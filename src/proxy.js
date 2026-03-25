const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream');
const SSEPassthrough = require('./sse-passthrough');
const { generateId, filterRequestHeaders, filterResponseHeaders, sanitizeForDashboard } = require('./utils');

// Shared state: pending AskUserQuestion interceptions
// Map<tool_use_id, { questions, resolve, reject }>
const pendingQuestions = new Map();

function sendProxyError(res, err) {
  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message: `Proxy error: ${err.message}` },
  }));
}

function createProxyRouter(store, broadcaster, targetUrl) {
  const router = express.Router();

  router.use(express.json({ limit: '50mb' }));
  router.use(express.raw({ limit: '50mb', type: () => false }));

  // POST /v1/messages - main endpoint
  router.post('/v1/messages', async (req, res) => {
    const body = req.body;
    const isStreaming = !!body.stream;

    // --- AskUserQuestion interception ---
    // Scan request messages for error tool_results matching a pending question
    let intercepted = false;
    if (body.messages) {
      for (const msg of body.messages) {
        if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
        for (let i = 0; i < msg.content.length; i++) {
          const block = msg.content[i];
          if (block.type === 'tool_result' && block.is_error && pendingQuestions.has(block.tool_use_id)) {
            intercepted = true;
            const toolUseId = block.tool_use_id;
            const pending = pendingQuestions.get(toolUseId);

            // Set up promise for the answer
            const answerPromise = new Promise((resolve, reject) => {
              pending.resolve = resolve;
              pending.reject = reject;
            });

            // Broadcast question to dashboard
            broadcaster.broadcast({
              type: 'ask:question',
              toolUseId,
              questions: pending.questions,
            });

            try {
              // Wait for user answer (5 min timeout)
              const answer = await Promise.race([
                answerPromise,
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Question timeout')), 300000)
                ),
              ]);

              // Rewrite the tool_result with the real answer
              msg.content[i] = {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: JSON.stringify(answer),
              };

              broadcaster.broadcast({ type: 'ask:answered', toolUseId });
            } catch {
              // Timeout or error - forward original error as-is
              broadcaster.broadcast({ type: 'ask:timeout', toolUseId });
            }

            pendingQuestions.delete(toolUseId);
          }
        }
      }
    }

    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages',
      request: { ...body },
      response: {
        status: null,
        headers: {},
        body: null,
        sseEvents: [],
      },
      timing: {
        startedAt: Date.now(),
        ttfb: null,
        duration: null,
      },
      usage: null,
      isStreaming,
      status: intercepted ? 'intercepted' : 'pending',
    };

    store.add(interaction);
    broadcaster.broadcast({
      type: 'interaction:start',
      interaction: sanitizeForDashboard(interaction),
    });

    try {
      const upstream = await fetch(`${targetUrl}/v1/messages`, {
        method: 'POST',
        headers: filterRequestHeaders(req.headers),
        body: JSON.stringify(body),
      });

      interaction.response.status = upstream.status;
      interaction.response.headers = filterResponseHeaders(upstream.headers);

      if (isStreaming && upstream.ok) {
        const responseHeaders = {
          ...filterResponseHeaders(upstream.headers),
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        };
        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'text/event-stream';
        }

        res.writeHead(upstream.status, responseHeaders);

        // Track AskUserQuestion tool_use blocks per-request
        const activeToolBlocks = new Map();

        const passthrough = new SSEPassthrough((event) => {
          interaction.response.sseEvents.push(event);

          if (event.eventType === 'message_start') {
            interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
            if (event.data?.message?.usage) {
              interaction.usage = { ...event.data.message.usage };
            }
          }
          if (event.eventType === 'message_delta' && event.data?.usage) {
            interaction.usage = { ...interaction.usage, ...event.data.usage };
          }
          if (event.eventType === 'message_stop') {
            interaction.timing.duration = Date.now() - interaction.timing.startedAt;
            interaction.status = 'complete';
          }

          // --- Track AskUserQuestion tool_use blocks ---
          if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
            const cb = event.data.content_block;
            activeToolBlocks.set(event.data.index, {
              id: cb.id,
              name: cb.name,
              inputJson: '',
            });
          }
          if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
            const tb = activeToolBlocks.get(event.data.index);
            if (tb) tb.inputJson += event.data.delta.partial_json || '';
          }
          if (event.eventType === 'content_block_stop') {
            const tb = activeToolBlocks.get(event.data?.index);
            if (tb && tb.name === 'AskUserQuestion') {
              try {
                const input = JSON.parse(tb.inputJson);
                pendingQuestions.set(tb.id, { questions: input.questions || [], resolve: null, reject: null });
                console.log(`[proxy] Recorded AskUserQuestion ${tb.id} with ${input.questions?.length || 0} questions`);
              } catch {}
            }
            activeToolBlocks.delete(event.data?.index);
          }

          broadcaster.broadcast({
            type: 'sse_event',
            interactionId: interaction.id,
            event,
          });

        });

        const nodeStream = Readable.fromWeb(upstream.body);

        pipeline(nodeStream, passthrough, res, (err) => {
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('Stream pipeline error:', err.message);
            interaction.status = 'error';
            interaction.response.error = err.message;
            broadcaster.broadcast({
              type: 'interaction:error',
              interactionId: interaction.id,
              error: err.message,
            });
          }
          if (!interaction.timing.duration) {
            interaction.timing.duration = Date.now() - interaction.timing.startedAt;
          }
          if (interaction.status === 'pending' || interaction.status === 'intercepted') {
            interaction.status = 'complete';
          }
          store.save(interaction.id);
          broadcaster.broadcast({
            type: 'interaction:complete',
            interaction: sanitizeForDashboard(interaction),
          });
        });
      } else {
        // Non-streaming response (or error response)
        const responseBody = await upstream.text();
        interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
        interaction.timing.duration = Date.now() - interaction.timing.startedAt;

        try {
          interaction.response.body = JSON.parse(responseBody);
          if (interaction.response.body.usage) {
            interaction.usage = interaction.response.body.usage;
          }
          // Track AskUserQuestion in non-streaming responses too
          if (interaction.response.body.content) {
            for (const block of interaction.response.body.content) {
              if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                pendingQuestions.set(block.id, {
                  questions: block.input?.questions || [],
                  resolve: null,
                  reject: null,
                });
                console.log(`[proxy] Recorded AskUserQuestion ${block.id} (non-streaming)`);
              }
            }
          }
        } catch {
          interaction.response.body = responseBody;
        }

        interaction.status = upstream.ok ? 'complete' : 'error';

        const responseHeaders = filterResponseHeaders(upstream.headers);
        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'application/json';
        }
        res.writeHead(upstream.status, responseHeaders);
        res.end(responseBody);

        store.save(interaction.id);
        broadcaster.broadcast({
          type: 'interaction:complete',
          interaction: sanitizeForDashboard(interaction),
        });
      }
    } catch (err) {
      console.error('Upstream fetch error:', err.message);
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      interaction.status = 'error';
      interaction.response.error = err.message;

      sendProxyError(res, err);

      store.save(interaction.id);
      broadcaster.broadcast({
        type: 'interaction:error',
        interactionId: interaction.id,
        error: err.message,
      });
    }
  });

  // POST /v1/messages/count_tokens
  router.post('/v1/messages/count_tokens', async (req, res) => {
    const body = req.body;
    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages/count_tokens',
      request: { ...body },
      response: { status: null, headers: {}, body: null, sseEvents: [] },
      timing: { startedAt: Date.now(), ttfb: null, duration: null },
      usage: null,
      isStreaming: false,
      status: 'pending',
    };

    store.add(interaction);
    broadcaster.broadcast({
      type: 'interaction:start',
      interaction: sanitizeForDashboard(interaction),
    });

    try {
      const upstream = await fetch(`${targetUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: filterRequestHeaders(req.headers),
        body: JSON.stringify(body),
      });

      const responseBody = await upstream.text();
      interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      const responseHeaders = filterResponseHeaders(upstream.headers);
      interaction.response.status = upstream.status;
      interaction.response.headers = responseHeaders;

      try {
        interaction.response.body = JSON.parse(responseBody);
      } catch {
        interaction.response.body = responseBody;
      }

      interaction.status = upstream.ok ? 'complete' : 'error';

      res.writeHead(upstream.status, responseHeaders);
      res.end(responseBody);

      store.save(interaction.id);
      broadcaster.broadcast({
        type: 'interaction:complete',
        interaction: sanitizeForDashboard(interaction),
      });
    } catch (err) {
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      interaction.status = 'error';
      interaction.response.error = err.message;

      sendProxyError(res, err);

      store.save(interaction.id);
    }
  });

  // Catch-all: forward unknown paths transparently
  router.all('*', async (req, res) => {
    try {
      const headers = filterRequestHeaders(req.headers);
      const fetchOpts = {
        method: req.method,
        headers,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOpts.body = JSON.stringify(req.body);
      }
      const upstream = await fetch(`${targetUrl}${req.path}`, fetchOpts);
      const body = await upstream.arrayBuffer();
      const responseHeaders = filterResponseHeaders(upstream.headers);
      res.writeHead(upstream.status, responseHeaders);
      res.end(Buffer.from(body));
    } catch (err) {
      sendProxyError(res, err);
    }
  });

  return router;
}

module.exports = createProxyRouter;
module.exports.pendingQuestions = pendingQuestions;

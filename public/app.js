// --- State ---
const state = {
  interactions: [],
  // Selection: { type: 'turn', id } or { type: 'tool', interactionId, toolIndex }
  selection: null,
  ws: null,
  reconnectDelay: 1000,
};

// --- DOM refs ---
const timelineList = document.getElementById('timeline-list');
const detailContent = document.getElementById('detail-content');
const emptyState = document.getElementById('empty-state');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const clearBtn = document.getElementById('clearBtn');
const resetBtn = document.getElementById('resetBtn');

// --- Tool call extraction ---
function extractToolCalls(interaction) {
  const calls = [];
  const resp = interaction.response || {};

  // From streaming SSE events
  if (interaction.isStreaming && resp.sseEvents?.length) {
    let current = null;
    for (const event of resp.sseEvents) {
      if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
        const cb = event.data.content_block;
        current = {
          blockIndex: event.data.index,
          id: cb.id || '',
          name: cb.name || '',
          inputJson: '',
          input: null,
          status: 'streaming',
        };
        calls.push(current);
      } else if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
        // Find the matching call by blockIndex
        const match = calls.find(c => c.blockIndex === event.data.index);
        if (match) match.inputJson += event.data.delta.partial_json || '';
      } else if (event.eventType === 'content_block_stop') {
        const match = calls.find(c => c.blockIndex === event.data?.index);
        if (match) {
          match.status = 'complete';
          try { match.input = JSON.parse(match.inputJson); } catch {}
        }
      }
    }
    return calls;
  }

  // From non-streaming response body
  if (resp.body?.content) {
    for (const block of resp.body.content) {
      if (block.type === 'tool_use') {
        calls.push({
          blockIndex: null,
          id: block.id || '',
          name: block.name || '',
          inputJson: JSON.stringify(block.input || {}),
          input: block.input || {},
          status: 'complete',
        });
      }
    }
  }

  return calls;
}

// Find tool_result in a subsequent interaction's request messages
function findToolResult(toolUseId) {
  for (const interaction of state.interactions) {
    const msgs = interaction.request?.messages;
    if (!msgs) continue;
    for (const msg of msgs) {
      if (msg.role !== 'user') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
          return block;
        }
      }
    }
  }
  return null;
}

// Check if this turn starts with a new user text message (not a tool-result continuation)
function isNewUserTurn(interaction) {
  if ((interaction.endpoint || '/v1/messages') !== '/v1/messages') return false;
  const msgs = interaction.request?.messages;
  if (!msgs || msgs.length === 0) return false;
  const last = msgs[msgs.length - 1];
  if (last.role !== 'user') return false;
  const content = Array.isArray(last.content) ? last.content : [];
  if (content.length === 0) return typeof last.content === 'string';
  return content[content.length - 1]?.type === 'text';
}

// Compact summary of a tool's input
function toolSummary(name, input) {
  if (!input) return '';
  if (input.file_path) return truncate(input.file_path, 35);
  if (input.command) return truncate(input.command, 35);
  if (input.pattern) return truncate(input.pattern, 35);
  if (input.query) return truncate(input.query, 35);
  if (input.url) return truncate(input.url, 35);
  if (input.content) return truncate(typeof input.content === 'string' ? input.content : '', 35);
  // Generic: first short string value
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0) return truncate(v, 35);
  }
  return '';
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

// --- WebSocket ---
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    statusEl.textContent = 'connected';
    statusEl.className = 'status connected';
    state.reconnectDelay = 1000;
  };

  ws.onclose = () => {
    statusEl.textContent = 'disconnected';
    statusEl.className = 'status disconnected';
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.interactions = msg.interactions || [];
      renderTimeline();
      updateStats();
      if (state.interactions.length > 0) {
        select({ type: 'turn', id: state.interactions[state.interactions.length - 1].id });
      }
      break;

    case 'interaction:start':
      state.interactions.push(msg.interaction);
      appendTurnToTimeline(msg.interaction);
      updateStats();
      select({ type: 'turn', id: msg.interaction.id });
      scrollTimelineToBottom();
      break;

    case 'sse_event':
      handleSSEEvent(msg.interactionId, msg.event);
      break;

    case 'interaction:complete':
      updateInteraction(msg.interaction);
      break;

    case 'interaction:error':
      markInteractionError(msg.interactionId, msg.error);
      break;

    case 'cleared':
      state.interactions = [];
      state.selection = null;
      timelineList.innerHTML = '';
      detailContent.innerHTML = '';
      detailContent.classList.add('hidden');
      emptyState.classList.remove('hidden');
      updateStats();
      break;

    case 'chat:event':
      handleChatEvent(msg.event);
      break;
    case 'chat:output':
      appendChatText(msg.text, 'assistant');
      break;
    case 'chat:error':
      appendChatText(msg.text, 'error');
      break;
    case 'chat:status':
      updateChatStatus(msg.status);
      break;

    case 'ask:question':
      showAskQuestion(msg.toolUseId, msg.questions);
      break;
    case 'ask:answered':
      markQuestionAnswered(msg.toolUseId);
      break;
    case 'ask:timeout':
      markQuestionTimeout(msg.toolUseId);
      break;
  }
}

// --- SSE event handling (live streaming) ---
function handleSSEEvent(interactionId, event) {
  const interaction = state.interactions.find(i => i.id === interactionId);
  if (!interaction) return;

  if (!interaction.response) interaction.response = { sseEvents: [] };
  if (!interaction.response.sseEvents) interaction.response.sseEvents = [];
  interaction.response.sseEvents.push(event);

  // Extract usage
  if (event.eventType === 'message_start' && event.data?.message?.usage) {
    interaction.usage = { ...event.data.message.usage };
  }
  if (event.eventType === 'message_delta' && event.data?.usage) {
    interaction.usage = { ...interaction.usage, ...event.data.usage };
  }
  if (event.eventType === 'message_start') {
    interaction.status = 'streaming';
    updateTurnBadge(interactionId, 'streaming');
  }
  if (event.eventType === 'message_stop') {
    interaction.status = 'complete';
    updateTurnBadge(interactionId, 'complete');
  }

  // Tool call appearing in the sidebar (live)
  if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
    const cb = event.data.content_block;
    const toolCalls = extractToolCalls(interaction);
    const toolIdx = toolCalls.length - 1;
    appendToolToTimeline(interactionId, toolIdx, cb.name, '');
  }
  if (event.eventType === 'content_block_stop') {
    // Update tool summary now that input is complete
    const toolCalls = extractToolCalls(interaction);
    const match = toolCalls.find(c => c.blockIndex === event.data?.index);
    if (match) {
      const toolIdx = toolCalls.indexOf(match);
      const summaryEl = document.querySelector(`[data-tool-summary="${interactionId}-${toolIdx}"]`);
      if (summaryEl) summaryEl.textContent = toolSummary(match.name, match.input);
    }
  }

  // Live update detail panel if this turn is selected
  const sel = state.selection;
  if (sel?.type === 'turn' && sel.id === interactionId) {
    appendSSEToDetail(event, interaction);
  }
}

function appendSSEToDetail(event, interaction) {
  const { eventType, data } = event;

  if (eventType === 'message_start') {
    const statusVal = document.getElementById('resp-status');
    if (statusVal) { statusVal.textContent = '200'; statusVal.className = 'info-value status-ok'; }
    if (data?.message?.usage) updateUsageDisplay(data.message.usage);
  }

  if (eventType === 'content_block_start') {
    const block = data?.content_block;
    if (!block) return;
    const container = document.getElementById('response-blocks');
    if (!container) return;

    const blockEl = document.createElement('div');
    blockEl.className = 'content-block';
    blockEl.id = `block-${data.index}`;

    const header = document.createElement('div');
    header.className = 'content-block-header';

    const body = document.createElement('div');
    body.className = 'content-block-body';
    body.id = `block-body-${data.index}`;

    if (block.type === 'thinking') {
      header.textContent = 'Thinking';
      body.classList.add('thinking');
    } else if (block.type === 'text') {
      header.textContent = 'Text';
    } else if (block.type === 'tool_use') {
      header.textContent = `Tool Use: ${block.name || ''}`;
      body.classList.add('tool-use');
      body.innerHTML = `<div class="tool-name">${escapeHtml(block.name || '')}</div><pre class="json-block" id="tool-input-${data.index}"></pre>`;
    } else {
      header.textContent = block.type;
    }

    blockEl.appendChild(header);
    blockEl.appendChild(body);
    container.appendChild(blockEl);
  }

  if (eventType === 'content_block_delta') {
    const delta = data?.delta;
    if (!delta) return;
    const bodyEl = document.getElementById(`block-body-${data.index}`);
    if (!bodyEl) return;

    if (delta.type === 'thinking_delta' || delta.type === 'text_delta') {
      bodyEl.appendChild(document.createTextNode(delta.thinking || delta.text || ''));
      bodyEl.scrollTop = bodyEl.scrollHeight;
    } else if (delta.type === 'input_json_delta') {
      const inputEl = document.getElementById(`tool-input-${data.index}`);
      if (inputEl) inputEl.appendChild(document.createTextNode(delta.partial_json || ''));
    }
  }

  if (eventType === 'content_block_stop') {
    const inputEl = document.getElementById(`tool-input-${data.index}`);
    if (inputEl) {
      try {
        const parsed = JSON.parse(inputEl.textContent);
        inputEl.innerHTML = highlightJSON(parsed);
      } catch {}
    }
  }

  if (eventType === 'message_delta') {
    if (data?.usage) {
      interaction.usage = { ...interaction.usage, ...data.usage };
      updateUsageDisplay(interaction.usage);
    }
    if (interaction.timing) {
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      const durationEl = document.getElementById('resp-duration');
      if (durationEl) durationEl.textContent = formatDuration(interaction.timing.duration);
    }
  }

  if (eventType === 'message_stop') {
    if (interaction.timing) {
      const durationEl = document.getElementById('resp-duration');
      if (durationEl) durationEl.textContent = formatDuration(interaction.timing.duration);
    }
    updateTurnBadge(interaction.id, 'complete');
    updateStats();
  }
}

// --- Update interaction after completion ---
function updateInteraction(updated) {
  const idx = state.interactions.findIndex(i => i.id === updated.id);
  if (idx >= 0) {
    const localEvents = state.interactions[idx].response?.sseEvents || [];
    state.interactions[idx] = { ...updated, response: { ...updated.response, sseEvents: localEvents } };
  }

  updateTurnBadge(updated.id, updated.status || 'complete');
  updateTurnMeta(updated);

  // Rebuild tool entries for this turn (now we have final data)
  rebuildToolEntries(updated.id);

  updateStats();

  const sel = state.selection;
  if (sel?.type === 'turn' && sel.id === updated.id) {
    const ttfbEl = document.getElementById('resp-ttfb');
    const durationEl = document.getElementById('resp-duration');
    if (ttfbEl && updated.timing?.ttfb) ttfbEl.textContent = formatDuration(updated.timing.ttfb);
    if (durationEl && updated.timing?.duration) durationEl.textContent = formatDuration(updated.timing.duration);
    if (updated.usage) updateUsageDisplay(updated.usage);
  }
}

function markInteractionError(id, error) {
  const interaction = state.interactions.find(i => i.id === id);
  if (interaction) {
    interaction.status = 'error';
    interaction.response = interaction.response || {};
    interaction.response.error = error;
  }
  updateTurnBadge(id, 'error');
}

// ============================================================
// TIMELINE RENDERING (hierarchical: turns + tool calls)
// ============================================================

function renderTimeline() {
  timelineList.innerHTML = '';
  state.interactions.forEach((interaction, idx) => {
    appendTurnToTimeline(interaction, idx);
  });
}

function appendTurnToTimeline(interaction, idx) {
  if (idx === undefined) idx = state.interactions.length - 1;

  // Turn group container
  const group = document.createElement('div');
  group.className = 'turn-group' + (isNewUserTurn(interaction) ? ' new-user-turn' : '');
  group.dataset.turnId = interaction.id;

  // Turn header row
  const el = document.createElement('div');
  el.className = 'timeline-entry turn-entry';
  el.dataset.id = interaction.id;

  const statusClass = badgeClass(interaction.status);
  const model = interaction.request?.model || 'unknown';
  const shortModel = model.replace('claude-', '').split('-202')[0];
  const duration = interaction.timing?.duration ? formatDuration(interaction.timing.duration) : '--';
  const endpoint = interaction.endpoint || '/v1/messages';
  const shortEndpoint = endpoint.replace('/v1/', '');

  el.innerHTML = `
    <div class="entry-header">
      <span class="entry-num">Turn ${idx + 1}</span>
      <span class="entry-badge ${statusClass}" data-badge="${interaction.id}">${interaction.status || 'pending'}</span>
    </div>
    <div class="entry-model">${escapeHtml(shortModel)}</div>
    <div class="entry-meta">
      <span>${shortEndpoint}</span>
      <span data-duration="${interaction.id}">${duration}</span>
    </div>
  `;

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    select({ type: 'turn', id: interaction.id });
  });

  group.appendChild(el);

  // Tool calls container
  const toolsContainer = document.createElement('div');
  toolsContainer.className = 'tool-entries';
  toolsContainer.dataset.toolsFor = interaction.id;
  group.appendChild(toolsContainer);

  // Render existing tool calls (for history replay)
  const toolCalls = extractToolCalls(interaction);
  toolCalls.forEach((tc, tIdx) => {
    const toolEl = createToolEntryEl(interaction.id, tIdx, tc.name, toolSummary(tc.name, tc.input));
    toolsContainer.appendChild(toolEl);
  });

  timelineList.appendChild(group);
}

function appendToolToTimeline(interactionId, toolIdx, name, summary) {
  const container = document.querySelector(`[data-tools-for="${interactionId}"]`);
  if (!container) return;
  // Don't duplicate
  if (container.querySelector(`[data-tool-id="${interactionId}-${toolIdx}"]`)) return;
  const toolEl = createToolEntryEl(interactionId, toolIdx, name, summary);
  container.appendChild(toolEl);
}

function createToolEntryEl(interactionId, toolIdx, name, summary) {
  const toolEl = document.createElement('div');
  toolEl.className = 'timeline-entry tool-entry';
  toolEl.dataset.toolId = `${interactionId}-${toolIdx}`;
  toolEl.innerHTML = `
    <span class="tool-connector"></span>
    <span class="tool-entry-name">${escapeHtml(name)}</span>
    <span class="tool-entry-summary" data-tool-summary="${interactionId}-${toolIdx}">${escapeHtml(summary)}</span>
  `;
  toolEl.addEventListener('click', (e) => {
    e.stopPropagation();
    select({ type: 'tool', interactionId, toolIndex: toolIdx });
  });
  return toolEl;
}

function rebuildToolEntries(interactionId) {
  const container = document.querySelector(`[data-tools-for="${interactionId}"]`);
  if (!container) return;
  container.innerHTML = '';
  const interaction = state.interactions.find(i => i.id === interactionId);
  if (!interaction) return;
  const toolCalls = extractToolCalls(interaction);
  toolCalls.forEach((tc, tIdx) => {
    const toolEl = createToolEntryEl(interactionId, tIdx, tc.name, toolSummary(tc.name, tc.input));
    container.appendChild(toolEl);
  });
}

function updateTurnBadge(id, status) {
  const badge = document.querySelector(`[data-badge="${id}"]`);
  if (badge) {
    badge.className = `entry-badge ${badgeClass(status)}`;
    badge.textContent = status;
  }
}

function updateTurnMeta(interaction) {
  const durationEl = document.querySelector(`[data-duration="${interaction.id}"]`);
  if (durationEl && interaction.timing?.duration) {
    durationEl.textContent = formatDuration(interaction.timing.duration);
  }
}

function badgeClass(status) {
  switch (status) {
    case 'streaming': return 'badge-streaming';
    case 'complete': return 'badge-complete';
    case 'error': return 'badge-error';
    default: return 'badge-pending';
  }
}

function scrollTimelineToBottom() {
  const timeline = document.getElementById('timeline');
  timeline.scrollTop = timeline.scrollHeight;
}

// ============================================================
// SELECTION + DETAIL PANEL
// ============================================================

function select(sel) {
  state.selection = sel;

  // Clear all highlights
  document.querySelectorAll('.timeline-entry.selected').forEach(el => el.classList.remove('selected'));

  if (sel.type === 'turn') {
    const el = document.querySelector(`.turn-entry[data-id="${sel.id}"]`);
    if (el) el.classList.add('selected');

    const interaction = state.interactions.find(i => i.id === sel.id);
    if (!interaction) return;

    emptyState.classList.add('hidden');
    detailContent.classList.remove('hidden');
    renderTurnDetail(interaction);
  } else if (sel.type === 'tool') {
    const el = document.querySelector(`[data-tool-id="${sel.interactionId}-${sel.toolIndex}"]`);
    if (el) el.classList.add('selected');

    const interaction = state.interactions.find(i => i.id === sel.interactionId);
    if (!interaction) return;

    emptyState.classList.add('hidden');
    detailContent.classList.remove('hidden');
    renderToolDetail(interaction, sel.toolIndex);
  }
}

// --- Turn detail (mostly same as before) ---
function renderTurnDetail(interaction) {
  const req = interaction.request || {};
  const resp = interaction.response || {};
  const timing = interaction.timing || {};

  const model = req.model || 'unknown';
  const maxTokens = req.max_tokens || '--';
  const temperature = req.temperature !== undefined ? req.temperature : '--';
  const stream = interaction.isStreaming ? 'yes' : 'no';

  let html = '';

  // --- Request panel ---
  html += `<div class="detail-panel request-panel">`;
  html += `<div class="section-title">Request</div>`;
  html += `<div class="info-grid">
    <span class="info-label">Model</span><span class="info-value">${escapeHtml(model)}</span>
    <span class="info-label">Max tokens</span><span class="info-value">${maxTokens}</span>
    <span class="info-label">Temperature</span><span class="info-value">${temperature}</span>
    <span class="info-label">Stream</span><span class="info-value">${stream}</span>
    <span class="info-label">Endpoint</span><span class="info-value">${escapeHtml(interaction.endpoint || '/v1/messages')}</span>
    <span class="info-label">Time</span><span class="info-value">${new Date(interaction.timestamp).toLocaleTimeString()}</span>
  </div>`;

  if (req.system) {
    const systemText = typeof req.system === 'string' ? req.system : JSON.stringify(req.system, null, 2);
    const charLen = typeof req.system === 'string' ? req.system.length : JSON.stringify(req.system).length;
    html += `<details>
      <summary>System Prompt (${charLen} chars)</summary>
      <div class="json-block">${escapeHtml(systemText)}</div>
    </details>`;
  }

  if (req.thinking) {
    html += `<details>
      <summary>Thinking Config</summary>
      <pre class="json-block">${highlightJSON(req.thinking)}</pre>
    </details>`;
  }

  if (req.messages?.length > 0) {
    html += `<details>
      <summary>Messages (${req.messages.length})</summary>
      <div class="json-block">${renderMessages(req.messages)}</div>
    </details>`;
  }

  if (req.tools?.length > 0) {
    const toolNames = req.tools.map(t => t.name || 'unnamed').join(', ');
    html += `<details>
      <summary>Tools (${req.tools.length}): ${escapeHtml(truncate(toolNames, 100))}</summary>
      <pre class="json-block">${highlightJSON(req.tools)}</pre>
    </details>`;
  }

  const knownKeys = new Set(['model', 'system', 'messages', 'tools', 'tool_choice', 'max_tokens', 'temperature', 'stream', 'thinking']);
  const otherParams = {};
  for (const [k, v] of Object.entries(req)) {
    if (!knownKeys.has(k)) otherParams[k] = v;
  }
  if (Object.keys(otherParams).length > 0) {
    html += `<details>
      <summary>Other Parameters</summary>
      <pre class="json-block">${highlightJSON(otherParams)}</pre>
    </details>`;
  }

  html += `</div>`; // end request-panel

  // --- Response panel ---
  html += `<div class="detail-panel response-panel">`;
  html += `<div class="section-title">Response</div>`;

  const statusOk = resp.status >= 200 && resp.status < 300;
  html += `<div class="info-grid">
    <span class="info-label">Status</span><span class="info-value ${statusOk ? 'status-ok' : 'status-err'}" id="resp-status">${resp.status || '--'}</span>
    <span class="info-label">TTFB</span><span class="info-value" id="resp-ttfb">${timing.ttfb ? formatDuration(timing.ttfb) : '--'}</span>
    <span class="info-label">Duration</span><span class="info-value" id="resp-duration">${timing.duration ? formatDuration(timing.duration) : '--'}</span>
  </div>`;

  html += `<div class="usage-bar" id="usage-bar">${interaction.usage ? renderUsage(interaction.usage) : '<span class="info-label">Tokens: --</span>'}</div>`;

  html += `<div id="response-blocks">`;

  if (interaction.isStreaming && resp.sseEvents?.length > 0) {
    html += renderAccumulatedBlocks(resp.sseEvents);
  } else if (resp.body) {
    if (resp.body.content) {
      for (const block of resp.body.content) html += renderStaticBlock(block);
    }
    if (resp.body.type === 'error') {
      html += `<div class="content-block">
        <div class="content-block-header" style="color:var(--red)">Error</div>
        <div class="content-block-body">${escapeHtml(JSON.stringify(resp.body.error, null, 2))}</div>
      </div>`;
    }
  }

  if (resp.error) {
    html += `<div class="content-block">
      <div class="content-block-header" style="color:var(--red)">Proxy Error</div>
      <div class="content-block-body">${escapeHtml(resp.error)}</div>
    </div>`;
  }

  html += `</div>`;

  if (resp.sseEvents?.length > 0) {
    html += `<details>
      <summary>Raw SSE Events (${resp.sseEvents.length})</summary>
      <pre class="json-block">${resp.sseEvents.map(e =>
        `<span class="json-key">event:</span> ${escapeHtml(e.eventType)}\n<span class="json-string">data:</span> ${escapeHtml(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))}\n`
      ).join('\n')}</pre>
    </details>`;
  }

  html += `</div>`; // end response-panel

  detailContent.innerHTML = html;
}

// --- Tool call detail ---
function renderToolDetail(interaction, toolIndex) {
  const toolCalls = extractToolCalls(interaction);
  const tc = toolCalls[toolIndex];
  if (!tc) { detailContent.innerHTML = '<p>Tool call not found.</p>'; return; }

  let html = '';

  // Header
  html += `<div class="section-title">Tool Call</div>`;
  html += `<div class="info-grid">
    <span class="info-label">Tool</span><span class="info-value" style="color:var(--purple);font-weight:700">${escapeHtml(tc.name)}</span>
    <span class="info-label">Status</span><span class="info-value">${tc.status}</span>
    <span class="info-label">Turn</span><span class="info-value"><a href="#" class="turn-link" data-turn-id="${interaction.id}">Turn ${state.interactions.indexOf(interaction) + 1}</a></span>
  </div>`;

  // Input
  html += `<div class="section-title">Input</div>`;
  if (tc.input) {
    html += `<pre class="json-block">${highlightJSON(tc.input)}</pre>`;
  } else if (tc.inputJson) {
    html += `<pre class="json-block">${escapeHtml(tc.inputJson)}</pre>`;
  } else {
    html += `<p class="info-label">No input data</p>`;
  }

  // Result (from next turn's messages)
  const result = findToolResult(tc.id);
  if (result) {
    html += `<div class="section-title">Result</div>`;
    if (result.is_error) {
      html += `<div class="content-block"><div class="content-block-header" style="color:var(--red)">Error Result</div>`;
    } else {
      html += `<div class="content-block"><div class="content-block-header">Tool Result</div>`;
    }
    html += `<div class="content-block-body">`;

    const content = result.content;
    if (typeof content === 'string') {
      html += `<pre style="white-space:pre-wrap">${escapeHtml(content)}</pre>`;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          html += `<pre style="white-space:pre-wrap">${escapeHtml(block.text || '')}</pre>`;
        } else if (block.type === 'image') {
          html += `<p class="info-label">[image: ${escapeHtml(block.source?.media_type || 'unknown')}]</p>`;
        } else {
          html += `<pre class="json-block">${highlightJSON(block)}</pre>`;
        }
      }
    } else if (content) {
      html += `<pre class="json-block">${highlightJSON(content)}</pre>`;
    }

    html += `</div></div>`;
  } else {
    html += `<div class="section-title">Result</div>`;
    html += `<p class="info-label">No result found (tool may still be executing or result not yet sent)</p>`;
  }

  detailContent.innerHTML = html;

  // Bind turn link
  const link = detailContent.querySelector('.turn-link');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      select({ type: 'turn', id: link.dataset.turnId });
    });
  }
}

// ============================================================
// RENDERING HELPERS
// ============================================================

function renderAccumulatedBlocks(events) {
  const blocks = [];
  let currentBlock = null;

  for (const event of events) {
    if (event.eventType === 'content_block_start') {
      const cb = event.data?.content_block;
      currentBlock = { type: cb?.type || 'unknown', name: cb?.name || '', text: '', index: event.data?.index };
      blocks.push(currentBlock);
    } else if (event.eventType === 'content_block_delta' && currentBlock) {
      const delta = event.data?.delta;
      if (delta?.type === 'text_delta') currentBlock.text += delta.text || '';
      else if (delta?.type === 'thinking_delta') currentBlock.text += delta.thinking || '';
      else if (delta?.type === 'input_json_delta') currentBlock.text += delta.partial_json || '';
    } else if (event.eventType === 'content_block_stop') {
      currentBlock = null;
    }
  }

  return blocks.map(b => {
    if (b.type === 'thinking') {
      return `<div class="content-block">
        <div class="content-block-header">Thinking</div>
        <div class="content-block-body thinking">${escapeHtml(b.text)}</div>
      </div>`;
    } else if (b.type === 'text') {
      return `<div class="content-block">
        <div class="content-block-header">Text</div>
        <div class="content-block-body">${escapeHtml(b.text)}</div>
      </div>`;
    } else if (b.type === 'tool_use') {
      let inputHtml;
      try { inputHtml = highlightJSON(JSON.parse(b.text)); } catch { inputHtml = escapeHtml(b.text); }
      return `<div class="content-block">
        <div class="content-block-header">Tool Use: ${escapeHtml(b.name)}</div>
        <div class="content-block-body tool-use">
          <div class="tool-name">${escapeHtml(b.name)}</div>
          <pre class="json-block">${inputHtml}</pre>
        </div>
      </div>`;
    }
    return `<div class="content-block">
      <div class="content-block-header">${escapeHtml(b.type)}</div>
      <div class="content-block-body">${escapeHtml(b.text)}</div>
    </div>`;
  }).join('');
}

function renderStaticBlock(block) {
  if (block.type === 'text') {
    return `<div class="content-block">
      <div class="content-block-header">Text</div>
      <div class="content-block-body">${escapeHtml(block.text || '')}</div>
    </div>`;
  }
  if (block.type === 'thinking') {
    return `<div class="content-block">
      <div class="content-block-header">Thinking</div>
      <div class="content-block-body thinking">${escapeHtml(block.thinking || '')}</div>
    </div>`;
  }
  if (block.type === 'tool_use') {
    return `<div class="content-block">
      <div class="content-block-header">Tool Use: ${escapeHtml(block.name || '')}</div>
      <div class="content-block-body tool-use">
        <div class="tool-name">${escapeHtml(block.name || '')}</div>
        <pre class="json-block">${highlightJSON(block.input || {})}</pre>
      </div>
    </div>`;
  }
  return `<div class="content-block">
    <div class="content-block-header">${escapeHtml(block.type)}</div>
    <pre class="json-block">${highlightJSON(block)}</pre>
  </div>`;
}

function renderMessages(messages) {
  return messages.map((msg, idx) => {
    const role = msg.role || 'unknown';
    let preview = '';
    if (typeof msg.content === 'string') {
      preview = msg.content.slice(0, 150);
    } else if (Array.isArray(msg.content)) {
      preview = msg.content.map(b => {
        if (b.type === 'text') return (b.text || '').slice(0, 80);
        if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
        if (b.type === 'tool_result') return `[tool_result: ${b.tool_use_id}]`;
        if (b.type === 'image') return '[image]';
        return `[${b.type}]`;
      }).join(' | ');
    }
    return `<details>
      <summary><strong>${escapeHtml(role)}</strong> [${idx}]: ${escapeHtml(truncate(preview, 120))}</summary>
      <pre>${highlightJSON(msg)}</pre>
    </details>`;
  }).join('');
}

// --- Usage ---
function renderUsage(usage) {
  let html = '';
  if (usage.input_tokens !== undefined)
    html += `<div class="usage-item"><span class="usage-dot input"></span>${usage.input_tokens} input</div>`;
  if (usage.output_tokens !== undefined)
    html += `<div class="usage-item"><span class="usage-dot output"></span>${usage.output_tokens} output</div>`;
  if (usage.cache_read_input_tokens)
    html += `<div class="usage-item"><span class="usage-dot cache-read"></span>${usage.cache_read_input_tokens} cache read</div>`;
  if (usage.cache_creation_input_tokens)
    html += `<div class="usage-item"><span class="usage-dot cache-create"></span>${usage.cache_creation_input_tokens} cache create</div>`;
  return html;
}

function updateUsageDisplay(usage) {
  const bar = document.getElementById('usage-bar');
  if (bar) bar.innerHTML = renderUsage(usage);
}

// --- Stats ---
function updateStats() {
  const total = state.interactions.length;
  let inputTokens = 0, outputTokens = 0, toolCallCount = 0;
  for (const i of state.interactions) {
    if (i.usage) {
      inputTokens += i.usage.input_tokens || 0;
      outputTokens += i.usage.output_tokens || 0;
    }
    toolCallCount += extractToolCalls(i).length;
  }
  statsEl.textContent = `${total} turn${total !== 1 ? 's' : ''} | ${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''} | ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out tokens`;
}

// --- Utilities ---
function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightJSON(obj) {
  const json = JSON.stringify(obj, null, 2);
  if (!json) return '';
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g, '<span class="json-key">"$1"</span>:')
    .replace(/:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g, ': <span class="json-string">"$1"</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, ': <span class="json-number">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '--';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- Event listeners ---
function sendClear() {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'clear' }));
  }
}

clearBtn.addEventListener('click', sendClear);
resetBtn.addEventListener('click', sendClear);

// ============================================================
// VIEW SWITCHING (Dashboard / Reference)
// ============================================================

document.getElementById('headerTabs').addEventListener('click', e => {
  const tab = e.target.closest('.header-tab');
  if (!tab) return;
  const view = tab.dataset.view;

  document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');

  const views = ['view-dashboard', 'view-claude', 'view-reference'];
  for (const id of views) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (id === `view-${view}`) {
      el.style.display = '';
      el.classList.remove('hidden');
    } else {
      el.style.display = 'none';
      el.classList.add('hidden');
    }
  }
});

// ============================================================
// REFERENCE PANEL LOGIC
// ============================================================

function toggleRef(header) {
  header.closest('.ref-card').classList.toggle('open');
}

// Section nav (Tools / Skills / Hooks)
document.getElementById('refNav').addEventListener('click', e => {
  const btn = e.target.closest('.ref-nav-btn');
  if (!btn) return;
  const section = btn.dataset.section;

  document.querySelectorAll('.ref-nav-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.querySelectorAll('.ref-panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('ref-' + section);
  if (target) target.classList.add('active');
});

// Tools sub-category filter
document.getElementById('refFilter').addEventListener('click', e => {
  const btn = e.target.closest('.ref-filter-btn');
  if (!btn) return;
  const cat = btn.dataset.cat;

  document.querySelectorAll('.ref-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.querySelectorAll('#ref-tools .ref-category').forEach(section => {
    section.style.display = (cat === 'all' || section.dataset.cat === cat) ? '' : 'none';
  });
});

// Alt+E to expand/collapse all visible ref cards
document.addEventListener('keydown', e => {
  if (e.key === 'e' && e.altKey) {
    const activePanel = document.querySelector('.ref-panel.active');
    if (!activePanel) return;
    const cards = activePanel.querySelectorAll('.ref-card');
    const allOpen = [...cards].every(c => c.classList.contains('open'));
    cards.forEach(c => c.classList.toggle('open', !allOpen));
  }
});

// ============================================================
// CLAUDE CHAT
// ============================================================

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const chatStopBtn = document.getElementById('chatStopBtn');
const chatStatusEl = document.getElementById('chatStatus');

let chatAutoScroll = true;

chatMessages?.addEventListener('scroll', () => {
  const el = chatMessages;
  chatAutoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
});

function chatScrollToBottom() {
  if (chatAutoScroll && chatMessages) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function sendChat() {
  const prompt = chatInput?.value?.trim();
  if (!prompt) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  // Show user message
  appendChatBubble(prompt, 'user');

  // Clear current assistant response accumulator
  state.chatCurrentEl = null;

  state.ws.send(JSON.stringify({ type: 'chat:send', prompt }));
  chatInput.value = '';
  chatInput.style.height = 'auto';
}

chatSendBtn?.addEventListener('click', sendChat);
chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Auto-resize textarea
chatInput?.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
});

chatStopBtn?.addEventListener('click', () => {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'chat:stop' }));
  }
});

function appendChatBubble(text, role) {
  if (!chatMessages) return;
  // Remove welcome if present
  const welcome = chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatScrollToBottom();
  return bubble;
}

function appendChatText(text, role) {
  if (!chatMessages) return;
  if (role === 'assistant' && state.chatCurrentEl) {
    state.chatCurrentEl.textContent += text;
  } else {
    state.chatCurrentEl = appendChatBubble(text, role);
  }
  chatScrollToBottom();
}

function handleChatEvent(event) {
  // stream-json events from claude -p
  // Types: message_start, content_block_start, content_block_delta, content_block_stop,
  //        message_delta, message_stop, result
  if (!chatMessages) return;

  if (event.type === 'content_block_delta') {
    const text = event.delta?.text || '';
    if (text) {
      if (!state.chatCurrentEl) {
        state.chatCurrentEl = appendChatBubble('', 'assistant');
      }
      state.chatCurrentEl.textContent += text;
      chatScrollToBottom();
    }
  } else if (event.type === 'result') {
    if (event.result) {
      if (!state.chatCurrentEl) {
        state.chatCurrentEl = appendChatBubble('', 'assistant');
      }
      state.chatCurrentEl.textContent = event.result;
      chatScrollToBottom();
    }
    state.chatCurrentEl = null;
  } else if (event.type === 'message_stop') {
    state.chatCurrentEl = null;
  }
}

function updateChatStatus(status) {
  if (chatStatusEl) {
    chatStatusEl.textContent = status;
    chatStatusEl.className = `chat-status ${status}`;
  }
  if (chatStopBtn) {
    chatStopBtn.classList.toggle('hidden', status !== 'running');
  }
  if (chatSendBtn) {
    chatSendBtn.disabled = status === 'running';
  }
}

// ============================================================
// ASK USER QUESTION (proxy interception UI)
// ============================================================

function showAskQuestion(toolUseId, questions) {
  if (!chatMessages) return;

  // Remove welcome if present
  const welcome = chatMessages.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // Auto-switch to Claude tab
  const claudeTab = document.querySelector('[data-view="claude"]');
  if (claudeTab && !claudeTab.classList.contains('active')) {
    claudeTab.click();
  }

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-question';
  bubble.dataset.toolUseId = toolUseId;

  let html = '';
  for (let qi = 0; qi < (questions || []).length; qi++) {
    const q = questions[qi];
    const isMulti = !!q.multiSelect;

    if (qi > 0) html += `<div class="chat-question-divider"></div>`;
    if (q.header) {
      html += `<div class="chat-question-header">${escapeHtml(q.header)}</div>`;
    }
    html += `<div class="chat-question-text">${escapeHtml(q.question)}</div>`;
    if (isMulti) {
      html += `<div class="chat-question-hint">Select one or more, then submit</div>`;
    }

    if (q.options && q.options.length > 0) {
      html += `<div class="chat-options" data-qi="${qi}" data-multi="${isMulti}">`;
      for (const opt of q.options) {
        html += `<button class="chat-option-btn" data-qi="${qi}" data-label="${escapeHtml(opt.label)}">`;
        if (isMulti) {
          html += `<span class="chat-option-check"></span>`;
        }
        html += `<span class="chat-option-label">${escapeHtml(opt.label)}</span>`;
        if (opt.description) {
          html += `<span class="chat-option-desc">${escapeHtml(opt.description)}</span>`;
        }
        html += `</button>`;
      }
      html += `</div>`;
    }
  }

  // Submit button (used for multi-select, or when there are multiple questions)
  const needsSubmit = questions.length > 1 || questions.some(q => q.multiSelect);
  if (needsSubmit) {
    html += `<button class="chat-submit-btn" disabled>Submit</button>`;
  }

  bubble.innerHTML = html;

  // Bind option clicks
  const allQuestions = questions || [];
  const submitBtn = bubble.querySelector('.chat-submit-btn');

  function checkSubmitReady() {
    if (!submitBtn) return;
    const allAnswered = allQuestions.every((_, qi) => {
      const sel = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
      return sel.length > 0;
    });
    submitBtn.disabled = !allAnswered;
  }

  bubble.querySelectorAll('.chat-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const qi = parseInt(btn.dataset.qi);
      const q = allQuestions[qi];
      const isMulti = !!q?.multiSelect;
      const optionsContainer = bubble.querySelector(`.chat-options[data-qi="${qi}"]`);

      if (isMulti) {
        // Toggle selection
        btn.classList.toggle('selected');
      } else {
        // Single select: deselect others in same group
        optionsContainer.querySelectorAll('.chat-option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');

        // If no submit button needed, send immediately
        if (!needsSubmit) {
          const answer = [{ question: q.question, answer: btn.dataset.label }];
          sendQuestionAnswer(toolUseId, answer);
          bubble.querySelectorAll('.chat-option-btn').forEach(b => b.disabled = true);
          bubble.classList.add('answered');
          return;
        }
      }

      checkSubmitReady();
    });
  });

  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      const answer = allQuestions.map((q, qi) => {
        const selected = bubble.querySelectorAll(`.chat-option-btn.selected[data-qi="${qi}"]`);
        const labels = Array.from(selected).map(b => b.dataset.label);
        return {
          question: q.question,
          answer: q.multiSelect ? labels : labels[0] || '',
        };
      });

      sendQuestionAnswer(toolUseId, answer);
      bubble.querySelectorAll('.chat-option-btn').forEach(b => b.disabled = true);
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitted';
      bubble.classList.add('answered');
    });
  }

  chatMessages.appendChild(bubble);
  chatScrollToBottom();
}

function sendQuestionAnswer(toolUseId, answer) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'ask:answer', toolUseId, answer }));
  }
}

function markQuestionAnswered(toolUseId) {
  const bubble = chatMessages?.querySelector(`.chat-question[data-tool-use-id="${toolUseId}"]`);
  if (bubble) {
    bubble.classList.add('answered');
  }
}

function markQuestionTimeout(toolUseId) {
  const bubble = chatMessages?.querySelector(`.chat-question[data-tool-use-id="${toolUseId}"]`);
  if (bubble) {
    bubble.classList.add('timed-out');
    const notice = document.createElement('div');
    notice.className = 'chat-question-timeout';
    notice.textContent = 'Timed out - error forwarded as-is';
    bubble.appendChild(notice);
  }
}

// --- Init ---
connect();

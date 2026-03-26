const WebSocket = require('ws');
const { sanitizeForDashboard } = require('./utils');
const { pendingQuestions } = require('./proxy');

class DashboardBroadcaster {
  constructor(wss, store, claudeSession) {
    this.wss = wss;
    this.store = store;
    this.claudeSession = claudeSession;

    this.wss.on('connection', (ws) => {
      // Send full history on connect
      const interactions = this.store.getAll().map(sanitizeForDashboard);
      ws.send(JSON.stringify({ type: 'init', interactions }));

      // Send current chat status and settings
      ws.send(JSON.stringify({
        type: 'chat:status',
        status: this.claudeSession?.running ? 'running' : 'idle',
      }));
      if (this.claudeSession) {
        ws.send(JSON.stringify({ type: 'chat:settings', cwd: this.claudeSession.cwd, permissionMode: this.claudeSession.permissionMode }));
      }

      // Send session list and active session
      ws.send(JSON.stringify({
        type: 'session:list',
        sessions: this.store.listSessions(),
        activeId: this.store.sessionId,
      }));

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'chat:send' && this.claudeSession) {
            this.claudeSession.send(msg.prompt || '');
          } else if (msg.type === 'chat:stop' && this.claudeSession) {
            this.claudeSession.kill();
          } else if (msg.type === 'chat:setCwd' && this.claudeSession) {
            const ok = this.claudeSession.setCwd(msg.cwd || '');
            if (!ok) {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid directory: ${msg.cwd}` }));
            }
          } else if (msg.type === 'chat:setPermissionMode' && this.claudeSession) {
            const ok = this.claudeSession.setPermissionMode(msg.mode || 'default');
            if (!ok) {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid permission mode: ${msg.mode}` }));
            }
          } else if (msg.type === 'session:delete' && this.claudeSession) {
            const ok = this.store.deleteSession(msg.id);
            if (ok) {
              this.broadcast({ type: 'session:list', sessions: this.store.listSessions(), activeId: this.store.sessionId });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete session ${msg.id}` }));
            }
          } else if (msg.type === 'session:new' && this.claudeSession) {
            this.claudeSession.newSession();
            this.broadcast({ type: 'session:switched', activeId: this.store.sessionId, interactions: [], chatHistory: [] });
            this.broadcast({ type: 'session:list', sessions: this.store.listSessions(), activeId: this.store.sessionId });
          } else if (msg.type === 'session:switch' && this.claudeSession) {
            const data = this.claudeSession.switchSession(msg.id);
            if (data) {
              // Build chat history from saved interactions
              const chatHistory = this._extractChatHistory(data.interactions);
              // Build inspector interactions (reconstruct enough for the timeline)
              const inspectorInteractions = this._reconstructInteractions(data.interactions);
              this.broadcast({ type: 'session:switched', activeId: this.store.sessionId, interactions: inspectorInteractions, chatHistory });
              this.broadcast({ type: 'session:list', sessions: this.store.listSessions(), activeId: this.store.sessionId });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Session ${msg.id} not found` }));
            }
          } else if (msg.type === 'ask:answer') {
            // Resolve a pending AskUserQuestion
            const pending = pendingQuestions.get(msg.toolUseId);
            if (pending?.resolve) {
              pending.resolve(msg.answer);
            }
          }
        } catch {}
      });
    });
  }

  _extractChatHistory(interactions) {
    const history = [];
    for (const inter of interactions) {
      // Extract user prompt from the last user message
      const messages = inter.request?.messages || [];
      for (const m of messages) {
        if (m.role === 'user') {
          const content = m.content;
          if (typeof content === 'string') {
            // Skip system reminder texts
            if (!content.startsWith('<system-reminder>')) {
              history.push({ role: 'user', text: content });
            }
          } else if (Array.isArray(content)) {
            // Find the actual user text (last text block, skip system-reminders)
            const texts = content
              .filter(b => b.type === 'text' && !b.text.startsWith('<system-reminder>'))
              .map(b => b.text);
            if (texts.length > 0) {
              history.push({ role: 'user', text: texts[texts.length - 1] });
            }
          }
        }
      }
      // Extract assistant response
      const body = inter.response?.body;
      if (body?.content) {
        const textBlocks = body.content.filter(b => b.type === 'text').map(b => b.text);
        if (textBlocks.length > 0) {
          history.push({ role: 'assistant', text: textBlocks.join('\n') });
        }
      }
    }
    return history;
  }

  _reconstructInteractions(savedInteractions) {
    return savedInteractions.map((inter, i) => {
      const id = `restored-${i}-${Date.now()}`;
      return {
        id,
        endpoint: inter.request?.endpoint || '/v1/messages',
        timestamp: inter.request?.timestamp || null,
        isStreaming: inter.request?.isStreaming ?? true,
        request: {
          model: inter.request?.model,
          messages: inter.request?.messages,
          system: inter.request?.system,
          tools: inter.request?.tools,
        },
        response: {
          status: inter.response?.status,
          headers: inter.response?.headers || {},
          body: inter.response?.body || null,
          sseEvents: inter.response?.sseEvents || [],
        },
        status: inter.response?.result || 'complete',
        timing: inter.response?.timing || {},
        usage: inter.response?.usage || null,
      };
    });
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(data);
        } catch {}
      }
    }
  }
}

module.exports = DashboardBroadcaster;

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
        ws.send(JSON.stringify({ type: 'chat:settings', cwd: this.claudeSession.cwd }));
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'clear') {
            this.store.clear();
            if (this.claudeSession) this.claudeSession.clearSession();
            this.broadcast({ type: 'cleared' });
          } else if (msg.type === 'chat:send' && this.claudeSession) {
            this.claudeSession.send(msg.prompt || '');
          } else if (msg.type === 'chat:stop' && this.claudeSession) {
            this.claudeSession.kill();
          } else if (msg.type === 'chat:setCwd' && this.claudeSession) {
            const ok = this.claudeSession.setCwd(msg.cwd || '');
            if (!ok) {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid directory: ${msg.cwd}` }));
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

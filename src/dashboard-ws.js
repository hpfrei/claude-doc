const WebSocket = require('ws');
const { sanitizeForDashboard } = require('./utils');
const { pendingQuestions } = require('./proxy');
const caps = require('./capabilities');

class DashboardBroadcaster {
  constructor(wss, store, claudeSession) {
    this.wss = wss;
    this.store = store;
    this.claudeSession = claudeSession;
    this.mcpHandler = null; // Set externally by src/mcp/index.js

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
        const cwd = this.claudeSession.cwd;
        // Collect available MCP servers for profile editor
        let mcpServers = [];
        try { mcpServers = require('./mcp/servers').listServers(); } catch {}
        ws.send(JSON.stringify({
          type: 'chat:settings',
          cwd,
          capabilities: this.claudeSession.capabilities,
          profiles: caps.listProfiles(cwd),
          knownTools: caps.KNOWN_TOOLS,
          knownSkills: caps.KNOWN_SKILLS,
          hookEvents: caps.HOOK_EVENTS,
          matcherEvents: caps.MATCHER_EVENTS,
          mcpServers,
        }));
        // Send skills, agents, hooks for capabilities tab
        ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(cwd) }));
        ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(cwd) }));
        ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(cwd) }));
      }

      // Send session list and active session
      ws.send(JSON.stringify({
        type: 'session:list',
        sessions: this.store.listSessions(),
        activeId: this.store.sessionId,
      }));

      // MCP Server Manager init
      if (this.mcpHandler) this.mcpHandler.onConnect(ws);

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
          // --- Capabilities / Profiles ---
          } else if (msg.type === 'chat:setCapabilities' && this.claudeSession) {
            this.claudeSession.setCapabilities(msg.capabilities);
            const cwd = this.claudeSession.cwd;
            this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
          } else if (msg.type === 'chat:switchProfile' && this.claudeSession) {
            const ok = this.claudeSession.switchProfile(msg.name);
            if (!ok) {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Unknown profile: ${msg.name}` }));
            } else {
              const cwd = this.claudeSession.cwd;
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            }
          } else if (msg.type === 'profile:list') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'profile:list', profiles: caps.listProfiles(cwd) }));
          } else if (msg.type === 'profile:save') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.saveProfile(cwd, msg.profile);
            if (ok) {
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot save profile: ${msg.profile?.name} (invalid or builtin name)` }));
            }
          } else if (msg.type === 'profile:delete') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.deleteProfile(cwd, msg.name);
            if (ok) {
              // If active profile was deleted, switch to full
              if (this.claudeSession && this.claudeSession.capabilities.name === msg.name) {
                this.claudeSession.switchProfile('full');
              }
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot delete profile: ${msg.name}` }));
            }
          } else if (msg.type === 'profile:duplicate') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.duplicateProfile(cwd, msg.source, msg.newName);
            if (ok) {
              this.broadcast({ type: 'profile:list', profiles: caps.listProfiles(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Cannot duplicate profile: invalid name or source` }));
            }
          // --- Skills ---
          } else if (msg.type === 'skill:list') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(cwd) }));
          } else if (msg.type === 'skill:save') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.saveSkill(cwd, msg.name, msg.content, msg.extraFiles);
            if (ok) {
              this.broadcast({ type: 'skill:list', skills: caps.listSkills(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid skill name: ${msg.name}` }));
            }
          } else if (msg.type === 'skill:delete') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.deleteSkill(cwd, msg.name);
            if (ok) this.broadcast({ type: 'skill:list', skills: caps.listSkills(cwd) });
          // --- Agents ---
          } else if (msg.type === 'agent:list') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(cwd) }));
          } else if (msg.type === 'agent:save') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.saveAgent(cwd, msg.name, msg.content);
            if (ok) {
              this.broadcast({ type: 'agent:list', agents: caps.listAgents(cwd) });
            } else {
              ws.send(JSON.stringify({ type: 'chat:error', text: `Invalid agent name: ${msg.name}` }));
            }
          } else if (msg.type === 'agent:delete') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.deleteAgent(cwd, msg.name);
            if (ok) this.broadcast({ type: 'agent:list', agents: caps.listAgents(cwd) });
          // --- Hooks ---
          } else if (msg.type === 'hook:list') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(cwd) }));
          } else if (msg.type === 'hook:save') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            caps.saveHook(cwd, msg.hook);
            this.broadcast({ type: 'hook:list', hooks: caps.listHooks(cwd) });
          } else if (msg.type === 'hook:delete') {
            const cwd = this.claudeSession?.cwd || process.cwd();
            const ok = caps.deleteHook(cwd, msg.event, msg.entryIndex);
            if (ok) this.broadcast({ type: 'hook:list', hooks: caps.listHooks(cwd) });
          // --- MCP Servers ---
          } else if (msg.type.startsWith('mcp:')) {
            if (this.mcpHandler) this.mcpHandler.handleMessage(ws, msg, this);
          }
        } catch (err) { console.error('WS message handling error:', err); }
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
        } catch (err) { console.error('WS broadcast error:', err); }
      }
    }
  }
}

module.exports = DashboardBroadcaster;

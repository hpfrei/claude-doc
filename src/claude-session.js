const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const caps = require('./capabilities');

class ClaudeSession {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.proc = null;
    this.buffer = '';
    this.cwd = process.env.PROJECT_DIR || process.cwd();
    this.sessionId = null;
    this.ready = false;
    this.capabilities = caps.loadActiveProfile(process.cwd());
    this._mcpConfigFile = null; // temp file for --mcp-config
    this._authToken = opts.authToken || '';
    this._dashboardPort = opts.dashboardPort || 3457;
  }

  setReady() {
    this.ready = true;
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null;
  }

  setCwd(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return false;
    }
    this.cwd = dir;
    this._broadcastSettings();
    return true;
  }

  setCapabilities(profile) {
    this.capabilities = caps.validateProfile(profile);
    // Save custom profiles to disk; builtins are not saved
    if (!caps.BUILTIN_PROFILES[this.capabilities.name]) {
      caps.saveProfile(process.cwd(), this.capabilities);
    }
    caps.setActiveProfile(process.cwd(), this.capabilities.name);
    if (this.running) this.kill();
    this._broadcastSettings();
    return true;
  }

  switchProfile(name) {
    const profile = caps.loadProfile(process.cwd(), name);
    if (!profile) return false;
    this.capabilities = profile;
    caps.setActiveProfile(process.cwd(), name);
    if (this.running) this.kill();
    this._broadcastSettings();
    return true;
  }

  _broadcastSettings() {
    this.broadcaster.broadcast({
      type: 'chat:settings',
      cwd: this.cwd,
      capabilities: this.capabilities,
    });
  }

  _cleanupMcpConfig() {
    if (this._mcpConfigFile) {
      try { fs.unlinkSync(this._mcpConfigFile); } catch {}
      this._mcpConfigFile = null;
    }
  }

  /**
   * Build a temp MCP config file for selected servers.
   * Returns the file path, or null if no servers selected.
   */
  _buildMcpConfig(serverSlugs) {
    if (!serverSlugs || serverSlugs.length === 0) return null;

    let mcpServers;
    try {
      mcpServers = require('./mcp/servers');
    } catch { return null; }

    const appRoot = path.dirname(__dirname);
    const bridgePath = path.join(appRoot, 'lib', 'mcp-bridge.js');
    const config = { mcpServers: {} };

    for (const slug of serverSlugs) {
      const meta = mcpServers.loadServer(slug);
      if (!meta) continue;

      // Build env from server's environment variables
      const env = {};
      if (meta.env && typeof meta.env === 'object' && !Array.isArray(meta.env)) {
        for (const [k, v] of Object.entries(meta.env)) {
          if (k) env[k] = String(v);
        }
      }
      if (meta.secrets && typeof meta.secrets === 'object') {
        for (const [k, v] of Object.entries(meta.secrets)) {
          if (k) env[k] = String(v);
        }
      }
      // Inject dashboard connection info for the bridge
      env.CLAUDE_DOC_DASHBOARD_PORT = String(this._dashboardPort || process.env.DASHBOARD_PORT || '3457');
      env.CLAUDE_DOC_AUTH_TOKEN = String(this._authToken || process.env.AUTH_TOKEN || '');
      env.CLAUDE_DOC_SERVER_SLUG = slug;

      config.mcpServers[slug] = {
        command: 'node',
        args: [bridgePath, slug],
        env,
      };
    }

    if (Object.keys(config.mcpServers).length === 0) return null;

    // Write to temp file
    const tmpFile = path.join(os.tmpdir(), `claude-doc-mcp-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
    this._mcpConfigFile = tmpFile;
    return tmpFile;
  }

  send(prompt) {
    if (!this.ready) {
      this.broadcaster.broadcast({
        type: 'chat:error',
        text: 'Services are still starting up. Please wait a moment and try again.',
      });
      return;
    }

    if (this.running) {
      // Kill existing process before starting a new one
      this.kill();
    }

    this.buffer = '';
    this.broadcaster.broadcast({ type: 'chat:status', status: 'running' });

    const args = ['-p', '--verbose', '--output-format', 'stream-json'];
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }
    // Profile-based capability flags
    const c = this.capabilities;
    if (c.permissionMode && c.permissionMode !== 'default') {
      args.push('--permission-mode', c.permissionMode);
    }
    if (c.disabledTools && c.disabledTools.length > 0) {
      args.push('--disallowedTools', ...c.disabledTools);
    }
    if (c.model) {
      args.push('--model', c.model);
    }
    if (c.effort) {
      args.push('--effort', c.effort);
    }
    if (c.disableSlashCommands) {
      args.push('--disable-slash-commands');
    }
    if (c.maxTurns) {
      args.push('--max-turns', String(c.maxTurns));
    }
    if (c.maxBudgetUsd) {
      args.push('--max-budget-usd', String(c.maxBudgetUsd));
    }
    if (c.appendSystemPrompt) {
      args.push('--append-system-prompt', c.appendSystemPrompt);
    }
    if (c.systemPrompt) {
      args.push('--system-prompt', c.systemPrompt);
    }

    // MCP server config injection
    this._cleanupMcpConfig();
    const mcpConfigFile = this._buildMcpConfig(c.mcpServers);
    if (mcpConfigFile) {
      args.push('--mcp-config', mcpConfigFile);
    }

    this.proc = spawn('claude', args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://localhost:${this.proxyPort}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send prompt to stdin and close it
    this.proc.stdin.write(prompt);
    this.proc.stdin.end();

    this.proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      this.buffer += text;

      // stream-json outputs one JSON object per line
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.session_id && !this.sessionId) {
            this.sessionId = event.session_id;
            console.log(`[session] Captured session ${this.sessionId}`);
            this.store.saveSessionMeta(this.sessionId);
          }
          this.broadcaster.broadcast({ type: 'chat:event', event });
          // 'result' is the last meaningful event from claude -p; signal idle immediately
          if (event.type === 'result') {
            this.broadcaster.broadcast({ type: 'chat:status', status: 'idle', exitCode: null });
          }
        } catch {
          // Not valid JSON, send as raw text
          this.broadcaster.broadcast({ type: 'chat:output', text: line });
        }
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      this.broadcaster.broadcast({ type: 'chat:error', text });
    });

    this.proc.on('close', (code) => {
      // Flush remaining buffer
      if (this.buffer.trim()) {
        try {
          const event = JSON.parse(this.buffer);
          if (event.session_id && !this.sessionId) {
            this.sessionId = event.session_id;
            console.log(`[session] Captured session ${this.sessionId}`);
            this.store.saveSessionMeta(this.sessionId);
          }
          this.broadcaster.broadcast({ type: 'chat:event', event });
        } catch {
          this.broadcaster.broadcast({ type: 'chat:output', text: this.buffer });
        }
        this.buffer = '';
      }
      this._cleanupMcpConfig();
      this.broadcaster.broadcast({
        type: 'chat:status',
        status: 'idle',
        exitCode: code,
      });
      this.proc = null;
    });

    this.proc.on('error', (err) => {
      this.broadcaster.broadcast({
        type: 'chat:error',
        text: `Failed to start claude: ${err.message}`,
      });
      this.broadcaster.broadcast({ type: 'chat:status', status: 'error' });
      this.proc = null;
    });
  }

  kill() {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this._cleanupMcpConfig();
  }

  clearSession() {
    this.kill();
    this.sessionId = null;
  }

  newSession() {
    this.kill();
    this.sessionId = null;
    this.store.newSession();
  }

  switchSession(storeSessionId) {
    this.kill();
    const data = this.store.loadSession(storeSessionId);
    if (!data) return null;
    this.store.switchTo(storeSessionId);
    this.sessionId = data.meta.claudeSessionId || null;
    return data;
  }
}

module.exports = ClaudeSession;

const { spawn } = require('child_process');
const fs = require('fs');

class ClaudeSession {
  constructor(proxyPort, broadcaster, store) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.proc = null;
    this.buffer = '';
    this.cwd = process.env.PROJECT_DIR || process.cwd();
    this.sessionId = null;
    this.ready = false;
    this.permissionMode = 'default';
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
    this.broadcaster.broadcast({ type: 'chat:settings', cwd: this.cwd, permissionMode: this.permissionMode });
    return true;
  }

  setPermissionMode(mode) {
    const valid = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];
    if (!valid.includes(mode)) return false;
    this.permissionMode = mode;
    this.broadcaster.broadcast({ type: 'chat:settings', cwd: this.cwd, permissionMode: this.permissionMode });
    return true;
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
    if (this.permissionMode && this.permissionMode !== 'default') {
      args.push('--permission-mode', this.permissionMode);
    }
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
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

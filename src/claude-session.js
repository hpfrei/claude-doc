const { spawn } = require('child_process');

class ClaudeSession {
  constructor(proxyPort, broadcaster) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.proc = null;
    this.buffer = '';
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null;
  }

  send(prompt) {
    if (this.running) {
      // Kill existing process before starting a new one
      this.kill();
    }

    this.buffer = '';
    this.broadcaster.broadcast({ type: 'chat:status', status: 'running' });

    this.proc = spawn('claude', ['-p', '--verbose', '--output-format', 'stream-json'], {
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
          this.broadcaster.broadcast({ type: 'chat:event', event });
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
}

module.exports = ClaudeSession;

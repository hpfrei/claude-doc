const { Transform } = require('stream');

class SSEPassthrough extends Transform {
  constructor(onEvent) {
    super();
    this.onEvent = onEvent;
    this.buffer = '';
    this.currentEventType = '';
    this.currentData = '';
  }

  _transform(chunk, encoding, callback) {
    // Push raw bytes downstream immediately (to CLI client)
    this.push(chunk);

    // Parse SSE events from the text (side-channel for dashboard)
    this.buffer += chunk.toString('utf-8');
    this._parseBuffer();

    callback();
  }

  _parseBuffer() {
    const lines = this.buffer.split('\n');
    // Keep the last (possibly incomplete) line
    this.buffer = lines.pop();

    for (const line of lines) {
      if (line === '') {
        // Blank line = end of event
        if (this.currentData) {
          this._dispatchEvent();
        }
        this.currentEventType = '';
        this.currentData = '';
      } else if (line.startsWith('event:')) {
        this.currentEventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).trimStart();
        this.currentData = this.currentData
          ? this.currentData + '\n' + value
          : value;
      }
      // Lines starting with ':' are SSE comments, ignore
    }
  }

  _dispatchEvent() {
    let parsedData = null;
    try {
      parsedData = JSON.parse(this.currentData);
    } catch {
      parsedData = this.currentData;
    }

    this.onEvent({
      eventType: this.currentEventType,
      data: parsedData,
      receivedAt: Date.now(),
    });
  }

  _flush(callback) {
    if (this.currentData) {
      this._dispatchEvent();
    }
    callback();
  }
}

module.exports = SSEPassthrough;

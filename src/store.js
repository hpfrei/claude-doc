const fs = require('fs');
const path = require('path');

const INTERACTIONS_DIR = path.join(__dirname, '..', 'interactions');

class InteractionStore {
  constructor(maxSize = 200) {
    this.interactions = new Map();
    this.order = [];
    this.maxSize = maxSize;
    this.seqMap = new Map(); // interaction id -> sequence number
    this.seq = 0;

    // Ensure root dir exists, derive session id from existing dirs
    fs.mkdirSync(INTERACTIONS_DIR, { recursive: true });
    this.sessionId = this._nextSessionId();
    this._ensureSessionDir();
  }

  _nextSessionId() {
    try {
      const ids = fs.readdirSync(INTERACTIONS_DIR)
        .map(Number)
        .filter(n => !isNaN(n) && n > 0);
      return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    } catch {
      return 1;
    }
  }

  _ensureSessionDir() {
    this.sessionDir = path.join(INTERACTIONS_DIR, String(this.sessionId));
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  add(interaction) {
    if (this.order.length >= this.maxSize) {
      const oldestId = this.order.shift();
      this.interactions.delete(oldestId);
      this.seqMap.delete(oldestId);
    }
    this.interactions.set(interaction.id, interaction);
    this.order.push(interaction.id);
    this.seq++;
    this.seqMap.set(interaction.id, this.seq);
  }

  get(id) {
    return this.interactions.get(id);
  }

  getAll() {
    return this.order.map(id => this.interactions.get(id));
  }

  save(id) {
    const interaction = this.interactions.get(id);
    if (!interaction) return;
    const seqNum = this.seqMap.get(id);
    if (!seqNum) return;

    const fileContent = {
      request: {
        ...interaction.request,
        endpoint: interaction.endpoint,
        timestamp: interaction.timestamp,
        isStreaming: interaction.isStreaming,
      },
      response: {
        status: interaction.response?.status ?? null,
        headers: interaction.response?.headers ?? {},
        body: interaction.response?.body ?? null,
        sseEvents: interaction.response?.sseEvents ?? [],
        error: interaction.response?.error ?? undefined,
        timing: interaction.timing,
        usage: interaction.usage,
        result: interaction.status,
      },
    };

    const filePath = path.join(this.sessionDir, `${seqNum}.json`);
    fs.writeFile(filePath, JSON.stringify(fileContent, null, 2), (err) => {
      if (err) console.error(`Failed to write interaction ${seqNum}:`, err.message);
    });
  }

  clear() {
    this.interactions.clear();
    this.order = [];
    this.seqMap.clear();
    this.seq = 0;
    this.sessionId++;
    this._ensureSessionDir();
  }
}

module.exports = InteractionStore;

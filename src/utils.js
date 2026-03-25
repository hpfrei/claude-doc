let counter = 0;

function generateId() {
  return `req_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

const FORWARD_REQUEST_HEADERS = [
  'x-api-key',
  'authorization',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
];

const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'request-id',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
];

function filterRequestHeaders(headers) {
  const out = {};
  for (const key of FORWARD_REQUEST_HEADERS) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const key of FORWARD_RESPONSE_HEADERS) {
    const val = headers.get ? headers.get(key) : headers[key];
    if (val) out[key] = val;
  }
  return out;
}

function sanitizeForDashboard(interaction) {
  // Only deep-clone messages (which may contain base64 image data to truncate).
  // Other fields are passed by shallow copy to avoid expensive serialization of large sseEvents arrays.
  const clone = { ...interaction };
  clone.response = { ...interaction.response };
  clone.timing = { ...interaction.timing };
  if (interaction.usage) clone.usage = { ...interaction.usage };
  if (interaction.request) {
    clone.request = { ...interaction.request };
    if (interaction.request.messages) {
      clone.request.messages = interaction.request.messages.map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        const hasImage = msg.content.some(b => b.type === 'image' && b.source?.data);
        if (!hasImage) return msg;
        return {
          ...msg,
          content: msg.content.map(block => {
            if (block.type === 'image' && block.source?.data) {
              return { ...block, source: { ...block.source, data: block.source.data.slice(0, 100) + '...[truncated]' } };
            }
            return block;
          }),
        };
      });
    }
  }
  return clone;
}

module.exports = {
  generateId,
  filterRequestHeaders,
  filterResponseHeaders,
  sanitizeForDashboard,
};

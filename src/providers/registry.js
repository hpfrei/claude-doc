// ============================================================
// Provider registry — maps provider IDs to adapter instances
// ============================================================

const OpenAIProvider = require('./openai');

const providers = {
  openai: new OpenAIProvider(),
};

function getProvider(providerName) {
  return providers[providerName] || null;
}

module.exports = { getProvider };

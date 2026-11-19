'use strict';

// The models people can choose in TruX Code.
//
//   id          what the browser sends and saves (never a vendor model name)
//   name        what people see
//   vertexModel what the model service is called with; it is never shown anywhere in the app
//   thinking    the thinking levels the model accepts
//   limited     true when non-owner accounts have a token allowance on it (see usage.js)
//   tokenLimit  the allowance in tokens for a `limited` model: a hard cap, not a default (see usage.js)
//   ownerOnly   true when only the owner account(s) may use it; everyone else is refused by the server
//   tools       false when the model must never be given tools: no web search, memory or connector tools are
//               declared for it and any tool call it asks for is ignored (see chat.js)
//
// To point a model at a different Vertex AI model, change `vertexModel` here and nowhere else.

// "Extended" in the interface. This is the value the model service receives for the level above High.
const EXTENDED_THINKING = 'XHIGH';
const BASE_THINKING = ['LOW', 'MEDIUM', 'HIGH'];
const ALL_THINKING = Object.freeze([...BASE_THINKING, EXTENDED_THINKING]);

// TruX-3 Oracle is listed first, above Aegis. It is open to every signed-in account, accepts all four thinking
// levels (Low, Medium, High and Extended / XHIGH), and is held to a strict 15,000-token allowance per account.
const ORACLE_TOKEN_LIMIT = 15000;

const MODELS = Object.freeze({
  'trux-3-oracle': Object.freeze({
    id: 'trux-3-oracle',
    name: 'TruX-3 Oracle',
    vertexModel: 'gemini-4-neon',
    thinking: ALL_THINKING,
    limited: true,
    tokenLimit: ORACLE_TOKEN_LIMIT,
    ownerOnly: false,
    tools: true
  }),
  'trux-3-aegis': Object.freeze({
    id: 'trux-3-aegis',
    name: 'TruX-3 Aegis',
    vertexModel: 'gemini-4-hydrogen',
    thinking: ALL_THINKING,
    limited: false,
    ownerOnly: false,
    tools: true
  })
});

const DEFAULT_MODEL_ID = 'trux-3-aegis';

// Returns the model entry for an id the browser sent, or null when it is not a model we offer.
function resolveModel(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  return Object.prototype.hasOwnProperty.call(MODELS, key) ? MODELS[key] : null;
}

// Validates a requested thinking level for a model. Returns the level to use, or null when the value is not a
// thinking level at all. A level the model does not have (Extended on Oracle, for example a saved setting that
// outlived a model switch) is lowered to High rather than failing the request.
function resolveThinking(model, requested) {
  const level = String(requested || 'MEDIUM').trim().toUpperCase();
  if (!ALL_THINKING.includes(level)) return null;
  if (model && !model.thinking.includes(level)) return 'HIGH';
  return level;
}

// Keeps vendor model names out of anything a person can read, such as an upstream error message.
function hideVendorNames(text, replacement) {
  return String(text || '').replace(/\bgemini[\w.-]*/gi, replacement || 'the model');
}

module.exports = {
  ALL_THINKING,
  ORACLE_TOKEN_LIMIT,
  DEFAULT_MODEL_ID,
  EXTENDED_THINKING,
  MODELS,
  hideVendorNames,
  resolveModel,
  resolveThinking
};

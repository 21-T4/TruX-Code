'use strict';

// Who may use which model, and the token allowance for limited models.
//
// A model flagged `limited` gives every account except the owner(s) a strict allowance of `tokenLimit` tokens in
// total (TruX-3 Oracle: 15,000). It is a fixed number in models.js; no setting raises it. The count is every token
// the model service reports for a reply (what was sent in, thought and written, across all tool rounds), and it does
// not reset. chat.js refuses a new reply once the allowance is gone, caps each reply at what is left, and stops a
// reply that is still streaming the moment the running count reaches the limit.
//
// Who is the owner: set OWNER_EMAILS (comma separated) and/or OWNER_UIDS on Cloud Run. An email only counts when
// the account has verified it, so nobody can claim the owner's address by signing up with it. Owners are never
// limited and never counted.
//
// The totals live in the server-only Firestore collection `truxModelUsage/{uid}` as
//   { tokens: { 'trux-3-oracle': <number> }, updatedAt }
// and are only ever written by this server (Admin SDK), never by the browser.

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { MODELS } = require('./models');

const COLLECTION = 'truxModelUsage';

function envList(name) {
  return String(process.env[name] || '').split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
}

// `user` is the verified account from firebase-auth.js.
function isOwner(user) {
  if (!user) return false;
  if (user.uid && envList('OWNER_UIDS').includes(String(user.uid))) return true;
  const email = String(user.email || '').trim().toLowerCase();
  const verified = user.email_verified === true || user.emailVerified === true;
  return Boolean(email && verified && envList('OWNER_EMAILS').some((item) => item.toLowerCase() === email));
}

// True when this account may use the model. Models that are not owner-only are open to every signed-in account.
function canUseModel(user, model) {
  return !model || !model.ownerOnly || isOwner(user);
}

// The strict allowance for a limited model, or null when the model has none.
function limitFor(model) {
  const limit = model && model.limited ? Number(model.tokenLimit) : NaN;
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
}

async function tokensUsed(uid, modelId) {
  const snapshot = await getFirestore().collection(COLLECTION).doc(uid).get();
  const data = snapshot.exists ? snapshot.data() : null;
  const value = data && data.tokens && typeof data.tokens === 'object' ? Number(data.tokens[modelId]) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Returns null when the model has no limit for this account (an unlimited model, or the owner); otherwise
// { limit, used, remaining }. Throws when the count cannot be read: a limit that cannot be checked is not skipped.
async function checkQuota(user, model) {
  const limit = limitFor(model);
  if (limit === null || isOwner(user)) return null;
  const used = await tokensUsed(user.uid, model.id);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

// True once this account has used up its allowance, counting `tokensThisReply` that are not saved yet.
function exceeded(quota, tokensThisReply) {
  if (!quota) return false;
  return quota.used + Math.max(0, Number(tokensThisReply) || 0) >= quota.limit;
}

async function recordUsage(uid, modelId, tokens) {
  const amount = Math.floor(Number(tokens));
  if (!uid || !modelId || !Number.isFinite(amount) || amount <= 0) return;
  await getFirestore().collection(COLLECTION).doc(uid).set({
    tokens: { [modelId]: FieldValue.increment(amount) },
    updatedAt: Date.now()
  }, { merge: true });
}

// What the browser shows: `models` is the allowance next to each limited model, { id: { limited, limit, used,
// remaining } }, and `access` says which owner-only models this account may see and use, { id: { available } }.
// The browser only decides what to show from this; the server refuses an owner-only model on its own.
async function summary(user) {
  const models = {};
  const access = {};
  for (const model of Object.values(MODELS)) {
    if (model.ownerOnly) access[model.id] = { available: canUseModel(user, model) };
    if (!model.limited) continue;
    const quota = await checkQuota(user, model);
    models[model.id] = quota
      ? { limited: true, limit: quota.limit, used: quota.used, remaining: quota.remaining }
      : { limited: false };
  }
  return { models, access };
}

function formatTokens(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

module.exports = {
  canUseModel,
  checkQuota,
  exceeded,
  formatTokens,
  isOwner,
  recordUsage,
  limitFor,
  summary
};

'use strict';

// Encrypts connector credentials (GitHub tokens, API keys, Google refresh tokens) before they are written
// to Firestore. AES-256-GCM with a key derived per user from MCP_ENCRYPTION_KEY, so a copied document
// cannot be decrypted without the key and cannot be replayed into another user's record.
//
// MCP_ENCRYPTION_KEY is a real secret: keep it in Secret Manager, never in .env.example.
//   openssl rand -base64 32 | gcloud secrets create MCP_ENCRYPTION_KEY --data-file=-

const crypto = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');

// If MCP_ENCRYPTION_KEY was never provided to Cloud Run, connectors used to be disabled entirely ("not set up on
// this server yet"), so nothing could be connected. To keep them working, the server then creates one random key
// the first time it is needed and keeps it in Firestore at serverConfig/mcp-vault (only the server's own service
// identity can read it; clients never can). That still encrypts every credential with a per-user derived key,
// but the key sits in the same project as the data, so setting MCP_ENCRYPTION_KEY from Secret Manager remains the
// stronger option and always wins when present.
let fallbackKey = '';
let readyPromise = null;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function activeKey() {
  const fromEnv = String(process.env.MCP_ENCRYPTION_KEY || '').trim();
  return fromEnv.length >= 32 ? fromEnv : fallbackKey;
}

function isConfigured() {
  return activeKey().length >= 32;
}

async function loadFallbackKey() {
  const ref = getFirestore().collection('serverConfig').doc('mcp-vault');
  let key = '';
  await getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const existing = snapshot.exists ? String(snapshot.data().key || '') : '';
    if (existing.length >= 32) { key = existing; return; }
    key = crypto.randomBytes(48).toString('base64url');
    transaction.set(ref, { key, createdAt: Date.now() });
  });
  fallbackKey = key;
  console.warn('MCP_ENCRYPTION_KEY is not set: using a server-generated key stored in Firestore (serverConfig/mcp-vault). Set MCP_ENCRYPTION_KEY from Secret Manager for stronger protection.');
}

// Resolves true when connector credentials can be encrypted. Safe to call often.
function ready() {
  if (isConfigured()) return Promise.resolve(true);
  if (!readyPromise) {
    readyPromise = loadFallbackKey().then(() => true).catch((error) => {
      readyPromise = null;
      console.error('Could not prepare the connector encryption key:', error && (error.code || error.name), error && error.message);
      return false;
    });
  }
  return readyPromise;
}

function keyFor(uid, connectorId) {
  if (!isConfigured()) {
    throw codedError('CONNECTORS_NOT_CONFIGURED',
      'Connectors are not configured. Set MCP_ENCRYPTION_KEY (at least 32 characters) from Secret Manager, or give the Cloud Run service identity Firestore access.');
  }
  const master = Buffer.from(activeKey(), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(String(uid)), Buffer.from('trux-connector:' + connectorId), 32));
}

function encrypt(uid, connectorId, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(uid, connectorId), iv);
  cipher.setAAD(Buffer.from(uid + ':' + connectorId));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function decrypt(uid, connectorId, sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw codedError('CONNECTOR_CREDENTIAL_INVALID', 'The saved credential is unreadable.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(uid, connectorId), Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(uid + ':' + connectorId));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    if (error && error.code === 'CONNECTORS_NOT_CONFIGURED') throw error;
    throw codedError('CONNECTOR_CREDENTIAL_INVALID', 'The saved credential could not be decrypted. Connect the app again.');
  }
}

module.exports = { decrypt, encrypt, isConfigured, ready };

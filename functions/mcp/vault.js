'use strict';

// Encrypts connector credentials (GitHub tokens, API keys, Google refresh tokens) before they are written
// to Firestore. AES-256-GCM with a key derived per user from MCP_ENCRYPTION_KEY, so a copied document
// cannot be decrypted without the key and cannot be replayed into another user's record.
//
// MCP_ENCRYPTION_KEY is a real secret: keep it in Secret Manager, never in .env.example.
//   openssl rand -base64 32 | gcloud secrets create MCP_ENCRYPTION_KEY --data-file=-

const crypto = require('node:crypto');

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isConfigured() {
  return String(process.env.MCP_ENCRYPTION_KEY || '').trim().length >= 32;
}

function keyFor(uid, connectorId) {
  if (!isConfigured()) {
    throw codedError('CONNECTORS_NOT_CONFIGURED',
      'Connectors are not configured. Set MCP_ENCRYPTION_KEY (at least 32 characters) from Secret Manager.');
  }
  const master = Buffer.from(String(process.env.MCP_ENCRYPTION_KEY).trim(), 'utf8');
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

module.exports = { decrypt, encrypt, isConfigured };

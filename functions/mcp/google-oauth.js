'use strict';

// Per-user Google sign-in for the Google Workspace MCP servers.
//
// Google's remote MCP servers do not support dynamic client registration, so this deployment needs its own
// OAuth client (type "Web application", with the AI-agent option selected, per Google's setup guide):
//   GOOGLE_OAUTH_CLIENT_ID      public identifier, fine in the environment
//   GOOGLE_OAUTH_CLIENT_SECRET  real secret, keep it in Secret Manager
// and this redirect URI registered on that client:  <APP_ORIGIN>/connectors/google/callback
//
// Flow: authorization code + PKCE. The one-time `state` lives in Firestore (hashed, 10 minutes, single use)
// and is bound to the user who started it. The refresh token is encrypted by vault.js and never reaches the browser.

const crypto = require('node:crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const vault = require('./vault');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const STATE_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_DOC = 'google-account';

const accessTokens = new Map(); // uid -> { token, expires }

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clientId() { return String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(); }
function clientSecret() { return String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(); }
function isConfigured() { return Boolean(clientId() && clientSecret() && vault.isConfigured()); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function connectorsRef(uid) { return getFirestore().collection('users').doc(uid).collection('connectors'); }

async function startAuthorization(uid, entry, origin) {
  if (!isConfigured()) {
    throw codedError('GOOGLE_OAUTH_NOT_CONFIGURED',
      'Google sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
  }
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = origin + '/connectors/google/callback';

  await getFirestore().collection('oauthStates').doc(sha256(state)).set({
    uid,
    connectorId: entry.id,
    verifier,
    redirectUri,
    expiresAt: Date.now() + STATE_TTL_MS,
    expireAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000)
  });

  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: entry.auth.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true'
  });
  return AUTH_URL + '?' + params.toString();
}

async function tokenRequest(body) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...body }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = codedError(data.error === 'invalid_grant' ? 'GOOGLE_REAUTH_REQUIRED' : 'GOOGLE_TOKEN_FAILED',
      'Google did not accept the sign-in (' + String(data.error || response.status) + ').');
    throw error;
  }
  return data;
}

// Completes the redirect. `sessionUid` is the signed-in TruX user on this request and must match the user
// who started the flow, so a link opened in another account cannot attach a Google account to this one.
async function completeAuthorization(sessionUid, code, state) {
  const stateRef = getFirestore().collection('oauthStates').doc(sha256(String(state || '')));
  const snapshot = await stateRef.get();
  if (!snapshot.exists) throw codedError('GOOGLE_STATE_INVALID', 'This sign-in link has expired. Start again.');
  await stateRef.delete();
  const saved = snapshot.data();
  if (saved.expiresAt < Date.now() || saved.uid !== sessionUid) {
    throw codedError('GOOGLE_STATE_INVALID', 'This sign-in link has expired. Start again.');
  }

  const tokens = await tokenRequest({
    code: String(code || ''),
    code_verifier: saved.verifier,
    redirect_uri: saved.redirectUri,
    grant_type: 'authorization_code'
  });

  const accountRef = connectorsRef(sessionUid).doc(ACCOUNT_DOC);
  const existing = await accountRef.get();
  const previous = existing.exists ? existing.data() : {};
  let refreshToken = tokens.refresh_token || '';
  if (!refreshToken && previous.enc) {
    try { refreshToken = vault.decrypt(sessionUid, ACCOUNT_DOC, previous.enc).refreshToken; } catch { /* re-consent below */ }
  }
  if (!refreshToken) throw codedError('GOOGLE_TOKEN_FAILED', 'Google did not return a long-lived sign-in. Try connecting again.');

  const granted = new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean));
  (previous.scopes || []).forEach((scope) => granted.add(scope));

  await accountRef.set({
    enc: vault.encrypt(sessionUid, ACCOUNT_DOC, { refreshToken }),
    scopes: Array.from(granted),
    updatedAt: Date.now()
  });
  accessTokens.set(sessionUid, {
    token: tokens.access_token,
    expires: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000 - 60000
  });
  return { connectorId: saved.connectorId, scopes: Array.from(granted) };
}

async function getAccessToken(uid) {
  const cached = accessTokens.get(uid);
  if (cached && cached.expires > Date.now()) return cached.token;

  const snapshot = await connectorsRef(uid).doc(ACCOUNT_DOC).get();
  if (!snapshot.exists) throw codedError('GOOGLE_REAUTH_REQUIRED', 'Connect your Google account first.');
  const { refreshToken } = vault.decrypt(uid, ACCOUNT_DOC, snapshot.data().enc);
  try {
    const tokens = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
    accessTokens.set(uid, {
      token: tokens.access_token,
      expires: Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000 - 60000
    });
    return tokens.access_token;
  } catch (error) {
    if (error.code === 'GOOGLE_REAUTH_REQUIRED') {
      accessTokens.delete(uid);
      await connectorsRef(uid).doc(ACCOUNT_DOC).delete().catch(() => {});
    }
    throw error;
  }
}

async function grantedScopes(uid) {
  const snapshot = await connectorsRef(uid).doc(ACCOUNT_DOC).get();
  return new Set(snapshot.exists ? snapshot.data().scopes || [] : []);
}

// Called when the last Google connector is removed: revoke the grant at Google and forget the token.
async function revokeAccount(uid) {
  const ref = connectorsRef(uid).doc(ACCOUNT_DOC);
  const snapshot = await ref.get();
  accessTokens.delete(uid);
  if (!snapshot.exists) return;
  try {
    const { refreshToken } = vault.decrypt(uid, ACCOUNT_DOC, snapshot.data().enc);
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    console.warn('Google token revocation could not be confirmed:', error && (error.code || error.name));
  }
  await ref.delete();
}

module.exports = {
  ACCOUNT_DOC,
  completeAuthorization,
  getAccessToken,
  grantedScopes,
  isConfigured,
  revokeAccount,
  startAuthorization
};

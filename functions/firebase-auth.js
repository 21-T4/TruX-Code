'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const SESSION_DURATION_MS = 400 * 24 * 60 * 60 * 1000;
const SESSION_COLLECTION = 'truxCodeSessions';

// A verified session is remembered in memory for a short time, so a burst of requests (chat history, chat
// stream, plugin calls) costs one Firestore lookup instead of one each. The entry is keyed by a hash of the
// cookie, never the cookie itself, and it is dropped the moment the session is revoked (sign out).
const VERIFIED_CACHE_MS = 30 * 1000;
const VERIFIED_CACHE_MAX = 500;
const verifiedSessions = new Map();

// Looking an account up in Firebase Auth (is it disabled, were its sessions revoked) is a slow network call, so
// it is shared between all sessions of the same user and refreshed in the background:
//   - younger than ACCOUNT_FRESH_MS: used as is;
//   - younger than ACCOUNT_MAX_STALE_MS: used immediately while a refresh runs behind it;
//   - older: the request waits for a fresh answer.
// A disabled account or a "sign out everywhere" therefore stops working within about ACCOUNT_FRESH_MS plus the
// session cache above (about a minute), at most one request later when the refresh is still running, and never
// lets anything slip past the cookie checks below. Answers that came from stale data are never cached.
const ACCOUNT_FRESH_MS = 30 * 1000;
const ACCOUNT_MAX_STALE_MS = 2 * 60 * 1000;
const ACCOUNT_CACHE_MAX = 500;
const accountStates = new Map();

// Renewing a session pushes its expiry forward. That is a write, so it happens at most this often per session
// instead of on every page load.
const RENEW_EVERY_MS = 60 * 60 * 1000;

function cacheKeyFor(value) {
  return crypto.createHash('sha256').update('trux-session-cache:' + value, 'utf8').digest('hex');
}

function readVerifiedCache(value) {
  const key = cacheKeyFor(value);
  const entry = verifiedSessions.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) { verifiedSessions.delete(key); return null; }
  return entry;
}

function writeVerifiedCache(value, user, renewedAt) {
  if (verifiedSessions.size >= VERIFIED_CACHE_MAX) {
    verifiedSessions.delete(verifiedSessions.keys().next().value);
  }
  verifiedSessions.set(cacheKeyFor(value), { user, renewedAt, expires: Date.now() + VERIFIED_CACHE_MS });
}

async function refreshAccount(uid) {
  try {
    const account = await getFirebaseAuth().getUser(uid);
    if (accountStates.size >= ACCOUNT_CACHE_MAX) accountStates.delete(accountStates.keys().next().value);
    accountStates.set(uid, { account, at: Date.now(), refreshing: false });
    return account;
  } catch (error) {
    accountStates.delete(uid);
    throw error;
  }
}

// Returns { account, stale }. `stale` means the answer came from the background-refresh window, so callers must
// not remember anything derived from it for longer than this one request.
async function loadAccount(uid) {
  const entry = accountStates.get(uid);
  const age = entry ? Date.now() - entry.at : Infinity;
  if (entry && age < ACCOUNT_FRESH_MS) return { account: entry.account, stale: false };
  if (entry && age < ACCOUNT_MAX_STALE_MS) {
    if (!entry.refreshing) {
      entry.refreshing = true;
      refreshAccount(uid).catch(() => { const current = accountStates.get(uid); if (current) current.refreshing = false; });
    }
    return { account: entry.account, stale: true };
  }
  return { account: await refreshAccount(uid), stale: false };
}

function getFirebaseAuth() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId) {
    const error = new Error('Firebase project is not configured.');
    error.code = 'CONFIG_MISSING';
    throw error;
  }

  if (admin.apps.length === 0) {
    // Cloud Run uses Application Default Credentials. Never ship a service-account key.
    admin.initializeApp({ projectId });
  }

  return admin.auth();
}

function isSecureRequest(req) {
  return Boolean(
    process.env.K_SERVICE ||
    process.env.NODE_ENV === 'production' ||
    (req && (req.secure || req.get('x-forwarded-proto') === 'https'))
  );
}

function getSessionCookieName(req) {
  // __Host- cookies must be Secure, have Path=/, and omit Domain.
  return isSecureRequest(req) ? '__Host-trux_code_session' : 'trux_code_session';
}

function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DURATION_MS
  };
}

function readRequestCookie(req, name) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function parsePersistentSession(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}

function hashSessionSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function invalidSessionError() {
  const error = new Error('Your TruX session is no longer valid. Please sign in again.');
  error.code = 'auth/session-cookie-expired';
  return error;
}

async function createPersistentSession(decoded) {
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
    throw new Error('A verified Firebase account is required to create a TruX session.');
  }

  // The browser receives the random secret once. Firestore stores only its SHA-256
  // digest, so a database read alone cannot be used as a sign-in credential.
  const id = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();

  await getFirestore().collection(SESSION_COLLECTION).doc(id).create({
    uid: decoded.uid,
    tokenHash: hashSessionSecret(secret),
    authTime: Number(decoded.auth_time) || Math.floor(now / 1000),
    signInProvider: String(decoded.firebase && decoded.firebase.sign_in_provider || ''),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + SESSION_DURATION_MS
  });

  return id + '.' + secret;
}

async function verifyPersistentSession(value, options) {
  const parsed = parsePersistentSession(value);
  if (!parsed) return null;

  const renew = Boolean(options && options.renew === true);
  const cached = readVerifiedCache(value);
  if (cached && (!renew || Date.now() - cached.renewedAt < RENEW_EVERY_MS)) return cached.user;

  const reference = getFirestore().collection(SESSION_COLLECTION).doc(parsed.id);
  const snapshot = await reference.get();
  if (!snapshot.exists) throw invalidSessionError();

  const session = snapshot.data() || {};
  const expected = Buffer.from(String(session.tokenHash || ''), 'hex');
  const actual = Buffer.from(hashSessionSecret(parsed.secret), 'hex');

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw invalidSessionError();
  }

  if (!Number.isFinite(Number(session.expiresAt)) || Number(session.expiresAt) <= Date.now()) {
    await reference.delete().catch(() => {});
    throw invalidSessionError();
  }

  let account;
  let stale = false;
  try {
    ({ account, stale } = await loadAccount(String(session.uid || '')));
  } catch (error) {
    if (error && error.code === 'auth/user-not-found') {
      await reference.delete().catch(() => {});
      throw invalidSessionError();
    }
    throw error;
  }

  if (account.disabled) {
    await reference.delete().catch(() => {});
    verifiedSessions.delete(cacheKeyFor(value));
    throw invalidSessionError();
  }

  const tokenValidAfter = Date.parse(account.tokensValidAfterTime || '') / 1000;
  if (Number.isFinite(tokenValidAfter) && tokenValidAfter > 0 &&
      Number(session.authTime || 0) < tokenValidAfter) {
    await reference.delete().catch(() => {});
    verifiedSessions.delete(cacheKeyFor(value));
    throw invalidSessionError();
  }

  let renewedAt = Number(session.lastSeenAt) || 0;
  if (renew && Date.now() - renewedAt >= RENEW_EVERY_MS) {
    const now = Date.now();
    await reference.update({ lastSeenAt: now, expiresAt: now + SESSION_DURATION_MS });
    renewedAt = now;
  }

  const providers = Array.isArray(account.providerData) ? account.providerData : [];
  const verified = {
    uid: account.uid,
    email: account.email || '',
    name: account.displayName || '',
    picture: account.photoURL || '',
    email_verified: Boolean(account.emailVerified),
    hasPasswordProvider: providers.some((provider) => provider.providerId === 'password'),
    hasGoogleProvider: providers.some((provider) => provider.providerId === 'google.com'),
    auth_time: Number(session.authTime) || 0,
    firebase: { sign_in_provider: String(session.signInProvider || '') }
  };
  if (!stale) writeVerifiedCache(value, verified, renewedAt);
  return verified;
}

// Opens the Firebase Admin and Firestore connections (credential fetch, TLS, gRPC channel) before the first
// person needs them, so the first sign-in check on a fresh instance is not the slow one. Safe to call anytime.
async function warmUp() {
  const auth = getFirebaseAuth();
  await Promise.allSettled([
    getFirestore().collection(SESSION_COLLECTION).doc('warm-up').get(),
    auth.getUser('trux-warm-up')
  ]);
}

async function revokePersistentSession(value) {
  const parsed = parsePersistentSession(value);
  if (!parsed) return false;

  const reference = getFirestore().collection(SESSION_COLLECTION).doc(parsed.id);
  const snapshot = await reference.get();
  if (!snapshot.exists) return false;

  const session = snapshot.data() || {};
  const expected = Buffer.from(String(session.tokenHash || ''), 'hex');
  const actual = Buffer.from(hashSessionSecret(parsed.secret), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return false;
  }

  verifiedSessions.delete(cacheKeyFor(value));
  await reference.delete();
  return true;
}

function readBearerToken(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function verifyRequestUser(req) {
  const auth = getFirebaseAuth();
  const cookie = readRequestCookie(req, getSessionCookieName(req));

  if (cookie) {
    if (parsePersistentSession(cookie)) {
      return verifyPersistentSession(cookie);
    }

    try {
      // Compatibility with existing Firebase session cookies during migration.
      return await auth.verifySessionCookie(cookie, true);
    } catch (cookieError) {
      const bearerToken = readBearerToken(req);
      if (!bearerToken) throw cookieError;
      return auth.verifyIdToken(bearerToken, true);
    }
  }

  const bearerToken = readBearerToken(req);
  if (!bearerToken) {
    const error = new Error('Sign in to use TruX Code.');
    error.code = 'auth/missing-token';
    throw error;
  }

  return auth.verifyIdToken(bearerToken, true);
}

module.exports = {
  SESSION_DURATION_MS,
  createPersistentSession,
  getFirebaseAuth,
  getSessionCookieName,
  getSessionCookieOptions,
  isSecureRequest,
  parsePersistentSession,
  readRequestCookie,
  revokePersistentSession,
  verifyPersistentSession,
  verifyRequestUser,
  warmUp
};

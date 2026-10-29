'use strict';

const admin = require('firebase-admin');
const runtimeConfig = require('../config/runtime-config.json');

const SESSION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

function getFirebaseAuth() {
  const projectId = runtimeConfig.firebase && runtimeConfig.firebase.projectId;
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

function readBearerToken(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function verifyRequestUser(req) {
  const auth = getFirebaseAuth();
  const cookie = readRequestCookie(req, getSessionCookieName(req));

  if (cookie) {
    try {
      // checkRevoked=true rejects disabled users and revoked Firebase sessions.
      return await auth.verifySessionCookie(cookie, true);
    } catch (cookieError) {
      // Keep compatibility with clients still using the previous ID-token API.
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
  getFirebaseAuth,
  getSessionCookieName,
  getSessionCookieOptions,
  isSecureRequest,
  readRequestCookie,
  verifyRequestUser
};

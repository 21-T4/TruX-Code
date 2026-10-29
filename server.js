'use strict';

const express = require('express');
const path = require('node:path');
const { chatHandler } = require('./functions/api/chat');
const runtimeConfig = require('./config/runtime-config.json');
const {
  SESSION_DURATION_MS,
  getFirebaseAuth,
  getSessionCookieName,
  getSessionCookieOptions,
  isSecureRequest,
  readRequestCookie
} = require('./functions/firebase-auth');

const app = express();
const publicDirectory = path.join(__dirname, 'public');
const DEFAULT_APP_ORIGIN = 'https://trux-code.trux.website';

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

app.use(express.json({ limit: '2mb' }));

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const protocolHeader = (req.get('x-forwarded-proto') || req.protocol || 'http')
    .split(',')[0].trim();
  const requestOrigin = req.get('host') ? protocolHeader + '://' + req.get('host') : '';
  const configuredOrigin = process.env.APP_ORIGIN || DEFAULT_APP_ORIGIN;
  const allowedOrigins = new Set([configuredOrigin, requestOrigin]);
  const fetchSite = req.get('sec-fetch-site');

  if (!isSecureRequest(req)) {
    allowedOrigins.add('http://localhost:8080');
    allowedOrigins.add('http://127.0.0.1:8080');
  }

  if (!origin || !allowedOrigins.has(origin) || (fetchSite && fetchSite !== 'same-origin')) {
    return res.status(403).json({ error: 'Cross-origin request rejected.' });
  }

  next();
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Firebase web config is public client config, not a server credential.
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const firebaseConfig = runtimeConfig.firebase;
  const configured = ['apiKey', 'authDomain', 'projectId', 'appId']
    .every((key) => typeof firebaseConfig[key] === 'string' && firebaseConfig[key].length > 0);

  res.status(200).json({
    configured,
    firebaseConfig: configured ? firebaseConfig : null
  });
});

// Exchange a Firebase ID token for a short-lived, HttpOnly server session.
// Firebase Authentication continues to own the account and password credential.
app.post('/api/session/login', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const idToken = req.body && req.body.idToken;

  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 16384) {
    return res.status(400).json({ error: 'A valid Firebase sign-in token is required.' });
  }

  try {
    const auth = getFirebaseAuth();
    await auth.verifyIdToken(idToken, true);
    const sessionCookie = await auth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS
    });

    res.cookie(getSessionCookieName(req), sessionCookie, getSessionCookieOptions(req));
    return res.status(204).end();
  } catch (error) {
    const code = String(error && error.code || '');
    console.error('Firebase session creation failed:', code || (error && error.name) || 'unknown');
    const status = code.startsWith('auth/') ? 401 : 503;
    return res.status(status).json({
      error: status === 401
        ? 'Your sign-in could not be verified. Sign in again.'
        : 'Secure session setup is temporarily unavailable. Please retry.'
    });
  }
});

// Restore the Firebase client SDK from a valid server session if browser storage
// was cleared or unavailable. The returned custom token is never cached.
app.post('/api/session/bootstrap', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cookieName = getSessionCookieName(req);
  const sessionCookie = readRequestCookie(req, cookieName);

  if (!sessionCookie) return res.status(204).end();

  try {
    const auth = getFirebaseAuth();
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    const customToken = await auth.createCustomToken(decoded.uid);
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ customToken });
  } catch (error) {
    const code = String(error && error.code || '');
    console.error('Firebase session restore failed:', code || (error && error.name) || 'unknown');

    const invalidSession = /auth\/(session-cookie-expired|session-cookie-revoked|invalid-session-cookie|user-disabled|user-not-found|id-token-revoked)/i.test(code);
    if (invalidSession) {
      res.clearCookie(cookieName, {
        httpOnly: true,
        secure: isSecureRequest(req),
        sameSite: 'lax',
        path: '/'
      });
      return res.status(204).end();
    }

    return res.status(503).json({ error: 'Secure session restore is temporarily unavailable.' });
  }
});

app.post('/api/session/logout', requireSameOrigin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.clearCookie(getSessionCookieName(req), {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/'
  });
  return res.status(204).end();
});

app.post('/api/chat', requireSameOrigin, chatHandler);

// Keep the private runtime file inaccessible over HTTP.
app.use('/config', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(publicDirectory, {
  dotfiles: 'ignore',
  index: 'index.html',
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(publicDirectory, 'index.html'));
});

const port = Number(process.env.PORT || 8080);

if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log('TruX Code listening on port ' + port);
  });
}

module.exports = app;

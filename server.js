'use strict';

const express = require('express');
const compression = require('compression');
const path = require('node:path');
const { chatHandler, jobStatusHandler, jobStopHandler } = require('./functions/api/chat');
const { transcribeHandler } = require('./functions/api/transcribe');
const cli = require('./functions/api/cli');
const { ttsHandler } = require('./functions/api/tts');
const { renderIndex } = require('./functions/html-patches');
const mcp = require('./functions/mcp/manager');
const memory = require('./functions/memory');
const jobs = require('./functions/jobs');
const chatStore = require('./functions/store');
const { getFirestore } = require('firebase-admin/firestore');
const {
  createPersistentSession,
  getFirebaseAuth,
  getSessionCookieName,
  getSessionCookieOptions,
  isSecureRequest,
  parsePersistentSession,
  readRequestCookie,
  revokePersistentSession,
  verifyPersistentSession,
  verifyRequestUser
} = require('./functions/firebase-auth');

const app = express();
const publicDirectory = path.join(__dirname, 'public');
const DEFAULT_APP_ORIGIN = 'https://trux-code.trux.website';

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

// Compress the app shell and static files (the Firebase sign-in SDK is the biggest download on first load).
// API and connector routes are skipped: replies stream as they are written and must never be buffered.
const compress = compression();
app.use((req, res, next) => (req.path.startsWith('/api/') || req.path.startsWith('/connectors/'))
  ? next() : compress(req, res, next));

const parseDefaultJson = express.json({ limit: '2mb' });
const parseChatJson = express.json({ limit: '12mb' });
const parseCliJson = express.json({ limit: '8mb' });

// Only chat and transcription requests accept bounded media payloads. Validate the origin before parsing
// the larger body so rejected cross-origin requests do not consume the larger parser.
app.use((req, res, next) => {
  if (req.path === '/api/chat' || req.path === '/api/transcribe') return next();
  if (req.path === '/api/cli/chat') return parseCliJson(req, res, next);
  return parseDefaultJson(req, res, next);
});

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

function publicSessionUser(decoded, profile) {
  const stored = profile && typeof profile === 'object' ? profile : {};
  return {
    uid: decoded.uid,
    email: stored.email || decoded.email || '',
    displayName: stored.displayName || decoded.name || '',
    photoURL: stored.photoURL || decoded.picture || '',
    emailVerified: typeof stored.emailVerified === 'boolean'
      ? stored.emailVerified
      : Boolean(decoded.email_verified),
    signInProvider: String(decoded.firebase && decoded.firebase.sign_in_provider || ''),
    hasPasswordProvider: typeof decoded.hasPasswordProvider === 'boolean' ? decoded.hasPasswordProvider : null,
    hasGoogleProvider: typeof decoded.hasGoogleProvider === 'boolean' ? decoded.hasGoogleProvider : null,
    isServerSession: true
  };
}

async function syncAccountDocument(user) {
  const db = getFirestore();
  const reference = db.collection('users').doc(user.uid);
  const previous = await reference.get();
  const now = Date.now();
  const existing = previous.exists ? previous.data() : {};
  await reference.set({
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || user.name || '',
    photoURL: user.photoURL || user.picture || '',
    emailVerified: Boolean(user.emailVerified || user.email_verified),
    createdAt: existing.createdAt || now,
    updatedAt: now
  }, { merge: true });
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Firebase web config is public client config, not a server credential.
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const firebaseConfig = {
    apiKey: String(process.env.FIREBASE_API_KEY || '').trim(),
    authDomain: String(process.env.FIREBASE_AUTH_DOMAIN || '').trim(),
    projectId: String(process.env.FIREBASE_PROJECT_ID || '').trim(),
    storageBucket: String(process.env.FIREBASE_STORAGE_BUCKET || '').trim(),
    messagingSenderId: String(process.env.FIREBASE_MESSAGING_SENDER_ID || '').trim(),
    appId: String(process.env.FIREBASE_APP_ID || '').trim(),
    measurementId: String(process.env.FIREBASE_MEASUREMENT_ID || '').trim()
  };
  const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const missingKeys = requiredKeys.filter((key) =>
    typeof firebaseConfig[key] !== 'string' || firebaseConfig[key].trim().length === 0
  );
  const configured = missingKeys.length === 0;

  res.status(configured ? 200 : 503).json({
    configured,
    firebaseConfig: configured ? firebaseConfig : null,
    ...(configured ? {} : {
      error: 'Firebase web configuration is incomplete in the TruX Code environment file.',
      missingKeys
    })
  });
});

// Exchange a freshly verified Firebase ID token for a random, server-owned TruX session.
// The browser receives only an opaque HttpOnly token; Firestore stores its hash, never a password.
app.post('/api/session/login', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const idToken = req.body && req.body.idToken;

  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 16384) {
    return res.status(400).json({ error: 'A valid Firebase sign-in token is required.' });
  }

  try {
    const auth = getFirebaseAuth();
    const decodedIdToken = await auth.verifyIdToken(idToken, true);
    const cookieName = getSessionCookieName(req);
    const existingCookie = readRequestCookie(req, cookieName);

    const authAgeSeconds = Math.floor(Date.now() / 1000) - Number(decodedIdToken.auth_time || 0);
    const recentlyAuthenticated = authAgeSeconds >= -60 && authAgeSeconds <= 5 * 60;

    // An existing session only matters when the sign-in itself is not fresh: it is what authorizes a renewal.
    // After a fresh sign-in the check would cost a Firestore and Firebase Auth round trip for nothing.
    if (!recentlyAuthenticated) {
      let existingSessionMatchesUser = false;
      if (existingCookie) {
        try {
          const existingSession = parsePersistentSession(existingCookie)
            ? await verifyPersistentSession(existingCookie)
            : await auth.verifySessionCookie(existingCookie, true);
          existingSessionMatchesUser = existingSession.uid === decodedIdToken.uid;
        } catch {
          // Invalid, expired, or revoked cookies cannot authorize session renewal.
        }
      }
      if (!existingSessionMatchesUser) {
        return res.status(401).json({
          error: 'Please sign in again to renew your secure TruX session.'
        });
      }
    }

    // The profile copy is best effort and independent of the session, so both run at the same time.
    const [, sessionCookie] = await Promise.all([
      syncAccountDocument({
        uid: decodedIdToken.uid,
        email: decodedIdToken.email || '',
        name: decodedIdToken.name || '',
        picture: decodedIdToken.picture || '',
        email_verified: Boolean(decodedIdToken.email_verified)
      }).catch((profileError) => {
        console.error('Firebase account profile sync deferred; Auth sign-in remains valid:',
          profileError && (profileError.code || profileError.name) || 'unknown');
      }),
      createPersistentSession(decodedIdToken)
    ]);
    if (existingCookie) {
      try {
        await revokePersistentSession(existingCookie);
      } catch (revokeError) {
        console.error('Previous TruX session cleanup deferred:',
          revokeError && (revokeError.code || revokeError.name) || 'unknown');
      }
    }

    res.cookie(cookieName, sessionCookie, getSessionCookieOptions(req));
    return res.status(204).end();
  } catch (error) {
    const code = String(error && error.code || '');
    console.error('TruX session creation failed:', code || (error && error.name) || 'unknown');
    const invalidCredential = new Set([
      'auth/argument-error',
      'auth/invalid-id-token',
      'auth/id-token-expired',
      'auth/id-token-revoked',
      'auth/user-disabled',
      'auth/user-not-found'
    ]).has(code);
    const status = invalidCredential ? 401 : 503;
    return res.status(status).json({
      error: invalidCredential
        ? 'Your sign-in could not be verified. Sign in again.'
        : 'Persistent sign-in storage is unavailable. Check that Firestore is enabled in project trux-ai and that the Cloud Run service identity has Firestore access.'
    });
  }
});

// Restore the account from the persistent HttpOnly TruX cookie. Upgrade existing
// 14-day Firebase session cookies to the new opaque, server-verified format once.
app.post('/api/session/bootstrap', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cookieName = getSessionCookieName(req);
  const sessionCookie = readRequestCookie(req, cookieName);

  if (!sessionCookie) return res.status(204).end();

  try {
    const auth = getFirebaseAuth();
    let decoded;
    let persistentCookie = sessionCookie;

    if (parsePersistentSession(sessionCookie)) {
      decoded = await verifyPersistentSession(sessionCookie, { renew: true });
    } else {
      decoded = await auth.verifySessionCookie(sessionCookie, true);
      persistentCookie = await createPersistentSession(decoded);
      decoded = await verifyPersistentSession(persistentCookie);
      res.cookie(cookieName, persistentCookie, getSessionCookieOptions(req));
    }

    if (parsePersistentSession(sessionCookie)) {
      // Refresh both the browser cookie and server-side expiry when the user returns.
      res.cookie(cookieName, persistentCookie, getSessionCookieOptions(req));
    }

    let profile = null;
    try {
      const snapshot = await getFirestore().collection('users').doc(decoded.uid).get();
      if (snapshot.exists) profile = snapshot.data();
    } catch (profileError) {
      console.error('Firebase profile read failed:',
        profileError && (profileError.code || profileError.name) || 'unknown');
    }

    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ user: publicSessionUser(decoded, profile) });
  } catch (error) {
    const code = String(error && error.code || '');
    console.error('TruX session restore failed:', code || (error && error.name) || 'unknown');

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

    return res.status(503).json({
      error: 'Persistent TruX session restoration is unavailable. Check Firestore access for the Cloud Run service identity.'
    });
  }
});

app.post('/api/session/logout', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cookieName = getSessionCookieName(req);
  const sessionCookie = readRequestCookie(req, cookieName);

  try {
    await revokePersistentSession(sessionCookie);
  } catch (error) {
    console.error('TruX session revocation failed:', error && (error.code || error.name) || 'unknown');
    return res.status(503).json({ error: 'The secure session could not be revoked. Please retry sign out.' });
  }

  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/'
  });
  return res.status(204).end();
});

app.post('/api/account/profile', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const displayName = String(req.body && req.body.displayName || '').trim();
  if (displayName.length > 80) {
    return res.status(400).json({ error: 'Your display name must be 80 characters or fewer.' });
  }

  try {
    const decoded = await verifyRequestUser(req);
    const updated = await getFirebaseAuth().updateUser(decoded.uid, {
      displayName: displayName || null
    });
    const user = {
      uid: updated.uid,
      email: updated.email || decoded.email || '',
      displayName: updated.displayName || '',
      photoURL: updated.photoURL || decoded.picture || '',
      emailVerified: Boolean(updated.emailVerified),
      signInProvider: String(decoded.firebase && decoded.firebase.sign_in_provider || ''),
      isServerSession: true
    };
    try {
      await syncAccountDocument(user);
    } catch (profileError) {
      console.error('Firebase account profile sync failed:',
        profileError && (profileError.code || profileError.name) || 'unknown');
    }
    return res.status(200).json({ user });
  } catch (error) {
    const code = String(error && error.code || '');
    const status = code.startsWith('auth/') ? 401 : 503;
    console.error('Account profile update failed:', code || (error && error.name) || 'unknown');
    return res.status(status).json({
      error: status === 401
        ? 'Your sign-in expired. Sign in again before changing your profile.'
        : 'Your profile could not be updated right now. Check Firebase Authentication permissions for the Cloud Run service identity.'
    });
  }
});

// ---- Chats ---------------------------------------------------------------------------------
// Account-scoped cloud chat history (see functions/store.js). Firestore is accessed only by the server after
// verifying the HttpOnly session; clients can never choose another UID.
function storageFailure(res, error, signedOutMessage, label) {
  const code = String(error && error.code || '');
  const status = code.startsWith('auth/') ? 401 : 503;
  console.error(label, code || (error && error.name) || 'unknown');
  return res.status(status).json({
    error: status === 401
      ? signedOutMessage
      : 'Cloud chat storage is unavailable. Enable the default Firestore database in project trux-ai and grant the Cloud Run service identity roles/datastore.user.'
  });
}

// The sidebar list: chat titles and times only. Messages are fetched for the chat that is opened.
app.get('/api/chats', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    return res.status(200).json({ conversations: await chatStore.listChats(user.uid) });
  } catch (error) {
    return storageFailure(res, error, 'Your sign-in expired. Sign in again to open your chats.', 'Cloud chat list failed:');
  }
});

app.get('/api/chats/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!chatStore.ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid conversation ID.' });
  try {
    const user = await verifyRequestUser(req);
    const chat = await chatStore.getChat(user.uid, id);
    if (!chat) return res.status(404).json({ error: 'That chat was not found.' });
    return res.status(200).json(chat);
  } catch (error) {
    return storageFailure(res, error, 'Your sign-in expired. Sign in again to open your chats.', 'Cloud chat read failed:');
  }
});

app.put('/api/chats/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!chatStore.ID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'Invalid conversation ID.' });
  }

  const body = req.body || {};
  if (body.titleOnly === true) {
    try {
      const user = await verifyRequestUser(req);
      await chatStore.renameChat(user.uid, id, body.title);
      return res.status(200).json({ saved: true });
    } catch (error) {
      return storageFailure(res, error, 'Your sign-in expired. Sign in again before saving chats.', 'Cloud chat rename failed:');
    }
  }
  if (!Array.isArray(body.messages)) {
    return res.status(400).json({ error: 'Conversation messages must be an array.' });
  }

  let totalCharacters = 0;
  const messages = [];
  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || message.content.length > 200000) {
      return res.status(400).json({ error: 'A chat message has an invalid role or content.' });
    }
    totalCharacters += message.content.length;
    if (totalCharacters > 1800000) {
      return res.status(413).json({ error: 'This conversation is too large to sync. Keep the browser copy and start a new chat.' });
    }
    messages.push({
      role: message.role,
      content: message.content,
      error: typeof message.error === 'string' ? message.error.slice(0, 3000) : '',
      activity: chatStore.normalizeActivitySteps(message.activity)
    });
  }

  try {
    const user = await verifyRequestUser(req);
    const result = await chatStore.saveChat(user.uid, id, body, messages);
    return res.status(200).json({ saved: true, ...(result.ignoredStaleWrite ? { ignoredStaleWrite: true } : {}) });
  } catch (error) {
    if (error && error.code === 'TOO_LARGE') return res.status(413).json({ error: error.message });
    return storageFailure(res, error, 'Your sign-in expired. Sign in again before saving chats.', 'Cloud chat write failed:');
  }
});

app.delete('/api/chats/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!chatStore.ID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'Invalid conversation ID.' });
  }
  try {
    const user = await verifyRequestUser(req);
    await chatStore.deleteChat(user.uid, id);
    return res.status(204).end();
  } catch (error) {
    return storageFailure(res, error, 'Your sign-in expired. Sign in again before deleting chats.', 'Cloud chat delete failed:');
  }
});

// ---- Memory --------------------------------------------------------------------------------
function memoryFailure(res, error) {
  const code = String(error && error.code || '');
  if (code.startsWith('auth/')) return res.status(401).json({ error: 'Your sign-in expired. Sign in again to manage memory.' });
  console.error('Memory request failed:', code || (error && error.name) || 'unknown');
  return res.status(503).json({ error: 'Memory is unavailable right now. Try again in a moment.' });
}

app.get('/api/memories', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    return res.status(200).json({ items: await memory.listForUser(user.uid) });
  } catch (error) {
    return memoryFailure(res, error);
  }
});

app.delete('/api/memories/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return res.status(400).json({ error: 'Invalid memory id.' });
  try {
    const user = await verifyRequestUser(req);
    await memory.removeForUser(user.uid, id);
    return res.status(204).end();
  } catch (error) {
    return memoryFailure(res, error);
  }
});

app.delete('/api/memories', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    await memory.clearForUser(user.uid);
    return res.status(204).end();
  } catch (error) {
    return memoryFailure(res, error);
  }
});

// ---- Connectors (MCP) ----------------------------------------------------------------------
// Every route derives the owner from the verified TruX session. Credentials stay on the server, encrypted.
function connectorFailure(res, error, fallbackMessage) {
  const code = String(error && error.code || '');
  if (code === 'CONNECTORS_NOT_CONFIGURED' || code === 'GOOGLE_OAUTH_NOT_CONFIGURED') {
    return res.status(503).json({ error: error.message, configured: false });
  }
  if (code === 'INVALID_REQUEST' || code === 'CONNECTOR_AUTH_FAILED') {
    return res.status(400).json({ error: error.message });
  }
  if (code.startsWith('auth/')) {
    return res.status(401).json({ error: 'Your sign-in expired. Sign in again to manage connectors.' });
  }
  console.error('Connector request failed:', code || (error && error.name) || 'unknown', error && error.message);
  return res.status(502).json({ error: fallbackMessage });
}

app.get('/api/connectors', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    return res.status(200).json({ items: await mcp.listConnectors(user.uid) });
  } catch (error) {
    return connectorFailure(res, error, 'Connectors could not be loaded right now. Try again in a moment.');
  }
});

// Token or API-key connectors (GitHub, Developer Knowledge). The token is checked against the server first.
app.post('/api/connectors/:id/token', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    const summary = await mcp.saveToken(user.uid, req.params.id, req.body && req.body.token);
    return res.status(200).json({ connected: true, tools: summary });
  } catch (error) {
    return connectorFailure(res, error, 'The connection could not be saved. Try again in a moment.');
  }
});

// Google connectors: returns the Google sign-in address to open.
app.post('/api/connectors/:id/connect', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    // requireSameOrigin has already verified this header against the configured and request origins.
    const redirectUrl = await mcp.startGoogleConnection(user.uid, req.params.id, req.get('origin'));
    return res.status(200).json({ redirectUrl });
  } catch (error) {
    return connectorFailure(res, error, 'The connection could not be started. Try again in a moment.');
  }
});

app.patch('/api/connectors/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    const item = await mcp.setOptions(user.uid, req.params.id, {
      enabled: req.body && req.body.enabled,
      allowWrites: req.body && req.body.allowWrites
    });
    return res.status(200).json({ item });
  } catch (error) {
    return connectorFailure(res, error, 'The setting could not be saved. Try again in a moment.');
  }
});

app.delete('/api/connectors/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    return res.status(200).json(await mcp.disconnect(user.uid, req.params.id));
  } catch (error) {
    return connectorFailure(res, error, 'The connector could not be disconnected. Try again in a moment.');
  }
});

function callbackPage(connectorId, ok, message) {
  const data = JSON.stringify({ type: 'trux-connector-return', connector: connectorId, status: ok ? 'success' : 'failed' }).replace(/</g, '\\u003c');
  const safeMessage = String(message).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connector</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f5;color:#1f1e1d;font:16px/1.5 system-ui,sans-serif}' +
    'main{max-width:340px;padding:24px;text-align:center}h1{margin:0 0 8px;font:500 22px Georgia,serif}p{margin:0;color:#6b6a68}' +
    '@media(prefers-color-scheme:dark){body{background:#262624;color:#faf9f5}p{color:#a8a6a1}}</style></head><body><main>' +
    '<h1>' + (ok ? 'Returning to TruX Code' : 'Connection not completed') + '</h1><p>' + safeMessage + '</p></main>' +
    '<script>(function(){var d=' + data + ';' +
    'try{if(window.opener&&!window.opener.closed){window.opener.postMessage(d,location.origin);window.close();return;}}catch(e){}' +
    'setTimeout(function(){location.replace("/?connector="+encodeURIComponent(d.connector)+"&status="+d.status)},1200);})();</script></body></html>';
}

// Where Google sends the person back after consent. Nothing in the address is trusted: the one-time `state`
// is looked up on the server and must belong to the signed-in user.
app.get('/connectors/google/callback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html');
  if (req.query.error) {
    return res.status(200).send(callbackPage('', false, 'Google sign-in was cancelled or not allowed.'));
  }
  try {
    const user = await verifyRequestUser(req);
    const result = await mcp.finishGoogleConnection(user.uid, String(req.query.code || ''), String(req.query.state || ''));
    return res.status(200).send(callbackPage(result.connectorId, result.complete,
      result.complete ? 'You can close this window if it does not close by itself.' : 'Google did not grant every permission this connector needs. Try again and allow them all.'));
  } catch (error) {
    console.error('Google connector callback failed:', error && (error.code || error.name));
    return res.status(200).send(callbackPage('', false, error && error.code === 'GOOGLE_STATE_INVALID'
      ? 'This sign-in link expired. Start again from Connectors.'
      : 'The connection could not be completed. Try again.'));
  }
});

// ---- TruX-Code CLI ------------------------------------------------------------------------
// Browser routes create/revoke CLI login tokens; the CLI itself calls /api/cli/info and /api/cli/chat with a bearer token.
app.post('/api/cli/token', requireSameOrigin, cli.createTokenHandler);
app.get('/api/cli/token', cli.tokenStatusHandler);
app.delete('/api/cli/token', requireSameOrigin, cli.revokeTokensHandler);
app.get('/api/cli/info', cli.infoHandler);
app.post('/api/cli/chat', cli.chatHandler);
// The CLI is one self-contained file, served for `curl | node` style installs and the download button.
app.get('/downloads/trux-code.mjs', (_req, res) => {
  // Always a file download: phones and browsers must never display the source as a page.
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Disposition', 'attachment; filename="trux-code.mjs"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type('application/octet-stream').sendFile(path.join(__dirname, 'cli', 'trux-code.mjs'));
});

app.post('/api/chat', requireSameOrigin, parseChatJson, chatHandler);
// Where a reply stands (for a browser that lost its connection) and how to stop it.
app.get('/api/chat/jobs/:requestId', jobStatusHandler);
app.post('/api/chat/jobs/:requestId/stop', requireSameOrigin, jobStopHandler);
app.post('/api/transcribe', requireSameOrigin, parseChatJson, transcribeHandler);
app.post('/api/tts', requireSameOrigin, ttsHandler);

// The app shell is served through the v3 patch layer (see functions/html-patches.js). If patching ever
// fails, fall back to the untouched file so the site stays up.
function sendIndex(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return res.type('html').send(renderIndex(publicDirectory));
  } catch (error) {
    console.error('Could not render the patched app shell, serving the original:', error && error.message);
    return res.sendFile(path.join(publicDirectory, 'index.html'));
  }
}

app.get(['/', '/index.html'], sendIndex);

app.use(express.static(publicDirectory, {
  dotfiles: 'ignore',
  index: false,
  setHeaders(res, filePath) {
    const name = path.basename(filePath);
    if (name === 'index.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
    // The service worker must always be revalidated so updates reach people, and may control the whole app.
    // The sign-in SDK bundle is large and only changes with a deploy: reuse it, and refresh it in the background.
    if (name === 'firebase-auth.bundle.js') {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=604800');
    }
    if (name === 'sw.js') {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    }
  }
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  return sendIndex(req, res);
});

const port = Number(process.env.PORT || 8080);

if (require.main === module) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log('TruX Code listening on port ' + port);
    // Prepare the connector encryption key in the background so the first Connectors page opens ready.
    require('./functions/mcp/vault').ready().catch(() => {});
    // Open the Firebase Admin and Firestore connections now, so the first sign-in check is not the slow one.
    require('./functions/firebase-auth').warmUp().catch(() => {});
  });

  // Cloud Run sends SIGTERM before it stops an instance. Replies still being written are marked interrupted
  // so browsers waiting on them find out right away and can offer a retry, instead of waiting for a timeout.
  process.on('SIGTERM', () => {
    const forceExit = setTimeout(() => process.exit(0), 8000);
    forceExit.unref();
    jobs.interruptAll().finally(() => server.close(() => process.exit(0)));
  });
}

module.exports = app;

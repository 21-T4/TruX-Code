'use strict';

const express = require('express');
const path = require('node:path');
const { chatHandler } = require('./functions/api/chat');
const runtimeConfig = require('./config/runtime-config.json');
const { getFirestore } = require('firebase-admin/firestore');
const {
  SESSION_DURATION_MS,
  getFirebaseAuth,
  getSessionCookieName,
  getSessionCookieOptions,
  isSecureRequest,
  readRequestCookie,
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
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

const parseDefaultJson = express.json({ limit: '2mb' });
const parseChatJson = express.json({ limit: '12mb' });

// Only chat requests accept bounded media payloads. Validate the origin before parsing
// the larger body so rejected cross-origin requests do not consume the larger parser.
app.use((req, res, next) => {
  if (req.path === '/api/chat') return next();
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

  const firebaseConfig = runtimeConfig.firebase || {};
  const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const missingKeys = requiredKeys.filter((key) =>
    typeof firebaseConfig[key] !== 'string' || firebaseConfig[key].trim().length === 0
  );
  const configured = missingKeys.length === 0;

  res.status(configured ? 200 : 503).json({
    configured,
    firebaseConfig: configured ? firebaseConfig : null,
    ...(configured ? {} : {
      error: 'Firebase web configuration is incomplete in config/runtime-config.json.',
      missingKeys
    })
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
    const decodedIdToken = await auth.verifyIdToken(idToken, true);
    const existingCookie = readRequestCookie(req, getSessionCookieName(req));
    let existingSessionMatchesUser = false;

    if (existingCookie) {
      try {
        const existingSession = await auth.verifySessionCookie(existingCookie, true);
        existingSessionMatchesUser = existingSession.uid === decodedIdToken.uid;
      } catch {
        // An expired or revoked cookie cannot authorize a rolling session renewal.
      }
    }

    const authAgeSeconds = Math.floor(Date.now() / 1000) - Number(decodedIdToken.auth_time || 0);
    const recentlyAuthenticated = authAgeSeconds >= -60 && authAgeSeconds <= 5 * 60;
    if (!recentlyAuthenticated && !existingSessionMatchesUser) {
      return res.status(401).json({
        error: 'Please sign in again to refresh your secure session.'
      });
    }

    const sessionCookie = await auth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS
    });

    res.cookie(getSessionCookieName(req), sessionCookie, getSessionCookieOptions(req));
    // Firebase Auth has already assigned a unique UID. Keep a profile document keyed
    // by that UID so chats and settings belong to this account across devices.
    try {
      await syncAccountDocument({
        uid: decodedIdToken.uid,
        email: decodedIdToken.email || '',
        name: decodedIdToken.name || '',
        picture: decodedIdToken.picture || '',
        email_verified: Boolean(decodedIdToken.email_verified)
      });
    } catch (profileError) {
      console.error('Firebase account profile sync failed:',
        profileError && (profileError.code || profileError.name) || 'unknown');
    }
    return res.status(204).end();
  } catch (error) {
    const code = String(error && error.code || '');
    const detail = String(error && error.message || '');
    const signerPermissionMissing = /iam\.serviceaccounts\.signblob/i.test(detail);
    console.error('Firebase session creation failed:', code || (error && error.name) || 'unknown',
      signerPermissionMissing ? 'missing iam.serviceAccounts.signBlob permission' : '');
    const status = code.startsWith('auth/') ? 401 : 503;
    return res.status(status).json({
      error: status === 401
        ? 'Your sign-in could not be verified. Sign in again.'
        : signerPermissionMissing
          ? 'Secure session signing needs the Cloud Run service account to have roles/iam.serviceAccountTokenCreator on its own service account. Grant that role and retry.'
          : 'Secure session setup is temporarily unavailable. Please retry.'
    });
  }
});

// Restore the signed-in account from the HttpOnly cookie. Do not mint a Firebase
// custom token here: custom-token minting requires IAM signBlob permission and is
// unnecessary because every protected API verifies the server session cookie.
app.post('/api/session/bootstrap', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cookieName = getSessionCookieName(req);
  const sessionCookie = readRequestCookie(req, cookieName);

  if (!sessionCookie) return res.status(204).end();

  try {
    const auth = getFirebaseAuth();
    const decoded = await auth.verifySessionCookie(sessionCookie, true);
    let profile = null;
    try {
      const snapshot = await getFirestore().collection('users').doc(decoded.uid).get();
      if (snapshot.exists) profile = snapshot.data();
    } catch (profileError) {
      // Authentication remains available if the optional profile read is temporarily unavailable.
      console.error('Firebase profile read failed:',
        profileError && (profileError.code || profileError.name) || 'unknown');
    }

    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ user: publicSessionUser(decoded, profile) });
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

    return res.status(503).json({
      error: 'Secure session restoration is temporarily unavailable. Please sign in again.'
    });
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

// Account-scoped cloud chat history. Firestore is accessed only by the server after
// verifying the HttpOnly Firebase session; clients can never choose another UID.
app.get('/api/chats', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    const chatsRef = getFirestore().collection('users').doc(user.uid).collection('chats');
    const snapshot = await chatsRef.orderBy('updatedAt', 'desc').get();
    const conversations = await Promise.all(snapshot.docs.map(async (chatDoc) => {
      const meta = chatDoc.data();
      const messageSnapshot = await chatDoc.ref.collection('messages').orderBy('index', 'asc').get();
      const messages = messageSnapshot.docs.map((messageDoc) => {
        const item = messageDoc.data();
        return {
          role: item.role,
          content: typeof item.content === 'string' ? item.content : '',
          error: typeof item.error === 'string' ? item.error : ''
        };
      });
      return {
        id: chatDoc.id,
        title: typeof meta.title === 'string' ? meta.title : 'New chat',
        updatedAt: Number(meta.updatedAt) || 0,
        messages
      };
    }));
    return res.status(200).json({ conversations });
  } catch (error) {
    const code = String(error && error.code || '');
    const status = code.startsWith('auth/') ? 401 : 503;
    console.error('Cloud chat history read failed:', code || (error && error.name) || 'unknown');
    return res.status(status).json({
      error: status === 401
        ? 'Your sign-in expired. Sign in again to open your chats.'
        : 'Cloud chat storage is unavailable. Enable the default Firestore database in project trux-ai and grant the Cloud Run service identity roles/datastore.user.'
    });
  }
});

app.put('/api/chats/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid conversation ID.' });
  }

  const body = req.body || {};
  if (!Array.isArray(body.messages) || body.messages.length > 400) {
    return res.status(400).json({ error: 'A conversation must contain no more than 400 messages.' });
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
      error: typeof message.error === 'string' ? message.error.slice(0, 3000) : ''
    });
  }

  try {
    const user = await verifyRequestUser(req);
    const db = getFirestore();
    const chatRef = db.collection('users').doc(user.uid).collection('chats').doc(id);
    const [existingChat, existingMessages] = await Promise.all([
      chatRef.get(),
      chatRef.collection('messages').get()
    ]);
    const previous = existingChat.exists ? existingChat.data() : {};
    const updatedAtValue = Number(body.updatedAt);
    const updatedAt = Number.isFinite(updatedAtValue) && updatedAtValue > 0
      ? updatedAtValue
      : Date.now();

    // Ignore an older in-flight update rather than replacing a more recent transcript.
    if (existingChat.exists && Number(previous.updatedAt) > updatedAt) {
      return res.status(200).json({ saved: true, ignoredStaleWrite: true });
    }

    const operations = [{
      type: 'set',
      reference: chatRef,
      data: {
        id,
        title: String(body.title || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 120) || 'New chat',
        updatedAt,
        createdAt: Number(previous.createdAt) || Date.now(),
        messageCount: messages.length
      },
      options: { merge: true }
    }];

    const expectedMessageIds = new Set();
    messages.forEach((message, index) => {
      const messageId = String(index).padStart(6, '0');
      expectedMessageIds.add(messageId);
      operations.push({
        type: 'set',
        reference: chatRef.collection('messages').doc(messageId),
        data: { ...message, index },
        options: undefined
      });
    });
    existingMessages.docs.forEach((messageDoc) => {
      if (!expectedMessageIds.has(messageDoc.id)) {
        operations.push({ type: 'delete', reference: messageDoc.ref });
      }
    });

    // Firestore batches are capped at 500 writes; chunking also handles deleted tail messages.
    for (let start = 0; start < operations.length; start += 400) {
      const batch = db.batch();
      operations.slice(start, start + 400).forEach((operation) => {
        if (operation.type === 'delete') batch.delete(operation.reference);
        else if (operation.options) batch.set(operation.reference, operation.data, operation.options);
        else batch.set(operation.reference, operation.data);
      });
      await batch.commit();
    }

    return res.status(200).json({ saved: true });
  } catch (error) {
    const code = String(error && error.code || '');
    const status = code.startsWith('auth/') ? 401 : 503;
    console.error('Cloud chat history write failed:', code || (error && error.name) || 'unknown');
    return res.status(status).json({
      error: status === 401
        ? 'Your sign-in expired. Sign in again before saving chats.'
        : 'Cloud chat storage is unavailable. Enable the default Firestore database in project trux-ai and grant the Cloud Run service identity roles/datastore.user.'
    });
  }
});

app.delete('/api/chats/:id', requireSameOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid conversation ID.' });
  }

  try {
    const user = await verifyRequestUser(req);
    const db = getFirestore();
    const chatRef = db.collection('users').doc(user.uid).collection('chats').doc(id);
    const messageDocs = await chatRef.collection('messages').get();
    for (let start = 0; start < messageDocs.docs.length; start += 400) {
      const batch = db.batch();
      messageDocs.docs.slice(start, start + 400).forEach((messageDoc) => batch.delete(messageDoc.ref));
      await batch.commit();
    }
    await chatRef.delete();
    return res.status(204).end();
  } catch (error) {
    const code = String(error && error.code || '');
    const status = code.startsWith('auth/') ? 401 : 503;
    console.error('Cloud chat delete failed:', code || (error && error.name) || 'unknown');
    return res.status(status).json({
      error: status === 401
        ? 'Your sign-in expired. Sign in again before deleting chats.'
        : 'Cloud chat storage is unavailable. Enable the default Firestore database in project trux-ai and grant the Cloud Run service identity roles/datastore.user.'
    });
  }
});

app.post('/api/chat', requireSameOrigin, parseChatJson, chatHandler);

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

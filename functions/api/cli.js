'use strict';

// TruX-Code CLI backend.
//
// The CLI runs its tools (files, shell, search...) on the person's own machine and calls this server for the model.
// The server holds the Vertex AI credentials, so the CLI never needs a Google key. Two groups of routes:
//
//   Browser (signed-in session, same origin):
//     POST   /api/cli/token     create a CLI login token (shown once)
//     GET    /api/cli/token     how many tokens exist
//     DELETE /api/cli/token     revoke every CLI token of this account
//   CLI (Authorization: Bearer trx_<id>.<secret>):
//     GET    /api/cli/info      who the token belongs to and which models exist
//     POST   /api/cli/chat      one model turn, streamed as NDJSON
//
// Web grounding: the model is given a `WebSearch` tool that is answered here with Google Search grounding on Vertex AI
// (functions/web-search.js). Every other tool call is handed back to the CLI to run locally.

const crypto = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');
const { verifyRequestUser } = require('../firebase-auth');
const webSearch = require('../web-search');
const { getVertexClient, isNetworkError } = require('./chat');
const memory = require('../memory');
const chatStore = require('../store');

const COLLECTION = 'truxCliTokens';
const MAX_TOKENS_PER_USER = 5;
// A CLI login stops working after this long, even if it was never revoked. Generate a new one in the web app.
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SERVER_TOOL_NAMES = new Set(['WebSearch', 'memory_save', 'memory_forget']);
const TOKEN_PATTERN = /^trx_([a-f0-9]{24})\.([A-Za-z0-9_-]{40,64})$/;

// The CLI always runs on this one model. It is chosen here on the server only: the CLI never sends, shows or
// switches the model, so a modified or old client cannot pick a different one.
const MODEL = 'gemini-4-argon';
const THINKING_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);

const MAX_SYSTEM_CHARS = 90000;
const MAX_CONTENT_CHARS = 3500000;
const MAX_DECLARATIONS = 64;
const MAX_SERVER_SEARCHES_PER_TURN = 4;
const IDLE_TIMEOUT_MS = Number(process.env.MODEL_IDLE_TIMEOUT_MS) || 90000;
const TURN_TIMEOUT_MS = Number(process.env.MODEL_REQUEST_TIMEOUT_MS) || 600000;
const HEARTBEAT_MS = 15000;

const RATE_WINDOW_MS = 60000;
const RATE_MAX = 40;
const rateBuckets = new Map();

function hashSecret(secret) {
  return crypto.createHash('sha256').update('trux-cli-token:' + secret, 'utf8').digest('hex');
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---- Tokens ---------------------------------------------------------------------------------

async function createToken(uid, label) {
  const db = getFirestore();
  const existing = await db.collection(COLLECTION).where('uid', '==', uid).get();
  if (existing.size >= MAX_TOKENS_PER_USER) {
    const oldest = existing.docs
      .map((doc) => ({ ref: doc.ref, at: Number(doc.get('createdAt')) || 0 }))
      .sort((a, b) => a.at - b.at)
      .slice(0, existing.size - MAX_TOKENS_PER_USER + 1);
    await Promise.all(oldest.map((item) => item.ref.delete()));
  }
  const id = crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  await db.collection(COLLECTION).doc(id).create({
    uid,
    hash: hashSecret(secret),
    label: String(label || 'TruX-Code CLI').slice(0, 60),
    createdAt: Date.now(),
    lastUsedAt: 0
  });
  return 'trx_' + id + '.' + secret;
}

async function revokeAll(uid) {
  const db = getFirestore();
  const snapshot = await db.collection(COLLECTION).where('uid', '==', uid).get();
  await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  return snapshot.size;
}

async function countTokens(uid) {
  const snapshot = await getFirestore().collection(COLLECTION).where('uid', '==', uid).get();
  return snapshot.size;
}

const verifiedTokens = new Map(); // token hash -> { uid, expires }

async function verifyCliToken(req) {
  const header = String(req.get('authorization') || '');
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const parsed = match ? TOKEN_PATTERN.exec(match[1]) : null;
  if (!parsed) throw fail('cli/missing-token', 'Sign in to the CLI again with /login.');
  const [, id, secret] = parsed;
  const hash = hashSecret(secret);

  const cached = verifiedTokens.get(id + hash);
  if (cached && cached.expires > Date.now()) return { uid: cached.uid, tokenId: id };

  const reference = getFirestore().collection(COLLECTION).doc(id);
  const snapshot = await reference.get();
  const stored = snapshot.exists ? String(snapshot.get('hash') || '') : '';
  const equal = stored.length === hash.length &&
    crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(hash));
  if (!equal) throw fail('cli/invalid-token', 'This CLI login was revoked or is invalid. Run /login with a new token.');

  const createdAt = Number(snapshot.get('createdAt')) || 0;
  if (createdAt && Date.now() - createdAt > TOKEN_TTL_MS) {
    reference.delete().catch(() => {});
    throw fail('cli/expired-token', 'This CLI login expired. Generate a new token in the web app and run /login.');
  }
  const uid = String(snapshot.get('uid') || '');
  if (verifiedTokens.size > 500) verifiedTokens.delete(verifiedTokens.keys().next().value);
  verifiedTokens.set(id + hash, { uid, expires: Date.now() + 30000 });
  // Best effort, and at most once a minute per token.
  const lastUsed = Number(snapshot.get('lastUsedAt')) || 0;
  if (Date.now() - lastUsed > 60000) reference.update({ lastUsedAt: Date.now() }).catch(() => {});
  return { uid, tokenId: id };
}

function rateLimited(key) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX) { rateBuckets.set(key, bucket); return true; }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 2000) rateBuckets.delete(rateBuckets.keys().next().value);
  return false;
}

// ---- Browser routes -------------------------------------------------------------------------

function browserFailure(res, error, label) {
  const code = String(error && error.code || '');
  const status = code.startsWith('auth/') ? 401 : 503;
  console.error(label, code || (error && error.name) || 'unknown');
  return res.status(status).json({
    error: status === 401
      ? 'Your sign-in expired. Sign in again to set up the CLI.'
      : 'CLI login storage is unavailable. Check Firestore access for the Cloud Run service identity.'
  });
}

async function createTokenHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    const token = await createToken(user.uid, req.body && req.body.label);
    return res.status(200).json({ token });
  } catch (error) {
    return browserFailure(res, error, 'CLI token creation failed:');
  }
}

async function tokenStatusHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    return res.status(200).json({ count: await countTokens(user.uid) });
  } catch (error) {
    return browserFailure(res, error, 'CLI token lookup failed:');
  }
}

async function revokeTokensHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyRequestUser(req);
    verifiedTokens.clear();
    return res.status(200).json({ revoked: await revokeAll(user.uid) });
  } catch (error) {
    return browserFailure(res, error, 'CLI token revoke failed:');
  }
}

// ---- CLI routes -----------------------------------------------------------------------------

function cliAuthStatus(error) {
  const code = String(error && error.code || '');
  return code.startsWith('cli/') ? 401 : 503;
}

async function infoHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { uid } = await verifyCliToken(req);
    let email = '';
    try {
      const { getFirebaseAuth } = require('../firebase-auth');
      email = (await getFirebaseAuth().getUser(uid)).email || '';
    } catch { /* optional */ }
    return res.status(200).json({
      ok: true,
      email,
      grounding: true
    });
  } catch (error) {
    const status = cliAuthStatus(error);
    return res.status(status).json({ error: status === 401 ? error.message : 'The server could not check this login right now.' });
  }
}

function validDeclarations(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_DECLARATIONS) throw fail('INVALID_REQUEST', 'Too many tool declarations.');
  return input.map((item) => {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.name) ||
        typeof item.description !== 'string' || item.description.length > 12000) {
      throw fail('INVALID_REQUEST', 'A tool declaration is invalid.');
    }
    if (item.name === webSearch.declaration.name || SERVER_TOOL_NAMES.has(item.name)) {
      throw fail('INVALID_REQUEST', item.name + ' is provided by the server.');
    }
    return { name: item.name, description: item.description, ...(item.parameters ? { parameters: item.parameters } : {}) };
  });
}

function validContents(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 4000) throw fail('INVALID_REQUEST', 'The conversation is empty or too long.');
  let size = 0;
  for (const item of input) {
    if (!item || !['user', 'model'].includes(item.role) || !Array.isArray(item.parts) || item.parts.length === 0) {
      throw fail('INVALID_REQUEST', 'The conversation contains an invalid message.');
    }
    for (const part of item.parts) {
      if (!part || typeof part !== 'object') throw fail('INVALID_REQUEST', 'The conversation contains an invalid part.');
    }
    size += JSON.stringify(item.parts).length;
    if (size > MAX_CONTENT_CHARS) throw fail('INVALID_REQUEST', 'The conversation is too large. Use /compact or /clear.');
  }
  if (input[input.length - 1].role !== 'user') throw fail('INVALID_REQUEST', 'The last message must come from the user.');
  return input;
}

// The model needs its own function-call and thought-signature parts back unchanged. Plain text parts are joined.
function mergeParts(parts) {
  const merged = [];
  let lastWasPlain = false;
  for (const part of parts) {
    if (part && part.thought) continue;
    const plain = Boolean(part) && typeof part.text === 'string' && !part.thoughtSignature && !part.functionCall;
    if (plain && lastWasPlain) merged[merged.length - 1] = { text: merged[merged.length - 1].text + part.text };
    else merged.push(plain ? { text: part.text } : part);
    lastWasPlain = plain;
  }
  return merged;
}

function partsOf(chunk) {
  const candidates = chunk && Array.isArray(chunk.candidates) ? chunk.candidates : [];
  const content = candidates[0] && candidates[0].content;
  return content && Array.isArray(content.parts) ? content.parts : [];
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { if (onTimeout) onTimeout(); reject(fail('IDLE_TIMEOUT', 'The model stopped responding.')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function* idleGuard(stream, ms, onIdle) {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await withTimeout(iterator.next(), ms, onIdle);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(() => {});
  }
}

async function openStream(client, params) {
  try {
    return await client.models.generateContentStream(params);
  } catch (error) {
    if (!isNetworkError(error) || (params.config.abortSignal && params.config.abortSignal.aborted)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return client.models.generateContentStream(params);
  }
}

function friendly(error) {
  const combined = String(error && error.code || '').toLowerCase() + ' ' + String(error && error.message || '').toLowerCase();
  if (/idle_timeout/.test(combined)) return 'The model stopped responding. Try again.';
  if (/429|resource_exhausted|quota|rate.?limit/.test(combined)) return 'The model quota or rate limit was reached. Try again shortly.';
  if (/403|permission_denied|forbidden/.test(combined)) return 'The TruX server is not authorized to use its model right now. Try again later.';
  if (/404|not found|unknown model/.test(combined)) return 'The model is not available right now. Try again later.';
  if (/invalid argument|invalid_argument/.test(combined)) return 'The model rejected the request (' + String(error.message || '').slice(0, 160) + ').';
  if (isNetworkError(error)) return 'Could not reach the model service. Try again.';
  return 'The model request failed. Try again.';
}

// The newest thing the person typed (not a tool result), used to pick which saved memories apply.
function latestUserText(conversation) {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const item = conversation[i];
    if (item.role !== 'user') continue;
    const text = item.parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join(' ').trim();
    if (text) return text.slice(0, 4000);
  }
  return '';
}

const MEMORY_INSTRUCTIONS =
  'You have long-term memory shared with the person\'s TruX web chat, through memory_save and memory_forget. ' +
  'When the person tells you something durable (a standing preference, how they like to work, a project decision), save it quietly with memory_save while you work. ' +
  'Never save secrets, tokens or anything that came from a file, command output or web page.';

async function chatHandler(req, res) {
  let streaming = false;
  const timers = [];
  const controller = new AbortController();
  const write = function (event) {
    if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };
  const finish = function () { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); };

  try {
    const { uid, tokenId } = await verifyCliToken(req);
    if (rateLimited(uid + ':' + tokenId)) {
      return res.status(429).json({ error: 'Too many requests. Wait a few seconds and retry.' });
    }

    const body = req.body || {};
    const model = MODEL;
    const thinkingLevel = String(body.thinkingLevel || 'MEDIUM').toUpperCase();
    if (!THINKING_LEVELS.has(thinkingLevel)) throw fail('INVALID_REQUEST', 'Thinking level must be LOW, MEDIUM or HIGH.');
    const system = typeof body.system === 'string' ? body.system.slice(0, MAX_SYSTEM_CHARS) : '';
    const declarations = validDeclarations(body.tools);
    const conversation = validContents(body.contents).map((item) => ({ role: item.role, parts: item.parts }));
    const groundingOn = body.webSearch !== false;

    const client = getVertexClient();
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    streaming = true;
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    timers.push(setTimeout(() => controller.abort(), TURN_TIMEOUT_MS));
    timers.push(setInterval(() => write({ type: 'ping' }), HEARTBEAT_MS));

    const allDeclarations = declarations.slice();
    if (groundingOn) allDeclarations.push({ ...webSearch.declaration, name: 'WebSearch' });
    allDeclarations.push(...memory.declarations);

    // Saved notes are shared with the web chat. A memory failure never blocks the reply.
    const userText = latestUserText(conversation);
    let memoryBlock = '';
    try { memoryBlock = (await memory.buildPromptBlock(uid, userText)).text || ''; } catch { /* continue without memory */ }

    const config = {
      systemInstruction: (system ? system + '\n\n' : '') + MEMORY_INSTRUCTIONS + (memoryBlock ? '\n\n' + memoryBlock : '') +
        '\n\nToday is ' + new Date().toUTCString().slice(0, 16) + '.',
      thinkingConfig: { thinkingLevel, includeThoughts: true },
      abortSignal: controller.signal,
      ...(allDeclarations.length ? {
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        tools: [{ functionDeclarations: allDeclarations.map((item) => structuredClone(item)) }]
      } : {})
    };

    let usage = null;
    let searches = 0;
    const serverResponses = [];

    // Loop: a turn whose only tool calls are WebSearch is finished here, so the CLI sees one answer.
    while (true) {
      const attempt = new AbortController();
      const signal = AbortSignal.any([controller.signal, attempt.signal]);
      const stream = await withTimeout(
        openStream(client, { model, contents: conversation, config: { ...config, abortSignal: signal } }),
        IDLE_TIMEOUT_MS, () => attempt.abort());
      const modelParts = [];
      const calls = [];
      for await (const chunk of idleGuard(stream, IDLE_TIMEOUT_MS, () => attempt.abort())) {
        if (controller.signal.aborted) break;
        if (chunk && chunk.usageMetadata) usage = chunk.usageMetadata;
        for (const part of partsOf(chunk)) {
          modelParts.push(part);
          if (part && part.functionCall && part.functionCall.name) calls.push(part.functionCall);
          if (part && typeof part.text === 'string' && part.text) {
            write({ type: part.thought ? 'thought' : 'text', text: part.text });
          }
        }
      }
      if (controller.signal.aborted) break;

      const merged = mergeParts(modelParts);
      const serverCalls = calls.filter((call) => SERVER_TOOL_NAMES.has(call.name));
      const localCalls = calls.filter((call) => !SERVER_TOOL_NAMES.has(call.name));

      if (serverCalls.length && searches < MAX_SERVER_SEARCHES_PER_TURN * 2) {
        const responseParts = [];
        for (const call of serverCalls) {
          searches += 1;
          let response;
          if (call.name === 'WebSearch') {
            write({ type: 'search', query: String(call.args && call.args.query || '').slice(0, 200) });
            const result = await webSearch.execute(client, call.args, controller.signal);
            if (result.ok) write({ type: 'sources', sources: (result.sources || []).slice(0, 8) });
            response = result.ok ? { output: result.data } : { error: result.error };
          } else {
            const result = await memory.executeCall(uid, call.name, call.args, userText, '');
            write({ type: 'notice', text: result.ok ? (call.name === 'memory_save' ? 'Saved to memory' : 'Removed from memory') : 'Memory: ' + String(result.error || 'not saved').slice(0, 120) });
            response = result.ok ? { output: result.data } : { error: result.error };
          }
          responseParts.push({
            functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response }
          });
        }
        if (!localCalls.length) {
          conversation.push({ role: 'model', parts: merged }, { role: 'user', parts: responseParts });
          continue;
        }
        // Server calls that came with local ones: the CLI gets the model turn plus these answers.
        serverResponses.push(...responseParts);
      }

      write({ type: 'model', parts: merged, serverResponses, usage, calls: localCalls.map((c) => c.name) });
      write({ type: 'done' });
      finish();
      return res.end();
    }

    finish();
    write({ type: 'done', stopped: true });
    return res.end();
  } catch (error) {
    finish();
    const code = String(error && error.code || '');
    if (controller.signal.aborted && streaming) {
      write({ type: 'done', stopped: true });
      return res.end();
    }
    if (code.startsWith('cli/')) return res.status(401).json({ error: error.message });
    if (code === 'INVALID_REQUEST') return res.status(400).json({ error: error.message });
    console.error('CLI chat failed:', code || (error && error.name), error && error.message);
    const message = friendly(error);
    if (streaming) { write({ type: 'error', error: message }); return res.end(); }
    return res.status(500).json({ error: message });
  }
}

// ---- Chat history shared with the web app ----------------------------------------------------
// CLI conversations are saved as plain text messages in the same cloud store as web chats, so they show up in the
// web sidebar and /resume in the CLI can open web chats too. Tool calls and results stay on the person's computer.

async function authedUser(req, res) {
  try { return await verifyCliToken(req); } catch (error) {
    const status = cliAuthStatus(error);
    res.status(status).json({ error: status === 401 ? error.message : 'The server could not check this login right now.' });
    return null;
  }
}

async function listChatsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await authedUser(req, res);
  if (!auth) return undefined;
  try {
    return res.status(200).json({ chats: (await chatStore.listChats(auth.uid)).slice(0, 30) });
  } catch (error) {
    console.error('CLI chat list failed:', error && (error.code || error.name));
    return res.status(503).json({ error: 'Chat history is unavailable right now.' });
  }
}

async function getChatHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!chatStore.ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid chat id.' });
  const auth = await authedUser(req, res);
  if (!auth) return undefined;
  try {
    const chat = await chatStore.getChat(auth.uid, id);
    if (!chat) return res.status(404).json({ error: 'That chat was not found.' });
    return res.status(200).json(chat);
  } catch (error) {
    console.error('CLI chat read failed:', error && (error.code || error.name));
    return res.status(503).json({ error: 'Chat history is unavailable right now.' });
  }
}

async function saveChatHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!chatStore.ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid chat id.' });
  const body = req.body || {};
  if (!Array.isArray(body.messages) || body.messages.length > 1500) return res.status(400).json({ error: 'Messages must be a list.' });
  const messages = [];
  let total = 0;
  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 200000) {
      return res.status(400).json({ error: 'A message has an invalid role or content.' });
    }
    total += message.content.length;
    if (total > 1800000) return res.status(413).json({ error: 'This conversation is too large to sync.' });
    messages.push({ role: message.role, content: message.content, error: '', activity: [] });
  }
  const auth = await authedUser(req, res);
  if (!auth) return undefined;
  if (rateLimited('sync:' + auth.uid)) return res.status(429).json({ error: 'Too many requests.' });
  try {
    const title = 'CLI: ' + String(body.title || 'Conversation').replace(/^CLI:\s*/, '');
    await chatStore.saveChat(auth.uid, id, { title, updatedAt: Date.now() }, messages);
    return res.status(200).json({ saved: true });
  } catch (error) {
    if (error && error.code === 'TOO_LARGE') return res.status(413).json({ error: error.message });
    console.error('CLI chat save failed:', error && (error.code || error.name));
    return res.status(503).json({ error: 'Chat history is unavailable right now.' });
  }
}

async function listMemoriesHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = await authedUser(req, res);
  if (!auth) return undefined;
  try {
    return res.status(200).json({ items: await memory.listForUser(auth.uid) });
  } catch (error) {
    console.error('CLI memory list failed:', error && (error.code || error.name));
    return res.status(503).json({ error: 'Memory is unavailable right now.' });
  }
}

module.exports = {
  chatHandler,
  getChatHandler,
  listChatsHandler,
  listMemoriesHandler,
  saveChatHandler,
  createTokenHandler,
  infoHandler,
  revokeTokensHandler,
  tokenStatusHandler,
  mergeParts,
  TOKEN_PATTERN
};

'use strict';

// MCP connector layer for TruX Code. It replaces the previous plugin provider.
//
// - Credentials are encrypted (vault.js) and live at users/{uid}/connectors/{id}; the owner is always the
//   verified Firebase UID, never a client-supplied value.
// - A chat turn gets the tools of every connector the user switched on, translated into Gemini function
//   declarations. Tool names are namespaced by connector so two servers can never collide.
// - Tools that can change things are hidden unless the user switched on "Allow changes" for that connector.
//   That is enforced here from each tool's MCP annotations, not just asked of the model in the prompt.
// - Tool output is returned to the model wrapped as untrusted content.

const crypto = require('node:crypto');
const { getFirestore } = require('firebase-admin/firestore');
const catalog = require('./catalog');
const vault = require('./vault');
const googleOAuth = require('./google-oauth');

const MAX_ENABLED = 8;
const TOOL_CACHE_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 55000;
const MAX_RESULT_CHARS = 24000;
const TOKEN_PATTERN = /^[\x21-\x7E]{8,4096}$/; // visible ASCII only: no spaces or line breaks to smuggle into a header

const toolCache = new Map(); // "uid:id" -> { tools, expires }

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function connectorsRef(uid) {
  return getFirestore().collection('users').doc(uid).collection('connectors');
}

function sharedKey(entry) {
  const name = entry.auth && entry.auth.serverEnv;
  return name ? String(process.env[name] || '').trim() : '';
}

function requireEntry(id) {
  const entry = catalog.getEntry(id);
  if (!entry) throw codedError('INVALID_REQUEST', 'That connector is not available.');
  return entry;
}

function forget(uid, id) {
  toolCache.delete(uid + ':' + id);
}

/* ------------------------------------------------------------------ listing and settings */

function describeState(entry, doc, granted) {
  const auth = entry.auth;
  const shared = auth.type === 'apikey' && Boolean(sharedKey(entry));
  let connected = false;
  let available = true;
  let reason = '';
  if (auth.type === 'google') {
    available = googleOAuth.isConfigured();
    if (!available) reason = 'Google sign-in is not set up on this server yet.';
    connected = Boolean(doc.connected) && auth.scopes.every((scope) => granted.has(scope));
  } else if (shared) {
    connected = true;
  } else {
    available = vault.isConfigured();
    if (!available) reason = 'Connectors are not set up on this server yet.';
    connected = Boolean(doc.enc);
  }
  // Shared-key connectors are opt-in; the others are switched on when connected.
  const enabled = connected && (shared ? doc.enabled === true : doc.enabled !== false);
  return {
    id: entry.id,
    name: entry.name,
    group: entry.group,
    description: entry.description,
    note: entry.note || '',
    authType: auth.type,
    authLabel: auth.label || '',
    authHelp: auth.help || '',
    connected,
    available,
    reason,
    enabled,
    allowWrites: Boolean(doc.allowWrites) && !entry.readOnly,
    readOnly: Boolean(entry.readOnly),
    sharedKey: shared
  };
}

async function loadDocs(uid) {
  const snapshot = await connectorsRef(uid).get();
  return new Map(snapshot.docs.map((doc) => [doc.id, doc.data()]));
}

async function listConnectors(uid) {
  const docs = await loadDocs(uid);
  const account = docs.get(googleOAuth.ACCOUNT_DOC);
  const granted = new Set(account && account.scopes || []);
  return catalog.CATALOG.map((entry) => describeState(entry, docs.get(entry.id) || {}, granted));
}

async function setOptions(uid, id, options) {
  const entry = requireEntry(id);
  const state = (await listConnectors(uid)).find((item) => item.id === entry.id);
  if (!state || !state.connected) throw codedError('INVALID_REQUEST', 'Connect ' + entry.name + ' first.');
  const update = { updatedAt: Date.now() };
  if (typeof options.enabled === 'boolean') update.enabled = options.enabled;
  if (typeof options.allowWrites === 'boolean' && !entry.readOnly) update.allowWrites = options.allowWrites;
  await connectorsRef(uid).doc(entry.id).set(update, { merge: true });
  forget(uid, entry.id);
  return (await listConnectors(uid)).find((item) => item.id === entry.id);
}

/* ------------------------------------------------------------------ credentials */

async function headersFor(uid, entry, doc) {
  const auth = entry.auth;
  if (auth.type === 'google') {
    return { Authorization: 'Bearer ' + await googleOAuth.getAccessToken(uid) };
  }
  let secret = '';
  if (doc && doc.enc) secret = String(vault.decrypt(uid, entry.id, doc.enc).token || '');
  if (!secret) secret = sharedKey(entry);
  if (!secret) throw codedError('CONNECTOR_AUTH_FAILED', 'Connect ' + entry.name + ' first.');
  return { [auth.header]: (auth.prefix || '') + secret };
}

async function openClient(url, headers) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: 'trux-code', version: '1.0.0' });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return client;
}

async function closeQuietly(client) {
  if (client) await Promise.resolve(client.close()).catch(() => {});
}

async function listAllTools(client) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 5; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
    tools.push(...(result.tools || []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

function isReadOnlyTool(tool) {
  return Boolean(tool && tool.annotations && tool.annotations.readOnlyHint === true);
}

function summarizeTools(tools) {
  const read = tools.filter(isReadOnlyTool).length;
  return { total: tools.length, read, change: tools.length - read };
}

// Saves an access token or API key, but only after the server accepted it.
async function saveToken(uid, id, rawToken) {
  const entry = requireEntry(id);
  if (!entry.auth || !['token', 'apikey'].includes(entry.auth.type)) {
    throw codedError('INVALID_REQUEST', entry.name + ' uses Google sign-in instead of a token.');
  }
  if (!vault.isConfigured()) {
    throw codedError('CONNECTORS_NOT_CONFIGURED', 'Connectors are not configured on this server.');
  }
  const token = String(rawToken || '').trim();
  if (!TOKEN_PATTERN.test(token)) throw codedError('INVALID_REQUEST', 'That token does not look valid.');

  let client;
  let tools;
  try {
    client = await openClient(entry.url, { [entry.auth.header]: (entry.auth.prefix || '') + token });
    tools = await listAllTools(client);
  } catch (error) {
    console.warn('Connector validation failed for', entry.id + ':', error && (error.code || error.name), error && error.message);
    throw codedError('CONNECTOR_AUTH_FAILED', entry.name + ' did not accept that token. Check it and its permissions.');
  } finally {
    await closeQuietly(client);
  }

  await connectorsRef(uid).doc(entry.id).set({
    enc: vault.encrypt(uid, entry.id, { token }),
    enabled: true,
    allowWrites: false,
    connectedAt: Date.now(),
    updatedAt: Date.now()
  });
  forget(uid, entry.id);
  return summarizeTools(tools);
}

async function startGoogleConnection(uid, id, origin) {
  const entry = requireEntry(id);
  if (!entry.auth || entry.auth.type !== 'google') throw codedError('INVALID_REQUEST', entry.name + ' does not use Google sign-in.');
  return googleOAuth.startAuthorization(uid, entry, origin);
}

async function finishGoogleConnection(uid, code, state) {
  const result = await googleOAuth.completeAuthorization(uid, code, state);
  const entry = catalog.getEntry(result.connectorId);
  const granted = new Set(result.scopes);
  const complete = Boolean(entry) && entry.auth.scopes.every((scope) => granted.has(scope));
  if (entry && complete) {
    await connectorsRef(uid).doc(entry.id).set(
      { connected: true, enabled: true, allowWrites: false, connectedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
    forget(uid, entry.id);
  }
  return { connectorId: result.connectorId, complete };
}

async function disconnect(uid, id) {
  const entry = requireEntry(id);
  await connectorsRef(uid).doc(entry.id).delete();
  forget(uid, entry.id);
  if (entry.auth.type === 'google') {
    const docs = await loadDocs(uid);
    const stillUsed = catalog.CATALOG.some((item) => item.auth.type === 'google' && docs.has(item.id));
    if (!stillUsed) await googleOAuth.revokeAccount(uid);
  }
  return { id: entry.id, removed: true };
}

/* ------------------------------------------------------------------ per-chat toolset */

function functionName(entryId, toolName) {
  const base = entryId.replace(/[^a-z0-9]/g, '_') + '__' + String(toolName).replace(/[^A-Za-z0-9_]/g, '_');
  if (base.length <= 64) return base;
  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 6);
  return base.slice(0, 57) + '_' + hash;
}

function cleanSchema(schema) {
  const input = schema && typeof schema === 'object' ? JSON.parse(JSON.stringify(schema)) : {};
  delete input.$schema;
  if (input.type !== 'object') return { type: 'object', properties: {} };
  if (!input.properties || typeof input.properties !== 'object') input.properties = {};
  return input;
}

const HINT_KEYS = ['query', 'q', 'repo', 'repository', 'owner', 'path', 'title', 'name', 'fileId', 'file', 'url', 'number', 'ref', 'branch'];
const SECRET_KEY = /token|secret|password|passwd|auth|credential|key/i;

function humanize(name) {
  return String(name || '').replace(/[_-]+/g, ' ').trim().toLowerCase();
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const picked = [];
  for (const key of HINT_KEYS) {
    const value = args[key];
    if ((typeof value === 'string' || typeof value === 'number') && !SECRET_KEY.test(key) && String(value).trim()) {
      picked.push(key + ': ' + String(value).replace(/\s+/g, ' ').slice(0, 60));
    }
    if (picked.length === 2) break;
  }
  return picked.join(', ');
}

function flattenResult(result) {
  const blocks = Array.isArray(result && result.content) ? result.content : [];
  let text = blocks.map((block) => {
    if (block && block.type === 'text') return String(block.text || '');
    if (block && block.type === 'resource' && block.resource && typeof block.resource.text === 'string') return block.resource.text;
    return '[' + String(block && block.type || 'content') + ' omitted]';
  }).join('\n').trim();
  if (!text && result && result.structuredContent) text = JSON.stringify(result.structuredContent);
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n[output truncated]';
  return text;
}

async function cachedTools(uid, entry, doc) {
  const key = uid + ':' + entry.id;
  const hit = toolCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.tools;
  const client = await openClient(entry.url, await headersFor(uid, entry, doc));
  try {
    const tools = await listAllTools(client);
    toolCache.set(key, { tools, expires: Date.now() + TOOL_CACHE_MS });
    if (toolCache.size > 400) {
      for (const [stale, value] of toolCache) if (value.expires <= Date.now()) toolCache.delete(stale);
    }
    return tools;
  } finally {
    await closeQuietly(client);
  }
}

// Builds the tools for one chat turn from the connectors the user has switched on. A connector that fails to
// load is skipped and reported, so the reply still goes ahead without it.
async function createChatToolset(uid) {
  const docs = await loadDocs(uid);
  const account = docs.get(googleOAuth.ACCOUNT_DOC);
  const granted = new Set(account && account.scopes || []);
  const active = catalog.CATALOG
    .map((entry) => ({ entry, doc: docs.get(entry.id) || {} }))
    .filter(({ entry, doc }) => {
      const state = describeState(entry, doc, granted);
      return state.connected && state.enabled && state.available;
    })
    .slice(0, MAX_ENABLED);
  if (!active.length) return null;

  const loaded = await Promise.allSettled(active.map(async ({ entry, doc }) => ({ entry, doc, tools: await cachedTools(uid, entry, doc) })));
  const declarations = [];
  const routes = new Map();
  const connectors = [];
  const failed = [];

  loaded.forEach((outcome, index) => {
    const { entry } = active[index];
    if (outcome.status !== 'fulfilled') {
      console.warn('Connector could not be loaded:', entry.id, outcome.reason && (outcome.reason.code || outcome.reason.message));
      failed.push(entry.name);
      return;
    }
    const { doc, tools } = outcome.value;
    const allowChanges = Boolean(doc.allowWrites) && !entry.readOnly;
    let count = 0;
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string') continue;
      if (!entry.readOnly && !allowChanges && !isReadOnlyTool(tool)) continue;
      const name = functionName(entry.id, tool.name);
      if (routes.has(name)) continue;
      routes.set(name, { entry, doc, tool });
      declarations.push({
        name,
        description: ('[' + entry.name + '] ' + String(tool.description || humanize(tool.name))).slice(0, 1000),
        parametersJsonSchema: cleanSchema(tool.inputSchema)
      });
      count += 1;
    }
    if (count) connectors.push({ id: entry.id, name: entry.name, tools: count, canChange: allowChanges });
  });
  // Nothing usable: the chat continues without connectors. The caller reports failed connectors via `failed`.
  if (!declarations.length) {
    return { connectors: [], failed, declarations: [], describe() { return { title: 'Using a connector', detail: '' }; }, async execute() { return { ok: false, error: 'No connector tools are available.' }; }, async close() {} };
  }

  const clients = new Map();
  async function clientFor(route) {
    if (!clients.has(route.entry.id)) {
      clients.set(route.entry.id, openClient(route.entry.url, await headersFor(uid, route.entry, route.doc)));
    }
    return clients.get(route.entry.id);
  }

  return {
    connectors,
    failed,
    declarations,
    describe(name, args) {
      const route = routes.get(name);
      if (!route) return { title: 'Using a connector', detail: '' };
      const hint = summarizeArgs(args);
      return {
        title: 'Using ' + route.entry.name,
        detail: humanize(route.tool.name) + (hint ? ' (' + hint + ')' : '')
      };
    },
    async execute(name, args, signal) {
      const route = routes.get(name);
      if (!route) return { ok: false, error: 'That tool is not available in this chat.' };
      try {
        const client = await clientFor(route);
        const result = await client.callTool(
          { name: route.tool.name, arguments: args && typeof args === 'object' ? args : {} },
          undefined,
          { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) }
        );
        const text = flattenResult(result);
        if (result && result.isError) return { ok: false, error: text.slice(0, 1500) || 'The connector reported an error.' };
        return { ok: true, data: { source: route.entry.name, untrusted_tool_output: text } };
      } catch (error) {
        clients.delete(route.entry.id);
        if (error && (error.code === 'GOOGLE_REAUTH_REQUIRED')) {
          return { ok: false, error: 'Google access expired. Ask the user to reconnect ' + route.entry.name + ' in Connectors.' };
        }
        return { ok: false, error: String(error && error.message || 'The connector call failed.').slice(0, 600) };
      }
    },
    async close() {
      const pending = Array.from(clients.values());
      clients.clear();
      await Promise.all(pending.map((promise) => promise.then(closeQuietly).catch(() => {})));
    }
  };
}

module.exports = {
  createChatToolset,
  disconnect,
  finishGoogleConnection,
  listConnectors,
  saveToken,
  setOptions,
  startGoogleConnection
};

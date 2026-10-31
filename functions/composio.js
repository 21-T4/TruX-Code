'use strict';

// Composio plugin layer for TruX Code.
//
// Every Composio call is made on the server with COMPOSIO_API_KEY, which is supplied by the
// Cloud Run environment (for example from Secret Manager). The key never reaches the browser.
// The owner of every connection is the verified Firebase UID, never a client-supplied value.

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_ENABLED_PLUGINS = 12;
const MAX_TOOL_RESULT_CHARS = 24000;
const LIST_SESSION_TTL_MS = 10 * 60 * 1000;

let composioPromise = null;
const listSessions = new Map();

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isConfigured() {
  return String(process.env.COMPOSIO_API_KEY || '').trim().length > 0;
}

function requireConfigured() {
  if (!isConfigured()) {
    throw codedError(
      'COMPOSIO_NOT_CONFIGURED',
      'Plugins are not configured. Set COMPOSIO_API_KEY in the Cloud Run environment.'
    );
  }
}

// @composio/core is ESM-only, so it is loaded with a dynamic import from this CommonJS server.
function getComposio() {
  requireConfigured();
  if (!composioPromise) {
    const apiKey = String(process.env.COMPOSIO_API_KEY).trim();
    composioPromise = import('@composio/core')
      .then((module) => new module.Composio({ apiKey }))
      .catch((error) => {
        composioPromise = null;
        throw error;
      });
  }
  return composioPromise;
}

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw codedError('INVALID_REQUEST', 'That plugin name is not valid.');
  return slug;
}

function normalizeSlugList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const slug = String(item || '').trim().toLowerCase();
    if (SLUG_PATTERN.test(slug)) seen.add(slug);
    if (seen.size >= MAX_ENABLED_PLUGINS) break;
  }
  return Array.from(seen);
}

// One default session per user is enough for browsing the catalog and starting connections.
async function getListSession(uid) {
  const cached = listSessions.get(uid);
  if (cached && cached.expires > Date.now()) return cached.session;
  const composio = await getComposio();
  const session = await composio.sessions.create(uid);
  listSessions.set(uid, { session, expires: Date.now() + LIST_SESSION_TTL_MS });
  if (listSessions.size > 500) {
    for (const [key, entry] of listSessions) {
      if (entry.expires <= Date.now()) listSessions.delete(key);
    }
  }
  return session;
}

async function withListSession(uid, task) {
  try {
    return await task(await getListSession(uid));
  } catch (error) {
    listSessions.delete(uid);
    throw error;
  }
}

async function listPlugins(uid, options) {
  requireConfigured();
  const limit = Math.min(Math.max(parseInt(options && options.limit, 10) || 24, 1), 48);
  const query = { limit };
  const search = String(options && options.search || '').trim().slice(0, 60);
  const cursor = String(options && options.cursor || '').trim().slice(0, 400);
  if (search) query.search = search;
  if (cursor) query.cursor = cursor;
  if (options && options.connected) query.isConnected = true;
  const only = String(options && options.slug || '').trim().toLowerCase();
  if (only && SLUG_PATTERN.test(only)) query.toolkits = [only];

  const result = await withListSession(uid, (session) => session.toolkits(query));
  const items = (result && Array.isArray(result.items) ? result.items : []).map((toolkit) => ({
    slug: String(toolkit.slug || ''),
    name: String(toolkit.name || toolkit.slug || ''),
    logo: typeof toolkit.logo === 'string' ? toolkit.logo : '',
    noAuth: Boolean(toolkit.isNoAuth),
    connected: Boolean(toolkit.isNoAuth || (toolkit.connection && toolkit.connection.isActive))
  })).filter((item) => SLUG_PATTERN.test(item.slug));

  return { items, nextCursor: (result && (result.nextCursor || result.cursor)) || null };
}

async function startConnection(uid, slugInput, callbackUrl) {
  const slug = normalizeSlug(slugInput);
  requireConfigured();
  const request = await withListSession(uid, (session) => session.authorize(slug, { callbackUrl }));
  return { slug, redirectUrl: request && request.redirectUrl ? String(request.redirectUrl) : null };
}

async function disconnectPlugin(uid, slugInput) {
  const slug = normalizeSlug(slugInput);
  const composio = await getComposio();
  // The lookup is scoped to this user's UID, so a client cannot remove another user's connection.
  const accounts = await composio.connectedAccounts.list({ userIds: [uid], toolkitSlugs: [slug], limit: 50 });
  const items = accounts && Array.isArray(accounts.items) ? accounts.items : [];
  for (const account of items) {
    await composio.connectedAccounts.delete(account.id);
  }
  listSessions.delete(uid);
  return { slug, removed: items.length };
}

function humanize(slug) {
  return String(slug || '')
    .toLowerCase()
    .replace(/^composio_/, '')
    .split('_')
    .filter(Boolean)
    .join(' ');
}

function describeToolCall(name, args) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'COMPOSIO_SEARCH_TOOLS') {
    const queries = Array.isArray(input.queries) ? input.queries : [];
    const first = queries[0] && (queries[0].use_case || queries[0].useCase);
    return {
      title: 'Finding the right tool',
      detail: first ? 'Searching connected apps for: ' + String(first).slice(0, 200) : 'Searching your connected apps for a matching tool.'
    };
  }
  if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    const tools = Array.isArray(input.tools) ? input.tools : [];
    const slugs = tools.map((tool) => tool && (tool.tool_slug || tool.toolSlug)).filter(Boolean);
    return {
      title: slugs.length === 1 ? 'Running ' + humanize(slugs[0]) : 'Running ' + (slugs.length || 'plugin') + ' plugin actions',
      detail: slugs.length ? slugs.map(String).join(', ').slice(0, 300) : 'Executing a plugin action.'
    };
  }
  return { title: 'Using ' + humanize(name), detail: 'Plugin tool call: ' + String(name).slice(0, 120) };
}

function compactResult(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (typeof text !== 'string') text = String(text);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return value;
  return { truncated: true, note: 'The result was shortened to fit.', preview: text.slice(0, MAX_TOOL_RESULT_CHARS) };
}

// Builds the Gemini function declarations and an executor for one chat turn. The session is limited
// to the plugins the user switched on and has code execution switched off.
async function createChatToolset(uid, slugs) {
  const enabled = normalizeSlugList(slugs);
  if (!enabled.length) return null;

  const composio = await getComposio();
  const session = await composio.sessions.create(uid, {
    toolkits: { enable: enabled },
    manageConnections: { enable: false },
    sandbox: { enable: false }
  });
  const tools = await session.tools();
  const declarations = (Array.isArray(tools) ? tools : []).flatMap((tool) => {
    const fn = tool && tool.function;
    if (!fn || typeof fn.name !== 'string' || !fn.name) return [];
    return [{
      name: fn.name,
      description: String(fn.description || '').slice(0, 1800),
      parametersJsonSchema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} }
    }];
  });
  if (!declarations.length) return null;

  const names = new Set(declarations.map((declaration) => declaration.name));
  return {
    plugins: enabled,
    declarations,
    describe: describeToolCall,
    async execute(name, args) {
      if (!names.has(name)) return { ok: false, error: 'That tool is not available in this chat.' };
      try {
        const result = await session.execute(name, args && typeof args === 'object' ? args : {});
        const completed = result && result.resultType === 'completed';
        return completed
          ? { ok: true, data: compactResult(result.data) }
          : { ok: false, error: String(result && result.error || 'The plugin action did not complete.').slice(0, 1500) };
      } catch (error) {
        return { ok: false, error: String(error && error.message || 'The plugin action failed.').slice(0, 1500) };
      }
    }
  };
}

module.exports = {
  MAX_ENABLED_PLUGINS,
  createChatToolset,
  disconnectPlugin,
  isConfigured,
  listPlugins,
  normalizeSlugList,
  startConnection
};

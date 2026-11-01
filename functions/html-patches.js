'use strict';

// TruX Code v3 — small, exact-match patches applied to public/index.html when it is served.
//
// Why this exists: index.html is one 190 KB file whose script keeps its state (chat list, current messages,
// the incognito flag...) private. These patches add the few hooks the v3 UI needs (/trux-v3.js and
// /trux-v3.css talk to the app through window.truxApp) without rewriting the whole file by hand.
//
// Every patch must match exactly once. A patch that no longer matches is skipped and logged, so a future edit
// to index.html can never take the site down. Run `npm run bake` once to write the patched result back into
// public/index.html permanently; after that this layer is a no-op and can be deleted.

const fs = require('node:fs');
const path = require('node:path');

const BRIDGE = `      notify: notify,
      isSending: function () { return isSending; },
      incognito: function () { return Boolean(window.truxIncognito); },
      setIncognito: function (on) {
        if (isSending) { notify('Wait for the current reply to finish first.'); return Boolean(window.truxIncognito); }
        on = Boolean(on);
        if (Boolean(window.truxIncognito) === on) return on;
        window.truxIncognito = on;
        document.documentElement.classList.toggle('tx-incognito', on);
        greetingRequest += 1;
        activeConversationId = null;
        currentMessages = [];
        showWelcome();
        if (currentUser) generateGreeting();
        renderHistory();
        closeSidebarOnMobile();
        return on;
      },
      chats: {
        get: function (id) {
          const c = conversations.find(function (item) { return item.id === id; });
          return c ? { id: c.id, title: c.title || 'New chat', pinned: Boolean(c.pinned) } : null;
        },
        activeId: function () { return activeConversationId; },
        rename: function (id, title) {
          const c = conversations.find(function (item) { return item.id === id; });
          const clean = String(title || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
          if (!c || !clean) return false;
          c.title = clean;
          persistConversations();
          syncConversationToCloud(c).catch(reportCloudSyncFailure);
          renderHistory();
          return true;
        },
        pin: function (id) {
          const c = conversations.find(function (item) { return item.id === id; });
          if (!c) return false;
          c.pinned = !c.pinned;
          persistConversations();
          renderHistory();
          return c.pinned;
        },
        remove: async function (id) {
          const index = conversations.findIndex(function (item) { return item.id === id; });
          if (index < 0) return false;
          if (isSending && id === activeConversationId) { notify('Wait for the current reply to finish first.'); return false; }
          conversations.splice(index, 1);
          persistConversations();
          if (id === activeConversationId) {
            greetingRequest += 1;
            activeConversationId = null;
            currentMessages = [];
            showWelcome();
            if (currentUser) generateGreeting();
          }
          renderHistory();
          try {
            if (currentUser) await synchronizeServerSession(currentUser, false);
            const response = await fetch('/api/chats/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) throw new Error('cloud delete failed');
          } catch (error) {
            notify('Chat removed here, but its cloud copy could not be deleted. It may come back after a reload.');
          }
          return true;
        },
        markdown: function (id) {
          const c = conversations.find(function (item) { return item.id === id; });
          if (!c) return '';
          const lines = ['# ' + (c.title || 'Chat'), ''];
          (c.messages || []).forEach(function (m) {
            if (!m || !m.content) return;
            lines.push('**' + (m.role === 'user' ? 'You' : 'TruX Code') + '**', '', m.content, '');
          });
          return lines.join('\\n');
        }
      },
      messages: {
        get: function (index) {
          const m = currentMessages[index];
          return m ? { role: m.role, content: m.content || '', error: m.error || '' } : null;
        },
        regenerate: function (index) {
          if (isSending || !currentUser) return false;
          const m = currentMessages[index];
          const u = currentMessages[index - 1];
          if (!m || m.role !== 'assistant' || !u || u.role !== 'user') return false;
          const text = String(u.content || '').replace(/\\n\\nAttached files: [^\\n]*$/, '');
          currentMessages = currentMessages.slice(0, index - 1);
          renderConversation();
          sendMessage(text);
          return true;
        },
        edit: function (index) {
          if (isSending || !currentUser) return false;
          const m = currentMessages[index];
          if (!m || m.role !== 'user') return false;
          const text = String(m.content || '').replace(/\\n\\nAttached files: [^\\n]*$/, '');
          currentMessages = currentMessages.slice(0, index);
          if (currentMessages.length) {
            renderConversation();
          } else {
            greetingRequest += 1;
            showWelcome();
            generateGreeting();
          }
          promptInput.value = text;
          resizePrompt();
          promptInput.focus();
          return true;
        }
      }
    };`;

const INCOGNITO_BUTTON = '<button class="icon-button incognito-toggle" id="incognitoButton" type="button" aria-pressed="false" aria-label="Incognito chat" title="Incognito chat">' +
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10a7 7 0 0 1 14 0v10l-2.33-1.75L14.33 20 12 18.25 9.67 20 7.33 18.25 5 20z"/><circle cx="9.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg></button>';

const PATCHES = [
  {
    name: 'v3 stylesheet',
    marker: '/trux-v3.css',
    find: '<link rel="stylesheet" href="/mobile-v2.css?v=20261101-serif-fix-3" media="(max-width: 760px)">',
    replace: function (ctx) {
      return '<link rel="stylesheet" href="/mobile-v2.css?v=20261101-serif-fix-3" media="(max-width: 760px)">\n' +
        '  <link rel="stylesheet" href="/trux-v3.css?v=' + ctx.version + '">';
    }
  },
  {
    name: 'v3 script',
    marker: '/trux-v3.js',
    find: '</body>',
    replace: function (ctx) { return '  <script defer src="/trux-v3.js?v=' + ctx.version + '"></script>\n</body>'; }
  },
  {
    name: 'top bar: drop the centred title, add the incognito button on the left',
    marker: 'id="incognitoButton"',
    find: '<div class="topbar-crumb"><strong>TruX Code</strong></div>',
    replace: INCOGNITO_BUTTON
  },
  {
    name: 'app bridge for v3 (incognito, chat actions, retry/edit)',
    marker: 'setIncognito: function',
    find: '      notify: notify\n    };',
    replace: BRIDGE
  },
  {
    name: 'incognito chats are never saved',
    marker: 'window.truxIncognito) return;',
    find: 'if (!currentUser || !currentMessages.length) return;',
    replace: 'if (!currentUser || !currentMessages.length || window.truxIncognito) return;'
  },
  {
    name: 'a renamed chat keeps its name',
    marker: 'conversation.title === conversation.autoTitle',
    find: 'if (firstUserMessage) {',
    replace: "if (firstUserMessage && (!conversation.title || conversation.title === 'New chat' || conversation.title === conversation.autoTitle)) {"
  },
  {
    name: 'remember the automatic title so a rename can be told apart',
    marker: 'conversation.autoTitle = conversation.title;',
    find: ".trim().slice(0, 48) || 'New chat';",
    replace: ".trim().slice(0, 48) || 'New chat';\n        conversation.autoTitle = conversation.title;"
  },
  {
    name: 'pinned chats sort first',
    marker: '(b.pinned ? 1 : 0)',
    find: 'return (b.updatedAt || 0) - (a.updatedAt || 0);',
    replace: 'return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0);'
  },
  {
    name: 'history rows carry their chat id (used by press-and-hold)',
    marker: 'button.dataset.chatId',
    find: "button.className = 'history-item' + (conversation.id === activeConversationId ? ' active' : '');",
    replace: "button.className = 'history-item' + (conversation.id === activeConversationId ? ' active' : '') + (conversation.pinned ? ' pinned' : '');\n        button.dataset.chatId = conversation.id;"
  }
];

function applyPatches(html, ctx) {
  let out = html;
  const report = [];
  for (const patch of PATCHES) {
    if (out.includes(patch.marker)) { report.push({ name: patch.name, status: 'already applied' }); continue; }
    const first = out.indexOf(patch.find);
    if (first < 0 || out.indexOf(patch.find, first + 1) >= 0) { report.push({ name: patch.name, status: first < 0 ? 'no match' : 'ambiguous' }); continue; }
    const replacement = typeof patch.replace === 'function' ? patch.replace(ctx) : patch.replace;
    out = out.slice(0, first) + replacement + out.slice(first + patch.find.length);
    report.push({ name: patch.name, status: 'applied' });
  }
  return { html: out, report };
}

let cache = { key: '', html: '' };

function renderIndex(publicDirectory) {
  const files = ['index.html', 'trux-v3.css', 'trux-v3.js'].map((name) => path.join(publicDirectory, name));
  const stamps = files.map((file) => { try { return Math.floor(fs.statSync(file).mtimeMs); } catch { return 0; } });
  const key = stamps.join('-');
  if (cache.key === key && cache.html) return cache.html;

  const source = fs.readFileSync(files[0], 'utf8');
  const version = String(Math.max(stamps[1], stamps[2]));
  const { html, report } = applyPatches(source, { version });
  report.filter((item) => item.status === 'no match' || item.status === 'ambiguous').forEach((item) => {
    console.warn('TruX v3 patch skipped (' + item.status + '): ' + item.name);
  });
  cache = { key, html };
  return html;
}

module.exports = { PATCHES, applyPatches, renderIndex };

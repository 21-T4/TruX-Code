/* TruX Code memory screen.
 *
 * The assistant decides what to remember (see functions/memory.js). This screen lets the person see every saved
 * note, delete any of them, clear everything, and switch memory off for new chats.
 */
(function () {
  'use strict';

  var state = { uid: null, items: [] };

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function app() { return window.truxApp || {}; }
  function notify(message) { if (app().notify) app().notify(message); }

  function prefKey() { return state.uid ? 'trux-memory-on-v1:' + state.uid : null; }
  function isOn() {
    var key = prefKey();
    if (!key) return true;
    try { return localStorage.getItem(key) !== '0'; } catch (e) { return true; }
  }
  function setOn(on) {
    var key = prefKey();
    if (!key) return;
    try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* storage can be blocked */ }
  }

  function api(path, options) {
    var init = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }, options || {});
    return fetch(path, init).then(function (response) {
      if (response.status === 204) return {};
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || 'The request failed (HTTP ' + response.status + ').');
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  var KIND_LABEL = { preference: 'Preference', instruction: 'Instruction', project: 'Project', fact: 'Fact' };

  function ago(ms) {
    if (!ms) return '';
    var days = Math.floor((Date.now() - ms) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
  }

  function render() {
    var list = $('memoryList');
    var clear = $('memoryClear');
    if (!list) return;
    list.replaceChildren();
    if (clear) clear.hidden = state.items.length === 0;
    if (!state.items.length) {
      list.appendChild(el('div', 'plugins-empty', 'Nothing saved yet. As you chat, TruX Code keeps short notes about your preferences and projects here.'));
      return;
    }
    state.items.forEach(function (item) {
      var row = el('article', 'memory-row');
      var copy = el('div', 'memory-copy');
      copy.appendChild(el('p', 'memory-text', item.text));
      copy.appendChild(el('span', 'memory-meta', (KIND_LABEL[item.kind] || 'Note') + (item.updatedAt ? ' · ' + ago(item.updatedAt) : '')));
      var remove = el('button', 'tx-btn', 'Forget');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Forget: ' + item.text.slice(0, 60));
      remove.addEventListener('click', function () {
        remove.disabled = true;
        api('/api/memories/' + encodeURIComponent(item.id), { method: 'DELETE' }).then(function () {
          state.items = state.items.filter(function (x) { return x.id !== item.id; });
          render();
        }).catch(function (error) { remove.disabled = false; notify(error.message); });
      });
      row.append(copy, remove);
      list.appendChild(row);
    });
  }

  function showNote(message, isError) {
    var note = $('memoryNote');
    if (!note) return;
    note.hidden = !message;
    note.className = 'plugins-note' + (isError ? ' error' : '');
    note.textContent = message || '';
  }

  function load() {
    showNote('');
    var list = $('memoryList');
    if (list) { list.replaceChildren(); list.appendChild(el('div', 'plugin-skeleton')); }
    return api('/api/memories').then(function (data) {
      state.items = Array.isArray(data.items) ? data.items : [];
      render();
    }).catch(function (error) {
      if (list) list.replaceChildren();
      showNote(error.status === 401 ? 'Your sign-in expired. Sign in again to see your memory.' : error.message, error.status !== 401);
    });
  }

  function openPage() {
    if (!(app().isSignedIn && app().isSignedIn())) { if (app().openSignIn) app().openSignIn(); return; }
    var sidebar = $('sidebar');
    if (sidebar) sidebar.classList.remove('mobile-open');
    $('memoryToggle').checked = isOn();
    $('memoryModal').hidden = false;
    load();
  }
  function closePage() { $('memoryModal').hidden = true; }

  function init() {
    $('openMemory').addEventListener('click', openPage);
    $('closeMemory').addEventListener('click', closePage);
    $('memoryToggle').addEventListener('change', function () {
      setOn(this.checked);
      notify(this.checked ? 'Memory is on for new messages.' : 'Memory is off. Nothing will be saved or used.');
    });
    $('memoryClear').addEventListener('click', function () {
      if (!window.confirm('Delete everything TruX Code has saved about you? This cannot be undone.')) return;
      api('/api/memories', { method: 'DELETE' }).then(function () { state.items = []; render(); notify('Memory cleared.'); })
        .catch(function (error) { notify(error.message); });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('memoryModal').hidden) closePage();
    });
    document.addEventListener('trux:auth', function (event) {
      state.uid = event.detail && event.detail.uid || null;
      if (!state.uid) closePage();
    });
    if (app().isSignedIn && app().isSignedIn()) state.uid = app().uid();
  }

  window.truxMemory = { enabled: isOn, open: openPage };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

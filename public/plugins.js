/* TruX Code plugins (Composio).
 *
 * Browser side of the plugin system: the composer chip, the Plugins page and the connect flow.
 * Everything that needs the Composio API key happens on the server (/api/plugins...). This file
 * only keeps UI state and a per-account list of which connected plugins are switched on for chats.
 */
(function () {
  'use strict';

  var PLUG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/></svg>';
  var MAX_ENABLED = 12;
  var PAGE_SIZE = 24;

  var state = {
    uid: null,
    configured: null,          // null = unknown, true/false once the server answered
    connected: {},             // slug -> true
    names: {},                 // slug -> { name, logo }
    off: {},                   // slug -> true (connected, but switched off for chats)
    optin: {},                 // slug -> true (apps that need no sign-in are opt-in)
    items: [],                 // currently shown on the Plugins page
    cursor: null,
    filter: 'all',
    search: '',
    loading: false,
    loadToken: 0
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function app() { return window.truxApp || {}; }
  function notify(message) { if (app().notify) app().notify(message); }
  function signedIn() { return Boolean(app().isSignedIn && app().isSignedIn()); }

  /* ---------- storage (per account, best effort) ---------- */
  function storageKey() { return state.uid ? 'trux-plugins-v1:' + state.uid : null; }
  function loadStored() {
    state.connected = {}; state.names = {}; state.off = {}; state.optin = {};
    var key = storageKey(); if (!key) return;
    try {
      var saved = JSON.parse(localStorage.getItem(key) || '{}');
      (saved.connected || []).forEach(function (slug) { state.connected[slug] = true; });
      (saved.off || []).forEach(function (slug) { state.off[slug] = true; });
      (saved.optin || []).forEach(function (slug) { state.optin[slug] = true; });
      state.names = saved.names && typeof saved.names === 'object' ? saved.names : {};
    } catch (e) { /* storage can be blocked */ }
  }
  function saveStored() {
    var key = storageKey(); if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        connected: Object.keys(state.connected),
        off: Object.keys(state.off),
        optin: Object.keys(state.optin),
        names: state.names
      }));
    } catch (e) { /* storage can be blocked */ }
  }

  /* ---------- public surface used by the chat request ---------- */
  function enabledList() {
    if (!signedIn() || state.configured === false) return [];
    var list = Object.keys(state.connected).filter(function (slug) { return !state.off[slug]; });
    Object.keys(state.optin).forEach(function (slug) { if (list.indexOf(slug) < 0) list.push(slug); });
    return list.sort().slice(0, MAX_ENABLED);
  }
  function isOn(slug) { return state.connected[slug] ? !state.off[slug] : Boolean(state.optin[slug]); }

  /* ---------- server calls ---------- */
  function api(path, options) {
    var init = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }, options || {});
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || 'The request failed (HTTP ' + response.status + ').');
          error.status = response.status;
          if (data.configured === false) state.configured = false;
          throw error;
        }
        return data;
      });
    });
  }
  function query(params) {
    var parts = [];
    Object.keys(params).forEach(function (key) {
      if (params[key] !== '' && params[key] != null) parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function remember(items) {
    items.forEach(function (item) {
      state.names[item.slug] = { name: item.name, logo: item.logo || '' };
      // Apps that need no sign-in are never "connected"; they are switched on by the user instead.
      if (item.connected && !item.noAuth) state.connected[item.slug] = true; else delete state.connected[item.slug];
    });
  }

  /* ---------- small UI pieces ---------- */
  function logoNode(slug, item) {
    var info = item || state.names[slug] || { name: slug, logo: '' };
    var box = el('span', 'plugin-logo');
    var letter = String(info.name || slug || '?').charAt(0).toUpperCase();
    if (/^https:\/\//i.test(info.logo || '')) {
      var img = document.createElement('img');
      img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = info.logo;
      img.addEventListener('error', function () { img.remove(); box.textContent = letter; });
      box.appendChild(img);
    } else {
      box.textContent = letter;
    }
    return box;
  }
  function displayName(slug) { return (state.names[slug] && state.names[slug].name) || slug; }

  function refreshCounters() {
    var count = enabledList().length;
    var badge = document.querySelector('#pluginChip .plugin-badge');
    var chip = $('pluginChip');
    if (badge) { badge.hidden = count === 0; badge.textContent = String(count); }
    if (chip) chip.classList.toggle('on', count > 0);
    var side = $('pluginCount');
    if (side) { side.hidden = count === 0; side.textContent = String(count); }
  }

  /* ---------- composer chip + popover ---------- */
  function buildChip() {
    var wrap = $('pluginChipWrap'); if (!wrap || $('pluginChip')) return;
    var chip = el('button', 'plugin-chip');
    chip.id = 'pluginChip'; chip.type = 'button';
    chip.setAttribute('aria-haspopup', 'true'); chip.setAttribute('aria-expanded', 'false');
    chip.title = 'Plugins for this chat';
    chip.innerHTML = PLUG_ICON + '<span class="plugin-chip-label">Plugins</span><span class="plugin-badge" hidden>0</span>';
    var pop = el('div', 'plugin-pop'); pop.id = 'pluginPop'; pop.hidden = true;
    wrap.append(chip, pop);
    chip.addEventListener('click', function () { togglePop(pop.hidden); });
    pop.addEventListener('click', function (event) { event.stopPropagation(); });
    document.addEventListener('click', function (event) { if (!wrap.contains(event.target)) togglePop(false); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') togglePop(false); });
  }
  function togglePop(open) {
    var pop = $('pluginPop'), chip = $('pluginChip'); if (!pop || !chip) return;
    if (open) { renderPop(); refreshConnected(); }
    pop.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
  }
  function renderPop() {
    var pop = $('pluginPop'); if (!pop) return;
    pop.replaceChildren();
    if (!signedIn()) {
      pop.appendChild(el('div', 'plugin-pop-empty', 'Sign in to connect plugins.'));
    } else if (state.configured === false) {
      pop.appendChild(el('div', 'plugin-pop-empty', 'Plugins are not set up on this server yet.'));
    } else {
      var slugs = Object.keys(state.connected).concat(Object.keys(state.optin).filter(function (x) { return !state.connected[x]; })).sort(function (a, b) { return displayName(a).localeCompare(displayName(b)); });
      if (!slugs.length) {
        pop.appendChild(el('div', 'plugin-pop-empty', 'No plugins connected yet. Connect an app and TruX Code can use it in this chat.'));
      }
      slugs.forEach(function (slug) {
        var row = el('label', 'plugin-row');
        var box = document.createElement('input'); box.type = 'checkbox'; box.checked = isOn(slug);
        box.setAttribute('aria-label', 'Use ' + displayName(slug) + ' in chats');
        box.addEventListener('change', function () { setEnabled(slug, box.checked); });
        row.append(logoNode(slug), el('span', 'plugin-row-name', displayName(slug)), box);
        pop.appendChild(row);
      });
    }
    var foot = el('div', 'plugin-pop-foot');
    var manage = el('button', '', slugsExist() ? 'Manage plugins' : 'Browse plugins'); manage.type = 'button';
    manage.addEventListener('click', function () { togglePop(false); openPage(); });
    foot.appendChild(manage); pop.appendChild(foot);
  }
  function slugsExist() { return Object.keys(state.connected).length + Object.keys(state.optin).length > 0; }

  function setEnabled(slug, on) {
    if (on && enabledList().length >= MAX_ENABLED) { notify('You can use up to ' + MAX_ENABLED + ' plugins in a chat.'); renderPop(); renderGrid(); return; }
    if (state.connected[slug]) { if (on) delete state.off[slug]; else state.off[slug] = true; }
    else if (on) state.optin[slug] = true; else delete state.optin[slug];
    saveStored(); refreshCounters();
  }

  /* ---------- Plugins page ---------- */
  var searchTimer = 0;
  function openPage() {
    if (!signedIn()) { if (app().openSignIn) app().openSignIn(); return; }
    var sidebar = $('sidebar'); if (sidebar) sidebar.classList.remove('mobile-open');
    $('pluginsModal').hidden = false;
    loadPage(true);
    setTimeout(function () { var s = $('pluginsSearch'); if (s) s.focus({ preventScroll: true }); }, 30);
  }
  function closePage() { $('pluginsModal').hidden = true; }

  function showNote(message, isError, noRetry) {
    var note = $('pluginsNote');
    if (!message) { note.hidden = true; return; }
    note.hidden = false; note.className = 'plugins-note' + (isError ? ' error' : '');
    note.replaceChildren(document.createTextNode(message));
    if (isError && !noRetry) {
      var retry = el('button', 'tx-btn', 'Try again'); retry.type = 'button'; retry.style.marginLeft = '10px';
      retry.addEventListener('click', function () { loadPage(true); });
      note.appendChild(retry);
    }
  }

  function loadPage(reset) {
    var token = ++state.loadToken;
    var grid = $('pluginsGrid'), more = $('pluginsMore');
    if (reset) {
      state.items = []; state.cursor = null;
      grid.replaceChildren();
      for (var i = 0; i < 6; i += 1) grid.appendChild(el('div', 'plugin-skeleton'));
      more.hidden = true;
    }
    showNote('');
    state.loading = true;
    more.disabled = true;
    return api('/api/plugins' + query({
      limit: PAGE_SIZE,
      search: state.search,
      cursor: reset ? '' : state.cursor,
      connected: state.filter === 'connected' ? '1' : ''
    })).then(function (data) {
      if (token !== state.loadToken) return;
      state.configured = data.configured !== false;
      if (!state.configured) {
        grid.replaceChildren();
        showNote('Plugins are not switched on for this deployment yet. Add COMPOSIO_API_KEY to the Cloud Run environment, then reload.', true, true);
        return;
      }
      remember(data.items || []);
      state.items = reset ? data.items : state.items.concat(data.items);
      state.cursor = data.nextCursor || null;
      saveStored(); refreshCounters(); renderGrid();
    }).catch(function (error) {
      if (token !== state.loadToken) return;
      grid.replaceChildren();
      if (error.status === 401) showNote('Your sign-in expired. Sign in again to manage plugins.', false);
      else showNote(error.message, true);
    }).then(function () {
      if (token === state.loadToken) { state.loading = false; more.disabled = false; more.hidden = !state.cursor; }
    });
  }

  function renderGrid() {
    var grid = $('pluginsGrid'); if (!grid || $('pluginsModal').hidden) return;
    grid.replaceChildren();
    if (!state.items.length) {
      grid.appendChild(el('div', 'plugins-empty', state.filter === 'connected' && !state.search
        ? 'Nothing connected yet. Pick an app from All apps to get started.'
        : 'No apps match your search.'));
      return;
    }
    state.items.forEach(function (item) { grid.appendChild(card(item)); });
  }

  function card(item) {
    var connected = Boolean(state.connected[item.slug]);
    var box = el('article', 'plugin-card' + (connected ? ' is-connected' : ''));
    box.dataset.slug = item.slug;
    var head = el('div', 'plugin-card-head');
    var name = el('div', 'plugin-card-name');
    var status = el('span');
    status.append(el('i', 'dot'), document.createTextNode(item.noAuth ? 'No sign-in needed' : connected ? 'Connected' : 'Not connected'));
    name.append(el('strong', '', item.name), status);
    head.append(logoNode(item.slug, item), name);

    var actions = el('div', 'plugin-card-actions');
    if (connected || item.noAuth) {
      var label = el('label'); var sw = document.createElement('input'); sw.type = 'checkbox';
      sw.checked = isOn(item.slug);
      sw.setAttribute('aria-label', 'Use ' + item.name + ' in chats');
      sw.addEventListener('change', function () { setEnabled(item.slug, sw.checked); });
      label.append(sw, document.createTextNode('Use in chats'));
      actions.appendChild(label);
      if (connected && !item.noAuth) {
        var off = el('button', 'tx-btn', 'Disconnect'); off.type = 'button';
        off.addEventListener('click', function () { disconnect(item, off); });
        actions.appendChild(off);
      }
    } else {
      var on = el('button', 'tx-btn connect', 'Connect'); on.type = 'button';
      on.addEventListener('click', function () { connect(item, on); });
      actions.append(el('span'), on);
    }
    box.append(head, actions);
    return box;
  }

  /* ---------- connect / disconnect ---------- */
  var pollTimer = 0;
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } }

  function connect(item, button) {
    button.disabled = true; button.textContent = 'Opening…';
    // Opened inside the click so browsers do not block it; the sign-in address is filled in below.
    var popup = window.open('', 'trux-plugin-connect', 'popup=yes,width=520,height=720');
    api('/api/plugins/' + encodeURIComponent(item.slug) + '/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}'
    }).then(function (data) {
      if (!data.redirectUrl || !/^https:\/\//i.test(data.redirectUrl)) throw new Error(item.name + ' did not return a sign-in link. Try again in a moment.');
      if (popup && !popup.closed) {
        popup.location.href = data.redirectUrl;
        button.textContent = 'Waiting…';
        watchConnection(item, popup, button);
      } else {
        // Pop-ups are blocked: continue in this tab. The callback page brings the user back here.
        window.location.assign(data.redirectUrl);
      }
    }).catch(function (error) {
      if (popup && !popup.closed) popup.close();
      button.disabled = false; button.textContent = 'Connect';
      notify(error.message);
    });
  }

  function watchConnection(item, popup, button) {
    stopPolling();
    var started = Date.now(), popupGoneAt = 0;
    function finish(ok) {
      stopPolling();
      try { if (popup && !popup.closed) popup.close(); } catch (e) { /* cross-origin window */ }
      if (ok) {
        state.connected[item.slug] = true; delete state.off[item.slug];
        saveStored(); refreshCounters(); renderGrid(); renderPop();
        notify(item.name + ' connected.');
      } else if (button && button.isConnected) {
        button.disabled = false; button.textContent = 'Connect';
      }
    }
    pollTimer = setInterval(function () {
      var gone = false;
      try { gone = popup.closed; } catch (e) { gone = false; }
      if (gone && !popupGoneAt) popupGoneAt = Date.now();
      api('/api/plugins' + query({ slug: item.slug, limit: 1 })).then(function (data) {
        var found = (data.items || []).filter(function (x) { return x.slug === item.slug; })[0];
        if (found && found.connected) finish(true);
        else if ((popupGoneAt && Date.now() - popupGoneAt > 6000) || Date.now() - started > 180000) finish(false);
      }).catch(function () { /* keep polling until the time limit */ });
    }, 2000);
  }

  function disconnect(item, button) {
    if (!window.confirm('Disconnect ' + item.name + '? TruX Code will no longer be able to use it.')) return;
    button.disabled = true; button.textContent = 'Disconnecting…';
    api('/api/plugins/' + encodeURIComponent(item.slug), { method: 'DELETE' }).then(function () {
      delete state.connected[item.slug]; delete state.off[item.slug];
      saveStored(); refreshCounters();
      if (state.filter === 'connected') state.items = state.items.filter(function (x) { return x.slug !== item.slug; });
      renderGrid(); renderPop();
      notify(item.name + ' disconnected.');
    }).catch(function (error) {
      button.disabled = false; button.textContent = 'Disconnect';
      notify(error.message);
    });
  }

  /* ---------- keep the connected list fresh ---------- */
  function refreshConnected() {
    if (!signedIn()) return Promise.resolve();
    return api('/api/plugins' + query({ connected: '1', limit: 48 })).then(function (data) {
      state.configured = data.configured !== false;
      if (state.configured) {
        var live = {};
        (data.items || []).forEach(function (item) { live[item.slug] = true; });
        remember(data.items || []);
        // Anything the server no longer lists as connected (for example removed elsewhere) is dropped.
        Object.keys(state.connected).forEach(function (slug) { if (!live[slug] && !data.nextCursor) delete state.connected[slug]; });
        saveStored();
      }
      refreshCounters();
      if (!$('pluginPop').hidden) renderPop();
    }).catch(function () { /* the chip keeps working from the saved list */ });
  }

  /* ---------- wiring ---------- */
  function onAuth(uid) {
    stopPolling();
    state.uid = uid || null; state.configured = null;
    loadStored(); refreshCounters();
    if (!uid) { closePage(); togglePop(false); return; }
    refreshConnected().then(handleReturnFromConnect);
  }

  // Back from a full-page connect (pop-ups blocked): ?plugin=slug&status=success|failed
  function handleReturnFromConnect() {
    var params = new URLSearchParams(window.location.search);
    var slug = params.get('plugin'); if (!slug) return;
    var ok = params.get('status') !== 'failed';
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) { /* ignore */ }
    if (ok) delete state.off[slug];
    notify(ok && state.connected[slug] ? displayName(slug) + ' connected.' : 'The connection was not completed.');
    openPage();
  }

  function init() {
    buildChip();
    document.addEventListener('trux:auth', function (event) { onAuth(event.detail && event.detail.uid); });
    if (signedIn()) onAuth(app().uid());

    $('openPlugins').addEventListener('click', openPage);
    $('quickPlugins').addEventListener('click', openPage);
    $('plusPluginsButton').addEventListener('click', function () { if (app().closePlusMenu) app().closePlusMenu(); openPage(); });
    $('closePlugins').addEventListener('click', closePage);
    $('pluginsMore').addEventListener('click', function () { if (state.cursor && !state.loading) loadPage(false); });
    $('pluginsSearch').addEventListener('input', function (event) {
      clearTimeout(searchTimer);
      var value = event.target.value.trim();
      searchTimer = setTimeout(function () { state.search = value; loadPage(true); }, 300);
    });
    $('pluginsFilter').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-f]'); if (!button) return;
      state.filter = button.dataset.f;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (b) { b.classList.toggle('on', b === button); });
      loadPage(true);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('pluginsModal').hidden) closePage();
    });
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin || !event.data || event.data.type !== 'trux-plugin-return') return;
      refreshConnected().then(function () { renderGrid(); });
    });
  }

  window.truxPlugins = { enabled: enabledList, open: openPage, refresh: refreshConnected };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

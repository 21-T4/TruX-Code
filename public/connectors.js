/* TruX Code connectors (official MCP servers).
 *
 * Browser side of the connector system: the Connectors page and the connect flow. Credentials never live in the
 * browser: a pasted token goes straight to the server (encrypted at rest) and Google sign-in happens on Google's
 * own page. This file only shows state returned by /api/connectors and sends the person's choices back.
 */
(function () {
  'use strict';

  var state = { uid: null, items: [], loaded: false, loading: false, token: 0 };
  var pollTimer = 0;

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

  function api(path, options) {
    var init = Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }, options || {});
    return fetch(path, init).then(function (response) {
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
  function send(method, path, body) {
    return api(path, { method: method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) });
  }

  function enabledCount() {
    return state.items.filter(function (item) { return item.connected && item.enabled; }).length;
  }
  function refreshCounters() {
    var side = $('pluginCount');
    if (!side) return;
    var count = enabledCount();
    side.hidden = count === 0;
    side.textContent = String(count);
  }

  function showNote(message, isError) {
    var note = $('pluginsNote');
    if (!note) return;
    if (!message) { note.hidden = true; return; }
    note.hidden = false;
    note.className = 'plugins-note' + (isError ? ' error' : '');
    note.replaceChildren(document.createTextNode(message));
    if (isError) {
      var retry = el('button', 'tx-btn', 'Try again');
      retry.type = 'button';
      retry.style.marginLeft = '10px';
      retry.addEventListener('click', function () { load(true); });
      note.appendChild(retry);
    }
  }

  function load(showSkeleton) {
    var token = ++state.token;
    var grid = $('pluginsGrid');
    if (showSkeleton && grid) {
      grid.replaceChildren();
      for (var i = 0; i < 4; i += 1) grid.appendChild(el('div', 'plugin-skeleton'));
    }
    showNote('');
    state.loading = true;
    return api('/api/connectors').then(function (data) {
      if (token !== state.token) return;
      state.items = Array.isArray(data.items) ? data.items : [];
      state.loaded = true;
      refreshCounters();
      render();
    }).catch(function (error) {
      if (token !== state.token) return;
      if (grid) grid.replaceChildren();
      showNote(error.status === 401 ? 'Your sign-in expired. Sign in again to manage connectors.' : error.message, error.status !== 401);
    }).then(function () { if (token === state.token) state.loading = false; });
  }

  /* ---------- rendering ---------- */
  function render() {
    var grid = $('pluginsGrid');
    var modal = $('pluginsModal');
    if (!grid || !modal || modal.hidden) return;
    var open = openFormId;
    grid.replaceChildren();
    if (!state.items.length) {
      grid.appendChild(el('div', 'plugins-empty', 'No connectors are available.'));
      return;
    }
    var group = '';
    state.items.forEach(function (item) {
      if (item.group !== group) {
        group = item.group;
        grid.appendChild(el('h3', 'conn-group', group));
      }
      grid.appendChild(card(item, open === item.id));
    });
  }

  var openFormId = null;

  function toggle(label, checked, onChange) {
    var wrap = el('label');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', function () { onChange(box.checked, box); });
    wrap.append(box, document.createTextNode(label));
    return wrap;
  }

  function card(item, formOpen) {
    var box = el('article', 'plugin-card' + (item.connected ? ' is-connected' : ''));
    box.dataset.id = item.id;

    var head = el('div', 'plugin-card-head');
    var letter = item.name.replace(/^Google\s+/, '').charAt(0).toUpperCase();
    var logo = el('span', 'plugin-logo');
    if (item.icon) {
      var img = document.createElement('img');
      img.src = item.icon;
      img.alt = '';
      img.width = 40;
      img.height = 40;
      img.decoding = 'async';
      img.loading = 'lazy';
      // If the icon cannot load, fall back to the first letter instead of a broken image.
      img.addEventListener('error', function () { logo.replaceChildren(document.createTextNode(letter)); });
      logo.appendChild(img);
    } else {
      logo.textContent = letter;
    }
    var name = el('div', 'plugin-card-name');
    var status = el('span');
    status.append(el('i', 'dot'), document.createTextNode(
      item.connected ? (item.enabled ? 'Connected' : 'Connected, switched off')
        : item.sharedKey ? 'Available' : 'Not connected'));
    name.append(el('strong', '', item.name), status);
    head.append(logo, name);
    box.appendChild(head);

    box.appendChild(el('p', 'conn-desc', item.description));
    if (!item.available && item.reason) box.appendChild(el('p', 'conn-note', item.reason));
    else if (item.note && !item.connected) box.appendChild(el('p', 'conn-note', item.note));

    var actions = el('div', 'plugin-card-actions');
    if (item.connected) {
      actions.appendChild(toggle('Use in chats', item.enabled, function (on, input) { setOption(item, { enabled: on }, input); }));
      if (!item.readOnly) {
        actions.appendChild(toggle('Allow changes', item.allowWrites, function (on, input) {
          if (on && !window.confirm('Let TruX Code make changes in ' + item.name + ' (for example create or edit things)? It will still ask before anything hard to undo.')) {
            input.checked = false;
            return;
          }
          setOption(item, { allowWrites: on }, input);
        }));
      } else {
        actions.appendChild(el('span', 'conn-ro', 'Read only'));
      }
      if (!item.sharedKey) {
        var off = el('button', 'tx-btn', 'Disconnect');
        off.type = 'button';
        off.addEventListener('click', function () { disconnect(item, off); });
        actions.appendChild(off);
      }
    } else if (item.sharedKey) {
      actions.appendChild(toggle('Use in chats', false, function (on, input) { enableShared(item, on, input); }));
    } else {
      var connect = el('button', 'tx-btn connect', 'Connect');
      connect.type = 'button';
      connect.disabled = !item.available;
      connect.addEventListener('click', function () {
        if (item.authType === 'google') startGoogle(item, connect);
        else { openFormId = formOpen ? null : item.id; render(); }
      });
      actions.append(el('span'), connect);
    }
    box.appendChild(actions);

    if (formOpen && !item.connected && item.authType !== 'google') box.appendChild(tokenForm(item));
    return box;
  }

  function tokenForm(item) {
    var form = el('form', 'conn-form');
    form.autocomplete = 'off';
    var label = el('label', '', item.authLabel || 'Access token');
    var input = document.createElement('input');
    input.type = 'password';
    input.required = true;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Paste it here';
    input.setAttribute('aria-label', item.authLabel || 'Access token');
    label.appendChild(input);
    var help = el('p', 'conn-help', item.authHelp || '');
    var save = el('button', 'tx-btn connect', 'Check and save');
    save.type = 'submit';
    form.append(label, help, save);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = input.value.trim();
      if (!value) return;
      save.disabled = true;
      save.textContent = 'Checking…';
      send('POST', '/api/connectors/' + encodeURIComponent(item.id) + '/token', { token: value }).then(function (data) {
        input.value = '';
        openFormId = null;
        var tools = data && data.tools ? data.tools : null;
        notify(item.name + ' connected' + (tools ? ' (' + tools.total + ' tools, ' + tools.read + ' read only).' : '.'));
        return load(false);
      }).catch(function (error) {
        save.disabled = false;
        save.textContent = 'Check and save';
        notify(error.message);
      });
    });
    setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 30);
    return form;
  }

  /* ---------- actions ---------- */
  function setOption(item, options, input) {
    if (input) input.disabled = true;
    send('PATCH', '/api/connectors/' + encodeURIComponent(item.id), options).then(function () {
      return load(false);
    }).catch(function (error) {
      notify(error.message);
      return load(false);
    });
  }

  function enableShared(item, on, input) {
    if (!on) return;
    input.disabled = true;
    // Shared-key connectors have no credential of their own; switching them on just records the choice.
    api('/api/connectors/' + encodeURIComponent(item.id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ enabled: true })
    }).then(function () { return load(false); }).catch(function (error) { notify(error.message); return load(false); });
  }

  function disconnect(item, button) {
    if (!window.confirm('Disconnect ' + item.name + '? TruX Code will no longer be able to use it.')) return;
    button.disabled = true;
    button.textContent = 'Disconnecting…';
    api('/api/connectors/' + encodeURIComponent(item.id), { method: 'DELETE' }).then(function () {
      notify(item.name + ' disconnected.');
      return load(false);
    }).catch(function (error) {
      button.disabled = false;
      button.textContent = 'Disconnect';
      notify(error.message);
    });
  }

  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } }

  function startGoogle(item, button) {
    button.disabled = true;
    button.textContent = 'Opening…';
    // Opened inside the click so browsers do not block it; the Google address is filled in below.
    var popup = window.open('', 'trux-connector-connect', 'popup=yes,width=520,height=720');
    send('POST', '/api/connectors/' + encodeURIComponent(item.id) + '/connect', {}).then(function (data) {
      if (!data.redirectUrl || !/^https:\/\/accounts\.google\.com\//i.test(data.redirectUrl)) {
        throw new Error('Google did not return a sign-in link. Try again in a moment.');
      }
      if (popup && !popup.closed) {
        popup.location.href = data.redirectUrl;
        button.textContent = 'Waiting…';
        watch(item, popup, button);
      } else {
        // Pop-ups are blocked: continue in this tab. The callback page brings the person back here.
        window.location.assign(data.redirectUrl);
      }
    }).catch(function (error) {
      if (popup && !popup.closed) popup.close();
      button.disabled = false;
      button.textContent = 'Connect';
      notify(error.message);
    });
  }

  function watch(item, popup, button) {
    stopPolling();
    var started = Date.now();
    var goneAt = 0;
    pollTimer = setInterval(function () {
      var gone = false;
      try { gone = popup.closed; } catch (e) { gone = false; }
      if (gone && !goneAt) goneAt = Date.now();
      api('/api/connectors').then(function (data) {
        var found = (data.items || []).filter(function (x) { return x.id === item.id; })[0];
        if (found && found.connected) {
          stopPolling();
          try { if (!popup.closed) popup.close(); } catch (e) { /* cross-origin window */ }
          state.items = data.items;
          refreshCounters();
          render();
          notify(item.name + ' connected.');
        } else if ((goneAt && Date.now() - goneAt > 6000) || Date.now() - started > 180000) {
          stopPolling();
          if (button && button.isConnected) { button.disabled = false; button.textContent = 'Connect'; }
        }
      }).catch(function () { /* keep polling until the time limit */ });
    }, 2000);
  }

  /* ---------- page ---------- */
  function openPage() {
    if (!signedIn()) { if (app().openSignIn) app().openSignIn(); return; }
    var sidebar = $('sidebar');
    if (sidebar) sidebar.classList.remove('mobile-open');
    $('pluginsModal').hidden = false;
    load(true);
  }
  function closePage() { $('pluginsModal').hidden = true; openFormId = null; stopPolling(); }

  function handleReturn() {
    var params = new URLSearchParams(window.location.search);
    var id = params.get('connector');
    if (!id) return;
    var ok = params.get('status') !== 'failed';
    try { window.history.replaceState({}, '', window.location.pathname); } catch (e) { /* ignore */ }
    notify(ok ? 'Connected.' : 'The connection was not completed.');
    openPage();
  }

  function onAuth(uid) {
    stopPolling();
    state.uid = uid || null;
    state.items = [];
    state.loaded = false;
    refreshCounters();
    if (!uid) { closePage(); return; }
    api('/api/connectors').then(function (data) {
      state.items = Array.isArray(data.items) ? data.items : [];
      state.loaded = true;
      refreshCounters();
      handleReturn();
    }).catch(function () { /* the count stays hidden until the page is opened */ });
  }

  function init() {
    document.addEventListener('trux:auth', function (event) { onAuth(event.detail && event.detail.uid); });
    if (signedIn()) onAuth(app().uid());

    ['openPlugins', 'quickPlugins'].forEach(function (id) { var node = $(id); if (node) node.addEventListener('click', openPage); });
    var plus = $('plusPluginsButton');
    if (plus) plus.addEventListener('click', function () { if (app().closePlusMenu) app().closePlusMenu(); openPage(); });
    $('closePlugins').addEventListener('click', closePage);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('pluginsModal').hidden) closePage();
    });
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin || !event.data || event.data.type !== 'trux-connector-return') return;
      load(false);
    });
  }

  window.truxConnectors = { open: openPage, refresh: function () { return load(false); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

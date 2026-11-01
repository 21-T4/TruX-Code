/* TruX Code v3 — incognito, half-screen "+" sheet, press-and-hold chat menu,
   message actions (copy / like / dislike / read aloud / retry / edit). Talks to the app via window.truxApp. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var app = function () { return window.truxApp || null; };
  var notify = function (m) { var a = app(); if (a && a.notify) a.notify(m); };

  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (html != null) node.innerHTML = html;
    return node;
  }
  function icon(path, extra) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (extra || '') + '>' + path + '</svg>';
  }
  var ICONS = {
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    up: '<path d="M7 11v9H4v-9zM7 11l4-8c1.7 0 2.6 1.2 2.3 2.8L12.8 9H19a2 2 0 0 1 2 2.4l-1.3 6.8a2 2 0 0 1-2 1.8H7"/>',
    down: '<path d="M7 13V4H4v9zM7 13l4 8c1.7 0 2.6-1.2 2.3-2.8L12.8 15H19a2 2 0 0 0 2-2.4l-1.3-6.8A2 2 0 0 0 17.7 4H7"/>',
    speaker: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
    retry: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/>',
    edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14 7 3 3"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9" />',
    pin: '<path d="M12 17v5M9 3h6l-1 7 3 3v2H7v-2l3-3z"/>',
    rename: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14 7 3 3"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>',
    trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    ghost: '<path d="M5 20V10a7 7 0 0 1 14 0v10l-2.33-1.75L14.33 20 12 18.25 9.67 20 7.33 18.25 5 20z"/><circle cx="9.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10.5" r="1" fill="currentColor" stroke="none"/>'
  };

  function haptic() { try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* optional */ } }
  function isMobile() { return window.matchMedia('(max-width: 760px)').matches; }

  /* ---------------------------------------------------------------- theme-color */
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var c = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    meta.setAttribute('content', c || (dark ? '#262624' : '#faf9f5'));
  }

  /* ---------------------------------------------------------------- incognito */
  function initIncognito() {
    var btn = $('incognitoButton');
    if (!btn) return;
    var workspace = document.querySelector('.workspace');
    if (workspace && !$('txIncogBanner')) {
      var banner = el('div', { id: 'txIncogBanner', class: 'tx-incog-banner', role: 'status' },
        icon(ICONS.ghost) + '<span>Incognito chat · not saved to history</span>');
      workspace.appendChild(banner);
    }
    btn.addEventListener('click', function () {
      var a = app();
      if (!a) return;
      if (!a.isSignedIn()) { a.openSignIn(); return; }
      a.setIncognito(!a.incognito());
    });
    var sync = function () {
      var on = document.documentElement.classList.contains('tx-incognito');
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('title', on ? 'Leave incognito' : 'Incognito chat');
    };
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  /* ---------------------------------------------------------------- "+" sheet */
  function initPlusSheet() {
    var menu = $('plusMenu');
    if (!menu || menu.classList.contains('tx-sheet')) return;
    var scrim = el('div', { id: 'txSheetScrim', class: 'tx-scrim' });
    document.body.appendChild(scrim);
    document.body.appendChild(menu);
    menu.classList.add('tx-sheet');

    var close = el('button', { type: 'button', class: 'tx-sheet-close', 'aria-label': 'Close' }, icon(ICONS.close));
    var head = el('div', { class: 'tx-sheet-head' });
    head.appendChild(el('div', { class: 'tx-sheet-grab' }));
    var bar = el('div', { class: 'tx-sheet-titlebar' }, '<strong>Add to chat</strong>');
    bar.appendChild(close);
    head.appendChild(bar);

    var tiles = el('div', { class: 'tx-sheet-tiles' });
    ['addFilesButton', 'cameraButton', 'pasteClipboardButton'].forEach(function (id) {
      var b = $(id);
      if (b) { b.classList.add('tx-tile'); tiles.appendChild(b); }
    });
    menu.insertBefore(tiles, menu.firstChild);
    menu.insertBefore(head, menu.firstChild);
    Array.prototype.forEach.call(menu.querySelectorAll('.plus-menu-item, .plus-menu-label'), function (node, i) {
      node.style.setProperty('--n', String(i));
    });

    var shut = function () { var a = app(); if (a) a.closePlusMenu(); };
    close.addEventListener('click', shut);
    scrim.addEventListener('click', shut);
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    new MutationObserver(function () {
      document.documentElement.classList.toggle('tx-sheet-open', !menu.hidden);
      if (menu.hidden) menu.scrollTop = 0;
    }).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    document.documentElement.classList.toggle('tx-sheet-open', !menu.hidden);

    // drag the handle down to dismiss
    var startY = 0, dy = 0, dragging = false;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.tx-sheet-close')) return;
      dragging = true; startY = e.clientY; dy = 0;
      menu.style.transition = 'none';
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - startY);
      menu.style.transform = 'translateY(' + dy + 'px)';
    });
    var release = function () {
      if (!dragging) return;
      dragging = false;
      menu.style.transition = '';
      menu.style.transform = '';
      if (dy > 110) shut();
      dy = 0;
    };
    head.addEventListener('pointerup', release);
    head.addEventListener('pointercancel', release);
  }

  /* ---------------------------------------------------------------- dialogs */
  var overlayScrim, ctxMenu, dialogBox, closeCtx = function () {}, dialogDone = null;

  function ensureOverlays() {
    if (overlayScrim) return;
    overlayScrim = el('div', { id: 'txCtxScrim', class: 'tx-scrim' });
    ctxMenu = el('div', { class: 'tx-ctx', role: 'menu' });
    dialogBox = el('div', { class: 'tx-dialog', role: 'dialog', 'aria-modal': 'true' });
    document.body.append(overlayScrim, ctxMenu, dialogBox);
    overlayScrim.addEventListener('click', function () {
      if (dialogDone) dialogDone(null); else closeCtx();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (dialogDone) dialogDone(null); else closeCtx();
    });
  }

  function openDialog(opts) {
    ensureOverlays();
    return new Promise(function (resolve) {
      var root = document.documentElement;
      var html = '<h3></h3>' + (opts.body ? '<p></p>' : '') + (opts.input != null ? '<input type="text" maxlength="120" autocomplete="off" enterkeyhint="done">' : '') +
        '<div class="tx-dialog-actions"><button type="button" data-a="no">Cancel</button><button type="button" data-a="yes" class="' + (opts.danger ? 'is-danger' : 'primary') + '"></button></div>';
      dialogBox.innerHTML = html;
      dialogBox.querySelector('h3').textContent = opts.title;
      if (opts.body) dialogBox.querySelector('p').textContent = opts.body;
      dialogBox.querySelector('[data-a="yes"]').textContent = opts.confirm || 'OK';
      var input = dialogBox.querySelector('input');
      if (input) input.value = opts.input;
      var finish = function (value) {
        dialogDone = null;
        dialogBox.classList.remove('open');
        root.classList.remove('tx-dialog-open');
        resolve(value);
      };
      dialogDone = finish;
      var submit = function () { finish(input ? input.value : true); };
      dialogBox.querySelector('[data-a="no"]').addEventListener('click', function () { finish(null); });
      dialogBox.querySelector('[data-a="yes"]').addEventListener('click', submit);
      if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      root.classList.add('tx-dialog-open');
      requestAnimationFrame(function () {
        dialogBox.classList.add('open');
        if (input) { input.focus(); input.select(); }
      });
    });
  }

  /* ---------------------------------------------------------------- press-and-hold chat menu */
  function initChatMenu() {
    var list = $('historyList');
    if (!list) return;
    ensureOverlays();
    var timer = 0, startX = 0, startY = 0, holdItem = null, suppressUntil = 0, openId = null;

    function cancelHold() {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (holdItem) { holdItem.classList.remove('holding'); holdItem = null; }
    }

    closeCtx = function () {
      ctxMenu.classList.remove('open');
      document.documentElement.classList.remove('tx-ctx-open');
      openId = null;
    };

    function download(name, text) {
      var url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      var a = el('a', { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    function openMenu(id, x, y) {
      var a = app();
      var chat = a && a.chats && a.chats.get(id);
      if (!chat) return;
      openId = id;
      ctxMenu.innerHTML = '';
      var title = el('div', { class: 'tx-ctx-title' });
      title.textContent = chat.title;
      ctxMenu.appendChild(title);
      var add = function (key, label, danger, fn) {
        if (key === 'sep') { ctxMenu.appendChild(el('div', { class: 'tx-ctx-sep' })); return; }
        var b = el('button', { type: 'button', class: 'tx-ctx-item' + (danger ? ' is-danger' : ''), role: 'menuitem' }, icon(ICONS[key]) + '<span></span>');
        b.lastChild.textContent = label;
        b.addEventListener('click', function () { closeCtx(); fn(); });
        ctxMenu.appendChild(b);
      };
      add('rename', 'Rename', false, function () {
        openDialog({ title: 'Rename chat', input: chat.title, confirm: 'Save' }).then(function (value) {
          if (value && value.trim()) a.chats.rename(id, value);
        });
      });
      add('pin', chat.pinned ? 'Unpin' : 'Pin to top', false, function () { a.chats.pin(id); });
      add('copy', 'Copy chat', false, function () {
        var text = a.chats.markdown(id);
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
          function () { notify('Chat copied.'); },
          function () { notify('Copying was blocked by the browser.'); });
      });
      add('download', 'Export as Markdown', false, function () {
        var safe = (chat.title || 'chat').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'chat';
        download(safe + '.md', a.chats.markdown(id));
      });
      add('sep');
      add('trash', 'Delete', true, function () {
        openDialog({ title: 'Delete this chat?', body: 'This permanently removes “' + chat.title.slice(0, 60) + '” from this device and your account.', confirm: 'Delete', danger: true })
          .then(function (ok) { if (ok) a.chats.remove(id); });
      });

      if (!isMobile()) {
        var w = 260, h = ctxMenu.offsetHeight || 260;
        ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
        ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
      } else {
        ctxMenu.style.left = ''; ctxMenu.style.top = '';
      }
      document.documentElement.classList.add('tx-ctx-open');
      requestAnimationFrame(function () { ctxMenu.classList.add('open'); });
    }

    list.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var item = e.target.closest('.history-item');
      if (!item || !item.dataset.chatId) return;
      cancelHold();
      startX = e.clientX; startY = e.clientY; holdItem = item;
      item.classList.add('holding');
      timer = setTimeout(function () {
        timer = 0;
        var id = item.dataset.chatId;
        item.classList.remove('holding'); holdItem = null;
        suppressUntil = Date.now() + 800;
        haptic();
        openMenu(id, startX, startY);
      }, e.pointerType === 'mouse' ? 550 : 420);
    });
    list.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - startX) > 9 || Math.abs(e.clientY - startY) > 9)) cancelHold();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) { list.addEventListener(name, cancelHold); });
    list.addEventListener('scroll', cancelHold, { passive: true });
    list.addEventListener('contextmenu', function (e) {
      var item = e.target.closest('.history-item');
      if (!item || !item.dataset.chatId) return;
      e.preventDefault();
      cancelHold();
      suppressUntil = Date.now() + 800;
      if (openId !== item.dataset.chatId) openMenu(item.dataset.chatId, e.clientX, e.clientY);
    });
    // the finger that opened the menu must not also open the chat
    list.addEventListener('click', function (e) {
      if (Date.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  /* ---------------------------------------------------------------- read aloud (Gemini TTS) */
  var SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  var tts = { audio: null, btn: null, token: 0, abort: null, cancelPlay: null };

  function toSpeech(md) {
    var t = String(md || '');
    t = t.replace(/```[\s\S]*?(```|$)/g, ' Code block omitted. ');
    t = t.replace(/\$\$[\s\S]*?\$\$/g, ' ');
    t = t.replace(/`([^`\n]+)`/g, '$1');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    t = t.replace(/^#{1,6}\s*/gm, '').replace(/^\s*>\s?/gm, '');
    t = t.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '');
    t = t.replace(/(\*\*|__|\*|~~)/g, '');
    t = t.replace(/^\|?[-:\s|]+\|?$/gm, '').replace(/\|/g, ', ').replace(/^[ ,]+|[ ,]+$/gm, '');
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/( Code block omitted\.\s*){2,}/g, ' Code block omitted. ');
    return t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n\n').trim().slice(0, 14000);
  }

  function splitLong(s, max) {
    var out = [], words = s.split(/\s+/), cur = '';
    words.forEach(function (w) {
      if (cur && cur.length + 1 + w.length > max) { out.push(cur); cur = ''; }
      cur = cur ? cur + ' ' + w : w;
    });
    if (cur) out.push(cur);
    return out;
  }

  // The first piece is short so audio starts quickly; the rest are bigger.
  function chunkText(text) {
    var sentences = [];
    text.split(/\n+/).forEach(function (p) {
      (p.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [p]).forEach(function (s) {
        s = s.trim();
        if (s) sentences.push(s);
      });
    });
    var chunks = [], cur = '';
    var limit = function () { return chunks.length === 0 ? 380 : 900; };
    sentences.forEach(function (s) {
      var parts = s.length > limit() ? splitLong(s, limit()) : [s];
      parts.forEach(function (part) {
        if (cur && cur.length + 1 + part.length > limit()) { chunks.push(cur); cur = ''; }
        cur = cur ? cur + ' ' + part : part;
      });
    });
    if (cur) chunks.push(cur);
    return chunks;
  }

  function setActState(btn, state) {
    if (!btn) return;
    btn.dataset.state = state;
    btn.classList.toggle('is-playing', state === 'playing');
    var path = state === 'loading' ? ICONS.spinner : state === 'playing' ? ICONS.stop : ICONS.speaker;
    btn.innerHTML = icon(path, state === 'loading' ? ' class="tx-spin"' : '');
    btn.setAttribute('aria-label', state === 'idle' ? 'Read aloud' : 'Stop reading');
    btn.title = state === 'idle' ? 'Read aloud' : 'Stop';
  }

  function stopTts() {
    tts.token += 1;
    if (tts.abort) { try { tts.abort.abort(); } catch (e) { /* ignore */ } tts.abort = null; }
    if (tts.cancelPlay) { tts.cancelPlay(); tts.cancelPlay = null; }
    if (tts.audio) { try { tts.audio.pause(); } catch (e) { /* ignore */ } }
    if (tts.btn) setActState(tts.btn, 'idle');
    tts.btn = null;
  }

  function fetchSpeech(text, signal) {
    return fetch('/api/tts', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, voice: localStorage.getItem('trux.ttsVoice') || undefined })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'Read aloud failed.'); });
      }
      return res.blob().then(function (blob) { return URL.createObjectURL(blob); });
    });
  }

  function playUrl(url, token) {
    return new Promise(function (resolve, reject) {
      var audio = tts.audio;
      var done = function () { audio.onended = audio.onerror = null; tts.cancelPlay = null; URL.revokeObjectURL(url); };
      tts.cancelPlay = function () { done(); resolve(); };
      audio.onended = function () { done(); resolve(); };
      audio.onerror = function () { done(); reject(new Error('The audio could not be played.')); };
      audio.src = url;
      audio.play().then(function () {
        if (token === tts.token && tts.btn) setActState(tts.btn, 'playing');
      }).catch(function (err) { done(); reject(err); });
    });
  }

  async function speak(btn, index) {
    if (tts.btn === btn) { stopTts(); return; }
    stopTts();
    var a = app();
    var message = a && a.messages.get(index);
    var text = toSpeech(message && message.content);
    if (!text) { notify('There is nothing to read aloud here.'); return; }
    var chunks = chunkText(text);
    var token = ++tts.token;
    tts.btn = btn;
    setActState(btn, 'loading');
    if (!tts.audio) tts.audio = new Audio();
    // iOS only allows playback that starts inside a tap; this "unlocks" the element for the pieces that follow.
    tts.audio.src = SILENT;
    tts.audio.play().catch(function () { /* unlock is best effort */ });

    var abort = tts.abort = new AbortController();
    try {
      var next = fetchSpeech(chunks[0], abort.signal);
      for (var i = 0; i < chunks.length; i += 1) {
        var url = await next;
        if (token !== tts.token) { URL.revokeObjectURL(url); return; }
        next = i + 1 < chunks.length ? fetchSpeech(chunks[i + 1], abort.signal) : null;
        if (next) next.catch(function () { /* surfaced when awaited */ });
        await playUrl(url, token);
        if (token !== tts.token) return;
      }
    } catch (error) {
      if (token === tts.token && !(error && error.name === 'AbortError')) notify(error && error.message || 'Read aloud failed.');
    } finally {
      if (token === tts.token) { setActState(btn, 'idle'); tts.btn = null; tts.abort = null; }
    }
  }

  /* ---------------------------------------------------------------- message actions */
  var FEEDBACK_KEY = 'truxFeedback.v1';
  function readFeedback() { try { return JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '{}'); } catch (e) { return {}; } }
  function feedbackKey(index) { var a = app(); var id = a && a.chats && a.chats.activeId(); return id ? id + ':' + index : null; }

  function copyText(text, btn) {
    var done = function () {
      btn.innerHTML = icon(ICONS.check);
      setTimeout(function () { btn.innerHTML = icon(ICONS.copy); }, 1600);
    };
    var fallback = function () {
      var ta = el('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { notify('Copying was blocked by the browser.'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  function indexOfArticle(article) {
    var list = $('messages');
    return Array.prototype.indexOf.call(list.querySelectorAll(':scope > article.message'), article);
  }

  function actButton(key, label, handler) {
    var b = el('button', { type: 'button', class: 'tx-act', 'data-act': key, 'aria-label': label, title: label }, icon(ICONS[key === 'like' ? 'up' : key === 'dislike' ? 'down' : key === 'read' ? 'speaker' : key]));
    b.addEventListener('click', function (e) { e.stopPropagation(); handler(b); });
    return b;
  }

  function buildAssistantActions(article) {
    var bar = el('div', { class: 'tx-actions', role: 'toolbar', 'aria-label': 'Message actions' });
    var a = app();
    bar.appendChild(actButton('copy', 'Copy', function (b) {
      var m = a.messages.get(indexOfArticle(article));
      if (m && m.content) copyText(m.content, b);
    }));
    var like = actButton('like', 'Good response', function () { setFeedback(1); });
    var dislike = actButton('dislike', 'Bad response', function () { setFeedback(-1); });
    function setFeedback(value) {
      var index = indexOfArticle(article), key = feedbackKey(index);
      var store = readFeedback();
      var current = key ? store[key] : (article._fb || 0);
      var next = current === value ? 0 : value;
      if (key) { if (next) store[key] = next; else delete store[key]; try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(store)); } catch (e) { /* optional */ } }
      article._fb = next;
      paintFeedback();
      if (next) notify(next > 0 ? 'Thanks for the feedback.' : 'Thanks — noted.');
    }
    function paintFeedback() {
      var key = feedbackKey(indexOfArticle(article));
      var v = key ? readFeedback()[key] || 0 : article._fb || 0;
      like.classList.toggle('on', v > 0); dislike.classList.toggle('on', v < 0);
      like.setAttribute('aria-pressed', String(v > 0)); dislike.setAttribute('aria-pressed', String(v < 0));
    }
    bar.append(like, dislike);
    var read = actButton('read', 'Read aloud', function (b) { speak(b, indexOfArticle(article)); });
    read.dataset.state = 'idle';
    bar.appendChild(read);
    bar.appendChild(el('span', { class: 'tx-act-sep' }));
    bar.appendChild(actButton('retry', 'Retry', function () { a.messages.regenerate(indexOfArticle(article)); }));
    bar._paint = paintFeedback;
    paintFeedback();
    return bar;
  }

  function buildUserActions(article) {
    var bar = el('div', { class: 'tx-actions', role: 'toolbar', 'aria-label': 'Message actions' });
    var a = app();
    bar.appendChild(actButton('copy', 'Copy', function (b) {
      var m = a.messages.get(indexOfArticle(article));
      if (m && m.content) copyText(m.content, b);
    }));
    bar.appendChild(actButton('edit', 'Edit', function () { a.messages.edit(indexOfArticle(article)); }));
    return bar;
  }

  function decorate() {
    var a = app();
    var list = $('messages');
    if (!a || !a.messages || !list || list.hidden) return;
    var articles = list.querySelectorAll(':scope > article.message');
    var lastAssistant = -1;
    articles.forEach(function (art, i) { if (art.classList.contains('assistant')) lastAssistant = i; });
    var busy = a.isSending();

    articles.forEach(function (art, i) {
      var existing = art.querySelector(':scope > .tx-actions, :scope > .message-body > .tx-actions');
      if (art.classList.contains('user')) {
        if (!existing && !busy && art.textContent.trim()) art.appendChild(buildUserActions(art));
        else if (existing && busy) existing.remove();
        return;
      }
      var streaming = art.classList.contains('tx-streaming') || art.querySelector('.trux-thinking-panel.is-active');
      var ready = !streaming && (art.classList.contains('has-response') || art.classList.contains('error'));
      if (ready && !existing) {
        var bar = buildAssistantActions(art);
        art.querySelector(':scope > .message-body').appendChild(bar);
        if (i !== lastAssistant) { var r = bar.querySelector('[data-act="retry"]'); if (r) r.remove(); var s = bar.querySelector('.tx-act-sep'); if (s) s.remove(); }
        if (art.classList.contains('error') && !art.classList.contains('has-response')) {
          Array.prototype.forEach.call(bar.querySelectorAll('.tx-act:not([data-act="retry"])'), function (n) { n.remove(); });
          var sep = bar.querySelector('.tx-act-sep'); if (sep) sep.remove();
        }
      } else if (!ready && existing) {
        existing.remove();
      } else if (ready && existing && i !== lastAssistant) {
        var rr = existing.querySelector('[data-act="retry"]');
        if (rr) { rr.remove(); var ss = existing.querySelector('.tx-act-sep'); if (ss) ss.remove(); }
      }
    });
    if (tts.btn && !tts.btn.isConnected) stopTts();
  }

  function initMessageActions() {
    var list = $('messages');
    if (!list) return;
    var pending = 0;
    var schedule = function () {
      if (pending) return;
      pending = requestAnimationFrame(function () { pending = 0; try { decorate(); } catch (e) { /* never break the chat */ } });
    };
    new MutationObserver(schedule).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    schedule();
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    [initIncognito, initPlusSheet, initChatMenu, initMessageActions].forEach(function (fn) {
      try { fn(); } catch (e) { console.warn('TruX v3: ' + fn.name + ' failed:', e && e.message); }
    });
    syncThemeColor();
    new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // truxApp is created by the app's module script, which runs after this deferred script is queued.
  function waitForApp(tries) {
    if (window.truxApp && window.truxApp.chats) { boot(); return; }
    if (tries > 200) { console.warn('TruX v3: the app bridge never appeared; v3 features are off.'); return; }
    setTimeout(function () { waitForApp(tries + 1); }, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { waitForApp(0); });
  else waitForApp(0);
}());

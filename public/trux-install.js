/* TruX Code app install: adds an "Install app" option to the sidebar so the app can be installed on a phone, tablet or
 * computer (manifest + service worker make it installable). Chrome, Edge and Samsung Internet give a real install
 * prompt; iPhone and iPad have no prompt, so the person is shown the Share > Add to Home Screen steps instead. */
(function () {
  'use strict';

  var deferred = null;
  var sheet = null;
  var button = null;

  function app() { return window.truxApp || {}; }
  function notify(m) { if (app().notify) app().notify(m); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* ignore */ }
    return window.navigator.standalone === true;
  }

  function isIos() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return /Mac/i.test(navigator.platform || '') && navigator.maxTouchPoints > 1; // iPadOS
  }

  function steps() {
    if (isIos()) {
      return ['Open TruX Code in Safari (not inside another app).', 'Tap the Share button in the toolbar.', 'Scroll down and tap Add to Home Screen, then tap Add.'];
    }
    if (/Android/i.test(navigator.userAgent || '')) {
      return ['Open the browser menu (the three dots).', 'Tap Install app or Add to Home screen.', 'Confirm. TruX Code now opens from your home screen like an app.'];
    }
    return ['Look for the install icon at the right end of the address bar, or open the browser menu.', 'Choose Install TruX Code.', 'It opens in its own window and shows in your app list.'];
  }

  function closeSheet() { if (sheet) sheet.hidden = true; document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') closeSheet(); }

  function showSteps() {
    if (!sheet) {
      sheet = el('div', 'modal-backdrop plugins-backdrop'); sheet.id = 'installModal'; sheet.hidden = true;
      var card = el('section', 'plugins-page install-sheet'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'installTitle');
      var top = el('header', 'plugins-top');
      var close = el('button', 'icon-button'); close.type = 'button'; close.setAttribute('aria-label', 'Close'); close.title = 'Close';
      close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>';
      close.addEventListener('click', closeSheet);
      var head = el('div'); var h2 = el('h2', '', 'Install TruX Code'); h2.id = 'installTitle'; head.appendChild(h2);
      head.appendChild(el('p', '', 'Add TruX Code to your device so it opens full screen, straight from your home screen.'));
      top.appendChild(close); top.appendChild(head);
      var scroll = el('div', 'plugins-body'); var body = el('div', 'cli-body'); body.id = 'installBody'; scroll.appendChild(body);
      card.appendChild(top); card.appendChild(scroll); sheet.appendChild(card);
      sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
      document.body.appendChild(sheet);
    }
    var body2 = sheet.querySelector('#installBody');
    body2.innerHTML = '';
    var c = el('section', 'cli-card');
    var ol = el('ol', 'install-steps');
    steps().forEach(function (s) { ol.appendChild(el('li', '', s)); });
    c.appendChild(ol);
    body2.appendChild(c);
    sheet.hidden = false;
    document.addEventListener('keydown', onKey);
  }

  // Runs the real install prompt when the browser offered one, otherwise explains how to install by hand.
  function run() {
    if (isStandalone()) { notify('TruX Code is already installed on this device.'); return; }
    if (deferred) {
      var p = deferred; deferred = null;
      p.prompt();
      if (p.userChoice && p.userChoice.then) {
        p.userChoice.then(function (c) { if (c && c.outcome === 'accepted') hide(); else deferred = p; }).catch(function () { /* ignore */ });
      }
      return;
    }
    showSteps();
  }

  function hide() { if (button) button.hidden = true; }

  function addButton() {
    if (button || isStandalone()) return;
    var anchor = document.getElementById('openTruxCli');
    if (!anchor || !anchor.parentNode) return;
    button = el('button', 'sidebar-item'); button.type = 'button'; button.id = 'installTruxApp'; button.title = 'Install TruX Code';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M12 8v6M9.5 11.8 12 14.3l2.5-2.5M10.5 17.5h3"/></svg><span class="item-label">Install app</span>';
    button.addEventListener('click', run);
    anchor.parentNode.insertBefore(button, anchor.nextSibling);
  }

  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', function () { deferred = null; hide(); notify('TruX Code was installed.'); });

  window.truxInstall = { run: run, isInstalled: isStandalone, canPrompt: function () { return Boolean(deferred); } };

  function boot() { addButton(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}());

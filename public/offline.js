/* TruX Code connection awareness.
 *
 * Registers the service worker and shows a small banner when the device goes offline. A reply that is already
 * being written keeps running on the server while the device is offline; the chat code (index.html) fetches it
 * when the connection is back. This file only tells the person what is going on.
 */
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* the app works without it */ });
    });
  }

  var banner = null;
  var hideTimer = 0;

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.className = 'tx-net-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.hidden = true;
    document.body.appendChild(banner);
    return banner;
  }

  function show(text, kind) {
    var node = ensureBanner();
    clearTimeout(hideTimer);
    node.textContent = text;
    node.dataset.kind = kind;
    node.hidden = false;
    requestAnimationFrame(function () { node.classList.add('on'); });
  }

  function hide(delay) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (!banner) return;
      banner.classList.remove('on');
      setTimeout(function () { if (!banner.classList.contains('on')) banner.hidden = true; }, 300);
    }, delay || 0);
  }

  function waiting() {
    return Boolean(window.truxApp && window.truxApp.isSending && window.truxApp.isSending());
  }

  window.addEventListener('offline', function () {
    show(waiting()
      ? 'You are offline. Your reply keeps being written and will appear when you reconnect.'
      : 'You are offline. Chats saved on this device are still available.', 'offline');
  });
  window.addEventListener('online', function () {
    show('Back online.', 'online');
    hide(2200);
  });
  document.addEventListener('DOMContentLoaded', function () {
    if (navigator.onLine === false) window.dispatchEvent(new Event('offline'));
  });
})();

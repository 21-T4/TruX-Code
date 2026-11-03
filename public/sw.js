/* TruX Code service worker: keeps the app shell available when the connection drops.
 *
 * It never touches /api/ or sign-in routes, so replies, chats and accounts always come from the server. It only
 * remembers the page and its own scripts and styles, so reopening the app offline still shows the interface and
 * the person's cached chats instead of a browser error page.
 */
'use strict';

var CACHE = 'trux-shell-v1';

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) { return caches.delete(key); })); })
      .then(function () { return self.clients.claim(); })
  );
});

function isAppAsset(url) {
  return /\.(?:js|css|png|svg|ico|webp|woff2?)$/i.test(url.pathname);
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(?:api|connectors|healthz)(?:\/|$)/.test(url.pathname)) return;

  // The page itself: the network first, so a deploy shows up immediately; the saved copy only when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put('/', copy); });
        }
        return response;
      }).catch(function () {
        return caches.match('/').then(function (saved) {
          return saved || new Response('TruX Code is offline. Reconnect and reload.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        });
      })
    );
    return;
  }

  // Scripts, styles and images: answer from the saved copy at once and refresh it in the background.
  if (isAppAsset(url)) {
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match(request).then(function (saved) {
          var fresh = fetch(request).then(function (response) {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(function () { return saved; });
          return saved || fresh;
        });
      })
    );
  }
});

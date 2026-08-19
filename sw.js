/* Financial Optionality — service worker
   Strategy:
   - App shell (index.html) is NETWORK-FIRST so a new GitHub Pages deploy is
     picked up immediately when online; the cached copy is only a fallback when
     offline. This deliberately avoids the "stale app on refresh" trap.
   - Static assets (icons, manifest) are CACHE-FIRST.
   Bump CACHE_VERSION whenever the cached shell/assets must be force-refreshed. */
const CACHE_VERSION = 'ff-v3';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (c) { return c.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE_VERSION; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (CDN) pass through

  // ONLY the app itself is the shell. Treating every navigation as the shell
  // meant that opening privacy.html (and now admin.html) overwrote the cached
  // ./index.html with that page, so an offline launch of the app served the
  // wrong document entirely.
  var isShell = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');

  // other same-origin pages: network-first, cached under their own key
  if (!isShell && req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  if (isShell) {
    // network-first: fresh deploy wins; cache is the offline fallback
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (m) { return m || caches.match('./'); });
      })
    );
    return;
  }

  // cache-first for same-origin static assets (icons, manifest)
  event.respondWith(
    caches.match(req).then(function (m) {
      return m || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        return res;
      });
    })
  );
});

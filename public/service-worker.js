/* EBCC Field Assistant — service worker
 * Offline-first app shell. Never caches /api/ or /.auth/ (identity + data must be live).
 * Bump CACHE_VERSION on any shell change to force clients to refresh.
 */
const CACHE_VERSION = 'ebcc-shell-v10';
const SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/app-sync.js',
  '/manifest.webmanifest',
  '/assets/inter/InterVariable.woff2',
  '/icons/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept auth or API — always go to network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.auth/')) return;

  // Navigations: network-first, fall back to cached shell (offline).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: stale-while-revalidate — serve from cache instantly for speed,
  // but always refresh the cached copy in the background so the next load is
  // current. Cached-forever assets never go permanently stale this way.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        if (url.origin === self.location.origin && res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

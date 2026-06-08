/* =============================================
   ANIWATCH — Service Worker
   Caches shell + static assets for offline/PWA
   ============================================= */

const CACHE     = 'aniwatch-v1';
const SHELL     = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&family=Inter:wght@300;400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js',
];

// Install — cache the shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - API / proxy / auth calls → network only (never cache streams)
// - Static assets → cache first, fallback to network
// - Pages → network first, fallback to cache
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API, proxy, or auth calls
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/auth/') ||
      url.hostname.includes('myanimelist') ||
      url.hostname.includes('jikan') ||
      url.hostname.includes('vid-cdn') ||
      url.hostname.includes('anizone')) {
    return;
  }

  // Static assets (css, js, fonts, images) — cache first
  if (e.request.destination === 'style' ||
      e.request.destination === 'script' ||
      e.request.destination === 'font' ||
      e.request.destination === 'image') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // HTML pages — network first, fallback to cached index.html
  e.respondWith(
    fetch(e.request).catch(() =>
      caches.match('/index.html')
    )
  );
});

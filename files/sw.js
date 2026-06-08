/* =============================================
   ANIWATCH — Service Worker
   Caches shell + static assets for offline/PWA
   ============================================= */

const CACHE     = 'aniwatch-v2';
const SHELL     = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&family=Inter:wght@300;400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js',
];

// Install — cache the shell
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Ignore anything that isn't http/https (chrome-extension, data, blob etc)
  if (!url.startsWith('http')) return;

  const parsed = new URL(url);

  // Never intercept API, proxy, auth, or external CDNs
  if (parsed.pathname.startsWith('/api/') ||
      parsed.pathname.startsWith('/auth/') ||
      parsed.hostname.includes('myanimelist') ||
      parsed.hostname.includes('jikan') ||
      parsed.hostname.includes('vid-cdn') ||
      parsed.hostname.includes('xin-cdn') ||
      parsed.hostname.includes('anizone')) {
    return;
  }

  // Static assets — cache first
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
            caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return res;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
    return;
  }

  // HTML — network first, fallback to shell
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match('/index.html'))
  );
});

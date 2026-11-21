/* My Voice Life service worker.
 *
 * What it caches: ONLY public, same-origin static files — the hashed app bundles under /assets/
 * (immutable), the icons, the manifest, and the offline page.
 * What it never touches: anything on another origin (Supabase = all user data and sign-in,
 * Stripe, OpenAI, fonts), any non-GET request, any request carrying an Authorization header, and
 * page navigations (always fetched from the network; the offline page is shown only if that fails).
 * So no private record, token or key can ever end up in this cache.
 *
 * Updates: a new version installs in the background and WAITS. The app shows "A new version is
 * ready — Reload"; only when the user accepts does it take over (never mid-recording by surprise).
 * BUILD is replaced at build time (vite.config.ts → mvl-sw-version) so every deploy is a new cache.
 */
const BUILD = '__MVL_BUILD__';
const STATIC_CACHE = `mvl-static-${BUILD}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
const PUBLIC_FILE = /^\/(icon[\w.-]*\.(png|svg)|apple-touch-icon\.png|manifest\.webmanifest|offline\.html|screenshots\/[\w.-]+\.png)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('mvl-') && key !== STATIC_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Supabase, Stripe, OpenAI, fonts: untouched
  if (req.headers.has('authorization')) return;             // defence in depth
  if (url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    // Network first, never cached. Offline → a static page that contains no user data.
    event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/')) { event.respondWith(cacheFirst(req)); return; }
  if (PUBLIC_FILE.test(url.pathname)) event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  }).catch(() => hit || Response.error());
  return hit || network;
}

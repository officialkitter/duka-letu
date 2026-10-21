/* POS service worker (hand-written, no build step).
 *
 * Responsibilities
 *  1. Make the app shell load with NO network: precache '/', runtime-cache
 *     hashed Next.js assets (cache-first) and same-origin static files.
 *  2. Never touch cross-origin traffic (API on Railway, Supabase, Stripe).
 *     Business data lives in IndexedDB (Dexie), not in this cache.
 *  3. Relay the Background Sync event to open tabs so they flush their outbox
 *     when the browser regains connectivity.
 *
 * Bump VERSION to force old shell caches to be dropped on the next activation.
 */
const VERSION = 'v1';
const SHELL_CACHE = `pos-shell-${VERSION}`;
const ASSET_CACHE = `pos-assets-${VERSION}`;
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith('pos-') && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API / Supabase / Stripe: network only

  // Page navigations: network first (fresh deploys), fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match(req)) || (await cache.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  // Content-hashed build output is immutable: cache first.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Other same-origin GETs (icons, manifest): stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => undefined);
      return hit || (await network) || Response.error();
    })(),
  );
});

// Background Sync (Chromium). Dexie + the auth session live in the page, so the
// worker's only job is to wake an open client. With no open client, the app
// flushes its outbox on next launch (first observed connectivity state).
self.addEventListener('sync', (event) => {
  if (event.tag !== 'pos-sync') return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'RUN_SYNC' });
    })(),
  );
});

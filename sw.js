/* Teo app shell service worker: offline support for the UI and static assets.
 * Normative PDFs are cached separately by the app (see normativeCache.ts). */
const VERSION = 'teo-shell-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const SHELL_ASSETS = ['./', './manifest.webmanifest', './favicon.svg', './icon-192.png'];

const cacheAsset = async (cache, asset) => {
  try {
    const response = await fetch(asset, { cache: 'reload' });
    if (response.ok) await cache.put(asset, response);
  } catch {
    // A missing optional asset must not break the installation.
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);

      await Promise.all(SHELL_ASSETS.map((asset) => cacheAsset(cache, asset)));

      // The entry JS/CSS filenames are hashed at build time. Read index.html and
      // precache them so the app can boot offline after the first visit.
      try {
        const response = await fetch('./index.html', { cache: 'reload' });
        if (response.ok) {
          const html = await response.clone().text();
          await cache.put('./index.html', response);

          const assets = new Set(
            [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]),
          );
          await Promise.all([...assets].map((asset) => cacheAsset(cache, asset)));
        }
      } catch {
        // The runtime cache still covers assets fetched after activation.
      }

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(
        keys
          // Only prune old shell versions; the normative cache is managed by
          // the app and must survive service worker updates.
          .filter((key) => key.startsWith('teo-shell-') && !key.startsWith(VERSION))
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // PDFs are handled by the app's own Cache API layer to avoid duplicate copies.
  if (url.pathname.toLowerCase().endsWith('.pdf')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(async () => (
          (await caches.match(request))
          || (await caches.match('./index.html'))
          || (await caches.match('./'))
          || new Response('Offline', { status: 503, statusText: 'Offline' })
        )),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached || new Response('Offline', { status: 503, statusText: 'Offline' }));

      return cached || network;
    }),
  );
});

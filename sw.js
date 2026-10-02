/**
 * Hand-written service worker — Trace gallery-kiosk offline mode
 * (`specs/ARCHITECTURE.md` → "Offline / PWA (kiosk mode)").
 *
 * Why hand-written instead of `@serwist/next` / `next-pwa`: both generate
 * their precache manifest from the Next build output in a way that fights
 * `output: 'export'` (no build-time server hook to inject a manifest into a
 * plain static export, and their webpack plugins assume a Next server
 * build). A small hand-rolled SW covers exactly what kiosk mode needs and
 * has zero dependency on the build pipeline.
 *
 * Strategy:
 *  - install: precache the "app shell" (the root document + manifest +
 *    icons) and use it as the offline fallback — everything else fills in
 *    opportunistically as the visitor browses on the first (networked) load.
 *  - runtime, same-origin GET only:
 *      - navigations/documents  -> stale-while-revalidate (serve cached
 *        instantly if present, refresh in the background; falls back to the
 *        cached shell if a page was never visited and the network is down)
 *      - everything else (JS/CSS chunks, RSC payloads, product images in
 *        /products, QR codes in /qr, self-hosted font files, etc.)
 *        -> cache-first (never re-fetched once cached — these are all
 *        content-hashed or immutable per exhibition run)
 *
 * This file is served as-is from `public/` (not processed by the Next
 * build), so it's plain ES2017 script-scope JS, not a module.
 *
 * To force every kiosk device to pick up a new build next time it has
 * network, bump CACHE_VERSION — the old cache is deleted on activate.
 */

const CACHE_VERSION = "v1";
const CACHE_NAME = `trace-cache-${CACHE_VERSION}`;
const CACHE_PREFIX = "trace-cache-";

// Derive the deploy base path from this script's own URL rather than trusting
// a build-time constant baked into this file — e.g. "/trace/" on GitHub
// Pages, "/" for a root-hosted build. Keeps this file identical across
// environments; RegisterSW.tsx registers it with `scope` set the same way.
const BASE_PATH = new URL(self.location.href).pathname.replace(/sw\.js$/, "");

// `trailingSlash: true` in next.config.ts means the root route itself is
// served at BASE_PATH (e.g. "/trace/") — that's both the app shell and the
// offline fallback for any document that was never cached.
const SHELL_URL = BASE_PATH;

const PRECACHE_URLS = [
  SHELL_URL,
  `${BASE_PATH}manifest.webmanifest`,
  `${BASE_PATH}icons/icon-192.png`,
  `${BASE_PATH}icons/icon-512.png`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      // Take over from any previous SW immediately rather than waiting for
      // every open tab to close — a kiosk iPad typically has one tab open
      // indefinitely, so the default behaviour would never update it.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Cache-first: serve from cache if present, else fetch + populate cache. */
async function cacheFirst(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  if (cached) return cached;

  const response = await fetch(event.request);
  if (response && response.ok) {
    event.waitUntil(cache.put(event.request, response.clone()));
  }
  return response;
}

/**
 * Stale-while-revalidate for documents: return the cached page instantly if
 * we have one (refreshing it in the background for next time), otherwise
 * wait on the network, and if that fails too (offline + never visited),
 * fall back to the cached app shell so the visitor never sees the browser's
 * own offline error page.
 */
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);

  const networkFetch = fetch(event.request)
    .then((response) => {
      if (response && response.ok) cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => null);

  event.waitUntil(networkFetch);

  if (cached) return cached;

  const network = await networkFetch;
  if (network) return network;

  const shell = await cache.match(SHELL_URL);
  if (shell) return shell;

  throw new Error("Trace SW: no cached document and network unavailable");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return; // let the browser handle non-GET as normal
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never intercept cross-origin requests

  const isDocument = request.mode === "navigate" || request.destination === "document";

  event.respondWith(isDocument ? staleWhileRevalidate(event) : cacheFirst(event));
});

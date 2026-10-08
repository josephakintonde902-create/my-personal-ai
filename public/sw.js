// v2: the name changes whenever the caching rules do, so that activating
// this worker throws away everything an earlier version stored.
const CACHE_NAME = "ari-static-v2";
const PRECACHE_URLS = [
  "/manifest.webmanifest",
  "/icons/ari-192.png",
  "/icons/ari-512.png",
  "/icons/ari-maskable-512.png",
  "/icons/ari-apple-touch.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("ari-static-") && key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/data/")) return;

  const isStaticAsset = url.pathname.startsWith("/_next/static/");
  const isPublicIcon = url.pathname.startsWith("/icons/");
  const isManifest = url.pathname === "/manifest.webmanifest";
  if (!isStaticAsset && !isPublicIcon && !isManifest) return;

  // Network first, cache as the fallback. The copy in the cache is only ever
  // used when the network cannot be reached, so the app's code can never be
  // older than the page that asked for it. (The first version answered from
  // the cache first, which left a browser running out-of-date JavaScript
  // whenever a file kept its name but changed its contents.) Repeat visits
  // stay fast regardless: the browser's own cache already keeps hashed
  // assets, which the server marks as immutable.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
    }),
  );
});

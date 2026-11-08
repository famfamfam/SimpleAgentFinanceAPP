const VERSION = "finance-dev";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/model.js",
  "/icons.js",
  "/release.js",
  "/db.js",
  "/chat-db.js",
  "/sync.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-180.png",
  "/icon-512.png",
];
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        cache.addAll(
          ASSETS.map((path) => new Request(path, { cache: "reload" })),
        ),
      ),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("finance-") && key !== VERSION)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    !ASSETS.includes(url.pathname)
  )
    return;
  event.respondWith(
    caches
      .open(VERSION)
      .then(
        async (cache) =>
          (await cache.match(url.pathname)) || fetch(event.request),
      ),
  );
});

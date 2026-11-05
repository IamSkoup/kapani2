const CACHE_PREFIX = "kapani-" + new URL(self.registration.scope).pathname + "-";
const CACHE = CACHE_PREFIX + "v22";
const FILES = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./js/publishing.js",
  "./js/education.js",
  "./js/notifications.js",
  "./assets/forest-road-small.webp",
  "./vendor/supabase.js",
  "./js/messenger.js",
  "./js/uploads.js",
  "./js/subscriptions.js",
  "./js/id.js",
  "./js/market.js",
  "./js/civic.js",
  "./js/business-panel.js",
  "./js/rentals.js",
  "./js/tasks.js",
  "./js/shop.js",
  "./js/map.js",
  "./js/taxi.js",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./js/recorder.js",
  "./js/api.js",
  "./js/ui.js",
  "./js/config.js",
  "./js/money.js",
  "./icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./manifest.webmanifest",
];
self.addEventListener("install", (e) =>
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (
    e.request.method !== "GET" ||
    u.origin !== location.origin ||
    !FILES.some(
      (p) => new URL(p, self.registration.scope).pathname === u.pathname,
    )
  )
    return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() =>
        caches
          .match(e.request)
          .then((r) => r ?? new Response("Нет подключения", { status: 503 })),
      ),
  );
});

// Uygulama kabuğunu önbelleğe alır; oran API'si önbelleğe alınmaz.
const CACHE = "nbav-v3";
const SHELL = ["./", "index.html", "main.js?v=3", "valuebet.js?v=3", "manifest.webmanifest", "sample_odds.json",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Ağ öncelikli: güncellemeler hemen gelir, çevrimdışıyken önbellek kullanılır.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: tarayıcının HTTP önbelleğini atlayıp sunucuya sorar (eski dosya kalmaz).
    fetch(e.request, { cache: "no-cache" }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match("index.html")))
  );
});

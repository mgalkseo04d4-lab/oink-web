// 앱 셸만 캐시(cache-first). MQTT(wss)·unpkg·Supabase 등 외부 요청은(다른 origin → 네트워크 전용) 건드리지 않는다.
const CACHE = "oink-shell-v36";
const SHELL = ["./", "index.html", "manual.html", "app.js", "logic.mjs", "sound.js", "style.css", "manifest.webmanifest",
  "img/pig_base.webp", "img/pig_happy.webp", "img/pig_angry.webp", "img/pig_base_lg.webp",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-512-maskable.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});

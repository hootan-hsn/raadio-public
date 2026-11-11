/* Raadio service worker: makes the app installable and opens offline.
   It never touches the live stream, the skip API or the studio API. */
const VERSION = "raadio-public-v3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/flamingo.svg",
  "./icons/flamingo-192.png"
];
// The 512 px icons aren't kept here: they're only needed when someone installs the app,
// and the phone fetches them itself then (saves ~150 KB on every first visit).
const NEVER = /\/(radio(-lite)?\.(mp3|opus)|skip|now-playing)(\?|$)|\/api\//;

// cache: "reload" skips the browser's own cache, so an update always stores the fresh files
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (NEVER.test(url.pathname)) return;

  // Page: network first (so updates show up), cached copy after 3 s or when offline
  if (req.mode === "navigate") {
    event.respondWith(
      Promise.race([fetch(req), timeout(3000)])
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put("./index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;   // (the fonts and three.js are the site's own files now)

  // Static files: answer from cache straight away, refresh it in the background
  event.respondWith(
    caches.open(VERSION).then((cache) =>
      cache.match(req).then((hit) => {
        const fresh = fetch(req).then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            cache.put(req, res.clone());
            // styles.css?v=<new> replaces styles.css?v=<old>: drop the old copies
            if (sameOrigin && url.search) {
              cache.keys().then((keys) => keys.forEach((k) => {
                const u = new URL(k.url);
                if (u.pathname === url.pathname && u.search !== url.search) cache.delete(k);
              }));
            }
          }
          return res;
        }).catch(() => hit);
        return hit || fresh;
      })
    )
  );
});

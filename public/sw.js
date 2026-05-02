// Service worker: web push + stale-while-revalidate page cache.
//
// Required for iOS 16.4+ Safari web-push to work once the PWA is
// "Added to Home Screen". Also caches the Dashboard / Feed / Settings
// HTML so a PWA cold-launch shows last-known content INSTANTLY (no
// skeleton, no waiting on the function), then quietly fetches fresh
// HTML in the background and updates the cache for the next launch.
//
// Bump CACHE_VERSION on any sw.js logic change to force a clean
// re-cache. Old caches are dropped on activate.

const CACHE_VERSION = "v1";
const PAGE_CACHE = `watcher-pages-${CACHE_VERSION}`;
// Only cache the three top-level pages. Playlist detail pages and
// API responses are deliberately NOT cached here — playlist pages
// don't benefit much (they're rarely the entry point), and API
// responses are already SWR'd at the client.
const CACHEABLE_PATHS = new Set(["/", "/feed", "/settings"]);

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any caches from older versions.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("watcher-") && k !== PAGE_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Stale-while-revalidate for top-level pages. Returns the cached
// response IMMEDIATELY (if any) and queues a background fetch to
// refresh the cache for the next visit. The browser sees "cache hit
// = instant" the way the user feels it.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(PAGE_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const networkPromise = fetch(request)
    .then((response) => {
      // Only cache successful HTML responses — never an auth redirect or
      // a 5xx. Cache the response with the path-only key so query strings
      // don't fragment the cache.
      if (response.ok) {
        const url = new URL(request.url);
        const cacheKey = new Request(url.origin + url.pathname, {
          method: "GET",
        });
        cache.put(cacheKey, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => cached);
  // If we have a cached response, return it immediately. Otherwise wait
  // for the network — first-ever visit must hit the wire.
  return cached || networkPromise;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Same-origin only — don't intercept Spotify CDN images, fonts, etc.
  if (url.origin !== self.location.origin) return;
  // Top-level page navigations only. Skip _next/* assets, /api/*, the
  // service worker itself, manifest, icon, etc.
  if (!CACHEABLE_PATHS.has(url.pathname)) return;
  // Skip Next.js RSC payload requests (they have ?_rsc=... or RSC: 1
  // header). Caching them would mismatch the page-version pairing.
  if (url.searchParams.has("_rsc")) return;
  if (request.headers.get("RSC") === "1") return;

  event.respondWith(staleWhileRevalidate(request));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Watcher", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Watcher";
  const options = {
    body: data.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: data.url || "/" },
    tag: data.playlistId || undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});

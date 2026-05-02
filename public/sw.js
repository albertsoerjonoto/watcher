// Service worker: web push only. Required for iOS 16.4+ Safari
// web-push to work once the PWA is "Added to Home Screen".
//
// We previously experimented with stale-while-revalidate caching of
// /, /feed, /settings — that's reverted because Next.js's hashed JS
// chunk URLs change on every deploy. A cached HTML response from an
// old build references chunks that 404 in the new build, breaking
// the page. Doing this safely needs Workbox-style precaching of every
// hashed chunk and a manifest update flow, which we don't want yet.
//
// Drops any leftover caches from the old version on activate.

const STALE_CACHES = ["watcher-pages-v1"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => STALE_CACHES.includes(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
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

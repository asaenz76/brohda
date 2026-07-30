// Tombstone — the offline-caching service worker that used to live here
// caused a real production incident: iOS suspends an installed home-screen
// app across app-switches rather than reloading it, so a client left open
// across a deploy kept running an old JS bundle whose Server Action IDs no
// longer matched the server, hanging login indefinitely. Independently,
// iOS Safari's service worker implementation adds real per-request latency
// just from having any active service worker in scope, regardless of what
// it actually caches — every click was slowed by that alone.
//
// This file's only job now is to self-destruct: any browser that already
// registered the old version fetches this on its next update check, wipes
// every cache, unregisters itself, and force-reloads any open client so
// the fix lands without waiting for the user to notice. app/providers.tsx
// no longer registers a service worker at all — see there for the
// matching client-side cleanup that doesn't wait on this update cycle.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => clients.forEach((client) => client.navigate(client.url))),
  );
});

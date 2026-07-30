// Offline support, deliberately scoped to static assets only. Everything
// with real-time consequences — every page, every RSC/data fetch, every
// server action (pool entries, wallet requests, all of it) — is always
// network-only, never served from cache. That's what keeps a late pool
// entry impossible even with offline support added: the entry form and
// every request it depends on either gets the live current state or fails
// outright, it never falls back to a cached "still open" view. The
// server's own atomic locks_at check in create_pool_entry is the real
// authority regardless — this is a second, independent guardrail, not a
// replacement for it.
const STATIC_CACHE = "brohda-static-v1";
const OFFLINE_URL = "/offline.html";
const OFFLINE_PRECACHE_URLS = [OFFLINE_URL, "/offline.css"];

// Next.js's own build output uses content-hashed filenames — a cached
// entry here can never be stale, since a new deploy simply produces
// different filenames. Everything else in this list is similarly static
// (rarely changes, and even when it does, being a version behind for a
// logo/icon is harmless in a way stale pool/wallet data never is).
function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/apple-icon.png" ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    OFFLINE_PRECACHE_URLS.includes(url.pathname)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(OFFLINE_PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Never intercept mutations (server actions are POSTs) — only GETs are
  // ever eligible for any handling below, so a request that changes
  // money/state always goes straight to the network exactly as if this
  // service worker didn't exist.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Cross-origin (Supabase, Sentry, etc.) is never touched either — this
  // service worker only ever has an opinion about this app's own origin.
  if (url.origin !== self.location.origin) return;

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Every page and every RSC/data request: network-only. A failed data
  // fetch just fails (surfaces as a normal error in the app), rather than
  // silently substituting a cached response — only a full-page navigation
  // gets a graceful fallback, and that fallback is a static "you're
  // offline" page, never stale app content.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
  }
});

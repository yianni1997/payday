// Payday offline support: keeps the app itself working with no connection.
// Only the app's own files are cached. Sync and Google requests always go straight to the network.
const CACHE = "payday-v25";
const SHELL = ["./", "index.html", "manifest.json", "pdf.min.js", "pdf.worker.min.js", "jszip.min.js", "icon-192.png", "icon-512.png",
  "firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  const fonts = /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (e.request.method !== "GET" || (url.origin !== self.location.origin && !fonts)) return;
  // Show the saved copy right away and refresh it in the background.
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, {ignoreSearch: true});
    const net = fetch(e.request).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

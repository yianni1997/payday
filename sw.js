// Payday offline support: keeps the app itself working with no connection.
// Only the app's own files are cached. Sync and Google requests always go straight to the network.
const CACHE = "payday-v49";
const SHELL = ["./", "index.html", "manifest.json", "pdf.min.js", "pdf.worker.min.js", "jszip.min.js", "icon-192.png", "icon-512.png",
  "firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js", "app.css", "app.js", "lblink.js", "plan.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== "payday-share").map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  // A zip shared to Payday from another app (Android share sheet): keep it, then open Payday to install it.
  if (e.request.method === "POST" && new URL(e.request.url).pathname.endsWith("/share-target")){
    e.respondWith((async () => {
      try{
        const form = await e.request.formData(), file = form.get("file");
        if (file && file.size){
          const cache = await caches.open("payday-share");
          await cache.put(new URL("./__shared__", self.registration.scope).href, new Response(file, {headers: {"x-name": encodeURIComponent(file.name || "shared.zip"), "content-type": file.type || "application/zip"}}));
        }
      }catch(_){}
      return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
    })());
    return;
  }
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

// Alerts from your Payday server ("3 new charges, $58.20"). Tapping one opens Review.
self.addEventListener("push", e => {
  let d = {}; try{ d = e.data ? e.data.json() : {}; }catch(_){ d = {body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title || "Payday", {body: d.body || "New charges are in Review.", icon: "icon-192.png", badge: "icon-192.png", tag: d.tag || "payday-pull", renotify: true, actions: d.actions || [], data: {url: d.url || "./?go=review", pick: d.pick || null}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const D = e.notification.data || {}, P = D.pick;
  // An action button (Personal, Gas…) opens Payday with that choice; Payday files and confirms the charge.
  const rel = e.action && P ? `./?go=pick&fund=${encodeURIComponent(e.action)}&d=${P.d}&a=${P.a}&n=${encodeURIComponent(P.n || "")}` : (D.url || "./?go=review");
  const url = new URL(rel, self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && "focus" in c){ c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});

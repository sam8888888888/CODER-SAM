// Prime Agent Hub — service worker (PWA basic offline shell)
// FIX (Aaron 15 Agu 2026): strategi NETWORK-FIRST untuk file inti (app.js/index.html/styles.css).
// Sebelumnya cache-first → sekali ter-cache, user tidak pernah dapat update sampai cache
// version di-bump manual → tombol Share (dan fix lain) tidak muncul untuk user lama.
// Sekarang: selalu coba server dulu; kalau offline, pakai cache.
const CACHE = 'pah-v58-cad15'; // v58 (Aaron 9 Sep 2026): cadangan-1 dewan juri + cadangan-5 benchmark
const CORE = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// F59 Push notification handler (9 Sep 2026): tampilkan notifikasi saat agent selesai.
self.addEventListener('push', (e) => {
  let data = { title: 'COBLAI', body: 'Agent selesai bekerja' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'COBLAI', {
      body: data.body || '',
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: data.url || '/admin' },
    })
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API selalu live
  const isCore = CORE.some((c) => {
    if (c === '/') return url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/admin';
    return url.pathname === c;
  });
  if (isCore) {
    // NETWORK-FIRST: update selalu kelihatan, cache hanya fallback offline
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/')))
    );
    return;
  }
  // Aset lain: cache-first
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('/')))
  );
});

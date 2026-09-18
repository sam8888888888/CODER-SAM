/**
 * Penangan `push` dan `notificationclick` untuk service worker COBLAI Coder
 * (Wave 10, butir 31 — notifikasi peramban).
 *
 * Berkas ini ada di folder `public/`, jadi Vite menyalinnya APA ADANYA ke `dist/`.
 * Service worker utama yang dibuat plugin PWA memuatnya lewat `workbox.importScripts`, lihat
 * `vite.config.ts` baris `workbox: { importScripts: ['push-sw.js'] }`. Karena itu berkas ini
 * ditulis sebagai SKRIP KLASIK: tanpa `import`, tanpa `export`, dan tanpa sintaks modul lain.
 *
 * Bentuk data yang dipakai server (`sendPushToUser`):
 *   { title, body, link, kind, at }
 */

/** Nilai cadangan bila data push kosong, bukan JSON, atau tidak lengkap. */
var CADANGAN = {
  title: 'COBLAI Coder',
  body: 'Ada pemberitahuan baru untuk Anda.',
  link: '/',
  kind: 'info',
  at: null,
};

/** Ambil isi notifikasi dari event push; selalu mengembalikan objek yang lengkap. */
function bacaIsi(event) {
  var data = null;
  if (event && event.data) {
    try {
      data = event.data.json();
    } catch (error) {
      // Bukan JSON: pakai teks mentah sebagai badan pesan supaya isinya tidak hilang.
      try {
        var teks = String(event.data.text() || '').trim();
        if (teks) data = { body: teks };
      } catch (kedua) {
        data = null;
      }
    }
  }
  if (!data || typeof data !== 'object') return CADANGAN;
  return {
    title: String(data.title || CADANGAN.title),
    body: String(data.body || CADANGAN.body),
    link: String(data.link || CADANGAN.link),
    kind: String(data.kind || CADANGAN.kind),
    at: data.at || null,
  };
}

/** Waktu tampil notifikasi; nilai yang tidak bisa dibaca diganti waktu sekarang. */
function waktuNotifikasi(at) {
  var parsed = at ? Date.parse(at) : NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

self.addEventListener('push', function (event) {
  var isi = bacaIsi(event);
  event.waitUntil(
    self.registration.showNotification(isi.title, {
      body: isi.body,
      // `tag` sama per jenis peristiwa, jadi pemberitahuan sejenis saling menggantikan.
      tag: 'coblai-' + isi.kind,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      timestamp: waktuNotifikasi(isi.at),
      data: { link: isi.link, kind: isi.kind },
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var link = (event.notification.data && event.notification.data.link) || '/';
  if (typeof link !== 'string' || link.indexOf('/') !== 0) link = '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (daftar) {
        // Utamakan jendela aplikasi yang sudah terbuka, lalu arahkan ke tautannya.
        for (var index = 0; index < daftar.length; index += 1) {
          var klien = daftar[index];
          if ('focus' in klien) {
            try {
              if ('navigate' in klien) return klien.navigate(link).then(function (hasil) { return (hasil || klien).focus(); });
            } catch (error) {
              return klien.focus();
            }
            return klien.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(link);
        return undefined;
      }),
  );
});

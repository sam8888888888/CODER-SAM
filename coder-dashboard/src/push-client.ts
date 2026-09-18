/**
 * Pembantu langganan notifikasi peramban (Wave 10, butir 31).
 *
 * Alur pemakaian oleh halaman:
 *  1. pushDidukung()            -> periksa kemampuan peramban sebelum menampilkan tombol apa pun.
 *  2. mintaIzinPush()           -> minta izin notifikasi; hasilnya 'granted' / 'default' / 'denied'.
 *  3. langgananPush(publicKey)  -> daftarkan peramban ini sebagai penerima push.
 *  4. batalkanLanggananPush()   -> hentikan langganan peramban ini.
 *
 * Service worker PWA sudah didaftarkan plugin PWA (lihat vite.config.ts), jadi berkas ini tidak
 * mendaftarkan service worker baru; ia hanya menunggu `navigator.serviceWorker.ready`.
 */

/** Dukungan peramban: notifikasi, service worker, dan PushManager harus ada semua. */
export function pushDidukung(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

/** Minta izin notifikasi. Izin yang sudah ada dikembalikan tanpa bertanya lagi. */
export async function mintaIzinPush(): Promise<NotificationPermission> {
  if (!pushDidukung()) return 'denied';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    // Peramban lama memakai panggilan berbasis callback; bila gagal, laporkan izin apa adanya.
    return Notification.permission;
  }
}

/**
 * Daftarkan peramban ini sebagai penerima push untuk kunci publik server.
 * Mengembalikan langganan yang sudah ada bila peramban sudah pernah berlangganan,
 * dan `null` bila peramban tidak mendukung, izin ditolak, atau data langganan tidak lengkap.
 */
export async function langgananPush(
  publicKey: string,
): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } } | null> {
  if (!pushDidukung()) return null;
  if (!String(publicKey ?? '').trim()) return null;
  const permission = await mintaIzinPush();
  if (permission !== 'granted') return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.pushManager) return null;
    const existing = await registration.pushManager.getSubscription();
    // Salin kunci ke tampilan baru di atas ArrayBuffer biasa; tipe `applicationServerKey`
    // (BufferSource) meminta buffer non-bersama, dan salinan kecil ini membuatnya pasti cocok.
    const kunci = urlBase64KeUint8(publicKey);
    const kunciServer = new Uint8Array(kunci.length);
    kunciServer.set(kunci);
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: kunciServer,
      }));
    const endpoint = String(subscription.endpoint ?? '');
    // `toJSON()` menyediakan kunci p256dh dan auth dalam bentuk base64url, sama seperti yang diminta server.
    const json = subscription.toJSON() as { keys?: Record<string, string> };
    const p256dh = String(json?.keys?.p256dh ?? '');
    const auth = String(json?.keys?.auth ?? '');
    if (!endpoint || !p256dh || !auth) return null;
    return { endpoint, keys: { p256dh, auth } };
  } catch {
    return null;
  }
}

/** Hentikan langganan push peramban ini. Mengembalikan true bila langganan benar-benar berakhir. */
export async function batalkanLanggananPush(): Promise<boolean> {
  if (!pushDidukung()) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.pushManager) return false;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return false;
    return await existing.unsubscribe();
  } catch {
    return false;
  }
}

/** Ubah kunci publik base64url dari server menjadi byte yang diterima `applicationServerKey`. */
export function urlBase64KeUint8(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (String(base64 ?? '').length % 4)) % 4);
  const normalized = (String(base64 ?? '') + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

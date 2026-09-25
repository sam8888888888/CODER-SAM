/**
 * Tombol instal aplikasi di HP + panduan iOS (Wave 11A, butir 55).
 *
 * Perilaku yang dijaga:
 *  1. Chrome/Edge Android mengirim peristiwa `beforeinstallprompt`. Peristiwa itu ditahan, lalu
 *     tombol "📲 Instal aplikasi di HP" memanggil `prompt()` miliknya. Hasil pilihan pengguna
 *     dilaporkan apa adanya.
 *  2. Bila aplikasi sudah berjalan dalam mode berdiri sendiri (`display-mode: standalone`) atau
 *     peramban tidak mendukung, tombol TIDAK ditampilkan, sehingga tidak ada tombol mati.
 *  3. Safari iOS tidak pernah mengirim `beforeinstallprompt`. Untuk itu ditampilkan panduan
 *     "Bagikan → Tambahkan ke Layar Utama" bila perangkatnya iOS.
 *  4. Untuk uji otomatis, penanda `window.__coblaiStandalone = true` dihormati sebagai "sudah
 *     berdiri sendiri" (hanya jalan pintas uji, bukan logika produksi).
 */
import { useEffect, useState } from 'react';

/** Peristiwa `beforeinstallprompt` belum ada di tipe DOM standar, jadi bentuknya ditulis sendiri. */
type InstallEvent = Event & { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome?: string; platform?: string }> };

type Props = {
  /** `banner` dipakai di Beranda, `settings` dipakai di halaman Pengaturan. */
  variant?: 'banner' | 'settings';
};

/** Apakah aplikasi sedang berjalan dalam mode berdiri sendiri (terpasang di layar utama). */
export function isStandaloneMode(): boolean {
  try {
    if ((window as unknown as { __coblaiStandalone?: boolean }).__coblaiStandalone === true) return true;
    if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
    return window.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    return false;
  }
}

/** Apakah peramban ini iOS (iPhone/iPad), tempat `beforeinstallprompt` tidak didukung. */
export function isIosBrowser(): boolean {
  try {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua);
    // iPadOS 13+ mengaku sebagai Macintosh; sentuhan multi-titik jadi penandanya.
    const ipadBaru = /Macintosh/.test(ua) && Number(navigator.maxTouchPoints) > 1;
    return ios || ipadBaru;
  } catch {
    return false;
  }
}

/**
 * Chrome/Edge sering mengirim `beforeinstallprompt` SEBELUM React melukis halaman. Kalau
 * pendengarnya baru dipasang saat komponen muncul, peristiwa itu hilang dan tombol instalasi tidak
 * pernah tampil. Karena itu pendengar dipasang sekali saat modul dimuat, peristiwanya ditahan di
 * sini, lalu komponen mengambilnya ketika muncul.
 */
let peristiwaDitahan: InstallEvent | null = null;
const pelanggan = new Set<(event: InstallEvent) => void>();
let pendengarDiniTerpasang = false;

function pasangPendengarDini(): void {
  if (pendengarDiniTerpasang || typeof window === 'undefined') return;
  pendengarDiniTerpasang = true;
  window.addEventListener('beforeinstallprompt', (raw: Event) => {
    const detail = raw as InstallEvent;
    // Peramban asli punya preventDefault; peristiwa buatan pada uji mungkin tidak punya.
    if (typeof detail.preventDefault === 'function') detail.preventDefault();
    peristiwaDitahan = detail;
    for (const kirim of pelanggan) kirim(detail);
  });
}
pasangPendengarDini();

export function InstallPrompt({ variant = 'settings' }: Props) {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [terpasang, setTerpasang] = useState(false);
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState(false);

  useEffect(() => {
    setStandalone(isStandaloneMode());
    setIos(isIosBrowser());
    setEvent(peristiwaDitahan ?? null); // peristiwa dini yang sudah ditahan modul ini
    const kirim = (detail: InstallEvent) => setEvent(detail);
    pelanggan.add(kirim);
    const selesai = () => { peristiwaDitahan = null; setTerpasang(true); setEvent(null); setPesan('Aplikasi sudah dipasang di perangkat ini.'); };
    window.addEventListener('appinstalled', selesai);
    return () => {
      pelanggan.delete(kirim);
      window.removeEventListener('appinstalled', selesai);
    };
  }, []);

  const bisaPasang = Boolean(event) && !standalone && !terpasang;
  // Tanpa dukungan peramban dan bukan iOS: jangan tampilkan apa pun (tidak ada tombol mati).
  if (!bisaPasang && !ios) return null;

  /** Menjalankan dialog instalasi bawaan peramban. */
  async function pasang(): Promise<void> {
    if (!event?.prompt) { setPesan('Peramban ini belum menyiapkan dialog instalasi. Coba buka lagi dari menu peramban.'); return; }
    setSibuk(true);
    setPesan('');
    try {
      await event.prompt();
      const pilihan = event.userChoice ? await event.userChoice : null;
      const hasil = String(pilihan?.outcome ?? '');
      setPesan(hasil === 'accepted'
        ? 'Instalasi disetujui. Ikon aplikasi akan muncul di layar utama.'
        : hasil === 'dismissed' ? 'Instalasi dibatalkan. Anda bisa mencoba lagi kapan saja.' : 'Dialog instalasi sudah ditutup.');
      if (hasil === 'accepted') { peristiwaDitahan = null; setEvent(null); }
    } catch (error) {
      setPesan(`Instalasi gagal dijalankan: ${error instanceof Error ? error.message : String(error)}.`);
    } finally {
      setSibuk(false);
    }
  }

  const isi = (
    <>
      <b>📲 Pasang aplikasi di HP</b>
      {bisaPasang && (
        <button type="button" className="primary" data-testid="install-button" disabled={sibuk} onClick={() => void pasang()}>
          {sibuk ? 'Membuka dialog…' : 'Instal aplikasi di HP'}
        </button>
      )}
      {ios && (
        <p className="install-guide" data-testid="install-ios-guide">
          Di iPhone/iPad (Safari): ketuk tombol <b>Bagikan</b>, lalu pilih <b>Tambahkan ke Layar Utama</b>. Safari tidak
          menyediakan tombol instalasi otomatis seperti Chrome.
        </p>
      )}
      {pesan && <p className="install-guide" data-testid="install-message">{pesan}</p>}
      {bisaPasang && <small>Tanpa unduh dari toko aplikasi: aplikasi memakai berkas yang sama seperti di peramban.</small>}
    </>
  );

  if (variant === 'banner') {
    return <div className="install-banner" data-testid="install-prompt" data-variant="banner">{isi}</div>;
  }
  return (
    <section className="settings-card" data-testid="install-prompt" data-variant="settings">
      <h3 className="settings-heading">Aplikasi di HP</h3>
      {isi}
    </section>
  );
}

export default InstallPrompt;

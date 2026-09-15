/**
 * Tombol ganti tema terang/gelap beserta helper tema.
 *
 * Berkas ini hanya menambah satu berkas baru; aturan CSS untuk
 * [data-theme="terang"] ditambahkan oleh App/induk di styles.css.
 */

/** Nama tema yang didukung aplikasi. */
export type ThemeName = 'gelap' | 'terang';

/** Kunci penyimpanan tema di localStorage. */
const KUNCI_TEMA = 'coblai.theme';

/** Tema bawaan saat belum ada pilihan tersimpan. */
const TEMA_BAWAAN: ThemeName = 'gelap';

/** Kelas Tailwind tombol kecil, selaras dengan tombol lain di aplikasi. */
const KELAS_TOMBOL =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400';

/** Cek apakah tema termasuk nilai yang dikenal. */
function temaDikenal(nilai: unknown): nilai is ThemeName {
  return nilai === 'gelap' || nilai === 'terang';
}

/** Ambil localStorage dengan aman; kamus peramban bisa memblokir aksesnya. */
function ambilPenyimpanan(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Mode privat atau izin diblokir: abaikan, tema tetap jalan tanpa simpanan.
    return null;
  }
}

/**
 * Baca tema tersimpan dari localStorage.
 * Mengembalikan 'gelap' bila belum ada, tidak dikenal, atau di luar peramban.
 */
export function bacaTema(): ThemeName {
  const penyimpanan = ambilPenyimpanan();
  if (!penyimpanan) return TEMA_BAWAAN;
  try {
    const tersimpan = penyimpanan.getItem(KUNCI_TEMA);
    return temaDikenal(tersimpan) ? tersimpan : TEMA_BAWAAN;
  } catch {
    return TEMA_BAWAAN;
  }
}

/**
 * Terapkan tema ke elemen <html> dan simpan pilihannya.
 * Aman dipanggil di luar peramban (tanpa `document`), jadi tidak akan gagal saat uji/SSR.
 */
export function terapkanTema(tema: ThemeName): void {
  const nilai: ThemeName = temaDikenal(tema) ? tema : TEMA_BAWAAN;

  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.theme = nilai;
  }

  const penyimpanan = ambilPenyimpanan();
  if (!penyimpanan) return;
  try {
    penyimpanan.setItem(KUNCI_TEMA, nilai);
  } catch {
    // Penyimpanan penuh atau diblokir: tema tetap diterapkan di halaman.
  }
}

/**
 * Tombol ganti tema. Komponen ini terkendali (controlled):
 * induk menyimpan state, komponen hanya melaporkan lewat onChange.
 */
export function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemeName;
  onChange: (tema: ThemeName) => void;
}): JSX.Element {
  const berikutnya: ThemeName = value === 'gelap' ? 'terang' : 'gelap';
  const label = berikutnya === 'terang' ? 'Terang' : 'Gelap';
  const judul = berikutnya === 'terang' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap';

  /** Terapkan tema lebih dulu, baru beri tahu induk agar state dan halaman tetap sinkron. */
  function gantiTema(): void {
    terapkanTema(berikutnya);
    onChange(berikutnya);
  }

  return (
    <button
      type="button"
      className={KELAS_TOMBOL}
      aria-label="Ganti tema"
      title={judul}
      onClick={gantiTema}
      onKeyDown={(event) => {
        // Tombol Escape melepas fokus tanpa mengubah tema.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    >
      {label}
    </button>
  );
}

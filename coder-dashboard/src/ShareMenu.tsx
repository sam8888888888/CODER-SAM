import { useEffect, useRef, useState } from 'react';

// Menu bagikan/ekspor untuk satu jawaban.
// Isi menu: salin teks, unduh berkas .md, dan cetak/simpan sebagai PDF.
type Props = {
  title?: string;
  content: string;
};

const LABEL_BAGIKAN = 'Bagikan';
const LABEL_SALIN = 'Salin teks';
const LABEL_UNDUH = 'Unduh .md';
const LABEL_CETAK = 'Cetak / PDF';
const STATUS_SALIN = 'Tersalin';
const STATUS_GAGAL_SALIN = 'Gagal menyalin';
const STATUS_GAGAL_POPUP = 'Popup diblokir peramban';
const STATUS_UNDUH = 'Berkas .md diunduh';
const STATUS_DURASI_MS = 2000;

// Ubah judul menjadi nama berkas yang aman: huruf kecil, spasi jadi '-', maksimal 48 karakter.
function slugJudul(title?: string): string {
  const dasar = (title ?? '').trim().toLowerCase();
  const bersih = dasar
    .replace(/[^a-z0-9\s-]/g, '') // buang karakter aneh
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return bersih.length > 0 ? bersih : 'jawaban';
}

// Bangun dokumen HTML sederhana untuk jendela cetak.
function htmlCetak(judul: string, isi: string): string {
  const judulAman = judul
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const isiAman = isi
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<title>${judulAman}</title>
<style>
body { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; margin: 24px; color: #0f172a; }
h1 { font-size: 18px; margin: 0 0 12px; }
pre { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; font-size: 13px; line-height: 1.6; margin: 0; }
</style>
</head>
<body>
<h1>${judulAman}</h1>
<pre>${isiAman}</pre>
</body>
</html>`;
}

export function ShareMenu({ title, content }: Props): JSX.Element {
  const [terbuka, setTerbuka] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');
  const wadahRef = useRef<HTMLDivElement | null>(null);
  const tombolRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);

  // Tampilkan status singkat, lalu hilangkan otomatis setelah 2 detik.
  function tampilkanStatus(teks: string): void {
    setStatus(teks);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setStatus('');
      timerRef.current = null;
    }, STATUS_DURASI_MS);
  }

  // Bersihkan timer saat komponen dilepas.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Tutup menu dengan tombol Escape atau klik di luar menu.
  useEffect(() => {
    if (!terbuka) return;

    function saatTombol(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setTerbuka(false);
        tombolRef.current?.focus();
      }
    }

    function saatKlikDiLuar(event: MouseEvent): void {
      const wadah = wadahRef.current;
      if (wadah && event.target instanceof Node && !wadah.contains(event.target)) {
        setTerbuka(false);
      }
    }

    document.addEventListener('keydown', saatTombol);
    document.addEventListener('mousedown', saatKlikDiLuar);
    return () => {
      document.removeEventListener('keydown', saatTombol);
      document.removeEventListener('mousedown', saatKlikDiLuar);
    };
  }, [terbuka]);

  // 1. Salin isi jawaban ke papan klip.
  async function salinTeks(): Promise<void> {
    setTerbuka(false);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        tampilkanStatus(STATUS_GAGAL_SALIN);
        return;
      }
      await navigator.clipboard.writeText(content);
      tampilkanStatus(STATUS_SALIN);
    } catch {
      // Clipboard ditolak peramban: beri tahu dengan tenang, jangan lempar error.
      tampilkanStatus(STATUS_GAGAL_SALIN);
    }
  }

  // 2. Unduh isi jawaban sebagai berkas markdown.
  function unduhMarkdown(): void {
    setTerbuka(false);
    try {
      const nama = `${slugJudul(title)}.md`;
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const tautan = document.createElement('a');
      tautan.href = url;
      tautan.download = nama;
      tautan.rel = 'noopener';
      document.body.appendChild(tautan);
      tautan.click();
      document.body.removeChild(tautan);
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      tampilkanStatus(STATUS_UNDUH);
    } catch {
      tampilkanStatus('Gagal mengunduh berkas');
    }
  }

  // 3. Buka jendela baru berisi teks jawaban, lalu panggil print().
  function cetakPdf(): void {
    setTerbuka(false);
    const judul = title && title.trim().length > 0 ? title.trim() : 'Jawaban';
    const jendela = window.open('', '_blank');
    if (!jendela) {
      tampilkanStatus(STATUS_GAGAL_POPUP);
      return;
    }
    try {
      jendela.document.open();
      jendela.document.write(htmlCetak(judul, content));
      jendela.document.close();
      jendela.focus();
      jendela.print();
    } catch {
      tampilkanStatus(STATUS_GAGAL_POPUP);
      try {
        jendela.close();
      } catch {
        // abaikan
      }
    }
  }

  return (
    <div className="relative inline-block" ref={wadahRef}>
      <button
        type="button"
        ref={tombolRef}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
        aria-label="Buka menu bagikan jawaban ini"
        aria-haspopup="menu"
        aria-expanded={terbuka}
        aria-controls="menu-bagikan"
        title={LABEL_BAGIKAN}
        onClick={() => setTerbuka((nilai) => !nilai)}
      >
        <span aria-hidden="true">&#8599;</span>
        <span>{LABEL_BAGIKAN}</span>
      </button>

      {terbuka && (
        <div
          id="menu-bagikan"
          role="menu"
          aria-label="Pilihan berbagi"
          className="absolute right-0 z-20 mt-2 flex w-44 flex-col gap-1 rounded-xl border border-slate-700 bg-slate-900/95 p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
            onClick={() => { void salinTeks(); }}
          >
            <span aria-hidden="true">&#128203;</span>
            <span>{LABEL_SALIN}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
            onClick={unduhMarkdown}
          >
            <span aria-hidden="true">&#11015;</span>
            <span>{LABEL_UNDUH}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
            onClick={cetakPdf}
          >
            <span aria-hidden="true">&#128424;</span>
            <span>{LABEL_CETAK}</span>
          </button>
        </div>
      )}

      <span role="status" aria-live="polite" className="ml-2 align-middle text-xs text-slate-400">
        {status}
      </span>
    </div>
  );
}

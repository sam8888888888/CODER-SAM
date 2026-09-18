/**
 * Halaman "Pencarian global" (Wave 10, butir 29).
 *
 * Satu kotak pencarian untuk seluruh isi yang boleh dibaca akun ini: proyek, percakapan, pesan,
 * artefak, basis pengetahuan, dan alur kerja. Hasil datang sudah dikelompokkan server, jadi halaman
 * ini hanya menampilkan kelompok, jumlah, dan cuplikan yang cocok.
 *
 * Dua catatan penting:
 * 1. Cuplikan (`snippet`) boleh memuat penanda dari server. Agar aman, `amankanSnippet()` lebih dahulu
 *    meloloskan semua tanda kurung, lalu HANYA menghidupkan kembali penanda `<mark>` dan `[kata]`.
 *    Jadi tidak ada tag lain dari isi pengguna yang ikut dirender.
 * 2. Panah navigasi bukan urusan halaman ini: bila induk memberi prop `onOpen`, tombol "Buka" memanggil
 *    prop itu; bila tidak, halaman hanya menampilkan tautan yang dilaporkan server.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Satu hasil pencarian seperti yang dikirim server (sebagian bidang opsional supaya tahan perubahan). */
export type SearchHit = {
  kind: string;
  id: string;
  title: string;
  subtitle?: string | null;
  snippet: string;
  workspaceId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  conversationId?: string | null;
  at?: string | null;
  link?: string | null;
};

/** Hasil dikelompokkan per jenis isi oleh server. */
export type SearchGroup = { kind: string; label?: string | null; hits: SearchHit[] };

/** Jawaban GET /v1/search. */
export type SearchResult = {
  query?: string;
  terms?: string[];
  limit?: number;
  total?: number;
  counts?: Record<string, number>;
  groups?: SearchGroup[];
  tookMs?: number;
  note?: string;
};

/** Jawaban GET /v1/search/status: jumlah pesan pada tabel asli versus yang sudah masuk indeks. */
export type SearchIndexStatus = {
  index?: { indexedMessages?: number; messages?: number };
  kinds?: string[];
  maxResults?: number;
  note?: string;
};

/** Laporan POST /v1/admin/search/reindex. */
export type ReindexReport = {
  before?: { indexedMessages?: number; messages?: number };
  indexed?: number;
  after?: { indexedMessages?: number; messages?: number };
};

/** Properti halaman: penangan buka hasil (opsional) dan status admin untuk tombol bangun ulang indeks. */
type Props = {
  onOpen?: (hit: SearchHit) => void;
  isAdmin?: boolean;
};

/** Label jenis isi dalam Bahasa Indonesia. */
const KIND_LABELS: Record<string, string> = {
  project: 'Proyek',
  conversation: 'Percakapan',
  message: 'Pesan',
  artifact: 'Artefak',
  knowledge: 'Pengetahuan',
  workflow: 'Workflow',
};

/** Urutan kelompok yang dipakai bila server tidak mengirim daftar kelompok. */
const KIND_ORDER = ['project', 'conversation', 'message', 'artifact', 'knowledge', 'workflow'];

/** Jumlah hasil per kelompok yang boleh diminta dari server. */
const LIMIT_OPTIONS = [5, 10, 20, 30];

/** Jeda sebelum pencarian otomatis berjalan setelah pengguna berhenti mengetik. */
const DEBOUNCE_MS = 400;

/** Kelas Tailwind dasar tombol sekunder. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas kecil untuk tombol "Buka" di daftar hasil. */
const BTN_SMALL = 'rounded-md border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-100 hover:bg-slate-700';
/** Kelas pembungkus kartu. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan informasi. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas kotak pesan sukses. */
const OK_BOX = 'rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas input gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas penanda kata yang cocok di dalam cuplikan. */
const MARK_CLASS = 'rounded bg-amber-400/20 px-0.5 text-amber-100';

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Format tanggal dan jam ke waktu Indonesia; nilai kosong ditulis sebagai tanda hubung. */
function dateTimeText(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Siapkan cuplikan untuk `dangerouslySetInnerHTML` dengan aman:
 * semua tanda kurung diloloskan lebih dahulu, lalu hanya penanda `<mark>` dari server dan pasangan
 * `[kata]` dari indeks teks penuh yang dihidupkan kembali sebagai penanda sorot.
 */
function amankanSnippet(raw: unknown): string {
  const escaped = String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/&lt;mark&gt;/g, '[[MARK]]')
    .replace(/&lt;\/mark&gt;/g, '[[/MARK]]')
    .replace(/\[([^\]]{1,120})\]/g, '[[MARK]]$1[[/MARK]]')
    .replace(/\[\[MARK\]\]/g, '<mark class="' + MARK_CLASS + '">')
    .replace(/\[\[\/MARK\]\]/g, '</mark>');
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/** Terjemahkan galat pencarian menjadi kalimat Indonesia yang ramah. */
function searchErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('SEARCH_QUERY_TOO_LONG')) return 'Kata kunci terlalu panjang. Maksimal 200 karakter.';
  if (code.includes('UNAUTHORIZED') || code.includes('UNAUTHENTICATED')) return 'Sesi Anda sudah berakhir. Silakan masuk lagi.';
  return 'Pencarian gagal dijalankan. Periksa sambungan Anda, lalu coba lagi.';
}

/** Terjemahkan galat pembangunan ulang indeks menjadi kalimat Indonesia yang ramah. */
function reindexErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('ADMIN_REQUIRED')) return 'Hanya admin platform yang boleh membangun ulang indeks pencarian.';
  if (code.includes('UNAUTHORIZED') || code.includes('UNAUTHENTICATED')) return 'Sesi Anda sudah berakhir. Silakan masuk lagi.';
  return 'Indeks gagal dibangun ulang. Coba lagi sebentar lagi.';
}

/** Nama kelompok yang ditampilkan; label server dipakai sebagai cadangan. */
function groupLabel(group: SearchGroup): string {
  return KIND_LABELS[group.kind] ?? String(group.label ?? group.kind ?? 'Hasil');
}

/** Jumlah hasil satu kelompok, memakai hitungan server bila ada. */
function groupCount(group: SearchGroup, counts: Record<string, number> | undefined): number {
  const fromServer = counts ? num(counts[group.kind]) : 0;
  return fromServer || (group.hits ?? []).length;
}

/** Keterangan kecil di bawah judul hasil: nama proyek dan waktu, memakai `subtitle` server bila ada. */
function hitSubtitle(hit: SearchHit): string {
  const parts: string[] = [];
  if (hit.subtitle) parts.push(String(hit.subtitle));
  else if (hit.projectName) parts.push('Proyek ' + String(hit.projectName));
  if (hit.at) parts.push(dateTimeText(hit.at));
  return parts.join(' - ');
}

/**
 * Halaman pencarian global: kotak cari, saringan jenis isi, keadaan indeks, dan hasil per kelompok.
 */
export function SearchPanel({ onOpen, isAdmin }: Props) {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [limit, setLimit] = useState(10);

  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [reindexBusy, setReindexBusy] = useState(false);
  const [notice, setNotice] = useState('');

  /** Panggil pencarian untuk satu kata kunci. Kata di bawah dua huruf tidak dikirim ke server. */
  const cari = useCallback(
    async (kata: string): Promise<void> => {
      const bersih = kata.trim();
      if (bersih.length < 2) {
        setResult(null);
        setError('');
        return;
      }
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ q: bersih, limit: String(limit) });
        if (kinds.length) params.set('kinds', kinds.join(','));
        const data = await api.get<SearchResult>('/v1/search?' + params.toString());
        setResult(data);
      } catch (galat) {
        setResult(null);
        setError(searchErrorMessage(galat));
      } finally {
        setLoading(false);
      }
    },
    [kinds, limit],
  );

  /** Muat keadaan indeks: berapa pesan yang sudah masuk indeks dibanding seluruh pesan. */
  const muatStatus = useCallback(async (): Promise<void> => {
    setStatusError('');
    try {
      const data = await api.get<SearchIndexStatus>('/v1/search/status');
      setStatus(data);
    } catch (galat) {
      setStatus(null);
      setStatusError(searchErrorMessage(galat));
    }
  }, []);

  // Cari otomatis 400 ms setelah pengguna berhenti mengetik, dan setiap saringan berubah.
  useEffect(() => {
    const bersih = query.trim();
    if (bersih.length < 2) {
      setResult(null);
      setError('');
      return;
    }
    const timer = setTimeout(() => {
      void cari(bersih);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, cari]);

  // Keadaan indeks dimuat sekali saat halaman dibuka.
  useEffect(() => {
    void muatStatus();
  }, [muatStatus]);

  /** Jalankan sekarang tanpa menunggu jeda; dipakai tombol "Cari" dan tombol Enter. */
  function cariSekarang(): void {
    void cari(query);
  }

  /** Tambah atau buang satu jenis isi dari saringan. */
  function toggleKind(kind: string): void {
    setKinds((lama) => (lama.includes(kind) ? lama.filter((item) => item !== kind) : [...lama, kind]));
  }

  /** Bangun ulang indeks pesan; hanya admin platform yang diizinkan server. */
  async function bangunUlangIndeks(): Promise<void> {
    setReindexBusy(true);
    setNotice('');
    setError('');
    try {
      const laporan = await api.send<ReindexReport>('/v1/admin/search/reindex', 'POST');
      setNotice(
        'Indeks dibangun ulang: ' +
          numberText(laporan?.indexed) +
          ' pesan dimasukkan. Sesudahnya ' +
          numberText(laporan?.after?.indexedMessages) +
          ' dari ' +
          numberText(laporan?.after?.messages) +
          ' pesan terindeks.',
      );
      await muatStatus();
      if (query.trim().length >= 2) await cari(query);
    } catch (galat) {
      setError(reindexErrorMessage(galat));
    } finally {
      setReindexBusy(false);
    }
  }

  /** Kelompok hasil sesuai urutan yang dikenal; kelompok tak dikenal tetap ditampilkan di akhir. */
  const groups: SearchGroup[] = (() => {
    const daftar = result?.groups ?? [];
    const dikenal = daftar.filter((group) => KIND_ORDER.includes(group.kind));
    const sisa = daftar.filter((group) => !KIND_ORDER.includes(group.kind));
    return [...dikenal, ...sisa];
  })();

  const total = num(result?.total);
  const kataPendek = query.trim().length > 0 && query.trim().length < 2;
  const indexed = num(status?.index?.indexedMessages);
  const pesanTotal = num(status?.index?.messages);
  const belumTerindeks = Math.max(0, pesanTotal - indexed);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-100">Pencarian global</h1>
        <p className="text-sm text-slate-400">
          Cari proyek, percakapan, pesan, artefak, pengetahuan, dan workflow yang boleh Anda buka. Hasil
          dikelompokkan per jenis isi.
        </p>
      </header>

      <div className={CARD}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className={FIELD + ' flex-1'}
            type="search"
            value={query}
            placeholder="Tulis kata kunci, minimal 2 huruf"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                cariSekarang();
              }
            }}
          />
          <button className={BTN_PRIMARY} type="button" onClick={cariSekarang} disabled={loading || query.trim().length < 2}>
            {loading ? 'Mencari...' : 'Cari'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-slate-300">
          <span className={LABEL}>Jenis isi</span>
          {KIND_ORDER.map((kind) => (
            <label key={kind} className="inline-flex items-center gap-1">
              <input type="checkbox" checked={kinds.includes(kind)} onChange={() => toggleKind(kind)} />
              <span>{KIND_LABELS[kind]}</span>
            </label>
          ))}
          <label className="inline-flex items-center gap-2">
            <span className={LABEL}>Hasil per kelompok</span>
            <select
              className={FIELD}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value) || 10)}
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Kosongkan centang untuk mencari di semua jenis isi. Pencarian berjalan otomatis 0,4 detik setelah
          Anda berhenti mengetik; tombol Enter juga menjalankannya.
        </p>
      </div>

      <div className={CARD}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className={LABEL}>Keadaan indeks pesan</div>
            <p className="text-sm text-slate-200">
              {indexed} dari {pesanTotal} pesan terindeks
              {belumTerindeks > 0 ? ' (' + numberText(belumTerindeks) + ' pesan belum masuk indeks)' : ' (seluruhnya terindeks)'}
            </p>
            {statusError ? <p className="text-xs text-rose-300">{statusError}</p> : null}
            {status?.note ? <p className="text-xs text-slate-400">{status.note}</p> : null}
          </div>
          {isAdmin === false ? (
            <p className="max-w-sm text-xs text-slate-400">
              Hanya admin platform yang boleh membangun ulang indeks pencarian.
            </p>
          ) : (
            <button className={BTN} type="button" onClick={() => void bangunUlangIndeks()} disabled={reindexBusy}>
              {reindexBusy ? 'Membangun ulang...' : 'Bangun ulang indeks'}
            </button>
          )}
        </div>
      </div>

      {error ? <div className={ERROR_BOX}>{error}</div> : null}
      {notice ? <div className={OK_BOX}>{notice}</div> : null}
      {kataPendek ? <div className={BANNER}>Tulis minimal 2 huruf.</div> : null}

      {!kataPendek && result ? (
        <div className={CARD}>
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
            <span className="font-semibold text-slate-100">{numberText(total)} hasil</span>
            <span>untuk "{String(result.query ?? query.trim())}"</span>
            <span className="text-slate-400">selesai dalam {numberText(result.tookMs)} ms</span>
          </div>
          {result.note ? <p className="mt-1 text-xs text-slate-400">{result.note}</p> : null}
        </div>
      ) : null}

      {!loading && !kataPendek && result && groups.length === 0 ? (
        <div className={BANNER}>Tidak ada hasil untuk kata itu.</div>
      ) : null}

      {groups.map((group) => (
        <section key={group.kind} className={CARD}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-100">{groupLabel(group)}</h2>
            <span className="text-xs text-slate-400">{numberText(groupCount(group, result?.counts))} hasil</span>
          </div>
          <ul className="space-y-3">
            {(group.hits ?? []).map((hit) => (
              <li key={group.kind + '-' + hit.id} className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="truncate font-medium text-slate-100" title={hit.title}>
                      {hit.title || '(tanpa judul)'}
                    </div>
                    {hitSubtitle(hit) ? <div className="text-xs text-slate-400">{hitSubtitle(hit)}</div> : null}
                  </div>
                  {onOpen ? (
                    <button className={BTN_SMALL} type="button" onClick={() => onOpen(hit)}>
                      Buka
                    </button>
                  ) : hit.link ? (
                    <span className="text-xs text-slate-500">{String(hit.link)}</span>
                  ) : null}
                </div>
                {hit.snippet ? (
                  <p
                    className="mt-2 text-sm text-slate-300"
                    dangerouslySetInnerHTML={{ __html: amankanSnippet(hit.snippet) }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default SearchPanel;

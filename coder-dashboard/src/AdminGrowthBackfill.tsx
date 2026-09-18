/**
 * Halaman "Pelengkapan data pertumbuhan" (admin platform) — Wave 10, butir 25 + 32C.
 *
 * Tujuan halaman ini:
 * 1. Menampilkan pratinjau apa yang AKAN ditulis ke log peristiwa pertumbuhan, per tabel sumber.
 * 2. Menjalankan pelengkapan (backfill) hanya setelah admin memeriksa pratinjau.
 * 3. Menunjukkan bahwa sebagian peristiwa TIDAK bisa dipulihkan, dengan alasan asli dari server.
 *
 * Arti angka yang dipakai halaman ini:
 * - candidates     = baris nyata di tabel sumber yang mungkin menjadi peristiwa.
 * - alreadyRecorded= baris yang sudah ada di log peristiwa, jadi tidak ditulis ulang.
 * - toInsert       = baris yang akan ditulis bila pelengkapan diterapkan.
 *
 * Semua panggilan jaringan lewat objek `api` dari './api' — tidak ada fetch langsung di sini.
 */

import { useCallback, useState } from 'react';
import { api } from './api';

/** Satu baris rencana pelengkapan per peristiwa. */
type PlanRow = {
  event: string;
  source: string;
  candidates: number;
  alreadyRecorded: number;
  toInsert: number;
};

/** Peristiwa yang tidak pernah tersimpan, jadi tidak bisa dibuat ulang. */
type ExcludedRow = { event: string; reason: string };

/** Ringkasan asal baris log: dicatat langsung (live) atau hasil pelengkapan (backfill). */
type SourceRow = { source: string; events: number; first: string | null; last: string | null };

/** Jawaban GET /v1/admin/growth/backfill. */
type PreviewResponse = {
  plan?: { rows?: PlanRow[]; excluded?: ExcludedRow[]; totalCandidates?: number } | null;
  sources?: SourceRow[] | null;
  recorded?: { totals?: { eventsRecorded?: number } | null } | null;
};

/** Jawaban POST /v1/admin/growth/backfill { apply: true }. */
type ApplyResponse = {
  report?: {
    dryRun?: boolean;
    generatedAt?: string;
    inserted?: number;
    skipped?: number;
    totalCandidates?: number;
    note?: string;
  } | null;
  sources?: SourceRow[] | null;
  note?: string;
};

/** Kalimat khusus bila akun yang membuka halaman ini bukan admin platform. */
const NO_ACCESS_MESSAGE = 'Halaman ini hanya untuk admin platform.';

/** Kelas Tailwind dasar tombol sekunder, sama dengan halaman admin lain. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi yang mengubah data. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas pembungkus kartu isi. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan untuk pemberitahuan. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas kotak peringatan untuk aksi yang menulis data. */
const WARN_BOX = 'rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
/** Kelas sel badan tabel. */
const TD = 'border-b border-slate-700/60 px-3 py-2';
/** Kelas lencana kecil untuk nama peristiwa dan asal baris. */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Warna lencana asal baris: live hijau, backfill violet, lain-lain abu. */
const CHIP_SOURCE: Record<string, string> = {
  live: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
  backfill: 'border-violet-500/40 bg-violet-500/15 text-violet-100',
};
/** Lencana abu-abu netral untuk nilai yang tidak dikenal. */
const CHIP_OFF = 'border-slate-600 bg-slate-700/40 text-slate-200';
/** Lencana nama peristiwa. */
const CHIP_EVENT = 'border-sky-500/40 bg-sky-500/15 text-sky-100';

/** Ubah nilai apa pun menjadi angka aman supaya tabel tidak pernah menampilkan NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ubah nilai apa pun menjadi teks yang sudah dipangkas. */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Format tanggal dan jam; nilai kosong ditulis sebagai tanda hubung. */
function dateTimeText(value: unknown): string {
  const raw = text(value);
  if (!raw) return '-';
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/** Apakah galat ini berarti pengguna bukan admin platform (403 / ADMIN_REQUIRED). */
function isAdminRequired(error: unknown): boolean {
  const code = errorCode(error);
  return code.includes('ADMIN_REQUIRED') || code.includes('FORBIDDEN') || /\b403\b/.test(code);
}

/** Terjemahkan galat pelengkapan menjadi kalimat Indonesia yang bisa dibaca pemakai. */
function backfillErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (isAdminRequired(error)) return NO_ACCESS_MESSAGE;
  if (code.includes('401') || code.includes('UNAUTHORIZED') || code.includes('UNAUTHENTICATED')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk lagi, lalu buka halaman ini.';
  }
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  }
  if (code.includes('RATE_LIMIT') || code.includes('429')) {
    return 'Terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi.';
  }
  return 'Permintaan pelengkapan gagal diproses server. Coba lagi sebentar lagi.';
}

/** Sebutan asal baris log dalam Bahasa Indonesia; nilai tak dikenal ditampilkan apa adanya. */
function sourceLabel(value: unknown): string {
  const code = text(value).toLowerCase();
  if (code === 'live') return 'tercatat langsung';
  if (code === 'backfill') return 'hasil pelengkapan';
  return code || 'tidak diketahui';
}

/** Kelas lencana sesuai asal baris log. */
function sourceChipClass(value: unknown): string {
  const code = text(value).toLowerCase();
  return CHIP + ' ' + (CHIP_SOURCE[code] ?? CHIP_OFF);
}

/** Satu kartu angka ringkas pada ringkasan. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={CARD}>
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{value}</p>
    </div>
  );
}

/**
 * Halaman pelengkapan data pertumbuhan.
 *
 * Halaman TIDAK memanggil API saat dibuka: pratinjau baru diambil setelah admin menekan
 * "Lihat pratinjau", sehingga permintaan tidak pernah berulang tanpa henti (misalnya saat
 * akun bukan admin platform).
 *
 * Properti halaman: tidak ada. Status admin dibaca dari jawaban server (403 ADMIN_REQUIRED).
 */
export function AdminGrowthBackfill() {
  // Pratinjau dari server; null berarti belum dimuat.
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');

  // Laporan hasil pelengkapan; null berarti belum pernah dijalankan.
  const [applied, setApplied] = useState<ApplyResponse | null>(null);

  // Sumber asal baris log terakhir yang diketahui (dari pratinjau atau dari hasil penerapan).
  const [sources, setSources] = useState<SourceRow[]>([]);

  // Persetujuan admin: kotak centang wajib sebelum aksi yang menulis data.
  const [acknowledged, setAcknowledged] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [notice, setNotice] = useState('');

  // Bila server menolak karena bukan admin, halaman berhenti memanggil API dan hanya menampilkan pesan.
  const [blocked, setBlocked] = useState(false);

  /** Bersihkan hasil lama lalu ambil pratinjau baru dari server. */
  const loadPreview = useCallback(async (): Promise<void> => {
    if (blocked) return;
    setPreviewBusy(true);
    setPreviewError('');
    setNotice('');
    try {
      const data = await api.get<PreviewResponse>('/v1/admin/growth/backfill');
      setPreview(data ?? null);
      setSources(Array.isArray(data?.sources) ? data.sources : []);
      // Kotak centang direset: pratinjau baru harus diperiksa ulang sebelum menerapkan.
      setAcknowledged(false);
    } catch (error) {
      // Jangan tampilkan rencana lama seolah masih sah.
      setPreview(null);
      const message = backfillErrorMessage(error);
      setPreviewError(message);
      if (isAdminRequired(error)) setBlocked(true);
    } finally {
      setPreviewBusy(false);
    }
  }, [blocked]);

  /** Jalankan pelengkapan (menulis baris), lalu muat ulang pratinjau supaya angka segar. */
  const runBackfill = useCallback(async (): Promise<void> => {
    if (blocked || !preview || !acknowledged) return;
    setApplyBusy(true);
    setApplyError('');
    setNotice('');
    try {
      const result = await api.send<ApplyResponse>('/v1/admin/growth/backfill', 'POST', { apply: true });
      setApplied(result ?? null);
      if (Array.isArray(result?.sources)) setSources(result.sources);
      const inserted = num(result?.report?.inserted);
      setNotice(
        inserted > 0
          ? 'Pelengkapan selesai: ' + numberText(inserted) + ' baris baru ditulis ke log peristiwa.'
          : 'Pelengkapan selesai: tidak ada baris baru yang perlu ditulis.',
      );
      await loadPreview();
    } catch (error) {
      const message = backfillErrorMessage(error);
      setApplyError(message);
      if (isAdminRequired(error)) setBlocked(true);
    } finally {
      setApplyBusy(false);
    }
  }, [blocked, preview, acknowledged, loadPreview]);

  // Tanpa hak admin: cukup kartu informasi, tanpa satu pun panggilan API lanjutan.
  if (blocked) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
        <h2 className="mb-2 text-base font-semibold text-slate-100">Pelengkapan data pertumbuhan</h2>
        <p className={ERROR_BOX}>{previewError || NO_ACCESS_MESSAGE}</p>
        <p className="mt-2">
          Halaman ini hanya menampilkan rencana dan menjalankan pelengkapan untuk admin platform. Masuk
          kembali dengan akun admin bila Anda berhak.
        </p>
      </section>
    );
  }

  const planRows = Array.isArray(preview?.plan?.rows) ? preview!.plan!.rows : [];
  const excluded = Array.isArray(preview?.plan?.excluded) ? preview!.plan!.excluded : [];
  const totalCandidates = preview?.plan?.totalCandidates;
  const eventsRecorded = preview?.recorded?.totals?.eventsRecorded;

  const report = applied?.report ?? null;
  // Tombol pelengkapan hanya aktif bila pratinjau sudah dimuat dan admin sudah memeriksanya.
  const canApply = preview !== null && acknowledged && !applyBusy && !previewBusy;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <h2 className="mb-2 text-base font-semibold text-slate-100">Pelengkapan data pertumbuhan</h2>
      <p className="mb-3">
        Halaman ini menyusun ulang peristiwa pertumbuhan dari tabel aslinya. Pratinjau tidak menulis apa
        pun; hanya tombol pelengkapan yang menulis, dan hanya untuk baris yang belum ada di log.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} onClick={() => void loadPreview()} disabled={previewBusy}>
          {previewBusy ? 'Memuat pratinjau...' : 'Lihat pratinjau'}
        </button>
        <span className="text-xs text-slate-400">
          Tidak ada permintaan otomatis: pratinjau diambil hanya saat Anda menekan tombol ini.
        </span>
      </div>

      {previewError && <p className={ERROR_BOX + ' mb-3'}>{previewError}</p>}
      {notice && <p className={BANNER + ' mb-3'}>{notice}</p>}

      {preview === null ? (
        <p className={BANNER}>Pratinjau belum dimuat. Tekan "Lihat pratinjau" untuk melihat rencananya.</p>
      ) : (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <StatCard label="Total kandidat" value={numberText(totalCandidates)} />
            <StatCard label="Akan ditulis" value={numberText(planRows.reduce((sum, row) => sum + num(row?.toInsert), 0))} />
            <StatCard label="Peristiwa sudah tercatat" value={numberText(eventsRecorded)} />
          </div>

          <p className="mb-2 text-xs text-slate-400">
            candidates = baris nyata di tabel sumber yang mungkin menjadi peristiwa. alreadyRecorded = baris
            yang sudah ada di log, jadi tidak ditulis ulang. toInsert = baris yang akan ditulis bila
            pelengkapan diterapkan.
          </p>

          <div className={CARD + ' mb-3'}>
            <p className="mb-2 font-semibold text-slate-100">Rencana per peristiwa</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className={TH}>Peristiwa</th>
                    <th className={TH}>Tabel sumber</th>
                    <th className={TH}>candidates</th>
                    <th className={TH}>alreadyRecorded</th>
                    <th className={TH}>toInsert</th>
                  </tr>
                </thead>
                <tbody>
                  {planRows.length === 0 ? (
                    <tr>
                      <td className={TD} colSpan={5}>
                        Server tidak mengirim baris rencana.
                      </td>
                    </tr>
                  ) : (
                    planRows.map((row, index) => (
                      <tr key={String(row?.event ?? '') + '-' + String(index)}>
                        <td className={TD}>
                          <span className={CHIP + ' ' + CHIP_EVENT}>{text(row?.event) || 'tidak diketahui'}</span>
                        </td>
                        <td className={TD}>{text(row?.source) || '-'}</td>
                        <td className={TD}>{numberText(row?.candidates)}</td>
                        <td className={TD}>{numberText(row?.alreadyRecorded)}</td>
                        <td className={TD + ' font-semibold text-slate-100'}>{numberText(row?.toInsert)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className={WARN_BOX + ' mb-3'}>
            <p className="font-semibold">Peristiwa yang tidak bisa dipulihkan</p>
            <p className="mt-1">
              Baris untuk peristiwa di bawah ini TIDAK dibuat oleh pelengkapan. Peristiwa itu memang tidak
              pernah menyimpan waktu atau baris apa pun, jadi angka lamanya tidak bisa dikembalikan dan tidak
              ditebak. Alasan berikut ditulis apa adanya oleh server:
            </p>
            {excluded.length === 0 ? (
              <p className="mt-2">Tidak ada peristiwa yang dikecualikan.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {excluded.map((item, index) => (
                  <li key={String(item?.event ?? '') + '-' + String(index)}>
                    <span className={CHIP + ' ' + CHIP_EVENT}>{text(item?.event) || 'tidak diketahui'}</span>{' '}
                    <span className="text-amber-100">{text(item?.reason) || 'server tidak memberi alasan'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={CARD + ' mb-3'}>
            <p className="mb-2 font-semibold text-slate-100">Sumber baris log peristiwa</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className={TH}>Sumber</th>
                    <th className={TH}>Jumlah peristiwa</th>
                    <th className={TH}>Paling awal</th>
                    <th className={TH}>Paling akhir</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.length === 0 ? (
                    <tr>
                      <td className={TD} colSpan={4}>
                        Server tidak mengirim ringkasan sumber.
                      </td>
                    </tr>
                  ) : (
                    sources.map((row, index) => (
                      <tr key={String(row?.source ?? '') + '-' + String(index)}>
                        <td className={TD}>
                          <span className={sourceChipClass(row?.source)}>{sourceLabel(row?.source)}</span>
                        </td>
                        <td className={TD}>{numberText(row?.events)}</td>
                        <td className={TD}>{dateTimeText(row?.first)}</td>
                        <td className={TD}>{dateTimeText(row?.last)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Baris "tercatat langsung" adalah peristiwa yang dicatat saat kejadiannya berlangsung; baris
              "hasil pelengkapan" adalah baris yang ditulis halaman ini dari tabel aslinya.
            </p>
          </div>

          <div className={WARN_BOX + ' mb-3'}>
            <label className="flex items-start gap-2">
              <input
                id="growth-backfill-ack"
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                Saya sudah memeriksa pratinjau. Saya paham pelengkapan hanya menambah baris yang belum ada
                dan tidak mengubah atau menghapus baris lama.
              </span>
            </label>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={() => void runBackfill()} disabled={!canApply}>
              {applyBusy ? 'Menjalankan pelengkapan...' : 'Jalankan pelengkapan'}
            </button>
            <span className="text-xs text-slate-400">
              {acknowledged
                ? 'Tombol aktif: pelengkapan akan menulis baris yang belum ada di log.'
                : 'Centang pernyataan di atas dulu agar tombol ini aktif.'}
            </span>
          </div>

          {applyError && <p className={ERROR_BOX + ' mb-3'}>{applyError}</p>}

          {report && (
            <div className={CARD + ' mb-3'}>
              <p className="mb-2 font-semibold text-slate-100">Hasil pelengkapan</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <StatCard label="inserted" value={numberText(report.inserted)} />
                <StatCard label="skipped" value={numberText(report.skipped)} />
                <StatCard label="Total kandidat" value={numberText(report.totalCandidates)} />
              </div>
              <ul className="mt-2 space-y-1 text-xs">
                <li>
                  <span className="text-slate-400">Waktu laporan:</span>{' '}
                  <span className="text-slate-100">{dateTimeText(report.generatedAt)}</span>
                </li>
                <li>
                  <span className="text-slate-400">Mode:</span>{' '}
                  <span className="text-slate-100">
                    {report.dryRun === true ? 'pratinjau (tidak menulis)' : 'menerapkan (menulis baris baru)'}
                  </span>
                </li>
              </ul>
              <p className="mt-2 text-xs text-slate-400">
                inserted = baris baru yang benar-benar ditulis. skipped = baris yang dilewati karena sudah ada
                di log. Semua baris hasil pelengkapan ditandai sumber "backfill".
              </p>
              <p className={BANNER + ' mt-2'}>
                {text(report.note) || text(applied?.note) || 'Server tidak memberi catatan tambahan.'}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default AdminGrowthBackfill;

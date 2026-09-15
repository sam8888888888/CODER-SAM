import { useEffect, useState } from 'react';
import { api } from './api';
import type { DirStats, SkillRow } from './api';

/** Properti halaman "Kapabilitas": pelapor galat dari induk. */
type Props = {
  onError?: (message: string) => void;
};

/** Kelas Tailwind dasar untuk tombol kecil di panel. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';

/** Badge hijau untuk kemampuan yang siap dipakai. */
const BADGE_READY = 'rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300';
/** Badge kuning untuk kemampuan yang belum siap (misalnya mesin mati). */
const BADGE_NOT_READY = 'rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300';

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Paksa nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Tulis angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Ubah jumlah byte menjadi ukuran yang mudah dibaca. */
function byteText(value: unknown): string {
  const bytes = num(value);
  if (bytes < 1024) return `${numberText(bytes)} byte`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let step = 0;
  while (size >= 1024 && step < units.length - 1) {
    size = size / 1024;
    step += 1;
  }
  return `${size.toFixed(1)} ${units[step]}`;
}

/** Format waktu ISO menjadi tanggal dan jam Indonesia; nilai kosong ditulis tanda hubung. */
function timeText(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('id-ID');
}

/** Ubah kode galat server menjadi kalimat Indonesia yang jelas. */
function skillsErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN') || code.includes('SESSION'))
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  if (code.includes('ENGINE_UNAVAILABLE')) return 'Mesin agen tidak merespons, jadi status kemampuan belum bisa dibaca.';
  return 'Daftar kapabilitas gagal dibaca dari server. Coba muat ulang halaman ini.';
}

/** Urutkan baris kemampuan mengikuti daftar group dari server; group tak dikenal ditaruh di akhir. */
function groupRows(rows: SkillRow[], groups: string[]): { group: string; rows: SkillRow[] }[] {
  const order: string[] = [];
  for (const group of groups ?? []) {
    const clean = String(group ?? '').trim();
    if (clean && !order.includes(clean)) order.push(clean);
  }
  for (const row of rows ?? []) {
    const clean = String(row?.group ?? '').trim() || 'Lain-lain';
    if (!order.includes(clean)) order.push(clean);
  }
  return order.map((group) => ({
    group,
    rows: (rows ?? []).filter((row) => (String(row?.group ?? '').trim() || 'Lain-lain') === group),
  }));
}

/** Kartu ringkas satu direktori penyimpanan (data pengguna atau sesi mesin). */
function StorageCard({ title, stats, hint }: { title: string; stats: DirStats | null; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <h4 className="mb-1 text-sm font-semibold text-slate-100">{title}</h4>
      {stats ? (
        <>
          <p className="text-slate-100">
            {numberText(stats.files)} berkas · {byteText(stats.bytes)}
          </p>
          <p className="text-xs text-slate-400">Berkas terbaru: {timeText(stats.newest)}</p>
        </>
      ) : (
        <p className="text-slate-400">Belum ada data direktori ini.</p>
      )}
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  );
}

/**
 * Halaman "Kapabilitas": daftar kemampuan platform yang benar-benar ada, dikelompokkan
 * per group, dengan badge "siap"/"belum" dari field available. Ditambah ringkasan
 * penyimpanan (data dan sesi mesin) serta status mesin agen.
 */
export function Skills({ onError }: Props) {
  // Baris kemampuan dan daftar kelompok dari server.
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [engine, setEngine] = useState<{ available: boolean; version?: string } | null>(null);
  const [storage, setStorage] = useState<{ data: DirStats | null; engineSessions: DirStats | null } | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  /** Catat galat ke halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function fail(message: string): void {
    onError?.(message);
  }

  /** Muat ulang daftar kapabilitas langsung dari platform. */
  async function loadSkills(): Promise<void> {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.skills();
      const list = Array.isArray(data?.skills) ? data.skills : [];
      setRows(list);
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
      setEngine(data?.engine ?? null);
      setStorage(data?.storage ?? null);
    } catch (error) {
      // Jangan tampilkan daftar lama seolah masih terbaru: kosongkan, lalu beri pesan galat.
      setRows([]);
      setGroups([]);
      setEngine(null);
      setStorage(null);
      const message = skillsErrorMessage(error);
      setLoadError(message);
      fail(message);
    } finally {
      setLoading(false);
    }
  }

  // Baca daftar kapabilitas sekali saat halaman dibuka.
  useEffect(() => {
    void loadSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pencarian sederhana berdasarkan nama, kunci, dan keterangan.
  const term = query.trim().toLowerCase();
  const filtered = term
    ? rows.filter((row) =>
        `${String(row?.name ?? '')} ${String(row?.key ?? '')} ${String(row?.detail ?? '')}`
          .toLowerCase()
          .includes(term),
      )
    : rows;
  const ready = filtered.filter((row) => Boolean(row?.available)).length;
  const notReady = filtered.length - ready;
  const grouped = groupRows(filtered, groups);

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <h2 className="mb-1 text-base font-semibold text-slate-100">❈ Kapabilitas</h2>
      <p className="mb-3 text-slate-400">
        Daftar ini dibaca langsung dari platform saat halaman dibuka. Tiap baris menampilkan kemampuan yang
        benar-benar tersedia beserta nilainya, bukan janji fitur.
      </p>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-slate-300">
          Cari kemampuan
          <input
            className={FIELD}
            type="search"
            value={query}
            placeholder="Cari nama atau keterangan kemampuan"
            aria-label="Cari kemampuan platform"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" className={BTN} disabled={loading} onClick={() => { void loadSkills(); }}>
          {loading ? 'Memuat…' : 'Muat ulang dari platform'}
        </button>
      </div>

      {loading ? <p className="text-slate-400">Membaca daftar kapabilitas dari platform…</p> : null}
      {loadError ? <p className="text-slate-100">{loadError}</p> : null}

      {!loading && !loadError ? (
        <>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
              <p className="text-xs text-slate-400">Siap</p>
              <p className="text-slate-100">{numberText(ready)}</p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
              <p className="text-xs text-slate-400">Belum siap</p>
              <p className="text-slate-100">{numberText(notReady)}</p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2">
              <p className="text-xs text-slate-400">Total dibaca</p>
              <p className="text-slate-100">{numberText(filtered.length)}</p>
            </div>
          </div>

          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <h3 className="mb-1 text-sm font-semibold text-slate-100">Status mesin</h3>
            {engine ? (
              <p className="text-slate-100">
                {engine.available ? 'Mesin agen hidup' : 'Mesin agen tidak terhubung'} · versi{' '}
                {engine.version ? engine.version : 'tidak dilaporkan'}
              </p>
            ) : (
              <p className="text-slate-400">Belum ada status mesin dari server.</p>
            )}
          </div>

          <h3 className="mb-2 text-sm font-semibold text-slate-100">Penyimpanan</h3>
          {storage ? (
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              <StorageCard
                title="Data pengguna"
                stats={storage.data}
                hint="Berkas data akun dan unggahan pada direktori data."
              />
              <StorageCard
                title="Sesi mesin"
                stats={storage.engineSessions}
                hint="Sesi mesin agen yang disimpan di direktori sesi mesin."
              />
            </div>
          ) : (
            <p className="mb-4 text-slate-400">Belum ada data penyimpanan dari server.</p>
          )}

          <h3 className="mb-2 text-sm font-semibold text-slate-100">Daftar kemampuan</h3>
          {rows.length === 0 ? <p className="text-slate-400">Belum ada kemampuan yang dilaporkan platform.</p> : null}
          {rows.length > 0 && filtered.length === 0 ? (
            <p className="text-slate-400">Tidak ada kemampuan yang cocok dengan pencarian Anda.</p>
          ) : null}

          {grouped.map((section) =>
            section.rows.length === 0 ? null : (
              <div key={section.group} className="mb-4">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{section.group}</h4>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="text-left text-slate-400">
                        <th scope="col" className="border-b border-slate-700 px-2 py-2">Kemampuan</th>
                        <th scope="col" className="border-b border-slate-700 px-2 py-2">Status</th>
                        <th scope="col" className="border-b border-slate-700 px-2 py-2">Keterangan</th>
                        <th scope="col" className="border-b border-slate-700 px-2 py-2">Yang dibutuhkan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.rows.map((row) => (
                        <tr key={row.key}>
                          <td className="border-b border-slate-700 px-2 py-2 text-slate-100">
                            {String(row?.name ?? row?.key ?? '-')}
                          </td>
                          <td className="border-b border-slate-700 px-2 py-2">
                            <span className={row?.available ? BADGE_READY : BADGE_NOT_READY}>
                              {row?.available ? 'siap' : 'belum'}
                            </span>
                          </td>
                          <td className="border-b border-slate-700 px-2 py-2">{String(row?.detail ?? '-')}</td>
                          <td className="border-b border-slate-700 px-2 py-2">
                            {row?.needs ? String(row.needs) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ),
          )}
        </>
      ) : null}
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AdminJobsResponse, BackgroundJob, JobCycleReport, JobStats, JobWorkerInfo } from './api';

/** Properti halaman "Antrean pekerjaan latar". Halaman ini hanya dibuka oleh admin platform. */
type Props = { onError: (message: string) => void };

/** Saringan status pekerjaan. String kosong berarti semua status. */
type StatusFilter = '' | 'queued' | 'running' | 'done' | 'failed';

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas pembungkus kartu isi. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan untuk peringatan, pemberitahuan, dan galat. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
/** Kelas sel badan tabel. */
const TD = 'border-b border-slate-700/60 px-3 py-2';
/** Kelas dasar lencana status pekerjaan. */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';

/** Warna lencana status: menunggu=abu, dikerjakan=kuning, selesai=hijau, gagal=merah. */
const STATUS_CHIP: Record<string, string> = {
  queued: 'border-slate-500/40 bg-slate-500/15 text-slate-200',
  running: 'border-amber-500/40 bg-amber-500/15 text-amber-100',
  done: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
  failed: 'border-rose-500/40 bg-rose-500/15 text-rose-100',
};
/** Lencana abu-abu netral untuk nilai yang tidak dikenal. */
const CHIP_OFF = 'border-slate-600 bg-slate-700/40 text-slate-200';

/** Tombol saringan status; nilainya dikirim apa adanya ke api.adminJobs(status, kind). */
const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: '', label: 'Semua' },
  { value: 'queued', label: 'Menunggu' },
  { value: 'running', label: 'Dikerjakan' },
  { value: 'done', label: 'Selesai' },
  { value: 'failed', label: 'Gagal' },
];

/** Sebutan status pekerjaan dalam Bahasa Indonesia. */
const STATUS_LABEL: Record<string, string> = {
  queued: 'menunggu',
  running: 'dikerjakan',
  done: 'selesai',
  failed: 'gagal',
};

/** Sebutan jenis pekerjaan (kind) dalam Bahasa Indonesia. Jenis lain ditampilkan apa adanya. */
const KIND_LABEL: Record<string, string> = {
  'run.execute': 'menjalankan run',
  'run.execute.followup': 'lanjutan run',
  'email.deliver': 'kirim email',
  'retention.run': 'pembersihan retensi',
  'run.reap': 'bersihkan run mati',
  'workflow.reap': 'bersihkan alur mati',
  'usage.rollup': 'rekap pemakaian',
};

/** Batas jumlah pekerjaan yang dikirim server pada satu permintaan (bawaan server = 50). */
const SERVER_LIMIT = 50;

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Format tanggal dan jam; nilai null atau kosong ditulis sebagai tanda hubung. */
function dateTimeText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Durasi dalam milidetik beserta perkiraan manusiawi supaya angka besar tetap mudah dibaca. */
function msText(value: unknown): string {
  const ms = num(value);
  if (ms <= 0) return '-';
  if (ms < 60_000) return numberText(ms) + ' ms (± ' + Math.round(ms / 1000) + ' detik)';
  if (ms < 3_600_000) return numberText(ms) + ' ms (± ' + Math.round(ms / 60_000) + ' menit)';
  return numberText(ms) + ' ms (± ' + Math.round(ms / 3_600_000) + ' jam)';
}

/** Potong teks panjang supaya tabel tetap rapi; nilai kosong ditulis sebagai tanda hubung. */
function shortText(value: unknown, max = 90): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Sebutan status pekerjaan; status tak dikenal ditampilkan apa adanya. */
function statusLabel(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase();
  return STATUS_LABEL[code] ?? (code || 'tidak diketahui');
}

/** Sebutan jenis pekerjaan; jenis tak dikenal ditampilkan apa adanya. */
function kindLabel(value: unknown): string {
  const code = String(value ?? '').trim();
  return KIND_LABEL[code] ?? (code || 'tanpa jenis');
}

/** Kelas lencana sesuai status pekerjaan. */
function statusChipClass(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase();
  return CHIP + ' ' + (STATUS_CHIP[code] ?? CHIP_OFF);
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/** Ubah kode galat antrean pekerjaan menjadi kalimat Indonesia yang jelas. */
function jobsErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('ADMIN_REQUIRED') || code.includes('FORBIDDEN') || code.includes('UNAUTHORIZED')) {
    return 'Akses ditolak. Hanya admin platform yang dapat membuka antrean pekerjaan latar.';
  }
  if (code.includes('JOB_NOT_FOUND')) {
    return 'Pekerjaan itu tidak ada lagi di basis data. Segarkan daftar antrean.';
  }
  if (code.includes('JOB_ALREADY_PENDING')) {
    return 'Pekerjaan itu masih menunggu atau sedang dikerjakan, jadi belum bisa diulang.';
  }
  if (code.includes('JOB_NOT_RETRYABLE')) {
    return 'Pekerjaan itu belum bisa diulang sekarang. Segarkan daftar antrean.';
  }
  if (code.includes('AUTH') || code.includes('UNAUTHENTICATED') || code.includes('SESSION')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  }
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  }
  return fallback;
}

/** Satu baris keterangan "label: nilai" untuk kartu ringkas. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="text-slate-400">{label}:</span>
      <span className="text-slate-100">{value}</span>
    </li>
  );
}

/** Satu kartu angka ringkas pada statistik antrean. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{value}</p>
    </div>
  );
}

/** Ringkasan angka satu putaran worker; dipakai untuk putaran terakhir yang dilaporkan server. */
function CycleSummary({ cycle }: { cycle: JobCycleReport }) {
  const scheduled = Array.isArray(cycle?.scheduled) ? cycle.scheduled : [];
  const details = Array.isArray(cycle?.details) ? cycle.details : [];
  const done = details.filter((item) => item.outcome === 'done').length;
  const failed = details.filter((item) => item.outcome === 'failed').length;
  const retry = details.filter((item) => item.outcome === 'retry').length;
  return (
    <>
      <ul className="mt-1">
        <Row label="Pemilik putaran" value={String(cycle?.owner ?? '') || '-'} />
        <Row label="Mulai" value={dateTimeText(cycle?.startedAt)} />
        <Row label="Selesai" value={dateTimeText(cycle?.finishedAt)} />
        <Row label="Diambil (claimed)" value={numberText(cycle?.claimed)} />
        <Row label="Berhasil" value={numberText(cycle?.succeeded)} />
        <Row label="Gagal" value={numberText(cycle?.failed)} />
        <Row label="Sewa mati yang dipulihkan" value={numberText(cycle?.recoveredLeases)} />
      </ul>
      <p className="mt-2 text-xs text-slate-400">
        Pekerjaan yang diantre putaran ini: {scheduled.length > 0 ? scheduled.map((item) => kindLabel(item)).join(', ') : 'tidak ada'}.
      </p>
      <p className="text-xs text-slate-400">
        Rincian langkah: {numberText(details.length)} baris (selesai {numberText(done)} · gagal {numberText(failed)} · dicoba lagi{' '}
        {numberText(retry)}).
      </p>
    </>
  );
}

/**
 * Halaman "Antrean pekerjaan latar" (admin platform): keadaan worker, statistik antrean,
 * saringan status dan jenis, serta tabel pekerjaan dengan aksi "Ulangi".
 * Semua angka dibaca langsung dari server; tidak ada nilai karangan di halaman ini.
 */
export function AdminJobs({ onError }: Props) {
  // Data antrean: keadaan worker, statistik, daftar pekerjaan, dan daftar jenis dari server.
  const [worker, setWorker] = useState<JobWorkerInfo | null>(null);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);

  // Saringan aktif: status dan jenis. String kosong berarti semua.
  const [status, setStatus] = useState<StatusFilter>('');
  const [kind, setKind] = useState('');

  // Hasil putaran yang baru dijalankan dari halaman ini.
  const [cycle, setCycle] = useState<JobCycleReport | null>(null);

  // Keadaan tombol dan pesan di halaman.
  const [loading, setLoading] = useState(false);
  const [cycleBusy, setCycleBusy] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk; galat tidak pernah ditelan. */
  const fail = useCallback(
    (message: string): void => {
      setError(message);
      onError(message);
    },
    [onError],
  );

  /**
   * Ambil keadaan worker, statistik, daftar jenis, dan daftar pekerjaan sesuai saringan.
   * api.adminJobs hanya menerima (status, kind); batas jumlah baris ditentukan server.
   */
  const loadJobs = useCallback(
    async (nextStatus: StatusFilter, nextKind: string): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const result: AdminJobsResponse = await api.adminJobs(nextStatus || undefined, nextKind || undefined);
        setWorker(result?.worker ?? null);
        setStats(result?.stats ?? null);
        setJobs(Array.isArray(result?.jobs) ? result.jobs : []);
        // Daftar jenis dipakai untuk isi dropdown; simpan yang terakhir diketahui bila server kosong.
        if (Array.isArray(result?.kinds) && result.kinds.length > 0) setKinds(result.kinds);
      } catch (caught) {
        // Jangan tampilkan angka lama seolah masih baru: kosongkan data bila gagal.
        setWorker(null);
        setStats(null);
        setJobs([]);
        fail(jobsErrorMessage(caught, 'Antrean pekerjaan tidak bisa dimuat. Segarkan sebentar lagi.'));
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  useEffect(() => {
    void loadJobs('', '');
  }, [loadJobs]);

  /** Jalankan satu putaran worker sekarang, lalu muat ulang daftar sesuai saringan. */
  async function runCycleNow(): Promise<void> {
    setCycleBusy(true);
    setProblem('');
    setNotice('');
    try {
      const result = await api.runAdminJobCycle();
      setCycle(result?.cycle ?? null);
      if (result?.worker) setWorker(result.worker);
      if (result?.stats) setStats(result.stats);
      setNotice(
        'Satu putaran dijalankan: ' +
          numberText(result?.cycle?.claimed) +
          ' pekerjaan diambil, ' +
          numberText(result?.cycle?.succeeded) +
          ' berhasil, ' +
          numberText(result?.cycle?.failed) +
          ' gagal, ' +
          numberText(result?.cycle?.recoveredLeases) +
          ' sewa mati dipulihkan.',
      );
      await loadJobs(status, kind);
    } catch (caught) {
      const message = jobsErrorMessage(caught, 'Putaran antrean tidak bisa dijalankan. Coba lagi sebentar lagi.');
      setProblem(message);
      onError(message);
    } finally {
      setCycleBusy(false);
    }
  }

  /** Kembalikan satu pekerjaan yang sudah selesai atau gagal ke antrean menunggu. */
  async function retryJob(row: BackgroundJob): Promise<void> {
    setBusy('retry-' + row.id);
    setProblem('');
    setNotice('');
    try {
      const result = await api.retryAdminJob(row.id);
      setNotice(
        result?.retried
          ? 'Pekerjaan ' + kindLabel(row.kind) + ' ("' + row.id + '") kembali ke antrean menunggu.'
          : 'Server tidak melaporkan percobaan ulang untuk pekerjaan itu. Segarkan daftar antrean.',
      );
      await loadJobs(status, kind);
    } catch (caught) {
      const message = jobsErrorMessage(caught, 'Pekerjaan itu tidak bisa diulang. Segarkan daftar antrean.');
      setProblem(message);
      onError(message);
    } finally {
      setBusy('');
    }
  }

  const activeFilter = FILTERS.find((item) => item.value === status) ?? FILTERS[0];
  const activeCycle = cycle ?? worker?.lastCycle ?? null;
  const handlers = Array.isArray(worker?.handlers) ? worker.handlers : [];
  const byKind = stats && stats.byKind && typeof stats.byKind === 'object' ? Object.entries(stats.byKind) : [];
  const kindOptions = kind && !kinds.includes(kind) ? [kind, ...kinds] : kinds;

  return (
    <section className="page-shell-inner text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">⏱</span>Antrean pekerjaan latar
        </h2>
        <p className="settings-hint">
          Setiap pekerjaan latar ditulis lebih dulu ke basis data, baru dikerjakan oleh worker di belakang. Selagi
          dikerjakan, baris pekerjaan diberi sewa (lease) dengan masa berlaku; kalau proses yang memegangnya mati, sewa
          itu kedaluwarsa dan proses berikutnya mengambil alih pekerjaan tersebut. Jadi pekerjaan tidak hilang hanya
          karena server di-restart, tetapi hasilnya bisa terlambat sampai sewa lama habis.
        </p>
      </header>

      {loading ? <p className={BANNER}>Memuat antrean pekerjaan...</p> : null}
      {error ? <p className={BANNER}>{error}</p> : null}
      {problem ? <p className={BANNER}>{problem}</p> : null}
      {notice ? <p className={BANNER}>{notice}</p> : null}

      {/* A. Tindakan: segarkan daftar dan jalankan satu putaran worker. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Tindakan</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={loading || cycleBusy}
            onClick={() => {
              void loadJobs(status, kind);
            }}
          >
            {loading ? 'Memuat…' : 'Segarkan'}
          </button>
          <button
            type="button"
            className={BTN}
            disabled={loading || cycleBusy}
            title="Menjalankan satu putaran antrean sekarang, seperti yang dilakukan worker berkala"
            onClick={() => {
              void runCycleNow();
            }}
          >
            {cycleBusy ? 'Menjalankan…' : 'Jalankan satu putaran'}
          </button>
          <span className="text-xs text-slate-400">
            Satu putaran mengambil sejumlah pekerjaan sesuai batchSize, menjalankannya, lalu memperbarui statistik.
          </span>
        </div>
      </div>

      {/* B. Kartu ringkasan antrean. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Ringkasan antrean</h3>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 lg:grid-cols-7">
          <StatCard label="Menunggu" value={numberText(stats?.queued)} />
          <StatCard label="Dikerjakan" value={numberText(stats?.running)} />
          <StatCard label="Selesai" value={numberText(stats?.done)} />
          <StatCard label="Gagal" value={numberText(stats?.failed)} />
          <StatCard label="Total" value={numberText(stats?.total)} />
          <StatCard label="Menunggu sejak" value={dateTimeText(stats?.oldestQueuedAt)} />
          <StatCard label="Selesai terakhir" value={dateTimeText(stats?.lastFinishedAt)} />
        </div>
        {byKind.length > 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            Per jenis pekerjaan:{' '}
            {byKind.map(([name, total], index) => (
              <span key={name}>
                {index > 0 ? ' · ' : ''}
                {kindLabel(name)} {numberText(total)}
              </span>
            ))}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-slate-400">
          Statistik dihitung server dari seluruh isi tabel pekerjaan, bukan hanya baris yang tampil di tabel bawah.
        </p>
      </div>

      {/* C. Panel worker: pengaturan dan keadaan terakhir. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Worker</h3>
        {worker ? (
          <>
            <ul className="mt-1">
              <Row label="Keadaan" value={worker.running ? 'berjalan' : 'berhenti (tidak ada putaran berkala)'} />
              <Row label="Selang putaran" value={msText(worker.intervalMs)} />
              <Row label="Masa sewa (lease)" value={msText(worker.leaseMs)} />
              <Row label="Jumlah per putaran (batch)" value={numberText(worker.batchSize)} />
              <Row label="Sewa dianggap mati setelah" value={msText(worker.orphanAfterMs)} />
              <Row label="Putaran yang sudah dijalankan" value={numberText(worker.cyclesRun)} />
            </ul>
            {!worker.running ? (
              <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-amber-100">
                Peringatan: worker tidak berjalan. Pekerjaan baru tetap masuk antrean, tetapi tidak dikerjakan sampai
                worker hidup lagi atau Anda menekan "Jalankan satu putaran".
              </p>
            ) : null}
            <p className="mt-3 text-slate-400">Jenis pekerjaan yang ditangani worker:</p>
            {handlers.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-2">
                {handlers.map((item) => (
                  <span key={item} className={CHIP + ' ' + CHIP_OFF} title={item}>
                    {kindLabel(item)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-slate-400">Server tidak melaporkan daftar penangan pekerjaan.</p>
            )}
          </>
        ) : (
          <p className="text-slate-400">
            {loading ? 'Memuat keadaan worker…' : 'Keadaan worker belum tersedia. Tekan Segarkan.'}
          </p>
        )}
      </div>

      {/* D. Putaran terakhir: dari tombol di halaman ini atau dari catatan worker. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Putaran terakhir</h3>
        {activeCycle ? (
          <>
            <CycleSummary cycle={activeCycle} />
            <p className="mt-2 text-xs text-slate-400">
              Ringkasan ini berasal dari {cycle ? 'putaran yang baru Anda jalankan' : 'catatan worker terakhir'}.
            </p>
          </>
        ) : (
          <p className="text-slate-400">Belum ada putaran yang dilaporkan server.</p>
        )}
      </div>

      {/* E. Saringan status dan jenis pekerjaan. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Saringan</h3>
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.value || 'semua'}
              type="button"
              className={BTN}
              aria-pressed={status === item.value}
              title={item.value ? 'Status: ' + item.value : 'Semua status'}
              disabled={loading}
              onClick={() => {
                setStatus(item.value);
                setCycle(null);
                void loadJobs(item.value, kind);
              }}
            >
              {item.label}
            </button>
          ))}
          <label className="ml-1 flex items-center gap-2 text-xs text-slate-400">
            Jenis pekerjaan:
            <select
              className="rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 text-sm text-slate-100"
              value={kind}
              disabled={loading}
              onChange={(event) => {
                const next = event.target.value;
                setKind(next);
                setCycle(null);
                void loadJobs(status, next);
              }}
            >
              <option value="">Semua jenis</option>
              {kindOptions.map((item) => (
                <option key={item} value={item}>
                  {kindLabel(item)} ({item})
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Saringan aktif: {activeFilter.label}
          {status ? ' (status = ' + status + ')' : ''} · jenis {kind ? kind : 'semua'} · {numberText(jobs.length)}{' '}
          baris dimuat.
        </p>
      </div>

      {/* F. Tabel pekerjaan antrean. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Daftar pekerjaan</h3>
        {jobs.length === 0 ? (
          <p className="text-slate-400">
            {loading ? 'Memuat antrean pekerjaan...' : 'Belum ada pekerjaan di antrean.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>Jenis</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}>Percobaan</th>
                  <th scope="col" className={TH}>Siap jalan</th>
                  <th scope="col" className={TH}>Pemegang sewa</th>
                  <th scope="col" className={TH}>Galat terakhir</th>
                  <th scope="col" className={TH}>Dibuat</th>
                  <th scope="col" className={TH}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((row) => {
                  const code = String(row.status ?? '').trim().toLowerCase();
                  const retryable = code === 'done' || code === 'failed';
                  return (
                    <tr key={row.id} className="text-slate-300">
                      <td className={TD} title={row.kind + ' · id ' + row.id}>
                        {kindLabel(row.kind)}
                      </td>
                      <td className={TD}>
                        <span className={statusChipClass(row.status)} title={code || 'tidak diketahui'}>
                          {statusLabel(row.status)}
                        </span>
                      </td>
                      <td className={TD}>
                        {numberText(row.attempts)}/{numberText(row.maxAttempts)}
                      </td>
                      <td className={TD}>{dateTimeText(row.runAfter)}</td>
                      <td
                        className={TD}
                        title={row.lockExpiresAt ? 'Sewa berakhir ' + dateTimeText(row.lockExpiresAt) : 'Tidak ada sewa aktif'}
                      >
                        {row.lockOwner ? String(row.lockOwner) : '-'}
                      </td>
                      <td className={TD} title={row.lastError ? String(row.lastError) : 'Tidak ada galat'}>
                        {shortText(row.lastError)}
                      </td>
                      <td className={TD}>{dateTimeText(row.createdAt)}</td>
                      <td className={TD}>
                        {retryable ? (
                          <button
                            type="button"
                            className={BTN}
                            disabled={busy === 'retry-' + row.id || loading}
                            title="Kembalikan pekerjaan ini ke antrean menunggu"
                            onClick={() => {
                              void retryJob(row);
                            }}
                          >
                            {busy === 'retry-' + row.id ? 'Mengulang…' : 'Ulangi'}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Tombol "Ulangi" hanya muncul untuk pekerjaan berstatus selesai atau gagal; pekerjaan yang masih menunggu atau
          sedang dikerjakan tidak boleh diulang. Server mengirim maksimal {numberText(SERVER_LIMIT)} pekerjaan terbaru
          per permintaan, dan halaman ini tidak mengubah batas itu.
        </p>
      </div>
    </section>
  );
}

export default AdminJobs;

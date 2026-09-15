import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { DirStats, StatusHub as StatusHubData } from './api';


/** Kelas Tailwind dasar untuk tombol kecil di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas kartu isi ringkas. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';

/** Urutan dan sebutan Indonesia untuk hitungan (counts) yang ditampilkan. */
const COUNT_LABELS: { key: string; label: string }[] = [
  { key: 'users', label: 'Pengguna' },
  { key: 'workspaces', label: 'Workspace' },
  { key: 'projects', label: 'Proyek' },
  { key: 'conversations', label: 'Percakapan' },
  { key: 'messages', label: 'Pesan' },
  { key: 'runs', label: 'Run' },
  { key: 'failedRuns', label: 'Run gagal' },
  { key: 'artifacts', label: 'Artefak' },
  { key: 'orders', label: 'Pesanan' },
  { key: 'pendingOrders', label: 'Pesanan menunggu' },
];

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Tampilkan boolean dengan kata "ya" atau "tidak". */
function yesNo(value: unknown): string {
  if (value === undefined || value === null) return 'tidak diketahui';
  return value ? 'ya' : 'tidak';
}

/** Ukuran berkas dalam satuan yang mudah dibaca. */
function bytesText(value: unknown): string {
  const bytes = num(value);
  if (bytes <= 0) return '0 byte';
  if (bytes < 1024) return bytes + ' byte';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Format tanggal dan jam; nilai kosong ditulis sebagai tanda hubung. */
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

/** Teks durasi pemuatan data status. */
function durationText(value: unknown): string {
  return numberText(value) + ' ms';
}

/** Label status run bahasa Indonesia dari kode status mesin. */
function runStatusLabel(status: unknown): string {
  const code = String(status ?? '').trim().toLowerCase();
  if (code === 'succeeded' || code === 'success' || code === 'ok' || code === 'completed') return 'selesai';
  if (code === 'running' || code === 'started') return 'berjalan';
  if (code === 'queued' || code === 'pending') return 'menunggu';
  if (code === 'failed' || code === 'error') return 'gagal';
  if (code === 'cancelled' || code === 'canceled') return 'dibatalkan';
  return code || 'tidak diketahui';
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ubah kode galat status platform menjadi kalimat Indonesia yang jelas. */
function statusErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('ADMIN_REQUIRED')) return 'Hanya admin platform yang dapat melihat status platform.';
  if (code.includes('AUTH') || code.includes('UNAUTHENTICATED')) return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Tidak dapat menghubungi server. Periksa koneksi Anda, lalu muat ulang.';
  }
  return 'Gagal memuat status platform. Coba muat ulang beberapa saat lagi.';
}

/** Ringkas isi direktori penyimpanan (jumlah berkas, ukuran, berkas terbaru). */
function DirSummary({ title, dir }: { title: string; dir: DirStats | null | undefined }) {
  return (
    <div className={CARD}>
      <p className={LABEL}>{title}</p>
      {dir ? (
        <ul className="mt-1 text-slate-300">
          <li>Jumlah berkas: {numberText(dir.files)}</li>
          <li>Ukuran: {bytesText(dir.bytes)}</li>
          <li>Berkas terbaru: {dateTimeText(dir.newest)}</li>
        </ul>
      ) : (
        <p className="mt-1 text-slate-400">Belum ada data penyimpanan.</p>
      )}
    </div>
  );
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

/**
 * Halaman "Status platform": menampilkan keadaan mesin agen, basis data, hitungan data,
 * pembayaran, surat, keamanan, batas biaya, penyimpanan, cadangan, dan run terakhir.
 * Data diambil langsung dari api.statusHub() tanpa nilai karangan.
 */
export function StatusHub({ onError }: { onError?: (message: string) => void }) {
  const [data, setData] = useState<StatusHubData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /** Catat galat ke halaman ini dan teruskan ke induk. */
  const fail = useCallback(
    (message: string): void => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  /** Ambil status terbaru dari server. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await api.statusHub();
      setData(result ?? null);
    } catch (caught) {
      // Jangan tampilkan angka lama seolah masih baru: kosongkan data bila gagal.
      setData(null);
      fail(statusErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const engine = data?.engine;
  const database = data?.database;
  const counts = data?.counts ?? {};
  const money = data?.money;
  const payments = money?.payments;
  const mail = data?.mail;
  const security = data?.security;
  const limits = data?.limits;
  const storage = data?.storage;
  const backup = data?.backup;
  const queue = data?.queue ?? {};
  const lastRuns = data?.lastRuns ?? [];
  const migrations = database?.migrations ?? [];
  const lastMigration = migrations.length > 0 ? migrations[migrations.length - 1] : null;
  const queueKeys = Object.keys(queue);
  const countExtras = Object.keys(counts).filter((key) => !COUNT_LABELS.some((item) => item.key === key));

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">◉</span>Status platform
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={loading} onClick={() => { void load(); }}>
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>
      </div>

      <p className="mb-3 text-slate-400">
        {data
          ? 'Status diambil ' + dateTimeText(data.generatedAt) + ' (waktu server), durasi pengambilan ' + durationText(data.durationMs) + '. Versi platform: ' + (data.version || 'tidak diketahui') + '.'
          : 'Belum ada data status yang dimuat.'}
      </p>
      {error ? <p className="mb-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">{error}</p> : null}
      {loading && !data ? <p className="mb-3 text-slate-400">Memuat status platform…</p> : null}

      {/* Mesin agen. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Mesin agen</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={CARD}>
          <p className={LABEL}>Ketersediaan mesin</p>
          <ul className="mt-1">
            <Row label="Tersedia" value={engine ? yesNo(engine.available) : 'tidak diketahui'} />
            <Row label="Versi" value={engine?.version || 'tidak diketahui'} />
            <Row label="Jumlah model" value={engine ? numberText(engine.models) : '0'} />
          </ul>
          {engine?.note ? <p className="mt-2 text-slate-300">Catatan: {engine.note}</p> : null}
          {engine?.error ? <p className="mt-2 text-slate-100">Galat mesin: {engine.error}</p> : null}
        </div>
      </div>

      {/* Basis data. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Basis data</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={CARD}>
          <p className={LABEL}>Keadaan basis data</p>
          <ul className="mt-1">
            <Row label="Sehat" value={database ? yesNo(database.ok) : 'tidak diketahui'} />
            <Row label="Jumlah tabel" value={database ? numberText(database.tables) : '0'} />
            <Row label="Keterangan" value={database?.detail || 'tidak ada keterangan'} />
          </ul>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Migrasi terakhir</p>
          {lastMigration ? (
            <ul className="mt-1">
              <Row label="Versi" value={numberText(lastMigration.version)} />
              <Row label="Catatan" value={lastMigration.note || 'tidak ada catatan'} />
              <Row label="Diterapkan" value={dateTimeText(lastMigration.appliedAt)} />
              <Row label="Total migrasi tercatat" value={numberText(migrations.length)} />
            </ul>
          ) : (
            <p className="mt-1 text-slate-400">Belum ada catatan migrasi.</p>
          )}
        </div>
      </div>

      {/* Hitungan data. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Hitungan data</h3>
      {Object.keys(counts).length === 0 ? (
        <p className="mb-4 text-slate-400">Belum ada hitungan data dari server.</p>
      ) : (
        <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {COUNT_LABELS.map((item) => (
            <div key={item.key} className={CARD}>
              <p className={LABEL}>{item.label}</p>
              <p className="mt-1 text-lg text-slate-100">{numberText(counts[item.key])}</p>
            </div>
          ))}
          {countExtras.map((key) => (
            <div key={key} className={CARD}>
              <p className={LABEL}>{key}</p>
              <p className="mt-1 text-lg text-slate-100">{numberText(counts[key])}</p>
            </div>
          ))}
        </div>
      )}

      {/* Uang: token hari ini dan status gateway pembayaran. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Uang</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={CARD}>
          <p className={LABEL}>Token terpakai hari ini</p>
          <p className="mt-1 text-lg text-slate-100">{numberText(money?.todayTokens)}</p>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Gateway Xendit</p>
          <ul className="mt-1">
            <Row label="Aktif" value={payments ? yesNo(payments.xenditEnabled) : 'tidak diketahui'} />
            <Row label="Terpasang" value={payments ? yesNo(payments.xenditConfigured) : 'tidak diketahui'} />
          </ul>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Gateway Midtrans</p>
          <ul className="mt-1">
            <Row label="Aktif" value={payments ? yesNo(payments.midtransEnabled) : 'tidak diketahui'} />
            <Row label="Terpasang" value={payments ? yesNo(payments.midtransConfigured) : 'tidak diketahui'} />
          </ul>
          {payments?.gateway ? <p className="mt-2 text-slate-300">Gateway aktif: {payments.gateway}</p> : null}
        </div>
      </div>

      {/* Surat dan keamanan. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Surat &amp; keamanan</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={CARD}>
          <p className={LABEL}>Surat (email)</p>
          <ul className="mt-1">
            <Row label="Sudah diatur" value={mail ? yesNo(mail.configured) : 'tidak diketahui'} />
            <Row label="Pengirim" value={mail?.from || 'belum diatur'} />
            <Row label="Host SMTP" value={mail?.host || 'belum diatur'} />
            <Row label="Koneksi aman" value={mail ? yesNo(mail.secure) : 'tidak diketahui'} />
          </ul>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Keamanan</p>
          <ul className="mt-1">
            <Row label="CSRF ketat" value={security ? yesNo(security.csrfStrict) : 'tidak diketahui'} />
            <Row label="Jumlah email admin" value={security ? numberText(security.adminEmails) : '0'} />
            <Row label="Metrik aktif" value={security ? yesNo(security.metricsEnabled) : 'tidak diketahui'} />
          </ul>
        </div>
      </div>

      {/* Batas biaya dan kecepatan. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Batas operasional</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={CARD}>
          <p className={LABEL}>Batas biaya</p>
          <ul className="mt-1">
            <Row label="Batas biaya harian" value={limits ? numberText(limits.dailyCostMicros) + ' micros' : 'tidak diketahui'} />
            <Row label="Batas biaya bulanan" value={limits ? numberText(limits.monthlyCostMicros) + ' micros' : 'tidak diketahui'} />
            <Row label="Run per jam" value={limits ? numberText(limits.runsPerHour) : 'tidak diketahui'} />
            <Row label="Tenggat mesin" value={limits ? numberText(limits.engineTimeoutMs) + ' ms' : 'tidak diketahui'} />
          </ul>
          <p className="mt-2 text-slate-400">
            Biaya dilaporkan server dalam micros, yaitu satuan sejuta bagian dolar AS. Halaman ini tidak mengubahnya ke rupiah.
          </p>
        </div>
      </div>

      {/* Penyimpanan. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Penyimpanan</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <DirSummary title="Folder data" dir={storage?.data} />
        <DirSummary title="Sesi mesin agen" dir={storage?.engineSessions} />
      </div>

      {/* Cadangan dan antrean. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Cadangan</h3>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={CARD}>
          <p className={LABEL}>Catatan cadangan</p>
          <p className="mt-1 text-slate-100">{backup?.note || 'Belum ada catatan cadangan dari server.'}</p>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Jadwal cadangan (cron)</p>
          <p className="mt-1 text-slate-100">{backup?.cron || 'Belum ada jadwal cadangan dari server.'}</p>
        </div>
        {queueKeys.length > 0 ? (
          <div className={CARD}>
            <p className={LABEL}>Antrean</p>
            <ul className="mt-1">
              {queueKeys.map((key) => (
                <Row key={key} label={key} value={numberText(queue[key])} />
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* Run terakhir. */}
      <h3 className="mb-2 text-sm font-semibold text-slate-100">Run terakhir</h3>
      {lastRuns.length === 0 ? (
        <p className="text-slate-400">Belum ada run terakhir yang tercatat.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th scope="col" className="border-b border-slate-700 px-3 py-2">Status</th>
                <th scope="col" className="border-b border-slate-700 px-3 py-2">Model</th>
                <th scope="col" className="border-b border-slate-700 px-3 py-2">Dibuat</th>
                <th scope="col" className="border-b border-slate-700 px-3 py-2">Selesai</th>
                <th scope="col" className="border-b border-slate-700 px-3 py-2">Biaya (micros)</th>
                <th scope="col" className="border-b border-slate-700 px-3 py-2">Kode galat</th>
              </tr>
            </thead>
            <tbody>
              {lastRuns.map((run) => (
                <tr key={run.id} className="text-slate-300">
                  <td className="border-b border-slate-700/60 px-3 py-2">{runStatusLabel(run.status)}</td>
                  <td className="border-b border-slate-700/60 px-3 py-2">{run.model || 'tidak diketahui'}</td>
                  <td className="border-b border-slate-700/60 px-3 py-2">{dateTimeText(run.createdAt)}</td>
                  <td className="border-b border-slate-700/60 px-3 py-2">{dateTimeText(run.finishedAt)}</td>
                  <td className="border-b border-slate-700/60 px-3 py-2">
                    {run.costMicros === null || run.costMicros === undefined ? 'tidak tercatat' : numberText(run.costMicros) + ' micros'}
                  </td>
                  <td className="border-b border-slate-700/60 px-3 py-2">{run.errorCode || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-slate-400">
        Kolom biaya memakai satuan micros apa adanya dari server (1 micros = 1/1.000.000 dolar AS). Kurs rupiah tidak diterapkan di halaman ini.
      </p>
    </section>
  );
}

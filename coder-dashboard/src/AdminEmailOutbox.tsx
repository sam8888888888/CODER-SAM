import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { EmailWorkerState, OutboxEmail, OutboxStats, RetentionReport } from './api';

/** Properti halaman "Antrean email". Halaman ini hanya dibuka oleh admin platform. */
type Props = { onError: (message: string) => void };

/** Saringan status pesan antrean. String kosong berarti semua status. */
type StatusFilter = '' | 'pending' | 'sent' | 'failed' | 'skipped';

/** Laporan hasil satu kali pengiriman antrean; bentuknya sama dengan jawaban server. */
type DeliveryReport = {
  enabled: boolean;
  mailerConfigured: boolean;
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  reason?: string;
};

/** Hasil pembersihan retensi, termasuk pesan ringkas dan jumlah baris terhapus dari server. */
type RetentionRun = RetentionReport & {
  dryRun: boolean;
  totalRemoved: number;
  expiredExports?: { marked: number; filesRemoved: number };
  message: string;
};

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

/** Tombol saringan status; nilainya dikirim apa adanya ke api.adminEmailOutbox(status). */
const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: '', label: 'Semua' },
  { value: 'pending', label: 'Menunggu' },
  { value: 'sent', label: 'Terkirim' },
  { value: 'failed', label: 'Gagal' },
  { value: 'skipped', label: 'Dilewati' },
];

/** Batas percobaan kirim yang dipakai server (MAX_DELIVERY_ATTEMPTS pada outbox.ts). */
const MAX_ATTEMPTS = 3;

/** Status yang boleh dikirim ulang; server hanya menerima failed dan skipped. */
const RETRYABLE_STATUS: string[] = ['failed', 'skipped'];

/** Sebutan status pesan dalam Bahasa Indonesia. */
const STATUS_LABEL: Record<string, string> = {
  pending: 'menunggu',
  sent: 'terkirim',
  failed: 'gagal',
  skipped: 'dilewati',
};

/** Sebutan jenis email (kind) dalam Bahasa Indonesia. Jenis lain ditampilkan apa adanya. */
const KIND_LABEL: Record<string, string> = {
  run: 'kegagalan run',
  runs: 'kegagalan run',
  quota: 'kuota token',
  cost: 'batas biaya',
  billing: 'tagihan',
  team: 'tim',
  invitation: 'undangan',
  security: 'keamanan',
  account: 'akun',
  system: 'sistem',
};

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
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

/** Tampilkan boolean dengan kata "ya" atau "tidak". */
function yesNo(value: unknown): string {
  if (value === undefined || value === null) return 'tidak diketahui';
  return value ? 'ya' : 'tidak';
}

/** Sebutan status pesan; status tak dikenal ditampilkan apa adanya. */
function statusLabel(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase();
  return STATUS_LABEL[code] ?? (code || 'tidak diketahui');
}

/** Sebutan jenis email; jenis tak dikenal ditampilkan apa adanya. */
function kindLabel(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase();
  return KIND_LABEL[code] ?? (code || 'tidak diketahui');
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ubah kode galat antrean email menjadi kalimat Indonesia yang jelas. */
function outboxErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('ADMIN_REQUIRED') || code.includes('FORBIDDEN') || code.includes('UNAUTHORIZED')) {
    return 'Akses ditolak. Hanya admin platform yang dapat membuka antrean email.';
  }
  if (code.includes('EMAIL_NOT_RETRYABLE')) {
    return 'Pesan itu tidak ada lagi atau statusnya masih menunggu, jadi belum bisa dikirim ulang.';
  }
  if (code.includes('EMAIL_NOT_DELETABLE')) {
    return 'Pesan itu tidak ada lagi atau masih menunggu dikirim, jadi belum bisa dihapus.';
  }
  if (code.includes('AUTH') || code.includes('UNAUTHENTICATED') || code.includes('SESSION')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  }
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  }
  return fallback;
}

/** Arti kode alasan yang dikirim server pada laporan pengiriman atau pembersihan. */
function reasonText(reason: unknown): string {
  const code = String(reason ?? '').trim();
  if (code === 'NOTIFY_EMAIL_DISABLED') {
    return 'pekerja email dimatikan (NOTIFY_EMAIL_ENABLED=false), jadi belum ada pesan yang dikirim.';
  }
  if (code === 'MAILER_NOT_CONFIGURED') {
    return 'pengaturan SMTP belum lengkap, jadi semua pesan ditandai dilewati.';
  }
  if (code === 'RETENTION_DISABLED') {
    return 'retensi dimatikan (RETENTION_ENABLED=false), jadi pembersihan sungguhan tidak menghapus apa pun.';
  }
  if (code === 'DRY_RUN') return 'mode uji, tidak ada baris yang dihapus.';
  return code || 'server tidak menyebut alasan khusus.';
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

/** Satu angka kebijakan retensi (batas hari) beserta keterangannya. */
function PolicyDays({ label, days, hint }: { label: string; days: unknown; hint: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{numberText(days)} hari</p>
      <p className="text-xs text-slate-400">{hint}</p>
    </div>
  );
}

/**
 * Halaman "Antrean email" (admin platform): keadaan pekerja email, statistik antrean,
 * saringan status, tabel pesan keluar dengan aksi kirim ulang dan hapus, serta panel
 * retensi yang bisa dihitung ulang, diuji, atau dijalankan sungguhan.
 * Semua angka dibaca langsung dari server; tidak ada nilai karangan di halaman ini.
 */
export function AdminEmailOutbox({ onError }: Props) {
  // Data antrean: keadaan pekerja, statistik, daftar pesan, dan catatan server.
  const [worker, setWorker] = useState<EmailWorkerState | null>(null);
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [emails, setEmails] = useState<OutboxEmail[]>([]);
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliveryReport | null>(null);

  // Data retensi: laporan terakhir, hasil pembersihan, dan pesannya.
  const [report, setReport] = useState<RetentionReport | null>(null);
  const [retentionRun, setRetentionRun] = useState<RetentionRun | null>(null);
  const [retentionMessage, setRetentionMessage] = useState('');

  // Keadaan tombol dan pesan di halaman.
  const [loading, setLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [retentionBusy, setRetentionBusy] = useState('');
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

  /** Ambil keadaan pekerja, statistik, dan daftar pesan sesuai saringan status. */
  const loadOutbox = useCallback(
    async (status: StatusFilter): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const result = await api.adminEmailOutbox(status || undefined);
        setWorker(result?.worker ?? null);
        setStats(result?.stats ?? null);
        setEmails(Array.isArray(result?.emails) ? result.emails : []);
        setNote(String(result?.note ?? ''));
      } catch (caught) {
        // Jangan tampilkan angka lama seolah masih baru: kosongkan data bila gagal.
        setWorker(null);
        setStats(null);
        setEmails([]);
        setNote('');
        setOpenId(null);
        fail(outboxErrorMessage(caught, 'Antrean email tidak bisa dimuat. Muat ulang sebentar lagi.'));
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  /** Ambil laporan retensi terbaru; laporan ini hanya menghitung dan tidak menghapus data. */
  const loadReport = useCallback(async (): Promise<void> => {
    setReportLoading(true);
    setError('');
    try {
      const result = await api.retentionReport();
      setReport(result ?? null);
    } catch (caught) {
      setReport(null);
      fail(outboxErrorMessage(caught, 'Laporan retensi tidak bisa dimuat. Muat ulang sebentar lagi.'));
    } finally {
      setReportLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    void loadOutbox('');
    void loadReport();
  }, [loadOutbox, loadReport]);

  /** Kirim pesan berstatus menunggu sekarang, lalu tampilkan ringkasan hasilnya. */
  async function deliverNow(): Promise<void> {
    setBusy('deliver');
    setProblem('');
    setNotice('');
    setDelivery(null);
    try {
      const result = await api.deliverOutbox();
      setDelivery(result ?? null);
      setNotice(
        'Pengiriman dijalankan: ' +
          numberText(result?.sent) +
          ' terkirim, ' +
          numberText(result?.failed) +
          ' gagal, ' +
          numberText(result?.skipped) +
          ' dilewati.',
      );
      await loadOutbox(filter);
    } catch (caught) {
      const message = outboxErrorMessage(caught, 'Pengiriman email tidak bisa dijalankan. Coba lagi sebentar lagi.');
      setProblem(message);
      onError(message);
    } finally {
      setBusy('');
    }
  }

  /** Kembalikan satu pesan gagal atau dilewati ke antrean menunggu. */
  async function retryEmail(row: OutboxEmail): Promise<void> {
    setBusy('retry-' + row.id);
    setProblem('');
    setNotice('');
    try {
      const result = await api.retryOutboxEmail(row.id);
      setNotice(
        result?.retried
          ? 'Pesan untuk ' + row.toEmail + ' kembali ke antrean menunggu dan akan dicoba lagi.'
          : 'Server tidak melaporkan percobaan ulang untuk pesan itu. Muat ulang daftar antrean.',
      );
      await loadOutbox(filter);
    } catch (caught) {
      const message = outboxErrorMessage(caught, 'Pesan itu tidak bisa dikirim ulang. Muat ulang daftar antrean.');
      setProblem(message);
      onError(message);
    } finally {
      setBusy('');
    }
  }

  /** Hapus satu pesan dari antrean sesudah konfirmasi pengguna. */
  async function removeEmail(row: OutboxEmail): Promise<void> {
    const confirmed = window.confirm(
      'Hapus pesan "' +
        (row.subject || '(tanpa subjek)') +
        '" untuk ' +
        (row.toEmail || '(tanpa penerima)') +
        '? Baris ini dihapus permanen dari antrean dan tidak bisa dikembalikan.',
    );
    if (!confirmed) return;
    setBusy('hapus-' + row.id);
    setProblem('');
    setNotice('');
    try {
      await api.deleteOutboxEmail(row.id);
      if (openId === row.id) setOpenId(null);
      setNotice('Pesan untuk ' + (row.toEmail || '(tanpa penerima)') + ' sudah dihapus dari antrean.');
      await loadOutbox(filter);
    } catch (caught) {
      const message = outboxErrorMessage(caught, 'Pesan itu tidak bisa dihapus. Muat ulang daftar antrean.');
      setProblem(message);
      onError(message);
    } finally {
      setBusy('');
    }
  }

  /** Jalankan pembersihan retensi: uji (dry run) atau sungguhan. */
  async function runRetentionNow(dryRun: boolean): Promise<void> {
    if (!dryRun) {
      const confirmed = window.confirm(
        'Jalankan pembersihan retensi sungguhan? Semua baris yang lebih tua dari batas kebijakan akan DIHAPUS PERMANEN dari basis data dan tidak bisa dikembalikan. Tekan Batal, lalu pakai "Uji (dry run)" bila hanya ingin melihat angkanya.',
      );
      if (!confirmed) return;
    }
    setRetentionBusy(dryRun ? 'dry' : 'run');
    setProblem('');
    setNotice('');
    setRetentionMessage('');
    setRetentionRun(null);
    try {
      const result = await api.runRetention(dryRun);
      setRetentionRun(result ?? null);
      setReport(result ?? null);
      setRetentionMessage(
        String(result?.message ?? '') ||
          (dryRun ? 'Mode uji selesai. Tidak ada data yang dihapus.' : 'Pembersihan retensi selesai.'),
      );
      await loadReport();
    } catch (caught) {
      const message = outboxErrorMessage(
        caught,
        dryRun
          ? 'Uji retensi tidak bisa dijalankan. Coba lagi sebentar lagi.'
          : 'Pembersihan retensi tidak bisa dijalankan. Periksa pengaturan server, lalu coba lagi.',
      );
      setProblem(message);
      onError(message);
    } finally {
      setRetentionBusy('');
    }
  }

  const policy = report?.policy ?? null;
  const tables = Array.isArray(report?.tables) ? report.tables : [];
  const activeFilter = FILTERS.find((item) => item.value === filter) ?? FILTERS[0];

  return (
    <section className="page-shell-inner text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">✉</span>Antrean email
        </h2>
        <p className="settings-hint">
          Halaman ini memperlihatkan semua pesan email yang masuk antrean platform: keadaan pekerja pengirim, jumlah
          pesan per status, isi pesan, dan hasil percobaan kirim. Panel di bagian bawah menunjukkan kebijakan retensi
          data beserta jumlah baris yang jadi kandidat pembersihan.
        </p>
      </header>

      {loading ? <p className={BANNER}>Memuat antrean email…</p> : null}
      {error ? <p className={BANNER}>{error}</p> : null}
      {problem ? <p className={BANNER}>{problem}</p> : null}
      {notice ? <p className={BANNER}>{notice}</p> : null}

      {/* A. Keadaan pekerja email, pengaturan pengirim, dan catatan server. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Keadaan pekerja email</h3>
        {worker ? (
          <>
            <ul className="mt-1">
              <Row label="Pekerja email" value={worker.enabled ? 'aktif' : 'tidak aktif'} />
              <Row label="Pengirim (from)" value={worker.from || 'belum diatur'} />
              <Row label="SMTP siap" value={yesNo(worker.mailerConfigured)} />
            </ul>
            {!worker.enabled ? (
              <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-amber-100">
                Peringatan: pekerja email belum aktif (NOTIFY_EMAIL_ENABLED=false). Pesan hanya masuk antrean dan belum
                dikirim, jadi tombol "Kirim sekarang" tidak akan mengirim apa pun.
              </p>
            ) : null}
            {worker.enabled && !worker.mailerConfigured ? (
              <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-amber-100">
                Peringatan: pengaturan SMTP belum lengkap. Pesan yang dicoba dikirim akan ditandai dilewati (skipped).
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-slate-400">
            {loading ? 'Memuat keadaan pekerja email…' : 'Keadaan pekerja email belum tersedia. Tekan Muat ulang.'}
          </p>
        )}
        {note ? <p className="mt-2 text-slate-400">Catatan server: {note}</p> : null}
      </div>

      {/* B. Kartu statistik antrean. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Statistik antrean</h3>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Menunggu" value={numberText(stats?.pending)} />
          <StatCard label="Terkirim" value={numberText(stats?.sent)} />
          <StatCard label="Gagal" value={numberText(stats?.failed)} />
          <StatCard label="Dilewati" value={numberText(stats?.skipped)} />
          <StatCard label="Total pesan" value={numberText(stats?.total)} />
          <StatCard label="Terkirim terakhir" value={dateTimeText(stats?.lastSentAt)} />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Statistik dihitung server dari seluruh isi tabel antrean, bukan hanya pesan yang sedang tampil di tabel bawah.
        </p>
      </div>

      {/* C. Saringan status, muat ulang, dan pengiriman sekarang. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Saringan dan tindakan</h3>
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.value || 'semua'}
              type="button"
              className={BTN}
              aria-pressed={filter === item.value}
              disabled={loading}
              onClick={() => {
                setFilter(item.value);
                setOpenId(null);
                setDelivery(null);
                void loadOutbox(item.value);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Saringan aktif: {activeFilter.label}. {numberText(emails.length)} pesan dimuat pada kategori ini.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={loading} onClick={() => { void loadOutbox(filter); }}>
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
          <button type="button" className={BTN} disabled={busy === 'deliver' || loading} onClick={() => { void deliverNow(); }}>
            {busy === 'deliver' ? 'Mengirim…' : 'Kirim sekarang'}
          </button>
          <span className="text-xs text-slate-400">
            Kirim sekarang memproses maksimal 20 pesan berstatus menunggu, sama seperti pekerja latar tiap menit.
          </span>
        </div>
        {delivery ? (
          <div className="mt-3">
            <p className={BANNER}>
              Ringkasan pengiriman: dipertimbangkan {numberText(delivery.considered)} · terkirim{' '}
              {numberText(delivery.sent)} · gagal {numberText(delivery.failed)} · dilewati {numberText(delivery.skipped)}{' '}
              · masih menunggu {numberText(delivery.pending)}.
            </p>
            <p className="mt-2 text-xs text-slate-400">
              Pekerja aktif saat pengiriman: {delivery.enabled ? 'ya' : 'tidak'} · SMTP siap:{' '}
              {delivery.mailerConfigured ? 'ya' : 'tidak'}
              {delivery.reason ? ' · alasan: ' + reasonText(delivery.reason) : ''}
            </p>
          </div>
        ) : null}
      </div>

      {/* D. Tabel pesan antrean: klik baris untuk melihat isi pesan. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Pesan antrean</h3>
        {emails.length === 0 ? (
          <p className="text-slate-400">
            {loading ? 'Memuat pesan antrean…' : 'Belum ada pesan pada kategori ini. Coba saringan "Semua".'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>Penerima</th>
                  <th scope="col" className={TH}>Jenis</th>
                  <th scope="col" className={TH}>Subjek</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}>Percobaan</th>
                  <th scope="col" className={TH}>Galat terakhir</th>
                  <th scope="col" className={TH}>Dibuat</th>
                  <th scope="col" className={TH}>Terkirim</th>
                  <th scope="col" className={TH}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {emails.map((row) => {
                  const open = openId === row.id;
                  const status = String(row.status ?? '').trim().toLowerCase();
                  const retryable = RETRYABLE_STATUS.includes(status);
                  const deletable = status !== 'pending';
                  return (
                    <Fragment key={row.id}>
                      <tr
                        className={`cursor-pointer text-slate-300 ${open ? 'bg-slate-800/40' : ''}`}
                        title="Klik untuk membuka atau menutup isi pesan"
                        onClick={() => {
                          setOpenId(open ? null : row.id);
                        }}
                      >
                        <td className={TD}>{row.toEmail || '(tanpa penerima)'}</td>
                        <td className={TD}>{kindLabel(row.kind)}</td>
                        <td className={TD}>{row.subject || '(tanpa subjek)'}</td>
                        <td className={TD}>
                          <span className="badge">{statusLabel(row.status)}</span>
                        </td>
                        <td className={TD}>{numberText(row.attempts) + ' dari ' + numberText(MAX_ATTEMPTS)}</td>
                        <td className={TD}>{row.lastError ? String(row.lastError) : '-'}</td>
                        <td className={TD}>{dateTimeText(row.createdAt)}</td>
                        <td className={TD}>{dateTimeText(row.sentAt)}</td>
                        <td className={TD}>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className={BTN}
                              aria-expanded={open}
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenId(open ? null : row.id);
                              }}
                            >
                              {open ? 'Tutup isi' : 'Lihat isi'}
                            </button>
                            <button
                              type="button"
                              className={BTN}
                              disabled={busy === 'retry-' + row.id || !retryable}
                              title={
                                retryable
                                  ? 'Kembalikan pesan ini ke antrean menunggu'
                                  : 'Hanya pesan gagal atau dilewati yang bisa dikirim ulang'
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                void retryEmail(row);
                              }}
                            >
                              {busy === 'retry-' + row.id ? 'Mengirim ulang…' : 'Kirim ulang'}
                            </button>
                            <button
                              type="button"
                              className={BTN}
                              disabled={busy === 'hapus-' + row.id || !deletable}
                              title={
                                deletable
                                  ? 'Hapus pesan ini dari antrean secara permanen'
                                  : 'Pesan yang masih menunggu tidak boleh dihapus'
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                void removeEmail(row);
                              }}
                            >
                              {busy === 'hapus-' + row.id ? 'Menghapus…' : 'Hapus'}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="text-slate-300">
                          <td className={TD} colSpan={9}>
                            <p className="mb-1 text-xs text-slate-400">
                              Isi pesan untuk {row.toEmail || '(tanpa penerima)'} · jenis {kindLabel(row.kind)} · dibuat{' '}
                              {dateTimeText(row.createdAt)}
                            </p>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-200">
                              {row.body || 'Pesan ini tidak punya isi teks.'}
                            </pre>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Catatan: baris tabel bisa diklik untuk membuka isi pesan, dan tombol "Lihat isi" melakukan hal yang sama.
        </p>
      </div>

      {/* E. Panel retensi data. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Retensi data</h3>
        <p className="mb-2 text-slate-400">
          Laporan ini hanya menghitung. Tidak ada baris yang dihapus sampai Anda menekan tombol pembersihan sungguhan
          dan RETENTION_ENABLED=true di server.
        </p>
        {report ? (
          <>
            <p className="mb-2 text-slate-400">
              Status pembersihan otomatis: <span className="badge">{policy?.enabled ? 'aktif' : 'tidak aktif'}</span>
            </p>
            {!policy?.enabled ? (
              <p className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-amber-100">
                Peringatan: retensi belum aktif (RETENTION_ENABLED=false). Angka di bawah hanya perhitungan, dan
                pembersihan sungguhan tidak akan menghapus apa pun.
              </p>
            ) : null}
            {policy ? (
              <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <PolicyDays label="Jejak audit" days={policy.auditDays} hint="Umur baris audit yang disimpan." />
                <PolicyDays label="Notifikasi" days={policy.notificationDays} hint="Umur pemberitahuan dalam aplikasi." />
                <PolicyDays label="Peristiwa run" days={policy.runEventDays} hint="Umur peristiwa langkah run." />
                <PolicyDays label="Berkas ekspor" days={policy.exportDays} hint="Masa berlaku berkas ekspor akun." />
              </div>
            ) : (
              <p className="mb-2 text-slate-400">Server tidak mengirim rincian kebijakan retensi.</p>
            )}
            {report.note ? <p className="mb-2 text-slate-400">Catatan server: {report.note}</p> : null}
            <p className="mb-2 text-slate-100">
              Total baris kandidat: {numberText(report.totalCandidates)} dari {numberText(tables.length)} tabel.
            </p>
            {tables.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th scope="col" className={TH}>Tabel</th>
                      <th scope="col" className={TH}>Kolom</th>
                      <th scope="col" className={TH}>Batas waktu (cutoff)</th>
                      <th scope="col" className={TH}>Kandidat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((item) => (
                      <tr key={String(item.table)} className="text-slate-300">
                        <td className={TD}>{String(item.table ?? '-')}</td>
                        <td className={TD}>{String(item.column ?? '-')}</td>
                        <td className={TD}>{dateTimeText(item.cutoff)}</td>
                        <td className={TD}>{numberText(item.candidates)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-slate-400">Server tidak melaporkan daftar tabel retensi.</p>
            )}
            <p className="mt-2 text-xs text-slate-400">Laporan dihitung {dateTimeText(report.generatedAt)} (waktu server).</p>
          </>
        ) : (
          <p className="text-slate-400">
            {reportLoading ? 'Menghitung laporan retensi…' : 'Laporan retensi belum tersedia. Tekan Hitung ulang.'}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={reportLoading} onClick={() => { void loadReport(); }}>
            {reportLoading ? 'Menghitung…' : 'Hitung ulang'}
          </button>
          <button
            type="button"
            className={BTN}
            disabled={Boolean(retentionBusy)}
            onClick={() => {
              void runRetentionNow(true);
            }}
          >
            {retentionBusy === 'dry' ? 'Menguji…' : 'Uji (dry run)'}
          </button>
          <button
            type="button"
            className={BTN}
            disabled={Boolean(retentionBusy)}
            onClick={() => {
              void runRetentionNow(false);
            }}
          >
            {retentionBusy === 'run' ? 'Menjalankan…' : 'Jalankan sungguhan'}
          </button>
        </div>
        {retentionMessage ? <p className={'mt-2 ' + BANNER}>{retentionMessage}</p> : null}
        {retentionRun ? (
          <p className="mt-2 text-xs text-slate-400">
            Mode terakhir: {retentionRun.dryRun ? 'uji (tidak menghapus)' : 'sungguhan'} · baris terhapus{' '}
            {numberText(retentionRun.totalRemoved)}
            {retentionRun.expiredExports
              ? ' · berkas ekspor ditandai kedaluwarsa ' + numberText(retentionRun.expiredExports.marked)
              : ''}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-slate-400">
          Tombol "Uji (dry run)" hanya menghitung. Tombol "Jalankan sungguhan" meminta konfirmasi karena penghapusan
          bersifat permanen.
        </p>
      </div>
    </section>
  );
}

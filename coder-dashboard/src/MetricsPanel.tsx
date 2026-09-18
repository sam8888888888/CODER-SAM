/**
 * Halaman "Metrik Operasional" (Wave 10, butir 28).
 *
 * Isi halaman:
 * 1. Kartu angka operasional dari GET /v1/admin/metrics, dikelompokkan seperti daftar
 *    resmi: akun, kerja, antrean, webhook, perangkat & push, pencarian & email, kunci API.
 * 2. Ringkasan sistem: versi, versi skema, umur proses, keadaan worker, dan penyimpanan.
 * 3. Kotak token metrik: pengguna menempelkan METRICS_TOKEN, lalu hasil GET /v1/metrics
 *    ditampilkan sebagai teks biasa beserta tombol "Salin".
 *
 * Catatan satuan: seluruh nilai *_micros adalah sepersejuta USD, jadi tampilan uang selalu
 * dihitung micros / 1_000_000 dan ditulis dengan enam angka di belakang koma.
 *
 * Rahasia: token metrik hanya hidup di state React halaman ini. Token tidak ditulis ke
 * localStorage, cookie, maupun URL, sehingga hilang saat halaman dimuat ulang.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Selang muat ulang otomatis saat kotak centang aktif (15 detik). */
const AUTO_REFRESH_MS = 15_000;

/** Kalimat yang ditampilkan bila pengguna bukan admin platform. */
const NO_ACCESS_MESSAGE = 'Halaman ini hanya untuk admin platform.';

/** Kelas Tailwind tombol sekunder, sama dengan halaman admin lain. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi menonjol. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas pembungkus kartu angka dan panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan untuk pemberitahuan dan peringatan. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas kotak teks hasil /metrics. */
const PRE_BOX =
  'max-h-96 overflow-auto rounded-lg border border-slate-700 bg-slate-950/70 p-3 font-mono text-xs text-slate-200';

/** Bentuk jawaban GET /v1/admin/metrics (hanya bidang yang dipakai halaman ini). */
export type MetricsSnapshot = {
  generatedAt?: string;
  version?: string;
  schemaVersion?: number;
  uptimeSeconds?: number;
  startedAt?: string | null;
  numbers?: Record<string, number>;
  jobs?: {
    queued?: number;
    running?: number;
    done?: number;
    failed?: number;
    total?: number;
    oldestQueuedAt?: string | null;
    lastFinishedAt?: string | null;
  } | null;
  worker?: { running?: boolean; intervalMs?: number; cyclesRun?: number } | null;
  search?: { indexedMessages?: number; messages?: number } | null;
  push?: {
    configured?: boolean;
    subscriptions?: number;
    activeSubscriptions?: number;
    users?: number;
    deliverable?: number;
    failed?: number;
    deliveredLast24h?: number;
  } | null;
  devices?: { devices?: number; users?: number; newLast24h?: number; trusted?: number; blocked?: number } | null;
  health?: { database?: string; dataDir?: string } | null;
  tokenConfigured?: boolean;
  retention?: { dryRun?: boolean; webhookDays?: number; smokeCleanup?: boolean; smokeHours?: number } | null;
};

/** Cara menampilkan satu angka: hitungan biasa, uang micros USD, atau umur dalam detik. */
type MetricFormat = 'count' | 'money' | 'age';

/** Satu kartu angka beserta label Indonesia dan nama kunci aslinya. */
type MetricKey = { key: string; label: string; hint?: string; format?: MetricFormat };

/** Satu kelompok kartu angka. */
type MetricGroup = { title: string; note?: string; keys: MetricKey[] };

/**
 * Pengelompokan angka persis seperti daftar resmi server.
 * Nama kunci ditampilkan kecil di bawah nilai supaya mudah dicocokkan dengan jawaban /metrics.
 */
const GROUPS: MetricGroup[] = [
  {
    title: 'Akun',
    keys: [
      { key: 'users_total', label: 'Total akun aktif' },
      { key: 'users_closed', label: 'Akun ditutup', hint: 'Akun yang menunggu masa tenggang berakhir.' },
      { key: 'users_verified', label: 'Surel terverifikasi' },
    ],
  },
  {
    title: 'Kerja',
    keys: [
      { key: 'workspaces_total', label: 'Ruang kerja' },
      { key: 'projects_total', label: 'Proyek' },
      { key: 'conversations_total', label: 'Percakapan' },
      { key: 'messages_total', label: 'Pesan' },
      { key: 'runs_total', label: 'Total run' },
      { key: 'runs_active', label: 'Run aktif', hint: 'Run yang masih menunggu antrean atau sedang berjalan.' },
      { key: 'runs_completed', label: 'Run selesai' },
      { key: 'runs_failed', label: 'Run gagal' },
      { key: 'tokens_total', label: 'Total token' },
      { key: 'cost_micros_total', label: 'Biaya pokok', hint: 'Dibayar platform ke penyedia AI.', format: 'money' },
      { key: 'billed_micros_total', label: 'Yang ditagihkan', hint: 'Nilai jual ke pelanggan.', format: 'money' },
    ],
  },
  {
    title: 'Antrean',
    keys: [
      { key: 'jobs_queued', label: 'Pekerjaan menunggu' },
      { key: 'jobs_running', label: 'Pekerjaan berjalan' },
      { key: 'jobs_failed', label: 'Pekerjaan gagal' },
      {
        key: 'jobs_oldest_queued_seconds',
        label: 'Umur antrean tertua',
        hint: 'Bila lama, worker mungkin berhenti.',
        format: 'age',
      },
    ],
  },
  {
    title: 'Webhook',
    keys: [
      { key: 'webhooks_total', label: 'Webhook aktif' },
      { key: 'webhook_deliveries_queued', label: 'Pengiriman menunggu' },
      { key: 'webhook_deliveries_deferred', label: 'Pengiriman ditahan', hint: 'Ditahan supaya urutan peristiwa tetap rapi.' },
      { key: 'webhook_deliveries_failed', label: 'Pengiriman gagal' },
    ],
  },
  {
    title: 'Perangkat & push',
    keys: [
      { key: 'devices_total', label: 'Perangkat terdaftar' },
      { key: 'devices_blocked', label: 'Perangkat diblokir' },
      { key: 'push_subscriptions_active', label: 'Langganan push aktif' },
    ],
  },
  {
    title: 'Pencarian & email',
    keys: [
      { key: 'messages_indexed', label: 'Pesan terindeks' },
      {
        key: 'search_terms',
        label: 'Dokumen berindeks',
        hint: 'Server mengambil angka ini dari tabel knowledge_documents.',
      },
      { key: 'email_pending', label: 'Email menunggu' },
      { key: 'email_failed', label: 'Email gagal' },
    ],
  },
  {
    title: 'Kunci API',
    keys: [
      { key: 'api_keys_active', label: 'Kunci API aktif' },
      { key: 'audit_events_total', label: 'Peristiwa audit' },
    ],
  },
];

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
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

/** Uang dalam sepersejuta USD: micros / 1_000_000 dengan enam angka di belakang koma. */
function usdMicros(value: unknown): string {
  return (num(value) / 1_000_000).toFixed(6) + ' USD';
}

/** Ubah detik menjadi umur yang enak dibaca, misalnya "2 jam 5 menit". */
function umurText(value: unknown): string {
  const total = Math.max(0, Math.round(num(value)));
  if (total === 0) return '0 detik';
  const hari = Math.floor(total / 86_400);
  const jam = Math.floor((total % 86_400) / 3_600);
  const menit = Math.floor((total % 3_600) / 60);
  const detik = total % 60;
  if (hari > 0) return numberText(hari) + ' hari ' + numberText(jam) + ' jam';
  if (jam > 0) return numberText(jam) + ' jam ' + numberText(menit) + ' menit';
  if (menit > 0) return numberText(menit) + ' menit ' + numberText(detik) + ' detik';
  return numberText(detik) + ' detik';
}

/** Format tanggal dan jam dalam waktu Indonesia (WIB); nilai kosong ditulis sebagai tanda hubung. */
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
    second: '2-digit',
    timeZone: 'Asia/Jakarta',
  }) + ' WIB';
}

/** Waktu sekarang dalam bentuk teks WIB; dipakai untuk menandai waktu muat terakhir. */
function sekarangText(): string {
  return new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Jakarta',
  }) + ' WIB';
}

/** Ya atau tidak dalam Bahasa Indonesia. */
function yaTidak(value: unknown): string {
  return value === true ? 'ya' : 'tidak';
}

/** Aktif atau mati dalam Bahasa Indonesia. */
function aktifMati(value: unknown): string {
  return value === true ? 'aktif' : 'mati';
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/** Terjemahkan galat pemuatan angka operasional menjadi kalimat Indonesia yang ramah. */
function metricsErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('ADMIN_REQUIRED')) return NO_ACCESS_MESSAGE;
  if (code.includes('UNAUTHORIZED') || code.includes('UNAUTHENTICATED')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk lagi, lalu buka halaman ini kembali.';
  }
  if (code.includes('401')) return 'Sesi Anda sudah berakhir. Silakan masuk lagi, lalu buka halaman ini kembali.';
  if (code.includes('403')) return NO_ACCESS_MESSAGE;
  if (code.includes('429') || code.includes('RATE_LIMIT')) return 'Terlalu banyak permintaan. Coba lagi sebentar.';
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu tekan Segarkan.';
  }
  return 'Angka operasional gagal dimuat. Coba tekan Segarkan sebentar lagi.';
}

/** Terjemahkan galat permintaan /metrics menjadi kalimat Indonesia yang jelas. */
function tokenErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('NOT_FOUND') || code.includes('404')) {
    return 'Token metrik tidak cocok dengan yang dipasang di server. Periksa kembali METRICS_TOKEN Anda.';
  }
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  }
  return 'Permintaan /metrics gagal diproses. Periksa token, lalu coba lagi.';
}

/** Ambil satu angka dari kumpulan `numbers`; kunci yang tidak ada dihitung nol. */
function angkaAngka(numbers: Record<string, number>, key: string): number {
  return num(numbers[key]);
}

/** Nilai satu kartu sesuai formatnya. */
function nilaiMetric(numbers: Record<string, number>, item: MetricKey): string {
  const value = angkaAngka(numbers, item.key);
  if (item.format === 'money') return usdMicros(value);
  if (item.format === 'age') return umurText(value);
  return numberText(value);
}

/** Satu kartu angka: label, nilai besar, kunci server, dan catatan singkat. */
function KartuAngka({ label, value, catatan }: { label: string; value: string; catatan?: string }) {
  return (
    <div className={CARD}>
      <div className={LABEL}>{label}</div>
      <div className="mt-1 text-base font-semibold text-slate-100">{value}</div>
      {catatan ? <div className="mt-1 font-mono text-xs text-slate-400">{catatan}</div> : null}
    </div>
  );
}

/** Satu baris keterangan "label: nilai" untuk daftar keadaan layanan. */
function Baris({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="text-slate-400">{label}:</span>
      <span className="text-slate-100">{value}</span>
    </li>
  );
}

/**
 * Halaman metrik operasional untuk admin platform.
 * Tanpa hak admin server menjawab ADMIN_REQUIRED, dan halaman menampilkan satu kalimat jelas.
 */
export function MetricsPanel() {
  // Data angka dari server, keadaan muat, dan galat pemuatan.
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadedAt, setLoadedAt] = useState('');
  /** Hanya galat ADMIN_REQUIRED yang mematikan seluruh halaman. */
  const [tanpaAkses, setTanpaAkses] = useState(false);

  // Kendali muat ulang otomatis.
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Kotak token metrik: token hanya di state React, tidak pernah ditulis ke localStorage atau URL.
  const [tokenInput, setTokenInput] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [metricsText, setMetricsText] = useState('');
  const [copyState, setCopyState] = useState('');

  /** Muat angka operasional dari /v1/admin/metrics. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.get<MetricsSnapshot>('/v1/admin/metrics');
      setSnapshot(data ?? null);
      setLoadError('');
      setTanpaAkses(false);
      setLoadedAt(sekarangText());
    } catch (error) {
      // Jangan tampilkan angka lama seolah masih baru: kosongkan lalu beri pesan galat.
      setSnapshot(null);
      const message = metricsErrorMessage(error);
      setLoadError(message);
      if (message === NO_ACCESS_MESSAGE) setTanpaAkses(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Muat sekali saat halaman dibuka.
  useEffect(() => {
    void load();
  }, [load]);

  // Muat ulang tiap 15 detik, hanya saat kotak centang aktif; timer dibersihkan saat dimatikan.
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void load();
    }, AUTO_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [autoRefresh, load]);

  /** Minta teks /metrics dengan token yang ditempelkan pengguna. */
  async function tampilkanMetrics(): Promise<void> {
    const token = tokenInput.trim();
    setCopyState('');
    if (!token) {
      setTokenError('Tempelkan token metrik terlebih dahulu, lalu tekan Tampilkan /metrics.');
      return;
    }
    setTokenBusy(true);
    setTokenError('');
    try {
      const teks = await api.text('/v1/metrics?token=' + encodeURIComponent(token));
      setMetricsText(teks ?? '');
      if (!text(teks)) setTokenError('Server menjawab kosong. Pastikan token metrik sudah dipasang di server.');
    } catch (error) {
      setMetricsText('');
      setTokenError(tokenErrorMessage(error));
    } finally {
      setTokenBusy(false);
    }
  }

  /** Salin hasil /metrics ke papan klip; beri pesan jujur bila peramban menolak. */
  async function salinMetrics(): Promise<void> {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('CLIPBOARD_UNAVAILABLE');
      }
      await navigator.clipboard.writeText(metricsText);
      setCopyState('Hasil /metrics sudah disalin ke papan klip.');
    } catch (caught) {
      setCopyState(
        errorCode(caught) === 'CLIPBOARD_UNAVAILABLE'
          ? 'Peramban ini tidak mengizinkan salin otomatis. Salin teksnya secara manual dari kotak di atas.'
          : 'Teks /metrics gagal disalin. Salin secara manual dari kotak di atas.',
      );
    }
  }

  // Tanpa hak admin: satu kalimat penjelas, tanpa memuat rahasia apa pun.
  if (tanpaAkses) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
        <h2 className="mb-2 text-base font-semibold text-slate-100">Metrik Operasional</h2>
        <p>{NO_ACCESS_MESSAGE}</p>
      </section>
    );
  }

  const numbers: Record<string, number> = snapshot?.numbers ?? {};
  const jobs = snapshot?.jobs ?? null;
  const worker = snapshot?.worker ?? null;
  const search = snapshot?.search ?? null;
  const push = snapshot?.push ?? null;
  const devices = snapshot?.devices ?? null;
  const health = snapshot?.health ?? null;
  const retention = snapshot?.retention ?? null;
  const adaAngka = Object.keys(numbers).length > 0;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <h2 className="mb-2 text-base font-semibold text-slate-100">Metrik Operasional</h2>
      <p className="mb-3 text-slate-400">
        Halaman ini menampilkan angka operasional platform dan wajah teks <span className="font-mono">/metrics</span> untuk
        agen pemantau. Angka diambil dari server saat halaman dibuka; tekan Segarkan atau nyalakan muat ulang otomatis
        tiap 15 detik agar tampilan tidak basi.
      </p>

      {/* Kendali muat ulang dan waktu muat terakhir. */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} disabled={loading} onClick={() => { void load(); }}>
          {loading ? 'Memuat…' : 'Segarkan'}
        </button>
        <label className="flex items-center gap-2 text-slate-300">
          <input
            type="checkbox"
            checked={autoRefresh}
            aria-label="Muat ulang tiap 15 detik"
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          Muat ulang tiap 15 detik
        </label>
        <span className="text-xs text-slate-400">
          {loadedAt ? 'Terakhir dimuat: ' + loadedAt : 'Belum dimuat.'}
        </span>
      </div>

      {loadError ? <p className={'mb-3 ' + ERROR_BOX}>{loadError}</p> : null}
      {!snapshot && !loading && !loadError ? (
        <p className="mb-3 text-slate-400">Angka belum dimuat. Tekan Segarkan untuk mengambil dari server.</p>
      ) : null}

      {/* Ringkasan sistem: versi, skema, umur proses, dan keadaan worker. */}
      {snapshot ? (
        <>
          <h3 className="mb-2 text-sm font-semibold text-slate-100">Ringkasan sistem</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <KartuAngka label="Versi aplikasi" value={text(snapshot.version) || 'dev'} catatan="version" />
            <KartuAngka
              label="Versi skema basis data"
              value={numberText(snapshot.schemaVersion)}
              catatan="schemaVersion"
            />
            <KartuAngka
              label="Umur proses"
              value={umurText(snapshot.uptimeSeconds)}
              catatan={'uptimeSeconds ' + numberText(snapshot.uptimeSeconds)}
            />
            <KartuAngka
              label="Proses mulai"
              value={dateTimeText(snapshot.startedAt)}
              catatan={'dibuat ' + dateTimeText(snapshot.generatedAt)}
            />
          </div>

          <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">Keadaan layanan</h3>
          <div className={CARD}>
            <ul className="grid gap-1 sm:grid-cols-2">
              <Baris label="Worker antrean" value={worker?.running ? 'berjalan' : 'berhenti'} />
              <Baris label="Selang worker" value={umurText(num(worker?.intervalMs) / 1000)} />
              <Baris label="Siklus worker" value={numberText(worker?.cyclesRun)} />
              <Baris label="Pekerjaan selesai" value={numberText(jobs?.done)} />
              <Baris label="Antrean tertua" value={dateTimeText(jobs?.oldestQueuedAt)} />
              <Baris label="Pekerjaan terakhir selesai" value={dateTimeText(jobs?.lastFinishedAt)} />
              <Baris
                label="Indeks pencarian"
                value={numberText(search?.indexedMessages) + ' dari ' + numberText(search?.messages) + ' pesan'}
              />
              <Baris
                label="Push"
                value={
                  (push?.configured ? 'siap' : 'belum siap') +
                  ' · ' +
                  numberText(push?.activeSubscriptions) +
                  ' langganan aktif · ' +
                  numberText(push?.deliveredLast24h) +
                  ' terkirim 24 jam terakhir'
                }
              />
              <Baris
                label="Perangkat"
                value={
                  numberText(devices?.devices) +
                  ' perangkat · ' +
                  numberText(devices?.newLast24h) +
                  ' baru 24 jam terakhir · ' +
                  numberText(devices?.blocked) +
                  ' diblokir'
                }
              />
              <Baris label="Basis data" value={text(health?.database) || 'tidak dilaporkan'} />
              <Baris label="Folder data" value={text(health?.dataDir) || 'tidak dilaporkan'} />
              <Baris
                label="Retensi webhook"
                value={
                  numberText(retention?.webhookDays) +
                  ' hari · mode kering ' +
                  aktifMati(retention?.dryRun) +
                  ' · pembersihan data uji ' +
                  aktifMati(retention?.smokeCleanup)
                }
              />
              <Baris label="Token metrik dipasang di server" value={yaTidak(snapshot.tokenConfigured)} />
            </ul>
          </div>
        </>
      ) : null}

      {/* Kartu angka, dikelompokkan seperti daftar resmi server. */}
      {adaAngka ? (
        GROUPS.map((group) => (
          <div key={group.title}>
            <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">{group.title}</h3>
            {group.note ? <p className="mb-2 text-xs text-slate-400">{group.note}</p> : null}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {group.keys.map((item) => (
                <KartuAngka
                  key={item.key}
                  label={item.label}
                  value={nilaiMetric(numbers, item)}
                  catatan={item.key + (item.hint ? ' · ' + item.hint : '')}
                />
              ))}
            </div>
          </div>
        ))
      ) : snapshot ? (
        <p className="mt-4 text-slate-400">Server tidak mengirim kumpulan angka pada jawaban ini.</p>
      ) : null}

      <p className="mt-3 text-xs text-slate-400">
        Satuan uang: nilai <span className="font-mono">cost_micros_total</span> dan{' '}
        <span className="font-mono">billed_micros_total</span> adalah micros USD (sepersejuta USD), jadi tampilan dihitung
        micros / 1.000.000 dengan enam angka di belakang koma. Waktu ditampilkan dalam zona waktu Indonesia (WIB).
      </p>

      {/* Kotak token metrik: wajah teks /metrics untuk agen pemantau. */}
      <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">Wajah teks /metrics</h3>
      <div className={CARD}>
        <p className="mb-2 text-slate-400">
          Tempelkan METRICS_TOKEN untuk melihat jawaban teks <span className="font-mono">GET /v1/metrics</span>. Token
          hanya disimpan di memori halaman ini: tidak ditulis ke localStorage maupun ke URL, dan hilang saat halaman
          dimuat ulang. Bila token metrik belum dipasang di server, titik itu menjawab 404.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-slate-300">
            Token metrik
            <input
              className={FIELD}
              type={tokenVisible ? 'text' : 'password'}
              value={tokenInput}
              autoComplete="off"
              spellCheck={false}
              placeholder="Tempel METRICS_TOKEN"
              aria-label="Token metrik"
              onChange={(event) => {
                setTokenInput(event.target.value);
                setTokenError('');
                setCopyState('');
              }}
            />
          </label>
          <button
            type="button"
            className={BTN}
            aria-pressed={tokenVisible}
            onClick={() => setTokenVisible((current) => !current)}
          >
            {tokenVisible ? 'Sembunyikan token' : 'Tampilkan token'}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={tokenBusy}
            onClick={() => { void tampilkanMetrics(); }}
          >
            {tokenBusy ? 'Mengambil…' : 'Tampilkan /metrics'}
          </button>
          {metricsText ? (
            <button type="button" className={BTN} onClick={() => { void salinMetrics(); }}>
              Salin
            </button>
          ) : null}
        </div>

        {tokenError ? <p className={'mt-2 ' + ERROR_BOX}>{tokenError}</p> : null}
        {copyState ? <p className={'mt-2 ' + BANNER}>{copyState}</p> : null}
        {metricsText ? (
          <pre className={'mt-3 ' + PRE_BOX}>{metricsText}</pre>
        ) : (
          <p className="mt-2 text-slate-400">Hasil /metrics akan muncul di sini setelah token diambil.</p>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Akun biasa tidak dapat membuka halaman ini; server menjawab ADMIN_REQUIRED. Bila itu terjadi, halaman hanya
        menampilkan kalimat bahwa metrik ini hanya untuk admin platform.
      </p>
    </section>
  );
}

export default MetricsPanel;

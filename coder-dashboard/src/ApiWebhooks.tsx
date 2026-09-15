import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type {
  Webhook,
  WebhookDelivery,
  WebhookEventInfo,
  WebhookLimits,
  WebhookStats,
  WebhookTestReport,
  WebhooksResponse,
  Workspace,
} from './api';

/** Properti halaman "Webhook keluar". Pesan galat diteruskan ke induk halaman. */
type Props = { onError: (message: string) => void };

/** Peristiwa yang dicentang lebih dahulu saat formulir pendaftaran dibuka. */
const DEFAULT_EVENT = 'run.completed';

/** Jumlah baris riwayat pengiriman yang diminta dari server untuk satu webhook. */
const HISTORY_LIMIT = 25;

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi menonjol. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas pembungkus kartu isi. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan (pemberitahuan dan peringatan). */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat, sama dengan halaman Kunci API dan Billing. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300';
/** Kotak mencolok untuk rahasia penandatanganan yang hanya tampil satu kali. */
const SECRET_BOX = 'rounded-lg border border-amber-400/60 bg-amber-400/10 px-3 py-2 text-amber-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala dan badan tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
const TD = 'border-b border-slate-700/60 px-3 py-2';
/** Kelas input, select, dan kotak ketik gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas tombol tautan kecil di dalam tabel. */
const LINK_BTN = 'link-button';

/** Kelas dasar lencana kecil (peristiwa dan status). */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Warna lencana status pengiriman: antrean=biru, terkirim=hijau, gagal=merah. */
const CHIP_STATUS: Record<string, string> = {
  queued: 'border-sky-500/40 bg-sky-500/15 text-sky-100',
  delivered: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
  failed: 'border-rose-500/40 bg-rose-500/15 text-rose-100',
};
/** Lencana abu-abu netral untuk nilai status yang tidak dikenal server. */
const CHIP_OFF = 'border-slate-600 bg-slate-700/40 text-slate-200';
/** Lencana netral untuk nama peristiwa. */
const CHIP_EVENT = 'border-violet-500/40 bg-violet-500/15 text-violet-100';

/** Sebutan status pengiriman dalam Bahasa Indonesia. */
const DELIVERY_STATUS_LABEL: Record<string, string> = {
  queued: 'menunggu antrean',
  delivered: 'terkirim',
  failed: 'gagal',
};

/** Rahasia penandatanganan yang baru dibuat; nilai mentahnya tidak pernah dikirim server lagi. */
type CreatedWebhook = { url: string; secret: string; warning: string };

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

/** Durasi milidetik yang mudah dibaca; nilai kosong atau nol ditulis sebagai tanda hubung. */
function msText(value: unknown): string {
  const ms = num(value);
  if (ms <= 0) return '-';
  if (ms < 60_000) return numberText(ms) + ' ms';
  if (ms < 3_600_000) return numberText(ms) + ' ms (± ' + numberText(Math.round(ms / 60_000)) + ' menit)';
  return numberText(ms) + ' ms (± ' + numberText(Math.round(ms / 3_600_000)) + ' jam)';
}

/** Ya atau tidak dalam Bahasa Indonesia. */
function yesNo(value: unknown): string {
  return value === true ? 'diizinkan' : 'tidak diizinkan';
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/**
 * Peta kode galat server menjadi kalimat Indonesia.
 * Urutan penting: kode yang lebih khusus harus diperiksa lebih dahulu.
 */
const ERROR_MAP: { codes: string[]; text: string }[] = [
  { codes: ['OWNER_REQUIRED'], text: 'Hanya owner atau admin ruang kerja yang boleh mengubah webhook.' },
  {
    codes: ['WEBHOOK_URL_INVALID'],
    text: 'Alamat webhook bukan URL yang sah. Contoh: https://contoh.com/hook.',
  },
  {
    codes: ['WEBHOOK_URL_BLOCKED'],
    text: 'Alamat itu ditolak: alamat lokal atau layanan metadata tidak boleh dipakai.',
  },
  { codes: ['WEBHOOK_URL_REQUIRED'], text: 'Alamat webhook wajib diisi.' },
  { codes: ['WEBHOOK_URL_TOO_LONG'], text: 'Alamat webhook maksimal 500 karakter.' },
  { codes: ['TOO_MANY_WEBHOOKS'], text: 'Jumlah webhook di ruang kerja ini sudah mencapai batas.' },
  { codes: ['WEBHOOK_NOT_FOUND'], text: 'Webhook itu tidak ditemukan di ruang kerja ini.' },
  { codes: ['WORKSPACE_NOT_FOUND'], text: 'Ruang kerja tidak ditemukan.' },
  {
    codes: ['UNAUTHORIZED', 'UNAUTHENTICATED'],
    text: 'Sesi Anda sudah berakhir. Silakan masuk lagi.',
  },
  { codes: ['FORBIDDEN'], text: 'Anda tidak punya izin untuk tindakan ini.' },
  {
    codes: ['WEBHOOK_EVENTS_REQUIRED', 'INVALID_EVENT', 'WEBHOOK_EVENT_INVALID'],
    text: 'Pilih minimal satu peristiwa yang dikenal server.',
  },
  { codes: ['RATE_LIMIT', 'TOO_MANY_REQUESTS'], text: 'Terlalu banyak permintaan. Coba lagi sebentar.' },
  { codes: ['Failed to fetch', 'NetworkError'], text: 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.' },
];

/** Kode status HTTP yang dikirim api.ts di dalam pesan "Request gagal (kode)". */
const HTTP_STATUS_MAP: Record<string, string> = {
  '401': 'Sesi Anda sudah berakhir. Silakan masuk lagi.',
  '403': 'Anda tidak punya izin untuk tindakan ini.',
  '404': 'Data yang diminta tidak ditemukan.',
  '429': 'Terlalu banyak permintaan. Coba lagi sebentar.',
};

/**
 * Ubah galat apa pun (kode server, galat jaringan, atau kode status HTTP)
 * menjadi satu kalimat Indonesia yang bisa dibaca pemakai.
 */
function errorText(error: unknown): string {
  const code = errorCode(error);
  for (const item of ERROR_MAP) {
    if (item.codes.some((needle) => code.includes(needle))) return item.text;
  }
  const status = code.match(/\b(401|403|404|429)\b/);
  if (status && HTTP_STATUS_MAP[status[1]]) return HTTP_STATUS_MAP[status[1]];
  const clean = code.trim();
  return clean
    ? 'Permintaan webhook gagal diproses server. Coba lagi sebentar lagi (kode: ' + clean + ').'
    : 'Permintaan webhook gagal diproses server. Coba lagi sebentar lagi.';
}

/** Sebutan status pengiriman; status tak dikenal ditampilkan apa adanya. */
function deliveryStatusLabel(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase();
  return DELIVERY_STATUS_LABEL[code] ?? (code || 'tidak diketahui');
}

/** Kelas lencana sesuai status pengiriman. */
function deliveryChipClass(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase();
  return CHIP + ' ' + (CHIP_STATUS[code] ?? CHIP_OFF);
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

/** Satu kartu angka ringkas pada ringkasan pengiriman. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{value}</p>
    </div>
  );
}

/**
 * Halaman "Webhook keluar".
 *
 * Isinya: pilihan ruang kerja, ringkasan statistik dan batas dari server, formulir
 * pendaftaran webhook beserta pilihan peristiwa, kotak rahasia penandatanganan yang
 * hanya tampil sekali, tabel webhook dengan aksi uji/aktifkan/riwayat/hapus, dan panel
 * riwayat pengiriman untuk webhook yang dipilih.
 */
export function ApiWebhooks({ onError }: Props) {
  // Daftar ruang kerja pemakai dan ruang kerja yang sedang dipilih.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');

  // Data webhook dari server untuk ruang kerja terpilih.
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [stats, setStats] = useState<WebhookStats | null>(null);
  const [events, setEvents] = useState<WebhookEventInfo[]>([]);
  const [limits, setLimits] = useState<WebhookLimits | null>(null);
  const [note, setNote] = useState('');
  /** null berarti server belum menjawab; hanya false yang mematikan form. */
  const [canManage, setCanManage] = useState<boolean | null>(null);

  // Formulir pendaftaran webhook.
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([DEFAULT_EVENT]);
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  // Rahasia hanya hidup di state halaman ini, tidak pernah ditulis ke localStorage.
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [copyState, setCopyState] = useState('');

  // Laporan hasil uji per webhook, dikunci dengan id webhook.
  const [reports, setReports] = useState<Record<string, WebhookTestReport>>({});

  // Riwayat pengiriman webhook yang sedang dibuka.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesError, setDeliveriesError] = useState('');

  // Keadaan umum halaman.
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk; galat tidak pernah ditelan. */
  const fail = useCallback(
    (message: string): void => {
      setError(message);
      onError(message);
    },
    [onError],
  );

  /** Nama peristiwa yang disediakan server; dipakai untuk pilihan berbentuk kotak centang. */
  const eventNames = useMemo(() => events.map((item) => String(item.event ?? '')).filter((name) => name.length > 0), [events]);
  /** Kunci teks untuk efek pemangkasan pilihan; array baru tidak mengubah nilainya. */
  const eventKey = eventNames.join(',');

  /** Muat daftar ruang kerja pemakai; ruang kerja pertama dipilih otomatis. */
  const loadWorkspaces = useCallback(async (): Promise<void> => {
    try {
      const result = await api.workspaces();
      const list = Array.isArray(result) ? result : [];
      setWorkspaces(list);
      setWorkspaceId((current) => (current && list.some((item) => item.id === current) ? current : String(list[0]?.id ?? '')));
    } catch (caught) {
      setWorkspaces([]);
      setWorkspaceId('');
      fail(errorText(caught));
    }
  }, [fail]);

  /** Muat webhook, statistik, daftar peristiwa, batas, dan catatan server untuk satu ruang kerja. */
  const loadWebhooks = useCallback(
    async (targetWorkspaceId: string): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const result: WebhooksResponse = await api.webhooks(targetWorkspaceId || undefined);
        setWebhooks(Array.isArray(result?.webhooks) ? result.webhooks : []);
        setStats(result?.stats ?? null);
        setEvents(Array.isArray(result?.events) ? result.events : []);
        setLimits(result?.limits ?? null);
        setNote(String(result?.note ?? ''));
        setCanManage(result?.canManage !== false);
      } catch (caught) {
        // Jangan tampilkan data lama seolah masih sah: kosongkan bila permintaan gagal.
        setWebhooks([]);
        setStats(null);
        setEvents([]);
        setLimits(null);
        setNote('');
        setCanManage(null);
        fail(errorText(caught));
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  /** Muat riwayat pengiriman satu webhook. */
  const loadDeliveries = useCallback(
    async (webhookId: string): Promise<void> => {
      setDeliveriesLoading(true);
      setDeliveriesError('');
      try {
        const result = await api.webhookDeliveries(webhookId, HISTORY_LIMIT);
        setDeliveries(Array.isArray(result?.deliveries) ? result.deliveries : []);
      } catch (caught) {
        setDeliveries([]);
        const message = errorText(caught);
        setDeliveriesError(message);
        fail(message);
      } finally {
        setDeliveriesLoading(false);
      }
    },
    [fail],
  );

  // Daftar ruang kerja dimuat sekali saat halaman dibuka.
  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // Setiap kali pilihan ruang kerja berubah, data webhook dimuat ulang dari server.
  useEffect(() => {
    if (workspaceId) void loadWebhooks(workspaceId);
  }, [workspaceId, loadWebhooks]);

  // Ganti ruang kerja: tutup panel riwayat dan kotak rahasia supaya tidak tertukar.
  useEffect(() => {
    setSelectedId(null);
    setDeliveries([]);
    setDeliveriesError('');
    setCreated(null);
    setCopyState('');
    setFormError('');
    setNotice('');
  }, [workspaceId]);

  // Sesuaikan pilihan peristiwa dengan daftar dari server; bawaan run.completed.
  useEffect(() => {
    const available = eventKey ? eventKey.split(',') : [];
    setSelectedEvents((previous) => {
      const kept = previous.filter((name) => available.includes(name));
      if (kept.length > 0) return kept;
      if (available.includes(DEFAULT_EVENT)) return [DEFAULT_EVENT];
      return available.slice(0, 1);
    });
  }, [eventKey]);

  /** Centang atau lepas satu peristiwa pada formulir. */
  function toggleEvent(name: string): void {
    setSelectedEvents((previous) =>
      previous.includes(name) ? previous.filter((item) => item !== name) : previous.concat([name]),
    );
  }

  /** Daftarkan webhook baru; rahasia penandatanganan hanya ada pada jawaban ini. */
  async function createWebhook(): Promise<void> {
    const cleanUrl = url.trim();
    const cleanDescription = description.trim();
    setFormError('');
    if (!cleanUrl) {
      setFormError('Alamat webhook wajib diisi.');
      return;
    }
    if (selectedEvents.length === 0) {
      setFormError('Pilih minimal satu peristiwa yang harus dikirim ke alamat ini.');
      return;
    }
    setCreating(true);
    try {
      const result = await api.createWebhook({
        url: cleanUrl,
        events: selectedEvents,
        ...(cleanDescription ? { description: cleanDescription } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
      // Rahasia hanya disimpan di state halaman ini dan hilang saat ditutup atau dimuat ulang.
      setCreated({
        url: String(result?.webhook?.url ?? cleanUrl),
        secret: String(result?.secret ?? ''),
        warning: String(result?.warning ?? ''),
      });
      setCopyState('');
      setUrl('');
      setDescription('');
      setNotice('Webhook ' + cleanUrl + ' berhasil didaftarkan. Salin rahasia penandatanganan sekarang.');
      if (workspaceId) await loadWebhooks(workspaceId);
    } catch (caught) {
      const message = errorText(caught);
      setFormError(message);
      fail(message);
    } finally {
      setCreating(false);
    }
  }

  /** Salin rahasia penandatanganan ke papan klip; nilai ini tidak disimpan di peramban. */
  async function copySecret(): Promise<void> {
    const secret = String(created?.secret ?? '');
    if (!secret) {
      setCopyState('Server tidak mengirim rahasia pada jawaban ini, jadi tidak ada yang bisa disalin.');
      return;
    }
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('CLIPBOARD_UNAVAILABLE');
      }
      await navigator.clipboard.writeText(secret);
      setCopyState('Rahasia sudah disalin ke papan klip. Simpan di tempat yang aman.');
    } catch (caught) {
      const message =
        errorCode(caught) === 'CLIPBOARD_UNAVAILABLE'
          ? 'Peramban ini tidak mengizinkan salin otomatis. Salin rahasianya secara manual dari kotak di atas.'
          : 'Rahasia gagal disalin. Salin secara manual dari kotak di atas.';
      setCopyState(message);
    }
  }

  /** Uji satu webhook sekarang dan simpan laporan hasilnya untuk baris itu. */
  async function testWebhook(row: Webhook): Promise<void> {
    setBusyId(row.id);
    setNotice('');
    try {
      const result = await api.testWebhook(row.id);
      const report = result?.report ?? null;
      if (report) {
        setReports((previous) => ({ ...previous, [row.id]: report }));
        setNotice('Uji webhook ' + row.url + ' selesai dengan status ' + deliveryStatusLabel(report.status) + '.');
      } else {
        setNotice('Server tidak mengirim laporan uji untuk ' + row.url + '.');
      }
      if (workspaceId) await loadWebhooks(workspaceId);
    } catch (caught) {
      fail(errorText(caught));
    } finally {
      setBusyId('');
    }
  }

  /** Nyalakan atau matikan satu webhook tanpa menghapus riwayatnya. */
  async function toggleActive(row: Webhook): Promise<void> {
    setBusyId(row.id);
    setNotice('');
    try {
      const nextActive = !row.active;
      await api.updateWebhook(row.id, { active: nextActive });
      setNotice('Webhook ' + row.url + ' sekarang ' + (nextActive ? 'aktif' : 'nonaktif') + '.');
      if (workspaceId) await loadWebhooks(workspaceId);
    } catch (caught) {
      fail(errorText(caught));
    } finally {
      setBusyId('');
    }
  }

  /** Buka atau tutup panel riwayat pengiriman satu webhook. */
  function toggleHistory(row: Webhook): void {
    if (selectedId === row.id) {
      setSelectedId(null);
      setDeliveries([]);
      setDeliveriesError('');
      return;
    }
    setSelectedId(row.id);
    setDeliveries([]);
    setDeliveriesError('');
    void loadDeliveries(row.id);
  }

  /** Hapus satu webhook sesudah konfirmasi; riwayat pengirimannya ikut terhapus. */
  async function removeWebhook(row: Webhook): Promise<void> {
    const confirmed = window.confirm(
      'Hapus webhook ' +
        row.url +
        '?\n\nSeluruh riwayat pengiriman webhook ini ikut terhapus dan tidak bisa dikembalikan.',
    );
    if (!confirmed) return;
    setBusyId(row.id);
    setNotice('');
    try {
      const result = await api.deleteWebhook(row.id);
      setNotice('Webhook ' + row.url + ' sudah dihapus.' + (result?.note ? ' ' + String(result.note) : ''));
      if (selectedId === row.id) {
        setSelectedId(null);
        setDeliveries([]);
        setDeliveriesError('');
      }
      setReports((previous) => {
        const next: Record<string, WebhookTestReport> = {};
        for (const key of Object.keys(previous)) if (key !== row.id) next[key] = previous[key];
        return next;
      });
      if (workspaceId) await loadWebhooks(workspaceId);
    } catch (caught) {
      fail(errorText(caught));
    } finally {
      setBusyId('');
    }
  }

  /** Pemakai hanya boleh membaca bila server menyatakan canManage = false. */
  const readOnly = canManage === false;
  /** Formulir dikunci selama permintaan pembuatan berjalan atau saat hanya boleh membaca. */
  const formLocked = readOnly || creating;
  const selected = webhooks.find((row) => row.id === selectedId) ?? null;

  return (
    <section className="page-shell-inner text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">
            ⇗
          </span>
          Webhook keluar
        </h2>
        <p className="settings-hint">
          Webhook keluar mengirim pemberitahuan ke alamat HTTPS milik Anda setiap kali peristiwa tertentu terjadi di
          ruang kerja ini. Server memberi rahasia penandatanganan satu kali saat webhook dibuat; pakai rahasia itu untuk
          memeriksa tanda tangan pada setiap permintaan.
        </p>
      </header>

      {error ? <p className={ERROR_BOX}>{error}</p> : null}
      {notice ? <p className={BANNER}>{notice}</p> : null}
      {readOnly ? (
        <p className={BANNER}>
          Hanya owner atau admin ruang kerja yang boleh mengubah webhook. Anda tetap bisa melihat daftarnya di bawah.
        </p>
      ) : null}

      {/* A. Pilihan ruang kerja. */}
      <div className={CARD}>
        <label className="block">
          <span className={LABEL}>Ruang kerja</span>
          <select
            className={FIELD + ' mt-1 w-full sm:max-w-md'}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.length === 0 ? <option value="">Belum ada ruang kerja</option> : null}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {String(workspace.name ?? workspace.id)}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          Webhook selalu milik satu ruang kerja. Ganti pilihan di atas untuk melihat webhook ruang kerja lain; daftar
          dimuat ulang dari server setiap kali pilihan berubah.
        </p>
      </div>

      {/* B. Ringkasan pengiriman dan batas dari server. */}
      <div className={CARD}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Ringkasan pengiriman</h3>
          <button
            type="button"
            className={BTN}
            disabled={loading || !workspaceId}
            onClick={() => {
              void loadWebhooks(workspaceId);
            }}
          >
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>

        {stats ? (
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Jumlah webhook" value={numberText(stats.hooks)} />
            <StatCard label="Aktif" value={numberText(stats.active)} />
            <StatCard label="Terkirim" value={numberText(stats.delivered)} />
            <StatCard label="Gagal" value={numberText(stats.failed)} />
            <StatCard label="Menunggu antrean" value={numberText(stats.queued)} />
            <StatCard label="Pengiriman terakhir" value={dateTimeText(stats.lastDeliveryAt)} />
          </div>
        ) : (
          <p className="text-slate-400">Statistik webhook belum tersedia.</p>
        )}

        {limits ? (
          <ul className="mt-3 grid gap-1 sm:grid-cols-2">
            <Row label="Maksimal webhook per ruang kerja" value={numberText(limits.maxPerWorkspace)} />
            <Row label="Maksimal percobaan kirim" value={numberText(limits.maxAttempts) + ' kali'} />
            <Row label="Waktu tunggu tiap kirim" value={msText(limits.timeoutMs)} />
            <Row label="Alamat lokal (localhost)" value={yesNo(limits.allowLocal)} />
          </ul>
        ) : null}
        {note ? <p className="settings-hint">{note}</p> : null}
      </div>

      {/* C. Formulir pendaftaran webhook. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Daftarkan webhook</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Alamat webhook (wajib)</span>
            <input
              className={FIELD + ' mt-1 w-full'}
              type="url"
              required
              value={url}
              maxLength={500}
              placeholder="https://contoh.com/hook"
              disabled={formLocked}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="block">
            <span className={LABEL}>Keterangan (opsional)</span>
            <input
              className={FIELD + ' mt-1 w-full'}
              type="text"
              value={description}
              placeholder="Contoh: notifikasi ruang kerja untuk tim data"
              disabled={formLocked}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>

        <fieldset className="mt-3" disabled={formLocked}>
          <legend className={LABEL}>Peristiwa yang dikirim</legend>
          {eventNames.length === 0 ? (
            <p className="text-slate-400">Server belum melaporkan daftar peristiwa. Muat ulang halaman ini.</p>
          ) : (
            <div className="mt-1 flex flex-col gap-1">
              {events.map((item) => {
                const name = String(item.event ?? '');
                return (
                  <label key={name || String(item.description ?? '')} className="flex items-start gap-2 text-slate-300">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedEvents.includes(name)}
                      disabled={formLocked}
                      onChange={() => toggleEvent(name)}
                    />
                    <span>
                      <code className="font-mono text-xs text-slate-100">{name || '-'}</code>
                      {item.description ? <span className="text-slate-400"> — {String(item.description)}</span> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
        <p className="settings-hint">
          Pilihan bawaan adalah peristiwa <code className="font-mono">run.completed</code>. Pilih minimal satu
          peristiwa; pilihan saat ini: {selectedEvents.length > 0 ? selectedEvents.join(', ') : 'belum ada'}.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={formLocked || url.trim().length === 0 || selectedEvents.length === 0}
            onClick={() => {
              void createWebhook();
            }}
          >
            {creating ? 'Mendaftarkan…' : 'Daftarkan'}
          </button>
          <span className="text-xs text-slate-400">
            {readOnly
              ? 'Formulir dimatikan karena Anda hanya boleh membaca di ruang kerja ini.'
              : limits
                ? 'Batas ruang kerja: ' + numberText(limits.maxPerWorkspace) + ' webhook, ' + numberText(limits.maxAttempts) + ' percobaan kirim.'
                : ''}
          </span>
        </div>
        {formError ? <p className={ERROR_BOX + ' mt-2'}>{formError}</p> : null}
      </div>

      {/* D. Rahasia penandatanganan: hanya tampil sekali. */}
      {created ? (
        <div className={SECRET_BOX}>
          <p className="font-semibold">
            Webhook {created.url} sudah didaftarkan. Salin rahasia penandatanganan sekarang.
          </p>
          <p className="mt-1 text-xs">
            {created.warning || 'Rahasia ini tidak bisa ditampilkan lagi setelah kotak ini ditutup.'}
          </p>
          <code className="mt-2 block break-all rounded-lg border border-amber-400/40 bg-slate-900/60 px-3 py-2 font-mono text-xs">
            {created.secret || 'server tidak mengirim rahasia'}
          </code>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              onClick={() => {
                void copySecret();
              }}
            >
              Salin
            </button>
            <button
              type="button"
              className={LINK_BTN}
              onClick={() => {
                // Rahasia langsung dibuang dari state; server tidak bisa mengirimnya lagi.
                setCreated(null);
                setCopyState('');
              }}
            >
              Sudah saya simpan
            </button>
            <span className="text-xs">{copyState}</span>
          </div>
          <p className="mt-2 text-xs">
            Rahasia ini tidak disimpan di peramban (tidak ada di localStorage) dan hilang saat halaman dimuat ulang.
            Server hanya menyimpan hash-nya, jadi nilainya tidak bisa ditampilkan lagi.
          </p>
        </div>
      ) : null}

      {/* E. Tabel webhook ruang kerja ini. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Webhook di ruang kerja ini</h3>

        {loading && webhooks.length === 0 ? <p className="text-slate-400">Memuat daftar webhook…</p> : null}
        {!loading && webhooks.length === 0 ? (
          <p className="text-slate-400">Belum ada webhook di ruang kerja ini. Daftarkan satu di atas.</p>
        ) : null}

        {webhooks.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>
                    Alamat
                  </th>
                  <th scope="col" className={TH}>
                    Peristiwa
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Pengiriman terakhir
                  </th>
                  <th scope="col" className={TH}>
                    Status terakhir
                  </th>
                  <th scope="col" className={TH}>
                    Jumlah gagal
                  </th>
                  <th scope="col" className={TH}>
                    Aksi
                  </th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((row) => {
                  const busy = busyId === row.id;
                  const report = reports[row.id];
                  const names = Array.isArray(row.events) ? row.events : [];
                  return (
                    <tr key={row.id}>
                      <td className={TD}>
                        <span className="break-all font-mono text-xs text-slate-100">{String(row.url ?? '') || '-'}</span>
                        {row.description ? (
                          <span className="block text-xs text-slate-400">{String(row.description)}</span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        {names.length === 0 ? (
                          <span className="text-slate-400">-</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {names.map((name) => (
                              <span key={String(name)} className={CHIP + ' ' + CHIP_EVENT}>
                                {String(name)}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className={TD}>
                        <span className="badge">{row.active ? 'Aktif' : 'Nonaktif'}</span>
                      </td>
                      <td className={TD}>{dateTimeText(row.lastDeliveryAt)}</td>
                      <td className={TD}>
                        <span className={deliveryChipClass(row.lastStatus)}>{deliveryStatusLabel(row.lastStatus)}</span>
                      </td>
                      <td className={TD}>{numberText(row.failureCount)}</td>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className={BTN}
                            disabled={busy || readOnly}
                            aria-label={'Uji webhook ' + row.url}
                            onClick={() => {
                              void testWebhook(row);
                            }}
                          >
                            {busy ? 'Bekerja…' : 'Uji'}
                          </button>
                          <button
                            type="button"
                            className={BTN}
                            disabled={busy || readOnly}
                            aria-label={(row.active ? 'Matikan webhook ' : 'Aktifkan webhook ') + row.url}
                            onClick={() => {
                              void toggleActive(row);
                            }}
                          >
                            {row.active ? 'Matikan' : 'Aktifkan'}
                          </button>
                          <button
                            type="button"
                            className={BTN}
                            aria-label={'Riwayat pengiriman ' + row.url}
                            onClick={() => toggleHistory(row)}
                          >
                            {selectedId === row.id ? 'Tutup riwayat' : 'Riwayat'}
                          </button>
                          <button
                            type="button"
                            className={BTN}
                            disabled={busy || readOnly}
                            aria-label={'Hapus webhook ' + row.url}
                            onClick={() => {
                              void removeWebhook(row);
                            }}
                          >
                            Hapus
                          </button>
                        </div>
                        {report ? (
                          <p className="mt-1 text-xs text-slate-400">
                            Hasil uji: status {deliveryStatusLabel(report.status)} · kode jawaban{' '}
                            {report.responseStatus === null ? '-' : numberText(report.responseStatus)} · galat{' '}
                            {String(report.error ?? '') || '-'} · durasi {msText(report.durationMs)}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* F. Riwayat pengiriman webhook yang dipilih. */}
      {selected ? (
        <div className={CARD}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-100">
              Riwayat pengiriman: <span className="break-all font-mono text-xs">{String(selected.url ?? '')}</span>
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={BTN}
                disabled={deliveriesLoading}
                onClick={() => {
                  void loadDeliveries(selected.id);
                }}
              >
                {deliveriesLoading ? 'Memuat…' : 'Muat ulang riwayat'}
              </button>
              <button
                type="button"
                className={LINK_BTN}
                onClick={() => {
                  setSelectedId(null);
                  setDeliveries([]);
                  setDeliveriesError('');
                }}
              >
                Tutup riwayat
              </button>
            </div>
          </div>
          <p className="settings-hint">
            Server mengirim {HISTORY_LIMIT} baris terakhir untuk webhook ini.
          </p>

          {deliveriesError ? <p className={ERROR_BOX + ' mb-2'}>{deliveriesError}</p> : null}
          {deliveriesLoading && deliveries.length === 0 ? <p className="text-slate-400">Memuat riwayat pengiriman…</p> : null}
          {!deliveriesLoading && deliveries.length === 0 ? <p className="text-slate-400">Riwayat kosong.</p> : null}

          {deliveries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="admin-table">
                <thead>
                  <tr className="text-left text-slate-400">
                    <th scope="col" className={TH}>
                      Peristiwa
                    </th>
                    <th scope="col" className={TH}>
                      Status
                    </th>
                    <th scope="col" className={TH}>
                      Percobaan
                    </th>
                    <th scope="col" className={TH}>
                      Kode jawaban
                    </th>
                    <th scope="col" className={TH}>
                      Durasi
                    </th>
                    <th scope="col" className={TH}>
                      Galat terakhir
                    </th>
                    <th scope="col" className={TH}>
                      Dibuat
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((item) => (
                    <tr key={item.id}>
                      <td className={TD}>
                        <span className={CHIP + ' ' + CHIP_EVENT}>{String(item.event ?? '') || '-'}</span>
                      </td>
                      <td className={TD}>
                        <span className={deliveryChipClass(item.status)}>{deliveryStatusLabel(item.status)}</span>
                        {item.deliveredAt ? (
                          <span className="block text-xs text-slate-400">{dateTimeText(item.deliveredAt)}</span>
                        ) : null}
                      </td>
                      <td className={TD}>{numberText(item.attempts)}</td>
                      <td className={TD}>{item.responseStatus === null ? '-' : numberText(item.responseStatus)}</td>
                      <td className={TD}>{msText(item.durationMs)}</td>
                      <td className={TD}>
                        {item.lastError ? (
                          <span className="break-all text-xs text-rose-300">{String(item.lastError)}</span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className={TD}>{dateTimeText(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Halaman "Riwayat pengiriman webhook" (Wave 10, butir 23).
 *
 * Tujuan halaman ini:
 * 1. Menampilkan riwayat pengiriman satu webhook menurut posisi stream-nya (kolom `sequence`),
 *    lengkap dengan status, jumlah percobaan, jawaban penerima, dan galat terakhir.
 * 2. Menjelaskan aturan urutan: bila penerima lambat, event berikutnya ditahan sebentar.
 * 3. Mengirim ulang satu baris riwayat sebagai BARIS BARU, supaya riwayat lama tetap utuh.
 * 4. Membersihkan riwayat lama dalam dua langkah: mode kering (dryRun) lebih dahulu,
 *    lalu konfirmasi kedua untuk benar-benar menghapus.
 *
 * Semua panggilan jaringan lewat objek `api` dari './api' — tidak ada fetch langsung di sini.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Properti halaman: id webhook awal dari induk (boleh kosong). */
type Props = { webhookId?: string };

/** Jumlah baris riwayat yang diminta dari server pada satu permintaan. */
const HISTORY_LIMIT = 50;

/** Kelas Tailwind dasar tombol sekunder, sama dengan halaman webhook lain. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi menonjol. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas tombol berbahaya untuk penghapusan yang sudah dikonfirmasi. */
const BTN_DANGER =
  'rounded-lg border border-rose-500/60 bg-rose-600/30 px-3 py-2 text-sm text-rose-100 hover:bg-rose-600/50 disabled:opacity-50';
/** Kelas input dan kotak ketik gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas pembungkus kartu ringkasan dan panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan untuk pemberitahuan. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala dan badan tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
const TD = 'border-b border-slate-700/60 px-3 py-2';
/** Lebar maksimum kolom galat supaya tabel tidak melebar karena pesan panjang. */
const ERROR_CELL_MAX_WIDTH = '18rem';

/** Kelas dasar lencana kecil (status dan penanda kiriman ulang). */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Warna lencana status pengiriman: antrean=biru, terkirim=hijau, gagal=merah. */
const CHIP_STATUS: Record<string, string> = {
  queued: 'border-sky-500/40 bg-sky-500/15 text-sky-100',
  delivered: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
  failed: 'border-rose-500/40 bg-rose-500/15 text-rose-100',
};
/** Lencana abu-abu netral untuk status yang tidak dikenal server. */
const CHIP_OFF = 'border-slate-600 bg-slate-700/40 text-slate-200';
/** Lencana kuning untuk baris yang ditahan sementara. */
const CHIP_HELD = 'border-amber-500/40 bg-amber-500/15 text-amber-100';
/** Lencana ungu untuk penanda kiriman ulang. */
const CHIP_RESEND = 'border-violet-500/40 bg-violet-500/15 text-violet-100';

/** Sebutan status pengiriman dalam Bahasa Indonesia. */
const DELIVERY_STATUS_LABEL: Record<string, string> = {
  queued: 'menunggu antrean',
  delivered: 'terkirim',
  failed: 'gagal',
};

/** Penjelasan urutan pengiriman; kalimat ini wajib tampil apa adanya di halaman. */
const ORDER_NOTE =
  'Event dikirim berurutan. Bila penerima lambat, event berikutnya ditahan sebentar supaya urutannya tidak kacau.';

/** Pesan saat webhook ini belum punya riwayat pengiriman sama sekali. */
const EMPTY_NOTE = 'Belum ada riwayat pengiriman untuk webhook ini.';

/** Pesan sukses kirim ulang: menegaskan bahwa baris baru terpisah dari riwayat lama. */
const RESEND_NOTE =
  'Peristiwa dikirim sebagai baris baru, jadi riwayat lama tetap utuh. Muat ulang daftar untuk melihat baris baru itu.';

/** Satu baris riwayat pengiriman seperti yang dikirim server. */
type DeliveryRow = {
  id: string;
  webhookId?: string;
  event: string;
  payload?: unknown;
  status: string;
  attempts?: number;
  sequence?: number | null;
  resendOf?: string | null;
  deferrals?: number;
  responseStatus?: number | null;
  durationMs?: number | null;
  lastError?: string | null;
  jobId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deliveredAt?: string | null;
};

/** Ringkasan webhook yang dikirim bersama riwayatnya. */
type DeliveryWebhook = {
  id: string;
  url?: string;
  events?: string[];
  active?: boolean;
  createdAt?: string;
  lastStatus?: string | null;
  failureCount?: number;
  description?: string | null;
};

/** Jawaban GET /v1/webhooks/:id/deliveries. */
type DeliveriesResponse = {
  webhook?: DeliveryWebhook | null;
  deliveries?: DeliveryRow[] | null;
};

/** Jawaban POST /v1/webhooks/:id/deliveries/:deliveryId/resend (status 202). */
type ResendResponse = {
  delivery?: DeliveryRow | null;
  jobId?: string | null;
  note?: string | null;
};

/** Laporan pembersihan riwayat dari server. */
type CleanupReport = {
  cutoff?: string;
  candidates?: number;
  removed?: number;
  dryRun?: boolean;
};

/** Jawaban DELETE /v1/webhooks/:id/deliveries (mode kering maupun penghapusan betulan). */
type CleanupResponse = {
  report?: CleanupReport | null;
  note?: string | null;
};

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

/** Format tanggal dan jam Indonesia; nilai kosong atau tidak sah ditulis seadanya. */
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

/** Durasi milidetik yang mudah dibaca; nol atau kosong ditulis sebagai tanda hubung. */
function msText(value: unknown): string {
  const ms = num(value);
  if (ms <= 0) return '-';
  if (ms < 60_000) return numberText(ms) + ' ms';
  if (ms < 3_600_000) return numberText(ms) + ' ms (sekitar ' + numberText(Math.round(ms / 60_000)) + ' menit)';
  return numberText(ms) + ' ms (sekitar ' + numberText(Math.round(ms / 3_600_000)) + ' jam)';
}

/** Delapan huruf pertama sebuah id, dipakai untuk penanda di kolom yang sempit. */
function shortId(value: unknown): string {
  const raw = text(value);
  if (!raw) return '-';
  return raw.length > 8 ? raw.slice(0, 8) : raw;
}

/** Ya atau tidak untuk status aktif webhook. */
function activeText(value: unknown): string {
  return value === true ? 'aktif' : 'tidak aktif';
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/**
 * Peta kode galat server menjadi kalimat Indonesia yang ramah.
 * Urutan penting: kode yang lebih khusus diperiksa lebih dahulu.
 */
const ERROR_MAP: { codes: string[]; text: string }[] = [
  {
    codes: ['WEBHOOK_DELIVERY_NOT_FOUND'],
    text: 'Baris riwayat itu tidak ditemukan pada webhook ini. Muat ulang daftar riwayat.',
  },
  {
    codes: ['WEBHOOK_DELIVERY_PENDING'],
    text: 'Kiriman itu masih menunggu antrean, jadi belum bisa dikirim ulang. Tunggu sampai selesai, lalu coba lagi.',
  },
  { codes: ['WEBHOOK_NOT_FOUND'], text: 'Webhook dengan id itu tidak ditemukan. Periksa kembali id webhook Anda.' },
  { codes: ['OWNER_REQUIRED'], text: 'Hanya owner atau admin ruang kerja yang boleh mengurus riwayat pengiriman webhook.' },
  { codes: ['WORKSPACE_NOT_FOUND'], text: 'Ruang kerja tidak ditemukan.' },
  { codes: ['ADMIN_REQUIRED'], text: 'Hanya admin yang boleh membuka data ini.' },
  { codes: ['UNAUTHORIZED', 'UNAUTHENTICATED'], text: 'Sesi Anda sudah berakhir. Silakan masuk lagi.' },
  { codes: ['FORBIDDEN'], text: 'Anda tidak punya izin untuk tindakan ini.' },
  { codes: ['RATE_LIMIT', 'TOO_MANY_REQUESTS'], text: 'Terlalu banyak permintaan. Coba lagi sebentar.' },
  { codes: ['Failed to fetch', 'NetworkError'], text: 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.' },
];

/** Kode status HTTP yang muncul di dalam pesan galat api.ts. */
const HTTP_STATUS_MAP: Record<string, string> = {
  '400': 'Permintaan tidak sah. Periksa id webhook dan jumlah hari yang Anda isi.',
  '401': 'Sesi Anda sudah berakhir. Silakan masuk lagi.',
  '403': 'Anda tidak punya izin untuk tindakan ini.',
  '404': 'Data yang diminta tidak ditemukan.',
  '409': 'Kiriman itu masih menunggu antrean, jadi belum bisa dikirim ulang.',
  '429': 'Terlalu banyak permintaan. Coba lagi sebentar.',
};

/** Ubah galat apa pun menjadi satu kalimat Indonesia yang bisa dibaca pengguna. */
function errorText(error: unknown): string {
  const code = errorCode(error);
  for (const item of ERROR_MAP) {
    if (item.codes.some((needle) => code.includes(needle))) return item.text;
  }
  const status = code.match(/\b(400|401|403|404|409|429)\b/);
  if (status && HTTP_STATUS_MAP[status[1]]) return HTTP_STATUS_MAP[status[1]];
  return 'Permintaan riwayat webhook gagal diproses server. Coba lagi sebentar lagi.';
}

/** Sebutan status pengiriman; status tak dikenal ditampilkan apa adanya. */
function deliveryStatusLabel(value: unknown): string {
  const code = text(value).toLowerCase();
  return DELIVERY_STATUS_LABEL[code] ?? (code || 'tidak diketahui');
}

/** Kelas lencana sesuai status pengiriman. */
function deliveryChipClass(value: unknown): string {
  const code = text(value).toLowerCase();
  return CHIP + ' ' + (CHIP_STATUS[code] ?? CHIP_OFF);
}

/**
 * Halaman riwayat pengiriman webhook: input id webhook, tabel riwayat berurutan,
 * tombol kirim ulang per baris, dan pembersihan riwayat lama dua langkah.
 */
export function WebhookDeliveries({ webhookId }: Props) {
  // Id webhook yang sedang dipakai dan yang sudah dimuat dari server.
  const [idInput, setIdInput] = useState(text(webhookId));
  const [loadedId, setLoadedId] = useState('');

  // Data riwayat beserta keadaan muat dan galat pemuatan.
  const [webhook, setWebhook] = useState<DeliveryWebhook | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Pesan sukses aksi terakhir dan galat aksi kirim ulang.
  const [notice, setNotice] = useState('');
  const [resendError, setResendError] = useState('');
  const [resendBusyId, setResendBusyId] = useState('');

  // Kendali pembersihan riwayat: jumlah hari simpan, laporan mode kering, dan galatnya.
  const [daysInput, setDaysInput] = useState('');
  const [dryReport, setDryReport] = useState<CleanupReport | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState('');
  const [cleanupError, setCleanupError] = useState('');

  /** Muat riwayat pengiriman satu webhook; id kosong tidak dikirim ke server. */
  const load = useCallback(async (targetId: string): Promise<void> => {
    const id = text(targetId);
    if (!id) {
      setWebhook(null);
      setDeliveries([]);
      setLoadError('Isi id webhook lebih dahulu, lalu tekan "Muat riwayat".');
      return;
    }
    setLoading(true);
    setLoadError('');
    setResendError('');
    setDryReport(null);
    setCleanupError('');
    try {
      const data = await api.get<DeliveriesResponse>(
        '/v1/webhooks/' + encodeURIComponent(id) + '/deliveries?limit=' + String(HISTORY_LIMIT),
      );
      setWebhook(data?.webhook ?? null);
      setDeliveries(Array.isArray(data?.deliveries) ? (data!.deliveries as DeliveryRow[]) : []);
      setLoadedId(id);
    } catch (error) {
      // Jangan tampilkan data lama seolah masih sah: kosongkan bila permintaan gagal.
      setWebhook(null);
      setDeliveries([]);
      setLoadedId('');
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // Bila induk memberi id webhook, muat riwayatnya lebih dahulu.
  useEffect(() => {
    const initial = text(webhookId);
    if (!initial) return;
    setIdInput(initial);
    void load(initial);
  }, [webhookId, load]);

  /** Jumlah hari simpan yang sah dari kotak isian; 0 berarti pakai bawaan server. */
  function daysParam(): number | null {
    const raw = daysInput.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) return null;
    return Math.round(value);
  }

  /** Kirim ulang satu baris riwayat sebagai baris baru, lalu muat ulang daftar. */
  async function resend(row: DeliveryRow): Promise<void> {
    const id = loadedId || text(idInput);
    if (!id || !row?.id) return;
    setResendBusyId(row.id);
    setResendError('');
    setNotice('');
    try {
      const target =
        '/v1/webhooks/' +
        encodeURIComponent(id) +
        '/deliveries/' +
        encodeURIComponent(row.id) +
        '/resend';
      const result = await api.send<ResendResponse>(target, 'POST', {});
      const newId = text(result?.delivery?.id);
      const serverNote = text(result?.note);
      setNotice(
        'Kiriman ulang untuk peristiwa ' +
          (text(row.event) || 'tanpa nama') +
          ' sudah diantrekan' +
          (newId ? ' sebagai baris baru ' + shortId(newId) : ' sebagai baris baru') +
          '. ' +
          (serverNote || RESEND_NOTE),
      );
      await load(id);
    } catch (error) {
      setResendError(errorText(error));
    } finally {
      setResendBusyId('');
    }
  }

  /** Langkah pertama pembersihan: mode kering, hanya menghitung kandidat. */
  async function dryRunCleanup(): Promise<void> {
    const id = loadedId || text(idInput);
    if (!id) {
      setCleanupError('Muat riwayat lebih dahulu supaya id webhook yang dipakai jelas.');
      return;
    }
    setCleanupBusy('dry');
    setCleanupError('');
    setNotice('');
    try {
      const days = daysParam();
      const target =
        '/v1/webhooks/' +
        encodeURIComponent(id) +
        '/deliveries?dryRun=true' +
        (days === null ? '' : '&days=' + String(days));
      const result = await api.send<CleanupResponse>(target, 'DELETE');
      setDryReport(result?.report ?? null);
    } catch (error) {
      setDryReport(null);
      setCleanupError(errorText(error));
    } finally {
      setCleanupBusy('');
    }
  }

  /** Langkah kedua pembersihan: hapus betulan setelah laporan mode kering dilihat. */
  async function confirmCleanup(): Promise<void> {
    const id = loadedId || text(idInput);
    if (!id || !dryReport) return;
    setCleanupBusy('hapus');
    setCleanupError('');
    setNotice('');
    try {
      const days = daysParam();
      const target =
        '/v1/webhooks/' + encodeURIComponent(id) + '/deliveries' + (days === null ? '' : '?days=' + String(days));
      const result = await api.send<CleanupResponse>(target, 'DELETE');
      const report = result?.report ?? null;
      const serverNote = text(result?.note);
      setDryReport(null);
      setNotice(
        'Riwayat lama sudah dibersihkan: ' +
          numberText(report?.removed) +
          ' baris dihapus dari ' +
          numberText(report?.candidates) +
          ' kandidat (batas waktu ' +
          dateTimeText(report?.cutoff) +
          ').' +
          (serverNote ? ' ' + serverNote : ''),
      );
      await load(id);
    } catch (error) {
      setCleanupError(errorText(error));
    } finally {
      setCleanupBusy('');
    }
  }

  const activeId = loadedId || text(idInput);
  const hookEvents = webhook && Array.isArray(webhook.events) ? webhook.events : [];
  const busy = loading || cleanupBusy !== '';

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <h2 className="mb-2 text-base font-semibold text-slate-100">Riwayat pengiriman webhook</h2>
      <p className="mb-2 text-slate-400">
        Halaman ini menampilkan jejak pengiriman satu webhook dari yang paling baru. Setiap baris mencatat posisi
        urutannya, jumlah percobaan, jawaban penerima, dan galat terakhir. Untuk mencoba lagi satu peristiwa, pakai
        tombol "Kirim ulang" pada baris itu.
      </p>
      <p className="mb-3 text-slate-400">{ORDER_NOTE}</p>

      {notice ? <p className={'mb-3 ' + BANNER}>{notice}</p> : null}

      {/* Input id webhook dan tombol pemuatan riwayat. */}
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void load(idInput);
        }}
      >
        <label className="flex flex-col gap-1 text-slate-300">
          Id webhook
          <input
            className={FIELD}
            type="text"
            value={idInput}
            placeholder="Contoh: wh_1234abcd"
            aria-label="Id webhook yang riwayatnya dimuat"
            onChange={(event) => {
              setIdInput(event.target.value);
              setLoadError('');
            }}
          />
        </label>
        <button type="submit" className={BTN_PRIMARY} disabled={loading}>
          {loading ? 'Memuat…' : 'Muat riwayat'}
        </button>
        <button
          type="button"
          className={BTN}
          disabled={loading}
          onClick={() => {
            setIdInput('');
            setWebhook(null);
            setDeliveries([]);
            setLoadedId('');
            setLoadError('');
            setNotice('');
            setResendError('');
            setDryReport(null);
            setCleanupError('');
          }}
        >
          Bersihkan tampilan
        </button>
      </form>

      {loading ? <p className="mb-2 text-slate-400">Memuat riwayat pengiriman…</p> : null}
      {loadError ? <p className={'mb-2 ' + ERROR_BOX}>{loadError}</p> : null}

      {/* Ringkasan webhook yang sedang dibuka. */}
      {webhook ? (
        <div className={'mb-3 ' + CARD}>
          <div className={LABEL}>Webhook</div>
          <div className="font-mono text-slate-100">{text(webhook.url) || '-'}</div>
          <div className="mt-1 text-xs text-slate-400">
            Id {text(webhook.id) || '-'} · {activeText(webhook.active)} · dibuat {dateTimeText(webhook.createdAt)} ·
            status terakhir {deliveryStatusLabel(webhook.lastStatus)} · kegagalan beruntun{' '}
            {numberText(webhook.failureCount)}
          </div>
          {hookEvents.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {hookEvents.map((name) => (
                <span key={name} className={CHIP + ' ' + CHIP_RESEND}>
                  {name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Tabel riwayat pengiriman. */}
      {!loading && !loadError && loadedId && deliveries.length === 0 ? (
        <p className="mb-2 text-slate-400">{EMPTY_NOTE}</p>
      ) : null}

      {deliveries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th scope="col" className={TH} title="sequence">
                  Urutan (sequence)
                </th>
                <th scope="col" className={TH} title="event">Event</th>
                <th scope="col" className={TH} title="status, deferrals, resendOf">Status</th>
                <th scope="col" className={TH} title="attempts">Percobaan</th>
                <th scope="col" className={TH} title="responseStatus">Jawaban penerima</th>
                <th scope="col" className={TH} title="durationMs">Durasi</th>
                <th scope="col" className={TH} title="lastError">Galat terakhir</th>
                <th scope="col" className={TH} title="createdAt">Dibuat</th>
                <th scope="col" className={TH}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row, index) => {
                const held = num(row?.deferrals) > 0;
                const resendOf = text(row?.resendOf);
                return (
                  <tr key={text(row?.id) || String(index)}>
                    <td className={TD}>
                      {row?.sequence === null || row?.sequence === undefined ? '-' : numberText(row.sequence)}
                    </td>
                    <td className={'font-mono ' + TD + ' text-slate-100'}>{text(row?.event) || '-'}</td>
                    <td className={TD}>
                      <span className={deliveryChipClass(row?.status)}>{deliveryStatusLabel(row?.status)}</span>
                      {held ? (
                        <span className={'ml-2 ' + CHIP + ' ' + CHIP_HELD} title={'Ditahan ' + numberText(row?.deferrals) + ' kali karena penerima lambat.'}>
                          ditahan
                        </span>
                      ) : null}
                      {resendOf ? (
                        <span className={'ml-2 ' + CHIP + ' ' + CHIP_RESEND} title={'Kiriman ulang dari ' + resendOf}>
                          {'kiriman ulang dari ' + shortId(resendOf)}
                        </span>
                      ) : null}
                    </td>
                    <td className={TD}>{numberText(row?.attempts)}</td>
                    <td className={TD}>
                      {row?.responseStatus === null || row?.responseStatus === undefined
                        ? '-'
                        : numberText(row.responseStatus)}
                    </td>
                    <td className={TD}>{msText(row?.durationMs)}</td>
                    <td className={TD}>
                      {text(row?.lastError) ? (
                        <span className="block truncate" style={{ maxWidth: ERROR_CELL_MAX_WIDTH }} title={text(row?.lastError)}>
                          {text(row?.lastError)}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className={TD} title={text(row?.createdAt)}>
                      {dateTimeText(row?.createdAt)}
                      {text(row?.deliveredAt) ? (
                        <span className="block text-xs text-slate-400">
                          selesai {dateTimeText(row?.deliveredAt)}
                        </span>
                      ) : null}
                    </td>
                    <td className={TD}>
                      <button
                        type="button"
                        className={BTN}
                        disabled={busy || resendBusyId === text(row?.id)}
                        aria-label={'Kirim ulang pengiriman ' + shortId(row?.id) + ' (' + text(row?.event) + ')'}
                        title="Kirim peristiwa ini sekali lagi sebagai baris riwayat baru."
                        onClick={() => {
                          void resend(row);
                        }}
                      >
                        {resendBusyId === text(row?.id) ? 'Mengirim…' : 'Kirim ulang'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {resendError ? <p className={'mt-2 ' + ERROR_BOX}>{resendError}</p> : null}

      {/* Pembersihan riwayat lama: mode kering dulu, lalu konfirmasi kedua. */}
      <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">Bersihkan riwayat lama</h3>
      <div className={CARD}>
        <p className="mb-2 text-slate-400">
          Pembersihan hanya menyentuh baris yang sudah selesai (terkirim atau gagal) dan lebih tua dari batas waktu.
          Baris yang masih menunggu antrean tidak pernah dihapus. Langkah pertama hanya menghitung, belum menghapus.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-slate-300">
            Simpan riwayat (hari)
            <input
              className={FIELD}
              type="number"
              min={1}
              step={1}
              value={daysInput}
              placeholder="Bawaan server"
              aria-label="Jumlah hari riwayat webhook yang disimpan"
              onChange={(event) => {
                setDaysInput(event.target.value);
                setCleanupError('');
                setDryReport(null);
              }}
            />
          </label>
          <button
            type="button"
            className={BTN}
            disabled={busy || !activeId}
            onClick={() => {
              void dryRunCleanup();
            }}
          >
            {cleanupBusy === 'dry' ? 'Menghitung…' : 'Bersihkan riwayat lama'}
          </button>
          {dryReport ? (
            <button
              type="button"
              className={BTN_DANGER}
              disabled={busy}
              onClick={() => {
                void confirmCleanup();
              }}
            >
              {cleanupBusy === 'hapus'
                ? 'Menghapus…'
                : 'Ya, hapus ' + numberText(dryReport.candidates) + ' baris lama'}
            </button>
          ) : null}
          {dryReport ? (
            <button type="button" className={BTN} disabled={busy} onClick={() => setDryReport(null)}>
              Batal
            </button>
          ) : null}
        </div>

        {/* Hasil mode kering: kandidat dan batas waktunya, belum ada yang dihapus. */}
        {dryReport ? (
          <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-amber-100">
            <p>
              Mode kering: {numberText(dryReport.candidates)} baris memenuhi syarat untuk dihapus. Belum ada baris yang
              benar-benar dihapus.
            </p>
            <p className="mt-1 text-xs">
              Batas waktu: {dateTimeText(dryReport.cutoff)} · {'dryRun=' + (dryReport.dryRun ? 'true' : 'false')}
            </p>
            <p className="mt-1 text-xs">
              Tekan tombol konfirmasi di atas bila Anda setuju menghapus {numberText(dryReport.candidates)} baris itu.
            </p>
          </div>
        ) : null}

        {cleanupError ? <p className={'mt-2 ' + ERROR_BOX}>{cleanupError}</p> : null}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Kirim ulang tidak mengubah baris lama. Server membuat baris baru yang menunjuk ke baris asalnya, sehingga jejak
        pengiriman sebelumnya tetap bisa Anda periksa.
      </p>
    </section>
  );
}

export default WebhookDeliveries;

/**
 * Halaman "Perangkat & notifikasi peramban" (Wave 10, butir 26 + 31).
 *
 * Bagian A — Perangkat: daftar peramban yang pernah masuk ke akun ini. Pemilik akun bisa mengganti
 * nama perangkat, mencabut perangkat (semua sesi dari perangkat itu ikut berakhir; tombolnya dua
 * langkah supaya tidak tertekan tanpa sengaja), dan melihat gerbang verifikasi perangkat.
 * Admin platform melihat satu tombol tambahan untuk memblokir perangkat.
 *
 * Bagian B — Notifikasi peramban: keadaan kanal push, tombol menyalakan notifikasi di peramban ini,
 * daftar langganan, dan tombol kirim notifikasi uji. Bila peramban tidak mendukung push atau izin
 * ditolak, halaman menjelaskan alasannya dan TIDAK menampilkan tombol palsu.
 *
 * Catatan: halaman ini memakai `push-client.ts` untuk semua urusan izin dan langganan peramban.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { User } from './types';
import { batalkanLanggananPush, langgananPush, mintaIzinPush, pushDidukung } from './push-client';

/** Satu perangkat seperti yang dilaporkan GET /v1/account/devices. */
export type Device = {
  id: string;
  label: string;
  platform?: string | null;
  userAgent?: string | null;
  firstIp?: string | null;
  lastIp?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  seenCount?: number;
  trusted?: number | boolean;
  verifiedAt?: string | null;
  blockedAt?: string | null;
  blockedReason?: string | null;
  sessions?: number;
  current?: boolean;
};

/** Jawaban GET /v1/account/devices. */
export type DevicesResponse = {
  devices?: Device[];
  verifyRequired?: boolean;
  tracking?: boolean;
  mode?: string;
  limit?: number;
  note?: string;
};

/** Satu langganan push peramban seperti yang dilaporkan GET /v1/account/push. */
export type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh?: string;
  auth?: string;
  userAgent?: string | null;
  createdAt?: string;
  lastSeenAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  failures?: number;
  active?: number | boolean;
};

/** Jawaban GET /v1/account/push. */
export type PushState = {
  enabled?: boolean;
  publicKey?: string | null;
  subject?: string;
  subscriptions?: PushSubscriptionRow[];
  max?: number;
  stats?: Record<string, number>;
  note?: string;
};

/** Laporan POST /v1/account/push/test. */
export type PushTestReport = {
  configured?: boolean;
  subscriptions?: number;
  sent?: number;
  failed?: number;
  disabled?: number;
  skipped?: string;
};

/** Properti halaman: status admin platform dan pelapor galat dari induk. */
type Props = {
  isAdmin?: boolean;
  onError?: (message: string) => void;
};

/** Kelas Tailwind dasar tombol sekunder. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas tombol bahaya (cabut perangkat, hapus langganan, blokir). */
const BTN_DANGER =
  'rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 hover:bg-rose-500/20 disabled:opacity-50';
/** Kelas tombol kecil di dalam tabel. */
const BTN_SMALL = 'rounded-md border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-100 hover:bg-slate-700';
/** Kelas pembungkus kartu. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan informasi. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas kotak pesan sukses. */
const OK_BOX = 'rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-100';
/** Kelas kotak peringatan (perangkat diblokir, izin ditolak). */
const WARN_BOX = 'rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-amber-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas sel kepala dan badan tabel. */
const TH = 'border-b border-slate-700 px-3 py-2 text-left';
const TD = 'border-b border-slate-700/60 px-3 py-2 align-top';
/** Kelas dasar lencana kecil. */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Warna lencana: sekarang=violet, tepercaya=hijau, diblokir=merah, biasa=abu. */
const CHIP_CURRENT = 'border-violet-500/40 bg-violet-500/15 text-violet-100';
const CHIP_TRUSTED = 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100';
const CHIP_BLOCKED = 'border-rose-500/40 bg-rose-500/15 text-rose-100';
const CHIP_OFF = 'border-slate-600 bg-slate-700/40 text-slate-200';

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

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/** Terjemahkan kode galat server menjadi kalimat Indonesia yang ramah. */
function deviceErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('ADMIN_REQUIRED')) return 'Hanya admin platform yang boleh memblokir perangkat.';
  if (code.includes('DEVICE_NOT_FOUND')) return 'Perangkat itu sudah tidak ada di akun Anda. Muat ulang daftar.';
  if (code.includes('INVALID_LABEL')) return 'Nama perangkat tidak boleh kosong. Isi nama yang mudah Anda kenali.';
  if (code.includes('PUSH_DISABLED')) return 'Notifikasi peramban sedang dimatikan admin platform.';
  if (code.includes('PUSH_UNAVAILABLE')) return 'Kunci push belum siap di server. Coba lagi nanti.';
  if (code.includes('INVALID_SUBSCRIPTION')) return 'Data langganan dari peramban tidak lengkap. Coba nyalakan lagi notifikasi.';
  if (code.includes('TOO_MANY_SUBSCRIPTIONS')) return 'Jumlah peramban yang berlangganan sudah mencapai batas. Hapus satu langganan dulu.';
  if (code.includes('SUBSCRIPTION_NOT_FOUND')) return 'Langganan itu sudah tidak ada. Muat ulang daftar langganan.';
  if (code.includes('UNAUTHORIZED') || code.includes('UNAUTHENTICATED')) return 'Sesi Anda sudah berakhir. Silakan masuk lagi.';
  return 'Aksi gagal diproses. Periksa sambungan Anda, lalu coba lagi.';
}

/** Kalimat penjelasan arti mode gerbang perangkat dan kewajiban verifikasi saat ini. */
function penjelasanGerbang(mode: unknown, verifyRequired: unknown, tracking: unknown): string {
  const wajib = verifyRequired === true ? 'Saat ini verifikasi perangkat WAJIB.' : 'Saat ini verifikasi perangkat TIDAK wajib.';
  if (tracking === false) {
    return 'Pelacakan perangkat dimatikan, jadi perangkat tidak dicatat dan verifikasi tidak diminta. ' + wajib;
  }
  const kode = String(mode ?? '').toLowerCase();
  if (kode === 'on') {
    return 'Mode gerbang "on": setiap perangkat baru wajib diverifikasi lewat tautan email sebelum aksi AI diizinkan. ' + wajib;
  }
  if (kode === 'auto') {
    return 'Mode gerbang "auto": perangkat baru wajib diverifikasi bila pengiriman email di server aktif. ' + wajib;
  }
  if (kode === 'off') {
    return 'Mode gerbang "off": perangkat baru tetap dicatat dan diberi notifikasi, tetapi tidak wajib diverifikasi. ' + wajib;
  }
  return 'Mode gerbang perangkat tidak dikenal oleh halaman ini. ' + wajib;
}

/** Sebutan mode gerbang untuk lencana kecil. */
function modeLabel(mode: unknown): string {
  const kode = String(mode ?? '').toLowerCase();
  if (kode === 'on') return 'on (wajib verifikasi)';
  if (kode === 'auto') return 'auto (ikut pengaturan email)';
  if (kode === 'off') return 'off (tanpa verifikasi)';
  return String(mode ?? 'tidak diketahui');
}

/** Dua huruf terakhir id perangkat, supaya baris panjang tetap bisa dibedakan. */
function idPendek(id: unknown): string {
  const text = String(id ?? '');
  return text.length > 8 ? text.slice(0, 8) : text;
}

/** Ambil endpoint push peramban yang sedang dipakai; kosong bila tidak ada. */
async function endpointPerambanIni(): Promise<string> {
  if (!pushDidukung()) return '';
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return String(subscription?.endpoint ?? '');
  } catch {
    return '';
  }
}

/**
 * Halaman perangkat dan notifikasi peramban untuk pemilik akun; admin platform mendapat tombol blokir.
 */
export function DevicesPanel({ isAdmin, onError }: Props) {
  // Status admin: dipakai prop bila induk mengirimkannya; bila tidak, halaman memeriksa sendiri
  // lewat /v1/auth/me supaya tombol blokir tidak pernah muncul untuk akun biasa.
  const [adminSendiri, setAdminSendiri] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [gate, setGate] = useState<DevicesResponse | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState('');
  const [notice, setNotice] = useState('');

  // Penggantian nama perangkat.
  const [renameId, setRenameId] = useState('');
  const [renameLabel, setRenameLabel] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  // Pencabutan perangkat: langkah pertama hanya menyiapkan konfirmasi.
  const [revokeId, setRevokeId] = useState('');
  const [revokeBusy, setRevokeBusy] = useState('');

  // Pemblokiran perangkat (admin platform saja): langkah pertama juga hanya konfirmasi.
  const [blockId, setBlockId] = useState('');
  const [blockReason, setBlockReason] = useState('Diblokir admin platform.');
  const [blockBusy, setBlockBusy] = useState('');

  // Keadaan kanal notifikasi peramban.
  const [push, setPush] = useState<PushState | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushError, setPushError] = useState('');
  const [pushNotice, setPushNotice] = useState('');
  const [pushBusy, setPushBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [endpointIni, setEndpointIni] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testReport, setTestReport] = useState<PushTestReport | null>(null);
  const [removeBusy, setRemoveBusy] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  const fail = useCallback(
    (message: string): void => {
      onError?.(message);
    },
    [onError],
  );

  /** Muat daftar perangkat beserta keadaan gerbangnya. */
  const loadDevices = useCallback(async (): Promise<void> => {
    setDevicesLoading(true);
    setDevicesError('');
    try {
      const data = await api.get<DevicesResponse>('/v1/account/devices');
      setDevices(Array.isArray(data?.devices) ? data.devices : []);
      setGate(data ?? null);
    } catch (error) {
      setDevices([]);
      setGate(null);
      const message = deviceErrorMessage(error);
      setDevicesError(message);
      fail(message);
    } finally {
      setDevicesLoading(false);
    }
  }, [fail]);

  /** Muat keadaan kanal push, daftar langganan, dan endpoint peramban ini. */
  const loadPush = useCallback(async (): Promise<void> => {
    setPushLoading(true);
    setPushError('');
    try {
      const data = await api.get<PushState>('/v1/account/push');
      setPush(data ?? null);
      setPermission(pushDidukung() ? Notification.permission : 'denied');
      setEndpointIni(await endpointPerambanIni());
    } catch (error) {
      setPush(null);
      setPushError(deviceErrorMessage(error));
    } finally {
      setPushLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    void loadPush();
  }, [loadDevices, loadPush]);

  // Tentukan status admin bila induk tidak mengirim prop `isAdmin`.
  useEffect(() => {
    if (typeof isAdmin === 'boolean') return;
    let batal = false;
    void (async () => {
      try {
        const data = await api.me();
        if (!batal) setAdminSendiri(Boolean((data?.user as User | undefined)?.isAdmin));
      } catch {
        if (!batal) setAdminSendiri(false);
      }
    })();
    return () => {
      batal = true;
    };
  }, [isAdmin]);

  /** Buka formulir ganti nama perangkat. */
  function mulaiGantiNama(device: Device): void {
    setRenameId(device.id);
    setRenameLabel(String(device.label ?? ''));
    setNotice('');
    setDevicesError('');
  }

  /** Simpan nama baru perangkat, lalu muat ulang daftar. */
  async function simpanNama(deviceId: string): Promise<void> {
    const label = renameLabel.trim();
    if (!label) {
      setDevicesError('Nama perangkat tidak boleh kosong.');
      return;
    }
    setRenameBusy(true);
    setDevicesError('');
    try {
      await api.send<{ device: Device }>('/v1/account/devices/' + encodeURIComponent(deviceId), 'PATCH', { label });
      setRenameId('');
      setRenameLabel('');
      setNotice('Nama perangkat diperbarui menjadi "' + label + '".');
      await loadDevices();
    } catch (error) {
      const message = deviceErrorMessage(error);
      setDevicesError(message);
      fail(message);
    } finally {
      setRenameBusy(false);
    }
  }

  /** Cabut perangkat: semua sesi dari perangkat itu ikut berakhir. */
  async function cabutPerangkat(device: Device): Promise<void> {
    setRevokeBusy(device.id);
    setDevicesError('');
    try {
      const hasil = await api.send<{ sessionsRemoved?: number }>(
        '/v1/account/devices/' + encodeURIComponent(device.id),
        'DELETE',
      );
      setRevokeId('');
      setNotice(
        'Perangkat "' +
          String(device.label ?? '') +
          '" dicabut. ' +
          numberText(hasil?.sessionsRemoved) +
          ' sesi yang terikat perangkat itu diakhiri.',
      );
      await loadDevices();
    } catch (error) {
      const message = deviceErrorMessage(error);
      setDevicesError(message);
      fail(message);
    } finally {
      setRevokeBusy('');
    }
  }

  /** Blokir perangkat dari sisi admin platform (admin saja). */
  async function blokirPerangkat(device: Device): Promise<void> {
    setBlockBusy(device.id);
    setDevicesError('');
    try {
      const hasil = await api.send<{ sessionsRemoved?: number }>(
        '/v1/admin/devices/' + encodeURIComponent(device.id) + '/block',
        'POST',
        { reason: blockReason.trim() || 'Diblokir admin platform.' },
      );
      setBlockId('');
      setNotice(
        'Perangkat "' +
          String(device.label ?? '') +
          '" diblokir. ' +
          numberText(hasil?.sessionsRemoved) +
          ' sesi diakhiri.',
      );
      await loadDevices();
    } catch (error) {
      const message = deviceErrorMessage(error);
      setDevicesError(message);
      fail(message);
    } finally {
      setBlockBusy('');
    }
  }

  /** Nyalakan notifikasi di peramban ini: minta izin, berlangganan, lalu simpan ke server. */
  async function nyalakanNotifikasi(): Promise<void> {
    setPushBusy(true);
    setPushError('');
    setPushNotice('');
    setTestReport(null);
    try {
      if (!pushDidukung()) {
        setPushError(
          'Peramban ini tidak menyediakan notifikasi push (Notification atau PushManager tidak ada). Pakai peramban modern di koneksi aman (https atau localhost).',
        );
        return;
      }
      const izin = await mintaIzinPush();
      setPermission(izin);
      if (izin !== 'granted') {
        setPushError(
          izin === 'denied'
            ? 'Izin notifikasi untuk situs ini diblokir. Buka pengaturan situs di peramban Anda, izinkan notifikasi, lalu muat ulang halaman ini.'
            : 'Izin notifikasi belum diberikan, jadi peramban ini belum bisa menerima pemberitahuan.',
        );
        return;
      }
      const publicKey = String(push?.publicKey ?? '');
      if (!publicKey) {
        setPushError('Server belum menyiapkan kunci push publik. Coba lagi nanti atau hubungi admin platform.');
        return;
      }
      const langganan = await langgananPush(publicKey);
      if (!langganan) {
        setPushError('Langganan push tidak bisa dibuat di peramban ini. Bila langganan lama sudah dihapus di server, hentikan dulu langganan peramban ini lalu coba lagi.');
        return;
      }
      await api.send<{ subscription: PushSubscriptionRow }>('/v1/account/push/subscribe', 'POST', langganan);
      setPushNotice('Peramban ini sudah terdaftar. Pemberitahuan yang sama dengan notifikasi dalam aplikasi akan muncul di sini.');
      await loadPush();
    } catch (error) {
      const message = deviceErrorMessage(error);
      setPushError(message);
      fail(message);
    } finally {
      setPushBusy(false);
    }
  }

  /** Hapus satu langganan. Bila baris itu milik peramban ini, langganan peramban ikut dihentikan. */
  async function hapusLangganan(row: PushSubscriptionRow): Promise<void> {
    setRemoveBusy(row.id);
    setPushError('');
    setPushNotice('');
    try {
      await api.send<{ removed: boolean }>('/v1/account/push/subscriptions/' + encodeURIComponent(row.id), 'DELETE');
      const perambanIni = Boolean(endpointIni) && endpointIni === String(row.endpoint ?? '');
      if (perambanIni) await batalkanLanggananPush();
      setPushNotice(
        perambanIni
          ? 'Langganan dihapus dan notifikasi peramban ini dihentikan.'
          : 'Langganan dihapus. Peramban itu tidak lagi menerima pemberitahuan.',
      );
      await loadPush();
    } catch (error) {
      const message = deviceErrorMessage(error);
      setPushError(message);
      fail(message);
    } finally {
      setRemoveBusy('');
    }
  }

  /** Kirim notifikasi uji ke semua peramban yang berlangganan. */
  async function kirimUji(): Promise<void> {
    setTestBusy(true);
    setPushError('');
    setPushNotice('');
    try {
      const hasil = await api.send<{ report?: PushTestReport }>('/v1/account/push/test', 'POST');
      setTestReport(hasil?.report ?? null);
      await loadPush();
    } catch (error) {
      const message = deviceErrorMessage(error);
      setPushError(message);
      fail(message);
    } finally {
      setTestBusy(false);
    }
  }

  // Admin platform: prop menang bila ada, kalau tidak pakai hasil pemeriksaan sendiri.
  const adminPlatform = typeof isAdmin === 'boolean' ? isAdmin : adminSendiri === true;
  const langganan = Array.isArray(push?.subscriptions) ? push?.subscriptions ?? [] : [];
  const aktif = langganan.filter((row) => row.active === undefined || row.active === 1 || row.active === true).length;
  const max = num(push?.max);
  const langgananAktif = num(push?.stats?.activeSubscriptions) || aktif;
  const didukung = pushDidukung();
  const izinDitolak = didukung && permission === 'denied';
  const pushDimatikanServer = push !== null && push?.enabled === false;
  const batasPenuh = max > 0 && langgananAktif >= max;
  const tombolNyalakanNonaktif = pushBusy || !didukung || izinDitolak || pushDimatikanServer || batasPenuh || !String(push?.publicKey ?? '');

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-100">Perangkat & notifikasi peramban</h1>
        <p className="text-sm text-slate-400">
          Periksa peramban yang pernah masuk ke akun Anda, cabut yang tidak Anda kenali, dan atur
          notifikasi peramban.
        </p>
      </header>

      {notice ? <div className={OK_BOX}>{notice}</div> : null}

      <section className={CARD}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-100">Perangkat yang pernah masuk</h2>
            <p className="max-w-2xl text-sm text-slate-300">{penjelasanGerbang(gate?.mode, gate?.verifyRequired, gate?.tracking)}</p>
            <p className="text-xs text-slate-400">
              Mode gerbang: {modeLabel(gate?.mode)}. Batas perangkat per akun: {numberText(gate?.limit)}.
            </p>
            {gate?.note ? <p className="text-xs text-slate-400">{gate.note}</p> : null}
          </div>
          <button className={BTN} type="button" onClick={() => void loadDevices()} disabled={devicesLoading}>
            {devicesLoading ? 'Memuat...' : 'Segarkan'}
          </button>
        </div>

        {devicesError ? <div className={ERROR_BOX + ' mb-3'}>{devicesError}</div> : null}

        {!devicesLoading && devices.length === 0 ? (
          <div className={BANNER}>Belum ada perangkat yang tercatat untuk akun ini.</div>
        ) : null}

        {devices.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className={TH}>Perangkat</th>
                  <th className={TH}>Platform</th>
                  <th className={TH}>Alamat terakhir</th>
                  <th className={TH}>Terakhir terlihat</th>
                  <th className={TH}>Berapa kali</th>
                  <th className={TH}>Keadaan</th>
                  <th className={TH}>Aksi</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td className={TD}>
                      <div className="font-medium text-slate-100">{String(device.label ?? 'Perangkat tanpa nama')}</div>
                      <div className="text-xs text-slate-400">id {idPendek(device.id)}</div>
                      {renameId === device.id ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <input
                            className={FIELD}
                            value={renameLabel}
                            maxLength={60}
                            placeholder="Nama perangkat"
                            onChange={(event) => setRenameLabel(event.target.value)}
                          />
                          <button
                            className={BTN_SMALL}
                            type="button"
                            onClick={() => void simpanNama(device.id)}
                            disabled={renameBusy}
                          >
                            {renameBusy ? 'Menyimpan...' : 'Simpan'}
                          </button>
                          <button className={BTN_SMALL} type="button" onClick={() => setRenameId('')}>
                            Batal
                          </button>
                        </div>
                      ) : null}
                    </td>
                    <td className={TD}>{String(device.platform ?? '-')}</td>
                    <td className={TD}>{String(device.lastIp ?? '-')}</td>
                    <td className={TD}>{dateTimeText(device.lastSeenAt)}</td>
                    <td className={TD}>{numberText(device.seenCount)} kali</td>
                    <td className={TD}>
                      <div className="flex flex-wrap gap-1">
                        {device.current ? <span className={CHIP + ' ' + CHIP_CURRENT}>Perangkat ini</span> : null}
                        {device.blockedAt ? (
                          <span className={CHIP + ' ' + CHIP_BLOCKED} title={String(device.blockedReason ?? '')}>
                            diblokir
                          </span>
                        ) : null}
                        <span className={CHIP + ' ' + (device.trusted === 1 || device.trusted === true ? CHIP_TRUSTED : CHIP_OFF)}>
                          {device.trusted === 1 || device.trusted === true ? 'tepercaya' : 'belum tepercaya'}
                        </span>
                        <span className={CHIP + ' ' + (device.verifiedAt ? CHIP_TRUSTED : CHIP_OFF)}>
                          {device.verifiedAt ? 'terverifikasi ' + dateTimeText(device.verifiedAt) : 'belum diverifikasi'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{numberText(device.sessions)} sesi aktif dari perangkat ini</div>
                    </td>
                    <td className={TD}>
                      <div className="flex flex-wrap gap-2">
                        <button className={BTN_SMALL} type="button" onClick={() => mulaiGantiNama(device)}>
                          Ganti nama
                        </button>
                        {revokeId === device.id ? (
                          <>
                            <button
                              className={BTN_DANGER}
                              type="button"
                              onClick={() => void cabutPerangkat(device)}
                              disabled={revokeBusy === device.id}
                            >
                              {revokeBusy === device.id ? 'Mencabut...' : 'Ya, cabut sekarang'}
                            </button>
                            <button className={BTN_SMALL} type="button" onClick={() => setRevokeId('')}>
                              Batal
                            </button>
                          </>
                        ) : (
                          <button className={BTN_DANGER} type="button" onClick={() => setRevokeId(device.id)}>
                            Cabut
                          </button>
                        )}
                        {adminPlatform ? (
                          blockId === device.id ? (
                            <>
                              <input
                                className={FIELD}
                                value={blockReason}
                                maxLength={120}
                                placeholder="Alasan blokir"
                                onChange={(event) => setBlockReason(event.target.value)}
                              />
                              <button
                                className={BTN_DANGER}
                                type="button"
                                onClick={() => void blokirPerangkat(device)}
                                disabled={blockBusy === device.id}
                              >
                                {blockBusy === device.id ? 'Memblokir...' : 'Ya, blokir perangkat'}
                              </button>
                              <button className={BTN_SMALL} type="button" onClick={() => setBlockId('')}>
                                Batal
                              </button>
                            </>
                          ) : (
                            <button className={BTN_DANGER} type="button" onClick={() => setBlockId(device.id)}>
                              Blokir (admin)
                            </button>
                          )
                        ) : null}
                      </div>
                      {revokeId === device.id ? (
                        <p className="mt-1 text-xs text-amber-200">
                          Mencabut perangkat akan mengakhiri seluruh sesi dari perangkat itu. Tekan sekali lagi
                          untuk melanjutkan.
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="mt-2 text-xs text-slate-400">
          Bila perangkat dicabut, pemakainya harus masuk ulang. Perangkat yang sudah dicabut masih bisa masuk
          lagi sebagai perangkat baru.
        </p>
      </section>

      <section className={CARD}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-100">Notifikasi peramban</h2>
            <p className="text-sm text-slate-300">
              {pushLoading
                ? 'Memuat keadaan langganan...'
                : push?.enabled
                  ? 'Kanal notifikasi peramban aktif di server. Peramban yang berlangganan menerima pemberitahuan yang sama dengan lonceng di aplikasi.'
                  : 'Kanal notifikasi peramban sedang dimatikan di server, jadi tidak ada pemberitahuan yang dikirim.'}
            </p>
            <p className="text-xs text-slate-400">
              {numberText(langgananAktif)} dari {max > 0 ? numberText(max) : 'tanpa batas'} langganan aktif dipakai.
              {push?.subject ? ' Subjek kunci push: ' + String(push.subject) + '.' : ''}
            </p>
            {push?.note ? <p className="text-xs text-slate-400">{push.note}</p> : null}
          </div>
          <button className={BTN} type="button" onClick={() => void loadPush()} disabled={pushLoading}>
            {pushLoading ? 'Memuat...' : 'Segarkan'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className={BTN_PRIMARY} type="button" onClick={() => void nyalakanNotifikasi()} disabled={tombolNyalakanNonaktif}>
            {pushBusy ? 'Menyalakan...' : 'Nyalakan notifikasi di peramban ini'}
          </button>
          <button className={BTN} type="button" onClick={() => void kirimUji()} disabled={testBusy || langganan.length === 0}>
            {testBusy ? 'Mengirim...' : 'Kirim notifikasi uji'}
          </button>
        </div>

        {!didukung ? (
          <div className={WARN_BOX + ' mt-3'}>
            Peramban ini tidak mendukung notifikasi push: Notification atau PushManager tidak tersedia. Tombol
            menyalakan notifikasi dinonaktifkan karena tidak akan berhasil.
          </div>
        ) : null}
        {izinDitolak ? (
          <div className={WARN_BOX + ' mt-3'}>
            Izin notifikasi untuk situs ini diblokir di peramban Anda. Buka pengaturan situs, izinkan notifikasi,
            lalu muat ulang halaman ini.
          </div>
        ) : null}
        {didukung && permission === 'default' ? (
          <p className="mt-2 text-xs text-slate-400">
            Izin notifikasi belum diminta. Peramban akan menanyakan izin saat Anda menekan tombol di atas.
          </p>
        ) : null}
        {pushDimatikanServer ? (
          <div className={WARN_BOX + ' mt-3'}>
            Notifikasi peramban dimatikan admin platform, jadi server tidak menyediakan kunci push. Hubungi admin
            bila Anda memerlukannya.
          </div>
        ) : null}
        {!pushDimatikanServer && didukung && !String(push?.publicKey ?? '') && !pushLoading ? (
          <div className={WARN_BOX + ' mt-3'}>Server belum menyediakan kunci push publik, jadi peramban belum bisa berlangganan.</div>
        ) : null}
        {batasPenuh ? (
          <div className={WARN_BOX + ' mt-3'}>
            Jumlah langganan sudah mencapai batas {numberText(max)} peramban. Hapus satu langganan di bawah dulu.
          </div>
        ) : null}

        {pushError ? <div className={ERROR_BOX + ' mt-3'}>{pushError}</div> : null}
        {pushNotice ? <div className={OK_BOX + ' mt-3'}>{pushNotice}</div> : null}
        {testReport ? (
          <div className={BANNER + ' mt-3'}>
            Laporan uji: {numberText(testReport.sent)} berhasil, {numberText(testReport.failed)} gagal
            {num(testReport.disabled) > 0 ? ', ' + numberText(testReport.disabled) + ' langganan mati dimatikan otomatis' : ''}.
            {testReport.skipped ? ' Catatan server: ' + String(testReport.skipped) + '.' : ''}
          </div>
        ) : null}

        <div className="mt-4 space-y-2">
          <div className={LABEL}>Langganan tersimpan</div>
          {langganan.length === 0 ? (
            <div className={BANNER}>Belum ada peramban yang berlangganan notifikasi untuk akun ini.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className={TH}>Peramban</th>
                    <th className={TH}>Dibuat</th>
                    <th className={TH}>Terakhir sukses</th>
                    <th className={TH}>Kegagalan</th>
                    <th className={TH}>Keadaan</th>
                    <th className={TH}>Aksi</th>
                  </tr>
                </thead>
                <tbody className="text-slate-200">
                  {langganan.map((row) => {
                    const tidakAktif = row.active === 0 || row.active === false;
                    return (
                      <tr key={row.id}>
                        <td className={TD}>
                          <div className="max-w-md truncate text-xs text-slate-300" title={String(row.userAgent ?? row.endpoint ?? '')}>
                            {String(row.userAgent ?? 'Peramban tidak dikenal')}
                          </div>
                          <div className="text-xs text-slate-500">
                            endpoint ...{String(row.endpoint ?? '').slice(-24)}
                            {endpointIni && endpointIni === String(row.endpoint ?? '') ? ' (peramban ini)' : ''}
                          </div>
                        </td>
                        <td className={TD}>{dateTimeText(row.createdAt)}</td>
                        <td className={TD}>{dateTimeText(row.lastSuccessAt)}</td>
                        <td className={TD}>
                          {numberText(row.failures)} kali
                          {row.lastError ? <div className="text-xs text-rose-300">{String(row.lastError)}</div> : null}
                        </td>
                        <td className={TD}>
                          <span className={CHIP + ' ' + (tidakAktif ? CHIP_BLOCKED : CHIP_TRUSTED)}>
                            {tidakAktif ? 'tidak aktif' : 'aktif'}
                          </span>
                        </td>
                        <td className={TD}>
                          <button
                            className={BTN_DANGER}
                            type="button"
                            onClick={() => void hapusLangganan(row)}
                            disabled={removeBusy === row.id}
                          >
                            {removeBusy === row.id ? 'Menghapus...' : 'Hapus'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Langganan yang ditolak oleh peramban (jawaban 404 atau 410) dimatikan otomatis oleh server, dan tetap
          terlihat di daftar ini dengan keadaan "tidak aktif".
        </p>
      </section>
    </div>
  );
}

export default DevicesPanel;

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ApiKeyDocs, ApiKeyRow, PublicEndpoint, Workspace } from './api';

/** Properti halaman "Kunci API". Pesan galat diteruskan ke induk halaman. */
type Props = { onError: (message: string) => void };

/** Batas nama kunci yang dipakai server (API_KEY_NAME_MIN/MAX di apikeys.ts). */
const NAME_MIN = 2;
const NAME_MAX = 60;

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
/** Kelas kotak galat, sama dengan halaman Billing dan Privasi. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300';
/** Kotak mencolok untuk nilai kunci yang hanya tampil satu kali. */
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

/** Nilai kunci yang baru dibuat; nilai mentahnya tidak pernah dikirim server lagi. */
type CreatedKey = { name: string; secret: string; warning: string; workspaceId: string };

/** Batas pemakaian kunci dari server. */
type KeyLimits = {
  maxActive: number;
  rateLimitPerMinute: number;
  dailyRequestsDefault?: number;
  dailyTokensDefault?: number;
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

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ubah kode galat kunci API menjadi kalimat Indonesia yang jelas. */
function apiKeyErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('INVALID_KEY_NAME')) {
    return 'Nama kunci harus ' + NAME_MIN + '-' + NAME_MAX + ' karakter.';
  }
  if (code.includes('INVALID_KEY_SCOPES')) return 'Pilih minimal satu izin: baca (read) atau tulis (write).';
  if (code.includes('API_KEY_DAILY_REQUEST_LIMIT') || code.includes('API_KEY_DAILY_TOKEN_LIMIT')) {
    return 'Batas harian kunci ini sudah tercapai. Tunggu sampai besok, naikkan batasnya, atau pakai kunci lain.';
  }
  if (code.includes('SCOPE_NOT_AVAILABLE')) {
    return 'Izin itu belum tersedia di server ini. Muat ulang halaman lalu coba lagi.';
  }
  if (code.includes('WORKSPACE_NOT_FOUND')) {
    return 'Workspace itu tidak ditemukan untuk akun Anda. Pilih workspace lain, lalu coba lagi.';
  }
  if (code.includes('VIEWER_READ_ONLY')) {
    return 'Peran Anda di workspace ini hanya bisa membaca, jadi kunci API tidak bisa dibuat atau diubah.';
  }
  if (code.includes('TOO_MANY_API_KEYS')) {
    return 'Jumlah kunci aktif sudah mencapai batas akun. Cabut dulu salah satu kunci.';
  }
  if (code.includes('API_KEY_ALREADY_REVOKED')) return 'Kunci itu sudah dicabut sebelumnya. Muat ulang daftar kunci.';
  if (code.includes('API_KEY_NOT_FOUND')) {
    return 'Kunci itu tidak ada lagi di server. Muat ulang daftar kunci.';
  }
  if (code.includes('RATE_LIMIT') || code.includes('API_KEY_RATE_LIMITED')) {
    return 'Permintaan terlalu sering. Tunggu sebentar, lalu coba lagi.';
  }
  if (code.includes('UNAUTHORIZED') || code.includes('UNAUTHENTICATED') || code.includes('AUTH')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  }
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  }
  return fallback;
}

/** Daftar izin (scope) dari teks yang dipisah koma oleh server. */
function scopeList(scopes: unknown): string[] {
  return String(scopes ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/** Sebutan izin dalam Bahasa Indonesia; izin tak dikenal ditampilkan apa adanya. */
function scopeLabel(scope: string): string {
  if (scope === 'read') return 'baca (read)';
  if (scope === 'write') return 'tulis (write)';
  return scope;
}

/** Izin kunci sebagai satu kalimat; kosong ditulis "tidak diketahui". */
function scopesText(scopes: unknown): string {
  const items = scopeList(scopes);
  return items.length > 0 ? items.map(scopeLabel).join(', ') : 'tidak diketahui';
}

/** Kunci sudah dicabut bila server mengisi revokedAt. */
function isRevoked(row: ApiKeyRow): boolean {
  return Boolean(String(row?.revokedAt ?? '').trim());
}

/** Status kunci dalam Bahasa Indonesia. */
function statusLabel(row: ApiKeyRow): string {
  return isRevoked(row) ? 'Dicabut' : 'Aktif';
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

/** Satu kartu angka ringkas. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{value}</p>
    </div>
  );
}

/** Tabel satu kelompok endpoint publik (method, path, izin, keterangan). */
function EndpointTable({
  title,
  hint,
  rows,
  muted,
}: {
  title: string;
  hint: string;
  rows: PublicEndpoint[];
  muted: boolean;
}) {
  return (
    <div className="mt-3">
      <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
      <p className="settings-hint">{hint}</p>
      {rows.length === 0 ? (
        <p className="text-slate-400">Server belum melaporkan endpoint pada bagian ini.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table">
            <thead>
              <tr className="text-left text-slate-400">
                <th scope="col" className={TH}>
                  Metode
                </th>
                <th scope="col" className={TH}>
                  Path
                </th>
                <th scope="col" className={TH}>
                  Izin
                </th>
                <th scope="col" className={TH}>
                  Keterangan
                </th>
              </tr>
            </thead>
            <tbody className={muted ? 'text-slate-400' : 'text-slate-300'}>
              {rows.map((endpoint, index) => (
                <tr key={String(endpoint.method) + ' ' + String(endpoint.path) + '-' + index}>
                  <td className={TD}>{String(endpoint.method ?? '') || '-'}</td>
                  <td className={TD}>
                    <code className="break-all font-mono text-xs">{String(endpoint.path ?? '') || '-'}</code>
                  </td>
                  <td className={TD}>{scopeLabel(String(endpoint.scope ?? ''))}</td>
                  <td className={TD}>{String(endpoint.description ?? '') || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Halaman "Kunci API".
 *
 * Isinya: penjelasan singkat, formulir pembuatan kunci Bearer, kotak sekali tampil
 * untuk nilai kunci, tabel kunci yang sudah dibuat (ubah nama dan cabut), dan panel
 * dokumentasi API publik. Nilai kunci hanya tampil sekali dan tidak pernah disimpan
 * di peramban (tidak masuk localStorage); yang disimpan server hanya hash-nya.
 */
export function ApiKeys({ onError }: Props) {
  // Daftar kunci, catatan server, batas pemakaian, dan izin yang tersedia.
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [note, setNote] = useState('');
  const [limits, setLimits] = useState<KeyLimits | null>(null);
  const [scopesAvailable, setScopesAvailable] = useState<string[]>([]);

  // Dokumentasi API publik.
  const [docs, setDocs] = useState<ApiKeyDocs | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState('');

  // Daftar workspace untuk pilihan saat membuat kunci.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');

  // Formulir pembuatan kunci.
  const [name, setName] = useState('');
  const [readScope, setReadScope] = useState(true);
  // Wave 6: izin tulis sudah dilayani, dan setiap kunci boleh punya batas harian sendiri.
  const [writeScope, setWriteScope] = useState(false);
  const [dailyRequests, setDailyRequests] = useState('0');
  const [dailyTokens, setDailyTokens] = useState('0');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [copyState, setCopyState] = useState('');

  // Ubah nama per baris (satu baris terbuka sekaligus).
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');
  const [savingId, setSavingId] = useState('');

  // Wave 6: ubah batas harian per kunci (satu baris terbuka sekaligus).
  const [limitId, setLimitId] = useState<string | null>(null);
  const [limitRequests, setLimitRequests] = useState('0');
  const [limitTokens, setLimitTokens] = useState('0');
  const [limitSaving, setLimitSaving] = useState(false);
  const [limitError, setLimitError] = useState('');

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

  /** Muat ulang daftar kunci beserta catatan dan batasnya. */
  const loadKeys = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await api.apiKeys();
      setKeys(Array.isArray(result?.keys) ? result.keys : []);
      setNote(String(result?.note ?? ''));
      setLimits(result?.limits ?? null);
      setScopesAvailable(Array.isArray(result?.scopesAvailable) ? result.scopesAvailable : []);
    } catch (caught) {
      // Jangan tampilkan kunci lama seolah masih sah: kosongkan daftar bila gagal.
      setKeys([]);
      setNote('');
      setLimits(null);
      setScopesAvailable([]);
      fail(apiKeyErrorMessage(caught, 'Gagal memuat daftar kunci API. Coba muat ulang sebentar lagi.'));
    } finally {
      setLoading(false);
    }
  }, [fail]);

  /** Muat daftar workspace untuk pilihan saat membuat kunci. */
  const loadWorkspaces = useCallback(async (): Promise<void> => {
    try {
      const result = await api.workspaces();
      setWorkspaces(Array.isArray(result) ? result : []);
    } catch (caught) {
      setWorkspaces([]);
      fail(apiKeyErrorMessage(caught, 'Gagal memuat daftar workspace. Kunci akan memakai workspace utama akun.'));
    }
  }, [fail]);

  /** Muat dokumentasi API publik. */
  const loadDocs = useCallback(async (): Promise<void> => {
    setDocsLoading(true);
    setDocsError('');
    try {
      const result = await api.apiKeyDocs();
      setDocs(result ?? null);
    } catch (caught) {
      setDocs(null);
      setDocsError(apiKeyErrorMessage(caught, 'Gagal memuat dokumentasi API. Coba muat ulang sebentar lagi.'));
    } finally {
      setDocsLoading(false);
    }
  }, [fail]);

  // Muat seluruh data sekali saat halaman dibuka.
  useEffect(() => {
    void loadKeys();
    void loadWorkspaces();
    void loadDocs();
  }, [loadKeys, loadWorkspaces, loadDocs]);

  /** Buat kunci baru; nilai kunci mentah hanya ada pada jawaban ini. */
  async function createKey(): Promise<void> {
    const clean = name.trim();
    setFormError('');
    if (clean.length < NAME_MIN || clean.length > NAME_MAX) {
      const message = 'Nama kunci harus ' + NAME_MIN + '-' + NAME_MAX + ' karakter.';
      setFormError(message);
      return;
    }
    if (!readScope && !writeScope) {
      const message = 'Pilih minimal satu izin: baca (read) atau tulis (write).';
      setFormError(message);
      return;
    }
    const requestLimit = Math.max(0, Math.trunc(Number(dailyRequests) || 0));
    const tokenLimit = Math.max(0, Math.trunc(Number(dailyTokens) || 0));
    setCreating(true);
    try {
      const result = await api.createApiKey({
        name: clean,
        // Izin tulis otomatis menambahkan izin baca di server; daftar ini dikirim apa adanya.
        scopes: [...(readScope ? ['read'] : []), ...(writeScope ? ['write'] : [])],
        ...(workspaceId ? { workspaceId } : {}),
        // 0 berarti tanpa batas khusus untuk kunci ini.
        dailyRequestLimit: requestLimit,
        dailyTokenLimit: tokenLimit,
      });
      // Nilai kunci hanya disimpan di state halaman ini, bukan di localStorage.
      setCreated({
        name: String(result?.key?.name ?? clean),
        secret: String(result?.secret ?? ''),
        warning: String(result?.warning ?? ''),
        workspaceId: String(result?.workspaceId ?? workspaceId),
      });
      setCopyState('');
      setName('');
      setNotice('Kunci "' + clean + '" berhasil dibuat. Salin nilainya sekarang.');
      await loadKeys();
    } catch (caught) {
      const message = apiKeyErrorMessage(caught, 'Kunci gagal dibuat. Periksa nama dan izin, lalu coba lagi.');
      setFormError(message);
      fail(message);
    } finally {
      setCreating(false);
    }
  }

  /** Salin nilai kunci ke papan klip; nilai ini tidak disimpan di peramban. */
  async function copySecret(): Promise<void> {
    const secret = String(created?.secret ?? '');
    if (!secret) {
      setCopyState('Tidak ada nilai kunci untuk disalin.');
      return;
    }
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('CLIPBOARD_UNAVAILABLE');
      }
      await navigator.clipboard.writeText(secret);
      setCopyState('Nilai kunci sudah disalin ke papan klip.');
    } catch (caught) {
      const message =
        errorCode(caught) === 'CLIPBOARD_UNAVAILABLE'
          ? 'Peramban ini tidak mengizinkan salin otomatis. Salin nilainya secara manual dari kotak di atas.'
          : 'Nilai kunci gagal disalin. Salin secara manual dari kotak di atas.';
      setCopyState(message);
    }
  }

  /** Buka panel ubah nama untuk satu kunci. */
  function startEdit(row: ApiKeyRow): void {
    setEditId(row.id);
    setEditName(String(row.name ?? ''));
    setEditError('');
  }

  /** Tutup panel ubah nama. */
  function cancelEdit(): void {
    setEditId(null);
    setEditName('');
    setEditError('');
  }

  /** Simpan nama baru satu kunci, lalu muat ulang daftarnya. */
  async function saveName(row: ApiKeyRow): Promise<void> {
    const clean = editName.trim();
    if (clean.length < NAME_MIN || clean.length > NAME_MAX) {
      setEditError('Nama kunci harus ' + NAME_MIN + '-' + NAME_MAX + ' karakter.');
      return;
    }
    setSavingId(row.id);
    setEditError('');
    try {
      const result = await api.updateApiKey(row.id, { name: clean });
      setNotice('Nama kunci diubah menjadi "' + String(result?.key?.name ?? clean) + '".');
      cancelEdit();
      await loadKeys();
    } catch (caught) {
      const message = apiKeyErrorMessage(caught, 'Nama kunci gagal diubah. Coba lagi sebentar lagi.');
      setEditError(message);
      fail(message);
    } finally {
      setSavingId('');
    }
  }

  /** Cabut satu kunci setelah konfirmasi; pencabutan tidak bisa dibatalkan. */
  async function revokeKey(row: ApiKeyRow): Promise<void> {
    const confirmed = window.confirm(
      'Cabut kunci "' + String(row.name ?? '') + '"?\n\nSkrip atau integrasi yang memakai kunci ini langsung berhenti bekerja. Tindakan ini tidak bisa dibatalkan.',
    );
    if (!confirmed) return;
    setBusyId(row.id);
    try {
      await api.revokeApiKey(row.id);
      setNotice('Kunci "' + String(row.name ?? '') + '" sudah dicabut.');
      if (editId === row.id) cancelEdit();
      await loadKeys();
    } catch (caught) {
      fail(apiKeyErrorMessage(caught, 'Kunci gagal dicabut. Coba lagi sebentar lagi.'));
    } finally {
      setBusyId('');
    }
  }

  /** Buka editor batas harian untuk satu kunci. */
  function startLimit(row: ApiKeyRow): void {
    setLimitId(row.id);
    setLimitRequests(String(num(row.dailyRequestLimit)));
    setLimitTokens(String(num(row.dailyTokenLimit)));
    setLimitError('');
  }

  /** Tutup editor batas harian tanpa menyimpan. */
  function cancelLimit(): void {
    setLimitId(null);
    setLimitError('');
  }

  /** Simpan batas harian; 0 berarti tanpa batas khusus untuk kunci ini. */
  async function saveLimit(row: ApiKeyRow): Promise<void> {
    const requests = Math.max(0, Math.trunc(Number(limitRequests) || 0));
    const tokens = Math.max(0, Math.trunc(Number(limitTokens) || 0));
    setLimitSaving(true);
    setLimitError('');
    try {
      await api.updateApiKey(row.id, { dailyRequestLimit: requests, dailyTokenLimit: tokens });
      setNotice('Batas harian kunci "' + String(row.name ?? '') + '" sudah disimpan.');
      cancelLimit();
      await loadKeys();
    } catch (caught) {
      setLimitError(apiKeyErrorMessage(caught, 'Batas harian gagal disimpan. Coba lagi sebentar lagi.'));
    } finally {
      setLimitSaving(false);
    }
  }

  const activeCount = keys.filter((row) => !isRevoked(row)).length;
  const activeEndpoints = (docs?.endpoints ?? []).filter((endpoint) => endpoint.available !== false);
  const plannedEndpoints =
    docs?.plannedEndpoints ?? (docs?.endpoints ?? []).filter((endpoint) => endpoint.available === false);

  return (
    <section className="page-shell-inner text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">
            ⚿
          </span>
          Kunci API
        </h2>
        <p className="settings-hint">
          Kunci API adalah token Bearer untuk skrip dan integrasi di luar aplikasi ini. Nilai kunci hanya tampil satu
          kali saat dibuat; yang disimpan server hanya hash-nya, jadi nilai mentah tidak bisa ditampilkan lagi.
        </p>
      </header>

      {error ? <p className={ERROR_BOX}>{error}</p> : null}
      {notice ? <p className={BANNER}>{notice}</p> : null}

      {/* A. Buat kunci baru. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Buat kunci baru</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Nama kunci</span>
            <input
              className={FIELD + ' mt-1 w-full'}
              type="text"
              value={name}
              maxLength={NAME_MAX}
              placeholder="Contoh: skrip laporan harian"
              disabled={creating}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block">
            <span className={LABEL}>Workspace</span>
            <select
              className={FIELD + ' mt-1 w-full'}
              value={workspaceId}
              disabled={creating}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              <option value="">Workspace utama akun</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="settings-hint">
          Nama kunci {NAME_MIN}-{NAME_MAX} karakter. Kunci hanya bisa memakai data di workspace yang dipilih. Batas
          harian per kunci berguna untuk membatasi kerugian bila kunci bocor.
        </p>

        <div className="mt-1 flex flex-col gap-1">
          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={readScope}
              disabled={creating}
              onChange={(event) => setReadScope(event.target.checked)}
            />
            Izin baca (read) — membaca profil kunci, proyek, percakapan, pesan, pemakaian, dan artefak.
          </label>
          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={writeScope}
              disabled={creating}
              onChange={(event) => setWriteScope(event.target.checked)}
            />
            Izin tulis (write) — membuat percakapan dan mengirim pesan lewat API publik. Kunci tulis juga boleh
            membaca.
          </label>
        </div>

        {/* Wave 6: batas harian per kunci. 0 berarti tanpa batas khusus. */}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL}>Batas permintaan per hari</span>
            <input
              className={FIELD + ' mt-1 w-full'}
              type="number"
              min="0"
              step="1"
              value={dailyRequests}
              disabled={creating}
              onChange={(event) => setDailyRequests(event.target.value)}
            />
            <span className="settings-hint">0 = tanpa batas khusus. Isi 0 bila tidak yakin.</span>
          </label>
          <label className="block">
            <span className={LABEL}>Batas token per hari</span>
            <input
              className={FIELD + ' mt-1 w-full'}
              type="number"
              min="0"
              step="1"
              value={dailyTokens}
              disabled={creating}
              onChange={(event) => setDailyTokens(event.target.value)}
            />
            <span className="settings-hint">0 = tanpa batas khusus. Dihitung dari pemakaian token run kunci ini.</span>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={creating || (!readScope && !writeScope) || name.trim().length < NAME_MIN}
            onClick={() => {
              void createKey();
            }}
          >
            {creating ? 'Membuat…' : 'Buat kunci'}
          </button>
          <span className="text-xs text-slate-400">
            Kunci aktif: {numberText(activeCount)}
            {limits ? ' dari batas ' + numberText(limits.maxActive) : ''}
            {limits ? ' · batas laju ' + numberText(limits.rateLimitPerMinute) + ' permintaan/menit' : ''}
          </span>
        </div>
        {formError ? <p className={ERROR_BOX + ' mt-2'}>{formError}</p> : null}
      </div>

      {/* B. Nilai kunci: hanya tampil sekali, tidak pernah disimpan di peramban. */}
      {created ? (
        <div className={SECRET_BOX}>
          <p className="font-semibold">Kunci "{created.name}" sudah dibuat. Salin nilainya sekarang.</p>
          <p className="mt-1 text-xs">
            {created.warning || 'Nilai ini tidak bisa ditampilkan lagi setelah kotak ini ditutup.'}
          </p>
          <code className="mt-2 block break-all rounded-lg border border-amber-400/40 bg-slate-900/60 px-3 py-2 font-mono text-xs">
            {created.secret || 'server tidak mengirim nilai kunci'}
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
                setCreated(null);
                setCopyState('');
              }}
            >
              Tutup kotak ini
            </button>
            <span className="text-xs">{copyState}</span>
          </div>
          <p className="mt-2 text-xs">
            Nilai kunci ini tidak disimpan di peramban (tidak ada di localStorage) dan hilang saat halaman dimuat ulang.
            Di server hanya hash-nya yang tersimpan.
          </p>
        </div>
      ) : null}

      {/* C. Tabel kunci. */}
      <div className={CARD}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Kunci Anda</h3>
          <button
            type="button"
            className={BTN}
            disabled={loading}
            onClick={() => {
              void loadKeys();
            }}
          >
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>

        {limits ? (
          <div className="mb-2 grid gap-2 sm:grid-cols-3">
            <StatCard label="Kunci aktif" value={numberText(activeCount) + ' / ' + numberText(limits.maxActive)} />
            <StatCard label="Batas laju per menit" value={numberText(limits.rateLimitPerMinute) + ' permintaan'} />
            <StatCard
              label="Izin tersedia"
              value={scopesAvailable.length > 0 ? scopesAvailable.map(scopeLabel).join(', ') : 'baca (read)'}
            />
            <StatCard
              label="Batas bawaan per kunci"
              value={
                (num(limits.dailyRequestsDefault) > 0
                  ? numberText(limits.dailyRequestsDefault) + ' permintaan/hari'
                  : 'permintaan: tanpa batas') +
                ' · ' +
                (num(limits.dailyTokensDefault) > 0
                  ? numberText(limits.dailyTokensDefault) + ' token/hari'
                  : 'token: tanpa batas')
              }
            />
          </div>
        ) : null}
        {note ? <p className="settings-hint">{note}</p> : null}
        <p className="settings-hint">
          Kolom Batas harian memakai angka 0 untuk "tanpa batas khusus". Pemakaian token dihitung dari run yang
          memakai kunci itu pada hari ini. Kolom Prefix memuat 8 karakter heksadesimal dari nilai kunci. Nilai penuh
          selalu diawali
          <code className="font-mono"> ck_</code> dan hanya tampil sekali saat kunci dibuat, jadi pakai prefix ini untuk
          mengenali kunci yang dipakai skrip Anda.
        </p>

        {loading && keys.length === 0 ? <p className="text-slate-400">Memuat daftar kunci API…</p> : null}
        {!loading && keys.length === 0 ? (
          <p className="text-slate-400">
            Belum ada kunci API di akun ini. Buat kunci pertama Anda pada formulir di atas, lalu salin nilainya saat
            kotak kuning muncul.
          </p>
        ) : null}

        {keys.length > 0 ? (
          <div className="mt-2 overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>
                    Nama
                  </th>
                  <th scope="col" className={TH}>
                    Prefix
                  </th>
                  <th scope="col" className={TH}>
                    Izin
                  </th>
                  <th scope="col" className={TH}>
                    Dibuat
                  </th>
                  <th scope="col" className={TH}>
                    Terakhir dipakai
                  </th>
                  <th scope="col" className={TH}>
                    Jumlah permintaan
                  </th>
                  <th scope="col" className={TH}>
                    Batas harian
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Aksi
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((row) => {
                  const revoked = isRevoked(row);
                  const editing = editId === row.id;
                  const saving = savingId === row.id;
                  const busy = busyId === row.id;
                  return (
                    <tr key={row.id}>
                      <td className={TD}>
                        {editing ? (
                          <div className="flex flex-col gap-1">
                            <input
                              className={FIELD + ' w-full'}
                              type="text"
                              value={editName}
                              maxLength={NAME_MAX}
                              disabled={saving}
                              aria-label={'Nama baru untuk kunci ' + String(row.name ?? '')}
                              onChange={(event) => setEditName(event.target.value)}
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className={BTN}
                                disabled={saving}
                                onClick={() => {
                                  void saveName(row);
                                }}
                              >
                                {saving ? 'Menyimpan…' : 'Simpan'}
                              </button>
                              <button type="button" className={LINK_BTN} disabled={saving} onClick={cancelEdit}>
                                Batal
                              </button>
                            </div>
                            {editError ? <span className="text-xs text-rose-300">{editError}</span> : null}
                          </div>
                        ) : (
                          <span className="text-slate-100">{String(row.name ?? '') || '-'}</span>
                        )}
                      </td>
                      <td className={TD}>
                        <code className="font-mono text-xs">{String(row.prefix ?? '') || '-'}</code>
                      </td>
                      <td className={TD}>{scopesText(row.scopes)}</td>
                      <td className={TD}>{dateTimeText(row.createdAt)}</td>
                      <td className={TD}>
                        {dateTimeText(row.lastUsedAt)}
                        {row.lastUsedIp ? <span className="ml-1 text-xs text-slate-400">({row.lastUsedIp})</span> : null}
                      </td>
                      <td className={TD}>{numberText(row.requestCount)}</td>
                      <td className={TD}>
                        {limitId === row.id ? (
                          <div className="flex flex-col gap-1">
                            <label className="block text-xs text-slate-400">
                              Permintaan/hari
                              <input
                                className={FIELD + ' mt-1 w-full'}
                                type="number"
                                min="0"
                                step="1"
                                value={limitRequests}
                                disabled={limitSaving}
                                onChange={(event) => setLimitRequests(event.target.value)}
                              />
                            </label>
                            <label className="block text-xs text-slate-400">
                              Token/hari
                              <input
                                className={FIELD + ' mt-1 w-full'}
                                type="number"
                                min="0"
                                step="1"
                                value={limitTokens}
                                disabled={limitSaving}
                                onChange={(event) => setLimitTokens(event.target.value)}
                              />
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className={BTN}
                                disabled={limitSaving}
                                onClick={() => {
                                  void saveLimit(row);
                                }}
                              >
                                {limitSaving ? 'Menyimpan…' : 'Simpan batas'}
                              </button>
                              <button type="button" className={LINK_BTN} disabled={limitSaving} onClick={cancelLimit}>
                                Batal
                              </button>
                            </div>
                            {limitError ? <span className="text-xs text-rose-300">{limitError}</span> : null}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1">
                            <span className="text-slate-300">
                              {num(row.dailyRequestLimit) > 0
                                ? numberText(row.dailyRequestLimit) + ' permintaan/hari'
                                : 'Permintaan: tanpa batas khusus'}
                            </span>
                            <span className="text-slate-300">
                              {num(row.dailyTokenLimit) > 0
                                ? numberText(row.dailyTokenLimit) + ' token/hari'
                                : 'Token: tanpa batas khusus'}
                            </span>
                            <span className="text-xs text-slate-400">
                              Hari ini: {numberText(row.requestsToday)} permintaan · {numberText(row.tokensToday)} token
                            </span>
                            <button
                              type="button"
                              className={LINK_BTN}
                              disabled={revoked || busy || limitSaving}
                              title={revoked ? 'Kunci ini sudah dicabut' : 'Ubah batas harian kunci ini'}
                              onClick={() => startLimit(row)}
                            >
                              Ubah batas
                            </button>
                          </div>
                        )}
                      </td>
                      <td className={TD}>
                        <span className="badge">{statusLabel(row)}</span>
                        {revoked ? (
                          <span className="ml-1 block text-xs text-slate-400">
                            dicabut {dateTimeText(row.revokedAt)}
                          </span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className={LINK_BTN}
                            disabled={editing || saving || busy}
                            onClick={() => startEdit(row)}
                          >
                            Ubah nama
                          </button>
                          <button
                            type="button"
                            className="link-button danger"
                            disabled={revoked || busy}
                            title={revoked ? 'Kunci ini sudah dicabut' : 'Cabut kunci ini secara permanen'}
                            onClick={() => {
                              void revokeKey(row);
                            }}
                          >
                            {busy ? 'Mencabut…' : 'Cabut'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="settings-hint">
          Kunci yang dicabut tetap tercatat untuk jejak audit, tetapi tidak bisa dipakai lagi. Jumlah permintaan dan
          waktu pakai terakhir diisi server setiap kali kunci dipakai.
        </p>
      </div>

      {/* D. Dokumentasi API publik. */}
      <div className={CARD}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Dokumentasi API publik</h3>
          <button
            type="button"
            className={BTN}
            disabled={docsLoading}
            onClick={() => {
              void loadDocs();
            }}
          >
            {docsLoading ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>
        {docsError ? <p className={ERROR_BOX}>{docsError}</p> : null}
        {docsLoading && !docs ? <p className="text-slate-400">Memuat dokumentasi API…</p> : null}
        {!docsLoading && !docs ? (
          <p className="text-slate-400">Dokumentasi API belum tersedia. Tekan Muat ulang untuk mencoba lagi.</p>
        ) : null}

        {docs ? (
          <>
            <ul className="mb-2">
              <Row label="Awalan nilai kunci" value={String(docs.prefix ?? '') ? String(docs.prefix) + '_' : 'tidak diketahui'} />
              <Row
                label="Izin tersedia"
                value={
                  Array.isArray(docs.scopes) && docs.scopes.length > 0
                    ? docs.scopes.map((scope) => scopeLabel(String(scope))).join(', ')
                    : 'baca (read)'
                }
              />
              <Row label="Fase" value={String(docs.phase ?? '') || 'tidak diketahui'} />
              <Row
                label="Batas laju"
                value={numberText(docs.rateLimitPerMinute) + ' permintaan per menit per kunci'}
              />
              <Row label="Endpoint publik aktif" value={numberText(activeEndpoints.length) + ' rute'} />
            </ul>

            <EndpointTable
              title="Endpoint publik yang aktif"
              hint="Semua rute di bawah ini dilayani server. Rute berizin read hanya membaca; rute berizin write membuat percakapan atau mengirim pesan."
              rows={activeEndpoints}
              muted={false}
            />
            {/* Wave 6: tidak ada lagi rute tulis yang hanya berupa rencana, jadi panel ini hilang sendiri. */}
            {plannedEndpoints.length > 0 ? (
              <EndpointTable
                title="Direncanakan (belum tersedia)"
                hint="Rute ini belum dilayani server, jadi jangan dipakai dulu. Daftar ini hanya gambaran rencana fase berikutnya."
                rows={plannedEndpoints}
                muted
              />
            ) : null}

            <h4 className="mt-3 text-sm font-semibold text-slate-100">Contoh pemakaian</h4>
            <pre className={FIELD + ' mt-1 w-full overflow-x-auto whitespace-pre-wrap break-all border-slate-700 bg-slate-900/60 font-mono text-xs'}>
              {String(docs.example?.curl ?? '') || 'Server belum mengirim contoh curl.'}
            </pre>
            {docs.example?.note ? <p className="settings-hint">{String(docs.example.note)}</p> : null}
            <p className="settings-hint">
              Simpan kunci di tempat rahasia (variabel lingkungan atau brankas rahasia), bukan di kode yang dibagikan.
              Server hanya menyimpan hash-nya, jadi kunci yang hilang harus dicabut lalu dibuat ulang.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

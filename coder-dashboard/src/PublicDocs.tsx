import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { PublicApiDocs, PublicEndpoint } from './api';

/** Properti halaman "Dokumentasi API". Halaman ini terbuka tanpa sesi. */
type Props = { onError: (message: string) => void };

/** Kelas Tailwind dasar untuk tombol di halaman ini (mengikuti halaman Kunci API dan Webhook). */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas pembungkus kartu isi. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas kotak galat, sama dengan halaman lain. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300';
/** Kelas pita pemberitahuan netral. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala dan badan tabel. */
const TH = 'border-b border-slate-700 px-3 py-2 text-left';
const TD = 'border-b border-slate-700/60 px-3 py-2 align-top';
/** Kelas lencana kecil (izin, peristiwa, ketersediaan). */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Kelas blok kode (contoh permintaan). */
const CODE_BOX =
  'overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-200';

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Teks yang selalu berupa kalimat; nilai kosong ditulis sebagai tanda hubung. */
function text(value: unknown): string {
  const isi = String(value ?? '').trim();
  return isi.length > 0 ? isi : '-';
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/**
 * Peta kode galat server menjadi kalimat Indonesia.
 * Urutan penting: kode yang lebih khusus diperiksa lebih dahulu.
 */
const ERROR_MAP: { codes: string[]; text: string }[] = [
  { codes: ['UNAUTHORIZED', 'AUTH_REQUIRED'], text: 'Kunci API tidak dikirim atau tidak dikenal.' },
  { codes: ['RATE_LIMITED'], text: 'Terlalu banyak permintaan dari koneksi ini. Coba lagi sebentar lagi.' },
  { codes: ['NotFound', 'NOT_FOUND', '404'], text: 'Alamat dokumentasi tidak ditemukan. Muat ulang halaman ini.' },
  { codes: ['Failed to fetch', 'NetworkError', 'network'], text: 'Server tidak bisa dihubungi. Periksa koneksi Anda.' },
];

/** Ubah galat menjadi kalimat Indonesia yang bisa dibaca pengunjung. */
function messageOf(error: unknown): string {
  const code = errorCode(error);
  for (const entry of ERROR_MAP) {
    if (entry.codes.some((item) => code.includes(item))) return entry.text;
  }
  return 'Dokumentasi API tidak bisa dimuat (' + code + ').';
}

/** Label ramah untuk kunci batas pemakaian yang dikirim server. */
const LIMIT_LABELS: Record<string, string> = {
  maxKeys: 'Kunci aktif per akun',
  maxActive: 'Kunci aktif per akun',
  rateLimitPerMinute: 'Permintaan per menit per kunci',
  dailyRequestsDefault: 'Batas permintaan harian bawaan per kunci',
  dailyTokensDefault: 'Batas token harian bawaan per kunci',
  scopes: 'Izin yang tersedia',
};

/** Urutan tampilan batas supaya hasilnya selalu sama untuk semua pengunjung. */
const LIMIT_ORDER = ['maxKeys', 'maxActive', 'rateLimitPerMinute', 'dailyRequestsDefault', 'dailyTokensDefault'];
/* Catatan jujur: kunci `maxKeys` dan `maxActive` sengaja dibiarkan berdampingan karena server lama
   masih memakai nama pertama dan halaman lain memakai nama kedua; keduanya berisi angka yang sama. */

/** Nilai batas yang mudah dibaca; angka 0 berarti "tanpa batas khusus". */
function limitText(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'ya' : 'tidak';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  const angka = Number(value);
  if (Number.isFinite(angka)) return angka === 0 ? '0 (tanpa batas khusus)' : numberText(angka);
  return text(value);
}

/** Warna lencana izin: baca=biru, tulis=ungu. */
const CHIP_SCOPE: Record<string, string> = {
  read: 'border-sky-500/40 bg-sky-500/15 text-sky-100',
  write: 'border-violet-500/40 bg-violet-500/15 text-violet-100',
};
/** Warna lencana ketersediaan rute. */
const CHIP_AVAILABLE = 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100';
const CHIP_PLANNED = 'border-amber-400/60 bg-amber-400/10 text-amber-100';

/**
 * Halaman dokumentasi API publik.
 *
 * Halaman ini dipasang pada jalur `/docs` dan sengaja TIDAK membutuhkan sesi, jadi isinya hanya boleh
 * memuat keterangan yang memang publik: alamat dasar, cara memakai kunci, daftar rute, batas pemakaian,
 * bentuk webhook, dan daftar kode galat. Tidak ada rahasia, tidak ada data pengguna.
 */
export function PublicDocs({ onError }: Props) {
  const [data, setData] = useState<PublicApiDocs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk; galat tidak pernah ditelan. */
  const fail = useCallback(
    (message: string): void => {
      setError(message);
      onError(message);
    },
    [onError],
  );

  /** Muat dokumentasi dari server; halaman tetap bisa dibuka walau permintaan gagal. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await api.publicDocs();
      setData(result);
    } catch (caught) {
      fail(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Salin teks ke papan klip dengan pesan jujur bila peramban menolaknya. */
  const copy = useCallback(async (label: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied('Peramban menolak akses papan klip. Salin manual: ' + value);
    }
  }, []);

  const endpoints: PublicEndpoint[] = Array.isArray(data?.endpoints) ? data.endpoints : [];
  const events = Array.isArray(data?.webhook?.events) ? data.webhook.events : [];
  const headers = Array.isArray(data?.webhook?.headers) ? data.webhook.headers : [];
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const scopes = Array.isArray(data?.auth?.scopes) ? data.auth.scopes : [];
  const limits = data?.limits ?? {};
  const limitKeys = LIMIT_ORDER.filter((key) => limits[key] !== undefined);
  const firstEndpoint = endpoints[0];
  const curlExample = firstEndpoint
    ? 'curl -H "Authorization: ApiKey ck_CONTOH" \\\n  ' + text(data?.baseUrl) + text(firstEndpoint.path)
    : 'curl -H "Authorization: ApiKey ck_CONTOH" ' + text(data?.baseUrl);

  return (
    <section className="page-shell mx-auto w-full max-w-4xl space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-100">Dokumentasi API</h1>
        <p className="text-sm text-slate-400">
          Halaman ini terbuka tanpa akun. Isinya keterangan publik: alamat dasar, cara memakai kunci, daftar rute,
          batas pemakaian, bentuk webhook, dan daftar kode galat. Tidak ada rahasia dan tidak ada data pengguna di sini.
        </p>
      </header>

      <div className={BANNER}>
        <strong className="text-slate-100">{text(data?.product)}</strong>{' '}
        <span className="text-slate-300">versi {text(data?.version)}</span>
      </div>

      {error ? <p className={ERROR_BOX}>{error}</p> : null}
      {loading && !data ? <p className="text-sm text-slate-400">Memuat dokumentasi…</p> : null}
      {copied ? <p className="text-sm text-emerald-300">{copied}</p> : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className={CARD}>
          <p className={LABEL}>Alamat dasar</p>
          <p className="break-all text-sm text-slate-100">{text(data?.baseUrl)}</p>
          <button
            type="button"
            className={BTN + ' mt-2'}
            onClick={() => void copy('Alamat dasar disalin.', text(data?.baseUrl))}
          >
            Salin alamat
          </button>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Cara memakai kunci</p>
          <p className="text-sm text-slate-100">
            Skema <strong>{text(data?.auth?.scheme)}</strong> pada header <strong>{text(data?.auth?.header)}</strong>.
          </p>
          <p className="mt-1 break-all text-xs text-slate-300">{text(data?.auth?.example)}</p>
          <p className="mt-1 text-xs text-slate-400">{text(data?.auth?.note)}</p>
          <p className="mt-2 flex flex-wrap gap-1">
            {scopes.map((scope) => (
              <span key={scope} className={CHIP + ' ' + (CHIP_SCOPE[scope] ?? 'border-slate-600 text-slate-200')}>
                {scope}
              </span>
            ))}
          </p>
        </div>
      </div>

      <div className={CARD}>
        <p className={LABEL}>Contoh permintaan</p>
        <pre className={CODE_BOX + ' mt-1'}>{curlExample}</pre>
        <p className="mt-1 text-xs text-slate-400">
          Ganti <code>ck_CONTOH</code> dengan kunci sungguhan. Nilai kunci hanya tampil sekali saat dibuat di halaman
          Kunci API, jadi simpanlah di tempat yang aman.
        </p>
        <button type="button" className={BTN + ' mt-2'} onClick={() => void copy('Contoh permintaan disalin.', curlExample)}>
          Salin contoh
        </button>
      </div>

      <div className={CARD}>
        <p className={LABEL}>Rute yang tersedia ({numberText(endpoints.length)})</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Metode</th>
                <th className={TH}>Jalur</th>
                <th className={TH}>Izin</th>
                <th className={TH}>Keterangan</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((row) => {
                const tersedia = row.available !== false;
                return (
                  <tr key={row.method + row.path}>
                    <td className={TD}>
                      <span className={CHIP + ' border-slate-600 text-slate-200'}>{row.method}</span>
                    </td>
                    <td className={TD}>
                      <span className="break-all font-mono text-xs text-slate-100">{row.path}</span>
                      <p className="mt-1">
                        <span className={CHIP + ' ' + (tersedia ? CHIP_AVAILABLE : CHIP_PLANNED)}>
                          {tersedia ? 'aktif' : 'rencana'}
                        </span>
                      </p>
                    </td>
                    <td className={TD}>
                      <span className={CHIP + ' ' + (CHIP_SCOPE[row.scope] ?? 'border-slate-600 text-slate-200')}>
                        {text(row.scope)}
                      </span>
                    </td>
                    <td className={TD + ' text-slate-300'}>{text(row.description)}</td>
                  </tr>
                );
              })}
              {endpoints.length === 0 ? (
                <tr>
                  <td className={TD + ' text-slate-400'} colSpan={4}>
                    Belum ada rute publik yang dilaporkan server.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className={CARD}>
        <p className={LABEL}>Batas pemakaian</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {limitKeys.map((key) => (
            <div key={key} className="rounded-lg border border-slate-700/60 p-2">
              <p className="text-xs text-slate-400">{LIMIT_LABELS[key] ?? key}</p>
              <p className="text-sm text-slate-100">{limitText(limits[key])}</p>
            </div>
          ))}
          {limitKeys.length === 0 ? <p className="text-sm text-slate-400">Server belum melaporkan batas pemakaian.</p> : null}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Batas berlaku untuk satu kunci API, bukan untuk seluruh akun. Batas yang lebih ketat bisa dipasang pada kunci
          tertentu dan bisa diperiksa di halaman Kunci API.
        </p>
      </div>

      <div className={CARD}>
        <p className={LABEL}>Webhook keluar</p>
        <p className="mt-1 text-sm text-slate-100">
          {data?.webhook?.enabled === true ? 'Aktif' : 'Belum aktif'} — platform mengirim peristiwa ke alamat Anda.
        </p>
        <p className="mt-1 flex flex-wrap gap-1">
          {events.map((peristiwa) => (
            <span key={peristiwa} className={CHIP + ' border-slate-600 text-slate-200'}>
              {peristiwa}
            </span>
          ))}
        </p>
        <div className="mt-2 space-y-1 text-sm text-slate-300">
          <p>
            Header tanda tangan: <span className="font-mono text-xs text-slate-100">{text(data?.webhook?.signatureHeader)}</span>
          </p>
          <p>Bentuk tanda tangan: {text(data?.webhook?.signatureFormat)}</p>
          <p className="text-xs text-slate-400">Header lain: {headers.map((item) => text(item)).join(', ') || '-'}</p>
          <p className="text-xs text-slate-400">
            Percobaan ulang: {numberText(data?.webhook?.retries?.attempts)} kali, jeda {text(data?.webhook?.retries?.backoffSeconds)},
            batas tunggu {numberText(data?.webhook?.retries?.timeoutMs)} ms.
          </p>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Rahasia penandatanganan hanya ditampilkan sekali saat webhook dibuat, dan tidak pernah dimuat di halaman ini.
        </p>
      </div>

      <div className={CARD}>
        <p className={LABEL}>Kode galat ({numberText(errors.length)})</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Kode</th>
                <th className={TH}>Arti</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((row) => (
                <tr key={row.code}>
                  <td className={TD + ' font-mono text-xs text-slate-100'}>{text(row.code)}</td>
                  <td className={TD + ' text-slate-300'}>{text(row.meaning)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={CARD}>
        <p className={LABEL}>Catatan jujur</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li>Halaman ini menyajikan keterangan publik saja; data akun, token, dan rahasia webhook tidak pernah dimuat.</li>
          <li>Bila daftar rute belum lengkap, server memang belum melaporkannya — bukan halaman ini yang menyembunyikan.</li>
          <li>
            Batas laju disimpan di memori proses, jadi angkanya bisa berbeda sesaat setelah platform dijalankan ulang.
          </li>
        </ul>
        <button type="button" className={BTN + ' mt-3'} disabled={loading} onClick={() => void load()}>
          {loading ? 'Memuat…' : 'Muat ulang'}
        </button>
      </div>
    </section>
  );
}

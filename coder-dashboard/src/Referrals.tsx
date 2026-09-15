import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ReferralRow, ReferralStatus, ReferralSummary } from './api';

/** Properti halaman "Undangan". Pesan galat diteruskan ke induk halaman. */
type Props = { onError: (message: string) => void };

/** Jumlah baris undangan paling banyak yang ditampilkan di tabel. */
const ROW_LIMIT = 50;

/** Lama tampilan konfirmasi "Tersalin" dalam milidetik. */
const COPY_FEEDBACK_MS = 2000;

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi menonjol. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas pembungkus kartu isi. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan (pemberitahuan biasa). */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas pita peringatan untuk program undangan yang sedang dimatikan admin. */
const WARN_BOX = 'rounded-lg border border-amber-400/60 bg-amber-400/10 px-3 py-2 text-amber-100';
/** Kelas kotak galat, sama dengan halaman Webhook dan Billing. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala dan badan tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
const TD = 'border-b border-slate-700/60 px-3 py-2';
/** Kotak gelap untuk kode dan tautan undangan. */
const MONO_BOX =
  'block break-all rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs text-slate-100';

/** Kelas dasar lencana kecil status undangan. */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Warna lencana per status undangan. */
const CHIP_STATUS: Record<ReferralStatus, string> = {
  pending: 'border-amber-400/40 bg-amber-400/15 text-amber-100',
  qualified: 'border-sky-500/40 bg-sky-500/15 text-sky-100',
  rewarded: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100',
  blocked: 'border-rose-500/40 bg-rose-500/15 text-rose-100',
};
/** Lencana abu-abu netral untuk status yang tidak dikenal. */
const CHIP_OFF = 'border-slate-600 bg-slate-700/40 text-slate-200';

/** Sebutan status undangan dalam Bahasa Indonesia. */
const STATUS_LABEL: Record<ReferralStatus, string> = {
  pending: 'Menunggu run pertama',
  qualified: 'Lolos syarat',
  rewarded: 'Hadiah sudah cair',
  blocked: 'Ditolak',
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
  return String(error instanceof Error ? error.message : error);
}

/**
 * Peta kode galat server menjadi kalimat Indonesia.
 * Urutan penting: kode yang lebih khusus harus diperiksa lebih dahulu.
 */
const ERROR_MAP: { codes: string[]; text: string }[] = [
  {
    codes: ['REFERRAL_CODE_REQUIRED'],
    text: 'Kode undangan wajib diisi.',
  },
  {
    codes: ['REFERRAL_CODE_NOT_FOUND'],
    text: 'Kode undangan itu tidak ditemukan. Periksa kembali penulisannya atau minta kode baru kepada pengundang Anda.',
  },
  {
    codes: ['REFERRAL_SELF'],
    text: 'Anda tidak bisa memakai kode undangan Anda sendiri. Bagikan kode itu kepada orang lain.',
  },
  {
    codes: ['REFERRAL_ALREADY_RECORDED'],
    text: 'Undangan untuk akun ini sudah pernah tercatat, jadi kode baru tidak bisa dipakai lagi.',
  },
  {
    codes: ['REFERRAL_DISABLED'],
    text: 'Program undangan sedang dimatikan admin. Kode tidak bisa dipakai dan tidak ada hadiah yang keluar.',
  },
  {
    codes: ['REFERRAL_CODE_FAILED'],
    text: 'Server gagal membuat kode undangan baru. Kode lama Anda masih berlaku; coba lagi sebentar lagi.',
  },
  {
    codes: ['RATE_LIMITED', 'RATE_LIMIT', 'TOO_MANY_REQUESTS'],
    text: 'Terlalu banyak permintaan dalam waktu singkat. Tunggu sebentar, lalu coba lagi.',
  },
  {
    codes: ['UNAUTHORIZED', 'UNAUTHENTICATED'],
    text: 'Sesi Anda sudah berakhir. Silakan masuk lagi.',
  },
  { codes: ['FORBIDDEN'], text: 'Anda tidak punya izin untuk tindakan ini.' },
  {
    codes: ['Failed to fetch', 'NetworkError'],
    text: 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.',
  },
];

/** Kode status HTTP yang dikirim api.ts di dalam pesan "Request gagal (kode)". */
const HTTP_STATUS_MAP: Record<string, string> = {
  '401': 'Sesi Anda sudah berakhir. Silakan masuk lagi.',
  '403': 'Anda tidak punya izin untuk tindakan ini.',
  '404': 'Data undangan tidak ditemukan di server.',
  '429': 'Terlalu banyak permintaan dalam waktu singkat. Tunggu sebentar, lalu coba lagi.',
};

/**
 * Ubah galat apa pun (kode server, galat jaringan, atau kode status HTTP)
 * menjadi satu kalimat Indonesia yang bisa dibaca pemakai.
 */
function errorText(error: unknown): string {
  const caught = errorCode(error);
  for (const item of ERROR_MAP) {
    if (item.codes.some((needle) => caught.includes(needle))) return item.text;
  }
  const status = caught.match(/\b(401|403|404|429)\b/);
  if (status && HTTP_STATUS_MAP[status[1]]) return HTTP_STATUS_MAP[status[1]];
  const clean = caught.trim();
  return clean
    ? 'Permintaan undangan gagal diproses server. Coba lagi sebentar lagi (kode: ' + clean + ').'
    : 'Permintaan undangan gagal diproses server. Coba lagi sebentar lagi.';
}

/** Status undangan yang dikenal server; nilai lain dikembalikan sebagai string kosong. */
function statusKey(value: unknown): ReferralStatus | '' {
  const code = String(value ?? '').trim().toLowerCase();
  if (code === 'pending' || code === 'qualified' || code === 'rewarded' || code === 'blocked') return code;
  return '';
}

/** Sebutan status; status tak dikenal ditampilkan apa adanya supaya tidak menyesatkan. */
function statusLabel(value: unknown): string {
  const key = statusKey(value);
  if (key) return STATUS_LABEL[key];
  const code = String(value ?? '').trim();
  return code || 'tidak diketahui';
}

/** Kelas lencana sesuai status undangan. */
function statusChipClass(value: unknown): string {
  const key = statusKey(value);
  return CHIP + ' ' + (key ? CHIP_STATUS[key] : CHIP_OFF);
}

/** Tanggal hadiah: pakai waktu cair, kalau belum ada pakai waktu lolos syarat. */
function rewardDateText(row: ReferralRow): string {
  if (String(row.rewardedAt ?? '').trim()) return dateTimeText(row.rewardedAt);
  if (String(row.qualifiedAt ?? '').trim()) return dateTimeText(row.qualifiedAt);
  return '-';
}

/** Keterangan singkat tahap hadiah pada kolom "Hadiah diterima". */
function rewardStageText(row: ReferralRow): string {
  if (String(row.rewardedAt ?? '').trim()) return 'hadiah cair';
  if (String(row.qualifiedAt ?? '').trim()) return 'lolos syarat, hadiah belum cair';
  return 'belum ada hadiah';
}

/** Surel orang yang diundang; server boleh tidak mengirimkannya. */
function inviteeText(row: ReferralRow): string {
  const email = String(row.inviteeEmail ?? '').trim();
  return email || 'tidak dikirim server';
}

/** Satu kartu angka ringkas pada baris statistik undangan. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{value}</p>
    </div>
  );
}

/** Satu baris keterangan "label: nilai" untuk kotak hadiah dan status undangan. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="text-slate-400">{label}:</span>
      <span className="text-slate-100">{value}</span>
    </li>
  );
}

/** Kalimat status untuk undangan yang Anda terima sendiri (panel "Anda diundang oleh"). */
function invitedByText(row: ReferralRow): string {
  const key = statusKey(row.status);
  if (key === 'pending') {
    return 'Undangan Anda masih menunggu. Hadiah untuk pengundang Anda baru keluar setelah Anda menyelesaikan run pertama.';
  }
  if (key === 'qualified') {
    return 'Anda sudah menyelesaikan run pertama, jadi syarat hadiah terpenuhi. Hadiah untuk pengundang Anda belum dicairkan server saat data ini dimuat.';
  }
  if (key === 'rewarded') {
    return (
      'Hadiah undangan ini sudah cair.' +
      (num(row.inviteeTokens) > 0 ? ' Anda menerima ' + numberText(row.inviteeTokens) + ' token.' : '')
    );
  }
  if (key === 'blocked') {
    const reason = String(row.blockedReason ?? '').trim();
    return (
      'Undangan ini ditolak sistem' +
      (reason ? ' dengan alasan ' + reason : '') +
      '. Tidak ada hadiah yang dibayarkan untuk undangan ini.'
    );
  }
  return 'Status undangan tidak dikenal: ' + statusLabel(row.status) + '.';
}

/**
 * Halaman "Undangan" (program referral).
 *
 * Isinya: kode undangan dan tautan yang bisa disalin, tombol ganti kode, pita peringatan
 * saat program dimatikan admin, baris statistik undangan, kotak hadiah yang berlaku,
 * panel undangan yang Anda terima sendiri, tabel undangan terakhir, dan kotak keterangan
 * jujur tentang cara hadiah keluar beserta batas yang diakui sistem.
 */
export function Referrals({ onError }: Props) {
  // Ringkasan undangan dari server; null berarti server belum menjawab.
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Konfirmasi salin: target menentukan tombol mana yang berubah menjadi "Tersalin". */
  const [copyNote, setCopyNote] = useState<{ target: '' | 'code' | 'link'; text: string }>({ target: '', text: '' });
  /** Pewaktu yang menghapus konfirmasi "Tersalin" setelah dua detik. */
  const copyTimer = useRef<number | null>(null);

  /** Catat galat di halaman ini dan teruskan ke induk; galat tidak pernah ditelan. */
  const fail = useCallback(
    (message: string): void => {
      setError(message);
      onError(message);
    },
    [onError],
  );

  /** Muat ringkasan undangan dari server. */
  const loadSummary = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await api.referralMe();
      setSummary(result ?? null);
    } catch (caught) {
      // Data lama dibuang supaya tidak terlihat seolah masih sah.
      setSummary(null);
      fail(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, [fail]);

  // Ringkasan undangan dimuat sekali saat halaman dibuka.
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // Pewaktu konfirmasi salin dibersihkan saat halaman ditutup.
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  /** Salin kode atau tautan ke papan klip; konfirmasi "Tersalin" tampil sekitar dua detik. */
  const copyValue = useCallback(
    async (value: string, target: 'code' | 'link'): Promise<void> => {
      const text = value.trim();
      const yang = target === 'code' ? 'kode' : 'tautan';
      if (!text) {
        setCopyNote({
          target: '',
          text: 'Server belum mengirim ' + yang + ' undangan, jadi tidak ada yang bisa disalin.',
        });
        return;
      }
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          throw new Error('CLIPBOARD_UNAVAILABLE');
        }
        await navigator.clipboard.writeText(text);
        setCopyNote({ target, text: 'Tersalin' });
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => {
          setCopyNote({ target: '', text: '' });
          copyTimer.current = null;
        }, COPY_FEEDBACK_MS);
      } catch (caught) {
        // Jujur apa adanya: browser bisa menolak akses papan klip (izin atau bukan HTTPS).
        setCopyNote({
          target: '',
          text:
            errorCode(caught) === 'CLIPBOARD_UNAVAILABLE'
              ? 'Peramban ini tidak menyediakan fungsi salin otomatis. Salin ' + yang + ' secara manual dari kotak di atas.'
              : 'Salin tidak diizinkan peramban (izin papan klip ditolak). Salin ' + yang + ' secara manual dari kotak di atas.',
        });
      }
    },
    [],
  );

  /** Ganti kode undangan sesudah konfirmasi; kode dan tautan lama tidak berlaku lagi. */
  async function rotateCode(): Promise<void> {
    const confirmed = window.confirm(
      'Ganti kode undangan Anda?\n\nKode dan tautan lama tidak berlaku lagi setelah ini. Orang yang membuka tautan lama akan melihat pesan bahwa kode tidak ditemukan, dan undangan yang belum tercatat tidak bisa lagi memakai kode lama itu.',
    );
    if (!confirmed) return;
    setRotating(true);
    setNotice('');
    setCopyNote({ target: '', text: '' });
    try {
      const result = await api.rotateReferralCode();
      const nextCode = String(result?.code ?? '').trim();
      const nextLink = String(result?.link ?? '').trim();
      // Kode baru langsung dipakai di layar supaya pemakai tidak salah membagikan kode lama.
      setSummary((previous) =>
        previous
          ? { ...previous, code: nextCode || previous.code, link: nextLink || previous.link }
          : previous,
      );
      setNotice('Kode undangan sudah diganti. Kode dan tautan lama tidak berlaku lagi; bagikan kode baru di bawah ini.');
    } catch (caught) {
      fail(errorText(caught));
    } finally {
      setRotating(false);
    }
  }

  // Nilai siap pakai untuk tampilan.
  const code = String(summary?.code ?? '').trim();
  const site = String(summary?.site ?? '').trim().replace(/\/+$/, '');
  /** Tautan dari server; bila kosong, tautan disusun dari alamat situs dan kode. */
  const link = String(summary?.link ?? '').trim() || (site && code ? site + '/?ref=' + encodeURIComponent(code) : '');
  const limits = summary?.limits ?? null;
  const counters = summary?.counters ?? null;
  const rows: ReferralRow[] = Array.isArray(summary?.recent) ? summary.recent.slice(0, ROW_LIMIT) : [];
  const invitedBy = summary?.invitedBy ?? null;
  /** Pita peringatan: admin bisa mematikan hadiah tanpa mematikan pembagian kode. */
  const programOff = limits?.enabled === false;

  return (
    <section className="page-shell-inner text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">
            ❖
          </span>
          Undangan
        </h2>
        <p className="settings-hint">
          Ajak orang lain mendaftar dengan kode undangan Anda. Hadiah berupa token masuk setelah orang yang Anda undang
          menyelesaikan run pertamanya, bukan saat ia hanya membuat akun.
        </p>
      </header>

      {error ? <p className={ERROR_BOX}>{error}</p> : null}
      {notice ? <p className={BANNER}>{notice}</p> : null}
      {programOff ? (
        <p className={WARN_BOX}>
          Program undangan sedang dimatikan admin. Kode Anda tetap bisa dibagikan dan orang tetap bisa mendaftar dengan
          kode itu, tetapi hadiah token tidak keluar sampai admin menyalakan program ini lagi.
        </p>
      ) : null}

      {loading && summary === null ? <p className="text-slate-400">Memuat data undangan…</p> : null}
      {!loading && summary === null ? (
        <p className="text-slate-400">
          Data undangan belum bisa ditampilkan. Tekan "Muat ulang" di bawah untuk mencoba lagi.
        </p>
      ) : null}

      {/* A. Kartu kode undangan: kode, tautan, tombol salin, dan tombol ganti kode. */}
      {summary ? (
        <div className={CARD}>
          <h3 className="mb-2 font-semibold text-slate-100">Kode undangan Anda</h3>
          <p className={LABEL}>Kode</p>
          <code className={MONO_BOX + ' mt-1 text-base'}>{code || 'server belum mengirim kode'}</code>
          <p className={LABEL + ' mt-3'}>Tautan lengkap</p>
          <code className={MONO_BOX}>{link || 'server belum mengirim tautan'}</code>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              disabled={code.length === 0}
              onClick={() => {
                void copyValue(code, 'code');
              }}
            >
              {copyNote.target === 'code' ? 'Tersalin' : 'Salin kode'}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={link.length === 0}
              onClick={() => {
                void copyValue(link, 'link');
              }}
            >
              {copyNote.target === 'link' ? 'Tersalin' : 'Salin tautan'}
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={rotating || loading}
              onClick={() => {
                void rotateCode();
              }}
            >
              {rotating ? 'Mengganti…' : 'Ganti kode'}
            </button>
            <span className="text-xs text-slate-400" role="status">
              {copyNote.text}
            </span>
          </div>
          <p className="settings-hint">
            "Ganti kode" membuat kode dan tautan baru, lalu kode lama langsung mati. Pakai tombol itu bila kode Anda
            sudah tersebar ke tempat yang tidak Anda inginkan.
          </p>
        </div>
      ) : null}

      {/* B. Baris statistik undangan. */}
      <div className={CARD}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Ringkasan undangan</h3>
          <button
            type="button"
            className={BTN}
            disabled={loading}
            onClick={() => {
              void loadSummary();
            }}
          >
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>
        {counters ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Diundang" value={numberText(counters.invited)} />
            <StatCard label="Menunggu" value={numberText(counters.pending)} />
            <StatCard label="Hadiah cair" value={numberText(counters.rewarded)} />
            <StatCard label="Token dari undangan" value={numberText(summary?.tokensEarned) + ' token'} />
          </div>
        ) : (
          <p className="text-slate-400">Statistik undangan belum tersedia dari server.</p>
        )}
      </div>

      {/* C. Kotak hadiah yang berlaku sekarang. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Hadiah saat ini</h3>
        {limits ? (
          <ul className="grid gap-1 sm:grid-cols-2">
            <Row label="Untuk Anda (pengundang)" value={numberText(limits.inviterTokens) + ' token'} />
            <Row label="Untuk orang yang diundang" value={numberText(limits.inviteeTokens) + ' token'} />
            <Row
              label="Batas hadiah cair per akun"
              value={num(limits.maxRewardedPerUser) === 0 ? 'tanpa batas' : numberText(limits.maxRewardedPerUser) + ' undangan'}
            />
            <Row
              label="Status program"
              value={limits.enabled === false ? 'dimatikan admin (hadiah tidak keluar)' : 'berjalan'}
            />
          </ul>
        ) : (
          <p className="text-slate-400">Besar hadiah belum dilaporkan server.</p>
        )}
        <p className="settings-hint">
          Batas dihitung dari jumlah undangan yang sudah benar-benar cair, bukan dari jumlah orang yang baru mendaftar.
          Undangan yang ditolak tidak ikut dihitung dan tidak dibayar.
        </p>
      </div>

      {/* D. Panel undangan yang Anda terima sendiri. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Anda diundang oleh</h3>
        {invitedBy ? (
          <div>
            <p className="text-slate-100">{invitedByText(invitedBy)}</p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              <Row label="Kode yang dipakai" value={String(invitedBy.code ?? '') || '-'} />
              <Row label="ID pengundang" value={String(invitedBy.inviterUserId ?? '') || '-'} />
              <Row label="Dibuat" value={dateTimeText(invitedBy.createdAt)} />
              <Row
                label="Token Anda dari undangan ini"
                value={numberText(invitedBy.inviteeTokens) + ' token'}
              />
            </ul>
            {invitedBy.status === 'blocked' ? (
              <p className={WARN_BOX + ' mt-2'}>
                Alasan penolakan dari server: {String(invitedBy.blockedReason ?? '') || 'tidak disebutkan'}. Bila Anda
                merasa ini keliru, hubungi admin; keputusan penolakan tidak bisa diubah dari halaman ini.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-slate-400">
            Anda mendaftar tanpa kode undangan, jadi tidak ada pengundang yang tercatat untuk akun ini.
          </p>
        )}
      </div>

      {/* E. Tabel undangan terakhir. */}
      <div className={CARD}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Daftar undangan</h3>
          <button
            type="button"
            className={BTN}
            disabled={loading}
            onClick={() => {
              void loadSummary();
            }}
          >
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>
        <p className="settings-hint">
          Menampilkan paling banyak {ROW_LIMIT} undangan terakhir dari ringkasan server. Undangan yang lebih lama tidak
          dikirim server ke halaman ini.
        </p>

        {loading && rows.length === 0 ? <p className="text-slate-400">Memuat daftar undangan…</p> : null}
        {!loading && summary !== null && rows.length === 0 ? (
          <p className="text-slate-400">
            Belum ada undangan tercatat. Bagikan kode Anda; baris pertama muncul setelah orang memakai kode itu saat
            mendaftar.
          </p>
        ) : null}

        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>
                    Email
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Hadiah Anda
                  </th>
                  <th scope="col" className={TH}>
                    Hadiah diterima
                  </th>
                  <th scope="col" className={TH}>
                    Waktu dibuat
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className={TD}>
                      <span className="break-all text-slate-100">{inviteeText(row)}</span>
                      <span className="block text-xs text-slate-400">kode: {String(row.code ?? '') || '-'}</span>
                    </td>
                    <td className={TD}>
                      <span className={statusChipClass(row.status)}>{statusLabel(row.status)}</span>
                      {statusKey(row.status) === 'blocked' ? (
                        <span className="block text-xs text-rose-300">
                          alasan: {String(row.blockedReason ?? '') || 'tidak disebutkan'}
                        </span>
                      ) : null}
                    </td>
                    <td className={TD}>{numberText(row.inviterTokens) + ' token'}</td>
                    <td className={TD}>
                      {rewardDateText(row)}
                      <span className="block text-xs text-slate-400">{rewardStageText(row)}</span>
                    </td>
                    <td className={TD}>{dateTimeText(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* F. Keterangan jujur: cara hadiah keluar, penolakan SAME_IP, dan batas yang diakui. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Yang perlu Anda ketahui (apa adanya)</h3>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Hadiah hanya keluar setelah orang yang Anda undang menyelesaikan <strong>run pertamanya</strong>. Mendaftar
            saja belum cukup, jadi undangan yang berstatus "Menunggu run pertama" memang belum dibayar.
          </li>
          <li>
            Undangan dengan alamat IP pendaftaran yang sama dengan Anda ditandai <code className="font-mono">blocked</code>{' '}
            dengan alasan <code className="font-mono">SAME_IP</code> dan tidak dibayar. Sistem memakai ini untuk menahan
            undangan palsu dari perangkat atau jaringan yang sama.
          </li>
          <li>
            <strong>Batas yang diakui:</strong> orang yang memakai jaringan berbeda tetap tidak bisa dikenali sistem,
            walaupun akunnya sama orangnya. Verifikasi email belum diwajibkan di platform ini, jadi penjagaan terhadap
            undangan palsu belum sempurna. Anggap angka di halaman ini sebagai perkiraan, bukan bukti pertumbuhan yang
            bersih.
          </li>
        </ul>
        {programOff ? (
          <p className="mt-2 text-amber-100">
            Catatan tambahan: program undangan sedang dimatikan admin, jadi hadiah tidak keluar walau syarat run pertama
            sudah terpenuhi.
          </p>
        ) : null}
      </div>
    </section>
  );
}

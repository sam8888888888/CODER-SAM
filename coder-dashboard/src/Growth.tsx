import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type {
  GrowthActivityRow,
  GrowthFunnelStep,
  GrowthReport,
  ReferralLeader,
  ReferralLimits,
  ReferralRow,
  ReferralStats,
} from './api';

/** Properti halaman "Pertumbuhan": pesan galat diteruskan ke induk halaman. */
type Props = { onError: (message: string) => void };

/** Satu baris undangan pada jawaban adminReferrals (tanpa statistik dan papan peringkat). */
type ReferralAdminRow = ReferralRow & { inviterEmail: string; inviteeEmailConfirmed: string };

/** Jawaban api.adminReferrals; ditulis lengkap supaya tidak ada tipe "any" di halaman ini. */
type AdminReferralsResponse = { stats: ReferralStats; leaderboard: ReferralLeader[]; referrals: ReferralAdminRow[] };

/** Jendela waktu yang bisa dipilih pengguna pada pemilih di atas halaman. */
const WINDOW_OPTIONS: number[] = [7, 30, 90];

/** Jumlah hari terakhir yang ditampilkan di tabel aktivitas harian (grafik tetap memuat semua hari). */
const ACTIVITY_TABLE_DAYS = 14;

/** Jumlah undangan terakhir yang ditampilkan pada kartu undangan. */
const REFERRAL_TABLE_ROWS = 10;

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi yang sedang dipakai atau aksi menonjol. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas tombol jendela waktu yang tidak dipilih. */
const BTN_WINDOW = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1 text-xs text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol jendela waktu yang sedang dipilih. */
const BTN_WINDOW_ACTIVE = 'rounded-lg border border-violet-500 bg-violet-600 px-3 py-1 text-xs font-semibold text-white';
/** Kelas pembungkus kartu isi, sama dengan halaman Webhook. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas kotak galat, sama dengan halaman Kunci API dan Billing. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300';
/** Kelas pita keterangan netral (catatan jujur dan petunjuk). */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala dan badan tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
const TD = 'border-b border-slate-700/60 px-3 py-2';

/** Warna batang grafik aktivitas: satu warna per metrik harian. */
const BAR_COLOR = {
  signups: '#38bdf8',
  runsCompleted: '#a78bfa',
  events: '#fbbf24',
  activeUsers: '#34d399',
};

/** Keterangan warna batang, dipakai sebagai legenda di bawah grafik. */
const BAR_LEGEND: { key: string; label: string; color: string }[] = [
  { key: 'signups', label: 'Pendaftar', color: BAR_COLOR.signups },
  { key: 'runsCompleted', label: 'Run selesai', color: BAR_COLOR.runsCompleted },
  { key: 'events', label: 'Event', color: BAR_COLOR.events },
  { key: 'activeUsers', label: 'Pengguna aktif', color: BAR_COLOR.activeUsers },
];

/** Sebutan status undangan dalam Bahasa Indonesia. */
const REFERRAL_STATUS_LABEL: Record<string, string> = {
  pending: 'menunggu',
  qualified: 'memenuhi syarat',
  rewarded: 'hadiah cair',
  blocked: 'ditolak',
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

/** Persentase satu desimal; nilai kosong ditulis sebagai tanda hubung. */
function percentText(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1).replace('.', ',') + '%' : '-';
}

/** Format hari "YYYY-MM-DD" menjadi "15 Sep 2026"; teks lain ditampilkan apa adanya. */
function dayText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const parts = text.slice(0, 10).split('-');
  if (parts.length !== 3) return text;
  const parsed = new Date(text.slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Format tanggal dan jam; nilai kosong ditulis sebagai tanda hubung. */
function dateTimeText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
    codes: ['ADMIN_REQUIRED', 'FORBIDDEN'],
    text: 'Hanya admin platform yang boleh melihat angka pertumbuhan dan daftar undangan.',
  },
  { codes: ['UNAUTHORIZED', 'UNAUTHENTICATED'], text: 'Sesi Anda sudah berakhir. Silakan masuk lagi.' },
  { codes: ['RATE_LIMITED', 'RATE_LIMIT', 'TOO_MANY_REQUESTS'], text: 'Terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi.' },
  { codes: ['Failed to fetch', 'NetworkError'], text: 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.' },
];

/**
 * Ubah galat apa pun (kode server, galat jaringan, atau kode status HTTP)
 * menjadi satu kalimat Indonesia yang bisa dibaca pemakai.
 */
function errorText(error: unknown): string {
  const code = errorCode(error);
  for (const item of ERROR_MAP) {
    if (item.codes.some((needle) => code.includes(needle))) return item.text;
  }
  if (/\b401\b/.test(code)) return 'Sesi Anda sudah berakhir. Silakan masuk lagi.';
  if (/\b403\b/.test(code)) return 'Hanya admin platform yang boleh melihat angka pertumbuhan dan daftar undangan.';
  if (/\b429\b/.test(code)) return 'Terlalu banyak permintaan. Tunggu sebentar, lalu coba lagi.';
  const clean = code.trim();
  return clean
    ? 'Angka pertumbuhan gagal dimuat dari server. Coba lagi sebentar lagi (kode: ' + clean + ').'
    : 'Angka pertumbuhan gagal dimuat dari server. Coba lagi sebentar lagi.';
}

/** Sebutan status undangan; status tak dikenal ditampilkan apa adanya. */
function referralStatusLabel(value: unknown): string {
  const code = String(value ?? '').trim().toLowerCase();
  return REFERRAL_STATUS_LABEL[code] ?? (code || 'tidak diketahui');
}

/** Kelas lencana status undangan: menunggu=biru, memenuhi syarat=ungu, cair=hijau, ditolak=merah. */
function referralStatusClass(value: unknown): string {
  const base = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
  const code = String(value ?? '').trim().toLowerCase();
  if (code === 'rewarded') return base + ' border-emerald-500/40 bg-emerald-500/15 text-emerald-100';
  if (code === 'qualified') return base + ' border-violet-500/40 bg-violet-500/15 text-violet-100';
  if (code === 'blocked') return base + ' border-rose-500/40 bg-rose-500/15 text-rose-100';
  return base + ' border-slate-600 bg-slate-700/40 text-slate-200';
}

/** Satu kartu angka ringkas pada baris statistik. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-100">{value}</p>
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

/** Ubah jumlah menjadi lebar batang dalam persen terhadap nilai terbesar; nol tetap nol. */
function barHeight(value: unknown, max: number): string {
  if (max <= 0) return '0%';
  const ratio = (num(value) / max) * 100;
  if (ratio <= 0) return '0%';
  // Beri lebar minimum 2% supaya hari dengan nilai kecil tetap terlihat.
  return Math.max(2, Math.min(100, ratio)) + '%';
}

/**
 * Halaman "Pertumbuhan" (khusus admin platform).
 *
 * Isinya: pemilih jendela waktu, ringkasan total, corong konversi, aktivitas harian,
 * retensi, event teratas, dan kartu undangan beserta papan peringkat.
 * Angka aktif dan event hanya dihitung dari tabel growth_events (sejak Wave 7), sedangkan
 * angka corong diambil dari tabel asli sehingga berlaku untuk seluruh riwayat.
 */
export function Growth({ onError }: Props) {
  // Jendela waktu yang sedang dipakai; mengubahnya memuat ulang seluruh laporan.
  const [days, setDays] = useState<number>(30);

  // Laporan pertumbuhan dari api.adminGrowth.
  const [report, setReport] = useState<GrowthReport | null>(null);
  const [loading, setLoading] = useState(false);

  // Undangan dari api.adminReferrals (statistik, papan peringkat, daftar undangan).
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [leaderboard, setLeaderboard] = useState<ReferralLeader[]>([]);
  const [referrals, setReferrals] = useState<ReferralAdminRow[]>([]);
  const [referralsLoading, setReferralsLoading] = useState(false);

  // Keadaan umum halaman.
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

  /** Muat laporan pertumbuhan untuk satu jendela waktu. */
  const loadGrowth = useCallback(
    async (windowDays: number): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const result = await api.adminGrowth(windowDays);
        setReport(result ?? null);
      } catch (caught) {
        // Jangan tampilkan angka lama seolah masih sah: kosongkan bila permintaan gagal.
        setReport(null);
        fail(errorText(caught));
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  /** Muat statistik, papan peringkat, dan daftar undangan untuk admin. */
  const loadReferrals = useCallback(async (): Promise<void> => {
    setReferralsLoading(true);
    try {
      const result: AdminReferralsResponse = await api.adminReferrals(REFERRAL_TABLE_ROWS);
      setStats(result?.stats ?? null);
      setLeaderboard(Array.isArray(result?.leaderboard) ? result.leaderboard : []);
      setReferrals(Array.isArray(result?.referrals) ? result.referrals : []);
    } catch (caught) {
      setStats(null);
      setLeaderboard([]);
      setReferrals([]);
      fail(errorText(caught));
    } finally {
      setReferralsLoading(false);
    }
  }, [fail]);

  // Laporan pertumbuhan dimuat setiap kali jendela waktu berubah; undangan dimuat sekali saat halaman dibuka.
  useEffect(() => {
    void loadGrowth(days);
  }, [days, loadGrowth]);

  useEffect(() => {
    void loadReferrals();
  }, [loadReferrals]);

  /** Muat ulang seluruh halaman: laporan dan undangan sekaligus. */
  async function reloadAll(): Promise<void> {
    setNotice('');
    await loadGrowth(days);
    await loadReferrals();
    setNotice('Angka terbaru sudah dimuat dari server.');
  }

  /** Pilih jendela waktu baru; efek di atas akan memuat ulang laporan. */
  function pickWindow(windowDays: number): void {
    setNotice('');
    setDays(windowDays);
  }

  /** Langkah corong beserta lebar batang dan konversi dari langkah sebelumnya. */
  const funnelSteps = useMemo(() => {
    const steps: GrowthFunnelStep[] = Array.isArray(report?.funnel?.steps) ? report.funnel.steps : [];
    const base = steps.reduce((largest, step) => Math.max(largest, num(step.users)), 0);
    return steps.map((step, index) => {
      const users = num(step.users);
      const previous = index > 0 ? num(steps[index - 1]?.users) : null;
      // Konversi dari langkah sebelumnya; langkah pertama tidak punya pembanding.
      const conversion =
        previous === null ? null : previous > 0 ? (users / previous) * 100 : Number.NaN;
      return {
        key: String(step.key ?? index),
        label: String(step.label ?? step.key ?? 'Langkah ' + String(index + 1)),
        users,
        allTime: num(step.allTime),
        width: barHeight(users, base),
        conversion,
        isFirst: index === 0,
      };
    });
  }, [report]);

  /** Nilai terbesar pada seluruh metrik aktivitas; dipakai sebagai skala grafik. */
  const activityMax = useMemo(() => {
    const rows = Array.isArray(report?.activity) ? report.activity : [];
    let largest = 0;
    for (const row of rows) {
      largest = Math.max(largest, num(row.signups), num(row.runsCompleted), num(row.events), num(row.activeUsers));
    }
    return largest;
  }, [report]);

  /** Aktivitas harian versi tampilan: terbaru lebih dahulu, dibatasi untuk tabel. */
  const activityNewest = useMemo(() => {
    const rows: GrowthActivityRow[] = Array.isArray(report?.activity) ? report.activity : [];
    return rows.slice().reverse();
  }, [report]);

  /** Jumlah pada jendela terpilih; dipakai sebagai keterangan ringkas di bawah tabel. */
  const activityTotals = useMemo(() => {
    const rows = activityNewest;
    return rows.reduce(
      (sum, row) => ({
        signups: sum.signups + num(row.signups),
        runsCompleted: sum.runsCompleted + num(row.runsCompleted),
        events: sum.events + num(row.events),
      }),
      { signups: 0, runsCompleted: 0, events: 0 },
    );
  }, [activityNewest]);

  const totals = report?.totals ?? null;
  const retention = report?.retention ?? null;
  const eventRows = Array.isArray(report?.events) ? report.events : [];
  const catalogue = Array.isArray(report?.catalogue) ? report.catalogue : [];
  const referralLimits: ReferralLimits | null = report?.referralLimits ?? null;

  return (
    <section className="page-shell-inner text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">
            ◈
          </span>
          Pertumbuhan
        </h2>
        <p className="settings-hint">
          Halaman ini merangkum corong pendaftaran, aktivitas harian, retensi, event yang tercatat, dan program undangan.
          Semua angka diambil langsung dari server; jendela waktu bawaan adalah 30 hari.
        </p>
      </header>

      {error ? <p className={ERROR_BOX}>{error}</p> : null}
      {notice ? <p className={BANNER}>{notice}</p> : null}

      {/* Pemilih jendela waktu + muat ulang. */}
      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={LABEL}>Jendela waktu</span>
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={option === days ? BTN_WINDOW_ACTIVE : BTN_WINDOW}
                disabled={loading && option !== days}
                aria-pressed={option === days}
                onClick={() => pickWindow(option)}
              >
                {option} hari
              </button>
            ))}
          </div>
          <button
            type="button"
            className={BTN}
            disabled={loading || referralsLoading}
            onClick={() => {
              void reloadAll();
            }}
          >
            {loading || referralsLoading ? 'Memuat...' : 'Muat ulang'}
          </button>
        </div>
        <p className="settings-hint">
          Jendela terpilih: {numberText(report?.windowDays ?? days)} hari
          {report?.funnel?.since ? ' · sejak ' + dayText(report.funnel.since) : ''}. Corong, aktivitas, dan event
          mengikuti jendela ini; angka aktif harian, mingguan, dan bulanan selalu dihitung dari hari berjalan.
        </p>
      </div>

      {/* Keterangan jujur supaya angka tidak salah dibaca. */}
      <div className={BANNER}>
        <p className="font-semibold">Cara membaca angka di halaman ini</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            Tabel <code className="font-mono text-xs">growth_events</code> baru ada sejak Wave 7. Karena itu angka
            pengguna aktif dan jumlah event tidak berlaku surut: hari sebelum pencatatan dimulai akan tampak kosong,
            bukan berarti tidak ada pemakai.
          </li>
          <li>
            Angka corong diambil dari tabel asli (users, projects, runs, orders), jadi berlaku untuk seluruh riwayat
            platform, bukan hanya sejak Wave 7.
          </li>
          <li>
            Total pengguna yang kecil pada instalasi baru bukan tanda kegagalan. Pencatatan event memang dimulai dari
            nol saat instalasi dibuat.
          </li>
        </ul>
      </div>

      {/* A. Total platform. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Total platform</h3>
        {loading && !totals ? <p className="text-slate-400">Memuat angka pertumbuhan...</p> : null}
        {totals ? (
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Pengguna" value={numberText(totals.users)} />
            <StatCard label="Workspace" value={numberText(totals.workspaces)} />
            <StatCard label="Proyek" value={numberText(totals.projects)} />
            <StatCard label="Percakapan" value={numberText(totals.conversations)} />
            <StatCard label="Run selesai" value={numberText(totals.runsCompleted)} />
            <StatCard label="Event tercatat" value={numberText(totals.eventsRecorded)} />
          </div>
        ) : null}
        {!loading && !totals ? <p className="text-slate-400">Total platform belum bisa ditampilkan.</p> : null}
      </div>

      {/* B. Corong konversi. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Corong (funnel)</h3>
        {loading && funnelSteps.length === 0 ? <p className="text-slate-400">Memuat corong...</p> : null}
        {!loading && funnelSteps.length === 0 ? (
          <p className="text-slate-400">Server belum melaporkan langkah corong untuk jendela ini.</p>
        ) : null}

        {funnelSteps.length > 0 ? (
          <ul className="space-y-3">
            {funnelSteps.map((step) => (
              <li key={step.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-slate-100">{step.label}</span>
                  <span className="text-xs text-slate-400">
                    {numberText(step.users)} pengguna unik · {numberText(step.allTime)} sepanjang masa ·{' '}
                    {step.isFirst
                      ? 'langkah pertama'
                      : step.conversion === null
                        ? 'konversi tidak bisa dihitung'
                        : Number.isNaN(step.conversion)
                          ? 'tidak bisa dihitung (langkah sebelumnya nol)'
                          : 'konversi ' + percentText(step.conversion) + ' dari langkah sebelumnya'}
                  </span>
                </div>
                <div className="mt-1 h-3 w-full overflow-hidden rounded-full bg-slate-900/60">
                  <div className="h-full rounded-full bg-violet-500" style={{ width: step.width }} />
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {report?.funnel?.note ? <p className="settings-hint">{report.funnel.note}</p> : null}
      </div>

      {/* C. Aktivitas harian. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Aktivitas harian</h3>

        {activityNewest.length === 0 ? (
          <p className="text-slate-400">Belum ada data aktivitas harian untuk jendela ini.</p>
        ) : (
          <>
            {/* Grafik batang sederhana: tinggi relatif terhadap nilai terbesar pada jendela ini. */}
            {activityMax <= 0 ? (
              <p className="text-slate-400">
                Seluruh angka aktivitas pada jendela ini nol, jadi grafik tidak digambar. Hari tanpa catatan bukan
                berarti tidak ada pemakai, karena event baru dicatat sejak Wave 7.
              </p>
            ) : (
              <>
                <div className="flex items-end gap-1 overflow-x-auto pb-1" style={{ height: '7rem' }}>
                  {report?.activity?.map((row) => (
                    <div
                      key={String(row.day)}
                      className="flex h-full items-end gap-px"
                      style={{ minWidth: 16, flex: '1 1 0%' }}
                      title={
                        dayText(row.day) +
                        ' · pendaftar ' +
                        numberText(row.signups) +
                        ' · run selesai ' +
                        numberText(row.runsCompleted) +
                        ' · event ' +
                        numberText(row.events) +
                        ' · pengguna aktif ' +
                        numberText(row.activeUsers)
                      }
                    >
                      <span
                        className="w-1/4 rounded-t"
                        style={{ height: barHeight(row.signups, activityMax), backgroundColor: BAR_COLOR.signups }}
                      />
                      <span
                        className="w-1/4 rounded-t"
                        style={{
                          height: barHeight(row.runsCompleted, activityMax),
                          backgroundColor: BAR_COLOR.runsCompleted,
                        }}
                      />
                      <span
                        className="w-1/4 rounded-t"
                        style={{ height: barHeight(row.events, activityMax), backgroundColor: BAR_COLOR.events }}
                      />
                      <span
                        className="w-1/4 rounded-t"
                        style={{
                          height: barHeight(row.activeUsers, activityMax),
                          backgroundColor: BAR_COLOR.activeUsers,
                        }}
                      />
                    </div>
                  ))}
                </div>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                  {BAR_LEGEND.map((item) => (
                    <li key={item.key} className="flex items-center gap-1">
                      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: item.color }} />
                      {item.label}
                    </li>
                  ))}
                </ul>
                <p className="settings-hint">
                  Skala grafik memakai nilai terbesar pada jendela ini ({numberText(activityMax)}), jadi tinggi batang
                  hanya bisa dibandingkan di dalam satu jendela.
                </p>
              </>
            )}

            <div className="overflow-x-auto">
              <table className="admin-table">
                <thead>
                  <tr className="text-left text-slate-400">
                    <th scope="col" className={TH}>
                      Tanggal
                    </th>
                    <th scope="col" className={TH}>
                      Pendaftar
                    </th>
                    <th scope="col" className={TH}>
                      Run selesai
                    </th>
                    <th scope="col" className={TH}>
                      Event
                    </th>
                    <th scope="col" className={TH}>
                      Pengguna aktif
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {activityNewest.slice(0, ACTIVITY_TABLE_DAYS).map((row) => (
                    <tr key={String(row.day)}>
                      <td className={TD}>{dayText(row.day)}</td>
                      <td className={TD}>{numberText(row.signups)}</td>
                      <td className={TD}>{numberText(row.runsCompleted)}</td>
                      <td className={TD}>{numberText(row.events)}</td>
                      <td className={TD}>{numberText(row.activeUsers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="settings-hint">
              Tabel menampilkan {numberText(Math.min(ACTIVITY_TABLE_DAYS, activityNewest.length))} hari terakhir dari{' '}
              {numberText(activityNewest.length)} hari pada jendela ini. Jumlah pada jendela: pendaftar{' '}
              {numberText(activityTotals.signups)}, run selesai {numberText(activityTotals.runsCompleted)}, event{' '}
              {numberText(activityTotals.events)}.
            </p>
          </>
        )}
      </div>

      {/* D. Retensi. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Retensi</h3>
        {loading && !retention ? <p className="text-slate-400">Memuat angka retensi...</p> : null}
        {retention ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard label="Aktif harian (DAU)" value={numberText(retention.dau)} />
              <StatCard label="Aktif mingguan (WAU)" value={numberText(retention.wau)} />
              <StatCard label="Aktif bulanan (MAU)" value={numberText(retention.mau)} />
              <StatCard label="Pengguna baru 7 hari" value={numberText(retention.newUsers7d)} />
              <StatCard label="Pengguna baru 30 hari" value={numberText(retention.newUsers30d)} />
              <StatCard label="Pelanggan aktif" value={numberText(retention.payingUsers)} />
            </div>
            <p className="settings-hint">
              {retention.note
                ? retention.note
                : 'Angka pengguna aktif dihitung dari event yang tercatat, sehingga belum berlaku surut.'}
            </p>
          </>
        ) : null}
        {!loading && !retention ? <p className="text-slate-400">Angka retensi belum bisa ditampilkan.</p> : null}
      </div>

      {/* E. Event teratas. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Event teratas</h3>
        {eventRows.length === 0 ? (
          <p className="text-slate-400">
            Belum ada event tercatat pada jendela ini. Ingat: pencatatan event baru dimulai sejak Wave 7.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>
                    Nama event
                  </th>
                  <th scope="col" className={TH}>
                    Jumlah
                  </th>
                  <th scope="col" className={TH}>
                    Pengguna unik
                  </th>
                </tr>
              </thead>
              <tbody>
                {eventRows.map((row) => (
                  <tr key={String(row.name)}>
                    <td className={TD}>
                      <code className="font-mono text-xs text-slate-100">{String(row.name ?? '') || '-'}</code>
                    </td>
                    <td className={TD}>{numberText(row.count)}</td>
                    <td className={TD}>{numberText(row.users)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="settings-hint">
          {catalogue.length > 0
            ? 'Event yang mungkin tercatat server: ' + catalogue.join(', ') + '.'
            : 'Server belum melaporkan daftar event yang mungkin tercatat.'}
        </p>
      </div>

      {/* F. Undangan: statistik, alasan penolakan, papan peringkat, dan daftar terakhir. */}
      <div className={CARD}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Undangan</h3>
          <button
            type="button"
            className={BTN}
            disabled={referralsLoading}
            onClick={() => {
              void loadReferrals();
            }}
          >
            {referralsLoading ? 'Memuat...' : 'Muat ulang'}
          </button>
        </div>

        {referralsLoading && !stats ? <p className="text-slate-400">Memuat data undangan...</p> : null}
        {!referralsLoading && !stats ? (
          <p className="text-slate-400">Data undangan belum bisa ditampilkan. Coba muat ulang.</p>
        ) : null}

        {stats ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard label="Kode dibuat" value={numberText(stats.codes)} />
              <StatCard label="Total undangan" value={numberText(stats.total)} />
              <StatCard label="Menunggu" value={numberText(stats.pending)} />
              <StatCard label="Hadiah cair" value={numberText(stats.rewarded)} />
              <StatCard label="Ditolak" value={numberText(stats.blocked)} />
              <StatCard label="Token hadiah dibagikan" value={numberText(stats.tokensGranted)} />
            </div>
            <p className="settings-hint">
              Undangan yang memenuhi syarat (belum cair): {numberText(stats.qualified)}. Token dihitung sebagai jumlah
              token yang benar-benar sudah diberikan ke pengundang dan pengundang baru.
            </p>

            <h4 className="mt-3 font-semibold text-slate-100">Alasan penolakan</h4>
            {Array.isArray(stats.blockedByReason) && stats.blockedByReason.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th scope="col" className={TH}>
                        Alasan dari server
                      </th>
                      <th scope="col" className={TH}>
                        Jumlah
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.blockedByReason.map((item) => (
                      <tr key={String(item.reason)}>
                        <td className={TD}>
                          <code className="font-mono text-xs text-slate-100">{String(item.reason ?? '') || '-'}</code>
                        </td>
                        <td className={TD}>{numberText(item.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-slate-400">Belum ada undangan yang ditolak.</p>
            )}
          </>
        ) : null}

        {referralLimits ? (
          <ul className="mt-3 grid gap-1 sm:grid-cols-2">
            <Row label="Program undangan" value={referralLimits.enabled ? 'aktif' : 'nonaktif'} />
            <Row label="Token untuk pengundang" value={numberText(referralLimits.inviterTokens)} />
            <Row label="Token untuk yang diundang" value={numberText(referralLimits.inviteeTokens)} />
            <Row label="Maksimal hadiah cair per pengguna" value={numberText(referralLimits.maxRewardedPerUser)} />
          </ul>
        ) : null}

        <h4 className="mt-3 font-semibold text-slate-100">Papan peringkat (10 teratas)</h4>
        {leaderboard.length === 0 ? (
          <p className="text-slate-400">Belum ada pengundang yang mendapat hadiah.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>
                    Peringkat
                  </th>
                  <th scope="col" className={TH}>
                    Email
                  </th>
                  <th scope="col" className={TH}>
                    Diundang
                  </th>
                  <th scope="col" className={TH}>
                    Hadiah cair
                  </th>
                  <th scope="col" className={TH}>
                    Token
                  </th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.slice(0, 10).map((row, index) => (
                  <tr key={String(row.userId ?? index)}>
                    <td className={TD}>{numberText(index + 1)}</td>
                    <td className={TD}>
                      <span className="break-all">{String(row.email ?? '') || '-'}</span>
                    </td>
                    <td className={TD}>{numberText(row.invited)}</td>
                    <td className={TD}>{numberText(row.rewarded)}</td>
                    <td className={TD}>{numberText(row.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h4 className="mt-3 font-semibold text-slate-100">Undangan terakhir</h4>
        {referrals.length === 0 ? (
          <p className="text-slate-400">Belum ada undangan tercatat.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>
                    Kode
                  </th>
                  <th scope="col" className={TH}>
                    Pengundang
                  </th>
                  <th scope="col" className={TH}>
                    Diundang
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Alasan
                  </th>
                  <th scope="col" className={TH}>
                    Token
                  </th>
                  <th scope="col" className={TH}>
                    Dibuat
                  </th>
                </tr>
              </thead>
              <tbody>
                {referrals.map((row) => (
                  <tr key={String(row.id)}>
                    <td className={TD}>
                      <code className="font-mono text-xs text-slate-100">{String(row.code ?? '') || '-'}</code>
                    </td>
                    <td className={TD}>
                      <span className="break-all">{String(row.inviterEmail ?? '') || '-'}</span>
                    </td>
                    <td className={TD}>
                      <span className="break-all">
                        {String(row.inviteeEmailConfirmed ?? '') || String(row.inviteeEmail ?? '') || '-'}
                      </span>
                      {String(row.inviteeEmailConfirmed ?? '') ? null : (
                        <span className="block text-xs text-slate-400">email belum dikonfirmasi</span>
                      )}
                    </td>
                    <td className={TD}>
                      <span className={referralStatusClass(row.status)}>{referralStatusLabel(row.status)}</span>
                    </td>
                    <td className={TD}>
                      {String(row.blockedReason ?? '') ? (
                        <code className="font-mono text-xs text-rose-300">{String(row.blockedReason)}</code>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className={TD}>
                      {numberText(row.inviterTokens)} / {numberText(row.inviteeTokens)}
                      <span className="block text-xs text-slate-400">pengundang / diundang</span>
                    </td>
                    <td className={TD}>{dateTimeText(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="settings-hint">
          Token ditampilkan sebagai dua angka: hadiah untuk pengundang dan hadiah untuk pengguna yang diundang. Hadiah
          baru keluar setelah undangan memenuhi syarat, jadi status "menunggu" berarti tokennya belum diberikan.
        </p>
      </div>
    </section>
  );
}

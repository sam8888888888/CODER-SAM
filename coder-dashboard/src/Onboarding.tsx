/**
 * Kartu "Langkah awal" untuk pengguna baru, dipasang di halaman Beranda.
 * Isinya: kemajuan, lima langkah pertama, dan tombol untuk menutup kartu.
 * Kartu ini bukan modal: lebarnya mengikuti induk halaman dan tidak menutupi konten lain.
 * Bila server menolak permintaan (misalnya 401 karena belum masuk), kartu langsung
 * menghilang dan galatnya hanya diteruskan sekali ke induk halaman lewat onError.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { OnboardingState, OnboardingStep } from './api';
import type { PageKey } from './nav';

/** Properti kartu: pesan galat diteruskan ke induk, perpindahan halaman lewat onNavigate. */
type Props = { onError: (message: string) => void; onNavigate: (page: PageKey) => void };

/** Kelas Tailwind kartu isi, sama dengan halaman Webhook dan Kunci API. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas tombol biasa. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas kotak galat, sama dengan halaman Kunci API dan Billing. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300';
/** Kelas pita keberhasilan saat semua langkah selesai. */
const RIBBON = 'rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-slate-100';
/** Kelas pita informasi ringan. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas dasar lencana kecil. */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Lencana "selesai" berwarna hijau. */
const CHIP_DONE = CHIP + ' border-emerald-500/40 bg-emerald-500/15 text-emerald-100';
/** Lencana "berikutnya" berwarna ungu supaya mudah dilihat. */
const CHIP_NEXT = CHIP + ' border-violet-500/40 bg-violet-500/15 text-violet-100';
/** Kelas lingkaran penanda langkah yang belum selesai. */
const MARK_TODO = 'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-600 text-xs text-slate-400';
/** Kelas lingkaran penanda langkah yang sudah selesai. */
const MARK_DONE = 'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/15 text-xs text-emerald-100';

/**
 * Peta kunci langkah dari server ke halaman di dalam aplikasi.
 * Kunci yang tidak ada di peta ini tidak punya halaman tujuan, jadi tombolnya dimatikan.
 */
const STEP_PAGE: Record<string, PageKey> = {
  verify_email: 'settings',
  first_project: 'projects',
  first_conversation: 'projects',
  first_run: 'chat',
  connect_team_or_key: 'team',
};

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/**
 * Ubah galat apa pun (kode server, galat jaringan, atau kode status HTTP)
 * menjadi satu kalimat Indonesia. `action` menerangkan langkah yang gagal: "dimuat" atau "disembunyikan".
 */
function errorText(error: unknown, action: string): string {
  const code = errorCode(error);
  if (/\b401\b|UNAUTHORIZED|UNAUTHENTICATED/.test(code)) return 'Sesi Anda sudah berakhir. Silakan masuk lagi.';
  if (/\b403\b|FORBIDDEN/.test(code)) return 'Anda tidak punya izin untuk mengubah langkah awal ini.';
  if (/\b429\b|RATE_LIMIT|TOO_MANY_REQUESTS/.test(code)) return 'Terlalu banyak permintaan. Coba lagi sebentar.';
  if (/Failed to fetch|NetworkError/.test(code)) return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  const clean = code.trim();
  return clean
    ? 'Langkah awal gagal ' + action + ' dari server. Coba lagi sebentar (kode: ' + clean + ').'
    : 'Langkah awal gagal ' + action + ' dari server. Coba lagi sebentar.';
}

/** Angka dari server dipakai bila sah; kalau tidak, nilai cadangan hasil hitung sendiri yang dipakai. */
function safeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Persentase kemajuan dipotong ke rentang 0-100 supaya bilah tidak pernah melampaui kotaknya. */
function safePercent(value: number, fallback: number): number {
  const raw = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Satu baris langkah: penanda selesai, judul, keterangan, dan tombol "Buka" bila belum selesai.
 * Langkah yang sedang ditandai server sebagai `nextStep` diberi lencana "berikutnya".
 */
function StepRow({ step, next, onOpen }: { step: OnboardingStep; next: boolean; onOpen: (step: OnboardingStep) => void }) {
  const page = STEP_PAGE[step.key] ?? null;
  return (
    <li className="flex flex-wrap items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-2">
      <span aria-hidden="true" className={step.done ? MARK_DONE : MARK_TODO}>
        {step.done ? '✓' : '○'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-100">
          <span>{String(step.label ?? '')}</span>
          {step.done ? <span className={CHIP_DONE}>selesai</span> : null}
          {next ? <span className={CHIP_NEXT}>berikutnya</span> : null}
        </p>
        {step.hint ? <p className="text-xs text-slate-400">{String(step.hint)}</p> : null}
      </div>
      {step.done ? null : (
        <button
          type="button"
          className={BTN}
          disabled={page === null}
          title={page === null ? 'Halaman tujuan langkah ini belum tersedia di aplikasi.' : 'Buka halaman ' + step.label}
          aria-label={'Buka ' + String(step.label ?? '')}
          onClick={() => onOpen(step)}
        >
          Buka
        </button>
      )}
    </li>
  );
}

/**
 * Kartu "Langkah awal" di Beranda.
 *
 * Data diambil sekali saat komponen dipasang lewat `api.onboarding()`. Tidak ada
 * pemuatan ulang saat jendela kembali aktif: angka langkah hanya berubah setelah
 * pemakai menyelesaikan sesuatu, dan kartu ini dimuat ulang saat halaman dibuka kembali.
 */
export function Onboarding({ onError, onNavigate }: Props) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  // Kartu hilang sendiri setelah server mencatat penutupan, atau setelah gagal dimuat.
  const [hidden, setHidden] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [localError, setLocalError] = useState('');

  /** Galat pemuatan pertama hanya dilaporkan sekali supaya induk tidak dibanjiri pesan. */
  const loadReported = useRef(false);
  /** Callback terbaru disimpan di ref supaya efek pemuatan cukup berjalan sekali saat dipasang. */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.onboarding();
        if (cancelled) return;
        setState(data);
      } catch (caught) {
        if (cancelled) return;
        // Misalnya 401 karena belum masuk: tidak ada kotak galat besar, cukup satu pesan ke induk.
        setState(null);
        if (!loadReported.current) {
          loadReported.current = true;
          onErrorRef.current(errorText(caught, 'dimuat'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Sembunyikan kartu: server mencatat penutupannya, lalu komponen hilang sendiri. */
  async function dismiss(): Promise<void> {
    setDismissing(true);
    setLocalError('');
    try {
      await api.dismissOnboarding();
      // Server sudah mencatat; kartu tidak perlu tampil lagi selama halaman ini terbuka.
      setHidden(true);
    } catch (caught) {
      const message = errorText(caught, 'disembunyikan');
      setLocalError(message);
      onErrorRef.current(message);
    } finally {
      setDismissing(false);
    }
  }

  /** Pindah ke halaman tujuan satu langkah; kunci yang tidak dikenal tidak mengubah halaman. */
  function openStep(step: OnboardingStep): void {
    const page = STEP_PAGE[step.key];
    if (page) onNavigate(page);
  }

  if (hidden) return null;

  if (loading) {
    return (
      <section className={CARD + ' text-sm text-slate-400'}>
        <h2 className="text-base font-semibold text-slate-100">Langkah awal</h2>
        <p className="settings-hint">Memuat langkah awal…</p>
      </section>
    );
  }

  // Gagal dimuat (misalnya sesi berakhir): Beranda dibiarkan rapi tanpa kartu dan tanpa kotak galat.
  if (!state) return null;

  const steps = Array.isArray(state.steps) ? state.steps : [];
  const doneComputed = steps.filter((step) => step.done === true).length;
  const total = safeNumber(state.total, steps.length);
  const done = safeNumber(state.done, doneComputed);
  const percent = safePercent(state.percent, total > 0 ? (done / total) * 100 : 0);
  const complete = state.complete === true || (total > 0 && done >= total);

  // Sudah ditutup: kartu tidak tampil lagi, tanpa melihat apakah semua langkah selesai.
  // Penanda ini tersimpan di basis data, jadi kartu tetap hilang setelah halaman dimuat ulang.
  if (state.dismissed === true) return null;

  return (
    <section className={CARD + ' text-sm text-slate-300'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            <span aria-hidden="true" className="mr-1">
              ◈
            </span>
            Langkah awal
          </h2>
          <p className="settings-hint">Selesaikan {total} langkah ini supaya tim Anda siap.</p>
        </div>
        <button
          type="button"
          className={BTN}
          disabled={dismissing}
          onClick={() => {
            void dismiss();
          }}
        >
          {dismissing ? 'Menyembunyikan…' : 'Sembunyikan'}
        </button>
      </div>

      {/* Pita keberhasilan: semua langkah sudah selesai. */}
      {complete ? <p className={RIBBON}>Semua langkah selesai.</p> : null}

      {localError ? <p className={ERROR_BOX + ' mt-2'}>{localError}</p> : null}

      {/* Bilah kemajuan: lebarnya mengikuti persen dari server. */}
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-700"
        role="progressbar"
        aria-label="Kemajuan langkah awal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="h-full rounded-full bg-violet-500" style={{ width: percent + '%' }} />
      </div>
      <p className="mt-1 text-xs text-slate-400">
        {done} dari {total} langkah selesai
      </p>

      {steps.length === 0 ? (
        <p className={BANNER + ' mt-2'}>
          Server belum mengirim daftar langkah awal. Muat ulang halaman Beranda untuk mencobanya lagi.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2">
          {steps.map((step) => (
            <StepRow
              key={step.key}
              step={step}
              next={state.nextStep !== null && step.key === state.nextStep}
              onOpen={openStep}
            />
          ))}
        </ol>
      )}

      <p className="mt-3 text-xs text-slate-400">
        Kartu ini hanya panduan. Semua fitur tetap bisa dibuka dari menu samping.
      </p>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { api } from './api';
import type { Persona, PlaygroundResult, QuotaState, ThinkingLevel } from './api';

/** Properti halaman "Playground": pelapor galat dari induk (opsional). */
type Props = {
  onError?: (message: string) => void;
};

/** Batas panjang prompt, sama dengan batas yang dipakai server. */
const PROMPT_MAX = 8000;

/** Kelas Tailwind dasar untuk tombol. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input, select, dan textarea gelap. */
const FIELD =
  'w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 disabled:opacity-50';
/** Kelas Tailwind untuk kartu panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas Tailwind untuk label kecil di atas input. */
const LABEL = 'mb-1 block text-xs uppercase tracking-wide text-slate-400';

/** Daftar tingkat penalaran yang dikenali server. */
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Satu baris katalog model dari api.models(). */
type ModelRow = { provider: string; model: string; context: string; maxOutput: string; thinking: boolean; images: boolean };

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Paksa nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Format jumlah token dengan pemisah ribuan Indonesia. */
function tokenText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Format durasi jawaban mesin dalam milidetik dan detik. */
function durationText(value: unknown): string {
  const ms = num(value);
  if (ms < 1000) return `${ms} ms`;
  return `${ms} ms (${(ms / 1000).toFixed(2)} detik)`;
}

/** Periksa apakah teks termasuk tingkat penalaran yang dikenali. */
function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

/** Ubah kode galat playground menjadi kalimat Indonesia yang jelas. */
function playgroundErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('DAILY_TOKEN_QUOTA_EXCEEDED')) {
    return 'Kuota token harian paket Anda sudah habis. Tingkatkan paket atau beli kredit token untuk lanjut.';
  }
  if (code.includes('MONTHLY_TOKEN_QUOTA_EXCEEDED')) {
    return 'Kuota token bulanan paket Anda sudah habis. Tingkatkan paket untuk lanjut.';
  }
  if (code.includes('QUOTA_EXCEEDED')) {
    return 'Kuota token Anda sudah habis, jadi prompt ini tidak dijalankan.';
  }
  if (code.includes('INVALID_PROMPT')) {
    return `Tulis pertanyaan ${1}-${PROMPT_MAX} karakter.`;
  }
  if (code.includes('UNKNOWN_MODEL')) {
    return 'Model yang Anda pilih tidak ada di katalog mesin. Muat ulang halaman ini lalu pilih lagi.';
  }
  if (code.includes('PLAYGROUND_FAILED')) {
    return 'Mesin gagal menjawab prompt ini. Coba lagi sebentar lagi atau pilih model lain.';
  }
  if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  }
  return 'Prompt gagal dijalankan. Periksa pilihan model, persona, dan koneksi Anda.';
}

/**
 * Halaman "Playground": uji satu prompt dengan model, tingkat penalaran, persona,
 * bank memori, dan mode otonom pilihan. Playground tidak menyimpan percakapan,
 * tetapi token yang dipakai tetap dihitung ke kuota akun.
 */
export function Playground({ onError }: Props) {
  // Isi form.
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState<ThinkingLevel | ''>('');
  const [personaId, setPersonaId] = useState('');
  const [useMemory, setUseMemory] = useState(true);
  const [autonomous, setAutonomous] = useState(false);

  // Pilihan yang dimuat dari server.
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [defaultThinking, setDefaultThinking] = useState<ThinkingLevel | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsNote, setModelsNote] = useState('');
  const [quota, setQuota] = useState<QuotaState | null>(null);

  // Keadaan muat dan hasil.
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [showUsage, setShowUsage] = useState(false);

  /** Catat galat ke halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function fail(message: string): void {
    setFormError(message);
    onError?.(message);
  }

  /** Muat tingkat penalaran, persona, katalog model, dan kuota dari server. */
  useEffect(() => {
    let active = true;

    async function loadThinking(): Promise<void> {
      const data = await api.agentSettings();
      if (!active) return;
      const levels = Array.isArray(data?.thinkingLevels) ? data.thinkingLevels.filter(isThinkingLevel) : [];
      setThinkingLevels(levels);
      const saved = data?.settings?.thinking_level;
      setDefaultThinking(isThinkingLevel(saved) && levels.includes(saved) ? saved : levels[0] ?? null);
      setQuota(data?.quota ?? null);
    }

    async function loadPersonas(): Promise<void> {
      const data = await api.personas();
      if (!active) return;
      setPersonas(Array.isArray(data?.personas) ? data.personas : []);
    }

    async function loadModels(): Promise<void> {
      const data = await api.models();
      if (!active) return;
      const list = Array.isArray(data?.models) ? data.models : [];
      setModels(list);
      // Katalog bisa kosong saat mesin tidak tersedia; sebut alasannya apa adanya.
      setModelsNote(data?.available === false ? String(data?.error || 'Katalog model tidak tersedia saat ini.') : '');
    }

    async function loadOptions(): Promise<void> {
      setLoadingOptions(true);
      setOptionsError('');
      // Ketiga panggilan ini berdiri sendiri: satu gagal tidak menggagalkan yang lain.
      const tasks = [loadThinking(), loadPersonas(), loadModels()];
      const outcomes = await Promise.allSettled(tasks);
      if (!active) return;
      const failed = outcomes.filter((item) => item.status === 'rejected');
      if (failed.length) {
        const first = (failed[0] as PromiseRejectedResult).reason;
        const message = playgroundErrorMessage(first);
        setOptionsError(`${message} Sebagian pilihan mungkin belum lengkap.`);
      }
      setLoadingOptions(false);
    }

    void loadOptions();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Segarkan angka kuota setelah satu prompt dijalankan. */
  async function refreshQuota(): Promise<void> {
    try {
      const data = await api.agentSettings();
      setQuota(data?.quota ?? null);
    } catch {
      // Gagal menyegarkan kuota tidak membatalkan hasil; biarkan angka lama.
    }
  }

  /** Jalankan prompt di mesin tanpa menyimpan percakapan. */
  async function run(): Promise<void> {
    const clean = prompt.trim();
    setFormError('');
    if (!clean) {
      fail('Tulis pertanyaan atau prompt dulu sebelum menjalankan.');
      return;
    }
    if (clean.length > PROMPT_MAX) {
      fail(`Prompt terlalu panjang. Maksimal ${PROMPT_MAX} karakter, sedangkan prompt Anda ${clean.length} karakter.`);
      return;
    }
    setRunning(true);
    setResult(null);
    setShowUsage(false);
    try {
      const data = await api.playground({
        prompt: clean,
        model: model.trim() || undefined,
        thinking: thinking || undefined,
        personaId: personaId || undefined,
        useMemory,
        autonomous,
      });
      setResult(data);
      await refreshQuota();
    } catch (error) {
      // Jangan tampilkan hasil palsu: kosongkan hasil, lalu beri pesan galat.
      setResult(null);
      fail(playgroundErrorMessage(error));
    } finally {
      setRunning(false);
    }
  }

  const usageText = result ? JSON.stringify(result.usage ?? null, null, 2) : '';
  const hasUsage = Boolean(result) && result?.usage !== null && result?.usage !== undefined;

  return (
    <section className="space-y-5 text-sm text-slate-300">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
        <div>
          <h2 className="text-base font-semibold text-slate-100">✧ Playground</h2>
          <p className="text-slate-400">
            Coba satu prompt dengan model, persona, dan tingkat penalaran pilihan Anda. Playground tidak menyimpan
            percakapan, tetapi token yang dipakai tetap dihitung ke kuota akun.
          </p>
        </div>
        <button type="button" className={BTN} onClick={() => void refreshQuota()} disabled={loadingOptions}>
          Segarkan kuota
        </button>
      </header>

      {optionsError ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-200">{optionsError}</p>
      ) : null}

      {formError ? (
        <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300">{formError}</p>
      ) : null}

      <div className={CARD}>
        <label className={LABEL} htmlFor="playground-prompt">
          Prompt (maksimal {PROMPT_MAX} karakter)
        </label>
        <textarea
          id="playground-prompt"
          className={`${FIELD} min-h-[140px] font-mono`}
          rows={7}
          maxLength={PROMPT_MAX}
          placeholder="Tulis pertanyaan atau perintah untuk diuji di sini..."
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={running}
        />
        <p className="mt-1 text-right text-xs text-slate-500">
          {prompt.trim().length} dari {PROMPT_MAX} karakter
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className={LABEL} htmlFor="playground-model">
              Model (opsional)
            </label>
            {models.length > 0 ? (
              <select
                id="playground-model"
                className={FIELD}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={running || loadingOptions}
              >
                <option value="">Bawaan server</option>
                {models.map((row) => (
                  <option key={`${row.provider}/${row.model}`} value={row.model}>
                    {row.model} · {row.provider}
                    {row.thinking ? ' · penalaran' : ''}
                  </option>
                ))}
              </select>
            ) : (
              // Tanpa katalog model, pengguna boleh menulis nama model sendiri.
              <input
                id="playground-model"
                className={FIELD}
                type="text"
                placeholder="Kosongkan untuk bawaan server"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={running || loadingOptions}
              />
            )}
            {modelsNote ? <p className="mt-1 text-xs text-slate-500">{modelsNote}</p> : null}
          </div>

          <div>
            <label className={LABEL} htmlFor="playground-thinking">
              Tingkat penalaran
            </label>
            <select
              id="playground-thinking"
              className={FIELD}
              value={thinking}
              onChange={(event) => setThinking(isThinkingLevel(event.target.value) ? event.target.value : '')}
              disabled={running || loadingOptions}
            >
              <option value="">
                {defaultThinking ? `Bawaan akun (${defaultThinking})` : 'Bawaan akun'}
              </option>
              {thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            {thinkingLevels.length === 0 && !loadingOptions ? (
              <p className="mt-1 text-xs text-slate-500">Belum ada daftar tingkat penalaran dari server.</p>
            ) : null}
          </div>

          <div>
            <label className={LABEL} htmlFor="playground-persona">
              Persona (opsional)
            </label>
            <select
              id="playground-persona"
              className={FIELD}
              value={personaId}
              onChange={(event) => setPersonaId(event.target.value)}
              disabled={running || loadingOptions}
            >
              <option value="">Tanpa persona</option>
              {personas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name}
                  {persona.isDefault ? ' · bawaan' : ''}
                </option>
              ))}
            </select>
            {personas.length === 0 && !loadingOptions ? (
              <p className="mt-1 text-xs text-slate-500">Belum ada persona tersimpan.</p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2" htmlFor="playground-memory">
            <input
              id="playground-memory"
              type="checkbox"
              className="h-4 w-4 rounded border-slate-600 bg-slate-900"
              checked={useMemory}
              onChange={(event) => setUseMemory(event.target.checked)}
              disabled={running}
            />
            Pakai bank memori
          </label>
          <label className="flex items-center gap-2" htmlFor="playground-autonomous">
            <input
              id="playground-autonomous"
              type="checkbox"
              className="h-4 w-4 rounded border-slate-600 bg-slate-900"
              checked={autonomous}
              onChange={(event) => setAutonomous(event.target.checked)}
              disabled={running}
            />
            Mode otonom
          </label>
          <button
            type="button"
            className="rounded-lg border border-violet-500/60 bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            onClick={() => void run()}
            disabled={running || loadingOptions}
          >
            {running ? 'Menjalankan...' : 'Jalankan'}
          </button>
        </div>

        {quota ? (
          <p className="mt-3 text-xs text-slate-400">
            Kuota paket {quota.tier}: hari ini {tokenText(quota.usedToday)} dari {tokenText(quota.dailyLimit)} token,
            bulan ini {tokenText(quota.usedMonth)} dari {tokenText(quota.monthlyLimit)} token, kredit tambahan{' '}
            {tokenText(quota.creditTokens)} token.
            {quota.blocked ? ' Kuota Anda sedang habis.' : ''}
          </p>
        ) : null}
      </div>

      <div className={CARD}>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Hasil</h3>
        {running ? <p className="text-slate-400">Menunggu jawaban mesin...</p> : null}
        {!running && !result ? (
          <p className="text-slate-400">Belum ada hasil. Jalankan satu prompt untuk melihat jawabannya di sini.</p>
        ) : null}
        {result ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <p className="text-xs text-slate-400">Token</p>
                <p className="text-slate-100">{tokenText(result.tokens)}</p>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <p className="text-xs text-slate-400">Durasi</p>
                <p className="text-slate-100">{durationText(result.durationMs)}</p>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <p className="text-xs text-slate-400">Model</p>
                <p className="break-all text-slate-100">{result.model || 'Bawaan server'}</p>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <p className="text-xs text-slate-400">Tingkat penalaran</p>
                <p className="text-slate-100">{result.thinking || '-'}</p>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <p className="text-xs text-slate-400">Blok sistem</p>
                <p className="text-slate-100">{num(result.systemBlocks)} blok</p>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <p className="text-xs text-slate-400">Mode otonom</p>
                <p className="text-slate-100">{result.autonomous ? 'Ya' : 'Tidak'}</p>
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Jawaban mesin</p>
              {result.text ? (
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-slate-100">
                  {result.text}
                </pre>
              ) : (
                <p className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-400">
                  Mesin tidak mengembalikan teks jawaban.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-slate-700 bg-slate-900">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800/60"
                onClick={() => setShowUsage((current) => !current)}
                aria-expanded={showUsage}
              >
                <span>Detail usage mentah</span>
                <span className="text-slate-400">{showUsage ? 'Sembunyikan' : 'Buka'}</span>
              </button>
              {showUsage ? (
                hasUsage ? (
                  <pre className="max-h-[260px] overflow-auto border-t border-slate-700 px-3 py-2 font-mono text-xs text-slate-300">
                    {usageText}
                  </pre>
                ) : (
                  <p className="border-t border-slate-700 px-3 py-2 text-slate-400">
                    Mesin tidak melaporkan detail usage untuk run ini.
                  </p>
                )
              ) : null}
            </div>

            <p className="text-xs text-slate-500">
              Playground tidak menyimpan percakapan ini. Token tetap dihitung ke kuota akun Anda.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

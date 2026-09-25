import { useEffect, useState } from 'react';
import { api, failureOf } from './api';
import type { Persona, PlaygroundEstimate, PlaygroundResult, QuotaState, ThinkingLevel } from './api';

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

/**
 * Baca isian angka opsional. Kembalikan `undefined` bila kolom kosong atau isinya
 * bukan bilangan bulat lebih dari 0, supaya field itu tidak dikirim ke server
 * (server lalu memakai nilai bawaannya).
 */
function angkaOpsional(teks: string): number | undefined {
  const clean = teks.trim();
  if (!clean) return undefined;
  const value = Number(clean);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** Format rupiah tanpa desimal, contoh: "Rp 12.345". */
function rupiahText(value: unknown): string {
  return `Rp ${Math.round(num(value)).toLocaleString('id-ID')}`;
}

/** Format mikrodolar menjadi USD dengan 6 angka desimal supaya nilai kecil tetap terbaca. */
function microUsdText(value: unknown): string {
  return `$${(num(value) / 1e6).toFixed(6)}`;
}

/** Format persentase kuota; nilai null berarti server tidak bisa menghitungnya. */
function percentText(value: unknown): string {
  if (value === null || value === undefined) return 'tidak bisa dihitung';
  return `${num(value).toLocaleString('id-ID', { maximumFractionDigits: 2 })}%`;
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
  if (code.includes('MODEL_REQUIRED')) {
    return 'Sebutkan model yang ingin dihitung perkiraan biayanya.';
  }
  if (code.includes('MODEL_UNKNOWN')) {
    return 'Model itu tidak ada di katalog harga. Cek ejaan namanya atau pilih dari daftar model.';
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
 * Pesan galat kalkulator biaya: utamakan pesan Indonesia dari server
 * (rute estimate memakai `requestDetailed`), lalu pesan cadangan kita sendiri.
 */
function estimateErrorMessage(error: unknown): string {
  const failure = failureOf(error);
  const kodeMesin = /^[A-Z0-9_]+$/.test(failure.message); // contoh: "MODEL_REQUIRED"
  if (failure.message && !kodeMesin) return failure.message;
  return playgroundErrorMessage(new Error(failure.code));
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

  // Kalkulator biaya (butir 56): perkiraan harga jual tanpa menjalankan model.
  const [estimate, setEstimate] = useState<PlaygroundEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState('');
  // Isian opsional untuk menambah ketelitian perkiraan; kosong = pakai bawaan server.
  const [outputTokensText, setOutputTokensText] = useState('');
  const [runsText, setRunsText] = useState('');

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

  // Perkiraan lama dibuang bila prompt atau model berubah, supaya angka lama tidak menyesatkan.
  useEffect(() => {
    setEstimate(null);
    setEstimateError('');
  }, [prompt, model]);

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

  /**
   * Hitung perkiraan biaya tanpa menjalankan model (butir 56).
   * Server mewajibkan `model`, jadi bila pengguna belum memilih model kita pakai model
   * pertama dari katalog yang sudah dimuat, lalu model itu disebut di panel hasil.
   */
  async function hitungSaja(): Promise<void> {
    const clean = prompt.trim();
    setEstimateError('');
    setEstimate(null);
    if (!clean) {
      fail('Tulis pertanyaan atau prompt dulu sebelum menghitung perkiraan biaya.');
      return;
    }
    const dipilih = model.trim();
    const modelHitung = dipilih || String(models[0]?.model ?? '').trim();
    if (!modelHitung) {
      fail('Pilih model dulu. Server perlu nama model untuk menghitung perkiraan biaya, dan katalog model belum termuat.');
      return;
    }
    // Isian tidak sah (mis. 2,5 atau -3) ditolak supaya angkanya tidak menyesatkan.
    if ((outputTokensText.trim() && angkaOpsional(outputTokensText) === undefined) || (runsText.trim() && angkaOpsional(runsText) === undefined)) {
      fail('Kolom "Token keluaran" dan "Jumlah perhitungan" harus bilangan bulat lebih dari 0, atau dikosongkan untuk memakai bawaan server.');
      return;
    }
    // Field opsional hanya dikirim bila terisi dan valid; kalau kosong, server memakai bawaannya (0 dan 1).
    const isian: { model: string; prompt: string; outputTokens?: number; runs?: number } = { model: modelHitung, prompt: clean };
    const keluaran = angkaOpsional(outputTokensText);
    if (keluaran !== undefined) isian.outputTokens = keluaran;
    const jumlah = angkaOpsional(runsText);
    if (jumlah !== undefined) isian.runs = jumlah;

    setEstimating(true);
    try {
      const data = await api.playgroundEstimate(isian);
      setEstimate(data);
    } catch (error) {
      // Jangan pernah menampilkan angka palsu saat perhitungan gagal.
      setEstimate(null);
      const message = estimateErrorMessage(error);
      setEstimateError(message);
      onError?.(message);
    } finally {
      setEstimating(false);
    }
  }

  const usageText = result ? JSON.stringify(result.usage ?? null, null, 2) : '';
  const hasUsage = Boolean(result) && result?.usage !== null && result?.usage !== undefined;
  // Dipakai untuk memberi tahu pengguna bahwa hitungan memakai model pertama katalog.
  const pakaiModelPertamaKatalog = model.trim() === '';
  /** Kotak kecil untuk satu angka pada panel perkiraan biaya. */
  function kotak(judul: string, nilai: string, catatan?: string) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
        <p className="text-xs text-slate-400">{judul}</p>
        <p className="break-all text-slate-100">{nilai}</p>
        {catatan ? <p className="mt-0.5 text-xs text-slate-500">{catatan}</p> : null}
      </div>
    );
  }

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
          {/* Butir 56: hitung perkiraan biaya tanpa menjalankan model. */}
          <button
            type="button"
            data-testid="playground-estimate-button"
            className={BTN}
            onClick={() => void hitungSaja()}
            disabled={estimating || loadingOptions}
          >
            {estimating ? 'Menghitung...' : 'Hitung saja'}
          </button>
        </div>

        {/* Isian opsional kalkulator biaya (butir 56). Kosongkan untuk memakai bawaan server. */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="playground-estimate-output-tokens">
              Token keluaran (opsional)
            </label>
            <input
              id="playground-estimate-output-tokens"
              data-testid="playground-estimate-output-tokens"
              className={FIELD}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="Kosongkan = bawaan server (0)"
              value={outputTokensText}
              onChange={(event) => setOutputTokensText(event.target.value)}
              disabled={estimating}
            />
            <p className="mt-1 text-xs text-slate-500">
              Perkiraan panjang jawaban. Kolom ini hanya menambah ketelitian perkiraan biaya; tidak menyentuh kuota atau
              pemakaian token Anda.
            </p>
          </div>

          <div>
            <label className={LABEL} htmlFor="playground-estimate-runs">
              Jumlah perhitungan (opsional)
            </label>
            <input
              id="playground-estimate-runs"
              data-testid="playground-estimate-runs"
              className={FIELD}
              type="number"
              min={1}
              max={100}
              step={1}
              inputMode="numeric"
              placeholder="Kosongkan = bawaan server (1)"
              value={runsText}
              onChange={(event) => setRunsText(event.target.value)}
              disabled={estimating}
            />
            <p className="mt-1 text-xs text-slate-500">
              Berapa kali prompt ini diperkirakan dijalankan (server membatasi 1-100). Kolom ini hanya menambah ketelitian
              perkiraan biaya; tidak menyentuh kuota atau pemakaian token Anda.
            </p>
          </div>
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

      {/* Butir 56: panel perkiraan biaya. Hanya muncul setelah "Hitung saja" ditekan. */}
      {estimating || estimate || estimateError ? (
        <div className={CARD} data-testid="playground-estimate">
          <h3 className="mb-2 text-sm font-semibold text-slate-100">Perkiraan biaya</h3>
          {estimating ? <p className="text-slate-400">Menghitung perkiraan biaya...</p> : null}
          {estimateError ? (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300">{estimateError}</p>
          ) : null}
          {estimate ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {kotak(
                  'Model yang dihitung',
                  estimate.model || '—',
                  pakaiModelPertamaKatalog ? 'Anda belum memilih model, jadi dihitung dengan model pertama katalog.' : undefined,
                )}
                {kotak('Panjang prompt', `${tokenText(estimate.promptChars)} karakter`)}
                {kotak('Jumlah perhitungan', `${tokenText(estimate.tokens.runs)} kali`)}
                {kotak('Token masukan', tokenText(estimate.tokens.input))}
                {kotak('Token keluaran', tokenText(estimate.tokens.output), 'Terisi bila panjang jawaban disebutkan; biasanya 0.')}
                {kotak('Total token', tokenText(estimate.tokens.total))}
                {kotak(
                  'Harga jual per 1 juta token',
                  `${estimate.hargaJualPerJuta.mataUang} ${num(estimate.hargaJualPerJuta.input)} masuk · ${num(estimate.hargaJualPerJuta.output)} keluar`,
                  `Markup ×${num(estimate.markup)} · sumber harga: ${estimate.priceSource}`,
                )}
                {kotak(
                  'Perkiraan biaya',
                  rupiahText(estimate.estimatedCostIdr),
                  `${microUsdText(estimate.estimatedCostMicros)} (mikrodolar: ${tokenText(estimate.estimatedCostMicros)})`,
                )}
                {kotak('Kurs USD ke IDR', `1 USD = ${rupiahText(estimate.usdIdrRate)}`, `Nilai kurs: ${num(estimate.usdIdrRate)}`)}
                {kotak(
                  'Bagian dari kuota harian',
                  percentText(estimate.percentOfDailyQuota),
                  `Batas harian ${tokenText(estimate.dailyLimitTokens)} token (dihitung dari token masukan).`,
                )}
              </div>

              <p className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">{estimate.catatan}</p>
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-200">
                Angka di atas adalah <b>perkiraan harga jual</b> (sudah termasuk markup ×{num(estimate.markup)}),{' '}
                <b>bukan tagihan</b> Anda. Tekan "Hitung saja" tidak menjalankan model, jadi perhitungan ini tidak menambah
                pemakaian token atau kuota
                {estimate.tanpaEfekSamping ? ' (server menandai tanpaEfekSamping: true).' : '.'}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

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

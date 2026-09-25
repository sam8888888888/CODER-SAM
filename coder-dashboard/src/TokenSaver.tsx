import { useEffect, useState } from 'react';
import { api } from './api';
import type { AgentPreview, AgentSettings, CompactionResult, FallbackModelsResponse, QuotaState, ThinkingLevel } from './api';

/** Baris katalog model dari `/v1/models`, dipakai sebagai saran nama model cadangan. */
type KatalogModel = { provider: string; model: string };

/** Properti halaman "Penghemat token": pelapor galat dari induk. */
type Props = {
  onError?: (message: string) => void;
};

/** Kelas Tailwind dasar untuk tombol kecil di panel. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';

/** Batas nilai yang sama dengan yang diperiksa server (jangan kirim nilai di luar rentang). */
const COMPACT_MIN = 4;
const COMPACT_MAX = 500;
const TURNS_MIN = 1;
const TURNS_MAX = 50;
const TOKENS_MIN = 1000;
const TOKENS_MAX = 500000;

/** Bantuan bawaan bila server tidak mengirim teks bantuan alat. */
const TOOLS_HELP_FALLBACK =
  "Kosong = bawaan mesin. Isi 'none' untuk tanpa alat. Atau daftar nama alat dipisah koma.";
/** Bantuan bawaan bila server tidak mengirim teks bantuan mode otonom. */
const AUTONOMOUS_HELP_FALLBACK =
  'Mode otonom menjalankan mesin sampai batas langkah/token, bukan sekali jawab.';

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Paksa nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Tulis angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Ubah jumlah byte menjadi ukuran yang mudah dibaca. */
function byteText(value: unknown): string {
  const bytes = num(value);
  if (bytes < 1024) return `${numberText(bytes)} byte`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let step = 0;
  while (size >= 1024 && step < units.length - 1) {
    size = size / 1024;
    step += 1;
  }
  return `${size.toFixed(1)} ${units[step]}`;
}

/** Format waktu ISO menjadi tanggal dan jam Indonesia; nilai kosong ditulis tanda hubung. */
function timeText(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('id-ID');
}

/** Nama Indonesia untuk tingkat penalaran; dipakai hanya sebagai label tampilan. */
function levelLabel(level: string): string {
  if (level === 'off') return 'nonaktif';
  if (level === 'minimal') return 'minimal';
  if (level === 'low') return 'rendah';
  if (level === 'medium') return 'sedang';
  if (level === 'high') return 'tinggi';
  if (level === 'xhigh') return 'sangat tinggi';
  if (level === 'max') return 'maksimal';
  return level;
}

/** Ringkas isi allowlist alat supaya pengguna tahu apa yang akan dikirim ke mesin. */
function toolsSummary(toolsAllow: string): string {
  const value = toolsAllow.trim();
  if (!value) return 'Kosong: mesin memakai daftar alat bawaannya.';
  if (value === 'none') return 'Semua alat dimatikan untuk akun Anda.';
  const names = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (names.length === 0) return 'Kosong: mesin memakai daftar alat bawaannya.';
  return `Allowlist aktif: ${names.join(', ')} (${names.length} alat).`;
}

/** Label sumber hasil pemadatan; "fallback" berarti ringkasan mesin gagal dipakai. */
function sourceLabel(source: string): string {
  if (source === 'engine') return 'mesin (ringkasan asli)';
  if (source === 'fallback') return 'cadangan (transkrip dipotong, ringkasan mesin tidak tersedia)';
  return source;
}

/** Ubah kode galat server menjadi kalimat Indonesia yang jelas. */
function agentErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('INVALID_THINKING_LEVEL')) return 'Tingkat penalaran itu tidak dikenal. Muat ulang halaman, lalu pilih lagi.';
  if (code.includes('INVALID_COMPACT_THRESHOLD'))
    return `Ambang pemadatan harus antara ${COMPACT_MIN} dan ${COMPACT_MAX} pesan.`;
  if (code.includes('INVALID_AUTONOMOUS_TURNS')) return `Batas langkah harus antara ${TURNS_MIN} dan ${TURNS_MAX}.`;
  if (code.includes('INVALID_AUTONOMOUS_TOKENS'))
    return `Batas token harus antara ${numberText(TOKENS_MIN)} dan ${numberText(TOKENS_MAX)}.`;
  // Wave 11A (butir 57): susunan model cadangan ditolak server (duplikat, sama dengan model utama,
  // atau lebih dari tiga baris). Pesan asli dari server sudah berbahasa Indonesia.
  if (code.includes('INVALID_FALLBACK_MODELS'))
    return 'Susunan model cadangan ditolak: maksimal 3 model, tidak boleh sama satu sama lain, dan tidak boleh sama dengan model utama.';
  if (code.includes('CONVERSATION_NOT_FOUND')) return 'Percakapan tidak ditemukan atau bukan milik workspace Anda.';
  if (code.includes('VIEWER_READ_ONLY')) return 'Peran Anda di workspace ini hanya baca, jadi tidak boleh memadatkan percakapan.';
  if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN') || code.includes('SESSION'))
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  return fallback;
}

/** Ubah angka dari input teks menjadi bilangan bulat; kembalikan null bila kosong/aneh. */
function parseInteger(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

/**
 * Halaman "Penghemat token": pengaturan penalaran, allowlist alat, pemadatan otomatis,
 * mode otonom bawaan, pratinjau yang dikirim ke mesin, dan tombol padatkan sekarang.
 * Semua nilai diambil dari /v1/agents/settings; tidak ada angka yang dikarang di sini.
 */
export function TokenSaver({ onError }: Props) {
  // Data server: pengaturan, daftar tingkat penalaran, kuota, dan teks bantuan.
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [toolsAllowHelp, setToolsAllowHelp] = useState('');
  const [autonomousHelp, setAutonomousHelp] = useState('');
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Isi form; disimpan sebagai teks dulu supaya kotak angka tidak berisi NaN.
  const [thinking, setThinking] = useState<string>('');
  const [toolsAllow, setToolsAllow] = useState('');
  const [autoCompact, setAutoCompact] = useState(false);
  const [compactAfter, setCompactAfter] = useState('');
  const [autonomousDefault, setAutonomousDefault] = useState(false);
  const [autonomousMaxTurns, setAutonomousMaxTurns] = useState('');
  const [autonomousMaxTokens, setAutonomousMaxTokens] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');

  // Wave 11A (butir 57): urutan model cadangan + keterangan batas dari server.
  const [fallback, setFallback] = useState<string[]>([]);
  const [fallbackInfo, setFallbackInfo] = useState<FallbackModelsResponse | null>(null);
  const [fallbackError, setFallbackError] = useState('');
  const [katalog, setKatalog] = useState<string[]>([]);
  const [modelUtama, setModelUtama] = useState('');

  // Panel pratinjau.
  const [previewId, setPreviewId] = useState('');
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [blocksOpen, setBlocksOpen] = useState(false);

  // Panel "Padatkan sekarang".
  const [compactId, setCompactId] = useState('');
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState('');
  const [compactResult, setCompactResult] = useState<CompactionResult | null>(null);

  /** Catat galat ke halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function fail(message: string): void {
    onError?.(message);
  }

  /** Isi form dari pengaturan server supaya yang tampil selalu nilai nyata. */
  function applySettings(row: AgentSettings): void {
    setSettings(row);
    setThinking(String(row.thinking_level ?? ''));
    setToolsAllow(String(row.tools_allow ?? ''));
    setAutoCompact(num(row.auto_compact) === 1);
    setCompactAfter(String(num(row.compact_after_messages)));
    setAutonomousDefault(num(row.autonomous_default) === 1);
    setAutonomousMaxTurns(String(num(row.autonomous_max_turns)));
    setAutonomousMaxTokens(String(num(row.autonomous_max_tokens)));
  }

  /** Susun ulang satu baris model cadangan tanpa mengubah isi baris lain. */
  function ubahBaris(index: number, value: string): void {
    setFallback((daftar) => daftar.map((item, posisi) => (posisi === index ? value : item)));
    setSaveError('');
    setNotice('');
  }

  /** Tambah satu baris kosong di akhir; batas maksimum diambil dari server. */
  function tambahBaris(): void {
    const batas = fallbackInfo ? num(fallbackInfo.maxModels) : 3;
    if (fallback.length >= batas) { setFallbackError(`Maksimal ${batas} model cadangan.`); return; }
    setFallbackError('');
    setFallback((daftar) => [...daftar, '']);
  }

  /** Buang satu baris model cadangan. */
  function hapusBaris(index: number): void {
    setFallback((daftar) => daftar.filter((_, posisi) => posisi !== index));
    setFallbackError('');
    setSaveError('');
    setNotice('');
  }

  /** Geser satu baris naik atau turun; urutan menentukan urutan pemakaian saat galat sementara. */
  function geserBaris(index: number, arah: -1 | 1): void {
    const tujuan = index + arah;
    if (tujuan < 0) return;
    setFallback((daftar) => {
      if (tujuan >= daftar.length) return daftar;
      const salinan = [...daftar];
      const sementara = salinan[index];
      salinan[index] = salinan[tujuan];
      salinan[tujuan] = sementara;
      return salinan;
    });
    setFallbackError('');
    setSaveError('');
    setNotice('');
  }

  /** Muat batas fallback dari server plus katalog model untuk saran nama. */
  async function loadFallbackInfo(): Promise<void> {
    setFallbackError('');
    try {
      const data = await api.fallbackModels();
      setFallbackInfo(data);
      setFallback((daftar) => (daftar.length ? daftar : (Array.isArray(data.models) ? data.models : [])));
    } catch (error) {
      setFallbackInfo(null);
      setFallbackError(agentErrorMessage(error, 'Batas model cadangan gagal dibaca dari server.'));
    }
    try {
      const data = await api.models();
      const baris: KatalogModel[] = Array.isArray(data?.models) ? data.models : [];
      setKatalog(baris.map((row) => String(row.model ?? '')).filter(Boolean));
      setModelUtama(String(data?.default?.model ?? ''));
    } catch {
      // Katalog hanya saran: tanpa katalog, nama model tetap bisa ditulis manual.
      setKatalog([]);
    }
  }

  /** Muat pengaturan agen dari server. */
  async function loadSettings(): Promise<void> {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.agentSettings();
      applySettings(data.settings);
      setFallback(Array.isArray(data.fallbackModels) ? data.fallbackModels : []);
      if (data.fallbackHelp) setFallbackError('');
      void loadFallbackInfo();
      setThinkingLevels(Array.isArray(data.thinkingLevels) ? data.thinkingLevels : []);
      setToolsAllowHelp(String(data.toolsAllowHelp ?? ''));
      setAutonomousHelp(String(data.autonomousHelp ?? ''));
      setQuota(data.quota ?? null);
    } catch (error) {
      // Jangan tampilkan angka palsu: kosongkan pengaturan, lalu beri pesan galat.
      setSettings(null);
      setThinkingLevels([]);
      setQuota(null);
      const message = agentErrorMessage(error, 'Pengaturan agen gagal dimuat dari server.');
      setLoadError(message);
      fail(message);
    } finally {
      setLoading(false);
    }
  }

  /** Muat pratinjau; tanpa id percakapan berarti pratinjau umum untuk akun ini. */
  async function loadPreview(): Promise<void> {
    setPreviewBusy(true);
    setPreviewError('');
    const clean = previewId.trim();
    try {
      const data = await api.agentPreview(clean || undefined);
      setPreview(data);
    } catch (error) {
      setPreview(null);
      const message = agentErrorMessage(error, 'Pratinjau gagal dimuat. Periksa id percakapan, lalu coba lagi.');
      setPreviewError(message);
      fail(message);
    } finally {
      setPreviewBusy(false);
    }
  }

  /** Simpan seluruh pengaturan agen setelah rentang nilai diperiksa di sisi klien. */
  async function saveSettings(): Promise<void> {
    setSaveError('');
    setNotice('');
    if (!thinking) {
      setSaveError('Pilih dulu tingkat penalaran.');
      return;
    }
    const after = parseInteger(compactAfter);
    if (autoCompact && (after === null || after < COMPACT_MIN || after > COMPACT_MAX)) {
      setSaveError(`Ambang pemadatan harus angka antara ${COMPACT_MIN} dan ${COMPACT_MAX} pesan.`);
      return;
    }
    const turns = parseInteger(autonomousMaxTurns);
    if (autonomousDefault && (turns === null || turns < TURNS_MIN || turns > TURNS_MAX)) {
      setSaveError(`Batas langkah harus angka antara ${TURNS_MIN} dan ${TURNS_MAX}.`);
      return;
    }
    const tokens = parseInteger(autonomousMaxTokens);
    if (autonomousDefault && (tokens === null || tokens < TOKENS_MIN || tokens > TOKENS_MAX)) {
      setSaveError(`Batas token harus angka antara ${numberText(TOKENS_MIN)} dan ${numberText(TOKENS_MAX)}.`);
      return;
    }
    setSaving(true);
    try {
      const patch: Parameters<typeof api.saveAgentSettings>[0] = {
        thinkingLevel: thinking as ThinkingLevel,
        autoCompact,
        toolsAllow,
        autonomousDefault,
      };
      if (after !== null) patch.compactAfterMessages = after;
      if (turns !== null) patch.autonomousMaxTurns = turns;
      if (tokens !== null) patch.autonomousMaxTokens = tokens;
      // Wave 11A (butir 57): hanya nama yang terisi yang dikirim; server memeriksa duplikat,
      // jumlah maksimum, dan bentrokan dengan model utama.
      const cadangan = fallback.map((item) => item.trim()).filter(Boolean);
      if (cadangan.length > 1 && new Set(cadangan).size !== cadangan.length) {
        setSaveError('Model cadangan tidak boleh sama satu sama lain.');
        return;
      }
      if (modelUtama && cadangan.includes(modelUtama)) {
        setSaveError(`Model utama (${modelUtama}) tidak boleh dipakai sebagai model cadangan.`);
        return;
      }
      const batasCadangan = fallbackInfo ? num(fallbackInfo.maxModels) : 3;
      if (cadangan.length > batasCadangan) {
        setSaveError(`Maksimal ${batasCadangan} model cadangan.`);
        return;
      }
      patch.fallbackModels = cadangan;
      if (modelUtama) patch.modelUtama = modelUtama;
      const result = await api.saveAgentSettings(patch);
      applySettings(result.settings);
      // Pesan jujur: baru ditulis setelah server membalas pengaturan tersimpan.
      setNotice(`Pengaturan agen sudah tersimpan. Tingkat penalaran sekarang: ${levelLabel(result.settings.thinking_level)}.`);
      await loadPreview();
    } catch (error) {
      const message = agentErrorMessage(error, 'Pengaturan gagal disimpan. Periksa nilai yang diisi, lalu coba lagi.');
      setSaveError(message);
      fail(message);
    } finally {
      setSaving(false);
    }
  }

  /** Padatkan satu percakapan sekarang, lalu tampilkan hasil nyata dari server. */
  async function compactNow(): Promise<void> {
    const id = compactId.trim();
    setCompactError('');
    setCompactResult(null);
    if (!id) {
      setCompactError('Masukkan id percakapan dulu.');
      return;
    }
    setCompacting(true);
    try {
      const result = await api.compactConversation(id);
      setCompactResult(result);
      await loadPreview();
    } catch (error) {
      const message = agentErrorMessage(error, 'Pemadatan gagal diproses server.');
      setCompactError(message);
      fail(message);
    } finally {
      setCompacting(false);
    }
  }

  // Muat pengaturan sekali, lalu ambil pratinjau umum tanpa argumen percakapan.
  useEffect(() => {
    void loadSettings();
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const helpTools = toolsAllowHelp || TOOLS_HELP_FALLBACK;
  const helpAutonomous = autonomousHelp || AUTONOMOUS_HELP_FALLBACK;
  const previewConversation = preview?.conversation ?? null;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <h2 className="mb-1 text-base font-semibold text-slate-100">◈ Penghemat token</h2>
      <p className="mb-3 text-slate-400">
        Atur tingkat penalaran, allowlist alat, dan pemadatan otomatis. Nilai di halaman ini dibaca dari
        server /v1/agents/settings saat halaman dibuka.
      </p>

      {loading ? <p className="text-slate-400">Memuat pengaturan agen…</p> : null}
      {loadError ? <p className="text-slate-100">{loadError}</p> : null}
      {!loading && !loadError && !settings ? <p className="text-slate-400">Belum ada pengaturan agen dari server.</p> : null}

      {settings ? (
        <>
          <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <h3 className="mb-2 text-sm font-semibold text-slate-100">Pengaturan agen</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-slate-300">
                Tingkat penalaran
                <select
                  className={FIELD}
                  value={thinking}
                  aria-label="Tingkat penalaran agen"
                  onChange={(event) => {
                    setThinking(event.target.value);
                    setSaveError('');
                    setNotice('');
                  }}
                >
                  {thinkingLevels.length === 0 ? <option value="">Tidak ada pilihan dari server</option> : null}
                  {thinkingLevels.map((level) => (
                    <option key={level} value={level}>
                      {level} — {levelLabel(level)}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-400">
                  Level lebih rendah membuat mesin berpikir lebih sedikit, jadi token berpikir (flag --thinking)
                  ikut turun. Level lebih tinggi memakai token lebih banyak untuk hasil yang lebih teliti.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-slate-300">
                Allowlist alat (toolsAllow)
                <input
                  className={FIELD}
                  type="text"
                  value={toolsAllow}
                  maxLength={400}
                  placeholder="Contoh: none, atau nama alat dipisah koma"
                  aria-label="Daftar alat yang diizinkan"
                  onChange={(event) => {
                    setToolsAllow(event.target.value);
                    setSaveError('');
                    setNotice('');
                  }}
                />
                <span className="text-xs text-slate-400">{helpTools}</span>
                <span className="text-xs text-slate-400">{toolsSummary(toolsAllow)}</span>
              </label>

              <label className="flex flex-col gap-1 text-slate-300">
                Ambang pemadatan otomatis (pesan)
                <input
                  className={FIELD}
                  type="number"
                  min={COMPACT_MIN}
                  max={COMPACT_MAX}
                  step={1}
                  value={compactAfter}
                  aria-label="Jumlah pesan sebelum pemadatan otomatis"
                  onChange={(event) => {
                    setCompactAfter(event.target.value);
                    setSaveError('');
                    setNotice('');
                  }}
                />
                <span className="text-xs text-slate-400">
                  Berlaku bila pemadatan otomatis aktif. Rentang {COMPACT_MIN}-{COMPACT_MAX} pesan.
                </span>
              </label>

              <label className="flex items-center gap-2 self-end text-slate-300">
                <input
                  type="checkbox"
                  checked={autoCompact}
                  onChange={(event) => {
                    setAutoCompact(event.target.checked);
                    setSaveError('');
                    setNotice('');
                  }}
                />
                Pemadatan otomatis aktif
              </label>

              <label className="flex items-center gap-2 text-slate-300">
                <input
                  type="checkbox"
                  checked={autonomousDefault}
                  onChange={(event) => {
                    setAutonomousDefault(event.target.checked);
                    setSaveError('');
                    setNotice('');
                  }}
                />
                Mode otonom aktif sebagai bawaan
              </label>

              <label className="flex flex-col gap-1 text-slate-300">
                Batas langkah otonom
                <input
                  className={FIELD}
                  type="number"
                  min={TURNS_MIN}
                  max={TURNS_MAX}
                  step={1}
                  value={autonomousMaxTurns}
                  aria-label="Batas langkah mode otonom"
                  onChange={(event) => {
                    setAutonomousMaxTurns(event.target.value);
                    setSaveError('');
                    setNotice('');
                  }}
                />
                <span className="text-xs text-slate-400">
                  Rentang {TURNS_MIN}-{TURNS_MAX} langkah.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-slate-300">
                Batas token otonom
                <input
                  className={FIELD}
                  type="number"
                  min={TOKENS_MIN}
                  max={TOKENS_MAX}
                  step={1000}
                  value={autonomousMaxTokens}
                  aria-label="Batas token mode otonom"
                  onChange={(event) => {
                    setAutonomousMaxTokens(event.target.value);
                    setSaveError('');
                    setNotice('');
                  }}
                />
                <span className="text-xs text-slate-400">
                  Rentang {numberText(TOKENS_MIN)}-{numberText(TOKENS_MAX)} token. {helpAutonomous}
                </span>
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={BTN} disabled={saving} onClick={() => { void saveSettings(); }}>
                {saving ? 'Menyimpan…' : 'Simpan pengaturan'}
              </button>
              <button type="button" className={BTN} disabled={saving || loading} onClick={() => { void loadSettings(); }}>
                Muat ulang dari server
              </button>
            </div>
            {saveError ? <p className="mt-2 text-slate-100">{saveError}</p> : null}
            {notice ? <p className="mt-2 text-slate-100">{notice}</p> : null}

            <p className="mt-2 text-xs text-slate-400">
              Kuota akun saat ini:{' '}
              {quota
                ? `${numberText(quota.usedToday)} dari ${
                    num(quota.dailyLimit) === 0 ? 'tak terbatas' : numberText(quota.dailyLimit)
                  } token hari ini, kredit ${numberText(quota.creditTokens)} token${
                    quota.blocked ? ` (dibatasi: ${String(quota.reason ?? 'kuota habis')})` : ''
                  }.`
                : 'belum dilaporkan server.'}
            </p>

            {/* Wave 11A (butir 57): urutan model cadangan. */}
            <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3" data-testid="fallback-models">
              <h4 className="mb-1 text-sm font-semibold text-slate-100">Model cadangan (urutan pemakaian)</h4>
              <p className="mb-2 text-xs text-slate-400">
                {fallbackInfo
                  ? fallbackInfo.help
                  : 'Model cadangan dipakai berurutan hanya saat galat sementara (429, 5xx, timeout).'}
                {fallbackInfo ? ` Maksimal ${num(fallbackInfo.maxModels)} model dan ${num(fallbackInfo.maxSwitchesPerRun)} perpindahan per run.` : ''}
                {modelUtama ? ` Model utama saat ini: ${modelUtama}.` : ''}
              </p>
              {fallback.map((nama, index) => (
                <div key={`fallback-${index}`} className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="w-16 text-xs text-slate-400">Urutan {index + 1}</span>
                  <input
                    className={FIELD}
                    type="text"
                    list="coblai-model-catalog"
                    value={nama}
                    placeholder="nama model, mis. openai/gpt-4o-mini"
                    aria-label={`Model cadangan urutan ${index + 1}`}
                    data-testid={`fallback-input-${index}`}
                    onChange={(event) => ubahBaris(index, event.target.value)}
                  />
                  <button type="button" className={BTN} data-testid={`fallback-up-${index}`} disabled={index === 0} title="Naikkan urutan" onClick={() => geserBaris(index, -1)}>▲</button>
                  <button type="button" className={BTN} data-testid={`fallback-down-${index}`} disabled={index >= fallback.length - 1} title="Turunkan urutan" onClick={() => geserBaris(index, 1)}>▼</button>
                  <button type="button" className={BTN} data-testid={`fallback-remove-${index}`} title="Buang model cadangan ini" onClick={() => hapusBaris(index)}>✕</button>
                </div>
              ))}
              <datalist id="coblai-model-catalog">
                {katalog.filter((namaModel) => namaModel !== modelUtama).map((namaModel) => <option key={namaModel} value={namaModel} />)}
              </datalist>
              <button
                type="button"
                className={BTN}
                data-testid="fallback-add"
                disabled={fallbackInfo !== null && fallback.length >= num(fallbackInfo.maxModels)}
                onClick={tambahBaris}
              >
                ＋ Tambah model cadangan
              </button>
              {!fallback.length ? <p className="mt-2 text-xs text-slate-400" data-testid="fallback-empty">Belum ada model cadangan: saat penyedia gagal permanen, run berhenti dengan galat jelas (ENGINE_UNAVAILABLE).</p> : null}
              {fallbackError ? <p className="mt-2 text-xs text-slate-100">{fallbackError}</p> : null}
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <h3 className="mb-1 text-sm font-semibold text-slate-100">Pratinjau yang dikirim</h3>
            <p className="mb-2 text-xs text-slate-400">
              Isi id percakapan bila ingin melihat pratinjau percakapan tertentu. Bila dikosongkan, pratinjau
              diambil tanpa id percakapan.
            </p>
            <div className="mb-2 flex flex-wrap items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-slate-300">
                Id percakapan (opsional)
                <input
                  className={FIELD}
                  type="text"
                  value={previewId}
                  placeholder="contoh: 0f2c… (biarkan kosong untuk pratinjau umum)"
                  aria-label="Id percakapan untuk pratinjau"
                  onChange={(event) => {
                    setPreviewId(event.target.value);
                    setPreviewError('');
                  }}
                />
              </label>
              <button type="button" className={BTN} disabled={previewBusy} onClick={() => { void loadPreview(); }}>
                {previewBusy ? 'Memuat…' : 'Muat pratinjau'}
              </button>
            </div>
            {previewError ? <p className="text-slate-100">{previewError}</p> : null}

            {preview ? (
              <div className="flex flex-col gap-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                    <p className="text-xs text-slate-400">Pesan</p>
                    <p className="text-slate-100">{numberText(preview.messages)}</p>
                  </div>
                  <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                    <p className="text-xs text-slate-400">Ringkasan pemadatan</p>
                    <p className="text-slate-100">{numberText(preview.summaryCount)}</p>
                  </div>
                  <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                    <p className="text-xs text-slate-400">Sesi mesin</p>
                    <p className="text-slate-100">
                      {preview.session
                        ? `${numberText(preview.session.files)} berkas, ${byteText(preview.session.bytes)}`
                        : 'Belum ada sesi mesin'}
                    </p>
                    <p className="text-xs text-slate-400">
                      Terbaru: {preview.session ? timeText(preview.session.newest) : '—'}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-xs text-slate-400">Percakapan</p>
                  {previewConversation ? (
                    <p className="text-slate-100">
                      {previewConversation.id} · sesi mesin {previewConversation.engineSessionId ?? 'belum ada'} ·
                      dipadatkan {timeText(previewConversation.compactedAt)} · persona{' '}
                      {previewConversation.personaId ?? 'bawaan'}
                    </p>
                  ) : (
                    <p className="text-slate-400">Belum ada percakapan pada pratinjau ini.</p>
                  )}
                </div>

                <div>
                  <p className="mb-1 text-xs text-slate-400">Persona aktif</p>
                  {preview.persona ? (
                    <p className="text-slate-100">
                      {preview.persona.name} · gaya {preview.persona.tone || '—'} · bahasa{' '}
                      {preview.persona.language || '—'} · penalaran {levelLabel(preview.persona.thinkingLevel)}
                    </p>
                  ) : (
                    <p className="text-slate-400">Belum ada persona khusus; mesin memakai bawaan.</p>
                  )}
                </div>

                <div>
                  <p className="mb-1 text-xs text-slate-400">Flag yang akan dikirim</p>
                  {preview.flags.length === 0 ? (
                    <p className="text-slate-400">Belum ada flag yang dilaporkan server.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {preview.flags.map((flag, index) => (
                        <li
                          key={`flag-${index}`}
                          className="rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 font-mono text-xs text-slate-100"
                        >
                          {flag}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <p className="text-xs text-slate-400">Blok sistem: {numberText(preview.blocks.length)}</p>
                    <button
                      type="button"
                      className={BTN}
                      aria-expanded={blocksOpen}
                      disabled={preview.blocks.length === 0}
                      onClick={() => setBlocksOpen((value) => !value)}
                    >
                      {blocksOpen ? 'Tutup blok' : 'Buka blok'}
                    </button>
                  </div>
                  {preview.blocks.length === 0 ? (
                    <p className="text-slate-400">Belum ada blok sistem yang dikirim.</p>
                  ) : blocksOpen ? (
                    <ul className="flex flex-col gap-2">
                      {preview.blocks.map((block, index) => (
                        <li key={`block-${index}`} className="rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                          <details>
                            <summary className="cursor-pointer text-slate-100">Blok {index + 1}</summary>
                            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
                              {block}
                            </pre>
                          </details>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div>
                  <p className="mb-1 text-xs text-slate-400">Catatan</p>
                  {preview.notes.length === 0 ? (
                    <p className="text-slate-400">Belum ada catatan dari server.</p>
                  ) : (
                    <ul className="ml-4 list-disc text-slate-200">
                      {preview.notes.map((note, index) => (
                        <li key={`note-${index}`}>{note}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : !previewBusy && !previewError ? (
              <p className="text-slate-400">Belum ada data pratinjau. Tekan "Muat pratinjau".</p>
            ) : null}
          </div>

          <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <h3 className="mb-1 text-sm font-semibold text-slate-100">Padatkan sekarang</h3>
            <p className="mb-2 text-xs text-slate-400">
              Pemadatan meminta mesin meringkas percakapan, lalu mengganti sesi mesin dengan sesi baru. Riwayat
              asli tetap tersimpan, tetapi tidak lagi dikirim penuh ke model.
            </p>
            <label className="mb-2 flex flex-col gap-1 text-slate-300">
              Id percakapan
              <input
                className={FIELD}
                type="text"
                value={compactId}
                placeholder="tempel id percakapan yang mau dipadatkan"
                aria-label="Id percakapan yang akan dipadatkan"
                onChange={(event) => {
                  setCompactId(event.target.value);
                  setCompactError('');
                  setCompactResult(null);
                }}
              />
            </label>
            {compactId.trim() ? (
              <button type="button" className={BTN} disabled={compacting} onClick={() => { void compactNow(); }}>
                {compacting ? 'Memadatkan…' : 'Padatkan sekarang'}
              </button>
            ) : (
              <p className="text-slate-400">Masukkan id percakapan dulu supaya tombol "Padatkan sekarang" muncul.</p>
            )}
            {compactError ? <p className="mt-2 text-slate-100">{compactError}</p> : null}

            {compactResult ? (
              <div className="mt-2 rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                <p className="text-slate-100">
                  Pemadatan selesai. Pesan tercakup: {numberText(compactResult.messagesCovered)} · karakter sebelum{' '}
                  {numberText(compactResult.charsBefore)} · karakter sesudah {numberText(compactResult.charsAfter)} ·
                  sumber {sourceLabel(compactResult.source)}
                </p>
                <p className="mt-1 text-xs text-slate-400">Sesi mesin baru: {compactResult.engineSessionId}</p>
                <p className="mt-2 text-xs text-slate-400">Ringkasan</p>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
                  {compactResult.summary || 'Belum ada ringkasan yang dikembalikan server.'}
                </pre>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { api } from './api';
import type { Persona, ThinkingLevel } from './api';
import { PersonaTransfer } from './PersonaTransfer';

/** Properti halaman "Persona agen": pelapor galat dari induk halaman. */
type Props = {
  onError?: (message: string) => void;
};

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input, textarea, dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas pembungkus kartu persona dan panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';

/** Batas isian yang dipakai server; disalin di UI supaya pengguna tahu batasnya. */
const NAME_MAX = 120;
const SYSTEM_MAX = 8000;
const TONE_MAX = 300;

/** Satu baris katalog model dari api.models(). */
type ModelRow = { provider: string; model: string; context: string; maxOutput: string; thinking: boolean; images: boolean };

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Terjemahkan kode galat persona menjadi kalimat Indonesia yang jelas. */
function personaErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('PERSONA_NOT_FOUND')) {
    return 'Persona itu tidak ditemukan di server. Muat ulang daftar persona.';
  }
  if (code.includes('INVALID_PERSONA')) {
    return 'Nama dan system prompt wajib diisi. Nama maksimal 120 karakter.';
  }
  if (code.includes('UNKNOWN_MODEL')) {
    return 'Model itu tidak ada di katalog mesin agen. Pilih model dari daftar, atau kosongkan kolom model.';
  }
  if (code.includes('INVALID_THINKING_LEVEL')) {
    return 'Tingkat penalaran itu tidak dikenal server. Pilih salah satu nilai pada daftar.';
  }
  if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  }
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  }
  return fallback;
}

/** Format tanggal Indonesia; nilai kosong ditulis sebagai tanda hubung. */
function formatDate(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Label bahasa persona. */
function languageLabel(value: unknown): string {
  return String(value ?? '') === 'en' ? 'Inggris' : 'Indonesia';
}

/** Tandai persona default; server menyimpan 1 = default. */
function isDefault(persona: Persona): boolean {
  return Number(persona?.isDefault) === 1;
}

/**
 * Halaman "Persona agen".
 *
 * Menampilkan daftar persona (nama, system prompt, gaya, bahasa, model, tingkat
 * penalaran), form buat dan edit, penanda persona default, dan hapus dengan
 * konfirmasi. Tingkat penalaran diambil dari api.agentSettings().thinkingLevels
 * dan daftar model dari api.models() supaya nilai yang dikirim pasti diterima server.
 */
export function Personas({ onError }: Props) {
  // Daftar persona dari server.
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');

  // Katalog mesin: daftar model dan tingkat penalaran yang dikenal server.
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsNote, setModelsNote] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [thinkingLevels, setThinkingLevels] = useState<ThinkingLevel[]>([]);
  const [settingsNote, setSettingsNote] = useState('');

  // Form buat persona.
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [tone, setTone] = useState('');
  const [language, setLanguage] = useState('id');
  const [model, setModel] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);

  // Panel edit (satu persona terbuka sekaligus).
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editSystemPrompt, setEditSystemPrompt] = useState('');
  const [editTone, setEditTone] = useState('');
  const [editLanguage, setEditLanguage] = useState('id');
  const [editModel, setEditModel] = useState('');
  const [editThinkingLevel, setEditThinkingLevel] = useState('');
  const [editError, setEditError] = useState('');
  const [savingId, setSavingId] = useState('');

  // Aksi per baris dan konfirmasi hapus.
  const [busyId, setBusyId] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  /** Catat galat di halaman ini dan teruskan ke induk. */
  function fail(message: string): void {
    onError?.(message);
  }

  /** Muat ulang daftar persona dari server. */
  async function loadPersonas(): Promise<void> {
    setLoading(true);
    setListError('');
    try {
      const data = await api.personas();
      setPersonas(Array.isArray(data?.personas) ? data.personas : []);
    } catch (error) {
      // Jangan tampilkan data lama seolah masih benar: kosongkan daftar.
      setPersonas([]);
      const message = personaErrorMessage(error, 'Gagal memuat daftar persona. Coba lagi sebentar lagi.');
      setListError(message);
      fail(message);
    } finally {
      setLoading(false);
    }
  }

  /** Muat katalog model mesin agen untuk pilihan model persona. */
  async function loadModels(): Promise<void> {
    setModelsLoading(true);
    try {
      const data = await api.models();
      const rows = Array.isArray(data?.models) ? data.models : [];
      setModels(rows);
      // Bila katalog kosong, server menerima nama model apa pun, jadi kolom teks tetap dipakai.
      setModelsNote(
        rows.length === 0
          ? String(data?.error ?? '') ||
              'Mesin agen belum melaporkan daftar model. Nama model bisa ditulis bebas; server memeriksanya saat menyimpan.'
          : '',
      );
    } catch (error) {
      setModels([]);
      setModelsNote(
        personaErrorMessage(error, 'Daftar model tidak bisa dimuat. Nama model bisa ditulis bebas; server memeriksanya saat menyimpan.'),
      );
    } finally {
      setModelsLoading(false);
    }
  }

  /** Muat tingkat penalaran yang dikenal server dari pengaturan agen. */
  async function loadThinkingLevels(): Promise<void> {
    try {
      const data = await api.agentSettings();
      const levels = Array.isArray(data?.thinkingLevels) ? data.thinkingLevels : [];
      setThinkingLevels(levels);
      setSettingsNote(
        levels.length === 0 ? 'Server belum melaporkan tingkat penalaran. Persona baru memakai bawaan server.' : '',
      );
      // Bawaan form mengikuti tingkat penalaran akun saat ini.
      setThinkingLevel((current) => current || String(data?.settings?.thinking_level ?? ''));
    } catch (error) {
      setThinkingLevels([]);
      setSettingsNote(
        personaErrorMessage(error, 'Tingkat penalaran tidak bisa dimuat. Persona baru memakai bawaan server.'),
      );
    }
  }

  // Muat semua data sekali saat halaman dibuka.
  useEffect(() => {
    void loadPersonas();
    void loadModels();
    void loadThinkingLevels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tutup panel edit dan bersihkan isinya. */
  function closeEdit(): void {
    setEditId(null);
    setEditName('');
    setEditSystemPrompt('');
    setEditTone('');
    setEditLanguage('id');
    setEditModel('');
    setEditThinkingLevel('');
    setEditError('');
  }

  /** Buka panel edit untuk satu persona dan isi nilainya. */
  function openEdit(persona: Persona): void {
    setEditId(persona.id);
    setEditName(String(persona?.name ?? ''));
    setEditSystemPrompt(String(persona?.systemPrompt ?? ''));
    setEditTone(String(persona?.tone ?? ''));
    setEditLanguage(String(persona?.language ?? 'id') === 'en' ? 'en' : 'id');
    setEditModel(String(persona?.model ?? ''));
    setEditThinkingLevel(String(persona?.thinkingLevel ?? ''));
    setEditError('');
    setNotice('');
    setConfirmId(null);
  }

  /** Buat persona baru, lalu muat ulang daftar. */
  async function createPersona(): Promise<void> {
    setFormError('');
    setNotice('');
    const cleanName = name.trim();
    const cleanPrompt = systemPrompt.trim();
    if (!cleanName) {
      setFormError('Nama persona wajib diisi.');
      return;
    }
    if (cleanName.length > NAME_MAX) {
      setFormError(`Nama persona maksimal ${NAME_MAX} karakter.`);
      return;
    }
    if (!cleanPrompt) {
      setFormError('System prompt wajib diisi.');
      return;
    }
    setCreating(true);
    try {
      const created = await api.createPersona({
        name: cleanName,
        systemPrompt: cleanPrompt.slice(0, SYSTEM_MAX),
        tone: tone.trim().slice(0, TONE_MAX) || undefined,
        language,
        model: model.trim() || undefined,
        thinkingLevel: thinkingLevel ? (thinkingLevel as ThinkingLevel) : undefined,
        makeDefault,
      });
      const saved = created?.persona;
      setName('');
      setSystemPrompt('');
      setTone('');
      setLanguage('id');
      setModel('');
      setMakeDefault(false);
      setNotice(
        saved
          ? `Persona "${String(saved.name)}" sudah tersimpan${Number(saved.isDefault) === 1 ? ' dan sekarang jadi default' : ''}.`
          : 'Persona baru sudah tersimpan.',
      );
      await loadPersonas();
    } catch (error) {
      const message = personaErrorMessage(error, 'Persona gagal disimpan. Periksa isian, lalu coba lagi.');
      setFormError(message);
      fail(message);
    } finally {
      setCreating(false);
    }
  }

  /** Simpan perubahan dari panel edit. */
  async function saveEdit(personaId: string): Promise<void> {
    setEditError('');
    setNotice('');
    const cleanName = editName.trim();
    const cleanPrompt = editSystemPrompt.trim();
    if (!cleanName) {
      setEditError('Nama persona wajib diisi.');
      return;
    }
    if (!cleanPrompt) {
      setEditError('System prompt wajib diisi.');
      return;
    }
    setSavingId(personaId);
    try {
      const updated = await api.updatePersona(personaId, {
        name: cleanName.slice(0, NAME_MAX),
        systemPrompt: cleanPrompt.slice(0, SYSTEM_MAX),
        tone: editTone.slice(0, TONE_MAX),
        language: editLanguage,
        model: editModel.trim(),
        ...(editThinkingLevel ? { thinkingLevel: editThinkingLevel as ThinkingLevel } : {}),
      });
      const savedName = String(updated?.persona?.name ?? cleanName);
      closeEdit();
      setNotice(
        editThinkingLevel
          ? `Perubahan persona "${savedName}" sudah tersimpan.`
          : `Perubahan persona "${savedName}" sudah tersimpan; tingkat penalaran dibiarkan seperti semula.`,
      );
      await loadPersonas();
    } catch (error) {
      const message = personaErrorMessage(error, 'Perubahan persona gagal disimpan. Coba lagi.');
      setEditError(message);
      fail(message);
    } finally {
      setSavingId('');
    }
  }

  /** Tandai satu persona sebagai persona default akun. */
  async function makePersonaDefault(persona: Persona): Promise<void> {
    setNotice('');
    setBusyId(`default-${persona.id}`);
    try {
      const result = await api.setDefaultPersona(persona.id);
      if (result?.isDefault) {
        setNotice(`Persona "${persona.name}" sekarang jadi persona default akun Anda.`);
      } else {
        setNotice(`Server tidak melaporkan perubahan persona default untuk "${persona.name}". Muat ulang daftar.`);
      }
      await loadPersonas();
    } catch (error) {
      const message = personaErrorMessage(error, 'Persona default gagal diubah. Coba lagi.');
      setListError(message);
      fail(message);
    } finally {
      setBusyId('');
    }
  }

  /** Hapus satu persona setelah pengguna menekan tombol konfirmasi. */
  async function removePersona(persona: Persona): Promise<void> {
    setNotice('');
    setBusyId(`hapus-${persona.id}`);
    try {
      const result = await api.deletePersona(persona.id);
      if (result?.deleted) {
        setPersonas((current) => current.filter((row) => row.id !== persona.id));
        setNotice(
          isDefault(persona)
            ? `Persona "${persona.name}" sudah dihapus. Akun Anda sekarang tanpa persona default.`
            : `Persona "${persona.name}" sudah dihapus dari server.`,
        );
      } else {
        setNotice(`Server tidak melaporkan penghapusan persona "${persona.name}". Muat ulang daftar.`);
      }
      setConfirmId(null);
      if (editId === persona.id) closeEdit();
      await loadPersonas();
    } catch (error) {
      const message = personaErrorMessage(error, 'Persona gagal dihapus. Coba lagi.');
      setListError(message);
      fail(message);
    } finally {
      setBusyId('');
    }
  }

  // Ringkasan di atas daftar.
  const defaultPersona = personas.find(isDefault) ?? null;
  const useModelSelect = models.length > 0;
  const groupedProviders = Array.from(new Set(models.map((row) => String(row.provider ?? ''))));

  /** Pilihan tingkat penalaran untuk form buat dan edit. */
  function thinkingOptions(current: string): string[] {
    const list = thinkingLevels.map((level) => String(level));
    if (current && !list.includes(current)) list.push(current);
    return list;
  }

  return (
    <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">☰ Persona agen</h2>
        <p className="mt-1 text-slate-400">
          Persona menentukan kepribadian agen lewat system prompt, gaya bahasa, pilihan model, dan tingkat penalaran.
          Persona default dipakai untuk percakapan baru dan untuk pratinjau konteks agen.
        </p>
        <p className="mt-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">
          {defaultPersona
            ? `Persona default saat ini: ${String(defaultPersona.name)}.`
            : 'Belum ada persona default. Agen memakai pengaturan umum akun Anda.'}
        </p>
      </header>

      {notice ? (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">{notice}</p>
      ) : null}

      {/* Butir 64: ekspor dan impor persona lewat berkas JSON. */}
      <PersonaTransfer onError={onError} onDone={() => void loadPersonas()} />

      {/* 1. Form buat persona. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Buat persona</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-slate-300 sm:col-span-2">
            Nama
            <input
              className={FIELD}
              type="text"
              value={name}
              maxLength={NAME_MAX}
              placeholder="Contoh: Analis data ringkas"
              aria-label="Nama persona baru"
              onChange={(event) => {
                setName(event.target.value);
                setFormError('');
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-slate-300 sm:col-span-2">
            System prompt
            <textarea
              className={`${FIELD} min-h-32 w-full`}
              value={systemPrompt}
              maxLength={SYSTEM_MAX}
              placeholder="Contoh: Anda analis data. Selalu tunjukkan asumsi, hitungan, dan kesimpulan singkat."
              aria-label="System prompt persona baru"
              onChange={(event) => {
                setSystemPrompt(event.target.value);
                setFormError('');
              }}
            />
            <span className="text-xs text-slate-400">
              {systemPrompt.length}/{SYSTEM_MAX} karakter
            </span>
          </label>
          <label className="flex flex-col gap-1 text-slate-300">
            Gaya bahasa (tone)
            <input
              className={FIELD}
              type="text"
              value={tone}
              maxLength={TONE_MAX}
              placeholder="Contoh: ringkas, tegas, tanpa basa-basi"
              aria-label="Gaya bahasa persona baru"
              onChange={(event) => {
                setTone(event.target.value);
                setFormError('');
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-slate-300">
            Bahasa
            <select
              className={FIELD}
              value={language}
              aria-label="Bahasa persona baru"
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="id">Indonesia</option>
              <option value="en">Inggris</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-300">
            Model (opsional)
            {useModelSelect ? (
              <select
                className={FIELD}
                value={model}
                aria-label="Model persona baru"
                onChange={(event) => {
                  setModel(event.target.value);
                  setFormError('');
                }}
              >
                <option value="">Bawaan akun</option>
                {groupedProviders.map((provider) => (
                  <optgroup key={`pilih-${provider}`} label={provider || 'lain-lain'}>
                    {models
                      .filter((row) => String(row.provider ?? '') === provider)
                      .map((row) => (
                        <option key={`${provider}-${row.model}`} value={row.model}>
                          {row.model}
                          {row.thinking ? ' · penalaran' : ''}
                          {row.images ? ' · gambar' : ''}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <input
                className={FIELD}
                type="text"
                value={model}
                placeholder="Kosongkan untuk bawaan akun"
                aria-label="Model persona baru"
                onChange={(event) => {
                  setModel(event.target.value);
                  setFormError('');
                }}
              />
            )}
          </label>
          <label className="flex flex-col gap-1 text-slate-300">
            Tingkat penalaran
            <select
              className={FIELD}
              value={thinkingLevel}
              disabled={thinkingLevels.length === 0}
              aria-label="Tingkat penalaran persona baru"
              onChange={(event) => setThinkingLevel(event.target.value)}
            >
              <option value="">Bawaan server</option>
              {thinkingOptions(thinkingLevel).map((level) => (
                <option key={`tingkat-${level}`} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-slate-300 sm:col-span-2">
            <input
              type="checkbox"
              checked={makeDefault}
              aria-label="Jadikan persona baru sebagai default"
              onChange={(event) => setMakeDefault(event.target.checked)}
            />
            Jadikan persona ini persona default
          </label>
        </div>

        {modelsLoading ? <p className="mt-2 text-slate-400">Memuat katalog model…</p> : null}
        {modelsNote ? <p className="mt-2 text-slate-400">{modelsNote}</p> : null}
        {settingsNote ? <p className="mt-2 text-slate-400">{settingsNote}</p> : null}

        <button
          type="button"
          className={`${BTN} mt-2`}
          disabled={creating}
          onClick={() => {
            void createPersona();
          }}
        >
          {creating ? 'Menyimpan…' : 'Simpan persona'}
        </button>
        {formError ? <p className="mt-2 text-slate-100">{formError}</p> : null}
      </div>

      {/* 2. Daftar persona. */}
      <div className="space-y-2">
        <h3 className="font-semibold text-slate-100">Daftar persona</h3>
        <p className="text-slate-400">
          {loading ? 'Memuat persona…' : `${personas.length} persona tersimpan.`}
        </p>
        {listError ? <p className="text-slate-100">{listError}</p> : null}
        {!loading && !listError && personas.length === 0 ? (
          <p className="text-slate-400">Belum ada persona. Buat persona pertama Anda di form di atas.</p>
        ) : null}

        {personas.map((persona) => {
          const editing = editId === persona.id;
          const deleting = busyId === `hapus-${persona.id}`;
          const settingDefault = busyId === `default-${persona.id}`;
          const rowDefault = isDefault(persona);
          return (
            <article key={persona.id} className={CARD}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="font-semibold text-slate-100">{String(persona.name ?? '(tanpa nama)')}</h4>
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                    <span>Gaya: {String(persona.tone ?? '') || 'belum diatur'}</span>
                    <span>Bahasa: {languageLabel(persona.language)}</span>
                    <span>Model: {String(persona.model ?? '') || 'bawaan akun'}</span>
                    <span>Penalaran: {String(persona.thinkingLevel ?? '') || '-'}</span>
                    <span>Dipakai {Number(persona.useCount ?? 0).toLocaleString('id-ID')} kali</span>
                    <span>Diperbarui {formatDate(persona.updatedAt)}</span>
                  </p>
                </div>
                {rowDefault ? (
                  <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-2 py-1 text-xs text-emerald-200">
                    Persona default
                  </span>
                ) : null}
              </div>

              {editing ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-slate-300 sm:col-span-2">
                    Nama
                    <input
                      className={FIELD}
                      type="text"
                      value={editName}
                      maxLength={NAME_MAX}
                      aria-label={`Nama persona ${persona.name}`}
                      onChange={(event) => {
                        setEditName(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300 sm:col-span-2">
                    System prompt
                    <textarea
                      className={`${FIELD} min-h-32 w-full`}
                      value={editSystemPrompt}
                      maxLength={SYSTEM_MAX}
                      aria-label={`System prompt persona ${persona.name}`}
                      onChange={(event) => {
                        setEditSystemPrompt(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Gaya bahasa (tone)
                    <input
                      className={FIELD}
                      type="text"
                      value={editTone}
                      maxLength={TONE_MAX}
                      aria-label={`Gaya bahasa persona ${persona.name}`}
                      onChange={(event) => {
                        setEditTone(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Bahasa
                    <select
                      className={FIELD}
                      value={editLanguage}
                      aria-label={`Bahasa persona ${persona.name}`}
                      onChange={(event) => setEditLanguage(event.target.value)}
                    >
                      <option value="id">Indonesia</option>
                      <option value="en">Inggris</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Model (opsional)
                    {useModelSelect ? (
                      <select
                        className={FIELD}
                        value={editModel}
                        aria-label={`Model persona ${persona.name}`}
                        onChange={(event) => {
                          setEditModel(event.target.value);
                          setEditError('');
                        }}
                      >
                        <option value="">Bawaan akun</option>
                        {editModel && !models.some((row) => row.model === editModel) ? (
                          <option value={editModel}>{editModel} (di luar katalog)</option>
                        ) : null}
                        {groupedProviders.map((provider) => (
                          <optgroup key={`edit-${provider}`} label={provider || 'lain-lain'}>
                            {models
                              .filter((row) => String(row.provider ?? '') === provider)
                              .map((row) => (
                                <option key={`edit-${provider}-${row.model}`} value={row.model}>
                                  {row.model}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={FIELD}
                        type="text"
                        value={editModel}
                        placeholder="Kosongkan untuk bawaan akun"
                        aria-label={`Model persona ${persona.name}`}
                        onChange={(event) => {
                          setEditModel(event.target.value);
                          setEditError('');
                        }}
                      />
                    )}
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Tingkat penalaran
                    <select
                      className={FIELD}
                      value={editThinkingLevel}
                      disabled={thinkingLevels.length === 0}
                      aria-label={`Tingkat penalaran persona ${persona.name}`}
                      onChange={(event) => setEditThinkingLevel(event.target.value)}
                    >
                      <option value="">Biarkan seperti semula</option>
                      {thinkingOptions(editThinkingLevel).map((level) => (
                        <option key={`edit-tingkat-${level}`} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap gap-2 sm:col-span-2">
                    <button
                      type="button"
                      className={BTN}
                      disabled={savingId === persona.id}
                      onClick={() => {
                        void saveEdit(persona.id);
                      }}
                    >
                      {savingId === persona.id ? 'Menyimpan…' : 'Simpan perubahan'}
                    </button>
                    <button type="button" className={BTN} disabled={savingId === persona.id} onClick={closeEdit}>
                      Batal
                    </button>
                  </div>
                  {editError ? <p className="text-slate-100 sm:col-span-2">{editError}</p> : null}
                </div>
              ) : (
                <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-slate-300">
                  {String(persona.systemPrompt ?? '')}
                </p>
              )}

              {!editing ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className={BTN} disabled={Boolean(busyId)} onClick={() => openEdit(persona)}>
                    Sunting
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    disabled={Boolean(busyId) || rowDefault}
                    onClick={() => {
                      void makePersonaDefault(persona);
                    }}
                  >
                    {settingDefault ? 'Menyimpan…' : rowDefault ? 'Sudah jadi default' : 'Jadikan default'}
                  </button>
                  {confirmId === persona.id ? (
                    <>
                      <span className="text-slate-100">Hapus persona ini?</span>
                      <button
                        type="button"
                        className={BTN}
                        disabled={deleting}
                        onClick={() => {
                          void removePersona(persona);
                        }}
                      >
                        {deleting ? 'Menghapus…' : 'Ya, hapus'}
                      </button>
                      <button type="button" className={BTN} disabled={deleting} onClick={() => setConfirmId(null)}>
                        Batal
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={BTN}
                      disabled={Boolean(busyId)}
                      onClick={() => {
                        setConfirmId(persona.id);
                        setNotice('');
                      }}
                    >
                      Hapus
                    </button>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {/* 3. Keterangan singkat soal model dan bawaan server. */}
      <div className={CARD}>
        <h3 className="font-semibold text-slate-100">Catatan model dan penalaran</h3>
        <p className="mt-1 text-slate-400">
          Daftar model di halaman ini dibaca langsung dari katalog mesin agen. Bila kolom model dikosongkan, persona
          memakai model bawaan akun Anda. Tingkat penalaran diambil dari pengaturan agen, jadi hanya nilai pada daftar
          itu yang diterima server.
        </p>
      </div>
    </section>
  );
}

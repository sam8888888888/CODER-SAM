import { useEffect, useState } from 'react';
import { api } from './api';
import type { PromptTemplate } from './api';

/** Properti halaman "Template & slash": pelapor galat dari induk halaman. */
type Props = {
  onError?: (message: string) => void;
};

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input, textarea, dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas pembungkus kartu template dan panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';

/** Batas isian yang dipakai server; disalin di UI supaya pengguna tahu batasnya. */
const NAME_MAX = 120;
const BODY_MAX = 10000;
const DESCRIPTION_MAX = 400;
const SLASH_MAX = 40;
const TAGS_MAX = 200;

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Terjemahkan kode galat template menjadi kalimat Indonesia yang jelas. */
function templateErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('TEMPLATE_NOT_FOUND')) {
    return 'Template itu tidak ditemukan di server. Muat ulang daftar template.';
  }
  if (code.includes('INVALID_TEMPLATE')) {
    return 'Nama dan isi prompt wajib diisi. Nama maksimal 120 karakter.';
  }
  if (code.includes('SLASH_TAKEN')) {
    return 'Perintah garis miring itu sudah dipakai template lain. Pilih nama lain.';
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

/** Ambil nama variabel {{seperti_ini}} dari isi template, tanpa duplikat. */
function variablesIn(body: string): string[] {
  const found: string[] = [];
  const pattern = /\{\{([A-Za-z0-9_]+)\}\}/g;
  let match = pattern.exec(body);
  while (match) {
    if (!found.includes(match[1])) found.push(match[1]);
    match = pattern.exec(body);
  }
  return found;
}

/** Rapikan tulisan slash pengguna agar sama dengan aturan server (huruf kecil, tanda hubung). */
function cleanSlash(value: string): string {
  return value.trim().replace(/^\/+/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, SLASH_MAX);
}

/**
 * Halaman "Template & slash".
 *
 * Menampilkan daftar template prompt milik pengguna, form buat, edit, dan hapus.
 * Tombol "Pakai" memanggil api.useTemplate(id, variables): teks hasil muncul di
 * area pratinjau, bisa disalin, dan variabel yang belum terisi dilaporkan apa adanya.
 * Daftar perintah garis miring aktif ditampilkan pada blok terpisah.
 */
export function Templates({ onError }: Props) {
  // Daftar template dari server.
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');

  // Form buat template.
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [description, setDescription] = useState('');
  const [slash, setSlash] = useState('');
  const [tags, setTags] = useState('');
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);

  // Panel edit (satu template terbuka sekaligus).
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSlash, setEditSlash] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editError, setEditError] = useState('');
  const [savingId, setSavingId] = useState('');

  // Aksi per baris dan konfirmasi hapus.
  const [busyId, setBusyId] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Panel "Pakai template" beserta hasil dari server.
  const [useId, setUseId] = useState<string | null>(null);
  const [useName, setUseName] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [useBusy, setUseBusy] = useState('');
  const [useError, setUseError] = useState('');
  const [resultText, setResultText] = useState('');
  const [resultName, setResultName] = useState('');
  const [remaining, setRemaining] = useState<string[]>([]);
  const [copyNote, setCopyNote] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk. */
  function fail(message: string): void {
    onError?.(message);
  }

  /** Muat ulang daftar template dari server. */
  async function loadTemplates(): Promise<void> {
    setLoading(true);
    setListError('');
    try {
      const data = await api.promptTemplates();
      setTemplates(Array.isArray(data?.templates) ? data.templates : []);
    } catch (error) {
      // Jangan tampilkan data lama seolah masih benar: kosongkan daftar.
      setTemplates([]);
      const message = templateErrorMessage(error, 'Gagal memuat daftar template. Coba lagi sebentar lagi.');
      setListError(message);
      fail(message);
    } finally {
      setLoading(false);
    }
  }

  // Muat daftar template sekali saat halaman dibuka.
  useEffect(() => {
    void loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tutup panel edit dan bersihkan isinya. */
  function closeEdit(): void {
    setEditId(null);
    setEditName('');
    setEditBody('');
    setEditDescription('');
    setEditSlash('');
    setEditTags('');
    setEditError('');
  }

  /** Buka panel edit untuk satu template. */
  function openEdit(template: PromptTemplate): void {
    setEditId(template.id);
    setEditName(String(template?.name ?? ''));
    setEditBody(String(template?.body ?? ''));
    setEditDescription(String(template?.description ?? ''));
    setEditSlash(String(template?.slash ?? ''));
    setEditTags(String(template?.tags ?? ''));
    setEditError('');
    setNotice('');
    setConfirmId(null);
  }

  /** Buat template baru, lalu muat ulang daftar. */
  async function createTemplate(): Promise<void> {
    setFormError('');
    setNotice('');
    const cleanName = name.trim();
    const cleanBody = body.trim();
    if (!cleanName) {
      setFormError('Nama template wajib diisi.');
      return;
    }
    if (cleanName.length > NAME_MAX) {
      setFormError(`Nama template maksimal ${NAME_MAX} karakter.`);
      return;
    }
    if (!cleanBody) {
      setFormError('Isi prompt wajib diisi.');
      return;
    }
    setCreating(true);
    try {
      const created = await api.createTemplate({
        name: cleanName,
        body: cleanBody.slice(0, BODY_MAX),
        description: description.trim().slice(0, DESCRIPTION_MAX) || undefined,
        slash: cleanSlash(slash) || undefined,
        tags: tags.trim().slice(0, TAGS_MAX) || undefined,
      });
      const saved = created?.template;
      setName('');
      setBody('');
      setDescription('');
      setSlash('');
      setTags('');
      setNotice(
        saved?.slash
          ? `Template "${String(saved.name)}" sudah tersimpan. Perintah aktif: /${String(saved.slash)}`
          : `Template "${String(saved?.name ?? cleanName)}" sudah tersimpan.`,
      );
      await loadTemplates();
    } catch (error) {
      const message = templateErrorMessage(error, 'Template gagal disimpan. Periksa isian, lalu coba lagi.');
      setFormError(message);
      fail(message);
    } finally {
      setCreating(false);
    }
  }

  /** Simpan perubahan dari panel edit. */
  async function saveEdit(templateId: string): Promise<void> {
    setEditError('');
    setNotice('');
    const cleanName = editName.trim();
    if (!cleanName) {
      setEditError('Nama template wajib diisi.');
      return;
    }
    if (!editBody.trim()) {
      setEditError('Isi prompt wajib diisi.');
      return;
    }
    setSavingId(templateId);
    try {
      const updated = await api.updateTemplate(templateId, {
        name: cleanName.slice(0, NAME_MAX),
        body: editBody.slice(0, BODY_MAX),
        description: editDescription.slice(0, DESCRIPTION_MAX),
        slash: cleanSlash(editSlash),
        tags: editTags.slice(0, TAGS_MAX),
      });
      const savedName = String(updated?.template?.name ?? cleanName);
      closeEdit();
      setNotice(`Perubahan template "${savedName}" sudah tersimpan.`);
      await loadTemplates();
    } catch (error) {
      const message = templateErrorMessage(error, 'Perubahan template gagal disimpan. Coba lagi.');
      setEditError(message);
      fail(message);
    } finally {
      setSavingId('');
    }
  }

  /** Hapus satu template setelah pengguna menekan tombol konfirmasi. */
  async function removeTemplate(template: PromptTemplate): Promise<void> {
    setNotice('');
    setBusyId(`hapus-${template.id}`);
    try {
      const result = await api.deleteTemplate(template.id);
      if (result?.deleted) {
        setTemplates((current) => current.filter((row) => row.id !== template.id));
        setNotice(`Template "${template.name}" sudah dihapus dari server.`);
      } else {
        setNotice(`Server tidak melaporkan penghapusan template "${template.name}". Muat ulang daftar.`);
      }
      setConfirmId(null);
      if (editId === template.id) closeEdit();
      if (useId === template.id) closeUse();
    } catch (error) {
      const message = templateErrorMessage(error, 'Template gagal dihapus. Coba lagi.');
      setListError(message);
      fail(message);
    } finally {
      setBusyId('');
    }
  }

  /** Buka panel "Pakai template" dan siapkan kolom variabel dari isi template. */
  function openUse(template: PromptTemplate): void {
    const keys = variablesIn(String(template.body ?? ''));
    setUseId(template.id);
    setUseName(String(template.name ?? ''));
    setVariables((current) => {
      const next: Record<string, string> = {};
      for (const key of keys) next[key] = current[key] ?? '';
      return next;
    });
    setUseError('');
    setUseBusy('');
    setResultText('');
    setResultName('');
    setRemaining([]);
    setCopyNote('');
    setNotice('');
    setConfirmId(null);
  }

  /** Tutup panel "Pakai template" dan bersihkan hasilnya. */
  function closeUse(): void {
    setUseId(null);
    setUseName('');
    setVariables({});
    setUseError('');
    setResultText('');
    setResultName('');
    setRemaining([]);
    setCopyNote('');
  }

  /** Jalankan template: server mengisi variabel dan menaikkan hitungan pemakaian. */
  async function runTemplate(templateId: string): Promise<void> {
    setUseError('');
    setCopyNote('');
    setUseBusy(templateId);
    try {
      const result = await api.useTemplate(templateId, variables);
      setResultText(String(result?.text ?? ''));
      setResultName(String(result?.name ?? useName));
      setRemaining(Array.isArray(result?.remainingVariables) ? result.remainingVariables : []);
      setNotice(`Template "${String(result?.name ?? useName)}" sudah dijalankan. Teks hasil ada di pratinjau.`);
      // Hitungan pemakaian berubah di server, jadi daftar dimuat ulang.
      await loadTemplates();
    } catch (error) {
      setResultText('');
      setRemaining([]);
      const message = templateErrorMessage(error, 'Template gagal dijalankan. Coba lagi.');
      setUseError(message);
      fail(message);
    } finally {
      setUseBusy('');
    }
  }

  /** Salin teks hasil ke papan klip; lapor apa adanya bila peramban menolak. */
  async function copyResult(): Promise<void> {
    setCopyNote('');
    try {
      await navigator.clipboard.writeText(resultText);
      setCopyNote('Teks hasil sudah disalin ke papan klip.');
    } catch {
      setCopyNote('Peramban menolak akses papan klip. Pilih teks di kotak pratinjau, lalu salin manual.');
    }
  }

  // Daftar perintah garis miring yang aktif, dan variabel panel "Pakai".
  const slashTemplates = templates.filter((template) => String(template?.slash ?? '').trim() !== '');
  const useKeys = Object.keys(variables);
  // Template yang sedang dibuka di panel "Pakai template".
  const activeTemplate = templates.find((template) => template.id === useId) ?? null;

  return (
    <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">⌗ Template &amp; slash</h2>
        <p className="mt-1 text-slate-400">
          Template prompt yang bisa dipakai ulang. Isi template boleh memuat variabel bertanda{' '}
          <code>{'{{nama_variabel}}'}</code>; nilainya Anda isi saat menekan tombol "Pakai".
        </p>
      </header>

      {notice ? (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">{notice}</p>
      ) : null}

      {/* 1. Form buat template. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Buat template</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-slate-300">
            Nama
            <input
              className={FIELD}
              type="text"
              value={name}
              maxLength={NAME_MAX}
              placeholder="Contoh: Ringkas laporan harian"
              aria-label="Nama template baru"
              onChange={(event) => {
                setName(event.target.value);
                setFormError('');
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-slate-300">
            Perintah garis miring
            <span className="flex items-center gap-1">
              <span className="text-slate-400">/</span>
              <input
                className={`${FIELD} w-full`}
                type="text"
                value={slash}
                maxLength={SLASH_MAX}
                placeholder="ringkas-laporan"
                aria-label="Perintah garis miring template baru"
                onChange={(event) => {
                  setSlash(event.target.value);
                  setFormError('');
                }}
              />
            </span>
            <span className="text-xs text-slate-400">
              Kosongkan bila tidak perlu. Huruf kecil, angka, dan tanda hubung.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-slate-300 sm:col-span-2">
            Isi prompt
            <textarea
              className={`${FIELD} min-h-32 w-full`}
              value={body}
              maxLength={BODY_MAX}
              placeholder={'Contoh: Ringkas laporan berikut menjadi 5 butir untuk {{pembaca}}:\n\n{{isi_laporan}}'}
              aria-label="Isi prompt template baru"
              onChange={(event) => {
                setBody(event.target.value);
                setFormError('');
              }}
            />
            <span className="text-xs text-slate-400">
              {body.length}/{BODY_MAX} karakter · variabel terdeteksi: {variablesIn(body).join(', ') || 'belum ada'}
            </span>
          </label>
          <label className="flex flex-col gap-1 text-slate-300 sm:col-span-2">
            Deskripsi
            <input
              className={FIELD}
              type="text"
              value={description}
              maxLength={DESCRIPTION_MAX}
              placeholder="Penjelasan singkat kapan template ini dipakai"
              aria-label="Deskripsi template baru"
              onChange={(event) => {
                setDescription(event.target.value);
                setFormError('');
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-slate-300 sm:col-span-2">
            Tag
            <input
              className={FIELD}
              type="text"
              value={tags}
              maxLength={TAGS_MAX}
              placeholder="Contoh: laporan, harian"
              aria-label="Tag template baru"
              onChange={(event) => {
                setTags(event.target.value);
                setFormError('');
              }}
            />
          </label>
        </div>
        <button
          type="button"
          className={`${BTN} mt-2`}
          disabled={creating}
          onClick={() => {
            void createTemplate();
          }}
        >
          {creating ? 'Menyimpan…' : 'Simpan template'}
        </button>
        {formError ? <p className="mt-2 text-slate-100">{formError}</p> : null}
      </div>

      {/* 2. Daftar template. */}
      <div className="space-y-2">
        <h3 className="font-semibold text-slate-100">Daftar template</h3>
        <p className="text-slate-400">
          {loading ? 'Memuat template…' : `${templates.length} template tersimpan.`}
        </p>
        {listError ? <p className="text-slate-100">{listError}</p> : null}
        {!loading && !listError && templates.length === 0 ? (
          <p className="text-slate-400">Belum ada template. Buat template pertama Anda di form di atas.</p>
        ) : null}

        {templates.map((template) => {
          const editing = editId === template.id;
          const deleting = busyId === `hapus-${template.id}`;
          const active = useId === template.id;
          const keys = variablesIn(String(template.body ?? ''));
          return (
            <article key={template.id} className={CARD}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="font-semibold text-slate-100">{String(template.name ?? '(tanpa nama)')}</h4>
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                    <span>Diperbarui {formatDate(template.updatedAt)}</span>
                    <span>Dipakai {Number(template.useCount ?? 0).toLocaleString('id-ID')} kali</span>
                    {keys.length > 0 ? <span>Variabel: {keys.map((key) => `{{${key}}}`).join(', ')}</span> : null}
                    {template.tags ? <span>Tag: {String(template.tags)}</span> : null}
                  </p>
                </div>
                {template.slash ? (
                  <span className="rounded-lg border border-cyan-500/30 bg-cyan-500/15 px-2 py-1 text-xs text-cyan-200">
                    /{String(template.slash)}
                  </span>
                ) : null}
              </div>

              {template.description ? (
                <p className="mt-2 text-slate-400">{String(template.description)}</p>
              ) : null}

              {editing ? (
                <div className="mt-2 grid gap-2">
                  <label className="flex flex-col gap-1 text-slate-300">
                    Nama
                    <input
                      className={FIELD}
                      type="text"
                      value={editName}
                      maxLength={NAME_MAX}
                      aria-label={`Nama template ${template.name}`}
                      onChange={(event) => {
                        setEditName(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Isi prompt
                    <textarea
                      className={`${FIELD} min-h-32 w-full`}
                      value={editBody}
                      maxLength={BODY_MAX}
                      aria-label={`Isi prompt template ${template.name}`}
                      onChange={(event) => {
                        setEditBody(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-slate-300">
                      Perintah garis miring
                      <input
                        className={FIELD}
                        type="text"
                        value={editSlash}
                        maxLength={SLASH_MAX}
                        placeholder="ringkas-laporan"
                        aria-label={`Perintah garis miring template ${template.name}`}
                        onChange={(event) => {
                          setEditSlash(event.target.value);
                          setEditError('');
                        }}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-slate-300">
                      Deskripsi
                      <input
                        className={FIELD}
                        type="text"
                        value={editDescription}
                        maxLength={DESCRIPTION_MAX}
                        aria-label={`Deskripsi template ${template.name}`}
                        onChange={(event) => {
                          setEditDescription(event.target.value);
                          setEditError('');
                        }}
                      />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Tag
                    <input
                      className={FIELD}
                      type="text"
                      value={editTags}
                      maxLength={TAGS_MAX}
                      aria-label={`Tag template ${template.name}`}
                      onChange={(event) => {
                        setEditTags(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={BTN}
                      disabled={savingId === template.id}
                      onClick={() => {
                        void saveEdit(template.id);
                      }}
                    >
                      {savingId === template.id ? 'Menyimpan…' : 'Simpan perubahan'}
                    </button>
                    <button type="button" className={BTN} disabled={savingId === template.id} onClick={closeEdit}>
                      Batal
                    </button>
                  </div>
                  {editError ? <p className="text-slate-100">{editError}</p> : null}
                </div>
              ) : (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-200">
                  {String(template.body ?? '')}
                </pre>
              )}

              {!editing ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className={BTN} disabled={Boolean(busyId)} onClick={() => openEdit(template)}>
                    Sunting
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    aria-pressed={active}
                    disabled={Boolean(busyId)}
                    onClick={() => openUse(template)}
                  >
                    Pakai
                  </button>
                  {confirmId === template.id ? (
                    <>
                      <span className="text-slate-100">Hapus template ini?</span>
                      <button
                        type="button"
                        className={BTN}
                        disabled={deleting}
                        onClick={() => {
                          void removeTemplate(template);
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
                        setConfirmId(template.id);
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

      {/* 3. Panel "Pakai template": variabel, hasil dari server, dan tombol salin. */}
      {activeTemplate ? (
        <div className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-100">Pakai template: {String(activeTemplate.name ?? '')}</h3>
            <button type="button" className={BTN} onClick={closeUse}>
              Tutup
            </button>
          </div>

          {useKeys.length === 0 ? (
            <p className="mt-2 text-slate-400">
              Template ini tidak memuat variabel. Tekan "Jalankan template" untuk mengambil teks hasilnya.
            </p>
          ) : (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {useKeys.map((key) => (
                <label key={key} className="flex flex-col gap-1 text-slate-300">
                  {`{{${key}}}`}
                  <input
                    className={FIELD}
                    type="text"
                    value={variables[key] ?? ''}
                    aria-label={`Nilai variabel ${key}`}
                    placeholder="Isi nilai variabel"
                    onChange={(event) => {
                      const value = event.target.value;
                      setVariables((current) => ({ ...current, [key]: value }));
                      setUseError('');
                    }}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              disabled={Boolean(useBusy)}
              onClick={() => {
                void runTemplate(activeTemplate.id);
              }}
            >
              {useBusy === activeTemplate.id ? 'Menjalankan…' : 'Jalankan template'}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={!resultText}
              onClick={() => {
                void copyResult();
              }}
            >
              Salin
            </button>
          </div>

          {useError ? <p className="mt-2 text-slate-100">{useError}</p> : null}
          {copyNote ? <p className="mt-2 text-slate-100">{copyNote}</p> : null}

          <div className="mt-2">
            <p className="text-slate-400">
              Pratinjau hasil{resultName ? ` · ${resultName}` : ''} · {resultText.length.toLocaleString('id-ID')} karakter
            </p>
            {resultText ? (
              <textarea
                className={`${FIELD} mt-1 min-h-40 w-full font-mono text-xs`}
                value={resultText}
                readOnly
                aria-label="Teks hasil template"
              />
            ) : (
              <p className="mt-1 text-slate-400">Belum ada teks hasil. Tekan "Jalankan template" untuk mengisinya.</p>
            )}
          </div>

          {remaining.length > 0 ? (
            <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-amber-100">
              Variabel yang belum terisi: {remaining.map((key) => `{{${key}}}`).join(', ')}. Isi nilainya di atas, lalu
              jalankan ulang template supaya teks hasilnya lengkap.
            </p>
          ) : resultText ? (
            <p className="mt-2 text-slate-400">Semua variabel sudah terisi.</p>
          ) : null}
        </div>
      ) : null}

      {/* 4. Daftar perintah garis miring aktif. */}
      <div className={CARD}>
        <h3 className="font-semibold text-slate-100">Perintah garis miring aktif</h3>
        <p className="mt-1 text-slate-400">
          Format perintah adalah <code>/namaprompt</code>, misalnya <code>/ringkas-laporan</code>. Tulis perintah itu di
          kotak pesan percakapan untuk memakai template terkait. Server menormalkan nama perintah menjadi huruf kecil
          dan tanda hubung, dan satu nama hanya boleh dipakai satu template.
        </p>
        {slashTemplates.length === 0 ? (
          <p className="mt-2 text-slate-400">
            Belum ada perintah garis miring. Isi kolom perintah pada template agar muncul di blok ini.
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {slashTemplates.map((template) => (
              <li key={`slash-${template.id}`} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <code className="text-slate-100">/{String(template.slash)}</code>
                <span className="text-slate-300"> · {String(template.name ?? '')}</span>
                {template.description ? <span className="text-slate-400"> · {String(template.description)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

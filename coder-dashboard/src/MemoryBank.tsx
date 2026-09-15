import { useEffect, useState } from 'react';
import { api } from './api';
import type { AgentPreview, MemoryNote } from './api';

/** Properti halaman "Bank memori": pelapor galat dari induk halaman. */
type Props = {
  onError?: (message: string) => void;
};

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input, textarea, dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas pembungkus kartu catatan dan panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';

/** Batas isian yang dipakai server; disalin di UI supaya pengguna tahu batasnya. */
const TITLE_MAX = 200;
const BODY_MAX = 8000;
const TAGS_MAX = 200;
/** Server hanya mengirim 12 catatan aktif teratas ke agen (disematkan lebih dulu). */
const SENT_LIMIT = 12;

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Terjemahkan kode galat bank memori menjadi kalimat Indonesia yang jelas. */
function memoryErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('MEMORY_NOT_FOUND')) {
    return 'Catatan itu tidak ditemukan di server. Muat ulang daftar catatan.';
  }
  if (code.includes('INVALID_MEMORY')) {
    return 'Judul dan isi catatan wajib diisi. Judul maksimal 200 karakter.';
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

/** Format ukuran byte sesingkat mungkin untuk panel sesi mesin. */
function byteText(value: unknown): string {
  const bytes = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 byte';
  if (bytes < 1024) return `${bytes} byte`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tanda catatan aktif pada daftar; server menyimpan 1 = aktif, 0 = nonaktif. */
function isEnabled(note: MemoryNote): boolean {
  return Number(note?.enabled) === 1;
}

/** Tanda catatan disematkan; server menyimpan 1 = disematkan. */
function isPinned(note: MemoryNote): boolean {
  return Number(note?.pinned) === 1;
}

/**
 * Halaman "Bank memori".
 *
 * Menampilkan daftar catatan milik pengguna, form tambah, edit cepat di dalam
 * kartu, tombol aktif/nonaktif, dan hapus dengan konfirmasi dua langkah.
 * Panel "Yang dikirim ke agen" memanggil api.agentPreview() supaya pengguna
 * melihat blok system yang benar-benar akan dikirim ke mesin agen.
 */
export function MemoryBank({ onError }: Props) {
  // Daftar catatan dari server.
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');

  // Form tambah catatan.
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [pinned, setPinned] = useState(false);
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);

  // Panel edit cepat (satu kartu terbuka sekaligus).
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editPinned, setEditPinned] = useState(false);
  const [editError, setEditError] = useState('');
  const [savingId, setSavingId] = useState('');

  // Keadaan sibuk per baris dan konfirmasi hapus.
  const [busyId, setBusyId] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Pratinjau blok system yang dikirim ke agen.
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk. */
  function fail(message: string): void {
    onError?.(message);
  }

  /** Muat ulang daftar catatan dari server. */
  async function loadNotes(): Promise<void> {
    setLoading(true);
    setListError('');
    try {
      const data = await api.memories();
      setNotes(Array.isArray(data?.memories) ? data.memories : []);
    } catch (error) {
      // Jangan tampilkan data lama seolah masih benar: kosongkan daftar.
      setNotes([]);
      const message = memoryErrorMessage(error, 'Gagal memuat daftar catatan. Coba lagi sebentar lagi.');
      setListError(message);
      fail(message);
    } finally {
      setLoading(false);
    }
  }

  /** Muat pratinjau blok system yang akan dipakai agen. */
  async function loadPreview(): Promise<void> {
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const data = await api.agentPreview();
      setPreview(data);
    } catch (error) {
      setPreview(null);
      const message = memoryErrorMessage(error, 'Gagal memuat pratinjau konteks agen.');
      setPreviewError(message);
      fail(message);
    } finally {
      setPreviewLoading(false);
    }
  }

  // Muat daftar catatan dan pratinjau sekali saat halaman dibuka.
  useEffect(() => {
    void loadNotes();
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Tutup panel edit dan bersihkan isinya. */
  function closeEdit(): void {
    setEditId(null);
    setEditTitle('');
    setEditBody('');
    setEditTags('');
    setEditPinned(false);
    setEditError('');
  }

  /** Buka panel edit cepat untuk satu catatan. */
  function openEdit(note: MemoryNote): void {
    setEditId(note.id);
    setEditTitle(String(note?.title ?? ''));
    setEditBody(String(note?.body ?? ''));
    setEditTags(String(note?.tags ?? ''));
    setEditPinned(isPinned(note));
    setEditError('');
    setNotice('');
    setConfirmId(null);
  }

  /** Tambah catatan baru, lalu muat ulang daftar dan pratinjau. */
  async function createNote(): Promise<void> {
    setFormError('');
    setNotice('');
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    if (!cleanTitle) {
      setFormError('Judul catatan wajib diisi.');
      return;
    }
    if (cleanTitle.length > TITLE_MAX) {
      setFormError(`Judul maksimal ${TITLE_MAX} karakter.`);
      return;
    }
    if (!cleanBody) {
      setFormError('Isi catatan wajib diisi.');
      return;
    }
    setCreating(true);
    try {
      const created = await api.createMemory({
        title: cleanTitle,
        body: cleanBody.slice(0, BODY_MAX),
        tags: tags.trim().slice(0, TAGS_MAX) || undefined,
        pinned,
      });
      const savedTitle = String(created?.memory?.title ?? cleanTitle);
      setTitle('');
      setBody('');
      setTags('');
      setPinned(false);
      setNotice(`Catatan "${savedTitle}" sudah tersimpan di server.`);
      await loadNotes();
      await loadPreview();
    } catch (error) {
      const message = memoryErrorMessage(error, 'Catatan gagal disimpan. Periksa isian, lalu coba lagi.');
      setFormError(message);
      fail(message);
    } finally {
      setCreating(false);
    }
  }

  /** Simpan perubahan dari panel edit cepat. */
  async function saveEdit(noteId: string): Promise<void> {
    setEditError('');
    setNotice('');
    const cleanTitle = editTitle.trim();
    if (!cleanTitle) {
      setEditError('Judul catatan wajib diisi.');
      return;
    }
    if (!editBody.trim()) {
      setEditError('Isi catatan wajib diisi.');
      return;
    }
    setSavingId(noteId);
    try {
      const updated = await api.updateMemory(noteId, {
        title: cleanTitle.slice(0, TITLE_MAX),
        body: editBody.trim().slice(0, BODY_MAX),
        tags: editTags.trim().slice(0, TAGS_MAX),
        pinned: editPinned,
      });
      const savedTitle = String(updated?.memory?.title ?? cleanTitle);
      closeEdit();
      setNotice(`Perubahan catatan "${savedTitle}" sudah tersimpan.`);
      await loadNotes();
      await loadPreview();
    } catch (error) {
      const message = memoryErrorMessage(error, 'Perubahan catatan gagal disimpan. Coba lagi.');
      setEditError(message);
      fail(message);
    } finally {
      setSavingId('');
    }
  }

  /** Aktifkan atau nonaktifkan satu catatan; hanya catatan aktif yang dikirim ke agen. */
  async function toggleEnabled(note: MemoryNote): Promise<void> {
    setNotice('');
    setBusyId(`aktif-${note.id}`);
    try {
      const next = !isEnabled(note);
      const updated = await api.updateMemory(note.id, { enabled: next });
      const enabled = Number(updated?.memory?.enabled) === 1;
      setNotes((current) =>
        current.map((row) => (row.id === note.id ? { ...row, enabled: enabled ? 1 : 0 } : row)),
      );
      setNotice(
        enabled
          ? `Catatan "${note.title}" sekarang aktif dan ikut dikirim ke agen.`
          : `Catatan "${note.title}" sekarang nonaktif dan tidak dikirim ke agen.`,
      );
      await loadPreview();
    } catch (error) {
      const message = memoryErrorMessage(error, 'Status catatan gagal diubah. Coba lagi.');
      setListError(message);
      fail(message);
    } finally {
      setBusyId('');
    }
  }

  /** Hapus satu catatan setelah pengguna menekan tombol konfirmasi. */
  async function removeNote(note: MemoryNote): Promise<void> {
    setNotice('');
    setBusyId(`hapus-${note.id}`);
    try {
      const result = await api.deleteMemory(note.id);
      if (result?.deleted) {
        setNotes((current) => current.filter((row) => row.id !== note.id));
        setNotice(`Catatan "${note.title}" sudah dihapus dari server.`);
      } else {
        setNotice(`Server tidak melaporkan penghapusan catatan "${note.title}". Muat ulang daftar.`);
      }
      setConfirmId(null);
      if (editId === note.id) closeEdit();
      await loadPreview();
    } catch (error) {
      const message = memoryErrorMessage(error, 'Catatan gagal dihapus. Coba lagi.');
      setListError(message);
      fail(message);
    } finally {
      setBusyId('');
    }
  }

  // Ringkasan kecil di atas daftar.
  const activeCount = notes.filter(isEnabled).length;

  return (
    <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">❖ Bank memori</h2>
        <p className="mt-1 text-slate-400">
          Catatan di bawah ini dikirim ke agen sebagai blok <code>--append-system-prompt</code>, bukan sebagai pesan
          Anda. Hanya catatan <strong className="text-slate-100">aktif</strong> yang ikut dikirim, dan server mengambil
          maksimal {SENT_LIMIT} catatan (yang disematkan lebih dulu, lalu yang terbaru).
        </p>
      </header>

      {notice ? (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">{notice}</p>
      ) : null}

      {/* 1. Form tambah catatan. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Tambah catatan</h3>
        <div className="grid gap-2">
          <label className="flex flex-col gap-1 text-slate-300">
            Judul
            <input
              className={FIELD}
              type="text"
              value={title}
              maxLength={TITLE_MAX}
              placeholder="Contoh: Gaya penulisan laporan"
              aria-label="Judul catatan baru"
              onChange={(event) => {
                setTitle(event.target.value);
                setFormError('');
              }}
            />
            <span className="text-xs text-slate-400">
              {title.length}/{TITLE_MAX} karakter
            </span>
          </label>
          <label className="flex flex-col gap-1 text-slate-300">
            Isi catatan
            <textarea
              className={`${FIELD} min-h-24 w-full`}
              value={body}
              maxLength={BODY_MAX}
              placeholder="Tulis fakta atau aturan yang harus selalu diingat agen."
              aria-label="Isi catatan baru"
              onChange={(event) => {
                setBody(event.target.value);
                setFormError('');
              }}
            />
            <span className="text-xs text-slate-400">
              {body.length}/{BODY_MAX} karakter
            </span>
          </label>
          <label className="flex flex-col gap-1 text-slate-300">
            Tag
            <input
              className={FIELD}
              type="text"
              value={tags}
              maxLength={TAGS_MAX}
              placeholder="Contoh: laporan, gaya"
              aria-label="Tag catatan baru"
              onChange={(event) => {
                setTags(event.target.value);
                setFormError('');
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={pinned}
              aria-label="Sematkan catatan baru"
              onChange={(event) => setPinned(event.target.checked)}
            />
            Sematkan catatan ini (dikirim lebih dulu)
          </label>
        </div>
        <button
          type="button"
          className={`${BTN} mt-2`}
          disabled={creating}
          onClick={() => {
            void createNote();
          }}
        >
          {creating ? 'Menyimpan…' : 'Simpan catatan'}
        </button>
        {formError ? <p className="mt-2 text-slate-100">{formError}</p> : null}
      </div>

      {/* 2. Daftar catatan. */}
      <div className="space-y-2">
        <h3 className="font-semibold text-slate-100">Daftar catatan</h3>
        <p className="text-slate-400">
          {loading
            ? 'Memuat catatan…'
            : `${notes.length} catatan tersimpan, ${activeCount} di antaranya aktif.`}
        </p>
        {listError ? <p className="text-slate-100">{listError}</p> : null}
        {!loading && !listError && notes.length === 0 ? (
          <p className="text-slate-400">Belum ada catatan. Tambahkan catatan pertama Anda di form di atas.</p>
        ) : null}

        {notes.map((note) => {
          const enabled = isEnabled(note);
          const rowPinned = isPinned(note);
          const editing = editId === note.id;
          const toggling = busyId === `aktif-${note.id}`;
          const deleting = busyId === `hapus-${note.id}`;
          return (
            <article key={note.id} className={CARD}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h4 className="font-semibold text-slate-100">{String(note.title ?? '(tanpa judul)')}</h4>
                  <p className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                    <span>Diperbarui {formatDate(note.updatedAt)}</span>
                    <span>Dipakai {Number(note.useCount ?? 0).toLocaleString('id-ID')} kali</span>
                    {note.tags ? <span>Tag: {String(note.tags)}</span> : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1 text-xs">
                  {rowPinned ? (
                    <span className="rounded-lg border border-violet-500/40 bg-violet-500/15 px-2 py-1 text-violet-200">
                      Disematkan
                    </span>
                  ) : null}
                  <span
                    className={`rounded-lg border px-2 py-1 ${
                      enabled
                        ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200'
                        : 'border-slate-500/30 bg-slate-500/15 text-slate-300'
                    }`}
                  >
                    {enabled ? 'Aktif, dikirim ke agen' : 'Nonaktif'}
                  </span>
                </div>
              </div>

              {editing ? (
                <div className="mt-2 grid gap-2">
                  <label className="flex flex-col gap-1 text-slate-300">
                    Judul
                    <input
                      className={FIELD}
                      type="text"
                      value={editTitle}
                      maxLength={TITLE_MAX}
                      aria-label={`Judul catatan ${note.title}`}
                      onChange={(event) => {
                        setEditTitle(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Isi catatan
                    <textarea
                      className={`${FIELD} min-h-24 w-full`}
                      value={editBody}
                      maxLength={BODY_MAX}
                      aria-label={`Isi catatan ${note.title}`}
                      onChange={(event) => {
                        setEditBody(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-slate-300">
                    Tag
                    <input
                      className={FIELD}
                      type="text"
                      value={editTags}
                      maxLength={TAGS_MAX}
                      aria-label={`Tag catatan ${note.title}`}
                      onChange={(event) => {
                        setEditTags(event.target.value);
                        setEditError('');
                      }}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-slate-300">
                    <input
                      type="checkbox"
                      checked={editPinned}
                      aria-label={`Sematkan catatan ${note.title}`}
                      onChange={(event) => setEditPinned(event.target.checked)}
                    />
                    Sematkan catatan ini
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={BTN}
                      disabled={savingId === note.id}
                      onClick={() => {
                        void saveEdit(note.id);
                      }}
                    >
                      {savingId === note.id ? 'Menyimpan…' : 'Simpan perubahan'}
                    </button>
                    <button type="button" className={BTN} disabled={savingId === note.id} onClick={closeEdit}>
                      Batal
                    </button>
                  </div>
                  {editError ? <p className="text-slate-100">{editError}</p> : null}
                </div>
              ) : (
                <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-slate-300">{String(note.body ?? '')}</p>
              )}

              {!editing ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className={BTN} disabled={Boolean(busyId)} onClick={() => openEdit(note)}>
                    Sunting
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    disabled={Boolean(busyId)}
                    onClick={() => {
                      void toggleEnabled(note);
                    }}
                  >
                    {toggling ? 'Mengubah…' : enabled ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                  {confirmId === note.id ? (
                    <>
                      <span className="text-slate-100">Hapus catatan ini?</span>
                      <button
                        type="button"
                        className={BTN}
                        disabled={deleting}
                        onClick={() => {
                          void removeNote(note);
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
                        setConfirmId(note.id);
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

      {/* 3. Panel "Yang dikirim ke agen" dari api.agentPreview(). */}
      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-slate-100">Yang dikirim ke agen</h3>
          <button
            type="button"
            className={BTN}
            disabled={previewLoading}
            onClick={() => {
              void loadPreview();
            }}
          >
            {previewLoading ? 'Memuat…' : 'Muat ulang pratinjau'}
          </button>
        </div>
        <p className="mt-1 text-slate-400">
          Pratinjau ini dihitung tanpa percakapan tertentu, jadi memakai persona bawaan akun Anda. Blok di bawah dikirim
          ke mesin agen sebagai <code>--append-system-prompt</code>.
        </p>
        {previewError ? <p className="mt-2 text-slate-100">{previewError}</p> : null}
        {!preview && !previewLoading && !previewError ? (
          <p className="mt-2 text-slate-400">Belum ada pratinjau.</p>
        ) : null}

        {preview ? (
          <div className="mt-2 space-y-2">
            <p className="text-slate-300">
              Jumlah blok: <strong className="text-slate-100">{preview.blocks?.length ?? 0}</strong> · Pesan pada
              percakapan: {Number(preview.messages ?? 0).toLocaleString('id-ID')} · Ringkasan pemadatan:{' '}
              {Number(preview.summaryCount ?? 0).toLocaleString('id-ID')}
            </p>
            <p className="text-slate-300">
              Persona: {preview.persona ? String(preview.persona.name) : 'tidak ada persona khusus'} · Tingkat penalaran:{' '}
              {String(preview.settings?.thinking_level ?? '-')}
            </p>
            <p className="text-slate-300">
              Sesi mesin:{' '}
              {preview.session
                ? `${Number(preview.session.files ?? 0).toLocaleString('id-ID')} berkas, ${byteText(
                    preview.session.bytes,
                  )}, terbaru ${formatDate(preview.session.newest)}`
                : 'belum ada sesi mesin untuk konteks ini'}
            </p>

            {(preview.blocks?.length ?? 0) === 0 ? (
              <p className="text-slate-400">
                Belum ada blok system. Tambahkan catatan aktif, atau atur persona agar agen menerima konteks tambahan.
              </p>
            ) : (
              <ol className="space-y-2">
                {(preview.blocks ?? []).map((block, index) => (
                  <li key={`blok-${index}`} className="rounded-lg border border-slate-700 bg-slate-900 p-2">
                    <p className="text-xs text-slate-400">
                      Blok {index + 1} · {block.length.toLocaleString('id-ID')} karakter
                    </p>
                    <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-200">
                      {block}
                    </pre>
                  </li>
                ))}
              </ol>
            )}

            {(preview.flags?.length ?? 0) > 0 ? (
              <div>
                <p className="text-slate-400">Bendera yang dipakai mesin agen</p>
                <ul className="mt-1 flex flex-wrap gap-1 text-xs">
                  {preview.flags.map((flag, index) => (
                    <li key={`bendera-${index}`} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1">
                      {flag}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {(preview.notes?.length ?? 0) > 0 ? (
              <div>
                <p className="text-slate-400">Catatan dari server</p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-slate-300">
                  {preview.notes.map((note, index) => (
                    <li key={`catatan-server-${index}`}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-slate-400">Belum ada catatan tambahan dari server.</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

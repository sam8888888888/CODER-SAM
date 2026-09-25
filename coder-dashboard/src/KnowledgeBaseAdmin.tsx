/**
 * Halaman "Knowledge Base" (Wave 11A, butir 52).
 *
 * Basis pengetahuan platform ditanam admin dan dikirim ke SETIAP run agen paling awal, sebelum
 * persona dan memori. Ada dua bagian: "umum" dan "whitelabel". Batas total entri aktif 8.000
 * karakter; angka batas itu datang dari jawaban server (limitChars) dan ditampilkan di indikator.
 *
 * Aturan akses:
 * - Semua pengguna boleh MEMBACA (GET /v1/knowledge-base).
 * - Hanya admin platform yang boleh menulis. Bila prop `isAdmin` false, halaman ini hanya menampilkan
 *   kalimat ramah dan tidak pernah mengirim permintaan tulis sama sekali.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, failureOf } from './api';
import type { KnowledgeBaseEntry } from './api';

/** Properti halaman: pelapor galat dari induk dan status admin platform. */
type Props = {
  onError?: (message: string) => void;
  isAdmin?: boolean;
};

/** Kelas Tailwind tombol sekunder, sama seperti halaman Wave 10. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi menonjol. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas tombol kecil di dalam satu baris entri. */
const BTN_SMALL = 'rounded-md border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas pembungkus kartu. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan informasi. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas kotak pesan sukses. */
const OK_BOX = 'rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas kotak teks isi entri. */
const TEXTAREA = FIELD + ' min-h-24 w-full font-mono text-xs';
/** Kelas batang indikator pemakaian kuota karakter. */
const BAR = 'h-1.5 w-full overflow-hidden rounded-full bg-slate-700';

/** Kalimat yang ditampilkan bila pengguna bukan admin platform. */
const NO_ACCESS_MESSAGE =
  'Anda bukan admin platform, jadi bagian ini hanya bisa dibaca. Penanaman aturan platform hanya dapat dilakukan admin platform. Bila Anda perlu perubahan, hubungi admin platform.';

/** Label bagian Knowledge Base dalam Bahasa Indonesia. */
const SECTION_LABELS: Record<string, string> = {
  umum: 'Umum (semua agen)',
  whitelabel: 'Whitelabel (identitas & aturan merek)',
};

/** Nilai bawaan form entri baru. */
const FORM_KOSONG = { section: 'umum', title: '', content: '', enabled: true };

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Bidang `enabled` dikirim server sebagai 0/1 atau boolean; keduanya dibaca sebagai aktif/mati. */
function aktif(enabled: unknown): boolean {
  return enabled === true || num(enabled) === 1;
}

/** Format tanggal dan jam ke waktu Indonesia; nilai kosong ditulis tanda hubung. */
function dateTimeText(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Label bagian; nilai tak dikenal tetap ditampilkan apa adanya. */
function sectionLabel(section: unknown): string {
  const value = String(section ?? '').trim();
  return SECTION_LABELS[value] ?? (value || 'tanpa bagian');
}

/**
 * Ubah galat menjadi kalimat Indonesia.
 * Pesan dari server dipakai apa adanya; bila server hanya mengirim kode mesin, halaman ini
 * menambahkan kalimat sendiri yang jujur.
 */
function pesanGalat(error: unknown, apa: string): string {
  const gagal = failureOf(error);
  const kode = (gagal.code + ' ' + gagal.message).toUpperCase();
  if (gagal.status === 403 || kode.includes('ADMIN_REQUIRED')) return NO_ACCESS_MESSAGE;
  if (gagal.status === 404 || gagal.status === 501 || kode.includes('NOT_IMPLEMENTED')) {
    return 'Rute API ' + apa + ' belum tersedia di server ini (menunggu API Wave 11A).';
  }
  if (gagal.status === 401 || kode.includes('UNAUTHORIZED') || kode.includes('UNAUTHENTICATED')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk lagi, lalu buka halaman ini kembali.';
  }
  if (gagal.status === 429 || kode.includes('RATE_LIMIT')) {
    return 'Terlalu banyak permintaan. Coba lagi sebentar.';
  }
  if (kode.includes('FAILED TO FETCH') || kode.includes('NETWORKERROR')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu tekan Segarkan.';
  }
  // Pesan Indonesia dari server ditampilkan apa adanya bila ada (bukan sekadar KODE_MESIN).
  const pesanServer = String(gagal.message ?? '').trim();
  if (pesanServer && pesanServer !== gagal.code) return pesanServer;
  return 'Permintaan ' + apa + ' gagal diproses. Coba lagi sebentar.';
}

/**
 * Halaman Knowledge Base platform: daftar entri per bagian, form tulis untuk admin, dan indikator
 * pemakaian kuota karakter.
 */
export function KnowledgeBaseAdmin({ onError, isAdmin }: Props) {
  // Daftar entri dan angka kuota dari server.
  const [entries, setEntries] = useState<KnowledgeBaseEntry[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [limitChars, setLimitChars] = useState(0);
  const [activeChars, setActiveChars] = useState(0);
  const [activeEntries, setActiveEntries] = useState(0);
  const [catatan, setCatatan] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Form tulis (hanya untuk admin).
  const [form, setForm] = useState(FORM_KOSONG);
  const [writeError, setWriteError] = useState('');
  const [writeBusy, setWriteBusy] = useState(false);
  const [tulisTerbuka, setTulisTerbuka] = useState(false);

  // Ubah satu entri di tempat.
  const [editId, setEditId] = useState('');
  const [edit, setEdit] = useState(FORM_KOSONG);
  const [rowError, setRowError] = useState('');
  const [rowBusy, setRowBusy] = useState('');
  const [notice, setNotice] = useState('');

  /** Catat galat ke halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function gagal(message: string): void {
    onError?.(message);
  }

  /** Muat daftar entri Knowledge Base; membaca boleh untuk semua pengguna yang sudah masuk. */
  const muat = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.knowledgeBase();
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
      setSections(Array.isArray(data?.sections) ? data.sections : []);
      setLimitChars(num(data?.limitChars));
      setActiveChars(num(data?.activeChars));
      setActiveEntries(num(data?.activeEntries));
      setCatatan(String(data?.catatan ?? ''));
    } catch (error) {
      // Jangan tampilkan daftar lama seolah masih baru: kosongkan, lalu beri pesan galat.
      setEntries([]);
      setSections([]);
      setLimitChars(0);
      setActiveChars(0);
      setActiveEntries(0);
      setCatatan('');
      const message = pesanGalat(error, 'knowledge base (/v1/knowledge-base)');
      setLoadError(message);
      gagal(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Muat sekali saat halaman dibuka; tidak ada pemanggilan berulang dari useEffect.
  useEffect(() => {
    void muat();
  }, [muat]);

  /** Tambah satu entri Knowledge Base (admin saja). */
  async function tambah(): Promise<void> {
    if (!isAdmin) {
      setWriteError(NO_ACCESS_MESSAGE);
      gagal(NO_ACCESS_MESSAGE);
      return;
    }
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title) {
      setWriteError('Judul entri wajib diisi.');
      gagal('Judul entri wajib diisi.');
      return;
    }
    if (!content) {
      setWriteError('Isi entri wajib diisi.');
      gagal('Isi entri wajib diisi.');
      return;
    }
    setWriteBusy(true);
    setWriteError('');
    setNotice('');
    try {
      await api.adminCreateKnowledgeBase({ section: form.section, title, content, enabled: form.enabled });
      setForm({ ...FORM_KOSONG, section: form.section });
      setNotice('Entri Knowledge Base sudah disimpan dan masuk audit platform.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'knowledge base (/v1/admin/knowledge-base)');
      setWriteError(message);
      gagal(message);
    } finally {
      setWriteBusy(false);
    }
  }

  /** Nyalakan atau matikan satu entri (admin saja). */
  async function saklar(entry: KnowledgeBaseEntry): Promise<void> {
    if (!isAdmin) {
      setRowError(NO_ACCESS_MESSAGE);
      gagal(NO_ACCESS_MESSAGE);
      return;
    }
    setRowBusy(entry.id);
    setRowError('');
    setNotice('');
    try {
      await api.adminUpdateKnowledgeBase(entry.id, { enabled: !aktif(entry.enabled) });
      setNotice('Entri "' + entry.title + '" sekarang ' + (aktif(entry.enabled) ? 'mati' : 'aktif') + '.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'knowledge base (/v1/admin/knowledge-base)');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  /** Buka editor satu entri dengan isi yang sekarang (admin saja). */
  function bukaEdit(entry: KnowledgeBaseEntry): void {
    if (!isAdmin) {
      setRowError(NO_ACCESS_MESSAGE);
      gagal(NO_ACCESS_MESSAGE);
      return;
    }
    setEditId(entry.id);
    setEdit({
      section: String(entry.section ?? 'umum'),
      title: String(entry.title ?? ''),
      content: String(entry.content ?? ''),
      enabled: aktif(entry.enabled),
    });
    setRowError('');
    setNotice('');
  }

  /** Simpan perubahan satu entri (admin saja). */
  async function simpanEdit(): Promise<void> {
    if (!isAdmin) {
      setRowError(NO_ACCESS_MESSAGE);
      gagal(NO_ACCESS_MESSAGE);
      return;
    }
    const title = edit.title.trim();
    const content = edit.content.trim();
    if (!title || !content) {
      setRowError('Judul dan isi entri wajib diisi.');
      gagal('Judul dan isi entri wajib diisi.');
      return;
    }
    setRowBusy(editId);
    setRowError('');
    try {
      await api.adminUpdateKnowledgeBase(editId, {
        section: edit.section,
        title,
        content,
        enabled: edit.enabled,
      });
      setEditId('');
      setNotice('Perubahan entri sudah disimpan.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'knowledge base (/v1/admin/knowledge-base)');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  /** Hapus satu entri (admin saja) setelah kotak konfirmasi disetujui. */
  async function hapus(entry: KnowledgeBaseEntry): Promise<void> {
    if (!isAdmin) {
      setRowError(NO_ACCESS_MESSAGE);
      gagal(NO_ACCESS_MESSAGE);
      return;
    }
    if (!window.confirm('Hapus entri "' + entry.title + '"? Perubahan ini masuk audit platform.')) return;
    setRowBusy(entry.id);
    setRowError('');
    setNotice('');
    try {
      await api.adminDeleteKnowledgeBase(entry.id);
      setNotice('Entri "' + entry.title + '" sudah dihapus.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'knowledge base (/v1/admin/knowledge-base)');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  const daftarSections = sections.length > 0 ? sections : ['umum', 'whitelabel'];
  const persen = limitChars > 0 ? Math.min(100, Math.round((activeChars / limitChars) * 100)) : 0;

  /**
   * Satu bagian Knowledge Base: judul bagian dan daftar entrinya.
   * Fungsi ini dipanggil langsung (bukan sebagai komponen React) supaya kotak isi yang sedang
   * diubah tidak kehilangan fokus setiap kali halaman digambar ulang.
   */
  function bagian(section: string) {
    const isi = entries.filter((entry) => String(entry.section ?? '') === section);
    return (
      <div key={section}>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">{sectionLabel(section)}</h3>
        {isi.length === 0 ? (
          <p className={BANNER}>Belum ada entri pada bagian ini.</p>
        ) : (
          <div className="space-y-3">
            {isi.map((entry) => (
              <div key={entry.id} className={CARD}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-100">{String(entry.title ?? '(tanpa judul)')}</div>
                    <div className="text-xs text-slate-400">
                      {sectionLabel(entry.section)} · id <span className="font-mono">{String(entry.id ?? '-')}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={aktif(entry.enabled)}
                        disabled={!isAdmin || rowBusy === entry.id}
                        aria-label={'Aktifkan entri ' + String(entry.title ?? '')}
                        onChange={() => { void saklar(entry); }}
                      />
                      {aktif(entry.enabled) ? 'aktif' : 'mati'}
                    </label>
                    <button
                      type="button"
                      className={BTN_SMALL}
                      disabled={!isAdmin || rowBusy === entry.id}
                      onClick={() => (editId === entry.id ? setEditId('') : bukaEdit(entry))}
                    >
                      {editId === entry.id ? 'Batal' : 'Ubah'}
                    </button>
                    <button
                      type="button"
                      className={BTN_SMALL}
                      disabled={!isAdmin || rowBusy === entry.id}
                      onClick={() => { void hapus(entry); }}
                    >
                      Hapus
                    </button>
                  </div>
                </div>

                {editId === entry.id ? (
                  <div className="mt-3 space-y-2 border-t border-slate-700 pt-3">
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>Bagian</span>
                      <select
                        className={FIELD}
                        value={edit.section}
                        aria-label="Bagian entri yang diubah"
                        onChange={(event) => setEdit({ ...edit, section: event.target.value })}
                      >
                        {daftarSections.map((section) => (
                          <option key={section} value={section}>
                            {sectionLabel(section)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>Judul</span>
                      <input
                        className={FIELD}
                        value={edit.title}
                        maxLength={200}
                        aria-label="Judul entri yang diubah"
                        onChange={(event) => setEdit({ ...edit, title: event.target.value })}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>Isi</span>
                      <textarea
                        className={TEXTAREA}
                        value={edit.content}
                        aria-label="Isi entri yang diubah"
                        onChange={(event) => setEdit({ ...edit, content: event.target.value })}
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={edit.enabled}
                          aria-label="Aktifkan entri setelah disimpan"
                          onChange={(event) => setEdit({ ...edit, enabled: event.target.checked })}
                        />
                        Aktif
                      </label>
                      <button
                        type="button"
                        className={BTN_PRIMARY}
                        disabled={rowBusy === entry.id}
                        onClick={() => { void simpanEdit(); }}
                      >
                        {rowBusy === entry.id ? 'Menyimpan…' : 'Simpan perubahan'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-200">
                    {String(entry.content ?? '')}
                  </pre>
                )}

                <div className="mt-2 text-xs text-slate-400">
                  {numberText(String(entry.content ?? '').length)} karakter · dibuat {dateTimeText(entry.createdAt)}{' '}
                  · diperbarui {dateTimeText(entry.updatedAt)} · urutan {numberText(entry.sortOrder)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-5 text-sm text-slate-300">
      <div>
        <h2 className="text-base font-semibold text-slate-100">Knowledge Base platform</h2>
        <p className="mt-1 text-slate-400">
          Knowledge Base platform adalah aturan dan identitas yang ditanam admin platform dan ikut dikirim ke{' '}
          <span className="font-semibold">setiap</span> run agen, paling awal sebelum persona dan memori. Isinya
          dibagi dua bagian: <span className="font-mono">umum</span> (berlaku untuk semua agen) dan{' '}
          <span className="font-mono">whitelabel</span> (identitas serta aturan merek). Bentuk respons API sudah pasti,
          jadi halaman ini menampilkan bidangnya langsung, tanpa data contoh.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Total isi entri aktif dibatasi {limitChars > 0 ? numberText(limitChars) : '8.000'} karakter. Setiap perubahan
          masuk jejak audit platform. Semua pengguna boleh membaca; hanya admin platform yang boleh menulis.
        </p>
        {catatan ? <p className={'mt-2 ' + BANNER}>{catatan}</p> : null}
      </div>

      {!isAdmin ? <p className={BANNER}>{NO_ACCESS_MESSAGE}</p> : null}

      {/* Indikator kuota karakter. */}
      <div className={CARD}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className={LABEL}>Isi entri aktif</div>
            <div className="mt-1 text-slate-100">
              {numberText(activeChars)}
              {limitChars > 0 ? ' dari ' + numberText(limitChars) : ''} karakter
            </div>
            <div className={'mt-1 ' + BAR}>
              <div
                className={persen >= 100 ? 'h-full bg-amber-400' : 'h-full bg-violet-500'}
                style={{ width: persen + '%' }}
              />
            </div>
          </div>
          <div>
            <div className={LABEL}>Entri</div>
            <div className="mt-1 text-slate-100">
              {numberText(activeEntries)} aktif dari {numberText(entries.length)} entri tersimpan
            </div>
            <div className="mt-1 text-xs text-slate-400">
              Entri nonaktif tetap tersimpan tetapi tidak ikut dikirim ke agen.
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} disabled={loading} onClick={() => { void muat(); }}>
          {loading ? 'Memuat…' : 'Segarkan'}
        </button>
        <span className="text-xs text-slate-400">
          {entries.length > 0 ? numberText(entries.length) + ' entri dimuat.' : 'Belum ada entri yang dimuat.'}
        </span>
      </div>

      {loadError ? <p className={ERROR_BOX}>{loadError}</p> : null}
      {rowError ? <p className={ERROR_BOX}>{rowError}</p> : null}
      {notice ? <p className={OK_BOX}>{notice}</p> : null}

      {/* Form tulis: hanya untuk admin platform. */}
      {isAdmin ? (
        <div className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">Tulis entri baru</h3>
            <button type="button" className={BTN} onClick={() => setTulisTerbuka((current) => !current)}>
              {tulisTerbuka ? 'Tutup form' : 'Buka form'}
            </button>
          </div>
          {tulisTerbuka ? (
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Bagian</span>
                  <select
                    className={FIELD}
                    value={form.section}
                    aria-label="Bagian entri baru"
                    onChange={(event) => setForm({ ...form, section: event.target.value })}
                  >
                    {daftarSections.map((section) => (
                      <option key={section} value={section}>
                        {sectionLabel(section)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Judul</span>
                  <input
                    className={FIELD}
                    value={form.title}
                    maxLength={200}
                    placeholder="Misalnya: Approval Mode wajib"
                    aria-label="Judul entri baru"
                    onChange={(event) => {
                      setForm({ ...form, title: event.target.value });
                      setWriteError('');
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className={LABEL}>
                    Isi ({numberText(form.content.trim().length)} karakter)
                  </span>
                  <textarea
                    className={TEXTAREA}
                    value={form.content}
                    placeholder="Tulis aturan yang harus dipatuhi semua agen platform."
                    aria-label="Isi entri baru"
                    onChange={(event) => {
                      setForm({ ...form, content: event.target.value });
                      setWriteError('');
                    }}
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    aria-label="Aktifkan entri baru"
                    onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                  />
                  Langsung aktifkan
                </label>
                <button type="button" className={BTN_PRIMARY} disabled={writeBusy} onClick={() => { void tambah(); }}>
                  {writeBusy ? 'Menyimpan…' : 'Simpan entri'}
                </button>
              </div>
              {writeError ? <p className={'mt-2 ' + ERROR_BOX}>{writeError}</p> : null}
            </>
          ) : (
            <p className="mt-2 text-xs text-slate-400">
              Form disembunyikan agar tidak ada pengiriman tidak sengaja. Tekan "Buka form" untuk menulis entri.
            </p>
          )}
        </div>
      ) : (
        <div className={CARD}>
          <h3 className="text-sm font-semibold text-slate-100">Tulis entri</h3>
          <p className="mt-1">{NO_ACCESS_MESSAGE}</p>
        </div>
      )}

      {/* Daftar entri per bagian. */}
      {daftarSections.map((section) => bagian(section))}
    </section>
  );
}

export default KnowledgeBaseAdmin;

/**
 * Panel "Skill saya" (Wave 11A, butir 51).
 *
 * Skill adalah instruksi tambahan yang dipasang sendiri oleh pengguna. Isi skill yang aktif ikut
 * dikirim ke agen setelah memori. Batasnya ketat dan datang dari server:
 * maksimal 8 skill aktif (activeLimit) dan total 4.000 karakter isi aktif (charsLimit).
 *
 * Panel ini dipakai sebagai tab di halaman Kapabilitas; halaman itu tetap menampilkan daftar
 * kapabilitas statis dan tidak diubah oleh berkas ini.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, failureOf } from './api';
import type { UserSkill } from './api';

/** Properti panel: pelapor galat dari induk dan status admin platform. */
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
/** Kelas tombol kecil di dalam satu baris skill. */
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
/** Kelas kotak teks isi skill. */
const TEXTAREA = FIELD + ' min-h-24 w-full font-mono text-xs';
/** Kelas batang indikator pemakaian kuota. */
const BAR = 'h-1.5 w-full overflow-hidden rounded-full bg-slate-700';

/** Nilai bawaan form pasang skill. */
const FORM_KOSONG = { name: '', description: '', content: '', enabled: true };

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

/**
 * Ubah galat menjadi kalimat Indonesia.
 * Pesan dari server dipakai apa adanya; bila server hanya mengirim kode mesin, panel ini
 * menambahkan kalimat sendiri yang jujur (mis. rute belum tersedia).
 */
function pesanGalat(error: unknown, apa: string): string {
  const gagal = failureOf(error);
  const kode = (gagal.code + ' ' + gagal.message).toUpperCase();
  if (gagal.status === 404 || gagal.status === 501 || kode.includes('NOT_FOUND') || kode.includes('NOT_IMPLEMENTED')) {
    return 'Rute API ' + apa + ' belum tersedia di server ini (menunggu API Wave 11A).';
  }
  if (gagal.status === 401 || kode.includes('UNAUTHORIZED') || kode.includes('UNAUTHENTICATED')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk lagi, lalu buka panel ini kembali.';
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

/** Satu batang indikator pemakaian: nilai sekarang dibandingkan batasnya. */
function Kuota({ label, pakai, batas, satuan }: { label: string; pakai: number; batas: number; satuan: string }) {
  const penuh = batas > 0 && pakai >= batas;
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="mt-1 text-slate-100">
        {numberText(pakai)}
        {batas > 0 ? ' dari ' + numberText(batas) : ''} {satuan}
      </div>
      <div className={'mt-1 ' + BAR}>
        <div
          className={penuh ? 'h-full bg-amber-400' : 'h-full bg-violet-500'}
          style={{ width: batas > 0 ? Math.min(100, Math.round((pakai / batas) * 100)) + '%' : '0%' }}
        />
      </div>
    </div>
  );
}

/**
 * Panel "Skill saya": indikator kuota, form pasang skill, dan daftar skill milik akun ini.
 */
export function UserSkills({ onError, isAdmin }: Props) {
  // Daftar skill dan kuota dari server.
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [activeLimit, setActiveLimit] = useState(0);
  const [charsLimit, setCharsLimit] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [activeChars, setActiveChars] = useState(0);
  const [help, setHelp] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Form pasang skill.
  const [form, setForm] = useState(FORM_KOSONG);
  const [installError, setInstallError] = useState('');
  const [installBusy, setInstallBusy] = useState(false);

  // Ubah satu skill di tempat.
  const [editId, setEditId] = useState('');
  const [edit, setEdit] = useState(FORM_KOSONG);
  const [rowError, setRowError] = useState('');
  const [rowBusy, setRowBusy] = useState('');
  const [notice, setNotice] = useState('');

  /** Catat galat ke panel ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function gagal(message: string): void {
    onError?.(message);
  }

  /** Muat daftar skill milik akun ini. */
  const muat = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.mySkills();
      setSkills(Array.isArray(data?.skills) ? data.skills : []);
      setActiveLimit(num(data?.activeLimit));
      setCharsLimit(num(data?.charsLimit));
      setActiveCount(num(data?.activeCount));
      setActiveChars(num(data?.activeChars));
      setHelp(String(data?.help ?? ''));
    } catch (error) {
      // Jangan tampilkan daftar lama seolah masih baru: kosongkan, lalu beri pesan galat.
      setSkills([]);
      setActiveLimit(0);
      setCharsLimit(0);
      setActiveCount(0);
      setActiveChars(0);
      setHelp('');
      const message = pesanGalat(error, 'skill saya (/v1/skills/mine)');
      setLoadError(message);
      gagal(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Muat sekali saat panel dibuka; tidak ada pemanggilan berulang dari useEffect.
  useEffect(() => {
    void muat();
  }, [muat]);

  /** Pasang satu skill baru, lalu muat ulang daftarnya. */
  async function pasang(): Promise<void> {
    const name = form.name.trim();
    const content = form.content.trim();
    if (!name) {
      setInstallError('Nama skill wajib diisi.');
      gagal('Nama skill wajib diisi.');
      return;
    }
    if (!content) {
      setInstallError('Isi skill wajib diisi. Tulis instruksi yang ingin Anda tambahkan ke agen.');
      gagal('Isi skill wajib diisi.');
      return;
    }
    setInstallBusy(true);
    setInstallError('');
    setNotice('');
    try {
      await api.installMySkill({
        name,
        description: form.description.trim(),
        content,
        enabled: form.enabled,
      });
      setForm(FORM_KOSONG);
      setNotice('Skill "' + name + '" sudah dipasang.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'skill saya (/v1/skills/mine)');
      setInstallError(message);
      gagal(message);
    } finally {
      setInstallBusy(false);
    }
  }

  /** Nyalakan atau matikan satu skill. */
  async function saklar(skill: UserSkill): Promise<void> {
    setRowBusy(skill.id);
    setRowError('');
    setNotice('');
    try {
      await api.updateMySkill(skill.id, { enabled: !aktif(skill.enabled) });
      setNotice('Skill "' + skill.name + '" sekarang ' + (aktif(skill.enabled) ? 'mati' : 'aktif') + '.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'skill saya (/v1/skills/mine)');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  /** Buka editor satu skill dengan isi yang sekarang. */
  function bukaEdit(skill: UserSkill): void {
    setEditId(skill.id);
    setEdit({
      name: String(skill.name ?? ''),
      description: String(skill.description ?? ''),
      content: String(skill.content ?? ''),
      enabled: aktif(skill.enabled),
    });
    setRowError('');
    setNotice('');
  }

  /** Simpan perubahan satu skill. */
  async function simpanEdit(): Promise<void> {
    const name = edit.name.trim();
    const content = edit.content.trim();
    if (!name || !content) {
      setRowError('Nama dan isi skill wajib diisi.');
      gagal('Nama dan isi skill wajib diisi.');
      return;
    }
    setRowBusy(editId);
    setRowError('');
    try {
      await api.updateMySkill(editId, {
        name,
        description: edit.description.trim(),
        content,
        enabled: edit.enabled,
      });
      setEditId('');
      setNotice('Perubahan skill sudah disimpan.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'skill saya (/v1/skills/mine)');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  /** Hapus satu skill setelah pengguna menyetujui kotak konfirmasi. */
  async function hapus(skill: UserSkill): Promise<void> {
    if (!window.confirm('Hapus skill "' + skill.name + '"? Skill yang dihapus tidak bisa dikembalikan.')) return;
    setRowBusy(skill.id);
    setRowError('');
    setNotice('');
    try {
      await api.deleteMySkill(skill.id);
      setNotice('Skill "' + skill.name + '" sudah dihapus.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'skill saya (/v1/skills/mine)');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  return (
    <section className="space-y-5 text-sm text-slate-300">
      <div>
        <h2 className="text-base font-semibold text-slate-100">Skill saya</h2>
        <p className="mt-1 text-slate-400">
          Pasang skill Anda sendiri di sini. Isi skill yang aktif ikut dikirim ke agen setelah memori dipin, jadi
          agen mengikuti cara kerja Anda. Batas dari server: maksimal{' '}
          {activeLimit > 0 ? numberText(activeLimit) : '8'} skill aktif dengan total isi{' '}
          {charsLimit > 0 ? numberText(charsLimit) : '4.000'} karakter. Nama skill harus unik per akun. Daftar
          kapabilitas bawaan platform tetap ada di tab lain halaman ini.
        </p>
        {isAdmin ? (
          <p className="mt-1 text-xs text-slate-400">
            Anda admin platform, tetapi skill di panel ini tetap milik akun Anda sendiri.
          </p>
        ) : null}
        {help ? <p className={'mt-2 ' + BANNER}>{help}</p> : null}
      </div>

      {/* Indikator kuota skill aktif. */}
      <div className={CARD}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Kuota label="Skill aktif" pakai={activeCount} batas={activeLimit} satuan="skill" />
          <Kuota label="Isi skill aktif" pakai={activeChars} batas={charsLimit} satuan="karakter" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} disabled={loading} onClick={() => { void muat(); }}>
          {loading ? 'Memuat…' : 'Segarkan'}
        </button>
        <span className="text-xs text-slate-400">
          {skills.length > 0 ? numberText(skills.length) + ' skill tersimpan.' : 'Belum ada skill yang dimuat.'}
        </span>
      </div>

      {loadError ? <p className={ERROR_BOX}>{loadError}</p> : null}
      {rowError ? <p className={ERROR_BOX}>{rowError}</p> : null}
      {notice ? <p className={OK_BOX}>{notice}</p> : null}

      {/* Form pasang skill. */}
      <div className={CARD}>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Pasang skill baru</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Nama skill</span>
            <input
              className={FIELD}
              value={form.name}
              maxLength={60}
              placeholder="Misalnya: Ringkas laporan keuangan"
              aria-label="Nama skill"
              onChange={(event) => {
                setForm({ ...form, name: event.target.value });
                setInstallError('');
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Keterangan singkat (opsional)</span>
            <input
              className={FIELD}
              value={form.description}
              maxLength={300}
              placeholder="Untuk apa skill ini dipakai"
              aria-label="Keterangan skill"
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className={LABEL}>
              Isi skill ({numberText(form.content.trim().length)} karakter)
            </span>
            <textarea
              className={TEXTAREA}
              value={form.content}
              placeholder="Tulis instruksi yang ingin selalu dipakai agen untuk akun ini."
              aria-label="Isi skill"
              onChange={(event) => {
                setForm({ ...form, content: event.target.value });
                setInstallError('');
              }}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enabled}
              aria-label="Aktifkan skill ini setelah dipasang"
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            Langsung aktifkan
          </label>
          <button type="button" className={BTN_PRIMARY} disabled={installBusy} onClick={() => { void pasang(); }}>
            {installBusy ? 'Memasang…' : 'Pasang skill'}
          </button>
        </div>
        {installError ? <p className={'mt-2 ' + ERROR_BOX}>{installError}</p> : null}
      </div>

      {/* Daftar skill milik akun ini. */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Skill terpasang</h3>
        {skills.length === 0 && !loading ? (
          <p className={BANNER}>
            Belum ada skill terpasang. {loadError ? 'Daftar tidak bisa dimuat dari server.' : ''}
          </p>
        ) : null}
        <div className="space-y-3">
          {skills.map((skill) => (
            <div key={skill.id} className={CARD}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-100">{String(skill.name ?? '(tanpa nama)')}</div>
                  <div className="text-xs text-slate-400">
                    {String(skill.description ?? '').trim() || 'tanpa keterangan'} · id{' '}
                    <span className="font-mono">{String(skill.id ?? '-')}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={aktif(skill.enabled)}
                      disabled={rowBusy === skill.id}
                      aria-label={'Aktifkan skill ' + String(skill.name ?? '')}
                      onChange={() => { void saklar(skill); }}
                    />
                    {aktif(skill.enabled) ? 'aktif' : 'mati'}
                  </label>
                  <button
                    type="button"
                    className={BTN_SMALL}
                    disabled={rowBusy === skill.id}
                    onClick={() => (editId === skill.id ? setEditId('') : bukaEdit(skill))}
                  >
                    {editId === skill.id ? 'Batal' : 'Ubah'}
                  </button>
                  <button
                    type="button"
                    className={BTN_SMALL}
                    disabled={rowBusy === skill.id}
                    onClick={() => { void hapus(skill); }}
                  >
                    Hapus
                  </button>
                </div>
              </div>

              {editId === skill.id ? (
                <div className="mt-3 space-y-2 border-t border-slate-700 pt-3">
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>Nama skill</span>
                    <input
                      className={FIELD}
                      value={edit.name}
                      maxLength={60}
                      aria-label="Nama skill yang diubah"
                      onChange={(event) => setEdit({ ...edit, name: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>Keterangan</span>
                    <input
                      className={FIELD}
                      value={edit.description}
                      maxLength={300}
                      aria-label="Keterangan skill yang diubah"
                      onChange={(event) => setEdit({ ...edit, description: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>
                      Isi skill ({numberText(edit.content.trim().length)} karakter)
                    </span>
                    <textarea
                      className={TEXTAREA}
                      value={edit.content}
                      aria-label="Isi skill yang diubah"
                      onChange={(event) => setEdit({ ...edit, content: event.target.value })}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={edit.enabled}
                        aria-label="Aktifkan skill setelah disimpan"
                        onChange={(event) => setEdit({ ...edit, enabled: event.target.checked })}
                      />
                      Aktif
                    </label>
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={rowBusy === skill.id}
                      onClick={() => { void simpanEdit(); }}
                    >
                      {rowBusy === skill.id ? 'Menyimpan…' : 'Simpan perubahan'}
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-200">
                  {String(skill.content ?? '')}
                </pre>
              )}

              <div className="mt-2 text-xs text-slate-400">
                Dipakai {numberText(skill.useCount)} kali · dibuat {dateTimeText(skill.createdAt)} · diperbarui{' '}
                {dateTimeText(skill.updatedAt)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default UserSkills;

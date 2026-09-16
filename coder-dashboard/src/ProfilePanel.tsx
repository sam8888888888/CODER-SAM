import { useEffect, useState } from 'react';
import { api } from './api';

// Panel profil + hapus akun. Hanya memakai kelas CSS yang sudah ada di styles.css.
type Props = {
  email: string;
  displayName: string;
  onChanged?: () => void;
  onDeleted?: () => void;
};

const CONFIRM_PHRASE = 'HAPUS AKUN';
const NAME_RULE_MESSAGE = 'Nama tampilan harus 2-80 karakter.';

// Ambil kode pesan dari error server (api.request melempar Error berisi kode).
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

// Kode error server -> pesan bahasa Indonesia.
function nameErrorMessage(code: string): string {
  if (code.includes('INVALID_DISPLAY_NAME')) return NAME_RULE_MESSAGE;
  return 'Gagal menyimpan nama. Coba lagi.';
}

function deleteErrorMessage(code: string): string {
  if (code.includes('INVALID_PASSWORD')) return 'Kata sandi salah.';
  if (code.includes('LAST_ADMIN')) return 'Akun admin platform terakhir tidak boleh ditutup.';
  if (code.includes('CONFIRM_REQUIRED')) return 'Ketik HAPUS AKUN untuk konfirmasi.';
  if (code.includes('EXPORT_REQUIRED')) return 'Unduh dulu salinan data Anda. Buat ekspor di bagian "Data & Privasi", lalu kembali ke sini.';
  if (code.includes('EXPORT_TOO_OLD')) return 'Salinan data terakhir sudah lebih dari 24 jam. Buat ekspor baru dulu, lalu tutup akun.';
  if (code.includes('ACCOUNT_ALREADY_CLOSED')) return 'Akun ini sudah ditutup sebelumnya. Hubungi admin untuk memulihkannya.';
  return 'Gagal menutup akun. Coba lagi.';
}

/** Tanggal singkat bahasa Indonesia untuk tanggal pemulihan. */
function dateText(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
}

export function ProfilePanel({ email, displayName, onChanged, onDeleted }: Props) {
  const [name, setName] = useState<string>(displayName);
  const [nameError, setNameError] = useState<string>('');
  const [nameOk, setNameOk] = useState<string>('');
  const [savingName, setSavingName] = useState<boolean>(false);

  const [password, setPassword] = useState<string>('');
  const [confirm, setConfirm] = useState<string>('');
  const [deleteError, setDeleteError] = useState<string>('');
  const [deleting, setDeleting] = useState<boolean>(false);
  // Wave 8: penutupan akun wajib didahului ekspor data. Panel ini membuat ekspornya sendiri.
  const [exportId, setExportId] = useState<string>('');
  const [exportReady, setExportReady] = useState<string>('');
  const [preparing, setPreparing] = useState<boolean>(false);

  // Kalau nama dari induk berubah (mis. setelah muat ulang profil), ikuti nilainya.
  useEffect(() => { setName(displayName); }, [displayName]);

  // Simpan nama tampilan. Validasi klien dulu, baru kirim ke server.
  async function saveName(): Promise<void> {
    setNameError('');
    setNameOk('');
    const value = name.trim();
    if (value.length < 2 || value.length > 80) {
      setNameError(NAME_RULE_MESSAGE);
      return;
    }
    setSavingName(true);
    try {
      await api.updateProfile(value);
      setNameOk('Nama tampilan diperbarui.');
      onChanged?.();
    } catch (error) {
      setNameError(nameErrorMessage(errorCode(error)));
    } finally {
      setSavingName(false);
    }
  }

  /**
   * Siapkan salinan data lewat API ekspor. Tautan unduhnya langsung dibuka, lalu id ekspor
   * disimpan supaya bisa dipakai saat menutup akun.
   */
  async function prepareExport(): Promise<void> {
    setDeleteError('');
    setExportReady('');
    setPreparing(true);
    try {
      const result = await api.createExport();
      const id = String(result?.export?.id ?? '');
      setExportId(id);
      setExportReady(
        'Salinan data siap' +
          (result?.export?.expiresAt ? ` (kedaluwarsa ${dateText(String(result.export.expiresAt))})` : '') +
          '. Simpan berkasnya, lalu tutup akun.',
      );
      if (id) window.open(api.exportDownloadUrl(id), '_blank');
    } catch (error) {
      setDeleteError(
        errorCode(error).includes('EXPORT_ALREADY_RUNNING')
          ? 'Ekspor sebelumnya masih diproses. Tunggu sebentar, lalu coba lagi.'
          : 'Gagal membuat salinan data. Coba lagi sebentar lagi.',
      );
    } finally {
      setPreparing(false);
    }
  }

  // Tutup akun: butuh kata sandi saat ini + frasa konfirmasi persis.
  async function removeAccount(): Promise<void> {
    setDeleteError('');
    if (confirm !== CONFIRM_PHRASE) {
      setDeleteError('Ketik HAPUS AKUN untuk konfirmasi.');
      return;
    }
    if (password.length === 0) {
      setDeleteError('Masukkan kata sandi Anda.');
      return;
    }
    setDeleting(true);
    try {
      await api.deleteAccount(password, exportId || undefined);
      onDeleted?.();
    } catch (error) {
      setDeleteError(deleteErrorMessage(errorCode(error)));
    } finally {
      setDeleting(false);
    }
  }

  const confirmOk = confirm === CONFIRM_PHRASE && password.length > 0;

  return (
    <>
      <section className="settings-card">
        <h2 className="settings-heading">Profil</h2>
        <p className="settings-meta">{email}</p>
        <p className="settings-hint">Email tidak dapat diubah.</p>
        <label>
          Nama tampilan
          <input
            type="text"
            value={name}
            maxLength={80}
            disabled={savingName}
            onChange={(event) => {
              setName(event.target.value);
              setNameError('');
              setNameOk('');
            }}
          />
        </label>
        <button type="button" className="primary" disabled={savingName} onClick={() => { void saveName(); }}>
          {savingName ? 'Menyimpan…' : 'Simpan nama'}
        </button>
        {nameError ? <p className="error">{nameError}</p> : null}
        {nameOk ? <p className="settings-ok">{nameOk}</p> : null}
      </section>

      <section className="settings-card danger-zone">
        <h2 className="settings-heading">Tutup akun</h2>
        <p className="settings-hint">
          Langkah 1: unduh salinan data Anda. Langkah 2: tutup akun. Akun langsung tidak bisa dipakai, lalu
          datanya dihapus permanen setelah 90 hari. Selama masa itu admin masih bisa memulihkan akun Anda.
        </p>
        <button type="button" className="primary" disabled={preparing || deleting} onClick={() => { void prepareExport(); }}>
          {preparing ? 'Menyiapkan salinan…' : exportReady ? 'Buat salinan data baru' : 'Langkah 1: unduh salinan data'}
        </button>
        {exportReady ? <p className="settings-ok">{exportReady}</p> : null}
        <p className="settings-hint">Langkah 2: isi kata sandi dan frasa konfirmasi, lalu tutup akun.</p>
        <label>
          Kata sandi saat ini
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            disabled={deleting}
            onChange={(event) => {
              setPassword(event.target.value);
              setDeleteError('');
            }}
          />
        </label>
        <label>
          <span className="section-label">Ketik HAPUS AKUN untuk konfirmasi</span>
          <input
            type="text"
            value={confirm}
            placeholder={CONFIRM_PHRASE}
            disabled={deleting}
            onChange={(event) => {
              setConfirm(event.target.value);
              setDeleteError('');
            }}
          />
        </label>
        <button type="button" className="btn-danger" disabled={!confirmOk || deleting} onClick={() => { void removeAccount(); }}>
          {deleting ? 'Menutup…' : 'Tutup akun saya'}
        </button>
        {deleteError ? <p className="error">{deleteError}</p> : null}
      </section>
    </>
  );
}

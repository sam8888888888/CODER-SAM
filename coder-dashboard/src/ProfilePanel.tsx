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
  if (code.includes('LAST_ADMIN')) return 'Akun admin platform terakhir tidak boleh dihapus.';
  if (code.includes('CONFIRM_REQUIRED')) return 'Ketik HAPUS AKUN untuk konfirmasi.';
  return 'Gagal menghapus akun. Coba lagi.';
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

  // Hapus akun: butuh kata sandi saat ini + frasa konfirmasi persis.
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
      await api.deleteAccount(password);
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
        <h2 className="settings-heading">Hapus akun</h2>
        <p className="settings-hint">Akun, sesi login, dan workspace yang hanya berisi Anda akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.</p>
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
          {deleting ? 'Menghapus…' : 'Hapus akun saya'}
        </button>
        {deleteError ? <p className="error">{deleteError}</p> : null}
      </section>
    </>
  );
}

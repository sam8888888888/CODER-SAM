import { useEffect, useRef, useState } from 'react';
import { api, failureOf, type AvatarResult } from './api';

// Panel profil + foto profil/avatar agen (butir 76) + hapus akun. Hanya memakai kelas CSS yang sudah ada.
type Props = {
  email: string;
  displayName: string;
  userId?: string;
  isAdmin?: boolean;
  onChanged?: () => void;
  onDeleted?: () => void;
};

const CONFIRM_PHRASE = 'HAPUS AKUN';
const NAME_RULE_MESSAGE = 'Nama tampilan harus 2-80 karakter.';

// Butir 76 (keputusan Bapak 26 Sep 2026): TIDAK ada pemroses gambar di server untuk merapikan foto.
// Jadi peramban yang mengerjakan: baca berkas -> potong persegi di tengah -> perkecil ke 512x512 ->
// tulis ulang sebagai PNG. Server tetap memeriksa ulang isi berkasnya (hanya PNG yang diterima mentah).
const AVATAR_MAX_MB = 4;
const AVATAR_MAX_BYTES = AVATAR_MAX_MB * 1024 * 1024;
const AVATAR_SISI = 512;

/** Hasil transformasi di peramban: PNG 512x512 dalam base64 + keterangan asal berkasnya. */
type PngSiap = { base64: string; lebar: number; tinggi: number; asalJenis: string; asalLebar: number; asalTinggi: number };

/** Ubah byte menjadi base64 tanpa `FileReader` supaya jalur kodenya pendek dan mudah dibaca. */
function base64Dari(bytes: Uint8Array): string {
  let biner = '';
  const potongan = 0x8000;
  for (let i = 0; i < bytes.length; i += potongan) {
    biner += String.fromCharCode(...bytes.subarray(i, i + potongan));
  }
  return btoa(biner);
}

/**
 * Transformasi gambar di peramban. Berlaku untuk semua format yang bisa dibaca peramban
 * (JPEG, PNG, WebP, GIF): gambar dipotong persegi di tengah, diperkecil ke 512x512, lalu
 * ditulis sebagai PNG. Kalau peramban tidak bisa membaca berkasnya, fungsi ini melempar galat.
 */
async function kePngPersegi(berkas: File): Promise<PngSiap> {
  const bitmap = await createImageBitmap(berkas);
  const sisi = Math.min(bitmap.width, bitmap.height);
  const kanvas = document.createElement('canvas');
  kanvas.width = AVATAR_SISI;
  kanvas.height = AVATAR_SISI;
  const konteks = kanvas.getContext('2d');
  if (!konteks) throw new Error('KANVAS_TIDAK_TERSEDIA');
  konteks.imageSmoothingEnabled = true;
  konteks.imageSmoothingQuality = 'high';
  konteks.drawImage(
    bitmap,
    Math.floor((bitmap.width - sisi) / 2), Math.floor((bitmap.height - sisi) / 2), sisi, sisi,
    0, 0, AVATAR_SISI, AVATAR_SISI,
  );
  const asal = { lebar: bitmap.width, tinggi: bitmap.height };
  if (typeof bitmap.close === 'function') bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => kanvas.toBlob((hasil) => resolve(hasil), 'image/png'));
  if (!blob) throw new Error('KANVAS_GAGAL');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    base64: base64Dari(bytes),
    lebar: AVATAR_SISI,
    tinggi: AVATAR_SISI,
    asalJenis: berkas.type || 'tidak diketahui',
    asalLebar: asal.lebar,
    asalTinggi: asal.tinggi,
  };
}

function ukuranMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

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

export function ProfilePanel({ email, displayName, userId, isAdmin = false, onChanged, onDeleted }: Props) {
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

  // Butir 76: foto profil (semua pengguna) dan avatar agen (admin platform).
  const berkasRef = useRef<HTMLInputElement | null>(null);
  const berkasAgenRef = useRef<HTMLInputElement | null>(null);
  const [avatar, setAvatar] = useState<AvatarResult | null>(null);
  const [avatarAda, setAvatarAda] = useState<boolean | null>(null);
  const [stempel, setStempel] = useState<number>(0);
  const [asal, setAsal] = useState<string>('');
  const [avatarGalat, setAvatarGalat] = useState<string>('');
  const [avatarOk, setAvatarOk] = useState<string>('');
  const [avatarSibuk, setAvatarSibuk] = useState<boolean>(false);
  const [agenAvatar, setAgenAvatar] = useState<AvatarResult | null>(null);
  const [agenAda, setAgenAda] = useState<boolean | null>(null);
  const [agenGalat, setAgenGalat] = useState<string>('');
  const [agenOk, setAgenOk] = useState<string>('');
  const [agenSibuk, setAgenSibuk] = useState<boolean>(false);

  // Kalau nama dari induk berubah (mis. setelah muat ulang profil), ikuti nilainya.
  useEffect(() => { setName(displayName); }, [displayName]);

  // Keadaan avatar agen dibaca dari server (hanya admin yang boleh memanggilnya).
  useEffect(() => {
    if (!isAdmin) { setAgenAvatar(null); return; }
    let hidup = true;
    void api.agentAvatar()
      .then((jawaban) => { if (hidup) setAgenAvatar(jawaban.agentAvatar); })
      .catch((error) => {
        if (!hidup) return;
        const detail = failureOf(error);
        setAgenGalat(`Gagal membaca keadaan avatar agen: ${detail.message || detail.code}`);
      });
    return () => { hidup = false; };
  }, [isAdmin]);

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

  /**
   * Unggah foto profil. Alur: peramban memotong + memperkecil + menulis PNG, lalu server memeriksa
   * ulang hasilnya. Berkas yang lebih besar dari batas ditolak di sini dengan pesan yang jelas supaya
   * pengguna tidak menunggu unggahan yang pasti gagal; batas yang sama juga berlaku di server.
   */
  async function unggahAvatar(): Promise<void> {
    const berkas = berkasRef.current?.files?.[0];
    if (!berkas) { setAvatarGalat('Pilih berkas gambar dulu.'); return; }
    if (berkas.size > AVATAR_MAX_BYTES) {
      setAvatarOk('');
      setAvatarGalat(`Ukuran berkas ${ukuranMb(berkas.size)} MB melebihi batas ${AVATAR_MAX_MB} MB. Server akan menjawab 413 AVATAR_TOO_LARGE, jadi halaman ini berhenti lebih dulu.`);
      return;
    }
    setAvatarSibuk(true); setAvatarGalat(''); setAvatarOk('');
    try {
      const png = await kePngPersegi(berkas);
      setAsal(`Asal ${png.asalJenis} ${png.asalLebar}×${png.asalTinggi} px → dikirim PNG ${png.lebar}×${png.tinggi} px`);
      const jawaban = await api.uploadAvatar(png.base64, berkas.name, berkas.type);
      setAvatar(jawaban.avatar);
      setStempel(Date.now());
      setAvatarAda(true);
      setAvatarOk(`Tersimpan di server sebagai ${jawaban.avatar.berkas ?? '(tanpa nama)'} (${jawaban.avatar.jenis ?? 'image/png'}, ${jawaban.avatar.ukuran ?? 0} byte, dari gambar ${jawaban.avatar.asal?.lebar ?? png.asalLebar}×${jawaban.avatar.asal?.tinggi ?? png.asalTinggi}).`);
    } catch (error) {
      if (error instanceof Error && (error.message === 'KANVAS_GAGAL' || error.message === 'KANVAS_TIDAK_TERSEDIA')) {
        setAvatarGalat('Peramban gagal menulis ulang gambar ini (kanvas tidak tersedia). Coba berkas lain.');
      } else if (error instanceof Error && error.name === 'InvalidStateError') {
        setAvatarGalat('Peramban tidak bisa membaca berkas ini sebagai gambar. Coba JPEG, PNG, atau WebP.');
      } else {
        const detail = failureOf(error);
        setAvatarGalat(`${detail.message || detail.code} [${detail.code}]`);
      }
    } finally {
      setAvatarSibuk(false);
    }
  }

  /** Hapus foto profil. Keadaan di layar mengikuti jawaban server, bukan tebakan halaman. */
  async function hapusAvatar(): Promise<void> {
    setAvatarSibuk(true); setAvatarGalat(''); setAvatarOk('');
    try {
      await api.deleteAvatar();
      setAvatar(null);
      setAvatarAda(false);
      setAsal('');
      setStempel(Date.now());
      setAvatarOk('Foto profil dihapus di server.');
    } catch (error) {
      const detail = failureOf(error);
      setAvatarGalat(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setAvatarSibuk(false);
    }
  }

  /** Avatar agen (admin): alur transformasi peramban sama persis dengan foto profil. */
  async function unggahAgenAvatar(): Promise<void> {
    const berkas = berkasAgenRef.current?.files?.[0];
    if (!berkas) { setAgenGalat('Pilih berkas gambar dulu.'); return; }
    if (berkas.size > AVATAR_MAX_BYTES) {
      setAgenOk('');
      setAgenGalat(`Ukuran berkas ${ukuranMb(berkas.size)} MB melebihi batas ${AVATAR_MAX_MB} MB.`);
      return;
    }
    setAgenSibuk(true); setAgenGalat(''); setAgenOk('');
    try {
      const png = await kePngPersegi(berkas);
      const jawaban = await api.uploadAgentAvatar(png.base64, berkas.name, berkas.type);
      setAgenAvatar(jawaban.agentAvatar);
      setAgenAda(true);
      setStempel(Date.now());
      setAgenOk(`Avatar agen tersimpan sebagai ${jawaban.agentAvatar.berkas ?? '(tanpa nama)'} (${jawaban.agentAvatar.ukuran ?? 0} byte).`);
    } catch (error) {
      const detail = failureOf(error);
      setAgenGalat(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setAgenSibuk(false);
    }
  }

  async function hapusAgenAvatar(): Promise<void> {
    setAgenSibuk(true); setAgenGalat(''); setAgenOk('');
    try {
      await api.deleteAgentAvatar();
      setAgenAvatar(null);
      setAgenAda(false);
      setStempel(Date.now());
      setAgenOk('Avatar agen dihapus di server.');
    } catch (error) {
      const detail = failureOf(error);
      setAgenGalat(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setAgenSibuk(false);
    }
  }

  const avatarUrl = userId ? `${api.avatarUrl(userId)}?v=${stempel}` : '';
  const agenAvatarUrl = `${api.agentAvatarUrl()}?v=${stempel}`;

  return (
    <>
      <section className="settings-card" data-testid="avatar-card"
        data-terpasang={avatarAda === null ? 'belum-dibaca' : avatarAda ? 'true' : 'false'}
        data-jenis={avatar?.jenis ?? ''}
        data-lebar={avatar?.lebar ?? ''}
        data-tinggi={avatar?.tinggi ?? ''}>
        <h2 className="settings-heading">Foto profil</h2>
        <p className="settings-hint">
          Gambar dipotong persegi di tengah dan diperkecil menjadi {AVATAR_SISI}×{AVATAR_SISI} piksel di
          peramban Anda, lalu dikirim sebagai PNG (batas {AVATAR_MAX_MB} MB). Server tidak punya pustaka
          pemroses gambar: ia hanya menerima PNG, memotong dan menskalakan ulang sendiri ke
          {AVATAR_SISI}×{AVATAR_SISI}, lalu menulis ulang berkasnya tanpa metadata. Karena itu JPEG dan WebP
          tetap bisa Anda pilih — peramban yang menulis ulangnya lebih dulu — sedangkan JPEG/WebP yang
          dikirim mentah ke API dijawab 503 IMAGE_PROCESSOR_UNAVAILABLE.
        </p>
        {userId ? (
          <img
            data-testid="avatar-gambar"
            data-ada={avatarAda === null ? 'belum-dibaca' : avatarAda ? 'true' : 'false'}
            className="avatar-preview"
            style={{ width: 96, height: 96, borderRadius: 12, objectFit: 'cover', background: '#0f172a' }}
            src={avatarUrl}
            alt="Foto profil Anda"
            onLoad={() => setAvatarAda(true)}
            onError={() => setAvatarAda(false)}
          />
        ) : null}
        <p className="settings-hint" data-testid="avatar-keadaan">
          {avatarAda === false ? 'Belum ada foto profil untuk akun ini.' : avatarAda ? 'Foto profil tersedia dari server.' : 'Keadaan foto profil belum dibaca.'}
          {asal ? ` ${asal}.` : ''}
        </p>
        <label>
          Berkas gambar (JPEG, PNG, atau WebP)
          <input type="file" accept="image/*" data-testid="avatar-berkas" ref={berkasRef} />
        </label>
        <button type="button" className="primary" data-testid="avatar-unggah" disabled={avatarSibuk} onClick={() => { void unggahAvatar(); }}>
          {avatarSibuk ? 'Memproses gambar…' : 'Potong & unggah foto profil'}
        </button>
        <button type="button" data-testid="avatar-hapus" disabled={avatarSibuk || avatarAda !== true} onClick={() => { void hapusAvatar(); }}>
          Hapus foto profil
        </button>
        {avatarGalat ? <p className="error" role="alert" data-testid="avatar-galat">{avatarGalat}</p> : null}
        {avatarOk ? <p className="settings-ok" data-testid="avatar-ok">{avatarOk}</p> : null}
      </section>

      {isAdmin ? (
        <section className="settings-card" data-testid="agent-avatar-card"
          data-terpasang={agenAda === null ? 'belum-dibaca' : agenAda ? 'true' : 'false'}
          data-berkas={agenAvatar?.berkas ?? ''}>
          <h2 className="settings-heading">Avatar agen (admin platform)</h2>
          <p className="settings-hint">
            Satu avatar untuk agen platform. Prosesnya sama: peramban memotong dan memperkecil, server
            menyimpan PNG hasil pemeriksaan ulang.
          </p>
          <img
            data-testid="agent-avatar-gambar"
            data-ada={agenAda === null ? 'belum-dibaca' : agenAda ? 'true' : 'false'}
            style={{ width: 96, height: 96, borderRadius: 12, objectFit: 'cover', background: '#0f172a' }}
            src={agenAvatarUrl}
            alt="Avatar agen"
            onLoad={() => setAgenAda(true)}
            onError={() => setAgenAda(false)}
          />
          <p className="settings-hint" data-testid="agent-avatar-keadaan">
            {agenAvatar ? `Tersimpan: ${agenAvatar.berkas ?? '(tanpa berkas)'} · ${agenAvatar.ukuran ?? 0} byte · ${agenAvatar.lebar ?? 0}×${agenAvatar.tinggi ?? 0} px${agenAvatar.diperbaruiPada ? ` · diperbarui ${agenAvatar.diperbaruiPada}` : ''}` : 'Belum ada avatar agen di server.'}
          </p>
          <label>
            Berkas gambar (JPEG, PNG, atau WebP)
            <input type="file" accept="image/*" data-testid="agent-avatar-berkas" ref={berkasAgenRef} />
          </label>
          <button type="button" className="primary" data-testid="agent-avatar-unggah" disabled={agenSibuk} onClick={() => { void unggahAgenAvatar(); }}>
            {agenSibuk ? 'Memproses gambar…' : 'Potong & unggah avatar agen'}
          </button>
          <button type="button" data-testid="agent-avatar-hapus" disabled={agenSibuk || agenAda !== true} onClick={() => { void hapusAgenAvatar(); }}>
            Hapus avatar agen
          </button>
          {agenGalat ? <p className="error" role="alert" data-testid="agent-avatar-galat">{agenGalat}</p> : null}
          {agenOk ? <p className="settings-ok" data-testid="agent-avatar-ok">{agenOk}</p> : null}
        </section>
      ) : null}

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

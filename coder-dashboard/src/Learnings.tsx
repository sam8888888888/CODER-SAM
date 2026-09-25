import { useCallback, useEffect, useState } from 'react';
import { api, type Learning, type LearningsResponse } from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, angka, daftar, pesanGalat, waktu } from './w11b';

/** Properti halaman "Pelajaran" (butir 60). Dipasang sebagai tab di halaman Memori. */
type Props = { onError?: (message: string) => void };

/** Batas yang dipakai server; disalin supaya pengguna tahu batasnya sebelum menekan simpan. */
const JUDUL_MAKS = 200;
const ISI_MAKS = 8000;

/**
 * Tab "Pelajaran" (butir 60).
 *
 * Pelajaran berbeda dari bank memori: bank memori menyimpan catatan gaya pengguna, sedangkan
 * pelajaran adalah butir yang dipelajari agen dari pekerjaan sebelumnya. Hanya pelajaran AKTIF yang
 * dikirim ke mesin, dan jumlah aktif dibatasi server. Tab ini mengubah data lewat API pelajaran
 * (/v1/learnings), bukan lewat bank memori, supaya kedua daftar tidak saling menimpa.
 */
export function Learnings({ onError }: Props) {
  const [data, setData] = useState<LearningsResponse | null>(null);
  const [memuat, setMemuat] = useState(false);
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [judul, setJudul] = useState('');
  const [isi, setIsi] = useState('');
  const [sibuk, setSibuk] = useState('');
  const [konfirmasi, setKonfirmasi] = useState('');
  const [suntingId, setSuntingId] = useState('');
  const [suntingJudul, setSuntingJudul] = useState('');
  const [suntingIsi, setSuntingIsi] = useState('');

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat('');
    try {
      setData(await api.learnings());
    } catch (error) {
      gagal(pesanGalat(error, 'Daftar pelajaran gagal dimuat dari server.'));
    } finally {
      setMemuat(false);
    }
  }, [gagal]);

  useEffect(() => { void muat(); }, [muat]);

  const daftarPelajaran = daftar<Learning>(data?.learnings);

  /** Tambah pelajaran baru. Judul dan isi wajib diisi; server tetap memeriksa ulang. */
  async function tambah(): Promise<void> {
    if (!judul.trim() || !isi.trim()) { gagal('Judul dan isi pelajaran wajib diisi.'); return; }
    setSibuk('tambah');
    setPesan('');
    try {
      const hasil = await api.createLearning({ title: judul.trim(), body: isi.trim() });
      setJudul('');
      setIsi('');
      setPesan(`Pelajaran "${hasil.learning.title}" tersimpan dan langsung aktif.`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Pelajaran baru gagal disimpan.'));
    } finally {
      setSibuk('');
    }
  }

  /** Aktifkan atau matikan satu pelajaran. Hanya yang aktif ikut dikirim ke mesin. */
  async function ubahAktif(item: Learning): Promise<void> {
    setSibuk(item.id);
    setPesan('');
    try {
      const hasil = await api.updateLearning(item.id, { enabled: !item.enabled });
      setPesan(hasil.learning.enabled
        ? `Pelajaran "${hasil.learning.title}" diaktifkan dan ikut dikirim ke mesin.`
        : `Pelajaran "${hasil.learning.title}" dimatikan, jadi tidak dikirim ke mesin.`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Status pelajaran gagal diubah.'));
    } finally {
      setSibuk('');
    }
  }

  /** Simpan perubahan judul dan isi satu pelajaran. */
  async function simpanSunting(item: Learning): Promise<void> {
    if (!suntingJudul.trim() || !suntingIsi.trim()) { gagal('Judul dan isi pelajaran wajib diisi.'); return; }
    setSibuk(item.id);
    try {
      const hasil = await api.updateLearning(item.id, { title: suntingJudul.trim(), body: suntingIsi.trim() });
      setSuntingId('');
      setPesan(`Perubahan pelajaran "${hasil.learning.title}" tersimpan.`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Perubahan pelajaran gagal disimpan.'));
    } finally {
      setSibuk('');
    }
  }

  /** Hapus satu pelajaran sesudah konfirmasi di dalam halaman (bukan dialog peramban). */
  async function hapus(item: Learning): Promise<void> {
    setSibuk(item.id);
    setPesan('');
    try {
      await api.deleteLearning(item.id);
      setKonfirmasi('');
      setPesan(`Pelajaran "${item.title}" dihapus dari daftar.`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Pelajaran gagal dihapus.'));
    } finally {
      setSibuk('');
    }
  }

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="learnings" data-count={daftarPelajaran.length}>
      <header>
        <h2 className="text-base font-semibold text-slate-100">✱ Pelajaran</h2>
        <p className="mt-1 text-slate-400">
          Pelajaran adalah butir yang dipelajari agen dari pekerjaan sebelumnya. Pelajaran yang AKTIF ikut
          dikirim ke mesin bersama prompt; yang dimatikan tetap tersimpan tetapi tidak dikirim.
        </p>
        {data ? (
          <p className="mt-2" data-testid="learnings-limits">
            {angka(data.activeCount)} aktif dari batas {angka(data.activeLimit)} · {angka(data.total)} butir tersimpan
            dari batas {angka(data.maxTotal)}. {data.help}
          </p>
        ) : null}
      </header>

      {galat ? <p className="text-rose-300" data-testid="learnings-error">{galat}</p> : null}
      {pesan ? <p className="text-emerald-300" data-testid="learnings-message">{pesan}</p> : null}

      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Tambah pelajaran</h3>
        <div className="grid gap-2">
          <label className={LABEL}>
            Judul
            <input
              className={FIELD}
              data-testid="learnings-judul"
              value={judul}
              maxLength={JUDUL_MAKS}
              placeholder="Contoh: Selalu jalankan uji sebelum lapor"
              onChange={(event) => setJudul(event.target.value)}
            />
          </label>
          <label className={LABEL}>
            Isi pelajaran
            <textarea
              className={`${FIELD} min-h-[90px]`}
              data-testid="learnings-isi"
              value={isi}
              maxLength={ISI_MAKS}
              placeholder="Tulis butir yang harus diingat agen pada pekerjaan berikutnya."
              onChange={(event) => setIsi(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button type="button" className={BTN_UTAMA} data-testid="learnings-tambah" disabled={sibuk === 'tambah'} onClick={() => void tambah()}>
              {sibuk === 'tambah' ? 'Menyimpan…' : 'Tambah pelajaran'}
            </button>
            <button type="button" className={BTN} disabled={memuat} onClick={() => void muat()}>Muat ulang</button>
          </div>
        </div>
      </div>

      {memuat && !daftarPelajaran.length ? <p>Memuat pelajaran…</p> : null}
      {!memuat && !daftarPelajaran.length ? (
        <p className="empty-side" data-testid="learnings-kosong">Belum ada pelajaran. Tambahkan satu butir di atas.</p>
      ) : null}

      {daftarPelajaran.length ? (
        <ul className="grid gap-2" data-testid="learnings-daftar">
          {daftarPelajaran.map((item) => (
            <li key={item.id} className={CARD} data-testid={`learning-${item.id}`}>
              {suntingId === item.id ? (
                <div className="grid gap-2">
                  <label className={LABEL}>
                    Judul
                    <input className={FIELD} data-testid={`learning-edit-judul-${item.id}`} value={suntingJudul} onChange={(event) => setSuntingJudul(event.target.value)} />
                  </label>
                  <label className={LABEL}>
                    Isi
                    <textarea className={`${FIELD} min-h-[70px]`} data-testid={`learning-edit-isi-${item.id}`} value={suntingIsi} onChange={(event) => setSuntingIsi(event.target.value)} />
                  </label>
                  <div className="flex gap-2">
                    <button type="button" className={BTN_UTAMA} data-testid={`learning-simpan-${item.id}`} disabled={sibuk === item.id} onClick={() => void simpanSunting(item)}>Simpan</button>
                    <button type="button" className={BTN} onClick={() => setSuntingId('')}>Batal</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="text-slate-100">{item.title}</b>
                    <span className="text-xs text-slate-400" data-testid={`learning-status-${item.id}`}>
                      {item.enabled ? 'aktif — ikut dikirim ke mesin' : 'nonaktif — tidak dikirim'}
                    </span>
                    <span className="text-xs text-slate-500">dibuat {waktu(item.createdAt)} · dipakai {angka(item.useCount)} kali</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-slate-300">{item.body}</p>
                  {item.tags ? <p className="mt-1 text-xs text-slate-400">Tag: {item.tags}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className={BTN} data-testid={`learning-aktif-${item.id}`} disabled={sibuk === item.id} onClick={() => void ubahAktif(item)}>
                      {item.enabled ? 'Matikan' : 'Aktifkan'}
                    </button>
                    <button
                      type="button"
                      className={BTN}
                      data-testid={`learning-edit-${item.id}`}
                      onClick={() => { setSuntingId(item.id); setSuntingJudul(item.title); setSuntingIsi(item.body); }}
                    >
                      Ubah
                    </button>
                    {konfirmasi === item.id ? (
                      <>
                        <button type="button" className={BTN} data-testid={`learning-hapus-yakin-${item.id}`} disabled={sibuk === item.id} onClick={() => void hapus(item)}>
                          Ya, hapus pelajaran ini
                        </button>
                        <button type="button" className={BTN} onClick={() => setKonfirmasi('')}>Batal</button>
                      </>
                    ) : (
                      <button type="button" className={BTN} data-testid={`learning-hapus-${item.id}`} onClick={() => setKonfirmasi(item.id)}>Hapus</button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

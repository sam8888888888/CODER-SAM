import { useCallback, useEffect, useState } from 'react';
import { api, type Project, type Schedule, type SchedulesResponse, type Workspace } from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, ZONA_WAKTU, angka, daftar, pesanGalat, waktu } from './w11b';

type Props = { onError?: (message: string) => void };

/** Contoh jadwal bawaan supaya pengguna tidak perlu hafal bentuk cron 5 kolom. */
const CRON_CONTOH = '0 7 * * *';

/**
 * Halaman "Jadwal" (butir 72).
 *
 * Jadwal disimpan server pada tabel prompt_schedules dan dijalankan pekerja latar setiap menit.
 * Halaman ini hanya mengurus daftar, penambahan, perubahan, penghapusan, dan tombol "Jalankan
 * sekarang". Waktu tayang ("berikutnya") dihitung server memakai zona waktu jadwal, bukan jam peramban;
 * angka itu ditampilkan apa adanya supaya tidak ada selisih jam.
 */
export function Schedules({ onError }: Props) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [proyek, setProyek] = useState<Project[]>([]);
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState(CRON_CONTOH);
  const [zona, setZona] = useState('');
  const [proyekId, setProyekId] = useState('');
  const [otonom, setOtonom] = useState(true);
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState('');
  const [sunting, setSunting] = useState('');
  const [suntingCron, setSuntingCron] = useState('');
  const [suntingZona, setSuntingZona] = useState('');
  const [konfirmasi, setKonfirmasi] = useState('');

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  const muat = useCallback(async () => {
    setGalat('');
    try {
      const isi = await api.schedules();
      setData(isi);
      setZona((current) => current || isi.defaultTimezone);
    } catch (error) {
      gagal(pesanGalat(error, 'Daftar jadwal gagal dimuat.'));
    }
  }, [gagal]);

  /** Daftar proyek dipakai untuk memilih sasaran jadwal; bila gagal, jadwal tetap bisa dibuat. */
  const muatProyek = useCallback(async () => {
    try {
      const ruang: Workspace[] = daftar<Workspace>(await api.workspaces());
      const semua: Project[] = [];
      for (const item of ruang) {
        try { semua.push(...daftar<Project>(await api.projects(item.id))); } catch { /* ruang tanpa proyek diabaikan */ }
      }
      setProyek(semua);
    } catch {
      setProyek([]);
    }
  }, []);

  useEffect(() => { void muat(); void muatProyek(); }, [muat, muatProyek]);

  const daftarJadwal = daftar<Schedule>(data?.schedules);

  async function tambah(): Promise<void> {
    if (!prompt.trim()) { gagal('Perintah jadwal belum diisi.'); return; }
    setSibuk('tambah');
    setPesan('');
    try {
      const hasil = await api.createSchedule({
        prompt: prompt.trim(), cron: cron.trim(), timezone: zona,
        autonomous: otonom, ...(proyekId ? { projectId: proyekId } : {}),
      });
      setPrompt('');
      setPesan(`Jadwal tersimpan. Waktu berikutnya ${waktu(hasil.schedule.nextRunAt)} (${hasil.schedule.timezone}).`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Jadwal gagal disimpan.'));
    } finally {
      setSibuk('');
    }
  }

  async function jalankanSekarang(item: Schedule): Promise<void> {
    setSibuk(item.id);
    setPesan('');
    try {
      const hasil = await api.runScheduleNow(item.id);
      setPesan(hasil.dijalankan
        ? `Jadwal dijalankan sekarang; run ${String(hasil.runId).slice(0, 8)} sudah dibuat. ${hasil.catatan}`
        : `Jadwal belum bisa dijalankan: ${hasil.alasan}. ${hasil.catatan}`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Jadwal gagal dijalankan sekarang.'));
    } finally {
      setSibuk('');
    }
  }

  async function ubah(item: Schedule, patch: Parameters<typeof api.updateSchedule>[1]): Promise<void> {
    setSibuk(item.id);
    setPesan('');
    try {
      const hasil = await api.updateSchedule(item.id, patch);
      setPesan(`Jadwal diperbarui. Berikutnya ${waktu(hasil.schedule.nextRunAt)}; perubahan berlaku untuk jalannya sendiri.`);
      setSunting('');
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Perubahan jadwal gagal disimpan.'));
    } finally {
      setSibuk('');
    }
  }

  async function hapus(item: Schedule): Promise<void> {
    setSibuk(item.id);
    try {
      await api.deleteSchedule(item.id);
      setKonfirmasi('');
      setPesan('Jadwal dihapus.');
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Jadwal gagal dihapus.'));
    } finally {
      setSibuk('');
    }
  }

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="schedules" data-count={daftarJadwal.length} data-limit={data?.limit ?? ''}>
      <header>
        <h2 className="text-base font-semibold text-slate-100">⏱ Jadwal</h2>
        <p className="mt-1 text-slate-400">
          Jalankan perintah yang sama secara berkala tanpa membuka halaman ini. Zona waktu disimpan per jadwal,
          jadi jam tayangnya tetap benar walau perangkat Anda berpindah zona.
        </p>
        {data ? (
          <p className="mt-1 text-xs text-slate-400" data-testid="schedules-batas">
            {angka(data.total)} dari batas {angka(data.limit)} jadwal dipakai · zona bawaan {data.defaultTimezone}. {data.help}
          </p>
        ) : null}
      </header>

      {galat ? <p className="text-rose-300" data-testid="schedules-error">{galat}</p> : null}
      {pesan ? <p className="text-emerald-300" data-testid="schedules-message">{pesan}</p> : null}

      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Jadwal baru</h3>
        <div className="grid gap-2">
          <label className={LABEL}>
            Perintah yang dijalankan
            <textarea className={`${FIELD} min-h-[80px]`} data-testid="schedules-prompt" value={prompt} placeholder="Ringkas laporan harian proyek ini." onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className={LABEL}>
              Cron (menit jam tanggal bulan hari)
              <input className={FIELD} data-testid="schedules-cron" value={cron} placeholder={CRON_CONTOH} onChange={(event) => setCron(event.target.value)} />
            </label>
            <label className={LABEL}>
              Zona waktu
              <select className={FIELD} data-testid="schedules-zona" value={zona} onChange={(event) => setZona(event.target.value)}>
                {(zona && !ZONA_WAKTU.includes(zona) ? [zona, ...ZONA_WAKTU] : ZONA_WAKTU).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className={LABEL}>
              Proyek sasaran
              <select className={FIELD} data-testid="schedules-proyek" value={proyekId} onChange={(event) => setProyekId(event.target.value)}>
                <option value="">proyek pertama akun</option>
                {proyek.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" data-testid="schedules-otonom" checked={otonom} onChange={(event) => setOtonom(event.target.checked)} />
              jalankan otonom (tanpa persetujuan)
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" className={BTN_UTAMA} data-testid="schedules-tambah" disabled={sibuk === 'tambah'} onClick={() => void tambah()}>
              {sibuk === 'tambah' ? 'Menyimpan…' : 'Simpan jadwal'}
            </button>
            <button type="button" className={BTN} onClick={() => void muat()}>Muat ulang</button>
          </div>
        </div>
      </div>

      {!daftarJadwal.length ? <p className="empty-side" data-testid="schedules-kosong">Belum ada jadwal. Buat satu jadwal di atas.</p> : null}

      <ul className="grid gap-2">
        {daftarJadwal.map((item) => (
          <li key={item.id} className={CARD} data-testid={`schedule-${item.id}`} data-enabled={item.enabled ? 'true' : 'false'}>
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-slate-100">{item.cron}</b>
              <span className="text-xs text-slate-400" data-testid={`schedule-cron-${item.id}`}>{item.cronText} · {item.timezone}</span>
              <span className="badge">{item.enabled ? 'aktif' : 'nonaktif'}</span>
              {item.autonomous ? <span className="badge">otonom</span> : <span className="badge">minta persetujuan</span>}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words">{item.prompt}</p>
            <p className="mt-1 text-xs text-slate-400" data-testid={`schedule-next-${item.id}`} data-next={item.nextRunAt ?? ''}>
              Berikutnya {waktu(item.nextRunAt)} · terakhir {waktu(item.lastRunAt)} · proyek {item.projectId ? String(item.projectId).slice(0, 8) : 'bawaan'}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={BTN} data-testid={`schedule-run-${item.id}`} disabled={sibuk === item.id} onClick={() => void jalankanSekarang(item)}>
                Jalankan sekarang
              </button>
              <button type="button" className={BTN} data-testid={`schedule-aktif-${item.id}`} disabled={sibuk === item.id} onClick={() => void ubah(item, { enabled: !item.enabled })}>
                {item.enabled ? 'Matikan' : 'Aktifkan'}
              </button>
              <button
                type="button"
                className={BTN}
                data-testid={`schedule-edit-${item.id}`}
                onClick={() => {
                  if (sunting === item.id) { setSunting(''); return; }
                  setSunting(item.id); setSuntingCron(item.cron); setSuntingZona(item.timezone);
                }}
              >
                Ubah waktu
              </button>
              {konfirmasi === item.id ? (
                <>
                  <button type="button" className={BTN} data-testid={`schedule-hapus-yakin-${item.id}`} disabled={sibuk === item.id} onClick={() => void hapus(item)}>Ya, hapus jadwal ini</button>
                  <button type="button" className={BTN} onClick={() => setKonfirmasi('')}>Batal</button>
                </>
              ) : (
                <button type="button" className={BTN} data-testid={`schedule-hapus-${item.id}`} onClick={() => setKonfirmasi(item.id)}>Hapus</button>
              )}
            </div>
            {sunting === item.id ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className={LABEL}>
                  Cron baru
                  <input className={FIELD} data-testid={`schedule-edit-cron-${item.id}`} value={suntingCron} onChange={(event) => setSuntingCron(event.target.value)} />
                </label>
                <label className={LABEL}>
                  Zona waktu baru
                  <select className={FIELD} data-testid={`schedule-edit-zona-${item.id}`} value={suntingZona} onChange={(event) => setSuntingZona(event.target.value)}>
                    {(ZONA_WAKTU.includes(suntingZona) ? ZONA_WAKTU : [suntingZona, ...ZONA_WAKTU]).map((zonaItem) => <option key={zonaItem} value={zonaItem}>{zonaItem}</option>)}
                  </select>
                </label>
                <button type="button" className={BTN_UTAMA} data-testid={`schedule-edit-simpan-${item.id}`} disabled={sibuk === item.id} onClick={() => void ubah(item, { cron: suntingCron.trim(), timezone: suntingZona })}>
                  Simpan perubahan
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

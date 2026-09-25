import { useCallback, useEffect, useState } from 'react';
import { api, type CouncilRunDetail, type CouncilRunRow, type CouncilEstimateResponse } from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, TABEL, SEL, angka, daftar, durasi, pesanGalat, usd, waktu } from './w11b';

/** Benih materi dari tombol "Minta penilaian dewan" pada jawaban run (butir 58). */
export type CouncilSeed = { material: string; question?: string };

type Props = {
  projectId?: string | null;
  seed?: CouncilSeed | null;
  onError?: (message: string) => void;
};

/** Pertanyaan bawaan: dipakai bila tombol di Riwayat run tidak mengirim pertanyaan sendiri. */
const PERTANYAAN_BAWAAN = 'Apakah jawaban ini layak dipakai? Sebutkan risiko terbesar dan perbaikan yang paling penting.';

/**
 * Halaman "Dewan juri" (butir 58).
 *
 * Alurnya sengaja dua langkah: perkiraan biaya DULU (POST /v1/council/estimate), baru menjalankan
 * dewan (POST /v1/council/run). Bila materi atau pertanyaan diubah sesudah memperkirakan, perkiraan
 * dibuang dan pengguna wajib menghitung ulang — angka lama tidak boleh dipakai untuk materi baru.
 * Tiap juri adalah run nyata, jadi proyek yang sedang aktif ikut dikirim.
 */
export function Council({ projectId, seed, onError }: Props) {
  const [material, setMaterial] = useState('');
  const [question, setQuestion] = useState(PERTANYAAN_BAWAAN);
  const [jurors, setJurors] = useState('');
  const [perkiraan, setPerkiraan] = useState<CouncilEstimateResponse | null>(null);
  const [hasil, setHasil] = useState<CouncilRunDetail | null>(null);
  const [riwayat, setRiwayat] = useState<CouncilRunRow[]>([]);
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState('');

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  /** Riwayat dewan terakhir (20 terakhir) diambil sekali saat halaman dibuka. */
  const muatRiwayat = useCallback(async () => {
    try {
      const data = await api.councilRuns();
      setRiwayat(daftar<CouncilRunRow>(data?.runs));
    } catch (error) {
      gagal(pesanGalat(error, 'Riwayat dewan juri gagal dimuat.'));
    }
  }, [gagal]);

  useEffect(() => { void muatRiwayat(); }, [muatRiwayat]);

  // Materi dari tombol di Riwayat run mengisi kolom materi; perkiraan lama dibuang karena materinya baru.
  useEffect(() => {
    if (!seed) return;
    setMaterial(seed.material ?? '');
    if (seed.question) setQuestion(seed.question);
    setPerkiraan(null);
    setHasil(null);
    setPesan('Materi dari jawaban run sudah diisi. Tekan "Hitung dulu" untuk melihat perkiraan biaya.');
  }, [seed]);

  /** Daftar juri dari isian bebas: dipisah koma, kosong berarti pakai juri bawaan server. */
  function daftarJuri(): string[] | undefined {
    const bersih = jurors.split(',').map((item) => item.trim()).filter(Boolean);
    return bersih.length ? bersih : undefined;
  }

  async function hitung(): Promise<void> {
    setSibuk('hitung');
    setGalat('');
    setPesan('');
    try {
      const data = await api.councilEstimate({ material, question, ...(daftarJuri() ? { jurors: daftarJuri() } : {}) });
      setPerkiraan(data);
      setPesan('Perkiraan biaya siap. Periksa angkanya sebelum menjalankan dewan.');
    } catch (error) {
      setPerkiraan(null);
      gagal(pesanGalat(error, 'Perkiraan biaya dewan juri gagal dihitung.'));
    } finally {
      setSibuk('');
    }
  }

  async function jalankan(): Promise<void> {
    setSibuk('jalan');
    setGalat('');
    setPesan('');
    try {
      const mulai = await api.councilRun({
        material, question,
        ...(daftarJuri() ? { jurors: daftarJuri() } : {}),
        ...(projectId ? { projectId } : {}),
      });
      const detail = await api.councilRunDetail(mulai.councilRunId);
      setHasil(detail);
      setPesan(`Dewan juri selesai dengan status ${detail.status}. Biaya nyata ${usd(detail.costMicros)}.`);
      await muatRiwayat();
    } catch (error) {
      gagal(pesanGalat(error, 'Dewan juri gagal dijalankan.'));
    } finally {
      setSibuk('');
    }
  }

  /** Buka satu dewan dari riwayat tanpa menjalankan apa pun. */
  async function buka(id: string): Promise<void> {
    setSibuk(id);
    setGalat('');
    try {
      setHasil(await api.councilRunDetail(id));
    } catch (error) {
      gagal(pesanGalat(error, 'Detail dewan juri gagal dimuat.'));
    } finally {
      setSibuk('');
    }
  }

  const juriHasil = daftar<CouncilRunDetail['verdicts'][number]>(hasil?.verdicts);

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="council">
      <header>
        <h2 className="text-base font-semibold text-slate-100">⚖ Dewan juri</h2>
        <p className="mt-1 text-slate-400">
          Kirim satu materi (jawaban run, kode, atau dokumen) ke beberapa juri model sekaligus. Setiap juri
          menjawab sendiri, memberi skor, dan biayanya dicatat terpisah. Hitung perkiraan biaya dulu sebelum
          menjalankan, karena setiap juri adalah run nyata yang menagih token.
        </p>
      </header>

      <div className={CARD}>
        <div className="grid gap-2">
          <label className={LABEL}>
            Materi yang dinilai (wajib)
            <textarea
              className={`${FIELD} min-h-[140px]`}
              data-testid="council-material"
              value={material}
              placeholder="Tempelkan jawaban run atau kode yang mau dinilai dewan."
              onChange={(event) => { setMaterial(event.target.value); setPerkiraan(null); }}
            />
          </label>
          <label className={LABEL}>
            Pertanyaan untuk dewan (wajib)
            <textarea
              className={`${FIELD} min-h-[70px]`}
              data-testid="council-question"
              value={question}
              placeholder="Apa yang harus dinilai juri?"
              onChange={(event) => { setQuestion(event.target.value); setPerkiraan(null); }}
            />
          </label>
          <label className={LABEL}>
            Juri (opsional, pisahkan koma — kosong berarti juri bawaan mesin)
            <input
              className={FIELD}
              data-testid="council-jurors"
              value={jurors}
              placeholder="model-a, model-b"
              onChange={(event) => { setJurors(event.target.value); setPerkiraan(null); }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN} data-testid="council-estimate-button" disabled={sibuk === 'hitung'} onClick={() => void hitung()}>
              {sibuk === 'hitung' ? 'Menghitung…' : 'Hitung dulu'}
            </button>
            <button
              type="button"
              className={BTN_UTAMA}
              data-testid="council-run-button"
              disabled={!perkiraan || sibuk === 'jalan'}
              title={perkiraan ? 'Jalankan dewan juri' : 'Hitung perkiraan biaya dulu'}
              onClick={() => void jalankan()}
            >
              {sibuk === 'jalan' ? 'Dewan berjalan…' : 'Minta penilaian dewan'}
            </button>
          </div>
          {!perkiraan ? (
            <small data-testid="council-need-estimate">
              Tombol menjalankan dewan mati sampai perkiraan biaya dihitung, supaya tidak ada biaya tak terduga.
            </small>
          ) : null}
        </div>
      </div>

      {galat ? <p className="text-rose-300" data-testid="council-error">{galat}</p> : null}
      {pesan ? <p className="text-emerald-300" data-testid="council-message">{pesan}</p> : null}

      {perkiraan ? (
        <div
          className={CARD}
          data-testid="council-estimate"
          data-micros={perkiraan.perkiraanBiayaMicros}
          data-jurors={perkiraan.jurors.join(',')}
        >
          <b className="text-slate-100">Perkiraan biaya dewan</b>
          <p className="mt-1">
            {perkiraan.jurors.length} juri: {perkiraan.jurors.join(', ')} · perkiraan biaya {usd(perkiraan.perkiraanBiayaMicros)} ±{' '}
            {angka(perkiraan.assumedOutputTokens)} token jawaban per juri · prompt juri {angka(perkiraan.promptChars)} karakter.
          </p>
          <p className="mt-1 text-xs text-slate-400">{perkiraan.catatan}</p>
        </div>
      ) : null}

      {hasil ? (
        <div className={CARD} data-testid="council-result" data-status={hasil.status}>
          <b className="text-slate-100">Hasil dewan {String(hasil.id).slice(0, 8)}</b>
          <p className="mt-1" data-testid="council-summary">{hasil.summary || 'Ringkasan kosong.'}</p>
          <p className="mt-1" data-testid="council-cost" data-estimated={hasil.perkiraanBiayaMicros} data-actual={hasil.costMicros}>
            Perkiraan {usd(hasil.perkiraanBiayaMicros)} · biaya nyata {usd(hasil.costMicros)} · biaya dasar mesin penyedia{' '}
            {usd(hasil.biayaDasarMicros)} · materi {angka(hasil.materialChars)} karakter · selesai {waktu(hasil.finishedAt)}.
          </p>
          <p className="mt-1 text-xs text-slate-400">{hasil.catatan}</p>
          <div className="mt-2 overflow-x-auto">
            <table className={TABEL} data-testid="council-verdicts" data-count={juriHasil.length}>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className={SEL}>Juri</th>
                  <th className={SEL}>Verdict</th>
                  <th className={SEL}>Skor</th>
                  <th className={SEL}>Biaya</th>
                  <th className={SEL}>Galat</th>
                </tr>
              </thead>
              <tbody>
                {juriHasil.map((juri) => (
                  <tr key={juri.id} data-testid={`council-verdict-${juri.id}`}>
                    <td className={SEL}>{juri.juror}</td>
                    <td className={SEL}>{juri.verdict || '(tanpa verdict terstruktur)'}</td>
                    <td className={SEL}>{juri.score === null || juri.score === undefined ? '—' : angka(juri.score)}</td>
                    <td className={SEL}>{usd(juri.costMicros)}</td>
                    <td className={SEL}>{juri.errorCode ? juri.errorCode : 'tidak ada'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {juriHasil.some((juri) => juri.notes) ? (
            <ul className="mt-2 grid gap-1 text-xs text-slate-400">
              {juriHasil.filter((juri) => juri.notes).map((juri) => (
                <li key={`catatan-${juri.id}`}><b className="text-slate-300">{juri.juror}</b>: {juri.notes.slice(0, 240)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className={CARD} data-testid="council-runs" data-count={riwayat.length}>
        <b className="text-slate-100">Dewan terakhir</b>
        {!riwayat.length ? <p className="mt-1 text-slate-400">Belum ada dewan juri di akun ini.</p> : null}
        <ul className="mt-2 grid gap-2">
          {riwayat.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 border-b border-slate-700 pb-1" data-testid={`council-run-${row.id}`}>
              <span className="text-xs text-slate-500">{waktu(row.createdAt)}</span>
              <span className="badge">{row.status}</span>
              <span className="flex-1 truncate" title={row.question}>{row.question}</span>
              <span className="text-xs text-slate-400">{angka(row.verdictCount)} juri jawab · {angka(row.failedCount)} gagal · {usd(row.costMicros)}</span>
              <button type="button" className={BTN} data-testid={`council-buka-${row.id}`} disabled={sibuk === row.id} onClick={() => void buka(row.id)}>
                Buka
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

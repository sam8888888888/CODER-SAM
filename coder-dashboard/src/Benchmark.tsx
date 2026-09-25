import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type BenchmarkEstimateResponse,
  type BenchmarkRunDetail,
  type BenchmarkSummaryRow,
} from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, SEL, TABEL, angka, daftar, durasi, pesanGalat, usd, waktu } from './w11b';

type Props = { onError?: (message: string) => void };

/** Server menolak lebih dari 3 model (config.BENCHMARK_MAX_MODELS). Batas itu disalin di UI. */
const MAKS_MODEL = 3;

/**
 * Halaman "Benchmark model" (butir 61).
 *
 * Dua langkah wajib: pilih model -> "Hitung dulu" (POST /v1/benchmark/estimate) -> jalankan
 * (POST /v1/benchmark/run) dengan angka perkiraan yang tadi dihitung. Server MEMERIKSA angka itu dan
 * menolak dengan ESTIMATE_MISMATCH bila berbeda, jadi angkanya diambil apa adanya dari jawaban server,
 * bukan dihitung ulang di peramban.
 */
export function Benchmark({ onError }: Props) {
  const [katalog, setKatalog] = useState<string[]>([]);
  const [pilihan, setPilihan] = useState<string[]>([]);
  const [isian, setIsian] = useState('');
  const [perkiraan, setPerkiraan] = useState<BenchmarkEstimateResponse | null>(null);
  const [hasil, setHasil] = useState<BenchmarkRunDetail | null>(null);
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState('');

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  useEffect(() => {
    let batal = false;
    void api.models()
      .then((data) => { if (!batal) setKatalog(daftar<{ model: string }>(data?.models).map((row) => String(row.model))); })
      .catch((error) => gagal(pesanGalat(error, 'Daftar model gagal dimuat, jadi nama model bisa diisi manual.')));
    return () => { batal = true; };
  }, [gagal]);

  /** Pilih atau batalkan satu model; lebih dari 3 model ditolak di UI karena server juga menolaknya. */
  function alihkan(nama: string): void {
    setPerkiraan(null);
    setPilihan((current) => {
      if (current.includes(nama)) return current.filter((item) => item !== nama);
      if (current.length >= MAKS_MODEL) { gagal(`Benchmark maksimal ${MAKS_MODEL} model sekali jalan.`); return current; }
      return [...current, nama];
    });
  }

  function tambahManual(): void {
    const nama = isian.trim();
    if (!nama) return;
    if (pilihan.includes(nama)) { gagal('Model itu sudah ada di daftar pilihan.'); return; }
    if (pilihan.length >= MAKS_MODEL) { gagal(`Benchmark maksimal ${MAKS_MODEL} model sekali jalan.`); return; }
    setPilihan((current) => [...current, nama]);
    setIsian('');
    setPerkiraan(null);
  }

  async function hitung(): Promise<void> {
    if (!pilihan.length) { gagal('Pilih dulu minimal satu model.'); return; }
    setSibuk('hitung');
    setGalat('');
    setPesan('');
    try {
      const data = await api.benchmarkEstimate(pilihan);
      setPerkiraan(data);
      setPesan(`Perkiraan siap: ${angka(data.questionCount)} soal x ${pilihan.length} model. Periksa angkanya sebelum menjalankan.`);
    } catch (error) {
      setPerkiraan(null);
      gagal(pesanGalat(error, 'Perkiraan biaya benchmark gagal dihitung.'));
    } finally {
      setSibuk('');
    }
  }

  async function jalankan(): Promise<void> {
    if (!perkiraan) { gagal('Hitung dulu perkiraan biaya sebelum menjalankan benchmark.'); return; }
    setSibuk('jalan');
    setGalat('');
    setPesan('');
    try {
      const mulai = await api.benchmarkRun(perkiraan.models, perkiraan.perkiraanBiayaMicros);
      const detail = await api.benchmarkRunDetail(mulai.benchmarkRunId);
      setHasil(detail);
      setPesan(`Benchmark ${mulai.benchmarkRunId.slice(0, 8)} selesai dengan status ${mulai.status}.`);
    } catch (error) {
      gagal(pesanGalat(error, 'Benchmark gagal dijalankan.'));
    } finally {
      setSibuk('');
    }
  }

  const ringkasan = daftar<BenchmarkSummaryRow>(hasil?.ringkasan?.perModel);
  const baris = daftar<BenchmarkRunDetail['results'][number]>(hasil?.results);

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="benchmark">
      <header>
        <h2 className="text-base font-semibold text-slate-100">◫ Benchmark model</h2>
        <p className="mt-1 text-slate-400">
          Uji sampai {MAKS_MODEL} model pada soal bawaan server, lalu lihat skor kesepakatan, biaya, dan waktu
          tanggap tiap model. Benchmark memanggil mesin sungguhan, jadi biayanya nyata: hitung perkiraan dulu.
        </p>
      </header>

      <div className={CARD}>
        <b className="text-slate-100">1. Pilih model (maksimal {MAKS_MODEL})</b>
        <p className="mt-1 text-xs text-slate-400" data-testid="benchmark-pilih-count" data-count={pilihan.length}>
          {pilihan.length} dari {MAKS_MODEL} model dipilih{pilihan.length ? `: ${pilihan.join(', ')}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {katalog.length ? katalog.map((nama) => (
            <button
              key={nama}
              type="button"
              className={pilihan.includes(nama) ? BTN_UTAMA : BTN}
              data-testid={`benchmark-model-${nama}`}
              onClick={() => alihkan(nama)}
            >
              {pilihan.includes(nama) ? '✓ ' : ''}{nama}
            </button>
          )) : <small>Daftar model belum tersedia; isi nama model secara manual di bawah.</small>}
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className={LABEL}>
            Nama model lain
            <input className={FIELD} data-testid="benchmark-custom-input" value={isian} placeholder="nama-model" onChange={(event) => setIsian(event.target.value)} />
          </label>
          <button type="button" className={BTN} data-testid="benchmark-custom-add" onClick={tambahManual}>Tambahkan</button>
          <button type="button" className={BTN} data-testid="benchmark-clear" onClick={() => { setPilihan([]); setPerkiraan(null); }}>Kosongkan pilihan</button>
        </div>
      </div>

      <div className={CARD}>
        <b className="text-slate-100">2. Hitung dulu, baru jalankan</b>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={BTN} data-testid="benchmark-estimate-button" disabled={sibuk === 'hitung'} onClick={() => void hitung()}>
            {sibuk === 'hitung' ? 'Menghitung…' : 'Hitung dulu'}
          </button>
          <button
            type="button"
            className={BTN_UTAMA}
            data-testid="benchmark-run-button"
            disabled={!perkiraan || sibuk === 'jalan'}
            title={perkiraan ? 'Jalankan benchmark' : 'Hitung perkiraan biaya dulu'}
            onClick={() => void jalankan()}
          >
            {sibuk === 'jalan' ? 'Benchmark berjalan…' : 'Jalankan benchmark'}
          </button>
        </div>
        {!perkiraan ? <small className="mt-2 block" data-testid="benchmark-need-estimate">Tombol jalankan mati sampai perkiraan biaya dihitung.</small> : null}
      </div>

      {galat ? <p className="text-rose-300" data-testid="benchmark-error">{galat}</p> : null}
      {pesan ? <p className="text-emerald-300" data-testid="benchmark-message">{pesan}</p> : null}

      {perkiraan ? (
        <div className={CARD} data-testid="benchmark-estimate" data-micros={perkiraan.perkiraanBiayaMicros} data-questions={perkiraan.questionCount}>
          <b className="text-slate-100">Perkiraan biaya benchmark</b>
          <p className="mt-1">
            {angka(perkiraan.questionCount)} soal × {perkiraan.models.length} model · perkiraan total {usd(perkiraan.perkiraanBiayaMicros)}
          </p>
          <ul className="mt-1 grid gap-1 text-xs text-slate-400">
            {(Array.isArray(perkiraan.perModel) ? perkiraan.perModel : []).map((row) => (
              <li key={row.model} data-testid={`benchmark-estimate-row-${row.model}`}>{row.model}: {usd(row.biayaMicros)}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-slate-400">Soal diambil dari {perkiraan.sumberSoal || 'berkas soal server'}. {perkiraan.catatan}</p>
        </div>
      ) : null}

      {hasil ? (
        <div className={CARD} data-testid="benchmark-result" data-status={hasil.status}>
          <b className="text-slate-100">Hasil benchmark {String(hasil.id).slice(0, 8)}</b>
          <p className="mt-1" data-testid="benchmark-cost" data-estimated={hasil.estimatedCostMicros} data-actual={hasil.costMicros}>
            Perkiraan {usd(hasil.estimatedCostMicros)} · biaya nyata {usd(hasil.costMicros)} · biaya dasar mesin penyedia {usd(hasil.biayaDasarMicros)} ·
            mulai {waktu(hasil.createdAt)} · selesai {waktu(hasil.finishedAt)}
          </p>
          <p className="mt-1 text-xs text-slate-400">{hasil.catatan}</p>

          <div className="mt-2 overflow-x-auto">
            <table className={TABEL} data-testid="benchmark-summary" data-count={ringkasan.length}>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className={SEL}>Model</th><th className={SEL}>Dijawab</th><th className={SEL}>Gagal</th>
                  <th className={SEL}>Biaya</th><th className={SEL}>Rata waktu</th>
                </tr>
              </thead>
              <tbody>
                {ringkasan.map((row) => (
                  <tr key={row.model} data-testid={`benchmark-summary-${row.model}`}>
                    <td className={SEL}>{row.model}</td>
                    <td className={SEL}>{angka(row.dijawab)}</td>
                    <td className={SEL}>{angka(row.gagal)}</td>
                    <td className={SEL}>{usd(row.biayaMicros)}</td>
                    <td className={SEL}>{row.rataLatencyMs === null ? '—' : durasi(row.rataLatencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 overflow-x-auto" style={{ maxHeight: 320 }}>
            <table className={TABEL} data-testid="benchmark-results" data-count={baris.length}>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className={SEL}>Model</th><th className={SEL}>Soal</th><th className={SEL}>Skor</th>
                  <th className={SEL}>Biaya</th><th className={SEL}>Waktu</th><th className={SEL}>Galat</th>
                </tr>
              </thead>
              <tbody>
                {baris.map((row) => (
                  <tr key={row.id} data-testid={`benchmark-result-${row.id}`}>
                    <td className={SEL}>{row.model}</td>
                    <td className={SEL} title={row.question}>{String(row.question).slice(0, 70)}</td>
                    <td className={SEL}>{row.score === null || row.score === undefined ? '—' : angka(row.score)}</td>
                    <td className={SEL}>{usd(row.costMicros)}</td>
                    <td className={SEL}>{durasi(row.latencyMs)}</td>
                    <td className={SEL}>{row.errorCode ? row.errorCode : 'tidak ada'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

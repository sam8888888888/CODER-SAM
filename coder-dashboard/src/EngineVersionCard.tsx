import { useCallback, useEffect, useState } from 'react';
import { api, failureOf, VERSI_TIDAK_DILAPORKAN } from './api';
import type { EngineVersionReport } from './api';

/** Kartu versi mesin (Wave 11C butir 78 tahap 1). Hanya admin platform; server menolak selainnya. */

/** Kelas Tailwind yang sudah dipakai halaman Status. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';

/** Baris label+nilai kecil, sama seperti kartu lain di halaman Status. */
function Baris({ label, nilai }: { label: string; nilai: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-400">{label}</span>
      <span className="text-right text-slate-100">{nilai}</span>
    </div>
  );
}

/** Waktu ISO menjadi teks Indonesia; nilai kosong ditulis apa adanya. */
function waktuText(value: string | null | undefined): string {
  if (!value) return 'tidak dilaporkan';
  const tanggal = new Date(value);
  return Number.isNaN(tanggal.getTime()) ? String(value) : tanggal.toLocaleString('id-ID');
}

export function EngineVersionCard({ isAdmin, onError }: { isAdmin?: boolean; onError?: (message: string) => void }) {
  const [laporan, setLaporan] = useState<EngineVersionReport | null>(null);
  const [sibuk, setSibuk] = useState(false);
  const [galat, setGalat] = useState('');

  /** Ambil laporan versi mesin dari server. Nilai ditampilkan apa adanya, tanpa karangan. */
  const muat = useCallback(async (): Promise<void> => {
    setSibuk(true);
    setGalat('');
    try {
      const jawaban = await api.engineVersion();
      setLaporan(jawaban);
    } catch (error) {
      const detail = failureOf(error);
      setLaporan(null);
      const pesan = `${detail.message || detail.code} [${detail.code}]`;
      setGalat(pesan);
      onError?.(pesan);
    } finally {
      setSibuk(false);
    }
  }, [onError]);

  useEffect(() => {
    if (!isAdmin) return;
    void muat();
  }, [isAdmin, muat]);

  // Kartu ini hanya untuk admin platform; rute servernya juga admin saja.
  if (!isAdmin) return null;

  const mentah = (laporan?.engineVersion ?? '').trim();
  const dilaporkan = mentah.length > 0 && mentah !== VERSI_TIDAK_DILAPORKAN;
  const nilaiVersi = dilaporkan ? mentah : VERSI_TIDAK_DILAPORKAN;

  return (
    <section className={CARD} data-testid="engine-version"
      data-version={laporan ? nilaiVersi : ''}
      data-version-mentah={mentah}
      data-dilaporkan={dilaporkan ? 'true' : 'false'}
      data-platform={laporan?.platformVersion ?? ''}
      data-mesin-tersedia={laporan ? String(laporan.engineAvailable) : ''}
      data-tahap2={laporan?.tahap2?.tersedia === true ? 'tersedia' : 'belum-tersedia'}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">Versi mesin</p>
        <button type="button" className={BTN} data-testid="engine-version-muat" disabled={sibuk} onClick={() => { void muat(); }}>
          {sibuk ? 'Memuat…' : 'Muat ulang versi mesin'}
        </button>
      </div>

      {galat ? <p className="text-slate-100" role="alert" data-testid="engine-version-galat">{galat}</p> : null}

      {laporan ? (
        <div className="space-y-1">
          <Baris label="Versi mesin" nilai={nilaiVersi} />
          <p className="sr-only" data-testid="engine-version-nilai">{nilaiVersi}</p>
          <Baris label="Versi platform" nilai={laporan.platformVersion || 'tidak dilaporkan'} />
          <Baris label="Mulai berjalan" nilai={waktuText(laporan.startedAt)} />
          <Baris label="Diperiksa" nilai={waktuText(laporan.checkedAt)} />
          <Baris label="Mesin tersedia" nilai={laporan.engineAvailable ? 'ya' : 'tidak'} />
          <Baris label="Asal versi" nilai={laporan.engineVersionSource || 'tidak dilaporkan'} />
          <Baris label="Jenis mesin" nilai={laporan.engineKind || 'tidak dilaporkan'} />
          <Baris label="Versi skema" nilai={String(laporan.schemaVersion ?? 'tidak dilaporkan')} />
          <Baris label="Berkas mesin"
            nilai={laporan.engineBinary
              ? `${laporan.engineBinary.present ? 'ada' : 'tidak ada'} · ${laporan.engineBinary.path || '(tanpa jalur)'}${laporan.engineBinary.version ? ` · ${laporan.engineBinary.version}` : ''}`
              : 'tidak dilaporkan'} />
          {laporan.engineBinary?.detail ? (
            <p className="text-xs text-slate-400" data-testid="engine-version-biner-detail">{laporan.engineBinary.detail}</p>
          ) : null}
          {laporan.healthError ? (
            <p className="text-slate-100" data-testid="engine-version-kesehatan">Galat kesehatan mesin: {laporan.healthError}</p>
          ) : null}
          <p className="text-xs text-slate-400" data-testid="engine-version-catatan">
            {laporan.catatan || 'Server tidak mengirim catatan.'}
          </p>
        </div>
      ) : null}

      {/* Tahap 2 (perbarui/pulihkan versi mesin) memang belum ada: keputusan Bapak menundanya. */}
      <p className="mt-2 text-xs text-slate-400" data-testid="engine-version-tahap2">
        Tombol "Perbarui versi mesin" dan "Pulihkan versi sebelumnya" (tahap 2) belum ada di server.
        {laporan?.tahap2?.tersedia ? ` Server menyatakan tersedia: ${laporan.tahap2.catatan ?? ''}` : ' Kartu ini hanya melaporkan keadaan mesin yang sedang berjalan.'}
      </p>
    </section>
  );
}

export default EngineVersionCard;

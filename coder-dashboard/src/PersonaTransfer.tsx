import { useCallback, useRef, useState } from 'react';
import { api, type PersonaImportResponse } from './api';
import { BTN, BTN_UTAMA, CARD, LABEL, angka, pesanGalat } from './w11b';

type Props = {
  onError?: (message: string) => void;
  /** Dipanggil sesudah impor berhasil supaya daftar persona di halaman induk ikut disegarkan. */
  onDone?: () => void;
};

/**
 * Kartu "Ekspor / Impor persona" (butir 64) — dipasang di halaman Persona.
 *
 * Ekspor memakai tautan unduh server (GET /v1/personas/export) supaya berkasnya asli dari server,
 * bukan rakitan peramban. Impor membaca satu berkas JSON pilihan pengguna dan mengirim isinya apa
 * adanya; server yang memutuskan mana yang masuk dan mana yang dilewati (mis. nama kembar), lalu
 * jumlah "ditambahkan" dan "dilewati" ditampilkan sebagai hasil, bukan sebagai klaim halaman.
 */
export function PersonaTransfer({ onError, onDone }: Props) {
  const [hasil, setHasil] = useState<PersonaImportResponse | null>(null);
  const [galat, setGalat] = useState('');
  const [nama, setNama] = useState('');
  const [sibuk, setSibuk] = useState(false);
  const [jumlahBerkas, setJumlahBerkas] = useState(0);
  const masukan = useRef<HTMLInputElement | null>(null);

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  /** Baca satu berkas JSON di peramban, lalu kirim isinya ke server. */
  async function impor(): Promise<void> {
    const berkas = masukan.current?.files?.[0];
    if (!berkas) { gagal('Pilih dulu berkas JSON persona yang mau diimpor.'); return; }
    setSibuk(true);
    setGalat('');
    setHasil(null);
    try {
      const teks = await berkas.text();
      const isi = JSON.parse(teks);
      const personas = Array.isArray(isi) ? isi : isi?.personas;
      if (!Array.isArray(personas)) { throw new Error('Berkas tidak memuat daftar persona.'); }
      const data = await api.importPersonas(personas);
      setHasil(data);
      // Daftar persona di halaman induk hanya disegarkan bila ada yang benar-benar masuk.
      if (data.added > 0) onDone?.();
    } catch (error) {
      gagal(error instanceof SyntaxError
        ? 'Berkas itu bukan JSON yang sah, jadi tidak ada persona yang diimpor.'
        : pesanGalat(error, 'Impor persona gagal.'));
    } finally {
      setSibuk(false);
    }
  }

  return (
    <section className={`${CARD} mt-3 space-y-2 text-sm text-slate-300`} data-testid="persona-transfer" data-added={hasil?.added ?? ''}>
      <b className="text-slate-100">⇅ Ekspor / impor persona</b>
      <p className="text-xs text-slate-400">
        Ekspor menyimpan semua persona Anda ke satu berkas JSON. Impor menambahkan persona dari berkas
        tersebut; persona dengan nama yang sudah ada akan dilewati, bukan ditimpa.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <a className={BTN} data-testid="persona-export" href={api.personaExportUrl()} download>
          Ekspor semua persona (JSON)
        </a>
        <label className={LABEL}>
          Berkas JSON persona
          <input
            ref={masukan}
            type="file"
            accept="application/json,.json"
            className={BTN}
            data-testid="persona-import-input"
            onChange={(event) => { setJumlahBerkas(event.target.files?.length ?? 0); setNama(event.target.files?.[0]?.name ?? ''); }}
          />
        </label>
        <button type="button" className={BTN_UTAMA} data-testid="persona-import" disabled={sibuk} onClick={() => void impor()}>
          {sibuk ? 'Mengimpor…' : 'Impor dari berkas'}
        </button>
        {nama ? <span className="text-xs text-slate-400" data-testid="persona-berkas" data-count={jumlahBerkas}>{nama}</span> : null}
      </div>
      {galat ? <p className="text-rose-300" data-testid="persona-transfer-error">{galat}</p> : null}
      {hasil ? (
        <div data-testid="persona-transfer-hasil" data-added={hasil.added} data-skipped={hasil.skipped.length}>
          <p className="text-emerald-300">
            {angka(hasil.added)} persona ditambahkan, {angka(hasil.skipped.length)} dilewati (nama sudah ada), total{' '}
            {angka(hasil.total)} persona.
          </p>
          {hasil.skipped.length ? (
            <p className="text-xs text-slate-400" data-testid="persona-transfer-dilewati">Dilewati: {hasil.skipped.join(', ')}</p>
          ) : null}
          <p className="text-xs text-slate-400">{hasil.catatan}</p>
        </div>
      ) : null}
    </section>
  );
}

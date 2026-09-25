import { useCallback, useEffect, useState } from 'react';
import { api, type AdminErrorsResponse, type ErrorEventRow } from './api';
import { BTN, CARD, FIELD, LABEL, SEL, TABEL, angka, daftar, pesanGalat, waktu } from './w11b';

type Props = { isAdmin: boolean; onError?: (message: string) => void };

/** Jenis galat yang dikenal server (kind kolom error_events). */
const JENIS = ['server', 'engine', 'ui'];

/**
 * Halaman "Laporan galat" (butir 66) — khusus admin platform.
 *
 * Daftar galat diambil dari GET /v1/admin/errors dan bisa disaring per jenis dan tanggal. Tombol
 * "Unduh CSV" memakai tautan unduh (/v1/admin/errors/export.csv) supaya berkas besar tidak perlu
 * disusun di peramban. Isi galat sudah disaring server (rahasia diganti [disunting]) sebelum disimpan,
 * jadi halaman ini tidak menyaring apa pun lagi.
 */
export function AdminErrorReports({ isAdmin, onError }: Props) {
  const [data, setData] = useState<AdminErrorsResponse | null>(null);
  const [kind, setKind] = useState('');
  const [dari, setDari] = useState('');
  const [sampai, setSampai] = useState('');
  const [galat, setGalat] = useState('');
  const [memuat, setMemuat] = useState(false);

  const muat = useCallback(async () => {
    if (!isAdmin) return;
    setMemuat(true);
    setGalat('');
    try {
      setData(await api.adminErrors({
        ...(kind ? { kind } : {}),
        ...(dari ? { from: dari } : {}),
        ...(sampai ? { to: sampai } : {}),
        limit: 100,
      }));
    } catch (error) {
      const teks = pesanGalat(error, 'Laporan galat gagal dimuat.');
      setGalat(teks);
      onError?.(teks);
    } finally {
      setMemuat(false);
    }
  }, [isAdmin, kind, dari, sampai, onError]);

  useEffect(() => { void muat(); }, [muat]);

  const baris = daftar<ErrorEventRow>(data?.rows);

  if (!isAdmin) {
    return (
      <section className="space-y-2 text-sm text-slate-300" data-testid="admin-errors">
        <h2 className="text-base font-semibold text-slate-100">⚠ Laporan galat</h2>
        <p data-testid="admin-errors-bukan-admin">Hanya admin platform yang dapat membuka halaman ini.</p>
      </section>
    );
  }

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="admin-errors" data-count={baris.length}>
      <header>
        <h2 className="text-base font-semibold text-slate-100">⚠ Laporan galat</h2>
        <p className="mt-1 text-slate-400">
          Galat server yang tercatat pada platform. Isi pesan sudah disaring server: token, kunci, dan sandi
          diganti [disunting] sebelum disimpan, jadi baris di sini aman dibaca.
        </p>
      </header>

      <div className={`${CARD} flex flex-wrap items-end gap-2`}>
        <label className={LABEL}>
          Jenis
          <select className={FIELD} data-testid="admin-errors-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">semua jenis</option>
            {JENIS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className={LABEL}>
          Dari tanggal
          <input type="date" className={FIELD} data-testid="admin-errors-dari" value={dari} onChange={(event) => setDari(event.target.value)} />
        </label>
        <label className={LABEL}>
          Sampai tanggal
          <input type="date" className={FIELD} data-testid="admin-errors-sampai" value={sampai} onChange={(event) => setSampai(event.target.value)} />
        </label>
        <button type="button" className={BTN} data-testid="admin-errors-muat" disabled={memuat} onClick={() => void muat()}>
          {memuat ? 'Memuat…' : 'Terapkan saringan'}
        </button>
        <a className={BTN} data-testid="admin-errors-csv" href={api.adminErrorsCsvUrl({ ...(kind ? { kind } : {}), ...(dari ? { from: dari } : {}), ...(sampai ? { to: sampai } : {}) })} download>
          Unduh CSV
        </a>
      </div>

      {galat ? <p className="text-rose-300" data-testid="admin-errors-error">{galat}</p> : null}

      {data ? (
        <p data-testid="admin-errors-total">
          {angka(baris.length)} dari {angka(data.total)} galat ditampilkan. {data.catatan}
        </p>
      ) : null}

      {data && !baris.length ? <p className="empty-side" data-testid="admin-errors-kosong">Tidak ada galat pada saringan ini.</p> : null}

      {baris.length ? (
        <div className={`${CARD} overflow-x-auto`}>
          <table className={TABEL} data-testid="admin-errors-daftar" data-count={baris.length}>
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                <th className={SEL}>Waktu</th><th className={SEL}>Jenis</th><th className={SEL}>Kode</th>
                <th className={SEL}>Pesan</th><th className={SEL}>Run</th>
              </tr>
            </thead>
            <tbody>
              {baris.map((row) => (
                <tr key={row.id} data-testid={`admin-errors-baris-${row.id}`}>
                  <td className={SEL}>{waktu(row.createdAt)}</td>
                  <td className={SEL}>{row.kind}</td>
                  <td className={SEL}>{row.code || '—'}</td>
                  <td className={SEL}>{row.message}</td>
                  <td className={SEL}>{row.runId ? String(row.runId).slice(0, 8) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

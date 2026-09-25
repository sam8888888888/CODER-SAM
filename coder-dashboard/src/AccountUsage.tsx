import { useCallback, useEffect, useState } from 'react';
import { api, type AccountUsageResponse, type UsageBreakdownRow } from './api';
import { BTN, CARD, SEL, TABEL, angka, daftar, pesanGalat, usd } from './w11b';

type Props = { onError?: (message: string) => void };

/** Rentang yang boleh diminta server (pola seperti 7d, 30d, 90d). */
const RENTANG = ['7d', '30d', '90d'];

/**
 * Halaman "Pemakaian saya" (butir 65).
 *
 * Menampilkan token dan biaya milik pengguna sendiri untuk proyek di ruang kerja tempat ia menjadi
 * anggota, termasuk baris yang belum punya harga jual (biayaTidakTertagihMicros) dan selisih
 * rekonsiliasi antara biaya mesin dan harga jual. Angka diambil apa adanya dari server.
 */
export function AccountUsage({ onError }: Props) {
  const [period, setPeriod] = useState('30d');
  const [data, setData] = useState<AccountUsageResponse | null>(null);
  const [galat, setGalat] = useState('');
  const [memuat, setMemuat] = useState(false);

  const muat = useCallback(async (rentang: string) => {
    setMemuat(true);
    setGalat('');
    try {
      setData(await api.accountUsage(rentang));
    } catch (error) {
      const teks = pesanGalat(error, 'Pemakaian akun gagal dimuat.');
      setGalat(teks);
      onError?.(teks);
    } finally {
      setMemuat(false);
    }
  }, [onError]);

  useEffect(() => { void muat(period); }, [muat, period]);

  const perHari = daftar<UsageBreakdownRow>(data?.perHari);
  const perModel = daftar<UsageBreakdownRow>(data?.perModel);

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="usage" data-period={data?.period ?? period}>
      <header className="flex flex-wrap items-end gap-2">
        <div className="flex-1">
          <h2 className="text-base font-semibold text-slate-100">∑ Pemakaian saya</h2>
          <p className="mt-1 text-slate-400">
            Token dan biaya milik akun Anda sendiri. Satuan biaya mikrodolar (1.000.000 = 1 dolar).
          </p>
        </div>
        <div className="flex gap-2">
          {RENTANG.map((rentang) => (
            <button
              key={rentang}
              type="button"
              className={period === rentang ? 'primary' : BTN}
              data-testid={`usage-rentang-${rentang}`}
              onClick={() => setPeriod(rentang)}
            >
              {rentang}
            </button>
          ))}
          <button type="button" className={BTN} data-testid="usage-refresh" disabled={memuat} onClick={() => void muat(period)}>
            {memuat ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>
      </header>

      {galat ? <p className="text-rose-300" data-testid="usage-error">{galat}</p> : null}

      {data ? (
        <>
          <div className={CARD} data-testid="usage-ringkasan" data-token={data.tokenTotal} data-total-micros={data.totalMicros}>
            <b className="text-slate-100">Ringkasan {angka(data.days)} hari terakhir</b>
            <p className="mt-1" data-testid="usage-tokens">
              Token masuk {angka(data.tokenInput)} · token keluar {angka(data.tokenOutput)} · total{' '}
              <b className="text-slate-100">{angka(data.tokenTotal)}</b> token
            </p>
            <p className="mt-1" data-testid="usage-biaya" data-billed={data.biayaTerbillingMicros} data-unbilled={data.biayaTidakTertagihMicros}>
              Ditagihkan {usd(data.biayaTerbillingMicros)} · tidak tertagih (belum ada harga jual) {usd(data.biayaTidakTertagihMicros)} ·
              total {usd(data.totalMicros)}
            </p>
            <p className="mt-1 text-xs text-slate-400">Sejak {data.sejak}.</p>
          </div>

          <div className={CARD} data-testid="usage-rekonsiliasi" data-selisih={data.rekonsiliasi?.selisihMicros ?? 0} data-run={data.rekonsiliasi?.jumlahRun ?? 0}>
            <b className="text-slate-100">Rekonsiliasi</b>
            <p className="mt-1">
              Selisih biaya mesin dan harga jual {usd(data.rekonsiliasi?.selisihMicros ?? 0)} pada {angka(data.rekonsiliasi?.jumlahRun ?? 0)} run.
            </p>
            <p className="mt-1 text-xs text-slate-400">{data.rekonsiliasi?.catatan}</p>
          </div>

          <div className={`${CARD} overflow-x-auto`}>
            <b className="text-slate-100">Per hari</b>
            {!perHari.length ? <p className="mt-1 text-slate-400">Belum ada pemakaian pada rentang ini.</p> : null}
            <table className={TABEL} data-testid="usage-perhari" data-count={perHari.length}>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className={SEL}>Tanggal</th><th className={SEL}>Token masuk</th><th className={SEL}>Token keluar</th>
                  <th className={SEL}>Total token</th><th className={SEL}>Ditagihkan</th><th className={SEL}>Tidak tertagih</th>
                </tr>
              </thead>
              <tbody>
                {perHari.map((row) => (
                  <tr key={String(row.tanggal)} data-testid={`usage-hari-${row.tanggal}`}>
                    <td className={SEL}>{row.tanggal}</td>
                    <td className={SEL}>{angka(row.tokenInput)}</td>
                    <td className={SEL}>{angka(row.tokenOutput)}</td>
                    <td className={SEL}>{angka(row.tokenTotal)}</td>
                    <td className={SEL}>{usd(row.biayaTerbillingMicros)}</td>
                    <td className={SEL}>{usd(row.biayaTidakTertagihMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`${CARD} overflow-x-auto`}>
            <b className="text-slate-100">Per model</b>
            {!perModel.length ? <p className="mt-1 text-slate-400">Belum ada pemakaian per model pada rentang ini.</p> : null}
            <table className={TABEL} data-testid="usage-permodel" data-count={perModel.length}>
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className={SEL}>Model</th><th className={SEL}>Total token</th><th className={SEL}>Ditagihkan</th><th className={SEL}>Tidak tertagih</th>
                </tr>
              </thead>
              <tbody>
                {perModel.map((row) => (
                  <tr key={String(row.model)} data-testid={`usage-model-${row.model}`}>
                    <td className={SEL}>{row.model}</td>
                    <td className={SEL}>{angka(row.tokenTotal)}</td>
                    <td className={SEL}>{usd(row.biayaTerbillingMicros)}</td>
                    <td className={SEL}>{usd(row.biayaTidakTertagihMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.catatan ? <p className="text-xs text-slate-400" data-testid="usage-catatan">{data.catatan}</p> : null}
        </>
      ) : null}
    </section>
  );
}

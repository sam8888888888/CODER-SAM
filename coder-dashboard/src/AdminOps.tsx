import { useCallback, useEffect, useState } from 'react';
import { api, type ShadowModeResponse, type TokenAccountingResponse } from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, SEL, TABEL, angka, bulanBerjalan, daftar, pesanGalat, waktu } from './w11b';

type Props = { isAdmin: boolean; onError?: (message: string) => void };

/**
 * Tab "Operasional admin" berisi dua kartu:
 *  - butir 59: mode bayangan (hanya mengukur; jawaban pengguna tidak berubah).
 *  - butir 67: pembukuan token bulanan (saldo, terpakai, sisa, proyeksi) + pemakaian per pengguna.
 *
 * Kedua kartu ini menembak rute admin, jadi pengguna bukan admin melihat kalimat penolakan, bukan
 * layar rusak. Kartu mode bayangan TIDAK mengubah apa pun sebelum tombol ditekan.
 */
export function AdminOps({ isAdmin, onError }: Props) {
  const [mode, setMode] = useState<ShadowModeResponse | null>(null);
  const [pembukuan, setPembukuan] = useState<TokenAccountingResponse | null>(null);
  const [bulan, setBulan] = useState(bulanBerjalan());
  const [saldoBaru, setSaldoBaru] = useState('');
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState('');

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  const muat = useCallback(async () => {
    if (!isAdmin) return;
    setGalat('');
    try {
      const [bayangan, token] = await Promise.all([api.shadowMode(), api.tokenAccounting(bulan)]);
      setMode(bayangan);
      setPembukuan(token);
      setSaldoBaru(String(token.saldo ?? ''));
    } catch (error) {
      gagal(pesanGalat(error, 'Data operasional admin gagal dimuat.'));
    }
  }, [isAdmin, bulan, gagal]);

  useEffect(() => { void muat(); }, [muat]);

  async function alihkanMode(baru: 'on' | 'off'): Promise<void> {
    setSibuk('mode');
    setPesan('');
    try {
      const hasil = await api.setShadowMode(baru);
      setPesan(`${hasil.catatan} Berlaku pada run berikutnya, bukan pada run yang sudah berjalan.`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Mode bayangan gagal diubah.'));
    } finally {
      setSibuk('');
    }
  }

  async function simpanSaldo(): Promise<void> {
    const nilai = Number(saldoBaru);
    if (!Number.isFinite(nilai) || nilai < 0) { gagal('Saldo token bulanan harus berupa angka 0 atau lebih.'); return; }
    setSibuk('saldo');
    setPesan('');
    try {
      const hasil = await api.setTokenBudget(bulan, Math.floor(nilai), 'disetel dari halaman Admin');
      setPesan(`Saldo token ${hasil.month} disetel ke ${angka(hasil.saldo)} token.`);
      await muat();
    } catch (error) {
      gagal(pesanGalat(error, 'Saldo token bulanan gagal disimpan.'));
    } finally {
      setSibuk('');
    }
  }

  if (!isAdmin) {
    return (
      <section className="space-y-2 text-sm text-slate-300" data-testid="admin-ops">
        <h2 className="text-base font-semibold text-slate-100">⚙ Operasional platform</h2>
        <p data-testid="admin-ops-bukan-admin">Hanya admin platform yang dapat membuka halaman ini.</p>
      </section>
    );
  }

  const perPengguna = daftar<TokenAccountingResponse['perPengguna'][number]>(pembukuan?.perPengguna);

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="admin-ops">
      {galat ? <p className="text-rose-300" data-testid="admin-ops-error">{galat}</p> : null}
      {pesan ? <p className="text-emerald-300" data-testid="admin-ops-message">{pesan}</p> : null}

      {/* Butir 59: mode bayangan */}
      <div className={CARD} data-testid="shadow-card" data-mode={mode?.mode ?? ''} data-total={mode?.total ?? ''}>
        <b className="text-slate-100">☾ Mode bayangan</b>
        <p className="mt-1">
          Mode saat ini: <b className="text-slate-100">{mode?.mode === 'on' ? 'AKTIF (mengukur saja)' : 'mati'}</b> ·{' '}
          {angka(mode?.total ?? 0)} baris pengukuran · jenis terukur: {daftar<string>(mode?.kinds).join(', ') || '(belum ada)'} ·
          diperbarui {waktu(mode?.updatedAt)}.
        </p>
        <p className="mt-1 text-xs text-slate-400">{mode?.catatan}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={BTN_UTAMA} data-testid="shadow-on" disabled={sibuk === 'mode' || mode?.mode === 'on'} onClick={() => void alihkanMode('on')}>
            Aktifkan mode bayangan
          </button>
          <button type="button" className={BTN} data-testid="shadow-off" disabled={sibuk === 'mode' || mode?.mode === 'off'} onClick={() => void alihkanMode('off')}>
            Matikan mode bayangan
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400" data-testid="shadow-note">
          Perubahan mode hanya berlaku pada run BERIKUTNYA. Run yang sedang berjalan tetap memakai mode lama, dan
          mode bayangan tidak pernah mengubah jawaban yang dilihat pengguna.
        </p>
      </div>

      {/* Butir 67: pembukuan token */}
      <div className={CARD} data-testid="token-card" data-saldo={pembukuan?.saldo ?? ''} data-terpakai={pembukuan?.terpakai ?? ''}>
        <b className="text-slate-100">◔ Pembukuan token bulanan</b>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className={LABEL}>
            Bulan (YYYY-MM)
            <input className={FIELD} data-testid="token-bulan" value={bulan} onChange={(event) => setBulan(event.target.value.trim())} />
          </label>
          <label className={LABEL}>
            Saldo bulanan (token)
            <input className={FIELD} data-testid="token-saldo" value={saldoBaru} inputMode="numeric" onChange={(event) => setSaldoBaru(event.target.value)} />
          </label>
          <button type="button" className={BTN_UTAMA} data-testid="token-simpan" disabled={sibuk === 'saldo'} onClick={() => void simpanSaldo()}>
            {sibuk === 'saldo' ? 'Menyimpan…' : 'Setel saldo bulanan'}
          </button>
          <button type="button" className={BTN} onClick={() => void muat()}>Muat ulang</button>
        </div>
        {pembukuan ? (
          <>
            <p className="mt-2" data-testid="token-ringkasan" data-proyeksi={pembukuan.proyeksi ?? ''}>
              {pembukuan.month}: saldo {angka(pembukuan.saldo)} · terpakai {angka(pembukuan.terpakai)} · sisa {angka(pembukuan.sisa)} token ·
              proyeksi akhir bulan {angka(pembukuan.proyeksi)} token · hari ke-{angka(pembukuan.daysElapsed)} dari {angka(pembukuan.daysInMonth)}
            </p>
            {pembukuan.peringatan ? <p className="text-amber-300" data-testid="token-peringatan">{pembukuan.peringatan}</p> : null}
            <p className="mt-1 text-xs text-slate-400" data-testid="token-catatan">{pembukuan.catatan}</p>
            <div className="mt-2 overflow-x-auto">
              <table className={TABEL} data-testid="token-perpengguna" data-count={perPengguna.length}>
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className={SEL}>Pengguna</th><th className={SEL}>Token bulan ini</th>
                  </tr>
                </thead>
                <tbody>
                  {perPengguna.map((row) => (
                    <tr key={row.userId} data-testid={`token-pengguna-${row.userId}`}>
                      <td className={SEL}>{row.email || String(row.userId).slice(0, 8)}</td>
                      <td className={SEL}>{angka(row.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Angka di kartu ini membandingkan saldo bulanan dengan pemakaian nyata dari catatan mesin. Proyeksi
              dihitung dari hari yang sudah berjalan, jadi hasilnya bisa berubah besok.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

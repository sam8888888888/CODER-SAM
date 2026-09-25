import { useCallback, useEffect, useState } from 'react';
import { api, type AccountAuditEvent, type AccountAuditResponse } from './api';
import { BTN, CARD, SEL, TABEL, angka, daftar, pesanGalat, waktu } from './w11b';

type Props = { onError?: (message: string) => void };

/** Pilihan rentang hari yang boleh diminta server (1 sampai 365). */
const RENTANG = [7, 30, 90];

/**
 * Halaman "Aktivitas saya" (butir 65).
 *
 * Berisi jejak aksi akun sendiri (audit_events dengan actor_user_id milik pengguna ini) pada rentang
 * hari tertentu. Baris milik pengguna lain tidak pernah ikut, dan server memotong jumlah baris bila
 * terlalu banyak — pemotongan itu ditulis di catatan.
 */
export function AccountActivity({ onError }: Props) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<AccountAuditResponse | null>(null);
  const [galat, setGalat] = useState('');
  const [memuat, setMemuat] = useState(false);

  const muat = useCallback(async (rentang: number) => {
    setMemuat(true);
    setGalat('');
    try {
      setData(await api.accountAudit(rentang));
    } catch (error) {
      const teks = pesanGalat(error, 'Aktivitas akun gagal dimuat.');
      setGalat(teks);
      onError?.(teks);
    } finally {
      setMemuat(false);
    }
  }, [onError]);

  useEffect(() => { void muat(days); }, [muat, days]);

  const kejadian = daftar<AccountAuditEvent>(data?.events);

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="activity" data-days={data?.days ?? days} data-count={kejadian.length}>
      <header className="flex flex-wrap items-end gap-2">
        <div className="flex-1">
          <h2 className="text-base font-semibold text-slate-100">≡ Aktivitas saya</h2>
          <p className="mt-1 text-slate-400">
            Jejak aksi akun Anda sendiri: masuk, mengubah setelan, menjalankan run, dan seterusnya.
          </p>
        </div>
        <div className="flex gap-2">
          {RENTANG.map((rentang) => (
            <button
              key={rentang}
              type="button"
              className={days === rentang ? 'primary' : BTN}
              data-testid={`activity-hari-${rentang}`}
              onClick={() => setDays(rentang)}
            >
              {rentang} hari
            </button>
          ))}
          <button type="button" className={BTN} data-testid="activity-refresh" disabled={memuat} onClick={() => void muat(days)}>
            {memuat ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>
      </header>

      {galat ? <p className="text-rose-300" data-testid="activity-error">{galat}</p> : null}

      {data ? (
        <p data-testid="activity-ringkasan">
          {angka(kejadian.length)} dari {angka(data.total)} jejak dalam {angka(data.days)} hari terakhir (sejak {data.sejak}).
        </p>
      ) : null}

      {data && !kejadian.length ? <p className="empty-side" data-testid="activity-kosong">Belum ada jejak pada rentang ini.</p> : null}

      {kejadian.length ? (
        <div className={`${CARD} overflow-x-auto`}>
          <table className={TABEL} data-testid="activity-daftar" data-count={kejadian.length}>
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                <th className={SEL}>Waktu</th><th className={SEL}>Aksi</th><th className={SEL}>Rincian</th>
              </tr>
            </thead>
            <tbody>
              {kejadian.map((row) => (
                <tr key={row.id} data-testid={`activity-event-${row.id}`}>
                  <td className={SEL}>{waktu(row.createdAt)}</td>
                  <td className={SEL}>{row.action}</td>
                  <td className={SEL} title={JSON.stringify(row.metadata)}>
                    {Object.keys(row.metadata ?? {}).length ? JSON.stringify(row.metadata).slice(0, 200) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data?.catatan ? <p className="text-xs text-slate-400" data-testid="activity-catatan">{data.catatan}</p> : null}
    </section>
  );
}

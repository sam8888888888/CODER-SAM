import { useCallback, useEffect, useState } from 'react';
import { api, type RunTimelineResponse, type TimelineStep } from './api';
import { BTN, CARD, SEL, TABEL, angka, daftar, pesanGalat, waktu } from './w11b';

type Props = { runId?: string | null; onError?: (message: string) => void };

/**
 * Halaman "Timeline run" (butir 62).
 *
 * Langkah diambil dari catatan server (run_events + baris runs) lewat
 * GET /v1/runs/:runId/timeline. Tidak ada langkah yang disusun sendiri di peramban; kalau server
 * menyebut ada langkah yang tidak bisa dibaca, itu ditampilkan di catatan.
 */
export function RunTimeline({ runId, onError }: Props) {
  const [data, setData] = useState<RunTimelineResponse | null>(null);
  const [galat, setGalat] = useState('');
  const [memuat, setMemuat] = useState(false);

  const muat = useCallback(async () => {
    if (!runId) { setData(null); return; }
    setMemuat(true);
    setGalat('');
    try {
      setData(await api.runTimeline(runId));
    } catch (error) {
      setData(null);
      const teks = pesanGalat(error, 'Timeline run gagal dimuat.');
      setGalat(teks);
      onError?.(teks);
    } finally {
      setMemuat(false);
    }
  }, [runId, onError]);

  useEffect(() => { void muat(); }, [muat]);

  const langkah = daftar<TimelineStep>(data?.langkah);

  return (
    <section className="space-y-3 text-sm text-slate-300" data-testid="timeline" data-run={runId ?? ''} data-count={langkah.length}>
      <header className="flex flex-wrap items-end gap-2">
        <div className="flex-1">
          <h2 className="text-base font-semibold text-slate-100">⟲ Timeline run</h2>
          <p className="mt-1 text-slate-400">
            Urutan kejadian satu run: kapan mulai, langkah apa saja yang dicatat mesin, dan bagaimana
            akhirnya. Halaman ini hanya membaca catatan server.
          </p>
        </div>
        <button type="button" className={BTN} data-testid="timeline-refresh" disabled={!runId || memuat} onClick={() => void muat()}>
          {memuat ? 'Memuat…' : 'Muat ulang'}
        </button>
      </header>

      {!runId ? (
        <p className="empty-side" data-testid="timeline-kosong">
          Belum ada run yang dipilih. Buka Riwayat run, lalu tekan "Timeline" pada salah satu run.
        </p>
      ) : null}

      {galat ? <p className="text-rose-300" data-testid="timeline-error">{galat}</p> : null}

      {data ? (
        <p data-testid="timeline-status" data-status={data.status}>
          Run {String(data.runId).slice(0, 8)} · status akhir <b className="text-slate-100">{data.status}</b> · {angka(data.total)} langkah.
        </p>
      ) : null}

      {langkah.length ? (
        <div className={`${CARD} overflow-x-auto`}>
          <table className={TABEL} data-testid="timeline-langkah" data-count={langkah.length}>
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                <th className={SEL}>#</th><th className={SEL}>Waktu</th><th className={SEL}>Jenis</th>
                <th className={SEL}>Nama</th><th className={SEL}>Ringkasan</th><th className={SEL}>Status</th>
              </tr>
            </thead>
            <tbody>
              {langkah.map((step) => (
                <tr key={step.seq} data-testid={`timeline-step-${step.seq}`} data-kind={step.kind} data-status={step.status}>
                  <td className={SEL}>{step.seq}</td>
                  <td className={SEL}>{waktu(step.at)}</td>
                  <td className={SEL}>{step.kind}</td>
                  <td className={SEL}>{step.name}</td>
                  <td className={SEL}>{step.summary || '—'}</td>
                  <td className={SEL}>{step.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data?.catatan ? <p className="text-xs text-slate-400" data-testid="timeline-catatan">{data.catatan}</p> : null}
    </section>
  );
}

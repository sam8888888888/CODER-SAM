import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type RunSummary } from './api';

/** Nilai status yang dikenal backend. Dipakai untuk pilihan filter dan ringkasan. */
const KNOWN_STATUS = ['completed', 'failed', 'cancelled', 'queued', 'running'];

/** Warna badge per status. Hanya gaya tampilan, tidak mengubah data. */
function statusStyle(status: string): CSSProperties {
  const map: Record<string, { color: string; borderColor: string; background: string }> = {
    completed: { color: '#bbf7d0', borderColor: '#22c55e66', background: '#22c55e1a' },
    failed: { color: '#fecaca', borderColor: '#ef444466', background: '#ef44441a' },
    cancelled: { color: '#fed7aa', borderColor: '#f9731666', background: '#f973161a' },
    queued: { color: '#bfdbfe', borderColor: '#3b82f666', background: '#3b82f61a' },
    running: { color: '#a5f3fc', borderColor: '#22d3ee66', background: '#22d3ee1a' },
  };
  const tone = map[status] ?? { color: '#ddd6fe', borderColor: '#8b5cf655', background: '#8b5cf622' };
  return { color: tone.color, borderColor: tone.borderColor, background: tone.background };
}

/** Waktu lokal Indonesia, aman bila nilai tanggal tidak valid. */
function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('id-ID');
}

/** Lama run = finishedAt - createdAt. Kosong bila run belum selesai. */
function formatDuration(run: RunSummary): string {
  if (!run.finishedAt) return run.status === 'queued' || run.status === 'running' ? 'berjalan…' : '—';
  const start = new Date(run.createdAt).getTime();
  const end = new Date(run.finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const totalSeconds = (end - start) / 1000;
  if (totalSeconds < 1) return `${Math.round(totalSeconds * 1000)} md`;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1).replace('.', ',')} dtk`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes} mnt ${seconds} dtk`;
}

const cell: CSSProperties = { padding: '9px 8px', borderBottom: '1px solid #1e2438', verticalAlign: 'top', fontSize: '12px' };
const number = (value: number) => value.toLocaleString('id-ID');
const usd = (value: number) => `$${(value ?? 0).toFixed(6)}`;

/** Halaman "Riwayat run": 50 run AI terbaru di proyek yang sedang aktif. */
export function Runs({ projectId }: { projectId: string | null }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState('');   // id run yang sedang dihentikan
  const [status, setStatus] = useState('');          // '' = semua status
  const [keyword, setKeyword] = useState('');        // pencarian pada prompt
  const [openId, setOpenId] = useState<string | null>(null); // baris yang sedang dibuka

  /** Ambil daftar run terbaru. Semua galat ditampilkan apa adanya. */
  /** Hentikan run yang masih berjalan, lalu segarkan daftar. Rute backend: POST /api/v1/runs/:runId/cancel. */
  async function cancelRun(runId: string) {
    setCancelling(runId);
    setError('');
    try {
      await api.cancelRun(runId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling('');
    }
  }

  async function load() {
    if (!projectId) { setRuns([]); return; }
    setLoading(true);
    setError('');
    try {
      const data = await api.runs(projectId);
      setRuns(Array.isArray(data?.runs) ? data.runs : []);
    } catch (e) {
      setRuns([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* muat ulang saat proyek aktif berubah */ }, [projectId]);

  // Filter dilakukan di klien: tidak perlu endpoint tambahan.
  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return runs.filter((run) => {
      if (status && run.status !== status) return false;
      if (needle && !String(run.prompt ?? '').toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [runs, status, keyword]);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    let totalCost = 0;
    for (const run of visible) {
      counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
      totalCost += Number(run.costUsd ?? 0);
    }
    // Sertakan status yang muncul di data walau di luar daftar yang dikenal.
    const statuses = Array.from(new Set([...KNOWN_STATUS, ...counts.keys()]));
    return { counts, statuses, totalCost };
  }, [visible]);

  if (!projectId) {
    return <div className="empty-side">Pilih proyek dulu</div>;
  }

  const columns = ['Waktu', 'Status', 'Model', 'Prompt', 'Token masuk', 'Token keluar', 'Biaya (USD)', 'Lama', ''];

  return (
    <section className="tool-card" style={{ margin: '24px auto', padding: 20 }}>
      <span className="eyebrow">RIWAYAT RUN</span>
      <h2 style={{ margin: '10px 0 4px' }}>Riwayat run</h2>
      <p className="section-label" style={{ padding: 0 }}>50 run terbaru di proyek yang Anda pilih. Klik satu baris untuk melihat detailnya.</p>

      {/* Ringkasan daftar yang sedang tampil */}
      <div className="tool-row wrap">
        <div className="stat"><b>{visible.length}</b><small>run tampil</small></div>
        {summary.statuses.map((key) => (
          <div className="stat" key={key}><b>{summary.counts.get(key) ?? 0}</b><small>{key}</small></div>
        ))}
        <div className="stat"><b>{usd(summary.totalCost)}</b><small>total biaya (USD)</small></div>
      </div>

      {/* Filter sederhana: status + kata kunci prompt */}
      <div className="tool-row wrap">
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter status">
          <option value="">Semua status</option>
          {(summary.statuses.length ? summary.statuses : KNOWN_STATUS).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
        <div className="search" style={{ margin: 0, flex: 1, minWidth: 200 }}>
          <span aria-hidden="true">⌕</span>
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="Cari kata di prompt" aria-label="Cari prompt" />
        </div>
        <button type="button" className="primary" style={{ padding: '10px 14px' }} disabled={loading} onClick={() => void load()}>Muat ulang</button>
      </div>

      {loading && <small>Memuat riwayat run…</small>}
      {error && <p className="error">{error}</p>}

      {!loading && !error && !visible.length && (
        <div className="empty-side">{runs.length ? 'Tidak ada run yang cocok dengan filter Anda.' : 'Belum ada run di proyek ini.'}</div>
      )}

      {visible.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                {columns.map((label, index) => (
                  <th key={`${label}-${index}`} style={{ ...cell, textAlign: 'left', color: '#64748b', fontSize: '10px', letterSpacing: '.08em', textTransform: 'uppercase' }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => {
                const open = openId === run.id;
                return (
                  <Fragment key={run.id}>
                    <tr onClick={() => setOpenId(open ? null : run.id)} style={{ cursor: 'pointer' }} title="Klik untuk membuka atau menutup detail">
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>{formatTime(run.createdAt)}</td>
                      <td style={cell}><span className="badge" style={statusStyle(run.status)}>{run.status}</span></td>
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>{run.model || '—'}</td>
                      <td style={cell}>
                        <span title={run.prompt} style={{ display: 'block', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {String(run.prompt ?? '').slice(0, 80) || '—'}
                        </span>
                      </td>
                      <td style={{ ...cell, textAlign: 'right' }}>{number(Number(run.inputTokens ?? 0))}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{number(Number(run.outputTokens ?? 0))}</td>
                      <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>{usd(Number(run.costUsd ?? 0))}</td>
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>{formatDuration(run)}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>
                        <button
                          type="button"
                          className="link-button"
                          onClick={(event) => { event.stopPropagation(); setOpenId(open ? null : run.id); }}
                        >
                          {open ? 'Tutup' : 'Detail'}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={columns.length} style={{ ...cell, background: '#0b0f1c' }}>
                          <div className="tool-list" style={{ maxHeight: 'none' }}>
                            <div>
                              <b>Prompt penuh</b>
                              <small>{formatTime(run.createdAt)} · {run.conversationId ? `percakapan ${run.conversationId}` : 'tanpa percakapan'}</small>
                            </div>
                            <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '11px', color: '#cbd5e1' }}>
                              {String(run.prompt ?? '') || '—'}
                            </pre>
                            <div><b>Hasil</b><small>{run.costMicros ? `${run.estimated ? 'token estimasi' : 'token terukur'} · ${usd(Number(run.costUsd ?? 0))}` : 'biaya belum tercatat'}</small></div>
                            <pre style={{ margin: 0, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '11px', color: '#94a3b8' }}>
                              {run.result ? String(run.result) : (run.status === 'queued' || run.status === 'running' ? 'Run masih berjalan…' : 'Belum ada hasil.')}
                            </pre>
                            {run.errorCode && <p className="error" style={{ margin: 0 }}>Kode galat: {run.errorCode}</p>}
                            {(run.status === 'queued' || run.status === 'running') && (
                              <button
                                type="button"
                                className="link-button"
                                disabled={cancelling === run.id}
                                onClick={() => void cancelRun(run.id)}
                              >
                                {cancelling === run.id ? 'Menghentikan…' : 'Batalkan run ini'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

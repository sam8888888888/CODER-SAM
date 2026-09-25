import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api, type ResumeStatus, type RunDetail, type RunSummary } from './api';

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

/** Ubah kode galat GET /v1/runs/:runId menjadi kalimat Indonesia singkat. */
function runDetailErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.includes('RUN_NOT_FOUND') || code.includes('404')) {
    return 'Detail run tidak ada di server (mungkin sudah terhapus oleh retensi data).';
  }
  if (code.includes('UNAUTHORIZED') || code.includes('401')) {
    return 'Sesi Anda sudah berakhir, jadi detail run tidak bisa dimuat. Silakan masuk kembali.';
  }
  if (code.includes('FORBIDDEN') || code.includes('403')) {
    return 'Akun Anda tidak punya akses ke run ini.';
  }
  return `Detail run gagal dimuat dari server (${code}).`;
}

/** Ubah kode dari jalur status lanjutan menjadi teks pendek (bahasa Indonesia). */
function resumeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Alasan server kenapa run TIDAK bisa dilanjutkan, ditulis sebagai kalimat biasa. */
function resumeMessage(code: string): string {
  const map: Record<string, string> = {
    RUN_TIDAK_GAGAL: 'Run ini tidak gagal, jadi tidak ada yang perlu dilanjutkan.',
    SUDAH_DILANJUTKAN: 'Run ini sudah pernah dilanjutkan; hasil lanjutannya ada di run lain.',
    GALAT_TIDAK_SEMENTARA: 'Galat run ini bukan galat sementara (misalnya salah permintaan), jadi tidak bisa dilanjutkan otomatis.',
    PERCOBAAN_HABIS: 'Jatah percobaan lanjutan untuk run ini sudah habis.',
    RUN_NOT_FOUND: 'Run ini tidak ditemukan lagi di server.',
  };
  return map[code] ?? `Run ini belum bisa dilanjutkan (${code || 'alasan tidak disebutkan server'}).`;
}

const cell: CSSProperties = { padding: '9px 8px', borderBottom: '1px solid #1e2438', verticalAlign: 'top', fontSize: '12px' };
const number = (value: number) => value.toLocaleString('id-ID');
const usd = (value: number) => `$${(value ?? 0).toFixed(6)}`;

/**
 * Halaman "Riwayat run": 50 run AI terbaru di proyek yang sedang aktif.
 * Wave 11A (butir 46) menambah panel kecil pelanggaran guardrail pada detail run, plus tautan ke
 * halaman Guardrail (laporan per akun ada di GET /v1/safety). `onOpenGuardrails` disediakan App.
 */
export function Runs({ projectId, onOpenGuardrails, onOpenTimeline, onAskCouncil }: {
  projectId: string | null;
  onOpenGuardrails?: () => void;
  /** Butir 62: buka halaman Timeline run untuk satu run. */
  onOpenTimeline?: (runId: string) => void;
  /** Butir 58: kirim jawaban satu run ke halaman Dewan juri sebagai materi. */
  onAskCouncil?: (materi: string) => void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState('');   // id run yang sedang dihentikan
  const [status, setStatus] = useState('');          // '' = semua status
  const [keyword, setKeyword] = useState('');        // pencarian pada prompt
  const [openId, setOpenId] = useState<string | null>(null); // baris yang sedang dibuka
  // Butir 57: detail run dari GET /v1/runs/:runId, disimpan per id supaya tidak diambil berulang kali.
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
  const [detailLoading, setDetailLoading] = useState('');   // id run yang detailnya sedang dimuat
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  // Butir 63: kelayakan lanjutan tiap run dari GET /v1/runs/:runId/resume-status.
  const [resumeInfo, setResumeInfo] = useState<Record<string, ResumeStatus>>({});
  const [resumeBusy, setResumeBusy] = useState('');
  const [resumeNote, setResumeNote] = useState<Record<string, string>>({});

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

  /** Ambil detail satu run sekali saja. Galat ditampilkan di panel detail, bukan menggagalkan tabel. */
  async function loadDetail(runId: string): Promise<void> {
    setDetailLoading(runId);
    setDetailErrors((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    try {
      const data = await api.runDetail(runId);
      setDetails((current) => ({ ...current, [runId]: data }));
      // Status lanjutan diminta bersamaan dengan detail; kegagalannya tidak boleh menutup detail run,
      // jadi kesalahannya hanya dicatat sebagai kalimat di panel.
      try {
        const kelayakan = await api.resumeStatus(runId);
        setResumeInfo((current) => ({ ...current, [runId]: kelayakan }));
      } catch (e) {
        setResumeNote((current) => ({ ...current, [runId]: `Status lanjutan gagal dimuat: ${resumeErrorText(e)}` }));
      }
    } catch (e) {
      const message = runDetailErrorMessage(e);
      setDetailErrors((current) => ({ ...current, [runId]: message }));
    } finally {
      setDetailLoading('');
    }
  }

  /** Buka atau tutup detail satu baris; detail diambil saat pertama kali dibuka. */
  function toggleRow(runId: string): void {
    const sudahTerbuka = openId === runId;
    setOpenId(sudahTerbuka ? null : runId);
    if (!sudahTerbuka && !details[runId]) void loadDetail(runId);
  }

  /**
   * Butir 63: lanjutkan run yang gagal lewat POST /v1/runs/:runId/resume (mode manual).
   * Bila server menerima, run baru dibuka otomatis supaya pengguna langsung melihat hasilnya.
   */
  async function lanjutkan(runId: string): Promise<void> {
    setResumeBusy(runId);
    setResumeNote((current) => ({ ...current, [runId]: '' }));
    try {
      const hasil = await api.resumeRun(runId, 'manual');
      setResumeNote((current) => ({
        ...current,
        [runId]: `Run lanjutan dibuat: ${hasil.runId} (jalur ${hasil.jalur}, ringkasan sebelumnya ${hasil.ringkasanDipakai ? 'dipakai' : 'tidak dipakai'}). ${hasil.catatan}`,
      }));
      await load();
      setOpenId(hasil.runId);
      await loadDetail(hasil.runId);
    } catch (e) {
      setResumeNote((current) => ({ ...current, [runId]: resumeErrorText(e) }));
    } finally {
      setResumeBusy('');
    }
  }

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
                const detail = details[run.id] ?? null;          // hasil GET /v1/runs/:runId
                const detailError = detailErrors[run.id] ?? '';   // galat khusus baris ini
                return (
                  <Fragment key={run.id}>
                    <tr onClick={() => toggleRow(run.id)} style={{ cursor: 'pointer' }} title="Klik untuk membuka atau menutup detail">
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
                          onClick={(event) => { event.stopPropagation(); toggleRow(run.id); }}
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
                            {run.errorCode && !detail && <p className="error" style={{ margin: 0 }}>Kode galat: {run.errorCode}</p>}

                            {/* Butir 57: detail dari server (status, waktu, penanda perpindahan model). */}
                            {detailLoading === run.id && <small>Memuat detail run…</small>}
                            {detailError && <p className="error" style={{ margin: 0 }}>{detailError}</p>}
                            {detail && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <small style={{ color: '#64748b' }}>
                                  Detail server — status: {detail.status || '—'} · mulai: {formatTime(detail.startedAt)} · selesai:{' '}
                                  {formatTime(detail.finishedAt)} · model tercatat: {detail.model || '—'}
                                </small>
                                {(detail.fallbackCount ?? 0) > 0 ? (
                                  <p data-testid="run-fallback-marker" style={{ margin: 0, color: '#fde68a' }}>
                                    ⇄ Model cadangan dipakai: pindah dari {detail.fallbackFrom || 'model utama'} sebanyak{' '}
                                    {detail.fallbackCount} kali; biaya di baris ini mengikuti model yang benar-benar dipakai (
                                    {detail.model || run.model || '—'}).
                                  </p>
                                ) : (
                                  <small data-testid="run-fallback-none" style={{ color: '#64748b' }}>Tanpa perpindahan model.</small>
                                )}
                                {/* Butir 46: pelanggaran guardrail yang tercatat pada run ini.
                                    Server menyisipkan larangan SEBELUM run dibuat, jadi daftar ini hampir
                                    selalu kosong; panel hanya muncul bila memang ada isinya. */}
                                {(detail.violations?.length ?? 0) > 0 ? (
                                  <div
                                    data-testid="run-violations"
                                    data-count={detail.violations!.length}
                                    style={{ border: '1px solid #f59e0b55', background: '#f59e0b1a', borderRadius: 8, padding: '8px 10px' }}
                                  >
                                    <b style={{ color: '#fde68a' }}>
                                      ⚠ {detail.violations!.length} pelanggaran guardrail tercatat pada run ini
                                    </b>
                                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
                                      {detail.violations!.map((violation) => (
                                        <li key={violation.id} data-testid={'run-violation-' + violation.id} style={{ fontSize: '11px' }}>
                                          <span style={{ color: '#fde68a' }}>{violation.judul || violation.ruleId}</span>
                                          {violation.kind ? <span style={{ color: '#94a3b8' }}> · {violation.kind}</span> : null}
                                          {violation.pattern ? <span style={{ color: '#94a3b8' }}> · pola: <code>{violation.pattern}</code></span> : null}
                                          {violation.snippet ? <span style={{ color: '#94a3b8' }}> · potongan: "{String(violation.snippet).slice(0, 120)}"</span> : null}
                                          <span style={{ color: '#64748b' }}> · {formatTime(violation.createdAt)}</span>
                                        </li>
                                      ))}
                                    </ul>
                                    <small style={{ color: '#94a3b8', display: 'block', marginTop: 6 }}>
                                      Aturan larangan biasanya menahan permintaan SEBELUM run dibuat, jadi daftar ini
                                      jarang terisi; entri di sini berarti permintaan tetap tercatat sebagai run.
                                    </small>
                                  </div>
                                ) : null}
                                <small data-testid="run-violations-info" style={{ color: '#64748b' }}>
                                  Pelanggaran guardrail: {detail.violations?.length ? detail.violations.length + ' tercatat' : 'tidak ada'}.
                                  {onOpenGuardrails ? (
                                    <>
                                      {' '}
                                      <button type="button" className="link-button" data-testid="run-violations-link" onClick={onOpenGuardrails}>
                                        Buka halaman Guardrail
                                      </button>{' '}
                                      untuk laporan pelanggaran akun Anda.
                                    </>
                                  ) : null}
                                </small>
                                {/* Butir 62 + 58: tautan ke timeline run dan tombol kirim jawaban ke Dewan juri. */}
                                {onOpenTimeline || onAskCouncil ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                                    {onOpenTimeline ? (
                                      <button type="button" className="link-button" data-testid="run-timeline-button" onClick={() => onOpenTimeline(run.id)}>
                                        ⟲ Timeline run ini
                                      </button>
                                    ) : null}
                                    {onAskCouncil ? (
                                      <button
                                        type="button"
                                        className="link-button"
                                        data-testid="run-council-button"
                                        onClick={() => onAskCouncil(String(run.result || run.prompt || ''))}
                                      >
                                        ⚖ Minta penilaian dewan
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}

                                {/* Butir 63: kelayakan lanjutan dari GET /v1/runs/:runId/resume-status. */}
                                {resumeInfo[run.id] ? (
                                  <div
                                    data-testid="run-resume"
                                    data-can={resumeInfo[run.id].canResume ? 'true' : 'false'}
                                    data-reason={resumeInfo[run.id].reason}
                                    style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                                  >
                                    <small data-testid="run-resume-status" style={{ color: '#94a3b8' }}>
                                      Lanjutan: <b>{resumeInfo[run.id].canResume ? 'bisa dilanjutkan' : 'tidak bisa dilanjutkan'}</b> · status run{' '}
                                      {resumeInfo[run.id].status} · percobaan {number(Number(resumeInfo[run.id].attempts ?? 0))} dari batas manual{' '}
                                      {number(Number(resumeInfo[run.id].maxPercobaanManual ?? 0))} · biaya run sebelumnya{' '}
                                      {usd(Number(resumeInfo[run.id].biayaSebelumnyaMicros ?? 0) / 1_000_000)}
                                    </small>
                                    <small data-testid="run-resume-reason" style={{ color: resumeInfo[run.id].canResume ? '#bbf7d0' : '#fca5a5' }}>
                                      {resumeInfo[run.id].canResume
                                        ? 'Run ini dihentikan oleh galat sementara, jadi server mengizinkan lanjutan. Langkah yang sudah selesai tidak diulang; biaya hanya bertambah dari run lanjutan.'
                                        : resumeMessage(resumeInfo[run.id].reason)}
                                    </small>
                                    {resumeInfo[run.id].canResume ? (
                                      <button
                                        type="button"
                                        className="primary"
                                        style={{ alignSelf: 'flex-start', padding: '8px 12px' }}
                                        data-testid="run-resume-button"
                                        disabled={resumeBusy === run.id}
                                        onClick={() => void lanjutkan(run.id)}
                                      >
                                        {resumeBusy === run.id ? 'Melanjutkan…' : 'Lanjutkan run ini'}
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                                {resumeNote[run.id] ? (
                                  <p data-testid="run-resume-message" style={{ margin: 0, color: resumeNote[run.id].startsWith('Run lanjutan') ? '#bbf7d0' : '#fca5a5' }}>
                                    {resumeNote[run.id]}
                                  </p>
                                ) : null}

                                {detail.errorCode && (
                                  <p className="error" style={{ margin: 0 }}>
                                    Kode galat: {detail.errorCode}
                                    {detail.errorCode === 'ENGINE_UNAVAILABLE'
                                      ? ' — semua model (utama dan cadangan) gagal sementara, jadi run ini tidak menghasilkan jawaban. Coba lagi sebentar lagi.'
                                      : ''}
                                  </p>
                                )}
                              </div>
                            )}
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

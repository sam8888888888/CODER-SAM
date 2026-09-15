import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AgentMapSession, CompactionResult, DirStats } from './api';


/** Jenis run seperti yang dikirim api.agentMap(). */
type AgentMapRun = AgentMapSession['runs'][number];

/** Satu baris run beserta tingkat kedalamannya di pohon parentRunId. */
type RunRow = { run: AgentMapRun; depth: number };

/** Kelas Tailwind dasar untuk tombol kecil di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas kartu isi ringkas. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';

/** Pilihan jumlah sesi yang dimuat dari server. */
const LIMIT_OPTIONS = [10, 30, 50, 100];

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Tampilkan angka 0/1 dari server sebagai ya/tidak. */
function yesNo(value: unknown): string {
  if (value === undefined || value === null) return 'tidak diketahui';
  return num(value) !== 0 ? 'ya' : 'tidak';
}

/** Ukuran berkas dalam satuan yang mudah dibaca. */
function bytesText(value: unknown): string {
  const bytes = num(value);
  if (bytes <= 0) return '0 byte';
  if (bytes < 1024) return bytes + ' byte';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Format tanggal dan jam; nilai kosong ditulis sebagai tanda hubung. */
function dateTimeText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Label status run bahasa Indonesia dari kode status mesin. */
function runStatusLabel(status: unknown): string {
  const code = String(status ?? '').trim().toLowerCase();
  if (code === 'succeeded' || code === 'success' || code === 'ok' || code === 'completed') return 'selesai';
  if (code === 'running' || code === 'started') return 'berjalan';
  if (code === 'queued' || code === 'pending') return 'menunggu';
  if (code === 'failed' || code === 'error') return 'gagal';
  if (code === 'cancelled' || code === 'canceled') return 'dibatalkan';
  return code || 'tidak diketahui';
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ubah kode galat peta agen menjadi kalimat Indonesia yang jelas. */
function mapErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('CONVERSATION_NOT_FOUND')) return 'Percakapan itu tidak ditemukan. Muat ulang daftar sesi.';
  if (code.includes('ENGINE_UNAVAILABLE') || code.includes('ENGINE_NOT_FOUND')) {
    return 'Mesin agen tidak tersedia, jadi data sesi mesin belum bisa dibaca.';
  }
  if (code.includes('AUTH') || code.includes('UNAUTHENTICATED')) return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Tidak dapat menghubungi server. Periksa koneksi Anda, lalu muat ulang.';
  }
  return 'Gagal memuat peta agen. Coba muat ulang beberapa saat lagi.';
}

/** Ubah kode galat pemadatan percakapan menjadi kalimat Indonesia yang jelas. */
function compactErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('CONVERSATION_NOT_FOUND')) return 'Percakapan itu tidak ditemukan, jadi belum bisa dipadatkan.';
  if (code.includes('ENGINE_UNAVAILABLE') || code.includes('ENGINE_NOT_FOUND')) {
    return 'Mesin agen tidak tersedia, jadi pemadatan belum bisa dijalankan.';
  }
  if (code.includes('NOTHING_TO_COMPACT') || code.includes('TOO_FEW_MESSAGES')) {
    return 'Belum ada cukup pesan untuk dipadatkan.';
  }
  if (code.includes('QUOTA') && code.includes('EXCEEDED')) return 'Kuota token Anda sudah habis, pemadatan tidak dijalankan.';
  if (code.includes('FORBIDDEN') || code.includes('ADMIN_REQUIRED')) return 'Anda tidak berhak memadatkan percakapan ini.';
  if (code.includes('AUTH') || code.includes('UNAUTHENTICATED')) return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Tidak dapat menghubungi server. Periksa koneksi Anda, lalu coba lagi.';
  }
  return 'Pemadatan gagal dijalankan. Coba lagi beberapa saat lagi.';
}

/** Susun daftar run menjadi baris bertingkat mengikuti parentRunId. */
function buildRunRows(runs: AgentMapRun[]): RunRow[] {
  const byId = new Map<string, AgentMapRun>();
  for (const run of runs) byId.set(run.id, run);
  const children = new Map<string, AgentMapRun[]>();
  const roots: AgentMapRun[] = [];
  for (const run of runs) {
    const parentId = run.parentRunId && run.parentRunId !== run.id && byId.has(run.parentRunId) ? run.parentRunId : null;
    if (!parentId) {
      roots.push(run);
      continue;
    }
    const list = children.get(parentId);
    if (list) list.push(run);
    else children.set(parentId, [run]);
  }
  const rows: RunRow[] = [];
  const visited = new Set<string>();
  const walk = (list: AgentMapRun[], depth: number): void => {
    for (const run of list) {
      if (visited.has(run.id)) continue;
      visited.add(run.id);
      rows.push({ run, depth });
      walk(children.get(run.id) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  // Jaga-jaga: run yang belum tampil (misal data tidak konsisten) tetap ditampilkan.
  walk(runs.filter((run) => !visited.has(run.id)), 0);
  return rows;
}

/** Satu baris keterangan "label: nilai" untuk kartu ringkas. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="text-slate-400">{label}:</span>
      <span className="text-slate-100">{value}</span>
    </li>
  );
}

/** Ringkas isi direktori sesi mesin pada kartu atas. */
function RootStorage({ dir }: { dir: DirStats | null | undefined }) {
  if (!dir) return <p className="mt-1 text-slate-400">Belum ada data penyimpanan sesi mesin.</p>;
  return (
    <ul className="mt-1">
      <Row label="Jumlah berkas" value={numberText(dir.files)} />
      <Row label="Ukuran" value={bytesText(dir.bytes)} />
      <Row label="Berkas terbaru" value={dateTimeText(dir.newest)} />
    </ul>
  );
}

/**
 * Halaman "Peta agen": daftar sesi agen beserta ukuran sesi mesin, pohon run per sesi
 * (bertingkat mengikuti parentRunId), dan tombol "Padatkan" yang memanggil
 * api.compactConversation(). Semua data diambil dari api.agentMap(limit).
 */
export function AgentMap({ onError }: { onError?: (message: string) => void }) {
  const [limit, setLimit] = useState(30);
  const [sessions, setSessions] = useState<AgentMapSession[]>([]);
  const [engine, setEngine] = useState<{ available: boolean; version?: string } | null>(null);
  const [engineRoot, setEngineRoot] = useState('');
  const [rootStorage, setRootStorage] = useState<DirStats | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Keadaan tombol "Padatkan" per percakapan: sibuk, hasil nyata, dan galat.
  const [compactBusyId, setCompactBusyId] = useState('');
  const [compactResults, setCompactResults] = useState<Record<string, CompactionResult>>({});
  const [compactErrors, setCompactErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');

  /** Catat galat ke halaman ini dan teruskan ke induk. */
  const fail = useCallback(
    (message: string): void => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  /** Ambil peta agen terbaru dari server. */
  const load = useCallback(
    async (activeLimit: number): Promise<void> => {
      setLoading(true);
      setError('');
      try {
        const data = await api.agentMap(activeLimit);
        setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
        setEngine(data?.engine ?? null);
        setEngineRoot(String(data?.engineRoot ?? ''));
        setRootStorage(data?.rootStorage ?? null);
        setNote(String(data?.note ?? ''));
      } catch (caught) {
        // Jangan tampilkan data lama seolah masih baru.
        setSessions([]);
        setEngine(null);
        setEngineRoot('');
        setRootStorage(null);
        setNote('');
        fail(mapErrorMessage(caught));
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  useEffect(() => {
    void load(limit);
  }, [load, limit]);

  /** Padatkan satu percakapan setelah dikonfirmasi pengguna. */
  async function compact(session: AgentMapSession): Promise<void> {
    const conversationId = session.conversationId;
    if (!conversationId) return;
    const judul = session.title || 'tanpa judul';
    const confirmed = window.confirm(
      'Padatkan percakapan "' + judul + '"? Pesan lama akan diringkas menjadi satu ringkasan dan tetap tersimpan di sesi mesin.',
    );
    if (!confirmed) return;
    setNotice('');
    setCompactErrors((current) => ({ ...current, [conversationId]: '' }));
    setCompactBusyId(conversationId);
    try {
      const result = await api.compactConversation(conversationId);
      setCompactResults((current) => ({ ...current, [conversationId]: result }));
      setNotice(
        'Pemadatan "' +
          judul +
          '" sudah diproses server. ' +
          numberText(result?.messagesCovered) +
          ' pesan diringkas, ukuran teks berubah dari ' +
          numberText(result?.charsBefore) +
          ' menjadi ' +
          numberText(result?.charsAfter) +
          ' karakter.',
      );
      // Muat ulang peta supaya jumlah ringkasan dan waktu pemadatan ikut terbarui.
      await load(limit);
    } catch (caught) {
      const message = compactErrorMessage(caught);
      setCompactErrors((current) => ({ ...current, [conversationId]: message }));
      onError?.(message);
    } finally {
      setCompactBusyId('');
    }
  }

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">⧗</span>Peta agen
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-slate-300">
            Jumlah sesi
            <select
              className={FIELD}
              value={limit}
              aria-label="Jumlah sesi yang dimuat"
              onChange={(event) => setLimit(Number(event.target.value) || 30)}
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={BTN} disabled={loading} onClick={() => { void load(limit); }}>
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
        </div>
      </div>

      {notice ? <p className="mb-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">{notice}</p> : null}
      {error ? <p className="mb-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">{error}</p> : null}
      {loading ? <p className="mb-3 text-slate-400">Memuat peta agen…</p> : null}
      {note ? <p className="mb-3 text-slate-400">Catatan server: {note}</p> : null}

      {/* Ringkasan mesin dan tempat penyimpanan sesi. */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className={CARD}>
          <p className={LABEL}>Mesin agen</p>
          <ul className="mt-1">
            <Row label="Tersedia" value={engine ? yesNo(engine.available) : 'tidak diketahui'} />
            <Row label="Versi" value={engine?.version || 'tidak diketahui'} />
          </ul>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Akar sesi mesin</p>
          <p className="mt-1 break-all text-slate-100">{engineRoot || 'Belum ada akar sesi mesin dari server.'}</p>
        </div>
        <div className={CARD}>
          <p className={LABEL}>Penyimpanan akar</p>
          <RootStorage dir={rootStorage} />
        </div>
      </div>

      <h3 className="mb-2 text-sm font-semibold text-slate-100">Daftar sesi</h3>
      {!loading && sessions.length === 0 ? <p className="mb-4 text-slate-400">Belum ada sesi agen.</p> : null}

      <ul className="mb-4 space-y-3">
        {sessions.map((session) => {
          const runs = Array.isArray(session.runs) ? session.runs : [];
          const rows = buildRunRows(runs);
          const busy = compactBusyId === session.conversationId;
          const result = compactResults[session.conversationId];
          const compactError = compactErrors[session.conversationId];
          const sessionDir = session.engineSession;
          return (
            <li key={session.conversationId} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-slate-100">{session.title || 'Tanpa judul'}</p>
                  <p className="text-slate-400">
                    Proyek {session.projectName || 'tidak diketahui'} · Workspace {session.workspaceName || 'tidak diketahui'}
                  </p>
                </div>
                <button
                  type="button"
                  className={BTN}
                  disabled={busy || !session.conversationId}
                  onClick={() => { void compact(session); }}
                >
                  {busy ? 'Memadatkan…' : 'Padatkan'}
                </button>
              </div>

              <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                <Row label="Jumlah pesan" value={numberText(session.messages)} />
                <Row label="Jumlah ringkasan" value={numberText(session.summaries)} />
                <Row label="ID sesi mesin" value={session.engineSessionId || 'belum ada'} />
                <Row label="Dipadatkan pada" value={session.compactedAt ? dateTimeText(session.compactedAt) : 'belum pernah'} />
                <Row label="Diperbarui" value={dateTimeText(session.updatedAt)} />
                <Row
                  label="Ukuran sesi mesin"
                  value={sessionDir ? numberText(sessionDir.files) + ' berkas · ' + bytesText(sessionDir.bytes) : 'belum ada'}
                />
                <Row label="Berkas sesi terbaru" value={sessionDir ? dateTimeText(sessionDir.newest) : '-'} />
              </ul>

              {result ? (
                <div className="mt-2 rounded-lg border border-slate-700 bg-slate-900 p-2">
                  <p className="text-slate-100">
                    Hasil pemadatan: {numberText(result.messagesCovered)} pesan diringkas, teks {numberText(result.charsBefore)} menjadi{' '}
                    {numberText(result.charsAfter)} karakter, sumber ringkasan {result.source === 'engine' ? 'mesin agen' : 'cadangan platform'}.
                  </p>
                  <p className="mt-1 text-slate-400">Ringkasan terbaru:</p>
                  <p className="whitespace-pre-wrap text-slate-300">{result.summary || 'Server belum mengirim teks ringkasan.'}</p>
                </div>
              ) : null}
              {compactError ? <p className="mt-2 text-slate-100">{compactError}</p> : null}

              <p className="mt-3 text-slate-400">Pohon run ({numberText(rows.length)} run):</p>
              {rows.length === 0 ? (
                <p className="text-slate-400">Belum ada run pada sesi ini.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {rows.map(({ run, depth }) => (
                    <li key={run.id} className="rounded border border-slate-700/60 px-2 py-1" style={{ marginLeft: (depth + 1) * 14 }}>
                      <span className="text-slate-400">{depth === 0 ? '├ ' : '└ '}</span>
                      <span className="text-slate-100">{runStatusLabel(run.status)}</span>
                      <span className="text-slate-400">
                        {' · model '}
                        {run.model || 'tidak diketahui'}
                        {' · penalaran '}
                        {run.thinkingLevel || 'tidak diketahui'}
                        {' · otonom '}
                        {yesNo(run.autonomous)}
                      </span>
                      <span className="block text-slate-400">
                        Prompt {run.promptChars === null ? 'tidak tercatat' : numberText(run.promptChars) + ' karakter'}
                        {' · tambahan system '}
                        {run.appendSystemChars === null ? 'tidak tercatat' : numberText(run.appendSystemChars) + ' karakter'}
                        {' · token '}
                        {numberText(run.totalTokens)}
                        {' · dibuat '}
                        {dateTimeText(run.createdAt)}
                        {run.finishedAt ? ' · selesai ' + dateTimeText(run.finishedAt) : ''}
                        {run.parentRunId ? ' · induk ' + run.parentRunId : ' · run induk'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {sessions.length > 0 ? (
        <p className="text-slate-400">Indentasi baris run mengikuti parentRunId; run tanpa induk ditulis pada tingkat paling kiri.</p>
      ) : null}
    </section>
  );
}

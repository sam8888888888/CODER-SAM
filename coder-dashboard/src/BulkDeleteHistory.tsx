/**
 * Hapus semua riwayat percakapan (Wave 11A, butir 54).
 *
 * Aturan keselamatan dari PRD dijaga di sini:
 *  1. Riwayat hanya boleh dihapus setelah diekspor. Ekspor digabung menjadi satu berkas oleh server,
 *     dan `exportId` hasilnya wajib ada saat menekan tombol hapus. Jadi UI tidak bisa menghapus
 *     riwayat tanpa pernah menyimpan cadangannya.
 *  2. Pengguna wajib mengetik `HAPUS` pada dialog konfirmasi.
 *  3. Artefak TIDAK ikut terhapus; jumlah artefak yang tetap tersimpan ditampilkan setelah selesai.
 *  4. Cakupan bisa satu proyek atau seluruh workspace.
 */
import { useEffect, useState } from 'react';
import { api, failureOf, type BulkDeleteScope, type BulkExportResponse, type BulkDeleteResponse, type Project } from './api';

type Props = {
  workspaceId: string | null;
  /** Proyek yang sedang aktif, dipakai sebagai cakupan awal bila ada. */
  projectId?: string | null;
  onError?: (message: string) => void;
  /** Dipanggil setelah penghapusan berhasil, supaya halaman induk menyegarkan daftarnya. */
  onDeleted?: () => void;
};

/** Ukuran berkas dalam satuan yang mudah dibaca. */
function byteText(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} byte`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function BulkDeleteHistory({ workspaceId, projectId, onError, onDeleted }: Props) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<BulkDeleteScope>('project');
  const [projects, setProjects] = useState<Project[]>([]);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<BulkExportResponse | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [result, setResult] = useState<BulkDeleteResponse | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (projectId) { setTargetId(projectId); setScope('project'); }
  }, [projectId]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    void (async () => {
      try {
        const rows = await api.projects(workspaceId);
        setProjects(rows);
        if (!projectId && rows.length) setTargetId((current) => current || rows[0].id);
      } catch {
        // Daftar proyek hanya pelengkap: tanpa daftar pun penghapusan cakupan workspace tetap bisa.
        setProjects([]);
      }
    })();
  }, [open, workspaceId]);

  function fail(message: string): void {
    setProblem(message);
    onError?.(message);
  }

  /** Langkah 1: ekspor dulu. Id ekspor dari server dipakai sebagai syarat langkah 2. */
  async function runExport(): Promise<void> {
    setBusy(true);
    setProblem('');
    setResult(null);
    try {
      const body = scope === 'project'
        ? { scope, projectId: targetId }
        : { scope, workspaceId: workspaceId ?? undefined };
      if (scope === 'project' && !targetId) { fail('Pilih proyek yang riwayatnya ingin diekspor.'); return; }
      if (scope === 'workspace' && !workspaceId) { fail('Workspace aktif belum dipilih.'); return; }
      const data = await api.bulkExportConversations(body);
      setExported(data);
    } catch (error) {
      setExported(null);
      fail(failureOf(error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Langkah 2: hapus; server menolak bila exportId tidak ada atau konfirmasi salah. */
  async function runDelete(): Promise<void> {
    setBusy(true);
    setProblem('');
    try {
      const body = scope === 'project'
        ? { scope, projectId: targetId, exportId: exported?.exportId ?? '', confirm: confirmText }
        : { scope, workspaceId: workspaceId ?? undefined, exportId: exported?.exportId ?? '', confirm: confirmText };
      const data = await api.bulkDeleteConversations(body);
      setResult(data);
      setExported(null);
      setConfirmText('');
      onDeleted?.();
    } catch (error) {
      fail(failureOf(error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="settings-card danger-zone">
        <h3 className="settings-heading">Hapus semua riwayat</h3>
        <p className="settings-hint">
          Menghapus percakapan, pesan, dan ringkasannya sekaligus. Artefak TIDAK ikut terhapus. Sistem mewajibkan
          ekspor riwayat lebih dulu supaya Anda punya cadangan.
        </p>
        <button type="button" className="link-button danger" data-testid="history-open" onClick={() => { setOpen(true); setProblem(''); setResult(null); }}>
          Hapus semua riwayat
        </button>
      </section>
    );
  }

  return (
    <section className="settings-card danger-zone" data-testid="history-panel">
      <h3 className="settings-heading">Hapus semua riwayat</h3>
      <div className="history-danger">
        <div className="row">
          <label title="Batasi penghapusan pada satu proyek">
            <input type="radio" name="history-scope" data-testid="history-scope-project" checked={scope === 'project'} onChange={() => { setScope('project'); setExported(null); }} /> Satu proyek
          </label>
          <label title="Hapus riwayat semua proyek di workspace aktif">
            <input type="radio" name="history-scope" data-testid="history-scope-workspace" checked={scope === 'workspace'} onChange={() => { setScope('workspace'); setExported(null); }} /> Seluruh workspace
          </label>
          {scope === 'project' && (
            <select data-testid="history-target" value={targetId} onChange={(event) => { setTargetId(event.target.value); setExported(null); }}>
              <option value="">(pilih proyek)</option>
              {projects.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              {projectId && !projects.some((row) => row.id === projectId) && <option value={projectId}>Proyek aktif</option>}
            </select>
          )}
        </div>
        <div className="row">
          <button type="button" className="primary" data-testid="history-export" disabled={busy} onClick={() => void runExport()}>
            {busy ? 'Bekerja…' : '1. Ekspor riwayat dulu'}
          </button>
          <small>Langkah wajib: penghapusan ditolak server bila belum ada berkas ekspor.</small>
        </div>
        {exported && (
          <p data-testid="history-export-info">
            Ekspor siap: {exported.conversations} percakapan, {exported.messages} pesan, {byteText(exported.sizeBytes)}.
            Nomor ekspor {exported.exportId.slice(0, 8)}… berlaku sampai {new Date(exported.expiresAt).toLocaleString('id-ID')}.
            Simpan berkasnya; berkas ini yang menjadi cadangan Anda.
          </p>
        )}
        <div className="row">
          <label>
            Ketik HAPUS untuk mengonfirmasi
            <input
              data-testid="history-confirm-input"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder="HAPUS"
            />
          </label>
          <button
            type="button"
            className="link-button danger"
            data-testid="history-delete"
            disabled={busy || !exported || confirmText.trim().toUpperCase() !== 'HAPUS'}
            onClick={() => void runDelete()}
          >
            2. Hapus riwayat sekarang
          </button>
          <button type="button" className="link-button" onClick={() => { setOpen(false); setExported(null); setConfirmText(''); setProblem(''); }}>
            Batal
          </button>
        </div>
        {!exported && <p className="settings-hint">Tombol hapus menyala setelah ekspor berhasil dan kata HAPUS diketik.</p>}
        {problem && <p className="error" data-testid="history-error">{problem}</p>}
        {result && (
          <p data-testid="history-result">
            Selesai: {result.deletedConversations} percakapan, {result.deletedMessages} pesan, {result.deletedSummaries} ringkasan dihapus.
            Artefak yang tetap tersimpan: {result.artifactsKept} di cakupan {result.scope.nama}. {result.catatan}
          </p>
        )}
      </div>
    </section>
  );
}

export default BulkDeleteHistory;

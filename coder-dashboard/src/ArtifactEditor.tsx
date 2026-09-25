/**
 * Modal sunting artefak + riwayat revisi (Wave 11A, butir 48).
 *
 * Alur yang dijaga berkas ini:
 *  1. Isi berkas diambil dari `GET /v1/artifacts/:id/content`; nomor `revision` dari jawaban itu
 *     dipakai sebagai `baseRevision` saat menyimpan.
 *  2. Bila berkas sudah berubah di server (409 `ARTIFACT_CHANGED`), teks pengguna TIDAK dibuang.
 *     Pengguna melihat isi terbaru di server, lalu memilih menyimpan ulang di atas versi itu.
 *  3. Setiap penyimpanan menyimpan salinan isi sebelumnya ke riwayat revisi (dilakukan server).
 *  4. Revisi lama bisa dilihat dan dipulihkan; pemulihan juga menaikkan nomor revisi.
 *
 * Berkas yang tampak biner atau lebih besar dari batas server tidak bisa disunting di peramban:
 * server menandainya `editable: false` dan UI hanya menampilkan alasannya.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, failureOf, type ArtifactContentResponse, type ArtifactRevision, type ArtifactRevisionList } from './api';

type Props = {
  artifactId: string;
  artifactName?: string;
  onClose: () => void;
  /** Dipanggil setelah isi tersimpan atau revisi dipulihkan, supaya halaman induk memuat ulang data. */
  onChanged?: (info: { revision: number; message: string }) => void;
  onError?: (message: string) => void;
};

/** Ubah ukuran byte menjadi satuan yang mudah dibaca. */
function byteText(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} byte`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** Waktu lokal Indonesia, atau tanda pisah bila kosong. */
function timeText(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('id-ID');
}

export function ArtifactEditor({ artifactId, artifactName, onClose, onChanged, onError }: Props) {
  const [info, setInfo] = useState<ArtifactContentResponse | null>(null);
  const [text, setText] = useState('');
  const [baseRevision, setBaseRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const [nota, setNota] = useState('');
  const [conflict, setConflict] = useState<{ latestRevision: number; latestContent: string | null; message: string } | null>(null);
  const [history, setHistory] = useState<ArtifactRevisionList | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [openRevision, setOpenRevision] = useState<number | null>(null);
  const [revisionText, setRevisionText] = useState('');
  const [revisionError, setRevisionError] = useState('');
  const [busyRevision, setBusyRevision] = useState(0);

  const fail = useCallback((message: string) => {
    setProblem(message);
    onError?.(message);
  }, [onError]);

  /** Muat isi berkas + riwayat revisi; dipakai saat pertama dibuka dan setelah pemulihan. */
  const load = useCallback(async () => {
    setLoading(true);
    setProblem('');
    setHistoryError('');
    try {
      const data = await api.artifactContent(artifactId);
      setInfo(data);
      setText(typeof data.content === 'string' ? data.content : '');
      setBaseRevision(Number(data.revision ?? 0));
      setConflict(null);
      if (data.editable === false && data.message) setNota(data.message);
    } catch (error) {
      setInfo(null);
      fail(failureOf(error).message);
    } finally {
      setLoading(false);
    }
    try {
      const rows = await api.artifactRevisions(artifactId);
      setHistory(rows);
    } catch (error) {
      setHistory(null);
      const detail = failureOf(error);
      setHistoryError(detail.status === 403
        ? 'Peran viewer tidak boleh membaca riwayat revisi artefak ini.'
        : detail.message);
    }
  }, [artifactId, fail]);

  useEffect(() => { void load(); }, [load]);

  /** Simpan isi baru di atas revisi terakhir yang diketahui. */
  async function save(): Promise<void> {
    setProblem('');
    setNota('');
    setSaving(true);
    try {
      const result = await api.saveArtifactContent(artifactId, { content: text, baseRevision, note: 'Disimpan dari peramban' });
      setBaseRevision(Number(result.revision ?? baseRevision));
      setText(result.content ?? text);
      setConflict(null);
      setNota(result.message || 'Artefak tersimpan.');
      onChanged?.({ revision: Number(result.revision ?? baseRevision), message: result.message });
      await load();
    } catch (error) {
      const detail = failureOf(error);
      if (detail.code === 'ARTIFACT_CHANGED') {
        const body = (detail.body ?? {}) as { latestRevision?: unknown; latestContent?: unknown };
        setConflict({
          latestRevision: Number(body.latestRevision ?? 0),
          latestContent: typeof body.latestContent === 'string' ? body.latestContent : null,
          message: detail.message,
        });
      } else {
        fail(detail.message);
      }
    } finally {
      setSaving(false);
    }
  }

  /** Lihat isi satu revisi lama (hanya baca). */
  async function openRevisionContent(revision: number): Promise<void> {
    setRevisionError('');
    setBusyRevision(revision);
    try {
      const data = await api.artifactRevisionContent(artifactId, revision);
      setOpenRevision(revision);
      setRevisionText(String(data.content ?? ''));
    } catch (error) {
      setOpenRevision(null);
      setRevisionText('');
      setRevisionError(failureOf(error).message);
    } finally {
      setBusyRevision(0);
    }
  }

  /** Pulihkan satu revisi lama menjadi isi berkas saat ini. */
  async function restore(revision: number): Promise<void> {
    setProblem('');
    setNota('');
    setBusyRevision(revision);
    try {
      const result = await api.restoreArtifactRevision(artifactId, revision, baseRevision);
      setText(String(result.content ?? text));
      setBaseRevision(Number(result.revision ?? baseRevision));
      setOpenRevision(null);
      setRevisionText('');
      setNota(result.message || `Revisi ${revision} dipulihkan.`);
      onChanged?.({ revision: Number(result.revision ?? baseRevision), message: result.message });
      await load();
    } catch (error) {
      const detail = failureOf(error);
      if (detail.code === 'ARTIFACT_CHANGED') {
        const body = (detail.body ?? {}) as { latestRevision?: unknown; latestContent?: unknown };
        setConflict({
          latestRevision: Number(body.latestRevision ?? 0),
          latestContent: typeof body.latestContent === 'string' ? body.latestContent : null,
          message: detail.message,
        });
      } else {
        fail(detail.message);
      }
    } finally {
      setBusyRevision(0);
    }
  }

  /** Ambil teks terbaru dari server tanpa membuang teks pengguna: teks pengguna disalin ke catatan. */
  function takeLatest(): void {
    if (!conflict) return;
    if (conflict.latestContent !== null) {
      setText(conflict.latestContent);
      setBaseRevision(conflict.latestRevision);
      setNota(`Teks di layar diganti dengan revisi terbaru dari server (revisi ${conflict.latestRevision}).`);
    } else {
      setBaseRevision(conflict.latestRevision);
      setNota('Nomor revisi disamakan dengan server. Isi terbaru tidak bisa ditampilkan sebagai teks.');
    }
    setConflict(null);
  }

  const editable = info ? info.editable !== false && info.content !== null : false;
  const limitBytes = Number(info?.maxBytes ?? 0);
  const sizeBytes = Number(info?.bytes ?? new TextEncoder().encode(text).length);

  return (
    <div className="preview-editor" data-testid="artifact-editor" data-artifact-id={artifactId}>
      <div className="preview-toolbar">
        <b>Sunting: {artifactName || info?.artifact?.name || artifactId}</b>
        <span className="preview-kind">REVISI {baseRevision}</span>
        <span>{byteText(sizeBytes)}{limitBytes ? ` / batas ${byteText(limitBytes)}` : ''}</span>
        <button type="button" className="link-button" onClick={onClose}>Tutup</button>
      </div>

      {loading && <p className="preview-note">Memuat isi artefak…</p>}
      {problem && <p className="error" data-testid="artifact-editor-error">{problem}</p>}
      {nota && <p className="preview-note" data-testid="artifact-editor-message">{nota}</p>}

      {conflict && (
        <div className="preview-conflict" data-testid="artifact-editor-conflict">
          <b>Berkas berubah di server</b>
          <p>{conflict.message}</p>
          <div className="preview-actions">
            <button type="button" className="primary" onClick={takeLatest}>Pakai revisi terbaru ({conflict.latestRevision})</button>
            <button type="button" onClick={() => setConflict(null)}>Simpan teks saya di atas versi terbaru</button>
          </div>
        </div>
      )}

      {!loading && info && !editable && (
        <p className="preview-note">{info.message || 'Berkas ini tidak bisa disunting di peramban.'}</p>
      )}

      {!loading && info && (
        <div className="preview-editor-grid">
          <label className="preview-editor-field">
            <span>Isi berkas {editable ? '' : '(hanya baca)'}</span>
            <textarea
              data-testid="artifact-editor-textarea"
              value={text}
              readOnly={!editable}
              rows={16}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="preview-actions">
            <button type="button" className="primary" data-testid="artifact-editor-save" disabled={!editable || saving} onClick={() => void save()}>
              {saving ? 'Menyimpan…' : 'Simpan revisi baru'}
            </button>
            <button type="button" onClick={() => void load()} disabled={loading}>Muat ulang dari server</button>
            {info.sha256Matches === false && <span className="preview-warn">Peringatan: sidik jari berkas di disk berbeda dari catatan basis data.</span>}
          </div>
        </div>
      )}

      <div className="preview-history" data-testid="artifact-editor-revisions">
        <h4>Riwayat revisi {history ? `(${history.count} dari maksimum ${history.limit})` : ''}</h4>
        {historyError && <p className="error">{historyError}</p>}
        {history && !history.revisions.length && <p className="preview-note">Belum ada revisi lama. Revisi muncul setelah isi berkas disimpan pertama kali.</p>}
        {history && history.revisions.length > 0 && (
          <table className="preview-table">
            <thead><tr><th>Revisi</th><th>Ukuran</th><th>Catatan</th><th>Waktu</th><th /></tr></thead>
            <tbody>
              {history.revisions.map((row: ArtifactRevision) => (
                <tr key={row.revisionNumber}>
                  <td>{row.revisionNumber}</td>
                  <td>{byteText(row.sizeBytes)}</td>
                  <td>{row.note || '—'}</td>
                  <td>{timeText(row.createdAt)}</td>
                  <td>
                    <button type="button" className="link-button" disabled={busyRevision === row.revisionNumber} onClick={() => void openRevisionContent(row.revisionNumber)}>Lihat</button>
                    <button type="button" className="link-button" data-testid={`artifact-editor-restore-${row.revisionNumber}`} disabled={busyRevision === row.revisionNumber} onClick={() => void restore(row.revisionNumber)}>Pulihkan</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history && history.note && <p className="preview-note">{history.note}</p>}
        {revisionError && <p className="error">{revisionError}</p>}
        {openRevision !== null && (
          <div data-testid="artifact-editor-revision-content">
            <b>Isi revisi {openRevision}</b>
            <pre className="artifact-preview-text">{revisionText}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default ArtifactEditor;

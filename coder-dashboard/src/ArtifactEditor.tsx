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
 *
 * Tombol `🔄 Render` (DoD butir 48) menampilkan pratinjau INLINE di dalam modal yang sama:
 *  - iframe memakai `sandbox="allow-scripts"` SAJA; `allow-same-origin` tidak pernah ditambahkan,
 *    sehingga skrip di dalam artefak tidak bisa membaca sesi, cookie, atau DOM halaman ini;
 *  - HTML/SVG dipasang apa adanya lewat `srcDoc`, teks biasa dibungkus `<pre>` yang di-escape,
 *    gambar base64 lewat data URL;
 *  - jenis berkas yang tidak bisa dirender (docx/xlsx/pptx/pdf/biner) ditolak dengan catatan jujur,
 *    bukan pratinjau palsu yang tampak kosong.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, failureOf, type ArtifactContentResponse, type ArtifactRevision, type ArtifactRevisionList } from './api';
import { previewKindOf, type PreviewArtifact } from './ArtifactPreview';

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

/** Catatan wajib saat jenis berkas tidak bisa dipratinjau: apa adanya, tanpa berpura-pura. */
export const RENDER_CANNOT = 'Jenis berkas ini tidak bisa dipratinjau di sini.';
/** Penjelasan bahwa iframe disandbox tanpa akses same-origin. */
export const RENDER_SANDBOX_NOTE =
  'Pratinjau dijalankan di iframe bersandbox "allow-scripts" tanpa "allow-same-origin": skrip di dalam berkas tidak bisa menyentuh sesi, cookie, atau data Anda.';

/** Rencana pratinjau: `srcDoc` untuk HTML/SVG/teks, `url` untuk gambar base64, atau alasan penolakan. */
export type RenderPlan =
  | { ok: true; mode: 'srcDoc'; html: string }
  | { ok: true; mode: 'url'; url: string }
  | { ok: false; reason: string };

/** Buang karakter berbahaya HTML supaya teks biasa tampil sebagai teks, bukan sebagai markup. */
export function escapeHtmlText(raw: string): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Tentukan isi iframe pratinjau dari jenis berkas + teks yang sedang dibuka.
 * Fungsi ini murni (tanpa efek samping) supaya keputusan render bisa dibaca ulang dengan tenang.
 */
export function renderPlanOf(artifact: PreviewArtifact | null, source: string): RenderPlan {
  const text = String(source ?? '');
  if (!artifact) return { ok: false, reason: `${RENDER_CANNOT} Data artefak belum termuat.` };
  if (!text.trim()) return { ok: false, reason: `${RENDER_CANNOT} Isinya kosong atau tidak tersedia sebagai teks (berkas biner).` };
  const kind = previewKindOf(artifact);
  const mime = String(artifact.mimeType ?? '').toLowerCase();
  // HTML dan SVG dipasang apa adanya: keamanannya dipegang sandbox iframe, bukan penghapusan tag.
  if (kind === 'html' || mime.includes('svg')) return { ok: true, mode: 'srcDoc', html: text };
  if (kind === 'markdown' || kind === 'csv' || kind === 'text') {
    const body = escapeHtmlText(text);
    return {
      ok: true,
      mode: 'srcDoc',
      html: `<pre style="white-space:pre-wrap;word-break:break-word;margin:0;padding:12px;background:#fff;color:#0f172a;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">${body}</pre>`,
    };
  }
  if (kind === 'image') {
    const compact = text.replace(/\s+/g, '');
    const looksBase64 = compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
    if (looksBase64) return { ok: true, mode: 'url', url: `data:${mime || 'image/png'};base64,${compact}` };
    return { ok: false, reason: `${RENDER_CANNOT} Isi gambar tidak dikenali sebagai data base64.` };
  }
  return { ok: false, reason: RENDER_CANNOT };
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
  /** Pratinjau inline (DoD butir 48). `null` berarti modal belum menampilkan pratinjau sama sekali. */
  const [renderPlan, setRenderPlan] = useState<RenderPlan | null>(null);
  const [renderSource, setRenderSource] = useState('');
  const [renderNonce, setRenderNonce] = useState(0);

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

  /** Ganti artefak = pratinjau lama tidak lagi mewakili berkas yang dibuka, jadi ditutup. */
  useEffect(() => { setRenderPlan(null); setRenderSource(''); }, [artifactId]);

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

  /**
   * Buka atau tutup pratinjau inline. Isi yang dipratinjau = isi kotak kode saat tombol ditekan,
   * supaya yang terlihat di pratinjau sama dengan yang akan disimpan pengguna.
   */
  function toggleRender(): void {
    if (renderPlan?.ok) { setRenderPlan(null); return; }
    setRenderSource(text);
    setRenderNonce((value) => value + 1);
    setRenderPlan(renderPlanOf(info?.artifact ?? null, text));
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
            <button type="button" data-testid="artifact-render" onClick={toggleRender}>
              {renderPlan?.ok ? '🔄 Sembunyikan pratinjau' : '🔄 Render'}
            </button>
            <button type="button" onClick={() => void load()} disabled={loading}>Muat ulang dari server</button>
            {info.sha256Matches === false && <span className="preview-warn">Peringatan: sidik jari berkas di disk berbeda dari catatan basis data.</span>}
          </div>
        </div>
      )}

      {renderPlan?.ok && (
        <div className="preview-panel" data-testid="artifact-render-box">
          <div className="preview-toolbar">
            <b>Pratinjau artefak</b>
            <span className="preview-kind">SANDBOX</span>
            {renderSource !== text && (
              <span className="preview-warn" data-testid="artifact-render-basi">Teks di kotak kode sudah berubah setelah pratinjau dibuka; tekan Render lagi untuk memperbarui.</span>
            )}
            <button type="button" className="link-button" data-testid="artifact-render-tutup" onClick={() => setRenderPlan(null)}>Tutup pratinjau</button>
          </div>
          <iframe
            className="preview-frame"
            data-testid="artifact-render-frame"
            key={renderNonce}
            title={`Pratinjau ${artifactName || info?.artifact?.name || artifactId}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            {...(renderPlan.mode === 'srcDoc' ? { srcDoc: renderPlan.html } : { src: renderPlan.url })}
          />
          <p className="preview-note" data-testid="artifact-render-catatan">{RENDER_SANDBOX_NOTE}</p>
        </div>
      )}

      {renderPlan && !renderPlan.ok && (
        <p className="preview-note" data-testid="artifact-render-catatan">{renderPlan.reason}</p>
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

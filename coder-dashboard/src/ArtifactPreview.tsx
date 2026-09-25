/**
 * Penampil pratinjau artefak (Wave 11A, butir 49).
 *
 * Aturan yang dijaga berkas ini:
 *  1. Jenis penampil dipilih dari EKSTENSI nama berkas, bukan dari MIME saja (banyak artefak
 *     dikirim sebagai `application/octet-stream`).
 *  2. Berkas lebih besar dari 10 MB tidak dirender di peramban: langsung mode unduh dengan pesan
 *     bahasa Indonesia, supaya tab tidak mati kehabisan memori.
 *  3. Bila pustaka penampil gagal (berkas rusak bukan format yang benar), pengguna melihat pesan
 *     bahasa Indonesia + tombol unduh, bukan layar kosong.
 *  4. Berkas HTML (dan hasil konversi dokumen Word) SELALU ditampilkan di dalam iframe ber-`sandbox`
 *     TANPA `allow-same-origin`, sehingga skrip di dalam berkas tidak bisa menyentuh sesi pengguna.
 *  5. Pustaka berat (mammoth/xlsx/pptx-preview) dimuat dengan `import()` dinamis supaya masuk ke
 *     potongan berkas terpisah dan tidak memberatkan halaman yang tidak membuka pratinjau.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

/** Batas ukuran berkas yang masih dirender di peramban (10 MB). */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** Batas teks yang dibaca untuk berkas teks besar, supaya tidak menahan peramban. */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export type PreviewArtifact = { id: string; name: string; mimeType?: string | null; sizeBytes?: number | null };
export type PreviewKind = 'docx' | 'xlsx' | 'pptx' | 'markdown' | 'html' | 'csv' | 'image' | 'pdf' | 'text' | 'binary';

/** Ukuran berkas dalam satuan yang mudah dibaca manusia. */
export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} byte`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** Ekstensi huruf kecil dari sebuah nama berkas (tanpa titik), atau string kosong. */
export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Memilih jenis penampil. Urutannya: ekstensi lebih dulu, lalu MIME sebagai cadangan.
 * Alasan: artefak dari agen sering dikirim dengan MIME umum (`application/octet-stream`),
 * sedangkan ekstensinya tetap benar.
 */
export function previewKindOf(input: PreviewArtifact): PreviewKind {
  const ext = extensionOf(input.name);
  const mime = String(input.mimeType ?? '').toLowerCase();
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return 'xlsx';
  if (ext === 'pptx' || ext === 'ppt') return 'pptx';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(ext)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') return 'text';
  if (ext) return 'text';
  return 'binary';
}

/** True bila jenis ini butuh pustaka berat, sehingga pemuatan bisa gagal dan perlu jaring aman. */
export function needsRichRenderer(kind: PreviewKind): boolean {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx';
}

/**
 * Menetralkan HTML hasil konversi dokumen sebelum ditampilkan: membuang tag yang bisa menjalankan
 * skrip atau memuat sumber luar, membuang atribut `on*`, dan menutup URL `javascript:`.
 * Iframe ber-`sandbox` tetap dipakai sebagai lapisan kedua.
 */
export function neutralizeDocumentHtml(html: string): string {
  let clean = String(html ?? '');
  clean = clean.replace(/<!--[\s\S]*?-->/g, '');
  clean = clean.replace(/<(script|iframe|object|embed|link|meta|base|form|input|button|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  clean = clean.replace(/<(script|iframe|object|embed|link|meta|base|form|input|button|style)\b[^>]*\/?>/gi, '');
  clean = clean.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  clean = clean.replace(/(href|src|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
  return clean;
}

/** Memecah teks CSV/TSV menjadi baris dan kolom sederhana (sadar tanda kutip dan pemisah koma/titik koma). */
export function parseDelimited(text: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  const firstLine = String(text ?? '').split(/\r?\n/, 1)[0] ?? '';
  const separator = firstLine.includes('\t') ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === separator) { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; if (rows.length >= maxRows) return rows; }
    else if (char !== '\r') cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.slice(0, maxRows);
}

/** Konversi byte menjadi teks UTF-8 dengan batas aman. */
export function bytesToText(bytes: ArrayBuffer, maxBytes = PREVIEW_TEXT_MAX_BYTES): string {
  const slice = bytes.byteLength > maxBytes ? bytes.slice(0, maxBytes) : bytes;
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}

type Props = {
  artifact: PreviewArtifact;
  /** Dipanggil saat pratinjau gagal, supaya halaman induk bisa menampilkan pesan yang sama. */
  onError?: (message: string) => void;
  /** Jarak unduh; bawaan memakai rute mentah artefak yang sudah ada. */
  downloadHref?: string;
  /** Memuat berkas sendiri saat dipasang (bawaan true). */
  autoLoad?: boolean;
};

type LoadState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; bytes: ArrayBuffer }
  | { phase: 'failed'; message: string };

/** Iframe ber-`sandbox` tanpa `allow-same-origin`: lapisan wajib untuk semua konten HTML. */
export function SandboxFrame({ html, title, scripts = false }: { html: string; title: string; scripts?: boolean }) {
  return (
    <iframe
      className="preview-frame"
      data-testid="artifact-preview-frame"
      title={title}
      srcDoc={html}
      sandbox={scripts ? 'allow-scripts allow-popups' : ''}
      referrerPolicy="no-referrer"
    />
  );
}

export function ArtifactPreview({ artifact, onError, downloadHref, autoLoad = true }: Props) {
  const kind = useMemo(() => previewKindOf(artifact), [artifact.name, artifact.mimeType]);
  const tooLarge = Number(artifact.sizeBytes ?? 0) > PREVIEW_MAX_BYTES;
  const [state, setState] = useState<LoadState>({ phase: 'idle' });
  const [renderError, setRenderError] = useState('');
  const url = downloadHref ?? api.artifactRawUrl(artifact.id);

  const fail = useCallback((message: string) => {
    setState({ phase: 'failed', message });
    onError?.(message);
  }, [onError]);

  const load = useCallback(async () => {
    if (tooLarge || kind === 'binary') { setState({ phase: 'ready', bytes: new ArrayBuffer(0) }); return; }
    setState({ phase: 'loading' });
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) { fail(`Pratinjau gagal dimuat (server menjawab ${response.status}). Anda masih bisa mengunduh berkasnya.`); return; }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > PREVIEW_MAX_BYTES) {
        fail(`Berkas berukuran ${formatBytes(bytes.byteLength)} melebihi batas pratinjau ${formatBytes(PREVIEW_MAX_BYTES)}. Gunakan mode unduh.`);
        return;
      }
      setState({ phase: 'ready', bytes });
    } catch (error) {
      fail(`Pratinjau gagal dimuat: ${error instanceof Error ? error.message : String(error)}. Anda masih bisa mengunduh berkasnya.`);
    }
  }, [url, kind, tooLarge, fail]);

  useEffect(() => {
    if (!autoLoad) return;
    void load();
  }, [autoLoad, load]);

  useEffect(() => { setRenderError(''); }, [artifact.id]);

  const downloadMode = tooLarge || kind === 'binary' || state.phase === 'failed' || Boolean(renderError);
  const mode = downloadMode ? 'unduh' : 'render';
  const message = tooLarge
    ? `Berkas ini ${formatBytes(Number(artifact.sizeBytes ?? 0))}, lebih besar dari batas pratinjau ${formatBytes(PREVIEW_MAX_BYTES)}. Dinda menampilkannya sebagai unduhan supaya peramban tidak kehabisan memori.`
    : kind === 'binary'
      ? 'Jenis berkas ini tidak punya penampil di peramban. Silakan unduh berkasnya.'
      : (state.phase === 'failed' ? state.message : (renderError ? `Pratinjau gagal dirender: ${renderError}. Berkasnya tetap bisa Anda unduh.` : ''));

  return (
    <div className="preview-panel" data-testid="artifact-preview" data-preview-kind={kind} data-preview-mode={mode} data-preview-state={state.phase}>
      <div className="preview-toolbar">
        <b>{artifact.name}</b>
        <span className="preview-kind">{kind.toUpperCase()}</span>
        <span>{formatBytes(Number(artifact.sizeBytes ?? 0))}</span>
        {mode === 'unduh' && (
          <a className="download" data-testid="artifact-preview-download" href={url} target="_blank" rel="noreferrer">Unduh berkas</a>
        )}
      </div>
      {mode === 'unduh' && <p className="preview-note" data-testid="artifact-preview-message">{message}</p>}
      {state.phase === 'loading' && <p className="preview-note">Memuat pratinjau…</p>}
      {mode === 'render' && state.phase === 'ready' && (
        <PreviewBody kind={kind} bytes={state.bytes} url={url} name={artifact.name} onError={setRenderError} />
      )}
    </div>
  );
}

function PreviewBody({ kind, bytes, url, name, onError }: { kind: PreviewKind; bytes: ArrayBuffer; url: string; name: string; onError: (message: string) => void }) {
  switch (kind) {
    case 'docx': return <DocxView bytes={bytes} name={name} onError={onError} />;
    case 'xlsx': return <SheetView bytes={bytes} onError={onError} />;
    case 'pptx': return <PptxView bytes={bytes} onError={onError} />;
    case 'image': return <img className="artifact-preview" data-testid="artifact-preview-image" src={url} alt={name} />;
    case 'pdf': return <iframe className="preview-frame" data-testid="artifact-preview-frame" title={name} src={url} />;
    case 'html': return <SandboxFrame html={bytesToText(bytes)} title={`Pratinjau HTML ${name}`} scripts />;
    case 'csv': return <StructTable rows={parseDelimited(bytesToText(bytes))} onError={onError} />;
    case 'markdown': return <pre className="artifact-preview-text" data-testid="artifact-preview-text">{bytesToText(bytes)}</pre>;
    default: return <pre className="artifact-preview-text" data-testid="artifact-preview-text">{bytesToText(bytes)}</pre>;
  }
}

/** Tabel hasil penguraian CSV/TSV. */
function StructTable({ rows, onError }: { rows: string[][]; onError: (message: string) => void }) {
  useEffect(() => { if (!rows.length) onError('Berkas ini tidak memuat baris yang bisa ditampilkan'); }, [rows.length, onError]);
  if (!rows.length) return null;
  const [head, ...body] = rows;
  return (
    <div className="preview-table-box">
      <table className="preview-table" data-testid="artifact-preview-table">
        <thead><tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>
          {body.slice(0, 200).map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > 201 && <p className="preview-note">Ditampilkan 200 baris pertama dari {rows.length} baris.</p>}
    </div>
  );
}

/** Dokumen Word: mammoth mengubah docx menjadi HTML, lalu HTML itu dinetralkan dan disandbox. */
function DocxView({ bytes, name, onError }: { bytes: ArrayBuffer; name: string; onError: (message: string) => void }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const imported: Record<string, unknown> = await import('mammoth/mammoth.browser.js' as string);
        const mammoth = (imported.default ?? imported) as { convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
        const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
        if (!cancelled) setHtml(neutralizeDocumentHtml(result.value || '<p>Dokumen ini tidak punya teks yang bisa ditampilkan.</p>'));
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [bytes, onError]);
  if (!html) return <p className="preview-note">Menyiapkan pratinjau dokumen…</p>;
  return <SandboxFrame html={html} title={`Pratinjau dokumen ${name}`} />;
}

/** Buku kerja Excel: setiap lembar ditampilkan sebagai tabel, dengan tab pemilih lembar. */
function SheetView({ bytes, onError }: { bytes: ArrayBuffer; onError: (message: string) => void }) {
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(new Uint8Array(bytes), { type: 'array' });
        const parsed = workbook.SheetNames.map((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' }) as unknown as string[][];
          return { name: sheetName, rows: rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [String(row ?? '')])) };
        });
        if (!cancelled) setSheets(parsed);
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [bytes, onError]);
  if (!sheets.length) return <p className="preview-note">Menyiapkan pratinjau lembar kerja…</p>;
  const current = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div>
      {sheets.length > 1 && (
        <div className="preview-tabs">
          {sheets.map((sheet, index) => (
            <button key={sheet.name} type="button" className={index === active ? 'preview-tab active' : 'preview-tab'} onClick={() => setActive(index)}>
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <StructTable rows={current.rows} onError={onError} />
      <p className="preview-note">Lembar {current.name} · {current.rows.length} baris</p>
    </div>
  );
}

/** Presentasi PowerPoint: dirender per slide oleh pptx-preview (mode satu-slide). */
function PptxView({ bytes, onError }: { bytes: ArrayBuffer; onError: (message: string) => void }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [slides, setSlides] = useState(0);
  const [status, setStatus] = useState('Menyiapkan pratinjau presentasi…');
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | null = null;
    void (async () => {
      try {
        const { init } = await import('pptx-preview');
        if (cancelled || !holder.current) return;
        holder.current.innerHTML = '';
        const previewer = init(holder.current, { width: 960, height: 540, mode: 'slide' });
        await previewer.preview(bytes);
        if (cancelled) return;
        setSlides(previewer.slideCount);
        setStatus('');
        destroy = () => { try { previewer.destroy(); } catch { /* sudah dibuang */ } };
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; destroy?.(); };
  }, [bytes, onError]);
  return (
    <div>
      <div className="preview-pptx" data-testid="artifact-preview-pptx" data-slides={slides} ref={holder} />
      {status && <p className="preview-note">{status}</p>}
      {slides > 0 && <p className="preview-note">Ditampilkan satu slide pada satu waktu · {slides} slide</p>}
    </div>
  );
}

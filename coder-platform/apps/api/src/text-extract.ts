import { inflateRawSync } from "node:zlib";

export type ExtractionResult = { text: string; kind: string };

const TEXT_KINDS = new Set(["txt", "md", "markdown", "json", "csv", "tsv", "log", "yaml", "yml", "html", "htm"]);

/** Normalizes extracted text: collapses whitespace and removes control characters. */
export function normalizeText(input: string) {
  return input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Extracts plain text from raw bytes for the supported document kinds. */
export async function extractText(buffer: Buffer, filename: string): Promise<ExtractionResult> {
  const extension = (filename.split(".").pop() ?? "").toLowerCase();
  if (extension === "pdf") return { text: normalizeText(await extractPdf(buffer)), kind: "pdf" };
  if (extension === "docx") return { text: normalizeText(await extractDocx(buffer)), kind: "docx" };
  if (TEXT_KINDS.has(extension)) return { text: normalizeText(buffer.toString("utf8")), kind: "text" };
  if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return { text: normalizeText(await extractPdf(buffer)), kind: "pdf" };
  throw new Error("UNSUPPORTED_DOCUMENT_TYPE");
}

/** Reads text out of a PDF using the bundled pdf-parse loader (no network access). */
async function extractPdf(buffer: Buffer) {
  /** pdf-parse index.js runs its own test code when imported from ESM, so the library file is loaded directly. */
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (data: Buffer) => Promise<{ text: string }>;
  const parsed = await pdfParse(buffer);
  if (!parsed.text?.trim()) throw new Error("PDF_HAS_NO_EXTRACTABLE_TEXT");
  return parsed.text;
}

/** Reads text out of a .docx package: the document part is plain XML inside a zip. */
async function extractDocx(buffer: Buffer) {
  const documentXml = readZipEntry(buffer, "word/document.xml");
  if (!documentXml) throw new Error("DOCX_DOCUMENT_PART_MISSING");
  return documentXml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Minimal zip reader for the single entry we need, so the app has no zip dependency. */
export function readZipEntry(buffer: Buffer, name: string): string | null {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66000; index -= 1) {
    if (buffer.readUInt32LE(index) === endSignature) { endOffset = index; break; }
  }
  if (endOffset < 0) return null;
  const total = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (entryName === name) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      return method === 0 ? data.toString("utf8") : inflateRawSync(data).toString("utf8");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** Splits text into overlapping chunks so search and prompt context stay small. */
export function chunkText(text: string, size = 1200, overlap = 200) {
  const clean = text.trim();
  if (!clean) return [] as string[];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf("\n", end);
      if (boundary > start + size / 2) end = boundary;
    }
    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

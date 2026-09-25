/**
 * Wave 11A (butir 48): tulis-balik artefak dari peramban, riwayat revisi, dan jaring aman.
 *
 * Aturan yang dijaga berkas ini (sembilan syarat butir 48):
 *  ① daftar putih ekstensi + penolakan isi biner  -> 415 ARTIFACT_NOT_EDITABLE
 *  ② batas ukuran `config.ARTIFACT_EDIT_MAX_BYTES` (bawaan 2 MB) -> 413 ARTIFACT_TOO_LARGE
 *  ③ jalur berkas wajib berada di dalam akar proyek: `..`, jalur absolut di luar akar, dan
 *     tautan simbolik yang keluar dari akar ditolak -> 400 INVALID_ARTIFACT_PATH
 *  ④ isi baru ditulis ke berkas sementara di direktori yang sama, lalu `rename` (atomik)
 *  ⑤ `baseRevision` wajib; bila server sudah punya revisi yang lebih baru -> 409 ARTIFACT_CHANGED
 *     beserta `latestRevision` dan `latestContent` (isi pengguna tetap ditampilkan)
 *  ⑥ peran `viewer` tidak boleh menulis maupun membaca revisi -> 403 VIEWER_FORBIDDEN
 *  ⑦ retensi maksimum `config.ARTIFACT_REVISION_LIMIT` (20) revisi per artefak + pemakaian disk
 *     dilaporkan pada daftar revisi (`totalBytes`/`limitBytes`/`count`/`limit`)
 *  ⑧ bentrok tulis: kunci tulis eksplisit (`setArtifactWriteLock`) atau run aktif di proyek yang
 *     sama -> 409 ARTIFACT_WRITE_BUSY dengan pesan Indonesia
 *  ⑨ `restore` menulis ulang isi artefak dan memperbarui `sha256`, `size_bytes`, serta `storage_path`
 *
 * Model revisi: satu baris `artifact_revisions` menyimpan SALINAN ISI LAMA (disalin sebelum
 * penimpaan, sesuai PRD "revisi ditulis dulu, baru isi artefak ditimpa"). `revision_number` naik
 * satu setiap kali isi artefak ditimpa, jadi nomor revisi terbaru = jumlah penimpaan. Klien
 * memakai angka itu sebagai `baseRevision` berikutnya; `GET .../content` mengembalikannya sebagai
 * `revision`.
 *
 * CARA MENYAMBUNG DI `server.ts` (belum dilakukan di sini; berkas itu milik Dinda):
 *  - Rute sudah terpasang otomatis lewat `registerWave11aRoutes(app)` -> `registerArtifactEditRoutes(app)`.
 *    Tidak ada tambahan pada daftar rute di server.ts.
 *  - Pada `POST /api/v1/projects/:projectId/artifacts`, sesudah baris artifacts disisipkan, panggil
 *    `await recordArtifactRevision(id, { content, note: "Versi awal artefak", createdBy: request.user!.id })`
 *    supaya versi pertama langsung ada di riwayat. Panggilan itu opsional: `PUT .../content` tetap bekerja
 *    walau artefak belum punya satu pun revisi (revisi pertama = salinan isi sebelum penimpaan pertama),
 *    karena `baseRevision` dibandingkan dengan `MAX(revision_number)` yang sedang ada, bukan angka tetap.
 *  - Agen/pekerja yang menulis artefak sendiri sebaiknya memanggil `setArtifactWriteLock(id, runId)` sebelum
 *    menulis dan `clearArtifactWriteLock(id)` sesudahnya, supaya pengguna melihat 409 ARTIFACT_WRITE_BUSY
 *    yang jelas, bukan kehilangan suntingan.
 *
 * Catatan jujur: kunci tulis disimpan di memori proses API (Map), bukan di tabel baru, karena
 * skema `db.ts` tidak boleh diubah dan tidak ada tabel kunci di skema Wave 11A. Kunci yang lebih
 * tua dari 15 menit dianggap kedaluwarsa supaya artefak tidak terkunci selamanya bila proses agen
 * berhenti mendadak. Jalur kedua (run aktif di proyek yang sama) dipakai untuk agen yang menulis
 * tanpa memanggil `setArtifactWriteLock`.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { requireUser } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { audit, fail } from "./shared.js";

/* ------------------------------------------------------------------ kontrak untuk server.ts */

/**
 * Menyisipkan satu revisi untuk sebuah artefak, lalu memangkas riwayat sampai
 * `config.ARTIFACT_REVISION_LIMIT` (20) baris. Dipanggil server.ts pada jalur penulisan artefak
 * (`POST /api/v1/projects/:projectId/artifacts`) dan dari `PUT .../content` di berkas ini.
 *
 * @param artifactId artefak pemilik riwayat
 * @param input.content isi yang disimpan sebagai revisi (salinan isi lama sebelum ditimpa)
 * @param input.note catatan singkat, mis. "Disimpan dari peramban"
 * @param input.createdBy id pengguna pelaku, boleh null untuk pekerjaan agen
 * @returns nomor revisi yang baru dibuat, checksum sha256 isi, dan ukurannya dalam byte
 * @throws Error("ARTIFACT_NOT_FOUND") bila artefaknya tidak ada
 */
export async function recordArtifactRevision(
  artifactId: string,
  input: { content: string | Buffer; note?: string; createdBy?: string | null },
): Promise<{ revisionNumber: number; checksum: string; sizeBytes: number }> {
  const row = db.prepare("SELECT id FROM artifacts WHERE id=?").get(artifactId) as { id: string } | undefined;
  if (!row) throw new Error("ARTIFACT_NOT_FOUND");
  const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(String(input.content ?? ""), "utf8");
  const revisionNumber = latestRevisionNumber(artifactId) + 1;
  db.prepare(`INSERT INTO artifact_revisions
      (id, artifact_id, revision_number, content, size_bytes, checksum, created_by, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), artifactId, revisionNumber, buffer.toString("utf8"), buffer.length,
    createHash("sha256").update(buffer).digest("hex"), input.createdBy ?? null,
    String(input.note ?? "").slice(0, 300), new Date().toISOString(),
  );
  pruneArtifactRevisions(artifactId);
  return { revisionNumber, checksum: createHash("sha256").update(buffer).digest("hex"), sizeBytes: buffer.length };
}

/**
 * Memangkas riwayat satu artefak supaya hanya nomor revisi TERBESAR sebanyak
 * `config.ARTIFACT_REVISION_LIMIT` (20) yang bertahan.
 *
 * @returns jumlah baris yang dibuang (0 bila riwayat masih di bawah batas)
 */
export function pruneArtifactRevisions(artifactId: string): number {
  const limit = Math.max(1, Number(config.ARTIFACT_REVISION_LIMIT) || 20);
  const stale = db.prepare(
    "SELECT revision_number AS revisionNumber FROM artifact_revisions WHERE artifact_id=? ORDER BY revision_number DESC LIMIT -1 OFFSET ?",
  ).all(artifactId, limit) as { revisionNumber: number }[];
  if (!stale.length) return 0;
  const remove = db.prepare("DELETE FROM artifact_revisions WHERE artifact_id=? AND revision_number=?");
  let removed = 0;
  db.transaction(() => { for (const item of stale) removed += remove.run(artifactId, item.revisionNumber).changes; })();
  return removed;
}

/** Nomor revisi terbaru sebuah artefak; 0 berarti isi artefak belum pernah ditimpa. */
export function latestArtifactRevision(artifactId: string): number {
  return latestRevisionNumber(artifactId);
}

/** Menandai bahwa satu run agen SEDANG menulis berkas artefak ini (syarat ⑧, jalur utama). */
export function setArtifactWriteLock(artifactId: string, runId: string): void {
  writeLocks.set(String(artifactId), { runId: String(runId), at: Date.now() });
}

/** Melepas kunci tulis artefak. Aman dipanggil walau tidak ada kunci. */
export function clearArtifactWriteLock(artifactId: string): void {
  writeLocks.delete(String(artifactId));
}

/** Run yang memegang kunci tulis eksplisit untuk artefak ini, atau null bila tidak ada/basi. */
export function artifactWriteLock(artifactId: string): string | null {
  const entry = writeLocks.get(String(artifactId));
  if (!entry) return null;
  if (Date.now() - entry.at > WRITE_LOCK_TTL_MS) { writeLocks.delete(String(artifactId)); return null; }
  return entry.runId;
}

/**
 * Alasan penulisan artefak ditolak karena bentrok tulis (syarat ⑧), atau null bila aman ditulis.
 * Jalur utama: kunci tulis eksplisit (`setArtifactWriteLock`). Jalur kedua: masih ada run
 * berstatus `queued`/`running` di proyek yang sama.
 */
export function artifactWriteBusyReason(artifactId: string, projectId: string): string | null {
  const lock = artifactWriteLock(artifactId);
  if (lock) {
    return `Agen sedang menulis berkas artefak ini (run ${lock}). Simpan ditolak supaya pekerjaan agen tidak tertimpa; coba lagi setelah agen selesai.`;
  }
  const active = db.prepare("SELECT id FROM runs WHERE project_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
    .get(projectId) as { id: string } | undefined;
  if (active) {
    return `Masih ada pekerjaan agen yang sedang berjalan di proyek ini (run ${active.id}). Simpan ditolak supaya berkas tidak berubah saat agen menulis; coba lagi setelah run selesai.`;
  }
  return null;
}

/* ------------------------------------------------------------------ daftar putih & pengenalan biner */

/** Ekstensi berkas teks yang boleh diedit dari peramban (syarat ①). */
export const EDITABLE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".json", ".jsonl", ".ndjson", ".csv", ".tsv",
  ".html", ".htm", ".css", ".scss", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".vue", ".svelte", ".py", ".rb", ".php", ".java", ".kt", ".kts", ".scala", ".go", ".rs",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".m", ".mm", ".lua", ".pl", ".r", ".dart",
  ".sql", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".yml", ".yaml", ".toml", ".ini", ".cfg",
  ".conf", ".properties", ".xml", ".svg", ".log", ".diff", ".patch", ".graphql", ".proto",
  ".tex", ".bib", ".srt", ".vtt", ".gitignore", ".editorconfig",
]);

/** Jenis MIME teks yang boleh diedit. Selain ini artefak hanya bisa dibaca. */
const TEXT_MIME_TYPES = new Set([
  "application/json", "application/ld+json", "application/x-ndjson", "application/json5",
  "application/xml", "application/xhtml+xml", "application/javascript", "application/x-javascript",
  "application/ecmascript", "application/typescript", "application/sql", "application/x-sh",
  "application/x-httpd-php", "application/x-yaml", "application/yaml", "application/toml",
  "application/graphql", "application/x-tex", "application/rtf",
  "image/svg+xml", "application/svg+xml",
]);

/** True bila jenis MIME artefak tergolong teks. */
export function isTextMime(mimeType: unknown): boolean {
  const mime = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (!mime) return false;
  return mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml");
}

/** Alasan sebuah artefak tidak boleh diedit, atau null bila boleh diedit. */
export function artifactNotEditableReason(artifact: { name?: unknown; mimeType?: unknown }): string | null {
  const name = String(artifact.name ?? "");
  const extension = extname(name).toLowerCase();
  if (!extension) return "Berkas ini tidak punya ekstensi berkas teks yang dikenal, jadi tidak bisa diedit di peramban.";
  if (!EDITABLE_EXTENSIONS.has(extension)) return `Ekstensi ${extension} tidak ada di daftar putih berkas teks, jadi tidak bisa diedit di peramban.`;
  if (!isTextMime(artifact.mimeType)) return `Jenis berkas ${String(artifact.mimeType ?? "tidak dikenal")} bukan teks, jadi tidak bisa diedit di peramban.`;
  return null;
}

/** True bila isi tampak biner: ada byte NUL, banyak byte kendali, atau bukan UTF-8 yang sah. */
export function looksBinary(content: Buffer): boolean {
  if (content.includes(0)) return true;
  const sample = content.subarray(0, 8192);
  let control = 0;
  for (const byte of sample) {
    const text = byte === 9 || byte === 10 || byte === 12 || byte === 13 || (byte >= 32 && byte !== 127);
    if (!text) control += 1;
  }
  if (sample.length >= 64 && control / sample.length > 0.3) return true;
  const text = content.toString("utf8");
  if (text.includes("\uFFFD") && !content.includes(Buffer.from("\uFFFD", "utf8"))) return true;
  return !Buffer.from(text, "utf8").equals(content);
}

/* ------------------------------------------------------------------ jalur aman (syarat ③) */

/** Akar penyimpanan artefak di disk; sama dengan yang dipakai server.ts. */
export function artifactRootDir(projectId: string): string {
  return join(config.DATA_DIR, "artifacts", projectId);
}

/** True bila `child` benar-benar berada di bawah `parent` (bukan parent itu sendiri). */
function isInside(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/**
 * Memeriksa `storage_path` sebuah artefak terhadap akar proyeknya, secara sintaksis (sinkron).
 * Dipakai sebelum menyentuh disk supaya permintaan yang jelas berbahaya tidak pernah sampai ke fs.
 */
export function safeArtifactPathInput(projectId: string, storagePath: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = String(storagePath ?? "").trim();
  if (!raw) return { ok: false, reason: "Jalur berkas artefak kosong." };
  if (raw.includes("\u0000")) return { ok: false, reason: "Jalur berkas artefak memuat karakter terlarang." };
  if (raw.split(/[\\/]+/).includes("..")) return { ok: false, reason: "Jalur berkas artefak memuat bagian '..'." };
  const root = resolve(artifactRootDir(projectId));
  const target = resolve(raw);
  if (!isInside(root, target)) return { ok: false, reason: "Jalur berkas artefak berada di luar akar proyek." };
  return { ok: true, path: target };
}

/** Menyelesaikan tautan simbolik pada bagian jalur yang benar-benar ada, lalu menempelkan sisanya. */
async function resolveThroughSymlinks(path: string): Promise<string> {
  let current = path;
  const missing: string[] = [];
  for (let step = 0; step < 64; step += 1) {
    try {
      const real = await realpath(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
  return resolve(path);
}

/**
 * Pemeriksaan penuh (sinkron + tautan simbolik) untuk jalur simpan sebuah artefak.
 * Menolak `..`, jalur absolut di luar akar proyek, dan tautan simbolik yang menembus keluar akar.
 */
export async function safeArtifactPath(projectId: string, storagePath: unknown): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const basic = safeArtifactPathInput(projectId, storagePath);
  if (!basic.ok) return basic;
  const root = resolve(artifactRootDir(projectId));
  const realRoot = await resolveThroughSymlinks(root);
  const realTarget = await resolveThroughSymlinks(basic.path);
  if (!isInside(realRoot, realTarget)) return { ok: false, reason: "Jalur berkas artefak menembus akar proyek lewat tautan simbolik." };
  return { ok: true, path: basic.path };
}

/* ------------------------------------------------------------------ akses & riwayat */

type ArtifactAccessRow = {
  id: string; projectId: string; name: string; mimeType: string; sizeBytes: number;
  sha256: string; storagePath: string; createdAt: string; workspaceId: string; role: string;
};

const WRITE_LOCK_TTL_MS = 15 * 60_000;
const writeLocks = new Map<string, { runId: string; at: number }>();

/** Artefak beserta peran pengguna di ruang kerja pemiliknya, atau null bila bukan anggotanya. */
function artifactAccess(artifactId: string, userId: string): ArtifactAccessRow | null {
  const row = db.prepare(`SELECT a.id AS id, a.project_id AS projectId, a.name AS name, a.mime_type AS mimeType,
      a.size_bytes AS sizeBytes, a.sha256 AS sha256, a.storage_path AS storagePath, a.created_at AS createdAt,
      p.workspace_id AS workspaceId, m.role AS role
    FROM artifacts a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE a.id=? AND m.user_id=?`).get(artifactId, userId) as ArtifactAccessRow | undefined;
  return row ?? null;
}

/** Bentuk artefak yang aman dikirim ke peramban (tanpa `storage_path` milik server). */
function publicArtifact(row: ArtifactAccessRow) {
  return {
    id: row.id, projectId: row.projectId, name: row.name, mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes), sha256: row.sha256, createdAt: row.createdAt,
  };
}

function latestRevisionNumber(artifactId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(revision_number),0) AS n FROM artifact_revisions WHERE artifact_id=?").get(artifactId) as { n: number };
  return Number(row?.n ?? 0);
}

function revisionRow(artifactId: string, revisionNumber: number) {
  return db.prepare(`SELECT revision_number AS revisionNumber, content, size_bytes AS sizeBytes,
      checksum, created_by AS createdBy, note, created_at AS createdAt
    FROM artifact_revisions WHERE artifact_id=? AND revision_number=?`).get(artifactId, revisionNumber) as
    { revisionNumber: number; content: string; sizeBytes: number; checksum: string; createdBy: string | null; note: string; createdAt: string } | undefined;
}

/** Jawaban seragam saat artefak tidak ada atau pengguna bukan anggota ruang kerjanya. */
function notFound(reply: any) {
  return fail(reply, 404, "ARTIFACT_NOT_FOUND", "Artefak tidak ditemukan atau Anda bukan anggota ruang kerja pemiliknya.");
}

/** Jawaban seragam untuk peran `viewer` (syarat ⑥). */
function viewerForbidden(reply: any, action: string) {
  return fail(reply, 403, "VIEWER_FORBIDDEN", `Peran viewer tidak boleh ${action}. Minta pemilik ruang kerja menaikkan peran Anda lebih dulu.`);
}

/** Menulis sebuah berkas secara atomik: berkas sementara di direktori yang sama, lalu `rename`. */
async function writeFileAtomic(target: string, content: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "w", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Menyamakan kolom artefak dengan isi berkas yang baru ditulis (ukuran, sha256, jalur simpan). */
function refreshArtifactRow(artifactId: string, content: Buffer, storagePath: string) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  db.prepare("UPDATE artifacts SET size_bytes=?, sha256=?, storage_path=? WHERE id=?").run(content.length, sha256, storagePath, artifactId);
  return sha256;
}

/** Membaca isi artefak dari disk setelah jalurnya dinyatakan aman (syarat ③). */
async function readArtifactBytes(row: ArtifactAccessRow, reply: any): Promise<{ ok: true; path: string; content: Buffer | null } | { ok: false }> {
  const safe = await safeArtifactPath(row.projectId, row.storagePath);
  if (!safe.ok) {
    fail(reply, 400, "INVALID_ARTIFACT_PATH", safe.reason);
    return { ok: false };
  }
  const content = await readFile(safe.path).catch(() => null);
  return { ok: true, path: safe.path, content };
}

/* ------------------------------------------------------------------ rute */

/**
 * Mendaftarkan rute tulis-balik artefak (butir 48). Dipanggil sekali oleh `registerWave11aRoutes`.
 * Semua rute memakai `preHandler: requireUser` dari `auth.ts` dan menjawab galat dengan format
 * `{ error, message }`.
 */
export function registerArtifactEditRoutes(app: any): void {
  const maxBytes = Number(config.ARTIFACT_EDIT_MAX_BYTES) || 2 * 1024 * 1024;
  const revisionLimit = Math.max(1, Number(config.ARTIFACT_REVISION_LIMIT) || 20);
  // Batas badan permintaan Fastify (bawaan 1 MB) dinaikkan sedikit di atas batas isi supaya
  // penolakan ukuran terjadi di berkas ini dengan kode ARTIFACT_TOO_LARGE, bukan di parser JSON.
  const bodyLimit = maxBytes * 2 + 64 * 1024;

  /** GET isi artefak + nomor revisi terbaru: dasar tombol Edit dan nilai `baseRevision`. */
  app.get("/api/v1/artifacts/:artifactId/content", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = artifactAccess(request.params.artifactId, request.user!.id);
    if (!row) return notFound(reply);
    const revision = latestRevisionNumber(row.id);
    const notEditable = artifactNotEditableReason(row);
    const meta = { artifact: publicArtifact(row), revision, maxBytes, limit: revisionLimit };
    if (notEditable) return reply.send({ ...meta, content: null, editable: false, message: notEditable });
    const read = await readArtifactBytes(row, reply);
    if (!read.ok) return reply;
    if (read.content === null) return fail(reply, 404, "ARTIFACT_NOT_FOUND", "Isi berkas artefak tidak ada lagi di penyimpanan server.");
    if (looksBinary(read.content)) {
      return reply.send({ ...meta, content: null, editable: false, message: "Isi berkas ini tampak biner, jadi tidak ditampilkan sebagai teks dan tidak bisa diedit." });
    }
    const sha256OnDisk = createHash("sha256").update(read.content).digest("hex");
    return reply.send({
      ...meta, content: read.content.toString("utf8"), editable: true,
      bytes: read.content.length, sha256OnDisk, sha256Matches: sha256OnDisk === row.sha256,
    });
  });

  /** GET daftar revisi + pemakaian disk (syarat ⑦). */
  app.get("/api/v1/artifacts/:artifactId/revisions", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = artifactAccess(request.params.artifactId, request.user!.id);
    if (!row) return notFound(reply);
    if (row.role === "viewer") return viewerForbidden(reply, "membaca riwayat revisi");
    const revisions = db.prepare(`SELECT revision_number AS revisionNumber, size_bytes AS sizeBytes, checksum,
        created_by AS createdBy, note, created_at AS createdAt
      FROM artifact_revisions WHERE artifact_id=? ORDER BY revision_number DESC`).all(row.id) as Array<Record<string, unknown>>;
    const totalBytes = revisions.reduce((sum, item) => sum + Number(item.sizeBytes ?? 0), 0);
    const usage = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS total FROM artifact_revisions WHERE artifact_id=?").get(row.id) as { n: number; total: number };
    return reply.send({
      artifact: publicArtifact(row),
      revisions,
      count: Number(usage.n ?? 0),
      limit: revisionLimit,
      totalBytes: Number(usage.total ?? 0),
      limitBytes: maxBytes,
      usageBytes: totalBytes,
      latestRevision: latestRevisionNumber(row.id),
      note: `Riwayat menyimpan maksimum ${revisionLimit} revisi terbaru; revisi lebih tua dibuang otomatis saat penimpaan.`,
    });
  });

  /** GET isi satu revisi lama. */
  app.get("/api/v1/artifacts/:artifactId/revisions/:revision", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = artifactAccess(request.params.artifactId, request.user!.id);
    if (!row) return notFound(reply);
    if (row.role === "viewer") return viewerForbidden(reply, "membaca riwayat revisi");
    const revisionNumber = Number(request.params.revision);
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) return fail(reply, 400, "INVALID_REVISION", "Nomor revisi harus bilangan bulat minimal 1.");
    const revision = revisionRow(row.id, revisionNumber);
    if (!revision) return fail(reply, 404, "ARTIFACT_REVISION_NOT_FOUND", `Revisi nomor ${revisionNumber} tidak ada pada artefak ini.`);
    return reply.send({ artifact: publicArtifact(row), ...revision, latestRevision: latestRevisionNumber(row.id) });
  });

  /** PUT isi baru: salinan isi lama disimpan lebih dulu, baru berkas nyata ditimpa. */
  app.put("/api/v1/artifacts/:artifactId/content", { preHandler: requireUser, bodyLimit }, async (request: any, reply: any) => {
    const row = artifactAccess(request.params.artifactId, request.user!.id);
    if (!row) return notFound(reply);
    if (row.role === "viewer") return viewerForbidden(reply, "menyimpan perubahan artefak");
    const body: Record<string, unknown> = request.body ?? {};
    if (typeof body.content !== "string") return fail(reply, 400, "INVALID_ARTIFACT_CONTENT", "Isi baru artefak wajib dikirim sebagai teks pada kolom content.");
    const baseRevision = Number(body.baseRevision);
    if (body.baseRevision === undefined || body.baseRevision === null || !Number.isInteger(baseRevision) || baseRevision < 0) {
      return fail(reply, 400, "BASE_REVISION_REQUIRED", "Kolom baseRevision wajib diisi dengan nomor revisi terakhir yang Anda lihat.");
    }
    const notEditable = artifactNotEditableReason(row);
    if (notEditable) return fail(reply, 415, "ARTIFACT_NOT_EDITABLE", notEditable);
    const content = Buffer.from(body.content, "utf8");
    if (content.length > maxBytes) {
      return fail(reply, 413, "ARTIFACT_TOO_LARGE", `Isi ${content.length} byte melebihi batas ${maxBytes} byte untuk sunting di peramban.`);
    }
    if (looksBinary(content)) return fail(reply, 415, "ARTIFACT_NOT_EDITABLE", "Isi yang dikirim tampak biner, jadi bukan berkas teks yang bisa diedit.");
    const safe = await safeArtifactPath(row.projectId, row.storagePath);
    if (!safe.ok) return fail(reply, 400, "INVALID_ARTIFACT_PATH", safe.reason);
    const busy = artifactWriteBusyReason(row.id, row.projectId);
    if (busy) return fail(reply, 409, "ARTIFACT_WRITE_BUSY", busy);
    const latest = latestRevisionNumber(row.id);
    if (baseRevision !== latest) {
      const current = await readFile(safe.path).catch(() => null);
      return reply.code(409).send({
        error: "ARTIFACT_CHANGED",
        message: `Artefak sudah berubah di server: revisi terbaru ${latest}, sedangkan Anda memakai revisi ${baseRevision}. Isi Anda tetap di sini; salin dulu lalu simpan ulang di atas versi terbaru.`,
        latestRevision: latest,
        latestContent: current && !looksBinary(current) ? current.toString("utf8") : null,
        yourRevision: baseRevision,
      });
    }
    let snapshot: { revisionNumber: number; checksum: string; sizeBytes: number } | null = null;
    const previous = await readFile(safe.path).catch(() => null);
    try {
      if (previous) {
        snapshot = await recordArtifactRevision(row.id, {
          content: previous,
          note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : "Disimpan dari peramban",
          createdBy: request.user!.id,
        });
      }
      await writeFileAtomic(safe.path, content);
    } catch (error) {
      return fail(reply, 500, "ARTIFACT_WRITE_FAILED", `Isi artefak gagal disimpan: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sha256 = refreshArtifactRow(row.id, content, safe.path);
    const revision = latestRevisionNumber(row.id);
    audit(request.user!.id, "artifact.content.updated", {
      artifactId: row.id, projectId: row.projectId, revision, snapshotRevision: snapshot?.revisionNumber ?? null,
      sizeBytes: content.length, checksum: sha256,
    });
    return reply.send({
      artifact: { ...publicArtifact(row), sizeBytes: content.length, sha256 },
      content: content.toString("utf8"), revision, snapshotRevision: snapshot?.revisionNumber ?? null,
      sha256, sizeBytes: content.length, limit: revisionLimit, maxBytes,
      message: "Artefak tersimpan. Salinan isi sebelumnya ada di riwayat revisi.",
    });
  });

  /** POST pulihkan satu revisi: isi lama ditulis ulang, kolom artefak diperbarui (syarat ⑨). */
  app.post("/api/v1/artifacts/:artifactId/revisions/:revision/restore", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = artifactAccess(request.params.artifactId, request.user!.id);
    if (!row) return notFound(reply);
    if (row.role === "viewer") return viewerForbidden(reply, "memulihkan revisi artefak");
    const revisionNumber = Number(request.params.revision);
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) return fail(reply, 400, "INVALID_REVISION", "Nomor revisi harus bilangan bulat minimal 1.");
    const revision = revisionRow(row.id, revisionNumber);
    if (!revision) return fail(reply, 404, "ARTIFACT_REVISION_NOT_FOUND", `Revisi nomor ${revisionNumber} tidak ada pada artefak ini.`);
    const safe = await safeArtifactPath(row.projectId, row.storagePath);
    if (!safe.ok) return fail(reply, 400, "INVALID_ARTIFACT_PATH", safe.reason);
    const busy = artifactWriteBusyReason(row.id, row.projectId);
    if (busy) return fail(reply, 409, "ARTIFACT_WRITE_BUSY", busy);
    const body: Record<string, unknown> = request.body ?? {};
    const latest = latestRevisionNumber(row.id);
    if (body.baseRevision !== undefined && body.baseRevision !== null) {
      const baseRevision = Number(body.baseRevision);
      if (!Number.isInteger(baseRevision) || baseRevision < 0) return fail(reply, 400, "BASE_REVISION_REQUIRED", "Kolom baseRevision harus bilangan bulat minimal 0.");
      if (baseRevision !== latest) {
        const current = await readFile(safe.path).catch(() => null);
        return reply.code(409).send({
          error: "ARTIFACT_CHANGED",
          message: `Artefak sudah berubah di server: revisi terbaru ${latest}, sedangkan Anda memakai revisi ${baseRevision}. Isi Anda tetap di sini; muat ulang lalu ulangi pemulihan.`,
          latestRevision: latest,
          latestContent: current && !looksBinary(current) ? current.toString("utf8") : null,
          yourRevision: baseRevision,
        });
      }
    }
    const restored = Buffer.from(revision.content ?? "", "utf8");
    const previous = await readFile(safe.path).catch(() => null);
    let snapshot: { revisionNumber: number } | null = null;
    try {
      if (previous) {
        snapshot = await recordArtifactRevision(row.id, {
          content: previous,
          note: `Salinan otomatis sebelum memulihkan revisi ${revisionNumber}`,
          createdBy: request.user!.id,
        });
      }
      await writeFileAtomic(safe.path, restored);
    } catch (error) {
      return fail(reply, 500, "ARTIFACT_WRITE_FAILED", `Revisi gagal dipulihkan: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sha256 = refreshArtifactRow(row.id, restored, safe.path);
    audit(request.user!.id, "artifact.revision.restored", {
      artifactId: row.id, projectId: row.projectId, restoredRevision: revisionNumber,
      snapshotRevision: snapshot?.revisionNumber ?? null, sizeBytes: restored.length, checksum: sha256,
    });
    return reply.send({
      artifact: { ...publicArtifact(row), sizeBytes: restored.length, sha256 },
      restored: revisionNumber, revision: latestRevisionNumber(row.id), snapshotRevision: snapshot?.revisionNumber ?? null,
      sha256, sizeBytes: restored.length, content: restored.toString("utf8"),
      message: `Revisi ${revisionNumber} dipulihkan ke berkas artefak.`,
    });
  });
}

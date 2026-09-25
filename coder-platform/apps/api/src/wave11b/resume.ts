/**
 * Wave 11B (butir 63): menandai run yang terputus dan melanjutkannya.
 *
 * Alasan modelnya begini:
 * - Penanda "bisa dilanjutkan" hanya ditulis untuk run yang GAGAL karena sebab sementara (proses mati,
 *   mesin habis waktu). Run yang gagal karena kesalahan permanen (mis. ditolak aturan) tidak ditawari.
 * - Lanjutan adalah run BARU (`runs.resumed_from` menunjuk run lama) yang memakai ringkasan terakhir
 *   percakapan. Biaya lama tidak pernah dihitung ulang: baris `run_usage` milik run lama tidak disentuh.
 * - Percobaan OTOMATIS dibatasi `config.RESUME_MAX_AUTO_ATTEMPTS` (1). Lanjutan dari lanjutan tidak
 *   pernah dilanjutkan otomatis lagi, supaya tidak ada rantai tanpa ujung; bila gagal lagi, berhenti
 *   dengan alasan yang jelas dan menunggu keputusan manusia (mode `manual`).
 * - Pemicu otomatis menghormati matriks perilaku butir 83 ①: percakapan mode diskusi tidak dieksekusi.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { reapAbandonedRuns } from "../jobs.js";
import { requireUser } from "../auth.js";
import { audit, fail, mayWrite } from "../wave11a/shared.js";
import { isTransientEngineError } from "../wave11a/fallback.js";
import { createRunAndDispatch } from "./dispatch.js";

/** Batas jumlah lanjutan yang boleh diminta manusia untuk satu run. Ditulis apa adanya di API. */
export const RESUME_MAX_MANUAL = 3;

type RunRow = {
  id: string; projectId: string; status: string; prompt: string; result: string | null; model: string | null;
  errorCode: string | null; resumeState: string; resumeAttempts: number; resumedFrom: string | null;
  thinkingLevel: string | null; personaId: string | null; autonomous: number; createdAt: string; role: string;
};

const RUN_COLUMNS = `r.id AS id, r.project_id AS projectId, r.status, r.prompt, r.result, r.model,
  r.error_code AS errorCode, r.resume_state AS resumeState, r.resume_attempts AS resumeAttempts,
  r.resumed_from AS resumedFrom, r.thinking_level AS thinkingLevel, r.persona_id AS personaId,
  r.autonomous, r.created_at AS createdAt, m.role AS role`;

function runForUser(runId: string, userId: string): RunRow | undefined {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM runs r JOIN projects p ON p.id=r.project_id
    JOIN memberships m ON m.workspace_id=p.workspace_id WHERE r.id=? AND m.user_id=?`).get(runId, userId) as RunRow | undefined;
}

/** Percakapan yang memuat run ini (lewat pesan), bila ada. */
function conversationOfRun(runId: string): string | null {
  const row = db.prepare("SELECT conversation_id AS conversationId FROM messages WHERE run_id=? LIMIT 1").get(runId) as
    { conversationId?: string } | undefined;
  return row?.conversationId ?? null;
}

/** Ringkasan terakhir percakapan — bahan wajib lanjutan supaya tidak mengulang dari nol. */
function lastSummary(conversationId: string | null): string | null {
  if (!conversationId) return null;
  const row = db.prepare("SELECT summary FROM conversation_summaries WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1")
    .get(conversationId) as { summary?: string } | undefined;
  return row?.summary?.trim() || null;
}

/** Galat yang pantas dicoba lagi: proses mati, waktu habis, mesin sibuk. Sisanya permanen. */
function transientFailure(errorCode: string | null): boolean {
  if (!errorCode) return true;
  if (errorCode === "WORKER_LOST") return true;
  return isTransientEngineError(errorCode);
}

type Eligibility = {
  canResume: boolean; canAutoResume: boolean; reason: string; catatan: string;
  conversationId: string | null; modePercakapan: string; ringkasanTerakhir: string | null;
};

/** Aturan kelayakan satu tempat, dipakai rute status, rute resume, dan pemindai otomatis. */
function eligibility(run: RunRow): Eligibility {
  const conversationId = conversationOfRun(run.id);
  const modePercakapan = conversationId
    ? String((db.prepare("SELECT agent_mode AS mode FROM conversations WHERE id=?").get(conversationId) as { mode?: string } | undefined)?.mode ?? "eksekusi")
    : "eksekusi";
  const ringkasan = lastSummary(conversationId);
  const dasar = { conversationId, modePercakapan, ringkasanTerakhir: ringkasan };
  if (run.status !== "failed") {
    return { ...dasar, canResume: false, canAutoResume: false, reason: "RUN_TIDAK_GAGAL", catatan: "Hanya run yang gagal yang bisa dilanjutkan." };
  }
  if (run.resumeState === "resumed") {
    return { ...dasar, canResume: false, canAutoResume: false, reason: "SUDAH_DILANJUTKAN", catatan: "Run ini sudah punya lanjutan." };
  }
  if (!(run.resumeState === "resumable" || transientFailure(run.errorCode))) {
    return { ...dasar, canResume: false, canAutoResume: false, reason: "GALAT_TIDAK_SEMENTARA", catatan: `Gagal karena "${run.errorCode}" — bukan sebab sementara, jadi melanjutkan tidak akan menolong.` };
  }
  if (run.resumeAttempts >= RESUME_MAX_MANUAL) {
    return { ...dasar, canResume: false, canAutoResume: false, reason: "PERCOBAAN_HABIS", catatan: `Lanjutan sudah dicoba ${run.resumeAttempts} kali untuk run ini (batas ${RESUME_MAX_MANUAL}).` };
  }
  const autoBase = run.resumeAttempts < config.RESUME_MAX_AUTO_ATTEMPTS && !run.resumedFrom;
  const canAutoResume = autoBase && modePercakapan !== "diskusi";
  const autoReason = !autoBase
    ? (run.resumedFrom ? "LANJUTAN_DARI_LANJUTAN" : "PERCOBAAN_OTOMATIS_HABIS")
    : (modePercakapan === "diskusi" ? "MODE_DISKUSI" : "");
  return {
    ...dasar, canResume: true, canAutoResume, reason: autoReason,
    catatan: canAutoResume
      ? "Run ditandai bisa dilanjutkan; lanjutan memakai ringkasan terakhir dan tidak mengulang biaya lama."
      : `Bisa dilanjutkan manual, tetapi tidak otomatis (${autoReason}).`,
  };
}

export function resumeStatusFor(runId: string, userId: string): Record<string, unknown> | null {
  const run = runForUser(runId, userId);
  if (!run) return null;
  const info = eligibility(run);
  const biayaSebelumnyaMicros = Number((db.prepare("SELECT COALESCE(SUM(cost_micros),0) AS n FROM run_usage WHERE run_id=?").get(run.id) as { n: number })?.n ?? 0);
  return {
    runId: run.id,
    status: run.status,
    errorCode: run.errorCode,
    resumeState: run.resumeState,
    canResume: info.canResume,
    canAutoResume: info.canAutoResume,
    reason: info.reason,
    attempts: run.resumeAttempts,
    maxAttemptsOtomatis: config.RESUME_MAX_AUTO_ATTEMPTS,
    maxPercobaanManual: RESUME_MAX_MANUAL,
    conversationId: info.conversationId,
    modePercakapan: info.modePercakapan,
    ringkasanTerakhirAda: Boolean(info.ringkasanTerakhir),
    biayaSebelumnyaMicros,
    resumedFrom: run.resumedFrom,
    catatan: info.catatan,
  };
}

/** Kalimat lanjutan: ringkasan terakhir dipakai, langkah yang sudah selesai tidak diulang. */
function resumePrompt(run: RunRow, ringkasan: string | null): { prompt: string; ringkasanDipakai: boolean } {
  const bagian = [
    `Lanjutkan run ${run.id.slice(0, 8)} yang terputus. Jangan mengulang langkah yang sudah selesai; mulai dari titik terakhir.`,
    `Ringkasan terakhir percakapan:\n${ringkasan ?? "(belum ada ringkasan percakapan)"}`,
    `Hasil sebagian run sebelumnya:\n${(run.result ?? "").trim().slice(0, 8_000) || "(tidak ada hasil tersimpan)"}`,
    `Permintaan awal pengguna:\n${run.prompt.slice(0, 4_000)}`,
    "Lanjutkan sekarang dan tutup pekerjaan yang belum selesai.",
  ];
  return { prompt: bagian.join("\n\n"), ringkasanDipakai: Boolean(ringkasan) };
}

export type ResumeStart = {
  ok: boolean; status: number; error?: string; message?: string; body?: Record<string, unknown>;
};

/** Inti tindakan resume; dipakai rute HTTP dan pemindai otomatis supaya keduanya berperilaku sama. */
export async function startResume(runId: string, userId: string, mode: "auto" | "manual"): Promise<ResumeStart> {
  const run = runForUser(runId, userId);
  if (!run) return { ok: false, status: 404, error: "RUN_NOT_FOUND", message: "Run tidak ditemukan." };
  const info = eligibility(run);
  if (mode === "auto" && !info.canAutoResume) {
    return { ok: false, status: 409, error: "RESUME_ATTEMPTS_EXHAUSTED", message: `Lanjutan otomatis tidak dijalankan (${info.reason}).`, body: { reason: info.reason, catatan: info.catatan } };
  }
  if (!info.canResume) {
    return { ok: false, status: 409, error: "RESUME_NOT_AVAILABLE", message: info.catatan, body: { reason: info.reason } };
  }
  const { prompt, ringkasanDipakai } = resumePrompt(run, info.ringkasanTerakhir);
  const hasil = await createRunAndDispatch({
    projectId: run.projectId,
    prompt,
    userId,
    conversationId: info.conversationId,
    model: run.model,
    thinking: run.thinkingLevel,
    personaId: run.personaId,
    // Penanda otonom dibawa apa adanya dari run lama; TIDAK diambil dari bawaan akun (butir 83 ②).
    autonomous: Boolean(run.autonomous),
    resumedFrom: run.id,
  });
  db.prepare("UPDATE runs SET resume_state='resumed', resume_attempts=resume_attempts+1 WHERE id=?").run(run.id);
  // Percakapan melihat jejak singkat, supaya jawaban lanjutan tidak muncul tanpa penjelasan.
  if (info.conversationId) {
    db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), info.conversationId, "user",
        `Lanjutan run ${run.id.slice(0, 8)} (${mode}). Ringkasan terakhir dipakai; langkah yang sudah selesai tidak diulang.`,
        hasil.runId, new Date().toISOString());
  }
  audit(userId, "run.resumed", {
    runId: run.id, lanjutanRunId: hasil.runId, mode, ringkasanDipakai, jalur: hasil.jalur,
    biayaSebelumnyaMicros: Number((db.prepare("SELECT COALESCE(SUM(cost_micros),0) AS n FROM run_usage WHERE run_id=?").get(run.id) as { n: number })?.n ?? 0),
  });
  return {
    ok: true, status: 202,
    body: {
      runId: hasil.runId, resumedFrom: run.id, mode, status: "queued", jalur: hasil.jalur,
      ringkasanDipakai, conversationId: info.conversationId,
      catatan: "Run lama tidak dihitung ulang: biaya hanya bertambah dari run lanjutan ini.",
    },
  };
}

/** Menandai satu run yang sudah gagal sebagai bisa dilanjutkan. */
export function markRunResumable(runId: string): boolean {
  const row = db.prepare("SELECT status, resume_state AS resumeState FROM runs WHERE id=?").get(runId) as
    { status?: string; resumeState?: string } | undefined;
  if (!row) return false;
  if (row.status !== "failed") return false;
  if (row.resumeState === "resumed") return false;
  db.prepare("UPDATE runs SET resume_state='resumable' WHERE id=?").run(runId);
  return true;
}

/**
 * Pemindai run yang putus. Memakai aturan sewa yang sama dengan `reapAbandonedRuns`, jadi run yang
 * masih di dalam masa sewa (mungkin masih dikerjakan proses lain) tidak pernah ditandai.
 */
export function markInterruptedRuns(now: Date = new Date()): number {
  const report = reapAbandonedRuns(now);
  let marked = 0;
  for (const run of report.runs) if (markRunResumable(run.id)) marked += 1;
  return marked;
}

export type AutoResumeReport = {
  diperiksa: number; dilanjutkan: { runId: string; lanjutanRunId: string }[];
  dilewati: { runId: string; reason: string }[]; tandaiBaru: number;
};

/** Percobaan lanjutan otomatis, maksimum `RESUME_MAX_AUTO_ATTEMPTS` per run. */
export async function attemptAutoResumes(now: Date = new Date()): Promise<AutoResumeReport> {
  const tandaiBaru = markInterruptedRuns(now);
  const rows = db.prepare("SELECT r.id, r.resume_state AS resumeState, r.resume_attempts AS attempts, r.resumed_from AS resumedFrom, r.project_id AS projectId FROM runs r WHERE r.status='failed' AND r.resume_state='resumable'").all() as any[];
  const dilanjutkan: { runId: string; lanjutanRunId: string }[] = [];
  const dilewati: { runId: string; reason: string }[] = [];
  for (const row of rows) {
    const owner = db.prepare(`SELECT m.user_id AS userId FROM memberships m JOIN projects p ON p.workspace_id=m.workspace_id WHERE p.id=? ORDER BY (m.role='owner') DESC LIMIT 1`).get(row.projectId) as { userId?: string } | undefined;
    if (!owner?.userId) { dilewati.push({ runId: String(row.id), reason: "PEMILIK_TIDAK_DITEMUKAN" }); continue; }
    const hasil = await startResume(String(row.id), String(owner.userId), "auto");
    if (hasil.ok) dilanjutkan.push({ runId: String(row.id), lanjutanRunId: String(hasil.body?.runId ?? "") });
    else dilewati.push({ runId: String(row.id), reason: String(hasil.body?.reason ?? hasil.error ?? "TIDAK_DILANJUTKAN") });
  }
  return { diperiksa: rows.length, dilanjutkan, dilewati, tandaiBaru };
}

/** Rute HTTP butir 63: status lanjutan + permintaan melanjutkan. */
export function registerResumeRoutes(app: any): void {
  app.get("/api/v1/runs/:runId/resume-status", { preHandler: requireUser }, async (request: any, reply: any) => {
    const status = resumeStatusFor(request.params.runId, request.user!.id);
    if (!status) return fail(reply, 404, "RUN_NOT_FOUND", "Run tidak ditemukan.");
    return status;
  });

  app.post("/api/v1/runs/:runId/resume", { preHandler: requireUser }, async (request: any, reply: any) => {
    const run = runForUser(request.params.runId, request.user!.id);
    if (!run) return fail(reply, 404, "RUN_NOT_FOUND", "Run tidak ditemukan.");
    if (!mayWrite(run.role)) return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran Anda hanya bisa melihat, tidak menjalankan run.");
    const mode = request.body?.mode === "auto" ? "auto" : "manual";
    const hasil = await startResume(request.params.runId, request.user!.id, mode);
    if (!hasil.ok) return reply.code(hasil.status).send({ error: hasil.error, message: hasil.message, ...(hasil.body ?? {}) });
    return reply.code(hasil.status).send(hasil.body);
  });
}

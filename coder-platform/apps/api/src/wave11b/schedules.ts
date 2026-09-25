/**
 * Wave 11B (butir 72): jadwal prompt bebas.
 *
 * Keputusan penting:
 * - Tidak ada penjadwal baru. Tabel `prompt_schedules` menyimpan jadwal, dan eksekusinya menumpang
 *   pekerja `jobs` (`schedule.run`, tiap 60 detik) dengan pemeriksa waktu dari `cron.ts`.
 * - Zona waktu DISIMPAN per jadwal (bawaan `Asia/Jakarta`) dan `next_run_at` dihitung pada zona itu,
 *   bukan pada jam server. `cron.ts` bekerja pada jam UTC, jadi jam lokal dihitung ulang di sini.
 * - Perilaku saat percakapan mode diskusi mengikuti matriks perilaku butir 83 ①: jadwal DILEWATI,
 *   tidak ada run, tidak ada biaya — bukan "tetap jalan lalu ditolak".
 * - Penanda otonom hanya dari kolom `autonomous` jadwal (butir 83 ②).
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { describeCron, nextCronRun, validateCronExpression } from "../cron.js";
import { requireUser } from "../auth.js";
import { audit, fail, mayWrite } from "../wave11a/shared.js";
import { createRunAndDispatch, isKnownModelName, isThinkingLevelName, projectOfConversation } from "./dispatch.js";

const DEFAULT_TZ = config.SCHEDULE_DEFAULT_TIMEZONE;
const MAX_PROMPT_CHARS = 8_000;

/** Zona waktu sah bila `Intl` mengenalinya. */
export function timezoneValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Selisih zona waktu terhadap UTC (ms) pada satu saat. */
export function zoneOffsetMs(timezone: string, at: Date): number {
  // Detik dan milidetik dibuang dulu: sisa milidetik akan membuat selisih zona tidak bulat
  // (mis. 25199628 ms alih-alih 25200000 ms untuk +7 jam).
  const dasar = Math.floor(at.getTime() / 1000) * 1000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(dasar));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour") % 24, pick("minute"), pick("second"));
  return asUtc - dasar;
}

/**
 * Waktu jalan berikutnya pada zona waktu jadwal. Jam lokal dihitung dengan menggeser UTC sebesar
 * selisih zona; karena selisih bisa berubah saat pergantian waktu musim (DST), hasilnya diulang
 * maksimum tiga kali sampai selisihnya stabil.
 */
export function nextRunInZone(expr: string, timezone: string, from: Date = new Date()): string | null {
  const zone = timezone || DEFAULT_TZ;
  if (!timezoneValid(zone)) return null;
  // Waktu acuan dipotong ke menit penuh: hasil cron harus menunjuk detik ke-0, bukan mewarisi
  // detik/milidetik pemanggil.
  const acuan = new Date(Math.floor(from.getTime() / 60_000) * 60_000);
  let offset = zoneOffsetMs(zone, acuan);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wall = new Date(acuan.getTime() + offset);
    const nextWall = nextCronRun(expr, wall);
    if (!nextWall) return null;
    const candidate = Math.floor((new Date(nextWall).getTime() - offset) / 60_000) * 60_000;
    const offsetThen = zoneOffsetMs(zone, new Date(candidate));
    if (offsetThen === offset) return new Date(candidate).toISOString();
    offset = offsetThen;
  }
  return null;
}

type ScheduleRow = {
  id: string; userId: string; projectId: string | null; conversationId: string | null; prompt: string; cron: string;
  timezone: string; model: string | null; thinking: string; autonomous: number; enabled: number;
  lastRunAt: string | null; nextRunAt: string | null; createdAt: string; updatedAt: string;
};

const SCHEDULE_COLUMNS = `id, user_id AS userId, project_id AS projectId, conversation_id AS conversationId, prompt, cron,
  timezone, model, thinking, autonomous, enabled, last_run_at AS lastRunAt, next_run_at AS nextRunAt,
  created_at AS createdAt, updated_at AS updatedAt`;

function scheduleView(row: ScheduleRow) {
  return {
    id: row.id, prompt: row.prompt, cron: row.cron, cronText: describeCron(row.cron), timezone: row.timezone,
    projectId: row.projectId, conversationId: row.conversationId, model: row.model, thinking: row.thinking,
    autonomous: Boolean(row.autonomous), enabled: Boolean(row.enabled),
    lastRunAt: row.lastRunAt, nextRunAt: row.nextRunAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

function scheduleForUser(id: string, userId: string): ScheduleRow | undefined {
  return db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM prompt_schedules WHERE id=? AND user_id=?`).get(id, userId) as ScheduleRow | undefined;
}

function countSchedules(userId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM prompt_schedules WHERE user_id=?").get(userId) as { n: number })?.n ?? 0);
}

/** Proyek tujuan: dari percakapan bila hanya percakapan yang diisi. */
function resolveTargets(userId: string, projectId?: string | null, conversationId?: string | null): { projectId: string | null; conversationId: string | null; error?: string } {
  const conversation = conversationId?.trim() || null;
  if (conversation) {
    const allowed = db.prepare(`SELECT c.id, c.project_id AS projectId FROM conversations c JOIN projects p ON p.id=c.project_id
      JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?`).get(conversation, userId) as { id: string; projectId: string } | undefined;
    if (!allowed) return { projectId: null, conversationId: conversation, error: "CONVERSATION_NOT_FOUND" };
    return { projectId: projectId?.trim() || allowed.projectId, conversationId: conversation };
  }
  const project = projectId?.trim() || null;
  if (!project) return { projectId: null, conversationId: null, error: "SCHEDULE_PROJECT_REQUIRED" };
  const allowed = db.prepare("SELECT p.id FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(project, userId);
  if (!allowed) return { projectId: null, conversationId: null, error: "PROJECT_NOT_FOUND" };
  return { projectId: project, conversationId: null };
}

/** Membuat run untuk satu jadwal, dengan aturan matriks butir 83 sudah diperiksa pemanggil. */
async function runSchedule(row: ScheduleRow, now: Date, mode: "terjadwal" | "manual"): Promise<{ dijalankan: boolean; alasan: string; runId: string | null; catatan: string }> {
  const { decideScheduledExecution } = await import("./behavior-matrix.js");
  const keputusan = decideScheduledExecution({ conversationId: row.conversationId, autonomousRequested: Boolean(row.autonomous) });
  if (!keputusan.dijalankan) return { dijalankan: false, alasan: keputusan.alasan, runId: null, catatan: keputusan.catatan };
  const projectId = row.projectId ?? (row.conversationId ? projectOfConversation(row.conversationId) : null);
  if (!projectId) return { dijalankan: false, alasan: "PROYEK_TIDAK_DITEMUKAN", runId: null, catatan: "Jadwal ini tidak punya proyek tujuan yang sah." };
  const hasil = await createRunAndDispatch({
    projectId, prompt: row.prompt, userId: row.userId, conversationId: row.conversationId,
    model: row.model, thinking: row.thinking, personaId: null, autonomous: Boolean(row.autonomous),
  });
  audit(row.userId, "schedule.triggered", { scheduleId: row.id, mode, runId: hasil.runId, jalur: hasil.jalur, autonomous: Boolean(row.autonomous) });
  return { dijalankan: true, alasan: "", runId: hasil.runId, catatan: keputusan.catatan };
}

/** Waktu jalan dicatat apa pun hasilnya, supaya jadwal yang dilewati tidak mencoba terus-menerus. */
function advance(row: ScheduleRow, now: Date): void {
  const next = row.enabled ? nextRunInZone(row.cron, row.timezone, now) : null;
  db.prepare("UPDATE prompt_schedules SET last_run_at=?, next_run_at=?, updated_at=? WHERE id=?").run(now.toISOString(), next, now.toISOString(), row.id);
}

/**
 * Pekerja `schedule.run`: menjalankan jadwal yang sudah waktunya satu kali.
 * `dilewati` dikembalikan apa adanya supaya pemanggil (server.ts) dapat mencatat jejaknya.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<{
  due: number; dijalankan: number; dilewati: { scheduleId: string; userId: string; reason: string }[];
}> {
  const stamp = now.toISOString();
  // `next_run_at` kosong pada jadwal lama: isi dulu supaya tidak langsung jalan bersamaan.
  const belumPunyaWaktu = db.prepare("SELECT id, cron, timezone FROM prompt_schedules WHERE enabled=1 AND next_run_at IS NULL").all() as { id: string; cron: string; timezone: string }[];
  for (const row of belumPunyaWaktu) {
    db.prepare("UPDATE prompt_schedules SET next_run_at=? WHERE id=?").run(nextRunInZone(row.cron, row.timezone, now), row.id);
  }
  const due = db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM prompt_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50`)
    .all(stamp) as ScheduleRow[];
  let dijalankan = 0;
  const dilewati: { scheduleId: string; userId: string; reason: string }[] = [];
  for (const row of due) {
    const hasil = await runSchedule(row, now, "terjadwal");
    advance(row, now);
    if (hasil.dijalankan) dijalankan += 1;
    else dilewati.push({ scheduleId: row.id, userId: row.userId, reason: hasil.alasan });
  }
  return { due: due.length, dijalankan, dilewati };
}

/** Rute HTTP butir 72. */
export function registerScheduleRoutes(app: any): void {
  app.get("/api/v1/schedules", { preHandler: requireUser }, async (request: any) => {
    const rows = db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM prompt_schedules WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).all(request.user!.id) as ScheduleRow[];
    return {
      schedules: rows.map(scheduleView),
      total: rows.length, limit: config.SCHEDULE_LIMIT, defaultTimezone: DEFAULT_TZ,
      help: "Jadwal memakai 5 kolom cron (menit jam tanggal bulan hari) pada zona waktu jadwal, contoh: 0 7 * * * = setiap hari pukul 07:00.",
    };
  });

  app.post("/api/v1/schedules", { preHandler: requireUser }, async (request: any, reply: any) => {
    const body = request.body ?? {};
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return fail(reply, 400, "SCHEDULE_PROMPT_REQUIRED", "Perintah jadwal belum diisi.");
    if (prompt.length > MAX_PROMPT_CHARS) return fail(reply, 400, "SCHEDULE_PROMPT_TOO_LONG", `Perintah jadwal maksimal ${MAX_PROMPT_CHARS} karakter.`);
    const cron = String(body.cron ?? "").trim();
    const checked = validateCronExpression(cron);
    if (!checked.ok) return fail(reply, 400, "CRON_INVALID", "Format jadwal tidak sah. Contoh: 0 7 * * *", { detail: checked.error });
    const timezone = String(body.timezone ?? DEFAULT_TZ).trim() || DEFAULT_TZ;
    if (!timezoneValid(timezone)) return fail(reply, 400, "INVALID_TIMEZONE", `Zona waktu "${timezone}" tidak dikenal. Contoh: Asia/Jakarta.`);
    const model = body.model ? String(body.model).trim() : null;
    if (model && !isKnownModelName(model)) return fail(reply, 400, "INVALID_MODEL", "Model yang diminta tidak dikenal mesin.");
    const thinking = body.thinking ? String(body.thinking).trim() : "medium";
    if (!isThinkingLevelName(thinking)) return fail(reply, 400, "INVALID_THINKING_LEVEL", "Tingkat berpikir tidak dikenal.");
    const target = resolveTargets(request.user!.id, body.projectId, body.conversationId);
    if (target.error) return fail(reply, 400, target.error, target.error === "SCHEDULE_PROJECT_REQUIRED" ? "Jadwal wajib punya proyek atau percakapan tujuan." : "Tujuan jadwal tidak ditemukan.");
    if (countSchedules(request.user!.id) >= config.SCHEDULE_LIMIT) {
      return fail(reply, 400, "SCHEDULE_LIMIT_REACHED", `Jadwal maksimal ${config.SCHEDULE_LIMIT} buah per akun.`);
    }
    const now = new Date();
    const id = randomUUID();
    db.prepare(`INSERT INTO prompt_schedules
      (id, user_id, project_id, conversation_id, prompt, cron, timezone, model, thinking, autonomous, enabled, last_run_at, next_run_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`)
      .run(id, request.user!.id, target.projectId, target.conversationId, prompt, cron, timezone, model, thinking,
        body.autonomous ? 1 : 0, body.enabled === false ? 0 : 1, nextRunInZone(cron, timezone, now), now.toISOString(), now.toISOString());
    const row = scheduleForUser(id, request.user!.id)!;
    audit(request.user!.id, "schedule.created", { scheduleId: id, cron, timezone, autonomous: Boolean(row.autonomous), conversationId: target.conversationId });
    return reply.code(201).send({ schedule: scheduleView(row) });
  });

  app.patch("/api/v1/schedules/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = scheduleForUser(request.params.id, request.user!.id);
    if (!row) return fail(reply, 404, "SCHEDULE_NOT_FOUND", "Jadwal tidak ditemukan.");
    const body = request.body ?? {};
    const patch: Record<string, unknown> = {};
    if (body.prompt !== undefined) {
      const prompt = String(body.prompt).trim();
      if (!prompt) return fail(reply, 400, "SCHEDULE_PROMPT_REQUIRED", "Perintah jadwal belum diisi.");
      if (prompt.length > MAX_PROMPT_CHARS) return fail(reply, 400, "SCHEDULE_PROMPT_TOO_LONG", `Perintah jadwal maksimal ${MAX_PROMPT_CHARS} karakter.`);
      patch.prompt = prompt;
    }
    if (body.cron !== undefined) {
      const cron = String(body.cron).trim();
      const checked = validateCronExpression(cron);
      if (!checked.ok) return fail(reply, 400, "CRON_INVALID", "Format jadwal tidak sah. Contoh: 0 7 * * *", { detail: checked.error });
      patch.cron = cron;
    }
    if (body.timezone !== undefined) {
      const timezone = String(body.timezone).trim();
      if (!timezoneValid(timezone)) return fail(reply, 400, "INVALID_TIMEZONE", `Zona waktu "${timezone}" tidak dikenal. Contoh: Asia/Jakarta.`);
      patch.timezone = timezone;
    }
    if (body.model !== undefined) {
      const model = body.model ? String(body.model).trim() : null;
      if (model && !isKnownModelName(model)) return fail(reply, 400, "INVALID_MODEL", "Model yang diminta tidak dikenal mesin.");
      patch.model = model;
    }
    if (body.thinking !== undefined) {
      const thinking = String(body.thinking).trim();
      if (!isThinkingLevelName(thinking)) return fail(reply, 400, "INVALID_THINKING_LEVEL", "Tingkat berpikir tidak dikenal.");
      patch.thinking = thinking;
    }
    if (body.autonomous !== undefined) patch.autonomous = body.autonomous ? 1 : 0;
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
    const keys = Object.keys(patch);
    if (!keys.length) return fail(reply, 400, "NOTHING_TO_UPDATE", "Tidak ada perubahan yang dikirim.");
    const now = new Date();
    const cron = String(patch.cron ?? row.cron);
    const timezone = String(patch.timezone ?? row.timezone);
    const enabled = Number(patch.enabled ?? row.enabled);
    const nextRunAt = enabled ? nextRunInZone(cron, timezone, now) : null;
    db.prepare(`UPDATE prompt_schedules SET ${keys.map((key) => `${key}=?`).join(", ")}, next_run_at=?, updated_at=? WHERE id=? AND user_id=?`)
      .run(...keys.map((key) => patch[key] ?? null), nextRunAt, now.toISOString(), row.id, request.user!.id);
    audit(request.user!.id, "schedule.updated", { scheduleId: row.id, fields: keys });
    return { schedule: scheduleView(scheduleForUser(row.id, request.user!.id)!) };
  });

  app.delete("/api/v1/schedules/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = scheduleForUser(request.params.id, request.user!.id);
    if (!row) return fail(reply, 404, "SCHEDULE_NOT_FOUND", "Jadwal tidak ditemukan.");
    db.prepare("DELETE FROM prompt_schedules WHERE id=? AND user_id=?").run(row.id, request.user!.id);
    audit(request.user!.id, "schedule.deleted", { scheduleId: row.id });
    return { deleted: true, scheduleId: row.id };
  });

  /**
   * Menjalankan jadwal sekarang. Percakapan mode diskusi TIDAK membuat run: balasannya menjelaskan
   * alasannya (butir 83 ①), bukan gagal diam-diam.
   */
  app.post("/api/v1/schedules/:id/run-now", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = scheduleForUser(request.params.id, request.user!.id);
    if (!row) return fail(reply, 404, "SCHEDULE_NOT_FOUND", "Jadwal tidak ditemukan.");
    if (!mayWrite("owner")) return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran Anda hanya bisa melihat.");
    const now = new Date();
    const hasil = await runSchedule(row, now, "manual");
    db.prepare("UPDATE prompt_schedules SET last_run_at=?, updated_at=? WHERE id=?").run(now.toISOString(), now.toISOString(), row.id);
    if (!hasil.dijalankan) {
      return reply.code(200).send({ dijalankan: false, alasan: hasil.alasan, runId: null, catatan: hasil.catatan });
    }
    return reply.code(202).send({ dijalankan: true, runId: hasil.runId, alasan: "", catatan: hasil.catatan });
  });
}

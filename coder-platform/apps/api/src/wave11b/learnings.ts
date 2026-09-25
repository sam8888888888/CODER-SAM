/**
 * Wave 11B (60) — Learnings Registry.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 60; jangan diubah pemilik butir lain.
 *
 * Pelajaran TIDAK memakai tabel baru: ia memakai `agent_memories` dengan `kind='learning'`. Karena
 * bank memori biasa (`kind='memory'`) hidup di tabel yang sama, setiap kueri di berkas ini menuliskan
 * `kind` secara eksplisit — itu yang menjamin menyalakan/mematikan pelajaran tidak mengubah memori.
 * Batasnya mengikuti gaya skill pengguna (wave11a/skills.ts): maksimal 12 pelajaran aktif yang
 * disuntikkan, dan 50 butir total per akun. Angka 50 dipakai karena `config` tidak punya kunci
 * khusus untuk pelajaran; jumlah ini disamakan dengan batas impor persona (PERSONA_IMPORT_LIMIT)
 * supaya satu akun tidak bisa menumpuk konteks tanpa batas.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { audit, fail } from "../wave11a/shared.js";

/** Maksimum butir pelajaran per akun (lihat catatan di atas: config tidak punya kunci khusus). */
export const LEARNING_MAX_TOTAL = 50;
/** Maksimum pelajaran aktif yang ikut disuntikkan, sama seperti 12 memori yang disuntik. */
export const LEARNING_ACTIVE_LIMIT = 12;
/** Pagar isi blok pelajaran; pelajaran yang tidak muat dilewati, bukan dikirim sebagian. */
export const LEARNING_BLOCK_CHARS_LIMIT = 4000;

export type Learning = {
  id: string; userId: string; title: string; body: string; tags: string;
  pinned: number; enabled: number; useCount: number; createdAt: string; updatedAt: string;
};

const SELECT_LEARNING = `SELECT id, user_id AS userId, title, body, tags, pinned, enabled, use_count AS useCount,
  created_at AS createdAt, updated_at AS updatedAt FROM agent_memories`;
const DARI_PELAJARAN = "WHERE kind='learning'";

export function listLearnings(userId: string): Learning[] {
  return db.prepare(`${SELECT_LEARNING} ${DARI_PELAJARAN} AND user_id=? ORDER BY pinned DESC, updated_at DESC`).all(userId) as Learning[];
}

function readLearning(userId: string, id: string): Learning | null {
  return (db.prepare(`${SELECT_LEARNING} ${DARI_PELAJARAN} AND user_id=? AND id=?`).get(userId, id) as Learning | undefined) ?? null;
}

export function countLearnings(userId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE kind='learning' AND user_id=?").get(userId) as { n: number }).n ?? 0);
}

/**
 * Blok konteks pelajaran, mengikuti bentuk userSkillsBlock di wave11a/skills.ts supaya ikut pagar
 * konteks butir 80. Isi dipotong pada batas LEARNING_BLOCK_CHARS_LIMIT; pelajaran yang tidak muat
 * dilewati (tidak dikirim sebagian) dan jumlah yang benar-benar dikirim dikembalikan lewat `learnings`.
 */
export function learningBlocks(userId: string): { block: string; learnings: { id: string }[] } {
  if (!userId) return { block: "", learnings: [] };
  const rows = db.prepare(`${SELECT_LEARNING} ${DARI_PELAJARAN} AND user_id=? AND enabled=1 ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
    .all(userId, LEARNING_ACTIVE_LIMIT) as Learning[];
  const kept: Learning[] = [];
  let chars = 0;
  for (const row of rows) {
    const satuBaris = `- ${row.title}: ${String(row.body).replace(/\s+/g, " ").slice(0, 400)}`;
    if (chars + satuBaris.length > LEARNING_BLOCK_CHARS_LIMIT) continue;
    chars += satuBaris.length;
    kept.push(row);
  }
  if (!kept.length) return { block: "", learnings: [] };
  const baris = kept.map((row) => `- ${row.title}: ${String(row.body).replace(/\s+/g, " ").slice(0, 400)}`);
  const block = `Pelajaran dari sesi sebelumnya (pakai bila relevan, jangan dibacakan mentah):\n${baris.join("\n")}`;
  return { block, learnings: kept.map((row) => ({ id: row.id })) };
}

/** Menambah penghitung pemakaian saat pelajaran benar-benar ikut dikirim ke mesin. */
export function touchLearnings(userId: string, ids: string[]): void {
  if (!ids?.length) return;
  try {
    const statement = db.prepare("UPDATE agent_memories SET use_count = use_count + 1 WHERE id=? AND user_id=? AND kind='learning'");
    for (const id of ids) statement.run(id, userId);
  } catch {
    // Penghitung pemakaian tidak boleh menggagalkan run.
  }
}

/** Memasang rute pelajaran: GET/POST /api/v1/learnings, PATCH/DELETE /api/v1/learnings/:id. */
export function registerLearningsRoutes(app: any): void {
  app.get("/api/v1/learnings", { preHandler: requireUser }, async (request: any) => {
    const userId = request.user!.id;
    const learnings = listLearnings(userId);
    return {
      learnings,
      total: learnings.length,
      activeCount: learnings.filter((row) => row.enabled).length,
      activeLimit: LEARNING_ACTIVE_LIMIT,
      maxTotal: LEARNING_MAX_TOTAL,
      help: `Pelajaran terpisah dari bank memori. Maksimal ${LEARNING_MAX_TOTAL} butir, dan maksimal ${LEARNING_ACTIVE_LIMIT} pelajaran aktif ikut dikirim ke mesin.`,
    };
  });

  app.post("/api/v1/learnings", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const title = String(request.body?.title ?? "").trim().slice(0, 200);
    const body = String(request.body?.body ?? "").trim().slice(0, 8000);
    if (!title || !body) return fail(reply, 400, "INVALID_LEARNING", "Judul dan isi pelajaran wajib diisi.");
    if (countLearnings(userId) >= LEARNING_MAX_TOTAL) return fail(reply, 400, "LEARNINGS_LIMIT_REACHED", `Pelajaran maksimal ${LEARNING_MAX_TOTAL} butir.`);
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_memories (id,user_id,workspace_id,title,body,tags,pinned,enabled,use_count,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,'learning',?,?)")
      .run(id, userId, null, title, body, String(request.body?.tags ?? "").trim().slice(0, 200), request.body?.pinned ? 1 : 0, 1, now, now);
    audit(userId, "learning.created", { learningId: id, title });
    return reply.code(201).send({ learning: readLearning(userId, id) });
  });

  app.patch("/api/v1/learnings/:learningId", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const learning = readLearning(userId, request.params.learningId);
    if (!learning) return fail(reply, 404, "LEARNING_NOT_FOUND", "Pelajaran tidak ditemukan.");
    const patch = request.body ?? {};
    const title = patch.title !== undefined ? String(patch.title).trim().slice(0, 200) : undefined;
    if (title === "") return fail(reply, 400, "INVALID_LEARNING", "Judul dan isi pelajaran wajib diisi.");
    if (patch.body !== undefined && !String(patch.body).trim()) return fail(reply, 400, "INVALID_LEARNING", "Judul dan isi pelajaran wajib diisi.");
    db.prepare(`UPDATE agent_memories SET title=COALESCE(?,title), body=COALESCE(?,body), tags=COALESCE(?,tags),
      pinned=COALESCE(?,pinned), enabled=COALESCE(?,enabled), updated_at=? WHERE id=? AND user_id=? AND kind='learning'`)
      .run(title ?? null, patch.body !== undefined ? String(patch.body).trim().slice(0, 8000) : null,
        patch.tags !== undefined ? String(patch.tags).trim().slice(0, 200) : null,
        patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : null,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : null,
        new Date().toISOString(), learning.id, userId);
    audit(userId, "learning.updated", { learningId: learning.id, enabled: patch.enabled });
    return { learning: readLearning(userId, learning.id) };
  });

  app.delete("/api/v1/learnings/:learningId", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const learning = readLearning(userId, request.params.learningId);
    if (!learning) return fail(reply, 404, "LEARNING_NOT_FOUND", "Pelajaran tidak ditemukan.");
    db.prepare("DELETE FROM agent_memories WHERE id=? AND user_id=? AND kind='learning'").run(learning.id, userId);
    audit(userId, "learning.deleted", { learningId: learning.id, title: learning.title });
    return { deleted: true, id: learning.id };
  });
}

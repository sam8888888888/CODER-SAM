/**
 * Wave 11A (butir 51): Skill milik pengguna.
 *
 * Skill adalah instruksi tambahan yang dipasang sendiri oleh pengguna. Batasnya ketat supaya tidak
 * ada akun yang membengkakkan konteks: maksimal 8 skill aktif dan total 4.000 karakter isi aktif.
 * Isi skill aktif disisipkan setelah memori yang dipin.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { audit, fail } from "./shared.js";

export const USER_SKILL_ACTIVE_LIMIT = 8;
export const USER_SKILL_CHARS_LIMIT = 4000;

export type UserSkill = {
  id: string; userId: string; name: string; description: string; content: string;
  enabled: number; useCount: number; createdAt: string; updatedAt: string;
};

const SELECT_SKILL = "SELECT id, user_id AS userId, name, description, content, enabled, use_count AS useCount, created_at AS createdAt, updated_at AS updatedAt FROM user_skills";

export function listUserSkills(userId: string): UserSkill[] {
  return db.prepare(`${SELECT_SKILL} WHERE user_id=? ORDER BY enabled DESC, updated_at DESC`).all(userId) as UserSkill[];
}

export function activeUserSkills(userId: string): UserSkill[] {
  return db.prepare(`${SELECT_SKILL} WHERE user_id=? AND enabled=1 ORDER BY updated_at DESC`).all(userId) as UserSkill[];
}

/**
 * Blok untuk `appendSystem[]`. Isi dipotong pada batas total 4.000 karakter; skill yang tidak muat
 * dilewati dan dilaporkan (bukan dikirim sebagian tanpa jejak).
 */
export function userSkillsBlock(userId: string): { block: string | null; chars: number; skills: { id: string; name: string }[]; activeChars: number; trimmed: boolean; dropped: string[] } {
  const rows = activeUserSkills(userId);
  const activeChars = rows.reduce((total, row) => total + row.content.length, 0);
  const kept: UserSkill[] = []; const dropped: string[] = [];
  let chars = 0;
  for (const row of rows) {
    if (chars + row.content.length > USER_SKILL_CHARS_LIMIT) { dropped.push(row.name); continue; }
    chars += row.content.length; kept.push(row);
  }
  if (!kept.length) return { block: null, chars: 0, skills: [], activeChars, trimmed: dropped.length > 0, dropped };
  const block = `Skill yang dipasang pengguna ini (pakai bila relevan):\n${kept.map((row) => `- ${row.name}: ${String(row.content).replace(/\s+/g, " ")}`).join("\n")}`;
  return { block, chars: block.length, skills: kept.map((row) => ({ id: row.id, name: row.name })), activeChars, trimmed: dropped.length > 0, dropped };
}

/** Menambah penghitung pemakaian saat skill benar-benar ikut dikirim ke mesin. */
export function touchUserSkills(userId: string, ids: string[]): void {
  if (!ids.length) return;
  const statement = db.prepare("UPDATE user_skills SET use_count = use_count + 1 WHERE id=? AND user_id=?");
  for (const id of ids) statement.run(id, userId);
}

function readSkill(userId: string, id: string): UserSkill | null {
  return (db.prepare(`${SELECT_SKILL} WHERE id=? AND user_id=?`).get(id, userId) as UserSkill | undefined) ?? null;
}

/** Berapa karakter yang sudah terpakai oleh skill aktif, tanpa menghitung satu skill tertentu. */
export function activeSkillChars(userId: string, excludeId?: string): number {
  return activeUserSkills(userId).filter((row) => row.id !== excludeId).reduce((total, row) => total + row.content.length, 0);
}

export function activeSkillCount(userId: string, excludeId?: string): number {
  return activeUserSkills(userId).filter((row) => row.id !== excludeId).length;
}

function nameTaken(userId: string, name: string, excludeId?: string): boolean {
  const row = db.prepare("SELECT id FROM user_skills WHERE user_id=? AND lower(name)=lower(?)").get(userId, name) as { id: string } | undefined;
  return Boolean(row && row.id !== excludeId);
}

export function registerUserSkillRoutes(app: any): void {
  app.get("/api/v1/skills/mine", { preHandler: requireUser }, async (request: any) => {
    const userId = request.user!.id;
    const skills = listUserSkills(userId);
    return {
      skills, activeLimit: USER_SKILL_ACTIVE_LIMIT, charsLimit: USER_SKILL_CHARS_LIMIT,
      activeCount: skills.filter((row) => row.enabled).length,
      activeChars: skills.filter((row) => row.enabled).reduce((total, row) => total + row.content.length, 0),
      help: `Maksimal ${USER_SKILL_ACTIVE_LIMIT} skill aktif dengan total isi ${USER_SKILL_CHARS_LIMIT} karakter. Halaman Kapabilitas tetap menampilkan 22 kapabilitas statis.`,
    };
  });

  app.post("/api/v1/skills/mine", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const name = String(request.body?.name ?? "").trim();
    const content = String(request.body?.content ?? "").trim();
    const description = String(request.body?.description ?? "").trim().slice(0, 300);
    if (!name) return fail(reply, 400, "INVALID_SKILL_NAME", "Nama skill wajib diisi.");
    if (name.length > 60) return fail(reply, 400, "INVALID_SKILL_NAME", "Nama skill maksimal 60 karakter.");
    if (!content) return fail(reply, 400, "INVALID_SKILL_CONTENT", "Isi skill wajib diisi.");
    if (nameTaken(userId, name)) return fail(reply, 409, "SKILL_NAME_TAKEN", "Nama skill sudah dipakai. Pakai nama lain atau ubah skill yang ada.");
    const enabled = request.body?.enabled === false ? 0 : 1;
    if (enabled) {
      if (activeSkillCount(userId) >= USER_SKILL_ACTIVE_LIMIT) return fail(reply, 400, "SKILL_LIMIT_REACHED", `Maksimal ${USER_SKILL_ACTIVE_LIMIT} skill aktif.`);
      if (activeSkillChars(userId) + content.length > USER_SKILL_CHARS_LIMIT) return fail(reply, 400, "SKILL_TOO_LONG", `Total isi skill aktif maksimal ${USER_SKILL_CHARS_LIMIT} karakter.`);
    }
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare("INSERT INTO user_skills (id,user_id,name,description,content,enabled,use_count,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)")
      .run(id, userId, name, description, content, enabled, now, now);
    audit(userId, "skill.created", { skillId: id, name, enabled });
    return reply.code(201).send({ skill: readSkill(userId, id) });
  });

  app.patch("/api/v1/skills/mine/:skillId", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const skill = readSkill(userId, request.params.skillId);
    if (!skill) return fail(reply, 404, "SKILL_NOT_FOUND", "Skill tidak ditemukan.");
    const next = {
      name: request.body?.name !== undefined ? String(request.body.name).trim() : skill.name,
      description: request.body?.description !== undefined ? String(request.body.description).trim().slice(0, 300) : skill.description,
      content: request.body?.content !== undefined ? String(request.body.content).trim() : skill.content,
      enabled: request.body?.enabled !== undefined ? (request.body.enabled ? 1 : 0) : skill.enabled,
    };
    if (!next.name) return fail(reply, 400, "INVALID_SKILL_NAME", "Nama skill wajib diisi.");
    if (!next.content) return fail(reply, 400, "INVALID_SKILL_CONTENT", "Isi skill wajib diisi.");
    if (nameTaken(userId, next.name, skill.id)) return fail(reply, 409, "SKILL_NAME_TAKEN", "Nama skill sudah dipakai.");
    if (next.enabled) {
      if (activeSkillCount(userId, skill.id) >= USER_SKILL_ACTIVE_LIMIT) return fail(reply, 400, "SKILL_LIMIT_REACHED", `Maksimal ${USER_SKILL_ACTIVE_LIMIT} skill aktif.`);
      if (activeSkillChars(userId, skill.id) + next.content.length > USER_SKILL_CHARS_LIMIT) return fail(reply, 400, "SKILL_TOO_LONG", `Total isi skill aktif maksimal ${USER_SKILL_CHARS_LIMIT} karakter.`);
    }
    db.prepare("UPDATE user_skills SET name=?, description=?, content=?, enabled=?, updated_at=? WHERE id=? AND user_id=?")
      .run(next.name, next.description, next.content, next.enabled, new Date().toISOString(), skill.id, userId);
    audit(userId, "skill.updated", { skillId: skill.id, enabled: next.enabled });
    return { skill: readSkill(userId, skill.id) };
  });

  app.delete("/api/v1/skills/mine/:skillId", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const skill = readSkill(userId, request.params.skillId);
    if (!skill) return fail(reply, 404, "SKILL_NOT_FOUND", "Skill tidak ditemukan.");
    db.prepare("DELETE FROM user_skills WHERE id=? AND user_id=?").run(skill.id, userId);
    audit(userId, "skill.deleted", { skillId: skill.id, name: skill.name });
    return { deleted: true, id: skill.id };
  });
}

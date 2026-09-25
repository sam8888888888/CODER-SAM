/**
 * Wave 11A (butir 52): Knowledge Base platform.
 *
 * Isi bagian ini milik platform, bukan milik satu akun: admin menanam aturan/identitas yang ikut
 * dikirim ke SETIAP run (paling awal, sebelum persona dan memori). Batas total 8.000 karakter
 * supaya sisipan platform tidak diam-diam membengkakkan konteks.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { adminRequired, audit, fail, isPlatformAdmin } from "./shared.js";

export const KB_SECTIONS = ["umum", "whitelabel"] as const;
export type KbSection = (typeof KB_SECTIONS)[number];

/** Batas total karakter entri AKTIF yang boleh dikirim ke mesin. */
export const KB_CHAR_LIMIT = 8000;

export type KbEntry = {
  id: string; section: KbSection; title: string; content: string; enabled: number;
  sortOrder: number; createdBy: string | null; createdAt: string; updatedAt: string;
};

const SELECT_ENTRY = "SELECT id, section, title, content, enabled, sort_order AS sortOrder, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM platform_knowledge";

export function listKnowledgeBase(includeDisabled = true): KbEntry[] {
  const where = includeDisabled ? "" : " WHERE enabled=1";
  return db.prepare(`${SELECT_ENTRY}${where} ORDER BY CASE section WHEN 'umum' THEN 0 ELSE 1 END, sort_order ASC, created_at ASC`).all() as KbEntry[];
}

/**
 * Blok untuk `appendSystem[]` yang dikirim paling awal. Bila total melewati batas, entri dipotong
 * berurutan (urutan tampil) dan pemotongan dilaporkan apa adanya, bukan disembunyikan.
 */
export function platformKnowledgeBlock(): { block: string | null; chars: number; entries: number; totalChars: number; trimmed: boolean; dropped: string[] } {
  const rows = listKnowledgeBase(false);
  const totalChars = rows.reduce((total, row) => total + row.title.length + row.content.length, 0);
  const kept: KbEntry[] = []; const dropped: string[] = [];
  let chars = 0;
  for (const row of rows) {
    const size = row.title.length + row.content.length + 4;
    if (chars + size > KB_CHAR_LIMIT) { dropped.push(row.title); continue; }
    chars += size; kept.push(row);
  }
  if (!kept.length) return { block: null, chars: 0, entries: 0, totalChars, trimmed: dropped.length > 0, dropped };
  const sections: string[] = [];
  for (const section of KB_SECTIONS) {
    const items = kept.filter((row) => row.section === section);
    if (!items.length) continue;
    sections.push(`## ${section === "umum" ? "Umum" : "Whitelabel"}\n${items.map((row) => `### ${row.title}\n${row.content}`).join("\n")}`);
  }
  const block = `PENGETAHUAN PLATFORM (wajib dipatuhi pada setiap jawaban):\n${sections.join("\n")}`;
  return { block, chars: block.length, entries: kept.length, totalChars, trimmed: dropped.length > 0, dropped };
}

/** Total karakter entri aktif, dipakai untuk menolak penyimpanan yang melewati batas. */
export function activeKnowledgeChars(excludeId?: string): number {
  const rows = listKnowledgeBase(false).filter((row) => row.id !== excludeId);
  return rows.reduce((total, row) => total + row.title.length + row.content.length, 0);
}

function readEntry(id: string): KbEntry | null {
  return (db.prepare(`${SELECT_ENTRY} WHERE id=?`).get(id) as KbEntry | undefined) ?? null;
}

export function registerKnowledgeBaseRoutes(app: any): void {
  app.get("/api/v1/knowledge-base", { preHandler: requireUser }, async () => {
    const entries = listKnowledgeBase(true).map((row) => ({ ...row }));
    return {
      entries, sections: KB_SECTIONS, limitChars: KB_CHAR_LIMIT,
      activeChars: activeKnowledgeChars(), activeEntries: entries.filter((row) => row.enabled).length,
      catatan: "Entri aktif dikirim ke setiap run agen, paling awal sebelum persona dan memori.",
    };
  });

  app.post("/api/v1/admin/knowledge-base", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const section = String(request.body?.section ?? "").trim().toLowerCase();
    if (!(KB_SECTIONS as readonly string[]).includes(section)) return fail(reply, 400, "INVALID_KB_SECTION", "Bagian harus 'umum' atau 'whitelabel'.");
    const title = String(request.body?.title ?? "").trim();
    const content = String(request.body?.content ?? "").trim();
    if (!title) return fail(reply, 400, "INVALID_KB_TITLE", "Judul wajib diisi.");
    if (!content) return fail(reply, 400, "INVALID_KB_CONTENT", "Isi wajib diisi.");
    if (title.length > 200) return fail(reply, 400, "INVALID_KB_TITLE", "Judul maksimal 200 karakter.");
    const enabled = request.body?.enabled === false ? 0 : 1;
    if (enabled && activeKnowledgeChars() + title.length + content.length > KB_CHAR_LIMIT) {
      return fail(reply, 400, "KB_LIMIT_REACHED", `Total Knowledge Base aktif melebihi ${KB_CHAR_LIMIT.toLocaleString("id-ID")} karakter. Matikan atau pendekkan entri lain dulu.`);
    }
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare("INSERT INTO platform_knowledge (id,section,title,content,enabled,sort_order,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, section, title, content, enabled, Number.isFinite(Number(request.body?.sortOrder)) ? Math.round(Number(request.body.sortOrder)) : 0, request.user!.id, now, now);
    audit(request.user!.id, "knowledge_base.created", { id, section, title, enabled });
    return reply.code(201).send({ entry: readEntry(id) });
  });

  app.patch("/api/v1/admin/knowledge-base/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const entry = readEntry(request.params.id);
    if (!entry) return fail(reply, 404, "KB_NOT_FOUND", "Entri Knowledge Base tidak ditemukan.");
    if (request.body?.section !== undefined && !(KB_SECTIONS as readonly string[]).includes(String(request.body.section))) {
      return fail(reply, 400, "INVALID_KB_SECTION", "Bagian harus 'umum' atau 'whitelabel'.");
    }
    const next = {
      section: request.body?.section !== undefined ? (String(request.body.section) as KbSection) : entry.section,
      title: request.body?.title !== undefined ? String(request.body.title).trim() : entry.title,
      content: request.body?.content !== undefined ? String(request.body.content).trim() : entry.content,
      enabled: request.body?.enabled !== undefined ? (request.body.enabled ? 1 : 0) : entry.enabled,
      sortOrder: request.body?.sortOrder !== undefined && Number.isFinite(Number(request.body.sortOrder)) ? Math.round(Number(request.body.sortOrder)) : entry.sortOrder,
    };
    if (!next.title) return fail(reply, 400, "INVALID_KB_TITLE", "Judul wajib diisi.");
    if (!next.content) return fail(reply, 400, "INVALID_KB_CONTENT", "Isi wajib diisi.");
    if (next.enabled && activeKnowledgeChars(entry.id) + next.title.length + next.content.length > KB_CHAR_LIMIT) {
      return fail(reply, 400, "KB_LIMIT_REACHED", `Total Knowledge Base aktif melebihi ${KB_CHAR_LIMIT.toLocaleString("id-ID")} karakter.`);
    }
    db.prepare("UPDATE platform_knowledge SET section=?, title=?, content=?, enabled=?, sort_order=?, updated_at=? WHERE id=?")
      .run(next.section, next.title, next.content, next.enabled, next.sortOrder, new Date().toISOString(), entry.id);
    audit(request.user!.id, "knowledge_base.updated", { id: entry.id, section: next.section, enabled: next.enabled });
    return { entry: readEntry(entry.id) };
  });

  app.delete("/api/v1/admin/knowledge-base/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const entry = readEntry(request.params.id);
    if (!entry) return fail(reply, 404, "KB_NOT_FOUND", "Entri Knowledge Base tidak ditemukan.");
    db.prepare("DELETE FROM platform_knowledge WHERE id=?").run(entry.id);
    audit(request.user!.id, "knowledge_base.deleted", { id: entry.id, title: entry.title });
    return { deleted: true, id: entry.id };
  });
}

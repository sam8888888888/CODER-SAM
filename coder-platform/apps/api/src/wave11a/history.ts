/**
 * Wave 11A (butir 54): hapus semua riwayat percakapan.
 *
 * Aturan keselamatan: penghapusan massal hanya boleh setelah percakapan diekspor lebih dulu.
 * Ekspor itu digabung menjadi SATU berkas (`bulk-export`), dan id ekspor itu wajib dikirim ulang
 * saat menghapus, sehingga UI tidak bisa menghapus riwayat tanpa pernah menyimpannya.
 * Artefak tidak pernah ikut terhapus.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { exportDir, exportFilePath } from "../dataexport.js";
import { audit, fail } from "./shared.js";

export const BULK_SCOPES = ["project", "workspace"] as const;
export type BulkScope = (typeof BULK_SCOPES)[number];

type ScopeRow = { targetId: string; workspaceId: string; role: string; nama: string; projectId: string | null };

/** Memeriksa hak akses cakupan dan mengembalikan barisnya, atau null bila tidak boleh dilihat. */
function scopeAccess(scope: string, targetId: string, userId: string): ScopeRow | null {
  if (scope === "project") {
    const row = db.prepare(`SELECT p.id AS targetId, p.workspace_id AS workspaceId, p.name AS nama, p.id AS projectId, m.role AS role
      FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?`).get(targetId, userId) as ScopeRow | undefined;
    return row ?? null;
  }
  const row = db.prepare(`SELECT w.id AS targetId, w.id AS workspaceId, w.name AS nama, NULL AS projectId, m.role AS role
    FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE w.id=? AND m.user_id=?`).get(targetId, userId) as ScopeRow | undefined;
  return row ?? null;
}

function conversationsInScope(scope: BulkScope, scopeRow: ScopeRow, userId: string): { id: string; title: string; projectId: string }[] {
  if (scope === "project") {
    return db.prepare("SELECT c.id, c.title, c.project_id AS projectId FROM conversations c WHERE c.project_id=? ORDER BY c.created_at ASC").all(scopeRow.targetId) as { id: string; title: string; projectId: string }[];
  }
  return db.prepare(`SELECT c.id, c.title, c.project_id AS projectId FROM conversations c JOIN projects p ON p.id=c.project_id
    JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.workspace_id=? AND m.user_id=? ORDER BY c.created_at ASC`).all(scopeRow.targetId, userId) as { id: string; title: string; projectId: string }[];
}

/** Penanda cakupan yang disimpan di kolom `sections` milik `data_exports`. */
export function scopeMarker(scope: BulkScope, targetId: string): string {
  return `cakupan:${scope}:${targetId}`;
}

function messagesOf(conversationIds: string[]): { conversationId: string; role: string; content: string; createdAt: string }[] {
  if (!conversationIds.length) return [];
  const placeholders = conversationIds.map(() => "?").join(",");
  return db.prepare(`SELECT conversation_id AS conversationId, role, content, created_at AS createdAt FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY created_at ASC`).all(...conversationIds) as { conversationId: string; role: string; content: string; createdAt: string }[];
}

/** Apakah ada ekspor siap pakai milik pengguna ini untuk cakupan yang sama. */
function exportCoversScope(userId: string, scope: BulkScope, targetId: string, exportId: string): boolean {
  const row = db.prepare("SELECT id, sections, status FROM data_exports WHERE id=? AND user_id=?").get(exportId, userId) as { id: string; sections: string; status: string } | undefined;
  if (!row || row.status !== "ready") return false;
  try {
    const sections = JSON.parse(row.sections || "[]") as { name?: string }[];
    return sections.some((section) => section?.name === scopeMarker(scope, targetId));
  } catch { return false; }
}

export function registerHistoryRoutes(app: any): void {
  app.post("/api/v1/conversations/bulk-export", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const scope = String(request.body?.scope ?? "").trim().toLowerCase();
    if (!(BULK_SCOPES as readonly string[]).includes(scope)) return fail(reply, 400, "INVALID_SCOPE", "Cakupan harus 'project' atau 'workspace'.");
    const targetId = String((scope === "project" ? request.body?.projectId : request.body?.workspaceId) ?? "").trim();
    if (!targetId) return fail(reply, 400, "INVALID_SCOPE_TARGET", scope === "project" ? "Sertakan projectId." : "Sertakan workspaceId.");
    const access = scopeAccess(scope, targetId, userId);
    if (!access) return fail(reply, 404, scope === "project" ? "PROJECT_NOT_FOUND" : "WORKSPACE_NOT_FOUND", "Cakupan tidak ditemukan atau bukan milik Anda.");
    if (access.role === "viewer") return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran viewer tidak boleh mengekspor atau menghapus riwayat.");
    const conversations = conversationsInScope(scope as BulkScope, access, userId);
    const messages = messagesOf(conversations.map((row) => row.id));
    const payload = {
      format: "coblai.conversations.bulk.v1",
      exportedAt: new Date().toISOString(),
      scope: { jenis: scope, id: access.targetId, nama: access.nama },
      jumlah: { percakapan: conversations.length, pesan: messages.length },
      catatan: "Ekspor ini wajib ada sebelum menghapus riwayat. Simpan berkasnya di tempat aman.",
      conversations: conversations.map((conversation) => ({
        ...conversation,
        messages: messages.filter((message) => message.conversationId === conversation.id),
      })),
    };
    const id = randomUUID();
    const text = JSON.stringify(payload, null, 2);
    await mkdir(exportDir(), { recursive: true });
    const storagePath = exportFilePath(id);
    await writeFile(storagePath, text, "utf8");
    const sections = [
      { name: scopeMarker(scope as BulkScope, access.targetId), rows: conversations.length },
      { name: "percakapan", rows: conversations.length },
      { name: "pesan", rows: messages.length },
    ];
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + config.RETENTION_EXPORT_DAYS * 86_400_000).toISOString();
    db.prepare("INSERT INTO data_exports (id,user_id,status,size_bytes,storage_path,sections,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, userId, "ready", Buffer.byteLength(text, "utf8"), storagePath, JSON.stringify(sections), now, expiresAt);
    audit(userId, "conversation.bulk_exported", { exportId: id, scope, targetId: access.targetId, percakapan: conversations.length, pesan: messages.length });
    return reply.code(201).send({ exportId: id, conversations: conversations.length, messages: messages.length, sizeBytes: Buffer.byteLength(text, "utf8"), expiresAt });
  });

  app.post("/api/v1/conversations/bulk-delete", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const scope = String(request.body?.scope ?? "").trim().toLowerCase();
    if (!(BULK_SCOPES as readonly string[]).includes(scope)) return fail(reply, 400, "INVALID_SCOPE", "Cakupan harus 'project' atau 'workspace'.");
    const targetId = String((scope === "project" ? request.body?.projectId : request.body?.workspaceId) ?? "").trim();
    if (!targetId) return fail(reply, 400, "INVALID_SCOPE_TARGET", scope === "project" ? "Sertakan projectId." : "Sertakan workspaceId.");
    if (String(request.body?.confirm ?? "").trim().toUpperCase() !== "HAPUS") return fail(reply, 400, "CONFIRM_REQUIRED", "Ketik HAPUS untuk mengonfirmasi penghapusan riwayat.");
    const access = scopeAccess(scope, targetId, userId);
    if (!access) return fail(reply, 404, scope === "project" ? "PROJECT_NOT_FOUND" : "WORKSPACE_NOT_FOUND", "Cakupan tidak ditemukan atau bukan milik Anda.");
    if (access.role === "viewer") return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran viewer tidak boleh menghapus riwayat.");
    const exportId = String(request.body?.exportId ?? "").trim();
    if (!exportId || !exportCoversScope(userId, scope as BulkScope, access.targetId, exportId)) {
      return fail(reply, 409, "EXPORT_REQUIRED", "Ekspor percakapan lebih dulu (POST /api/v1/conversations/bulk-export), lalu kirim exportId-nya. Penghapusan tanpa cadangan tidak diizinkan.");
    }
    const conversations = conversationsInScope(scope as BulkScope, access, userId);
    const ids = conversations.map((row) => row.id);
    const artifactsKept = scope === "project"
      ? Number((db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE project_id=?").get(access.targetId) as { n: number }).n)
      : Number((db.prepare(`SELECT COUNT(*) AS n FROM artifacts a JOIN projects p ON p.id=a.project_id WHERE p.workspace_id=?`).get(access.targetId) as { n: number }).n);
    let deletedMessages = 0; let deletedSummaries = 0;
    db.transaction(() => {
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        deletedMessages = db.prepare(`DELETE FROM messages WHERE conversation_id IN (${placeholders})`).run(...ids).changes;
        deletedSummaries = db.prepare(`DELETE FROM conversation_summaries WHERE conversation_id IN (${placeholders})`).run(...ids).changes;
        db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...ids);
      }
    })();
    audit(userId, "conversation.bulk_deleted", { scope, targetId: access.targetId, exportId, percakapan: ids.length, pesan: deletedMessages });
    return {
      deletedConversations: ids.length, deletedMessages, deletedSummaries, artifactsKept,
      scope: { jenis: scope, id: access.targetId, nama: access.nama }, exportId,
      catatan: "Artefak tidak ikut terhapus. Berkas ekspor tetap tersimpan sampai masa simpannya habis.",
    };
  });
}

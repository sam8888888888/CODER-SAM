/**
 * Wave 11A: helper bersama untuk modul-modul rute baru.
 *
 * Modul wave11a hanya memakai helper di berkas ini supaya tidak ada salinan kedua dari aturan
 * keamanan (admin platform, keanggotaan percakapan, dan pencatatan audit).
 */
import { db } from "../db.js";
import { config } from "../config.js";
import { recordAudit } from "../workflow-engine.js";

/** True when the user may inspect or change the whole platform. */
export function isPlatformAdmin(user: { id: string; email: string }): boolean {
  const allowed = config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(String(user.email).toLowerCase())) return true;
  const row = db.prepare("SELECT is_admin FROM users WHERE id=?").get(user.id) as { is_admin?: number } | undefined;
  return Boolean(row?.is_admin);
}

/** Balasan seragam untuk rute yang hanya boleh dipakai admin platform. */
export function adminRequired(reply: any) {
  return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melakukan ini." });
}

/** Balasan galat seragam: kode mesin + kalimat Indonesia. */
export function fail(reply: any, status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error, message, ...extra });
}

/** Workspace pribadi tempat tindakan tingkat akun dicatat. */
export function accountAuditWorkspace(userId: string): string | null {
  const row = db.prepare("SELECT workspace_id FROM memberships WHERE user_id=? AND role='owner' ORDER BY created_at LIMIT 1").get(userId) as { workspace_id?: string } | undefined;
  return row?.workspace_id ?? null;
}

/** Mencatat satu tindakan ke audit_events; audit tidak pernah menggagalkan permintaan. */
export function audit(userId: string | null, action: string, metadata: Record<string, unknown>) {
  recordAudit(userId ? accountAuditWorkspace(userId) : null, userId, action, metadata);
}

export type ConversationAccess = {
  id: string; projectId: string; workspaceId: string; title: string; role: string;
  agentMode: string; personaId: string | null;
};

/** Satu percakapan beserta peran pengguna di ruang kerjanya, atau null bila bukan anggotanya. */
export function conversationAccess(conversationId: string, userId: string): ConversationAccess | null {
  const row = db.prepare(`SELECT c.id AS id, c.project_id AS projectId, c.title AS title, c.agent_mode AS agentMode,
      c.persona_id AS personaId, p.workspace_id AS workspaceId, m.role AS role
    FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE c.id=? AND m.user_id=?`).get(conversationId, userId) as ConversationAccess | undefined;
  return row ?? null;
}

/** Peran terkecil yang boleh menulis: `viewer` hanya membaca. */
export function mayWrite(role: string): boolean {
  return role !== "viewer";
}

/** Nilai pengaturan platform (tabel platform_settings) dengan bawaan dari config. */
export function platformSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM platform_settings WHERE key=?").get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

export function savePlatformSetting(key: string, value: string) {
  db.prepare(`INSERT INTO platform_settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, value, new Date().toISOString());
}

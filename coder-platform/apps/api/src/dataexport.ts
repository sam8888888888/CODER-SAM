import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "./db.js";
import { config } from "./config.js";

/** Wave 4: a person can download everything the platform stores about them.
 *  The file is written under DATA_DIR/exports, never to a public folder, and expires on its own. */

export type ExportSection = { name: string; rows: number };
export type ExportRow = { id: string; userId: string; status: string; sizeBytes: number; sections: string; createdAt: string; expiresAt: string };
export type ExportSummary = Omit<ExportRow, "sections"> & { sections: ExportSection[] };

export function exportDir(): string { return join(config.DATA_DIR, "exports"); }
export function exportFilePath(exportId: string): string { return join(exportDir(), `${exportId}.json`); }

function pick<T = Record<string, unknown>>(sql: string, params: unknown[]): T[] { return db.prepare(sql).all(...params) as T[]; }

/** Builds the export object. Password hashes, MFA secrets and raw API keys are never included. */
export function collectUserData(userId: string): { data: Record<string, unknown>; sections: ExportSection[] } {
  const user = db.prepare("SELECT id, email, display_name AS displayName, created_at AS createdAt, updated_at AS updatedAt, mfa_enabled AS mfaEnabled, is_admin AS isAdmin FROM users WHERE id=?").get(userId) as Record<string, unknown> | undefined;
  const data: Record<string, unknown> = {};
  const sections: ExportSection[] = [];
  const add = (name: string, rows: unknown[]) => { data[name] = rows; sections.push({ name, rows: rows.length }); };

  add("profile", user ? [user] : []);
  add("sessions", pick("SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, user_agent AS userAgent FROM auth_sessions WHERE user_id=?", [userId]));
  add("memberships", pick(`SELECT m.workspace_id AS workspaceId, w.name AS workspaceName, m.role, m.created_at AS createdAt
      FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=?`, [userId]));
  add("projects", pick(`SELECT p.id, p.workspace_id AS workspaceId, p.name, p.created_at AS createdAt
      FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?`, [userId]));
  add("conversations", pick(`SELECT c.id, c.project_id AS projectId, c.title, c.pinned, c.created_at AS createdAt
      FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?`, [userId]));
  add("messages", pick(`SELECT msg.id, msg.conversation_id AS conversationId, msg.role, msg.content, msg.created_at AS createdAt
      FROM messages msg JOIN conversations c ON c.id=msg.conversation_id JOIN projects p ON p.id=c.project_id
      JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?`, [userId]));
  add("runs", pick(`SELECT r.id, r.project_id AS projectId, r.status, r.model, r.created_at AS createdAt, r.started_at AS startedAt, r.finished_at AS finishedAt
      FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?`, [userId]));
  add("usage", pick(`SELECT u.id, u.run_id AS runId, u.project_id AS projectId, u.model, u.input_tokens AS inputTokens, u.output_tokens AS outputTokens, u.total_tokens AS totalTokens, u.cost_micros AS costMicros, u.created_at AS createdAt
      FROM run_usage u JOIN projects p ON p.id=u.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?`, [userId]));
  add("user_usage", pick("SELECT id, run_id AS runId, source, model, total_tokens AS totalTokens, cost_micros AS costMicros, created_at AS createdAt FROM user_usage WHERE user_id=?", [userId]));
  add("artifacts", pick(`SELECT a.id, a.project_id AS projectId, a.name, a.mime_type AS mimeType, a.size_bytes AS sizeBytes, a.sha256, a.created_at AS createdAt
      FROM artifacts a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?`, [userId]));
  add("notifications", pick("SELECT id, kind, title, body, link, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id=?", [userId]));
  add("memories", pick("SELECT id, title, body, tags, pinned, created_at AS createdAt FROM agent_memories WHERE user_id=?", [userId]));
  add("prompt_templates", pick("SELECT id, name, body, description, slash, created_at AS createdAt FROM prompt_templates WHERE user_id=?", [userId]));
  add("personas", pick("SELECT id, name, system_prompt AS systemPrompt, tone, language, is_default AS isDefault, created_at AS createdAt FROM agent_personas WHERE user_id=?", [userId]));
  add("agent_settings", pick("SELECT thinking_level AS thinkingLevel, auto_compact AS autoCompact, compact_after_messages AS compactAfterMessages, tools_allow AS toolsAllow, autonomous_default AS autonomousDefault FROM agent_settings WHERE user_id=?", [userId]));
  add("notification_preferences", pick("SELECT email_quota AS emailQuota, email_runs AS emailRuns, email_billing AS emailBilling, email_team AS emailTeam, email_security AS emailSecurity, updated_at AS updatedAt FROM notification_prefs WHERE user_id=?", [userId]));
  // Only key metadata leaves the platform. The secret itself exists once, at creation time.
  add("api_keys", pick("SELECT id, name, prefix, scopes, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt, request_count AS requestCount FROM api_keys WHERE user_id=?", [userId]));
  add("billing", pick("SELECT id, plan_code AS planCode, status, started_at AS startedAt, expires_at AS expiresAt FROM subscriptions WHERE user_id=?", [userId]));
  add("orders", pick("SELECT id, plan_code AS planCode, months, total_idr AS totalIdr, method, status, created_at AS createdAt FROM orders WHERE user_id=?", [userId]));
  add("credit_ledger", pick("SELECT id, tokens, reason, ref, note, created_at AS createdAt FROM credit_ledger WHERE user_id=?", [userId]));
  add("quota", pick("SELECT tier, day_key AS dayKey, day_tokens AS dayTokens, month_key AS monthKey, month_tokens AS monthTokens, updated_at AS updatedAt FROM token_quotas WHERE user_id=?", [userId]));
  add("email_outbox", pick("SELECT id, kind, subject, status, attempts, created_at AS createdAt, sent_at AS sentAt FROM email_outbox WHERE user_id=?", [userId]));
  add("knowledge_documents", pick(`SELECT k.id, k.project_id AS projectId, k.title, k.source_type AS sourceType, k.created_at AS createdAt
      FROM knowledge_documents k JOIN projects p ON p.id=k.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?`, [userId]));
  return { data, sections };
}

export function exportExpiryDays(): number { return config.RETENTION_EXPORT_DAYS; }

export async function createExport(userId: string, now = new Date()): Promise<{ row: ExportRow; sections: ExportSection[] }> {
  const id = randomUUID();
  const { data, sections } = collectUserData(userId);
  const payload = {
    generatedAt: now.toISOString(), format: "coblai-coder-export/1", user: ((data.profile as Record<string, unknown>[] | undefined) ?? [])[0] ?? null,
    note: "Berkas ini memuat data akun Anda. Kata sandi, kode pemulihan MFA, dan kunci API mentah tidak pernah disertakan.",
    sections, data,
  };
  const text = JSON.stringify(payload, null, 2);
  await mkdir(exportDir(), { recursive: true });
  const storagePath = exportFilePath(id);
  await writeFile(storagePath, text, "utf8");
  const sizeBytes = Buffer.byteLength(text, "utf8");
  const expiresAt = new Date(now.getTime() + config.RETENTION_EXPORT_DAYS * 86_400_000).toISOString();
  const createdAt = now.toISOString();
  db.prepare("INSERT INTO data_exports (id,user_id,status,size_bytes,storage_path,sections,created_at,expires_at) VALUES (?,?,'ready',?,?,?,?,?)")
    .run(id, userId, sizeBytes, storagePath, JSON.stringify(sections), createdAt, expiresAt);
  return { row: { id, userId, status: "ready", sizeBytes, sections: JSON.stringify(sections), createdAt, expiresAt }, sections };
}

export function listExports(userId: string): ExportSummary[] {
  const rows = db.prepare("SELECT id, user_id AS userId, status, size_bytes AS sizeBytes, sections, created_at AS createdAt, expires_at AS expiresAt FROM data_exports WHERE user_id=? ORDER BY created_at DESC").all(userId) as ExportRow[];
  return rows.map((row) => ({ ...row, sections: JSON.parse(row.sections || "[]") as ExportSection[] }));
}

export function getExport(userId: string, exportId: string): ExportSummary | null {
  const row = db.prepare("SELECT id, user_id AS userId, status, size_bytes AS sizeBytes, sections, created_at AS createdAt, expires_at AS expiresAt FROM data_exports WHERE id=? AND user_id=?").get(exportId, userId) as ExportRow | undefined;
  if (!row) return null;
  return { ...row, sections: JSON.parse(row.sections || "[]") as ExportSection[] };
}

export async function deleteExport(userId: string, exportId: string): Promise<boolean> {
  const row = getExport(userId, exportId);
  if (!row) return false;
  db.prepare("DELETE FROM data_exports WHERE id=? AND user_id=?").run(exportId, userId);
  try { await unlink(exportFilePath(exportId)); } catch { /* the file may already be gone */ }
  return true;
}

/** Deletes the files of exports that are past their expiry and marks the rows. */
export async function expireExports(now = new Date()): Promise<{ marked: number; filesRemoved: number }> {
  const rows = db.prepare("SELECT id FROM data_exports WHERE status='ready' AND expires_at < ?").all(now.toISOString()) as { id: string }[];
  let filesRemoved = 0;
  for (const row of rows) {
    try { await unlink(exportFilePath(row.id)); filesRemoved += 1; } catch { /* already gone */ }
  }
  const marked = db.prepare("UPDATE data_exports SET status='expired' WHERE status='ready' AND expires_at < ?").run(now.toISOString()).changes;
  return { marked, filesRemoved };
}

export async function exportFileSize(exportId: string): Promise<number | null> {
  try { const info = await stat(exportFilePath(exportId)); return info.size; } catch { return null; }
}

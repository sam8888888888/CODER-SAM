import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { mailerConfigured, sendMail } from "./mailer.js";

/** Wave 4: outgoing email goes through an outbox table.
 *  Nothing is delivered until NOTIFY_EMAIL_ENABLED is on, and every attempt is recorded, so an operator
 *  can see exactly what would be sent. In-app notifications are not affected by this file. */

export type EmailKind = "run" | "quota" | "cost" | "billing" | "team" | "invitation" | "security" | "account" | "system";

export type NotificationPrefs = {
  userId: string; emailQuota: number; emailRuns: number; emailBilling: number;
  emailTeam: number; emailSecurity: number; updatedAt: string;
};

export const PREF_COLUMN: Record<string, keyof NotificationPrefs | null> = {
  run: "emailRuns",
  runs: "emailRuns",
  quota: "emailQuota",
  cost: "emailQuota",
  billing: "emailBilling",
  team: "emailTeam",
  invitation: "emailTeam",
  security: "emailSecurity",
  account: "emailSecurity",
  system: null,
};

export const MAX_DELIVERY_ATTEMPTS = 3;

function toPrefs(value: any, userId: string): NotificationPrefs {
  return {
    userId, emailQuota: Number(value?.emailQuota ?? 1), emailRuns: Number(value?.emailRuns ?? 1),
    emailBilling: Number(value?.emailBilling ?? 1), emailTeam: Number(value?.emailTeam ?? 1),
    emailSecurity: Number(value?.emailSecurity ?? 1), updatedAt: String(value?.updatedAt ?? ""),
  };
}

export function notificationPrefs(userId: string): NotificationPrefs {
  const row = db.prepare(`SELECT email_quota AS emailQuota, email_runs AS emailRuns, email_billing AS emailBilling,
      email_team AS emailTeam, email_security AS emailSecurity, updated_at AS updatedAt
      FROM notification_prefs WHERE user_id=?`).get(userId);
  return toPrefs(row, userId);
}

export function saveNotificationPrefs(userId: string, patch: Record<string, unknown>): NotificationPrefs {
  const current = notificationPrefs(userId);
  const pick = (key: string, fallback: number) => {
    if (!(key in patch)) return fallback;
    const value = patch[key];
    if (value === true) return 1;
    if (value === false) return 0;
    return Number(value) === 0 ? 0 : 1;
  };
  const next = {
    emailQuota: pick("emailQuota", current.emailQuota), emailRuns: pick("emailRuns", current.emailRuns),
    emailBilling: pick("emailBilling", current.emailBilling), emailTeam: pick("emailTeam", current.emailTeam),
    emailSecurity: pick("emailSecurity", current.emailSecurity),
  };
  db.prepare(`INSERT INTO notification_prefs (user_id,email_quota,email_runs,email_billing,email_team,email_security,updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET email_quota=excluded.email_quota, email_runs=excluded.email_runs,
      email_billing=excluded.email_billing, email_team=excluded.email_team, email_security=excluded.email_security,
      updated_at=excluded.updated_at`)
    .run(userId, next.emailQuota, next.emailRuns, next.emailBilling, next.emailTeam, next.emailSecurity, new Date().toISOString());
  return notificationPrefs(userId);
}

/** True when the user allows email for this kind. Unknown kinds are allowed. */
export function prefsAllowEmail(userId: string, kind: string): boolean {
  const column = PREF_COLUMN[kind] ?? null;
  if (!column) return true;
  const prefs = notificationPrefs(userId) as unknown as Record<string, unknown>;
  return Number(prefs[column] ?? 1) === 1;
}

export function emailEnabled(): boolean { return config.NOTIFY_EMAIL_ENABLED; }

export function emailWorkerState(): { enabled: boolean; mailerConfigured: boolean; from: string } {
  return { enabled: config.NOTIFY_EMAIL_ENABLED, mailerConfigured: mailerConfigured(), from: config.SMTP_FROM };
}

export function renderEmail(kind: EmailKind, title: string, body: string, link?: string | null): { subject: string; body: string } {
  const lines = [title, "", body];
  if (link) lines.push("", `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}${link.startsWith("/") ? link : "/" + link}`);
  lines.push("", "COBLAI Coder", "Email ini dikirim otomatis karena Anda punya akun di COBLAI Coder.");
  return { subject: `[COBLAI Coder] ${title}`, body: lines.join("\n") };
}

/** Adds one message to the outbox. A dedupe key keeps repeated warnings from piling up. */
export function queueEmail(input: { userId: string | null; toEmail: string; kind: EmailKind; subject: string; body: string; dedupeKey?: string | null }): { queued: boolean; id: string | null; reason?: string } {
  if (!input.toEmail || !input.toEmail.includes("@")) return { queued: false, id: null, reason: "INVALID_RECIPIENT" };
  if (input.userId && !prefsAllowEmail(input.userId, input.kind)) return { queued: false, id: null, reason: "EMAIL_DISABLED_BY_USER" };
  const id = randomUUID();
  try {
    db.prepare("INSERT INTO email_outbox (id,user_id,to_email,kind,subject,body,status,attempts,dedupe_key,created_at) VALUES (?,?,?,?,?,?,'pending',0,?,?)")
      .run(id, input.userId ?? null, input.toEmail, input.kind, input.subject, input.body, input.dedupeKey ?? null, new Date().toISOString());
    return { queued: true, id };
  } catch (error) {
    const message = String((error as Error).message || "");
    if (message.includes("UNIQUE")) return { queued: false, id: null, reason: "ALREADY_QUEUED" };
    return { queued: false, id: null, reason: message.slice(0, 120) };
  }
}

export type OutboxRow = {
  id: string; userId: string | null; toEmail: string; kind: string; subject: string; body: string;
  status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null;
};

export function listOutbox(options: { status?: string; limit?: number; userId?: string | null } = {}): OutboxRow[] {
  const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 200);
  const where: string[] = []; const params: unknown[] = [];
  if (options.status) { where.push("status=?"); params.push(options.status); }
  if (options.userId) { where.push("user_id=?"); params.push(options.userId); }
  const sql = `SELECT id, user_id AS userId, to_email AS toEmail, kind, subject, body, status, attempts,
      last_error AS lastError, created_at AS createdAt, sent_at AS sentAt FROM email_outbox
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit) as OutboxRow[];
}

export function outboxStats(): { pending: number; sent: number; failed: number; skipped: number; total: number; lastSentAt: string | null } {
  const rows = db.prepare("SELECT status, COUNT(*) AS total FROM email_outbox GROUP BY status").all() as { status: string; total: number }[];
  const stats = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0, lastSentAt: null as string | null };
  for (const row of rows) {
    stats.total += row.total;
    if (row.status === "pending") stats.pending = row.total;
    else if (row.status === "sent") stats.sent = row.total;
    else if (row.status === "failed") stats.failed = row.total;
    else if (row.status === "skipped") stats.skipped = row.total;
  }
  const last = db.prepare("SELECT sent_at AS sentAt FROM email_outbox WHERE status='sent' ORDER BY sent_at DESC LIMIT 1").get() as { sentAt: string } | undefined;
  stats.lastSentAt = last?.sentAt ?? null;
  return stats;
}

export function retryEmail(id: string): boolean {
  const result = db.prepare("UPDATE email_outbox SET status='pending', last_error=NULL WHERE id=? AND status IN ('failed','skipped')").run(id);
  return result.changes > 0;
}

/**
 * Removes one queued message.
 * A `pending` row is only removable while the email worker is switched off, because nothing is in
 * flight then. While sending is enabled the row is left alone so a message cannot vanish mid-send.
 */
export function deleteOutboxRow(id: string, allowPending = false): boolean {
  const statement = allowPending ? "DELETE FROM email_outbox WHERE id=?" : "DELETE FROM email_outbox WHERE id=? AND status<>'pending'";
  return db.prepare(statement).run(id).changes > 0;
}

/** Reads one queued message, including the delivery status, so callers can explain a refusal. */
export function getOutboxRow(id: string): OutboxRow | null {
  return (db.prepare(`SELECT id, user_id AS userId, to_email AS toEmail, kind, subject, body, status, attempts,
      last_error AS lastError, created_at AS createdAt, sent_at AS sentAt FROM email_outbox WHERE id=?`).get(id) as OutboxRow | undefined) ?? null;
}

export type DeliveryReport = { enabled: boolean; mailerConfigured: boolean; considered: number; sent: number; failed: number; skipped: number; pending: number; reason?: string };

/** Delivers queued mail. It is a no-op while NOTIFY_EMAIL_ENABLED is off. */
export async function deliverPending(limit = 20): Promise<DeliveryReport> {
  const report: DeliveryReport = { enabled: config.NOTIFY_EMAIL_ENABLED, mailerConfigured: mailerConfigured(), considered: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
  if (!config.NOTIFY_EMAIL_ENABLED) {
    report.pending = outboxStats().pending;
    report.reason = "NOTIFY_EMAIL_DISABLED";
    return report;
  }
  const rows = db.prepare("SELECT id, user_id AS userId, to_email AS toEmail, kind, subject, body, status, attempts FROM email_outbox WHERE status='pending' ORDER BY created_at ASC LIMIT ?").all(limit) as { id: string; userId: string | null; toEmail: string; kind: string; subject: string; body: string; attempts: number }[];
  report.considered = rows.length;
  if (!mailerConfigured()) {
    const mark = db.prepare("UPDATE email_outbox SET status='skipped', last_error=? WHERE id=?");
    for (const row of rows) { mark.run("MAILER_NOT_CONFIGURED", row.id); report.skipped += 1; }
    report.reason = "MAILER_NOT_CONFIGURED";
    return report;
  }
  for (const row of rows) {
    let result: { sent: boolean; reason?: string; detail?: string };
    try { result = await sendMail({ to: row.toEmail, subject: row.subject, text: row.body }); }
    catch (error) { result = { sent: false, reason: "SEND_FAILED", detail: String((error as Error).message || "").slice(0, 200) }; }
    if (result.sent) {
      db.prepare("UPDATE email_outbox SET status='sent', sent_at=?, attempts=attempts+1, last_error=NULL WHERE id=?").run(new Date().toISOString(), row.id);
      report.sent += 1;
    } else {
      const attempts = row.attempts + 1;
      const status = attempts >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending";
      db.prepare("UPDATE email_outbox SET status=?, attempts=?, last_error=? WHERE id=?").run(status, attempts, `${result.reason ?? "SEND_FAILED"}${result.detail ? ": " + result.detail : ""}`.slice(0, 300), row.id);
      report.failed += 1;
    }
  }
  report.pending = outboxStats().pending;
  return report;
}

export const EMAIL_WORKER_INTERVAL_MS = 60_000;

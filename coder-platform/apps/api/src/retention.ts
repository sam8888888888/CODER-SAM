import { db } from "./db.js";
import { config } from "./config.js";

/** Wave 4: data retention.
 *  The report always works and never changes anything. Deletion happens only when RETENTION_ENABLED=true
 *  and the caller asks for a real run, so an operator can review the numbers first. */

export type RetentionPolicy = { enabled: boolean; dryRunForced: boolean; auditDays: number; notificationDays: number; runEventDays: number; exportDays: number; webhookDays: number };

export type RetentionTableReport = { table: string; column: string; cutoff: string; candidates: number; removed: number };

export function retentionPolicy(): RetentionPolicy {
  return {
    enabled: config.RETENTION_ENABLED, dryRunForced: config.RETENTION_DRY_RUN, auditDays: config.RETENTION_AUDIT_DAYS,
    notificationDays: config.RETENTION_NOTIFICATION_DAYS, runEventDays: config.RETENTION_RUN_EVENT_DAYS,
    exportDays: config.RETENTION_EXPORT_DAYS, webhookDays: config.RETENTION_WEBHOOK_DAYS,
  };
}

function daysAgo(days: number, now: Date): string { return new Date(now.getTime() - days * 86_400_000).toISOString(); }

type Target = { table: string; column: string; where: string; days: (policy: RetentionPolicy) => number };

const TARGETS: Target[] = [
  { table: "audit_events", column: "created_at", where: "created_at < ?", days: (policy) => policy.auditDays },
  { table: "notifications", column: "created_at", where: "created_at < ?", days: (policy) => policy.notificationDays },
  { table: "run_events", column: "created_at", where: "created_at < ?", days: (policy) => policy.runEventDays },
  { table: "auth_tokens", column: "expires_at", where: "expires_at < ?", days: (policy) => 1 },
  // Wave 10 (item 23): the history of a busy hook grows without limit. Only rows that are finished are
  // removed: a delivery that is still waiting, or being retried, is work in progress.
  { table: "webhook_deliveries", column: "created_at", where: "created_at < ? AND status IN ('delivered','failed')", days: (policy) => policy.webhookDays },
];

/** Wave 8: how long a closed account can still be recovered before its rows are removed. */
export const ACCOUNT_RECOVERY_DAYS = 90;

export type ClosedAccountRow = { userId: string; email: string; closedAt: string | null; purgeAfter: string | null };

/** Lists closed accounts: `due` have passed the recovery window, `waiting` are still recoverable. */
export function closedAccounts(now = new Date()): { due: ClosedAccountRow[]; waiting: ClosedAccountRow[] } {
  const fields = "id AS userId, email, deleted_at AS closedAt, purge_after AS purgeAfter";
  const due = db.prepare(`SELECT ${fields} FROM users WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= ? ORDER BY purge_after ASC`).all(now.toISOString()) as ClosedAccountRow[];
  const waiting = db.prepare(`SELECT ${fields} FROM users WHERE deleted_at IS NOT NULL AND (purge_after IS NULL OR purge_after > ?) ORDER BY deleted_at ASC`).all(now.toISOString()) as ClosedAccountRow[];
  return { due, waiting };
}

export type PurgeAccountsResult = { accounts: number; removedWorkspaces: string[]; promoted: number };

/**
 * Wave 8: removes the rows of accounts whose 90 day recovery window has passed.
 * A workspace that still has members keeps living: the oldest remaining member is promoted to
 * owner. A workspace with no members left is removed, and its id is returned so the caller can
 * delete the matching files on disk.
 */
export function purgeClosedAccounts(now = new Date()): PurgeAccountsResult {
  const result: PurgeAccountsResult = { accounts: 0, removedWorkspaces: [], promoted: 0 };
  for (const account of closedAccounts(now).due) {
    const owned = db.prepare("SELECT workspace_id AS workspaceId FROM memberships WHERE user_id=? AND role='owner'").all(account.userId) as { workspaceId: string }[];
    for (const workspace of owned) {
      const remaining = db.prepare("SELECT user_id AS userId, role FROM memberships WHERE workspace_id=? AND user_id<>? ORDER BY created_at ASC").all(workspace.workspaceId, account.userId) as { userId: string; role: string }[];
      if (remaining.length === 0) {
        // Nobody is left in the workspace, so the workspace and everything under it goes too.
        db.prepare("DELETE FROM workspace_invitations WHERE workspace_id=?").run(workspace.workspaceId);
        db.prepare("DELETE FROM notifications WHERE workspace_id=?").run(workspace.workspaceId);
        db.prepare("DELETE FROM workspaces WHERE id=?").run(workspace.workspaceId);
        result.removedWorkspaces.push(workspace.workspaceId);
        continue;
      }
      if (!remaining.some((member) => member.role === "owner" || member.role === "admin")) {
        db.prepare("UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?").run(workspace.workspaceId, remaining[0].userId);
        result.promoted += 1;
      }
    }
    // These tables carry a plain user id without a foreign key, so they are cleared by hand.
    for (const table of ["agent_memories", "prompt_templates", "agent_personas"]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(account.userId);
    }
    // audit_events names the acting user in `actor_user_id`. Rows tied to a workspace stay,
    // because they belong to the record of that workspace; personal rows go with the account.
    db.prepare("DELETE FROM audit_events WHERE actor_user_id=? AND workspace_id IS NULL").run(account.userId);
    db.prepare("DELETE FROM users WHERE id=?").run(account.userId);
    result.accounts += 1;
  }
  return result;
}

/** Counts what a real run would delete, without touching a single row. */
export function retentionReport(now = new Date()): { policy: RetentionPolicy; generatedAt: string; tables: RetentionTableReport[]; totalCandidates: number } {
  const policy = retentionPolicy();
  const tables: RetentionTableReport[] = [];
  for (const target of TARGETS) {
    const cutoff = daysAgo(target.days(policy), now);
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${target.table} WHERE ${target.where}`).get(cutoff) as { total: number };
    tables.push({ table: target.table, column: target.column, cutoff, candidates: row.total, removed: 0 });
  }
  const expiredExports = db.prepare("SELECT COUNT(*) AS total FROM data_exports WHERE status='ready' AND expires_at < ?").get(now.toISOString()) as { total: number };
  tables.push({ table: "data_exports", column: "expires_at", cutoff: now.toISOString(), candidates: expiredExports.total, removed: 0 });
  const closed = closedAccounts(now);
  tables.push({ table: "users (akun ditutup)", column: "purge_after", cutoff: now.toISOString(), candidates: closed.due.length, removed: 0 });
  return { policy, generatedAt: now.toISOString(), tables, totalCandidates: tables.reduce((sum, item) => sum + item.candidates, 0) };
}

/** Runs the retention pass. Refuses to delete while the feature is off, unless the caller forces a dry run. */
export function runRetention(options: { dryRun?: boolean; now?: Date } = {}): { policy: RetentionPolicy; dryRun: boolean; tables: RetentionTableReport[]; totalRemoved: number; reason?: string; purgedAccounts?: number; removedWorkspaces?: string[] } {
  const now = options.now ?? new Date();
  const policy = retentionPolicy();
  // Wave 10 (item 27): RETENTION_DRY_RUN=true keeps the pass in report mode even when a caller asks for
  // a real run. It is the seat belt for an operator who wants the numbers without the deletion.
  const dryRun = policy.dryRunForced || (options.dryRun ?? !policy.enabled);
  if (policy.dryRunForced) {
    return { policy, dryRun: true, tables: retentionReport(now).tables, totalRemoved: 0, reason: "RETENTION_DRY_RUN" };
  }
  if (!policy.enabled && !dryRun) {
    return { policy, dryRun: true, tables: retentionReport(now).tables, totalRemoved: 0, reason: "RETENTION_DISABLED" };
  }
  const tables = retentionReport(now).tables;
  if (dryRun) return { policy, dryRun: true, tables, totalRemoved: 0, reason: "DRY_RUN" };
  for (const target of TARGETS) {
    const entry = tables.find((item) => item.table === target.table)!;
    const result = db.prepare(`DELETE FROM ${target.table} WHERE ${target.where}`).run(entry.cutoff);
    entry.removed = result.changes;
  }
  const exportRow = tables.find((item) => item.table === "data_exports")!;
  const marked = db.prepare("UPDATE data_exports SET status='expired' WHERE status='ready' AND expires_at < ?").run(now.toISOString());
  exportRow.removed = marked.changes;
  const purged = purgeClosedAccounts(now);
  const accountRow = tables.find((item) => item.table === "users (akun ditutup)")!;
  accountRow.removed = purged.accounts;
  return { policy, dryRun: false, tables, totalRemoved: tables.reduce((sum, item) => sum + item.removed, 0), purgedAccounts: purged.accounts, removedWorkspaces: purged.removedWorkspaces };
}

export const RETENTION_JOB_INTERVAL_MS = 6 * 60 * 60 * 1000;

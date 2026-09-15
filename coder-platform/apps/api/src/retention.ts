import { db } from "./db.js";
import { config } from "./config.js";

/** Wave 4: data retention.
 *  The report always works and never changes anything. Deletion happens only when RETENTION_ENABLED=true
 *  and the caller asks for a real run, so an operator can review the numbers first. */

export type RetentionPolicy = { enabled: boolean; auditDays: number; notificationDays: number; runEventDays: number; exportDays: number };

export type RetentionTableReport = { table: string; column: string; cutoff: string; candidates: number; removed: number };

export function retentionPolicy(): RetentionPolicy {
  return {
    enabled: config.RETENTION_ENABLED, auditDays: config.RETENTION_AUDIT_DAYS,
    notificationDays: config.RETENTION_NOTIFICATION_DAYS, runEventDays: config.RETENTION_RUN_EVENT_DAYS,
    exportDays: config.RETENTION_EXPORT_DAYS,
  };
}

function daysAgo(days: number, now: Date): string { return new Date(now.getTime() - days * 86_400_000).toISOString(); }

type Target = { table: string; column: string; where: string; days: (policy: RetentionPolicy) => number };

const TARGETS: Target[] = [
  { table: "audit_events", column: "created_at", where: "created_at < ?", days: (policy) => policy.auditDays },
  { table: "notifications", column: "created_at", where: "created_at < ?", days: (policy) => policy.notificationDays },
  { table: "run_events", column: "created_at", where: "created_at < ?", days: (policy) => policy.runEventDays },
  { table: "auth_tokens", column: "expires_at", where: "expires_at < ?", days: (policy) => 1 },
];

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
  return { policy, generatedAt: now.toISOString(), tables, totalCandidates: tables.reduce((sum, item) => sum + item.candidates, 0) };
}

/** Runs the retention pass. Refuses to delete while the feature is off, unless the caller forces a dry run. */
export function runRetention(options: { dryRun?: boolean; now?: Date } = {}): { policy: RetentionPolicy; dryRun: boolean; tables: RetentionTableReport[]; totalRemoved: number; reason?: string } {
  const now = options.now ?? new Date();
  const policy = retentionPolicy();
  const dryRun = options.dryRun ?? !policy.enabled;
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
  return { policy, dryRun: false, tables, totalRemoved: tables.reduce((sum, item) => sum + item.removed, 0) };
}

export const RETENTION_JOB_INTERVAL_MS = 6 * 60 * 60 * 1000;

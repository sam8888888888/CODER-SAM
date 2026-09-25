/**
 * Penjaga pemakaian ruang kerja (workspace) — dipindahkan dari `server.ts` pada Wave 11C supaya
 * modul fitur baru (mis. percakapan grup) bisa memakai penjaga yang SAMA, bukan salinannya.
 *
 * Alasan: setiap jalur yang membuat run harus melewati penjaga ini. Kalau logikanya hanya hidup di
 * dalam `server.ts`, modul lain tidak bisa mengimpornya tanpa membuat impor melingkar.
 */
import { config } from "./config.js";
import { db } from "./db.js";

/** True when a share of the platform (chat runs, workflow steps) may start for a workspace. */
export function workspaceGuards(workspaceId: string) {
  const row = db.prepare("SELECT id, daily_cost_limit_micros AS daily, monthly_cost_limit_micros AS monthly, runs_per_hour_limit AS perHour FROM workspaces WHERE id=?").get(workspaceId) as { id: string; daily: number | null; monthly: number | null; perHour: number | null } | undefined;
  return {
    daily: row?.daily ?? config.DEFAULT_DAILY_COST_LIMIT_MICROS,
    monthly: row?.monthly ?? config.DEFAULT_MONTHLY_COST_LIMIT_MICROS,
    perHour: row?.perHour ?? config.DEFAULT_RUNS_PER_HOUR_LIMIT,
  };
}

/** Cost in micros that a workspace produced today, plus this calendar month. */
export function workspaceSpend(workspaceId: string) {
  const day = db.prepare(`SELECT COALESCE(SUM(u.cost_micros),0) AS micros, COUNT(*) AS runs FROM run_usage u JOIN projects p ON p.id=u.project_id WHERE p.workspace_id=? AND u.created_at >= ?`).get(workspaceId, new Date(Date.now() - 86_400_000).toISOString()) as { micros: number; runs: number };
  const month = db.prepare(`SELECT COALESCE(SUM(u.cost_micros),0) AS micros FROM run_usage u JOIN projects p ON p.id=u.project_id WHERE p.workspace_id=? AND u.created_at >= ?`).get(workspaceId, new Date(Date.now() - 30 * 86_400_000).toISOString()) as { micros: number };
  return { dayMicros: day.micros ?? 0, dayRuns: day.runs ?? 0, monthMicros: month.micros ?? 0 };
}

/**
 * Guard for a workspace about to start engine work.
 * Returns null when allowed, or { status, error } describing the block.
 */
export function guardWorkspaceUsage(workspaceId: string): { status: number; error: string; detail?: Record<string, unknown> } | null {
  const limits = workspaceGuards(workspaceId);
  const spend = workspaceSpend(workspaceId);
  if (limits.daily > 0 && spend.dayMicros >= limits.daily) return { status: 429, error: "COST_LIMIT_EXCEEDED", detail: { window: "day", limitMicros: limits.daily, usedMicros: spend.dayMicros } };
  if (limits.monthly > 0 && spend.monthMicros >= limits.monthly) return { status: 429, error: "COST_LIMIT_EXCEEDED", detail: { window: "month", limitMicros: limits.monthly, usedMicros: spend.monthMicros } };
  if (limits.perHour > 0 && spend.dayRuns >= limits.perHour) return { status: 429, error: "RUN_RATE_LIMITED", detail: { window: "day", limitRuns: limits.perHour, usedRuns: spend.dayRuns } };
  return null;
}

import { randomUUID } from "node:crypto";
import { db } from "./db.js";

/** Wave 7: growth measurement.
 *
 *  Two different jobs live here and they must not be confused:
 *  1. `recordGrowthEvent` writes a small row every time something worth counting happens. These rows
 *     only exist from Wave 7 onwards, so they are never used for the all-time funnel.
 *  2. The reporting functions read the REAL tables (users, projects, runs, orders) so the funnel is
 *     true for the whole history of the platform, not just from the day this module was installed.
 */

export const GROWTH_EVENTS = [
  "signup", "email_verified", "project_created", "conversation_created",
  "run_started", "run_completed", "run_failed",
  "api_key_created", "webhook_created",
  "order_created", "order_paid",
  "referral_joined", "referral_rewarded", "onboarding_completed",
  "quota_warning_shown", "upgrade_viewed",
] as const;

export type GrowthEventName = (typeof GROWTH_EVENTS)[number];

const EVENT_SET = new Set<string>(GROWTH_EVENTS);

export function isGrowthEvent(name: string): name is GrowthEventName {
  return EVENT_SET.has(name);
}

/** Writes one event row. It must never break the caller: a failure to count is not a failure of the
 *  feature the user asked for. */
export function recordGrowthEvent(
  name: string,
  opts: { userId?: string | null; workspaceId?: string | null; props?: Record<string, unknown> } = {},
): void {
  if (!isGrowthEvent(name)) return;
  try {
    db.prepare("INSERT INTO growth_events (id, name, user_id, workspace_id, props, created_at) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), name, opts.userId ?? null, opts.workspaceId ?? null, JSON.stringify(opts.props ?? {}), new Date().toISOString());
  } catch {
    /* counting is best effort by design */
  }
}

function sinceIso(days: number): string {
  const safe = Math.max(1, Math.min(365, Math.round(days || 30)));
  return new Date(Date.now() - safe * 24 * 60 * 60 * 1000).toISOString();
}

type Step = { key: string; label: string; users: number; allTime: number };

/** The funnel in five steps. Each step counts DISTINCT USERS, so the numbers can be compared. */
export function funnelReport(days = 30): { days: number; since: string; steps: Step[]; note: string } {
  const since = sinceIso(days);
  const one = (sql: string, ...args: unknown[]): { users: number; allTime: number } => {
    const row = db.prepare(sql).get(...args) as { users: number; allTime: number } | undefined;
    return { users: Number(row?.users ?? 0), allTime: Number(row?.allTime ?? 0) };
  };

  const signup = one(
    `SELECT COUNT(DISTINCT CASE WHEN created_at >= ? THEN id END) AS users, COUNT(*) AS allTime FROM users`,
    since,
  );
  const project = one(
    `SELECT COUNT(DISTINCT CASE WHEN p.created_at >= ? THEN m.user_id END) AS users,
            COUNT(DISTINCT m.user_id) AS allTime
       FROM projects p JOIN memberships m ON m.workspace_id = p.workspace_id`,
    since,
  );
  const run = one(
    `SELECT COUNT(DISTINCT CASE WHEN r.finished_at >= ? THEN m.user_id END) AS users,
            COUNT(DISTINCT m.user_id) AS allTime
       FROM runs r JOIN projects p ON p.id = r.project_id
       JOIN memberships m ON m.workspace_id = p.workspace_id
      WHERE r.status = 'completed'`,
    since,
  );
  const paid = one(
    `SELECT COUNT(DISTINCT CASE WHEN COALESCE(decided_at, created_at) >= ? THEN user_id END) AS users,
            COUNT(DISTINCT user_id) AS allTime
       FROM orders WHERE status = 'paid'`,
    since,
  );

  const steps: Step[] = [
    { key: "signup", label: "Mendaftar", ...signup },
    { key: "project", label: "Membuat proyek", ...project },
    { key: "run", label: "Menyelesaikan satu run", ...run },
    { key: "paid", label: "Membeli paket", ...paid },
  ];
  return {
    days: Math.max(1, Math.min(365, Math.round(days || 30))),
    since,
    steps,
    note: "Setiap langkah menghitung pengguna UNIK, diambil dari tabel asli (users, projects, runs, orders), sehingga berlaku untuk seluruh riwayat platform.",
  };
}

/** One row per day: new signups, completed runs, and the recorded events of that day. */
export function dailyActivity(days = 30): Array<{ day: string; signups: number; runsCompleted: number; events: number; activeUsers: number }> {
  const since = sinceIso(days);
  const days_ = Math.max(1, Math.min(365, Math.round(days || 30)));
  const rows = db.prepare(`
    WITH RECURSIVE d(day) AS (
      SELECT date(?) UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < date('now')
    )
    SELECT d.day AS day,
      (SELECT COUNT(*) FROM users u WHERE date(u.created_at) = d.day) AS signups,
      (SELECT COUNT(*) FROM runs r WHERE r.status='completed' AND date(r.finished_at) = d.day) AS runsCompleted,
      (SELECT COUNT(*) FROM growth_events e WHERE date(e.created_at) = d.day) AS events,
      (SELECT COUNT(DISTINCT e.user_id) FROM growth_events e WHERE date(e.created_at) = d.day) AS activeUsers
    FROM d ORDER BY d.day`).all(since.slice(0, 10)) as Array<{ day: string; signups: number; runsCompleted: number; events: number; activeUsers: number }>;
  return rows.slice(-days_);
}

/** Weekly and monthly active users.
 *  Honest limit: active users here come from growth_events, which only exist from Wave 7. */
export function retentionReport(): {
  dau: number; wau: number; mau: number; newUsers7d: number; newUsers30d: number;
  payingUsers: number; note: string;
} {
  const since = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const act = (d: number) =>
    Number((db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM growth_events WHERE user_id IS NOT NULL AND created_at >= ?").get(since(d)) as { n: number }).n);
  const newUsers = (d: number) =>
    Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?").get(since(d)) as { n: number }).n);
  const paying = Number((db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM subscriptions WHERE status='active'").get() as { n: number }).n);
  return {
    dau: act(1), wau: act(7), mau: act(30),
    newUsers7d: newUsers(7), newUsers30d: newUsers(30), payingUsers: paying,
    note: "Pengguna aktif dihitung dari tabel growth_events yang baru ada sejak Wave 7; angka sebelum itu tidak tersedia.",
  };
}

/** The most frequent recorded events in the window. */
export function topEvents(days = 30, limit = 15): Array<{ name: string; count: number; users: number }> {
  return db.prepare(`SELECT name, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users
    FROM growth_events WHERE created_at >= ? GROUP BY name ORDER BY count DESC LIMIT ?`)
    .all(sinceIso(days), Math.max(1, Math.min(50, limit))) as Array<{ name: string; count: number; users: number }>;
}

export function eventCatalogue(): string[] {
  return [...GROWTH_EVENTS];
}

/** Everything one screen needs, in one call. */
export function growthOverview(days = 30) {
  const funnel = funnelReport(days);
  const activity = dailyActivity(days);
  const retention = retentionReport();
  const events = topEvents(days);
  const totals = {
    users: Number((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n),
    workspaces: Number((db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n),
    projects: Number((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n),
    conversations: Number((db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n),
    runsCompleted: Number((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='completed'").get() as { n: number }).n),
    eventsRecorded: Number((db.prepare("SELECT COUNT(*) AS n FROM growth_events").get() as { n: number }).n),
  };
  return { funnel, activity, retention, events, totals, catalogue: eventCatalogue() };
}

import { createHash, randomUUID } from "node:crypto";
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
  // Wave 10 (item 25/32C): artefak dan alur kerja ikut dihitung. Peristiwa ini hanya muncul dari
  // pelengkapan data, karena tidak ada jalur yang mencatatnya saat kejadian berlangsung.
  "artifact_created", "workflow_created",
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

/**
 * Wave 10 (item 25 + 32c): rebuild the event log from the real tables.
 *
 * `growth_events` only exists from Wave 7, so the daily activity chart and the active user numbers
 * were blind before that date. This pass reads the real tables (`users`, `projects`, `conversations`,
 * `runs`, `api_keys`, `webhooks`, `orders`, `referrals`) and writes the events that were never
 * recorded, each one stamped with the real time of the row it came from.
 *
 * Three rules make it safe to run at every start-up:
 *  1. A row is written only when the same real entity is not already in the log. Live rows are matched
 *     through the id stored in `props`, account-based events through the user id, and rebuilt rows
 *     through their deterministic id (`bf-<hash of event + entity>`).
 *  2. Rebuilt rows carry `source='backfill'`, so a reader can always separate rebuilt history from what
 *     the platform recorded live.
 *  3. Events that were never stored anywhere (a dismissed upgrade banner, a warning toast, an
 *     onboarding step whose time is not kept) are NOT invented. They stay missing, and the report says
 *     so instead of quietly producing numbers.
 */

export type GrowthBackfillPlanRow = { event: GrowthEventName; source: string; candidates: number; alreadyRecorded: number; toInsert: number };

export type GrowthBackfillReport = {
  dryRun: boolean;
  generatedAt: string;
  rows: GrowthBackfillPlanRow[];
  inserted: number;
  skipped: number;
  totalCandidates: number;
  excluded: Array<{ event: string; reason: string }>;
  note: string;
};

/** One rebuilt event: the real table, the real time, and the account it belongs to. */
type SourceQuery = {
  event: GrowthEventName;
  table: string;
  /** The id of the real row, as the caller reads it. */
  entityId: string;
  /** The property that holds the same id when the event was recorded live (null: match by account). */
  propsKey: string | null;
  sql: string;
};

const EXCLUDED: Array<{ event: string; reason: string }> = [
  { event: "quota_warning_shown", reason: "hanya tampil di layar; tidak ada baris tersimpan yang menyebut waktunya" },
  { event: "upgrade_viewed", reason: "hanya tampil di layar; tidak ada baris tersimpan yang menyebut waktunya" },
  { event: "onboarding_completed", reason: "onboarding_state tidak menyimpan waktu selesai" },
];

/** The owner of a workspace is the account that represents it in reports. */
const owner = (column: string) => `(SELECT m.user_id FROM memberships m WHERE m.workspace_id = ${column} AND m.role='owner' ORDER BY m.created_at ASC LIMIT 1)`;

const SOURCES: SourceQuery[] = [
  { event: "signup", table: "users", entityId: "id", propsKey: null, sql: "SELECT id AS entityId, created_at AS at, id AS userId, NULL AS workspaceId FROM users" },
  { event: "email_verified", table: "users (email_verified=1)", entityId: "id", propsKey: null, sql: "SELECT id AS entityId, created_at AS at, id AS userId, NULL AS workspaceId FROM users WHERE email_verified=1" },
  { event: "project_created", table: "projects", entityId: "id", propsKey: "projectId", sql: `SELECT p.id AS entityId, p.created_at AS at, ${owner("p.workspace_id")} AS userId, p.workspace_id AS workspaceId FROM projects p` },
  { event: "conversation_created", table: "conversations", entityId: "id", propsKey: "conversationId", sql: `SELECT c.id AS entityId, c.created_at AS at, ${owner("p.workspace_id")} AS userId, p.workspace_id AS workspaceId FROM conversations c JOIN projects p ON p.id = c.project_id` },
  { event: "run_started", table: "runs", entityId: "id", propsKey: "runId", sql: `SELECT r.id AS entityId, r.created_at AS at, ${owner("p.workspace_id")} AS userId, p.workspace_id AS workspaceId FROM runs r JOIN projects p ON p.id = r.project_id` },
  { event: "run_completed", table: "runs (completed)", entityId: "id", propsKey: "runId", sql: `SELECT r.id AS entityId, COALESCE(r.finished_at, r.created_at) AS at, ${owner("p.workspace_id")} AS userId, p.workspace_id AS workspaceId FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.status='completed'` },
  { event: "run_failed", table: "runs (failed)", entityId: "id", propsKey: "runId", sql: `SELECT r.id AS entityId, COALESCE(r.finished_at, r.created_at) AS at, ${owner("p.workspace_id")} AS userId, p.workspace_id AS workspaceId FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.status='failed'` },
  // The live row for a new key only carries the scopes, so this one is matched per account.
  { event: "api_key_created", table: "api_keys", entityId: "id", propsKey: null, sql: "SELECT k.id AS entityId, k.created_at AS at, k.user_id AS userId, k.workspace_id AS workspaceId FROM api_keys k" },
  { event: "webhook_created", table: "webhooks", entityId: "id", propsKey: "webhookId", sql: "SELECT w.id AS entityId, w.created_at AS at, w.user_id AS userId, w.workspace_id AS workspaceId FROM webhooks w" },
  { event: "artifact_created", table: "artifacts", entityId: "id", propsKey: "artifactId", sql: `SELECT a.id AS entityId, a.created_at AS at, ${owner("p.workspace_id")} AS userId, p.workspace_id AS workspaceId FROM artifacts a JOIN projects p ON p.id = a.project_id` },
  { event: "workflow_created", table: "workflows", entityId: "id", propsKey: "workflowId", sql: `SELECT wf.id AS entityId, wf.created_at AS at, ${owner("p.workspace_id")} AS userId, p.workspace_id AS workspaceId FROM workflows wf JOIN projects p ON p.id = wf.project_id` },
  { event: "order_created", table: "orders", entityId: "id", propsKey: "orderId", sql: "SELECT o.id AS entityId, o.created_at AS at, o.user_id AS userId, NULL AS workspaceId FROM orders o" },
  { event: "order_paid", table: "orders (paid)", entityId: "id", propsKey: "orderId", sql: "SELECT o.id AS entityId, COALESCE(o.decided_at, o.updated_at) AS at, o.user_id AS userId, NULL AS workspaceId FROM orders o WHERE o.status='paid'" },
  { event: "referral_joined", table: "referrals", entityId: "id", propsKey: "referralId", sql: "SELECT r.id AS entityId, r.created_at AS at, r.invitee_user_id AS userId, NULL AS workspaceId FROM referrals r" },
  { event: "referral_rewarded", table: "referrals (rewarded)", entityId: "id", propsKey: "referralId", sql: "SELECT r.id AS entityId, COALESCE(r.rewarded_at, r.qualified_at, r.created_at) AS at, r.inviter_user_id AS userId, NULL AS workspaceId FROM referrals r WHERE r.status='rewarded'" },
];

function backfillId(event: string, entityId: string): string {
  return `bf-${createHash("sha256").update(`${event}:${entityId}`).digest("hex").slice(0, 32)}`;
}

type Candidate = { entityId: string; at: string | null; userId: string | null; workspaceId: string | null };

function candidatesOf(source: SourceQuery): Candidate[] {
  return db.prepare(source.sql).all() as Candidate[];
}

/** The real entities that the log already knows about for one event, live or rebuilt. */
function recordedEntities(source: SourceQuery): Set<string> {
  const keys = new Set<string>();
  if (source.propsKey) {
    // A live row keeps the id under the property name of its event; a rebuilt row (source='backfill')
    // keeps it under `entityId`. Both must count as "already there", otherwise the plan keeps promising
    // rows that the apply step will refuse to write.
    const rows = db.prepare(`SELECT json_extract(props, '$.${source.propsKey}') AS key, json_extract(props, '$.entityId') AS rebuilt FROM growth_events WHERE name=?`).all(source.event) as Array<{ key: string | null; rebuilt: string | null }>;
    for (const row of rows) {
      if (row.key) keys.add(row.key);
      if (row.rebuilt) keys.add(row.rebuilt);
    }
    return keys;
  }
  const rows = db.prepare("SELECT user_id AS userId FROM growth_events WHERE name=?").all(source.event) as Array<{ userId: string | null }>;
  for (const row of rows) if (row.userId) keys.add(`user:${row.userId}`);
  return keys;
}

/** Counts what each source table holds, and how much of it is already in the event log. */
export function planGrowthBackfill(): { rows: GrowthBackfillPlanRow[]; excluded: Array<{ event: string; reason: string }>; totalCandidates: number } {
  const rows: GrowthBackfillPlanRow[] = [];
  let totalCandidates = 0;
  for (const source of SOURCES) {
    const candidates = candidatesOf(source);
    const recorded = recordedEntities(source);
    const already = candidates.filter((row) => recorded.has(source.propsKey ? row.entityId : `user:${row.userId ?? ""}`)).length;
    totalCandidates += candidates.length;
    rows.push({ event: source.event, source: source.table, candidates: candidates.length, alreadyRecorded: already, toInsert: candidates.length - already });
  }
  return { rows, excluded: EXCLUDED, totalCandidates };
}

/** Runs the pass. Without `apply` it only reports, which is the safe default for an admin call. */
export function backfillGrowthEvents(options: { apply?: boolean; now?: Date } = {}): GrowthBackfillReport {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const apply = Boolean(options.apply);
  const plan = planGrowthBackfill();
  const insert = db.prepare("INSERT OR IGNORE INTO growth_events (id, name, user_id, workspace_id, props, created_at, source) VALUES (?,?,?,?,?,?, 'backfill')");
  let inserted = 0;
  let skipped = 0;
  for (const source of SOURCES) {
    const recorded = recordedEntities(source);
    for (const row of candidatesOf(source)) {
      if (!row.entityId) continue;
      const matchKey = source.propsKey ? row.entityId : `user:${row.userId ?? ""}`;
      if (recorded.has(matchKey)) { skipped += 1; continue; }
      if (!apply) continue;
      const props = JSON.stringify({ backfill: true, entityId: row.entityId, table: source.table });
      try {
        const result = insert.run(backfillId(source.event, row.entityId), source.event, row.userId ?? null, row.workspaceId ?? null, props, row.at ?? generatedAt);
        if (result.changes) inserted += 1; else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  if (!apply) {
    return {
      dryRun: true, generatedAt, rows: plan.rows, inserted: 0,
      skipped: plan.rows.reduce((sum, row) => sum + row.alreadyRecorded, 0),
      totalCandidates: plan.totalCandidates, excluded: plan.excluded,
      note: "Pratinjau: tidak ada baris yang ditulis. Panggil ulang dengan { apply: true } untuk menerapkan.",
    };
  }
  return {
    dryRun: false, generatedAt, rows: plan.rows, inserted, skipped,
    totalCandidates: plan.totalCandidates, excluded: plan.excluded,
    note: "Baris hasil pelengkapan ditandai source='backfill' dan memakai waktu asli dari tabel sumber. Peristiwa yang tidak pernah tersimpan tidak dibuat.",
  };
}

/** How many rows in the log come from the real tables and how many were recorded live. */
export function growthEventSources(): Array<{ source: string; events: number; first: string | null; last: string | null }> {
  return db.prepare("SELECT COALESCE(source,'live') AS source, COUNT(*) AS events, MIN(created_at) AS first, MAX(created_at) AS last FROM growth_events GROUP BY COALESCE(source,'live') ORDER BY events DESC").all() as Array<{ source: string; events: number; first: string | null; last: string | null }>;
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

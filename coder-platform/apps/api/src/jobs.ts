import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";

/**
 * Wave 5: pekerjaan latar yang tahan restart.
 *
 * Sebelum ini, pekerjaan latar (kirim email, retensi, dan pekerjaan yang dijalankan langsung setelah
 * permintaan HTTP dijawab) hanya hidup di memori proses API. Kalau container dimatikan, pekerjaan yang
 * belum selesai hilang tanpa jejak dan tidak ada yang mencobanya lagi.
 *
 * Sekarang setiap pekerjaan ditulis dulu ke tabel `jobs`, lalu dikerjakan oleh worker yang memakai
 * SEWA (lease): satu pekerjaan hanya boleh dipegang satu pemilik sampai `lock_expires_at`. Bila proses
 * mati, sewa itu kedaluwarsa dan proses berikutnya mengambil alih pekerjaannya. Jadi tidak ada
 * pekerjaan yang menggantung, dan tidak ada dua worker mengerjakan pekerjaan yang sama.
 *
 * Aturan yang dipakai:
 *  - `attempts` dinaikkan saat pekerjaan DIAMBIL, bukan saat selesai.
 *  - Bila handler gagal dan `attempts < max_attempts`, pekerjaan dikembalikan ke `queued` dengan
 *    jeda bertambah (5 detik x percobaan). Bila sudah habis, status menjadi `failed` dan alasannya
 *    disimpan di `last_error`.
 *  - `dedupe_key` unik mencegah satu pekerjaan diantre dua kali (mis. dua proses menambah pekerjaan
 *    berkala pada menit yang sama).
 */

export type JobStatus = "queued" | "running" | "done" | "failed";

/** Jenis pekerjaan yang dikenal platform. Jenis lain tetap boleh (dipakai uji), tetapi bukan bawaan. */
export const JOB_KINDS = ["run.execute", "email.deliver", "retention.run", "smoke.cleanup", "run.reap", "workflow.reap", "webhook.deliver", "ratelimit.sweep"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type JobRow = {
  id: string;
  kind: string;
  status: JobStatus;
  payload: string;
  result: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockOwner: string | null;
  lockExpiresAt: string | null;
  lastError: string | null;
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type JobCycleReport = {
  owner: string;
  startedAt: string;
  finishedAt: string;
  recoveredLeases: number;
  scheduled: string[];
  claimed: number;
  succeeded: number;
  failed: number;
  details: { id: string; kind: string; outcome: "done" | "failed" | "retry"; note?: string }[];
};

const COLUMNS = `id, kind, status, payload, result, attempts AS attempts, max_attempts AS maxAttempts,
  run_after AS runAfter, lock_owner AS lockOwner, lock_expires_at AS lockExpiresAt, last_error AS lastError,
  dedupe_key AS dedupeKey, created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt`;

/** Berapa lama hasil `jobStats` dan status hub boleh dianggap segar. Tidak ada caching: selalu dibaca. */
const RETRY_BASE_DELAY_MS = 5_000;
/** Pekerjaan pemeriksa (reaper) dijalankan tiap sepuluh menit. */
export const REAP_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Butir 15b: sapuan tabel `rate_limit_hits` dijalankan pekerja terjadwal tiap lima menit. Jendela
 * terpanjang hanya 20 menit, jadi jeda ini selalu membuang baris yang sudah mati sebelum menumpuk.
 */
export const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const handlers = new Map<string, (payload: any, job: JobRow) => Promise<unknown> | unknown>();

let lastCycle: JobCycleReport | null = null;
let cyclesRun = 0;

function nowIso(now: Date = new Date()): string { return now.toISOString(); }

function toIso(value: Date | string | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

export function getJob(id: string): JobRow | null {
  return (db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).get(id) as JobRow | undefined) ?? null;
}

export function listJobs(options: { status?: JobStatus | string; kind?: string; limit?: number } = {}): JobRow[] {
  const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 200);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (options.status) { filters.push("status = ?"); params.push(options.status); }
  if (options.kind) { filters.push("kind = ?"); params.push(options.kind); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  params.push(limit);
  return db.prepare(`SELECT ${COLUMNS} FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as JobRow[];
}

export function jobStats(): {
  queued: number; running: number; done: number; failed: number; total: number;
  oldestQueuedAt: string | null; lastFinishedAt: string | null; byKind: Record<string, number>;
} {
  const rows = db.prepare("SELECT status, COUNT(*) AS total FROM jobs GROUP BY status").all() as any[];
  const counts: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  let total = 0;
  for (const row of rows) { counts[String(row.status)] = Number(row.total); total += Number(row.total); }
  const oldest = db.prepare("SELECT MIN(created_at) AS value FROM jobs WHERE status = 'queued'").get() as any;
  const lastFinished = db.prepare("SELECT MAX(finished_at) AS value FROM jobs WHERE finished_at IS NOT NULL").get() as any;
  const byKind: Record<string, number> = {};
  for (const row of db.prepare("SELECT kind, COUNT(*) AS total FROM jobs GROUP BY kind").all() as any[]) byKind[String(row.kind)] = Number(row.total);
  return {
    queued: counts.queued, running: counts.running, done: counts.done, failed: counts.failed,
    total, oldestQueuedAt: oldest?.value ?? null, lastFinishedAt: lastFinished?.value ?? null, byKind,
  };
}

/** Menambah pekerjaan baru. `dedupeKey` yang sama tidak akan masuk dua kali (dilaporkan `queued: false`). */
export function enqueueJob(input: {
  kind: string; payload?: unknown; runAfter?: Date | string; maxAttempts?: number; dedupeKey?: string;
}): { queued: boolean; id: string | null; reason?: string } {
  const now = new Date();
  const id = randomUUID();
  const payload = JSON.stringify(input.payload ?? {});
  const maxAttempts = Math.max(Math.trunc(Number(input.maxAttempts ?? 3)), 1);
  const dedupeKey = input.dedupeKey ?? null;
  if (dedupeKey) {
    const existing = db.prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as any;
    if (existing) return { queued: false, id: String(existing.id), reason: "DUPLICATE" };
  }
  try {
    db.prepare(`INSERT INTO jobs (id, kind, status, payload, attempts, max_attempts, run_after, dedupe_key, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, input.kind, payload, maxAttempts, toIso(input.runAfter, now), dedupeKey, nowIso(now), nowIso(now));
    return { queued: true, id };
  } catch (error) {
    // Balapan dua proses: indeks unik dedupe_key menangkapnya, jadi tidak ada pekerjaan kembar.
    if (dedupeKey) {
      const existing = db.prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as any;
      if (existing) return { queued: false, id: String(existing.id), reason: "DUPLICATE" };
    }
    return { queued: false, id: null, reason: String((error as Error).message) };
  }
}

export function registerJobHandler(kind: string, handler: (payload: any, job: JobRow) => Promise<unknown> | unknown): void {
  handlers.set(kind, handler);
}
export function jobHandlerKinds(): string[] { return [...handlers.keys()].sort(); }

/** Mengembalikan pekerjaan yang sewanya kedaluwarsa (proses pemegangnya mati) ke antrean. */
export function recoverExpiredLeases(now: Date = new Date()): number {
  const stamp = nowIso(now);
  const stale = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at < ?`)
    .all(stamp) as JobRow[];
  let recovered = 0;
  for (const job of stale) {
    if (job.attempts >= job.maxAttempts) {
      db.prepare("UPDATE jobs SET status='failed', last_error=?, lock_owner=NULL, lock_expires_at=NULL, finished_at=?, updated_at=? WHERE id=? AND status='running'")
        .run("WORKER_LOST: proses pemegang pekerjaan berhenti dan percobaan sudah habis", stamp, stamp, job.id);
    } else {
      db.prepare("UPDATE jobs SET status='queued', last_error=?, lock_owner=NULL, lock_expires_at=NULL, updated_at=? WHERE id=? AND status='running'")
        .run("WORKER_LOST: proses pemegang pekerjaan berhenti, pekerjaan dikembalikan ke antrean", stamp, job.id);
    }
    recovered += 1;
  }
  return recovered;
}

/** Mengambil pekerjaan yang siap jalan dan menguncinya untuk `owner`. Satu pengambilan, satu transaksi. */
export function claimJobs(limit: number, owner: string, now: Date = new Date()): JobRow[] {
  const stamp = nowIso(now);
  const leaseUntil = new Date(now.getTime() + config.JOB_LEASE_MS).toISOString();
  const take = db.transaction((count: number) => {
    const candidates = db.prepare("SELECT id FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY run_after ASC, created_at ASC LIMIT ?")
      .all(stamp, count) as any[];
    const taken: JobRow[] = [];
    for (const candidate of candidates) {
      const result = db.prepare(`UPDATE jobs SET status='running', lock_owner=?, lock_expires_at=?, attempts=attempts+1, updated_at=?
        WHERE id=? AND status='queued'`).run(owner, leaseUntil, stamp, String(candidate.id));
      if (result.changes === 1) taken.push(getJob(String(candidate.id))!);
    }
    return taken;
  });
  return take(Math.min(Math.max(Math.trunc(limit), 1), 200));
}

export function completeJob(id: string, result: unknown = null): void {
  const stamp = nowIso();
  const text = result === null || result === undefined ? null : JSON.stringify(result).slice(0, 4000);
  db.prepare("UPDATE jobs SET status='done', result=?, last_error=NULL, lock_owner=NULL, lock_expires_at=NULL, finished_at=?, updated_at=? WHERE id=?")
    .run(text, stamp, stamp, id);
}

/** Mencatat kegagalan. Selama percobaan masih tersisa, pekerjaan dikembalikan ke antrean. */
export function failJob(id: string, error: string): { retrying: boolean; attempts: number; maxAttempts: number } {
  const job = getJob(id);
  if (!job) return { retrying: false, attempts: 0, maxAttempts: 0 };
  const stamp = nowIso();
  const message = String(error ?? "").slice(0, 900);
  if (job.attempts < job.maxAttempts) {
    const delay = RETRY_BASE_DELAY_MS * Math.max(job.attempts, 1);
    const runAfter = new Date(Date.now() + delay).toISOString();
    db.prepare("UPDATE jobs SET status='queued', last_error=?, run_after=?, lock_owner=NULL, lock_expires_at=NULL, updated_at=? WHERE id=?")
      .run(message, runAfter, stamp, id);
    return { retrying: true, attempts: job.attempts, maxAttempts: job.maxAttempts };
  }
  db.prepare("UPDATE jobs SET status='failed', last_error=?, lock_owner=NULL, lock_expires_at=NULL, finished_at=?, updated_at=? WHERE id=?")
    .run(message, stamp, stamp, id);
  return { retrying: false, attempts: job.attempts, maxAttempts: job.maxAttempts };
}

/** Menaruh pekerjaan yang sudah selesai/gagal kembali ke antrean atas permintaan admin. */
export function retryJob(id: string, now: Date = new Date()): { ok: boolean; reason?: string } {
  const job = getJob(id);
  if (!job) return { ok: false, reason: "JOB_NOT_FOUND" };
  if (job.status === "queued" || job.status === "running") return { ok: false, reason: "JOB_ALREADY_PENDING" };
  db.prepare("UPDATE jobs SET status='queued', attempts=0, last_error=NULL, result=NULL, finished_at=NULL, lock_owner=NULL, lock_expires_at=NULL, run_after=?, updated_at=? WHERE id=?")
    .run(nowIso(now), nowIso(now), id);
  return { ok: true };
}

/** Pekerjaan berkala hanya diantre bila jenis itu tidak sedang menunggu/dikerjakan dan sudah waktunya. */
export function ensureRecurringJobs(now: Date = new Date()): string[] {
  const schedule: { kind: string; intervalMs: number; enabled: boolean; payload?: unknown; maxAttempts?: number }[] = [
    { kind: "email.deliver", intervalMs: 60_000, enabled: config.NOTIFY_EMAIL_ENABLED, maxAttempts: 3 },
    { kind: "retention.run", intervalMs: 6 * 60 * 60 * 1000, enabled: true, maxAttempts: 2 },
    // Wave 10 (item 27): the production smoke test writes real rows so that every check is real. This
    // pass clears them again, and it only runs when the operator switched it on.
    { kind: "smoke.cleanup", intervalMs: Math.max(60_000, config.SMOKE_CLEANUP_HOURS * 60 * 60 * 1000), enabled: config.SMOKE_CLEANUP_ENABLED, maxAttempts: 2 },
    // Butir 15b: sapuan tabel pembatas laju. Pekerjaan ini SELALU dijadwalkan supaya satu pemilik
    // antrean selalu menyapu tabel; `RATE_LIMIT_SWEEP_IN_WEB` hanya menentukan apakah proses web
    // ikut menyapu sendiri (lihat ratelimit.ts). Menghapus baris mati bersifat idempoten, jadi
    // bentrok dua penyapu tidak berbahaya.
    { kind: "ratelimit.sweep", intervalMs: RATE_LIMIT_SWEEP_INTERVAL_MS, enabled: true, maxAttempts: 1 },
    { kind: "run.reap", intervalMs: REAP_INTERVAL_MS, enabled: true, maxAttempts: 1 },
    { kind: "workflow.reap", intervalMs: REAP_INTERVAL_MS, enabled: true, maxAttempts: 1 },
  ];
  const created: string[] = [];
  for (const entry of schedule) {
    if (!entry.enabled) continue;
    const pending = db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE kind=? AND status IN ('queued','running')").get(entry.kind) as any;
    if (Number(pending?.total ?? 0) > 0) continue;
    const last = db.prepare("SELECT MAX(COALESCE(finished_at, created_at)) AS value FROM jobs WHERE kind=? AND status IN ('done','failed')").get(entry.kind) as any;
    const lastAt = last?.value ? new Date(String(last.value)).getTime() : 0;
    if (lastAt && now.getTime() - lastAt < entry.intervalMs) continue;
    const bucket = Math.floor(now.getTime() / entry.intervalMs);
    // Penting: pekerjaan berkala diberi runAfter = waktu acuan putaran ini, bukan "sekarang".
    // Tanpa itu, jam pekerjaan sedikit di depan jam putaran (selisih milidetik) sehingga
    // pekerjaan yang baru dijadwalkan tidak ikut diambil di putaran yang sama.
    const queued = enqueueJob({ kind: entry.kind, payload: entry.payload ?? {}, maxAttempts: entry.maxAttempts ?? 3, dedupeKey: `${entry.kind}:${bucket}`, runAfter: now });
    if (queued.queued) created.push(entry.kind);
  }
  return created;
}

/** Satu putaran kerja: pemulihan sewa, penjadwalan berkala, lalu menjalankan pekerjaan yang siap. */
export async function runJobCycleOnce(options: { owner?: string; limit?: number; now?: Date } = {}): Promise<JobCycleReport> {
  const owner = options.owner ?? `worker-${process.pid}`;
  const now = options.now ?? new Date();
  const startedAt = nowIso();
  const recoveredLeases = recoverExpiredLeases(now);
  const scheduled = ensureRecurringJobs(now);
  const claimed = claimJobs(options.limit ?? config.JOB_BATCH_SIZE, owner, now);
  const details: JobCycleReport["details"] = [];
  let succeeded = 0;
  let failed = 0;

  for (const job of claimed) {
    const handler = handlers.get(job.kind);
    if (!handler) {
      failed += 1;
      const outcome = failJob(job.id, `Tidak ada penangan untuk jenis pekerjaan '${job.kind}'`);
      details.push({ id: job.id, kind: job.kind, outcome: outcome.retrying ? "retry" : "failed", note: "HANDLER_MISSING" });
      continue;
    }
    try {
      const payload = job.payload ? JSON.parse(job.payload) : {};
      const result = await handler(payload, job);
      completeJob(job.id, result ?? { ok: true });
      succeeded += 1;
      details.push({ id: job.id, kind: job.kind, outcome: "done" });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = failJob(job.id, message);
      details.push({ id: job.id, kind: job.kind, outcome: outcome.retrying ? "retry" : "failed", note: message.slice(0, 200) });
    }
  }

  cyclesRun += 1;
  lastCycle = {
    owner, startedAt, finishedAt: nowIso(), recoveredLeases, scheduled,
    claimed: claimed.length, succeeded, failed, details,
  };
  return lastCycle;
}

export function jobWorkerState(): {
  running: boolean; intervalMs: number; leaseMs: number; batchSize: number; orphanAfterMs: number;
  handlers: string[]; cyclesRun: number; lastCycle: JobCycleReport | null;
} {
  return {
    running: Boolean(workerTimer),
    intervalMs: config.JOB_WORKER_INTERVAL_MS,
    leaseMs: config.JOB_LEASE_MS,
    batchSize: config.JOB_BATCH_SIZE,
    orphanAfterMs: config.JOB_ORPHAN_AFTER_MS,
    handlers: jobHandlerKinds(),
    cyclesRun,
    lastCycle,
  };
}

let workerTimer: NodeJS.Timeout | null = null;

/** Worker di dalam proses API. Aman dipanggil sekali; panggilan kedua mengembalikan timer yang sama. */
export function startJobWorker(): NodeJS.Timeout {
  if (workerTimer) return workerTimer;
  workerTimer = setInterval(() => {
    void runJobCycleOnce().catch(() => undefined);
  }, config.JOB_WORKER_INTERVAL_MS);
  workerTimer.unref?.();
  return workerTimer;
}

export function stopJobWorker(): void {
  if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
}

/**
 * Pekerjaan yang ditinggalkan proses mati. `runs` dan `workflow_executions` tidak punya sewa sendiri,
 * jadi pemeriksa ini memakai batas waktu yang lebih panjang daripada batas waktu mesin. Pekerjaan yang
 * masih sehat tidak tersentuh: batas bawaannya 45 menit, sedangkan batas waktu mesin 30 menit.
 */
export function reapAbandonedRuns(now: Date = new Date(), minAgeMs: number = config.JOB_ORPHAN_AFTER_MS): { marked: number; runs: { id: string; projectId: string; startedAt: string | null }[] } {
  const cutoff = new Date(now.getTime() - minAgeMs).toISOString();
  const rows = db.prepare(`SELECT id, project_id AS projectId, started_at AS startedAt FROM runs
    WHERE status='running' AND started_at IS NOT NULL AND started_at < ?`).all(cutoff) as any[];
  const stamp = nowIso(now);
  for (const row of rows) {
    db.prepare("UPDATE runs SET status='failed', error_code='WORKER_LOST', finished_at=? WHERE id=? AND status='running'").run(stamp, String(row.id));
  }
  return {
    marked: rows.length,
    runs: rows.map((row) => ({ id: String(row.id), projectId: String(row.projectId), startedAt: row.startedAt ?? null })),
  };
}

export function reapAbandonedExecutions(now: Date = new Date(), minAgeMs: number = config.JOB_ORPHAN_AFTER_MS): { marked: number; executions: { id: string; workflowId: string; startedAt: string | null }[] } {
  const cutoff = new Date(now.getTime() - minAgeMs).toISOString();
  const rows = db.prepare(`SELECT id, workflow_id AS workflowId, started_at AS startedAt FROM workflow_executions
    WHERE status='running' AND started_at IS NOT NULL AND started_at < ?`).all(cutoff) as any[];
  const stamp = nowIso(now);
  for (const row of rows) {
    db.prepare("UPDATE workflow_executions SET status='failed', error='WORKER_LOST: proses berhenti sebelum langkah selesai', finished_at=? WHERE id=? AND status='running'")
      .run(stamp, String(row.id));
  }
  return {
    marked: rows.length,
    executions: rows.map((row) => ({ id: String(row.id), workflowId: String(row.workflowId), startedAt: row.startedAt ?? null })),
  };
}

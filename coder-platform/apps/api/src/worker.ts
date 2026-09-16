/**
 * Dedicated queue worker (Wave 9, item 17).
 *
 * Production runs the queue in its own container so background work never competes with an HTTP
 * request for the event loop, and so a wall-clock heavy job cannot delay a user's page load:
 *
 *   coder-platform-worker  ->  node dist/api/worker.js   (this file, no HTTP listener)
 *   coder-platform-app     ->  node dist/api/server.js   (HTTP only, JOB_WORKER_IN_WEB=false)
 *
 * The worker loads the same application module as the API, which is what keeps one implementation of
 * every job handler. The two flags set below are what make the difference: `WORKER_ONLY` stops the
 * HTTP listener, and `JOB_WORKER_IN_WEB` says that this process owns the queue (leases, the boot
 * repair of abandoned runs, and the recurring cycles). They must be set BEFORE the module is imported,
 * because the configuration is read once, at import time.
 */
process.env.WORKER_ONLY = "true";
process.env.JOB_WORKER_IN_WEB = "true";
// A worker never serves pages, so the private/public directory is irrelevant here. It is set anyway so
// a missing folder can never make the import fail.
process.env.PUBLIC_DIR = process.env.PUBLIC_DIR ?? "/app/public";

await import("./server.js");
const { jobStats, jobWorkerState } = await import("./jobs.js");
const { config } = await import("./config.js");

console.log(`[worker] proses antrean siap: pid=${process.pid} interval=${config.JOB_WORKER_INTERVAL_MS}ms lease=${config.JOB_LEASE_MS}ms batch=${config.JOB_BATCH_SIZE}`);

/**
 * Periodic heartbeat: shows in `docker logs` that the worker is alive and how much it has done.
 *
 * This timer is deliberately NOT unreferenced. The queue timer inside jobs.ts is unreferenced so the
 * API process can exit on its own, which means nothing else would keep a worker process (no HTTP
 * listener) alive: it would exit a few seconds after start-up. This interval is what holds it open.
 */
const heartbeat = setInterval(() => {
  const state = jobWorkerState();
  const stats = jobStats();
  const last = state.lastCycle ? `diambil=${state.lastCycle.claimed ?? 0} berhasil=${state.lastCycle.succeeded ?? 0} gagal=${state.lastCycle.failed ?? 0}` : "belum ada putaran";
  console.log(`[worker] denyut: putaran=${state.cyclesRun} (${last}) menunggu=${stats.queued ?? 0} berjalan=${stats.running ?? 0} gagal=${stats.failed ?? 0}`);
}, Math.max(30_000, config.JOB_WORKER_INTERVAL_MS * 2));
console.log(`[worker] denyut dicatat setiap ${Math.max(30_000, config.JOB_WORKER_INTERVAL_MS * 2)} ms`);

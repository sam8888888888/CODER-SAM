/**
 * Load test for COBLAI Coder API.
 *
 * Boots its own API server (mock engine, temporary DATA_DIR), then fires N parallel runs
 * against one project: POST /api/v1/projects/:projectId/runs, then polls GET /api/v1/runs/:runId
 * until the run reaches a terminal status. It reports success/failure, latency percentiles,
 * total wall time and database consistency (run_usage rows vs completed runs).
 *
 * Usage:
 *   cd /workspace/coblai-dinda/coder-platform
 *   LOAD_N=40 npx tsx apps/api/test/load-test.mjs
 *
 * Env:
 *   LOAD_N            number of parallel runs (default 20)
 *   LOAD_TIMEOUT_MS   per-run budget for accept + completion (default 60000)
 *   LOAD_DB_WAIT_MS   how long to wait for the database to settle (default 20000)
 *
 * Prints "LOAD_TEST_PASSED" or "LOAD_TEST_FAILED=<n>" and exits 0 only when there is no failure.
 */
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const LOAD_N = Math.max(1, Number(process.env.LOAD_N ?? 20) || 20);
const RUN_TIMEOUT_MS = Math.max(1000, Number(process.env.LOAD_TIMEOUT_MS ?? 60000) || 60000);
const DB_WAIT_MS = Math.max(1000, Number(process.env.LOAD_DB_WAIT_MS ?? 20000) || 20000);

/** Picks a free port inside the range reserved for this load test. */
async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 3460 + Math.floor(Math.random() * 20); // 3460..3479
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("NO_FREE_PORT_IN_RANGE");
}

const port = await pickPort();
const startedStamp = Date.now();
const dataDir = `/tmp/coder-load-${startedStamp}`;
const dbPath = `${dataDir}/coder.db`;

process.env.NODE_ENV = "test";
process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "test-model";

const base = `http://127.0.0.1:${port}`;
let cookie = "";
let failures = 0;

function fail(name, detail = "") { console.log(`FAIL ${name}${detail ? ` ${detail}` : ""}`); failures += 1; }
function pass(name, detail = "") { console.log(`PASS ${name}${detail ? ` ${detail}` : ""}`); }

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

/** Nearest-rank percentile over an ascending copy of the values. */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
const round = (value) => Math.round(value * 100) / 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`LOAD_TEST_START n=${LOAD_N} timeout_ms=${RUN_TIMEOUT_MS} port=${port} dataDir=${dataDir}`);

// ---------------------------------------------------------------- boot server
await import("../src/server.js");
const bootDeadline = Date.now() + 20000;
let booted = false;
while (Date.now() < bootDeadline) {
  try {
    const health = await fetch(`${base}/health`);
    if (health.ok) { booted = true; break; }
  } catch { /* server is not listening yet */ }
  await sleep(100);
}
if (!booted) {
  fail("server booted", `no /health answer on ${base}`);
  console.log(`LOAD_TEST_FAILED=${failures}`);
  process.exit(1);
}
pass("server booted", base);

// ------------------------------------------------------- register + workspace
const email = `load-${randomBytes(4).toString("hex")}@example.test`;
const registered = await call("POST", "/api/v1/auth/register", { email, password: "LoadTest12345!", displayName: "Load Tester" });
if (registered.status !== 201 || !registered.json?.workspace?.id) {
  fail("register user and workspace", `${registered.status} ${JSON.stringify(registered.json)}`);
  console.log(`LOAD_TEST_FAILED=${failures}`);
  process.exit(1);
}
pass("register user and workspace", email);
const workspaceId = registered.json.workspace.id;

const project = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Load Project", slug: `load-${startedStamp}` });
if (project.status !== 201 || !project.json?.id) {
  fail("create project", `${project.status} ${JSON.stringify(project.json)}`);
  console.log(`LOAD_TEST_FAILED=${failures}`);
  process.exit(1);
}
pass("create project", project.json.id);
const projectId = project.json.id;

// ------------------------------------------------------------------- N runs
/**
 * Sends one run and polls it until it reaches a terminal status or the per-run budget runs out.
 * Poll interval grows so a big N does not flood the server with status requests.
 */
async function runOnce(index) {
  const startedAt = Date.now();
  const deadline = startedAt + RUN_TIMEOUT_MS;
  const accepted = await call("POST", `/api/v1/projects/${projectId}/runs`, { prompt: `load run ${index} ${randomUUID()}` });
  const acceptMs = Date.now() - startedAt;
  if (accepted.status !== 202 || !accepted.json?.id) {
    return { index, outcome: "http_error", acceptMs, totalMs: Date.now() - startedAt, status: null, detail: `POST_${accepted.status}:${JSON.stringify(accepted.json).slice(0, 120)}` };
  }
  const runId = accepted.json.id;
  let last = null;
  let waitMs = 50;
  while (Date.now() < deadline) {
    const polled = await call("GET", `/api/v1/runs/${runId}`);
    if (polled.status !== 200) {
      return { index, runId, outcome: "http_error", acceptMs, totalMs: Date.now() - startedAt, status: null, detail: `GET_${polled.status}:${JSON.stringify(polled.json).slice(0, 120)}` };
    }
    last = polled.json;
    if (["completed", "failed", "cancelled"].includes(last.status)) break;
    await sleep(waitMs);
    waitMs = Math.min(500, Math.round(waitMs * 1.5));
  }
  const totalMs = Date.now() - startedAt;
  if (!last || !["completed", "failed", "cancelled"].includes(last.status)) {
    return { index, runId, outcome: "timeout", acceptMs, totalMs, status: last?.status ?? null, detail: `not terminal after ${RUN_TIMEOUT_MS}ms` };
  }
  if (last.status !== "completed") {
    return { index, runId, outcome: "run_failed", acceptMs, totalMs, status: last.status, detail: last.errorCode ?? last.status };
  }
  return { index, runId, outcome: "ok", acceptMs, totalMs, status: last.status, detail: "" };
}

const wallStart = Date.now();
const results = await Promise.all(Array.from({ length: LOAD_N }, (_, index) => runOnce(index)));
const wallMs = Date.now() - wallStart;

const ok = results.filter((row) => row.outcome === "ok");
const timeouts = results.filter((row) => row.outcome === "timeout");
const httpErrors = results.filter((row) => row.outcome === "http_error");
const runFailures = results.filter((row) => row.outcome === "run_failed");
const latencies = ok.map((row) => row.totalMs);
const acceptLatencies = ok.map((row) => row.acceptMs);

for (const row of httpErrors) fail(`run ${row.index} http`, row.detail);
for (const row of runFailures) fail(`run ${row.index} status`, `${row.status} ${row.detail}`);
for (const row of timeouts) fail(`run ${row.index} timeout`, `${row.totalMs}ms accept=${row.acceptMs}ms last_status=${row.status}`);
if (ok.length === LOAD_N) pass(`runs completed ${ok.length}/${LOAD_N}`, "no per-run failure");

console.log("---- LOAD RESULT ----");
console.log(`runs_requested=${LOAD_N}`);
console.log(`runs_ok=${ok.length}`);
console.log(`runs_timeout=${timeouts.length}`);
console.log(`runs_http_error=${httpErrors.length}`);
console.log(`runs_status_failed=${runFailures.length}`);
console.log(`latency_ms_p50=${round(percentile(latencies, 50))}`);
console.log(`latency_ms_p95=${round(percentile(latencies, 95))}`);
console.log(`latency_ms_max=${round(latencies.length ? Math.max(...latencies) : 0)}`);
console.log(`accept_ms_p50=${round(percentile(acceptLatencies, 50))}`);
console.log(`accept_ms_p95=${round(percentile(acceptLatencies, 95))}`);
console.log(`accept_ms_max=${round(acceptLatencies.length ? Math.max(...acceptLatencies) : 0)}`);
console.log(`total_wall_ms=${wallMs}`);
console.log(`data_dir=${dataDir}`);
console.log(`db_path=${dbPath}`);

// --------------------------------------------------- database consistency
/** Reads the invariant counters straight from the SQLite file written by the server. */
function readDb() {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const one = (sql, ...args) => db.prepare(sql).get(...args).n;
    const statuses = db.prepare("SELECT id, status FROM runs WHERE project_id=?").all(projectId);
    return {
      runsTotal: one("SELECT COUNT(*) AS n FROM runs WHERE project_id=?", projectId),
      runsCompleted: one("SELECT COUNT(*) AS n FROM runs WHERE project_id=? AND status='completed'", projectId),
      runsFailed: one("SELECT COUNT(*) AS n FROM runs WHERE project_id=? AND status='failed'", projectId),
      runsUnfinished: one("SELECT COUNT(*) AS n FROM runs WHERE project_id=? AND status IN ('queued','running')", projectId),
      usageRows: one("SELECT COUNT(*) AS n FROM run_usage WHERE project_id=?", projectId),
      usageDistinctRuns: one("SELECT COUNT(DISTINCT run_id) AS n FROM run_usage WHERE project_id=?", projectId),
      usageOrphans: one("SELECT COUNT(*) AS n FROM run_usage u LEFT JOIN runs r ON r.id=u.run_id WHERE u.project_id=? AND r.id IS NULL", projectId),
      statusById: new Map(statuses.map((row) => [row.id, row.status])),
    };
  } finally {
    db.close();
  }
}

// The last runs may still be finishing, so wait until the database settles (or the wait budget ends).
const dbDeadline = Date.now() + DB_WAIT_MS;
let dbCounters = null;
while (Date.now() < dbDeadline) {
  dbCounters = readDb();
  if (dbCounters.runsCompleted + dbCounters.runsFailed === dbCounters.runsTotal) break;
  await sleep(250);
}
if (!dbCounters) dbCounters = readDb();

// Runs the client gave up on may have completed later; that is reported, not hidden.
const lateCompleted = timeouts.filter((row) => row.runId && dbCounters.statusById.get(row.runId) === "completed");
const stillRunning = timeouts.filter((row) => row.runId && ["queued", "running"].includes(dbCounters.statusById.get(row.runId)));

console.log("---- DB CONSISTENCY ----");
console.log(`db_runs_total=${dbCounters.runsTotal}`);
console.log(`db_runs_completed=${dbCounters.runsCompleted}`);
console.log(`db_runs_failed=${dbCounters.runsFailed}`);
console.log(`db_runs_unfinished=${dbCounters.runsUnfinished}`);
console.log(`db_run_usage_rows=${dbCounters.usageRows}`);
console.log(`db_run_usage_distinct_runs=${dbCounters.usageDistinctRuns}`);
console.log(`db_run_usage_orphans=${dbCounters.usageOrphans}`);
console.log(`timeouts_completed_later_in_db=${lateCompleted.length}`);
console.log(`timeouts_still_unfinished_in_db=${stillRunning.length}`);

if (dbCounters.runsCompleted !== ok.length) {
  console.log(`NOTE client_ok=${ok.length} db_completed=${dbCounters.runsCompleted} (difference = runs finished after the client timeout)`);
}
if (dbCounters.usageRows === dbCounters.runsCompleted && dbCounters.usageDistinctRuns === dbCounters.usageRows && dbCounters.usageOrphans === 0) {
  pass("db run_usage rows match completed runs", `${dbCounters.usageRows} == ${dbCounters.runsCompleted}`);
} else {
  fail("db run_usage rows match completed runs",
    `usage=${dbCounters.usageRows} distinct=${dbCounters.usageDistinctRuns} orphans=${dbCounters.usageOrphans} completed=${dbCounters.runsCompleted}`);
}
if (dbCounters.runsUnfinished === 0) pass("db has no run left queued or running", "0");
else fail("db has no run left queued or running", String(dbCounters.runsUnfinished));

console.log(failures === 0 ? "LOAD_TEST_PASSED" : `LOAD_TEST_FAILED=${failures}`);
process.exit(failures === 0 ? 0 : 1);

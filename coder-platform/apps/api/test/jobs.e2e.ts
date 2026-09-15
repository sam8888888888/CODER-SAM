/**
 * Uji antrean pekerjaan latar (Wave 5). Membuktikan janji utamanya: pekerjaan latar TIDAK hilang saat
 * proses mati, tidak dikerjakan dua worker sekaligus, dan tidak menggantung selamanya.
 *
 * Yang diuji:
 *  1) tabel `jobs` ada di skema 13 dan pekerjaan baru masuk sebagai `queued`;
 *  2) sewa (lease): pekerjaan yang sedang dipegang worker lain tidak boleh diambil ulang;
 *  3) percobaan gagal dikembalikan ke antrean dengan jeda, dan berhenti sebagai `failed` setelah habis;
 *  4) RESTART: pekerjaan `running` yang sewanya kedaluwarsa (proses mati) dikembalikan ke antrean dan
 *     benar-benar dikerjakan pada putaran berikutnya;
 *  5) run yang sudah tersimpan tetapi BELUM dijalankan (proses mati sebelum kirim ke mesin) dijalankan
 *     oleh antrean, dan run yang sudah selesai TIDAK dijalankan ulang;
 *  6) pemeriksa pekerjaan menggantung menandai run/eksekusi lama sebagai failed `WORKER_LOST`, tetapi
 *     TIDAK menyentuh pekerjaan yang masih sehat;
 *  7) rute admin `/api/v1/admin/jobs` menolak non-admin dan bekerja untuk admin.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/jobs.e2e.ts
 */

const port = 6200 + Math.floor(Math.random() * 200); // rentang khusus 6200-6400
const dataDir = `/tmp/coder-jobs-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `jobs-admin-${stamp}@example.test`;
const outsiderEmail = `jobs-outsider-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "jobs-test-model";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
// Pengiriman email dan retensi tetap MATI, jadi suite ini tidak mengirim email atau menghapus data.
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.RETENTION_ENABLED = "false";
// Interval worker dibuat sangat panjang supaya hanya putaran yang dipanggil uji ini yang berjalan.
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.JOB_BATCH_SIZE = "20";
process.env.JOB_LEASE_MS = "60000";

await import("../src/server.js");
const jobsMod: any = await import("../src/jobs.js");
const dbMod: any = await import("../src/db.js");
const db = dbMod.db;

const base = `http://127.0.0.1:${port}`;

let checks = 0;
let passed = 0;
let failed = 0;
const failedNames: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) { passed += 1; console.log(`PASS ${checks}) ${name}`); return; }
  failed += 1; failedNames.push(`${checks}) ${name}`);
  console.log(`FAIL ${checks}) ${name}${detail ? ` :: ${detail}` : ""}`);
}
function short(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

type Reply = { status: number; json: any; text: string };
type ApiClient = { call: (method: string, path: string, body?: unknown) => Promise<Reply> };

function client(): ApiClient {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) { const value = setCookie.split(";")[0]; cookie = value.endsWith("=") ? "" : value; }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, json, text };
    },
  };
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { await response.arrayBuffer(); return; } } catch { /* server belum siap */ }
    await sleep(250);
  }
  throw new Error("server tidak siap");
}

await waitForHealth();
console.log("serve: server uji siap");

// Putaran pertama (saat boot) dijalankan server sendiri. Tunggu selesai supaya tidak beradu dengan uji.
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (jobsMod.jobWorkerState().cyclesRun >= 1) break;
  await sleep(100);
}

const admin = client();
const outsider = client();
const registerAdmin = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password: "SandiUji2026!aman", displayName: "Admin Antrean" });
check("pendaftaran admin berhasil", registerAdmin.status === 200 || registerAdmin.status === 201, short(registerAdmin.json));
const loginAdmin = await admin.call("POST", "/api/v1/auth/login", { email: adminEmail, password: "SandiUji2026!aman" });
check("login admin berhasil", loginAdmin.status === 200, short(loginAdmin.json));
// Pendaftaran pengguna kedua memakai klien TERPISAH supaya cookie admin tidak tertimpa.
const registerOutsider = await outsider.call("POST", "/api/v1/auth/register", { email: outsiderEmail, password: "SandiUji2026!aman", displayName: "Bukan Admin" });
check("pendaftaran pengguna non-admin berhasil", registerOutsider.status === 200 || registerOutsider.status === 201, short(registerOutsider.json));

/* ---------------------------------- 1) bentuk tabel dan skema ---------------------------------- */

const schemaRow = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as any;
check("skema basis data minimal 14 (tabel jobs dan webhook ikut terpasang)", Number(schemaRow?.version) >= 14, short(schemaRow));
const jobColumns = (db.prepare("PRAGMA table_info(jobs)").all() as any[]).map((row) => String(row.name));
const expectedColumns = ["id", "kind", "status", "payload", "result", "attempts", "max_attempts", "run_after", "lock_owner", "lock_expires_at", "last_error", "dedupe_key", "created_at", "updated_at", "finished_at"];
check("kolom tabel jobs lengkap", expectedColumns.every((name) => jobColumns.includes(name)), short(jobColumns));
check("ada indeks kesiapan pekerjaan (status, run_after)",
  (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'").all() as any[]).some((row) => String(row.name) === "idx_jobs_ready"),
  short(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='jobs'").all()));

/* ---------------------------------- 2) antre, dedupe, sewa ---------------------------------- */

jobsMod.registerJobHandler("probe.echo", async (payload: any) => ({ echo: payload.value ?? null }));
jobsMod.registerJobHandler("probe.fail", async () => { throw new Error("probe gagal sengaja"); });

const first = jobsMod.enqueueJob({ kind: "probe.echo", payload: { value: "satu" }, dedupeKey: `probe-${stamp}` });
const firstRow = jobsMod.getJob(first.id);
check("pekerjaan baru masuk sebagai queued dengan percobaan 0",
  first.queued === true && firstRow?.status === "queued" && Number(firstRow?.attempts) === 0 && Number(firstRow?.maxAttempts) === 3, short(firstRow));
const duplicate = jobsMod.enqueueJob({ kind: "probe.echo", payload: { value: "dua" }, dedupeKey: `probe-${stamp}` });
check("kunci dedupe mencegah pekerjaan kembar",
  duplicate.queued === false && duplicate.reason === "DUPLICATE" && duplicate.id === first.id, short(duplicate));
check("hanya satu baris untuk kunci dedupe yang sama",
  Number((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE dedupe_key=?").get(`probe-${stamp}`) as any).n) === 1);

const cycleFirst = await jobsMod.runJobCycleOnce({ owner: "uji-cycle", limit: 20 });
const echoRow = jobsMod.getJob(first.id);
check("putaran kerja menjalankan handler sampai selesai",
  echoRow?.status === "done" && String(echoRow?.result).includes("satu") && cycleFirst.claimed >= 1, short(echoRow));

const future = jobsMod.enqueueJob({ kind: "probe.echo", payload: { value: "nanti" }, runAfter: new Date(Date.now() + 3_600_000).toISOString() });
const claimedFuture = jobsMod.claimJobs(50, "uji-a");
check("pekerjaan bertanggal masa depan belum diambil", claimedFuture.every((row: any) => row.id !== future.id), short(claimedFuture.map((row: any) => row.kind)));
db.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), future.id);
const claimedNow = jobsMod.claimJobs(50, "uji-a");
const claimedFutureRow = claimedNow.find((row: any) => row.id === future.id);
check("setelah waktunya tiba pekerjaan diambil dengan sewa",
  Boolean(claimedFutureRow) && claimedFutureRow.status === "running" && Number(claimedFutureRow.attempts) === 1
    && claimedFutureRow.lockOwner === "uji-a" && Boolean(claimedFutureRow.lockExpiresAt), short(claimedFutureRow));

const steal = jobsMod.claimJobs(50, "uji-b").find((row: any) => row.id === future.id);
check("pekerjaan yang sedang dipegang worker lain tidak diambil ulang", steal === undefined);

jobsMod.completeJob(future.id, { echo: "nanti" });
const doneRow = jobsMod.getJob(future.id);
check("pekerjaan selesai ditandai done dan hasilnya disimpan",
  doneRow?.status === "done" && String(doneRow?.result).includes("nanti") && Boolean(doneRow?.finishedAt)
    && doneRow?.lockOwner === null && doneRow?.lockExpiresAt === null, short(doneRow));

const missing = jobsMod.enqueueJob({ kind: "probe.tanpa-handler", payload: {}, maxAttempts: 1 });
await jobsMod.runJobCycleOnce({ owner: "uji-cycle", limit: 20 });
const missingRow = jobsMod.getJob(missing.id);
check("jenis pekerjaan tanpa handler gagal dengan alasan yang jelas",
  missingRow?.status === "failed" && Number(missingRow?.attempts) === 1 && String(missingRow?.lastError).includes("Tidak ada penangan"), short(missingRow));

/* ---------------------------------- 3) gagal, jeda, dan ulang ---------------------------------- */

const failing = jobsMod.enqueueJob({ kind: "probe.fail", payload: {}, maxAttempts: 2 });
await jobsMod.runJobCycleOnce({ owner: "uji-cycle", limit: 20 });
const failingAfterOne = jobsMod.getJob(failing.id);
check("kegagalan pertama dikembalikan ke antrean dengan jeda dan alasan disimpan",
  failingAfterOne?.status === "queued" && String(failingAfterOne?.lastError).includes("probe gagal sengaja")
    && new Date(String(failingAfterOne?.runAfter)).getTime() > Date.now(), short(failingAfterOne));
check("pekerjaan berjeda tidak langsung diambil lagi",
  jobsMod.claimJobs(50, "uji-c").every((row: any) => row.id !== failing.id));

db.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), failing.id);
await jobsMod.runJobCycleOnce({ owner: "uji-cycle", limit: 20 });
const failingAfterTwo = jobsMod.getJob(failing.id);
check("kegagalan saat percobaan sudah habis menjadi failed permanen",
  failingAfterTwo?.status === "failed" && Number(failingAfterTwo?.attempts) === 2 && Boolean(failingAfterTwo?.finishedAt), short(failingAfterTwo));

const retryFailed = jobsMod.retryJob(failing.id);
check("pekerjaan gagal bisa diulang dari nol", retryFailed.ok === true && jobsMod.getJob(failing.id)?.status === "queued"
  && Number(jobsMod.getJob(failing.id)?.attempts) === 0, short(jobsMod.getJob(failing.id)));
check("pekerjaan yang masih menunggu menolak diulang",
  jobsMod.retryJob(failing.id).reason === "JOB_ALREADY_PENDING", short(jobsMod.retryJob(failing.id)));
check("pekerjaan yang tidak ada dilaporkan JOB_NOT_FOUND", jobsMod.retryJob("tidak-ada").reason === "JOB_NOT_FOUND");

/* ---------------------------------- 4) RESTART: sewa kedaluwarsa ---------------------------------- */

function insertStaleRunning(id: string, kind: string, attempts: number, maxAttempts: number): void {
  const past = new Date(Date.now() - 600_000).toISOString();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (id, kind, status, payload, attempts, max_attempts, run_after, lock_owner, lock_expires_at, created_at, updated_at)
    VALUES (?, ?, 'running', '{"value":"setelah-restart"}', ?, ?, ?, 'worker-mati', ?, ?, ?)`).run(id, kind, attempts, maxAttempts, now, past, now, now);
}

insertStaleRunning("job-stale-recover", "probe.echo", 1, 3);
const recoveredCount = jobsMod.recoverExpiredLeases();
const staleAfter = jobsMod.getJob("job-stale-recover");
check("sewa kedaluwarsa dikembalikan ke antrean (pekerjaan tidak hilang)",
  recoveredCount >= 1 && staleAfter?.status === "queued" && String(staleAfter?.lastError).includes("WORKER_LOST")
    && staleAfter?.lockOwner === null, short(staleAfter));

insertStaleRunning("job-stale-exhausted", "probe.echo", 2, 2);
jobsMod.recoverExpiredLeases();
const exhausted = jobsMod.getJob("job-stale-exhausted");
check("pekerjaan yang percobaannya habis saat proses mati ditandai failed",
  exhausted?.status === "failed" && String(exhausted?.lastError).includes("WORKER_LOST"), short(exhausted));

insertStaleRunning("job-stale-run", "probe.echo", 1, 3);
const cycleRestart = await jobsMod.runJobCycleOnce({ owner: "uji-restart", limit: 20 });
const restartedRow = jobsMod.getJob("job-stale-run");
check("pekerjaan yang ditinggalkan proses mati benar-benar dikerjakan pada putaran berikutnya",
  cycleRestart.recoveredLeases >= 1 && restartedRow?.status === "done" && String(restartedRow?.result).includes("setelah-restart"),
  short({ cycle: cycleRestart.recoveredLeases, job: restartedRow }));

const stats = jobsMod.jobStats();
check("statistik antrean konsisten dengan jumlah baris",
  stats.total === stats.queued + stats.running + stats.done + stats.failed
    && stats.done >= 2 && stats.failed >= 1 && Number(stats.byKind["probe.echo"]) >= 4, short(stats));

/* ---------------------------------- 5) rute admin ---------------------------------- */

const denied = await outsider.call("GET", "/api/v1/admin/jobs");
check("non-admin ditolak membuka antrean (403 ADMIN_REQUIRED)", denied.status === 403 && denied.json?.error === "ADMIN_REQUIRED", short(denied.json));

const listed = await admin.call("GET", "/api/v1/admin/jobs");
check("admin membuka antrean dan melihat statistik",
  listed.status === 200 && listed.json?.stats?.total >= 1 && listed.json?.worker?.running === true, short(listed.json?.stats));
check("worker melaporkan penangan bawaan dan interval panjang dari uji",
  ["run.execute", "email.deliver", "retention.run", "run.reap", "workflow.reap"].every((kind) => (listed.json?.worker?.handlers ?? []).includes(kind))
    && Number(listed.json?.worker?.intervalMs) === 3_600_000, short(listed.json?.worker?.handlers));

const filteredStatus = await admin.call("GET", "/api/v1/admin/jobs?status=failed");
check("saringan status hanya mengembalikan status itu",
  filteredStatus.status === 200 && (filteredStatus.json?.jobs ?? []).length >= 1
    && (filteredStatus.json?.jobs ?? []).every((row: any) => row.status === "failed"), short(filteredStatus.json?.jobs));
const filteredKind = await admin.call("GET", "/api/v1/admin/jobs?kind=probe.echo");
check("saringan jenis hanya mengembalikan jenis itu",
  filteredKind.status === 200 && (filteredKind.json?.jobs ?? []).every((row: any) => row.kind === "probe.echo"), short(filteredKind.json?.jobs));

const retryMissing = await admin.call("POST", "/api/v1/admin/jobs/tidak-ada/retry");
check("rute ulang pekerjaan asing menjawab 404 JOB_NOT_FOUND", retryMissing.status === 404 && retryMissing.json?.error === "JOB_NOT_FOUND", short(retryMissing.json));
const retryDenied = await outsider.call("POST", `/api/v1/admin/jobs/${missing.id}/retry`);
check("non-admin tidak boleh mengulang pekerjaan", retryDenied.status === 403 && retryDenied.json?.error === "ADMIN_REQUIRED", short(retryDenied.json));
const retried = await admin.call("POST", `/api/v1/admin/jobs/${missing.id}/retry`);
check("admin bisa mengulang pekerjaan gagal", retried.status === 200 && retried.json?.retried === true && retried.json?.job?.status === "queued", short(retried.json));

const tick = await admin.call("POST", "/api/v1/admin/jobs/tick");
check("admin bisa menjalankan satu putaran antrean",
  tick.status === 200 && typeof tick.json?.cycle?.claimed === "number" && typeof tick.json?.stats?.total === "number", short(tick.json?.cycle));
const auditCycle = db.prepare("SELECT action FROM audit_events WHERE action='admin.job.cycle' ORDER BY created_at DESC LIMIT 1").get() as any;
check("putaran yang dijalankan admin dicatat di jejak audit", Boolean(auditCycle), short(auditCycle));

/* ---------------------------------- 6) run yang belum dijalankan ---------------------------------- */

// Pendaftaran sudah membuat ruang kerja pribadi beserta proyek bawaannya, jadi uji ini memakainya.
const workspaces = await admin.call("GET", "/api/v1/workspaces");
const workspaceId = (workspaces.json ?? [])[0]?.id;
check("ruang kerja milik admin terbaca", Boolean(workspaceId), short(workspaces.json));
const project = await admin.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: `Proyek Antrean ${stamp}` });
const projectId = project.json?.project?.id ?? project.json?.id;
check("proyek uji dibuat lewat API", Boolean(projectId), short(project.json));

const adminUser = db.prepare("SELECT id FROM users WHERE email=?").get(adminEmail) as any;
const orphanRunId = `run-orphan-${stamp}`;
const queueRunId = `run-recovered-${stamp}`;
db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)")
  .run(queueRunId, projectId, "queued", "halo antrean", "jobs-test-model", new Date().toISOString());
const queuedJob = jobsMod.enqueueJob({
  kind: "run.execute", maxAttempts: 1, dedupeKey: `run.execute:${queueRunId}`,
  payload: { runId: queueRunId, projectId, prompt: "halo antrean", model: "jobs-test-model", userId: adminUser.id, autonomous: false },
});
await jobsMod.runJobCycleOnce({ owner: "uji-run", limit: 20 });
await sleep(1500);
const recoveredRun = db.prepare("SELECT status, result FROM runs WHERE id=?").get(queueRunId) as any;
const recoveredJob = jobsMod.getJob(queuedJob.id);
check("run yang tersimpan tetapi belum dikirim akhirnya DIJALANKAN oleh antrean",
  recoveredJob?.status === "done" && String(recoveredJob?.result).includes("dispatched") && recoveredRun?.status === "completed",
  short({ job: recoveredJob, run: recoveredRun }));

const skipJob = jobsMod.enqueueJob({
  kind: "run.execute", maxAttempts: 1, dedupeKey: `run.execute:${queueRunId}-ulang`,
  payload: { runId: queueRunId, projectId, prompt: "halo antrean", model: "jobs-test-model", userId: adminUser.id },
});
await jobsMod.runJobCycleOnce({ owner: "uji-run", limit: 20 });
const skipRow = jobsMod.getJob(skipJob.id);
check("run yang sudah selesai TIDAK dijalankan ulang oleh antrean",
  skipRow?.status === "done" && String(skipRow?.result).includes("RUN_COMPLETED"), short(skipRow));

const notFoundJob = jobsMod.enqueueJob({ kind: "run.execute", maxAttempts: 1, payload: { runId: orphanRunId, projectId, prompt: "x", userId: adminUser.id } });
await jobsMod.runJobCycleOnce({ owner: "uji-run", limit: 20 });
check("pekerjaan run yang barisnya sudah tidak ada dilewati dengan alasan jelas",
  String(jobsMod.getJob(notFoundJob.id)?.result).includes("RUN_NOT_FOUND"), short(jobsMod.getJob(notFoundJob.id)));

/* ---------------------------------- 7) pemeriksa pekerjaan menggantung ---------------------------------- */

const oldRunId = `run-old-${stamp}`;
db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,started_at,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(oldRunId, projectId, "running", "run lama", "jobs-test-model", new Date(Date.now() - 7_200_000).toISOString(), new Date(Date.now() - 7_200_000).toISOString());
const freshRunId = `run-fresh-${stamp}`;
db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,started_at,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(freshRunId, projectId, "running", "run baru", "jobs-test-model", new Date().toISOString(), new Date().toISOString());
const reap = jobsMod.reapAbandonedRuns();
const oldRunAfter = db.prepare("SELECT status, error_code FROM runs WHERE id=?").get(oldRunId) as any;
const freshRunAfter = db.prepare("SELECT status FROM runs WHERE id=?").get(freshRunId) as any;
check("run yang ditinggalkan proses mati ditandai failed WORKER_LOST",
  reap.marked >= 1 && oldRunAfter?.status === "failed" && oldRunAfter?.error_code === "WORKER_LOST", short({ reap: reap.marked, run: oldRunAfter }));
check("run yang masih dalam batas waktu TIDAK diganggu pemeriksa", freshRunAfter?.status === "running", short(freshRunAfter));
const freshWithLongAge = jobsMod.reapAbandonedRuns(new Date(), 60_000);
check("batas waktu pemeriksa bisa diatur dan run baru tetap aman", freshWithLongAge.marked === 0, short(freshWithLongAge));

const workflow = await admin.call("POST", `/api/v1/projects/${projectId}/workflows`, {
  name: `Alur Antrean ${stamp}`, description: "uji pemeriksa", steps: [{ name: "Langkah satu", type: "prompt", prompt: "halo" }],
});
const workflowId = workflow.json?.workflow?.id ?? workflow.json?.id;
check("alur kerja uji dibuat", Boolean(workflowId), short(workflow.json));
const published = await admin.call("POST", `/api/v1/workflows/${workflowId}/publish`);
check("alur kerja uji diterbitkan supaya bisa dijalankan", published.status === 200, short(published.json));
const execution = await admin.call("POST", `/api/v1/workflows/${workflowId}/execute`, { input: "halo" });
const executionId = execution.json?.execution?.id ?? execution.json?.id ?? execution.json?.executionId;
check("eksekusi alur kerja dimulai", Boolean(executionId), short(execution.json));
await sleep(1200);
db.prepare("UPDATE workflow_executions SET status='running', started_at=?, finished_at=NULL WHERE id=?")
  .run(new Date(Date.now() - 7_200_000).toISOString(), executionId);
const reapExecutions = jobsMod.reapAbandonedExecutions();
const executionAfter = db.prepare("SELECT status, error FROM workflow_executions WHERE id=?").get(executionId) as any;
check("eksekusi alur kerja yang menggantung ditandai failed WORKER_LOST",
  reapExecutions.marked >= 1 && executionAfter?.status === "failed" && String(executionAfter?.error).includes("WORKER_LOST"), short({ reap: reapExecutions.marked, execution: executionAfter }));

const emptyReap = jobsMod.reapAbandonedExecutions();
check("pemeriksa aman dijalankan berulang kali (tidak menggantung dua kali)", emptyReap.marked === 0, short(emptyReap));

/* ---------------------------------- 8) pekerjaan berkala & status hub ---------------------------------- */

const finalStats = jobsMod.jobStats();
check("pekerjaan berkala (retensi & pemeriksa run) sudah pernah diantre sejak boot",
  Number(finalStats.byKind["retention.run"]) >= 1 && Number(finalStats.byKind["run.reap"]) >= 1, short(finalStats.byKind));
check("pengiriman email TIDAK diantre selagi NOTIFY_EMAIL_ENABLED=false",
  Number(finalStats.byKind["email.deliver"] ?? 0) === 0, short(finalStats.byKind));

const hub = await admin.call("GET", "/api/v1/status-hub");
check("status hub melaporkan keadaan antrean pekerjaan",
  hub.status === 200 && typeof hub.json?.backgroundWork?.queue?.total === "number"
    && hub.json?.backgroundWork?.worker?.running === true && hub.json?.backgroundWork?.reapOnBoot === true, short(hub.json?.backgroundWork));

console.log("");
console.log(`HASIL: ${passed}/${checks} lulus, ${failed} gagal`);
if (failed) { console.log("Gagal pada:"); for (const name of failedNames) console.log(` - ${name}`); process.exit(1); }
console.log("ALL_JOBS_TESTS_PASSED");
process.exit(0);

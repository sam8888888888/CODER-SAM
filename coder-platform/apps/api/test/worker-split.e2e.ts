/**
 * Uji Wave 9 (v0.19.0) — item 17: antrean berjalan di proses terpisah.
 *
 * Yang dibuktikan (dengan dua proses nyata, bukan tiruan):
 *  1) proses API dengan JOB_WORKER_IN_WEB=false TIDAK mengambil pekerjaan dari antrean;
 *  2) proses `apps/api/src/worker.ts` mengambil pekerjaan itu dan menyelesaikannya;
 *  3) proses pekerja tidak membuka pendengar HTTP sama sekali;
 *  4) proses pekerja tetap hidup saat menganggur (penjaga event loop), yaitu bug yang benar-benar
 *     terjadi: timer antrean di jobs.ts di-unref, jadi tanpa penjaga proses keluar beberapa detik
 *     sesudah menyala;
 *  5) kontrak statis berkas deploy: tiga service compose (biru, hijau dengan profil `green`, dan
 *     pekerja), serta dua gerbang di skrip deploy (rehearsal migrasi dan pergantian biru-hijau).
 *
 * Jalankan: npx tsx apps/api/test/worker-split.e2e.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const port = 7080 + Math.floor(Math.random() * 18); // rentang khusus 7080-7097
const portUnused = port + 1;
const dataDir = `/tmp/coder-wave9-worker-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)); // .../coder-platform

process.env.NODE_ENV = "test";
process.env.DATA_DIR = dataDir;
process.env.MOCK_ENGINE = "true";
process.env.NOTIFY_EMAIL_ENABLED = "false";

const { db } = await import("../src/db.js");
const { enqueueJob } = await import("../src/jobs.js");

let passed = 0; let failed = 0;
const failedNames: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}

type Proc = { child: ChildProcess; log: () => string };
function start(script: string, extraEnv: Record<string, string>): Proc {
  let log = "";
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += String(chunk); });
  child.stderr?.on("data", (chunk) => { log += String(chunk); });
  return { child, log: () => log };
}

async function stop(proc: Proc | null, name: string) {
  if (!proc || proc.child.exitCode !== null) return;
  proc.child.kill("SIGTERM");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (proc.child.exitCode !== null) return;
    await delay(250);
  }
  proc.child.kill("SIGKILL");
  console.log(`INFO ${name} dihentikan paksa`);
}

async function responds(url: string): Promise<boolean> {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(2500) }); return response.ok; } catch { return false; }
}

async function waitFor(check_: () => Promise<boolean> | boolean, tries: number, stepMs = 250): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await check_()) return true;
    await delay(stepMs);
  }
  return false;
}

function jobStatus(id: string): string {
  const row = db.prepare("SELECT status FROM jobs WHERE id=?").get(id) as { status?: string } | undefined;
  return String(row?.status ?? "missing");
}

const sharedEnv = {
  DATA_DIR: dataDir,
  NODE_ENV: "test",
  MOCK_ENGINE: "true",
  NOTIFY_EMAIL_ENABLED: "false",
  HOST: "127.0.0.1",
  PUBLIC_DIR: `${dataDir}/public`,
  JOB_WORKER_INTERVAL_MS: "1500",
  JOB_REAP_ON_BOOT: "false",
  APP_VERSION: "0.19.0",
};

let api: Proc | null = null;
let worker: Proc | null = null;
try {
  // --- 1) API tanpa hak antrean ---------------------------------------------------------------
  api = start("apps/api/src/server.ts", { ...sharedEnv, PORT: String(port), JOB_WORKER_IN_WEB: "false" });
  const apiReady = await waitFor(() => responds(`http://127.0.0.1:${port}/ready`), 160, 250);
  check("1) API (JOB_WORKER_IN_WEB=false) melayani /ready", apiReady, api.log().slice(-400));
  const apiLog = api.log();
  check("1) log API menyatakan antrean milik proses terpisah",
    apiLog.includes("antrean milik proses pekerja terpisah"), apiLog.slice(-400));
  check("1) API tidak menyalakan pekerja di dalam proses webnya", !apiLog.includes("[jobs] worker aktif"), apiLog.slice(-400));

  // --- 2) pekerjaan menunggu selama hanya API yang hidup ---------------------------------------
  const job = enqueueJob({ kind: "email.deliver" });
  const jobId = String(job.id);
  const stayedQueued = await waitFor(async () => false, 24, 250); // 6 detik, lebih dari tiga interval antrean
  void stayedQueued;
  check("2) pekerjaan tetap 'queued' setelah 6 detik walau API hidup", jobStatus(jobId) === "queued",
    `status=${jobStatus(jobId)}`);

  // --- 3) proses pekerja mengambil pekerjaan itu ----------------------------------------------
  worker = start("apps/api/src/worker.ts", { ...sharedEnv, PORT: String(portUnused), JOB_WORKER_IN_WEB: "false" });
  const workerSaidNoHttp = await waitFor(() => worker!.log().includes("HTTP tidak dijalankan"), 80, 250);
  check("3) proses pekerja menyatakan HTTP tidak dijalankan (WORKER_ONLY)", workerSaidNoHttp, worker.log().slice(-400));
  check("3) proses pekerja tidak menempati PORT yang diberikan",
    !(await responds(`http://127.0.0.1:${portUnused}/ready`)) && !(await responds(`http://127.0.0.1:${portUnused}/health`)));

  const done = await waitFor(() => jobStatus(jobId) === "done", 120, 250);
  check("3) pekerjaan diselesaikan oleh proses pekerja (status 'done')", done, `status=${jobStatus(jobId)}`);
  const log = worker.log();
  check("3) log pekerja menyebut putaran antrean", log.includes("[worker] proses antrean siap"), log.slice(-400));

  // --- 4) penjaga event loop: proses pekerja tetap hidup saat menganggur ------------------------
  await delay(6000);
  check("4) proses pekerja masih hidup setelah menganggur 6 detik", worker.child.exitCode === null,
    `exitCode=${worker.child.exitCode} log=${worker.log().slice(-300)}`);

  // --- 5) kontrak statis berkas deploy ---------------------------------------------------------
  const compose = readFileSync(`${repoRoot}/docker-compose.austria.yml`, "utf8");
  check("5) compose memuat service biru", compose.includes("coder-platform-app:") && compose.includes("127.0.0.1:3402:3402"));
  check("5) compose memuat service hijau dengan profil 'green' dan port 3403",
    compose.includes("coder-platform-app-green") && compose.includes("127.0.0.1:3403:3402") && /profiles:\s*\n\s*-\s*green/.test(compose));
  check("5) compose memuat service pekerja tanpa port yang dipublikasikan",
    compose.includes("coder-platform-worker") && compose.includes("dist/api/worker.js") && compose.includes("healthcheck:"));
  check("5) biru dan hijau memakai satu definisi bersama (anchor x-app)",
    compose.includes("x-app: &app") && compose.includes("<<: *app"));
  // Skrip deploy tinggal di akar repositori (satu tingkat di atas coder-platform), karena ia juga
  // mengemas coder-dashboard dan hanya dipakai dari komputer pengembang.
  const deployScript = readFileSync(fileURLToPath(new URL("../../../../deploy/deploy-austria.sh", import.meta.url)), "utf8");
  check("5) skrip deploy menjalankan rehearsal migrasi sebelum mengganti container",
    deployScript.includes("migration-rehearsal.js") && deployScript.indexOf("migration-rehearsal.js") < deployScript.indexOf("--force-recreate coder-platform-app"));
  check("5) skrip deploy memakai pergantian biru-hijau",
    deployScript.includes("coder-platform-app-green") && deployScript.includes("point_nginx 3403") && deployScript.includes("--profile green"));
  check("5) skrip deploy me-recreate container pekerja", deployScript.includes("--force-recreate coder-platform-worker"));
  check("5) alat rehearsal ada di dalam paket aplikasi (ikut terkompilasi)",
    readFileSync(`${repoRoot}/apps/api/src/migration-rehearsal.ts`, "utf8").includes("MIGRATION_REHEARSAL_OK"));

  // --- 6) rehearsal migrasi atas cadangan hanya-baca -------------------------------------------
  // Kegagalan nyata di gerbang deploy 16 Sep 2026: volume cadangan dipasang `:ro`, dan SQLite
  // menolak membuka basis data mode WAL secara hanya-baca di sana karena ia ingin membuat berkas
  // `-shm` di sampingnya ("attempt to write a readonly database"). Alat rehearsal sekarang menyalin
  // dulu lalu membaca salinannya, dan berkas aslinya tidak boleh tersentuh sama sekali. Sebagian
  // pemeriksaan di bawah tetap berguna saat dijalankan sebagai root, karena root bisa menembus izin
  // berkas: yang diperiksa adalah ukuran, mode, dan waktu ubah berkas aslinya.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const roDir = mkdtempSync(join(tmpdir(), "coder-ro-"));
  const roSource = join(roDir, "coder.db");
  copyFileSync(join(dataDir, "coder.db"), roSource);
  chmodSync(roSource, 0o444);
  chmodSync(roDir, 0o555);
  const roBefore = { size: statSync(roSource).size, mode: statSync(roSource).mode & 0o777, mtime: statSync(roSource).mtimeMs };
  const rehearsal = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/migration-rehearsal.ts", roSource],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env }, timeout: 240_000 });
  const rehearsalOut = `${rehearsal.stdout ?? ""}${rehearsal.stderr ?? ""}`;
  const rehearsalTail = rehearsalOut.slice(-260).replace(/\s+/g, " ");
  check("6) rehearsal lulus atas salinan cadangan hanya-baca", rehearsalOut.includes("MIGRATION_REHEARSAL_OK"), rehearsalTail);
  check("6) jumlah baris tabel penting tidak berubah", rehearsalOut.includes("ROW_COUNTS_PRESERVED true"), rehearsalTail);
  check("6) berkas asli tidak diubah (ukuran, mode, waktu ubah sama)",
    statSync(roSource).size === roBefore.size && (statSync(roSource).mode & 0o777) === roBefore.mode && statSync(roSource).mtimeMs === roBefore.mtime,
    `size=${statSync(roSource).size} mode=${(statSync(roSource).mode & 0o777).toString(8)}`);
  check("6) berkas asli masih hanya-baca", (statSync(roSource).mode & 0o777) === 0o444);
  chmodSync(roDir, 0o755);
  rmSync(roDir, { recursive: true, force: true });
} finally {
  await stop(worker, "pekerja");
  await stop(api, "API");
  try { db.close(); } catch { /* sudah tertutup */ }
}

console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed}`);
if (failed) { console.log(`GAGAL: ${failedNames.join(" | ")}`); console.log("WORKER_SPLIT_TESTS_FAILED"); process.exit(1); }
console.log("ALL_WORKER_SPLIT_TESTS_PASSED");

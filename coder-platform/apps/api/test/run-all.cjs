/**
 * Runner semua suite mock coder-platform (v0.14.0: 22 suite + Wave 4).
 * Suite yang butuh mesin AI nyata (real-ai, real-usage) TIDAK dijalankan di sini karena butuh
 * PRIME_AGENT_PROVIDER/PRIME_AGENT_MODEL; jalankan terpisah.
 *
 * Pakai: node apps/api/test/run-all.cjs
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const here = __dirname;
const root = path.join(here, "..", "..", "..");
const suites = fs.readdirSync(here)
  .filter((name) => name.endsWith(".e2e.ts"))
  .filter((name) => !["real-ai.e2e.ts", "real-usage.e2e.ts"].includes(name))
  .sort();
// Gerbang migrasi (Wave 9, butir 18): dijalankan otomatis di sini. Tanpa argumen ia membangun
// basis data baru dari nol dan membuktikan versi skema, tabel, kolom, dan idempotensi buka-ulang.
// Di jalur deploy, alat yang sama (apps/api/src/migration-rehearsal.ts) dijalankan pada salinan
// cadangan produksi terbaru sebelum container diganti.

/** Runs the migration gate first: a broken migration must stop the run before any suite. */
function runMigrationGate() {
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--import", "tsx", path.join(here, "migration-check.ts")], { cwd: root, encoding: "utf8", env: { ...process.env } });
  const ms = Date.now() - started;
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const tail = output.trim().split("\n").slice(-3).join(" | ");
  const ok = run.status === 0;
  console.log(`${ok ? "OK  " : "GAGAL"} ${"migration-check.ts".padEnd(28)} ${String(ms).padStart(6)}ms  ${tail.slice(0, 160)}`);
  return ok;
}

/** Wave 10 (butir 21): tipe seluruh berkas uji juga diperiksa. Sebelum ini tidak ada tsconfig
 *  yang mencakup `apps/api/test`, jadi kesalahan tipe di berkas uji hanya terlihat saat dijalankan. */
function runTestTypeGate() {
  const started = Date.now();
  const run = spawnSync("npx", ["tsc", "-p", "tsconfig.test.json"], { cwd: root, encoding: "utf8", env: { ...process.env }, shell: process.platform === "win32" });
  const ms = Date.now() - started;
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const tail = output.trim().split("\n").slice(-3).join(" | ");
  const ok = run.status === 0;
  console.log(`${ok ? "OK  " : "GAGAL"} ${"tsconfig.test.json".padEnd(28)} ${String(ms).padStart(6)}ms  ${ok ? "-" : tail.slice(0, 160)}`);
  return ok;
}

let failed = 0;
const results = [];
if (!runTestTypeGate()) failed += 1;
if (!runMigrationGate()) failed += 1;
for (const suite of suites) {
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--import", "tsx", path.join(here, suite)], { cwd: root, encoding: "utf8", env: { ...process.env } });
  const ms = Date.now() - started;
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const tail = output.trim().split("\n").slice(-3).join(" | ");
  const ok = run.status === 0;
  if (!ok) failed += 1;
  results.push({ suite, ok, ms, tail });
  console.log(`${ok ? "OK  " : "GAGAL"} ${suite.padEnd(28)} ${String(ms).padStart(6)}ms  ${tail.slice(0, 160)}`);
}
const total = suites.length + 2;
console.log("");
console.log(`RINGKASAN: ${total - failed}/${total} suite hijau (termasuk gerbang tipe uji dan gerbang migrasi).`);
if (failed) { console.log("SUITES_FAILED"); process.exit(1); }
console.log("ALL_SUITES_PASSED");

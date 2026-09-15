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
// migration-check.ts TIDAK dijalankan otomatis: itu alat manual yang butuh argumen
// (berkas DB sumber + DATA_DIR tujuan). Jalankan manual: npx tsx apps/api/test/migration-check.ts <db> <dir>

let failed = 0;
const results = [];
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
console.log("");
console.log(`RINGKASAN: ${suites.length - failed}/${suites.length} suite hijau.`);
if (failed) { console.log("SUITES_FAILED"); process.exit(1); }
console.log("ALL_SUITES_PASSED");

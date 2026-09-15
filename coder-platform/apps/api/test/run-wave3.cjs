#!/usr/bin/env node
/**
 * Runner untuk suite end-to-end Wave 3 coder-platform.
 *
 * Pakai dari mana saja:
 *   node apps/api/test/run-wave3.cjs
 *
 * Skrip ini hanya menjalankan SATU suite (apps/api/test/wave3.e2e.ts) lewat tsx dari akar repo,
 * supaya tidak perlu menulis path lengkap atau berpindah direktori. Suite-nya sendiri yang menyiapkan
 * variabel lingkungan (DATA_DIR sementara di /tmp, MOCK_ENGINE=true, port acak 5200-5600, kredensial
 * SMTP dan kunci gateway dihapus), jadi tidak ada rahasia yang diteruskan dari shell.
 *
 * Catatan: repo ini tidak punya runner "21 suite" bersama; STATUS.md mendokumentasikan pola
 * `MOCK_ENGINE=true npx tsx apps/api/test/<suite>.e2e.ts` untuk tiap suite. Runner ini mengikuti pola
 * itu untuk Wave 3 saja.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const suite = path.join("apps", "api", "test", "wave3.e2e.ts");

console.log(`[run-wave3] menjalankan ${suite} dari ${repoRoot}`);
const child = spawn(process.execPath, [require.resolve("tsx/cli"), suite], {
  cwd: repoRoot,
  env: { ...process.env, NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});

let passed = 0; let failed = 0; let skipped = 0;
const failedNames = []; const skippedNames = [];
const handleLine = (line) => {
  if (line.startsWith("PASS ")) passed += 1;
  else if (line.startsWith("FAIL ")) { failed += 1; failedNames.push(line.slice(5)); }
  else if (line.startsWith("SKIP ")) { skipped += 1; skippedNames.push(line.slice(5)); }
};
let buffer = "";
const consume = (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk.toString("utf8");
  const parts = buffer.split("\n");
  buffer = parts.pop() ?? "";
  parts.forEach(handleLine);
};

child.stdout.on("data", consume);
child.stderr.on("data", consume);
child.on("close", (code) => {
  if (buffer) handleLine(buffer);
  console.log("");
  console.log(`[run-wave3] ringkasan runner: ${passed} lulus, ${failed} gagal, ${skipped} dilewati (kode keluar ${code}).`);
  if (failedNames.length) { console.log("[run-wave3] pemeriksaan gagal:"); failedNames.forEach((name) => console.log(` - ${name}`)); }
  if (skippedNames.length) { console.log("[run-wave3] pemeriksaan dilewati:"); skippedNames.forEach((name) => console.log(` - ${name}`)); }
  process.exit(code ?? 1);
});

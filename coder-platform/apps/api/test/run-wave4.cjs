/**
 * Runner Wave 4: menjalankan wave4.e2e.ts dengan tsx, meneruskan exit code.
 * Pola sama dengan run-wave3.cjs supaya suite bisa dijalankan lewat `node` tanpa npx.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const file = path.join(__dirname, "wave4.e2e.ts");
const child = spawn(process.execPath, ["--import", "tsx", file], { stdio: "inherit", env: process.env, cwd: path.join(__dirname, "..", "..", "..") });
child.on("exit", (code, signal) => {
  if (signal) { console.error(`wave4 dihentikan oleh sinyal ${signal}`); process.exit(1); }
  process.exit(code ?? 1);
});

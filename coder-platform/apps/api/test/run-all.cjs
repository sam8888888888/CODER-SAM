/**
 * Runner semua suite mock coder-platform (v0.14.0: 22 suite + Wave 4).
 * Suite yang butuh mesin AI nyata (real-ai, real-usage) TIDAK dijalankan di sini karena butuh
 * PRIME_AGENT_PROVIDER/PRIME_AGENT_MODEL; jalankan terpisah.
 *
 * Suite yang MERAH menulis log utuhnya ke /tmp/verify-logs/<suite>.log (atau VERIFY_LOG_DIR),
 * supaya kegagalan berbasis waktu bisa didiagnosis sesudahnya.
 *
 * Pakai: node apps/api/test/run-all.cjs
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

/**
 * Kebersihan /tmp (risiko lama butir 40: "disk server sering penuh -> suite bisa gagal SQLITE_FULL").
 * Tiap suite membuat direktori kerja sendiri di /tmp (mis. `coder-wave2-<stamp>-<pid>`) dan tidak
 * menyapunya sesudah keluar; terukur 26 Sep 2026: 59 suite meninggalkan ratusan direktori, ~5 MB
 * per direktori (yaitu ~300 MB per gerbang penuh). Di sini direktori BARU milik suite yang baru
 * selesai dibuang — proses anaknya sudah keluar, jadi tidak ada yang masih memakainya. Direktori
 * yang sudah ada SEBELUM gerbang berjalan tidak disentuh (bukan milik jalannya gerbang ini).
 * `VERIFY_KEEP_TMP=1` mematikan penyapuan (dipakai saat mau memeriksa sisa berkas suite).
 */
const TMP_ROOT = os.tmpdir();
const AWALAN_TMP_SUITE = "coder-";

function daftarTmpSuite() {
  try {
    return new Set(fs.readdirSync(TMP_ROOT).filter((nama) => nama.startsWith(AWALAN_TMP_SUITE)));
  } catch {
    return new Set();
  }
}

function sapuTmpSuite(sebelum) {
  if (process.env.VERIFY_KEEP_TMP === "1") return 0;
  let jumlah = 0;
  for (const nama of daftarTmpSuite()) {
    if (sebelum.has(nama)) continue;
    try {
      fs.rmSync(path.join(TMP_ROOT, nama), { recursive: true, force: true });
      jumlah += 1;
    } catch {
      /* berkas masih dipakai atau bukan milik kita: lewati saja, jangan gagalkan gerbang */
    }
  }
  return jumlah;
}

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
// Suite yang merah WAJIB meninggalkan log utuh: ringkasan tiga baris terakhir tidak cukup untuk
// mendiagnosis kegagalan berbasis waktu (pelajaran 26 Sep 2026: suite wave11a.e2e.ts merah 7
// pemeriksaan di gerbang penuh, tetapi log lengkapnya sudah hilang sehingga sebabnya tidak bisa
// dipastikan). Log ditulis di luar repo supaya tidak ikut ke paket rilis.
const logDir = process.env.VERIFY_LOG_DIR || "/tmp/verify-logs";
let tmpDibersihkan = 0;
// Daftar diambil SEKALI di awal: proses anak yang masih hidup sesaat setelah induknya keluar bisa
// membuat direktori kerja BARU di antara dua suite, sehingga cuplikan per-suite akan salah
// menganggapnya "sudah ada sebelumnya". Yang tidak ada di cuplikan awal = milik jalannya gerbang ini.
// Syarat: jalankan gerbang ini sendirian (jangan bersamaan dengan suite lain).
const tmpSebelumGerbang = daftarTmpSuite();
for (const suite of suites) {
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--import", "tsx", path.join(here, suite)], { cwd: root, encoding: "utf8", env: { ...process.env } });
  const ms = Date.now() - started;
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const tail = output.trim().split("\n").slice(-3).join(" | ");
  const ok = run.status === 0;
  let jejak = "";
  if (!ok) {
    failed += 1;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const berkas = path.join(logDir, `${suite}.log`);
      fs.writeFileSync(berkas, output);
      jejak = ` -> log utuh: ${berkas}`;
    } catch (error) {
      jejak = ` (gagal menulis log utuh: ${String(error)})`;
    }
  }
  const tmpSesudahSapu = sapuTmpSuite(tmpSebelumGerbang);
  tmpDibersihkan += tmpSesudahSapu;
  results.push({ suite, ok, ms, tail, tmpSesudahSapu });
  const jejakTmp = tmpSesudahSapu ? ` (tmp dibersihkan: ${tmpSesudahSapu})` : "";
  console.log(`${ok ? "OK  " : "GAGAL"} ${suite.padEnd(28)} ${String(ms).padStart(6)}ms  ${tail.slice(0, 160)}${jejak}${jejakTmp}`);
}
const total = suites.length + 2;
console.log("");
console.log(`TMP_DIBERSIHKAN ${tmpDibersihkan} direktori kerja suite di ${TMP_ROOT}${process.env.VERIFY_KEEP_TMP === "1" ? " (penyapuan DIMATIKAN oleh VERIFY_KEEP_TMP=1)" : ""}`);
console.log(`RINGKASAN: ${total - failed}/${total} suite hijau (termasuk gerbang tipe uji dan gerbang migrasi).`);
if (failed) { console.log("SUITES_FAILED"); process.exit(1); }
console.log("ALL_SUITES_PASSED");

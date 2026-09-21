/**
 * Uji butir 15b (v0.20.2): sapuan tabel `rate_limit_hits` dipindahkan ke pekerja terjadwal.
 *
 * Sebelum perubahan ini, setiap proses web menyapu seluruh tabel sekali per menit dari dalam
 * `allow()`. Di instalasi berpenggal (banyak replika web + satu pekerja), setiap replika mengulang
 * pekerjaan yang sama. Sekarang:
 *  - sapuan di dalam proses web hanya jalan bila `RATE_LIMIT_SWEEP_IN_WEB` (bawaan true = satu wadah);
 *  - pekerjaan berkala `ratelimit.sweep` SELALU dijadwalkan, jadi satu pemilik antrean yang menyapu;
 *  - hasil sapuan dilaporkan jujur: `rateLimitStorage().sweepOwner` = "web" atau "worker".
 *
 * Yang dibuktikan berkas ini:
 *  1) konfigurasi memisahkan dua hal itu (sweepInWeb=false, sweepOwner="worker");
 *  2) `allow()` TIDAK lagi menyapu seluruh tabel saat sweepInWeb=false (baris mati milik kunci lain tetap ada);
 *  3) `sweepRateLimitHits()` menghapus baris mati, menyisakan baris segar DAN baris yang masih di dalam margin;
 *  4) pekerjaan `ratelimit.sweep` diantre penjadwal berkala (dan tidak diantre dua kali dalam satu jeda);
 *  5) satu putaran antrean benar-benar menjalankan handlernya: pekerjaan berstatus done, hasilnya memuat
 *     jumlah baris yang dihapus, dan baris mati benar-benar hilang dari tabel.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/ratelimit-sweep.e2e.ts
 */
const port = 7160 + Math.floor(Math.random() * 10); // rentang khusus 7160-7169
const dataDir = `/tmp/coder-rlsweep-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.RETENTION_ENABLED = "false";
// Inilah keadaan produksi: sapuan tidak dikerjakan proses web.
process.env.RATE_LIMIT_SWEEP_IN_WEB = "false";
// Putaran pekerja bawaan server dibuat sangat panjang; uji ini memanggil putarannya sendiri.
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.RATE_LIMIT_API_PER_MINUTE = "600";

const startedAtMs = Date.now();
// server.ts memasang handler pekerjaan (`ratelimit.sweep`), jadi berkas ini mengimpornya.
await import("../src/server.js");
const { db } = await import("../src/db.js");
const configMod: any = await import("../src/config.js");
const rlMod: any = await import("../src/ratelimit.js");
const jobsMod: any = await import("../src/jobs.js");
const config = configMod.config;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
const short = (value: unknown, max = 200) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);

/** Menulis satu baris hit langsung ke tabel, supaya umur baris bisa ditentukan uji. */
function insertHit(bucket: string, hitAt: number): void {
  db.prepare("INSERT INTO rate_limit_hits (bucket, hit_at) VALUES (?,?)").run(bucket, hitAt);
}
const rowExists = (bucket: string) => Number((db.prepare("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket=?").get(bucket) as { n: number }).n ?? 0) > 0;
const toIso = (value: unknown) => new Date(Number(value)).toISOString();

console.log("=== Butir 15b: sapuan rate_limit_hits pindah ke pekerja terjadwal ===\n");

// ---------------------------------------------------------------------------------------
// 1) Konfigurasi: dua hal yang berbeda (siapa menyapu, seberapa sering).
// ---------------------------------------------------------------------------------------
check("1a. RATE_LIMIT_SWEEP_IN_WEB=false dibaca dari lingkungan", config.RATE_LIMIT_SWEEP_IN_WEB === false, short({ nilai: config.RATE_LIMIT_SWEEP_IN_WEB }));
const storage = rlMod.rateLimitStorage();
check("1b. rateLimitStorage melaporkan pemilik sapuan = worker", storage.sweepInWeb === false && storage.sweepOwner === "worker", short(storage));
check("1c. jeda dan margin sapuan dilaporkan apa adanya",
  Number(storage.sweepIntervalMs) === Number(rlMod.SWEEP_INTERVAL_MS) && Number(storage.sweepAfterMs) === 20 * 60 * 1000,
  short({ intervalMs: storage.sweepIntervalMs, afterMs: storage.sweepAfterMs }));

// ---------------------------------------------------------------------------------------
// 2) Proses web tidak lagi menyapu seluruh tabel lewat allow().
// ---------------------------------------------------------------------------------------
const staleForeign = `rate:mati-${stamp}`;
const staleAt = Date.now() - 30 * 60 * 1000; // 30 menit, di luar jendela 20 menit
insertHit(staleForeign, staleAt);
const limiter = rlMod.limiterFor("api");
const allowed = limiter.allow(`lazy-${stamp}`);
check("2a. permintaan biasa tetap diizinkan", allowed === true);
check("2b. allow() TIDAK menghapus baris mati milik kunci lain (sapuan web mati)",
  rowExists(staleForeign),
  short({ bucket: staleForeign, masihAda: rowExists(staleForeign), catatan: "kalau ini gagal, artinya sapuan web masih jalan" }));

// ---------------------------------------------------------------------------------------
// 3) Fungsi sapuan itu sendiri: benar membuang yang mati, benar menyisakan yang hidup.
// ---------------------------------------------------------------------------------------
const freshBucket = `rate:segar-${stamp}`;
const marginBucket = `rate:margin-${stamp}`;
const nowSweep = Date.now();
insertHit(freshBucket, nowSweep - 10_000);          // 10 detik: jelas hidup
insertHit(marginBucket, nowSweep - 19 * 60 * 1000);  // 19 menit: di dalam margin 20 menit
const swept = rlMod.sweepRateLimitHits(nowSweep);
check("3a. sweepRateLimitHits mengembalikan batas waktu dan jumlah baris terhapus",
  typeof swept.cutoff === "number" && swept.removed >= 1 && Number(swept.cutoff) === nowSweep - 20 * 60 * 1000,
  short({ cutoff: toIso(swept.cutoff), removed: swept.removed }));
check("3b. baris mati milik kunci lain benar-benar terhapus", rowExists(staleForeign) === false, short({ bucket: staleForeign }));
check("3c. baris segar tetap ada", rowExists(freshBucket), short({ bucket: freshBucket }));
check("3d. baris yang masih di dalam margin (19 menit) tetap ada, jadi hit aktif tidak ikut terbuang",
  rowExists(marginBucket), short({ bucket: marginBucket }));
const sweptAgain = rlMod.sweepRateLimitHits(nowSweep);
check("3e. sapuan kedua tidak menemukan baris mati lagi (idempoten)",
  Number(sweptAgain.removed) === 0, short({ removed: sweptAgain.removed }));

// ---------------------------------------------------------------------------------------
// 4) Penjadwalan berkala: `ratelimit.sweep` diantre, dan tidak dobel dalam satu jeda.
// ---------------------------------------------------------------------------------------
check("4a. jenis pekerjaan ratelimit.sweep dikenal", Array.isArray(jobsMod.JOB_KINDS) && jobsMod.JOB_KINDS.includes("ratelimit.sweep"), short(jobsMod.JOB_KINDS));
check("4b. jeda pekerjaan sapuan lima menit", Number(jobsMod.RATE_LIMIT_SWEEP_INTERVAL_MS) === 5 * 60 * 1000, short({ intervalMs: jobsMod.RATE_LIMIT_SWEEP_INTERVAL_MS }));
// Sisa penjadwalan bawaan (retensi, reaper) dihapus dulu supaya putaran uji hanya mengurus sapuan.
db.prepare("DELETE FROM jobs WHERE kind IN ('ratelimit.sweep')").run();
const base = new Date(Date.now() + 60_000);
const first = jobsMod.ensureRecurringJobs(base);
check("4c. penjadwal mengantre ratelimit.sweep", Array.isArray(first) && first.includes("ratelimit.sweep"), short(first));
const pendingRow = db.prepare("SELECT id, status, dedupe_key AS dedupeKey FROM jobs WHERE kind='ratelimit.sweep' ORDER BY created_at DESC LIMIT 1").get() as any;
check("4d. pekerjaan tersimpan dengan kunci pencegah dobel", Boolean(pendingRow) && String(pendingRow.dedupeKey).startsWith("ratelimit.sweep:"), short(pendingRow));

// ---------------------------------------------------------------------------------------
// 5) Satu putaran antrean: handler benar-benar berjalan dan menghapus baris mati.
// ---------------------------------------------------------------------------------------
const cycleStale = `rate:putaran-${stamp}`;
insertHit(cycleStale, Date.now() - 40 * 60 * 1000);
const report = await jobsMod.runJobCycleOnce({ owner: `uji-15b-${stamp}`, now: base });
const handled = (report.details ?? []).find((entry: any) => entry.kind === "ratelimit.sweep");
check("5a. putaran antrean menjalankan pekerjaan sapuan dan hasilnya sukses",
  Boolean(handled) && handled.outcome === "done",
  short(report.details));
check("5b. baris mati benar-benar hilang setelah putaran antrean", rowExists(cycleStale) === false, short({ bucket: cycleStale }));
const doneRow = db.prepare("SELECT status, result FROM jobs WHERE kind='ratelimit.sweep' AND status='done' ORDER BY finished_at DESC LIMIT 1").get() as any;
let parsedResult: any = null;
try { parsedResult = doneRow?.result ? JSON.parse(String(doneRow.result)) : null; } catch { parsedResult = null; }
check("5c. pekerjaan tercatat selesai", String(doneRow?.status ?? "") === "done", short(doneRow));
check("5d. hasil pekerjaan melaporkan jumlah terhapus dan pemilik sapuan yang sebenarnya",
  Boolean(parsedResult) && typeof parsedResult.removed === "number" && parsedResult.sweepInWeb === false,
  short(parsedResult));
check("5e. hasil pekerjaan menyebut batas waktu sapuan", Boolean(parsedResult) && typeof parsedResult.cutoff === "string", short(parsedResult));

// ---------------------------------------------------------------------------------------
// 6) Jeda benar-benar dihormati: tidak diantre dua kali sebelum jeda lewat.
// ---------------------------------------------------------------------------------------
db.prepare("DELETE FROM jobs WHERE kind='ratelimit.sweep'").run();
const j1 = jobsMod.ensureRecurringJobs(base);
check("6a. putaran pertama mengantre sapuan", j1.includes("ratelimit.sweep"), short(j1));
// Setelah pekerjaan selesai, jeda lima menit belum lewat.
db.prepare("UPDATE jobs SET status='done', finished_at=?, updated_at=? WHERE kind='ratelimit.sweep'").run(base.toISOString(), base.toISOString());
const j2 = jobsMod.ensureRecurringJobs(new Date(base.getTime() + 60_000));
check("6b. 60 detik kemudian tidak mengantre lagi (jeda lima menit dihormati)", j2.includes("ratelimit.sweep") === false, short(j2));
const j3 = jobsMod.ensureRecurringJobs(new Date(base.getTime() + 6 * 60_000));
check("6c. enam menit kemudian diantre lagi", j3.includes("ratelimit.sweep"), short(j3));

// =====================================================================================
// Ringkasan.
// =====================================================================================
console.log("");
if (skipped.length) {
  console.log(`SKIP ${skipped.length} pemeriksaan:`);
  for (const entry of skipped) console.log(`  - ${entry}`);
} else {
  console.log("Tidak ada pemeriksaan yang di-skip.");
}
if (failedNames.length) {
  console.log(`GAGAL ${failed} pemeriksaan:`);
  for (const name of failedNames) console.log(`  - ${name}`);
}
const total = passed + failed;
console.log(`${passed}/${total} lulus`);
console.log(`INFO durasi uji ${Math.round((Date.now() - startedAtMs) / 1000)} detik, data uji di ${dataDir}`);
process.exit(failed === 0 ? 0 : 1);

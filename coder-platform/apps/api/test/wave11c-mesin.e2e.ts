/**
 * Uji Wave 11C (v0.23.0) butir 78 TAHAP 1 — periksa versi mesin (hanya membaca).
 *
 * Rute yang diuji (lewat peladen NYATA `../src/server.js`; suite ini TIDAK memasang rute sendiri):
 *   GET /api/v1/admin/engine/version   ->  { engineVersion, platformVersion, startedAt, ...medan penjelas }
 *
 * Yang dibuktikan:
 *   1. hanya admin platform yang boleh membaca (pengguna biasa 403 ADMIN_REQUIRED, tanpa sesi 401);
 *   2. jawabannya datar dengan tiga medan wajib bertipe string, dan `platformVersion` benar-benar
 *      berasal dari sumber keadaan proses web (`APP_VERSION`) — dibuktikan dengan MENGUBAH nilai itu
 *      dan melihat jawabannya ikut berubah, bukan dihafal saat modul dimuat;
 *   3. `startedAt` waktu nyata (bisa diurai, tidak di masa depan, dan tetap sama antar panggilan),
 *      sedangkan `schemaVersion` sama dengan `SCHEMA_VERSION` di `db.ts`;
 *   4. kalimat WAJIB "versi tidak dilaporkan" benar-benar muncul saat mesin tidak melaporkan versi —
 *      dibuktikan lima cara pada PROSES TERPISAH (biner tidak ada, biner diam, biner menggantung yang
 *      kena batas waktu, biner mencetak sampah, dan mesin belum dikonfigurasi) — dan TIDAK PERNAH
 *      diganti angka tebakan;
 *   5. angka versi yang benar juga diteruskan apa adanya: biner palsu yang mencetak "9.9.9-uji" ke
 *      stdout, dan yang mencetak ke STDERR (perilaku CLI Prime Agent nyata), keduanya terbaca;
 *   6. rute ini tidak pernah menulis dan tahap 2 (perbarui/rollback) memang TIDAK ADA — rutenya 404.
 *
 * Jalankan dari akar repo: `npx tsx apps/api/test/wave11c-mesin.e2e.ts`
 *
 * Batas pengujian yang disebut apa adanya:
 *   • Mesin nyata tidak dijalankan sama sekali. Untuk membuktikan pembacaan versi, dipakai biner
 *     palsu buatan uji ini sendiri (`/bin/sh` satu baris) supaya hasilnya bisa dipastikan.
 *   • Bukti bahwa biner Prime Agent asli menulis versi ke stderr tidak diulang di sini karena
 *     memanggil biner itu termasuk aksi yang tidak perlu; yang diuji adalah kemampuan membaca
 *     kedua saluran (stdout dan stderr), bukan isi biner pihak lain.
 * Berkas ini HANYA menambah dua berkas uji baru (suite + alat bantu); tidak ada berkas agen lain diubah.
 */
import { createServer as createTcpServer } from "node:net";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const akarRepo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Mencari port bebas di rentang Wave 11C mesin (7328-7340); nomor utama dicoba lebih dulu. */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 12 }, () => 7328 + Math.floor(Math.random() * 12))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve_) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve_(false));
      probe.once("listening", () => probe.close(() => resolve_(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang Wave 11C mesin (7328-7340).");
}

const port = await cariPortBebas(7328, 7329, 7330);
const dataDir = `/tmp/coder-wave11c-mesin-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const folderAlat = `/tmp/coder-wave11c-mesin-alat-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
mkdirSync(folderAlat, { recursive: true });
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11c-mesin-admin-${stamp}@example.test`;
const biasaEmail = `w11c-mesin-biasa-${stamp}@example.test`;
const VERSI_PLATFORM_AWAL = `0.23.0-uji-mesin-${stamp}`;
const VERSI_PLATFORM_BARU = `0.23.1-uji-mesin-${stamp}`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_BIN = "";            // tidak ada biner mesin: tidak ada proses yang dijalankan
process.env.APP_VERSION = VERSI_PLATFORM_AWAL;
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_IN_WEB = "false";
process.env.JOB_REAP_ON_BOOT = "false";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { engine } = await import("../src/engine.js");
const mesinMod: any = await import("../src/wave11c/engine-version.js");

const base = `http://127.0.0.1:${port}`;
let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} - ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 260) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const hitung = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);

function client() {
  const jar = new Map<string, string>();
  let primed = false;
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    if (mutating) await prime();
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: base,
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(mutating && jar.get("coder_csrf") ? { "x-csrf-token": String(jar.get("coder_csrf")) } : {}),
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
      "accept-language": "id-ID",
    };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const rawCookies = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of rawCookies) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim(); const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, bytes, headers: response.headers };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server belum siap */ } }
  return { call, bootstrap: prime };
}

const admin = client();
const biasa = client();

for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const siap = await fetch(`${base}/health`); if (siap.ok) break; } catch { /* belum siap */ }
  await new Promise((selesai) => setTimeout(selesai, 200));
}
console.log(`INFO peladen uji siap di ${base}, data di ${dataDir}`);

async function daftar(klien: ReturnType<typeof client>, email: string, nama: string) {
  await klien.bootstrap();
  return klien.call("POST", "/api/v1/auth/register", { email, password, displayName: nama });
}

/** Membuat biner palsu satu baris di folder alat; dipakai untuk membuktikan pembacaan versi. */
function binerPalsu(nama: string, isi: string): string {
  const jalur = join(folderAlat, nama);
  writeFileSync(jalur, `#!/bin/sh\n${isi}\n`, { mode: 0o755 });
  chmodSync(jalur, 0o755);
  return jalur;
}
const BIN_STDOUT = binerPalsu("versi-stdout.sh", 'echo "9.9.9-uji"');
const BIN_STDERR = binerPalsu("versi-stderr.sh", 'echo "0.9.5-ke-stderr" 1>&2');
const BIN_DIAM = binerPalsu("versi-diam.sh", "exit 0");
const BIN_SAMPAH = binerPalsu("versi-sampah.sh", 'echo "versi belum tersedia"');
const BIN_MENGGANTUNG = binerPalsu("versi-menggantung.sh", "sleep 8");
const BIN_TIDAK_ADA = join(folderAlat, "tidak-ada-biner-ini");

/** Menjalankan alat bantu di proses terpisah dan mengurai satu baris JSON yang dicetaknya. */
function jalankanProbe(opsi: { bin?: string; timeoutMs?: number }): { ok: boolean; hasil: any; keluaran: string } {
  const probe = join(akarRepo, "apps", "api", "test", "fixtures", "wave11c-engine-version-probe.ts");
  const hasil = spawnSync("npx", ["tsx", probe], {
    cwd: akarRepo,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PROBE_JSON: JSON.stringify({ ...opsi, dataDir: `${dataDir}-probe-${Math.floor(Math.random() * 1_000_000)}` }) },
  });
  const keluaran = `${hasil.stdout ?? ""}${hasil.stderr ?? ""}`.trim();
  const baris = String(hasil.stdout ?? "").split("\n").filter((teks) => teks.trim().startsWith("{")).pop();
  if (!baris) return { ok: false, hasil: null, keluaran: keluaran.slice(-400) };
  try { return { ok: true, hasil: JSON.parse(baris), keluaran }; } catch { return { ok: false, hasil: null, keluaran: keluaran.slice(-400) }; }
}

/* =====================================================================================
 * Bagian 0: keadaan uji.
 * ===================================================================================== */
console.log("\n--- Bagian 0: keadaan uji ---");
const adminReg = await daftar(admin, adminEmail, "Admin Mesin");
const biasaReg = await daftar(biasa, biasaEmail, "Pengguna Biasa");
check("0a. akun admin platform dan akun biasa terdaftar",
  adminReg.status === 201 && biasaReg.status === 201, short([adminReg.status, biasaReg.status]));
check("0b. mesin yang aktif adalah mesin tiruan (MOCK_ENGINE=true) dan tidak ada biner mesin dikonfigurasi",
  config.MOCK_ENGINE === true && !config.PRIME_AGENT_BIN && mesinMod.jenisMesin() === "mock", short({ mock: config.MOCK_ENGINE, bin: config.PRIME_AGENT_BIN ?? null, jenis: mesinMod.jenisMesin() }));
const kesehatan = await engine.health();
check("0c. mesin tiruan melaporkan versinya sendiri (\"mock\") lewat health() — sumber angka yang dipakai nanti",
  kesehatan.available === true && kesehatan.version === "mock", short(kesehatan));

/* =====================================================================================
 * Bagian 1: akses dan bentuk jawaban.
 * ===================================================================================== */
console.log("\n--- Bagian 1: akses dan bentuk jawaban ---");
const rAnonim = await fetch(`${base}/api/v1/admin/engine/version`);
check("1a. tanpa sesi dijawab 401 AUTH_REQUIRED", rAnonim.status === 401, `${rAnonim.status} ${short(await rAnonim.text())}`);
const rBiasa = await biasa.call("GET", "/api/v1/admin/engine/version");
check("1b. pengguna biasa dijawab 403 ADMIN_REQUIRED (bukan 200 dengan data kosong)",
  rBiasa.status === 403 && rBiasa.json?.error === "ADMIN_REQUIRED", `${rBiasa.status} ${short(rBiasa.json)}`);

const rAdmin = await admin.call("GET", "/api/v1/admin/engine/version");
const badan: any = rAdmin.json;
check("1c. admin dijawab 200 dan jawabannya DATAR dengan tiga medan wajib bertipe string",
  rAdmin.status === 200 && typeof badan?.engineVersion === "string" && typeof badan?.platformVersion === "string" && typeof badan?.startedAt === "string"
  && !Array.isArray(badan), `${rAdmin.status} ${short(badan)}`);
check("1d. bukan pembungkus bersarang: kunci tingkat atas benar-benar engineVersion/platformVersion/startedAt",
  Object.prototype.hasOwnProperty.call(badan ?? {}, "engineVersion") && Object.prototype.hasOwnProperty.call(badan ?? {}, "platformVersion")
  && Object.prototype.hasOwnProperty.call(badan ?? {}, "startedAt"), short(Object.keys(badan ?? {})));

const waktuSekarang = new Date();
const mulaiMs = Date.parse(String(badan?.startedAt));
check("1e. startedAt waktu nyata: bisa diurai, tidak di masa depan, dan tidak lebih tua dari 24 jam",
  Number.isFinite(mulaiMs) && mulaiMs <= waktuSekarang.getTime() + 1000 && mulaiMs >= waktuSekarang.getTime() - 24 * 3600 * 1000,
  short({ startedAt: badan?.startedAt, sekarang: waktuSekarang.toISOString() }));
const checkedMs = Date.parse(String(badan?.checkedAt));
check("1f. checkedAt (kapan diperiksa) tidak mendahului startedAt dan tidak di masa depan",
  Number.isFinite(checkedMs) && checkedMs >= mulaiMs && checkedMs <= waktuSekarang.getTime() + 1000, short(badan?.checkedAt));

check("1g. platformVersion sama dengan APP_VERSION proses web (sumber keadaan, bukan hafalan)",
  badan?.platformVersion === VERSI_PLATFORM_AWAL, short({ jawaban: badan?.platformVersion, proses: process.env.APP_VERSION }));
process.env.APP_VERSION = VERSI_PLATFORM_BARU;
const rAdminBaru = await admin.call("GET", "/api/v1/admin/engine/version");
check("1h. setelah APP_VERSION diubah, jawabannya IKUT berubah (dibaca saat itu juga)",
  rAdminBaru.json?.platformVersion === VERSI_PLATFORM_BARU, short(rAdminBaru.json?.platformVersion));
process.env.APP_VERSION = VERSI_PLATFORM_AWAL;

check("1i. schemaVersion sama dengan SCHEMA_VERSION di db.ts",
  badan?.schemaVersion === SCHEMA_VERSION && SCHEMA_VERSION === 21, short({ jawaban: badan?.schemaVersion, db: SCHEMA_VERSION }));
const rAdminUlang = await admin.call("GET", "/api/v1/admin/engine/version");
check("1j. startedAt tetap sama pada panggilan berikutnya (satu sumber keadaan, bukan diacak)",
  rAdminUlang.json?.startedAt === badan?.startedAt, short({ pertama: badan?.startedAt, kedua: rAdminUlang.json?.startedAt }));

check("1k. jenis mesin dan sumber versi disebut apa adanya: mock lewat health(), tanpa biner",
  badan?.engineKind === "mock" && badan?.engineAvailable === true && body_memuat(badan, "health")
  && badan?.engineBinary?.path === null && badan?.engineBinary?.present === false
  && badan?.engineBinary?.version === "versi tidak dilaporkan",
  short({ kind: badan?.engineKind, sumber: badan?.engineVersionSource, biner: badan?.engineBinary }));
check("1l. versi mesin tiruan diteruskan apa adanya (\"mock\") — bukan dikosongkan dan bukan dikarang",
  badan?.engineVersion === "mock" && badan?.engineVersion === kesehatan.version, short({ jawaban: badan?.engineVersion, health: kesehatan.version }));

function body_memuat(obj: any, teks: string): boolean { return JSON.stringify(obj ?? {}).toLowerCase().includes(teks.toLowerCase()); }

/* =====================================================================================
 * Bagian 2: rute ini hanya membaca; tahap 2 memang belum ada.
 * ===================================================================================== */
console.log("\n--- Bagian 2: hanya membaca, dan tahap 2 tidak ada ---");
const rPost = await admin.call("POST", "/api/v1/admin/engine/version", { version: "9.9.9" });
const rPut = await admin.call("PUT", "/api/v1/admin/engine/version", { version: "9.9.9" });
const rDelete = await admin.call("DELETE", "/api/v1/admin/engine/version");
check("2a. POST/PUT/DELETE pada rute versi dijawab 404: tidak ada jalur pengubahan",
  rPost.status === 404 && rPut.status === 404 && rDelete.status === 404, short([rPost.status, rPut.status, rDelete.status]));
const rUpdate = await admin.call("POST", "/api/v1/admin/engine/update", { version: "9.9.9" });
const rRollback = await admin.call("POST", "/api/v1/admin/engine/rollback", {});
check("2b. rute tahap 2 (perbarui/rollback) memang TIDAK ADA: keduanya 404",
  rUpdate.status === 404 && rRollback.status === 404, short([rUpdate.status, rRollback.status]));
check("2c. tahap2.tersedia = false dan catatannya menyebut keputusan yang ditunggu (K5)",
  badan?.tahap2?.tersedia === false && body_memuat(badan?.tahap2, "K5"), short(badan?.tahap2));

const sebelum = { runs: hitung("SELECT COUNT(*) AS n FROM runs"), audit: hitung("SELECT COUNT(*) AS n FROM audit_events"), pengaturan: hitung("SELECT COUNT(*) AS n FROM platform_settings") };
await admin.call("GET", "/api/v1/admin/engine/version");
await admin.call("GET", "/api/v1/admin/engine/version");
const sesudah = { runs: hitung("SELECT COUNT(*) AS n FROM runs"), audit: hitung("SELECT COUNT(*) AS n FROM audit_events"), pengaturan: hitung("SELECT COUNT(*) AS n FROM platform_settings") };
check("2d. dua pembacaan berikutnya tidak menambah baris runs/audit_events/platform_settings (benar-benar hanya membaca)",
  JSON.stringify(sebelum) === JSON.stringify(sesudah), short({ sebelum, sesudah }));

/* =====================================================================================
 * Bagian 3: "versi tidak dilaporkan" pada proses mesin RPC (proses terpisah).
 * ===================================================================================== */
console.log("\n--- Bagian 3: mesin tidak melaporkan versi (proses terpisah, MOCK_ENGINE=false) ---");
const p1 = jalankanProbe({ bin: BIN_TIDAK_ADA });
check("3a. biner mesin tidak ada: proses memilih mesin RPC tetapi versi = \"versi tidak dilaporkan\"",
  p1.ok && p1.hasil.jenisMesin === "prime-rpc" && p1.hasil.engineVersion === "versi tidak dilaporkan"
  && p1.hasil.engineBinary.present === false, short(p1.hasil ?? p1.keluaran));
const p2 = jalankanProbe({ bin: BIN_STDOUT });
check("3b. biner palsu mencetak \"9.9.9-uji\" ke stdout: angka itu yang dilaporkan, bukan tebakan",
  p2.ok && p2.hasil.engineVersion === "9.9.9-uji" && p2.hasil.engineVersionSource === "biner --version"
  && p2.hasil.engineBinary.present === true, short(p2.hasil ?? p2.keluaran));
const p3 = jalankanProbe({ bin: BIN_STDERR });
check("3c. biner mencetak versi ke STDERR (perilaku CLI Prime Agent nyata): tetap terbaca",
  p3.ok && p3.hasil.engineVersion === "0.9.5-ke-stderr", short(p3.hasil ?? p3.keluaran));
const p4 = jalankanProbe({ bin: BIN_DIAM });
check("3d. biner keluar tanpa mencetak apa pun: jawabannya \"versi tidak dilaporkan\" dengan alasan tercatat",
  p4.ok && p4.hasil.engineVersion === "versi tidak dilaporkan" && String(p4.hasil.engineBinary.detail).includes("tidak mencetak versi"),
  short(p4.hasil ?? p4.keluaran));
const p5 = jalankanProbe({ bin: BIN_SAMPAH });
check("3e. biner mencetak kalimat yang bukan bentuk versi: TIDAK dipakai sebagai versi (tidak mengarang)",
  p5.ok && p5.hasil.engineVersion === "versi tidak dilaporkan", short(p5.hasil ?? p5.keluaran));
const p6 = jalankanProbe({ bin: BIN_MENGGANTUNG, timeoutMs: 800 });
check("3f. biner menggantung: batas waktu berlaku dan jawabannya \"versi tidak dilaporkan\", bukan menunggu selamanya",
  p6.ok && p6.hasil.engineVersion === "versi tidak dilaporkan" && String(p6.hasil.engineBinary.detail).includes("tidak menjawab dalam 800 ms")
  && Number(p6.hasil.ms) < 4000, short({ hasil: p6.hasil, keluaran: p6.keluaran }));
const p7 = jalankanProbe({ bin: undefined });
check("3g. mesin belum dikonfigurasi (tanpa PRIME_AGENT_BIN): jawabannya juga \"versi tidak dilaporkan\"",
  p7.ok && p7.hasil.engineKind === "unconfigured" && p7.hasil.engineVersion === "versi tidak dilaporkan", short(p7.hasil ?? p7.keluaran));
check("3h. kelima jawaban \"versi tidak dilaporkan\" itu TIDAK pernah berisi angka versi karangan (tidak ada 0.0.0 / unknown)",
  [p1, p4, p5, p6, p7].every((p) => p.ok && p.hasil.engineVersion === "versi tidak dilaporkan")
  && !JSON.stringify([p1, p4, p5, p6, p7].map((p) => p.hasil?.engineVersion)).match(/0\.0\.0|unknown|n\/a/i),
  short([p1, p4, p5, p6, p7].map((p) => p.hasil?.engineVersion)));

/* =====================================================================================
 * Bagian 4: pemeriksaan langsung pada fungsi (tanpa HTTP, tanpa proses terpisah).
 * ===================================================================================== */
console.log("\n--- Bagian 4: pemeriksaan langsung pada fungsi modul ---");
const sekarang = new Date();
const tanpaVersi = await mesinMod.laporanVersiMesin(sekarang, { health: async () => ({ available: true }) });
check("4a. sumber kesehatan yang tidak mengisi versi: jawabannya \"versi tidak dilaporkan\" (mesin tiruan pun dihormati)",
  tanpaVersi.engineVersion === "versi tidak dilaporkan" && tanpaVersi.engineAvailable === true && String(tanpaVersi.engineVersionSource).includes("tidak dilaporkan"),
  short({ versi: tanpaVersi.engineVersion, sumber: tanpaVersi.engineVersionSource }));
const denganVersi = await mesinMod.laporanVersiMesin(sekarang, { health: async () => ({ available: true, version: "1.2.3" }) });
check("4b. sumber kesehatan yang melaporkan \"1.2.3\": angka itu diteruskan apa adanya",
  denganVersi.engineVersion === "1.2.3", short(denganVersi.engineVersion));
const denganGalat = await mesinMod.laporanVersiMesin(sekarang, { health: async () => { throw new Error("mesin tidak bisa dihubungi"); } });
check("4c. sumber kesehatan yang melempar galat: versi \"versi tidak dilaporkan\", galatnya dicatat, available=false",
  denganGalat.engineVersion === "versi tidak dilaporkan" && denganGalat.engineAvailable === false && String(denganGalat.healthError).includes("tidak bisa dihubungi"),
  short({ versi: denganGalat.engineVersion, galat: denganGalat.healthError }));

const langsung = await mesinMod.probeVersiBiner(BIN_STDOUT);
check("4d. probeVersiBiner membaca \"9.9.9-uji\" dari biner palsu", langsung.versi === "9.9.9-uji" && langsung.alasan.length > 0, short(langsung));
const langsungHilang = await mesinMod.probeVersiBiner(BIN_TIDAK_ADA);
check("4e. probeVersiBiner pada biner yang tidak ada: versi null dan alasannya jelas (tidak menebak)",
  langsungHilang.versi === null && String(langsungHilang.alasan).length > 0, short(langsungHilang));
const mulaiGantung = Date.now();
const langsungGantung = await mesinMod.probeVersiBiner(BIN_MENGGANTUNG, 600);
check("4f. probeVersiBiner menaati batas waktu yang diminta (600 ms) dan tidak menggantung",
  langsungGantung.versi === null && Date.now() - mulaiGantung < 3000, short({ hasil: langsungGantung, ms: Date.now() - mulaiGantung }));
check("4g. binerAda() benar-benar memeriksa disk (biner palsu ada, biner khayalan tidak)",
  mesinMod.binerAda(BIN_STDOUT) === true && mesinMod.binerAda(BIN_TIDAK_ADA) === false && mesinMod.binerAda("biner-khayalan-xyz") === false,
  short({ ada: mesinMod.binerAda(BIN_STDOUT), hilang: mesinMod.binerAda(BIN_TIDAK_ADA) }));
const konstanta = mesinMod.VERSI_TIDAK_DILAPORKAN;
check("4h. kalimat wajib persis \"versi tidak dilaporkan\" (konstanta modul, bukan tulisan berbeda-beda)",
  konstanta === "versi tidak dilaporkan", short(konstanta));

console.log(`\nRingkasan: ${passed} lulus, ${failed} gagal`);
if (failedNames.length) console.log(`Gagal: ${failedNames.join(" | ")}`);
if (skipped.length) console.log(`Dilewati: ${skipped.join(" | ")}`);
process.exitCode = failed ? 1 : 0;
try {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(folderAlat, { recursive: true, force: true });
  // Folder DATA_DIR milik proses pemeriksa (satu per kasus) juga dibersihkan.
  let dibersihkan = 0;
  for (const nama of readdirSync("/tmp")) {
    if (nama.startsWith(`${basename(dataDir)}-probe-`)) { rmSync(join("/tmp", nama), { recursive: true, force: true }); dibersihkan += 1; }
  }
  console.log(`INFO DATA_DIR, folder alat, dan ${dibersihkan} folder pemeriksa dibersihkan`);
} catch (error) { console.log(`INFO gagal membersihkan: ${String(error)}`); }
process.exit(failed ? 1 : 0);

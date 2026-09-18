/**
 * Uji Wave 10 (butir 32): penyelarasan kunci .env lewat deploy/env-sync.sh + deploy/env.keys.txt,
 * dan sambungannya ke deploy/deploy-austria.sh.
 *
 * Yang dibuktikan (semua memakai berkas sementara di /tmp; berkas .env sungguhan tidak disentuh):
 *  A) --check adalah pratinjau: isi dan mtime berkas tujuan tidak berubah, ENV_MISSING tercetak;
 *  B) tanpa --check: kunci baru ditambahkan dengan nilai bawaan apa adanya (termasuk $ dan kutip),
 *     sedangkan nilai kunci lama TIDAK ditimpa;
 *  C) cadangan bernomor .bak.1 dibuat, lalu naik ke .bak.2 pada perubahan berikutnya, dan
 *     cadangan lama tidak ditimpa; opsi --backup-dir juga bekerja;
 *  D) idempoten: jalan kedua -> ENV_ADDED 0, tanpa cadangan baru, isi berkas tetap;
 *  E) kunci usang (#usang) yang masih ada di berkas tujuan dilaporkan di ENV_OBSOLETE_KEYS dan
 *     tidak pernah ditambahkan; kunci asing dilaporkan di ENV_UNKNOWN_KEYS;
 *  F) gerbang anti-basi: setiap kunci di coder-platform/.env.austria.example ada di
 *     deploy/env.keys.txt (sebagai baris resmi atau baris #usang) dan nilai bawaannya sama;
 *  G) deploy/deploy-austria.sh benar-benar memanggil env-sync.sh (pratinjau + penulisan) dan
 *     gulungan lama `while IFS= read -r line ... done < .env.austria.example` sudah hilang;
 *  H) penanganan argumen/kesalahan: kode keluar 2 dan ENV_SYNC_ERROR pada pemakaian salah.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/deploy-env-sync.e2e.ts
 *
 * Catatan jujur: berkas ini HANYA menambah berkas baru dan tidak menyentuh .env sungguhan.
 * Semua berkas uji hidup di bawah /tmp dan dihapus lagi di akhir.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Naik dari direktori berkas uji sampai menemukan deploy/deploy-austria.sh (akar repo). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "deploy", "deploy-austria.sh"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`akar repo tidak ditemukan dari ${start} (deploy/deploy-austria.sh tidak ada)`);
}

const repoRoot = findRepoRoot(here);
const envSync = join(repoRoot, "deploy", "env-sync.sh");
const keysResmi = join(repoRoot, "deploy", "env.keys.txt");
const deployScript = join(repoRoot, "deploy", "deploy-austria.sh");
const exampleFile = join(repoRoot, "coder-platform", ".env.austria.example");

let passed = 0;
let failed = 0;
const failedNames: string[] = [];
const skipped: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) {
  skipped.push(`${name} — ${reason}`);
  console.log(`SKIP ${name} ${reason}`);
}

type Hasil = { status: number; out: string; err: string };
/** Jalankan env-sync.sh dari akar repo (seperti pemakaian nyata). */
function sync(args: string[]): Hasil {
  const run = spawnSync("bash", [envSync, ...args], { encoding: "utf8", cwd: repoRoot });
  return { status: run.status ?? -1, out: `${run.stdout ?? ""}`, err: `${run.stderr ?? ""}` };
}
/** Ambil baris laporan persis `NAMA` atau `NAMA nilai`. */
function baris(out: string, nama: string): string[] {
  return out.split("\n").filter((line) => line === nama || line.startsWith(`${nama} `));
}
/** Nilai sesudah nama baris laporan; "" bila tidak ada. */
function nilai(out: string, nama: string): string {
  const found = baris(out, nama);
  return found.length ? found[found.length - 1].slice(nama.length).trim() : "";
}
/** Daftar kunci pada baris laporan berbentuk `NAMA k1,k2` (baris tunggal). */
function daftar(out: string, nama: string): string[] {
  const raw = nilai(out, nama);
  return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}
/** Semua nilai dari baris `NAMA nilai` yang boleh muncul berkali-kali (ENV_MISSING / ENV_ADD). */
function nilaiSemua(out: string, nama: string): string[] {
  return baris(out, nama).map((line) => line.slice(nama.length).trim());
}
/** Daftar kunci gabungan dari semua baris `NAMA k1,k2`. */
function daftarSemua(out: string, nama: string): string[] {
  return nilaiSemua(out, nama).flatMap((raw) => (raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : []));
}
function tulis(path: string, isi: string) { writeFileSync(path, isi, "utf8"); }
function baca(path: string): string { return readFileSync(path, "utf8"); }
function tidur(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function kunciDiBerkas(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}
function petaNilai(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) out.set(match[1], match[2]);
  }
  return out;
}
function daftarUsang(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^#usang\s+([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}
function adaBerkas(path: string): boolean { return existsSync(path); }

const kerja = mkdtempSync(join(tmpdir(), "wave10-env-sync-"));
const rahasia = "NILAI_RAHASIA_JANGAN_CETAK_9f3a";
const keysUji = join(kerja, "keys-uji.txt");
/** Daftar kunci uji: BETA sengaja memuat $ dan kutip supaya penulisan apa adanya terbukti. */
const isiKeysUji = [
  "# komentar biasa diabaikan",
  "",
  "ALPHA=satu",
  `BETA=nilai dengan $tanda dan 'kutip tunggal' serta "kutip ganda"`,
  "GAMMA=",
  "#usang LAMA=9",
  "DUA_KATA=nilai dengan spasi di dalamnya",
].join("\n") + "\n";
const keysUjiDua = isiKeysUji + "DELTA=4\n";

console.log(`INFO akar repo ${repoRoot}`);
console.log(`INFO env-sync.sh ${envSync}`);
console.log(`INFO berkas uji sementara ${kerja}`);

// =====================================================================================
// Bagian A: --check adalah pratinjau yang benar-benar tidak menulis.
// =====================================================================================
console.log("\n--- Bagian A: pratinjau --check ---");
tulis(keysUji, isiKeysUji);
const envA = join(kerja, "a.env");
tulis(envA, `ALPHA=lama\nPORT=1234\nRAHASIA=${rahasia}\nLUAR=asing\n`);
const isiASebelum = baca(envA);
const mtimeASebelum = statSync(envA).mtimeMs;
await tidur(30);
const a = sync([envA, "--check", "--keys-file", keysUji]);
check("A1 --check keluar 0 dan mencetak ENV_SYNC_CHECK_OK", a.status === 0 && a.out.includes("ENV_SYNC_CHECK_OK"), `${a.status} ${a.err}`);
check("A2 --check mencetak ENV_SYNC_MODE check", nilai(a.out, "ENV_SYNC_MODE") === "check", nilai(a.out, "ENV_SYNC_MODE"));
check("A3 --check melaporkan ENV_MISSING BETA", daftarSemua(a.out, "ENV_MISSING").includes("BETA"), a.out.split("\n").filter((l) => l.startsWith("ENV_MISSING")).join(" | "));
check("A4 --check melaporkan ENV_MISSING GAMMA dan DUA_KATA", ["GAMMA", "DUA_KATA"].every((k) => daftarSemua(a.out, "ENV_MISSING").includes(k)), nilai(a.out, "ENV_MISSING_COUNT"));
check("A5 ENV_MISSING_COUNT cocok dengan jumlah baris ENV_MISSING", Number(nilai(a.out, "ENV_MISSING_COUNT")) === baris(a.out, "ENV_MISSING").length, `${nilai(a.out, "ENV_MISSING_COUNT")} vs ${baris(a.out, "ENV_MISSING").length}`);
check("A6 isi berkas tujuan tidak berubah setelah --check", baca(envA) === isiASebelum);
check("A7 mtime berkas tujuan tidak berubah setelah --check", statSync(envA).mtimeMs === mtimeASebelum, `${statSync(envA).mtimeMs} vs ${mtimeASebelum}`);
check("A8 --check tidak membuat cadangan", !adaBerkas(`${envA}.bak.1`), readdirSync(kerja).join(","));
check("A9 ENV_ADDED 0 pada pratinjau", nilai(a.out, "ENV_ADDED") === "0", nilai(a.out, "ENV_ADDED"));
check("A10 keluaran tidak pernah memuat isi nilai rahasia", !a.out.includes(rahasia) && !a.err.includes(rahasia));

// =====================================================================================
// Bagian B: penulisan — kunci baru ditambahkan, nilai lama tidak ditimpa, cadangan .bak.1.
// =====================================================================================
console.log("\n--- Bagian B: penulisan + cadangan bernomor ---");
const b = sync([envA, "--keys-file", keysUji]);
const isiB = baca(envA);
check("B1 penulisan keluar 0 dan mencetak ENV_SYNC_OK", b.status === 0 && b.out.includes("ENV_SYNC_OK"), `${b.status} ${b.err}`);
check("B2 ENV_ADD BETA dan GAMMA tercetak", ["BETA", "GAMMA"].every((k) => daftarSemua(b.out, "ENV_ADD").includes(k)), nilai(b.out, "ENV_ADDED"));
check("B3 ENV_ADDED 3 (BETA, GAMMA, DUA_KATA)", nilai(b.out, "ENV_ADDED") === "3", nilai(b.out, "ENV_ADDED"));
check("B4 nilai bawaan ditulis apa adanya (tanpa ekspansi $ atau kutip)",
  isiB.split("\n").includes(`BETA=nilai dengan $tanda dan 'kutip tunggal' serta "kutip ganda"`),
  isiB.split("\n").filter((l) => l.startsWith("BETA")).join(" | "));
check("B5 nilai bawaan ber-spasi ditulis utuh", isiB.split("\n").includes("DUA_KATA=nilai dengan spasi di dalamnya"));
check("B6 kunci bawaan kosong ditulis sebagai GAMMA=", isiB.split("\n").includes("GAMMA="));
check("B7 nilai kunci lama ALPHA tidak ditimpa", isiB.includes("ALPHA=lama") && !isiB.includes("ALPHA=satu"));
check("B8 kunci RAHASIA lama tetap ada dan hanya satu baris",
  isiB.split("\n").filter((l) => l.startsWith("RAHASIA=")).length === 1 && isiB.includes(`RAHASIA=${rahasia}`));
check("B9 baris lama tetap di depan (tambahan diletakkan di akhir berkas)",
  isiB.split("\n").slice(0, 4).join("\n") === `ALPHA=lama\nPORT=1234\nRAHASIA=${rahasia}\nLUAR=asing`);
check("B10 ENV_BACKUP menunjuk .bak.1", nilai(b.out, "ENV_BACKUP") === `${envA}.bak.1`, nilai(b.out, "ENV_BACKUP"));
check("B11 cadangan .bak.1 ada dan isinya sama dengan keadaan sebelum penulisan",
  adaBerkas(`${envA}.bak.1`) && baca(`${envA}.bak.1`) === isiASebelum);
check("B12 keluaran penulisan tidak memuat nilai rahasia", !b.out.includes(rahasia) && !b.err.includes(rahasia));

// =====================================================================================
// Bagian C: idempoten.
// =====================================================================================
console.log("\n--- Bagian C: idempoten ---");
const isiCSebelum = baca(envA);
const mtimeCSebelum = statSync(envA).mtimeMs;
await tidur(30);
const c = sync([envA, "--keys-file", keysUji]);
check("C1 jalan kedua ENV_ADDED 0", nilai(c.out, "ENV_ADDED") === "0" && c.status === 0, `${c.status} ${nilai(c.out, "ENV_ADDED")} ${c.err}`);
check("C2 jalan kedua tidak mencetak ENV_ADD", baris(c.out, "ENV_ADD").length === 0, baris(c.out, "ENV_ADD").join(","));
check("C3 jalan kedua tidak membuat cadangan baru", !adaBerkas(`${envA}.bak.2`), readdirSync(kerja).filter((n) => n.startsWith("a.env.bak")).join(","));
check("C4 isi berkas tidak berubah", baca(envA) === isiCSebelum);
check("C5 mtime berkas tidak berubah", statSync(envA).mtimeMs === mtimeCSebelum, `${statSync(envA).mtimeMs} vs ${mtimeCSebelum}`);
check("C6 jalan kedua tetap mencetak ENV_SYNC_OK", c.out.includes("ENV_SYNC_OK"));

// =====================================================================================
// Bagian D: cadangan bernomor naik dan opsi --backup-dir.
// =====================================================================================
console.log("\n--- Bagian D: nomor cadangan naik + --backup-dir ---");
const keysUji2 = join(kerja, "keys-uji-2.txt");
tulis(keysUji2, keysUjiDua);
const isiDSebelum = baca(envA);
const d = sync([envA, "--keys-file", keysUji2]);
check("D1 perubahan berikutnya menambah DELTA (ENV_ADDED 1)", nilai(d.out, "ENV_ADDED") === "1" && daftarSemua(d.out, "ENV_ADD").includes("DELTA"), nilai(d.out, "ENV_ADDED"));
check("D2 cadangan kedua bernama .bak.2", nilai(d.out, "ENV_BACKUP") === `${envA}.bak.2`, nilai(d.out, "ENV_BACKUP"));
check("D3 isi .bak.2 sama dengan keadaan sebelum perubahan kedua", adaBerkas(`${envA}.bak.2`) && baca(`${envA}.bak.2`) === isiDSebelum);
check("D4 cadangan .bak.1 tidak ditimpa (masih keadaan awal)", baca(`${envA}.bak.1`) === isiASebelum);

const envD = join(kerja, "d.env");
const dirBackup = join(kerja, "cadangan");
mkdirSync(dirBackup, { recursive: true });
tulis(envD, "ALPHA=awal\n");
const dd = sync([envD, "--keys-file", keysUji, "--backup-dir", dirBackup]);
check("D5 --backup-dir menaruh cadangan di direktori lain",
  nilai(dd.out, "ENV_BACKUP") === join(dirBackup, "d.env.bak.1") && adaBerkas(join(dirBackup, "d.env.bak.1")),
  nilai(dd.out, "ENV_BACKUP"));
check("D6 cadangan di luar direktori tujuan tidak mengganggu penulisan", daftarSemua(dd.out, "ENV_ADD").includes("BETA"));

// =====================================================================================
// Bagian E: kunci usang dan kunci asing.
// =====================================================================================
console.log("\n--- Bagian E: kunci usang (#usang) dan kunci asing ---");
appendFileSync(envA, "LAMA=9\n", "utf8");
const e = sync([envA, "--check", "--keys-file", keysUji]);
check("E1 kunci usang yang masih ada dilaporkan di ENV_OBSOLETE_KEYS", daftar(e.out, "ENV_OBSOLETE_KEYS").includes("LAMA"), nilai(e.out, "ENV_OBSOLETE_KEYS"));
check("E2 kunci asing dilaporkan di ENV_UNKNOWN_KEYS", daftar(e.out, "ENV_UNKNOWN_KEYS").includes("LUAR"), nilai(e.out, "ENV_UNKNOWN_KEYS"));
check("E3 kunci usang tidak dihitung sebagai kunci asing", !daftar(e.out, "ENV_UNKNOWN_KEYS").includes("LAMA"), nilai(e.out, "ENV_UNKNOWN_KEYS"));
check("E4 kunci usang tidak pernah masuk ENV_MISSING", !daftarSemua(e.out, "ENV_MISSING").includes("LAMA"));

const envE = join(kerja, "e.env");
tulis(envE, "ALPHA=awal\n");
const ee = sync([envE, "--keys-file", keysUji]);
check("E5 penulisan tidak pernah menambahkan kunci usang",
  ee.status === 0 && !baca(envE).split("\n").some((line) => line.startsWith("LAMA=")) && !daftarSemua(ee.out, "ENV_ADD").includes("LAMA"));
check("E6 berkas bersih: ENV_OBSOLETE_KEYS tercetak tanpa kunci", baris(ee.out, "ENV_OBSOLETE_KEYS").length === 1 && nilai(ee.out, "ENV_OBSOLETE_KEYS") === "", ee.out.split("\n").filter((l) => l.startsWith("ENV_OBSOLETE")).join(" | "));
const envE2 = join(kerja, "e2.env");
tulis(envE2, "ALPHA=awal\nBETA=x\nGAMMA=\nDUA_KATA=y\n");
const ee2 = sync([envE2, "--check", "--keys-file", keysUji]);
check("E7 berkas tujuan yang hanya berisi kunci resmi: ENV_UNKNOWN_KEYS kosong",
  baris(ee2.out, "ENV_UNKNOWN_KEYS").length === 1 && nilai(ee2.out, "ENV_UNKNOWN_KEYS") === "",
  ee2.out.split("\n").filter((l) => l.startsWith("ENV_UNKNOWN")).join(" | "));

// =====================================================================================
// Bagian F: daftar resmi sungguhan (gerbang anti-basi).
// =====================================================================================
console.log("\n--- Bagian F: daftar resmi sungguhan ---");
const isiExample = baca(exampleFile);
const isiKeys = baca(keysResmi);
const kunciExample = kunciDiBerkas(isiExample);
const kunciResmi = kunciDiBerkas(isiKeys);
const kunciUsangResmi = daftarUsang(isiKeys);
check("F1 .env.austria.example terbaca dan memuat banyak kunci", kunciExample.length >= 60, String(kunciExample.length));
check("F2 setiap kunci .env.austria.example ada di deploy/env.keys.txt (resmi atau #usang)",
  kunciExample.every((key) => kunciResmi.includes(key) || kunciUsangResmi.includes(key)),
  kunciExample.filter((key) => !kunciResmi.includes(key) && !kunciUsangResmi.includes(key)).join(","));
check("F3 daftar resmi dan daftar usang tidak beririsan",
  kunciUsangResmi.every((key) => !kunciResmi.includes(key)),
  kunciUsangResmi.filter((key) => kunciResmi.includes(key)).join(","));
const petaExample = petaNilai(isiExample);
const petaResmi = petaNilai(isiKeys);
const bedaNilai = kunciResmi.filter((key) => petaExample.has(key) && petaExample.get(key) !== petaResmi.get(key));
check("F4 nilai bawaan di deploy/env.keys.txt sama dengan .env.austria.example", bedaNilai.length === 0, bedaNilai.map((k) => `${k}:${petaResmi.get(k)} != ${petaExample.get(k)}`).join(" | "));
check("F5 berkas kunci memuat penjelasan format (baris biasa dan baris usang)",
  isiKeys.includes("KEY=nilai_default") && isiKeys.includes("#usang KEY=nilai"));
check("F6 tidak ada baris tak dikenal di berkas kunci (tidak ada ENV_SYNC_WARN saat pratinjau)",
  !sync([envA, "--check", "--keys-file", keysResmi]).out.includes("ENV_SYNC_WARN"));

const envF = join(kerja, "f.env");
tulis(envF, `APP_VERSION=0.0.1\nPLATFORM_WEBHOOK_URL=\nDATABASE_URL=${rahasia}\n`);
const f = sync([envF, "--check", "--keys-file", keysResmi]);
const kurangF = baris(f.out, "ENV_MISSING").length;
const diharapkanKurang = kunciResmi.filter((key) => key !== "APP_VERSION" && !kunciUsangResmi.includes(key)).length;
check("F7 pratinjau berkas kunci sungguhan melaporkan jumlah ENV_MISSING yang benar",
  f.status === 0 && kurangF === diharapkanKurang && nilai(f.out, "ENV_MISSING_COUNT") === String(diharapkanKurang),
  `${kurangF} vs ${diharapkanKurang}`);
check("F8 berkas kunci sungguhan melaporkan kunci usang PLATFORM_WEBHOOK_URL",
  kunciUsangResmi.includes("PLATFORM_WEBHOOK_URL") ? daftar(f.out, "ENV_OBSOLETE_KEYS").includes("PLATFORM_WEBHOOK_URL") : true,
  nilai(f.out, "ENV_OBSOLETE_KEYS"));
check("F9 berkas kunci sungguhan melaporkan kunci asing DATABASE_URL", daftar(f.out, "ENV_UNKNOWN_KEYS").includes("DATABASE_URL"), nilai(f.out, "ENV_UNKNOWN_KEYS"));
const fw = sync([envF, "--keys-file", keysResmi]);
const isiF = baca(envF);
check("F10 penulisan nyata: APP_VERSION lama TIDAK ditimpa nilai bawaan",
  isiF.split("\n").includes("APP_VERSION=0.0.1") && !isiF.includes("APP_VERSION=0.19.0"),
  isiF.split("\n").filter((l) => l.startsWith("APP_VERSION")).join(" | "));
check("F11 penulisan nyata menambahkan tepat sebanyak ENV_MISSING_COUNT",
  Number(nilai(fw.out, "ENV_ADDED")) === diharapkanKurang, `${nilai(fw.out, "ENV_ADDED")} vs ${diharapkanKurang}`);
check("F12 setiap kunci resmi ada di berkas tujuan setelah penulisan",
  kunciResmi.every((key) => isiF.split("\n").some((line) => line.startsWith(`${key}=`))),
  kunciResmi.filter((key) => !isiF.split("\n").some((line) => line.startsWith(`${key}=`))).join(","));
check("F13 kunci usang tidak ditambahkan oleh penulisan nyata",
  kunciUsangResmi.filter((key) => key !== "PLATFORM_WEBHOOK_URL").every((key) => !isiF.split("\n").some((line) => line.startsWith(`${key}=`))));

// =====================================================================================
// Bagian G: sambungan ke deploy/deploy-austria.sh.
// =====================================================================================
console.log("\n--- Bagian G: deploy-austria.sh memakai env-sync.sh ---");
const teksDeploy = baca(deployScript);
check("G1 deploy-austria.sh memanggil env-sync.sh", teksDeploy.includes("env-sync.sh"), "");
check("G2 deploy-austria.sh menjalankan pratinjau --check lebih dulu",
  /--check --keys-file/.test(teksDeploy), "");
check("G3 deploy-austria.sh meneruskan --keys-file (daftar resmi)",
  teksDeploy.includes("--keys-file") && teksDeploy.includes("env.keys.txt"), "");
check("G4 gulungan lama `while IFS= read -r line` sudah hilang",
  !teksDeploy.includes("while IFS= read -r line") && !teksDeploy.includes("done < .env.austria.example"), "");
check("G5 berkas .env persisten dipakai sebagai berkas tujuan",
  teksDeploy.includes('"\\${PERSIST}"') || teksDeploy.includes('"${PERSIST}"'), "");
check("G6 pembaruan APP_VERSION setiap deploy tetap ada",
  teksDeploy.includes("^APP_VERSION=") && teksDeploy.includes("APP_VERSION=${VERSION}"), "");
check("G7 deploy berhenti bila berkas butir 32 tidak ada di paket",
  teksDeploy.includes("DEPLOY_ABORTED") && teksDeploy.includes("env.keys.txt tidak ada di paket"), "");
check("G8 env-sync.sh dapat dieksekusi dan bershebang bash",
  (statSync(envSync).mode & 0o111) !== 0 && baca(envSync).startsWith("#!/usr/bin/env bash"), `mode ${(statSync(envSync).mode & 0o777).toString(8)}`);
const teksSync = baca(envSync);
check("G9 env-sync.sh memakai set -euo pipefail", teksSync.includes("set -euo pipefail"));
// Komentar di skrip ikut menyebut "eval"/"source", jadi hanya baris NON-komentar yang dinilai.
const teksSyncKode = teksSync.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
check("G10 env-sync.sh tanpa eval dan tanpa source berkas env",
  !/\beval\b/.test(teksSyncKode) && !/^\s*(source|\.)\s/m.test(teksSyncKode) && !/sed\s+-i/.test(teksSyncKode), "");

// =====================================================================================
// Bagian H: penanganan argumen dan kesalahan.
// =====================================================================================
console.log("\n--- Bagian H: argumen dan kesalahan ---");
const h1 = sync([]);
check("H1 tanpa berkas tujuan keluar kode 2", h1.status === 2, String(h1.status));
const h2 = sync([join(kerja, "tidak-ada.env"), "--check"]);
check("H2 berkas tujuan tidak ada keluar kode 2 dengan ENV_SYNC_ERROR", h2.status === 2 && h2.err.includes("ENV_SYNC_ERROR"), `${h2.status} ${h2.err.trim()}`);
const h3 = sync([envA, "--salah"]);
check("H3 argumen tidak dikenal keluar kode 2", h3.status === 2 && h3.err.includes("ENV_SYNC_ERROR"), String(h3.status));
const h4 = sync([envA, "--keys-file", join(kerja, "keys-tidak-ada.txt")]);
check("H4 berkas daftar kunci tidak ada keluar kode 2", h4.status === 2 && h4.err.includes("ENV_SYNC_ERROR"), String(h4.status));
const h5 = sync(["--help"]);
check("H5 --help keluar kode 0 dan menampilkan pakai", h5.status === 0 && h5.out.includes("pakai:"), String(h5.status));
const envH = join(kerja, "h.env");
tulis(envH, "ALPHA=tanpa newline di akhir");
const h6 = sync([envH, "--keys-file", keysUji]);
const isiH = baca(envH);
check("H6 berkas tanpa newline di akhir: kunci baru tetap di baris tersendiri",
  h6.status === 0 && isiH.startsWith("ALPHA=tanpa newline di akhir\n") && isiH.split("\n").includes("ALPHA=tanpa newline di akhir"),
  JSON.stringify(isiH.slice(0, 60)));

// =====================================================================================
// Ringkasan.
// =====================================================================================
rmSync(kerja, { recursive: true, force: true });
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
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
if (failed === 0) {
  console.log("ALL_WAVE10_ENV_SYNC_TESTS_PASSED");
  process.exit(0);
}
console.log("SUITE_FAILED");
process.exit(1);

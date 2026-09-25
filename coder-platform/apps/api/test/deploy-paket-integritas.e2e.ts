/**
 * Gerbang integritas paket rilis: memastikan tidak ada berkas KODE yang hilang dari paket.
 *
 * Kenapa ada: paket dibangun `deploy/buat-paket.sh` dari `git ls-files`, jadi berkas yang
 * terabaikan `.gitignore` TIDAK akan pernah ikut ke paket walau API mengimpornya. Kejadian nyata
 * 26 Sep 2026: pola `*token*` di `.gitignore` menelan `apps/api/src/wave11b/token-accounting.ts`
 * (di-import `wave11b/index.ts`). Tanpa uji ini, paket v0.23.0 akan kehilangan berkas itu dan
 * API gagal saat impor di peladen.
 *
 * Yang dibuktikan:
 *  A) tidak ada berkas kode (.ts/.tsx/.mjs) di tiga pohon kode yang terabaikan git;
 *  B) setiap berkas kode yang ADA di disk terlihat git (terlacak atau belum-terlacak bersih);
 *  C) `git check-ignore` per berkas tidak menyisakan satu pun;
 *  D) skrip paket benar-benar bersumber dari `git ls-files` dan memuat daftar berkas wajib;
 *  E) paket uji SUNGGUHAN dibangun ke folder sementara -> PAKET_OK + SHA256, dan isinya bersih
 *     (tanpa node_modules/.env/data/dist) serta memuat env-sync.sh + env.keys.txt;
 *  F) kedua Dockerfile meng-COPY `apps/api/benchmark` (pelajaran butir 61);
 *  G) `deploy/env.keys.txt` memuat kunci rilis SECRETS_KEY + CSP_ENABLED + APP_VERSION bersemver.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/deploy-paket-integritas.e2e.ts
 *
 * Catatan jujur: paket pada langkah (E) dibangun dari HEAD (isi commit terakhir), bukan dari berkas
 * kerja yang belum di-commit. Jadi uji ini membuktikan MEKANISME paket selalu benar, bukan bahwa
 * commit v0.23.0 memuat seluruh berkas 11C (itu terbukti di langkah A-C + pemeriksaan git manual).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Akar repo git: `apps/api/test` -> naik 4 tingkat = /workspace/coblai-dinda (berisi coder-platform). */
const REPO = join(here, "..", "..", "..", "..");
const KODE_EXT = [".ts", ".tsx", ".mjs"];
const POHON = ["coder-platform/apps", "coder-dashboard/src", "coder-dashboard/e2e"];

let passed = 0, failed = 0;
const failedNames: string[] = [];
const skipped: string[] = [];
function cek(nama: string, syarat: boolean, rincian = "") {
  if (syarat) { passed++; console.log(`PASS ${nama}${rincian ? " · " + rincian : ""}`); }
  else { failed++; failedNames.push(nama); console.log(`GAGAL ${nama}${rincian ? " · " + rincian : ""}`); }
}
function git(args: string[]) {
  const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { kode: r.status, keluar: (r.stdout ?? "").trim(), galat: (r.stderr ?? "").trim() };
}
/** Semua berkas kode di disk di bawah tiga pohon kode. */
function berkasKodeDiDisk(): string[] {
  const hasil: string[] = [];
  const jalan = (rel: string) => {
    const absolut = join(REPO, rel);
    if (!existsSync(absolut)) return;
    for (const isi of readdirSync(absolut, { withFileTypes: true })) {
      if (isi.name === "node_modules" || isi.name === "dist" || isi.name === ".git") continue;
      const anak = `${rel}/${isi.name}`;
      if (isi.isDirectory()) jalan(anak);
      else if (KODE_EXT.some((ext) => isi.name.endsWith(ext))) hasil.push(anak);
    }
  };
  for (const pohon of POHON) jalan(pohon);
  return hasil.sort();
}

// =====================================================================================
// A) Tidak ada berkas kode yang terabaikan git.
// =====================================================================================
const abaikan = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...POHON]);
const abaikanKode = abaikan.keluar.split("\n").filter((baris) => baris && KODE_EXT.some((ext) => baris.endsWith(ext)));
cek("A1 tidak ada berkas kode yang terabaikan git", abaikanKode.length === 0,
  abaikanKode.length ? `terabaikan: ${abaikanKode.join(", ")}` : "0 berkas");

// =====================================================================================
// B) Setiap berkas kode di disk terlihat git (terlacak atau belum-terlacak bersih).
// =====================================================================================
const diDisk = berkasKodeDiDisk();
const terlacak = new Set(git(["ls-files", "--", ...POHON]).keluar.split("\n").filter(Boolean));
const belumTerlacak = new Set(git(["ls-files", "--others", "--exclude-standard", "--", ...POHON]).keluar.split("\n").filter(Boolean));
const tidakTerlihat = diDisk.filter((f) => !terlacak.has(f) && !belumTerlacak.has(f));
cek("B1 jumlah berkas kode di disk > 100 (dasar pemeriksaan masuk akal)", diDisk.length > 100, `${diDisk.length} berkas`);
cek("B2 setiap berkas kode di disk terlihat git", tidakTerlihat.length === 0,
  tidakTerlihat.length ? `tidak terlihat: ${tidakTerlihat.slice(0, 5).join(", ")}` : `${diDisk.length} berkas terbaca git`);
cek("B3 berkas wave11b/token-accounting.ts (jebakan nyata 26 Sep 2026) terlihat git",
  belumTerlacak.has("coder-platform/apps/api/src/wave11b/token-accounting.ts") ||
  terlacak.has("coder-platform/apps/api/src/wave11b/token-accounting.ts"),
  existsSync(join(REPO, "coder-platform/apps/api/src/wave11b/token-accounting.ts")) ? "ada di disk dan terbaca git" : "berkas tidak ada");

// =====================================================================================
// C) git check-ignore per berkas: tidak satu pun.
// =====================================================================================
const periksa = spawnSync("git", ["-C", REPO, "check-ignore", "--no-index", "--stdin"], {
  encoding: "utf8", input: diDisk.join("\n") + "\n", maxBuffer: 64 * 1024 * 1024,
});
const diabaikanPerBerkas = (periksa.stdout ?? "").trim().split("\n").filter(Boolean);
cek("C1 git check-ignore tidak menandai satu pun berkas kode", diabaikanPerBerkas.length === 0,
  diabaikanPerBerkas.length ? `ditandai: ${diabaikanPerBerkas.slice(0, 5).join(", ")}` : "0 dari " + diDisk.length);
cek("C2 jalur impor wave11b/index.ts -> token-accounting.ts nyata ada",
  readFileSync(join(REPO, "coder-platform/apps/api/src/wave11b/index.ts"), "utf8").includes('from "./token-accounting.js"'),
  "import ditemukan di index.ts");

// =====================================================================================
// D) Skrip paket bersumber dari git ls-files + daftar berkas wajib.
// =====================================================================================
const skripPaket = readFileSync(join(REPO, "deploy", "buat-paket.sh"), "utf8");
cek("D1 buat-paket.sh mengambil berkas dari git ls-files", skripPaket.includes("git ls-files"),
  "pernyataan ada di skrip");
for (const wajib of ["coder-platform/apps/api/src/server.ts", "coder-dashboard/index.html", "coder-platform/deploy/env.keys.txt"]) {
  cek(`D2 daftar wajib paket memuat ${wajib}`, skripPaket.includes(wajib), "tercantum di loop pemeriksaan");
}

// =====================================================================================
// E) Paket uji SUNGGUHAN dibangun ke folder sementara.
// =====================================================================================
const keluar = mkdtempSync(join(tmpdir(), "paket-uji-"));
const bangun = spawnSync("bash", [join(REPO, "deploy", "buat-paket.sh"), "0.0.1"], {
  cwd: REPO, encoding: "utf8", env: { ...process.env, PAKET_KELUARAN: keluar },
});
const keluaranPaket = `${bangun.stdout ?? ""}${bangun.stderr ?? ""}`;
const tarPath = join(keluar, "coder-sam-university-v0.0.1.tar.gz");
cek("E1 buat-paket.sh selesai tanpa galat", bangun.status === 0, `kode keluar=${bangun.status}`);
cek("E2 skrip mencetak PAKET_OK", keluaranPaket.includes("PAKET_OK"), keluaranPaket.split("\n").find((b) => b.startsWith("PAKET_OK")) ?? "(tidak ada)");
cek("E3 sidik jari SHA256 tercetak dan berkasnya ada", keluaranPaket.includes("SHA256") && existsSync(`${tarPath}.sha256`), "");
cek("E4 berkas paket ada dan tidak kosong", existsSync(tarPath) && statSync(tarPath).size > 100_000, existsSync(tarPath) ? `${Math.round(statSync(tarPath).size / 1024)} KB` : "tidak ada");
const daftar = spawnSync("tar", ["-tzf", tarPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? "";
const baris = daftar.split("\n").filter(Boolean);
cek("E5 paket TIDAK memuat node_modules/.env/data/dist",
  !baris.some((b) => /(^|\/)node_modules\/|(^|\/)\.env$|(^|\/)data\/|\/dist\//.test(b)), `${baris.length} entri`);
cek("E6 paket memuat deploy/env-sync.sh + env.keys.txt di dalam coder-platform",
  baris.includes("coder-platform/deploy/env-sync.sh") && baris.includes("coder-platform/deploy/env.keys.txt"), "");
/** Modul Wave 11 yang belum di-commit tetap harus TERBACA git, supaya `git add -A` tidak melewatinya. */
for (const [nama, dir] of [["wave11b", "coder-platform/apps/api/src/wave11b/"], ["wave11c", "coder-platform/apps/api/src/wave11c/"]]) {
  const modul = diDisk.filter((f) => f.startsWith(dir));
  const terlihat = modul.filter((f) => terlacak.has(f) || belumTerlacak.has(f));
  cek(`E7 seluruh modul ${nama} di disk akan ikut paket setelah commit`,
    modul.length >= 5 && terlihat.length === modul.length,
    `${terlihat.length}/${modul.length} modul terbaca git`);
}
cek("E8 paket uji (dari HEAD) tetap memuat berkas dashboard di paket",
  baris.includes("coder-dashboard/index.html") && baris.includes("coder-dashboard/src/App.tsx"),
  `${baris.filter((b) => b.startsWith("coder-dashboard/")).length} berkas dashboard di paket`);
rmSync(keluar, { recursive: true, force: true });

// =====================================================================================
// F) Dockerfile memuat questions.json benchmark (pelajaran butir 61).
// =====================================================================================
for (const docker of ["Dockerfile", "Dockerfile.austria"]) {
  const isi = readFileSync(join(REPO, "coder-platform", docker), "utf8");
  cek(`F Dockerfile ${docker} meng-COPY apps/api/benchmark`, isi.includes("apps/api/benchmark"), "baris COPY ada");
}

// =====================================================================================
// G) Kunci rilis ada di registry env.
// =====================================================================================
const kunciEnv = readFileSync(join(REPO, "deploy", "env.keys.txt"), "utf8");
for (const kunci of ["SECRETS_KEY", "CSP_ENABLED"]) {
  cek(`G kunci ${kunci} ada di deploy/env.keys.txt`, new RegExp(`^${kunci}=`, "m").test(kunciEnv), "baris resmi ada");
}
const versiEnv = (kunciEnv.match(/^APP_VERSION=(.+)$/m) ?? [])[1] ?? "";
cek("G APP_VERSION di deploy/env.keys.txt bersemver", /^\d+\.\d+\.\d+$/.test(versiEnv.trim()),
  versiEnv.trim() ? `nilai=${versiEnv.trim()}` : "tidak ditemukan");

// =====================================================================================
// Ringkasan.
// =====================================================================================
console.log("");
if (skipped.length) console.log(`SKIP ${skipped.length} pemeriksaan: ${skipped.join(", ")}`);
else console.log("Tidak ada pemeriksaan yang di-skip.");
if (failedNames.length) { console.log(`GAGAL ${failed} pemeriksaan:`); for (const n of failedNames) console.log(`  - ${n}`); }
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
if (failed === 0) { console.log("ALL_DEPLOY_PAKET_TESTS_PASSED"); process.exit(0); }
console.log("SUITE_FAILED");
process.exit(1);

/**
 * Gerbang port uji: memastikan tidak ada suite yang bisa memilih port yang DIBLOKIR `fetch()`.
 *
 * Kenapa ada (26 Sep 2026): `fetch()` menolak daftar "bad port" dari spesifikasi Fetch. Bila suite
 * memilih nomor terblokir sebagai port peladen ujinya, setiap `fetch()` gagal seketika dengan
 * `TypeError: fetch failed <- Error: bad port` walaupun peladen hidup dan HTTP polos berhasil,
 * sehingga suite melapor "server tidak siap". Itu membuat gerbang rilis merah dua kali tanpa sebab
 * yang tampak (gerbang penuh putaran 2 dan 5; direproduksi 2 dari 24 putaran `wave6.e2e.ts` mandiri
 * pada nomor 6566 dan 6668). Berkas `port-aman.ts` menyediakan penolongnya; uji ini menjaga agar
 * tidak ada suite yang kembali memakai rentang mentah yang memuat nomor terblokir.
 *
 * Yang dibuktikan:
 *  A) daftar terblokir tidak kosong DAN masih benar pada Node yang berjalan: sampel nomor terblokir
 *     gagal dengan cause "bad port", sementara nomor kontrol tidak;
 *  B) seluruh deklarasi rentang port di `apps/api/test/*.ts` dipindai, jumlah yang terbaca minimal
 *     20 (supaya uji ini tidak bisa lulus karena pemindaian rusak), dan tidak satu pun rentang
 *     memuat nomor terblokir;
 *  C) ketiga suite yang pernah kena (wave6, csrf-limits, outbox-mail) benar-benar memakai
 *     `pilihPortUji`, dan penolong itu tidak pernah mengembalikan nomor terblokir (5000 undian);
 *  D) basis penolong port-bebas (`cariPortBebas`/`freePort`), termasuk rentang `Math.random` di
 *     dalam badannya, tidak memuat nomor terblokir.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/port-uji-fetch-aman.e2e.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT_TERBLOKIR_FETCH, pilihPortUji } from "./port-aman.js";

const here = dirname(fileURLToPath(import.meta.url));
const TERBLOKIR = [...PORT_TERBLOKIR_FETCH].sort((a, b) => a - b);

let passed = 0, failed = 0;
const failedNames: string[] = [];
function cek(nama: string, syarat: boolean, rincian = "") {
  if (syarat) { passed++; console.log(`PASS ${nama}${rincian ? " · " + rincian : ""}`); }
  else { failed++; failedNames.push(nama); console.log(`GAGAL ${nama}${rincian ? " · " + rincian : ""}`); }
}

/** Sebab galat fetch: "bad port" berarti nomor port ditolak sebelum menyambung. */
async function sebabFetch(port: number): Promise<string> {
  try {
    await fetch(`http://127.0.0.1:${port}/tidak-ada`);
    return "berhasil";
  } catch (error: any) {
    return String(error?.cause?.message ?? error?.message ?? "tidak diketahui");
  }
}

// =====================================================================================
// A. Daftar terblokir masih berlaku pada Node ini.
// =====================================================================================
cek("A1 daftar port terblokir tidak kosong", TERBLOKIR.length >= 10, `jumlah=${TERBLOKIR.length}`);
for (const nomor of [6000, 6566, 6668, 6697]) {
  const sebab = await sebabFetch(nomor);
  cek(`A2 nomor ${nomor} ditolak fetch sebagai bad port`, sebab === "bad port", `sebab=${sebab}`);
}
for (const nomor of [6550, 6699, 7060]) {
  const sebab = await sebabFetch(nomor);
  cek(`A3 nomor kontrol ${nomor} bukan bad port`, sebab !== "bad port", `sebab=${sebab}`);
}

// =====================================================================================
// B. Pindai seluruh berkas uji: tidak ada rentang port yang memuat nomor terblokir.
// =====================================================================================
const berkas = readdirSync(here).filter((f) => f.endsWith(".ts")).sort();
const rentang: { berkas: string; nama: string; mulai: number; akhir: number }[] = [];
const POLA_NamaPort = /const\s+(\w*[Pp]ort\w*)\s*=\s*(\d[\d_]*)\s*\+\s*Math\.floor\(Math\.random\(\)\s*\*\s*(\d[\d_]*)\)/g;
const POLA_Tetap = /const\s+(\w*[Pp]ort\w*)\s*=\s*(\d[\d_]*)\s*;/g;
const POLA_BadanPenolong = /(?:function\s+(cariPortBebas|freePort\w*)|const\s+(cariPortBebas|freePort\w*)\s*=)[\s\S]{0,900}?(\d[\d_]*)\s*\+\s*Math\.floor\(Math\.random\(\)\s*\*\s*(\d[\d_]*)\)/g;
const angka = (s: string) => Number(s.replace(/_/g, ""));
for (const f of berkas) {
  const isi = readFileSync(join(here, f), "utf8");
  for (const m of isi.matchAll(POLA_NamaPort)) rentang.push({ berkas: f, nama: m[1], mulai: angka(m[2]), akhir: angka(m[2]) + angka(m[3]) - 1 });
  for (const m of isi.matchAll(POLA_Tetap)) rentang.push({ berkas: f, nama: m[1], mulai: angka(m[2]), akhir: angka(m[2]) });
  for (const m of isi.matchAll(POLA_BadanPenolong)) rentang.push({ berkas: f, nama: `badan ${m[1] ?? m[2]}`, mulai: angka(m[3]), akhir: angka(m[3]) + angka(m[4]) - 1 });
}

cek("B1 pemindaian rentang port berjalan", berkas.length >= 40 && rentang.length >= 20,
  `berkas=${berkas.length} rentang terbaca=${rentang.length}`);
const kena = rentang.filter((r) => TERBLOKIR.some((b) => r.mulai <= b && b <= r.akhir));
cek("B2 tidak ada rentang port suite yang memuat nomor terblokir", kena.length === 0,
  kena.length ? kena.map((r) => `${r.berkas}:${r.nama}=${r.mulai}-${r.akhir}`).join(" | ") : `${rentang.length} rentang bersih`);

// =====================================================================================
// C. Suite yang pernah kena memakai penolong, dan penolongnya tidak pernah salah pilih.
// =====================================================================================
const RENTANG_PERNAH_KENA: [string, number, number][] = [
  ["wave6.e2e.ts", 6500, 200],
  ["csrf-limits.e2e.ts", 3900, 500],
  ["outbox-mail.e2e.ts", 6000, 200],
];
for (const [f, mulai, jumlah] of RENTANG_PERNAH_KENA) {
  const isi = readFileSync(join(here, f), "utf8");
  cek(`C1 ${f} memakai pilihPortUji`, isi.includes("pilihPortUji("), `rentang ${mulai}-${mulai + jumlah - 1}`);
  let salah = 0;
  for (let i = 0; i < 5000; i += 1) if (PORT_TERBLOKIR_FETCH.has(pilihPortUji(mulai, jumlah))) salah += 1;
  cek(`C2 pilihPortUji aman 5000 undian untuk rentang ${mulai}-${mulai + jumlah - 1}`, salah === 0, `terblokir terpilih=${salah}`);
}

// =====================================================================================
// D. Basis penolong port-bebas tidak menunjuk nomor terblokir.
// =====================================================================================
const POLA_Penolong = /(?:cariPortBebas|freePort)\s*\(([^)]*)\)/g;
const basisSalah: string[] = [];
let basisTerbaca = 0;
for (const f of berkas) {
  const isi = readFileSync(join(here, f), "utf8");
  for (const m of isi.matchAll(POLA_Penolong)) {
    for (const nomorStr of m[1].matchAll(/\d[\d_]*/g)) {
      const nomor = angka(nomorStr[0]);
      if (nomor < 3000) continue;
      basisTerbaca += 1;
      if (PORT_TERBLOKIR_FETCH.has(nomor)) basisSalah.push(`${f}:${nomor}`);
    }
  }
}
cek("D1 basis penolong port-bebas terbaca", basisTerbaca >= 10, `jumlah=${basisTerbaca}`);
cek("D2 tidak ada basis penolong yang menunjuk nomor terblokir", basisSalah.length === 0,
  basisSalah.length ? basisSalah.join(" | ") : "bersih");

// Turunan port (mis. `hookPort = port + 500`) juga bisa jatuh ke nomor terblokir, jadi geserannya
// ikut diperiksa terhadap rentang dasar di berkas yang sama -- ini menutup celah yang tadinya ada.
const POLA_Turunan = /const\s+(\w*[Pp]ort\w*)\s*=\s*(\w+)\s*\+\s*(\d[\d_]*)\s*;/g;
const turunanSalah: string[] = [];
let turunanTerbaca = 0;
for (const f of berkas) {
  const isi = readFileSync(join(here, f), "utf8");
  const dasar = new Map<string, { mulai: number; akhir: number }>();
  for (const m of isi.matchAll(POLA_NamaPort)) dasar.set(m[1], { mulai: angka(m[2]), akhir: angka(m[2]) + angka(m[3]) - 1 });
  for (const m of isi.matchAll(POLA_Tetap)) dasar.set(m[1], { mulai: angka(m[2]), akhir: angka(m[2]) });
  for (const m of isi.matchAll(POLA_Turunan)) {
    const asal = dasar.get(m[2]);
    if (!asal) continue;
    const geser = angka(m[3]);
    turunanTerbaca += 1;
    const mulai = asal.mulai + geser, akhir = asal.akhir + geser;
    const kenaTurunan = TERBLOKIR.filter((b) => mulai <= b && b <= akhir);
    if (kenaTurunan.length) turunanSalah.push(`${f}:${m[1]}=${mulai}-${akhir} memuat ${kenaTurunan.join("/")}`);
  }
}
cek("D3 turunan port terbaca", turunanTerbaca >= 2, `jumlah=${turunanTerbaca}`);
cek("D4 tidak ada turunan port yang memuat nomor terblokir", turunanSalah.length === 0,
  turunanSalah.length ? turunanSalah.join(" | ") : `${turunanTerbaca} turunan bersih`);

// =====================================================================================
// Ringkasan.
// =====================================================================================
console.log("");
console.log(`Daftar port terblokir fetch yang diuji: ${TERBLOKIR.join(", ")}`);
if (failedNames.length) { console.log(`GAGAL ${failed} pemeriksaan:`); for (const n of failedNames) console.log(`  - ${n}`); }
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=0`);
if (failed === 0) { console.log("ALL_PORT_UJI_FETCH_AMAN_PASSED"); process.exit(0); }
console.log("SUITE_FAILED");
process.exit(1);

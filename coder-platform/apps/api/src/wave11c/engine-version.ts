/**
 * Wave 11C (butir 78) — TAHAP 1 SAJA: periksa versi mesin. HANYA MEMBACA.
 *
 * Rute: `GET /api/v1/admin/engine/version` (admin platform) membalas DATAR:
 *   `{ engineVersion, platformVersion, startedAt, ...medan penjelas }`
 *
 * Sumber setiap nilai disebut apa adanya:
 *  • `engineVersion` — dari mesin itu sendiri. Untuk mesin RPC, versi dibaca dengan menjalankan
 *    `<PRIME_AGENT_BIN> --version` (baca saja, batas waktu `ENGINE_VERSION_TIMEOUT_MS`, bawaan 5000 ms).
 *    CLI Prime Agent versi ini menulis nomor versi ke **stderr**, jadi keluaran stdout DAN stderr dibaca.
 *    Untuk MOCK_ENGINE, satu-satunya sumber adalah `engine.health()` milik adapter.
 *    Bila mesin tidak melaporkan versi, jawabannya HARUS "versi tidak dilaporkan" — bukan angka karangan.
 *  • `platformVersion` — dari `process.env.APP_VERSION` (atau `npm_package_version`), yaitu label rilis
 *    yang benar-benar dijalankan proses web ini. Bila keduanya kosong, jawabannya "dev".
 *  • `startedAt` — dari `platform_settings.server_started_at` bila ada; bila baris itu belum ditulis,
 *    dipakai `process.uptime()` sehingga tetap tanggal-waktu nyata proses ini mulai.
 *  • `schemaVersion` — `SCHEMA_VERSION` dari `db.ts` (versi skema basis data), medan tambahan.
 *
 * TAHAP 2 (perbarui/rollback mesin) TIDAK dibuat di sini: menunggu keputusan Bapak (K5). Rute ini tidak
 * pernah menulis apa pun, tidak menjalankan perintah selain `--version`, dan tidak menyentuh berkas mesin.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { db, SCHEMA_VERSION } from "../db.js";
import { config } from "../config.js";
import { engine } from "../engine.js";
import { requireUser } from "../auth.js";
import { adminRequired, isPlatformAdmin, platformSetting } from "../wave11a/shared.js";

/** Kalimat yang wajib muncul bila mesin tidak melaporkan versi. Tidak pernah diganti angka tebakan. */
export const VERSI_TIDAK_DILAPORKAN = "versi tidak dilaporkan";

/** Batas waktu menjalankan `<biner> --version`. Bisa diatur operator; bukan kunci `config.ts`. */
const BATAS_WAKTU_MS = (() => {
  const angka = Number(process.env.ENGINE_VERSION_TIMEOUT_MS);
  return Number.isFinite(angka) && angka >= 500 && angka <= 60_000 ? Math.floor(angka) : 5000;
})();

/** Batas panjang teks versi yang diterima; lebih panjang dari ini dianggap laporan sampah. */
const MAKS_PANJANG_VERSI = 80;

export type JenisMesin = "mock" | "prime-rpc" | "unconfigured";

/** Jenis mesin yang benar-benar dipakai proses ini (logika sama dengan `engine.ts`). */
export function jenisMesin(): JenisMesin {
  if (config.MOCK_ENGINE) return "mock";
  return String(config.PRIME_AGENT_BIN ?? "").trim() ? "prime-rpc" : "unconfigured";
}

/** Mencari biner di PATH bila namanya bukan jalur (perilaku setara `which`), tanpa menjalankannya. */
export function binerAda(biner: string): boolean {
  const nama = String(biner ?? "").trim();
  if (!nama) return false;
  if (nama.includes("/") || nama.includes("\\")) {
    try { return existsSync(nama) && statSync(nama).isFile(); } catch { return false; }
  }
  for (const folder of String(process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    try { const jalur = join(folder, nama); if (existsSync(jalur) && statSync(jalur).isFile()) return true; } catch { /* folder aneh dilewati */ }
  }
  return false;
}

export type HasilProbeVersi = { versi: string | null; alasan: string; keluaran: string };

/** Satu baris pertama yang masuk akal dari keluaran mesin; sisanya diabaikan. */
function barisVersi(teks: string): string | null {
  for (const baris of String(teks ?? "").split(/\r?\n/)) {
    const bersih = baris.trim();
    if (!bersih) continue;
    if (bersih.length > MAKS_PANJANG_VERSI) return null;
    // Hanya bentuk versi/label wajar yang diterima; keluaran aneh tidak pernah dipakai sebagai versi.
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(bersih)) return null;
    return bersih;
  }
  return null;
}

/** Menjalankan `<biner> --version` dan membaca versinya. Tidak pernah menebak bila gagal. */
export function probeVersiBiner(biner: string, batasWaktuMs: number = BATAS_WAKTU_MS): Promise<HasilProbeVersi> {
  return new Promise<HasilProbeVersi>((resolve) => {
    let selesai = false;
    const selesaikan = (hasil: HasilProbeVersi) => { if (!selesai) { selesai = true; resolve(hasil); } };
    let anak: ReturnType<typeof spawn>;
    try {
      anak = spawn(biner, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const pesan = error instanceof Error ? error.message : String(error);
      selesaikan({ versi: null, alasan: `biner tidak bisa dijalankan: ${pesan.slice(0, 120)}`, keluaran: "" });
      return;
    }
    let keluaranStdout = "";
    let keluaranStderr = "";
    const pengaturWaktu = setTimeout(() => {
      try { anak.kill("SIGKILL"); } catch { /* proses mungkin sudah mati */ }
      selesaikan({ versi: null, alasan: `biner tidak menjawab dalam ${batasWaktuMs} ms`, keluaran: (keluaranStdout + keluaranStderr).slice(0, 200) });
    }, batasWaktuMs);
    anak.stdout?.on("data", (potongan) => { keluaranStdout += String(potongan); });
    anak.stderr?.on("data", (potongan) => { keluaranStderr += String(potongan); });
    anak.on("error", (error) => {
      clearTimeout(pengaturWaktu);
      selesaikan({ versi: null, alasan: `biner tidak bisa dijalankan: ${error.message.slice(0, 120)}`, keluaran: "" });
    });
    anak.on("close", (kode) => {
      clearTimeout(pengaturWaktu);
      // CLI Prime Agent menulis nomor versi ke stderr; karena itu kedua saluran dibaca.
      const versi = barisVersi(keluaranStdout) ?? barisVersi(keluaranStderr);
      const keluaran = `${keluaranStdout}${keluaranStderr}`.trim().slice(0, 200);
      if (versi) selesaikan({ versi, alasan: kode === 0 ? "biner melaporkan versi" : `biner keluar dengan kode ${kode} tetapi melaporkan versi`, keluaran });
      else selesaikan({ versi: null, alasan: kode === 0 ? "biner tidak mencetak versi yang bisa dibaca" : `biner keluar dengan kode ${kode} tanpa melaporkan versi`, keluaran });
    });
  });
}

export type LaporanVersiMesin = {
  engineVersion: string;
  platformVersion: string;
  startedAt: string;
  schemaVersion: number;
  engineKind: JenisMesin;
  engineAvailable: boolean;
  engineVersionSource: string;
  engineBinary: { path: string | null; present: boolean; version: string; detail: string };
  healthError: string | null;
  checkedAt: string;
  tahap2: { tersedia: boolean; catatan: string };
  catatan: string;
};

/**
 * Kapan proses web ini mulai. Nilai dari `platform_settings` dipakai bila benar-benar ada.
 *
 * Bila pengaturan itu belum pernah ditulis, waktunya dihitung sekali dari `process.uptime()` lalu
 * DISIMPAN di modul ini. Tanpa simpanan itu, dua panggilan berurutan bisa berbeda beberapa
 * milidetik sehingga "waktu mulai" tidak lagi bisa dipercaya sebagai satu titik waktu.
 */
let mulaiPeladenTersimpanMs: number | null = null;

export function waktuMulaiPeladen(now: Date = new Date()): string {
  const tersimpan = platformSetting("server_started_at");
  if (tersimpan && !Number.isNaN(Date.parse(tersimpan))) return new Date(tersimpan).toISOString();
  if (mulaiPeladenTersimpanMs === null) mulaiPeladenTersimpanMs = now.getTime() - Math.round(process.uptime() * 1000);
  return new Date(mulaiPeladenTersimpanMs).toISOString();
}

/** Sumber kesehatan mesin bisa diganti uji; bawaan = adapter nyata dari `engine.ts`. */
export type SumberKesehatan = { health(): Promise<{ available: boolean; version?: string }> };

/**
 * Laporan versi mesin. Selalu membaca ulang pada setiap panggilan (tidak ada angka yang dihafal),
 * supaya laporan mengikuti keadaan yang sedang berlaku.
 */
export async function laporanVersiMesin(now: Date = new Date(), sumber: SumberKesehatan = engine as SumberKesehatan): Promise<LaporanVersiMesin> {
  const jenis = jenisMesin();
  // `PRIME_AGENT_BIN=` (kosong) sama artinya dengan tidak dikonfigurasi; nilainya disebut sebagai null
  // supaya laporan tidak menampilkan jalur kosong yang bisa disalahartikan sebagai biner nyata.
  const binerMentah = typeof config.PRIME_AGENT_BIN === "string" ? config.PRIME_AGENT_BIN.trim() : "";
  const biner: string | null = binerMentah.length > 0 ? binerMentah : null;
  const binerInfo = { path: biner, present: biner ? binerAda(biner) : false, version: VERSI_TIDAK_DILAPORKAN, detail: biner ? "" : "Tidak ada PRIME_AGENT_BIN yang dikonfigurasi (atau isinya kosong)." };
  let kesehatan: { available: boolean; version?: string } = { available: false };
  let galatKesehatan: string | null = null;
  try { kesehatan = await sumber.health(); }
  catch (error) { galatKesehatan = (error instanceof Error ? error.message : String(error)).slice(0, 200); }

  let versi: string | null = null;
  let sumberVersi: string;
  if (jenis === "prime-rpc" && biner) {
    const hasil = await probeVersiBiner(biner);
    versi = hasil.versi;
    binerInfo.version = hasil.versi ?? VERSI_TIDAK_DILAPORKAN;
    binerInfo.detail = hasil.alasan;
    sumberVersi = hasil.versi ? "biner --version" : `tidak dilaporkan (${hasil.alasan})`;
  } else if (jenis === "mock") {
    const dilaporkan = typeof kesehatan.version === "string" ? kesehatan.version.trim() : "";
    versi = dilaporkan || null;
    sumberVersi = dilaporkan ? "engine.health() (mesin tiruan)" : "tidak dilaporkan (mesin tiruan tidak mengisi versi)";
  } else {
    const dilaporkan = typeof kesehatan.version === "string" ? kesehatan.version.trim() : "";
    versi = dilaporkan || null;
    sumberVersi = dilaporkan ? "engine.health()" : "tidak dilaporkan (mesin belum dikonfigurasi)";
  }

  const platformVersion = process.env.APP_VERSION ?? process.env.npm_package_version ?? "dev";
  return {
    engineVersion: versi ?? VERSI_TIDAK_DILAPORKAN,
    platformVersion,
    startedAt: waktuMulaiPeladen(now),
    schemaVersion: SCHEMA_VERSION,
    engineKind: jenis,
    engineAvailable: Boolean(kesehatan.available),
    engineVersionSource: sumberVersi,
    engineBinary: binerInfo,
    healthError: galatKesehatan,
    checkedAt: now.toISOString(),
    tahap2: {
      tersedia: false,
      catatan: "Perbarui/rollback mesin (tahap 2) BELUM dibuat: menunggu keputusan Bapak (K5). Rute versi ini hanya membaca dan tidak pernah menyentuh berkas mesin.",
    },
    catatan: [
      `platformVersion bersumber dari APP_VERSION proses web (sekarang: ${platformVersion}); schemaVersion dari SCHEMA_VERSION di db.ts.`,
      `startedAt dibaca dari platform_settings.server_started_at; bila baris itu belum ada, dipakai process.uptime() (${Math.round(process.uptime())} detik).`,
      `Jenis mesin: ${jenis}. Biner: ${binerInfo.path ?? "(tidak ada)"} (ada di disk: ${binerInfo.present}).`,
      versi ? `Versi mesin dari: ${sumberVersi}.` : `Mesin tidak melaporkan versi: ${sumberVersi}.`,
    ].join(" "),
  };
}

/** Mendaftarkan rute versi mesin (butir 78 tahap 1). Dipanggil lead dari `wave11c/index.ts`. */
export function registerEngineVersionRoutes(app: any): void {
  app.get("/api/v1/admin/engine/version", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    // Datar sesuai brief: { engineVersion, platformVersion, startedAt } + medan penjelas.
    return laporanVersiMesin();
  });
}

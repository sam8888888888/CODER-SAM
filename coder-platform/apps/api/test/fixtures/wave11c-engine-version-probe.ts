/**
 * Alat bantu uji (BUKAN uji tersendiri) — Wave 11C butir 78.
 *
 * Satu proses terpisah yang MEMUAT modul nyata `wave11c/engine-version.ts` dengan pengaturan mesin
 * yang diberikan lewat `PROBE_JSON`, lalu mencetak satu baris JSON berisi hasil `laporanVersiMesin()`.
 * Dipakai suite `wave11c-mesin.e2e.ts` untuk membuktikan perilaku "versi tidak dilaporkan" pada
 * proses yang benar-benar memilih mesin RPC (MOCK_ENGINE=false) — bukan pada mesin tiruan.
 *
 * Semua impor di bawah dibuat DINAMIS: `config.ts` membaca variabel lingkungan sekali saat modulnya
 * dimuat, jadi pengaturan harus ditulis lebih dulu.
 */
const opsi = JSON.parse(String(process.env.PROBE_JSON ?? "{}")) as { bin?: string; dataDir?: string; timeoutMs?: number };

process.env.NODE_ENV = "test";
process.env.DATA_DIR = opsi.dataDir ?? `/tmp/w11c-mesin-probe-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
process.env.MOCK_ENGINE = "false";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_REAP_ON_BOOT = "false";
process.env.JOB_WORKER_IN_WEB = "false";
if (opsi.bin === undefined) delete process.env.PRIME_AGENT_BIN;
else process.env.PRIME_AGENT_BIN = opsi.bin;
if (opsi.timeoutMs === undefined) delete process.env.ENGINE_VERSION_TIMEOUT_MS;
else process.env.ENGINE_VERSION_TIMEOUT_MS = String(opsi.timeoutMs);

const mulai = Date.now();
const { laporanVersiMesin, jenisMesin } = await import("../../src/wave11c/engine-version.js");
const laporan = await laporanVersiMesin();
console.log(JSON.stringify({
  jenisMesin: jenisMesin(),
  engineVersion: laporan.engineVersion,
  engineKind: laporan.engineKind,
  engineVersionSource: laporan.engineVersionSource,
  engineBinary: laporan.engineBinary,
  engineAvailable: laporan.engineAvailable,
  healthError: laporan.healthError,
  platformVersion: laporan.platformVersion,
  startedAt: laporan.startedAt,
  schemaVersion: laporan.schemaVersion,
  tahap2Tersedia: laporan.tahap2.tersedia,
  ms: Date.now() - mulai,
}));

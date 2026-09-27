/**
 * Wave 11A (butir 57) — penjaga nama model tidak boleh "lupa" saat katalog mesin menjawab tidak lengkap.
 *
 * Kenapa suite ini ada (ditemukan 26 Sep 2026, saat memperbaiki butir 57): rute run menolak nama model
 * yang tidak ada di katalog `prime-agent model list` dengan `400 UNKNOWN_MODEL`. Katalog itu diambil
 * dengan menjalankan CLI mesin, dan CLI bertanya ke penyedia — jadi satu jawaban bisa tidak lengkap
 * (penyedia lambat, keluaran terpotong). Dulu jawaban pendek menimpa daftar lama, sehingga model yang
 * SAH ditolak. Kejadian nyata: satu jalan `<...>/wave11a.e2e.ts` (log `/workspace/outputs/w11a_57_run.log`,
 * cek 12h dan 12n) gagal `UNKNOWN_MODEL` saat peramban uji berjalan bersamaan, lalu hijau di jalan
 * berikutnya tanpa perubahan kode. Kegagalan yang bergantung beban mesin bukan bukti yang sah.
 *
 * Suite ini memakai mesin tiruan katalog (fixtures/fake-prime-agent-katalog.mjs) yang jawabannya
 * ditentukan berkas penanda: panjang (ada `glm-4.7-flash`) -> pendek (hanya `deepseek-v4-flash`).
 * Dengan begitu premis "jawaban katalog jadi pendek" dibuktikan, bukan diasumsikan.
 *
 * Pakai: npx tsx apps/api/test/wave11a-katalog.e2e.ts
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = 7392;
const dataDir = `/tmp/coder-katalog-${Date.now()}`;
const penanda = join(dataDir, "penanda-pendek.txt");
const penandaTambahan = join(dataDir, "penanda-tambahan.txt");

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_BIN = process.env.PRIME_AGENT_BIN ?? join(here, "fixtures/fake-prime-agent-katalog.mjs");
process.env.KATALOG_FIXTURE_MARKER = penanda;
process.env.KATALOG_FIXTURE_TAMBAHAN = penandaTambahan;
process.env.PRIME_AGENT_MODEL = "deepseek-v4-flash";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "80";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "80";
process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 300));

const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures += 1;
}
function potong(bahan: unknown, max = 220): string {
  const teks = typeof bahan === "string" ? bahan : (() => { try { return JSON.stringify(bahan); } catch { return String(bahan); } })();
  return (teks ?? "").slice(0, max);
}
function klien() {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
      const teks = await response.text(); let json: any = null;
      try { json = teks ? JSON.parse(teks) : null; } catch { json = teks; }
      return { status: response.status, json };
    },
  };
}

/** Membaca katalog langsung dari CLI tiruan (tanpa lewat rute), memakai tata cara penguraian yang sama. */
function bacaKatalogCLI(): string[] {
  const bin = String(process.env.PRIME_AGENT_BIN);
  const res = spawnSync(bin, ["model", "list"], { encoding: "utf8", timeout: 20_000 });
  const raw = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const lines = raw.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const header = lines.findIndex((line) => /^provider\s+model\b/.test(line));
  const body = (header >= 0 ? lines.slice(header + 1) : lines).filter((line) => !/^provider\s+model\b/.test(line));
  return body.map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(/\s{2,}/)[1] ?? "").filter(Boolean);
}

const c = klien();
const email = `katalog-${randomUUID().slice(0, 8)}@example.com`;
const daftar = await c.call("POST", "/api/v1/auth/register", { email, password: "Katalog123!", displayName: "Uji Katalog" });
const workspaceId = String(daftar.json?.workspace?.id ?? "");
const proyek = await c.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Katalog", slug: `k-${Date.now()}` });
const projectId = String(proyek.json?.id ?? "");
check("0. pengguna + proyek siap", Boolean(workspaceId) && Boolean(projectId), `${daftar.status}/${proyek.status} ${potong(proyek.json)}`);

const namaKatalog = async (segar = false) => {
  const balasan = await c.call("GET", `/api/v1/models${segar ? "?refresh=1" : ""}`);
  return { status: balasan.status, daftar: (balasan.json?.models ?? []).map((row: any) => row.model) as string[], json: balasan.json };
};
const kirimRun = (model: string) => c.call("POST", `/api/v1/projects/${projectId}/runs`, { prompt: `Uji katalog untuk ${model}.`, model });
async function tungguRun(runId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const balasan = await c.call("GET", `/api/v1/runs/${runId}`);
    const status = String(balasan.json?.status ?? "");
    if (status === "completed" || status === "failed") return balasan.json;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

console.log("\n--- Bagian 1: katalog panjang -> pendek ---");
const katalogPanjang = await namaKatalog();
check("1a. premis: katalog awal memuat deepseek-v4-flash DAN glm-4.7-flash",
  katalogPanjang.daftar.includes("deepseek-v4-flash") && katalogPanjang.daftar.includes("glm-4.7-flash"),
  `status=${katalogPanjang.status} daftar=[${katalogPanjang.daftar.join(", ")}]`);

const runAwalan = await kirimRun("zai/glm-4.7-flash");
check("1b. model dengan awalan penyedia diterima (katalog menulisnya sebagai glm-4.7-flash)",
  runAwalan.status === 202, `${runAwalan.status} ${potong(runAwalan.json)}`);
const runAwalanRow = await tungguRun(String(runAwalan.json?.id ?? ""));
check("1c. run itu benar-benar selesai (mesin tiruan)", String(runAwalanRow?.status ?? "") === "completed", potong(runAwalanRow));

const runSalahTulis = await kirimRun("mustahil/glm-9.9-tidak-ada");
check("1d. nama model yang benar-benar tidak dikenal tetap ditolak 400 UNKNOWN_MODEL",
  runSalahTulis.status === 400 && runSalahTulis.json?.error === "UNKNOWN_MODEL", `${runSalahTulis.status} ${potong(runSalahTulis.json)}`);

// Premis untuk cek berikutnya: jawaban CLI benar-benar memendek. Diukur di SUMBERNYA (CLI tiruan
// langsung), sebab jawaban rute sejak perbaikan 27 Sep 2026 sengaja TIDAK lagi menyusut (lihat 1e2).
writeFileSync(penanda, "pendek\n");
const cliPendek = bacaKatalogCLI();
check("1e. premis: sesudah penanda dibuat, jawaban CLI TIDAK lagi memuat glm-4.7-flash",
  !cliPendek.includes("glm-4.7-flash") && cliPendek.includes("deepseek-v4-flash"),
  `cli=[${cliPendek.join(", ")}]`);
const katalogPendek = await namaKatalog(true);
check("1e2. jawaban rute TIDAK menyusut walau CLI memendek (hanya menambah) dan alasannya ditulis apa adanya",
  katalogPendek.daftar.includes("glm-4.7-flash") && typeof katalogPendek.json?.note === "string" && /digabung/i.test(katalogPendek.json.note),
  `status=${katalogPendek.status} daftar=[${katalogPendek.daftar.join(", ")}] note=${potong(katalogPendek.json?.note ?? "")}`);

const runLama = await kirimRun("glm-4.7-flash");
check("1f. model yang pernah dikenal TIDAK ditolak oleh jawaban katalog yang lebih pendek",
  runLama.status === 202, `${runLama.status} ${potong(runLama.json)}`);
const runLamaRow = await tungguRun(String(runLama.json?.id ?? ""));
check("1g. run model lama itu juga selesai", String(runLamaRow?.status ?? "") === "completed", potong(runLamaRow));

const runSalahTulis2 = await kirimRun("mustahil/glm-9.9-tidak-ada");
check("1h. penjaga tetap menolak nama tak dikenal sesudah katalog memendek",
  runSalahTulis2.status === 400 && runSalahTulis2.json?.error === "UNKNOWN_MODEL", `${runSalahTulis2.status} ${potong(runSalahTulis2.json)}`);
check("1i. berkas penanda memang ada (bukti premis 1e nyata, bukan kebetulan)",
  existsSync(penanda), penanda);

console.log("\n--- Bagian 2: katalog terpotong saat PROSES BARU (kejadian gerbang 27 Sep 2026) ---");
// Kejadian nyata 27 Sep 2026: rute `/api/v1/models` melaporkan 252 model padahal katalog penuh memuat
// 354 model, sehingga model yang SAH dan BELUM PERNAH terlihat ditolak `400 UNKNOWN_MODEL`.
// Bagian ini meniru persis itu: satu model yang hanya ada di daftar panjang belum pernah dibaca,
// lalu permintaan run datang saat jawaban katalog masih pendek.
const namaBaru = "glm-5.0-flash-uji";
writeFileSync(penanda, "pendek\n");
const katalogSaatPendek = await namaKatalog(true);
const cliSaatPendek = bacaKatalogCLI();
check("2a. premis: nama model baru belum pernah terbaca (rute maupun CLI) saat jawaban CLI memendek",
  !katalogSaatPendek.daftar.includes(namaBaru) && !cliSaatPendek.includes(namaBaru)
    && cliSaatPendek.includes("deepseek-v4-flash") && !cliSaatPendek.includes("glm-4.7-flash"),
  `rute=[${katalogSaatPendek.daftar.join(", ")}] cli=[${cliSaatPendek.join(", ")}]`);

// Jawaban katalog pulih TEPAT sebelum permintaan run: penyedia kembali sehat (penanda pendek dihapus)
// dan model baru muncul di daftar. Inilah saat penjaga nama model harus membaca ulang, bukan menolak.
rmSync(penanda, { force: true });
writeFileSync(penandaTambahan, "tambahan\n");
const cliSehat = bacaKatalogCLI();
check("2a2. premis: jawaban CLI sudah pulih dan memuat model baru", cliSehat.includes(namaBaru), `cli=[${cliSehat.join(", ")}]`);
const runBaru = await kirimRun(namaBaru);
check("2b. model yang belum pernah terlihat DITERIMA karena katalog dibaca ulang sebelum menolak",
  runBaru.status === 202, `${runBaru.status} ${potong(runBaru.json)}`);
const runBaruRow = await tungguRun(String(runBaru.json?.id ?? ""));
check("2c. run model baru itu selesai (bukan sekadar diterima)", String(runBaruRow?.status ?? "") === "completed", potong(runBaruRow));
const katalogSesudah = await namaKatalog(true);
check("2d. nama model yang baru dikenal ikut masuk ingatan penjaga (katalog menyebutnya)",
  katalogSesudah.daftar.includes(namaBaru), `daftar=[${katalogSesudah.daftar.join(", ")}]`);

// Hanya MENAMBAH, tidak mengurangi: jawaban boleh memendek dari CLI, tetapi nama yang sudah dikenal
// tidak boleh hilang dari jawaban rute.
writeFileSync(penanda, "pendek\n");
const katalogPendek2 = await namaKatalog(true);
check("2e. jawaban rute tidak menyusut walau CLI menjawab pendek lagi (gabungan hanya menambah)",
  katalogPendek2.daftar.includes(namaBaru) && katalogPendek2.daftar.includes("glm-4.7-flash"),
  `daftar=[${katalogPendek2.daftar.join(", ")}]`);
check("2f. catatan penggabungan dijelaskan apa adanya di jawaban rute",
  typeof katalogPendek2.json?.note === "string" && /digabung/i.test(katalogPendek2.json.note), potong(katalogPendek2.json?.note ?? ""));

// Pembacaan ulang hanya sekali per menit: nama yang benar-benar tidak ada TETAP ditolak.
const runSalah3 = await kirimRun("mustahil/glm-9.9-tidak-ada");
check("2g. penjaga TIDAK berubah jadi 'terima semua': nama tak dikenal tetap 400 UNKNOWN_MODEL",
  runSalah3.status === 400 && runSalah3.json?.error === "UNKNOWN_MODEL", `${runSalah3.status} ${potong(runSalah3.json)}`);
check("2h. berkas penanda masih ada (premis 2e nyata)", existsSync(penanda), penanda);

console.log(`\nRINGKASAN: ${failures === 0 ? "lulus semua" : `${failures} gagal`}`);
if (failures) { console.log("WAVE11A_KATALOG_FAILED"); process.exit(1); }
console.log("WAVE11A_KATALOG_PASSED");
process.exit(0);

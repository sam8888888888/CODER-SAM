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
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = 7392;
const dataDir = `/tmp/coder-katalog-${Date.now()}`;
const penanda = join(dataDir, "penanda-pendek.txt");

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_BIN = process.env.PRIME_AGENT_BIN ?? join(here, "fixtures/fake-prime-agent-katalog.mjs");
process.env.KATALOG_FIXTURE_MARKER = penanda;
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

// Premis untuk cek berikutnya: jawaban CLI benar-benar memendek. Tanpa ini, 1f tidak membuktikan apa pun.
writeFileSync(penanda, "pendek\n");
const katalogPendek = await namaKatalog(true);
check("1e. premis: sesudah penanda dibuat, katalog segar TIDAK lagi memuat glm-4.7-flash",
  !katalogPendek.daftar.includes("glm-4.7-flash") && katalogPendek.daftar.includes("deepseek-v4-flash"),
  `status=${katalogPendek.status} daftar=[${katalogPendek.daftar.join(", ")}]`);

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

console.log(`\nRINGKASAN: ${failures === 0 ? "lulus semua" : `${failures} gagal`}`);
if (failures) { console.log("WAVE11A_KATALOG_FAILED"); process.exit(1); }
console.log("WAVE11A_KATALOG_PASSED");
process.exit(0);

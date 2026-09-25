/**
 * Uji Wave 11B (v0.22.0) — butir 62 (replay timeline), 64 (ekspor/impor agen), 65 (metrik jujur).
 *
 * Tiga bagian, semuanya memeriksa perilaku nyata (kode status, isi badan, dan baris basis data):
 *   §5 (62) urutan timeline sesuai created_at run_events; run tanpa alat tetap rapi; run ruang kerja
 *          lain menjawab 404 tanpa membocorkan isinya; run 500 peristiwa tetap di bawah 2 detik.
 *   §7 (64) berkas rusak ditolak; nama bentrok dilewati dan persona lama tidak berubah; audit
 *          `personas_import` tercatat; batas 50 ditegakkan.
 *   §8 (65) angka pemakaian dihitung ULANG di uji ini lalu dibandingkan; isolasi antar-pengguna;
 *          baris tanpa harga jual muncul sebagai biaya tidak tertagih + selisih rekonsiliasi; rentang
 *          waktu dihormati.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11b-riwayat.e2e.ts
 *
 * Catatan jujur: berkas ini hanya menambah berkas uji baru + tiga modul butir milik Dinda
 * (wave11b/timeline.ts, wave11b/persona-transfer.ts, wave11b/account-usage.ts). Tidak ada berkas
 * milik pemilik butir lain yang disentuh.
 */
import { createServer as createTcpServer } from "node:net";

/**
 * Mencari port bebas. Server uji lain yang masih memegang port yang sama pernah menyerap permintaan
 * dan membuat gagal palsu, jadi port diperiksa lebih dulu dan kegagalan dilaporkan jelas.
 */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 20 }, () => 7293 + Math.floor(Math.random() * 3))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang 7293-7295: ada server uji yang belum keluar?");
}

const port = await cariPortBebas(7293, 7294, 7295);
const dataDir = `/tmp/coder-wave11b-riwayat-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11b-admin-${stamp}@example.test`;
const ownerEmail = `w11b-owner-${stamp}@example.test`;
const otherEmail = `w11b-other-${stamp}@example.test`;
const importEmail = `w11b-impor-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.CSRF_STRICT = "true";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "80";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "80";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { config } = await import("../src/config.js");

const base = `http://127.0.0.1:${port}`;
let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 220) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const angka = (value: unknown) => Number(value ?? 0);

/** Klien HTTP kecil: jar cookie sendiri + token CSRF ganda (mode CSRF_STRICT). */
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
    const text = await response.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server belum siap */ } }
  return { call, bootstrap: prime };
}

const owner = client(); const other = client(); const importUser = client(); const anon = client();

for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const ready = await fetch(`${base}/health`); if (ready.ok) break; } catch { /* belum siap */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), data di ${dataDir}`);

/* ------------------------------------------------------------------ bantu */

async function register(account: ReturnType<typeof client>, email: string, name: string) {
  await account.bootstrap();
  return account.call("POST", "/api/v1/auth/register", { email, password, displayName: name });
}
const tidur = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Menunggu run berakhir (jalur API menjalankan mesin secara asinkron). */
async function tungguRun(runId: string, batasMs = 30_000) {
  const tenggat = Date.now() + batasMs;
  while (Date.now() < tenggat) {
    const row = db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status?: string } | undefined;
    if (row && ["completed", "failed", "cancelled"].includes(String(row.status))) return String(row.status);
    await tidur(100);
  }
  return null;
}

/** Menyisipkan baris `runs` langsung supaya urutan peristiwa timeline bisa dikendalikan penuh. */
function barisRun(id: string, projectId: string, status: string, o: { createdAt: string; finishedAt?: string | null; prompt?: string; result?: string | null; errorCode?: string | null }) {
  db.prepare("INSERT INTO runs (id,project_id,status,prompt,result,error_code,started_at,finished_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, projectId, status, o.prompt ?? "Permintaan uji timeline", o.result ?? null, o.errorCode ?? null, o.createdAt, o.finishedAt ?? null, o.createdAt);
  return id;
}
function tambahEvent(runId: string, type: string, data: unknown, createdAt: string) {
  db.prepare("INSERT INTO run_events (run_id,type,data_json,created_at) VALUES (?,?,?,?)").run(runId, type, JSON.stringify(data), createdAt);
}
/** Menghitung ulang angka pemakaian dari basis data (bukan dengan memanggil modul yang diuji). */
const CAKUPAN_UJI = `ru.project_id IN (SELECT p.id FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?)`;
function hitungUlang(userId: string, sejak: string) {
  return db.prepare(`SELECT
      COALESCE(SUM(ru.input_tokens),0) AS tokenInput,
      COALESCE(SUM(ru.output_tokens),0) AS tokenOutput,
      COALESCE(SUM(COALESCE(ru.total_tokens, COALESCE(ru.input_tokens,0)+COALESCE(ru.output_tokens,0))),0) AS tokenTotal,
      COALESCE(SUM(CASE WHEN ru.sell_cost_micros IS NOT NULL THEN ru.sell_cost_micros ELSE 0 END),0) AS terbilling,
      COALESCE(SUM(CASE WHEN ru.sell_cost_micros IS NULL THEN COALESCE(ru.cost_micros,0) ELSE 0 END),0) AS tidakTertagih,
      COALESCE(SUM(CASE WHEN ru.sell_cost_micros IS NOT NULL AND ru.cost_micros IS NOT NULL THEN ru.cost_micros - ru.sell_cost_micros ELSE 0 END),0) AS selisih,
      COUNT(DISTINCT CASE WHEN ru.sell_cost_micros IS NOT NULL AND ru.cost_micros IS NOT NULL THEN ru.run_id END) AS jumlahRunRekonsiliasi,
      COUNT(*) AS baris
    FROM run_usage ru WHERE ${CAKUPAN_UJI} AND ru.created_at >= ?`).get(userId, sejak) as any;
}
/** Menyisipkan baris run_usage langsung supaya angka uji pasti dan bisa dihitung ulang. */
function barisUsage(id: string, runId: string, projectId: string, o: { model?: string | null; tokenInput?: number; tokenOutput?: number; totalTokens?: number | null; costMicros?: number | null; sellCostMicros?: number | null; createdAt: string }) {
  db.prepare(`INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,sell_cost_micros,estimated,raw_json,created_at)
    VALUES (?,?,?,?,?,?,?,0,0,?,?,?,0,NULL,?)`).run(
    id, runId, projectId, o.model ?? "model-uji", "uji",
    o.tokenInput ?? 0, o.tokenOutput ?? 0, o.totalTokens === undefined ? null : o.totalTokens,
    o.costMicros === undefined ? null : o.costMicros, o.sellCostMicros === undefined ? null : o.sellCostMicros,
    o.createdAt,
  );
}

/* =====================================================================================
 * Bagian 0: akun, proyek, dan satu run nyata.
 * ===================================================================================== */
console.log("\n--- Bagian 0: akun dan proyek ---");
const ownerReg = await register(owner, ownerEmail, "Pemilik Wave 11B");
const ownerId = String(ownerReg.json?.user?.id ?? "");
const ownerWorkspaceId = String(ownerReg.json?.workspace?.id ?? "");
check("0a. akun pemilik terdaftar dengan ruang kerja", ownerReg.status === 201 && Boolean(ownerId && ownerWorkspaceId), `${ownerReg.status} ${short(ownerReg.json)}`);

const otherReg = await register(other, otherEmail, "Pengguna Lain Wave 11B");
const otherId = String(otherReg.json?.user?.id ?? "");
const otherWorkspaceId = String(otherReg.json?.workspace?.id ?? "");
check("0b. akun pembanding terdaftar di ruang kerja terpisah", otherReg.status === 201 && Boolean(otherId && otherWorkspaceId && otherWorkspaceId !== ownerWorkspaceId), `${otherReg.status}`);

const importReg = await register(importUser, importEmail, "Pengguna Impor Wave 11B");
const importUserId = String(importReg.json?.user?.id ?? "");
check("0c. akun ketiga terdaftar (untuk uji batas impor + akun tanpa pemakaian)", importReg.status === 201 && Boolean(importUserId), `${importReg.status}`);

const proyekOwner = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`, { name: "Proyek Timeline 11B" });
const projectId = String(proyekOwner.json?.id ?? "");
check("0d. proyek pemilik dibuat", proyekOwner.status === 201 && Boolean(projectId), `${proyekOwner.status} ${short(proyekOwner.json)}`);

const proyekOther = await other.call("POST", `/api/v1/workspaces/${otherWorkspaceId}/projects`, { name: "Proyek Tetangga 11B" });
const otherProjectId = String(proyekOther.json?.id ?? "");
check("0e. proyek pembanding dibuat", proyekOther.status === 201 && Boolean(otherProjectId), `${proyekOther.status}`);

const runNyataReply = await owner.call("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "Ringkas berkas rencana proyek." });
const runNyataId = String(runNyataReply.json?.id ?? "");
const statusRunNyata = runNyataId ? await tungguRun(runNyataId) : null;
check("0f. run nyata lewat API selesai (mesin tiruan)", runNyataReply.status === 202 && statusRunNyata === "completed", `${runNyataReply.status} status=${statusRunNyata}`);
check("0g. run nyata menulis baris run_usage (dipakai bagian §8)", count("SELECT COUNT(*) AS n FROM run_usage WHERE run_id=?", runNyataId) >= 1, short(count("SELECT COUNT(*) AS n FROM run_usage WHERE run_id=?", runNyataId)));

const runTetanggaReply = await other.call("POST", `/api/v1/projects/${otherProjectId}/runs`, { prompt: "RAHASIA-TETANGGA: ringkas berkas internal." });
const runTetanggaId = String(runTetanggaReply.json?.id ?? "");
const statusRunTetangga = runTetanggaId ? await tungguRun(runTetanggaId) : null;
check("0h. run pembanding selesai dan tercatat di run_usage", statusRunTetangga === "completed" && count("SELECT COUNT(*) AS n FROM run_usage WHERE run_id=?", runTetanggaId) >= 1, `status=${statusRunTetangga}`);

/* =====================================================================================
 * Bagian 5 (§5, butir 62): replay timeline.
 * ===================================================================================== */
console.log("\n--- Bagian 5 (§5/62): timeline run ---");
const t0 = Date.now();
const at = (offset: number) => new Date(t0 + offset).toISOString();

// Run dengan peristiwa terkendali penuh: sudah dibuat, ada konteks, dua alat, satu perpindahan model,
// dua potongan teks jawaban, lalu penutup dari mesin.
const runAlat = barisRun(`run-alat-${stamp}`, projectId, "completed", { createdAt: at(0), finishedAt: at(60_000), prompt: "Uji timeline dengan alat", result: "Selesai mengerjakan permintaan." });
tambahEvent(runAlat, "knowledge", { hits: [{ id: "kb-1", title: "Panduan Deploy" }, { id: "kb-2", title: "Aturan Biaya" }] }, at(1_000));
tambahEvent(runAlat, "tool", { name: "read_file", summary: "Membaca README.md", status: "selesai" }, at(2_000));
tambahEvent(runAlat, "text", "potongan jawaban pertama", at(3_000));
tambahEvent(runAlat, "tool", { name: "write_file", summary: "Menulis 12 baris ke src/app.ts", status: "selesai" }, at(4_000));
tambahEvent(runAlat, "text", "potongan jawaban kedua", at(5_000));
tambahEvent(runAlat, "model_fallback", { dari: "model-a", ke: "model-b", alasan: "429 rate limit exceeded" }, at(6_000));
tambahEvent(runAlat, "completed", { result: "Selesai mengerjakan permintaan." }, at(7_000));

const timelineAlat = await owner.call("GET", `/api/v1/runs/${runAlat}/timeline`);
check("5a. timeline run milik pemilik menjawab 200 dengan bentuk kontrak", timelineAlat.status === 200
  && timelineAlat.json?.runId === runAlat && timelineAlat.json?.status === "completed"
  && Number(timelineAlat.json?.total) === (timelineAlat.json?.langkah ?? []).length
  && Array.isArray(timelineAlat.json?.langkah) && typeof timelineAlat.json?.catatan === "string",
  `${timelineAlat.status} ${short(timelineAlat.json, 320)}`);

const langkah: any[] = timelineAlat.json?.langkah ?? [];
check("5b. setiap langkah punya enam kolom kontrak dan seq naik 1..n", langkah.length > 0
  && langkah.every((row, index) => row?.seq === index + 1 && ["seq", "at", "kind", "name", "summary", "status"].every((key) => key in row)),
  short(langkah.map((row) => row?.seq)));

// Urutan `at` wajib sama dengan urutan created_at baris nyata: baris runs lebih dulu, lalu run_events
// (tanpa peristiwa teks) menurut created_at ASC, id ASC.
const barisNyata = db.prepare("SELECT type, created_at AS createdAt FROM run_events WHERE run_id=? AND type<>'text' ORDER BY created_at ASC, id ASC").all(runAlat) as { type: string; createdAt: string }[];
const harapanAt = [String((db.prepare("SELECT created_at AS createdAt FROM runs WHERE id=?").get(runAlat) as any).createdAt), ...barisNyata.map((row) => row.createdAt)];
check("5c. urutan `at` timeline sama dengan urutan created_at baris nyata", JSON.stringify(langkah.map((row) => row.at)) === JSON.stringify(harapanAt),
  short({ dapat: langkah.map((row) => row.at), harap: harapanAt }, 360));
check("5d. waktu pada timeline tidak menurun", langkah.every((row, index) => index === 0 || String(row.at) >= String(langkah[index - 1].at)), short(langkah.map((row) => row.at)));
check("5e. langkah pertama dari baris runs: kind run, name 'run dibuat'", langkah[0]?.kind === "run" && langkah[0]?.name === "run dibuat" && langkah[0]?.status === "dibuat", short(langkah[0]));
check("5f. peristiwa konteks muncul sebagai langkah 'konteks' dengan hitungan potongan", langkah[1]?.kind === "konteks" && String(langkah[1]?.summary).includes("2 potongan konteks"), short(langkah[1]));
check("5g. peristiwa alat dipetakan apa adanya (read_file + write_file)", langkah[2]?.kind === "alat" && langkah[2]?.name === "read_file" && langkah[2]?.summary === "Membaca README.md" && langkah[2]?.status === "selesai"
  && langkah[3]?.name === "write_file" && langkah[3]?.kind === "alat", short([langkah[2], langkah[3]]));
check("5h. perpindahan model muncul dengan model tujuan dan alasan", langkah[4]?.kind === "model" && String(langkah[4]?.name).includes("model-b") && String(langkah[4]?.summary).includes("429"), short(langkah[4]));
check("5i. penutup dari peristiwa mesin: kind selesai + status selesai", langkah[5]?.kind === "selesai" && langkah[5]?.status === "selesai" && String(langkah[5]?.summary).includes("karakter"), short(langkah[5]));
check("5j. potongan teks jawaban TIDAK menjadi langkah tersendiri", langkah.every((row) => row.kind !== "teks") && String(timelineAlat.json?.catatan).includes("2 baris peristiwa teks jawaban"), short(timelineAlat.json?.catatan));
check("5k. jumlah langkah tepat 6 (tidak ada langkah karangan)", langkah.length === 6, short(langkah.length));

// Run tanpa peristiwa alat sama sekali: daftar minimal dari baris `runs` saja.
const runKosong = barisRun(`run-kosong-${stamp}`, projectId, "completed", { createdAt: at(100), finishedAt: at(30_000), prompt: "Tanpa peristiwa alat", result: "Jawaban ringkas." });
const timelineKosong = await owner.call("GET", `/api/v1/runs/${runKosong}/timeline`);
const langkahKosong: any[] = timelineKosong.json?.langkah ?? [];
check("5l. run tanpa peristiwa alat tetap rapi: 2 langkah dari baris runs", timelineKosong.status === 200 && langkahKosong.length === 2
  && langkahKosong[0]?.kind === "run" && langkahKosong[1]?.kind === "selesai" && langkahKosong[1]?.at === at(30_000),
  `${timelineKosong.status} ${short(langkahKosong)}`);
check("5m. catatan run tanpa teks menyebut tidak ada peristiwa teks", String(timelineKosong.json?.catatan).includes("Tidak ada baris peristiwa teks jawaban"), short(timelineKosong.json?.catatan));

const runGagal = barisRun(`run-gagal-${stamp}`, projectId, "failed", { createdAt: at(200), finishedAt: at(20_000), prompt: "Uji gagal", errorCode: "ENGINE_UNAVAILABLE" });
const timelineGagal = await owner.call("GET", `/api/v1/runs/${runGagal}/timeline`);
const langkahGagal: any[] = timelineGagal.json?.langkah ?? [];
check("5n. run gagal tanpa peristiwa ditutup langkah gagal dari kolom error_code", timelineGagal.status === 200 && langkahGagal.length === 2
  && langkahGagal[1]?.kind === "gagal" && langkahGagal[1]?.status === "gagal" && String(langkahGagal[1]?.summary).includes("ENGINE_UNAVAILABLE"),
  short(langkahGagal));

// Run NYATA (jalur API): mesin tiruan mengirim beberapa peristiwa teks lalu satu peristiwa completed.
const timelineNyata = await owner.call("GET", `/api/v1/runs/${runNyataId}/timeline`);
const langkahNyata: any[] = timelineNyata.json?.langkah ?? [];
check("5o. run nyata: teks dilewati, tersisa 'run dibuat' + peristiwa selesai mesin", timelineNyata.status === 200 && langkahNyata.length === 2
  && langkahNyata[0]?.kind === "run" && langkahNyata[1]?.kind === "selesai" && langkahNyata[1]?.status === "selesai",
  `${timelineNyata.status} ${short(langkahNyata)}`);
check("5p. kind setiap langkah run nyata hanya dari pemetaan yang ada", langkahNyata.every((row) => ["run", "selesai", "gagal", "alat", "konteks", "model", "lain"].includes(row.kind)), short(langkahNyata.map((row) => row.kind)));

// Isolasi ruang kerja: run pembanding TIDAK boleh terbaca, dan isinya tidak boleh bocor.
const lintas = await owner.call("GET", `/api/v1/runs/${runTetanggaId}/timeline`);
check("5q. run milik ruang kerja lain menjawab 404 RUN_NOT_FOUND", lintas.status === 404 && lintas.json?.error === "RUN_NOT_FOUND", `${lintas.status} ${short(lintas.json)}`);
check("5r. jawaban 404 tidak membocorkan isi run (prompt tidak muncul)", !String(lintas.text).includes("RAHASIA-TETANGGA"), short(lintas.text));
const lintasPemilik = await other.call("GET", `/api/v1/runs/${runTetanggaId}/timeline`);
check("5s. pemiliknya sendiri tetap bisa membaca timeline run itu", lintasPemilik.status === 200 && lintasPemilik.json?.runId === runTetanggaId, `${lintasPemilik.status}`);
const runTidakAda = await owner.call("GET", "/api/v1/runs/run-tidak-ada-11b/timeline");
check("5t. run yang tidak ada menjawab 404", runTidakAda.status === 404 && runTidakAda.json?.error === "RUN_NOT_FOUND", `${runTidakAda.status}`);
const tanpaSesi = await anon.call("GET", `/api/v1/runs/${runAlat}/timeline`);
check("5u. tanpa sesi masuk menjawab 401 AUTH_REQUIRED", tanpaSesi.status === 401 && tanpaSesi.json?.error === "AUTH_REQUIRED", `${tanpaSesi.status} ${short(tanpaSesi.json)}`);

// Run besar: 500 peristiwa alat + 1 langkah 'run dibuat'. Wajib tetap di bawah 2 detik.
const runBesar = barisRun(`run-besar-${stamp}`, projectId, "running", { createdAt: at(300), prompt: "Uji 500 peristiwa" });
const isiBesar = db.transaction(() => {
  for (let i = 0; i < 500; i += 1) tambahEvent(runBesar, "tool", { name: `alat-${i}`, summary: `langkah ${i}`, status: "selesai" }, new Date(t0 + 1_000 + i * 10).toISOString());
});
isiBesar();
const mulaiBesar = Date.now();
const timelineBesar = await owner.call("GET", `/api/v1/runs/${runBesar}/timeline`);
const durasiBesar = Date.now() - mulaiBesar;
const langkahBesar: any[] = timelineBesar.json?.langkah ?? [];
check("5v. run 500 peristiwa tetap cepat (< 2 detik)", timelineBesar.status === 200 && durasiBesar < 2_000, `${timelineBesar.status} ${durasiBesar} ms`);
check("5w. seluruh 500 peristiwa tampil berurutan", langkahBesar.length === 501 && langkahBesar[1]?.name === "alat-0" && langkahBesar[500]?.name === "alat-499"
  && langkahBesar.every((row, index) => row.seq === index + 1), short({ total: langkahBesar.length, pertama: langkahBesar[1]?.name, terakhir: langkahBesar[500]?.name }));

/* =====================================================================================
 * Bagian 7 (§7, butir 64): ekspor / impor agen.
 * ===================================================================================== */
console.log("\n--- Bagian 7 (§7/64): ekspor & impor persona ---");
// Dua persona nyata lewat API resmi: satu milik pemilik, satu milik pengguna pembanding.
const personaOwnerReply = await owner.call("POST", "/api/v1/personas", { name: "Penulis Utama", systemPrompt: "Anda editor teknis.", tone: "ringkas", language: "id", thinkingLevel: "high" });
const personaOwnerId = String(personaOwnerReply.json?.persona?.id ?? "");
check("7a. persona pemilik dibuat lewat API resmi", personaOwnerReply.status === 201 && Boolean(personaOwnerId), `${personaOwnerReply.status} ${short(personaOwnerReply.json)}`);
const personaOtherReply = await other.call("POST", "/api/v1/personas", { name: "Penulis Lain", systemPrompt: "Milik akun lain.", tone: "santai" });
check("7b. persona pembanding dibuat di akun lain", personaOtherReply.status === 201, `${personaOtherReply.status}`);

const ekspor = await owner.call("GET", "/api/v1/personas/export");
const disposisi = String(ekspor.headers.get("content-disposition") ?? "");
check("7c. ekspor menjawab 200 berkas lampiran coder-personas.json", ekspor.status === 200 && /attachment/i.test(disposisi) && disposisi.includes("coder-personas.json"), `${ekspor.status} ${disposisi}`);
check("7d. berkas ekspor memuat versi 1, dieksporPada, dan daftar personas", ekspor.json?.versi === 1 && typeof ekspor.json?.dieksporPada === "string" && !Number.isNaN(Date.parse(ekspor.json.dieksporPada)) && Array.isArray(ekspor.json?.personas), short(ekspor.json, 300));
const isiEkspor: any[] = ekspor.json?.personas ?? [];
const personaEkspor = isiEkspor.find((row) => row?.name === "Penulis Utama");
check("7e. butir ekspor memuat enam kolom yang diminta", Boolean(personaEkspor) && ["name", "systemPrompt", "tone", "language", "model", "thinkingLevel"].every((key) => key in personaEkspor)
  && personaEkspor.systemPrompt === "Anda editor teknis." && personaEkspor.tone === "ringkas" && personaEkspor.language === "id" && personaEkspor.thinkingLevel === "high",
  short(personaEkspor));
check("7f. ekspor TIDAK memuat persona pengguna lain", !isiEkspor.some((row) => row?.name === "Penulis Lain"), short(isiEkspor.map((row) => row?.name)));
check("7g. ekspor tidak membocorkan id internal persona", isiEkspor.every((row) => !("id" in row) && !("userId" in row) && !("user_id" in row)), short(Object.keys(isiEkspor[0] ?? {})));

// Bentuk berkas yang salah wajib ditolak.
const imporBukanDaftar = await owner.call("POST", "/api/v1/personas/import", { personas: "bukan daftar" });
check("7h. body tanpa daftar personas ditolak 400 INVALID_IMPORT", imporBukanDaftar.status === 400 && imporBukanDaftar.json?.error === "INVALID_IMPORT", `${imporBukanDaftar.status} ${short(imporBukanDaftar.json)}`);
const imporTanpaName = await owner.call("POST", "/api/v1/personas/import", { personas: [{ systemPrompt: "Tanpa nama." }] });
check("7i. butir tanpa name ditolak 400 dengan pesan yang diminta", imporTanpaName.status === 400 && imporTanpaName.json?.error === "INVALID_IMPORT"
  && imporTanpaName.json?.message === "Berkas impor tidak sah: setiap butir wajib punya name.", `${imporTanpaName.status} ${short(imporTanpaName.json)}`);
const imporNameKosong = await owner.call("POST", "/api/v1/personas/import", { personas: [{ name: "   ", systemPrompt: "Nama kosong." }] });
check("7j. name kosong (hanya spasi) juga ditolak 400 INVALID_IMPORT", imporNameKosong.status === 400 && imporNameKosong.json?.error === "INVALID_IMPORT", `${imporNameKosong.status}`);
const imporBukanObjek = await owner.call("POST", "/api/v1/personas/import", { personas: ["Penulis Utama"] });
check("7k. butir bukan objek ditolak 400 INVALID_IMPORT", imporBukanObjek.status === 400 && imporBukanObjek.json?.error === "INVALID_IMPORT", `${imporBukanObjek.status}`);

// Berkas dengan satu butir cacat tidak boleh menambah apa pun (impor utuh atau tidak sama sekali).
const personaSebelumCacat = count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=?", ownerId);
const imporCampuran = await owner.call("POST", "/api/v1/personas/import", { personas: [{ name: "Riset Pasar" }, { systemPrompt: "Tanpa nama." }] });
check("7l. satu butir cacat menolak seluruh berkas tanpa menambah baris", imporCampuran.status === 400
  && count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=?", ownerId) === personaSebelumCacat
  && count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=? AND name='Riset Pasar'", ownerId) === 0,
  `${imporCampuran.status} sebelum=${personaSebelumCacat} sesudah=${count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=?", ownerId)}`);

const spamSebelum = count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=?", ownerId);
const impor51 = await owner.call("POST", "/api/v1/personas/import", { personas: Array.from({ length: 51 }, (_v, i) => ({ name: `Batas ${i}` })) });
check("7m. 51 butir ditolak 400 IMPORT_LIMIT_REACHED dan tidak menambah baris", impor51.status === 400 && impor51.json?.error === "IMPORT_LIMIT_REACHED"
  && count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=?", ownerId) === spamSebelum, `${impor51.status} ${short(impor51.json)}`);
check("7n. batas yang dipakai adalah config.PERSONA_IMPORT_LIMIT (50)", Number(impor51.json?.limit) === Number(config.PERSONA_IMPORT_LIMIT) && Number(config.PERSONA_IMPORT_LIMIT) === 50, short(impor51.json));

// Impor sah: satu nama baru + satu nama bentrok yang wajib DILEWATI.
const sebelumImpor: any = db.prepare("SELECT name, system_prompt AS systemPrompt, tone, language, model, thinking_level AS thinkingLevel, updated_at AS updatedAt FROM agent_personas WHERE id=?").get(personaOwnerId);
const imporSah = await owner.call("POST", "/api/v1/personas/import", { personas: [
  { name: "Riset Pasar", systemPrompt: "Anda analis pasar.", tone: "teliti", language: "en", model: null, thinkingLevel: "high" },
  { name: "Penulis Utama", systemPrompt: "ISI INI TIDAK BOLEH MENIMPA", tone: "harus ditolak", thinkingLevel: "off" },
] });
check("7o. impor sah menambah 1 dan melewati 1 nama bentrok", imporSah.status === 200 && Number(imporSah.json?.added) === 1
  && JSON.stringify(imporSah.json?.skipped) === JSON.stringify(["Penulis Utama"]) && Number(imporSah.json?.total) === 2,
  `${imporSah.status} ${short(imporSah.json)}`);
check("7p. added + skipped sama dengan total butir berkas", Number(imporSah.json?.added) + (imporSah.json?.skipped ?? []).length === Number(imporSah.json?.total), short(imporSah.json));
const sesudahImpor: any = db.prepare("SELECT name, system_prompt AS systemPrompt, tone, language, model, thinking_level AS thinkingLevel, updated_at AS updatedAt FROM agent_personas WHERE id=?").get(personaOwnerId);
check("7q. persona lama TIDAK berubah sedikit pun", JSON.stringify(sesudahImpor) === JSON.stringify(sebelumImpor), short({ sebelum: sebelumImpor, sesudah: sesudahImpor }, 360));
const personaBaru: any = db.prepare("SELECT user_id AS userId, system_prompt AS systemPrompt, tone, language, model, thinking_level AS thinkingLevel, is_default AS isDefault FROM agent_personas WHERE user_id=? AND name='Riset Pasar'").get(ownerId);
check("7r. persona baru tersimpan milik pengguna yang mengimpor dengan isi utuh", personaBaru?.userId === ownerId && personaBaru?.systemPrompt === "Anda analis pasar."
  && personaBaru?.tone === "teliti" && personaBaru?.language === "en" && personaBaru?.model === null && personaBaru?.thinkingLevel === "high" && Number(personaBaru?.isDefault) === 0,
  short(personaBaru));

const imporBentrokHuruf = await owner.call("POST", "/api/v1/personas/import", { personas: [{ name: "pENULIS uTAMA" }, { name: "Riset Pasar" }] });
check("7s. bentrok nama tanpa memandang huruf besar/kecil tetap dilewati", imporBentrokHuruf.status === 200 && Number(imporBentrokHuruf.json?.added) === 0
  && JSON.stringify(imporBentrokHuruf.json?.skipped) === JSON.stringify(["pENULIS uTAMA", "Riset Pasar"]), `${imporBentrokHuruf.status} ${short(imporBentrokHuruf.json)}`);

// Nama kembar di DALAM satu berkas: butir kedua dilewati, bukan menambah persona kedua.
const kembar = await importUser.call("POST", "/api/v1/personas/import", { personas: [{ name: "Kembar Ganda" }, { name: "kembar ganda" }] });
check("7t. nama kembar di dalam satu berkas dilewati", kembar.status === 200 && Number(kembar.json?.added) === 1 && (kembar.json?.skipped ?? []).length === 1
  && count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=? AND lower(name)='kembar ganda'", importUserId) === 1, `${kembar.status} ${short(kembar.json)}`);

const imporKosong = await owner.call("POST", "/api/v1/personas/import", { personas: [] });
check("7u. berkas kosong diterima dengan added 0", imporKosong.status === 200 && Number(imporKosong.json?.added) === 0 && Number(imporKosong.json?.total) === 0 && (imporKosong.json?.skipped ?? []).length === 0, `${imporKosong.status} ${short(imporKosong.json)}`);

// Tepat 50 butir pada akun yang masih longgar wajib diterima.
const impor50 = await importUser.call("POST", "/api/v1/personas/import", { personas: Array.from({ length: 50 }, (_v, i) => ({ name: `Tepat ${i}`, systemPrompt: `Prompt ${i}` })) });
check("7v. tepat 50 butir diterima (batas inklusif)", impor50.status === 200 && Number(impor50.json?.added) === 50 && (impor50.json?.skipped ?? []).length === 0
  && count("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=? AND name LIKE 'Tepat %'", importUserId) === 50, `${impor50.status} ${short(impor50.json)}`);

const imporTanpaSesi = await anon.call("POST", "/api/v1/personas/import", { personas: [{ name: "Tanpa Sesi" }] });
check("7w. impor tanpa sesi menjawab 401 AUTH_REQUIRED", imporTanpaSesi.status === 401 && imporTanpaSesi.json?.error === "AUTH_REQUIRED", `${imporTanpaSesi.status} ${short(imporTanpaSesi.json)}`);
const eksporTanpaSesi = await anon.call("GET", "/api/v1/personas/export");
check("7x. ekspor tanpa sesi menjawab 401 AUTH_REQUIRED", eksporTanpaSesi.status === 401 && eksporTanpaSesi.json?.error === "AUTH_REQUIRED", `${eksporTanpaSesi.status}`);

// Audit `personas_import`: angka di metadata harus sama dengan laporan terakhir.
const auditImpor: any = db.prepare("SELECT action, metadata_json AS metadataJson, actor_user_id AS actorId FROM audit_events WHERE actor_user_id=? AND action='personas_import' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(ownerId);
let metadataImpor: any = {};
try { metadataImpor = JSON.parse(String(auditImpor?.metadataJson ?? "{}")); } catch { metadataImpor = {}; }
check("7y. audit `personas_import` tercatat untuk pengguna yang mengimpor", auditImpor?.actorId === ownerId && auditImpor?.action === "personas_import", short(auditImpor, 240));
check("7z. metadata audit cocok dengan laporan impor terakhir (added/skipped/total)", Number(metadataImpor?.added) === Number(imporKosong.json?.added)
  && Number(metadataImpor?.skipped) === (imporKosong.json?.skipped ?? []).length && Number(metadataImpor?.total) === Number(imporKosong.json?.total), short(metadataImpor));
const auditImporAdaSkipped: any = db.prepare("SELECT metadata_json AS metadataJson FROM audit_events WHERE actor_user_id=? AND action='personas_import' ORDER BY created_at DESC, rowid DESC LIMIT 4").all(ownerId) as any[];
const namaDilewatiTercatat = auditImporAdaSkipped.some((row: any) => { try { return String(JSON.parse(String(row.metadataJson)).skippedNames ?? "").includes("Penulis Utama"); } catch { return false; } });
check("7aa. nama yang dilewati ikut tercatat di metadata audit", namaDilewatiTercatat, short(auditImporAdaSkipped.map((row: any) => row.metadataJson)));
const jumlahAuditImpor = count("SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id=? AND action='personas_import'", ownerId);
check("7ab. setiap impor yang diterima meninggalkan satu baris audit (3 impor sukses)", jumlahAuditImpor === 3, `audit=${jumlahAuditImpor}`);

/* =====================================================================================
 * Bagian 8 (§8, butir 65): metrik jujur + pemakaian & audit pribadi.
 * ===================================================================================== */
console.log("\n--- Bagian 8 (§8/65): pemakaian & audit pribadi ---");
const sekarang = Date.now();
const iso = (offsetMs: number) => new Date(sekarang + offsetMs).toISOString();

// Baris run_usage terkendali, termasuk satu baris TANPA harga jual (tidak tertagih) dan satu baris
// lama (40 hari) untuk menguji rentang waktu. Angka pemilik dan angka pembanding sengaja berbeda jauh.
barisUsage(`ru-1-${stamp}`, runAlat, projectId, { model: "model-utama", tokenInput: 1000, tokenOutput: 200, totalTokens: 1200, costMicros: 4000, sellCostMicros: 5000, createdAt: iso(0) });
barisUsage(`ru-2-${stamp}`, runAlat, projectId, { model: "model-utama", tokenInput: 300, tokenOutput: 50, totalTokens: 350, costMicros: 700, sellCostMicros: null, createdAt: iso(1_000) });
barisUsage(`ru-3-${stamp}`, runKosong, projectId, { model: "model-lama", tokenInput: 10, tokenOutput: 5, totalTokens: 15, costMicros: 90, sellCostMicros: 100, createdAt: iso(-40 * 86_400_000) });
barisUsage(`ru-4-${stamp}`, runKosong, projectId, { model: "model-utama", tokenInput: 200, tokenOutput: 100, totalTokens: null, costMicros: 1000, sellCostMicros: 1250, createdAt: iso(-5 * 86_400_000) });
barisUsage(`ru-tetangga-${stamp}`, runTetanggaId, otherProjectId, { model: "model-tetangga", tokenInput: 7000, tokenOutput: 800, totalTokens: 7800, costMicros: 700_000, sellCostMicros: 777_000, createdAt: iso(0) });

const usage = await owner.call("GET", "/api/v1/account/usage?period=30d");
const wajibAda = ["period", "days", "sejak", "tokenInput", "tokenOutput", "tokenTotal", "biayaTerbillingMicros", "biayaTidakTertagihMicros", "totalMicros", "rekonsiliasi", "perHari", "perModel", "catatan"];
check("8a. pemakaian menjawab 200 dengan seluruh kolom kontrak", usage.status === 200 && wajibAda.every((key) => key in (usage.json ?? {})), `${usage.status} ${short(usage.json, 260)}`);
check("8b. rentang 30d dilaporkan apa adanya sebagai period/days", usage.json?.period === "30d" && Number(usage.json?.days) === 30
  && Math.abs(Date.parse(String(usage.json?.sejak)) - (sekarang - 30 * 86_400_000)) < 10_000,
  short({ period: usage.json?.period, days: usage.json?.days, sejak: usage.json?.sejak }, 200));

// Angka diuji ULANG di sini dari basis data, bukan dengan memanggil modul yang diuji.
const sejak30 = String(usage.json?.sejak ?? "");
const harap30 = hitungUlang(ownerId, sejak30);
check("8c. token input/output/total cocok hitungan ulang run_usage", Number(usage.json?.tokenInput) === angka(harap30.tokenInput)
  && Number(usage.json?.tokenOutput) === angka(harap30.tokenOutput) && Number(usage.json?.tokenTotal) === angka(harap30.tokenTotal),
  short({ api: { i: usage.json?.tokenInput, o: usage.json?.tokenOutput, t: usage.json?.tokenTotal }, ulang: { i: harap30.tokenInput, o: harap30.tokenOutput, t: harap30.tokenTotal } }));
check("8d. biaya terbilling = SUM(sell_cost_micros) yang tidak NULL", Number(usage.json?.biayaTerbillingMicros) === angka(harap30.terbilling) && angka(harap30.terbilling) > 0,
  short({ api: usage.json?.biayaTerbillingMicros, ulang: harap30.terbilling }));
check("8e. biaya tidak tertagih = SUM(cost_micros) untuk baris sell_cost_micros NULL", Number(usage.json?.biayaTidakTertagihMicros) === angka(harap30.tidakTertagih)
  && angka(harap30.tidakTertagih) >= 700, short({ api: usage.json?.biayaTidakTertagihMicros, ulang: harap30.tidakTertagih }));
check("8f. totalMicros = terbilling + tidak tertagih", Number(usage.json?.totalMicros) === Number(usage.json?.biayaTerbillingMicros) + Number(usage.json?.biayaTidakTertagihMicros), short(usage.json?.totalMicros));
check("8g. selisih rekonsiliasi = SUM(cost) - SUM(sell) pada baris yang keduanya terisi", Number(usage.json?.rekonsiliasi?.selisihMicros) === angka(harap30.selisih), short({ api: usage.json?.rekonsiliasi, ulang: harap30.selisih }));
// Baris uji ru-1 dan ru-4 memang dijual lebih murah dari harga pokoknya (5000 < ... -> negatif),
// jadi selisih negatif WAJIB muncul apa adanya, bukan dipangkas jadi nol.
check("8g2. selisih negatif ditampilkan apa adanya (tidak dipangkas jadi nol)", Number(usage.json?.rekonsiliasi?.selisihMicros) < 0, short(usage.json?.rekonsiliasi?.selisihMicros));
check("8h. jumlahRun rekonsiliasi = COUNT(DISTINCT run_id) baris yang keduanya terisi", Number(usage.json?.rekonsiliasi?.jumlahRun) === angka(harap30.jumlahRunRekonsiliasi)
  && angka(harap30.jumlahRunRekonsiliasi) >= 2, short({ api: usage.json?.rekonsiliasi?.jumlahRun, ulang: harap30.jumlahRunRekonsiliasi }));
check("8i. catatan menyebut definisi setiap angka, termasuk yang tidak tertagih", ["biayaTerbillingMicros = SUM(run_usage.sell_cost_micros) yang TIDAK NULL", "biayaTidakTertagihMicros", "selisihMicros", "tidak dihitung"].every((potongan) => String(usage.json?.catatan).includes(potongan)), short(usage.json?.catatan, 400));

const jumlah = (rows: any[], key: string) => rows.reduce((total, row) => total + angka(row?.[key]), 0);
check("8j. perHari menjumlah kembali ke angka total", Array.isArray(usage.json?.perHari) && jumlah(usage.json?.perHari, "tokenTotal") === Number(usage.json?.tokenTotal)
  && jumlah(usage.json?.perHari, "biayaTerbillingMicros") === Number(usage.json?.biayaTerbillingMicros)
  && jumlah(usage.json?.perHari, "biayaTidakTertagihMicros") === Number(usage.json?.biayaTidakTertagihMicros),
  short(usage.json?.perHari));
check("8k. perHari hanya memuat hari yang punya baris (baris 40 hari lalu tidak ada di 30d)", Array.isArray(usage.json?.perHari)
  && usage.json.perHari.some((row: any) => row.tanggal === iso(0).slice(0, 10))
  && !usage.json.perHari.some((row: any) => row.tanggal === iso(-40 * 86_400_000).slice(0, 10)), short(usage.json?.perHari));
check("8l. perModel menjumlah kembali ke angka total dan memuat model uji", Array.isArray(usage.json?.perModel) && jumlah(usage.json?.perModel, "tokenTotal") === Number(usage.json?.tokenTotal)
  && usage.json.perModel.some((row: any) => row.model === "model-utama" && angka(row.biayaTidakTertagihMicros) >= 700), short(usage.json?.perModel));

// Baris TANPA harga jual ditambahkan SETELAH pembacaan pertama: yang berubah hanya biaya tidak
// tertagih, sedangkan yang tertagih dan selisih rekonsiliasi tidak bergerak. Itu bukti definisinya.
barisUsage(`ru-5-${stamp}`, runAlat, projectId, { model: "model-utama", tokenInput: 500, tokenOutput: 500, totalTokens: 1000, costMicros: 2000, sellCostMicros: null, createdAt: iso(2_000) });
const usageLagi = await owner.call("GET", "/api/v1/account/usage?period=30d");
check("8m. baris tanpa harga jual menambah biaya tidak tertagih tepat sebesar cost_micros", Number(usageLagi.json?.biayaTidakTertagihMicros) === Number(usage.json?.biayaTidakTertagihMicros) + 2000,
  `${usage.json?.biayaTidakTertagihMicros} -> ${usageLagi.json?.biayaTidakTertagihMicros}`);
check("8n. baris tanpa harga jual TIDAK menggeser biaya tertagih dan selisih rekonsiliasi", Number(usageLagi.json?.biayaTerbillingMicros) === Number(usage.json?.biayaTerbillingMicros)
  && Number(usageLagi.json?.rekonsiliasi?.selisihMicros) === Number(usage.json?.rekonsiliasi?.selisihMicros),
  short({ billed: [usage.json?.biayaTerbillingMicros, usageLagi.json?.biayaTerbillingMicros], selisih: [usage.json?.rekonsiliasi?.selisihMicros, usageLagi.json?.rekonsiliasi?.selisihMicros] }));
check("8o. totalMicros ikut naik tepat 2000 (angka apa adanya, tidak dibulatkan)", Number(usageLagi.json?.totalMicros) === Number(usage.json?.totalMicros) + 2000, `${usage.json?.totalMicros} -> ${usageLagi.json?.totalMicros}`);

// Rentang waktu dihormati: baris 40 hari lalu masuk di 90d, tidak masuk di 30d maupun 7d.
const usage7 = await owner.call("GET", "/api/v1/account/usage?period=7d");
const usage90 = await owner.call("GET", "/api/v1/account/usage?period=90d");
check("8p. 7d dan 30d sama karena semua baris uji masih di dalam 7 hari terakhir", Number(usage7.json?.days) === 7
  && Number(usage7.json?.tokenInput) === Number(usageLagi.json?.tokenInput)
  && Number(usage7.json?.tokenOutput) === Number(usageLagi.json?.tokenOutput)
  && Number(usage7.json?.tokenTotal) === Number(usageLagi.json?.tokenTotal)
  && Number(usage7.json?.biayaTerbillingMicros) === Number(usageLagi.json?.biayaTerbillingMicros)
  && Number(usage7.json?.totalMicros) === Number(usageLagi.json?.totalMicros),
  short({ tujuh: [usage7.json?.tokenInput, usage7.json?.tokenTotal], tiga10: [usageLagi.json?.tokenInput, usageLagi.json?.tokenTotal] }));
check("8q. 90d memuat baris 40 hari lalu tepat sebesar barisnya", Number(usage90.json?.days) === 90
  && Number(usage90.json?.tokenTotal) - Number(usage7.json?.tokenTotal) === 15
  && Number(usage90.json?.tokenInput) - Number(usage7.json?.tokenInput) === 10
  && Number(usage90.json?.tokenOutput) - Number(usage7.json?.tokenOutput) === 5
  && Number(usage90.json?.biayaTerbillingMicros) - Number(usage7.json?.biayaTerbillingMicros) === 100
  && Number(usage90.json?.biayaTidakTertagihMicros) === Number(usage7.json?.biayaTidakTertagihMicros),
  short({ tujuh: usage7.json?.tokenTotal, sembilan10: usage90.json?.tokenTotal }));
const harap90 = hitungUlang(ownerId, String(usage90.json?.sejak ?? ""));
check("8r. angka 90d juga cocok hitungan ulang", Number(usage90.json?.tokenTotal) === angka(harap90.tokenTotal) && Number(usage90.json?.biayaTerbillingMicros) === angka(harap90.terbilling), short({ api: usage90.json?.tokenTotal, ulang: harap90.tokenTotal }));

// Bentuk `period` yang tidak sah wajib ditolak.
for (const period of ["30", "abc", "0d", "30D", ""]) {
  const salah = await owner.call("GET", `/api/v1/account/usage?period=${encodeURIComponent(period)}`);
  check(`8s[${period || "kosong"}]. period tidak berbentuk <angka>d ditolak 400 INVALID_PERIOD`, salah.status === 400 && salah.json?.error === "INVALID_PERIOD", `${salah.status} ${short(salah.json)}`);
}

// Isolasi antar-pengguna: angka pemilik tidak boleh memuat pemakaian ruang kerja lain.
const usageOther = await other.call("GET", "/api/v1/account/usage?period=30d");
const harapOther = hitungUlang(otherId, String(usageOther.json?.sejak ?? ""));
check("8t. angka pengguna lain juga cocok hitungan ulang pada cakupannya sendiri", Number(usageOther.json?.biayaTerbillingMicros) === angka(harapOther.terbilling)
  && Number(usageOther.json?.tokenTotal) === angka(harapOther.tokenTotal), short({ api: usageOther.json?.biayaTerbillingMicros, ulang: harapOther.terbilling }));
check("8u. pemakaian ruang kerja lain (777.000 mikrodolar) TIDAK masuk ke angka pemilik", Number(usageLagi.json?.biayaTerbillingMicros) < 777_000
  && Number(usageOther.json?.biayaTerbillingMicros) >= 777_000
  && Number(usageLagi.json?.biayaTerbillingMicros) !== Number(usageOther.json?.biayaTerbillingMicros),
  short({ pemilik: usageLagi.json?.biayaTerbillingMicros, pembanding: usageOther.json?.biayaTerbillingMicros }));
check("8v. model milik ruang kerja lain tidak muncul di perModel pemilik", !(usageLagi.json?.perModel ?? []).some((row: any) => row.model === "model-tetangga"), short((usageLagi.json?.perModel ?? []).map((row: any) => row.model)));

const usageImport = await importUser.call("GET", "/api/v1/account/usage?period=30d");
check("8w. akun tanpa run melaporkan nol apa adanya (bukan angka karangan)", Number(usageImport.json?.tokenTotal) === 0 && Number(usageImport.json?.totalMicros) === 0
  && (usageImport.json?.perHari ?? []).length === 0 && (usageImport.json?.perModel ?? []).length === 0
  && String(usageImport.json?.catatan).includes("0 baris run_usage"), short(usageImport.json, 300));
const usageTanpaSesi = await anon.call("GET", "/api/v1/account/usage?period=30d");
check("8x. pemakaian tanpa sesi menjawab 401 AUTH_REQUIRED", usageTanpaSesi.status === 401 && usageTanpaSesi.json?.error === "AUTH_REQUIRED", `${usageTanpaSesi.status}`);

/* --------------------------------------------------------------- audit pribadi */
db.prepare("INSERT INTO audit_events (id,workspace_id,actor_user_id,action,metadata_json,created_at) VALUES (?,?,?,?,?,?)")
  .run(`audit-lama-${stamp}`, ownerWorkspaceId, ownerId, "uji_lama_audit", JSON.stringify({ catatan: "10 hari lalu" }), iso(-10 * 86_400_000));
db.prepare("INSERT INTO audit_events (id,workspace_id,actor_user_id,action,metadata_json,created_at) VALUES (?,?,?,?,?,?)")
  .run(`audit-tetangga-${stamp}`, otherWorkspaceId, otherId, "uji_isolasi_audit", JSON.stringify({ rahasia: "milik pembanding" }), iso(0));

const audit90 = await owner.call("GET", "/api/v1/account/audit?days=90");
const event90: any[] = audit90.json?.events ?? [];
check("8y. audit menjawab 200 dengan seluruh kolom kontrak", audit90.status === 200 && Number(audit90.json?.days) === 90 && typeof audit90.json?.sejak === "string"
  && Number.isInteger(Number(audit90.json?.total)) && Array.isArray(audit90.json?.events) && typeof audit90.json?.catatan === "string", `${audit90.status} ${short(audit90.json, 300)}`);
check("8z. total audit sama dengan jumlah baris milik sendiri di basis data", Number(audit90.json?.total) === count("SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id=? AND created_at>=?", ownerId, String(audit90.json?.sejak)),
  short({ total: audit90.json?.total, db: count("SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id=? AND created_at>=?", ownerId, String(audit90.json?.sejak)) }));
check("8aa. setiap baris audit yang dikembalikan benar-benar milik pengguna ini", event90.length > 0
  && event90.every((row) => String((db.prepare("SELECT actor_user_id AS actorId FROM audit_events WHERE id=?").get(row.id) as any)?.actorId) === ownerId),
  short(event90.map((row) => row.id)));
check("8ab. jejak pengguna lain tidak ikut terbawa", !event90.some((row) => row.action === "uji_isolasi_audit"), short(event90.map((row) => row.action)));
check("8ac. jejak aksi impor sendiri terlihat dengan metadata terurai", event90.some((row) => row.action === "personas_import" && typeof row.metadata === "object" && row.metadata !== null && Number.isInteger(Number(row.metadata.added))),
  short(event90.filter((row) => row.action === "personas_import").slice(0, 1)));
check("8ad. metadata dikembalikan sebagai objek JSON, bukan teks mentah", event90.every((row) => typeof row.metadata === "object" && row.metadata !== null), short(event90[0]));

const audit1 = await owner.call("GET", "/api/v1/account/audit?days=1");
const event1: any[] = audit1.json?.events ?? [];
check("8ae. rentang 1 hari mengabaikan jejak 10 hari lalu tetapi tetap memuat aksi baru", audit1.status === 200
  && !event1.some((row) => row.action === "uji_lama_audit") && event1.some((row) => row.action === "personas_import"),
  short(event1.map((row) => row.action)));

for (const days of ["0", "366", "abc", "-5"]) {
  const salah = await owner.call("GET", `/api/v1/account/audit?days=${encodeURIComponent(days)}`);
  check(`8af[${days}]. days di luar 1..365 ditolak 400 INVALID_DAYS`, salah.status === 400 && salah.json?.error === "INVALID_DAYS", `${salah.status} ${short(salah.json)}`);
}

const auditOther = await other.call("GET", "/api/v1/account/audit?days=90");
const eventOther: any[] = auditOther.json?.events ?? [];
check("8ag. audit pengguna lain memuat jejaknya sendiri", auditOther.status === 200 && eventOther.some((row) => row.action === "uji_isolasi_audit"), `${auditOther.status} ${short(eventOther.map((row) => row.action))}`);
const idPemilik = new Set(event90.map((row) => row.id));
check("8ah. himpunan jejak dua pengguna berbeda tidak beririsan", eventOther.length > 0 && eventOther.every((row) => !idPemilik.has(row.id)), short({ pemilik: idPemilik.size, pembanding: eventOther.length }));
check("8ai. catatan audit menyebut jejak milik sendiri dan jumlah baris yang ditampilkan", String(audit90.json?.catatan).includes("milik Anda sendiri")
  && String(audit90.json?.catatan).includes(`Menampilkan ${event90.length} dari ${audit90.json?.total}`), short(audit90.json?.catatan, 320));
const auditTanpaSesi = await anon.call("GET", "/api/v1/account/audit?days=90");
check("8aj. audit tanpa sesi menjawab 401 AUTH_REQUIRED", auditTanpaSesi.status === 401 && auditTanpaSesi.json?.error === "AUTH_REQUIRED", `${auditTanpaSesi.status}`);

console.log(`\nRingkasan: ${passed} lulus, ${failed} gagal${skipped.length ? `, ${skipped.length} dilewati` : ""}`);
if (failedNames.length) console.log(`Gagal: ${failedNames.join(" | ")}`);
console.log(`Jumlah pemeriksaan: bagian §5/62 + §7/64 + §8/65 = ${passed + failed}`);
process.exit(failed ? 1 : 0);

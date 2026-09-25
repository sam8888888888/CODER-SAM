/**
 * Uji Wave 11B (v0.22.0) butir 58 (dewan juri) dan butir 61 (benchmark) — satu suite, dua butir.
 *
 * Butir 58 — dewan juri:
 *  ① `POST /api/v1/council/run` mengembalikan 202 dan SETIAP juri adalah satu run nyata yang
 *    barisnya bisa dilihat di tabel `runs` + `run_usage`.
 *  ② galat bentuk permintaan: COUNCIL_MATERIAL_REQUIRED, COUNCIL_QUESTION_REQUIRED,
 *    COUNCIL_JUROR_LIMIT, INVALID_JUROR, CONVERSATION_NOT_FOUND, VIEWER_FORBIDDEN.
 *  ③ juri yang gagal TIDAK merobohkan hasil: barisnya tetap ada dengan `error_code`, juri lain
 *    selesai, status dewan `completed`; bila SEMUA juri gagal status menjadi `failed`.
 *  ④ biaya terlihat SEBELUM jalan (`POST /api/v1/council/estimate`, tanpa menulis apa pun) dan
 *    SESUDAH jalan (`cost_micros` di GET /api/v1/council/runs/:id).
 *  ⑤ kuota token dihormati: 429 saat kuota habis, dan juri yang kena batas di tengah dewan
 *    dilewati dengan `error_code = QUOTA_EXCEEDED` tanpa membuat run baru.
 *  ⑥ juri dijalankan berurutan per gelombang `COUNCIL_MAX_PARALLEL` (diuji pada helpernya).
 *
 * Butir 61 — benchmark:
 *  ① `POST /api/v1/benchmark/estimate` (gratis, tanpa menulis) dan `POST /api/v1/benchmark/run`
 *    yang WAJIB memakai angka perkiraan yang cocok (ESTIMATE_REQUIRED, ESTIMATE_MISMATCH).
 *  ② soal tetap dibaca dari `apps/api/benchmark/questions.json` (maks 10 soal).
 *  ③ galat: BENCHMARK_MODEL_LIMIT, INVALID_MODEL, MODEL_REQUIRED, BENCHMARK_NOT_FOUND.
 *  ④ tiap pasangan (model, soal) menyimpan satu baris `benchmark_results` beserta biaya dan waktu;
 *    model yang gagal ditandai `error_code` dan tidak menghentikan model lain.
 *  ⑤ skor kesepakatan antar model dihitung dan disimpan; isi formulanya diuji langsung.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11b-council.e2e.ts
 *
 * Catatan jujur tentang batas pengujian:
 *  • Mesin yang dipakai suite ini adalah MOCK_ENGINE. Mock hanya MENGULANG prompt, jadi jawaban
 *    juri tidak pernah memuat verdict terstruktur. Karena itu pembacaan verdict diuji langsung
 *    (unit dalam proses) dan uji HTTP-nya justru membuktikan hal yang lebih penting: prompt juri
 *    memuat kata setuju/menolak/ragu, tetapi jawaban tanpa verdict TIDAK ditebak dari kata kunci.
 *  • Batas paralel diuji pada helper `jalankanBerurutanBersamaan`; lewat HTTP, mock selesai terlalu
 *    cepat untuk bisa mengukur tumpang tindih waktu secara jujur.
 * Berkas ini hanya menambah berkas uji baru. Tidak ada berkas lain milik agen lain yang diubah.
 */
import { createServer as createTcpServer } from "node:net";
import { readFileSync } from "node:fs";

/** Mencari port bebas di rentang Wave 11B (7285-7305); nomor utama dicoba lebih dulu. */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 20 }, () => 7285 + Math.floor(Math.random() * 21))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang Wave 11B (7285-7305): ada server uji yang belum keluar?");
}

const port = await cariPortBebas(7285, 7286, 7287);
const dataDir = `/tmp/coder-wave11b-council-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11b-admin-${stamp}@example.test`;
const ownerEmail = `w11b-owner-${stamp}@example.test`;
const viewerEmail = `w11b-viewer-${stamp}@example.test`;
const strangerEmail = `w11b-stranger-${stamp}@example.test`;
const miskinEmail = `w11b-miskin-${stamp}@example.test`;

/** Tiga model nyata di katalog harga platform; dipakai supaya biaya benar-benar lebih dari nol. */
const MODEL_A = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODEL_B = "@cf/qwen/qwen3-30b-a3b-fp8";
const MODEL_C = "@cf/openai/gpt-oss-20b";
/** Model yang tidak ada di katalog harga: harus ditolak, bukan dihitung biayanya dengan tebakan. */
const MODEL_TIDAK_ADA = "model-tanpa-harga-xyz";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = MODEL_A;
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { quotaState } = await import("../src/billing.js");
const { quoteCosts, priceView } = await import("../src/pricing.js");
const councilMod: any = await import("../src/wave11b/council.js");
const benchMod: any = await import("../src/wave11b/benchmark.js");

const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} - ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 220) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const hitung = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const semua = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params as any[]) as any[];
const satu = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as any[]) as any;

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
    return { status: response.status, json, text };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server belum siap */ } }
  return { call, bootstrap: prime };
}

const owner = client();
const viewer = client();
const stranger = client();
const miskin = client();

for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const ready = await fetch(`${base}/health`); if (ready.ok) break; } catch { /* belum siap */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), data di ${dataDir}`);

async function register(account: ReturnType<typeof client>, email: string, name: string) {
  await account.bootstrap();
  return account.call("POST", "/api/v1/auth/register", { email, password, displayName: name });
}

/** Bahan penilaian yang cukup panjang supaya biaya tokennya nyata dan tidak dibulatkan jadi nol. */
const MATERI = [
  "function hitungTotal(baris) {",
  "  let total = 0;",
  "  for (const satu of baris) { total = total + satu.harga * satu.jumlah; }",
  "  return total;",
  "}",
  "Catatan: fungsi ini tidak memeriksa apakah harga atau jumlah bernilai kosong,",
  "tidak menangani galat basis data, dan menulis pesan galat mentah ke log aplikasi.",
  "Bagian rahasia disimpan di berkas yang sama dan ikut terekam di dalam log permintaan.",
].join("\n");
const MATERI_PANJANG = `${MATERI}\n${MATERI}\n${MATERI}\n${MATERI.repeat(6)}`;
const PERTANYAAN = "Apakah materi ini layak dipakai produksi, dan apa satu risiko terbesarnya?";

/* =====================================================================================
 * Bagian 0: akun, proyek, dan bukti bahwa harga yang dipakai nyata.
 * ===================================================================================== */
console.log("\n--- Bagian 0: akun, proyek, dan bahan uji ---");
const ownerReg = await register(owner, ownerEmail, "Pemilik Wave 11B");
const ownerUserId = String(ownerReg.json?.user?.id ?? "");
const ownerWorkspaceId = String(ownerReg.json?.workspace?.id ?? ownerReg.json?.workspaceId ?? "");
check("0a. akun pemilik terdaftar beserta ruang kerja", ownerReg.status === 201 && Boolean(ownerUserId && ownerWorkspaceId), `${ownerReg.status} ${short(ownerReg.json)}`);

const projectReply = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`, { name: "Proyek Dewan Juri" });
const projectId = String(projectReply.json?.id ?? "");
check("0b. proyek pemilik dibuat", projectReply.status === 201 && Boolean(projectId), `${projectReply.status} ${short(projectReply.json)}`);

const harga = [MODEL_A, MODEL_B, MODEL_C].map((model) => ({ model, sumber: priceView(model).source, jual: quoteCosts(model, { inputTokens: 1000, outputTokens: 256, cacheReadTokens: 0, cacheWriteTokens: 0 }).sellMicros }));
check("0c. tiga model uji punya harga nyata di katalog (bukan nol dan bukan tanpa harga)", harga.every((row) => row.sumber !== "none" && typeof row.jual === "number" && row.jual > 0), short(harga));
check("0d. model tanpa harga dikenali sebagai tanpa harga", priceView(MODEL_TIDAK_ADA).source === "none", short(priceView(MODEL_TIDAK_ADA)));
check("0e. skema basis data sudah memuat tabel dewan juri dan benchmark", (SCHEMA_VERSION as number) >= 20
  && hitung("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('council_runs','council_verdicts','benchmark_runs','benchmark_results')") === 4, short(`${SCHEMA_VERSION} (>= 20)`));

const viewerReg = await register(viewer, viewerEmail, "Pengamat Wave 11B");
const viewerUserId = String(viewerReg.json?.user?.id ?? "");
db.prepare("INSERT OR REPLACE INTO memberships (user_id, workspace_id, role, created_at) VALUES (?,?,?,?)")
  .run(viewerUserId, ownerWorkspaceId, "viewer", new Date().toISOString());
const viewerRole = String(satu("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?", ownerWorkspaceId, viewerUserId)?.role ?? "");
check("0f. akun viewer jadi anggota ruang kerja pemilik dengan peran viewer", viewerReg.status === 201 && viewerRole === "viewer", short({ status: viewerReg.status, viewerRole }));

const strangerReg = await register(stranger, strangerEmail, "Orang Luar Wave 11B");
const strangerUserId = String(strangerReg.json?.user?.id ?? "");
const proyekStranger = hitung("SELECT COUNT(*) AS n FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?", strangerUserId);
check("0g. akun luar terdaftar dan belum punya proyek (untuk uji PROJECT_REQUIRED)", strangerReg.status === 201 && proyekStranger === 0, short({ status: strangerReg.status, proyekStranger }));

const convReply = await owner.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Diskusi Dewan" });
const conversationId = String(convReply.json?.conversation?.id ?? convReply.json?.id ?? "");
check("0h. percakapan proyek dibuat (untuk uji jangkar proyek)", convReply.status === 201 && Boolean(conversationId), `${convReply.status} ${short(convReply.json)}`);

/* =====================================================================================
 * Bagian 1: butir 58 - dewan juri lewat HTTP.
 * ===================================================================================== */
console.log("\n--- Bagian 1: dewan juri (butir 58) ---");

const tanpaMateri = await owner.call("POST", "/api/v1/council/run", { question: PERTANYAAN, jurors: [MODEL_A] });
check("C1. materi kosong -> 400 COUNCIL_MATERIAL_REQUIRED", tanpaMateri.status === 400 && tanpaMateri.json?.error === "COUNCIL_MATERIAL_REQUIRED", `${tanpaMateri.status} ${short(tanpaMateri.json)}`);

const tanpaPertanyaan = await owner.call("POST", "/api/v1/council/run", { material: MATERI, jurors: [MODEL_A] });
check("C2. pertanyaan kosong -> 400 COUNCIL_QUESTION_REQUIRED", tanpaPertanyaan.status === 400 && tanpaPertanyaan.json?.error === "COUNCIL_QUESTION_REQUIRED", `${tanpaPertanyaan.status} ${short(tanpaPertanyaan.json)}`);

const juriKebanyakan = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A, MODEL_B, MODEL_C, "model-keempat"] });
check(`C3. juri melebihi COUNCIL_MAX_JURORS (${config.COUNCIL_MAX_JURORS}) -> 400 COUNCIL_JUROR_LIMIT`, juriKebanyakan.status === 400 && juriKebanyakan.json?.error === "COUNCIL_JUROR_LIMIT", `${juriKebanyakan.status} ${short(juriKebanyakan.json)}`);

const juriKosong = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A, "  "] });
check("C4. nama juri kosong -> 400 INVALID_JUROR", juriKosong.status === 400 && juriKosong.json?.error === "INVALID_JUROR", `${juriKosong.status} ${short(juriKosong.json)}`);

const juriGanda = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A, MODEL_A] });
check("C5. juri yang sama dua kali -> 400 INVALID_JUROR", juriGanda.status === 400 && juriGanda.json?.error === "INVALID_JUROR", `${juriGanda.status} ${short(juriGanda.json)}`);

const juriTerlaluPanjang = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: ["x".repeat(200)] });
check("C6. nama juri terlalu panjang -> 400 INVALID_JUROR", juriTerlaluPanjang.status === 400 && juriTerlaluPanjang.json?.error === "INVALID_JUROR", `${juriTerlaluPanjang.status} ${short(juriTerlaluPanjang.json)}`);

const materiTerlaluPanjang = await owner.call("POST", "/api/v1/council/run", { material: "a".repeat(200_001), question: PERTANYAAN, jurors: [MODEL_A] });
check("C7. materi melebihi batas -> 400 COUNCIL_MATERIAL_TOO_LONG", materiTerlaluPanjang.status === 400 && materiTerlaluPanjang.json?.error === "COUNCIL_MATERIAL_TOO_LONG", `${materiTerlaluPanjang.status} ${short(materiTerlaluPanjang.json)}`);

const convAsing = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A], conversationId: `tidak-ada-${stamp}` });
check("C8. percakapan asing -> 404 CONVERSATION_NOT_FOUND", convAsing.status === 404 && convAsing.json?.error === "CONVERSATION_NOT_FOUND", `${convAsing.status} ${short(convAsing.json)}`);

const proyekAsing = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A], projectId: `proyek-tidak-ada-${stamp}` });
check("C9. proyek asing -> 404 PROJECT_NOT_FOUND", proyekAsing.status === 404 && proyekAsing.json?.error === "PROJECT_NOT_FOUND", `${proyekAsing.status} ${short(proyekAsing.json)}`);

const viewerDewan = await viewer.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A], conversationId });
check("C10. peran viewer -> 403 VIEWER_FORBIDDEN", viewerDewan.status === 403 && viewerDewan.json?.error === "VIEWER_FORBIDDEN", `${viewerDewan.status} ${short(viewerDewan.json)}`);

const viewerProyek = await viewer.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A] });
check("C11. viewer tanpa conversationId tetap -> 403 VIEWER_FORBIDDEN", viewerProyek.status === 403 && viewerProyek.json?.error === "VIEWER_FORBIDDEN", `${viewerProyek.status} ${short(viewerProyek.json)}`);

const strangerDewan = await stranger.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A] });
check("C12. akun tanpa proyek -> 400 PROJECT_REQUIRED", strangerDewan.status === 400 && strangerDewan.json?.error === "PROJECT_REQUIRED", `${strangerDewan.status} ${short(strangerDewan.json)}`);

const perkiraanReply = await owner.call("POST", "/api/v1/council/estimate", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A, MODEL_B] });
const perkiraanSebelum = Number(perkiraanReply.json?.perkiraanBiayaMicros ?? -1);
const perkiraanUlang = await owner.call("POST", "/api/v1/council/estimate", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A, MODEL_B] });
const councilSebelum = hitung("SELECT COUNT(*) AS n FROM council_runs WHERE user_id=?", ownerUserId);
const runSebelum = hitung("SELECT COUNT(*) AS n FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?", ownerUserId);
check("C13. perkiraan biaya tersedia SEBELUM jalan dan tidak menulis apa pun", perkiraanReply.status === 200 && perkiraanSebelum > 0
  && Number(perkiraanUlang.json?.perkiraanBiayaMicros) === perkiraanSebelum && councilSebelum === 0 && runSebelum === 0,
  short({ status: perkiraanReply.status, perkiraanSebelum, councilSebelum, runSebelum, badan: perkiraanReply.json }));

const perkiraanBawaan = await owner.call("POST", "/api/v1/council/estimate", { material: MATERI, question: PERTANYAAN });
check("C14. tanpa daftar juri, perkiraan memakai model bawaan akun", perkiraanBawaan.status === 200
  && Array.isArray(perkiraanBawaan.json?.jurors) && perkiraanBawaan.json.jurors.length === 1 && perkiraanBawaan.json.jurors[0] === MODEL_A
  && Number(perkiraanBawaan.json?.perkiraanBiayaMicros) > 0, short(perkiraanBawaan.json));

const jalan = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A, MODEL_B], conversationId });
const councilRunId = String(jalan.json?.councilRunId ?? "");
check("C15. dewan juri dijalankan -> 202 dengan id dan status completed", jalan.status === 202 && Boolean(councilRunId) && jalan.json?.status === "completed", `${jalan.status} ${short(jalan.json)}`);
check("C16. perkiraan di balasan 202 sama dengan perkiraan yang dilihat sebelum jalan", Number(jalan.json?.perkiraanBiayaMicros ?? -1) === perkiraanSebelum, short({ sebelum: perkiraanSebelum, sesudah: jalan.json?.perkiraanBiayaMicros }));

const barisVerdict = semua("SELECT juror, verdict, score, notes, run_id AS runId, cost_micros AS costMicros, error_code AS errorCode FROM council_verdicts WHERE council_run_id=? ORDER BY created_at, id", councilRunId);
check("C17. satu baris verdict per juri, masing-masing dengan run_id sendiri", barisVerdict.length === 2
  && barisVerdict.every((row) => Boolean(row.runId)) && new Set(barisVerdict.map((row) => row.runId)).size === 2, short(barisVerdict));

const barisRun = barisVerdict.map((row) => satu("SELECT id, status, model, prompt, result FROM runs WHERE id=?", row.runId));
check("C18. setiap juri benar-benar satu run nyata yang selesai dan memuat materi", barisRun.length === 2
  && barisRun.every((row) => row?.status === "completed" && String(row?.prompt ?? "").includes(MATERI.slice(0, 60))),
  short(barisRun.map((row) => ({ id: row?.id, status: row?.status, model: row?.model }))));

const pemakaian = semua(`SELECT v.juror AS juror, COALESCE(SUM(u.input_tokens),0) AS inputTokens, COALESCE(SUM(u.output_tokens),0) AS outputTokens,
    COALESCE(SUM(u.cost_micros),0) AS biayaDasar, COALESCE(SUM(u.sell_cost_micros),0) AS biayaJual
  FROM council_verdicts v JOIN run_usage u ON u.run_id=v.run_id WHERE v.council_run_id=? GROUP BY v.juror`, councilRunId);
check("C19. setiap juri punya pemakaian token nyata dan biaya jual lebih dari nol", pemakaian.length === 2
  && pemakaian.every((row) => Number(row.inputTokens) > 0 && Number(row.biayaJual) > 0), short(pemakaian));

const detail = await owner.call("GET", `/api/v1/council/runs/${councilRunId}`);
const totalJual = barisVerdict.reduce((total, row) => total + Number(row.costMicros), 0);
check("C20. GET hasil -> 200 dengan biaya SESUDAH jalan sebesar jumlah biaya tiap juri", detail.status === 200
  && Number(detail.json?.costMicros) === totalJual && totalJual > 0, short({ status: detail.status, costMicros: detail.json?.costMicros, totalJual }));
check("C21. hasil lengkap memuat verdict, catatan biaya, dan jumlah juri yang gagal = 0", detail.status === 200
  && Array.isArray(detail.json?.verdicts) && detail.json.verdicts.length === 2
  && String(detail.json?.catatan ?? "").includes("Biaya nyata") && detail.json?.verdicts.every((row: any) => row.errorCode === null),
  short(detail.json?.catatan));
check("C22. biaya nyata lebih kecil dari perkiraan dan selisihnya dijelaskan di catatan", Number(detail.json?.costMicros) < perkiraanSebelum
  && String(detail.json?.catatan ?? "").includes("lebih murah dari perkiraan"), short({ nyata: detail.json?.costMicros, perkiraan: perkiraanSebelum }));

const verdictJuri = barisVerdict.map((row) => row.verdict);
check("C23. jawaban mock tanpa verdict TIDAK ditebak dari kata kunci di prompt", verdictJuri.every((nilai) => nilai === "tidak-terbaca")
  && String(detail.json?.summary ?? "").includes("Tidak ada suara yang terbaca"), short({ verdictJuri, summary: detail.json?.summary }));
check("C24. ringkasan dewan mencatat skor kosong sebagai apa adanya", barisVerdict.every((row) => row.score === null), short(barisVerdict.map((row) => row.score)));

const daftar = await owner.call("GET", "/api/v1/council/runs");
check("C25. daftar dewan memuat hasil terakhir beserta jumlah verdict dan juri gagal", daftar.status === 200
  && Array.isArray(daftar.json?.runs) && daftar.json.runs.some((row: any) => row.id === councilRunId && Number(row.verdictCount) === 2 && Number(row.failedCount) === 0),
  short({ status: daftar.status, jumlah: daftar.json?.runs?.length }));

const daftarStranger = await stranger.call("GET", "/api/v1/council/runs");
check("C26. akun lain tidak melihat dewan juri milik pemilik", daftarStranger.status === 200
  && Array.isArray(daftarStranger.json?.runs) && daftarStranger.json.runs.length === 0, short(daftarStranger.json));

const detailAsing = await stranger.call("GET", `/api/v1/council/runs/${councilRunId}`);
check("C27. akun lain membuka hasil dewan -> 404 COUNCIL_NOT_FOUND", detailAsing.status === 404 && detailAsing.json?.error === "COUNCIL_NOT_FOUND", `${detailAsing.status} ${short(detailAsing.json)}`);

const tanpaJuri = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, projectId });
const barisBawaan = semua("SELECT juror, run_id AS runId FROM council_verdicts WHERE council_run_id=?", String(tanpaJuri.json?.councilRunId ?? ""));
check("C28. tanpa daftar juri, dewan memakai satu juri bawaan dan catatannya berterus terang", tanpaJuri.status === 202
  && barisBawaan.length === 1 && barisBawaan[0].juror === MODEL_A && String(tanpaJuri.json?.catatan ?? "").includes("bawaan"),
  short({ status: tanpaJuri.status, barisBawaan, catatan: tanpaJuri.json?.catatan }));

/* --- juri gagal tidak merobohkan dewan ------------------------------------------------ */
process.env.MOCK_ENGINE_FAIL_MODELS = MODEL_B;
process.env.MOCK_ENGINE_FAIL_TEXT = "MODEL_UNKNOWN model cadangan tidak tersedia";
const sebagianGagal = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A, MODEL_B], projectId });
const idSebagian = String(sebagianGagal.json?.councilRunId ?? "");
const barisSebagian = semua("SELECT juror, verdict, run_id AS runId, error_code AS errorCode, cost_micros AS costMicros FROM council_verdicts WHERE council_run_id=? ORDER BY created_at, id", idSebagian);
check("C29. satu juri gagal: status dewan tetap completed dan juri lain tetap dinilai", sebagianGagal.status === 202
  && sebagianGagal.json?.status === "completed" && barisSebagian.length === 2
  && barisSebagian.some((row) => row.juror === MODEL_A && row.errorCode === null)
  && barisSebagian.some((row) => row.juror === MODEL_B && row.errorCode === "MODEL_UNKNOWN"),
  short({ status: sebagianGagal.json?.status, barisSebagian }));
const runGagal = satu("SELECT id, status, error_code AS errorCode FROM runs WHERE id=?", (barisSebagian.find((row) => row.juror === MODEL_B) ?? {}).runId);
check("C30. juri gagal tetap meninggalkan run nyata berstatus failed dengan kode galat", runGagal?.status === "failed" && String(runGagal?.errorCode ?? "").includes("MODEL_UNKNOWN"), short(runGagal));
check("C31. ringkasan dewan menyebut juri yang gagal apa adanya", String(sebagianGagal.json?.summary ?? "").includes(`Juri gagal: ${MODEL_B}`)
  && String(sebagianGagal.json?.summary ?? "").includes("MODEL_UNKNOWN"), short(sebagianGagal.json?.summary));

const semuaGagal = await owner.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_B], projectId });
check("C32. semua juri gagal -> status dewan failed dan biaya nyata nol", semuaGagal.status === 202 && semuaGagal.json?.status === "failed"
  && Number(semuaGagal.json?.costMicros) === 0 && Number(semuaGagal.json?.perkiraanBiayaMicros) > 0,
  short({ status: semuaGagal.json?.status, costMicros: semuaGagal.json?.costMicros, perkiraan: semuaGagal.json?.perkiraanBiayaMicros }));
const detailGagal = await owner.call("GET", `/api/v1/council/runs/${String(semuaGagal.json?.councilRunId ?? "")}`);
check("C33. hasil dewan yang gagal seluruhnya tetap bisa dibaca beserta alasannya", detailGagal.status === 200
  && detailGagal.json?.status === "failed" && Number(detailGagal.json?.costMicros) === 0
  && detailGagal.json?.verdicts?.every((row: any) => row.errorCode !== null), short({ status: detailGagal.status, badan: detailGagal.json?.status }));
delete process.env.MOCK_ENGINE_FAIL_MODELS;
delete process.env.MOCK_ENGINE_FAIL_TEXT;

/* --- jejak audit ---------------------------------------------------------------------- */
check("C34. tindakan dewan juri tercatat di jejak audit", hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='council.run_started'") > 0
  && hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='council.run_finished'") > 0,
  short({ mulai: hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='council.run_started'"), selesai: hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='council.run_finished'") }));

/* =====================================================================================
 * Bagian 1b: butir 58 - pembacaan verdict dan batas paralel (unit dalam proses).
 * ===================================================================================== */
console.log("\n--- Bagian 1b: pembacaan verdict + batas paralel (butir 58) ---");

const baca = councilMod.bacaVerdictJuri as (nilai: unknown) => { verdict: string; score: number | null; notes: string };
const contoh = baca('Pendapat saya begini. {"verdict":"setuju","score":88,"notes":"Risiko kecil dan sudah ada uji."} Terima kasih.');
check("U1. verdict JSON yang sah dibaca lengkap dengan skor dan catatan", contoh.verdict === "setuju" && contoh.score === 88 && contoh.notes.includes("Risiko kecil"), short(contoh));
const contohAlias = baca('{"putusan":"MENOLAK","skor":"40","catatan":"Masih ada galat yang ditelan."}');
check("U2. sinonim kunci dan huruf besar dibaca sebagai menolak", contohAlias.verdict === "menolak" && contohAlias.score === 40, short(contohAlias));
const contohRagu = baca('{"verdict":"tidak yakin","score":150}');
check("U3. verdict ragu dikenali dan skor di luar 0-100 dipotong ke batas", contohRagu.verdict === "ragu" && contohRagu.score === 100, short(contohRagu));
const contohKosong = baca("Menurut saya kode ini setuju saja, tidak ada masalah.");
check("U4. jawaban tanpa objek JSON BUKAN ditebak dari kata kunci", contohKosong.verdict === "tidak-terbaca" && contohKosong.score === null
  && contohKosong.notes.includes("tidak-terbaca") === false && contohKosong.notes.includes("setuju"), short(contohKosong));
const contohRusak = baca('{"verdict":"setuju", "score":}');
check("U5. JSON rusak tidak membuat rute meledak, hanya dilaporkan apa adanya", contohRusak.verdict === "tidak-terbaca", short(contohRusak));
const ringkas = councilMod.ringkasDewan as (baris: any[]) => string;
const ringkasMayoritas = ringkas([
  { juror: "a", verdict: "setuju", score: 80, errorCode: null },
  { juror: "b", verdict: "setuju", score: 90, errorCode: null },
  { juror: "c", verdict: "menolak", score: 20, errorCode: null },
]);
check("U6. ringkasan menghitung suara dan menyebut mayoritas", ringkasMayoritas.includes("Mayoritas menyatakan setuju") && ringkasMayoritas.includes("Rata-rata skor 63"), short(ringkasMayoritas));
const ringkasSeri = ringkas([
  { juror: "a", verdict: "setuju", score: null, errorCode: null },
  { juror: "b", verdict: "menolak", score: null, errorCode: null },
]);
check("U7. ringkasan menyebut seri tanpa mengarang pemenang", ringkasSeri.includes("Tidak ada mayoritas mutlak"), short(ringkasSeri));

const jalankanBersamaan = councilMod.jalankanBerurutanBersamaan as <T, R>(nilai: T[], batas: number, kerja: (item: T, index: number) => Promise<R>) => Promise<R[]>;
let aktif = 0; let puncak = 0;
const urutan: number[] = [];
await jalankanBersamaan([1, 2, 3, 4, 5], config.COUNCIL_MAX_PARALLEL, async (nilai, index) => {
  aktif += 1; puncak = Math.max(puncak, aktif);
  await new Promise((resolve) => setTimeout(resolve, 25));
  urutan.push(nilai); aktif -= 1;
  return index;
});
check(`U8. pekerjaan berjalan per gelombang maksimal COUNCIL_MAX_PARALLEL (${config.COUNCIL_MAX_PARALLEL})`, puncak === config.COUNCIL_MAX_PARALLEL
  && urutan.join(",") === "1,2,3,4,5", short({ puncak, urutan: urutan.join(",") }));

const proyekTerselesaikan = councilMod.selesaikanProyek as (userId: string, projectId: unknown, conversationId: unknown) => any;
check("U9. jangkar proyek: percakapan milik sendiri menghasilkan proyek percakapan itu", proyekTerselesaikan(ownerUserId, undefined, conversationId).projectId === projectId,
  short(proyekTerselesaikan(ownerUserId, undefined, conversationId)));
check("U10. jangkar proyek: viewer ditolak sebelum run dibuat", proyekTerselesaikan(viewerUserId, undefined, conversationId).error === "viewer",
  short(proyekTerselesaikan(viewerUserId, undefined, conversationId)));

/* =====================================================================================
 * Bagian 3: butir 58 - kuota token.
 * ===================================================================================== */
console.log("\n--- Bagian 3: kuota token pada dewan juri ---");
const miskinReg = await register(miskin, miskinEmail, "Akun Kuota Wave 11B");
const miskinUserId = String(miskinReg.json?.user?.id ?? "");
const miskinWorkspaceId = String(miskinReg.json?.workspace?.id ?? miskinReg.json?.workspaceId ?? "");
const miskinProyekReply = await miskin.call("POST", `/api/v1/workspaces/${miskinWorkspaceId}/projects`, { name: "Proyek Kuota" });
const miskinProjectId = String(miskinProyekReply.json?.id ?? "");
check("Q1. akun uji kuota terdaftar beserta proyeknya", miskinReg.status === 201 && Boolean(miskinUserId && miskinProjectId), short({ status: miskinReg.status, miskinProjectId }));

const kuotaAwal = quotaState(miskinUserId);
const batasHarian = Number(kuotaAwal.dailyLimit) + Number(kuotaAwal.creditTokens);
const runKuotaId = `kuota-${stamp}`;
const sekarang = new Date().toISOString();
db.prepare("INSERT INTO runs (id,project_id,status,prompt,created_at) VALUES (?,?,'completed','pemakaian uji kuota',?)").run(runKuotaId, miskinProjectId, sekarang);
db.prepare(`INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,total_tokens,cost_micros,sell_cost_micros,estimated,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`usage-${stamp}`, runKuotaId, miskinProjectId, MODEL_A, null, batasHarian - 120, 0, batasHarian - 120, 0, 0, 0, sekarang);
const kuotaHampir = quotaState(miskinUserId);
check("Q2. akun uji berada tepat di bawah batas kuota harian dan belum diblokir (bukan admin)",
  kuotaHampir.blocked === false && Number(kuotaHampir.usedToday) >= batasHarian - 200 && batasHarian > 0,
  short({ blocked: kuotaHampir.blocked, usedToday: kuotaHampir.usedToday, batasHarian, tier: kuotaHampir.tier }));

const dewanHemat = await miskin.call("POST", "/api/v1/council/estimate", { material: MATERI_PANJANG, question: PERTANYAAN, jurors: [MODEL_A, MODEL_B, MODEL_C] });
check("Q3. perkiraan biaya tetap boleh dihitung saat kuota hampir habis", dewanHemat.status === 200 && Number(dewanHemat.json?.perkiraanBiayaMicros) > 0, short(dewanHemat.json));

// Tiga juri dipakai supaya ada dua gelombang: gelombang pertama menghabiskan sisa kuota, lalu
// pemeriksaan kuota sebelum juri gelombang kedua berjalan. Juri di dalam satu gelombang berjalan
// bersamaan, jadi pemeriksaan mereka terjadi pada saat yang sama.
const dewanBatas = await miskin.call("POST", "/api/v1/council/run", { material: MATERI_PANJANG, question: PERTANYAAN, jurors: [MODEL_A, MODEL_B, MODEL_C] });
const barisBatas = semua("SELECT juror, run_id AS runId, error_code AS errorCode, notes FROM council_verdicts WHERE council_run_id=? ORDER BY created_at, id", String(dewanBatas.json?.councilRunId ?? ""));
const juriJalan = barisBatas.filter((row) => row.errorCode === null);
const juriLewat = barisBatas.filter((row) => row.errorCode === "QUOTA_EXCEEDED");
check("Q4. gelombang pertama tetap jalan, juri di gelombang berikutnya dilewati karena kuota habis di tengah dewan", dewanBatas.status === 202
  && dewanBatas.json?.status === "completed" && juriJalan.length === config.COUNCIL_MAX_PARALLEL && juriLewat.length === 1 && juriLewat[0].runId === null,
  short({ status: dewanBatas.json?.status, barisBatas }));
check("Q5. juri yang dilewati tidak membuat run baru (tidak dibebani biaya)", hitung("SELECT COUNT(*) AS n FROM runs WHERE id IN (SELECT run_id FROM council_verdicts WHERE council_run_id=? AND run_id IS NOT NULL)", String(dewanBatas.json?.councilRunId ?? "")) === config.COUNCIL_MAX_PARALLEL,
  short(semua("SELECT run_id AS runId FROM council_verdicts WHERE council_run_id=?", String(dewanBatas.json?.councilRunId ?? ""))));

const dewanHabis = await miskin.call("POST", "/api/v1/council/run", { material: MATERI, question: PERTANYAAN, jurors: [MODEL_A] });
check("Q6. kuota habis sebelum jalan -> 429 DAILY_TOKEN_QUOTA_EXCEEDED tanpa membuat dewan baru",
  dewanHabis.status === 429 && String(dewanHabis.json?.error ?? "").includes("QUOTA_EXCEEDED")
  && hitung("SELECT COUNT(*) AS n FROM council_runs WHERE user_id=? AND status='running'", miskinUserId) === 0,
  `${dewanHabis.status} ${short(dewanHabis.json)}`);

/* =====================================================================================
 * Bagian 4: butir 61 - benchmark lewat HTTP.
 * ===================================================================================== */
console.log("\n--- Bagian 4: benchmark (butir 61) ---");

const soalBerkas = JSON.parse(readFileSync(new URL("../benchmark/questions.json", import.meta.url), "utf8")) as { questions: { id: string; text: string }[] };
check("B1. berkas soal benchmark ada, berbentuk benar, maksimal 10 soal, dan id-nya unik", Array.isArray(soalBerkas.questions)
  && soalBerkas.questions.length > 0 && soalBerkas.questions.length <= 10
  && soalBerkas.questions.every((row) => typeof row.id === "string" && row.id.length > 0 && typeof row.text === "string" && row.text.length > 10)
  && new Set(soalBerkas.questions.map((row) => row.id)).size === soalBerkas.questions.length, short(soalBerkas.questions.map((row) => row.id)));
check("B2. pemuat soal memotong daftar pada batas yang diminta dan pada batas platform", (benchMod.loadBenchmarkQuestions(3) as any[]).length === 3
  && (benchMod.loadBenchmarkQuestions(999) as any[]).length === Math.min(10, soalBerkas.questions.length), short(soalBerkas.questions.length));

const estTanpaModel = await owner.call("POST", "/api/v1/benchmark/estimate", {});
check("B3. perkiraan tanpa model -> 400 MODEL_REQUIRED", estTanpaModel.status === 400 && estTanpaModel.json?.error === "MODEL_REQUIRED", `${estTanpaModel.status} ${short(estTanpaModel.json)}`);
const estModelKebanyakan = await owner.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_A, MODEL_B, MODEL_C, MODEL_A] });
check(`B4. model melebihi BENCHMARK_MAX_MODELS (${config.BENCHMARK_MAX_MODELS}) -> 400 BENCHMARK_MODEL_LIMIT`, estModelKebanyakan.status === 400 && estModelKebanyakan.json?.error === "BENCHMARK_MODEL_LIMIT", `${estModelKebanyakan.status} ${short(estModelKebanyakan.json)}`);
const estModelAneh = await owner.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_TIDAK_ADA] });
check("B5. model tanpa harga di katalog -> 400 INVALID_MODEL", estModelAneh.status === 400 && estModelAneh.json?.error === "INVALID_MODEL", `${estModelAneh.status} ${short(estModelAneh.json)}`);
const estModelGanda = await owner.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_A, MODEL_A] });
check("B6. model yang sama dua kali -> 400 INVALID_MODEL", estModelGanda.status === 400 && estModelGanda.json?.error === "INVALID_MODEL", `${estModelGanda.status} ${short(estModelGanda.json)}`);

const estReply = await owner.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_A, MODEL_B] });
const perkiraanBench = Number(estReply.json?.perkiraanBiayaMicros ?? -1);
const benchmarkSebelum = hitung("SELECT COUNT(*) AS n FROM benchmark_runs WHERE user_id=?", ownerUserId);
check("B7. perkiraan benchmark 200, lebih dari nol, memuat rincian per model, dan tidak menulis apa pun", estReply.status === 200
  && perkiraanBench > 0 && Number(estReply.json?.questionCount) === 10 && Array.isArray(estReply.json?.perModel) && estReply.json.perModel.length === 2
  && benchmarkSebelum === 0, short({ status: estReply.status, perkiraanBench, questionCount: estReply.json?.questionCount, benchmarkSebelum }));

const runTanpaPerkiraan = await owner.call("POST", "/api/v1/benchmark/run", { models: [MODEL_A] });
check("B8. jalan tanpa angka perkiraan -> 400 ESTIMATE_REQUIRED", runTanpaPerkiraan.status === 400 && runTanpaPerkiraan.json?.error === "ESTIMATE_REQUIRED", `${runTanpaPerkiraan.status} ${short(runTanpaPerkiraan.json)}`);
const runPerkiraanSalah = await owner.call("POST", "/api/v1/benchmark/run", { models: [MODEL_A, MODEL_B], estimatedCostMicros: perkiraanBench + 1 });
check("B9. angka perkiraan tidak cocok -> 400 ESTIMATE_MISMATCH beserta perkiraan sekarang", runPerkiraanSalah.status === 400
  && runPerkiraanSalah.json?.error === "ESTIMATE_MISMATCH" && Number(runPerkiraanSalah.json?.perkiraanSekarang) === perkiraanBench,
  `${runPerkiraanSalah.status} ${short(runPerkiraanSalah.json)}`);
const estReplyMiskin = await stranger.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_A] });
const runTanpaProyek = await stranger.call("POST", "/api/v1/benchmark/run", { models: [MODEL_A], estimatedCostMicros: Number(estReplyMiskin.json?.perkiraanBiayaMicros ?? 0) });
check("B10. akun tanpa proyek -> 400 PROJECT_REQUIRED (bukan menjalankan panggilan berbayar)", runTanpaProyek.status === 400 && runTanpaProyek.json?.error === "PROJECT_REQUIRED", `${runTanpaProyek.status} ${short(runTanpaProyek.json)}`);

const runBench = await owner.call("POST", "/api/v1/benchmark/run", { models: [MODEL_A, MODEL_B], estimatedCostMicros: perkiraanBench });
const benchmarkRunId = String(runBench.json?.benchmarkRunId ?? "");
check("B11. benchmark dijalankan -> 202 dengan status completed dan angka perkiraan tersimpan", runBench.status === 202
  && Boolean(benchmarkRunId) && runBench.json?.status === "completed" && Number(runBench.json?.estimatedCostMicros) === perkiraanBench,
  `${runBench.status} ${short(runBench.json)}`);

const hasilBench = semua("SELECT id, model, question_id AS questionId, answer, score, latency_ms AS latencyMs, cost_micros AS costMicros, error_code AS errorCode FROM benchmark_results WHERE benchmark_run_id=? ORDER BY model, question_id", benchmarkRunId);
check("B12. satu baris hasil untuk tiap pasangan (model x soal)", hasilBench.length === 20
  && new Set(hasilBench.map((row) => `${row.model}|${row.questionId}`)).size === 20, short({ jumlah: hasilBench.length }));
check("B13. setiap hasil terisi jawaban, skor, waktu, dan biaya lebih dari nol", hasilBench.every((row) => String(row.answer ?? "").length > 0
  && typeof row.score === "number" && Number(row.latencyMs) >= 0 && Number(row.costMicros) > 0 && row.errorCode === null),
  short(hasilBench.slice(0, 2)));
check("B14. skor kesepakatan 100 karena dua model mock menerima prompt yang sama", hasilBench.every((row) => row.score === 100), short(hasilBench.map((row) => row.score).slice(0, 5)));

const satuRunBenchmark = hitung("SELECT COUNT(*) AS n FROM runs WHERE prompt LIKE ?", `Benchmark ${benchmarkRunId} - %`);
const usageBenchmark = satu(`SELECT COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(cost_micros),0) AS biayaDasar, COALESCE(SUM(sell_cost_micros),0) AS biayaJual,
    COUNT(*) AS baris FROM run_usage WHERE run_id=(SELECT id FROM runs WHERE prompt LIKE ?)`, `Benchmark ${benchmarkRunId} - %`);
check("B15. satu run induk menampung seluruh pemakaian token benchmark", satuRunBenchmark === 1 && Number(usageBenchmark.baris) === 20
  && Number(usageBenchmark.inputTokens) > 0 && Number(usageBenchmark.biayaJual) > 0, short({ satuRunBenchmark, usageBenchmark }));

const detailBench = await owner.call("GET", `/api/v1/benchmark/runs/${benchmarkRunId}`);
const totalBiayaHasil = hasilBench.reduce((total, row) => total + Number(row.costMicros), 0);
check("B16. GET hasil benchmark -> 200 dengan biaya sama dengan jumlah biaya tiap pasangan", detailBench.status === 200
  && Number(detailBench.json?.costMicros) === totalBiayaHasil && detailBench.json?.results?.length === 20, short({ status: detailBench.status, costMicros: detailBench.json?.costMicros, totalBiayaHasil }));
check("B17. ringkasan per model memuat jumlah dijawab, gagal, biaya, dan rata-rata waktu", detailBench.status === 200
  && Array.isArray(detailBench.json?.ringkasan?.perModel) && detailBench.json.ringkasan.perModel.length === 2
  && detailBench.json.ringkasan.perModel.every((row: any) => row.dijawab === 10 && row.gagal === 0 && row.biayaMicros > 0 && typeof row.rataLatencyMs === "number"),
  short(detailBench.json?.ringkasan));
check("B18. catatan hasil menjelaskan selisih biaya nyata vs perkiraan apa adanya", String(detailBench.json?.catatan ?? "").includes("Biaya nyata")
  && String(detailBench.json?.catatan ?? "").includes("lebih murah dari perkiraan") && Number(detailBench.json?.estimatedCostMicros) === perkiraanBench,
  short(detailBench.json?.catatan));

const detailAsingBench = await stranger.call("GET", `/api/v1/benchmark/runs/${benchmarkRunId}`);
check("B19. akun lain membuka hasil benchmark -> 404 BENCHMARK_NOT_FOUND", detailAsingBench.status === 404 && detailAsingBench.json?.error === "BENCHMARK_NOT_FOUND", `${detailAsingBench.status} ${short(detailAsingBench.json)}`);

process.env.MOCK_ENGINE_FAIL_MODELS = MODEL_B;
process.env.MOCK_ENGINE_FAIL_TEXT = "MODEL_UNKNOWN model cadangan tidak tersedia";
const estSebagian = await owner.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_A, MODEL_B] });
const runSebagian = await owner.call("POST", "/api/v1/benchmark/run", { models: [MODEL_A, MODEL_B], estimatedCostMicros: Number(estSebagian.json?.perkiraanBiayaMicros ?? -1) });
const idSebagianBench = String(runSebagian.json?.benchmarkRunId ?? "");
const hasilSebagian = semua("SELECT model, error_code AS errorCode, cost_micros AS costMicros FROM benchmark_results WHERE benchmark_run_id=?", idSebagianBench);
check("B20. satu model gagal: status tetap completed dan model lain tetap dinilai", runSebagian.status === 202
  && runSebagian.json?.status === "completed" && hasilSebagian.filter((row) => row.errorCode === null).length === 10
  && hasilSebagian.filter((row) => row.errorCode === "MODEL_UNKNOWN").length === 10,
  short({ status: runSebagian.json?.status, ringkasan: runSebagian.json?.ringkasan }));
check("B21. ringkasan per model memisahkan yang gagal dan yang dijawab", Array.isArray(runSebagian.json?.ringkasan)
  && runSebagian.json.ringkasan.some((row: any) => row.model === MODEL_B && row.gagal === 10 && row.dijawab === 0)
  && runSebagian.json.ringkasan.some((row: any) => row.model === MODEL_A && row.dijawab === 10), short(runSebagian.json?.ringkasan));

const estSemuaGagal = await owner.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_B] });
const runSemuaGagal = await owner.call("POST", "/api/v1/benchmark/run", { models: [MODEL_B], estimatedCostMicros: Number(estSemuaGagal.json?.perkiraanBiayaMicros ?? -1) });
check("B22. semua model gagal -> status benchmark failed", runSemuaGagal.status === 202 && runSemuaGagal.json?.status === "failed", short(runSemuaGagal.json));
delete process.env.MOCK_ENGINE_FAIL_MODELS;
delete process.env.MOCK_ENGINE_FAIL_TEXT;

check("B23. tindakan benchmark tercatat di jejak audit", hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='benchmark.run_started'") > 0
  && hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='benchmark.run_finished'") > 0,
  short({ mulai: hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='benchmark.run_started'") }));

/* =====================================================================================
 * Bagian 4b: butir 61 - formula skor dan perkiraan (unit dalam proses).
 * ===================================================================================== */
console.log("\n--- Bagian 4b: formula skor + perkiraan (butir 61) ---");
const skor = benchMod.skorKesepakatan as (jawaban: string[], indeks: number) => number | null;
check("U11. dua jawaban yang sama menghasilkan kesepakatan penuh (100)", skor(["kode ini aman dipakai produksi", "kode ini aman dipakai produksi"], 0) === 100, short(skor(["kode ini aman dipakai produksi", "kode ini aman dipakai produksi"], 0)));
check("U12. dua jawaban yang tidak berbagi kata kunci menghasilkan kesepakatan nol", skor(["penanganan galat lemah sekali", "struktur folder rapi benar"], 0) === 0, short(skor(["penanganan galat lemah sekali", "struktur folder rapi benar"], 0)));
check("U13. hanya satu jawaban: skor null, bukan angka karangan", skor(["hanya satu jawaban di sini"], 0) === null, short(skor(["hanya satu jawaban di sini"], 0)));
const perkiraanUnit = benchMod.perkiraanBenchmark([MODEL_A], soalBerkas.questions.slice(0, 2)) as { perkiraanBiayaMicros: number; perModel: { model: string; biayaMicros: number }[] };
check("U14. perkiraan unit = jumlah perkiraan per model dan memakai jumlah soal yang diberikan", perkiraanUnit.perkiraanBiayaMicros === perkiraanUnit.perModel[0].biayaMicros && perkiraanUnit.perkiraanBiayaMicros > 0, short(perkiraanUnit));
const perkiraanUnitKosong = benchMod.perkiraanBenchmark([MODEL_TIDAK_ADA], soalBerkas.questions) as { perkiraanBiayaMicros: number; tanpaHarga: string[] };
check("U15. model tanpa harga tidak dihitung dan dicatat sebagai tanpa harga", perkiraanUnitKosong.perkiraanBiayaMicros === 0 && perkiraanUnitKosong.tanpaHarga.includes(MODEL_TIDAK_ADA), short(perkiraanUnitKosong));
const ringkasModel = benchMod.ringkasPerModel([{ model: "a", errorCode: null, costMicros: 10, latencyMs: 20 }, { model: "a", errorCode: "X", costMicros: 0, latencyMs: 0 }, { model: "b", errorCode: null, costMicros: 5, latencyMs: 0 }]) as any[];
check("U16. ringkasan per model menghitung dijawab/gagal/biaya dan rata-rata waktu", ringkasModel.length === 2
  && ringkasModel[0].dijawab === 1 && ringkasModel[0].gagal === 1 && ringkasModel[0].biayaMicros === 10 && ringkasModel[0].rataLatencyMs === 20
  && ringkasModel[1].rataLatencyMs === 0, short(ringkasModel));

/* =====================================================================================
 * Bagian 5: butir 61 - kuota token.
 * ===================================================================================== */
console.log("\n--- Bagian 5: kuota token pada benchmark ---");
const estMiskin = await miskin.call("POST", "/api/v1/benchmark/estimate", { models: [MODEL_A] });
check("Q7. perkiraan benchmark tetap boleh dihitung saat kuota habis (tidak ada panggilan mesin)", estMiskin.status === 200 && Number(estMiskin.json?.perkiraanBiayaMicros) > 0, short(estMiskin.json));
const benchmarkHabis = await miskin.call("POST", "/api/v1/benchmark/run", { models: [MODEL_A], estimatedCostMicros: Number(estMiskin.json?.perkiraanBiayaMicros ?? -1) });
check("Q8. kuota habis -> 429 pada benchmark dan tidak ada baris benchmark yang tertulis", benchmarkHabis.status === 429
  && String(benchmarkHabis.json?.error ?? "").includes("QUOTA_EXCEEDED")
  && hitung("SELECT COUNT(*) AS n FROM benchmark_runs WHERE user_id=?", miskinUserId) === 0, `${benchmarkHabis.status} ${short(benchmarkHabis.json)}`);

/* =====================================================================================
 * Bagian 6: keadaan akhir.
 * ===================================================================================== */
console.log("\n--- Bagian 6: keadaan akhir ---");
const dewanAkhir = semua("SELECT id, status, cost_micros AS costMicros, (SELECT COUNT(*) FROM council_verdicts v WHERE v.council_run_id=r.id) AS verdict FROM council_runs r WHERE r.user_id=?", ownerUserId);
check("A1. setiap dewan yang tercatat punya minimal satu baris verdict dan biaya tidak negatif", dewanAkhir.length > 0
  && dewanAkhir.every((row) => Number(row.verdict) > 0 && Number(row.costMicros) >= 0), short(dewanAkhir.map((row) => ({ status: row.status, verdict: row.verdict }))));
const biayaVerdict = semua(`SELECT v.cost_micros AS costMicros, COALESCE(SUM(u.sell_cost_micros),0) AS dariUsage FROM council_verdicts v
  LEFT JOIN run_usage u ON u.run_id=v.run_id WHERE v.council_run_id=? GROUP BY v.id`, councilRunId);
check("A2. biaya di baris verdict sama dengan jumlah pemakaian run juri itu (satu sumber angka)", biayaVerdict.length === 2
  && biayaVerdict.every((row) => Number(row.costMicros) === Number(row.dariUsage)), short(biayaVerdict));
const jumlahRunBenchmark = hitung("SELECT COUNT(*) AS n FROM runs WHERE prompt LIKE 'Benchmark %'");
check("A3. tiap benchmark meninggalkan tepat satu run induk di tabel runs", jumlahRunBenchmark === hitung("SELECT COUNT(*) AS n FROM benchmark_runs WHERE user_id=?", ownerUserId), short({ jumlahRunBenchmark, benchmarkRuns: hitung("SELECT COUNT(*) AS n FROM benchmark_runs WHERE user_id=?", ownerUserId) }));

console.log(`\nRingkasan: ${passed} lulus, ${failed} gagal${skipped.length ? `, ${skipped.length} dilewati` : ""}`);
if (failedNames.length) console.log(`Gagal: ${failedNames.join(" | ")}`);
process.exit(failed ? 1 : 0);

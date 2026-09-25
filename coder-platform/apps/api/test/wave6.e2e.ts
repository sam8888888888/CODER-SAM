/**
 * Uji Wave 6 (v0.16.0): API publik fase dua + webhook keluar + batas harian per kunci.
 *
 * Yang dibuktikan:
 *  1) skema 14: tabel `webhooks` & `webhook_deliveries`, kolom batas harian di `api_keys`, `runs.api_key_id`;
 *  2) izin `write` sekarang benar-benar dilayani: kunci baca ditolak 403, kunci tulis berhasil;
 *  3) POST percakapan (201) dan POST pesan (202) bekerja, jawaban mesin tersimpan di rute pesan;
 *  4) validasi jujur: model tak dikenal, tingkat berpikir salah, isi kosong, percakapan milik workspace lain;
 *  5) batas harian per kunci: jumlah permintaan dan jumlah token, plus pemulihan saat hari berganti;
 *  6) webhook: CRUD, penolakan alamat berbahaya, hak akses owner, rahasia hanya sekali;
 *  7) pengiriman nyata ke penerima lokal: tanda tangan HMAC diverifikasi di sisi penerima;
 *  8) kegagalan penerima -> baris gagal + percobaan ulang lewat antrean sampai batasnya;
 *  9) peristiwa run (selesai & gagal) benar-benar dikirim; webhook mati tidak mengirim apa pun.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave6.e2e.ts
 */

import http from "node:http";
import net from "node:net";
import { pilihPortUji } from "./port-aman.js";

const port = pilihPortUji(6500, 200); // rentang khusus 6500-6700; nomor yang diblokir fetch dilewati
const hookPort = port + 500;                          // penerima webhook lokal
const dataDir = `/tmp/coder-wave6-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const ownerEmail = `w6-owner-${stamp}@example.test`;
const guestEmail = `w6-guest-${stamp}@example.test`;
const password = "SandiUji2026!aman";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave6-test-model";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.RETENTION_ENABLED = "false";
// Interval worker dibuat sangat panjang: hanya putaran yang dipanggil uji ini yang berjalan.
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.JOB_BATCH_SIZE = "20";
// Penerima webhook lokal hanya boleh saat flag ini hidup.
process.env.WEBHOOK_ALLOW_LOCAL = "true";
process.env.WEBHOOK_MAX_ATTEMPTS = "3";
process.env.WEBHOOK_MAX_PER_WORKSPACE = "3";
process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = "3000";

await import("../src/server.js");
const jobsMod: any = await import("../src/jobs.js");
const dbMod: any = await import("../src/db.js");
const hookMod: any = await import("../src/webhooks.js");
const keyMod: any = await import("../src/apikeys.js");
const db = dbMod.db;

const base = `http://127.0.0.1:${port}`;
const hookBase = `http://127.0.0.1:${hookPort}`;

let checks = 0;
let passed = 0;
let failed = 0;
const failedNames: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) { passed += 1; console.log(`PASS ${checks}) ${name}`); return; }
  failed += 1; failedNames.push(`${checks}) ${name}`);
  console.log(`FAIL ${checks}) ${name}${detail ? ` :: ${detail}` : ""}`);
}
function short(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

type Reply = { status: number; json: any; text: string };
type ApiClient = { call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply> };
function client(): ApiClient {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) { const value = setCookie.split(";")[0]; cookie = value.endsWith("=") ? "" : value; }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, json, text };
    },
  };
}
/** Penerima webhook: satu proses kecil di dalam uji ini, jadi tidak ada kiriman ke internet. */
type Hit = { path: string; event: string; signature: string; timestamp: string; delivery: string; body: any; raw: string };
function receiver() {
  const hits: Hit[] = [];
  let failNext = 0;
  const server = http.createServer((request: any, response: any) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      hits.push({
        path: String(request.url ?? ""), event: String(request.headers["x-coblai-event"] ?? ""),
        signature: String(request.headers["x-coblai-signature"] ?? ""), timestamp: String(request.headers["x-coblai-timestamp"] ?? ""),
        delivery: String(request.headers["x-coblai-delivery"] ?? ""), body, raw,
      });
      const failing = failNext > 0 || String(request.url ?? "").includes("/fail");
      if (failNext > 0) failNext -= 1;
      response.statusCode = failing ? 500 : 200;
      response.end(failing ? "{\"ok\":false}" : "{\"ok\":true}");
    });
  });
  return {
    hits, server,
    listen: () => new Promise<void>((resolve) => server.listen(hookPort, "127.0.0.1", () => resolve())),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    failNext: (count: number) => { failNext = count; },
    of: (path: string) => hits.filter((hit) => hit.path.includes(path)),
  };
}
function rantaiGalat(error: any): string {
  // undici menyembunyikan sebab asli di properti `cause`; tanpa ini "fetch failed" tidak memberi
  // informasi apa pun (jejak 26 Sep 2026).
  const bagian: string[] = [];
  let kaki: any = error;
  for (let depth = 0; kaki && depth < 5; depth += 1) {
    bagian.push(`${kaki.name ?? "?"}:${kaki.message ?? "?"}${kaki.code ? `/code=${kaki.code}` : ""}${kaki.errno ? `/errno=${kaki.errno}` : ""}${kaki.syscall ? `/syscall=${kaki.syscall}` : ""}`);
    kaki = kaki.cause;
  }
  return bagian.join(" <- ");
}
function ambilLewatHttp(): Promise<string> {
  // Pembanding langsung: permintaan HTTP polos (node:http) ke alamat yang sama. Kalau ini berhasil
  // sementara fetch gagal, masalahnya ada di lapisan fetch/undici, bukan di peladen.
  return new Promise((resolve) => {
    const permintaan = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3000 }, (jawaban) => {
      jawaban.resume();
      resolve(`HTTP ${jawaban.statusCode}`);
    });
    permintaan.on("timeout", () => { permintaan.destroy(); resolve("habis batas 3 detik"); });
    permintaan.on("error", (error: any) => resolve(`galat: ${error.code ?? error.message}`));
  });
}
async function waitForHealth(): Promise<void> {
  // 40 detik: cukup longgar saat mesin sedang sibuk menjalankan suite lain berurutan.
  const ragamGalat = new Map<string, number>();
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { await response.arrayBuffer(); return; } ragamGalat.set(`HTTP ${response.status}`, (ragamGalat.get(`HTTP ${response.status}`) ?? 0) + 1); }
    catch (error) { const kunci = rantaiGalat(error); ragamGalat.set(kunci, (ragamGalat.get(kunci) ?? 0) + 1); }
    await sleep(250);
  }
  // Jejak diagnosis (26 Sep 2026): gerbang penuh dan 20 putaran mandiri sama-sama pernah merah di
  // suite ini dengan "server tidak siap" padahal peladen mencatat dirinya mendengarkan. Sekarang
  // sebab asli rantai galat fetch, sambungan TCP langsung, dan permintaan HTTP polos ikut dilaporkan.
  let sambungTcp = "tidak dicoba";
  await new Promise<void>((resolve) => {
    const soket = net.connect(port, "127.0.0.1");
    const batas = setTimeout(() => { sambungTcp = sambungTcp === "tidak dicoba" ? "habis batas 2 detik" : sambungTcp; soket.destroy(); resolve(); }, 2000);
    soket.once("connect", () => { sambungTcp = "tersambung"; clearTimeout(batas); soket.destroy(); resolve(); });
    soket.once("error", (error) => { sambungTcp = `galat: ${error.message}`; clearTimeout(batas); resolve(); });
  });
  const lewatHttp = await ambilLewatHttp();
  const ragam = [...ragamGalat.entries()].map(([kunci, jumlah]) => `${jumlah}x ${kunci}`).join(" | ");
  throw new Error(`server tidak siap (port=${port} envPORT=${process.env.PORT} tcp=${sambungTcp} httpPolos=${lewatHttp} ragamGalatFetch=${ragam})`);
}

const hooks = receiver();
await hooks.listen();
await waitForHealth();
for (let attempt = 0; attempt < 80; attempt += 1) {
  if (jobsMod.jobWorkerState().cyclesRun >= 1) break;
  await sleep(100);
}

const owner = client();
const guest = client();
const registerOwner = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Kunci" });
check("pendaftaran pemilik berhasil", registerOwner.status === 200 || registerOwner.status === 201, short(registerOwner.json));
const registerGuest = await guest.call("POST", "/api/v1/auth/register", { email: guestEmail, password, displayName: "Tamu Viewer" });
check("pendaftaran pengguna kedua berhasil", registerGuest.status === 200 || registerGuest.status === 201, short(registerGuest.json));

const workspaces = await owner.call("GET", "/api/v1/workspaces");
const workspaceId: string = (workspaces.json ?? [])[0]?.id;
check("ruang kerja pemilik terbaca", Boolean(workspaceId), short(workspaces.json));
const project = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: `Proyek Wave 6 ${stamp}` });
const projectId: string = project.json?.project?.id ?? project.json?.id;
check("proyek uji dibuat", Boolean(projectId), short(project.json));
const ownerUser = db.prepare("SELECT id FROM users WHERE email=?").get(ownerEmail) as any;
const guestUser = db.prepare("SELECT id FROM users WHERE email=?").get(guestEmail) as any;

/* ---------------------------------- 1) bentuk skema 14 ---------------------------------- */

const schemaRow = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as any;
check("skema basis data minimal 14", Number(schemaRow?.version) >= 14, short(schemaRow));
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => String(row.name));
check("tabel webhooks dan webhook_deliveries terpasang", tables.includes("webhooks") && tables.includes("webhook_deliveries"), short(tables.length));
const keyColumns = (db.prepare("PRAGMA table_info(api_keys)").all() as any[]).map((row) => String(row.name));
check("kolom batas harian ada di api_keys",
  ["daily_request_limit", "daily_token_limit", "requests_today", "usage_day"].every((name) => keyColumns.includes(name)), short(keyColumns));
const runColumns = (db.prepare("PRAGMA table_info(runs)").all() as any[]).map((row) => String(row.name));
check("kolom api_key_id ada di runs", runColumns.includes("api_key_id"), short(runColumns));
check("jenis pekerjaan webhook.deliver dikenal antrean", jobsMod.JOB_KINDS.includes("webhook.deliver"), short(jobsMod.JOB_KINDS));
check("penangan webhook.deliver terdaftar saat boot", jobsMod.jobHandlerKinds().includes("webhook.deliver"), short(jobsMod.jobHandlerKinds()));

/* ---------------------------------- 2) izin write benar-benar dilayani ---------------------------------- */

const readKeyReply = await owner.call("POST", "/api/v1/api-keys", { name: `kunci-baca-${stamp}`, scopes: ["read"] });
check("kunci baca dibuat", readKeyReply.status === 201 && String(readKeyReply.json?.key?.scopes) === "read", short(readKeyReply.json));
const readSecret = String(readKeyReply.json?.secret ?? "");
const readAuth = { authorization: `Bearer ${readSecret}` };

const writeKeyReply = await owner.call("POST", "/api/v1/api-keys", {
  name: `kunci-tulis-${stamp}`, scopes: ["write"], dailyRequestLimit: 0, dailyTokenLimit: 0,
});
check("kunci tulis dibuat tanpa ditolak SCOPE_NOT_AVAILABLE",
  writeKeyReply.status === 201 && String(writeKeyReply.json?.key?.scopes).includes("write"), short(writeKeyReply.json));
const writeSecret = String(writeKeyReply.json?.secret ?? "");
const writeKeyId = String(writeKeyReply.json?.key?.id ?? "");
const writeAuth = { authorization: `Bearer ${writeSecret}` };
check("kunci tulis otomatis boleh membaca juga", String(writeKeyReply.json?.key?.scopes) === "write,read", short(writeKeyReply.json?.key?.scopes));
check("permintaan tanpa kunci ditolak 401", (await owner.call("GET", "/api/v1/public/v1/me", undefined, { authorization: "" })).status === 401);

const readPost = await fetch(`${base}/api/v1/public/v1/projects/${projectId}/conversations`, {
  method: "POST", headers: { ...readAuth, "content-type": "application/json" }, body: JSON.stringify({ title: "x" }),
});
check("kunci baca ditolak saat menulis (403 API_KEY_SCOPE_REQUIRED)", readPost.status === 403, `${readPost.status}`);

const docsReply = await owner.call("GET", "/api/v1/api-keys/docs");
check("dokumentasi API menyebut izin read & write", Array.isArray(docsReply.json?.scopes) && docsReply.json.scopes.includes("write"), short(docsReply.json?.scopes));
check("dokumentasi API tidak lagi punya rute rencana yang bohong", Array.isArray(docsReply.json?.plannedEndpoints) && docsReply.json.plannedEndpoints.length === 0, short(docsReply.json?.plannedEndpoints));
check("dokumentasi API memuat 9 rute tersedia", docsReply.json?.endpoints?.length === 9, short(docsReply.json?.endpoints?.length));
check("dokumentasi API menjelaskan webhook dan tanda tangan",
  Array.isArray(docsReply.json?.webhooks?.events) && String(docsReply.json?.webhooks?.signature ?? "").includes("sha256"), short(docsReply.json?.webhooks));
check("kunci menyertakan batas harian di daftar kunci",
  (await owner.call("GET", "/api/v1/api-keys")).json?.keys?.some((key: any) => "dailyRequestLimit" in key && "tokensToday" in key) === true);

/* ---------------------------------- 3) rute tulis publik ---------------------------------- */

const badProject = await fetch(`${base}/api/v1/public/v1/projects/tidak-ada/conversations`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({}),
});
check("proyek tak dikenal ditolak 404", badProject.status === 404, `${badProject.status}`);

const createdConversation = await fetch(`${base}/api/v1/public/v1/projects/${projectId}/conversations`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ title: "Percakapan dari skrip" }),
});
const createdJson: any = await createdConversation.json().catch(() => null);
const conversationId = String(createdJson?.conversation?.id ?? "");
check("kunci tulis membuat percakapan (201)", createdConversation.status === 201 && Boolean(conversationId), short(createdJson));

const listed = await fetch(`${base}/api/v1/public/v1/projects/${projectId}/conversations`, { headers: writeAuth });
const listedJson: any = await listed.json().catch(() => null);
check("percakapan baru terlihat lewat rute baca", (listedJson?.conversations ?? []).some((row: any) => row.id === conversationId), short(listedJson));

const unknownModel = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "halo", model: "model-tidak-ada-xyz" }),
});
const unknownModelJson: any = await unknownModel.json().catch(() => null);
check("model tak dikenal ditolak 400 UNKNOWN_MODEL", unknownModel.status === 400 && unknownModelJson?.error === "UNKNOWN_MODEL", short(unknownModelJson));

const badThinking = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "halo", thinking: "sangat-dalam" }),
});
const badThinkingJson: any = await badThinking.json().catch(() => null);
check("tingkat berpikir salah ditolak 400", badThinking.status === 400 && badThinkingJson?.error === "INVALID_THINKING_LEVEL", short(badThinkingJson));

const emptyMessage = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "   " }),
});
const emptyJson: any = await emptyMessage.json().catch(() => null);
check("pesan kosong ditolak 400 INVALID_MESSAGE", emptyMessage.status === 400 && emptyJson?.error === "INVALID_MESSAGE", short(emptyJson));

const sentMessage = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "Tolong balas singkat." }),
});
const sentJson: any = await sentMessage.json().catch(() => null);
const sentRunId = String(sentJson?.run?.id ?? "");
check("kunci tulis mengirim pesan (202) dan run dibuat",
  sentMessage.status === 202 && Boolean(sentRunId) && sentJson?.message?.role === "user", short(sentJson));

let answer = "";
let runStatus = "";
for (let attempt = 0; attempt < 60; attempt += 1) {
  const messages = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, { headers: writeAuth });
  const body: any = await messages.json().catch(() => null);
  const assistant = (body?.messages ?? []).filter((row: any) => row.role === "assistant");
  if (assistant.length) { answer = String(assistant[assistant.length - 1]?.content ?? ""); break; }
  await sleep(250);
}
runStatus = String((db.prepare("SELECT status FROM runs WHERE id=?").get(sentRunId) as any)?.status ?? "");
check("run dari rute tulis selesai oleh mesin", runStatus === "completed", runStatus || "kosong");
check("jawaban mesin tersimpan sebagai pesan assistant", answer.length > 0, short(answer));
const usageRow = db.prepare("SELECT model, total_tokens AS tokens FROM run_usage WHERE run_id=?").get(sentRunId) as any;
check("pemakaian token tercatat untuk run publik", Boolean(usageRow) && Number(usageRow.tokens) > 0, short(usageRow));
const runKeyRow = db.prepare("SELECT api_key_id AS keyId FROM runs WHERE id=?").get(sentRunId) as any;
check("run publik tercatat pada kunci yang memakainya", String(runKeyRow?.keyId) === writeKeyId, short(runKeyRow));

const foreignConversation = db.prepare("SELECT id FROM conversations WHERE project_id IN (SELECT id FROM projects WHERE workspace_id!=?) LIMIT 1").get(workspaceId) as any;
const foreignReply = await fetch(`${base}/api/v1/public/v1/conversations/${String(foreignConversation?.id ?? "tidak-ada")}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "halo" }),
});
check("percakapan workspace lain tidak bisa dihubungi lewat kunci", foreignReply.status === 404, `${foreignReply.status}`);

const auditPublic = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='public.message.created'").get() as any;
check("aksi tulis publik dicatat di audit", Number(auditPublic.n) >= 1, short(auditPublic));

/* ---------------------------------- 4) batas harian per kunci ---------------------------------- */

const limited = await owner.call("POST", "/api/v1/api-keys", { name: `kunci-batas-${stamp}`, scopes: ["read"], dailyRequestLimit: 2 });
const limitedSecret = String(limited.json?.secret ?? "");
const limitedId = String(limited.json?.key?.id ?? "");
const limitedAuth = { authorization: `Bearer ${limitedSecret}` };
check("kunci dengan batas 2 permintaan dibuat", limited.status === 201 && Number(limited.json?.key?.dailyRequestLimit) === 2, short(limited.json?.key));
const firstCall = await fetch(`${base}/api/v1/public/v1/me`, { headers: limitedAuth });
const secondCall = await fetch(`${base}/api/v1/public/v1/me`, { headers: limitedAuth });
const thirdCall = await fetch(`${base}/api/v1/public/v1/me`, { headers: limitedAuth });
const thirdJson: any = await thirdCall.json().catch(() => null);
check("dua permintaan pertama lolos", firstCall.status === 200 && secondCall.status === 200, `${firstCall.status}/${secondCall.status}`);
check("permintaan ketiga ditolak 429 API_KEY_DAILY_REQUEST_LIMIT",
  thirdCall.status === 429 && thirdJson?.error === "API_KEY_DAILY_REQUEST_LIMIT" && Number(thirdJson?.limit) === 2, short(thirdJson));
check("penolakan menyebut pemakaian apa adanya", Number(thirdJson?.used) === 2, short(thirdJson));

// Hari berganti: pemakaian kemarin tidak boleh menghukum hari ini.
db.prepare("UPDATE api_keys SET usage_day='2000-01-01', requests_today=99 WHERE id=?").run(limitedId);
const afterRollover = await fetch(`${base}/api/v1/public/v1/me`, { headers: limitedAuth });
check("pemakaian harian direset saat hari berganti", afterRollover.status === 200, `${afterRollover.status}`);

const tokenLimited = await owner.call("POST", "/api/v1/api-keys", { name: `kunci-token-${stamp}`, scopes: ["read"], dailyTokenLimit: 1000 });
const tokenLimitedId = String(tokenLimited.json?.key?.id ?? "");
const tokenLimitedSecret = String(tokenLimited.json?.secret ?? "");
const tokenLimitedAuth = { authorization: `Bearer ${tokenLimitedSecret}` };
const tokenRunId = `run-token-${stamp}`;
db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,api_key_id,created_at) VALUES (?,?,?,?,?,?,?)")
  .run(tokenRunId, projectId, "completed", "halo", "wave6-test-model", tokenLimitedId, new Date().toISOString());
db.prepare("INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,total_tokens,estimated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(`usage-token-${stamp}`, tokenRunId, projectId, "wave6-test-model", "mock", 60, 60, 120, 0, new Date().toISOString());
const beforeToken = await fetch(`${base}/api/v1/public/v1/me`, { headers: tokenLimitedAuth });
const beforeTokenJson: any = await beforeToken.json().catch(() => null);
check("pemakaian token kunci terlihat di rute me", Number(beforeTokenJson?.key?.tokensToday ?? -1) === 120, short(beforeTokenJson?.key));
const tighten = await owner.call("PATCH", `/api/v1/api-keys/${tokenLimitedId}`, { dailyTokenLimit: 100 });
check("batas token per kunci bisa diubah lewat PATCH", tighten.status === 200 && Number(tighten.json?.key?.dailyTokenLimit) === 100, short(tighten.json?.key));
const overToken = await fetch(`${base}/api/v1/public/v1/projects`, { headers: tokenLimitedAuth });
const overTokenJson: any = await overToken.json().catch(() => null);
check("batas token harian per kunci menolak 429 API_KEY_DAILY_TOKEN_LIMIT",
  overToken.status === 429 && overTokenJson?.error === "API_KEY_DAILY_TOKEN_LIMIT" && Number(overTokenJson?.used) === 120, short(overTokenJson));

// Kunci milik anggota viewer: membaca boleh, menulis tidak.
db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,?,?)")
  .run(guestUser.id, workspaceId, "viewer", new Date().toISOString());
const viewerKey = keyMod.createApiKey({ userId: guestUser.id, workspaceId, name: `kunci-viewer-${stamp}`, scopes: ["write"] });
const viewerAuth = { authorization: `Bearer ${viewerKey.raw}` };
const viewerWrite = await fetch(`${base}/api/v1/public/v1/projects/${projectId}/conversations`, {
  method: "POST", headers: { ...viewerAuth, "content-type": "application/json" }, body: JSON.stringify({ title: "dari viewer" }),
});
check("kunci milik anggota viewer ditolak menulis (403 VIEWER_READ_ONLY)", viewerWrite.status === 403, `${viewerWrite.status}`);
const viewerRead = await fetch(`${base}/api/v1/public/v1/projects`, { headers: viewerAuth });
check("kunci milik anggota viewer masih boleh membaca", viewerRead.status === 200, `${viewerRead.status}`);

/* ---------------------------------- 5) webhook: CRUD dan penolakan alamat ---------------------------------- */

const badUrl = await owner.call("POST", "/api/v1/webhooks", { url: "bukan-url" });
check("alamat bukan URL ditolak 400 WEBHOOK_URL_INVALID", badUrl.status === 400 && badUrl.json?.error === "WEBHOOK_URL_INVALID", short(badUrl.json));
const wrongScheme = await owner.call("POST", "/api/v1/webhooks", { url: "ftp://contoh.com/hook" });
check("skema selain http/https ditolak", wrongScheme.status === 400 && wrongScheme.json?.error === "WEBHOOK_URL_INVALID", short(wrongScheme.json));
const metadataUrl = await owner.call("POST", "/api/v1/webhooks", { url: "http://169.254.169.254/latest/meta-data" });
check("alamat metadata ditolak 400 WEBHOOK_URL_BLOCKED", metadataUrl.status === 400 && metadataUrl.json?.error === "WEBHOOK_URL_BLOCKED", short(metadataUrl.json));
const unknownEvent = await owner.call("POST", "/api/v1/webhooks", { url: `${hookBase}/ok`, events: ["tidak.ada"] });
check("peristiwa tak dikenal jatuh ke run.completed", unknownEvent.status === 201 && String(unknownEvent.json?.webhook?.events) === "run.completed", short(unknownEvent.json?.webhook?.events));
check("rahasia webhook tampil sekali dan berbentuk whsec_", String(unknownEvent.json?.secret ?? "").startsWith("whsec_"), short(unknownEvent.json?.secret));
const hookId = String(unknownEvent.json?.webhook?.id ?? "");
const hookSecret = String(unknownEvent.json?.secret ?? "");
await owner.call("DELETE", `/api/v1/webhooks/${hookId}`);

const mainHook = await owner.call("POST", "/api/v1/webhooks", { url: `${hookBase}/ok`, events: ["run.completed", "run.failed"], description: "penerima uji" });
const mainHookId = String(mainHook.json?.webhook?.id ?? "");
const mainSecret = String(mainHook.json?.secret ?? "");
check("webhook utama dibuat (201)", mainHook.status === 201 && Boolean(mainHookId), short(mainHook.json));

const listedHooks = await owner.call("GET", "/api/v1/webhooks");
check("daftar webhook tidak pernah memuat rahasia",
  Array.isArray(listedHooks.json?.webhooks) && listedHooks.json.webhooks.every((row: any) => !("secret" in row)), short(listedHooks.json?.webhooks?.[0]));
check("daftar webhook memuat statistik dan pilihan peristiwa",
  Boolean(listedHooks.json?.stats) && Array.isArray(listedHooks.json?.events) && listedHooks.json?.limits?.maxAttempts === 3, short(listedHooks.json?.limits));
check("pemilik boleh mengelola webhook", listedHooks.json?.canManage === true);

const guestManage = await guest.call("POST", "/api/v1/webhooks", { url: `${hookBase}/ok`, workspaceId });
check("anggota viewer ditolak mengelola webhook (403 OWNER_REQUIRED)", guestManage.status === 403 && guestManage.json?.error === "OWNER_REQUIRED", short(guestManage.json));
const guestDelete = await guest.call("DELETE", `/api/v1/webhooks/${mainHookId}?workspaceId=${workspaceId}`);
check("anggota viewer ditolak menghapus webhook", guestDelete.status === 403, `${guestDelete.status}`);

/* ---------------------------------- 6) pengiriman nyata + tanda tangan ---------------------------------- */

const testDelivery = await owner.call("POST", `/api/v1/webhooks/${mainHookId}/test`);
check("uji webhook menjawab 200 dengan laporan", testDelivery.status === 200 && testDelivery.json?.report?.status === "delivered", short(testDelivery.json));
const testHits = hooks.of("/ok");
check("penerima menerima satu kiriman uji", testHits.length === 1, short(testHits.length));
const testHit = testHits[0];
const expectedSignature = hookMod.signPayload(mainSecret, testHit?.timestamp ?? "", testHit?.raw ?? "");
check("tanda tangan HMAC cocok di sisi penerima", Boolean(testHit) && testHit.signature === expectedSignature, short({ got: testHit?.signature, want: expectedSignature }));
check("header peristiwa dan id kiriman ikut dikirim",
  testHit?.event === "webhook.test" && Boolean(testHit?.delivery), short({ event: testHit?.event, delivery: testHit?.delivery }));
check("isi kiriman uji memuat pesan uji", String(testHit?.body?.data?.message ?? "").includes("Pesan uji"), short(testHit?.body));
check("baris pengiriman tercatat delivered dengan kode 200",
  Number((db.prepare("SELECT response_status AS s, status FROM webhook_deliveries WHERE id=?").get(testHit?.delivery) as any)?.s) === 200, short((db.prepare("SELECT status, response_status AS s, attempts FROM webhook_deliveries WHERE id=?").get(testHit?.delivery) as any)));

/* ---------------------------------- 7) peristiwa run dikirim otomatis ---------------------------------- */

const beforeEvent = hooks.of("/ok").length;
const secondMessage = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "Balas lagi." }),
});
check("pesan kedua diterima mesin (202)", secondMessage.status === 202, `${secondMessage.status}`);
let eventDelivery: any = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  eventDelivery = db.prepare("SELECT id, event, status FROM webhook_deliveries WHERE webhook_id=? AND event='run.completed' ORDER BY created_at DESC LIMIT 1").get(mainHookId) as any;
  if (eventDelivery) break;
  await sleep(250);
}
check("run selesai membuat baris pengiriman run.completed", Boolean(eventDelivery), short(eventDelivery));
const cycleEvent = await jobsMod.runJobCycleOnce({ owner: "uji-wave6", limit: 20 });
await sleep(400);
const okHits = hooks.of("/ok");
check("putaran antrean mengirim peristiwa ke penerima", okHits.length > beforeEvent, short(okHits.length));
const lastOk = okHits[okHits.length - 1];
check("peristiwa yang diterima adalah run.completed", lastOk?.event === "run.completed", short(lastOk?.event));
check("badan peristiwa memuat id run dan id percakapan",
  Boolean(lastOk?.body?.data?.runId) && String(lastOk?.body?.data?.conversationId ?? "") === conversationId, short(lastOk?.body?.data));
check("pengiriman peristiwa ditandai delivered",
  String((db.prepare("SELECT status FROM webhook_deliveries WHERE id=?").get(lastOk?.delivery) as any)?.status) === "delivered", short(db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE id=?").get(lastOk?.delivery) as any));
const cycleSummary: any = cycleEvent;
check("putaran antrean menyelesaikan pekerjaan webhook", Number(cycleSummary?.claimed ?? 0) >= 1, short(cycleSummary));

/* ---------------------------------- 8) kegagalan penerima dan percobaan ulang ---------------------------------- */

const failHook = await owner.call("POST", "/api/v1/webhooks", { url: `${hookBase}/fail`, events: ["run.completed"] });
const failHookId = String(failHook.json?.webhook?.id ?? "");
check("webhook penerima gagal dibuat", failHook.status === 201, short(failHook.json));

const thirdMessage = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "Pesan ketiga." }),
});
check("pesan ketiga diterima mesin (202)", thirdMessage.status === 202, `${thirdMessage.status}`);
let failDelivery: any = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  failDelivery = db.prepare("SELECT id, status, attempts FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 1").get(failHookId) as any;
  if (failDelivery) break;
  await sleep(250);
}
check("baris pengiriman untuk penerima gagal dibuat", Boolean(failDelivery), short(failDelivery));
await jobsMod.runJobCycleOnce({ owner: "uji-wave6-fail", limit: 20 });
await sleep(300);
const failedOnce = db.prepare("SELECT status, attempts, last_error AS lastError, response_status AS responseStatus FROM webhook_deliveries WHERE id=?").get(failDelivery.id) as any;
check("percobaan pertama mencatat kegagalan dan kode jawaban 500",
  Number(failedOnce?.attempts) === 1 && Number(failedOnce?.responseStatus) === 500 && String(failedOnce?.lastError ?? "").includes("500"), short(failedOnce));
const failJob = db.prepare("SELECT status, attempts, run_after AS runAfter FROM jobs WHERE dedupe_key=?").get(`webhook.deliver:${failDelivery.id}`) as any;
check("pekerjaan webhook dikembalikan ke antrean untuk dicoba lagi",
  String(failJob?.status) === "queued" && Number(failJob?.attempts) === 1, short(failJob));
check("jeda percobaan ulang dipasang di masa depan", new Date(String(failJob?.runAfter)).getTime() > Date.now() - 1000, short(failJob?.runAfter));

for (let attempt = 0; attempt < 2; attempt += 1) {
  db.prepare("UPDATE jobs SET run_after=? WHERE dedupe_key=?").run(new Date(Date.now() - 1000).toISOString(), `webhook.deliver:${failDelivery.id}`);
  await jobsMod.runJobCycleOnce({ owner: `uji-wave6-retry-${attempt}`, limit: 20 });
  await sleep(200);
}
const finalFail = db.prepare("SELECT status, attempts FROM webhook_deliveries WHERE id=?").get(failDelivery.id) as any;
const finalFailJob = db.prepare("SELECT status, attempts FROM jobs WHERE dedupe_key=?").get(`webhook.deliver:${failDelivery.id}`) as any;
check("setelah batas percobaan, pengiriman berhenti sebagai failed", String(finalFail?.status) === "failed" && Number(finalFail?.attempts) === 3, short(finalFail));
check("pekerjaan antreannya juga berhenti failed", String(finalFailJob?.status) === "failed" && Number(finalFailJob?.attempts) === 3, short(finalFailJob));
check("penerima gagal benar-benar dihubungi tiga kali", hooks.of("/fail").length === 3, short(hooks.of("/fail").length));
const failHookRow = await owner.call("GET", "/api/v1/webhooks");
check("penghitung kegagalan webhook naik", Number((failHookRow.json?.webhooks ?? []).find((row: any) => row.id === failHookId)?.failureCount ?? 0) >= 1, short((failHookRow.json?.webhooks ?? []).find((row: any) => row.id === failHookId)));

/* ---------------------------------- 9) webhook mati dan batas jumlah ---------------------------------- */

const disabled = await owner.call("PATCH", `/api/v1/webhooks/${failHookId}`, { active: false });
check("webhook bisa dimatikan", disabled.status === 200 && disabled.json?.webhook?.active === false, short(disabled.json?.webhook));
const deliveriesBefore = Number((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=?").get(failHookId) as any).n);
const fourthMessage = await fetch(`${base}/api/v1/public/v1/conversations/${conversationId}/messages`, {
  method: "POST", headers: { ...writeAuth, "content-type": "application/json" }, body: JSON.stringify({ content: "Pesan keempat." }),
});
check("pesan keempat diterima mesin (202)", fourthMessage.status === 202, `${fourthMessage.status}`);
await sleep(600);
const deliveriesAfter = Number((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=?").get(failHookId) as any).n);
check("webhook yang dimatikan tidak membuat pengiriman baru", deliveriesAfter === deliveriesBefore, `${deliveriesBefore} -> ${deliveriesAfter}`);
const history = await owner.call("GET", `/api/v1/webhooks/${failHookId}/deliveries?limit=5`);
check("riwayat pengiriman bisa dibaca lewat rute", Array.isArray(history.json?.deliveries) && history.json.deliveries.length >= 1, short(history.json?.deliveries?.length));
check("rute riwayat menghormati batas limit", (history.json?.deliveries ?? []).length <= 5);

const third = await owner.call("POST", "/api/v1/webhooks", { url: `${hookBase}/ok`, events: ["run.completed"] });
check("webhook ketiga masih boleh (batas 3)", third.status === 201, short(third.json));
const fourth = await owner.call("POST", "/api/v1/webhooks", { url: `${hookBase}/ok` });
check("webhook keempat ditolak 409 TOO_MANY_WEBHOOKS", fourth.status === 409 && fourth.json?.error === "TOO_MANY_WEBHOOKS", short(fourth.json));

const removed = await owner.call("DELETE", `/api/v1/webhooks/${failHookId}`);
check("webhook bisa dihapus", removed.status === 200 && removed.json?.deleted === true, short(removed.json));
check("riwayat pengiriman webhook yang dihapus ikut hilang",
  Number((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=?").get(failHookId) as any).n) === 0);
const removedAgain = await owner.call("DELETE", `/api/v1/webhooks/${failHookId}`);
check("menghapus webhook yang sudah hilang menjawab 404", removedAgain.status === 404 && removedAgain.json?.error === "WEBHOOK_NOT_FOUND", short(removedAgain.json));
const unknownTest = await owner.call("POST", `/api/v1/webhooks/tidak-ada/test`);
check("menguji webhook tak dikenal menjawab 404", unknownTest.status === 404, `${unknownTest.status}`);

/* ---------------------------------- 10) status hub dan audit ---------------------------------- */

const hub = await owner.call("GET", "/api/v1/status-hub");
check("status hub melaporkan webhook dan batas kunci",
  Boolean(hub.json?.openPlatform?.webhooks) && Boolean(hub.json?.openPlatform?.keyLimits), short(hub.json?.openPlatform?.webhooks));
check("status hub menghitung rute publik yang benar-benar tersedia",
  Number(hub.json?.openPlatform?.publicEndpoints) === 9 && Number(hub.json?.openPlatform?.publicEndpointsPlanned) === 0, short(hub.json?.openPlatform));
const auditRows = db.prepare("SELECT action, COUNT(*) AS n FROM audit_events WHERE action IN ('webhook.created','webhook.tested','webhook.deleted','public.conversation.created') GROUP BY action").all() as any[];
check("aksi webhook dan tulis publik tercatat di audit", auditRows.length >= 3, short(auditRows));

await hooks.close();
console.log("");
console.log(`wave6: ${passed}/${checks} lulus, gagal ${failed}`);
if (failed) { console.log("GAGAL:"); for (const name of failedNames) console.log(`  - ${name}`); console.log("WAVE6_TESTS_FAILED"); }
else console.log("ALL_WAVE6_TESTS_PASSED");
process.exit(failed ? 1 : 0);

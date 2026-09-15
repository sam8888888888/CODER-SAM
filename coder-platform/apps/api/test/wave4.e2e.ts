/**
 * Uji end-to-end Wave 4 ("platform terbuka & kepatuhan") coder-platform: kunci API + API publik
 * baca-saja, antrean email (outbox), preferensi email, ekspor data pribadi, kebijakan retensi, dan
 * halaman harga publik.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave4.e2e.ts
 * (atau dari mana saja: node apps/api/test/run-wave4.cjs)
 *
 * Pola bootstrap meniru wave2/wave3: semua variabel lingkungan diset SEBELUM modul server/config
 * diimpor, DATA_DIR sementara di /tmp, MOCK_ENGINE=true, batas rate limit HTTP dinaikkan, kredensial
 * SMTP dan kunci gateway DIHAPUS. Suite ini TIDAK mengirim email: NOTIFY_EMAIL_ENABLED dibiarkan
 * false sehingga pesan hanya masuk antrean, dan tidak ada panggilan jaringan keluar.
 *
 * BATAS YANG DIAKUI APA ADANYA:
 *  1) API publik baru melayani READ. Dua rute POST (kirim pesan, buat percakapan) belum dilayani dan
 *     hanya muncul di `plannedEndpoints`; suite memeriksa status 404-nya, bukan menganggapnya ada.
 *  2) RETENTION_ENABLED=false, jadi pembersihan tidak menghapus apa pun. Yang diuji adalah laporan
 *     hitungan dan penolakan menjalankan penghapusan saat flag mati.
 *  3) Preferensi email hanya memengaruhi salinan email; notifikasi dalam aplikasi selalu ditulis.
 *  4) Kunci API disimpan sebagai hash sha256, jadi nilai mentah tidak bisa diuji dari database.
 *     Yang diuji: nilai mentah hanya keluar sekali saat pembuatan, dan tidak muncul lagi di respons
 *     daftar kunci maupun di berkas ekspor data.
 */

const port = 5600 + Math.floor(Math.random() * 400); // rentang khusus Wave 4: 5600-6000
const dataDir = `/tmp/coder-wave4-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `wave4-admin-${stamp}@example.test`;
const outsiderEmail = `wave4-outsider-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave4-test-model";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail; // daftar admin platform untuk suite ini
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RATE_LIMIT_PASSWORD_PER_HOUR = "60";
process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
// Batas laju per kunci dibuat rendah supaya uji 429 murah, tetapi cukup tinggi untuk bagian lain.
process.env.API_KEY_RATE_LIMIT_PER_MINUTE = "20";
// Fitur email keluar dan penghapusan retensi sengaja dibiarkan MATI untuk seluruh suite ini.
delete process.env.NOTIFY_EMAIL_ENABLED;
delete process.env.RETENTION_ENABLED;
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;
delete process.env.XENDIT_SECRET_KEY;
delete process.env.XENDIT_CALLBACK_TOKEN;
delete process.env.MIDTRANS_SERVER_KEY;
delete process.env.MIDTRANS_CLIENT_KEY;
delete process.env.MIDTRANS_MERCHANT_ID;

await import("../src/server.js");

const base = `http://127.0.0.1:${port}`;

let checks = 0;
let passed = 0;
let failed = 0;
const failedNames: string[] = [];
const skipped: string[] = [];
const notes: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) { passed += 1; console.log(`PASS ${checks}) ${name}`); return; }
  failed += 1; failedNames.push(`${checks}) ${name}`);
  console.log(`FAIL ${checks}) ${name}${detail ? ` :: ${detail}` : ""}`);
}
function skip(name: string, reason: string): void {
  skipped.push(`${name} — ${reason}`);
  console.log(`SKIP ${name} :: ${reason}`);
}
function note(text: string): void { notes.push(text); console.log(`NOTE ${text}`); }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function short(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}

type Reply = { status: number; json: any; text: string; headers: Headers; buffer: Buffer };
type ApiClient = { call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Reply>; cookie: () => string };

/** Klien kecil dengan cookie sendiri; header tambahan dipakai untuk Bearer kunci API. */
function client(initialCookie = ""): ApiClient {
  let cookie = initialCookie;
  return {
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const value = setCookie.split(";")[0];
        cookie = value.endsWith("=") ? "" : value;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const text = buffer.toString("utf8");
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json, text, headers: response.headers, buffer };
    },
    cookie() { return cookie; },
  };
}

async function waitForHealth(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.status === 200) return true; } catch { /* belum siap */ }
    await sleep(250);
  }
  return false;
}
async function messagesOf(api: ApiClient, conversationId: string): Promise<any[]> {
  const reply = await api.call("GET", `/api/v1/conversations/${conversationId}/messages`);
  return Array.isArray(reply.json?.messages) ? reply.json.messages : [];
}
/** Menunggu jawaban assistant untuk satu run (mesin mock menjawab tidak sinkron). */
async function waitForAssistantRun(api: ApiClient, conversationId: string, runId: string, tries = 80): Promise<any> {
  let list = await messagesOf(api, conversationId);
  let message = list.find((row: any) => row.runId === runId && row.role === "assistant");
  for (let attempt = 0; attempt < tries && !message; attempt += 1) {
    await sleep(100); list = await messagesOf(api, conversationId);
    message = list.find((row: any) => row.runId === runId && row.role === "assistant");
  }
  return message ?? null;
}
const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

const password = "Wave4Uji123!";

// ==================================================================== bagian 1: dasar
console.log("\n=== Bagian 1: dasar ===");
const serverReady = await waitForHealth();
check("[Dasar] server uji siap menjawab GET /health 200", serverReady, `base=${base}`);

const admin = client();
const outsider = client();
const anon = client();

const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Wave4" });
check("[Dasar] daftar akun admin platform (email di PLATFORM_ADMIN_EMAILS)", adminReg.status === 201, `${adminReg.status} ${short(adminReg.json)}`);
const adminUserId = adminReg.json?.user?.id;
const adminWorkspaceId = adminReg.json?.workspace?.id;
check("[Dasar] akun admin mendapat workspace pribadi", typeof adminWorkspaceId === "string" && adminWorkspaceId.length > 0, short(adminReg.json?.workspace));

const outsiderReg = await outsider.call("POST", "/api/v1/auth/register", { email: outsiderEmail, password, displayName: "Pengguna Luar Wave4" });
check("[Dasar] daftar akun kedua (bukan admin)", outsiderReg.status === 201, `${outsiderReg.status} ${short(outsiderReg.json)}`);
const outsiderUserId = outsiderReg.json?.user?.id;
const outsiderWorkspaceId = outsiderReg.json?.workspace?.id;

// ==================================================================== bagian 2: kunci API
console.log("\n=== Bagian 2: kunci API ===");
const anonKeys = await anon.call("GET", "/api/v1/api-keys");
check("[Kunci] GET /api/v1/api-keys tanpa sesi -> 401 AUTH_REQUIRED", anonKeys.status === 401 && anonKeys.json?.error === "AUTH_REQUIRED", `${anonKeys.status} ${short(anonKeys.json)}`);

const anonDocs = await anon.call("GET", "/api/v1/api-keys/docs");
check("[Kunci] GET /api/v1/api-keys/docs tanpa sesi -> 401", anonDocs.status === 401, `${anonDocs.status} ${short(anonDocs.json)}`);

const emptyKeys = await admin.call("GET", "/api/v1/api-keys");
check("[Kunci] akun baru belum punya kunci", emptyKeys.status === 200 && Array.isArray(emptyKeys.json?.keys) && emptyKeys.json.keys.length === 0, short(emptyKeys.json));
check("[Kunci] daftar kunci menjelaskan bahwa nilai mentah tidak bisa ditampilkan lagi",
  typeof emptyKeys.json?.note === "string" && emptyKeys.json.note.includes("sekali"), short(emptyKeys.json?.note));
check("[Kunci] batas kunci aktif dan batas laju dilaporkan",
  emptyKeys.json?.limits?.maxActive === 20 && emptyKeys.json?.limits?.rateLimitPerMinute === 20, short(emptyKeys.json?.limits));

const createMain = await admin.call("POST", "/api/v1/api-keys", { name: "Skrip laporan harian", scopes: ["read"] });
check("[Kunci] POST /api/v1/api-keys membuat kunci -> 201", createMain.status === 201, `${createMain.status} ${short(createMain.json)}`);
const mainRaw = String(createMain.json?.secret ?? "");
const mainKeyId = createMain.json?.key?.id;
const mainPrefix = String(createMain.json?.key?.prefix ?? "");
check("[Kunci] nilai kunci diawali ck_ dan panjangnya 43 karakter", mainRaw.startsWith("ck_") && mainRaw.length === 43, short(mainRaw).slice(0, 12) + `... (panjang ${mainRaw.length})`);
check("[Kunci] prefix yang tampil adalah 8 karakter awal rahasia (tanpa ck_)", mainPrefix.length === 8 && mainRaw.slice(3, 11) === mainPrefix, `${mainPrefix} vs ${mainRaw.slice(3, 11)}`);
check("[Kunci] izin kunci tersimpan sebagai read", createMain.json?.key?.scopes === "read", short(createMain.json?.key?.scopes));
check("[Kunci] workspace kunci = workspace pribadi pembuatnya", createMain.json?.workspaceId === adminWorkspaceId, short(createMain.json?.workspaceId));
check("[Kunci] respons pembuatan memuat peringatan untuk menyalin nilai sekarang",
  typeof createMain.json?.warning === "string" && createMain.json.warning.includes("tidak bisa"), short(createMain.json?.warning));

const listAfterCreate = await admin.call("GET", "/api/v1/api-keys");
check("[Kunci] daftar kunci memuat satu kunci baru", listAfterCreate.json?.keys?.length === 1, short(listAfterCreate.json?.keys));
check("[Kunci] nilai kunci MENTAH tidak pernah muncul lagi di respons daftar",
  listAfterCreate.text.includes("ck_") === false && !listAfterCreate.text.includes(mainRaw), `panjang respons ${listAfterCreate.text.length}`);
check("[Kunci] kunci baru belum pernah dipakai", listAfterCreate.json?.keys?.[0]?.lastUsedAt === null && listAfterCreate.json?.keys?.[0]?.requestCount === 0, short(listAfterCreate.json?.keys?.[0]));

const docsReply = await admin.call("GET", "/api/v1/api-keys/docs");
check("[Kunci] dokumentasi menyebut fase 'baca saja'", docsReply.status === 200 && docsReply.json?.phase === "baca saja", short(docsReply.json?.phase));
check("[Kunci] dokumentasi memuat 7 endpoint yang benar-benar dilayani", Array.isArray(docsReply.json?.endpoints) && docsReply.json.endpoints.length === 7 && docsReply.json.endpoints.every((row: any) => row.available === true), short(docsReply.json?.endpoints?.length));
check("[Kunci] endpoint tulis dipisah sebagai rencana, bukan sebagai fitur aktif",
  Array.isArray(docsReply.json?.plannedEndpoints) && docsReply.json.plannedEndpoints.length === 2 && docsReply.json.plannedEndpoints.every((row: any) => row.available === false && row.scope === "write"),
  short(docsReply.json?.plannedEndpoints));
check("[Kunci] contoh curl memakai header Authorization Bearer",
  typeof docsReply.json?.example?.curl === "string" && docsReply.json.example.curl.includes("Authorization: Bearer ck_"), short(docsReply.json?.example?.curl));

const badName = await admin.call("POST", "/api/v1/api-keys", { name: "A", scopes: ["read"] });
check("[Kunci] nama kunci terlalu pendek -> 400 INVALID_KEY_NAME", badName.status === 400 && badName.json?.error === "INVALID_KEY_NAME", `${badName.status} ${short(badName.json)}`);
const noScopes = await admin.call("POST", "/api/v1/api-keys", { name: "Tanpa izin", scopes: [] });
check("[Kunci] izin kosong -> 400 INVALID_KEY_SCOPES", noScopes.status === 400 && noScopes.json?.error === "INVALID_KEY_SCOPES", `${noScopes.status} ${short(noScopes.json)}`);
const writeScope = await admin.call("POST", "/api/v1/api-keys", { name: "Izin tulis", scopes: ["write"] });
check("[Kunci] izin write ditolak jujur -> 400 SCOPE_NOT_AVAILABLE", writeScope.status === 400 && writeScope.json?.error === "SCOPE_NOT_AVAILABLE", `${writeScope.status} ${short(writeScope.json)}`);
const foreignWorkspace = await admin.call("POST", "/api/v1/api-keys", { name: "Workspace orang", workspaceId: outsiderWorkspaceId });
check("[Kunci] workspace yang bukan milik kita -> 404 WORKSPACE_NOT_FOUND", foreignWorkspace.status === 404 && foreignWorkspace.json?.error === "WORKSPACE_NOT_FOUND", `${foreignWorkspace.status} ${short(foreignWorkspace.json)}`);

const renameKey = await admin.call("PATCH", `/api/v1/api-keys/${mainKeyId}`, { name: "Skrip laporan malam" });
check("[Kunci] PATCH mengubah nama kunci", renameKey.status === 200 && renameKey.json?.key?.name === "Skrip laporan malam", short(renameKey.json));
const renameBad = await admin.call("PATCH", `/api/v1/api-keys/${mainKeyId}`, { name: "X" });
check("[Kunci] PATCH dengan nama tidak sah -> 400 INVALID_KEY_NAME", renameBad.status === 400 && renameBad.json?.error === "INVALID_KEY_NAME", `${renameBad.status} ${short(renameBad.json)}`);
const patchMissing = await admin.call("PATCH", "/api/v1/api-keys/11111111-2222-3333-4444-555555555555", { name: "Tidak ada" });
check("[Kunci] PATCH kunci yang tidak ada -> 404 API_KEY_NOT_FOUND", patchMissing.status === 404 && patchMissing.json?.error === "API_KEY_NOT_FOUND", `${patchMissing.status} ${short(patchMissing.json)}`);
const deleteMissing = await admin.call("DELETE", "/api/v1/api-keys/11111111-2222-3333-4444-555555555555");
check("[Kunci] DELETE kunci yang tidak ada -> 404", deleteMissing.status === 404 && deleteMissing.json?.error === "API_KEY_NOT_FOUND", `${deleteMissing.status} ${short(deleteMissing.json)}`);

// Kunci yang dicabut harus berhenti bekerja, tetapi barisnya tetap ada sebagai jejak.
const revocable = await admin.call("POST", "/api/v1/api-keys", { name: "Kunci untuk dicabut", scopes: ["read"] });
const revocableRaw = String(revocable.json?.secret ?? "");
const revocableId = revocable.json?.key?.id;
const revoked = await admin.call("DELETE", `/api/v1/api-keys/${revocableId}`);
check("[Kunci] DELETE mencabut kunci", revoked.status === 200 && revoked.json?.revoked === true, short(revoked.json));
const listAfterRevoke = await admin.call("GET", "/api/v1/api-keys");
const revokedRow = (listAfterRevoke.json?.keys ?? []).find((row: any) => row.id === revocableId);
check("[Kunci] kunci yang dicabut tetap terlihat dengan tanggal pencabutan", Boolean(revokedRow?.revokedAt), short(revokedRow));
const revokeAgain = await admin.call("DELETE", `/api/v1/api-keys/${revocableId}`);
check("[Kunci] mencabut dua kali -> 409 API_KEY_ALREADY_REVOKED (bukan sukses palsu)", revokeAgain.status === 409 && revokeAgain.json?.error === "API_KEY_ALREADY_REVOKED", `${revokeAgain.status} ${short(revokeAgain.json)}`);

// ==================================================================== bagian 3: API publik (read)
console.log("\n=== Bagian 3: API publik baca ===");
const noAuth = await anon.call("GET", "/api/v1/public/v1/me");
check("[Publik] tanpa header Authorization -> 401 API_KEY_REQUIRED", noAuth.status === 401 && noAuth.json?.error === "API_KEY_REQUIRED", `${noAuth.status} ${short(noAuth.json)}`);
const wrongAuth = await anon.call("GET", "/api/v1/public/v1/me", undefined, bearer("bukan-kunci"));
check("[Publik] header bukan format kunci -> 401 API_KEY_INVALID", wrongAuth.status === 401 && wrongAuth.json?.error === "API_KEY_INVALID", `${wrongAuth.status} ${short(wrongAuth.json)}`);
const bogusAuth = await anon.call("GET", "/api/v1/public/v1/me", undefined, bearer("ck_" + "0".repeat(40)));
check("[Publik] kunci tidak dikenal -> 401 API_KEY_INVALID", bogusAuth.status === 401 && bogusAuth.json?.error === "API_KEY_INVALID", `${bogusAuth.status} ${short(bogusAuth.json)}`);
const revokedAuth = await anon.call("GET", "/api/v1/public/v1/me", undefined, bearer(revocableRaw));
check("[Publik] kunci yang sudah dicabut -> 401 API_KEY_INVALID", revokedAuth.status === 401 && revokedAuth.json?.error === "API_KEY_INVALID", `${revokedAuth.status} ${short(revokedAuth.json)}`);

const meReply = await anon.call("GET", "/api/v1/public/v1/me", undefined, bearer(mainRaw));
check("[Publik] GET /public/v1/me dengan kunci sah -> 200", meReply.status === 200, `${meReply.status} ${short(meReply.json)}`);
check("[Publik] identitas yang dilaporkan adalah pemilik kunci", meReply.json?.user?.email === adminEmail, short(meReply.json?.user));
check("[Publik] workspace terkunci pada workspace kunci", meReply.json?.workspace?.id === adminWorkspaceId && meReply.json?.workspace?.role === "owner", short(meReply.json?.workspace));
check("[Publik] kuota ikut dilaporkan pada endpoint identitas", typeof meReply.json?.quota?.tier === "string" && typeof meReply.json?.quota?.usedToday === "number", short(meReply.json?.quota));
check("[Publik] metadata kunci dilaporkan (id, nama, izin)", meReply.json?.key?.id === mainKeyId && meReply.json?.key?.scopes === "read", short(meReply.json?.key));

// Siapkan proyek, percakapan, dan satu run nyata (mesin mock) supaya ada data untuk dibaca.
const projectA = await admin.call("POST", `/api/v1/workspaces/${adminWorkspaceId}/projects`, { name: "Proyek Wave4" });
check("[Data] proyek dibuat untuk uji API publik", projectA.status === 201 || projectA.status === 200, `${projectA.status} ${short(projectA.json)}`);
const projectAId = projectA.json?.project?.id ?? projectA.json?.id;
const conversationA = await admin.call("POST", `/api/v1/projects/${projectAId}/conversations`, { title: "Percakapan Wave4" });
check("[Data] percakapan dibuat", conversationA.status === 201 || conversationA.status === 200, `${conversationA.status} ${short(conversationA.json)}`);
const conversationAId = conversationA.json?.conversation?.id ?? conversationA.json?.id;
const sendA = await admin.call("POST", `/api/v1/conversations/${conversationAId}/messages`, { content: "Halo Wave4, tolong ringkas status platform." });
check("[Data] pesan dikirim ke mesin mock -> 202", sendA.status === 202, `${sendA.status} ${short(sendA.json)}`);
const runAId = sendA.json?.run?.id;
const answerA = await waitForAssistantRun(admin, conversationAId, String(runAId));
check("[Data] jawaban assistant muncul dan mencatat pemakaian token", Boolean(answerA), short(answerA));

const workspacesPublic = await anon.call("GET", "/api/v1/public/v1/workspaces", undefined, bearer(mainRaw));
check("[Publik] GET /public/v1/workspaces hanya berisi workspace kunci", workspacesPublic.status === 200 && workspacesPublic.json?.workspaces?.length === 1 && workspacesPublic.json.workspaces[0].id === adminWorkspaceId, short(workspacesPublic.json));

const projectsPublic = await anon.call("GET", "/api/v1/public/v1/projects", undefined, bearer(mainRaw));
check("[Publik] GET /public/v1/projects memuat proyek workspace kunci", projectsPublic.status === 200 && (projectsPublic.json?.projects ?? []).some((row: any) => row.id === projectAId), short(projectsPublic.json));

const conversationsPublic = await anon.call("GET", `/api/v1/public/v1/projects/${projectAId}/conversations`, undefined, bearer(mainRaw));
check("[Publik] GET conversations proyek -> 200 dengan nama proyek", conversationsPublic.status === 200 && conversationsPublic.json?.project?.id === projectAId, short(conversationsPublic.json));
check("[Publik] daftar percakapan memuat percakapan yang baru dibuat", (conversationsPublic.json?.conversations ?? []).some((row: any) => row.id === conversationAId), short(conversationsPublic.json?.conversations));

const messagesPublic = await anon.call("GET", `/api/v1/public/v1/conversations/${conversationAId}/messages`, undefined, bearer(mainRaw));
check("[Publik] GET messages -> 200", messagesPublic.status === 200 && Array.isArray(messagesPublic.json?.messages), short(messagesPublic.json));
check("[Publik] pesan pengguna dan jawaban assistant terlihat lewat API publik", (messagesPublic.json?.messages ?? []).length >= 2, short(messagesPublic.json?.messages?.length));

const usagePublic = await anon.call("GET", `/api/v1/public/v1/projects/${projectAId}/usage`, undefined, bearer(mainRaw));
check("[Publik] GET usage proyek -> 200 dengan token > 0", usagePublic.status === 200 && Number(usagePublic.json?.totals?.tokens) > 0, short(usagePublic.json));
check("[Publik] usage melaporkan jumlah run dan rincian per model", Number(usagePublic.json?.totals?.runs) >= 1 && Array.isArray(usagePublic.json?.byModel) && usagePublic.json.byModel.length >= 1, short(usagePublic.json?.byModel));

const artifactsPublic = await anon.call("GET", `/api/v1/public/v1/projects/${projectAId}/artifacts`, undefined, bearer(mainRaw));
check("[Publik] GET artifacts -> 200 dan jelas bahwa isi berkas tidak disajikan", artifactsPublic.status === 200 && typeof artifactsPublic.json?.note === "string" && artifactsPublic.json.note.includes("tidak disajikan"), short(artifactsPublic.json?.note));

// Proyek milik pengguna lain tidak boleh terlihat, walau kunci sah.
const outsiderProject = await outsider.call("POST", `/api/v1/workspaces/${outsiderWorkspaceId}/projects`, { name: "Proyek Luar" });
const outsiderProjectId = outsiderProject.json?.project?.id ?? outsiderProject.json?.id;
const outsiderConversation = await outsider.call("POST", `/api/v1/projects/${outsiderProjectId}/conversations`, { title: "Percakapan Luar" });
const outsiderConversationId = outsiderConversation.json?.conversation?.id ?? outsiderConversation.json?.id;

const crossProject = await anon.call("GET", `/api/v1/public/v1/projects/${outsiderProjectId}/conversations`, undefined, bearer(mainRaw));
check("[Publik] kunci TIDAK bisa membaca proyek workspace lain -> 404 PROJECT_NOT_FOUND", crossProject.status === 404 && crossProject.json?.error === "PROJECT_NOT_FOUND", `${crossProject.status} ${short(crossProject.json)}`);
const crossUsage = await anon.call("GET", `/api/v1/public/v1/projects/${outsiderProjectId}/usage`, undefined, bearer(mainRaw));
check("[Publik] usage lintas workspace juga 404", crossUsage.status === 404 && crossUsage.json?.error === "PROJECT_NOT_FOUND", `${crossUsage.status} ${short(crossUsage.json)}`);
const crossMessages = await anon.call("GET", `/api/v1/public/v1/conversations/${outsiderConversationId}/messages`, undefined, bearer(mainRaw));
check("[Publik] pesan lintas workspace 404", crossMessages.status === 404 && crossMessages.json?.error === "CONVERSATION_NOT_FOUND", `${crossMessages.status} ${short(crossMessages.json)}`);

// Rute tulis memang belum dilayani; suite mencatatnya sebagai 404, bukan sebagai fitur.
const writeAttempt = await anon.call("POST", `/api/v1/public/v1/projects/${projectAId}/conversations`, { title: "Coba tulis" }, bearer(mainRaw));
check("[Publik] rute tulis publik belum dilayani -> 404", writeAttempt.status === 404, `${writeAttempt.status} ${short(writeAttempt.json)}`);
note("API publik Wave 4 masih baca-saja: POST /api/v1/public/v1/... menjawab 404 dan hanya terdaftar sebagai plannedEndpoints.");

// Pemakaian kunci tercatat.
const afterUse = await admin.call("GET", "/api/v1/api-keys");
const usedRow = (afterUse.json?.keys ?? []).find((row: any) => row.id === mainKeyId);
check("[Publik] pemakaian kunci tercatat (requestCount > 5, lastUsedAt terisi)", Number(usedRow?.requestCount) > 5 && typeof usedRow?.lastUsedAt === "string", short(usedRow));

// Batas laju per kunci: kunci khusus supaya tidak mengganggu uji lain.
const rateKey = await admin.call("POST", "/api/v1/api-keys", { name: "Kunci uji batas laju", scopes: ["read"] });
const rateRaw = String(rateKey.json?.secret ?? "");
let rateLimitHit: any = null;
let rateOkCount = 0;
for (let attempt = 0; attempt < 22 && !rateLimitHit; attempt += 1) {
  const response = await anon.call("GET", "/api/v1/public/v1/me", undefined, bearer(rateRaw));
  if (response.status === 429) rateLimitHit = response; else if (response.status === 200) rateOkCount += 1;
}
check("[Publik] 20 permintaan pertama kunci masih 200", rateOkCount >= 20, `berhasil=${rateOkCount}`);
check("[Publik] permintaan ke-21 -> 429 API_KEY_RATE_LIMITED", rateLimitHit?.json?.error === "API_KEY_RATE_LIMITED", short(rateLimitHit?.json));

// Kunci yang terikat workspace lain tidak bisa dipakai di workspace ini.
const outsiderKey = await outsider.call("POST", "/api/v1/api-keys", { name: "Kunci milik pengguna luar", scopes: ["read"] });
const outsiderRaw = String(outsiderKey.json?.secret ?? "");
const outsiderPublic = await anon.call("GET", "/api/v1/public/v1/projects", undefined, bearer(outsiderRaw));
check("[Publik] kunci milik pengguna luar tidak melihat proyek kita", outsiderPublic.status === 200 && (outsiderPublic.json?.projects ?? []).every((row: any) => row.id !== projectAId), short(outsiderPublic.json?.projects));
const outsiderCross = await anon.call("GET", `/api/v1/public/v1/projects/${projectAId}/usage`, undefined, bearer(outsiderRaw));
check("[Publik] kunci pengguna luar -> 404 untuk proyek kita", outsiderCross.status === 404, `${outsiderCross.status} ${short(outsiderCross.json)}`);

// ==================================================================== bagian 4: antrean email
console.log("\n=== Bagian 4: antrean email (outbox) ===");
const outsiderOutbox = await outsider.call("GET", "/api/v1/admin/email-outbox");
check("[Email] pengguna biasa tidak boleh membuka antrean -> 403 ADMIN_REQUIRED", outsiderOutbox.status === 403 && outsiderOutbox.json?.error === "ADMIN_REQUIRED", `${outsiderOutbox.status} ${short(outsiderOutbox.json)}`);

const outbox = await admin.call("GET", "/api/v1/admin/email-outbox");
check("[Email] admin membuka antrean -> 200", outbox.status === 200, `${outbox.status} ${short(outbox.json)}`);
check("[Email] pekerja email melaporkan fitur MATI (NOTIFY_EMAIL_ENABLED=false)", outbox.json?.worker?.enabled === false, short(outbox.json?.worker));
check("[Email] SMTP tidak dikonfigurasi di lingkungan uji", outbox.json?.worker?.mailerConfigured === false, short(outbox.json?.worker));
check("[Email] catatan menjelaskan pesan hanya masuk antrean", typeof outbox.json?.note === "string" && outbox.json.note.includes("NOTIFY_EMAIL_ENABLED=false"), short(outbox.json?.note));
const welcomeEmail = (outbox.json?.emails ?? []).find((row: any) => row.kind === "account" && row.toEmail === adminEmail);
check("[Email] pendaftaran akun masuk antrean sebagai pesan 'account'", Boolean(welcomeEmail), short((outbox.json?.emails ?? []).slice(0, 3)));
check("[Email] pesan antrean berstatus pending dan belum dikirim", welcomeEmail?.status === "pending" && welcomeEmail?.sentAt === null && welcomeEmail?.attempts === 0, short(welcomeEmail));
check("[Email] subjek diberi awalan [COBLAI Coder]", typeof welcomeEmail?.subject === "string" && welcomeEmail.subject.startsWith("[COBLAI Coder]"), short(welcomeEmail?.subject));
check("[Email] isi pesan memuat tautan ke platform", typeof welcomeEmail?.body === "string" && welcomeEmail.body.includes("http"), short(welcomeEmail?.body));
check("[Email] statistik antrean melaporkan pesan menunggu", Number(outbox.json?.stats?.pending) >= 1 && outbox.json?.stats?.total === Number(outbox.json?.stats?.pending) + Number(outbox.json?.stats?.sent) + Number(outbox.json?.stats?.failed) + Number(outbox.json?.stats?.skipped), short(outbox.json?.stats));

const deliverOff = await admin.call("POST", "/api/v1/admin/email-outbox/deliver");
check("[Email] kirim saat fitur mati -> report reason NOTIFY_EMAIL_DISABLED", deliverOff.status === 200 && deliverOff.json?.enabled === false && deliverOff.json?.reason === "NOTIFY_EMAIL_DISABLED", short(deliverOff.json));
check("[Email] tidak ada pesan yang terkirim saat fitur mati", Number(deliverOff.json?.sent) === 0 && Number(deliverOff.json?.skipped) === 0, short(deliverOff.json));
const stillPending = await admin.call("GET", "/api/v1/admin/email-outbox?status=pending");
check("[Email] pesan tetap berstatus menunggu setelah percobaan kirim", (stillPending.json?.emails ?? []).some((row: any) => row.id === welcomeEmail?.id), short(stillPending.json?.emails?.length));
const retryPending = await admin.call("POST", `/api/v1/admin/email-outbox/${welcomeEmail?.id}/retry`);
check("[Email] kirim ulang untuk pesan yang masih menunggu -> 404 EMAIL_NOT_RETRYABLE", retryPending.status === 404 && retryPending.json?.error === "EMAIL_NOT_RETRYABLE", `${retryPending.status} ${short(retryPending.json)}`);
// Pengiriman email MATI di suite ini, jadi tidak ada pesan yang sedang dikirim: operator boleh
// membersihkan antrean. Saat pengiriman aktif, penghapusan pesan menunggu ditolak
// (409 EMAIL_IN_FLIGHT) dan hal itu diuji di apps/api/test/outbox-mail.e2e.ts.
const deletePending = await admin.call("DELETE", `/api/v1/admin/email-outbox/${welcomeEmail?.id}`);
check("[Email] pesan menunggu boleh dihapus selagi pengiriman mati -> 200", deletePending.status === 200 && deletePending.json?.deleted === true && deletePending.json?.status === "pending", `${deletePending.status} ${short(deletePending.json)}`);
const afterDeletePending = await admin.call("GET", "/api/v1/admin/email-outbox");
check("[Email] pesan yang dihapus hilang dari antrean", !(afterDeletePending.json?.emails ?? []).some((row: any) => row.id === welcomeEmail?.id), short((afterDeletePending.json?.emails ?? []).length));
const sentFilter = await admin.call("GET", "/api/v1/admin/email-outbox?status=sent");
check("[Email] filter status=sent kosong karena belum ada pengiriman", sentFilter.status === 200 && (sentFilter.json?.emails ?? []).length === 0, short(sentFilter.json?.emails));
const deleteUnknownEmail = await admin.call("DELETE", "/api/v1/admin/email-outbox/11111111-2222-3333-4444-555555555555");
check("[Email] hapus pesan yang tidak ada -> 404 EMAIL_NOT_FOUND", deleteUnknownEmail.status === 404 && deleteUnknownEmail.json?.error === "EMAIL_NOT_FOUND", `${deleteUnknownEmail.status} ${short(deleteUnknownEmail.json)}`);

// ==================================================================== bagian 5: preferensi email
console.log("\n=== Bagian 5: preferensi email ===");
const prefs = await admin.call("GET", "/api/v1/account/notification-preferences");
check("[Preferensi] lima jenis email dilaporkan", prefs.status === 200 && (prefs.json?.kinds ?? []).length === 5, short(prefs.json?.kinds));
check("[Preferensi] semua saklar menyala secara bawaan", prefs.json?.preferences?.emailQuota === 1 && prefs.json?.preferences?.emailBilling === 1 && prefs.json?.preferences?.emailSecurity === 1, short(prefs.json?.preferences));
check("[Preferensi] catatan menegaskan notifikasi dalam aplikasi selalu aktif", typeof prefs.json?.note === "string" && prefs.json.note.includes("dalam aplikasi"), short(prefs.json?.note));
const savePrefs = await admin.call("PUT", "/api/v1/account/notification-preferences", { emailBilling: false });
check("[Preferensi] PUT mematikan email tagihan -> tersimpan 0", savePrefs.status === 200 && savePrefs.json?.preferences?.emailBilling === 0, short(savePrefs.json));
const rereadPrefs = await admin.call("GET", "/api/v1/account/notification-preferences");
check("[Preferensi] perubahan bertahan setelah dibaca ulang", rereadPrefs.json?.preferences?.emailBilling === 0, short(rereadPrefs.json?.preferences));
check("[Preferensi] pesan konfirmasi memakai Bahasa Indonesia", typeof savePrefs.json?.message === "string" && savePrefs.json.message.includes("disimpan"), short(savePrefs.json?.message));

// Saklar email tagihan benar-benar dipakai: admin memberi kredit (notifikasi 'billing') dan kita
// membandingkan SELISIH jumlah antrean. Pesan lama tetap ada di antrean, jadi angka mutlak menipu.
async function pendingBilling(toEmail: string): Promise<any[]> {
  const reply = await admin.call("GET", "/api/v1/admin/email-outbox?status=pending");
  return (reply.json?.emails ?? []).filter((row: any) => row.kind === "billing" && row.toEmail === toEmail);
}
// Saklar milik ADMIN dimatikan lebih dulu; kredit diberikan ke ADMIN sendiri.
const adminBillingOff = await admin.call("PUT", "/api/v1/account/notification-preferences", { emailBilling: false });
check("[Preferensi] admin mematikan email tagihan untuk dirinya", adminBillingOff.json?.preferences?.emailBilling === 0, short(adminBillingOff.json?.preferences));
const adminPendingBefore = (await pendingBilling(adminEmail)).length;
const creditAdmin = await admin.call("POST", `/api/v1/admin/users/${adminUserId}/credit`, { tokens: 555, note: "uji preferensi email (admin)" });
check("[Preferensi] pemberian kredit berhasil (sumber notifikasi billing)", creditAdmin.status === 200, `${creditAdmin.status} ${short(creditAdmin.json)}`);
const adminPendingAfter = (await pendingBilling(adminEmail)).length;
check("[Preferensi] email TIDAK diantrekan saat saklar billing pemiliknya mati", adminPendingAfter === adminPendingBefore, `sebelum=${adminPendingBefore} sesudah=${adminPendingAfter}`);
const adminInApp = await admin.call("GET", "/api/v1/notifications");
check("[Preferensi] notifikasi dalam aplikasi tetap masuk walau email dimatikan", (adminInApp.json?.notifications ?? []).some((row: any) => row.kind === "billing"), short((adminInApp.json?.notifications ?? []).length));

const outsiderPrefsOff = await outsider.call("PUT", "/api/v1/account/notification-preferences", { emailBilling: false });
check("[Preferensi] akun luar mematikan email tagihan", outsiderPrefsOff.status === 200 && outsiderPrefsOff.json?.preferences?.emailBilling === 0, short(outsiderPrefsOff.json?.preferences));
const outsiderBefore = (await pendingBilling(outsiderEmail)).length;
const creditOff = await admin.call("POST", `/api/v1/admin/users/${outsiderUserId}/credit`, { tokens: 999, note: "uji preferensi email kedua" });
check("[Preferensi] kredit tetap masuk ke akun luar (notifikasi dalam aplikasi tidak terpengaruh)", creditOff.status === 200, `${creditOff.status} ${short(creditOff.json)}`);
const outsiderAfter = (await pendingBilling(outsiderEmail)).length;
check("[Preferensi] tetap tidak ada email billing baru saat saklar mati", outsiderAfter === outsiderBefore, `sebelum=${outsiderBefore} sesudah=${outsiderAfter}`);
const outsiderInApp = await outsider.call("GET", "/api/v1/notifications");
check("[Preferensi] notifikasi DALAM APLIKASI tetap bertambah walau email dimatikan", (outsiderInApp.json?.notifications ?? []).some((row: any) => row.kind === "billing"), short((outsiderInApp.json?.notifications ?? []).length));

const outsiderPrefsOn = await outsider.call("PUT", "/api/v1/account/notification-preferences", { emailBilling: true });
check("[Preferensi] saklar dinyalakan kembali", outsiderPrefsOn.json?.preferences?.emailBilling === 1, short(outsiderPrefsOn.json?.preferences));
const creditOn = await admin.call("POST", `/api/v1/admin/users/${outsiderUserId}/credit`, { tokens: 777, note: "uji preferensi email ketiga" });
check("[Preferensi] kredit ketiga diterima", creditOn.status === 200, `${creditOn.status} ${short(creditOn.json)}`);
const outsiderAfterOn = (await pendingBilling(outsiderEmail)).length;
check("[Preferensi] TEPAT satu email billing baru diantrekan setelah saklar dinyalakan", outsiderAfterOn === outsiderBefore + 1, `sebelum=${outsiderBefore} sesudah=${outsiderAfterOn}`);
const billingTotal = (await admin.call("GET", "/api/v1/admin/email-outbox?status=pending")).json?.emails ?? [];
check("[Preferensi] jenis 'billing' tidak digabung harian (dua peristiwa = dua pesan berbeda)",
  billingTotal.filter((row: any) => row.kind === "billing").length === 1, `jumlah email billing di antrean=${billingTotal.filter((row: any) => row.kind === "billing").length}`);
// ==================================================================== bagian 6: ekspor data pribadi
console.log("\n=== Bagian 6: ekspor data pribadi ===");
const anonPrivacy = await anon.call("GET", "/api/v1/account/privacy");
check("[Privasi] tanpa sesi -> 401", anonPrivacy.status === 401, `${anonPrivacy.status} ${short(anonPrivacy.json)}`);

const privacy = await admin.call("GET", "/api/v1/account/privacy");
check("[Privasi] ringkasan privasi -> 200", privacy.status === 200, `${privacy.status} ${short(privacy.json)}`);
check("[Privasi] kebijakan retensi ikut dilaporkan", privacy.json?.policy?.auditDays === 365 && privacy.json?.policy?.exportDays === 7, short(privacy.json?.policy));
check("[Privasi] ada minimal 20 bagian data yang disertakan dalam ekspor", (privacy.json?.sectionsInExport ?? []).length >= 20, short(privacy.json?.sectionsInExport?.length));
const sectionNames = (privacy.json?.sectionsInExport ?? []).map((row: any) => row.name);
check("[Privasi] bagian penting data pribadi terdaftar", ["profile", "messages", "runs", "api_keys", "notifications"].every((name) => sectionNames.includes(name)), short(sectionNames));
check("[Privasi] jumlah baris data dihitung nyata (bukan nol)", Number(privacy.json?.storedTotals?.rows) > 0 && Number(privacy.json?.storedTotals?.sections) >= 20, short(privacy.json?.storedTotals));
check("[Privasi] catatan menjelaskan apa yang TIDAK disertakan", Array.isArray(privacy.json?.notes) && privacy.json.notes.some((text: string) => text.includes("MFA") || text.includes("Kata sandi")), short(privacy.json?.notes));

const createExportReply = await admin.call("POST", "/api/v1/account/export");
check("[Ekspor] POST /api/v1/account/export -> 201", createExportReply.status === 201, `${createExportReply.status} ${short(createExportReply.json)}`);
const exportRow = createExportReply.json?.export;
check("[Ekspor] berkas punya ukuran nyata", Number(exportRow?.sizeBytes) > 500, short(exportRow?.sizeBytes));
check("[Ekspor] bagian dikembalikan sebagai array (bukan teks JSON)", Array.isArray(exportRow?.sections) && exportRow.sections.length >= 20, short(exportRow?.sections?.length));
check("[Ekspor] tautan unduh menunjuk ke id ekspor", typeof createExportReply.json?.downloadUrl === "string" && createExportReply.json.downloadUrl.includes(exportRow?.id), short(createExportReply.json?.downloadUrl));
check("[Ekspor] masa berlaku dilaporkan dalam kalimat", typeof createExportReply.json?.message === "string" && createExportReply.json.message.includes("berlaku sampai"), short(createExportReply.json?.message));

const listExportsReply = await admin.call("GET", "/api/v1/account/exports");
check("[Ekspor] daftar ekspor memuat satu berkas", listExportsReply.json?.exports?.length === 1, short(listExportsReply.json?.exports));
const download = await admin.call("GET", `/api/v1/account/exports/${exportRow?.id}/download`);
check("[Ekspor] unduh berkas -> 200", download.status === 200, `${download.status} ${short(download.text)}`);
check("[Ekspor] header unduhan memaksa simpan berkas", String(download.headers.get("content-disposition") ?? "").includes("attachment") && String(download.headers.get("content-disposition") ?? "").includes("coblai-data-akun"), short(download.headers.get("content-disposition")));
let exportJson: any = null;
try { exportJson = JSON.parse(download.text); } catch { exportJson = null; }
check("[Ekspor] isi berkas adalah JSON yang sah dengan penanda format", exportJson?.format === "coblai-coder-export/1", short(download.text).slice(0, 120));
check("[Ekspor] identitas pemilik ada di dalam berkas", exportJson?.user?.email === adminEmail, short(exportJson?.user));
check("[Ekspor] pesan percakapan ikut diekspor", Array.isArray(exportJson?.data?.messages) && exportJson.data.messages.length >= 2, short(exportJson?.data?.messages?.length));
check("[Ekspor] metadata kunci API ikut diekspor tanpa nilai rahasia", Array.isArray(exportJson?.data?.api_keys) && exportJson.data.api_keys.length >= 2, short(exportJson?.data?.api_keys?.length));
check("[Ekspor] nilai kunci mentah TIDAK ada di berkas ekspor", !download.text.includes(mainRaw) && !download.text.includes(rateRaw), "tidak ditemukan ck_ mentah");
check("[Ekspor] hash kata sandi dan rahasia MFA TIDAK ada di berkas ekspor",
  !download.text.includes("password_hash") && !download.text.includes("mfa_secret") && !download.text.includes(password), "tidak ditemukan bahan rahasia");
check("[Ekspor] pemakaian token pribadi ikut diekspor di bagian 'usage'",
  Array.isArray(exportJson?.data?.usage) && exportJson.data.usage.length >= 1 && Number(exportJson.data.usage[0]?.totalTokens) > 0,
  `usage=${short(exportJson?.data?.usage?.length)} ${short(exportJson?.data?.usage?.[0])}`);

const crossDownload = await outsider.call("GET", `/api/v1/account/exports/${exportRow?.id}/download`);
check("[Ekspor] pengguna lain tidak bisa mengunduh ekspor kita -> 404 EXPORT_NOT_FOUND", crossDownload.status === 404 && crossDownload.json?.error === "EXPORT_NOT_FOUND", `${crossDownload.status} ${short(crossDownload.json)}`);
const anonDownload = await anon.call("GET", `/api/v1/account/exports/${exportRow?.id}/download`);
check("[Ekspor] tanpa sesi -> 401", anonDownload.status === 401, `${anonDownload.status} ${short(anonDownload.json)}`);
const unknownDownload = await admin.call("GET", "/api/v1/account/exports/11111111-2222-3333-4444-555555555555/download");
check("[Ekspor] id tidak dikenal -> 404", unknownDownload.status === 404, `${unknownDownload.status} ${short(unknownDownload.json)}`);

const deleteExportReply = await admin.call("DELETE", `/api/v1/account/exports/${exportRow?.id}`);
check("[Ekspor] DELETE menghapus ekspor", deleteExportReply.status === 200 && deleteExportReply.json?.deleted === true, short(deleteExportReply.json));
const afterDelete = await admin.call("GET", "/api/v1/account/exports");
check("[Ekspor] daftar ekspor kembali kosong", (afterDelete.json?.exports ?? []).length === 0, short(afterDelete.json?.exports));
const downloadAfterDelete = await admin.call("GET", `/api/v1/account/exports/${exportRow?.id}/download`);
check("[Ekspor] berkas yang sudah dihapus tidak bisa diunduh lagi -> 404", downloadAfterDelete.status === 404, `${downloadAfterDelete.status} ${short(downloadAfterDelete.json)}`);
const deleteExportAgain = await admin.call("DELETE", `/api/v1/account/exports/${exportRow?.id}`);
check("[Ekspor] menghapus dua kali -> 404", deleteExportAgain.status === 404, `${deleteExportAgain.status} ${short(deleteExportAgain.json)}`);

// ==================================================================== bagian 7: retensi (laporan saja)
console.log("\n=== Bagian 7: retensi ===");
const outsiderRetention = await outsider.call("GET", "/api/v1/admin/retention");
check("[Retensi] pengguna biasa -> 403 ADMIN_REQUIRED", outsiderRetention.status === 403 && outsiderRetention.json?.error === "ADMIN_REQUIRED", `${outsiderRetention.status} ${short(outsiderRetention.json)}`);
const anonRetentionRun = await anon.call("POST", "/api/v1/admin/retention/run", { dryRun: true });
check("[Retensi] tanpa sesi -> 401", anonRetentionRun.status === 401, `${anonRetentionRun.status} ${short(anonRetentionRun.json)}`);

const retention = await admin.call("GET", "/api/v1/admin/retention");
check("[Retensi] admin membuka laporan -> 200", retention.status === 200, `${retention.status} ${short(retention.json)}`);
check("[Retensi] fitur dilaporkan MATI (RETENTION_ENABLED=false)", retention.json?.policy?.enabled === false && retention.json?.enabled === false, short(retention.json?.policy));
const retentionTables = (retention.json?.tables ?? []).map((row: any) => row.table);
check("[Retensi] lima sasaran pembersihan terdaftar", ["audit_events", "notifications", "run_events", "auth_tokens", "data_exports"].every((name) => retentionTables.includes(name)), short(retentionTables));
check("[Retensi] setiap sasaran punya batas waktu dan hitungan", (retention.json?.tables ?? []).every((row: any) => typeof row.cutoff === "string" && typeof row.candidates === "number"), short(retention.json?.tables));
check("[Retensi] jumlah calon total dijumlahkan", Number(retention.json?.totalCandidates) === (retention.json?.tables ?? []).reduce((sum: number, row: any) => sum + row.candidates, 0), short(retention.json?.totalCandidates));
check("[Retensi] catatan menegaskan tidak ada data yang dihapus", typeof retention.json?.note === "string" && retention.json.note.includes("RETENTION_ENABLED=false"), short(retention.json?.note));

const dryRunReply = await admin.call("POST", "/api/v1/admin/retention/run", { dryRun: true });
check("[Retensi] mode uji -> dryRun true dan tidak ada yang dihapus", dryRunReply.status === 200 && dryRunReply.json?.dryRun === true && Number(dryRunReply.json?.totalRemoved) === 0, short(dryRunReply.json));
check("[Retensi] mode uji menyebut dirinya uji di pesan", typeof dryRunReply.json?.message === "string" && dryRunReply.json.message.includes("Mode uji"), short(dryRunReply.json?.message));
check("[Retensi] tidak ada baris yang ditandai terhapus di setiap sasaran", (dryRunReply.json?.tables ?? []).every((row: any) => Number(row.removed) === 0), short(dryRunReply.json?.tables));

const realRunWhileOff = await admin.call("POST", "/api/v1/admin/retention/run", { dryRun: false });
check("[Retensi] permintaan hapus saat fitur mati -> ditolak dengan alasan RETENTION_DISABLED", realRunWhileOff.json?.reason === "RETENTION_DISABLED", short(realRunWhileOff.json));
check("[Retensi] permintaan hapus saat fitur mati tetap tidak menghapus apa pun", realRunWhileOff.json?.dryRun === true && Number(realRunWhileOff.json?.totalRemoved) === 0, short(realRunWhileOff.json));
const auditTarget = (realRunWhileOff.json?.tables ?? []).find((row: any) => row.table === "audit_events");
check("[Retensi] baris audit yang masih baru TIDAK dihitung sebagai calon penghapusan", auditTarget?.candidates === 0, short(auditTarget));
check("[Retensi] batas waktu audit dihitung dari kebijakan 365 hari (bukan dari hari ini)", String(auditTarget?.cutoff ?? "") < new Date(Date.now() - 300 * 24 * 3600 * 1000).toISOString().slice(0, 10), short(auditTarget?.cutoff));

// ==================================================================== bagian 8: harga publik
console.log("\n=== Bagian 8: halaman harga publik ===");
const publicPlans = await anon.call("GET", "/api/v1/public/plans");
check("[Harga] GET /api/v1/public/plans tanpa sesi -> 200", publicPlans.status === 200, `${publicPlans.status} ${short(publicPlans.json)}`);
check("[Harga] hanya lima kelompok data yang dipublikasikan", Object.keys(publicPlans.json ?? {}).sort().join(",") === "branding,currency,gateways,plans,usdToIdrRate", short(Object.keys(publicPlans.json ?? {})));
const publicPlansList = publicPlans.json?.plans ?? [];
check("[Harga] minimal tiga paket aktif dilaporkan", Array.isArray(publicPlansList) && publicPlansList.length >= 3, short(publicPlansList.length));
check("[Harga] mata uang dan kurs dilaporkan", publicPlans.json?.currency === "IDR" && Number(publicPlans.json?.usdToIdrRate) > 0, `${publicPlans.json?.currency} ${publicPlans.json?.usdToIdrRate}`);
check("[Harga] paket gratis tersedia dengan harga 0", publicPlansList.some((plan: any) => Number(plan.priceIdr) === 0), short(publicPlansList.map((plan: any) => [plan.code, plan.priceIdr])));
check("[Harga] setiap paket memuat batas token harian dan bulanan", publicPlansList.every((plan: any) => typeof plan.dailyTokenLimit === "number" && typeof plan.monthlyTokenLimit === "number" && typeof plan.periodDays === "number"), short(publicPlansList[0]));
check("[Harga] status gateway berupa boolean", typeof publicPlans.json?.gateways?.xendit === "boolean" && typeof publicPlans.json?.gateways?.midtrans === "boolean" && publicPlans.json?.gateways?.manualTransfer === true, short(publicPlans.json?.gateways));
check("[Harga] TIDAK ada kunci rahasia yang bocor di halaman harga",
  !/secret|serverKey|clientKey|callbackToken|XENDIT_|MIDTRANS_/i.test(publicPlans.text), short(publicPlans.text).slice(0, 200));
check("[Harga] identitas merek ikut dilaporkan sesuai penyimpanan", typeof publicPlans.json?.branding === "object" && publicPlans.json.branding !== null, short(publicPlans.json?.branding));

// ==================================================================== bagian 9: RBAC, kuota, dan penggabungan email harian
console.log("\n=== Bagian 9: RBAC, kuota, dan penggabungan email ===");
const invitation = await admin.call("POST", `/api/v1/workspaces/${adminWorkspaceId}/invitations`, { email: outsiderEmail, role: "viewer" });
check("[RBAC] undangan viewer dibuat dan tokennya dikembalikan ke pengundang", invitation.status === 201 && typeof invitation.json?.token === "string", `${invitation.status} ${short(invitation.json?.id)}`);
const accept = await outsider.call("POST", "/api/v1/invitations/accept", { token: invitation.json?.token });
check("[RBAC] pengguna luar menerima undangan sebagai viewer", accept.status === 200, `${accept.status} ${short(accept.json)}`);
const viewersList = await admin.call("GET", `/api/v1/workspaces/${adminWorkspaceId}/members`);
check("[RBAC] peran viewer terlihat di daftar anggota", (viewersList.json ?? []).some((row: any) => row.email === outsiderEmail && row.role === "viewer"), short(viewersList.json));
const viewerCreateKey = await outsider.call("POST", "/api/v1/api-keys", { name: "Kunci viewer", workspaceId: adminWorkspaceId });
check("[RBAC] viewer tidak boleh membuat kunci untuk workspace itu -> 403 VIEWER_READ_ONLY", viewerCreateKey.status === 403 && viewerCreateKey.json?.error === "VIEWER_READ_ONLY", `${viewerCreateKey.status} ${short(viewerCreateKey.json)}`);
const viewerAudit = await admin.call("GET", `/api/v1/workspaces/${adminWorkspaceId}/audit?limit=300`);
const auditActions = (viewerAudit.json ?? []).map((row: any) => row.action);
check("[RBAC] pembuatan dan pencabutan kunci tercatat di audit", auditActions.includes("api_key.created") && auditActions.includes("api_key.revoked"), short(auditActions.filter((row: string) => row.startsWith("api_key"))));
check("[RBAC] ekspor data pribadi tercatat di audit workspace pemiliknya", auditActions.includes("account.export.created") && auditActions.includes("account.export.deleted"), short(auditActions.filter((row: string) => row.startsWith("account."))));
check("[RBAC] perubahan preferensi email tercatat di audit", auditActions.includes("account.notification_preferences.updated"), short(auditActions.filter((row: string) => row.startsWith("account."))));

// Batas jumlah kunci aktif per akun (20) — diuji sampai ditolak.
let createdUntilLimit = 0;
let limitReply: any = null;
for (let attempt = 0; attempt < 25 && !limitReply; attempt += 1) {
  const response = await admin.call("POST", "/api/v1/api-keys", { name: `Kunci tambahan ${attempt}`, scopes: ["read"] });
  if (response.status === 201) createdUntilLimit += 1; else limitReply = response;
}
check("[Kunci] pembuatan kunci berhenti pada batas 20 kunci aktif", limitReply?.status === 409 && limitReply?.json?.error === "TOO_MANY_API_KEYS", `${limitReply?.status} ${short(limitReply?.json)}`);
check("[Kunci] jumlah kunci aktif tepat 20 saat penolakan", createdUntilLimit >= 10, `tambahan yang dibuat=${createdUntilLimit}`);

// Kuota: paket gratis dibuat sangat kecil supaya kuota benar-benar habis untuk akun NON-admin.
// Akun ini SENGAJA baru dan belum pernah diberi kredit: kredit menaikkan plafon harian
// (plafon = batas paket + kredit), jadi akun ber-kredit tidak bisa dipakai menguji kehabisan kuota.
const quotaEmail = `wave4-kuota-${stamp}@example.test`;
const quotaUser = client();
const quotaReg = await quotaUser.call("POST", "/api/v1/auth/register", { email: quotaEmail, password, displayName: "Pengguna Kuota Wave4" });
check("[Kuota] akun ketiga tanpa kredit dibuat untuk uji kuota", quotaReg.status === 201, `${quotaReg.status} ${short(quotaReg.json)}`);
const quotaWorkspaceId = quotaReg.json?.workspace?.id;
const quotaProject = await quotaUser.call("POST", `/api/v1/workspaces/${quotaWorkspaceId}/projects`, { name: "Proyek Kuota" });
const quotaProjectId = quotaProject.json?.project?.id ?? quotaProject.json?.id;
const quotaConversation = await quotaUser.call("POST", `/api/v1/projects/${quotaProjectId}/conversations`, { title: "Percakapan Kuota" });
const quotaConversationId = quotaConversation.json?.conversation?.id ?? quotaConversation.json?.id;
check("[Kuota] proyek dan percakapan akun kuota siap", typeof quotaProjectId === "string" && typeof quotaConversationId === "string", short(quotaConversation.json));
const quotaBefore = await quotaUser.call("GET", `/api/v1/projects/${quotaProjectId}/usage`);
check("[Kuota] akun baru belum memakai token", Number(quotaBefore.json?.totals?.totalTokens ?? -1) === 0, short(quotaBefore.json?.totals));

const freePlanBefore = await admin.call("GET", "/api/v1/admin/plans");
const freePlanRow = (freePlanBefore.json?.plans ?? []).find((plan: any) => plan.code === "free");
const originalDailyLimit = Number(freePlanRow?.dailyTokenLimit ?? 0);
check("[Kuota] paket gratis awal dibaca untuk dipulihkan nanti", originalDailyLimit > 0, `dailyTokenLimit awal=${originalDailyLimit}`);
const shrinkFree = await admin.call("PATCH", "/api/v1/admin/plans/free", { dailyTokenLimit: 1 });
check("[Kuota] batas harian paket gratis diturunkan menjadi 1 token", shrinkFree.status === 200 && Number(shrinkFree.json?.plan?.dailyTokenLimit) === 1, short(shrinkFree.json));

const quotaSend1 = await quotaUser.call("POST", `/api/v1/conversations/${quotaConversationId}/messages`, { content: "Pesan pertama sebelum kuota habis." });
check("[Kuota] pengguna non-admin masih bisa menjalankan satu kali", quotaSend1.status === 202, `${quotaSend1.status} ${short(quotaSend1.json)}`);
await waitForAssistantRun(quotaUser, quotaConversationId, String(quotaSend1.json?.run?.id));
let quotaTokens = 0;
for (let attempt = 0; attempt < 40 && quotaTokens === 0; attempt += 1) {
  // Rute privat memakai nama totalTokens; rute publik memakai tokens.
  const usageNow = await quotaUser.call("GET", `/api/v1/projects/${quotaProjectId}/usage`);
  quotaTokens = Number(usageNow.json?.totals?.totalTokens ?? 0);
  if (quotaTokens === 0) await sleep(100);
}
check("[Kuota] pemakaian token tercatat melebihi batas 1 token", quotaTokens > 1, `tokens=${quotaTokens}`);

const quotaSend2 = await quotaUser.call("POST", `/api/v1/conversations/${quotaConversationId}/messages`, { content: "Pesan kedua, kuota harus habis." });
check("[Kuota] kuota harian habis -> 429 DAILY_TOKEN_QUOTA_EXCEEDED", quotaSend2.status === 429 && quotaSend2.json?.error === "DAILY_TOKEN_QUOTA_EXCEEDED", `${quotaSend2.status} ${short(quotaSend2.json)}`);
const quotaSend3 = await quotaUser.call("POST", `/api/v1/conversations/${quotaConversationId}/messages`, { content: "Pesan ketiga, kuota tetap habis." });
check("[Kuota] percobaan kedua juga 429 (notifikasi berulang di aplikasi)", quotaSend3.status === 429, `${quotaSend3.status} ${short(quotaSend3.json)}`);
check("[Kuota] pesan penolakan menjelaskan sisa kuota atau pemulihan", typeof quotaSend2.json?.message === "string" && quotaSend2.json.message.length > 10, short(quotaSend2.json?.message));

const quotaOutbox = await admin.call("GET", "/api/v1/admin/email-outbox?status=pending");
const quotaEmails = (quotaOutbox.json?.emails ?? []).filter((row: any) => row.kind === "quota" && row.toEmail === quotaEmail);
check("[Kuota] email peringatan kuota diantrekan untuk pemilik akun", quotaEmails.length === 1, short(quotaEmails));
check("[Kuota] dua peristiwa kuota dalam satu hari digabung menjadi SATU email", quotaEmails.length === 1, `jumlah email=${quotaEmails.length}`);
check("[Kuota] subjek email kuota menyebut kuota habis", String(quotaEmails[0]?.subject ?? "").includes("Kuota"), short(quotaEmails[0]?.subject));
const quotaNotifications = await quotaUser.call("GET", "/api/v1/notifications");
const quotaInApp = (quotaNotifications.json?.notifications ?? []).filter((row: any) => row.kind === "quota");
check("[Kuota] notifikasi dalam aplikasi tercatat DUA kali (penggabungan hanya berlaku untuk email)", quotaInApp.length === 2, `jumlah notifikasi=${quotaInApp.length}`);
check("[Kuota] kunci API tetap bisa dibaca saat kuota habis (kuota hanya membatasi run AI)",
  (await quotaUser.call("GET", "/api/v1/api-keys")).status === 200, "GET /api/v1/api-keys tetap 200");
const adminBypass = await admin.call("POST", `/api/v1/conversations/${conversationAId}/messages`, { content: "Admin tetap boleh bekerja walau kuota habis." });
check("[Kuota] admin platform tetap bisa mengirim pesan saat kuota habis (batas paket 1 token)", adminBypass.status === 202, `${adminBypass.status} ${short(adminBypass.json)}`);
const adminUsageWhileShrunk = await admin.call("GET", `/api/v1/projects/${projectAId}/usage`);
check("[Kuota] admin benar-benar melampaui batas 1 token namun tidak diblokir (pengecualian admin)", Number(adminUsageWhileShrunk.json?.totals?.totalTokens ?? 0) > 1, short(adminUsageWhileShrunk.json?.totals));

const restoreFree = await admin.call("PATCH", "/api/v1/admin/plans/free", { dailyTokenLimit: originalDailyLimit });
check("[Kuota] batas harian paket gratis dipulihkan seperti semula", restoreFree.status === 200 && Number(restoreFree.json?.plan?.dailyTokenLimit) === originalDailyLimit, short(restoreFree.json?.plan));
const quotaSend4 = await quotaUser.call("POST", `/api/v1/conversations/${quotaConversationId}/messages`, { content: "Pesan setelah batas dipulihkan." });
check("[Kuota] setelah dipulihkan, pengguna non-admin bisa bekerja lagi", quotaSend4.status === 202, `${quotaSend4.status} ${short(quotaSend4.json)}`);

// ==================================================================== ringkasan
console.log("");
console.log(`RINGKASAN WAVE 4: ${checks} pemeriksaan, ${passed} lulus, ${failed} gagal, ${skipped.length} dilewati.`);
if (failedNames.length) {
  console.log("Pemeriksaan yang gagal:");
  for (const name of failedNames) console.log(` - ${name}`);
}
if (skipped.length) {
  console.log("Pemeriksaan yang dilewati:");
  for (const name of skipped) console.log(` - ${name}`);
}
if (notes.length) {
  console.log("Catatan perilaku nyata (temuan / penyimpangan):");
  for (const text of notes) console.log(` - ${text}`);
}
if (failed > 0) {
  console.log("WAVE4_TESTS_FAILED");
  process.exit(1);
}
console.log("ALL_WAVE4_TESTS_PASSED");
process.exit(0);

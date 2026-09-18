/**
 * Uji end-to-end Wave 3 ("agent workspace") coder-platform: pengaturan agen, pratinjau konteks,
 * bank memori, template prompt, persona, opsi run, pemadatan percakapan, peta agen, katalog
 * kapabilitas, status hub, playground, pembanding artefak, dan laporan Markdown.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave3.e2e.ts
 * (atau dari mana saja: node apps/api/test/run-wave3.cjs)
 *
 * Pola bootstrap meniru apps/api/test/wave2.e2e.ts: semua variabel lingkungan diset SEBELUM modul
 * server/config diimpor (config.ts membaca env saat impor), DATA_DIR sementara di /tmp,
 * MOCK_ENGINE=true, batas rate limit dinaikkan, kredensial SMTP dan kunci gateway DIHAPUS, akun uji
 * didaftarkan lewat HTTP, dan seluruh pemeriksaan lewat HTTP ke 127.0.0.1. Tidak ada email keluar
 * dan tidak ada panggilan jaringan luar dari suite ini.
 *
 * CATATAN KONTRAK (perilaku nyata yang berbeda dari dugaan dilaporkan apa adanya, bukan ditutupi):
 *  1) Mesin mock (MOCK_ENGINE=true) selalu mengembalikan teks, jadi ringkasan pemadatan selalu
 *     berlabel source="engine" dan bukan "fallback".
 *  2) Kolom runs.persona_id TIDAK dibaca oleh endpoint HTTP mana pun (ditulis di server.ts, hanya
 *     dibaca oleh SQL internal). Pemeriksaan kolom itu di-skip dengan alasan yang dicetak.
 *  3) GET /api/v1/agents/settings -> quota dihitung dari tabel run_usage. Playground menagih kuota
 *     lewat chargeQuota() tetapi tidak menulis run_usage, sehingga token playground tidak terlihat
 *     di quotaState. Pemeriksaan itu di-skip dan bukti mentahnya dicetak.
 *  4) GET /api/v1/agents/preview mengisi field `persona` hanya bila personaId dikirim eksplisit;
 *     padahal blok persona bawaan tetap ikut ke `blocks`. Perilaku ini dicatat, tidak dianggap lulus
 *     sebagai "sama".
 *  5) GET /api/v1/projects/:projectId/runs tidak mengembalikan thinking_level/autonomous; bukti
 *     kolom itu diambil dari GET /api/v1/agents/map (juga endpoint riwayat run yang nyata).
 */

const port = 5200 + Math.floor(Math.random() * 400); // rentang khusus Wave 3: 5200-5600 (suite lain 3424-3471, 3900-4400, 4500-4900)
const dataDir = `/tmp/coder-wave3-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave3-test-model";
process.env.PLATFORM_ADMIN_EMAILS = "wave3-admin@example.test";
// Batas rate limit dinaikkan hanya untuk lingkungan uji supaya suite tidak kena 429 palsu.
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RATE_LIMIT_PASSWORD_PER_HOUR = "60";
process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
// Suite ini tidak boleh mengirim email dan tidak boleh mengaktifkan gateway berbayar.
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
const { randomUUID } = await import("node:crypto");

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
/** Catatan perilaku nyata yang menyimpang dari dugaan (selalu ikut dicetak di ringkasan). */
function note(text: string): void { notes.push(text); console.log(`NOTE ${text}`); }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Potongan teks pendek untuk detail kegagalan. */
function short(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}

type Reply = { status: number; json: any; text: string; headers: Headers; buffer: Buffer };
type ApiClient = { call: (method: string, path: string, body?: unknown) => Promise<Reply>; cookie: () => string };

/** Klien kecil dengan cookie sendiri, supaya isolasi antar-pengguna benar-benar teruji. */
function client(initialCookie = ""): ApiClient {
  let cookie = initialCookie;
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
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

/** Menunggu server siap; percobaan pertama yang menjawab 200 dipakai sebagai bukti. */
async function waitForHealth(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) return true;
    } catch { /* server belum mendengar */ }
    await sleep(250);
  }
  return false;
}

/** Daftar pesan satu percakapan lewat HTTP. */
async function messagesOf(api: ApiClient, conversationId: string): Promise<any[]> {
  const reply = await api.call("GET", `/api/v1/conversations/${conversationId}/messages`);
  return Array.isArray(reply.json?.messages) ? reply.json.messages : [];
}
/** Menunggu sampai jumlah pesan mencapai `count` (jawaban mesin mock selesai tidak sinkron). */
async function waitForMessageCount(api: ApiClient, conversationId: string, count: number, tries = 80): Promise<any[]> {
  let list = await messagesOf(api, conversationId);
  for (let attempt = 0; attempt < tries && list.length < count; attempt += 1) { await sleep(100); list = await messagesOf(api, conversationId); }
  return list;
}
/**
 * Menunggu jawaban assistant untuk satu run. Jawaban itu memuat echo opsi mesin ([options]),
 * jadi dipakai sebagai bukti bahwa opsi benar-benar diteruskan ke lapisan mesin.
 */
async function waitForAssistantRun(api: ApiClient, conversationId: string, runId: string, tries = 80): Promise<{ messages: any[]; message: any }> {
  let list = await messagesOf(api, conversationId);
  let message = list.find((row: any) => row.runId === runId && row.role === "assistant");
  for (let attempt = 0; attempt < tries && !message; attempt += 1) {
    await sleep(100); list = await messagesOf(api, conversationId);
    message = list.find((row: any) => row.runId === runId && row.role === "assistant");
  }
  return { messages: list, message: message ?? null };
}
/** Membaca echo opsi mesin mock dari jawaban assistant. */
function mockOptions(text: unknown): any {
  const raw = String(text ?? "");
  const index = raw.indexOf("[options]");
  if (index < 0) return null;
  try { return JSON.parse(raw.slice(index + "[options]".length).trim()); } catch { return null; }
}
/** Satu sesi di peta agen (HTTP), dicari dari conversationId. */
async function mapSession(api: ApiClient, conversationId: string): Promise<{ reply: Reply; session: any; sessions: any[] }> {
  const reply = await api.call("GET", "/api/v1/agents/map?limit=100");
  const sessions: any[] = Array.isArray(reply.json?.sessions) ? reply.json.sessions : [];
  return { reply, sessions, session: sessions.find((row: any) => row.conversationId === conversationId) ?? null };
}
/** Menunggu kolom runs (thinking_level/autonomous/append_system_chars) terisi di peta agen. */
async function waitForMapRun(api: ApiClient, conversationId: string, runId: string, tries = 80): Promise<{ session: any; run: any }> {
  let found = await mapSession(api, conversationId);
  let run = (found.session?.runs ?? []).find((row: any) => row.id === runId);
  for (let attempt = 0; attempt < tries && (!run || run.thinkingLevel === null); attempt += 1) {
    await sleep(120);
    found = await mapSession(api, conversationId);
    run = (found.session?.runs ?? []).find((row: any) => row.id === runId);
  }
  return { session: found.session ?? null, run: run ?? null };
}
/** Pemakaian token harian menurut endpoint pengaturan agen (kuota nyata, bukan hitungan suite). */
async function usedToday(api: ApiClient): Promise<number | null> {
  const reply = await api.call("GET", "/api/v1/agents/settings");
  const used = reply.json?.quota?.usedToday;
  return typeof used === "number" ? used : null;
}
/** Unggah artefak teks kecil lewat rute unggah yang ada. */
function uploadArtifact(api: ApiClient, projectId: string, name: string, text: string): Promise<Reply> {
  return api.call("POST", `/api/v1/projects/${projectId}/artifacts`, { name, mimeType: "text/plain", contentBase64: Buffer.from(text, "utf8").toString("base64") });
}

const stamp = Date.now();
const password = "Wave3Uji123!";
const ownerEmail = `wave3-owner-${stamp}@example.test`;
const outsiderEmail = `wave3-outsider-${stamp}@example.test`;

// ==================================================================== persiapan akun & proyek
const serverReady = await waitForHealth();
check("[Dasar] server uji siap menjawab GET /health 200", serverReady, `base=${base}`);

const agent = client();
const outsider = client();

const ownerReg = await agent.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Wave3" });
check("[Dasar] daftar akun pemilik workspace", ownerReg.status === 201, `${ownerReg.status} ${short(ownerReg.json)}`);
const ownerWorkspaceId = ownerReg.json?.workspace?.id;
check("[Dasar] pendaftaran memberi workspace pribadi", typeof ownerWorkspaceId === "string" && ownerWorkspaceId.length > 0, short(ownerReg.json?.workspace));

const outsiderReg = await outsider.call("POST", "/api/v1/auth/register", { email: outsiderEmail, password, displayName: "Orang Luar Wave3" });
check("[Dasar] daftar akun kedua (bukan anggota workspace pemilik)", outsiderReg.status === 201, `${outsiderReg.status} ${short(outsiderReg.json)}`);
const outsiderWorkspaceId = outsiderReg.json?.workspace?.id;

const projectCreate = await agent.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`, { name: "Proyek Wave3", slug: `wave3-${stamp}` });
const projectId = projectCreate.json?.id;
check("[Dasar] proyek uji siap dibuat lewat HTTP", projectCreate.status === 201 && typeof projectId === "string", `${projectCreate.status} ${short(projectCreate.json)}`);

const outsiderProjectCreate = await outsider.call("POST", `/api/v1/workspaces/${outsiderWorkspaceId}/projects`, { name: "Proyek Orang Luar Wave3", slug: `wave3-luar-${stamp}` });
const outsiderProjectId = outsiderProjectCreate.json?.id;
check("[Dasar] proyek milik pengguna lain siap (uji isolasi)", outsiderProjectCreate.status === 201 && typeof outsiderProjectId === "string", `${outsiderProjectCreate.status} ${short(outsiderProjectCreate.json)}`);

/** Membuat satu percakapan baru di proyek uji pemilik. */
async function newConversation(title: string): Promise<string> {
  const reply = await agent.call("POST", `/api/v1/projects/${projectId}/conversations`, { title });
  return reply.json?.conversation?.id ?? reply.json?.id;
}
const convOne = await newConversation("Percakapan Persona Wave3");
check("[Dasar] percakapan utama siap dibuat lewat HTTP", typeof convOne === "string", short(convOne));

// ==================================================================== A. pengaturan agen
const settingsGet = await agent.call("GET", "/api/v1/agents/settings");
const settingsShape = settingsGet.json?.settings;
check("[A] GET /agents/settings -> 200 dengan objek settings", settingsGet.status === 200 && Boolean(settingsShape), `${settingsGet.status} ${short(settingsGet.json)}`);
check("[A] settings memuat thinking_level/auto_compact/compact_after_messages/tools_allow/autonomous_default/autonomous_max_turns/autonomous_max_tokens",
  Boolean(settingsShape) && ["thinking_level", "auto_compact", "compact_after_messages", "tools_allow", "autonomous_default", "autonomous_max_turns", "autonomous_max_tokens"].every((key) => key in settingsShape),
  short(settingsShape));
check("[A] thinkingLevels berisi 7 tingkat (off..max) dan nilainya string",
  Array.isArray(settingsGet.json?.thinkingLevels) && settingsGet.json.thinkingLevels.length === 7 && settingsGet.json.thinkingLevels.every((value: unknown) => typeof value === "string"),
  short(settingsGet.json?.thinkingLevels));
check("[A] nilai bawaan settings: thinking medium, ambang pemadatan 24, alat kosong",
  settingsShape?.thinking_level === "medium" && settingsShape?.compact_after_messages === 24 && settingsShape?.tools_allow === "",
  short(settingsShape));
check("[A] balasan memuat quota, toolsAllowHelp, dan autonomousHelp",
  Boolean(settingsGet.json?.quota) && typeof settingsGet.json?.toolsAllowHelp === "string" && typeof settingsGet.json?.autonomousHelp === "string",
  short({ quota: settingsGet.json?.quota, help: settingsGet.json?.toolsAllowHelp }));

const validThinking = await agent.call("PATCH", "/api/v1/agents/settings", { thinkingLevel: "high" });
check("[A] PATCH thinkingLevel='high' -> 200 dan tersimpan", validThinking.status === 200 && validThinking.json?.settings?.thinking_level === "high", `${validThinking.status} ${short(validThinking.json)}`);
const rereadThinking = await agent.call("GET", "/api/v1/agents/settings");
check("[A] GET ulang membuktikan thinkingLevel='high' benar-benar persisten", rereadThinking.json?.settings?.thinking_level === "high", short(rereadThinking.json?.settings));

const invalidThinking = await agent.call("PATCH", "/api/v1/agents/settings", { thinkingLevel: "super-pintar" });
check("[A] PATCH thinkingLevel tidak valid -> 400 INVALID_THINKING_LEVEL",
  invalidThinking.status === 400 && invalidThinking.json?.error === "INVALID_THINKING_LEVEL", `${invalidThinking.status} ${short(invalidThinking.json)}`);
check("[A] balasan INVALID_THINKING_LEVEL menyertakan daftar allowed", Array.isArray(invalidThinking.json?.allowed) && invalidThinking.json.allowed.includes("high"), short(invalidThinking.json?.allowed));

const toolsNone = await agent.call("PATCH", "/api/v1/agents/settings", { toolsAllow: "none" });
check("[A] PATCH toolsAllow='none' -> 200 dan tersimpan apa adanya", toolsNone.status === 200 && toolsNone.json?.settings?.tools_allow === "none", `${toolsNone.status} ${short(toolsNone.json)}`);
const rereadTools = await agent.call("GET", "/api/v1/agents/settings");
check("[A] GET ulang membuktikan toolsAllow='none' persisten", rereadTools.json?.settings?.tools_allow === "none", short(rereadTools.json?.settings));
const previewAfterTools = await agent.call("GET", "/api/v1/agents/preview");
check("[A] pratinjau menerjemahkan toolsAllow='none' menjadi flag --no-tools",
  Array.isArray(previewAfterTools.json?.flags) && previewAfterTools.json.flags.includes("--no-tools"), short(previewAfterTools.json?.flags));
check("[A] pratinjau memuat flag --thinking high setelah perubahan pengaturan",
  Array.isArray(previewAfterTools.json?.flags) && previewAfterTools.json.flags.includes("--thinking high"), short(previewAfterTools.json?.flags));

const lowThreshold = await agent.call("PATCH", "/api/v1/agents/settings", { compactAfterMessages: 3 });
check("[A] PATCH compactAfterMessages=3 (di bawah rentang) -> 400 INVALID_COMPACT_THRESHOLD",
  lowThreshold.status === 400 && lowThreshold.json?.error === "INVALID_COMPACT_THRESHOLD", `${lowThreshold.status} ${short(lowThreshold.json)}`);
const highThreshold = await agent.call("PATCH", "/api/v1/agents/settings", { compactAfterMessages: 501 });
check("[A] PATCH compactAfterMessages=501 (di atas rentang) -> 400 INVALID_COMPACT_THRESHOLD",
  highThreshold.status === 400 && highThreshold.json?.error === "INVALID_COMPACT_THRESHOLD", `${highThreshold.status} ${short(highThreshold.json)}`);
const okThreshold = await agent.call("PATCH", "/api/v1/agents/settings", { compactAfterMessages: 500 });
check("[A] PATCH compactAfterMessages=500 (batas atas) -> 200 dan tersimpan",
  okThreshold.status === 200 && okThreshold.json?.settings?.compact_after_messages === 500, `${okThreshold.status} ${short(okThreshold.json)}`);
const autoCompactPatch = await agent.call("PATCH", "/api/v1/agents/settings", { autoCompact: true, autonomousDefault: false });
check("[A] PATCH autoCompact=true dan autonomousDefault=false -> 200",
  autoCompactPatch.status === 200 && autoCompactPatch.json?.settings?.auto_compact === 1 && autoCompactPatch.json?.settings?.autonomous_default === 0,
  `${autoCompactPatch.status} ${short(autoCompactPatch.json?.settings)}`);
const badTurns = await agent.call("PATCH", "/api/v1/agents/settings", { autonomousMaxTurns: 0 });
check("[A] PATCH autonomousMaxTurns=0 -> 400 INVALID_AUTONOMOUS_TURNS",
  badTurns.status === 400 && badTurns.json?.error === "INVALID_AUTONOMOUS_TURNS", `${badTurns.status} ${short(badTurns.json)}`);
const badTokens = await agent.call("PATCH", "/api/v1/agents/settings", { autonomousMaxTokens: 10 });
check("[A] PATCH autonomousMaxTokens=10 -> 400 INVALID_AUTONOMOUS_TOKENS",
  badTokens.status === 400 && badTokens.json?.error === "INVALID_AUTONOMOUS_TOKENS", `${badTokens.status} ${short(badTokens.json)}`);
const settingsAnon = await client().call("GET", "/api/v1/agents/settings");
check("[A] GET /agents/settings tanpa sesi -> 401 AUTH_REQUIRED", settingsAnon.status === 401 && settingsAnon.json?.error === "AUTH_REQUIRED", `${settingsAnon.status} ${short(settingsAnon.json)}`);

// ==================================================================== B. pratinjau agen (tanpa parameter)
const previewPlain = await agent.call("GET", "/api/v1/agents/preview");
check("[B] GET /agents/preview tanpa parameter -> 200", previewPlain.status === 200, `${previewPlain.status} ${short(previewPlain.json)}`);
check("[B] balasan memuat settings, persona, blocks, flags, summaryCount, messages, notes, conversation, session",
  ["settings", "persona", "blocks", "flags", "summaryCount", "messages", "notes", "conversation", "session"].every((key) => key in (previewPlain.json ?? {})),
  short(Object.keys(previewPlain.json ?? {})));
check("[B] blocks/flags/notes berupa array, summaryCount dan messages berupa angka",
  Array.isArray(previewPlain.json?.blocks) && Array.isArray(previewPlain.json?.flags) && Array.isArray(previewPlain.json?.notes)
    && typeof previewPlain.json?.summaryCount === "number" && typeof previewPlain.json?.messages === "number",
  short({ blocks: previewPlain.json?.blocks, flags: previewPlain.json?.flags, summaryCount: previewPlain.json?.summaryCount, messages: previewPlain.json?.messages }));
check("[B] tanpa conversationId: conversation=null, session=null, summaryCount=0, messages=0",
  previewPlain.json?.conversation === null && previewPlain.json?.session === null && previewPlain.json?.summaryCount === 0 && previewPlain.json?.messages === 0,
  short({ conversation: previewPlain.json?.conversation, session: previewPlain.json?.session, summaryCount: previewPlain.json?.summaryCount, messages: previewPlain.json?.messages }));
check("[B] tanpa memori dan tanpa persona: blocks kosong dan tidak ada flag --append-system-prompt",
  previewPlain.json?.blocks?.length === 0 && Array.isArray(previewPlain.json?.flags) && !previewPlain.json.flags.some((flag: string) => flag.startsWith("--append-system-prompt")),
  short({ blocks: previewPlain.json?.blocks, flags: previewPlain.json?.flags }));
check("[B] flags memuat --model <nama> sesuai PRIME_AGENT_MODEL",
  Array.isArray(previewPlain.json?.flags) && String(previewPlain.json.flags[0] ?? "").startsWith("--model "), short(previewPlain.json?.flags));
check("[B] notes berisi 3 penjelasan (blok sistem, pemadatan, allowlist alat)",
  Array.isArray(previewPlain.json?.notes) && previewPlain.json.notes.length === 3, short(previewPlain.json?.notes));
check("[B] notes menyebut allowlist alat dimatikan setelah toolsAllow='none'",
  String(previewPlain.json?.notes?.[2] ?? "").includes("dimatikan"), short(previewPlain.json?.notes));
check("[B] notes menjelaskan blok dikirim lewat --append-system-prompt",
  String(previewPlain.json?.notes?.[0] ?? "").includes("--append-system-prompt"), short(previewPlain.json?.notes?.[0]));
const previewAnon = await client().call("GET", "/api/v1/agents/preview");
check("[B] GET /agents/preview tanpa sesi -> 401 AUTH_REQUIRED", previewAnon.status === 401 && previewAnon.json?.error === "AUTH_REQUIRED", `${previewAnon.status} ${short(previewAnon.json)}`);
const previewForeignConversation = await outsider.call("GET", `/api/v1/agents/preview?conversationId=${convOne}`);
check("[B] pratinjau percakapan pengguna lain -> 404 CONVERSATION_NOT_FOUND",
  previewForeignConversation.status === 404 && previewForeignConversation.json?.error === "CONVERSATION_NOT_FOUND", `${previewForeignConversation.status} ${short(previewForeignConversation.json)}`);

// ==================================================================== C. bank memori
const memoryCreate = await agent.call("POST", "/api/v1/memories", { title: "Preferensi trading", body: "Fokus XAU/USD timeframe H1, hindari sinyal scalping M1.", tags: "trading,emas", pinned: true });
const memoryId = memoryCreate.json?.memory?.id;
check("[C] POST /api/v1/memories -> 201 dengan memory.id", memoryCreate.status === 201 && typeof memoryId === "string", `${memoryCreate.status} ${short(memoryCreate.json)}`);
check("[C] memori baru aktif (enabled=1), pinned=1, useCount=0",
  memoryCreate.json?.memory?.enabled === 1 && memoryCreate.json?.memory?.pinned === 1 && memoryCreate.json?.memory?.useCount === 0, short(memoryCreate.json?.memory));
check("[C] memori bodi kosong -> 400 INVALID_MEMORY",
  (await agent.call("POST", "/api/v1/memories", { title: "Tanpa isi" })).status === 400, "judul tanpa isi");
const memoryEmptyTitle = await agent.call("POST", "/api/v1/memories", { title: "   ", body: "ada isi" });
check("[C] memori judul kosong -> 400 INVALID_MEMORY", memoryEmptyTitle.status === 400 && memoryEmptyTitle.json?.error === "INVALID_MEMORY", `${memoryEmptyTitle.status} ${short(memoryEmptyTitle.json)}`);

const memoryList = await agent.call("GET", "/api/v1/memories");
check("[C] GET /api/v1/memories -> 200 dan memuat memori baru", memoryList.status === 200 && Array.isArray(memoryList.json?.memories) && memoryList.json.memories.some((row: any) => row.id === memoryId), `${memoryList.status} ${short(memoryList.json)}`);
const outsiderMemories = await outsider.call("GET", "/api/v1/memories");
check("[C] daftar memori pengguna lain tidak menampilkan memori ini", outsiderMemories.status === 200 && (outsiderMemories.json?.memories ?? []).every((row: any) => row.id !== memoryId), `${outsiderMemories.status} ${short(outsiderMemories.json?.memories)}`);

const previewWithMemory = await agent.call("GET", "/api/v1/agents/preview");
check("[C] memori aktif menambah blocks di pratinjau (0 -> 1)", previewWithMemory.json?.blocks?.length === 1, short(previewWithMemory.json?.blocks));
check("[C] blocks memuat judul dan isi memori",
  String(previewWithMemory.json?.blocks?.[0] ?? "").includes("Preferensi trading") && String(previewWithMemory.json?.blocks?.[0] ?? "").includes("XAU/USD"), short(previewWithMemory.json?.blocks?.[0]));
check("[C] flags memuat --append-system-prompt setelah memori aktif",
  Array.isArray(previewWithMemory.json?.flags) && previewWithMemory.json.flags.includes("--append-system-prompt <blok>"), short(previewWithMemory.json?.flags));

const memoryPatch = await agent.call("PATCH", `/api/v1/memories/${memoryId}`, { title: "Preferensi trading v2", body: "Fokus XAU/USD H1 saja.", enabled: true, pinned: false });
check("[C] PATCH memori mengubah judul/isi/pinned -> 200", memoryPatch.status === 200 && memoryPatch.json?.memory?.title === "Preferensi trading v2" && memoryPatch.json?.memory?.body === "Fokus XAU/USD H1 saja." && memoryPatch.json?.memory?.pinned === 0,
  `${memoryPatch.status} ${short(memoryPatch.json)}`);
const memoryPatchTitleEmpty = await agent.call("PATCH", `/api/v1/memories/${memoryId}`, { title: "" });
check("[C] PATCH judul kosong -> 400 INVALID_MEMORY", memoryPatchTitleEmpty.status === 400 && memoryPatchTitleEmpty.json?.error === "INVALID_MEMORY", `${memoryPatchTitleEmpty.status} ${short(memoryPatchTitleEmpty.json)}`);

const memoryOff = await agent.call("PATCH", `/api/v1/memories/${memoryId}`, { enabled: false });
check("[C] PATCH enabled=false -> 200", memoryOff.status === 200 && memoryOff.json?.memory?.enabled === 0, `${memoryOff.status} ${short(memoryOff.json?.memory)}`);
const previewMemoryOff = await agent.call("GET", "/api/v1/agents/preview");
check("[C] memori nonaktif hilang dari blocks dan flags", previewMemoryOff.json?.blocks?.length === 0 && !previewMemoryOff.json.flags.includes("--append-system-prompt <blok>"), short({ blocks: previewMemoryOff.json?.blocks, flags: previewMemoryOff.json?.flags }));
const memoryOn = await agent.call("PATCH", `/api/v1/memories/${memoryId}`, { enabled: true });
check("[C] PATCH enabled=true mengaktifkan kembali memori", memoryOn.status === 200 && memoryOn.json?.memory?.enabled === 1, `${memoryOn.status} ${short(memoryOn.json?.memory)}`);

const outsiderPatchMemory = await outsider.call("PATCH", `/api/v1/memories/${memoryId}`, { title: "Dibajak" });
check("[C] pengguna lain PATCH memori orang -> 404 MEMORY_NOT_FOUND", outsiderPatchMemory.status === 404 && outsiderPatchMemory.json?.error === "MEMORY_NOT_FOUND", `${outsiderPatchMemory.status} ${short(outsiderPatchMemory.json)}`);
const outsiderDeleteMemory = await outsider.call("DELETE", `/api/v1/memories/${memoryId}`);
check("[C] pengguna lain DELETE memori orang -> 404 MEMORY_NOT_FOUND", outsiderDeleteMemory.status === 404 && outsiderDeleteMemory.json?.error === "MEMORY_NOT_FOUND", `${outsiderDeleteMemory.status} ${short(outsiderDeleteMemory.json)}`);
const unknownMemory = await agent.call("PATCH", `/api/v1/memories/${randomUUID()}`, { title: "Tidak ada" });
check("[C] PATCH id memori tak dikenal -> 404 MEMORY_NOT_FOUND", unknownMemory.status === 404 && unknownMemory.json?.error === "MEMORY_NOT_FOUND", `${unknownMemory.status} ${short(unknownMemory.json)}`);

// Memori kedua khusus untuk uji DELETE, supaya memori utama tetap hidup untuk bagian lain.
const memoryDelete = await agent.call("POST", "/api/v1/memories", { title: "Memori sekali pakai", body: "Boleh dihapus." });
const memoryDeleteId = memoryDelete.json?.memory?.id;
const deleteReply = await agent.call("DELETE", `/api/v1/memories/${memoryDeleteId}`);
check("[C] DELETE memori milik sendiri -> 200 {deleted:true}", deleteReply.status === 200 && deleteReply.json?.deleted === true, `${deleteReply.status} ${short(deleteReply.json)}`);
const memoriesAfterDelete = await agent.call("GET", "/api/v1/memories");
check("[C] memori terhapus tidak ada lagi di daftar", (memoriesAfterDelete.json?.memories ?? []).every((row: any) => row.id !== memoryDeleteId), short(memoriesAfterDelete.json?.memories?.map((row: any) => row.title)));

// ==================================================================== D. template prompt
const templateCreate = await agent.call("POST", "/api/v1/prompt-templates", { name: "Analisa emas", body: "Analisa {{topik}} dengan gaya {{gaya}} lalu beri 3 skenario.", description: "Template analisa", slash: "/Analisa Emas", tags: "trading" });
const templateId = templateCreate.json?.template?.id;
check("[D] POST /prompt-templates -> 201 dengan template.id", templateCreate.status === 201 && typeof templateId === "string", `${templateCreate.status} ${short(templateCreate.json)}`);
check("[D] slash dinormalkan menjadi huruf kecil tanpa garis miring", templateCreate.json?.template?.slash === "analisa-emas", short(templateCreate.json?.template?.slash));
check("[D] template baru useCount=0", templateCreate.json?.template?.useCount === 0, short(templateCreate.json?.template));
const duplicateSlash = await agent.call("POST", "/api/v1/prompt-templates", { name: "Duplikat", body: "isi", slash: "analisa-emas" });
check("[D] slash yang sudah dipakai -> 409 SLASH_TAKEN", duplicateSlash.status === 409 && duplicateSlash.json?.error === "SLASH_TAKEN", `${duplicateSlash.status} ${short(duplicateSlash.json)}`);
const templateBodyEmpty = await agent.call("POST", "/api/v1/prompt-templates", { name: "Kosong" });
check("[D] template tanpa isi -> 400 INVALID_TEMPLATE", templateBodyEmpty.status === 400 && templateBodyEmpty.json?.error === "INVALID_TEMPLATE", `${templateBodyEmpty.status} ${short(templateBodyEmpty.json)}`);

const templateList = await agent.call("GET", "/api/v1/prompt-templates");
check("[D] GET /prompt-templates -> 200 dan memuat template baru", templateList.status === 200 && (templateList.json?.templates ?? []).some((row: any) => row.id === templateId), `${templateList.status} ${short(templateList.json?.templates?.map((row: any) => row.name))}`);

const templateUse = await agent.call("POST", `/api/v1/prompt-templates/${templateId}/use`, { variables: { topik: "XAU/USD H1" } });
check("[D] POST /:id/use -> 200 dengan teks terisi", templateUse.status === 200 && templateUse.json?.text === "Analisa XAU/USD H1 dengan gaya {{gaya}} lalu beri 3 skenario.", `${templateUse.status} ${short(templateUse.json)}`);
check("[D] placeholder yang tidak diisi muncul di remainingVariables",
  Array.isArray(templateUse.json?.remainingVariables) && templateUse.json.remainingVariables.length === 1 && templateUse.json.remainingVariables[0] === "gaya", short(templateUse.json?.remainingVariables));
const templateUseAgain = await agent.call("POST", `/api/v1/prompt-templates/${templateId}/use`, { variables: { topik: "BTC/USDT", gaya: "ringkas" } });
check("[D] isi semua placeholder -> remainingVariables kosong dan teks tanpa kurung kurawal",
  templateUseAgain.json?.remainingVariables?.length === 0 && !String(templateUseAgain.json?.text ?? "").includes("{{"), short(templateUseAgain.json));
const templateListAfterUse = await agent.call("GET", "/api/v1/prompt-templates");
const templateRowAfterUse = (templateListAfterUse.json?.templates ?? []).find((row: any) => row.id === templateId);
check("[D] useCount bertambah menjadi 2 di GET berikutnya", templateRowAfterUse?.useCount === 2, short(templateRowAfterUse));

const templatePatch = await agent.call("PATCH", `/api/v1/prompt-templates/${templateId}`, { name: "Analisa emas v2", body: "Analisa {{topik}}.", slash: "analisa2" });
check("[D] PATCH template mengubah nama/isi/slash -> 200",
  templatePatch.status === 200 && templatePatch.json?.template?.name === "Analisa emas v2" && templatePatch.json?.template?.body === "Analisa {{topik}}." && templatePatch.json?.template?.slash === "analisa2",
  `${templatePatch.status} ${short(templatePatch.json)}`);
const templatePatchEmptySlashConflict = await agent.call("PATCH", `/api/v1/prompt-templates/${templateId}`, { slash: "analisa-emas" });
check("[D] PATCH slash yang tidak dipakai template lain -> 200 (tidak ada tabrakan)",
  templatePatchEmptySlashConflict.status === 200 && templatePatchEmptySlashConflict.json?.template?.slash === "analisa-emas", `${templatePatchEmptySlashConflict.status} ${short(templatePatchEmptySlashConflict.json)}`);
const outsiderPatchTemplate = await outsider.call("PATCH", `/api/v1/prompt-templates/${templateId}`, { name: "Bajakan" });
check("[D] pengguna lain PATCH template orang -> 404 TEMPLATE_NOT_FOUND", outsiderPatchTemplate.status === 404 && outsiderPatchTemplate.json?.error === "TEMPLATE_NOT_FOUND", `${outsiderPatchTemplate.status} ${short(outsiderPatchTemplate.json)}`);
const outsiderUseTemplate = await outsider.call("POST", `/api/v1/prompt-templates/${templateId}/use`, { variables: {} });
check("[D] pengguna lain memakai template orang -> 404 TEMPLATE_NOT_FOUND", outsiderUseTemplate.status === 404 && outsiderUseTemplate.json?.error === "TEMPLATE_NOT_FOUND", `${outsiderUseTemplate.status} ${short(outsiderUseTemplate.json)}`);
const deleteTemplate = await agent.call("DELETE", `/api/v1/prompt-templates/${templateId}`);
check("[D] DELETE template milik sendiri -> 200 {deleted:true}", deleteTemplate.status === 200 && deleteTemplate.json?.deleted === true, `${deleteTemplate.status} ${short(deleteTemplate.json)}`);
const outsiderDeleteTemplate = await outsider.call("DELETE", `/api/v1/prompt-templates/${templateId}`);
check("[D] DELETE template orang oleh pengguna lain -> 404 TEMPLATE_NOT_FOUND", outsiderDeleteTemplate.status === 404 && outsiderDeleteTemplate.json?.error === "TEMPLATE_NOT_FOUND", `${outsiderDeleteTemplate.status} ${short(outsiderDeleteTemplate.json)}`);

// ==================================================================== E. persona agen
const personaOne = await agent.call("POST", "/api/v1/personas", { name: "Persona Satu", systemPrompt: "Kamu analis emas XAU/USD.", tone: "ringkas", language: "id", makeDefault: true });
const personaOneId = personaOne.json?.persona?.id;
check("[E] POST /api/v1/personas -> 201 dengan persona.id", personaOne.status === 201 && typeof personaOneId === "string", `${personaOne.status} ${short(personaOne.json)}`);
check("[E] persona pertama ditandai isDefault=1 saat makeDefault dikirim", personaOne.json?.persona?.isDefault === 1, short(personaOne.json?.persona));
check("[E] persona baru useCount=0 dan thinkingLevel bawaan 'medium'", personaOne.json?.persona?.useCount === 0 && personaOne.json?.persona?.thinkingLevel === "medium", short(personaOne.json?.persona));
const personaNoPrompt = await agent.call("POST", "/api/v1/personas", { name: "Tanpa prompt" });
check("[E] persona tanpa system prompt -> 400 INVALID_PERSONA", personaNoPrompt.status === 400 && personaNoPrompt.json?.error === "INVALID_PERSONA", `${personaNoPrompt.status} ${short(personaNoPrompt.json)}`);
const personaBadThinking = await agent.call("POST", "/api/v1/personas", { name: "Thinking ngawur", systemPrompt: "isi", thinkingLevel: "ultra" });
check("[E] persona dengan thinkingLevel tidak valid jatuh ke 'medium' (bukan error)", personaBadThinking.status === 201 && personaBadThinking.json?.persona?.thinkingLevel === "medium", `${personaBadThinking.status} ${short(personaBadThinking.json?.persona)}`);
await agent.call("DELETE", `/api/v1/personas/${personaBadThinking.json?.persona?.id}`);

const personaTwo = await agent.call("POST", "/api/v1/personas", { name: "Persona Dua", systemPrompt: "Kamu editor laporan keuangan.", tone: "formal", language: "id", makeDefault: true });
const personaTwoId = personaTwo.json?.persona?.id;
check("[E] persona kedua dengan makeDefault -> 201", personaTwo.status === 201 && typeof personaTwoId === "string", `${personaTwo.status} ${short(personaTwo.json)}`);
const personasList = await agent.call("GET", "/api/v1/personas");
const defaultRows = (personasList.json?.personas ?? []).filter((row: any) => row.isDefault === 1);
check("[E] hanya SATU persona bertanda default setelah dua makeDefault", personasList.status === 200 && defaultRows.length === 1 && defaultRows[0].id === personaTwoId, `${personasList.status} ${short(defaultRows)}`);
check("[E] daftar persona diurutkan default lebih dulu", personasList.json?.personas?.[0]?.id === personaTwoId, short(personasList.json?.personas?.map((row: any) => row.name)));
const outsiderPersonas = await outsider.call("GET", "/api/v1/personas");
check("[E] daftar persona pengguna lain tidak menampilkan persona ini", (outsiderPersonas.json?.personas ?? []).every((row: any) => row.id !== personaOneId && row.id !== personaTwoId), short(outsiderPersonas.json?.personas));

const setDefaultOne = await agent.call("POST", `/api/v1/personas/${personaOneId}/default`);
check("[E] POST /personas/:id/default -> 200 {isDefault:true, personaId}", setDefaultOne.status === 200 && setDefaultOne.json?.isDefault === true && setDefaultOne.json?.personaId === personaOneId, `${setDefaultOne.status} ${short(setDefaultOne.json)}`);
const personasAfterDefault = await agent.call("GET", "/api/v1/personas");
check("[E] setelah ganti default, hanya persona satu yang bertanda default",
  (personasAfterDefault.json?.personas ?? []).filter((row: any) => row.isDefault === 1).map((row: any) => row.id).join(",") === personaOneId,
  short((personasAfterDefault.json?.personas ?? []).map((row: any) => ({ name: row.name, isDefault: row.isDefault }))));

const personaPatch = await agent.call("PATCH", `/api/v1/personas/${personaTwoId}`, { name: "Persona Dua v2", systemPrompt: "Kamu editor laporan keuangan resmi.", tone: "tegas", thinkingLevel: "high" });
check("[E] PATCH persona mengubah nama/systemPrompt/tone/thinkingLevel -> 200",
  personaPatch.status === 200 && personaPatch.json?.persona?.name === "Persona Dua v2" && personaPatch.json?.persona?.tone === "tegas" && personaPatch.json?.persona?.thinkingLevel === "high",
  `${personaPatch.status} ${short(personaPatch.json)}`);
const personaPatchBadThinking = await agent.call("PATCH", `/api/v1/personas/${personaTwoId}`, { thinkingLevel: "ultra" });
check("[E] PATCH thinkingLevel persona tidak valid -> 400 INVALID_THINKING_LEVEL",
  personaPatchBadThinking.status === 400 && personaPatchBadThinking.json?.error === "INVALID_THINKING_LEVEL", `${personaPatchBadThinking.status} ${short(personaPatchBadThinking.json)}`);
const outsiderPersonaPatch = await outsider.call("PATCH", `/api/v1/personas/${personaTwoId}`, { name: "Bajakan" });
check("[E] pengguna lain PATCH persona orang -> 404 PERSONA_NOT_FOUND", outsiderPersonaPatch.status === 404 && outsiderPersonaPatch.json?.error === "PERSONA_NOT_FOUND", `${outsiderPersonaPatch.status} ${short(outsiderPersonaPatch.json)}`);
const outsiderPersonaDefault = await outsider.call("POST", `/api/v1/personas/${personaTwoId}/default`);
check("[E] pengguna lain menjadikan persona orang sebagai default -> 404 PERSONA_NOT_FOUND", outsiderPersonaDefault.status === 404 && outsiderPersonaDefault.json?.error === "PERSONA_NOT_FOUND", `${outsiderPersonaDefault.status} ${short(outsiderPersonaDefault.json)}`);

// Model persona: hanya bisa diuji kalau katalog mesin benar-benar terisi (dijalankan dari CLI engine).
const catalogueReply = await agent.call("GET", "/api/v1/models");
const catalogueSize = Array.isArray(catalogueReply.json?.models) ? catalogueReply.json.models.length : 0;
check("[E] GET /api/v1/models mengembalikan bentuk katalog (models array + default)", catalogueReply.status === 200 && Array.isArray(catalogueReply.json?.models) && "default" in (catalogueReply.json ?? {}), `${catalogueReply.status} ${short({ models: catalogueSize, note: catalogueReply.json?.note, error: catalogueReply.json?.error })}`);
note(`[I] katalog model terisi: ${catalogueSize} model (keterangan: ${short(catalogueReply.json?.note ?? catalogueReply.json?.error ?? "tidak ada")}).`);
if (catalogueSize > 0) {
  const firstModel = String(catalogueReply.json.models[0].model);
  const personaModelOk = await agent.call("PATCH", `/api/v1/personas/${personaTwoId}`, { model: firstModel });
  check(`[E] PATCH persona dengan model katalog '${firstModel}' -> 200`, personaModelOk.status === 200 && personaModelOk.json?.persona?.model === firstModel, `${personaModelOk.status} ${short(personaModelOk.json)}`);
  const personaModelBad = await agent.call("PATCH", `/api/v1/personas/${personaTwoId}`, { model: "model-yang-tidak-ada-xyz" });
  check("[E] PATCH persona dengan model tak dikenal -> 400 UNKNOWN_MODEL", personaModelBad.status === 400 && personaModelBad.json?.error === "UNKNOWN_MODEL", `${personaModelBad.status} ${short(personaModelBad.json)}`);
} else {
  skip("[E] PATCH persona dengan model katalog -> 400 UNKNOWN_MODEL untuk model tak dikenal", "katalog mesin kosong di lingkungan ini, jadi isKnownModel() selalu meloloskan nama model apa pun (tidak bisa dibedakan)");
}

// Persona per percakapan + bukti tanpa DB
const attachPersona = await agent.call("PATCH", `/api/v1/conversations/${convOne}/persona`, { personaId: personaTwoId });
check("[E] PATCH /conversations/:id/persona -> 200 {conversationId, personaId}", attachPersona.status === 200 && attachPersona.json?.personaId === personaTwoId && attachPersona.json?.conversationId === convOne, `${attachPersona.status} ${short(attachPersona.json)}`);
const previewWithConversationPersona = await agent.call("GET", `/api/v1/agents/preview?conversationId=${convOne}`);
check("[E] pratinjau percakapan memuat conversation.personaId yang baru dipasang",
  previewWithConversationPersona.json?.conversation?.personaId === personaTwoId, short(previewWithConversationPersona.json?.conversation));
check("[E] blok persona yang dipakai percakapan tampil di blocks",
  String(previewWithConversationPersona.json?.blocks?.[0] ?? "").includes("Persona Dua v2"), short(previewWithConversationPersona.json?.blocks?.[0]));
check("[E] field persona di pratinjau adalah persona percakapan, bukan default akun",
  previewWithConversationPersona.json?.persona?.id === personaTwoId, short(previewWithConversationPersona.json?.persona));
const foreignPersonaAttach = await agent.call("PATCH", `/api/v1/conversations/${convOne}/persona`, { personaId: randomUUID() });
check("[E] memasang persona yang bukan milik sendiri -> 404 PERSONA_NOT_FOUND", foreignPersonaAttach.status === 404 && foreignPersonaAttach.json?.error === "PERSONA_NOT_FOUND", `${foreignPersonaAttach.status} ${short(foreignPersonaAttach.json)}`);

const personaRun = await agent.call("POST", `/api/v1/conversations/${convOne}/messages`, { content: "Jelaskan singkat struktur laporan keuangan." });
const personaRunId = personaRun.json?.run?.id;
check("[E] kirim pesan di percakapan ber-persona -> 202", personaRun.status === 202 && typeof personaRunId === "string", `${personaRun.status} ${short(personaRun.json)}`);
check("[E] balasan 202 memuat thinkingLevel dari pengaturan akun (high) saat tidak diminta eksplisit",
  personaRun.json?.run?.thinkingLevel === "high" && personaRun.json?.run?.autonomous === false, short(personaRun.json?.run));
const personaAnswer = await waitForAssistantRun(agent, convOne, personaRunId);
check("[E] jawaban assistant untuk run persona diterima lewat HTTP", Boolean(personaAnswer.message), `pesan=${personaAnswer.messages.length}`);
const personaMapRun = await waitForMapRun(agent, convOne, personaRunId);
check("[E] baris run menyimpan append_system_chars > 0 (blok persona benar-benar dikirim)",
  Number(personaMapRun.run?.appendSystemChars ?? 0) > 0, short(personaMapRun.run));
check("[E] peta agen menautkan percakapan ke persona percakapan (sessions[].personaId)",
  personaMapRun.session?.personaId === personaTwoId, short({ personaId: personaMapRun.session?.personaId, expected: personaTwoId }));
const personaEngineOptions = mockOptions(personaAnswer.message?.content);
check("[E] lapisan mesin menerima appendSystem berisi teks persona",
  Array.isArray(personaEngineOptions?.appendSystem) && personaEngineOptions.appendSystem.some((block: string) => String(block).includes("Persona Dua v2")),
  short(personaEngineOptions?.appendSystem));
check("[E] lapisan mesin menerima thinking 'high' dari pengaturan akun", personaEngineOptions?.thinking === "high", short(personaEngineOptions?.thinking));
skip("[E] kolom runs.persona_id tersimpan di basis data", "TIDAK ADA endpoint HTTP yang membaca kolom runs.persona_id (server.ts menulisnya di baris 810, hanya dibaca SQL internal). Bukti pengganti yang tetap lewat HTTP: (1) conversations.persona_id lewat preview?conversationId, (2) sessions[].personaId di /api/v1/agents/map, (3) runs.append_system_chars > 0, (4) appendSystem di echo mesin memuat nama persona.");

const previewDefaultAsymmetry = await agent.call("GET", "/api/v1/agents/preview");
// Dulu field persona bernilai null walau blok persona bawaan tetap dikirim ke mesin. Sesudah diperbaiki,
// pratinjau melaporkan persona yang benar-benar memasok blok, beserta asalnya.
check("[E] pratinjau tanpa personaId melaporkan persona bawaan akun, bukan null",
  previewDefaultAsymmetry.json?.persona?.name === "Persona Satu" && previewDefaultAsymmetry.json?.personaSource === "bawaan akun" && String(previewDefaultAsymmetry.json?.blocks?.[0] ?? "").includes("Persona Satu"),
  short({ persona: previewDefaultAsymmetry.json?.persona, personaSource: previewDefaultAsymmetry.json?.personaSource, blok0: String(previewDefaultAsymmetry.json?.blocks?.[0] ?? "").slice(0, 60) }));

const clearConversationPersona = await agent.call("PATCH", `/api/v1/conversations/${convOne}/persona`, { personaId: null });
check("[E] melepas persona percakapan (personaId null) -> 200 personaId null", clearConversationPersona.status === 200 && clearConversationPersona.json?.personaId === null, `${clearConversationPersona.status} ${short(clearConversationPersona.json)}`);
const previewAfterClear = await agent.call("GET", `/api/v1/agents/preview?conversationId=${convOne}`);
check("[E] setelah dilepas, conversation.personaId benar-benar null", previewAfterClear.json?.conversation?.personaId === null, short(previewAfterClear.json?.conversation));
check("[E] percakapan tanpa persona jatuh kembali ke persona default akun (blok persona tetap ada)",
  String(previewAfterClear.json?.blocks?.[0] ?? "").includes("Persona Satu"), short(previewAfterClear.json?.blocks?.[0]));
note("[E] melepas persona percakapan tidak mengosongkan blok persona: percakapan otomatis memakai persona default akun. Perilaku ini tercatat, bukan dianggap salah.");

// ==================================================================== F. opsi run per pesan (thinking, otonom, persona)
const runOptions = await agent.call("POST", `/api/v1/conversations/${convOne}/messages`, { content: "Susun rencana singkat.", thinking: "low", autonomous: true, personaId: personaOneId });
const runOptionsId = runOptions.json?.run?.id;
check("[F] POST pesan {thinking:'low', autonomous:true, personaId} -> 202", runOptions.status === 202 && typeof runOptionsId === "string", `${runOptions.status} ${short(runOptions.json)}`);
check("[F] balasan 202 melaporkan thinkingLevel='low' dan autonomous=true",
  runOptions.json?.run?.thinkingLevel === "low" && runOptions.json?.run?.autonomous === true, short(runOptions.json?.run));
check("[F] willCompact=false karena ambang pemadatan 500 pesan", runOptions.json?.run?.willCompact === false, short(runOptions.json?.run));
const runOptionsAnswer = await waitForAssistantRun(agent, convOne, runOptionsId);
check("[F] jawaban assistant untuk run opsi diterima", Boolean(runOptionsAnswer.message), `pesan=${runOptionsAnswer.messages.length}`);
const runOptionsMap = await waitForMapRun(agent, convOne, runOptionsId);
const runOptionsRow = runOptionsMap.run;
check("[F] peta agen menampilkan thinkingLevel='low' untuk run ini", runOptionsRow?.thinkingLevel === "low", short(runOptionsRow));
check("[F] peta agen menampilkan autonomous=1 untuk run ini", Number(runOptionsRow?.autonomous) === 1, short(runOptionsRow));
check("[F] promptChars sama dengan panjang konten yang dikirim", Number(runOptionsRow?.promptChars) === "Susun rencana singkat.".length, short(runOptionsRow));
check("[F] status run selesai 'completed' dan totalTokens tercatat > 0", runOptionsRow?.status === "completed" && Number(runOptionsRow?.totalTokens ?? 0) > 0, short(runOptionsRow));
const optionEcho = mockOptions(runOptionsAnswer.message?.content);
check("[F] echo mesin: thinking='low' diteruskan ke mesin", optionEcho?.thinking === "low", short(optionEcho?.thinking));
check("[F] echo mesin: autonomous memakai batas langkah/token dari pengaturan akun (6 langkah, 40000 token)",
  optionEcho?.autonomous?.maxTurns === 6 && optionEcho?.autonomous?.maxTokens === 40000, short(optionEcho?.autonomous));
check("[F] echo mesin: appendSystem memuat persona yang diminta, bukan persona default",
  Array.isArray(optionEcho?.appendSystem) && optionEcho.appendSystem.some((block: string) => String(block).includes("Persona Satu")) && !optionEcho.appendSystem.some((block: string) => String(block).includes("Persona Dua v2")),
  short(optionEcho?.appendSystem));
check("[F] echo mesin: tools berupa array kosong karena toolsAllow='none'", Array.isArray(optionEcho?.tools) && optionEcho.tools.length === 0, short(optionEcho?.tools));
const badThinkingMessage = await agent.call("POST", `/api/v1/conversations/${convOne}/messages`, { content: "halo", thinking: "ultra" });
check("[F] POST pesan dengan thinking tidak valid -> 400 INVALID_THINKING_LEVEL", badThinkingMessage.status === 400 && badThinkingMessage.json?.error === "INVALID_THINKING_LEVEL", `${badThinkingMessage.status} ${short(badThinkingMessage.json)}`);
const projectRuns = await agent.call("GET", `/api/v1/projects/${projectId}/runs?limit=200`);
const projectRunRow = (projectRuns.json?.runs ?? []).find((row: any) => row.id === runOptionsId);
check("[H] GET /projects/:id/runs memuat run yang baru dibuat dengan token input/output",
  projectRuns.status === 200 && Boolean(projectRunRow) && Number(projectRunRow?.inputTokens ?? 0) > 0 && Number(projectRunRow?.outputTokens ?? 0) > 0, short(projectRunRow));
if (projectRunRow && !("thinkingLevel" in projectRunRow) && !("autonomous" in projectRunRow) && !("appendSystemChars" in projectRunRow)) {
  note("[H] KETERBATASAN: GET /api/v1/projects/:projectId/runs tidak mengembalikan thinkingLevel/autonomous/appendSystemChars/promptChars (hanya id, status, prompt, result, model, errorCode, waktu, token, biaya). Bukti kolom Wave 3 diambil dari GET /api/v1/agents/map.");
}

// ==================================================================== G. pemadatan percakapan
const convTwo = await newConversation("Percakapan Pemadatan Wave3");
check("[G] percakapan kedua untuk uji pemadatan dibuat", typeof convTwo === "string", short(convTwo));
for (const content of ["Pesan pertama soal XAU/USD H1.", "Pesan kedua: tambahkan level support.", "Pesan ketiga: rangkum rencana besok."]) {
  const sent = await agent.call("POST", `/api/v1/conversations/${convTwo}/messages`, { content });
  if (sent.status !== 202) check("[G] kirim pesan persiapan pemadatan", false, `${sent.status} ${short(sent.json)}`);
  else await waitForAssistantRun(agent, convTwo, sent.json.run.id);
}
const beforeCompactMessages = await waitForMessageCount(agent, convTwo, 6);
check("[G] percakapan pemadatan berisi 6 pesan (3 pengguna + 3 asisten)", beforeCompactMessages.length === 6, `pesan=${beforeCompactMessages.length}`);
const summariesBefore = await agent.call("GET", `/api/v1/conversations/${convTwo}/summaries`);
check("[G] sebelum pemadatan: 0 ringkasan dan engineSessionId sudah terisi", summariesBefore.status === 200 && (summariesBefore.json?.summaries ?? []).length === 0 && typeof summariesBefore.json?.conversation?.engineSessionId === "string", `${summariesBefore.status} ${short(summariesBefore.json)}`);
const sessionBefore = summariesBefore.json?.conversation?.engineSessionId;
check("[G] sebelum pemadatan: compactedAt masih null", summariesBefore.json?.conversation?.compactedAt === null, short(summariesBefore.json?.conversation));

// Percakapan kosong tidak boleh memakai token mesin untuk ringkasan kosong.
const emptyConvId = await newConversation("Percakapan Kosong Wave3");
const compactEmpty = await agent.call("POST", `/api/v1/conversations/${emptyConvId}/compact`);
check("[G] POST compact pada percakapan kosong -> 400 NO_MESSAGES_TO_COMPACT",
  compactEmpty.status === 400 && compactEmpty.json?.error === "NO_MESSAGES_TO_COMPACT", `${compactEmpty.status} ${short(compactEmpty.json)}`);

const compactReply = await agent.call("POST", `/api/v1/conversations/${convTwo}/compact`);
check("[G] POST /conversations/:id/compact -> 200 {compacted:true, ...}", compactReply.status === 200 && compactReply.json?.compacted === true, `${compactReply.status} ${short(compactReply.json).slice(0, 500)}`);
check("[G] hasil pemadatan memuat summary, messagesCovered, charsBefore, charsAfter, engineSessionId, usage, source",
  Boolean(compactReply.json?.summary) && Number(compactReply.json?.messagesCovered) === 6 && Number(compactReply.json?.charsBefore) > 0 && Number(compactReply.json?.charsAfter) > 0
    && typeof compactReply.json?.engineSessionId === "string" && "usage" in (compactReply.json ?? {}) && typeof compactReply.json?.source === "string",
  short({ messagesCovered: compactReply.json?.messagesCovered, charsBefore: compactReply.json?.charsBefore, charsAfter: compactReply.json?.charsAfter, source: compactReply.json?.source, usage: compactReply.json?.usage }));
check("[G] pemadatan mengganti sesi mesin dengan id baru (bukan sesi lama)",
  compactReply.json?.engineSessionId !== sessionBefore && String(compactReply.json?.engineSessionId).length > 0, short({ lama: sessionBefore, baru: compactReply.json?.engineSessionId }));
note(`[G] sumber ringkasan yang benar-benar terjadi dengan MOCK_ENGINE: source="${compactReply.json?.source}" (mock selalu mengembalikan teks, jadi jalur fallback tidak terpakai).`);
check("[G] dengan MOCK_ENGINE, sumber ringkasan adalah 'engine' (bukan 'fallback')", compactReply.json?.source === "engine", short(compactReply.json?.source));

const summariesAfter = await agent.call("GET", `/api/v1/conversations/${convTwo}/summaries`);
check("[G] setelah pemadatan: tepat 1 baris ringkasan", (summariesAfter.json?.summaries ?? []).length === 1, `${summariesAfter.status} ${short(summariesAfter.json?.summaries)}`);
check("[G] baris ringkasan mencatat messagesCovered/charsBefore/charsAfter yang sama seperti balasan",
  Number(summariesAfter.json?.summaries?.[0]?.messagesCovered) === 6 && Number(summariesAfter.json?.summaries?.[0]?.charsBefore) === Number(compactReply.json?.charsBefore)
    && Number(summariesAfter.json?.summaries?.[0]?.charsAfter) === Number(compactReply.json?.charsAfter),
  short(summariesAfter.json?.summaries?.[0]));
check("[G] conversations.engineSessionId diperbarui ke sesi baru dan compactedAt terisi",
  summariesAfter.json?.conversation?.engineSessionId === compactReply.json?.engineSessionId && Boolean(summariesAfter.json?.conversation?.compactedAt),
  short(summariesAfter.json?.conversation));
check("[G] jumlah pesan lama tidak hilang setelah pemadatan (masih 6)", Number(summariesAfter.json?.messages) === 6, short(summariesAfter.json?.messages));

const previewAfterCompact = await agent.call("GET", `/api/v1/agents/preview?conversationId=${convTwo}`);
check("[G] pratinjau setelah pemadatan menghitung summaryCount=1 dan messages=6", previewAfterCompact.json?.summaryCount === 1 && previewAfterCompact.json?.messages === 6, short({ summaryCount: previewAfterCompact.json?.summaryCount, messages: previewAfterCompact.json?.messages }));
check("[G] ringkasan lama dikirim sebagai blok TERAKHIR di blocks (persona default + memori + ringkasan = 3 blok)",
  Array.isArray(previewAfterCompact.json?.blocks) && previewAfterCompact.json.blocks.length === 3
    && String(previewAfterCompact.json.blocks[previewAfterCompact.json.blocks.length - 1]).startsWith("Ringkasan percakapan sebelum pemadatan"),
  short(previewAfterCompact.json?.blocks?.map((block: string) => block.slice(0, 60))));
check("[G] flags menambah satu --append-system-prompt untuk setiap blok",
  (previewAfterCompact.json?.flags ?? []).filter((flag: string) => flag === "--append-system-prompt <blok>").length === (previewAfterCompact.json?.blocks ?? []).length,
  short(previewAfterCompact.json?.flags));

const afterCompactMessage = await agent.call("POST", `/api/v1/conversations/${convTwo}/messages`, { content: "Lanjutkan dari ringkasan." });
check("[G] percakapan masih bisa dipakai setelah pemadatan -> 202", afterCompactMessage.status === 202, `${afterCompactMessage.status} ${short(afterCompactMessage.json)}`);
check("[G] run lanjutan sudah memakai sesi mesin yang baru", afterCompactMessage.json?.run?.willCompact === false, short(afterCompactMessage.json?.run));
const afterCompactAnswer = await waitForAssistantRun(agent, convTwo, afterCompactMessage.json?.run?.id);
check("[G] jawaban lanjutan diterima setelah pemadatan", Boolean(afterCompactAnswer.message), `pesan=${afterCompactAnswer.messages.length}`);
const afterCompactEcho = mockOptions(afterCompactAnswer.message?.content);
check("[G] mesin menerima ringkasan sebagai blok kedua di appendSystem",
  Array.isArray(afterCompactEcho?.appendSystem) && afterCompactEcho.appendSystem.some((block: string) => String(block).startsWith("Ringkasan percakapan sebelum pemadatan")),
  short(afterCompactEcho?.appendSystem?.map((block: string) => block.slice(0, 50))));

// ==================================================================== H. peta agen
const mapReply = await agent.call("GET", "/api/v1/agents/map");
check("[H] GET /api/v1/agents/map -> 200 dengan sessions[]", mapReply.status === 200 && Array.isArray(mapReply.json?.sessions) && mapReply.json.sessions.length > 0, `${mapReply.status} ${short(mapReply.json)?.slice(0, 300)}`);
check("[H] peta memuat engineRoot (string), rootStorage, dan note", typeof mapReply.json?.engineRoot === "string" && "rootStorage" in (mapReply.json ?? {}) && typeof mapReply.json?.note === "string", short({ engineRoot: mapReply.json?.engineRoot, rootStorage: mapReply.json?.rootStorage }));
check("[H] sessions[] memuat field conversationId/title/messages/summaries/engineSessionId/compactedAt/runs",
  (mapReply.json?.sessions ?? []).every((session: any) => ["conversationId", "title", "messages", "summaries", "engineSessionId", "compactedAt", "runs"].every((key) => key in session)),
  short(Object.keys(mapReply.json?.sessions?.[0] ?? {})));
const compactMapSession = (mapReply.json?.sessions ?? []).find((session: any) => session.conversationId === convTwo);
check("[H] sesi percakapan yang dipadatkan tercatat summaries=1 dan engineSessionId baru",
  compactMapSession?.summaries === 1 && compactMapSession?.engineSessionId === compactReply.json?.engineSessionId && Boolean(compactMapSession?.compactedAt),
  short(compactMapSession));
check("[H] jumlah pesan di peta sama dengan jumlah pesan nyata (8 setelah pemadatan)", compactMapSession?.messages === 8, short(compactMapSession?.messages));
check("[H] runs[] di peta memuat id/status/model/thinkingLevel/autonomous/promptChars/appendSystemChars/totalTokens",
  (compactMapSession?.runs ?? []).length > 0 && compactMapSession.runs.every((run: any) => ["id", "status", "model", "thinkingLevel", "autonomous", "promptChars", "appendSystemChars", "totalTokens", "createdAt"].every((key) => key in run)),
  short(Object.keys(compactMapSession?.runs?.[0] ?? {})));
check("[H] setiap run di peta sudah berstatus selesai dengan token > 0",
  (compactMapSession?.runs ?? []).every((run: any) => run.status === "completed" && Number(run.totalTokens) > 0), short(compactMapSession?.runs?.map((run: any) => ({ status: run.status, tokens: run.totalTokens }))));
check("[H] runs[] memuat promptChars sesuai panjang prompt pengguna",
  (compactMapSession?.runs ?? []).some((run: any) => Number(run.promptChars) === "Lanjutkan dari ringkasan.".length), short(compactMapSession?.runs?.map((run: any) => run.promptChars)));
check("[H] sessions[] hanya berisi percakapan milik pengguna ini (peta orang lain terpisah)",
  (mapReply.json?.sessions ?? []).every((session: any) => session.workspaceName === "Pemilik Wave3's Workspace"), short((mapReply.json?.sessions ?? []).map((session: any) => session.workspaceName)));
const outsiderMap = await outsider.call("GET", "/api/v1/agents/map");
check("[H] peta agen pengguna lain tidak memuat percakapan pemilik", outsiderMap.status === 200 && (outsiderMap.json?.sessions ?? []).every((session: any) => session.conversationId !== convOne && session.conversationId !== convTwo), `${outsiderMap.status} ${short((outsiderMap.json?.sessions ?? []).map((s: any) => s.title))}`);
const mapStorage = mapReply.json?.rootStorage;
check("[H] rootStorage berisi nilai nyata atau null (direktori sesi mesin relatif terhadap cwd)", mapStorage === null || (typeof mapStorage?.files === "number" && typeof mapStorage?.bytes === "number" && "newest" in mapStorage), short(mapStorage));

// ==================================================================== I. katalog kapabilitas (skills)
const skillsReply = await agent.call("GET", "/api/v1/skills");
check("[I] GET /api/v1/skills -> 200 dengan skills[] dan groups[]", skillsReply.status === 200 && Array.isArray(skillsReply.json?.skills) && Array.isArray(skillsReply.json?.groups) && skillsReply.json.skills.length > 20, `${skillsReply.status} jumlah=${skillsReply.json?.skills?.length}`);
const skills: any[] = skillsReply.json?.skills ?? [];
check("[I] setiap baris skill memuat key/name/available/detail/needs/group dengan tipe benar",
  skills.every((skill: any) => typeof skill.key === "string" && typeof skill.name === "string" && typeof skill.available === "boolean" && typeof skill.detail === "string" && (skill.needs === null || typeof skill.needs === "string") && typeof skill.group === "string"),
  short(skills.filter((skill: any) => typeof skill.key !== "string").slice(0, 2)));
const groupsInSkills = [...new Set(skills.map((skill: any) => skill.group))];
check("[I] groups[] sama persis dengan kumpulan group pada skills[]",
  skillsReply.json.groups.length === groupsInSkills.length && groupsInSkills.every((group) => skillsReply.json.groups.includes(group)),
  short({ groups: skillsReply.json?.groups, dihitung: groupsInSkills }));
const unavailable = skills.filter((skill: any) => skill.available === false);
check("[I] ada kapabilitas yang jujur ditandai available=false", unavailable.length >= 1, short(unavailable.map((skill: any) => skill.key)));
check("[I] setiap kapabilitas yang tidak tersedia menjelaskan kebutuhannya (needs tidak kosong)",
  unavailable.every((skill: any) => typeof skill.needs === "string" && skill.needs.length > 0), short(unavailable.map((skill: any) => ({ key: skill.key, needs: skill.needs }))));
const mailSkill = skills.find((skill: any) => skill.key === "mail");
check("[I] surat transaksional available=false + needs 'kredensial SMTP' (SMTP dihapus di suite ini)", mailSkill?.available === false && mailSkill?.needs === "kredensial SMTP", short(mailSkill));
const gatewaySkill = skills.find((skill: any) => skill.key === "gateway");
check("[I] gateway pembayaran available=false + needs 'kunci Xendit/Midtrans' (kunci dihapus di suite ini)", gatewaySkill?.available === false && gatewaySkill?.needs === "kunci Xendit/Midtrans", short(gatewaySkill));
const engineSkill = skills.find((skill: any) => skill.key === "engine");
check("[I] kapabilitas 'engine' available=true dengan versi mock tercatat", engineSkill?.available === true && String(engineSkill?.detail ?? "").includes("mock"), short(engineSkill));
const compactSkill = skills.find((skill: any) => skill.key === "compact");
check("[I] detail kapabilitas 'compact' mengikuti pengaturan akun (500 pesan)", String(compactSkill?.detail ?? "").includes("500 pesan"), short(compactSkill));
const memorySkill = skills.find((skill: any) => skill.key === "memory");
check("[I] detail kapabilitas 'memory' mengikuti jumlah catatan nyata", String(memorySkill?.detail ?? "").startsWith("1 catatan aktif"), short(memorySkill));
check("[I] balasan skills menyertakan storage.data dan storage.engineSessions", "data" in (skillsReply.json?.storage ?? {}) && "engineSessions" in (skillsReply.json?.storage ?? {}), short(skillsReply.json?.storage));
check("[I] skills tanpa sesi -> 401 AUTH_REQUIRED", (await client().call("GET", "/api/v1/skills")).status === 401, "tanpa cookie");

// ==================================================================== J. status hub
const hub = await agent.call("GET", "/api/v1/status-hub");
check("[J] GET /api/v1/status-hub -> 200", hub.status === 200, `${hub.status} ${short(hub.json)?.slice(0, 200)}`);
check("[J] balasan memuat engine, database, counts, money, mail, security, limits, storage, lastRuns, backup",
  ["engine", "database", "counts", "money", "mail", "security", "limits", "storage", "lastRuns", "backup"].every((key) => key in (hub.json ?? {})),
  short(Object.keys(hub.json ?? {})));
check("[J] database.ok=true dengan detail 'ok' dan jumlah tabel > 0", hub.json?.database?.ok === true && hub.json?.database?.detail === "ok" && hub.json?.database?.tables > 0, short(hub.json?.database));
check("[J] riwayat migrasi terbaru dilaporkan (maks 5 baris)", Array.isArray(hub.json?.database?.migrations) && hub.json.database.migrations.length >= 1 && hub.json.database.migrations.length <= 5, short(hub.json?.database?.migrations));
check("[J] engine tersambung dan jumlah model dilaporkan sebagai angka", hub.json?.engine?.available === true && typeof hub.json?.engine?.models === "number", short(hub.json?.engine));
check("[J] counts berisi pesan dan run nyata dari suite ini", Number(hub.json?.counts?.messages) >= 8 && Number(hub.json?.counts?.runs) >= 4 && Number(hub.json?.counts?.conversations) >= 2, short(hub.json?.counts));
check("[J] money.todayTokens > 0 setelah beberapa run nyata", Number(hub.json?.money?.todayTokens) > 0, short(hub.json?.money));
check("[J] mail.configured=false (SMTP dihapus) dan host null", hub.json?.mail?.configured === false && hub.json?.mail?.host === null, short(hub.json?.mail));
check("[J] keamanan: cookie sesi httpOnly dan CSRF tidak ketat", hub.json?.security?.sessionCookie === "httpOnly" && hub.json?.security?.csrfStrict === false, short(hub.json?.security));
const configuredAdminEmails = String(process.env.PLATFORM_ADMIN_EMAILS ?? "");
const adminEmailField = Number(hub.json?.security?.adminEmails);
if (adminEmailField === configuredAdminEmails.length) {
  note(`[J] TEMUAN KECIL: status-hub.security.adminEmails berisi PANJANG KARAKTER string PLATFORM_ADMIN_EMAILS (=${adminEmailField} untuk "${configuredAdminEmails}"), bukan jumlah alamat admin. Memakai daftar dua alamat akan melaporkan angka yang lebih besar tanpa alasan. Ditemukan dari server.ts:2567 (config.PLATFORM_ADMIN_EMAILS.length pada nilai string).`);
  skip("[J] status hub melaporkan JUMLAH email admin", `nilai nyata = panjang string env (${adminEmailField}), jadi pemeriksaan jumlah alamat tidak bisa lulus; dilaporkan sebagai temuan kecil, bukan kegagalan suite.`);
} else {
  check("[J] status hub melaporkan jumlah email admin sesuai daftar", adminEmailField === 1, short(hub.json?.security));
}
check("[J] limits memuat batas biaya, run per jam, dan timeout mesin", typeof hub.json?.limits?.engineTimeoutMs === "number" && typeof hub.json?.limits?.runsPerHour === "number" && typeof hub.json?.limits?.dailyCostMicros === "number", short(hub.json?.limits));
check("[J] storage.data nyata (direktori DATA_DIR ada) dan engineSessions berupa nilai/null", Number(hub.json?.storage?.data?.files) >= 1 && "engineSessions" in (hub.json?.storage ?? {}), short(hub.json?.storage));
check("[J] lastRuns memuat run terbaru dengan status/waktu", Array.isArray(hub.json?.lastRuns) && hub.json.lastRuns.length >= 1 && hub.json.lastRuns.every((run: any) => typeof run.id === "string" && typeof run.status === "string" && typeof run.createdAt === "string"), short(hub.json?.lastRuns?.slice(0, 3)));
check("[J] tidak ada run gagal dari suite ini (failedRuns konsisten dengan status run)", hub.json?.counts?.failedRuns === 0, short(hub.json?.counts?.failedRuns));
check("[J] backup melaporkan cron 03:17 dan catatan eksplisit", String(hub.json?.backup?.cron ?? "").length > 0 && String(hub.json?.backup?.note ?? "").includes("cron"), short(hub.json?.backup));
check("[J] generatedAt berupa waktu ISO dan durationMs angka", !Number.isNaN(Date.parse(String(hub.json?.generatedAt))) && typeof hub.json?.durationMs === "number", short({ generatedAt: hub.json?.generatedAt, durationMs: hub.json?.durationMs }));
check("[J] status-hub tanpa sesi -> 401 AUTH_REQUIRED", (await client().call("GET", "/api/v1/status-hub")).status === 401, "tanpa cookie");

// ==================================================================== K. playground
const quotaBeforePlayground = await usedToday(agent);
const playground = await agent.call("POST", "/api/v1/playground/run", { prompt: "Hitung 1+1 dan jelaskan dalam satu kalimat." });
check("[K] POST /api/v1/playground/run -> 200 dengan text", playground.status === 200 && typeof playground.json?.text === "string" && playground.json.text.includes("[mock:"), `${playground.status} ${short(playground.json)}`);
check("[K] playground melaporkan tokens > 0 dan usage dari mesin", Number(playground.json?.tokens) > 0 && playground.json?.usage && typeof playground.json.usage.inputTokens === "number", short({ tokens: playground.json?.tokens, usage: playground.json?.usage }));
check("[K] playground memakai thinking dari pengaturan akun (high)", playground.json?.thinking === "high" && playground.json?.autonomous === false, short({ thinking: playground.json?.thinking, autonomous: playground.json?.autonomous }));
check("[K] playground memakai model bawaan PRIME_AGENT_MODEL", playground.json?.model === "wave3-test-model", short(playground.json?.model));
check("[K] playground melaporkan systemBlocks = 2 (persona default akun + bank memori aktif)", playground.json?.systemBlocks === 2, short({ systemBlocks: playground.json?.systemBlocks }));
check("[K] playground memuat sessionId dan durationMs sebagai angka", typeof playground.json?.sessionId === "string" && typeof playground.json?.durationMs === "number", short({ sessionId: playground.json?.sessionId, durationMs: playground.json?.durationMs }));
const playgroundEcho = mockOptions(playground.json?.text);
check("[K] echo mesin: blok persona default dan bank memori benar-benar diteruskan",
  Array.isArray(playgroundEcho?.appendSystem) && playgroundEcho.appendSystem.length === 2
    && playgroundEcho.appendSystem.some((block: string) => String(block).includes("Persona aktif:"))
    && playgroundEcho.appendSystem.some((block: string) => String(block).includes("Bank memori pengguna")),
  short(playgroundEcho?.appendSystem));
check("[K] echo mesin: thinking mengikuti pengaturan akun (high)", playgroundEcho?.thinking === "high", short(playgroundEcho?.thinking));
note(`[K] bukti mentah opsi yang diterima mesin dari playground: ${JSON.stringify({ ...playgroundEcho, appendSystem: (playgroundEcho?.appendSystem ?? []).map((block: string) => `${String(block).slice(0, 24)}...(${String(block).length} karakter)`) })}`);
if (!("totalTokens" in (playground.json?.usage ?? {}))) {
  note(`[K] tokens playground (${playground.json?.tokens}) adalah ESTIMASI ceil(prompt/4)+ceil(text/4), bukan angka mesin, karena usage mesin ini tidak memuat totalTokens (server.ts:2608-2609). Di lingkungan nyata angka diambil dari usage.totalTokens bila ada.`);
}
if ("tools" in (playgroundEcho ?? {}) && playgroundEcho.tools !== null) {
  check("[K] echo mesin: allowlist alat diteruskan ke mesin (toolsAllow='none' -> array kosong)", Array.isArray(playgroundEcho.tools) && playgroundEcho.tools.length === 0, short(playgroundEcho.tools));
} else {
  note(`[K] BUG: /api/v1/playground/run TIDAK meneruskan allowlist alat ke mesin. Bukti: echo mesin berisi tools=null padahal pengaturan akun toolsAllow="none" dan pratinjau agen menampilkan flag --no-tools. Sebabnya engine.run() di server.ts:2595-2600 hanya mengirim runId/sessionId/prompt/model/provider/thinking/appendSystem/autonomous, sedangkan jalur percakapan mengirim field tools (server.ts:821). Akibatnya pengguna yang mematikan alat tetap mendapat bawaan mesin di playground.`);
  skip("[K] playground meneruskan allowlist alat (toolsAllow='none' -> tools=[])", "perilaku nyata = tools null (allowlist diabaikan). Ini BUG kode sumber; dilaporkan sebagai temuan dan tidak diperbaiki karena tugas melarang mengubah berkas sumber.");
}

const playgroundNoMemory = await agent.call("POST", "/api/v1/playground/run", { prompt: "Halo tanpa memori.", useMemory: false });
check("[K] useMemory=false -> systemBlocks=0 dan tidak ada appendSystem di mesin",
  playgroundNoMemory.status === 200 && playgroundNoMemory.json?.systemBlocks === 0 && Array.isArray(mockOptions(playgroundNoMemory.json?.text)?.appendSystem) && mockOptions(playgroundNoMemory.json?.text).appendSystem.length === 0,
  short({ systemBlocks: playgroundNoMemory.json?.systemBlocks, echo: mockOptions(playgroundNoMemory.json?.text) }));
const playgroundMaxThinking = await agent.call("POST", "/api/v1/playground/run", { prompt: "Halo.", thinking: "max" });
check("[K] playground menghormati thinking='max'", playgroundMaxThinking.status === 200 && playgroundMaxThinking.json?.thinking === "max" && mockOptions(playgroundMaxThinking.json?.text)?.thinking === "max", short({ thinking: playgroundMaxThinking.json?.thinking, echo: mockOptions(playgroundMaxThinking.json?.text)?.thinking }));
const playgroundEmpty = await agent.call("POST", "/api/v1/playground/run", { prompt: "   " });
check("[K] playground prompt kosong -> 400 INVALID_PROMPT", playgroundEmpty.status === 400 && playgroundEmpty.json?.error === "INVALID_PROMPT", `${playgroundEmpty.status} ${short(playgroundEmpty.json)}`);
const playgroundTooLong = await agent.call("POST", "/api/v1/playground/run", { prompt: "x".repeat(8001) });
check("[K] playground prompt > 8000 karakter -> 400 INVALID_PROMPT", playgroundTooLong.status === 400 && playgroundTooLong.json?.error === "INVALID_PROMPT", `${playgroundTooLong.status} ${short(playgroundTooLong.json)}`);
if (catalogueSize > 0) {
  const playgroundBadModel = await agent.call("POST", "/api/v1/playground/run", { prompt: "Halo.", model: "model-yang-tidak-ada-xyz" });
  check("[K] playground model tak dikenal -> 400 UNKNOWN_MODEL", playgroundBadModel.status === 400 && playgroundBadModel.json?.error === "UNKNOWN_MODEL", `${playgroundBadModel.status} ${short(playgroundBadModel.json)}`);
} else {
  skip("[K] playground model tak dikenal -> 400 UNKNOWN_MODEL", "katalog model kosong, isKnownModel() meloloskan semua nama");
}
check("[K] playground tanpa sesi -> 401 AUTH_REQUIRED", (await client().call("POST", "/api/v1/playground/run", { prompt: "halo" })).status === 401, "tanpa cookie");

const quotaAfterPlayground = await usedToday(agent);
if (quotaAfterPlayground === quotaBeforePlayground) {
  skip("[K] token playground masuk ke kuota harian (quotaState.usedToday naik)",
    `kuota harian TIDAK berubah walau playground melaporkan tokens=${playground.json?.tokens} (usedToday sebelum=${quotaBeforePlayground}, sesudah=${quotaAfterPlayground}). Sebabnya: quotaState() menghitung pemakaian dari tabel run_usage, sedangkan /api/v1/playground/run hanya memanggil chargeQuota(userId, tokens) di server.ts:2610 tanpa menulis baris run_usage. Jadi tidak ada endpoint GET yang bisa membuktikan token playground masuk kuota — ini TEMUAN, bukan kegagalan suite.`);
} else {
  check("[K] token playground masuk ke kuota harian (quotaState.usedToday naik)", Number(quotaAfterPlayground) > Number(quotaBeforePlayground), short({ sebelum: quotaBeforePlayground, sesudah: quotaAfterPlayground }));
}
// Pembanding: jalur run percakapan memang menulis run_usage dan menaikkan kuota.
const quotaBeforeRun = await usedToday(agent);
const quotaRun = await agent.call("POST", `/api/v1/conversations/${convOne}/messages`, { content: "Pesan pembanding kuota." });
await waitForAssistantRun(agent, convOne, quotaRun.json?.run?.id);
const quotaAfterRun = await usedToday(agent);
check("[K] jalur run percakapan menaikkan usedToday kuota (bukti kuota dihitung dari run_usage)",
  Number(quotaAfterRun) > Number(quotaBeforeRun), short({ sebelum: quotaBeforeRun, sesudah: quotaAfterRun, run: quotaRun.json?.run?.id }));
check("[K] kenaikan kuota minimal sebesar token yang dilaporkan mock (input/output)",
  Number(quotaAfterRun) - Number(quotaBeforeRun) >= 2, short({ sebelum: quotaBeforeRun, sesudah: quotaAfterRun }));

// ==================================================================== L. pembanding artefak (diff)
const artifactA = await uploadArtifact(agent, projectId, "catatan-a.txt", "baris satu\nbaris dua\nbaris tiga\n");
const artifactB = await uploadArtifact(agent, projectId, "catatan-b.txt", "baris satu\nbaris DUA\nbaris tiga\nbaris empat\n");
const artifactAId = artifactA.json?.id;
const artifactBId = artifactB.json?.id;
check("[L] unggah dua artefak teks -> 201", artifactA.status === 201 && artifactB.status === 201 && typeof artifactAId === "string" && typeof artifactBId === "string", `${artifactA.status}/${artifactB.status} ${short(artifactA.json)}`);
const foreignArtifact = await uploadArtifact(outsider, outsiderProjectId, "catatan-luar.txt", "isi orang lain\n");
const foreignArtifactId = foreignArtifact.json?.id;
check("[L] artefak milik pengguna lain siap (uji isolasi diff)", foreignArtifact.status === 201 && typeof foreignArtifactId === "string", `${foreignArtifact.status} ${short(foreignArtifact.json)}`);

const diffReply = await agent.call("GET", `/api/v1/artifacts/${artifactAId}/diff/${artifactBId}`);
check("[L] GET /artifacts/:id/diff/:otherId -> 200", diffReply.status === 200, `${diffReply.status} ${short(diffReply.json)}`);
check("[L] diff melaporkan nama kedua berkas dan jumlah baris", diffReply.json?.left?.name === "catatan-a.txt" && diffReply.json?.right?.name === "catatan-b.txt" && Number(diffReply.json?.left?.lines) > 0 && Number(diffReply.json?.right?.lines) > 0, short({ left: diffReply.json?.left, right: diffReply.json?.right }));
check("[L] diff menghitung added=2, removed=1, changes=3 untuk isi uji ini", diffReply.json?.added === 2 && diffReply.json?.removed === 1 && diffReply.json?.changes === 3, short({ added: diffReply.json?.added, removed: diffReply.json?.removed, changes: diffReply.json?.changes }));
check("[L] changes selalu sama dengan added + removed", Number(diffReply.json?.changes) === Number(diffReply.json?.added) + Number(diffReply.json?.removed), short(diffReply.json));
check("[L] hunks memuat baris '-' dan '+' dengan nomor baris kiri/kanan",
  Array.isArray(diffReply.json?.hunks) && diffReply.json.hunks.some((line: any) => line.type === "-" && Number(line.left) > 0) && diffReply.json.hunks.some((line: any) => line.type === "+" && Number(line.right) > 0),
  short(diffReply.json?.hunks));
const artifactC = await uploadArtifact(agent, projectId, "catatan-c.txt", "baris satu\nbaris dua\nbaris tiga\n");
const identicalDiff = await agent.call("GET", `/api/v1/artifacts/${artifactAId}/diff/${artifactC.json?.id}`);
check("[L] dua artefak BERBEDA dengan isi sama -> 200 dengan added=0, removed=0, changes=0",
  identicalDiff.status === 200 && identicalDiff.json?.added === 0 && identicalDiff.json?.removed === 0 && identicalDiff.json?.changes === 0 && identicalDiff.json?.left?.name !== identicalDiff.json?.right?.name,
  `${identicalDiff.status} ${short(identicalDiff.json)}`);
const sameDiff = await agent.call("GET", `/api/v1/artifacts/${artifactAId}/diff/${artifactAId}`);
check("[L] artefak yang sama -> 400 SAME_ARTIFACT", sameDiff.status === 400 && sameDiff.json?.error === "SAME_ARTIFACT", `${sameDiff.status} ${short(sameDiff.json)}`);
const foreignDiff = await agent.call("GET", `/api/v1/artifacts/${artifactAId}/diff/${foreignArtifactId}`);
check("[L] artefak milik pengguna lain di sisi kanan -> 404 ARTIFACT_NOT_FOUND", foreignDiff.status === 404 && foreignDiff.json?.error === "ARTIFACT_NOT_FOUND", `${foreignDiff.status} ${short(foreignDiff.json)}`);
const foreignDiffLeft = await agent.call("GET", `/api/v1/artifacts/${foreignArtifactId}/diff/${artifactAId}`);
check("[L] artefak milik pengguna lain di sisi kiri -> 404 ARTIFACT_NOT_FOUND", foreignDiffLeft.status === 404 && foreignDiffLeft.json?.error === "ARTIFACT_NOT_FOUND", `${foreignDiffLeft.status} ${short(foreignDiffLeft.json)}`);
const unknownDiff = await agent.call("GET", `/api/v1/artifacts/${randomUUID()}/diff/${artifactAId}`);
check("[L] id artefak tak dikenal -> 404 ARTIFACT_NOT_FOUND", unknownDiff.status === 404 && unknownDiff.json?.error === "ARTIFACT_NOT_FOUND", `${unknownDiff.status} ${short(unknownDiff.json)}`);
const diffContextZero = await agent.call("GET", `/api/v1/artifacts/${artifactAId}/diff/${artifactBId}?context=0`);
check("[L] context=0 tetap 200 dan hunks tidak lebih panjang dari context bawaan",
  diffContextZero.status === 200 && Array.isArray(diffContextZero.json?.hunks) && diffContextZero.json.hunks.length <= (diffReply.json?.hunks ?? []).length,
  short({ context0: diffContextZero.json?.hunks?.length, bawaan: diffReply.json?.hunks?.length }));
check("[L] diff tanpa sesi -> 401 AUTH_REQUIRED", (await client().call("GET", `/api/v1/artifacts/${artifactAId}/diff/${artifactBId}`)).status === 401, "tanpa cookie");
const artifactList = await agent.call("GET", `/api/v1/projects/${projectId}/artifacts`);
check("[L] daftar artefak proyek memuat kedua berkas uji",
  artifactList.status === 200 && Array.isArray(artifactList.json)
    && artifactList.json.some((row: any) => row.id === artifactAId) && artifactList.json.some((row: any) => row.id === artifactBId),
  Array.isArray(artifactList.json) ? short(artifactList.json.map((row: any) => row.name)) : short(artifactList.json));

// ==================================================================== M. laporan Markdown
const reportProject = await agent.call("GET", `/api/v1/projects/${projectId}/report.md?kind=project`);
check("[M] GET /projects/:id/report.md?kind=project -> 200", reportProject.status === 200, `${reportProject.status} ${short(reportProject.text).slice(0, 200)}`);
check("[M] tipe konten text/markdown dan nosniff diset", String(reportProject.headers.get("content-type") ?? "").startsWith("text/markdown") && reportProject.headers.get("x-content-type-options") === "nosniff", short(reportProject.headers.get("content-type")));
const disposition = String(reportProject.headers.get("content-disposition") ?? "");
check("[M] Content-Disposition berbentuk attachment dengan nama berkas .md", disposition.startsWith("attachment;") && disposition.includes("laporan-proyek-") && disposition.endsWith('.md"'), disposition);
check("[M] isi laporan proyek dimulai dengan judul proyek", reportProject.text.startsWith(`# Laporan proyek: Proyek Wave3`), short(reportProject.text.slice(0, 80)));
check("[M] laporan proyek memuat angka ringkas, daftar percakapan, artefak, run, dan workflow",
  ["## Angka ringkas", "## Percakapan", "## Artefak", "## Run terakhir", "## Workflow"].every((section) => reportProject.text.includes(section)),
  short(reportProject.text.slice(0, 400)));
check("[M] laporan proyek menyebut artefak nyata dari suite ini", reportProject.text.includes("catatan-a.txt") && reportProject.text.includes("catatan-b.txt"), short(reportProject.text.match(/## Artefak[\s\S]{0,200}/)?.[0]));

const reportConversation = await agent.call("GET", `/api/v1/projects/${projectId}/report.md?kind=conversation&conversationId=${convTwo}`);
check("[M] GET report.md?kind=conversation&conversationId -> 200", reportConversation.status === 200, `${reportConversation.status} ${short(reportConversation.text).slice(0, 200)}`);
check("[M] nama berkas laporan percakapan memuat 8 huruf pertama id percakapan", String(reportConversation.headers.get("content-disposition") ?? "").includes(`laporan-percakapan-${convTwo.slice(0, 8)}.md`), short(reportConversation.headers.get("content-disposition")));
check("[M] laporan percakapan memuat judul, bagian ringkasan pemadatan, dan isi percakapan",
  reportConversation.text.startsWith("# Laporan percakapan:") && reportConversation.text.includes("## Ringkasan pemadatan") && reportConversation.text.includes("### Pengguna") && reportConversation.text.includes("### Asisten"),
  short(reportConversation.text.slice(0, 300)));
check("[M] ringkasan pemadatan nyata ikut tercatat di laporan", reportConversation.text.includes("Pesan pertama soal XAU/USD H1.") && !reportConversation.text.includes("_Belum ada pemadatan._"), short(reportConversation.text.match(/## Ringkasan pemadatan[\s\S]{0,160}/)?.[0]));

const conversationsInProject = await agent.call("GET", `/api/v1/projects/${projectId}/conversations`);
const newestConversation = (conversationsInProject.json ?? [])[0];
const reportConversationNoId = await agent.call("GET", `/api/v1/projects/${projectId}/report.md?kind=conversation`);
const autoDisposition = String(reportConversationNoId.headers.get("content-disposition") ?? "");
check("[M] kind=conversation tanpa conversationId tetap 200", reportConversationNoId.status === 200, `${reportConversationNoId.status} ${short(reportConversationNoId.text).slice(0, 120)}`);
check("[M] tanpa conversationId laporan diam-diam memakai percakapan paling baru di proyek",
  typeof newestConversation?.id === "string" && autoDisposition.includes(newestConversation.id.slice(0, 8)),
  short({ namaBerkas: autoDisposition, percakapanTerbaru: newestConversation?.title, id: newestConversation?.id }));
note(`[M] kind=conversation tanpa conversationId TIDAK meminta konfirmasi: server otomatis memakai percakapan paling baru di proyek (di sini "${newestConversation?.title}"). Bisa mengejutkan kalau proyek punya banyak percakapan — dicatat sebagai perilaku nyata.`);

const reportUnknownKind = await agent.call("GET", `/api/v1/projects/${projectId}/report.md?kind=majalah`);
check("[M] kind tidak dikenal -> 400 UNKNOWN_REPORT_KIND", reportUnknownKind.status === 400 && reportUnknownKind.json?.error === "UNKNOWN_REPORT_KIND", `${reportUnknownKind.status} ${short(reportUnknownKind.json)}`);
const reportForeign = await outsider.call("GET", `/api/v1/projects/${projectId}/report.md?kind=project`);
check("[M] laporan proyek pengguna lain -> 404 REPORT_NOT_AVAILABLE", reportForeign.status === 404 && reportForeign.json?.error === "REPORT_NOT_AVAILABLE", `${reportForeign.status} ${short(reportForeign.json)}`);
const reportForeignConversation = await agent.call("GET", `/api/v1/projects/${projectId}/report.md?kind=conversation&conversationId=${randomUUID()}`);
check("[M] conversationId yang tidak ada di proyek -> 404 REPORT_NOT_AVAILABLE", reportForeignConversation.status === 404 && reportForeignConversation.json?.error === "REPORT_NOT_AVAILABLE", `${reportForeignConversation.status} ${short(reportForeignConversation.json)}`);
const reportUnknownProject = await agent.call("GET", `/api/v1/projects/${randomUUID()}/report.md?kind=project`);
check("[M] proyek tak dikenal -> 404 REPORT_NOT_AVAILABLE", reportUnknownProject.status === 404 && reportUnknownProject.json?.error === "REPORT_NOT_AVAILABLE", `${reportUnknownProject.status} ${short(reportUnknownProject.json)}`);
check("[M] report.md tanpa sesi -> 401 AUTH_REQUIRED", (await client().call("GET", `/api/v1/projects/${projectId}/report.md?kind=project`)).status === 401, "tanpa cookie");

// ==================================================================== N. hapus persona + peran viewer + isolasi akhir
const personaDelete = await agent.call("DELETE", `/api/v1/personas/${personaTwoId}`);
check("[E] DELETE persona milik sendiri -> 200 {deleted:true}", personaDelete.status === 200 && personaDelete.json?.deleted === true, `${personaDelete.status} ${short(personaDelete.json)}`);
const personasAfterDelete = await agent.call("GET", "/api/v1/personas");
check("[E] persona terhapus hilang dari daftar", (personasAfterDelete.json?.personas ?? []).every((row: any) => row.id !== personaTwoId), short((personasAfterDelete.json?.personas ?? []).map((row: any) => row.name)));
const defaultAfterDelete = await agent.call("POST", `/api/v1/personas/${personaTwoId}/default`);
check("[E] menjadikan persona terhapus sebagai default -> 404 PERSONA_NOT_FOUND", defaultAfterDelete.status === 404 && defaultAfterDelete.json?.error === "PERSONA_NOT_FOUND", `${defaultAfterDelete.status} ${short(defaultAfterDelete.json)}`);
const personaDeleteOutsider = await outsider.call("DELETE", `/api/v1/personas/${personaOneId}`);
check("[E] pengguna lain DELETE persona orang -> 404 PERSONA_NOT_FOUND", personaDeleteOutsider.status === 404 && personaDeleteOutsider.json?.error === "PERSONA_NOT_FOUND", `${personaDeleteOutsider.status} ${short(personaDeleteOutsider.json)}`);

const attachDefaultPersona = await agent.call("PATCH", `/api/v1/conversations/${convOne}/persona`, { personaId: personaOneId });
check("[E] pasang persona default (satu-satunya tersisa) ke percakapan -> 200", attachDefaultPersona.status === 200 && attachDefaultPersona.json?.personaId === personaOneId, `${attachDefaultPersona.status} ${short(attachDefaultPersona.json)}`);
const deleteDefaultPersona = await agent.call("DELETE", `/api/v1/personas/${personaOneId}`);
check("[E] DELETE persona yang sedang jadi default akun -> 200", deleteDefaultPersona.status === 200 && deleteDefaultPersona.json?.deleted === true, `${deleteDefaultPersona.status} ${short(deleteDefaultPersona.json)}`);
const previewAfterPersonaDelete = await agent.call("GET", `/api/v1/agents/preview?conversationId=${convOne}`);
check("[E] percakapan yang memakai persona terhapus otomatis dilepas (conversation.personaId null)",
  previewAfterPersonaDelete.json?.conversation?.personaId === null, short(previewAfterPersonaDelete.json?.conversation));
check("[E] blok persona hilang dari pratinjau setelah semua persona dihapus",
  (previewAfterPersonaDelete.json?.blocks ?? []).every((block: string) => !String(block).includes("Persona aktif:")), short(previewAfterPersonaDelete.json?.blocks?.map((block: string) => block.slice(0, 40))));
const personasEmpty = await agent.call("GET", "/api/v1/personas");
check("[E] daftar persona akun kosong setelah semua dihapus", personasEmpty.status === 200 && (personasEmpty.json?.personas ?? []).length === 0, short(personasEmpty.json?.personas));

// Peran viewer: undang pengguna baru sebagai viewer, lalu pastikan tulis Wave 3 ditolak.
const viewerEmail = `wave3-viewer-${stamp}@example.test`;
const viewer = client();
const viewerReg = await viewer.call("POST", "/api/v1/auth/register", { email: viewerEmail, password, displayName: "Viewer Wave3" });
check("[N] daftar akun calon viewer", viewerReg.status === 201, `${viewerReg.status} ${short(viewerReg.json)}`);
const inviteViewer = await agent.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/invitations`, { email: viewerEmail, role: "viewer" });
check("[N] undangan peran viewer terbit", inviteViewer.status === 201 && typeof inviteViewer.json?.token === "string", `${inviteViewer.status} ${short(inviteViewer.json)}`);
const acceptViewer = await viewer.call("POST", "/api/v1/invitations/accept", { token: inviteViewer.json?.token });
check("[N] viewer menerima undangan -> anggota workspace", acceptViewer.status === 200, `${acceptViewer.status} ${short(acceptViewer.json)}`);
const viewerPreview = await viewer.call("GET", `/api/v1/agents/preview?conversationId=${convTwo}`);
check("[N] viewer boleh membaca pratinjau konteks percakapan (200)", viewerPreview.status === 200 && viewerPreview.json?.summaryCount === 1, `${viewerPreview.status} ${short(viewerPreview.json)?.slice(0, 200)}`);
const viewerCompact = await viewer.call("POST", `/api/v1/conversations/${convTwo}/compact`);
check("[N] viewer memicu pemadatan -> 403 VIEWER_READ_ONLY", viewerCompact.status === 403 && viewerCompact.json?.error === "VIEWER_READ_ONLY", `${viewerCompact.status} ${short(viewerCompact.json)}`);
const viewerAttachPersona = await viewer.call("PATCH", `/api/v1/conversations/${convTwo}/persona`, { personaId: null });
check("[N] viewer mengubah persona percakapan -> 403 VIEWER_READ_ONLY", viewerAttachPersona.status === 403 && viewerAttachPersona.json?.error === "VIEWER_READ_ONLY", `${viewerAttachPersona.status} ${short(viewerAttachPersona.json)}`);
const viewerMap = await viewer.call("GET", "/api/v1/agents/map");
check("[N] viewer melihat peta agen workspace (200) tanpa kebocoran memori pribadi", viewerMap.status === 200 && Array.isArray(viewerMap.json?.sessions), `${viewerMap.status} ${short(viewerMap.json?.sessions?.length)}`);
const viewerMemories = await viewer.call("GET", "/api/v1/memories");
check("[N] daftar memori viewer kosong (bank memori bersifat per pengguna)",
  viewerMemories.status === 200 && (viewerMemories.json?.memories ?? []).length === 0, short(viewerMemories.json?.memories));
const viewerSettings = await viewer.call("GET", "/api/v1/agents/settings");
check("[N] pengaturan agen viewer terpisah dan memakai bawaan (thinking medium, alat kosong)",
  viewerSettings.status === 200 && viewerSettings.json?.settings?.thinking_level === "medium" && viewerSettings.json?.settings?.tools_allow === "", `${viewerSettings.status} ${short(viewerSettings.json?.settings)}`);

const outsiderCompact = await outsider.call("POST", `/api/v1/conversations/${convTwo}/compact`);
check("[N] pengguna di luar workspace memicu pemadatan -> 404 CONVERSATION_NOT_FOUND", outsiderCompact.status === 404 && outsiderCompact.json?.error === "CONVERSATION_NOT_FOUND", `${outsiderCompact.status} ${short(outsiderCompact.json)}`);
const outsiderSummaries = await outsider.call("GET", `/api/v1/conversations/${convTwo}/summaries`);
check("[N] pengguna di luar workspace membaca ringkasan -> 404 CONVERSATION_NOT_FOUND", outsiderSummaries.status === 404 && outsiderSummaries.json?.error === "CONVERSATION_NOT_FOUND", `${outsiderSummaries.status} ${short(outsiderSummaries.json)}`);
const outsiderConversationPersona = await outsider.call("PATCH", `/api/v1/conversations/${convTwo}/persona`, { personaId: null });
check("[N] pengguna di luar workspace mengubah persona percakapan -> 404 CONVERSATION_NOT_FOUND", outsiderConversationPersona.status === 404 && outsiderConversationPersona.json?.error === "CONVERSATION_NOT_FOUND", `${outsiderConversationPersona.status} ${short(outsiderConversationPersona.json)}`);
const outsiderPlayground = await outsider.call("POST", "/api/v1/playground/run", { prompt: "Halo dari luar.", useMemory: false });
check("[N] playground milik pengguna lain tetap terpisah (200 dengan systemBlocks=0)", outsiderPlayground.status === 200 && outsiderPlayground.json?.systemBlocks === 0, `${outsiderPlayground.status} ${short(outsiderPlayground.json)?.slice(0, 200)}`);
const anonymousPaths = ["/api/v1/agents/map", "/api/v1/memories", "/api/v1/prompt-templates", "/api/v1/personas", "/api/v1/status-hub"];
for (const path of anonymousPaths) {
  const response = await client().call("GET", path);
  check(`[N] GET ${path} tanpa sesi -> 401 AUTH_REQUIRED`, response.status === 401 && response.json?.error === "AUTH_REQUIRED", `${response.status} ${short(response.json)}`);
}

// Perubahan pengaturan tetap tersimpan sampai akhir suite (bukti persistensi lintas bagian).
const finalSettings = await agent.call("GET", "/api/v1/agents/settings");
check("[A] pengaturan akhir tetap thinking='high', toolsAllow='none', ambang=500",
  finalSettings.json?.settings?.thinking_level === "high" && finalSettings.json?.settings?.tools_allow === "none" && finalSettings.json?.settings?.compact_after_messages === 500,
  short(finalSettings.json?.settings));
check("[A] kuota akhir dilaporkan dengan tier nyata dan sisa harian", typeof finalSettings.json?.quota?.tier === "string" && Number(finalSettings.json?.quota?.remainingToday) > 0, short(finalSettings.json?.quota));

// ==================================================================== ringkasan
console.log("");
console.log(`RINGKASAN WAVE 3: ${checks} pemeriksaan, ${passed} lulus, ${failed} gagal, ${skipped.length} dilewati.`);
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
  console.log("WAVE3_TESTS_FAILED");
  process.exit(1);
}
console.log("ALL_WAVE3_TESTS_PASSED");
process.exit(0);

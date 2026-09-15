/**
 * Uji end-to-end Wave 2 coder-platform: lampiran pesan, cabang percakapan (branch),
 * hapus artefak massal (bulk-delete), dan penjagaan sesi/peran.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave2.e2e.ts
 *
 * Pola bootstrap meniru apps/api/test/billing.e2e.ts: semua variabel lingkungan diset SEBELUM
 * modul server/config diimpor (config.ts membaca env saat impor), DB sementara di /tmp, akun uji
 * didaftarkan lewat HTTP, dan seluruh pemeriksaan lewat HTTP ke 127.0.0.1. Tidak ada email
 * keluar dan tidak ada panggilan jaringan luar.
 *
 * CATATAN KONTRAK (perilaku nyata yang berbeda dari kontrak tulisan dicatat di laporan, bukan
 * ditutupi): 1) pemakaian `model` divalidasi lewat katalog CLI `prime-agent model list`; bila
 * katalog kosong, `isKnownModel` menerima semua nama sehingga UNKNOWN_MODEL tidak pernah muncul
 * (suite melewati pemeriksaan itu dengan CATATAN). 2) `attachments` yang bukan array diabaikan
 * dan pesan tetap 202. 3) Cabang percakapan menyalin berkas lampiran ke path baru.
 */

const port = 4600 + Math.floor(Math.random() * 300); // bukan port tetap; suite lain memakai 3424-3471, 3900-4400 dan 4500-4900
const dataDir = `/tmp/coder-wave2-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave2-test-model";
process.env.PLATFORM_ADMIN_EMAILS = "wave2-admin@example.test";
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
const { db } = await import("../src/db.js");
const { randomUUID } = await import("node:crypto");
const { existsSync } = await import("node:fs");

const base = `http://127.0.0.1:${port}`;

let checks = 0;
let passed = 0;
let failed = 0;
const failedNames: string[] = [];
const skipped: string[] = [];

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Potongan teks pendek untuk detail kegagalan. */
function short(value: unknown, limit = 240): string {
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
async function waitForMessageCount(api: ApiClient, conversationId: string, count: number, tries = 60): Promise<any[]> {
  let list = await messagesOf(api, conversationId);
  for (let attempt = 0; attempt < tries && list.length < count; attempt += 1) { await sleep(100); list = await messagesOf(api, conversationId); }
  return list;
}
/** Unggah artefak teks kecil lewat rute unggah yang ada. */
function uploadArtifact(api: ApiClient, projectId: string, name: string, text: string): Promise<Reply> {
  return api.call("POST", `/api/v1/projects/${projectId}/artifacts`, { name, mimeType: "text/plain", contentBase64: Buffer.from(text, "utf8").toString("base64") });
}
/** Baris artefak di DB (untuk memeriksa path berkas di disk). */
function artifactRow(id: string): any {
  return db.prepare("SELECT id, storage_path AS storagePath, name FROM artifacts WHERE id=?").get(id);
}
/** Baris lampiran di DB (untuk memeriksa path berkas dan jumlah teks yang diekstrak). */
function attachmentRow(id: string): any {
  return db.prepare("SELECT id, storage_path AS storagePath, size_bytes AS sizeBytes, extracted_chars AS extractedChars, mime_type AS mimeType FROM message_attachments WHERE id=?").get(id);
}
/** Prompt sebuah run di DB. */
function runRow(runId: string): any {
  return db.prepare("SELECT id, status, prompt FROM runs WHERE id=?").get(runId);
}

const stamp = Date.now();
const password = "Wave2Uji123!";
const ownerEmail = `wave2-owner-${stamp}@example.test`;
const outsiderEmail = `wave2-outsider-${stamp}@example.test`;
const viewerEmail = `wave2-viewer-${stamp}@example.test`;
const memberEmail = `wave2-member-${stamp}@example.test`;

// ==================================================================== persiapan akun & proyek
const serverReady = await waitForHealth();
check("[D] server uji siap menjawab GET /health 200", serverReady, `base=${base}`);

const agent = client();
const outsider = client();
const viewer = client();
const member = client();

const ownerReg = await agent.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Wave2" });
check("[D] daftar akun pemilik workspace", ownerReg.status === 201, `${ownerReg.status} ${short(ownerReg.json)}`);
const ownerWorkspaceId = ownerReg.json?.workspace?.id;
check("[D] pendaftaran memberi workspace pribadi", typeof ownerWorkspaceId === "string" && ownerWorkspaceId.length > 0, short(ownerReg.json?.workspace));

const outsiderReg = await outsider.call("POST", "/api/v1/auth/register", { email: outsiderEmail, password, displayName: "Orang Luar Wave2" });
check("[D] daftar akun kedua (bukan anggota workspace pemilik)", outsiderReg.status === 201, `${outsiderReg.status} ${short(outsiderReg.json)}`);
const outsiderWorkspaceId = outsiderReg.json?.workspace?.id;

const viewerReg = await viewer.call("POST", "/api/v1/auth/register", { email: viewerEmail, password, displayName: "Viewer Wave2" });
check("[D] daftar akun calon viewer", viewerReg.status === 201, `${viewerReg.status} ${short(viewerReg.json)}`);

const memberReg = await member.call("POST", "/api/v1/auth/register", { email: memberEmail, password, displayName: "Member Wave2" });
check("[D] daftar akun calon member", memberReg.status === 201, `${memberReg.status} ${short(memberReg.json)}`);

const projectCreate = await agent.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`, { name: "Proyek Wave2", slug: `wave2-${stamp}` });
const projectId = projectCreate.json?.id;
check("[A] proyek uji siap dibuat lewat HTTP", projectCreate.status === 201 && typeof projectId === "string", `${projectCreate.status} ${short(projectCreate.json)}`);

const outsiderProjectCreate = await outsider.call("POST", `/api/v1/workspaces/${outsiderWorkspaceId}/projects`, { name: "Proyek Orang Luar", slug: `wave2-luar-${stamp}` });
const outsiderProjectId = outsiderProjectCreate.json?.id;
check("[C] proyek milik pengguna lain siap (uji isolasi artefak)", outsiderProjectCreate.status === 201 && typeof outsiderProjectId === "string", `${outsiderProjectCreate.status} ${short(outsiderProjectCreate.json)}`);

// Viewer dan member diundang lewat rute undangan, lalu menerima tokennya (tanpa email).
const inviteViewer = await agent.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/invitations`, { email: viewerEmail, role: "viewer" });
check("[D] undangan peran viewer terbit", inviteViewer.status === 201 && typeof inviteViewer.json?.token === "string", `${inviteViewer.status} ${short(inviteViewer.json)}`);
const acceptViewer = await viewer.call("POST", "/api/v1/invitations/accept", { token: inviteViewer.json?.token });
check("[D] viewer menerima undangan -> anggota workspace", acceptViewer.status === 200 && acceptViewer.json?.role === "viewer", `${acceptViewer.status} ${short(acceptViewer.json)}`);

const inviteMember = await agent.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/invitations`, { email: memberEmail, role: "member" });
const acceptMember = await member.call("POST", "/api/v1/invitations/accept", { token: inviteMember.json?.token });
check("[D] member menerima undangan -> anggota workspace", inviteMember.status === 201 && acceptMember.status === 200 && acceptMember.json?.role === "member", `${inviteMember.status}/${acceptMember.status} ${short(acceptMember.json)}`);

const conversationTitle = "Percakapan Wave2";
const conversationCreate = await agent.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: conversationTitle });
const conversationId = conversationCreate.json?.conversation?.id ?? conversationCreate.json?.id;
check("[B] percakapan uji siap dibuat lewat HTTP", conversationCreate.status === 201 && typeof conversationId === "string", `${conversationCreate.status} ${short(conversationCreate.json)}`);

const emptyConversationCreate = await agent.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Percakapan Kosong Wave2" });
const emptyConversationId = emptyConversationCreate.json?.conversation?.id ?? emptyConversationCreate.json?.id;
check("[B] percakapan kosong siap (uji EMPTY_BRANCH)", emptyConversationCreate.status === 201 && typeof emptyConversationId === "string", `${emptyConversationCreate.status} ${short(emptyConversationCreate.json)}`);

// ==================================================================== A. lampiran pesan
const uniqueSentence = `RAHASIA-WAVE2-${stamp}-HANYA-UNTUK-PROMPT`;
const attachmentName = "catatan.txt";
const attachmentText = `Catatan uji lampiran.\nKalimat unik: ${uniqueSentence}\nBaris ketiga.\n`;
const attachmentBuffer = Buffer.from(attachmentText, "utf8");

const withAttachment = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, {
  content: "Tolong baca lampiran ini.",
  attachments: [{ name: attachmentName, mimeType: "text/plain", contentBase64: attachmentBuffer.toString("base64") }],
});
const firstMessage = withAttachment.json?.message;
const sourceAttachment = Array.isArray(firstMessage?.attachments) ? firstMessage.attachments[0] : undefined;
check("[A] kirim pesan + 1 lampiran .txt -> 202", withAttachment.status === 202, `${withAttachment.status} ${short(withAttachment.json)}`);
check("[A] balasan memuat message.attachments dengan id, messageId, name, mimeType, sizeBytes",
  Boolean(sourceAttachment) && typeof sourceAttachment.id === "string" && typeof sourceAttachment.messageId === "string"
    && sourceAttachment.name === attachmentName && sourceAttachment.mimeType === "text/plain" && typeof sourceAttachment.sizeBytes === "number",
  short(firstMessage?.attachments));
check("[A] messageId lampiran sama dengan id pesan", sourceAttachment?.messageId === firstMessage?.id, `att=${sourceAttachment?.messageId} pesan=${firstMessage?.id}`);
check("[A] sizeBytes lampiran = jumlah byte yang dikirim", sourceAttachment?.sizeBytes === attachmentBuffer.length, `dapat ${sourceAttachment?.sizeBytes}, kirim ${attachmentBuffer.length}`);
check("[A] balasan menyertakan run queued", withAttachment.json?.run?.status === "queued" && typeof withAttachment.json?.run?.id === "string", short(withAttachment.json?.run));

const sourceAttachmentId = sourceAttachment?.id;
const firstMessageId = firstMessage?.id;
const attachmentDisk = attachmentRow(sourceAttachmentId);
check("[A] berkas lampiran tertulis di disk (storage_path ada)", Boolean(attachmentDisk?.storagePath) && existsSync(attachmentDisk.storagePath), short(attachmentDisk));
check("[A] teks lampiran ikut diekstrak (extracted_chars > 0)", Number(attachmentDisk?.extractedChars ?? 0) > 0, short(attachmentDisk));

// Prompt run harus memuat isi teks lampiran dan nama berkasnya (dibaca dari tabel runs).
const firstRunId = withAttachment.json?.run?.id;
const runAfterAttachment = runRow(firstRunId);
check("[A] prompt run memuat kalimat unik dari lampiran", String(runAfterAttachment?.prompt ?? "").includes(uniqueSentence), short(runAfterAttachment?.prompt));
check("[A] prompt run memuat nama berkas lampiran", String(runAfterAttachment?.prompt ?? "").includes(attachmentName), short(runAfterAttachment?.prompt));
check("[A] prompt run memuat teks asli pesan di depan blok lampiran", String(runAfterAttachment?.prompt ?? "").startsWith("Tolong baca lampiran ini."), short(runAfterAttachment?.prompt));

// Tunggu jawaban mock supaya urutan pesan berikutnya pasti.
const afterFirstAnswer = await waitForMessageCount(agent, conversationId, 2);
check("[A] jalannya mesin mock menambah pesan assistant", afterFirstAnswer.length >= 2 && afterFirstAnswer[1]?.role === "assistant", short(afterFirstAnswer.map((m: any) => m.role)));

const messagesListing = await agent.call("GET", `/api/v1/conversations/${conversationId}/messages`);
const listedMessages: any[] = Array.isArray(messagesListing.json?.messages) ? messagesListing.json.messages : [];
const listedForFirst = listedMessages.find((message: any) => message.id === firstMessageId);
check("[A] GET messages -> 200 dan tiap pesan punya array attachments",
  messagesListing.status === 200 && listedMessages.length > 0 && listedMessages.every((message: any) => Array.isArray(message.attachments)),
  `${messagesListing.status} ${short(listedMessages.map((m: any) => m.attachments === undefined ? "tidak-ada" : m.attachments.length))}`);
check("[A] pesan berlampiran menampilkan 1 lampiran, pesan lain 0",
  listedForFirst?.attachments?.length === 1 && listedForFirst.attachments[0].id === sourceAttachmentId
    && listedMessages.filter((message: any) => message.id !== firstMessageId).every((message: any) => message.attachments.length === 0),
  short(listedMessages.map((m: any) => ({ id: m.id, n: m.attachments?.length }))));

const download = await agent.call("GET", `/api/v1/attachments/${sourceAttachmentId}`);
check("[A] GET /attachments/:id -> 200", download.status === 200, `${download.status} ${short(download.text)}`);
check("[A] content-type lampiran sesuai mime yang dikirim", String(download.headers.get("content-type") ?? "").startsWith("text/plain"), String(download.headers.get("content-type")));
check("[A] isi byte identik dengan yang dikirim", download.buffer.equals(attachmentBuffer), `panjang ${download.buffer.length} vs ${attachmentBuffer.length}`);
check("[A] content-disposition inline", String(download.headers.get("content-disposition") ?? "").toLowerCase().includes("inline"), String(download.headers.get("content-disposition")));

const unknownAttachment = await agent.call("GET", `/api/v1/attachments/${randomUUID()}`);
check("[A] id lampiran tak dikenal -> 404 ATTACHMENT_NOT_FOUND",
  unknownAttachment.status === 404 && unknownAttachment.json?.error === "ATTACHMENT_NOT_FOUND", `${unknownAttachment.status} ${short(unknownAttachment.json)}`);

const foreignAttachment = await outsider.call("GET", `/api/v1/attachments/${sourceAttachmentId}`);
check("[D] lampiran milik pengguna lain -> 404 ATTACHMENT_NOT_FOUND (bukan 200/403)",
  foreignAttachment.status === 404 && foreignAttachment.json?.error === "ATTACHMENT_NOT_FOUND", `${foreignAttachment.status} ${short(foreignAttachment.json)}`);

const viewerAttachment = await viewer.call("GET", `/api/v1/attachments/${sourceAttachmentId}`);
check("[D] viewer anggota workspace boleh mengunduh lampiran -> 200", viewerAttachment.status === 200 && viewerAttachment.buffer.equals(attachmentBuffer), `${viewerAttachment.status} ${short(viewerAttachment.json)}`);

const attachmentOnly = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, {
  content: "   ",
  attachments: [{ name: "hanya-lampiran.txt", mimeType: "text/plain", contentBase64: Buffer.from("tanpa teks pesan", "utf8").toString("base64") }],
});
check("[A] content kosong tapi ada lampiran -> 202 dan content diisi '(lihat lampiran)'",
  attachmentOnly.status === 202 && attachmentOnly.json?.message?.content === "(lihat lampiran)",
  `${attachmentOnly.status} ${short(attachmentOnly.json?.message)}`);

const emptyMessage = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "   " });
check("[A] content dan lampiran dua-duanya kosong -> 400 INVALID_MESSAGE",
  emptyMessage.status === 400 && emptyMessage.json?.error === "INVALID_MESSAGE", `${emptyMessage.status} ${short(emptyMessage.json)}`);

const sixFiles = Array.from({ length: 6 }, (_value, index) => ({ name: `banyak-${index}.txt`, mimeType: "text/plain", contentBase64: Buffer.from(`isi ${index}`, "utf8").toString("base64") }));
const tooMany = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Enam lampiran.", attachments: sixFiles });
check("[A] lebih dari 5 lampiran -> 400 TOO_MANY_ATTACHMENTS",
  tooMany.status === 400 && tooMany.json?.error === "TOO_MANY_ATTACHMENTS", `${tooMany.status} ${short(tooMany.json)}`);
check("[A] pesan TOO_MANY_ATTACHMENTS berbahasa Indonesia dan menyebut 'Maksimal 5 lampiran'",
  String(tooMany.json?.message ?? "").includes("Maksimal 5 lampiran"), short(tooMany.json?.message));

const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
const tooLarge = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, {
  content: "Lampiran besar.",
  attachments: [{ name: "besar.txt", mimeType: "text/plain", contentBase64: oversized.toString("base64") }],
});
check("[A] satu lampiran > 5 MB -> 400 ATTACHMENT_TOO_LARGE",
  tooLarge.status === 400 && tooLarge.json?.error === "ATTACHMENT_TOO_LARGE", `${tooLarge.status} ${short(tooLarge.json)}`);

const noName = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, {
  content: "Lampiran tanpa nama.",
  attachments: [{ name: "   ", mimeType: "text/plain", contentBase64: Buffer.from("isi", "utf8").toString("base64") }],
});
check("[A] nama berkas kosong -> 400 ATTACHMENT_INVALID",
  noName.status === 400 && noName.json?.error === "ATTACHMENT_INVALID", `${noName.status} ${short(noName.json)}`);

const notArray = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Attachments bukan array.", attachments: "bukan-array" });
check("[A] attachments bukan array -> diabaikan, pesan tetap 202 tanpa lampiran",
  notArray.status === 202 && Array.isArray(notArray.json?.message?.attachments) && notArray.json.message.attachments.length === 0,
  `${notArray.status} ${short(notArray.json?.message)}`);

const dataUrl = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, {
  content: "Lampiran dengan awalan data URL.",
  attachments: [{ name: "data-url.txt", mimeType: "text/plain", contentBase64: `data:text/plain;base64,${Buffer.from("isi data url", "utf8").toString("base64")}` }],
});
check("[A] awalan data:...;base64, pada contentBase64 diterima -> 202 dengan byte benar",
  dataUrl.status === 202 && dataUrl.json?.message?.attachments?.[0]?.sizeBytes === Buffer.byteLength("isi data url"),
  `${dataUrl.status} ${short(dataUrl.json?.message?.attachments)}`);

const guessedMime = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, {
  content: "Lampiran tanpa mimeType.",
  attachments: [{ name: "laporan.md", contentBase64: Buffer.from("# Judul laporan", "utf8").toString("base64") }],
});
check("[A] mimeType ditebak dari ekstensi bila klien tidak mengirim -> text/markdown",
  guessedMime.status === 202 && guessedMime.json?.message?.attachments?.[0]?.mimeType === "text/markdown",
  `${guessedMime.status} ${short(guessedMime.json?.message?.attachments)}`);

// Pesan kedua tanpa lampiran di percakapan uji lampiran.
const secondMessage = await agent.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Pertanyaan kedua tanpa lampiran." });
check("[A] kirim pesan kedua (tanpa lampiran) -> 202 dengan attachments kosong",
  secondMessage.status === 202 && Array.isArray(secondMessage.json?.message?.attachments) && secondMessage.json.message.attachments.length === 0,
  `${secondMessage.status} ${short(secondMessage.json?.message)}`);

const conversationMessages = await waitForMessageCount(agent, conversationId, 12);
const messagesWithAttachments = conversationMessages.filter((message: any) => (message.attachments?.length ?? 0) > 0);
check("[A] lampiran hanya menempel pada 4 pesan user dan tidak ada pada pesan assistant",
  messagesWithAttachments.length === 4 && messagesWithAttachments.every((message: any) => message.role === "user")
    && conversationMessages.filter((message: any) => message.role === "assistant").every((message: any) => (message.attachments?.length ?? 0) === 0),
  short(conversationMessages.map((m: any) => `${m.role}:${m.attachments?.length}`)));

// ==================================================================== B. cabang percakapan
// Percakapan sumber cabang dibuat khusus supaya urutannya pasti: tepat 4 pesan
// (user + lampiran, assistant, user tanpa lampiran, assistant).
const branchSourceTitle = "Percakapan Sumber Cabang";
const branchSourceCreate = await agent.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: branchSourceTitle });
const branchConversationId = branchSourceCreate.json?.conversation?.id ?? branchSourceCreate.json?.id;
check("[B] percakapan sumber cabang siap dibuat",
  branchSourceCreate.status === 201 && typeof branchConversationId === "string", `${branchSourceCreate.status} ${short(branchSourceCreate.json)}`);

const branchSourceFirst = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/messages`, {
  content: "Pesan cabang pertama.",
  attachments: [{ name: attachmentName, mimeType: "text/plain", contentBase64: attachmentBuffer.toString("base64") }],
});
const branchSourceAttachmentId = branchSourceFirst.json?.message?.attachments?.[0]?.id;
check("[B] pesan pertama percakapan sumber cabang + lampiran -> 202",
  branchSourceFirst.status === 202 && typeof branchSourceAttachmentId === "string", `${branchSourceFirst.status} ${short(branchSourceFirst.json?.message)}`);
const branchSourceAttachmentDisk = attachmentRow(branchSourceAttachmentId);

const afterBranchSourceFirst = await waitForMessageCount(agent, branchConversationId, 2);
check("[B] jawaban mesin untuk pesan pertama percakapan sumber cabang tersimpan",
  afterBranchSourceFirst.length >= 2 && afterBranchSourceFirst[1]?.role === "assistant", short(afterBranchSourceFirst.map((m: any) => m.role)));

const branchSourceSecond = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/messages`, { content: "Pesan cabang kedua tanpa lampiran." });
check("[B] pesan kedua percakapan sumber cabang (tanpa lampiran) -> 202",
  branchSourceSecond.status === 202 && branchSourceSecond.json?.message?.attachments?.length === 0, `${branchSourceSecond.status} ${short(branchSourceSecond.json?.message)}`);

const sourceMessages = await waitForMessageCount(agent, branchConversationId, 4);
check("[B] percakapan sumber cabang berisi tepat 4 pesan (user, assistant, user, assistant)",
  sourceMessages.length === 4 && sourceMessages.map((message: any) => message.role).join(",") === "user,assistant,user,assistant",
  short(sourceMessages.map((m: any) => m.role)));
const sourceMessageIds = sourceMessages.map((message: any) => message.id);

const branchAll = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { title: "Cabang Penuh Wave2" });
const branchAllConversation = branchAll.json?.conversation;
check("[B] cabang tanpa fromMessageId -> 201 dengan conversation & run null",
  branchAll.status === 201 && typeof branchAllConversation?.id === "string" && branchAll.json?.run === null,
  `${branchAll.status} ${short(branchAll.json)}`);
check("[B] cabang berada di project yang sama dan judul permintaan dipakai",
  branchAllConversation?.projectId === projectId && branchAllConversation?.title === "Cabang Penuh Wave2" && typeof branchAllConversation?.createdAt === "string",
  short(branchAllConversation));
check("[B] id percakapan cabang berbeda dari sumbernya", branchAllConversation?.id !== conversationId, `${branchAllConversation?.id} vs ${conversationId}`);

const branchAllMessages = await messagesOf(agent, branchAllConversation?.id);
check("[B] seluruh pesan sumber disalin ke cabang (4 pesan, urutan dan isi sama)",
  branchAllMessages.length === sourceMessages.length
    && branchAllMessages.every((message: any, index: number) => message.role === sourceMessages[index].role && message.content === sourceMessages[index].content),
  short(branchAllMessages.map((m: any) => m.role)));

const branchCopySource = branchAllMessages.find((message: any) => Array.isArray(message.attachments) && message.attachments.length > 0);
const branchAttachment = branchCopySource?.attachments?.[0];
check("[B] lampiran pesan yang disalin ikut tersalin dengan id baru dan metadata sama",
  Boolean(branchAttachment) && branchAttachment.id !== branchSourceAttachmentId && branchAttachment.name === attachmentName
    && branchAttachment.mimeType === "text/plain" && branchAttachment.sizeBytes === attachmentBuffer.length,
  short(branchAttachment));

const branchAttachmentDisk = attachmentRow(branchAttachment?.id);
check("[B] berkas lampiran cabang memakai path baru di disk (bukan path sumber)",
  Boolean(branchAttachmentDisk?.storagePath) && branchAttachmentDisk.storagePath !== branchSourceAttachmentDisk?.storagePath
    && existsSync(branchAttachmentDisk.storagePath) && existsSync(branchSourceAttachmentDisk?.storagePath ?? ""),
  short({ cabang: branchAttachmentDisk?.storagePath, sumber: branchSourceAttachmentDisk?.storagePath }));

const branchAttachmentDownload = await agent.call("GET", `/api/v1/attachments/${branchAttachment?.id}`);
const sourceAttachmentAgain = await agent.call("GET", `/api/v1/attachments/${branchSourceAttachmentId}`);
check("[B] lampiran cabang bisa diunduh dengan isi byte yang sama",
  branchAttachmentDownload.status === 200 && branchAttachmentDownload.buffer.equals(attachmentBuffer), `${branchAttachmentDownload.status} ${short(branchAttachmentDownload.text)}`);
check("[B] lampiran sumber tetap bisa diunduh setelah cabang dibuat",
  sourceAttachmentAgain.status === 200 && sourceAttachmentAgain.buffer.equals(attachmentBuffer), `${sourceAttachmentAgain.status} ${short(sourceAttachmentAgain.text)}`);

const projectConversations = await agent.call("GET", `/api/v1/projects/${projectId}/conversations`);
const conversationIds = (Array.isArray(projectConversations.json) ? projectConversations.json : []).map((row: any) => row.id);
check("[B] percakapan cabang muncul di daftar percakapan project",
  projectConversations.status === 200 && conversationIds.includes(branchAllConversation?.id), `${projectConversations.status} ${short(conversationIds)}`);

const branchPartial = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { fromMessageId: sourceMessages[2]?.id, title: "Cabang Sebagian Wave2" });
const branchPartialMessages = await messagesOf(agent, branchPartial.json?.conversation?.id);
check("[B] fromMessageId -> hanya pesan sampai titik itu yang disalin (3 pesan)",
  branchPartial.status === 201 && branchPartialMessages.length === 3
    && branchPartialMessages.every((message: any, index: number) => message.content === sourceMessages[index].content),
  `${branchPartial.status} ${short(branchPartialMessages.map((m: any) => m.role))}`);
const partialAttachments = branchPartialMessages.flatMap((message: any) => message.attachments ?? []);
check("[B] cabang sebagian hanya membawa lampiran dari pesan di dalam rentang (1 lampiran, id baru)",
  partialAttachments.length === 1 && partialAttachments[0].id !== branchSourceAttachmentId
    && partialAttachments[0].sizeBytes === attachmentBuffer.length,
  short(branchPartialMessages.map((m: any) => m.attachments?.length)));

const branchUpToAssistant = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { fromMessageId: sourceMessages[1]?.id, title: "Cabang Sampai Assistant" });
const branchUpToAssistantMessages = await messagesOf(agent, branchUpToAssistant.json?.conversation?.id);
check("[B] fromMessageId pada balasan assistant -> cabang berisi 2 pesan dengan 1 lampiran",
  branchUpToAssistant.status === 201 && branchUpToAssistantMessages.length === 2
    && branchUpToAssistantMessages[1]?.role === "assistant"
    && (branchUpToAssistantMessages[0]?.attachments?.length ?? 0) === 1,
  `${branchUpToAssistant.status} ${short(branchUpToAssistantMessages.map((m: any) => ({ role: m.role, n: m.attachments?.length })))}`);

const branchHead = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { fromMessageId: sourceMessages[0]?.id, title: "Cabang Satu Pesan Wave2" });
const branchHeadMessages = await messagesOf(agent, branchHead.json?.conversation?.id);
check("[B] fromMessageId pesan pertama -> cabang berisi 1 pesan berlampiran",
  branchHead.status === 201 && branchHeadMessages.length === 1 && branchHeadMessages[0]?.attachments?.length === 1
    && branchHeadMessages[0].attachments[0].id !== branchSourceAttachmentId,
  `${branchHead.status} ${short(branchHeadMessages.map((m: any) => m.attachments?.length))}`);

const branchMissingMessage = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { fromMessageId: randomUUID() });
check("[B] fromMessageId tidak ada di percakapan itu -> 400 MESSAGE_NOT_FOUND",
  branchMissingMessage.status === 400 && branchMissingMessage.json?.error === "MESSAGE_NOT_FOUND", `${branchMissingMessage.status} ${short(branchMissingMessage.json)}`);

const branchEmpty = await agent.call("POST", `/api/v1/conversations/${emptyConversationId}/branch`, { title: "Cabang Kosong" });
check("[B] cabang percakapan kosong tanpa fromMessageId -> 400 EMPTY_BRANCH",
  branchEmpty.status === 400 && branchEmpty.json?.error === "EMPTY_BRANCH", `${branchEmpty.status} ${short(branchEmpty.json)}`);

const branchDefaultTitle = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, {});
check("[B] judul cabang kosong memakai judul sumber + ' (cabang)'",
  branchDefaultTitle.status === 201 && branchDefaultTitle.json?.conversation?.title === `${branchSourceTitle} (cabang)`,
  short(branchDefaultTitle.json?.conversation));

const branchRerun = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { fromMessageId: sourceMessages[2]?.id, rerun: true });
const rerunRunId = branchRerun.json?.run?.id;
check("[B] rerun:true -> cabang 201 dengan run queued",
  branchRerun.status === 201 && typeof rerunRunId === "string" && branchRerun.json?.run?.status === "queued",
  `${branchRerun.status} ${short(branchRerun.json)}`);
const rerunRow = runRow(rerunRunId);
check("[B] run cabang tercatat di DB dengan prompt pesan user terakhir yang disalin",
  Boolean(rerunRow?.id) && rerunRow.prompt === sourceMessages[2]?.content, short(rerunRow));

const branchUnknownModel = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { title: "Cabang Model Salah", model: `model-tidak-ada-${stamp}` });
const catalogue = await agent.call("GET", "/api/v1/models");
const knownModels: string[] = Array.isArray(catalogue.json?.models) ? catalogue.json.models.map((row: any) => row?.model).filter(Boolean) : [];
if (knownModels.length > 0) {
  check("[B] model tak dikenal -> 400 UNKNOWN_MODEL",
    branchUnknownModel.status === 400 && branchUnknownModel.json?.error === "UNKNOWN_MODEL", `${branchUnknownModel.status} ${short(branchUnknownModel.json)}`);
  const branchKnownModel = await agent.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { title: "Cabang Model Benar", model: knownModels[0] });
  check("[B] model dari katalog mesin diterima -> 201", branchKnownModel.status === 201, `${branchKnownModel.status} ${short(branchKnownModel.json)}`);
} else {
  skip("[B] model tak dikenal -> 400 UNKNOWN_MODEL",
    `katalog mesin kosong (GET /models models=[]) sehingga isKnownModel menerima semua nama; respons nyata ${branchUnknownModel.status} ${short(branchUnknownModel.json?.error ?? branchUnknownModel.json)}`);
}

const branchByOutsider = await outsider.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { title: "Cabang Orang Luar" });
check("[D] cabang oleh pengguna bukan anggota -> 404 CONVERSATION_NOT_FOUND",
  branchByOutsider.status === 404 && branchByOutsider.json?.error === "CONVERSATION_NOT_FOUND", `${branchByOutsider.status} ${short(branchByOutsider.json)}`);

const branchByViewer = await viewer.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { title: "Cabang Viewer" });
check("[D] cabang oleh peran viewer -> 403 VIEWER_READ_ONLY",
  branchByViewer.status === 403 && branchByViewer.json?.error === "VIEWER_READ_ONLY", `${branchByViewer.status} ${short(branchByViewer.json)}`);

const viewerReadMessages = await viewer.call("GET", `/api/v1/conversations/${conversationId}/messages`);
check("[D] viewer tetap boleh membaca riwayat pesan -> 200", viewerReadMessages.status === 200 && Array.isArray(viewerReadMessages.json?.messages), `${viewerReadMessages.status} ${short(viewerReadMessages.json)}`);

// ==================================================================== C. hapus artefak massal
const artifactA1 = await uploadArtifact(agent, projectId, "artefak-a1.txt", "isi artefak a1");
const artifactA2 = await uploadArtifact(agent, projectId, "artefak-a2.txt", "isi artefak a2");
const artifactA3 = await uploadArtifact(agent, projectId, "artefak-a3.txt", "isi artefak a3");
const artifactA4 = await uploadArtifact(agent, projectId, "artefak-a4.txt", "isi artefak a4");
const artifactA5 = await uploadArtifact(agent, projectId, "artefak-a5.txt", "isi artefak a5");
const artifactOutsider = await uploadArtifact(outsider, outsiderProjectId, "artefak-luar.txt", "isi artefak orang luar");
check("[C] lima artefak uji terunggah lewat rute unggah",
  [artifactA1, artifactA2, artifactA3, artifactA4, artifactA5].every((reply) => reply.status === 201 && typeof reply.json?.id === "string"),
  short([artifactA1.status, artifactA2.status, artifactA3.status, artifactA4.status, artifactA5.status]));
check("[C] artefak milik pengguna lain terunggah di project terpisah",
  artifactOutsider.status === 201 && typeof artifactOutsider.json?.id === "string", `${artifactOutsider.status} ${short(artifactOutsider.json)}`);

const idA1 = artifactA1.json?.id;
const idA2 = artifactA2.json?.id;
const idA3 = artifactA3.json?.id;
const idA4 = artifactA4.json?.id;
const idA5 = artifactA5.json?.id;
const idOutside = artifactOutsider.json?.id;
const pathA1 = artifactRow(idA1)?.storagePath;
check("[C] berkas artefak ada di disk sebelum dihapus", Boolean(pathA1) && existsSync(pathA1), String(pathA1));

const noIds = await agent.call("POST", "/api/v1/artifacts/bulk-delete", {});
check("[C] body tanpa ids -> 400 IDS_REQUIRED", noIds.status === 400 && noIds.json?.error === "IDS_REQUIRED", `${noIds.status} ${short(noIds.json)}`);
const idsNotArray = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: "bukan-array" });
check("[C] ids bukan array -> 400 IDS_REQUIRED", idsNotArray.status === 400 && idsNotArray.json?.error === "IDS_REQUIRED", `${idsNotArray.status} ${short(idsNotArray.json)}`);
const idsEmpty = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [] });
check("[C] ids array kosong -> 400 IDS_REQUIRED", idsEmpty.status === 400 && idsEmpty.json?.error === "IDS_REQUIRED", `${idsEmpty.status} ${short(idsEmpty.json)}`);
const idsBlank = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [null, "   ", ""] });
check("[C] ids berisi entri kosong saja -> 400 IDS_REQUIRED", idsBlank.status === 400 && idsBlank.json?.error === "IDS_REQUIRED", `${idsBlank.status} ${short(idsBlank.json)}`);

const deleteA1 = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [idA1] });
check("[C] hapus satu artefak sah -> 200 deleted=1 skipped=[]",
  deleteA1.status === 200 && deleteA1.json?.deleted === 1 && Array.isArray(deleteA1.json?.skipped) && deleteA1.json.skipped.length === 0,
  `${deleteA1.status} ${short(deleteA1.json)}`);
check("[C] baris artefak hilang dari DB setelah dihapus", artifactRow(idA1) === undefined, short(artifactRow(idA1)));
check("[C] berkas artefak ikut terhapus dari disk", !existsSync(pathA1), String(pathA1));

const artifactsAfterDelete = await agent.call("GET", `/api/v1/projects/${projectId}/artifacts`);
const artifactIdsAfter = (Array.isArray(artifactsAfterDelete.json) ? artifactsAfterDelete.json : []).map((row: any) => row.id);
check("[C] artefak yang dihapus tidak ada lagi di GET /projects/:id/artifacts", !artifactIdsAfter.includes(idA1), short(artifactIdsAfter));

const rawAfterDelete = await agent.call("GET", `/api/v1/artifacts/${idA1}/raw`);
check("[C] unduh artefak yang sudah dihapus -> 404 ARTIFACT_NOT_FOUND",
  rawAfterDelete.status === 404 && rawAfterDelete.json?.error === "ARTIFACT_NOT_FOUND", `${rawAfterDelete.status} ${short(rawAfterDelete.json)}`);

const unknownId = randomUUID();
const deleteUnknown = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [unknownId] });
check("[C] id tak dikenal -> deleted=0 dan id masuk skipped tanpa error",
  deleteUnknown.status === 200 && deleteUnknown.json?.deleted === 0 && Array.isArray(deleteUnknown.json?.skipped) && deleteUnknown.json.skipped.includes(unknownId),
  `${deleteUnknown.status} ${short(deleteUnknown.json)}`);

const deleteMixed = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [idA2, unknownId] });
check("[C] campuran id sah dan id tak dikenal -> deleted=1 skipped=1",
  deleteMixed.status === 200 && deleteMixed.json?.deleted === 1 && deleteMixed.json?.skipped?.length === 1 && deleteMixed.json.skipped[0] === unknownId,
  `${deleteMixed.status} ${short(deleteMixed.json)}`);

const deleteForeign = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [idOutside] });
check("[C] artefak milik pengguna lain -> skipped, bukan dihapus",
  deleteForeign.status === 200 && deleteForeign.json?.deleted === 0 && deleteForeign.json?.skipped?.includes(idOutside), `${deleteForeign.status} ${short(deleteForeign.json)}`);
const outsiderArtifacts = await outsider.call("GET", `/api/v1/projects/${outsiderProjectId}/artifacts`);
const outsiderArtifactIds = (Array.isArray(outsiderArtifacts.json) ? outsiderArtifacts.json : []).map((row: any) => row.id);
check("[C] artefak milik pengguna lain masih ada bagi pemiliknya", outsiderArtifactIds.includes(idOutside), short(outsiderArtifactIds));

const deleteDuplicates = await agent.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [idA3, idA3, ` ${idA3} `] });
check("[C] id ganda dan berspasi diproses sekali -> deleted=1 skipped=[]",
  deleteDuplicates.status === 200 && deleteDuplicates.json?.deleted === 1 && deleteDuplicates.json?.skipped?.length === 0, `${deleteDuplicates.status} ${short(deleteDuplicates.json)}`);

const deleteByViewer = await viewer.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [idA4] });
check("[C] peran viewer tidak boleh menghapus -> deleted=0 dan id masuk skipped",
  deleteByViewer.status === 200 && deleteByViewer.json?.deleted === 0 && deleteByViewer.json?.skipped?.includes(idA4), `${deleteByViewer.status} ${short(deleteByViewer.json)}`);
check("[C] artefak yang dilewati peran viewer masih ada", Boolean(artifactRow(idA4)) && existsSync(artifactRow(idA4)?.storagePath ?? ""), short(artifactRow(idA4)));

const deleteByMember = await member.call("POST", "/api/v1/artifacts/bulk-delete", { ids: [idA5] });
check("[C] peran member boleh menghapus artefak workspace -> deleted=1",
  deleteByMember.status === 200 && deleteByMember.json?.deleted === 1 && deleteByMember.json?.skipped?.length === 0, `${deleteByMember.status} ${short(deleteByMember.json)}`);

const bulkDeleteAnon = await client().call("POST", "/api/v1/artifacts/bulk-delete", { ids: [idA4] });
check("[D] bulk-delete tanpa sesi -> 401 AUTH_REQUIRED", bulkDeleteAnon.status === 401 && bulkDeleteAnon.json?.error === "AUTH_REQUIRED", `${bulkDeleteAnon.status} ${short(bulkDeleteAnon.json)}`);

// ==================================================================== D. otentikasi & isolasi antar-pengguna
const anon = client();
const anonMessages = await anon.call("GET", `/api/v1/conversations/${conversationId}/messages`);
check("[D] GET messages tanpa sesi -> 401 AUTH_REQUIRED", anonMessages.status === 401 && anonMessages.json?.error === "AUTH_REQUIRED", `${anonMessages.status} ${short(anonMessages.json)}`);
const anonSend = await anon.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Tanpa sesi." });
check("[D] POST messages tanpa sesi -> 401 AUTH_REQUIRED", anonSend.status === 401 && anonSend.json?.error === "AUTH_REQUIRED", `${anonSend.status} ${short(anonSend.json)}`);
const anonAttachment = await anon.call("GET", `/api/v1/attachments/${sourceAttachmentId}`);
check("[D] GET attachment tanpa sesi -> 401 AUTH_REQUIRED", anonAttachment.status === 401 && anonAttachment.json?.error === "AUTH_REQUIRED", `${anonAttachment.status} ${short(anonAttachment.json)}`);
const anonBranch = await anon.call("POST", `/api/v1/conversations/${branchConversationId}/branch`, { title: "Cabang Anonim" });
check("[D] POST branch tanpa sesi -> 401 AUTH_REQUIRED", anonBranch.status === 401 && anonBranch.json?.error === "AUTH_REQUIRED", `${anonBranch.status} ${short(anonBranch.json)}`);

const fakeSession = await client("coder_session=token-palsu-tidak-ada").call("GET", `/api/v1/conversations/${conversationId}/messages`);
check("[D] cookie sesi palsu -> 401 AUTH_REQUIRED", fakeSession.status === 401 && fakeSession.json?.error === "AUTH_REQUIRED", `${fakeSession.status} ${short(fakeSession.json)}`);

const outsiderMessages = await outsider.call("GET", `/api/v1/conversations/${conversationId}/messages`);
check("[D] baca pesan percakapan pengguna lain -> 404 CONVERSATION_NOT_FOUND",
  outsiderMessages.status === 404 && outsiderMessages.json?.error === "CONVERSATION_NOT_FOUND", `${outsiderMessages.status} ${short(outsiderMessages.json)}`);
const outsiderSend = await outsider.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Menyusup ke percakapan orang." });
check("[D] kirim pesan ke percakapan pengguna lain -> 404 CONVERSATION_NOT_FOUND",
  outsiderSend.status === 404 && outsiderSend.json?.error === "CONVERSATION_NOT_FOUND", `${outsiderSend.status} ${short(outsiderSend.json)}`);
const outsiderArtifactsOfOwner = await outsider.call("GET", `/api/v1/projects/${projectId}/artifacts`);
check("[D] daftar artefak project pengguna lain -> 404 PROJECT_NOT_FOUND",
  outsiderArtifactsOfOwner.status === 404 && outsiderArtifactsOfOwner.json?.error === "PROJECT_NOT_FOUND", `${outsiderArtifactsOfOwner.status} ${short(outsiderArtifactsOfOwner.json)}`);

const viewerSend = await viewer.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Viewer mencoba menulis." });
check("[D] peran viewer mengirim pesan -> 403 VIEWER_READ_ONLY",
  viewerSend.status === 403 && viewerSend.json?.error === "VIEWER_READ_ONLY", `${viewerSend.status} ${short(viewerSend.json)}`);

const outsiderOwnMessages = await outsider.call("GET", `/api/v1/conversations/${emptyConversationId}/messages`);
check("[D] percakapan kosong milik pengguna lain juga 404 (tidak ada kebocoran keberadaan)",
  outsiderOwnMessages.status === 404 && outsiderOwnMessages.json?.error === "CONVERSATION_NOT_FOUND", `${outsiderOwnMessages.status} ${short(outsiderOwnMessages.json)}`);

const sourceConversationAfterBranch = await messagesOf(agent, branchConversationId);
check("[B] percakapan sumber tidak berubah setelah semua cabang dibuat: daftar id pesan identik",
  sourceConversationAfterBranch.length === sourceMessageIds.length
    && sourceConversationAfterBranch.every((message: any, index: number) => message.id === sourceMessageIds[index]),
  short(sourceConversationAfterBranch.map((m: any) => m.id)));

// ==================================================================== ringkasan
console.log("");
console.log(`RINGKASAN WAVE 2: ${checks} pemeriksaan, ${passed} lulus, ${failed} gagal, ${skipped.length} dilewati.`);
if (failedNames.length) {
  console.log("Pemeriksaan yang gagal:");
  for (const name of failedNames) console.log(` - ${name}`);
}
if (skipped.length) {
  console.log("Pemeriksaan yang dilewati:");
  for (const name of skipped) console.log(` - ${name}`);
}
if (failed > 0) {
  console.log("WAVE2_TESTS_FAILED");
  process.exit(1);
}
console.log("ALL_WAVE2_TESTS_PASSED");
process.exit(0);

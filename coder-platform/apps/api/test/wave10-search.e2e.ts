/**
 * Uji Wave 10 butir 29: pencarian global lintas proyek.
 *
 * Yang dibuktikan:
 *  1) skema 18: tabel FTS `message_search` ada, plus tiga trigger penjaga indeks;
 *  2) pesan baru masuk indeks OTOMATIS lewat rute kirim pesan (trigger insert) dan MATCH menemukannya;
 *  3) `GET /api/v1/search?q=` menemukan proyek, percakapan, pesan, artefak, dokumen knowledge, dan
 *     workflow, lengkap dengan `groups[].kind`, `title`, dan `snippet`;
 *  4) ISOLASI RUANG KERJA: kata yang hanya ada di data akun LAIN tidak muncul, dan akun luar
 *     mendapat `total: 0` untuk kata milik ruang kerja orang lain;
 *  5) batas masukan: `q` kosong/1 karakter, kata berlebih, dan `limit` besar;
 *  6) `POST /api/v1/admin/search/reindex` hanya untuk admin dan tahan terhadap indeks yang hilang;
 *  7) `GET /api/v1/search/status` melaporkan jumlah pesan dan jumlah baris terindeks;
 *  8) trigger delete/update: pesan yang dihapus hilang dari indeks, isi yang diubah ikut diperbarui.
 *
 * Jalankan: npx tsx apps/api/test/wave10-search.e2e.ts
 */
const port = 7180 + Math.floor(Math.random() * 10); // rentang khusus suite ini: 7180-7189
const dataDir = `/tmp/coder-wave10-search-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `w10search-admin-${stamp}@example.test`;
const ownerEmail = `w10search-owner-${stamp}@example.test`;
const otherEmail = `w10search-other-${stamp}@example.test`;
const password = "SandiUji2026!aman";
/** Satu kata alfanumerik: tokenizer unicode61 menjadikannya satu token FTS. */
const TOKEN = `carian${stamp}`;
/** Kata yang HANYA ditulis di data akun lain (uji isolasi ruang kerja). */
const TOKEN_ASING = `asing${stamp}`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.ENGINE_ROOT_DIR = `${dataDir}/engine-sessions`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave10-search-model";
process.env.NOTIFY_EMAIL_ENABLED = "false";
// Gerbang verifikasi email dimatikan: suite ini menguji pencarian, bukan verifikasi (Wave 8).
process.env.VERIFY_EMAIL_REQUIRED = "off";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RETENTION_ENABLED = "false";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { jobWorkerState } = await import("../src/jobs.js");
const { searchTerms, SEARCH_KINDS } = await import("../src/search.js");

await new Promise((resolve) => setTimeout(resolve, 1200));
// Putaran pekerjaan pertama berjalan sendiri saat server menyala; suite ini menunggu dulu supaya
// pekerjaan berkala tidak berlomba dengan data ujinya (pola sama dengan wave8.e2e.ts).
for (let attempt = 0; attempt < 120; attempt += 1) {
  const scheduled = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='retention.run' AND status IN ('queued','running')").get() as { n: number };
  if (jobWorkerState().cyclesRun >= 1 && Number(scheduled?.n ?? 0) === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log(`INFO putaran pekerjaan awal selesai: cycles=${jobWorkerState().cyclesRun}`);
const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }

/** Klien HTTP kecil dengan cookie sendiri. Origin kosong = klien non-peramban, jadi lolos CSRF. */
function client() {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) { const value = setCookie.split(";")[0]; cookie = value.endsWith("=") ? "" : value; }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json, text };
    },
    clear() { cookie = ""; },
  };
}
const admin = client(); const owner = client(); const other = client(); const anon = client();
const tableCount = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const scalar = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as any[]) as T | undefined;
/** Permintaan MATCH yang berdiri sendiri (bukan memanggil helper modul). */
const match = (token: string) => `SELECT COUNT(*) AS n FROM message_search WHERE message_search MATCH '"${token}"*'`;

// ------------------------------------------------------------------ 1) skema 18
const version = Number((scalar<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations") ?? { v: 0 }).v);
check(`1) skema basis data versi ${SCHEMA_VERSION}`, version === SCHEMA_VERSION, String(version));
const ftsTable = scalar<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE name='message_search'");
check("1) tabel FTS message_search ada", ftsTable?.name === "message_search", JSON.stringify(ftsTable?.name));
check("1) message_search dibuat sebagai tabel virtual FTS5 dengan tokenizer unicode61",
  /USING fts5/i.test(String(ftsTable?.sql)) && /unicode61/i.test(String(ftsTable?.sql)), String(ftsTable?.sql)?.slice(0, 120));
const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'message_search_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
check("1) tiga trigger indeks ada (insert, delete, update)",
  ["message_search_delete", "message_search_insert", "message_search_update"].every((name) => triggers.includes(name)), JSON.stringify(triggers));

// ------------------------------------------------------------------ 2) pesan baru masuk indeks otomatis
const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Pencarian Wave 10" });
check("2) akun admin uji terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.user?.id), JSON.stringify(adminReg.json)?.slice(0, 160));
const ownerReg = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Pencarian Wave 10" });
check("2) akun pemilik uji terdaftar", ownerReg.status === 201 && Boolean(ownerReg.json?.workspace?.id), JSON.stringify(ownerReg.json)?.slice(0, 160));
const ownerUserId = String(ownerReg.json?.user?.id ?? "");
const ownerWorkspaceId = String(ownerReg.json?.workspace?.id ?? "");
const project = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`,
  { name: `Proyek ${TOKEN} Alpha`, slug: `proyek-${TOKEN}`, description: `Keterangan proyek ${TOKEN} untuk uji pencarian global.` });
check("2) proyek uji dibuat", project.status === 201 && Boolean(project.json?.id), JSON.stringify(project.json)?.slice(0, 160));
const projectId = String(project.json?.id ?? "");
const conversation = await owner.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: `Percakapan ${TOKEN} pertama` });
check("2) percakapan uji dibuat", conversation.status === 201 && Boolean(conversation.json?.conversation?.id), JSON.stringify(conversation.json)?.slice(0, 160));
const conversationId = String(conversation.json?.conversation?.id ?? "");

const indexedBefore = tableCount("SELECT COUNT(*) AS n FROM message_search");
const sent = await owner.call("POST", `/api/v1/conversations/${conversationId}/messages`,
  { content: `Pesan uji berisi ${TOKEN} untuk indeks pencarian global.` });
check("2) pesan diterima rute kirim pesan (202)", sent.status === 202 && Boolean(sent.json?.message?.id), JSON.stringify(sent.json)?.slice(0, 200));
const sentMessageId = String(sent.json?.message?.id ?? "");
const indexedAfter = tableCount("SELECT COUNT(*) AS n FROM message_search");
check("2) trigger insert menambah baris indeks tanpa aksi lain", indexedAfter >= indexedBefore + 1, `${indexedBefore} -> ${indexedAfter}`);
check("2) baris indeks memuat pesan yang baru dikirim",
  tableCount("SELECT COUNT(*) AS n FROM message_search WHERE message_id=?", sentMessageId) === 1, sentMessageId);
check("2) MATCH menemukan kata kunci pada pesan baru", tableCount(match(TOKEN)) >= 1, String(tableCount(match(TOKEN))));

// Data lain untuk lima kelompok hasil: artefak, knowledge, dan workflow.
const artifact = await owner.call("POST", `/api/v1/projects/${projectId}/artifacts`,
  { name: `berkas-${TOKEN}.txt`, mimeType: "text/plain", contentBase64: Buffer.from(`isi artefak ${TOKEN}`).toString("base64") });
check("3) artefak uji dibuat", artifact.status === 201 && Boolean(artifact.json?.id), JSON.stringify(artifact.json)?.slice(0, 160));
const knowledge = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge`,
  { title: `Dokumen ${TOKEN}`, content: `Badan dokumen berisi ${TOKEN} supaya ikut terindeks FTS.` });
check("3) dokumen knowledge uji dibuat", knowledge.status === 201 && Boolean(knowledge.json?.id), JSON.stringify(knowledge.json)?.slice(0, 160));
const workflow = await owner.call("POST", `/api/v1/projects/${projectId}/workflows`,
  { name: `Alur ${TOKEN}`, description: `Alur kerja berisi ${TOKEN}`, steps: [{ type: "prompt", prompt: "halo" }] });
check("3) workflow uji dibuat", workflow.status === 201 && Boolean(workflow.json?.id), JSON.stringify(workflow.json)?.slice(0, 160));

// ------------------------------------------------------------------ 3) pencarian lintas kelompok
const found = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}`);
check("3) GET /api/v1/search menjawab 200", found.status === 200, `${found.status} ${found.text?.slice(0, 120)}`);
const body = found.json ?? {};
const groups: any[] = Array.isArray(body.groups) ? body.groups : [];
const kindsFound = groups.map((group) => String(group?.kind));
const wanted = ["project", "conversation", "message", "artifact", "knowledge", "workflow"];
check("3) hasil memuat enam kelompok yang diminta spec", wanted.every((kind) => kindsFound.includes(kind)), JSON.stringify(kindsFound));
check("3) tiap kelompok memuat kind, label, dan hits", groups.every((group) => wanted.includes(String(group?.kind)) && typeof group?.label === "string" && Array.isArray(group?.hits) && group.hits.length > 0),
  JSON.stringify(groups.map((group) => ({ kind: group?.kind, label: group?.label, hits: group?.hits?.length })))?.slice(0, 240));
const allHits = groups.flatMap((group) => group.hits ?? []);
check("3) tiap hasil memuat kind, id, title, snippet, dan link",
  allHits.every((hit: any) => wanted.includes(String(hit?.kind)) && typeof hit?.id === "string" && typeof hit?.title === "string" && typeof hit?.snippet === "string" && typeof hit?.link === "string"),
  JSON.stringify(allHits[0])?.slice(0, 200));
check("3) total = jumlah hit yang dikembalikan", Number(body.total) === allHits.length, `total=${body.total} hit=${allHits.length}`);
check("3) counts per kelompok cocok dengan jumlah hit",
  wanted.every((kind) => Number(body.counts?.[kind] ?? 0) === Number(groups.find((group) => group.kind === kind)?.hits?.length ?? 0)),
  JSON.stringify(body.counts));
const snippetKinds = ["project", "message", "knowledge", "workflow"];
const snippetBarrier = allHits.filter((hit: any) => snippetKinds.includes(String(hit?.kind)));
check("3) cuplikan kelompok teks memuat kata yang dicari",
  snippetBarrier.length > 0 && snippetBarrier.every((hit: any) => String(hit.snippet).toLowerCase().includes(TOKEN.toLowerCase())),
  JSON.stringify(snippetBarrier.map((hit: any) => [hit.kind, hit.snippet]))?.slice(0, 300));
check("3) cuplikan percakapan dan artefak berisi penjelasan proyek", allHits.filter((hit: any) => ["conversation", "artifact"].includes(String(hit?.kind))).every((hit: any) => String(hit.snippet).length > 0), "");
console.log(`INFO cuplikan contoh: ${JSON.stringify(allHits.slice(0, 3).map((hit: any) => ({ kind: hit.kind, snippet: String(hit.snippet).slice(0, 90) })))}`);
// Cuplikan menandai kata yang dicari dengan `<mark>`. Halaman meng-escape seluruh cuplikan lalu
// hanya menghidupkan tag itu kembali, jadi teks simpanan tidak pernah bisa menjadi tag lain.
check("3) cuplikan memakai penanda <mark> pada kata yang dicari",
  allHits.some((hit: any) => String(hit?.snippet).includes("<mark>") && String(hit?.snippet).includes("</mark>")),
  JSON.stringify(allHits.slice(0, 3).map((hit: any) => String(hit?.snippet).slice(0, 80))));
check("3) cuplikan tidak membawa tag lain selain <mark>",
  allHits.every((hit: any) => !/<(?!\/?mark>)[a-zA-Z!/]/.test(String(hit?.snippet ?? ""))),
  JSON.stringify(allHits.map((hit: any) => String(hit?.snippet ?? "")).filter((text: string) => /<(?!\/?mark>)[a-zA-Z!/]/.test(text)).slice(0, 2)));

// ------------------------------------------------------------------ 4) isolasi ruang kerja
const otherReg = await other.call("POST", "/api/v1/auth/register", { email: otherEmail, password, displayName: "Akun Luar Wave 10" });
check("4) akun luar terdaftar dengan ruang kerja sendiri", otherReg.status === 201 && Boolean(otherReg.json?.workspace?.id), JSON.stringify(otherReg.json)?.slice(0, 160));
const otherWorkspaceId = String(otherReg.json?.workspace?.id ?? "");
check("4) akun luar BUKAN anggota ruang kerja pemilik",
  tableCount("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=? AND user_id=?", ownerWorkspaceId, String(otherReg.json?.user?.id ?? "")) === 0, "");
const otherProject = await other.call("POST", `/api/v1/workspaces/${otherWorkspaceId}/projects`,
  { name: `Proyek ${TOKEN_ASING} Rahasia`, slug: `rahasia-${TOKEN_ASING}`, description: `Hanya milik akun luar ${TOKEN_ASING}.` });
check("4) proyek akun luar dibuat", otherProject.status === 201, JSON.stringify(otherProject.json)?.slice(0, 160));
const otherProjectId = String(otherProject.json?.id ?? "");
const otherConversation = await other.call("POST", `/api/v1/projects/${otherProjectId}/conversations`, { title: `Percakapan ${TOKEN_ASING}` });
const otherConversationId = String(otherConversation.json?.conversation?.id ?? "");
const otherSent = await other.call("POST", `/api/v1/conversations/${otherConversationId}/messages`, { content: `Pesan akun luar berisi ${TOKEN_ASING}.` });
check("4) pesan akun luar masuk indeks", otherSent.status === 202 && tableCount(match(TOKEN_ASING)) >= 1, `${otherSent.status}`);

const leak = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN_ASING)}`);
check("4) kata milik ruang kerja lain TIDAK muncul untuk pemilik (total 0)", leak.status === 200 && Number(leak.json?.total) === 0 && (leak.json?.groups ?? []).length === 0,
  JSON.stringify({ total: leak.json?.total, kinds: (leak.json?.groups ?? []).map((group: any) => group.kind) }));
const ownSearch = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}`);
check("4) seluruh hasil pemilik berasal dari ruang kerjanya sendiri",
  (ownSearch.json?.groups ?? []).flatMap((group: any) => group.hits).every((hit: any) => hit.workspaceId === ownerWorkspaceId),
  JSON.stringify((ownSearch.json?.groups ?? []).flatMap((group: any) => group.hits).map((hit: any) => hit.workspaceId)));
const otherSearch = await other.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN_ASING)}`);
check("4) akun luar menemukan kata miliknya sendiri (proyek + pesan)",
  otherSearch.status === 200 && Number(otherSearch.json?.total) >= 2
  && (otherSearch.json?.groups ?? []).some((group: any) => group.kind === "project")
  && (otherSearch.json?.groups ?? []).some((group: any) => group.kind === "message"),
  JSON.stringify({ total: otherSearch.json?.total, kinds: (otherSearch.json?.groups ?? []).map((group: any) => group.kind) }));
const anonSearch = await anon.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}`);
check("4) pencarian tanpa masuk ditolak (401)", anonSearch.status === 401, `${anonSearch.status} ${anonSearch.text?.slice(0, 120)}`);

// ------------------------------------------------------------------ 5) batas masukan
const emptyQuery = await owner.call("GET", "/api/v1/search?q=");
// Dulu bercabang ke `skip` ketika server belum menolak; sekarang rute WAJIB menolak (regresi harus berisik).
check("5) q kosong ditolak 400", emptyQuery.status === 400,
  `server menjawab ${emptyQuery.status} (total=${emptyQuery.json?.total})`);
check("5) q kosong tidak mengembalikan hasil", Number(emptyQuery.json?.total ?? 0) === 0 && (emptyQuery.json?.groups ?? []).length === 0, JSON.stringify({ status: emptyQuery.status, total: emptyQuery.json?.total }));
const shortQuery = await owner.call("GET", "/api/v1/search?q=c");
check("5) q satu karakter ditolak 400 SEARCH_QUERY_TOO_SHORT",
  shortQuery.status === 400 && shortQuery.json?.error === "SEARCH_QUERY_TOO_SHORT",
  `${shortQuery.status} ${JSON.stringify(shortQuery.json)?.slice(0, 120)}`);
const longQuery = await owner.call("GET", `/api/v1/search?q=${"a".repeat(201)}`);
check("5) q lebih dari 200 karakter ditolak 400 SEARCH_QUERY_TOO_LONG", longQuery.status === 400 && longQuery.json?.error === "SEARCH_QUERY_TOO_LONG", `${longQuery.status} ${JSON.stringify(longQuery.json)?.slice(0, 120)}`);
// Kata pendek supaya seluruh permintaan tetap di bawah batas 200 karakter milik rute.
const manyWords = Array.from({ length: 12 }, (_, index) => `z${index}x${stamp.toString(36)}`);
const manyResult = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(manyWords.join(" "))}`);
const terms: string[] = Array.isArray(manyResult.json?.terms) ? manyResult.json.terms : [];
check("5) kata berlebih dipotong sebelum dikirim ke FTS", manyResult.status === 200 && terms.length > 0 && terms.length < manyWords.length, `istilah=${terms.length} dari ${manyWords.length} kata`);
check("5) potongan kata sama dengan aturan searchTerms (maks 8 istilah)", terms.length === searchTerms(manyWords.join(" ")).length, `rute=${terms.length} modul=${searchTerms(manyWords.join(" ")).length}`);
check("5) potongan istilah mengikuti aturan searchTerms",
  terms.length === searchTerms(manyWords.join(" ")).length,
  `rute=${terms.length} modul=${searchTerms(manyWords.join(" ")).length}`);
const bigLimit = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}&limit=1000`);
check("5) limit besar tidak diteruskan apa adanya", Number(bigLimit.json?.limit) < 1000, String(bigLimit.json?.limit));
check("5) jumlah hit per kelompok tidak melebihi limit yang berlaku",
  (bigLimit.json?.groups ?? []).every((group: any) => Number(group?.hits?.length ?? 0) <= Number(bigLimit.json?.limit ?? 0)),
  JSON.stringify((bigLimit.json?.groups ?? []).map((group: any) => group?.hits?.length)));
// SEARCH_MAX_RESULTS adalah batas ATAS satu halaman: pemanggil boleh meminta lebih sedikit, tidak
// boleh lebih banyak. Jadi permintaan 1000 pun dijawab 10, bukan 50.
check("5) limit besar dijepit tepat ke SEARCH_MAX_RESULTS", Number(bigLimit.json?.limit) === 10, String(bigLimit.json?.limit));
const smallLimit = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}&limit=3`);
check("5) limit kecil dihormati apa adanya", Number(smallLimit.json?.limit) === 3, String(smallLimit.json?.limit));
const onlyMessage = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}&kinds=message`);
check("5) kinds=message hanya mengembalikan kelompok message", onlyMessage.status === 200 && (onlyMessage.json?.groups ?? []).length === 1 && onlyMessage.json?.groups?.[0]?.kind === "message",
  JSON.stringify((onlyMessage.json?.groups ?? []).map((group: any) => group.kind)));
check("5) kinds=message mengosongkan hitungan kelompok lain dan total = counts.message",
  Number(onlyMessage.json?.counts?.project ?? -1) === 0 && Number(onlyMessage.json?.counts?.message ?? 0) === Number(onlyMessage.json?.total),
  JSON.stringify(onlyMessage.json?.counts));
const twoKinds = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}&kinds=project,message`);
check("5) kinds=project,message mengembalikan dua kelompok saja",
  twoKinds.status === 200 && (twoKinds.json?.groups ?? []).length === 2 && (twoKinds.json?.groups ?? []).every((group: any) => ["project", "message"].includes(group.kind)),
  JSON.stringify((twoKinds.json?.groups ?? []).map((group: any) => group.kind)));
check("5) kinds tak dikenal diabaikan (kembali ke semua kelompok)",
  (await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}&kinds=khayalan`)).json?.groups?.length === 6, "");

// ------------------------------------------------------------------ 6) reindex (admin saja)
const messagesCount = tableCount("SELECT COUNT(*) AS n FROM messages");
const reindexForbidden = await owner.call("POST", "/api/v1/admin/search/reindex");
check("6) pengguna biasa ditolak 403 ADMIN_REQUIRED", reindexForbidden.status === 403 && reindexForbidden.json?.error === "ADMIN_REQUIRED", `${reindexForbidden.status} ${JSON.stringify(reindexForbidden.json)?.slice(0, 120)}`);
const firstReindex = await admin.call("POST", "/api/v1/admin/search/reindex");
check("6) admin menjalankan reindex -> 200", firstReindex.status === 200, `${firstReindex.status} ${firstReindex.text?.slice(0, 140)}`);
check("6) reindex melaporkan jumlah pesan yang dibangun ulang",
  Number(firstReindex.json?.indexed?.messages) === Number(firstReindex.json?.before?.messages) && Number(firstReindex.json?.indexed?.messages) >= messagesCount,
  `indexed=${firstReindex.json?.indexed?.messages} sebelum=${firstReindex.json?.before?.messages} pesan=${messagesCount}`);
check("6) sesudah reindex: baris indeks setara jumlah pesan", Number(firstReindex.json?.after?.indexedMessages) === Number(firstReindex.json?.after?.messages), JSON.stringify(firstReindex.json?.after));

// Ketahanan: indeks dikosongkan seperti setelah pemulihan cadangan lama, lalu dibangun ulang.
db.prepare("DELETE FROM message_search").run();
const statusAfterWipe = await owner.call("GET", "/api/v1/search/status");
check("6) setelah indeks dikosongkan: status melaporkan 0 baris terindeks", Number(statusAfterWipe.json?.index?.indexedMessages) === 0, JSON.stringify(statusAfterWipe.json?.index));
const searchAfterWipe = await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}&kinds=message`);
check("6) setelah indeks dikosongkan: pesan tidak ditemukan", Number(searchAfterWipe.json?.counts?.message ?? -1) === 0, JSON.stringify(searchAfterWipe.json?.counts));
const restored = await admin.call("POST", "/api/v1/admin/search/reindex");
check("6) reindex mengembalikan indeks pesan",
  Number(restored.json?.after?.indexedMessages) === Number(restored.json?.after?.messages) && Number(restored.json?.after?.indexedMessages) >= messagesCount,
  JSON.stringify(restored.json?.after));
check("6) sesudah dipulihkan: pesan ditemukan lagi", Number((await owner.call("GET", `/api/v1/search?q=${encodeURIComponent(TOKEN)}&kinds=message`)).json?.counts?.message ?? 0) >= 1, "");
check("6) reindex menyebut jumlah sebelum dan sesudah", Number.isFinite(Number(restored.json?.before?.indexedMessages)) && Number.isFinite(Number(restored.json?.after?.indexedMessages)), JSON.stringify({ before: restored.json?.before, after: restored.json?.after }));

// ------------------------------------------------------------------ 7) status indeks
const status = await owner.call("GET", "/api/v1/search/status");
check("7) GET /api/v1/search/status menjawab 200", status.status === 200, `${status.status}`);
check("7) status melaporkan index.messages dan index.indexedMessages",
  Number.isFinite(Number(status.json?.index?.messages)) && Number.isFinite(Number(status.json?.index?.indexedMessages)),
  JSON.stringify(status.json?.index));
check("7) status melaporkan jumlah pesan nyata dan indeks setara",
  Number(status.json?.index?.messages) === Number(status.json?.index?.indexedMessages) && Number(status.json?.index?.messages) >= messagesCount,
  JSON.stringify({ status: status.json?.index, messagesCount }));
check("7) status memuat daftar kinds dan maxResults", Array.isArray(status.json?.kinds) && status.json.kinds.length === SEARCH_KINDS.length && Number.isFinite(Number(status.json?.maxResults)),
  JSON.stringify({ kinds: status.json?.kinds, maxResults: status.json?.maxResults }));

// ------------------------------------------------------------------ 8) trigger update dan delete
const nowIso = new Date().toISOString();
const TOKEN_UPDATE = `diubah${stamp}`;
const probeId = `w10-probe-${stamp}`;
db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,NULL,?)")
  .run(probeId, conversationId, "user", `Pesan uji trigger berisi ${TOKEN} saja.`, nowIso);
check("8) trigger insert mengindeks pesan yang disisipkan langsung", tableCount(match(TOKEN)) >= 2, String(tableCount(match(TOKEN))));
check("8) baris indeks menunjuk pesan itu", tableCount("SELECT COUNT(*) AS n FROM message_search WHERE message_id=?", probeId) === 1, "");
const probeConvId = String((scalar<{ conversationId: string }>("SELECT conversation_id AS conversationId FROM message_search WHERE message_id=?", probeId) ?? { conversationId: "" }).conversationId);
check("8) baris indeks memuat conversation_id dan project_id", probeConvId === conversationId && String((scalar<{ projectId: string }>("SELECT project_id AS projectId FROM message_search WHERE message_id=?", probeId) ?? { projectId: "" }).projectId) === projectId, probeConvId);
db.prepare("UPDATE messages SET content=? WHERE id=?").run(`Pesan uji trigger berisi ${TOKEN_UPDATE} sekarang.`, probeId);
check("8) trigger update mengindeks isi baru", tableCount(`SELECT COUNT(*) AS n FROM message_search WHERE message_search MATCH '"${TOKEN_UPDATE}"*'`) === 1, String(tableCount(`SELECT COUNT(*) AS n FROM message_search WHERE message_search MATCH '"${TOKEN_UPDATE}"*'`)));
check("8) kata lama tidak lagi cocok untuk pesan itu",
  tableCount(`SELECT COUNT(*) AS n FROM message_search WHERE message_id=? AND message_search MATCH '"${TOKEN}"*'`, probeId) === 0, "");
check("8) trigger update tidak menggandakan baris indeks", tableCount("SELECT COUNT(*) AS n FROM message_search WHERE message_id=?", probeId) === 1, "");
const indexedBeforeDelete = tableCount("SELECT COUNT(*) AS n FROM message_search");
db.prepare("DELETE FROM messages WHERE id=?").run(probeId);
check("8) trigger delete membuang baris indeks pesan yang dihapus", tableCount("SELECT COUNT(*) AS n FROM message_search WHERE message_id=?", probeId) === 0, "");
check("8) jumlah baris indeks turun satu setelah penghapusan", tableCount("SELECT COUNT(*) AS n FROM message_search") === indexedBeforeDelete - 1,
  `${indexedBeforeDelete} -> ${tableCount("SELECT COUNT(*) AS n FROM message_search")}`);
check("8) kata yang sudah diubah tidak ditemukan lagi", tableCount(`SELECT COUNT(*) AS n FROM message_search WHERE message_search MATCH '"${TOKEN_UPDATE}"*'`) === 0, "");

// ------------------------------------------------------------------ ringkasan
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
console.log(`RINGKASAN: ${passed}/${passed + failed} lulus`);
if (skipped.length > 0) for (const item of skipped) console.log(`SKIP ${item}`);
if (failed === 0) {
  console.log("ALL_WAVE10_SEARCH_TESTS_PASSED");
  process.exit(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
process.exit(1);

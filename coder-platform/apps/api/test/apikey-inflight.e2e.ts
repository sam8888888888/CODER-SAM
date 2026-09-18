/**
 * Uji Wave 10 butir 24, bagian MODUL (tanpa server HTTP): kuota token kunci API termasuk
 * pekerjaan yang masih berjalan.
 *
 * Yang dibuktikan:
 *  1) `estimateRunTokens(prompt, allowance)` naik bersama panjang prompt dan tidak pernah < 1;
 *  2) `reserveRunTokens` / `releaseRunTokens` mengubah angka `apiKeyReservedTokens` dan isi
 *     `apiKeyInFlight` dengan benar (baris runs buatan: queued, running, completed, failed);
 *  3) hanya status queued/running yang dihitung; completed/failed tidak;
 *  4) `checkApiKeyDailyQuota` menolak saat used + reserved >= limit, termasuk saat `tokensUsed`
 *     sendiri masih di bawah batas;
 *  5) `apiKeyQuotaSnapshot` mengembalikan angka yang konsisten
 *     (tokensRemaining = limit - used - reserved, dan null bila limit 0 = tak terbatas);
 *  6) pergantian hari (dayKey) mereset tokensUsed tetapi TIDAK mereset cadangan yang masih berjalan.
 *
 * Jalankan: npx tsx apps/api/test/apikey-inflight.e2e.ts
 */
const dataDir = `/tmp/coder-wave10-inflight-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();

process.env.NODE_ENV = "test";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.NOTIFY_EMAIL_ENABLED = "false";

import type { ApiKeyRow } from "../src/apikeys.js";

const { db } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const {
  apiKeyReservedTokens, apiKeyInFlight, estimateRunTokens, reserveRunTokens, releaseRunTokens,
  checkApiKeyDailyQuota, apiKeyQuotaSnapshot, apiKeyTokensToday, todayKey, refreshApiKeyDay,
  createApiKey, getApiKey, updateApiKey,
} = await import("../src/apikeys.js");

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const tableCount = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const scalar = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as any[]) as T | undefined;

const userId = `w10i-user-${stamp}`;
const workspaceId = `w10i-ws-${stamp}`;
const projectId = `w10i-project-${stamp}`;
const now = new Date();
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
const TODAY = todayKey(now);
const YESTERDAY = todayKey(new Date(now.getTime() - 24 * 3600 * 1000));

db.prepare("INSERT INTO users (id,email,display_name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(userId, `w10i-${stamp}@example.test`, "Pemilik Kunci Wave 10", iso(0), iso(0));
db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(workspaceId, "Ruang Kerja Uji Inflight", `ws-inflight-${stamp}`, iso(0), iso(0));
db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,?,?)")
  .run(userId, workspaceId, "owner", iso(0));
db.prepare("INSERT INTO projects (id,workspace_id,name,slug,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
  .run(projectId, workspaceId, "Proyek Inflight", `proyek-inflight-${stamp}`, "Proyek uji kuota berjalan.", iso(0), iso(0));
const created = createApiKey({ userId, workspaceId, name: "Kunci Uji Inflight", scopes: "read" });
const keyId = created.key.id;
const freshRow = (): ApiKeyRow => getApiKey(userId, keyId) as ApiKeyRow;
function insertRun(id: string, status: string, reserved: number | null, createdAt: string) {
  db.prepare("INSERT INTO runs (id, project_id, status, prompt, model, api_key_id, created_at, reserved_tokens) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, projectId, status, "prompt uji kuota", "wave10-inflight-model", keyId, createdAt, reserved);
}
function insertUsage(id: string, runId: string, tokens: number, createdAt: string) {
  db.prepare(`INSERT INTO run_usage (id, run_id, project_id, model, provider, input_tokens, output_tokens, total_tokens, cost_micros, estimated, created_at)
    VALUES (?,?,?,?,?,?,?,?,0,0,?)`).run(id, runId, projectId, "wave10-inflight-model", "mock", Math.max(0, tokens - 10), 10, tokens, createdAt);
}

// ------------------------------------------------------------------ 1) perkiraan token satu panggilan
const defaultAllowance = config.API_KEY_INFLIGHT_OUTPUT_TOKENS;
check("1) perkiraan minimal 1 walau prompt kosong dan allowance 0", estimateRunTokens("", 0) === 1, String(estimateRunTokens("", 0)));
check("1) perkiraan minimal 1 walau allowance negatif", estimateRunTokens("", -500) === 1, String(estimateRunTokens("", -500)));
check("1) perkiraan naik bersama panjang prompt",
  estimateRunTokens("a".repeat(400), 0) > estimateRunTokens("a".repeat(40), 0) && estimateRunTokens("a".repeat(40), 0) > estimateRunTokens("a", 0),
  JSON.stringify([estimateRunTokens("a", 0), estimateRunTokens("a".repeat(40), 0), estimateRunTokens("a".repeat(400), 0)]));
check("1) prompt 400 karakter dengan allowance 0 = 100 token (400/4)", estimateRunTokens("a".repeat(400), 0) === 100, String(estimateRunTokens("a".repeat(400), 0)));
check("1) allowance bawaan dipakai bila tidak diberikan", estimateRunTokens("abcd") === 1 + defaultAllowance, `${estimateRunTokens("abcd")} vs ${1 + defaultAllowance}`);
check("1) allowance ikut ditambahkan ke perkiraan prompt", estimateRunTokens("a".repeat(400), 1000) === 100 + 1000, String(estimateRunTokens("a".repeat(400), 1000)));
check("1) angka perkiraan selalu bilangan bulat", Number.isInteger(estimateRunTokens("a".repeat(7), 3.4)), String(estimateRunTokens("a".repeat(7), 3.4)));

// ------------------------------------------------------------------ 2) dan 3) cadangan token
const runQ = `w10i-run-q-${stamp}`; const runR = `w10i-run-r-${stamp}`;
const runC = `w10i-run-c-${stamp}`; const runF = `w10i-run-f-${stamp}`; const runN = `w10i-run-n-${stamp}`;
insertRun(runQ, "queued", 1200, iso(-60_000));
insertRun(runR, "running", 800, iso(-30_000));
insertRun(runC, "completed", 5000, iso(-90_000));
insertRun(runF, "failed", 700, iso(-90_000));
insertRun(runN, "queued", null, iso(-120_000));
const expectedReserved = 1200 + 800 + defaultAllowance; // baris tanpa reserved_tokens memakai cadangan bawaan
check("2) apiKeyReservedTokens = jumlah cadangan run queued/running", apiKeyReservedTokens(keyId) === expectedReserved,
  `${apiKeyReservedTokens(keyId)} vs ${expectedReserved}`);
check("3) cadangan run completed dan failed TIDAK dihitung",
  apiKeyReservedTokens(keyId) === 1200 + 800 + defaultAllowance && 5000 + 700 > 0, `total=${apiKeyReservedTokens(keyId)}`);
const inFlight = apiKeyInFlight(keyId);
check("2) apiKeyInFlight mengembalikan run queued/running saja", inFlight.length === 3 && inFlight.every((row) => ["queued", "running"].includes(row.status)),
  JSON.stringify(inFlight.map((row) => [row.runId, row.status, row.tokens])));
check("3) apiKeyInFlight tidak memuat run completed/failed", !inFlight.some((row) => [runC, runF].includes(row.runId)), JSON.stringify(inFlight.map((row) => row.runId)));
check("2) apiKeyInFlight urut dari yang paling lama", inFlight.map((row) => row.runId).join(",") === [runN, runQ, runR].join(","), JSON.stringify(inFlight.map((row) => row.runId)));
check("2) apiKeyInFlight melaporkan jumlah token cadangan tiap run",
  inFlight.find((row) => row.runId === runQ)?.tokens === 1200 && inFlight.find((row) => row.runId === runR)?.tokens === 800
  && inFlight.find((row) => row.runId === runN)?.tokens === defaultAllowance, JSON.stringify(inFlight.map((row) => [row.runId, row.tokens])));
check("2) apiKeyInFlight memuat createdAt", inFlight.every((row) => typeof row.createdAt === "string" && row.createdAt.length > 0), JSON.stringify(inFlight[0]));

reserveRunTokens(runQ, 1234);
check("2) reserveRunTokens menaikkan cadangan", apiKeyReservedTokens(keyId) === 1234 + 800 + defaultAllowance, String(apiKeyReservedTokens(keyId)));
check("2) reserveRunTokens menulis angka ke baris runs", Number((scalar<{ reserved: number }>("SELECT reserved_tokens AS reserved FROM runs WHERE id=?", runQ) ?? { reserved: -1 }).reserved) === 1234, "");
reserveRunTokens(runN, 0);
check("2) reserveRunTokens 0 menghentikan pemakaian cadangan bawaan", apiKeyReservedTokens(keyId) === 1234 + 800, String(apiKeyReservedTokens(keyId)));
releaseRunTokens(runQ);
check("2) releaseRunTokens mengembalikan cadangan run itu", apiKeyReservedTokens(keyId) === 800, String(apiKeyReservedTokens(keyId)));
check("2) releaseRunTokens mengosongkan kolom runs.reserved_tokens", Number((scalar<{ reserved: number }>("SELECT reserved_tokens AS reserved FROM runs WHERE id=?", runQ) ?? { reserved: -1 }).reserved) === 0, "");
check("2) run yang dilepas tetap tampil di apiKeyInFlight dengan 0 token",
  apiKeyInFlight(keyId).some((row) => row.runId === runQ && row.tokens === 0), JSON.stringify(apiKeyInFlight(keyId).map((row) => [row.runId, row.tokens])));
releaseRunTokens(runC);
check("3) releaseRunTokens pada run completed tidak mengubah hitungan cadangan", apiKeyReservedTokens(keyId) === 800, String(apiKeyReservedTokens(keyId)));
const nullRunId = `w10i-run-null-${stamp}`;
insertRun(nullRunId, "running", null, iso(-200_000));
releaseRunTokens(nullRunId);
check("2) releaseRunTokens tidak menyentuh baris yang belum punya cadangan",
  (scalar<{ reserved: number | null }>("SELECT reserved_tokens AS reserved FROM runs WHERE id=?", nullRunId) ?? { reserved: 0 }).reserved === null, JSON.stringify(scalar("SELECT reserved_tokens AS reserved FROM runs WHERE id=?", nullRunId)));
db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(nullRunId);
reserveRunTokens(runN, 999);
db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(runN);
check("3) run yang dibatalkan berhenti dihitung walau cadangannya masih tersimpan",
  apiKeyReservedTokens(keyId) === 800 && !apiKeyInFlight(keyId).some((row) => row.runId === runN),
  JSON.stringify({ reserved: apiKeyReservedTokens(keyId), inFlight: apiKeyInFlight(keyId).map((row) => row.runId) }));
// Keadaan akhir yang dipakai bagian berikutnya: cadangan = 1200 (queued) + 800 (running).
reserveRunTokens(runQ, 1200);
check("3) keadaan akhir: hanya queued dan running yang dihitung", apiKeyReservedTokens(keyId) === 2000, String(apiKeyReservedTokens(keyId)));
check("3) pekerjaan yang selesai atau dibatalkan berhenti dihitung tanpa perlu disentuh lagi",
  apiKeyInFlight(keyId).length === 2 && !apiKeyInFlight(keyId).some((row) => [nullRunId, runN, runC, runF].includes(row.runId)),
  JSON.stringify(apiKeyInFlight(keyId).map((row) => [row.runId, row.status])));

// ------------------------------------------------------------------ 4) batas harian
insertUsage(`w10i-usage-${stamp}`, runC, 900, iso(0));
check("4) token hari ini dibaca dari run_usage milik kunci (900)", apiKeyTokensToday(keyId) === 900, String(apiKeyTokensToday(keyId)));
updateApiKey(userId, keyId, { dailyTokenLimit: 2000 });
const rejectedByReserve = checkApiKeyDailyQuota(freshRow());
check("4) used + reserved >= limit ditolak 429 API_KEY_DAILY_TOKEN_LIMIT",
  rejectedByReserve?.status === 429 && rejectedByReserve?.error === "API_KEY_DAILY_TOKEN_LIMIT", JSON.stringify(rejectedByReserve));
check("4) penolakan terjadi walau tokensUsed sendiri masih di bawah batas",
  Number(rejectedByReserve?.detail?.used) === 900 && Number(rejectedByReserve?.detail?.limit) === 2000,
  JSON.stringify(rejectedByReserve?.detail));
check("4) rincian penolakan memuat used, reserved, dan total yang dijumlahkan",
  Number(rejectedByReserve?.detail?.reserved) === 2000 && Number(rejectedByReserve?.detail?.total) === 2900,
  JSON.stringify(rejectedByReserve?.detail));
check("4) pesan penolakan menjelaskan token yang masih berjalan",
  typeof rejectedByReserve?.detail?.message === "string" && String(rejectedByReserve?.detail?.message).includes("menahan"),
  String(rejectedByReserve?.detail?.message));
updateApiKey(userId, keyId, { dailyTokenLimit: 3000 });
const allowedByTokens = checkApiKeyDailyQuota(freshRow());
check("4) used + reserved < limit -> panggilan boleh berjalan (null)", allowedByTokens === null, JSON.stringify(allowedByTokens));
db.prepare("UPDATE api_keys SET requests_today=5, usage_day=? WHERE id=?").run(TODAY, keyId);
updateApiKey(userId, keyId, { dailyRequestLimit: 5 });
const rejectedByRequests = checkApiKeyDailyQuota(freshRow());
check("4) used >= limit permintaan ditolak 429 API_KEY_DAILY_REQUEST_LIMIT",
  rejectedByRequests?.status === 429 && rejectedByRequests?.error === "API_KEY_DAILY_REQUEST_LIMIT", JSON.stringify(rejectedByRequests));
check("4) rincian penolakan permintaan memuat limit dan used",
  Number(rejectedByRequests?.detail?.limit) === 5 && Number(rejectedByRequests?.detail?.used) === 5, JSON.stringify(rejectedByRequests?.detail));
updateApiKey(userId, keyId, { dailyRequestLimit: 6 });
check("4) 5 dari 6 permintaan masih boleh", checkApiKeyDailyQuota(freshRow()) === null, JSON.stringify(checkApiKeyDailyQuota(freshRow())));
updateApiKey(userId, keyId, { dailyRequestLimit: 0 });
check("4) limit permintaan 0 = tanpa batas permintaan", checkApiKeyDailyQuota(freshRow()) === null, JSON.stringify(checkApiKeyDailyQuota(freshRow())));

// ------------------------------------------------------------------ 5) potret kuota
const snapshot = apiKeyQuotaSnapshot(freshRow());
check("5) potret memuat seluruh bidang kuota",
  ["requestLimit", "requestsUsed", "tokenLimit", "tokensUsed", "tokensReserved", "tokensRemaining", "requestsRemaining"].every((field) => field in (snapshot ?? {})),
  JSON.stringify(snapshot));
check("5) tokensRemaining = limit - used - reserved", Number(snapshot.tokensRemaining) === 3000 - 900 - 2000, JSON.stringify(snapshot));
check("5) tokensUsed dan tokensReserved sesuai tabel", Number(snapshot.tokensUsed) === 900 && Number(snapshot.tokensReserved) === 2000, JSON.stringify(snapshot));
check("5) requestsRemaining null saat limit permintaan 0", snapshot.requestsRemaining === null, JSON.stringify(snapshot));
updateApiKey(userId, keyId, { dailyTokenLimit: 0 });
const unlimited = apiKeyQuotaSnapshot(freshRow());
check("5) tokenLimit 0 = tak terbatas -> tokensRemaining null", Number(unlimited.tokenLimit) === 0 && unlimited.tokensRemaining === null, JSON.stringify(unlimited));
check("5) limit 0 tetap melaporkan used dan reserved apa adanya",
  Number(unlimited.tokensUsed) === 900 && Number(unlimited.tokensReserved) === 2000, JSON.stringify(unlimited));
updateApiKey(userId, keyId, { dailyTokenLimit: 1000 });
const negative = apiKeyQuotaSnapshot(freshRow());
check("5) tokensRemaining negatif saat kuota sudah terlampaui", Number(negative.tokensRemaining) === 1000 - 900 - 2000, JSON.stringify(negative));
updateApiKey(userId, keyId, { dailyRequestLimit: 5 });
const withRequests = apiKeyQuotaSnapshot(freshRow());
check("5) requestsRemaining = limit - used saat limit diisi", Number(withRequests.requestsRemaining) === 5 - 5, JSON.stringify(withRequests));

// ------------------------------------------------------------------ 6) pergantian hari
insertUsage(`w10i-usage-y-${stamp}`, runC, 500, `${YESTERDAY}T12:00:00.000Z`);
check("6) token hari kemarin tidak dihitung sebagai pemakaian hari ini", apiKeyTokensToday(keyId) === 900, String(apiKeyTokensToday(keyId)));
check("6) dayKey hari ini = tanggal UTC", TODAY === new Date().toISOString().slice(0, 10), TODAY);
db.prepare("UPDATE api_keys SET usage_day=?, requests_today=7 WHERE id=?").run(YESTERDAY, keyId);
updateApiKey(userId, keyId, { dailyRequestLimit: 7, dailyTokenLimit: 0 });
const staleRow = freshRow();
check("6) baris lama melaporkan 7 permintaan pada hari kemarin", staleRow.usageDay === YESTERDAY && staleRow.requestsToday === 7, JSON.stringify({ usageDay: staleRow.usageDay, requestsToday: staleRow.requestsToday }));
check("6) refreshApiKeyDay mereset penghitung permintaan pada hari baru", refreshApiKeyDay(staleRow) === 0, String(refreshApiKeyDay(freshRow())));
check("6) bukti DB: requests_today direset dan usage_day menjadi hari ini",
  Number((scalar<{ n: number }>("SELECT requests_today AS n FROM api_keys WHERE id=?", keyId) ?? { n: -1 }).n) === 0
  && String((scalar<{ day: string }>("SELECT usage_day AS day FROM api_keys WHERE id=?", keyId) ?? { day: "" }).day) === TODAY, "");
check("6) kuota permintaan kembali longgar setelah hari berganti (0 dari 7)", checkApiKeyDailyQuota(freshRow()) === null, JSON.stringify(checkApiKeyDailyQuota(freshRow())));
// Hari baru: pemakaian token hari ini disapu, tetapi cadangan run yang masih berjalan tetap ada.
db.prepare("DELETE FROM run_usage WHERE substr(created_at,1,10)=?").run(TODAY);
check("6) pemakaian token hari ini menjadi 0 pada hari baru", apiKeyTokensToday(keyId) === 0, String(apiKeyTokensToday(keyId)));
reserveRunTokens(runQ, 1200); reserveRunTokens(runR, 800);
const daySnapshot = apiKeyQuotaSnapshot(freshRow());
check("6) cadangan run yang masih berjalan TIDAK direset oleh pergantian hari",
  Number(daySnapshot.tokensUsed) === 0 && Number(daySnapshot.tokensReserved) === 2000, JSON.stringify(daySnapshot));
updateApiKey(userId, keyId, { dailyTokenLimit: 2000 });
const dayRejected = checkApiKeyDailyQuota(freshRow());
check("6) kuota tetap menahan panggilan baru karena pekerjaan lama masih berjalan",
  dayRejected?.status === 429 && Number(dayRejected?.detail?.total) === 2000, JSON.stringify(dayRejected?.detail));
check("6) run yang belum selesai masih terlihat di apiKeyInFlight setelah hari berganti",
  apiKeyInFlight(keyId).length === 2, JSON.stringify(apiKeyInFlight(keyId).map((row) => [row.runId, row.status])));

// ------------------------------------------------------------------ ringkasan
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
console.log(`RINGKASAN: ${passed}/${passed + failed} lulus`);
if (skipped.length > 0) for (const item of skipped) console.log(`SKIP ${item}`);
if (failed === 0) {
  console.log("ALL_WAVE10_INFLIGHT_TESTS_PASSED");
  process.exit(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
process.exit(1);

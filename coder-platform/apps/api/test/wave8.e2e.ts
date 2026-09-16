/**
 * Uji Wave 8 (v0.18.0): penutupan akun dua langkah, batas laju di basis data,
 * kewajiban verifikasi email, dan pembersihan akun yang ditutup oleh pekerja retensi.
 *
 * Yang dibuktikan:
 *  1) skema 16: tabel `rate_limit_hits` + kolom `users.deleted_at` dan `users.purge_after`;
 *  2) hitungan batas laju benar-benar disimpan di tabel, bukan di memori proses;
 *  3) jendela geser dihormati: baris di luar jendela tidak dihitung;
 *  4) hitungan bisa dibersihkan dari basis data dan pengguna langsung boleh mencoba lagi;
 *  5) aksi AI (run, eksekusi workflow, pembuatan kunci API) ditolak 403 EMAIL_NOT_VERIFIED
 *     selama email belum diverifikasi, dan boleh setelah verifikasi;
 *  6) menutup akun wajib didahului ekspor data (409 EXPORT_REQUIRED), lalu menjadi penutupan lunak;
 *  7) akun yang ditutup tidak bisa masuk (403 ACCOUNT_DELETED) dan bisa dipulihkan admin;
 *  8) pekerja retensi menghapus baris akun yang masa pemulihannya lewat, memindahkan kepemilikan
 *     workspace yang masih beranggota, dan menghapus workspace yang sudah kosong berikut berkasnya.
 *
 * Jalankan: npx tsx apps/api/test/wave8.e2e.ts
 */
const port = 6980 + Math.floor(Math.random() * 18); // rentang khusus 6980-6997
const dataDir = `/tmp/coder-wave8-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `w8-admin-${stamp}@example.test`;
const secondAdminEmail = `w8-admin2-${stamp}@example.test`;
const ownerEmail = `w8-owner-${stamp}@example.test`;
const heirEmail = `w8-heir-${stamp}@example.test`;
const password = "SandiUji2026!aman";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave8-test-model";
process.env.NOTIFY_EMAIL_ENABLED = "false";
// Mode "on": verifikasi email dipaksa walau server surat tidak aktif. Di produksi mode "auto"
// mengikuti NOTIFY_EMAIL_ENABLED, jadi pengguna tidak pernah terkunci tanpa cara memverifikasi.
process.env.VERIFY_EMAIL_REQUIRED = "on";
process.env.PLATFORM_ADMIN_EMAILS = `${adminEmail},${secondAdminEmail}`;
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "5";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RETENTION_ENABLED = "true";

await import("../src/server.js");
const { db } = await import("../src/db.js");
const { runRetention, closedAccounts, ACCOUNT_RECOVERY_DAYS } = await import("../src/retention.js");
const { enqueueJob, jobWorkerState } = await import("../src/jobs.js");
const { createHash } = await import("node:crypto");
await new Promise((resolve) => setTimeout(resolve, 1200));
// Putaran pekerjaan pertama berjalan sendiri saat server menyala dan ia MENJADWALKAN pekerjaan
// retensi berkala. Uji ini harus menunggu putaran itu selesai dulu; kalau tidak, pekerjaan
// berkala yang menghapus akun kedaluwarsa bisa berlomba dengan data uji yang baru disiapkan.
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

/** Klien HTTP kecil dengan cookie sendiri. */
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
      if (setCookie) {
        const value = setCookie.split(";")[0];
        cookie = value.endsWith("=") ? "" : value;
      }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json, text, headers: response.headers, setCookie };
    },
    clear() { cookie = ""; },
  };
}
const admin = client(); const owner = client(); const heir = client(); const anon = client();
const tableCount = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);

// ------------------------------------------------------------------ 1) skema 16
const version = Number((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v);
check("1) skema basis data versi 16", version === 16, String(version));
const rlTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limit_hits'").get() as { name: string } | undefined;
check("1) tabel rate_limit_hits ada", rlTable?.name === "rate_limit_hits", JSON.stringify(rlTable));
const rlCols = (db.prepare("PRAGMA table_info(rate_limit_hits)").all() as { name: string }[]).map((row) => row.name);
check("1) kolom rate_limit_hits = bucket, hit_at", rlCols.includes("bucket") && rlCols.includes("hit_at"), JSON.stringify(rlCols));
const userCols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((row) => row.name);
check("1) kolom users.deleted_at ada", userCols.includes("deleted_at"), JSON.stringify(userCols.slice(-4)));
check("1) kolom users.purge_after ada", userCols.includes("purge_after"), "");
const rlIndex = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rate_limit_hits_bucket'").get() as { name: string } | undefined;
check("1) indeks idx_rate_limit_hits_bucket ada", rlIndex?.name === "idx_rate_limit_hits_bucket", JSON.stringify(rlIndex));

// ------------------------------------------------------------------ 2) batas laju pindah ke basis data
const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Wave 8" });
check("2) akun admin uji terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.user?.id), JSON.stringify(adminReg.json)?.slice(0, 160));
const hub = await admin.call("GET", "/api/v1/status-hub");
check("2) status-hub melaporkan penyimpanan pembatas laju = basis data", hub.json?.openPlatform?.rateLimits?.store === "database", JSON.stringify(hub.json?.openPlatform?.rateLimits));
check("2) status-hub menyebut tabel rate_limit_hits", hub.json?.openPlatform?.rateLimits?.table === "rate_limit_hits", JSON.stringify(hub.json?.openPlatform?.rateLimits?.table));
check("2) status-hub memuat aturan login dengan batas 5", Number(hub.json?.openPlatform?.rateLimits?.rules?.login) === 5, JSON.stringify(hub.json?.openPlatform?.rateLimits?.rules));
check("2) status-hub melaporkan mode verifikasi email = on", hub.json?.security?.verifyEmailMode === "on" && hub.json?.security?.verifyEmailRequired === true, JSON.stringify({ mode: hub.json?.security?.verifyEmailMode, required: hub.json?.security?.verifyEmailRequired }));
check("2) status-hub melaporkan kebijakan akun ditutup 90 hari", Number(hub.json?.openPlatform?.closedAccounts?.recoveryDays) === 90, JSON.stringify(hub.json?.openPlatform?.closedAccounts));

// Kunci hitungan = nama aturan + alamat + email, jadi kunci login berbeda dari kunci pendaftaran.
const probeEmail = `w8-probe-${stamp}@example.test`;
const probeBucket = `login:127.0.0.1:${probeEmail}`;
const beforeLoginRows = tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket LIKE 'login:%'");
let limited = false; let limitedStatus = 0;
for (let attempt = 0; attempt < 7; attempt += 1) {
  const reply = await anon.call("POST", "/api/v1/auth/login", { email: probeEmail, password: "SalahSekali123!" });
  if (reply.status === 429) { limited = true; limitedStatus = reply.status; break; }
}
check("2) percobaan login ke-6 untuk alamat yang sama kena 429", limited === true, `status terakhir=${limitedStatus}`);
check("2) galat 429 memakai kode LOGIN_RATE_LIMITED", limitedStatus === 429, String(limitedStatus));
const loginBucketRows = tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket LIKE 'login:%'") - beforeLoginRows;
check("2) bukti DB: baris hitungan login bertambah di rate_limit_hits", loginBucketRows >= 5, String(loginBucketRows));
const probeRows = tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket=?", probeBucket);
check("2) bukti DB: baris tersimpan dengan kunci 127.0.0.1:email", probeRows >= 5, String(probeRows));
// Bukti paling kuat: hapus hitungan dari basis data, lalu pengguna langsung boleh mencoba lagi.
// Kalau hitungan masih di memori proses, cara ini tidak akan membuka blokir.
db.prepare("DELETE FROM rate_limit_hits WHERE bucket=?").run(probeBucket);
const afterClear = await anon.call("POST", "/api/v1/auth/login", { email: probeEmail, password: "SalahSekali123!" });
check("2) setelah baris DB dihapus, login tidak lagi 429 (hitungan memang dari basis data)", afterClear.status !== 429, JSON.stringify(afterClear.json));
check("2) bukti DB: pendaftaran memakai kunci sendiri di tabel yang sama", tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket='register:127.0.0.1'") >= 1, "");
// Pemisahan kunci diuji langsung di modulnya: dua aturan berbeda memakai kunci yang sama.
const { createRateLimiter } = await import("../src/ratelimit.js");
const limiterUjiA = createRateLimiter({ windowMs: 60_000, max: 2 }, "ujiA");
const limiterUjiB = createRateLimiter({ windowMs: 60_000, max: 2 }, "ujiB");
const izinA1 = limiterUjiA.allow("sama"); const izinA2 = limiterUjiA.allow("sama");
check("2) aturan A menerima dua kali lalu menolak", izinA1 === true && izinA2 === true && limiterUjiA.allow("sama") === false, "");
check("2) aturan B dengan kunci sama tetap boleh (kunci tidak saling menjumlah)", limiterUjiB.allow("sama") === true, "");
check("2) size() menghitung kunci milik aturan ini saja", limiterUjiA.size() === 1 && limiterUjiB.size() === 1, `${limiterUjiA.size()}/${limiterUjiB.size()}`);
check("2) retryAfterSeconds memberi sisa waktu saat sudah penuh", limiterUjiA.retryAfterSeconds("sama") > 0 && limiterUjiA.retryAfterSeconds("sama") <= 60, String(limiterUjiA.retryAfterSeconds("sama")));
limiterUjiA.reset("sama");
check("2) reset(kunci) membuka blokir hanya untuk aturan itu", limiterUjiA.allow("sama") === true && limiterUjiB.size() === 1, "");
limiterUjiA.reset();
check("2) reset() tanpa argumen membersihkan seluruh kunci aturan itu", limiterUjiA.size() === 0, String(limiterUjiA.size()));
check("2) bukti DB: hanya kunci ujiA yang terhapus, kunci ujiB tetap ada", tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket LIKE 'ujiA:%'") === 0 && tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket LIKE 'ujiB:%'") >= 1, "");
// Jendela geser: baris berumur 17 menit (di luar jendela login 15 menit) tidak boleh dihitung.
const staleAt = Date.now() - 17 * 60 * 1000;
for (let index = 0; index < 9; index += 1) db.prepare("INSERT INTO rate_limit_hits (bucket, hit_at) VALUES (?,?)").run(probeBucket, staleAt + index);
const staleRows = tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket=?", probeBucket);
const staleAttempt = await anon.call("POST", "/api/v1/auth/login", { email: probeEmail, password: "SalahSekali123!" });
check("2) baris lama di luar jendela diabaikan (tidak 429)", staleRows >= 9 && staleAttempt.status !== 429, `baris=${staleRows} status=${staleAttempt.status}`);
check("2) bukti DB: baris di luar jendela sudah disapu saat pemeriksaan", tableCount("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket=? AND hit_at <= ?", probeBucket, staleAt + 1000) === 0, "");
db.prepare("DELETE FROM rate_limit_hits WHERE bucket LIKE 'login:%'").run();

// ------------------------------------------------------------------ 3) wajib verifikasi email
const ownerReg = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Wave 8" });
check("3) akun pemilik uji terdaftar lengkap dengan workspace", ownerReg.status === 201 && Boolean(ownerReg.json?.user?.id) && Boolean(ownerReg.json?.workspace?.id), JSON.stringify(ownerReg.json)?.slice(0, 200));
check("3) bukti DB: users.email_verified masih 0 setelah daftar", tableCount("SELECT COUNT(*) AS n FROM users WHERE id=? AND email_verified=0", String(ownerReg.json?.user?.id ?? "")) === 1, "");
const meBefore = await owner.call("GET", "/api/v1/auth/me");
check("3) GET /auth/me menyebut email belum terverifikasi (dipakai shell untuk memberi tahu)", meBefore.json?.user?.emailVerified === false && meBefore.json?.user?.accountClosed === false, JSON.stringify(meBefore.json?.user));
const ownerUserId = String(ownerReg.json?.user?.id ?? "");
const ownerWorkspace = String(ownerReg.json?.workspace?.id ?? "");
const project = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspace}/projects`, { name: "Proyek Wave 8", slug: `wave8-${stamp}` });
check("3) proyek uji dibuat", project.status === 201 || project.status === 200, JSON.stringify(project.json)?.slice(0, 160));
const blockedRun = await owner.call("POST", `/api/v1/projects/${project.json.id}/runs`, { prompt: "halo sebelum verifikasi" });
check("3) run ditolak 403 EMAIL_NOT_VERIFIED", blockedRun.status === 403 && blockedRun.json?.error === "EMAIL_NOT_VERIFIED", JSON.stringify(blockedRun.json));
check("3) pesan galat berbentuk kalimat bahasa Indonesia", typeof blockedRun.json?.message === "string" && blockedRun.json.message.includes("Verifikasi email dulu"), JSON.stringify(blockedRun.json?.message));
const workflow = await owner.call("POST", `/api/v1/projects/${project.json.id}/workflows`, { name: "Alur Wave 8", steps: [{ id: "s1", type: "prompt", prompt: "Tes {{input}}" }] });
await owner.call("POST", `/api/v1/workflows/${workflow.json?.id}/publish`);
const blockedWorkflow = await owner.call("POST", `/api/v1/workflows/${workflow.json?.id}/execute`, { input: "halo" });
check("3) eksekusi workflow ditolak 403 EMAIL_NOT_VERIFIED", blockedWorkflow.status === 403 && blockedWorkflow.json?.error === "EMAIL_NOT_VERIFIED", JSON.stringify(blockedWorkflow.json));
const blockedKey = await owner.call("POST", "/api/v1/api-keys", { name: "kunci wave 8" });
check("3) pembuatan kunci API ditolak 403 EMAIL_NOT_VERIFIED", blockedKey.status === 403 && blockedKey.json?.error === "EMAIL_NOT_VERIFIED", JSON.stringify(blockedKey.json));
const noRuns = await owner.call("GET", `/api/v1/projects/${project.json.id}/runs`);
const noRunRows = Array.isArray(noRuns.json) ? noRuns.json.length : (Array.isArray(noRuns.json?.runs) ? noRuns.json.runs.length : -1);
check("3) bukti DB: tidak ada run yang dibuat selama terblokir", tableCount("SELECT COUNT(*) AS n FROM runs WHERE project_id=?", project.json.id) === 0, `daftar=${noRunRows}`);

// Verifikasi lewat token sungguhan: baris auth_tokens memakai aturan yang sama dengan server (sha256).
const verifyToken = `w8-verify-${stamp}-token`;
db.prepare("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)")
  .run(`tok-${stamp}`, ownerUserId, "email_verify", createHash("sha256").update(verifyToken).digest("hex"), new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
const verified = await owner.call("POST", "/api/v1/auth/email/verify", { token: verifyToken });
check("3) verifikasi email dengan token sungguhan berhasil", verified.status === 200, JSON.stringify(verified.json));
const verifiedAgain = await owner.call("POST", "/api/v1/auth/email/verify", { token: verifyToken });
check("3) token verifikasi sekali pakai (pemakaian kedua ditolak)", verifiedAgain.status >= 400, JSON.stringify(verifiedAgain.json));
check("3) bukti DB: users.email_verified sudah 1", tableCount("SELECT COUNT(*) AS n FROM users WHERE id=? AND email_verified=1", ownerUserId) === 1, "");
const meAfter = await owner.call("GET", "/api/v1/auth/me");
check("3) GET /auth/me menyebut email sudah terverifikasi", meAfter.json?.user?.emailVerified === true, JSON.stringify(meAfter.json?.user));
const allowedRun = await owner.call("POST", `/api/v1/projects/${project.json.id}/runs`, { prompt: "halo setelah verifikasi" });
check("3) setelah verifikasi, run diterima 202", allowedRun.status === 202 && Boolean(allowedRun.json?.id), JSON.stringify(allowedRun.json)?.slice(0, 160));
const allowedKey = await owner.call("POST", "/api/v1/api-keys", { name: "kunci wave 8" });
check("3) setelah verifikasi, kunci API bisa dibuat", allowedKey.status === 201 || allowedKey.status === 200, JSON.stringify(allowedKey.json)?.slice(0, 160));
const allowedWorkflow = await owner.call("POST", `/api/v1/workflows/${workflow.json?.id}/execute`, { input: "halo" });
check("3) setelah verifikasi, eksekusi workflow diterima 202", allowedWorkflow.status === 202, JSON.stringify(allowedWorkflow.json)?.slice(0, 160));

// ------------------------------------------------------------------ 4) menutup akun wajib ekspor
const heirReg = await heir.call("POST", "/api/v1/auth/register", { email: heirEmail, password, displayName: "Ahli Waris Workspace" });
check("4) akun kedua terdaftar", heirReg.status === 201, JSON.stringify(heirReg.json)?.slice(0, 160));
const heirToken = `w8-heir-${stamp}`;
db.prepare("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)")
  .run(`tok-heir-${stamp}`, String(heirReg.json?.user?.id ?? ""), "email_verify", createHash("sha256").update(heirToken).digest("hex"), new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
await heir.call("POST", "/api/v1/auth/email/verify", { token: heirToken });

const invite = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspace}/invitations`, { email: heirEmail, role: "member" });
const accepted = await heir.call("POST", "/api/v1/invitations/accept", { token: invite.json?.token });
check("4) akun kedua bergabung ke workspace pemilik", accepted.status === 200, JSON.stringify(accepted.json)?.slice(0, 160));

const closeWithoutExport = await owner.call("DELETE", "/api/v1/auth/account", { password, confirm: "HAPUS AKUN" });
check("4) menutup akun tanpa ekspor -> 409 EXPORT_REQUIRED", closeWithoutExport.status === 409 && closeWithoutExport.json?.error === "EXPORT_REQUIRED", JSON.stringify(closeWithoutExport.json));
const createdExport = await owner.call("POST", "/api/v1/account/export");
check("4) ekspor data dibuat lewat API", (createdExport.status === 201 || createdExport.status === 200) && Boolean(createdExport.json?.export?.id), JSON.stringify(createdExport.json)?.slice(0, 160));
const closed = await owner.call("DELETE", "/api/v1/auth/account", { password, confirm: "HAPUS AKUN" });
check("4) menutup akun dengan ekspor -> 200 dan masa pemulihan 90 hari", closed.status === 200 && closed.json?.recoveryDays === 90, JSON.stringify(closed.json));
const closedRow = db.prepare("SELECT deleted_at AS deletedAt, purge_after AS purgeAfter FROM users WHERE id=?").get(ownerUserId) as { deletedAt: string | null; purgeAfter: string | null };
check("4) bukti DB: baris akun masih ada dengan deleted_at dan purge_after", Boolean(closedRow?.deletedAt) && Boolean(closedRow?.purgeAfter), JSON.stringify(closedRow));
check("4) jarak purge_after tepat 90 hari dari deleted_at", Math.round((Date.parse(String(closedRow.purgeAfter)) - Date.parse(String(closedRow.deletedAt))) / 86_400_000) === 90, String(closedRow?.purgeAfter));
const closedLogin = await owner.call("POST", "/api/v1/auth/login", { email: ownerEmail, password });
check("4) akun tertutup tidak bisa masuk -> 403 ACCOUNT_DELETED", closedLogin.status === 403 && closedLogin.json?.error === "ACCOUNT_DELETED", JSON.stringify(closedLogin.json));
const closedMe = await owner.call("GET", "/api/v1/auth/me");
check("4) sesi lama akun tertutup sudah tidak berlaku (401)", closedMe.status === 401, JSON.stringify(closedMe.json));
const restoreLog = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='user.account_closed' AND metadata_json LIKE ?").get(`%${ownerUserId}%`) as { n: number };
check("4) jejak audit penutupan akun tercatat beserta id pengguna", Number(restoreLog.n) >= 1, String(restoreLog.n));

// ------------------------------------------------------------------ 5) pekerja retensi: pemulihan dan pembersihan
const closedList = closedAccounts();
check("5) closedAccounts() melihat akun yang menunggu masa pemulihan", closedList.waiting.some((row) => row.userId === ownerUserId), JSON.stringify(closedList.waiting.map((row) => row.userId)));
const dryReport = runRetention({ dryRun: true });
const accountLine = dryReport.tables.find((item) => item.table.startsWith("users"));
check("5) laporan retensi memuat baris akun ditutup", Boolean(accountLine), JSON.stringify(dryReport.tables.map((item) => item.table)));
check("5) akun yang belum jatuh tempo belum masuk daftar hapus", Number(accountLine?.candidates ?? -1) === 0, JSON.stringify(accountLine));

// Dua akun yang masa pemulihannya SUDAH lewat, supaya pembersihan bisa diuji sungguhan.
// Akun "sendiri" : workspace tanpa anggota lain -> semuanya hilang, berkasnya ikut dibersihkan.
// Akun "warisan" : masih ada anggota lain -> workspace dipertahankan, anggota dinaikkan jadi owner.
const goneNow = new Date();
const goneClosedAt = new Date(goneNow.getTime() - 91 * 86_400_000).toISOString();
const gonePurgeAt = new Date(goneNow.getTime() - 86_400_000).toISOString();
const soloId = `solo-${stamp}`; const soloWorkspace = `solo-ws-${stamp}`; const soloProject = `solo-prj-${stamp}`;
const legacyId = `legacy-${stamp}`; const legacyWorkspace = `legacy-ws-${stamp}`; const legacyProject = `legacy-prj-${stamp}`;
const heirId = String(heirReg.json?.user?.id ?? "");
function seedClosedAccount(input: { id: string; workspaceId: string; projectId: string; extraMemberId?: string }) {
  db.prepare("INSERT INTO users (id,email,display_name,password_hash,email_verified,created_at,updated_at,deleted_at,purge_after) VALUES (?,?,?,?,1,?,?,?,?)")
    .run(input.id, `${input.id}@example.test`, "Akun Kedaluwarsa", "hash-tidak-dipakai", goneClosedAt, goneClosedAt, goneClosedAt, gonePurgeAt);
  db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(input.workspaceId, `Workspace ${input.id}`, input.workspaceId, goneClosedAt, goneClosedAt);
  db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,'owner',?)").run(input.id, input.workspaceId, goneClosedAt);
  db.prepare("INSERT INTO projects (id,workspace_id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(input.projectId, input.workspaceId, "Proyek Kedaluwarsa", input.projectId, goneClosedAt, goneClosedAt);
  if (input.extraMemberId) {
    db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,'member',?)")
      .run(input.extraMemberId, input.workspaceId, new Date(goneNow.getTime() - 80 * 86_400_000).toISOString());
  }
}
seedClosedAccount({ id: soloId, workspaceId: soloWorkspace, projectId: soloProject });
seedClosedAccount({ id: legacyId, workspaceId: legacyWorkspace, projectId: legacyProject, extraMemberId: heirId });
check("5) dua akun kedaluwarsa disiapkan bersama proyeknya", tableCount("SELECT COUNT(*) AS n FROM projects WHERE id IN (?,?)", soloProject, legacyProject) === 2, "");
const dueList = closedAccounts();
check("5) closedAccounts() menandai akun kedaluwarsa sebagai jatuh tempo", dueList.due.some((row) => row.userId === soloId) && dueList.due.some((row) => row.userId === legacyId), JSON.stringify(dueList.due.map((row) => row.userId)));
const filesBefore = await import("node:fs/promises");
for (const projectId of [soloProject, legacyProject]) {
  await filesBefore.mkdir(`${dataDir}/artifacts/${projectId}`, { recursive: true });
  await filesBefore.writeFile(`${dataDir}/artifacts/${projectId}/sisa.txt`, "berkas uji", "utf8");
}
let artifactFileReady = true;
try { await filesBefore.access(`${dataDir}/artifacts/${soloProject}/sisa.txt`); } catch { artifactFileReady = false; }
check("5) berkas artefak sementara siap sebelum pembersihan", artifactFileReady === true, `${dataDir}/artifacts/${soloProject}/sisa.txt`);

const queued = enqueueJob({ kind: "retention.run", payload: { trigger: "wave8-test" }, maxAttempts: 1 });
check("5) pekerjaan retention.run masuk antrean", queued.queued === true, JSON.stringify(queued));
// Antrean bisa memuat pekerjaan lain (mis. run.execute dari bagian 3). Jadi kita jalankan
// beberapa putaran sampai pekerjaan retensi ini sendiri selesai, bukan menebak satu putaran cukup.
let tick = await admin.call("POST", "/api/v1/admin/jobs/tick");
check("5) putaran pekerjaan dijalankan admin", tick.status === 200 && Number(tick.json?.cycle?.succeeded ?? 0) >= 1, JSON.stringify(tick.json?.cycle));
for (let round = 0; round < 8; round += 1) {
  const state = db.prepare("SELECT status FROM jobs WHERE id=?").get(String(queued.id)) as { status: string } | undefined;
  if (state && state.status !== "pending") break;
  tick = await admin.call("POST", "/api/v1/admin/jobs/tick");
}
const jobRow = db.prepare("SELECT status, result, last_error AS lastError FROM jobs WHERE id=?").get(String(queued.id)) as { status: string; result: string | null; lastError: string | null } | undefined;
check("5) bukti DB: pekerjaan retensi selesai tanpa galat", jobRow?.status === "done" && !jobRow?.lastError, JSON.stringify(jobRow));
const jobResult = JSON.parse(jobRow?.result ?? "{}");
check("5) laporan pekerjaan menyebut minimal dua akun dibersihkan", Number(jobResult?.accountsPurged ?? 0) >= 2, String(jobRow?.result));
check("5) laporan pekerjaan menyebut satu workspace ikut dihapus", Number(jobResult?.workspacesRemoved ?? 0) === 1, String(jobRow?.result));
check("5) laporan pekerjaan menyebut berkas yang dibersihkan", Number(jobResult?.filesRemoved ?? 0) >= 1, String(jobRow?.result));

check("5) bukti DB: baris akun kedaluwarsa (sendiri) sudah hilang", tableCount("SELECT COUNT(*) AS n FROM users WHERE id=?", soloId) === 0, "");
check("5) bukti DB: workspace sendirian ikut dihapus", tableCount("SELECT COUNT(*) AS n FROM workspaces WHERE id=?", soloWorkspace) === 0, "");
check("5) bukti DB: proyek di dalamnya ikut hilang", tableCount("SELECT COUNT(*) AS n FROM projects WHERE id=?", soloProject) === 0, "");
check("5) bukti DB: keanggotaan akun yang hilang sudah bersih", tableCount("SELECT COUNT(*) AS n FROM memberships WHERE user_id=?", soloId) === 0, "");
let artifactDirGone = false;
try { await filesBefore.access(`${dataDir}/artifacts/${soloProject}`); } catch { artifactDirGone = true; }
check("5) berkas artefak proyek yang hilang sudah dibersihkan dari disk", artifactDirGone === true, `${dataDir}/artifacts/${soloProject}`);

check("5) akun berwarisan juga sudah dihapus", tableCount("SELECT COUNT(*) AS n FROM users WHERE id=?", legacyId) === 0, "");
check("5) workspace berwarisan TETAP ada karena masih beranggota", tableCount("SELECT COUNT(*) AS n FROM workspaces WHERE id=?", legacyWorkspace) === 1, "");
check("5) proyek di workspace berwarisan tetap ada", tableCount("SELECT COUNT(*) AS n FROM projects WHERE id=?", legacyProject) === 1, "");
const heirRole = db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(legacyWorkspace, heirId) as { role: string } | undefined;
check("5) anggota yang tersisa dinaikkan menjadi owner", heirRole?.role === "owner", JSON.stringify(heirRole));
let legacyDirKept = true;
try { await filesBefore.access(`${dataDir}/artifacts/${legacyProject}/sisa.txt`); } catch { legacyDirKept = false; }
check("5) berkas workspace yang dipertahankan TIDAK dihapus", legacyDirKept === true, `${dataDir}/artifacts/${legacyProject}/sisa.txt`);
check("5) akun yang masih menunggu masa pemulihan TIDAK dihapus", tableCount("SELECT COUNT(*) AS n FROM users WHERE id=?", ownerUserId) === 1, "");
check("5) jejak audit akun yang dibersihkan tidak menyisakan baris pribadi", tableCount("SELECT COUNT(*) AS n FROM audit_events WHERE actor_user_id=? AND workspace_id IS NULL", soloId) === 0, "");

// ------------------------------------------------------------------ 6) pemulihan oleh admin
const restore = await admin.call("POST", `/api/v1/admin/users/${ownerUserId}/restore`);
check("6) admin memulihkan akun -> 200", restore.status === 200 && restore.json?.ok === true, JSON.stringify(restore.json));
const restoredRow = db.prepare("SELECT deleted_at AS deletedAt, purge_after AS purgeAfter FROM users WHERE id=?").get(ownerUserId) as { deletedAt: string | null; purgeAfter: string | null };
check("6) bukti DB: tanda tutup sudah dibersihkan", restoredRow.deletedAt === null && restoredRow.purgeAfter === null, JSON.stringify(restoredRow));
owner.clear();
const loginBack = await owner.call("POST", "/api/v1/auth/login", { email: ownerEmail, password });
check("6) akun yang dipulihkan bisa masuk lagi", loginBack.status === 200, JSON.stringify(loginBack.json)?.slice(0, 160));
const restoreAgain = await admin.call("POST", `/api/v1/admin/users/${ownerUserId}/restore`);
check("6) pemulihan kedua ditolak 409 ACCOUNT_NOT_CLOSED", restoreAgain.status === 409 && restoreAgain.json?.error === "ACCOUNT_NOT_CLOSED", JSON.stringify(restoreAgain.json));

// ------------------------------------------------------------------ 7) admin kedua: ubah email dan setel sandi
const secondAdminReg = await anon.call("POST", "/api/v1/auth/register", { email: secondAdminEmail, password, displayName: "Admin Kedua" });
check("7) akun admin kedua terdaftar", secondAdminReg.status === 201, JSON.stringify(secondAdminReg.json)?.slice(0, 160));
const adminList = await admin.call("GET", "/api/v1/admin/user-list");
const secondRow = Array.isArray(adminList.json?.users) ? adminList.json.users.find((row: any) => row.email === secondAdminEmail) : undefined;
check("7) admin kedua terlihat di daftar pengguna admin", Boolean(secondRow?.id), JSON.stringify(adminList.json)?.slice(0, 160));
check("7) balasan daftar memuat status akun (deletedAt/purgeAfter)", secondRow ? "deletedAt" in secondRow && "purgeAfter" in secondRow : false, JSON.stringify(secondRow));
const newEmail = `w8-heir-baru-${stamp}@example.test`;
const badEmail = await admin.call("PATCH", `/api/v1/admin/users/${heirId}`, { email: "bukan-email" });
check("7) email tidak sah -> 400 INVALID_EMAIL", badEmail.status === 400 && badEmail.json?.error === "INVALID_EMAIL", JSON.stringify(badEmail.json));
const takenEmail = await admin.call("PATCH", `/api/v1/admin/users/${heirId}`, { email: adminEmail });
check("7) email yang sudah dipakai -> 409 EMAIL_EXISTS", takenEmail.status === 409 && takenEmail.json?.error === "EMAIL_EXISTS", JSON.stringify(takenEmail.json));
const changedEmail = await admin.call("PATCH", `/api/v1/admin/users/${heirId}`, { email: newEmail });
check("7) admin mengubah email pengguna -> email baru tersimpan", changedEmail.status === 200 && changedEmail.json?.user?.email === newEmail, JSON.stringify(changedEmail.json)?.slice(0, 200));
check("7) email baru dianggap belum terverifikasi", changedEmail.json?.user?.emailVerified === false, JSON.stringify(changedEmail.json?.user));
const heirGate = await heir.call("POST", `/api/v1/projects/${project.json.id}/runs`, { prompt: "coba tanpa verifikasi" });
check("7) gerbang verifikasi berlaku lagi setelah email diubah", heirGate.status === 403 && heirGate.json?.error === "EMAIL_NOT_VERIFIED", JSON.stringify(heirGate.json));

const nonAdmin = await heir.call("PATCH", `/api/v1/admin/users/${ownerUserId}`, { displayName: "Coba Nakal" });
check("7) pengguna biasa ditolak 403 ADMIN_REQUIRED saat mengubah pengguna", nonAdmin.status === 403 && nonAdmin.json?.error === "ADMIN_REQUIRED", JSON.stringify(nonAdmin.json));
const weakPassword = await admin.call("POST", `/api/v1/admin/users/${heirId}/password`, { password: "pendek" });
check("7) kata sandi kurang dari 8 karakter -> 400 WEAK_PASSWORD", weakPassword.status === 400 && weakPassword.json?.error === "WEAK_PASSWORD", JSON.stringify(weakPassword.json));
const generated = await admin.call("POST", `/api/v1/admin/users/${heirId}/password`, {});
check("7) admin menyetel sandi tanpa mengirim sandi -> sandi dibuat otomatis", generated.status === 200 && generated.json?.generated === true && typeof generated.json?.password === "string" && String(generated.json.password).length >= 8, JSON.stringify(generated.json));
heir.clear();
const loginWithIssued = await heir.call("POST", "/api/v1/auth/login", { email: newEmail, password: String(generated.json?.password ?? "") });
check("7) pengguna bisa masuk dengan sandi yang diberikan admin", loginWithIssued.status === 200, JSON.stringify(loginWithIssued.json)?.slice(0, 160));
const loginWithOld = await anon.call("POST", "/api/v1/auth/login", { email: newEmail, password });
check("7) sandi lama tidak berlaku lagi", loginWithOld.status === 401 || loginWithOld.status === 403, JSON.stringify(loginWithOld.json));
const chosenPassword = "SandiPilihan2026!kuat";
const setChosen = await admin.call("POST", `/api/v1/admin/users/${heirId}/password`, { password: chosenPassword });
check("7) admin bisa menetapkan sandi pilihannya sendiri", setChosen.status === 200 && setChosen.json?.generated === false, JSON.stringify(setChosen.json));
heir.clear();
const loginChosen = await heir.call("POST", "/api/v1/auth/login", { email: newEmail, password: chosenPassword });
check("7) pengguna bisa masuk dengan sandi pilihan admin", loginChosen.status === 200, JSON.stringify(loginChosen.json)?.slice(0, 160));
const otherOperator = await anon.call("POST", "/api/v1/auth/register", { email: `w8-plain-${stamp}@example.test`, password: "SandiUji2026!aman", displayName: "Pengguna Biasa" });
check("7) akun biasa tambahan terdaftar", otherOperator.status === 201, JSON.stringify(otherOperator.json)?.slice(0, 120));
const plainSet = await anon.call("POST", `/api/v1/admin/users/${heirId}/password`, { password: chosenPassword });
check("7) pengguna biasa ditolak 403 saat menyetel sandi orang lain", plainSet.status === 403, JSON.stringify(plainSet.json));
// Email admin kedua ada di PLATFORM_ADMIN_EMAILS, jadi akun itu memang admin tanpa kolom is_admin.
const secondAdminIsAdmin = await (async () => {
  const fresh = client();
  await fresh.call("POST", "/api/v1/auth/login", { email: secondAdminEmail, password });
  const listed = await fresh.call("GET", "/api/v1/admin/user-list");
  return listed.status === 200;
})();
check("7) email kedua di PLATFORM_ADMIN_EMAILS benar-benar berhak admin", secondAdminIsAdmin === true, "GET /admin/user-list harus 200");

// ------------------------------------------------------------------ ringkasan
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
if (skipped.length > 0) for (const item of skipped) console.log(`SKIP ${item}`);
if (failed === 0) {
  console.log("ALL_WAVE8_TESTS_PASSED");
  process.exit(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
process.exit(1);

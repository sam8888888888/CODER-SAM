/**
 * Uji Wave 10 butir 25 + 32C: pelengkapan (backfill) data pertumbuhan dari tabel ASLI.
 *
 * Yang dibuktikan:
 *  1) skema 18: kolom `growth_events.source` ada dengan default 'live';
 *  2) `planGrowthBackfill()` menghitung calon dari tabel nyata (users, users.email_verified,
 *     projects, conversations, runs, referrals, dan seterusnya), bukan dari angka karangan;
 *  3) mode kering TIDAK menulis apa pun (GET maupun POST tanpa `apply`);
 *  4) `POST { apply: true }` menulis hanya baris yang belum ada, `source='backfill'`,
 *     `id` = bf-<sha256 32 hex>, dan `created_at` memakai waktu ASLI baris sumbernya;
 *  5) idempoten: panggilan kedua `inserted === 0` dan jumlah baris tidak bertambah;
 *  6) baris `live` tidak digandakan;
 *  7) `growthEventSources()` mengelompokkan live dan backfill dengan events/first/last;
 *  8) rute backfill hanya untuk admin platform (403 ADMIN_REQUIRED);
 *  9) satu baris backfill dicocokkan dengan baris tabel aslinya (props.entityId), jadi terbukti
 *     tidak memakai angka simulasi.
 *
 * Jalankan: npx tsx apps/api/test/growth-backfill.e2e.ts
 */
const port = 7190 + Math.floor(Math.random() * 10); // rentang khusus suite ini: 7190-7199
const dataDir = `/tmp/coder-wave10-backfill-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `w10bf-admin-${stamp}@example.test`;
const memberEmail = `w10bf-member-${stamp}@example.test`;
const password = "SandiUji2026!aman";
/** Waktu asli baris lama: jauh sebelum suite ini berjalan, jadi mudah dibedakan dari "sekarang". */
const OLD_ISO = "2024-03-04T05:06:07.000Z";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.ENGINE_ROOT_DIR = `${dataDir}/engine-sessions`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave10-backfill-model";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.VERIFY_EMAIL_REQUIRED = "off";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RETENTION_ENABLED = "false";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { jobWorkerState } = await import("../src/jobs.js");
const { planGrowthBackfill, backfillGrowthEvents, growthEventSources, GROWTH_EVENTS } = await import("../src/growth.js");
const { createHash } = await import("node:crypto");

await new Promise((resolve) => setTimeout(resolve, 1200));
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
const admin = client(); const member = client();
const tableCount = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const scalar = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as any[]) as T | undefined;
const backfillId = (event: string, entityId: string) => `bf-${createHash("sha256").update(`${event}:${entityId}`).digest("hex").slice(0, 32)}`;
const planRow = (plan: any, event: string) => (plan?.rows ?? []).find((row: any) => row?.event === event);

// ------------------------------------------------------------------ 1) skema 18: kolom source
const version = Number((scalar<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations") ?? { v: 0 }).v);
check(`1) skema basis data versi ${SCHEMA_VERSION}`, version === SCHEMA_VERSION, String(version));
const columns = db.prepare("PRAGMA table_info(growth_events)").all() as { name: string; dflt_value: string | null; notnull: number }[];
const sourceColumn = columns.find((column) => column.name === "source");
check("1) kolom growth_events.source ada", Boolean(sourceColumn), JSON.stringify(columns.map((column) => column.name)));
check("1) default kolom source = 'live' dan NOT NULL", String(sourceColumn?.dflt_value ?? "") === "'live'" && Number(sourceColumn?.notnull ?? 0) === 1,
  JSON.stringify({ dflt: sourceColumn?.dflt_value, notnull: sourceColumn?.notnull }));

// ------------------------------------------------------------------ 2) data nyata + rencana dari tabel asli
const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Backfill Wave 10" });
check("2) akun admin uji terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.workspace?.id), JSON.stringify(adminReg.json)?.slice(0, 160));
const adminUserId = String(adminReg.json?.user?.id ?? "");
const adminWorkspaceId = String(adminReg.json?.workspace?.id ?? "");
const codeReply = await admin.call("GET", "/api/v1/referrals");
check("2) kode undangan admin tersedia", codeReply.status === 200 && typeof codeReply.json?.code === "string", JSON.stringify(codeReply.json)?.slice(0, 160));
const refCode = String(codeReply.json?.code ?? "");
const memberReg = await member.call("POST", "/api/v1/auth/register", { email: memberEmail, password, displayName: "Anggota Backfill Wave 10", ref: refCode });
check("2) akun anggota mendaftar memakai kode undangan", memberReg.status === 201 && memberReg.json?.referral?.accepted === true, JSON.stringify(memberReg.json)?.slice(0, 200));
const memberUserId = String(memberReg.json?.user?.id ?? "");
check("2) baris referrals nyata terbentuk", tableCount("SELECT COUNT(*) AS n FROM referrals WHERE inviter_user_id=? AND invitee_user_id=?", adminUserId, memberUserId) === 1, "");
// Verifikasi email admin lewat token sungguhan -> menulis baris `live` (jalur normal Wave 7).
const verifyToken = `w10bf-verify-${stamp}`;
db.prepare("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)")
  .run(`tok-${stamp}`, adminUserId, "email_verify", createHash("sha256").update(verifyToken).digest("hex"), new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
const verified = await admin.call("POST", "/api/v1/auth/email/verify", { token: verifyToken });
check("2) verifikasi email admin berhasil (baris live email_verified)", verified.status === 200 && tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='email_verified' AND user_id=?", adminUserId) === 1,
  `${verified.status} ${JSON.stringify(verified.json)?.slice(0, 160)}`);
// Data lama: email anggota sudah terverifikasi tetapi TIDAK ada baris peristiwanya (keadaan sebelum Wave 7).
db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(memberUserId);
check("2) anggota terverifikasi tanpa baris peristiwa", tableCount("SELECT COUNT(*) FROM users WHERE id=? AND email_verified=1".replace("COUNT(*)", "COUNT(*) AS n"), memberUserId) === 1
  && tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='email_verified' AND user_id=?", memberUserId) === 0, "");
const project = await admin.call("POST", `/api/v1/workspaces/${adminWorkspaceId}/projects`, { name: "Proyek Backfill Wave 10", slug: `backfill-${stamp}` });
check("2) proyek nyata dibuat lewat rute", project.status === 201 && Boolean(project.json?.id), JSON.stringify(project.json)?.slice(0, 160));
const projectId = String(project.json?.id ?? "");
const conversation = await admin.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Percakapan backfill" });
const conversationId = String(conversation.json?.conversation?.id ?? "");
check("2) percakapan nyata dibuat lewat rute", conversation.status === 201 && Boolean(conversationId), JSON.stringify(conversation.json)?.slice(0, 160));
const sent = await admin.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Pesan uji untuk run mock backfill pertumbuhan." });
check("2) pesan dan run diterima rute (202)", sent.status === 202 && Boolean(sent.json?.run?.id), JSON.stringify(sent.json)?.slice(0, 160));
let runRow: { id: string; status: string } | undefined;
for (let attempt = 0; attempt < 80; attempt += 1) {
  runRow = scalar<{ id: string; status: string }>("SELECT id, status FROM runs WHERE project_id=? ORDER BY created_at DESC LIMIT 1", projectId);
  if (runRow?.status === "completed") break;
  await sleep(250);
}
check("2) run mock selesai (status completed)", runRow?.status === "completed", String(runRow?.status));
check("2) baris live run_completed tercatat", tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='run_completed' AND json_extract(props,'$.runId')=?", String(runRow?.id ?? "")) === 1, "");
// Baris lama tanpa peristiwa: proyek dari arsip dengan waktu asli 2024 (tidak pernah dicatat Wave 7).
const oldProjectId = `w10bf-old-${stamp}`;
db.prepare("INSERT INTO projects (id,workspace_id,name,slug,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
  .run(oldProjectId, adminWorkspaceId, "Proyek Arsip 2024", `arsip-${stamp}`, "Proyek lama tanpa baris peristiwa.", OLD_ISO, OLD_ISO);
check("2) proyek arsip lama disisipkan tanpa baris peristiwa",
  tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='project_created' AND json_extract(props,'$.projectId')=?", oldProjectId) === 0, "");

const plan = planGrowthBackfill();
check("2) planGrowthBackfill mengembalikan daftar baris rencana", Array.isArray(plan?.rows) && plan.rows.length > 0, JSON.stringify(plan?.rows?.length));
check("2) planGrowthBackfill menghitung calon (totalCandidates > 0)", Number(plan?.totalCandidates ?? 0) > 0, String(plan?.totalCandidates));
check("2) totalCandidates = jumlah candidates semua baris",
  Number(plan?.totalCandidates ?? -1) === plan.rows.reduce((sum: number, row: any) => sum + Number(row.candidates ?? 0), 0), String(plan?.totalCandidates));
// Hitungan yang berdiri sendiri, langsung dari tabel asli.
const realCounts: Record<string, number> = {
  signup: tableCount("SELECT COUNT(*) AS n FROM users"),
  email_verified: tableCount("SELECT COUNT(*) AS n FROM users WHERE email_verified=1"),
  project_created: tableCount("SELECT COUNT(*) AS n FROM projects"),
  conversation_created: tableCount("SELECT COUNT(*) AS n FROM conversations"),
  run_started: tableCount("SELECT COUNT(*) AS n FROM runs"),
  run_completed: tableCount("SELECT COUNT(*) AS n FROM runs WHERE status='completed'"),
  run_failed: tableCount("SELECT COUNT(*) AS n FROM runs WHERE status='failed'"),
  api_key_created: tableCount("SELECT COUNT(*) AS n FROM api_keys"),
  webhook_created: tableCount("SELECT COUNT(*) AS n FROM webhooks"),
  order_created: tableCount("SELECT COUNT(*) AS n FROM orders"),
  order_paid: tableCount("SELECT COUNT(*) AS n FROM orders WHERE status='paid'"),
  referral_joined: tableCount("SELECT COUNT(*) AS n FROM referrals"),
  referral_rewarded: tableCount("SELECT COUNT(*) AS n FROM referrals WHERE status='rewarded'"),
};
const mismatched = Object.entries(realCounts).filter(([event, count]) => Number(planRow(plan, event)?.candidates ?? -1) !== count);
check("2) calon tiap peristiwa sama dengan jumlah baris tabel aslinya", mismatched.length === 0,
  JSON.stringify(mismatched.map(([event, count]) => ({ event, tabel: count, plan: planRow(plan, event)?.candidates }))));
check("2) tiap baris rencana punya source, candidates, alreadyRecorded, toInsert dan toInsert = candidates - alreadyRecorded",
  plan.rows.every((row: any) => typeof row.source === "string" && row.source.length > 0 && Number.isFinite(Number(row.candidates))
    && Number.isFinite(Number(row.alreadyRecorded)) && Number(row.toInsert) === Number(row.candidates) - Number(row.alreadyRecorded)),
  JSON.stringify(plan.rows.slice(0, 3)));
check("2) peristiwa yang tidak tersimpan tidak dibuat (disertakan di daftar excluded)",
  Array.isArray(plan.excluded) && plan.excluded.length >= 3 && plan.excluded.every((row: any) => typeof row.reason === "string" && row.reason.length > 0),
  JSON.stringify(plan.excluded));
check("2) proyek arsip 2024 memang jadi calon yang belum tercatat", Number(planRow(plan, "project_created")?.toInsert ?? 0) >= 1 && Number(planRow(plan, "project_created")?.alreadyRecorded ?? 0) >= 1,
  JSON.stringify(planRow(plan, "project_created")));
check("2) email anggota jadi calon yang belum tercatat", Number(planRow(plan, "email_verified")?.toInsert ?? 0) >= 1, JSON.stringify(planRow(plan, "email_verified")));
// Dulu bercabang ke `skip`; sekarang SOURCES di apps/api/src/growth.ts memang memuat artifact/workflow,
// jadi pemeriksaan ini WAJIB lulus supaya hilangnya sumber itu ketahuan.
check("2) rencana memuat sumber artefak atau workflow",
  plan.rows.some((row: any) => String(row.source).includes("artifact") || String(row.source).includes("workflow")),
  JSON.stringify(plan.rows.map((row: any) => `${row.event}:${row.source}`)).slice(0, 240));

const beforeDry = tableCount("SELECT COUNT(*) AS n FROM growth_events");
const liveBefore = tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE COALESCE(source,'live')='live'");
const backfillBefore = tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE source='backfill'");

// ------------------------------------------------------------------ 3) mode kering tidak menulis
const dryGet = await admin.call("GET", "/api/v1/admin/growth/backfill");
check("3) GET /api/v1/admin/growth/backfill menjawab 200 dengan plan, sources, recorded",
  dryGet.status === 200 && Array.isArray(dryGet.json?.plan?.rows) && Array.isArray(dryGet.json?.sources) && Boolean(dryGet.json?.recorded), `${dryGet.status} ${dryGet.text?.slice(0, 160)}`);
check("3) GET tidak menulis baris growth_events", tableCount("SELECT COUNT(*) AS n FROM growth_events") === beforeDry, `${beforeDry} -> ${tableCount("SELECT COUNT(*) AS n FROM growth_events")}`);
check("3) GET melaporkan rencana yang sama dengan modul",
  Number(dryGet.json?.plan?.totalCandidates) === Number(plan.totalCandidates) && Number(planRow(dryGet.json?.plan, "project_created")?.toInsert) === Number(planRow(plan, "project_created")?.toInsert),
  JSON.stringify({ rute: dryGet.json?.plan?.totalCandidates, modul: plan.totalCandidates }));
const dryPost = await admin.call("POST", "/api/v1/admin/growth/backfill", {});
check("3) POST tanpa apply = mode kering (dryRun true, inserted 0)", dryPost.status === 200 && dryPost.json?.report?.dryRun === true && Number(dryPost.json?.report?.inserted) === 0,
  JSON.stringify(dryPost.json?.report)?.slice(0, 200));
check("3) POST tanpa apply tidak menulis baris growth_events", tableCount("SELECT COUNT(*) AS n FROM growth_events") === beforeDry, `${beforeDry} -> ${tableCount("SELECT COUNT(*) AS n FROM growth_events")}`);
check("3) POST tanpa apply tidak membuat baris source='backfill'", tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE source='backfill'") === backfillBefore, String(backfillBefore));

// ------------------------------------------------------------------ 4) menerapkan backfill
const plannedInsert = planGrowthBackfill().rows.reduce((sum, row) => sum + Number(row.toInsert ?? 0), 0);
check("4) ada baris yang memang perlu ditulis", plannedInsert >= 2, String(plannedInsert));
const applied = await admin.call("POST", "/api/v1/admin/growth/backfill", { apply: true });
check("4) POST apply menjawab 200 dengan report", applied.status === 200 && Boolean(applied.json?.report), `${applied.status} ${applied.text?.slice(0, 160)}`);
check("4) report.dryRun = false dan inserted sama dengan rencana", applied.json?.report?.dryRun === false && Number(applied.json?.report?.inserted) === plannedInsert,
  JSON.stringify({ inserted: applied.json?.report?.inserted, plannedInsert }));
const totalAfter = tableCount("SELECT COUNT(*) AS n FROM growth_events");
check("4) jumlah baris growth_events naik tepat sejumlah inserted", totalAfter === beforeDry + plannedInsert, `${beforeDry} -> ${totalAfter}`);
const oldRow = scalar<{ id: string; name: string; userId: string | null; workspaceId: string | null; props: string; createdAt: string; source: string }>(
  "SELECT id, name, user_id AS userId, workspace_id AS workspaceId, props, created_at AS createdAt, source FROM growth_events WHERE id=?", backfillId("project_created", oldProjectId));
check("4) baris proyek arsip ditulis dengan id bf-<sha256 32 hex>", Boolean(oldRow) && /^bf-[0-9a-f]{32}$/.test(String(oldRow?.id)), JSON.stringify(oldRow?.id));
check("4) baris itu memakai source='backfill'", oldRow?.source === "backfill", String(oldRow?.source));
check("4) baris itu memakai waktu ASLI proyek arsip, bukan waktu sekarang", oldRow?.createdAt === OLD_ISO, `${oldRow?.createdAt} vs ${OLD_ISO}`);
check("4) props baris backfill menunjuk entitas nyata", (() => { try { const props = JSON.parse(String(oldRow?.props ?? "{}")); return props.entityId === oldProjectId && props.backfill === true; } catch { return false; } })(), String(oldRow?.props));
const memberRow = scalar<{ id: string; createdAt: string; source: string }>("SELECT id, created_at AS createdAt, source FROM growth_events WHERE id=?", backfillId("email_verified", memberUserId));
check("4) baris email anggota ditulis dengan id bf-<sha256 32 hex>", Boolean(memberRow) && /^bf-[0-9a-f]{32}$/.test(String(memberRow?.id)), JSON.stringify(memberRow?.id));
check("4) baris itu memakai source='backfill' dan waktu asli users.created_at",
  memberRow?.source === "backfill" && memberRow?.createdAt === String((scalar<{ createdAt: string }>("SELECT created_at AS createdAt FROM users WHERE id=?", memberUserId) ?? { createdAt: "" }).createdAt),
  JSON.stringify(memberRow));
check("4) baris yang sudah tercatat saat kejadian TIDAK digandakan (project nyata tetap 1 baris)",
  tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='project_created' AND json_extract(props,'$.projectId')=?", projectId) === 1, "");
check("4) signup tiap akun tetap satu baris", tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='signup' AND user_id=?", adminUserId) === 1
  && tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='signup' AND user_id=?", memberUserId) === 1, "");
const planAfterApply = planGrowthBackfill();
check("4) baris yang sudah dilengkapi tidak dihitung lagi pada sumber berbasis user_id (email_verified)",
  Number(planRow(planAfterApply, "email_verified")?.toInsert ?? -1) === 0, JSON.stringify(planRow(planAfterApply, "email_verified")));
// Baris hasil pelengkapan menyimpan id-nya di props.entityId, sedangkan baris live memakai
// props.<propsKey>. Rencana WAJIB mengenali keduanya, kalau tidak pratinjau terus menjanjikan baris
// yang sama sementara apply menolak menulisnya (laporan rencana jadi tidak jujur).
const leftover = planAfterApply.rows.filter((row) => Number(row.toInsert ?? 0) > 0);
check("4) rencana setelah apply tidak menyisakan calon yang belum tercatat", leftover.length === 0, JSON.stringify(leftover));
check("4) baris project_created hasil pelengkapan ikut dihitung sebagai sudah tercatat",
  Number(planRow(planAfterApply, "project_created")?.toInsert ?? -1) === 0 && Number(planRow(planAfterApply, "project_created")?.alreadyRecorded ?? -1) === 2,
  JSON.stringify(planRow(planAfterApply, "project_created")));
check("4) sumber berbasis propsKey yang tidak pernah di-backfill tetap melaporkan toInsert 0",
  Number(planRow(planAfterApply, "run_completed")?.toInsert ?? -1) === 0 && Number(planRow(planAfterApply, "conversation_created")?.toInsert ?? -1) === 0,
  JSON.stringify([planRow(planAfterApply, "run_completed"), planRow(planAfterApply, "conversation_created")]));
check("4) kolom source dipakai konsisten: total = live + backfill",
  tableCount("SELECT COUNT(*) AS n FROM growth_events") === tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE COALESCE(source,'live')='live'") + tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE source='backfill'"), "");

// ------------------------------------------------------------------ 5) idempoten
const countBeforeSecond = tableCount("SELECT COUNT(*) AS n FROM growth_events");
const second = await admin.call("POST", "/api/v1/admin/growth/backfill", { apply: true });
check("5) panggilan apply kedua menjawab 200", second.status === 200, String(second.status));
check("5) panggilan apply kedua: inserted === 0", Number(second.json?.report?.inserted) === 0, String(second.json?.report?.inserted));
check("5) jumlah baris tetap sama setelah panggilan kedua", tableCount("SELECT COUNT(*) AS n FROM growth_events") === countBeforeSecond, `${countBeforeSecond} -> ${tableCount("SELECT COUNT(*) AS n FROM growth_events")}`);
check("5) tidak ada baris backfill ganda", tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE id=?", backfillId("project_created", oldProjectId)) === 1, "");
check("5) rencana sesudah apply kedua kosong, sama seperti hasil apply-nya (inser 0)",
  Number(second.json?.report?.inserted) === 0 && Number(planRow(planGrowthBackfill(), "project_created")?.toInsert) === 0,
  JSON.stringify(planRow(planGrowthBackfill(), "project_created")));

// ------------------------------------------------------------------ 6) baris live tidak digandakan
check("6) jumlah baris live tidak bertambah setelah dua kali apply", tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE COALESCE(source,'live')='live'") === liveBefore,
  `${liveBefore} -> ${tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE COALESCE(source,'live')='live'")}`);
check("6) tidak ada id ganda di growth_events", tableCount("SELECT COUNT(*) AS n FROM (SELECT id FROM growth_events GROUP BY id HAVING COUNT(*) > 1)") === 0, "");
check("6) baris live run_completed tetap satu untuk run nyata",
  tableCount("SELECT COUNT(*) AS n FROM growth_events WHERE name='run_completed' AND json_extract(props,'$.runId')=?", String(runRow?.id ?? "")) === 1, "");

// ------------------------------------------------------------------ 7) pengelompokan sumber
const sources = growthEventSources();
check("7) growthEventSources mengembalikan daftar sumber", Array.isArray(sources) && sources.length >= 1, JSON.stringify(sources));
check("7) tiap sumber memuat source, events, first, last",
  sources.every((row) => typeof row.source === "string" && Number.isFinite(Number(row.events)) && typeof row.first === "string" && typeof row.last === "string"),
  JSON.stringify(sources));
const liveGroup = sources.find((row) => row.source === "live");
const backfillGroup = sources.find((row) => row.source === "backfill");
check("7) kelompok live dan backfill keduanya ada", Boolean(liveGroup) && Boolean(backfillGroup), JSON.stringify(sources));
check("7) jumlah pada kelompok backfill = jumlah baris backfill yang ditulis", Number(backfillGroup?.events ?? 0) === plannedInsert,
  JSON.stringify({ grup: backfillGroup?.events, plannedInsert }));
check("7) jumlah pada kelompok live = baris live di tabel", Number(liveGroup?.events ?? 0) === liveBefore, JSON.stringify({ grup: liveGroup?.events, liveBefore }));
check("7) first <= last pada tiap kelompok", sources.every((row) => String(row.first) <= String(row.last)), JSON.stringify(sources));
const hub = await admin.call("GET", "/api/v1/status-hub");
check("7) status-hub memuat growthSources", Array.isArray(hub.json?.openPlatform?.growthSources), JSON.stringify(hub.json?.openPlatform?.growthSources));

// ------------------------------------------------------------------ 8) hanya admin
const memberGet = await member.call("GET", "/api/v1/admin/growth/backfill");
check("8) pengguna biasa ditolak 403 ADMIN_REQUIRED pada GET", memberGet.status === 403 && memberGet.json?.error === "ADMIN_REQUIRED", `${memberGet.status} ${JSON.stringify(memberGet.json)?.slice(0, 140)}`);
const countBeforeMember = tableCount("SELECT COUNT(*) AS n FROM growth_events");
const memberPost = await member.call("POST", "/api/v1/admin/growth/backfill", { apply: true });
check("8) pengguna biasa ditolak 403 ADMIN_REQUIRED pada POST", memberPost.status === 403 && memberPost.json?.error === "ADMIN_REQUIRED", `${memberPost.status} ${JSON.stringify(memberPost.json)?.slice(0, 140)}`);
check("8) percobaan pengguna biasa tidak menulis apa pun", tableCount("SELECT COUNT(*) AS n FROM growth_events") === countBeforeMember, `${countBeforeMember} -> ${tableCount("SELECT COUNT(*) AS n FROM growth_events")}`);

// ------------------------------------------------------------------ 9) angka nyata, bukan simulasi
const realOldProject = scalar<{ createdAt: string; name: string; workspaceId: string }>("SELECT created_at AS createdAt, name, workspace_id AS workspaceId FROM projects WHERE id=?", oldProjectId);
check("9) baris backfill proyek cocok dengan baris projects nyata (waktu dan entitas)",
  oldRow?.createdAt === realOldProject?.createdAt && JSON.parse(String(oldRow?.props ?? "{}")).entityId === oldProjectId, JSON.stringify({ backfill: oldRow?.createdAt, tabel: realOldProject?.createdAt }));
check("9) baris backfill memakai userId pemilik workspace nyata",
  oldRow?.userId === String((scalar<{ userId: string }>("SELECT user_id AS userId FROM memberships WHERE workspace_id=? AND role='owner' ORDER BY created_at ASC LIMIT 1", adminWorkspaceId) ?? { userId: "" }).userId)
  && oldRow?.workspaceId === adminWorkspaceId, JSON.stringify({ baris: oldRow?.userId, workspace: oldRow?.workspaceId }));
check("9) waktu baris backfill berbeda dari waktu pembuatan report (bukan waktu sekarang)",
  oldRow?.createdAt !== applied.json?.report?.generatedAt && oldRow?.createdAt === OLD_ISO, JSON.stringify({ baris: oldRow?.createdAt, generatedAt: applied.json?.report?.generatedAt }));
const tableOf: Record<string, string> = {
  signup: "users", email_verified: "users", project_created: "projects", conversation_created: "conversations",
  run_started: "runs", run_completed: "runs", run_failed: "runs", api_key_created: "api_keys",
  webhook_created: "webhooks", order_created: "orders", order_paid: "orders", referral_joined: "referrals", referral_rewarded: "referrals",
};
const backfillRows = db.prepare("SELECT id, name, props FROM growth_events WHERE source='backfill'").all() as { id: string; name: string; props: string }[];
check("9) semua baris backfill punya nama peristiwa yang dikenal", backfillRows.every((row) => (GROWTH_EVENTS as readonly string[]).includes(row.name)), JSON.stringify(backfillRows.map((row) => row.name)));
const notInRealTable = backfillRows.filter((row) => {
  try {
    const entityId = String(JSON.parse(row.props).entityId ?? "");
    return entityId === "" || tableCount(`SELECT COUNT(*) AS n FROM ${tableOf[row.name]} WHERE id=?`, entityId) !== 1;
  } catch { return true; }
});
check("9) tiap baris backfill menunjuk baris nyata di tabel aslinya", notInRealTable.length === 0, JSON.stringify(notInRealTable.map((row) => row.id)));

// ------------------------------------------------------------------ ringkasan
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
console.log(`RINGKASAN: ${passed}/${passed + failed} lulus`);
if (skipped.length > 0) for (const item of skipped) console.log(`SKIP ${item}`);
if (failed === 0) {
  console.log("ALL_WAVE10_BACKFILL_TESTS_PASSED");
  process.exit(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
process.exit(1);

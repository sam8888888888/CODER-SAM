/**
 * Uji Wave 7 (v0.17.0): pertumbuhan — program undangan, angka pertumbuhan, langkah awal, peringatan kuota,
 * dan permukaan publik (robots, sitemap, dokumentasi API).
 *
 * Yang dibuktikan:
 *  1) skema 15: tabel `referral_codes`, `referrals`, `growth_events`, `onboarding_state`, kolom `users.signup_ip`;
 *  2) kode undangan dibuat otomatis, 8 karakter, tanpa huruf/angka yang mudah tertukar;
 *  3) pendaftaran dengan kode: kode salah/sendiri/email sama/IP sama ditolak dengan alasan yang terbaca;
 *  4) hadiah keluar SETELAH run pertama orang yang diundang selesai — dibuktikan lewat alur nyata (mock engine);
 *  5) batas hadiah per pengundang dihormati (CEILING);
 *  6) peristiwa pertumbuhan benar-benar tercatat saat tindakan terjadi;
 *  7) corong pertumbuhan dibaca dari tabel asli (users, projects, runs, orders) dan berlaku surut;
 *  8) langkah awal (onboarding) dan penyembunyiannya disimpan di basis data;
 *  9) peringatan kuota memakai angka sungguhan dan berubah tingkat saat kuota hampir penuh;
 * 10) halaman admin pertumbuhan menolak pengguna biasa (403 ADMIN_REQUIRED);
 * 11) permukaan publik: robots.txt, sitemap.xml, dan dokumentasi API tanpa sesi.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave7.e2e.ts
 */

import { createHash } from "node:crypto";

const port = 6900 + Math.floor(Math.random() * 90); // rentang khusus 6900-6990
const dataDir = `/tmp/coder-wave7-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `w7-admin-${stamp}@example.test`;
const ownerEmail = `w7-owner-${stamp}@example.test`;
const guestEmail = `w7-guest-${stamp}@example.test`;
const sameIpEmail = `w7-sameip-${stamp}@example.test`;
const inviteeEmail = `w7-invitee-${stamp}@example.test`;
const thirdEmail = `w7-third-${stamp}@example.test`;
const password = "SandiUji2026!aman";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave7-test-model";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
process.env.RATE_LIMIT_REFERRAL_PER_HOUR = "3"; // cukup kecil supaya batasnya benar-benar teruji
process.env.REFERRAL_MAX_REWARDED_PER_USER = "1"; // supaya batas hadiah (CEILING) teruji
process.env.NOTIFY_EMAIL_ENABLED = "false";
// Wave 10 (butir 26): syarat hadiah dipertegas di sini supaya uji ini menguji perilaku bawaan
// produksi (bawaan kode juga true), bukan perilaku yang dilonggarkan hanya untuk uji.
process.env.REFERRAL_REQUIRE_VERIFIED_EMAIL = "true";
process.env.RETENTION_ENABLED = "false";
process.env.WEBHOOK_ALLOW_LOCAL = "true";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.GROWTH_WINDOW_DAYS = "30";

await import("../src/server.js");
const dbMod: any = await import("../src/db.js");
const refMod: any = await import("../src/referrals.js");
const growthMod: any = await import("../src/growth.js");
const db = dbMod.db;

const base = `http://127.0.0.1:${port}`;

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
function client() {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) { const value = setCookie.split(";")[0]; cookie = value.endsWith("=") ? "" : value; }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, json, text };
    },
    get cookie(): string { return cookie; },
  };
}

/* ------------------------------- 1) bentuk skema 15 ------------------------------- */

const schemaRow = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as any;
check("skema basis data minimal 15", Number(schemaRow?.version) >= 15, short(schemaRow));
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => String(row.name));
for (const table of ["referral_codes", "referrals", "growth_events", "onboarding_state"]) {
  check(`tabel ${table} terpasang`, tables.includes(table), short(tables.filter((name) => name.startsWith("referral") || name.startsWith("growth") || name.startsWith("onboarding"))));
}
const userColumns = (db.prepare("PRAGMA table_info(users)").all() as any[]).map((row) => String(row.name));
check("kolom users.signup_ip ada (dipakai anti-penyalahgunaan undangan)", userColumns.includes("signup_ip"), short(userColumns));
const referralColumns = (db.prepare("PRAGMA table_info(referrals)").all() as any[]).map((row) => String(row.name));
const expectedReferralColumns = ["id", "code", "inviter_user_id", "invitee_user_id", "invitee_email", "invitee_ip", "inviter_ip", "status", "blocked_reason", "inviter_tokens", "invitee_tokens", "created_at", "qualified_at", "rewarded_at"];
check("bentuk tabel referrals lengkap", expectedReferralColumns.every((column) => referralColumns.includes(column)), short(referralColumns));
const eventColumns = (db.prepare("PRAGMA table_info(growth_events)").all() as any[]).map((row) => String(row.name));
check("bentuk tabel growth_events lengkap", ["id", "name", "user_id", "workspace_id", "props", "created_at"].every((column) => eventColumns.includes(column)), short(eventColumns));

/* ------------------------------- 2) akun uji ------------------------------- */

const admin = client(); const owner = client(); const guest = client();
const anon = client(); const sameIp = client(); const invitee = client(); const third = client();
// Klien pendaftaran terpisah: POST /auth/register memasang sesi baru dan akan menimpa cookie klien anonim.
const probeA = client(); const probeB = client();

const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Wave 7" });
check("akun admin platform terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.user?.id), short(adminReg.json));
const ownerReg = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Undangan" });
check("akun pemilik undangan terdaftar", ownerReg.status === 201 && Boolean(ownerReg.json?.user?.id), short(ownerReg.json));
const guestReg = await guest.call("POST", "/api/v1/auth/register", { email: guestEmail, password, displayName: "Tamu Biasa" });
check("akun tamu terdaftar", guestReg.status === 201 && Boolean(guestReg.json?.user?.id), short(guestReg.json));
const ownerId = String(ownerReg.json?.user?.id ?? "");
const guestId = String(guestReg.json?.user?.id ?? "");
const adminId = String(adminReg.json?.user?.id ?? "");

const ownerIp = String((db.prepare("SELECT signup_ip AS ip FROM users WHERE id=?").get(ownerId) as any)?.ip ?? "");
check("IP pendaftaran dicatat untuk pemilik undangan", ownerIp.length > 0, ownerIp || "kosong");

/* ------------------------------- 3) kode undangan ------------------------------- */

const me = await owner.call("GET", "/api/v1/referrals/me");
const code = String(me.json?.code ?? "");
check("kode undangan dibuat otomatis saat panel pertama dibuka", me.status === 200 && code.length === 8, short(me.json));
check("kode undangan memakai huruf/angka yang tidak mudah tertukar",
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code), code);
check("tautan undangan memuat kode", String(me.json?.link ?? "").includes(`?ref=${code}`), short(me.json?.link));
check("panel undangan menyertakan batas dan angka hadiah",
  Number(me.json?.limits?.inviterTokens) > 0 && Number(me.json?.limits?.inviteeTokens) > 0 && Number(me.json?.limits?.maxRewardedPerUser) === 1,
  short(me.json?.limits));
check("pemilik belum mengundang siapa pun pada awalnya",
  Number(me.json?.counters?.invited) === 0 && Number(me.json?.counters?.rewarded) === 0 && Number(me.json?.tokensEarned) === 0,
  short(me.json?.counters));
const listedReferrals = await owner.call("GET", "/api/v1/referrals?limit=5");
check("daftar undangan sesi mengembalikan kode, batas, dan baris",
  listedReferrals.status === 200 && listedReferrals.json?.code === code && Array.isArray(listedReferrals.json?.referrals) && Number(listedReferrals.json?.limits?.inviteeTokens) > 0,
  short(listedReferrals.json));

/* ------------------------------- 4) penolakan kode ------------------------------- */

const noCode = await probeA.call("POST", "/api/v1/auth/register", { email: `w7-nocode-${stamp}@example.test`, password, displayName: "Tanpa Kode" });
check("pendaftaran tanpa kode tetap berhasil dan tidak mencatat undangan",
  noCode.status === 201 && noCode.json?.referral?.accepted === false
  && Number((db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE invitee_user_id=?").get(String(noCode.json?.user?.id ?? "")) as any)?.n) === 0,
  short(noCode.json?.referral));

const wrongCode = await probeB.call("POST", "/api/v1/auth/register", { email: `w7-wrong-${stamp}@example.test`, password, displayName: "Kode Salah", ref: "ZZZZZZZZ" });
check("kode tak dikenal ditolak dengan alasan yang terbaca",
  wrongCode.status === 201 && wrongCode.json?.referral?.accepted === false && wrongCode.json?.referral?.error === "REFERRAL_CODE_NOT_FOUND",
  short(wrongCode.json?.referral));

const selfAttach = refMod.attachReferral({ inviteeUserId: ownerId, inviteeEmail: ownerEmail, inviteeIp: "10.1.1.1", code });
check("mengundang diri sendiri ditolak (REFERRAL_SELF)", selfAttach?.ok === false && selfAttach?.error === "REFERRAL_SELF", short(selfAttach));

const sameEmailAttach = refMod.attachReferral({ inviteeUserId: guestId, inviteeEmail: ownerEmail, inviteeIp: "10.2.2.2", code });
check("email yang sama dengan pengundang ditandai diblokir (SAME_EMAIL)",
  sameEmailAttach?.ok === true && String((db.prepare("SELECT status, blocked_reason AS reason FROM referrals WHERE invitee_user_id=?").get(guestId) as any)?.reason) === "SAME_EMAIL",
  short(db.prepare("SELECT status, blocked_reason AS reason FROM referrals WHERE invitee_user_id=?").get(guestId)));
const repeatedAttach = refMod.attachReferral({ inviteeUserId: guestId, inviteeEmail: guestEmail, inviteeIp: "10.2.2.2", code });
check("undangan ganda untuk satu akun ditolak (REFERRAL_ALREADY_RECORDED)",
  repeatedAttach?.ok === false && repeatedAttach?.error === "REFERRAL_ALREADY_RECORDED", short(repeatedAttach));

const sameIpReg = await sameIp.call("POST", "/api/v1/auth/register", { email: sameIpEmail, password, displayName: "IP Sama", ref: code });
const sameIpRow = db.prepare("SELECT status, blocked_reason AS reason FROM referrals WHERE invitee_user_id=?").get(String(sameIpReg.json?.user?.id ?? "")) as any;
check("pendaftaran dari IP yang sama ditandai diblokir (SAME_IP)",
  sameIpReg.status === 201 && sameIpReg.json?.referral?.accepted === true && sameIpRow?.status === "blocked" && sameIpRow?.reason === "SAME_IP",
  short(sameIpRow));
check("undangan yang diblokir tidak dihitung sebagai hadiah",
  Number((db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE inviter_user_id=? AND status='rewarded'").get(ownerId) as any)?.n) === 0,
  short(db.prepare("SELECT status, COUNT(*) AS n FROM referrals WHERE inviter_user_id=? GROUP BY status").all(ownerId)));

// Pengundang dipindahkan ke jaringan lain supaya alur normal (pendaftaran dari IP berbeda) bisa diuji.
db.prepare("UPDATE users SET signup_ip='203.0.113.7' WHERE id=?").run(ownerId);
const inviteeReg = await invitee.call("POST", "/api/v1/auth/register", { email: inviteeEmail, password, displayName: "Yang Diundang", ref: code });
const inviteeId = String(inviteeReg.json?.user?.id ?? "");
const inviteeRow = db.prepare("SELECT status, inviter_user_id AS inviter FROM referrals WHERE invitee_user_id=?").get(inviteeId) as any;
check("pendaftaran dengan kode yang sah dicatat sebagai menunggu (pending)",
  inviteeReg.status === 201 && inviteeReg.json?.referral?.accepted === true && inviteeRow?.status === "pending" && inviteeRow?.inviter === ownerId,
  short(inviteeRow));
check("peristiwa pendaftaran dan undangan tercatat di growth_events",
  Number((db.prepare("SELECT COUNT(*) AS n FROM growth_events WHERE name='signup' AND user_id=?").get(inviteeId) as any)?.n) >= 1
  && Number((db.prepare("SELECT COUNT(*) AS n FROM growth_events WHERE name='referral_joined' AND user_id=?").get(inviteeId) as any)?.n) >= 1,
  short(db.prepare("SELECT name, COUNT(*) AS n FROM growth_events GROUP BY name").all()));
const inviteePending = await owner.call("GET", "/api/v1/referrals/me");
check("undangan yang menunggu terlihat di panel pengundang",
  inviteePending.json?.recent?.some((row: any) => row.inviteeUserId === inviteeId && row.status === "pending") === true,
  short(inviteePending.json?.recent?.slice(0, 3)));
check("hadiah belum dibayar sebelum run pertama selesai",
  Number(inviteePending.json?.counters?.rewarded) === 0 && Number((db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id=?").get(ownerId) as any)?.n) === 0 && Number(inviteePending.json?.tokensEarned) === 0,
  short(inviteePending.json?.counters));

// Wave 10 (butir 26): hadiah hanya dibayar ke akun yang benar-benar memverifikasi emailnya, supaya
// alamat sekali pakai tidak bisa memanen program undangan. Token dibuat seperti uji Wave 8 (baris
// auth_tokens dengan aturan sha256 yang sama), jadi alurnya tetap alur sungguhan, bukan pintasan.
const inviteeVerifyToken = `w7-verify-${stamp}-token`;
db.prepare("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)")
  .run(`tok-invitee-${stamp}`, inviteeId, "email_verify", createHash("sha256").update(inviteeVerifyToken).digest("hex"), new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
const inviteeVerified = await invitee.call("POST", "/api/v1/auth/email/verify", { token: inviteeVerifyToken });
check("email orang yang diundang terverifikasi (syarat hadiah sejak Wave 10)",
  inviteeVerified.status === 200
  && Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE id=? AND email_verified=1").get(inviteeId) as any)?.n) === 1,
  short(inviteeVerified.json));
const stillPending = db.prepare("SELECT status FROM referrals WHERE invitee_user_id=?").get(inviteeId) as any;
check("verifikasi email saja belum membayar hadiah (menunggu run pertama)",
  stillPending?.status === "pending", short(stillPending));

/* ------------------------------- 5) hadiah setelah run pertama ------------------------------- */

const inviteeWorkspaces = await invitee.call("GET", "/api/v1/workspaces");
const inviteeWorkspaceId = String(inviteeWorkspaces.json?.[0]?.id ?? "");
const inviteeProject = await invitee.call("POST", `/api/v1/workspaces/${inviteeWorkspaceId}/projects`, { name: "Proyek Undangan" });
const inviteeProjectId = String(inviteeProject.json?.project?.id ?? inviteeProject.json?.id ?? "");
check("orang yang diundang bisa membuat proyek pertamanya", inviteeProject.status === 201 && inviteeProjectId.length > 0, short(inviteeProject.json));
const inviteeRun = await invitee.call("POST", `/api/v1/projects/${inviteeProjectId}/runs`, { prompt: "Kerjakan satu tugas singkat." });
const inviteeRunId = String(inviteeRun.json?.id ?? "");
check("run pertama orang yang diundang dimulai (202)", inviteeRun.status === 202 && inviteeRunId.length > 0, short(inviteeRun.json));
let inviteeRunStatus = "";
for (let attempt = 0; attempt < 80; attempt += 1) {
  inviteeRunStatus = String((db.prepare("SELECT status FROM runs WHERE id=?").get(inviteeRunId) as any)?.status ?? "");
  if (inviteeRunStatus === "completed" || inviteeRunStatus === "failed") break;
  await sleep(250);
}
check("run pertama selesai oleh mesin", inviteeRunStatus === "completed", inviteeRunStatus || "kosong");
const rewardedRow = db.prepare("SELECT id AS referralId, status, inviter_tokens AS inviterTokens, invitee_tokens AS inviteeTokens, qualified_at AS qualifiedAt, rewarded_at AS rewardedAt FROM referrals WHERE invitee_user_id=?").get(inviteeId) as any;
check("hadiah cair otomatis setelah run pertama selesai",
  rewardedRow?.status === "rewarded" && Number(rewardedRow?.inviterTokens) === 500000 && Number(rewardedRow?.inviteeTokens) === 250000 && Boolean(rewardedRow?.qualifiedAt) && Boolean(rewardedRow?.rewardedAt),
  short(rewardedRow));
const inviterCredit = db.prepare("SELECT tokens, reason FROM credit_ledger WHERE user_id=? AND reason='referral_inviter'").get(ownerId) as any;
const inviteeCredit = db.prepare("SELECT tokens, reason, ref FROM credit_ledger WHERE user_id=? AND reason='referral_invitee'").get(inviteeId) as any;
check("kredit pengundang tercatat di buku besar", Number(inviterCredit?.tokens) === 500000, short(inviterCredit));
check("kredit orang yang diundang tercatat di buku besar", Number(inviteeCredit?.tokens) === 250000 && String(inviteeCredit?.ref) === String(rewardedRow?.referralId ?? inviteeCredit?.ref), short(inviteeCredit));
check("pemakaian kode undangan bertambah",
  Number((db.prepare("SELECT uses FROM referral_codes WHERE code=?").get(code) as any)?.uses ?? 0) >= 1,
  short(db.prepare("SELECT code, uses FROM referral_codes").all()));
check("pengundang menerima notifikasi hadiah",
  Number((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND kind='growth'").get(ownerId) as any)?.n) >= 1,
  short(db.prepare("SELECT kind, title FROM notifications WHERE user_id=?").all(ownerId)));
check("peristiwa hadiah dan run tercatat di growth_events",
  Number((db.prepare("SELECT COUNT(*) AS n FROM growth_events WHERE name='referral_rewarded'").get() as any)?.n) >= 1
  && Number((db.prepare("SELECT COUNT(*) AS n FROM growth_events WHERE name='run_started' AND user_id=?").get(inviteeId) as any)?.n) >= 1
  && Number((db.prepare("SELECT COUNT(*) AS n FROM growth_events WHERE name='run_completed' AND user_id=?").get(inviteeId) as any)?.n) >= 1,
  short(db.prepare("SELECT name, COUNT(*) AS n FROM growth_events GROUP BY name").all()));
const ownerAfterReward = await owner.call("GET", "/api/v1/referrals/me");
check("panel pengundang melaporkan hadiah dan token yang diterima",
  Number(ownerAfterReward.json?.counters?.rewarded) === 1 && Number(ownerAfterReward.json?.tokensEarned) === 500000 && Number(ownerAfterReward.json?.counters?.invited) >= 3,
  short(ownerAfterReward.json?.counters));

/* ------------------------------- 6) batas hadiah per pengundang ------------------------------- */

const thirdReg = await third.call("POST", "/api/v1/auth/register", { email: thirdEmail, password, displayName: "Undangan Ketiga", ref: code });
const thirdId = String(thirdReg.json?.user?.id ?? "");
const thirdAttached = db.prepare("SELECT status FROM referrals WHERE invitee_user_id=?").get(thirdId) as any;
check("undangan ketiga tercatat menunggu sebelum batasnya diuji", thirdReg.json?.referral?.accepted === true && thirdAttached?.status === "pending", short(thirdAttached));
// Syarat verifikasi email (Wave 10) diperiksa lebih dulu daripada batas hadiah, jadi undangan ketiga
// diverifikasi seperti pengguna sungguhan supaya yang teruji di sini benar-benar batas CEILING.
const thirdVerifyToken = `w7-verify3-${stamp}-token`;
db.prepare("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)")
  .run(`tok-third-${stamp}`, thirdId, "email_verify", createHash("sha256").update(thirdVerifyToken).digest("hex"), new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
const thirdVerified = await third.call("POST", "/api/v1/auth/email/verify", { token: thirdVerifyToken });
check("email undangan ketiga terverifikasi sebelum batas diuji", thirdVerified.status === 200, short(thirdVerified.json));
const ceiling = refMod.qualifyReferralForRun(thirdId);
const thirdAfter = db.prepare("SELECT status, blocked_reason AS reason FROM referrals WHERE invitee_user_id=?").get(thirdId) as any;
check("batas hadiah per pengundang dihormati (CEILING)",
  ceiling?.status === "ceiling" && thirdAfter?.status === "blocked" && thirdAfter?.reason === "CEILING", short(thirdAfter));
const qualifyAgain = refMod.qualifyReferralForRun(inviteeId);
check("hadiah tidak dibayar dua kali untuk undangan yang sama", qualifyAgain?.status === "none", short(qualifyAgain));
check("buku besar pengundang tidak bertambah setelah batas tercapai",
  Number((db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id=? AND reason='referral_inviter'").get(ownerId) as any)?.n) === 1,
  short(db.prepare("SELECT tokens, reason FROM credit_ledger WHERE user_id=?").all(ownerId)));

/* ------------------------------- 7) rotasi kode dan batas lajunya ------------------------------- */

const rotate1 = await owner.call("POST", "/api/v1/referrals/code");
const newCode = String(rotate1.json?.code ?? "");
check("kode undangan bisa diganti", rotate1.status === 200 && newCode.length === 8 && newCode !== code, short(rotate1.json));
check("tautan kode baru memuat kode baru", String(rotate1.json?.link ?? "").includes(`?ref=${newCode}`), short(rotate1.json?.link));
check("kode lama tidak lagi dikenali", refMod.codeOwner(code) === null, short(refMod.codeOwner(code)));
check("kode baru dikenali sistem", String(refMod.codeOwner(newCode)?.userId ?? "") === ownerId, short(refMod.codeOwner(newCode)));
check("rotasi kode meninggalkan jejak audit",
  Number((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='referral.code_rotated'").get() as any)?.n) >= 1,
  short(db.prepare("SELECT action FROM audit_events WHERE action LIKE 'referral%'").all()));
const rotate2 = await owner.call("POST", "/api/v1/referrals/code");
const rotate3 = await owner.call("POST", "/api/v1/referrals/code");
const rotate4 = await owner.call("POST", "/api/v1/referrals/code");
check("tiga rotasi pertama masih dilayani", rotate2.status === 200 && rotate3.status === 200, `${rotate2.status}/${rotate3.status}`);
check("rotasi keempat ditolak 429 dengan pesan tunggu", rotate4.status === 429 && rotate4.json?.error === "RATE_LIMITED" && /detik/.test(String(rotate4.json?.message ?? "")), short(rotate4.json));
const currentCode = String(rotate3.json?.code ?? "");

/* ------------------------------- 8) angka pertumbuhan (admin) ------------------------------- */

const growthBlocked = await guest.call("GET", "/api/v1/admin/growth");
check("halaman pertumbuhan menolak pengguna biasa", growthBlocked.status === 403 && growthBlocked.json?.error === "ADMIN_REQUIRED", short(growthBlocked.json));
const referralsBlocked = await guest.call("GET", "/api/v1/admin/referrals");
check("daftar undangan admin menolak pengguna biasa", referralsBlocked.status === 403 && referralsBlocked.json?.error === "ADMIN_REQUIRED", short(referralsBlocked.json));

const growth = await admin.call("GET", "/api/v1/admin/growth?days=7");
check("admin menerima laporan pertumbuhan", growth.status === 200 && Number(growth.json?.windowDays) === 7, short(growth.json)?.slice(0, 200));
const funnelKeys = (growth.json?.funnel?.steps ?? []).map((step: any) => String(step.key));
check("corong pertumbuhan berisi empat langkah berurutan",
  JSON.stringify(funnelKeys) === JSON.stringify(["signup", "project", "run", "paid"]), short(funnelKeys));
const funnelAllTime = (growth.json?.funnel?.steps ?? []).map((step: any) => Number(step.allTime));
check("angka corong dihitung dari tabel asli dan berlaku surut (semua akun uji terhitung)",
  funnelAllTime[0] >= 6 && funnelAllTime[1] >= 1 && funnelAllTime[2] >= 1,
  short(growth.json?.funnel?.steps));
check("setiap langkah corong tidak melebihi langkah sebelumnya (urutan logis)",
  funnelAllTime.every((value: number, index: number) => index === 0 || value <= funnelAllTime[index - 1]),
  short(funnelAllTime));
check("jendela aktivitas harian tepat satu baris per hari",
  Array.isArray(growth.json?.activity) && growth.json.activity.length === 7,
  short(growth.json?.activity?.length));
check("retensi melaporkan angka dan keterbatasannya secara jujur",
  Number.isFinite(Number(growth.json?.retention?.dau)) && Number.isFinite(Number(growth.json?.retention?.wau))
  && Number.isFinite(Number(growth.json?.retention?.payingUsers)) && String(growth.json?.retention?.note ?? "").length > 10,
  short(growth.json?.retention));
check("daftar peristiwa teratas berisi nama dan jumlah",
  Array.isArray(growth.json?.events) && growth.json.events.length >= 1 && String(growth.json.events[0]?.name ?? "").length > 0 && Number(growth.json.events[0]?.count) >= 1,
  short(growth.json?.events?.slice(0, 3)));
// Panjang katalog dibaca dari modul, bukan angka mati, supaya uji ini tidak basi setiap Wave
// menambah nama peristiwa. Isinya tetap diperiksa: semua nama modul muncul dan hadiah ada di situ.
const catalogueModul = growthMod.GROWTH_EVENTS as string[];
check(`katalog peristiwa memuat ${catalogueModul.length} nama yang dikenal`,
  Array.isArray(growth.json?.catalogue) && growth.json.catalogue.length === catalogueModul.length
  && catalogueModul.every((name) => growth.json.catalogue.includes(name)) && growth.json.catalogue.includes("referral_rewarded"),
  short(growth.json?.catalogue?.length));
check("total umum pertumbuhan tersedia",
  Number(growth.json?.totals?.users) >= 6 && Number(growth.json?.totals?.projects) >= 1 && Number(growth.json?.totals?.runsCompleted) >= 1,
  short(growth.json?.totals));
check("laporan pertumbuhan menyertakan statistik undangan dan papan peringkat",
  Number(growth.json?.referrals?.total) >= 3 && Number(growth.json?.referrals?.rewarded) === 1 && (growth.json?.referrals?.blockedByReason ?? []).some((row: any) => row.reason === "CEILING")
  && Array.isArray(growth.json?.leaderboard) && String(growth.json?.leaderboard?.[0]?.email ?? "").length > 0,
  short(growth.json?.referrals));
const growthDefault = await admin.call("GET", "/api/v1/admin/growth");
check("jendela laporan mengikuti GROWTH_WINDOW_DAYS bila tidak diminta", Number(growthDefault.json?.windowDays) === 30, short(growthDefault.json?.windowDays));
const growthBig = await admin.call("GET", "/api/v1/admin/growth?days=9999");
check("jendela laporan dibatasi 365 hari", Number(growthBig.json?.windowDays) === 365, short(growthBig.json?.windowDays));

const adminReferrals = await admin.call("GET", "/api/v1/admin/referrals?limit=50");
check("admin melihat daftar undangan lengkap dengan email kedua pihak",
  adminReferrals.status === 200 && Array.isArray(adminReferrals.json?.referrals) && adminReferrals.json.referrals.length >= 3
  && adminReferrals.json.referrals.every((row: any) => typeof row.inviterEmail === "string" && typeof row.inviteeEmail === "string"),
  short(adminReferrals.json?.referrals?.slice(0, 2)));
check("angka undangan di panel admin cocok dengan perhitungan modul",
  JSON.stringify(adminReferrals.json?.stats) === JSON.stringify(refMod.referralStats()), short(adminReferrals.json?.stats));

/* ------------------------------- 9) langkah awal (onboarding) ------------------------------- */

const anonOnboarding = await anon.call("GET", "/api/v1/onboarding");
check("langkah awal butuh sesi", anonOnboarding.status === 401, `${anonOnboarding.status}`);
const onboarding = await invitee.call("GET", "/api/v1/onboarding");
const stepKeys = (onboarding.json?.steps ?? []).map((step: any) => String(step.key));
check("langkah awal berisi lima langkah tetap",
  onboarding.status === 200 && JSON.stringify(stepKeys) === JSON.stringify(["verify_email", "first_project", "first_conversation", "first_run", "connect_team_or_key"]),
  short(stepKeys));
check("langkah awal menandai proyek dan run pertama sudah selesai",
  onboarding.json?.steps?.find((step: any) => step.key === "first_project")?.done === true
  && onboarding.json?.steps?.find((step: any) => step.key === "first_run")?.done === true,
  short(onboarding.json?.steps));
check("kemajuan langkah awal dihitung wajar", Number(onboarding.json?.total) === 5 && Number(onboarding.json?.percent) >= 20 && Number(onboarding.json?.percent) <= 100,
  `${onboarding.json?.done}/${onboarding.json?.total} = ${onboarding.json?.percent}%`);
check("langkah berikutnya menunjuk langkah yang belum selesai",
  stepKeys.includes(String(onboarding.json?.nextStep)) && onboarding.json?.complete === false,
  short(onboarding.json?.nextStep));
// Sejak Wave 10 (butir 26) alamat orang yang diundang memang sudah diverifikasi sebelum hadiahnya
// cair, jadi angka pendukung ini harus jujur menyebut true — bukan false seperti sebelum Wave 10.
check("angka pendukung langkah awal masuk akal",
  Number(onboarding.json?.counts?.projects) >= 1 && Number(onboarding.json?.counts?.runsDone) >= 1 && onboarding.json?.counts?.emailVerified === true,
  short(onboarding.json?.counts));
const dismissed = await invitee.call("POST", "/api/v1/onboarding/dismiss");
check("langkah awal bisa disembunyikan dan keadaannya dikembalikan",
  dismissed.status === 200 && dismissed.json?.dismissed === true && dismissed.json?.onboarding?.dismissed === true,
  short(dismissed.json));
check("keadaan sembunyi tersimpan di basis data",
  Boolean((db.prepare("SELECT dismissed_at AS d FROM onboarding_state WHERE user_id=?").get(inviteeId) as any)?.d),
  short(db.prepare("SELECT * FROM onboarding_state WHERE user_id=?").get(inviteeId)));
const onboardingAgain = await invitee.call("GET", "/api/v1/onboarding");
check("langkah awal tetap tersembunyi saat dimuat ulang", onboardingAgain.json?.dismissed === true, short(onboardingAgain.json?.dismissed));
const growthBadDays = await admin.call("GET", "/api/v1/admin/growth?days=abc");
check("jendela hari yang tidak masuk akal jatuh ke nilai bawaan", Number(growthBadDays.json?.windowDays) === 30, short(growthBadDays.json?.windowDays));

/* ------------------------------- 10) peringatan kuota ------------------------------- */

const quotaFresh = await invitee.call("GET", "/api/v1/billing/quota-alert");
check("peringatan kuota mengembalikan bentuk yang lengkap",
  quotaFresh.status === 200 && ["ok", "warning", "critical", "exceeded"].includes(String(quotaFresh.json?.level))
  && Number(quotaFresh.json?.percent) >= 0 && String(quotaFresh.json?.message).length > 10
  && String(quotaFresh.json?.packagePath) === "/paket" && Number(quotaFresh.json?.refreshSeconds) === 300,
  short(quotaFresh.json));
check("peringatan kuota memakai angka paket yang sebenarnya",
  Number(quotaFresh.json?.dailyLimit) > 0 && Number(quotaFresh.json?.monthlyLimit) > 0 && Number(quotaFresh.json?.usedToday) >= 0 && String(quotaFresh.json?.tier) === "free",
  short({ tier: quotaFresh.json?.tier, day: quotaFresh.json?.dailyLimit, month: quotaFresh.json?.monthlyLimit }));
check("kuota yang masih longgar disebut apa adanya",
  quotaFresh.json?.blocked === false && quotaFresh.json?.level === "ok" && /longgar/i.test(String(quotaFresh.json?.message ?? "")),
  short(quotaFresh.json?.message));
const quotaAnon = await anon.call("GET", "/api/v1/billing/quota-alert");
check("peringatan kuota butuh sesi", quotaAnon.status === 401, `${quotaAnon.status}`);

// Pemakaian token diisi di atas batas harian paket free (400.000) supaya tingkat peringatan benar-benar berubah.
db.prepare(`INSERT INTO run_usage (id, run_id, project_id, model, provider, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_micros, estimated, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`w7-usage-${stamp}`, inviteeRunId, inviteeProjectId, "wave7-test-model", "mock", 900000, 100000, 0, 1000000, 0, 0, new Date().toISOString());
const quotaFull = await invitee.call("GET", "/api/v1/billing/quota-alert");
check("kuota yang sudah penuh dilaporkan sebagai terlampaui",
  quotaFull.json?.blocked === true && quotaFull.json?.level === "exceeded" && String(quotaFull.json?.reason) === "DAILY_TOKEN_QUOTA_EXCEEDED"
  && Number(quotaFull.json?.percent) === 100 && /Batas paket/.test(String(quotaFull.json?.message ?? "")),
  short(quotaFull.json));
check("peringatan kuota menyertakan sisa jatah harian dan bulanan",
  quotaFull.json?.remainingToday === 0 && Number.isFinite(Number(quotaFull.json?.remainingMonth)),
  short({ today: quotaFull.json?.remainingToday, month: quotaFull.json?.remainingMonth }));
const blockedRun = await invitee.call("POST", `/api/v1/projects/${inviteeProjectId}/runs`, { prompt: "Ini seharusnya ditolak." });
check("run baru ditolak saat kuota penuh, sesuai angka yang dilaporkan",
  blockedRun.status === 429 && blockedRun.json?.error === "DAILY_TOKEN_QUOTA_EXCEEDED",
  short(blockedRun.json));
const adminQuota = await admin.call("GET", "/api/v1/billing/quota-alert");
check("admin platform tetap bisa melewati kuota", adminQuota.json?.blocked === false, short(adminQuota.json?.level));

/* ------------------------------- 11) permukaan publik ------------------------------- */

const robots = await anon.call("GET", "/robots.txt");
check("robots.txt dilayani tanpa sesi dan menunjuk sitemap",
  robots.status === 200 && /text\/plain/.test(String(robots.text).length > 0 ? "text/plain" : "") && robots.text.includes("Sitemap:") && robots.text.includes("Disallow: /api/") && robots.text.includes("Allow: /docs"),
  short(robots.text));
const sitemap = await anon.call("GET", "/sitemap.xml");
check("sitemap.xml memuat halaman publik utama",
  sitemap.status === 200 && sitemap.text.includes("<urlset") && sitemap.text.includes("/harga") && sitemap.text.includes("/docs"),
  short(sitemap.text));
const docs = await anon.call("GET", "/api/v1/public/docs");
check("dokumentasi API terbuka tanpa sesi", docs.status === 200 && docs.json?.product === "COBLAI Coder", short(docs.json)?.slice(0, 160));
check("dokumentasi API memuat sembilan rute dan semuanya tersedia",
  Array.isArray(docs.json?.endpoints) && docs.json.endpoints.length === 9 && docs.json.endpoints.every((row: any) => row.available !== false),
  short(docs.json?.endpoints?.length));
check("dokumentasi API menjelaskan izin dan batas pemakaian",
  JSON.stringify(docs.json?.auth?.scopes) === JSON.stringify(["read", "write"]) && Number(docs.json?.limits?.maxKeys) > 0 && Number(docs.json?.limits?.rateLimitPerMinute) > 0,
  short(docs.json?.limits));
check("dokumentasi API menjelaskan webhook beserta percobaan ulang",
  JSON.stringify(docs.json?.webhook?.events) === JSON.stringify(["run.completed", "run.failed"])
  && String(docs.json?.webhook?.signatureHeader).includes("signature") && Number(docs.json?.webhook?.retries?.attempts) >= 1,
  short(docs.json?.webhook));
check("dokumentasi API memuat daftar kode galat",
  Array.isArray(docs.json?.errors) && docs.json.errors.length >= 5 && docs.json.errors.every((row: any) => typeof row.code === "string" && typeof row.meaning === "string"),
  short(docs.json?.errors?.length));
check("dokumentasi API tidak membocorkan rahasia", !JSON.stringify(docs.json).includes("whsec_") && !JSON.stringify(docs.json).includes("secret"), `panjang=${JSON.stringify(docs.json)?.length}`);
check("halaman dokumentasi ditunjuk pada alamat publik", String(docs.json?.page ?? "").includes("/docs"), short(docs.json?.page));

/* ------------------------------- 12) penutup: menyembunyikan email masuk ------------------------------- */

const growthFinal = await admin.call("GET", "/api/v1/admin/growth?days=30");
check("laporan terakhir tetap konsisten setelah semua tindakan",
  Array.isArray(growthFinal.json?.funnel?.steps) && growthFinal.json.funnel.steps.length === 4
  && Number(growthFinal.json?.referrals?.rewarded) === 1,
  short(growthFinal.json?.referrals));
check("tidak ada email yang dikirim keluar karena NOTIFY_EMAIL_ENABLED mati",
  Number((db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status='sent'").get() as any)?.n) === 0,
  short(db.prepare("SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status").all()));

console.log(`WAVE7 ${passed}/${checks} lulus, ${failed} gagal`);
if (failed > 0) { console.log("GAGAL:"); for (const name of failedNames) console.log(` - ${name}`); }
console.log(failed === 0 ? "ALL_WAVE7_TESTS_PASSED" : "WAVE7_TESTS_FAILED");
process.exit(failed === 0 ? 0 : 1);

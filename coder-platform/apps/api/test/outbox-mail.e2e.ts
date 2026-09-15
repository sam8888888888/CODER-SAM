/**
 * Uji khusus antrean email dengan pengiriman DIKATAKAN AKTIF (`NOTIFY_EMAIL_ENABLED=true`) tetapi SMTP
 * TIDAK dikonfigurasi. Tujuannya memastikan dua hal keamanan:
 *  1) antrean email tidak pernah mencoba menghubungi SMTP kalau konfigurasinya tidak lengkap
 *     (baris ditandai `skipped` + alasan `MAILER_NOT_CONFIGURED`, `sent` tetap 0), dan
 *  2) pesan yang masih menunggu (`pending`) TIDAK bisa dihapus selagi pengiriman aktif
 *     (409 EMAIL_IN_FLIGHT), sementara pesan yang sudah selesai bisa dihapus.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/outbox-mail.e2e.ts
 *
 * Tidak ada email yang benar-benar terkirim: tidak ada kredensial SMTP, dan suite ini tidak
 * menyentuh jaringan luar.
 */

const port = 6000 + Math.floor(Math.random() * 200); // rentang khusus 6000-6200
const dataDir = `/tmp/coder-outbox-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `outbox-admin-${stamp}@example.test`;
const secondEmail = `outbox-second-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "outbox-test-model";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RATE_LIMIT_API_PER_MINUTE = "100000";
// Pengiriman email dikatakan AKTIF, tetapi kredensial SMTP sengaja dibiarkan kosong.
process.env.NOTIFY_EMAIL_ENABLED = "true";
process.env.SMTP_HOST = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASSWORD = "";
process.env.SMTP_FROM = "";
delete process.env.SMTP_PORT;
delete process.env.SMTP_SECURE;

await import("../src/server.js");

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

type Reply = { status: number; json: any; text: string };
type ApiClient = { call: (method: string, path: string, body?: unknown) => Promise<Reply> };

function client(): ApiClient {
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
  };
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { await response.arrayBuffer(); return; } } catch { /* server belum siap */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server tidak siap");
}

await waitForHealth();
console.log("serve: server uji siap");

const admin = client();
const registerAdmin = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password: "SandiUji2026!aman", displayName: "Admin Antrean" });
check("pendaftaran admin berhasil", registerAdmin.status === 200 || registerAdmin.status === 201, short(registerAdmin.json));
const loginAdmin = await admin.call("POST", "/api/v1/auth/login", { email: adminEmail, password: "SandiUji2026!aman" });
check("login admin berhasil", loginAdmin.status === 200, short(loginAdmin.json));

const box = await admin.call("GET", "/api/v1/admin/email-outbox");
check("pengiriman aktif tetapi SMTP kosong: worker melaporkan enabled=true dan mailerConfigured=false",
  box.status === 200 && box.json?.worker?.enabled === true && box.json?.worker?.mailerConfigured === false, short(box.json?.worker));
const welcome = (box.json?.emails ?? []).find((row: any) => row.kind === "account" && row.toEmail === adminEmail);
check("pendaftaran akun masuk antrean sebagai pesan menunggu", Boolean(welcome) && welcome?.status === "pending", short((box.json?.emails ?? []).slice(0, 2)));

const deliver = await admin.call("POST", "/api/v1/admin/email-outbox/deliver");
check("pengiriman tanpa SMTP TIDAK mengirim apa pun (sent=0, skipped>=1)",
  deliver.status === 200 && deliver.json?.enabled === true && deliver.json?.sent === 0 && Number(deliver.json?.skipped) >= 1, short(deliver.json));
const afterDeliver = await admin.call("GET", "/api/v1/admin/email-outbox?status=skipped");
const skippedRow = (afterDeliver.json?.emails ?? []).find((row: any) => row.id === welcome?.id);
check("baris yang gagal dikonfigurasi ditandai skipped dengan alasan MAILER_NOT_CONFIGURED",
  skippedRow?.status === "skipped" && String(skippedRow?.lastError ?? "").includes("MAILER_NOT_CONFIGURED"), short(skippedRow));

// Pesan baru yang masih menunggu: pengiriman aktif, jadi tidak boleh dihapus dulu.
// Pendaftaran pengguna kedua memakai klien anonim: register otomatis memasang sesi pengguna itu,
// jadi memakai klien admin akan menimpa cookie admin dan membuat pemeriksaan berikutnya salah.
const anon = client();
const second = await anon.call("POST", "/api/v1/auth/register", { email: secondEmail, password: "SandiUji2026!aman", displayName: "Pengguna Kedua" });
check("pendaftaran pengguna kedua berhasil", second.status === 200 || second.status === 201, short(second.json));
const boxAgain = await admin.call("GET", "/api/v1/admin/email-outbox");
const pendingRow = (boxAgain.json?.emails ?? []).find((row: any) => row.status === "pending" && row.toEmail === secondEmail);
check("pesan pengguna kedua masih menunggu di antrean", Boolean(pendingRow), short((boxAgain.json?.emails ?? []).slice(0, 3)));

const deletePending = await admin.call("DELETE", `/api/v1/admin/email-outbox/${pendingRow?.id}`);
check("pesan menunggu tidak bisa dihapus selagi pengiriman aktif -> 409 EMAIL_IN_FLIGHT",
  deletePending.status === 409 && deletePending.json?.error === "EMAIL_IN_FLIGHT", `${deletePending.status} ${short(deletePending.json)}`);
const stillThere = await admin.call("GET", "/api/v1/admin/email-outbox");
check("pesan menunggu itu masih ada setelah penolakan", (stillThere.json?.emails ?? []).some((row: any) => row.id === pendingRow?.id), short((stillThere.json?.emails ?? []).length));

const deleteFinished = await admin.call("DELETE", `/api/v1/admin/email-outbox/${welcome?.id}`);
check("pesan yang sudah selesai (skipped) boleh dihapus", deleteFinished.status === 200 && deleteFinished.json?.deleted === true, `${deleteFinished.status} ${short(deleteFinished.json)}`);
const goneAfterDelete = await admin.call("GET", "/api/v1/admin/email-outbox");
check("pesan yang dihapus tidak ada lagi di daftar", !(goneAfterDelete.json?.emails ?? []).some((row: any) => row.id === welcome?.id), short((goneAfterDelete.json?.emails ?? []).length));

const deleteUnknown = await admin.call("DELETE", "/api/v1/admin/email-outbox/tidak-ada-0000");
check("menghapus pesan yang tidak ada -> 404 EMAIL_NOT_FOUND", deleteUnknown.status === 404 && deleteUnknown.json?.error === "EMAIL_NOT_FOUND", `${deleteUnknown.status} ${short(deleteUnknown.json)}`);

const retryFinished = await admin.call("POST", `/api/v1/admin/email-outbox/${pendingRow?.id}/retry`);
check("kirim ulang untuk pesan yang masih menunggu ditolak -> 404 EMAIL_NOT_RETRYABLE",
  retryFinished.status === 404 && retryFinished.json?.error === "EMAIL_NOT_RETRYABLE", `${retryFinished.status} ${short(retryFinished.json)}`);

console.log("\n=== RINGKASAN ===");
console.log(`total pemeriksaan: ${checks}, lulus: ${passed}, gagal: ${failed}`);
if (failed) { console.log(`gagal pada: ${failedNames.join("; ")}`); console.log("OUTBOX_MAIL_TESTS_FAILED"); process.exit(1); }
console.log("ALL_OUTBOX_MAIL_TESTS_PASSED");
process.exit(0);

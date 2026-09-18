/**
 * Uji Wave 10 (v0.19.0): kuota token pekerjaan yang sedang berjalan, perangkat masuk +
 * verifikasi email perangkat, pembersihan data smoke (mode kering dulu), halaman metrik,
 * dan notifikasi peramban (push).
 *
 * Yang dibuktikan (butir 24, 26, 27+22, 28, 31, dan status-hub):
 *  1) kolom runs.reserved_tokens ada dan dipakai: estimateRunTokens / reserveRunTokens /
 *     releaseRunTokens / apiKeyReservedTokens bekerja, dan checkApiKeyDailyQuota MENOLAK
 *     saat terpakai + cadangan sudah menyentuh batas;
 *  2) rute GET /api/v1/api-keys melaporkan tokensReserved, inFlight, dan quota;
 *  3) jalur publik POST .../messages menulis runs.reserved_tokens > 0 dan mengembalikannya
 *     di jawaban (run.reservedTokens);
 *  4) login merekam perangkat (respons punya device.id, auth_sessions.device_id terisi),
 *     halaman perangkat menandai current, rename/delete/admin-block bekerja, dan pencabutan
 *     perangkat langsung mematikan sesi yang terikat padanya;
 *  5) gerbang DEVICE_VERIFY_NEW: perangkat baru masuk dengan verified=false, tautan verifikasi
 *     terbit, POST /account/devices/verify menandai verified_at, dan token sekali pakai;
 *  6) anti-abuse undangan: sidik perangkat yang sama memblokir hadiah (SAME_DEVICE) dan
 *     hadiah menunggu email invitee terverifikasi (EMAIL_NOT_VERIFIED);
 *  7) pembersihan data smoke: mode kering melaporkan jumlah nyata tanpa menghapus, mode nyata
 *     menghapus proyek + berkas artefak + notifikasi milik akun smoke saja, dan admin ditolak;
 *  8) halaman metrik /api/v1/metrics (token wajib, teks) dan /api/v1/admin/metrics (admin);
 *  9) notifikasi peramban: kunci VAPID, batas langganan, hapus langganan, kirim uji yang gagal
 *     tanpa mematikan langganan, dan saklar PUSH_ENABLED;
 * 10) status-hub memuat kunci baru: search, push, devices, housekeeping, growthSources.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave10.e2e.ts
 *
 * Catatan jujur: berkas ini HANYA menambah berkas baru; tidak ada berkas lain yang diubah.
 * Bila ada bagian spesifikasi yang tidak cocok dengan kode server, bagian itu ditulis sebagai
 * SKIP beserta sebabnya dan dilaporkan (tidak diperbaiki di sini).
 */
import { createECDH, createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = 7140 + Math.floor(Math.random() * 20); // rentang khusus 7140-7159
const dataDir = `/tmp/coder-wave10-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w10-admin-${stamp}@example.test`;
const ownerEmail = `w10-owner-${stamp}@example.test`;
const smokeEmail = `w10-smoke-${stamp}@example.test`;
const inviteeEmail = `w10-invitee-${stamp}@example.test`;
const pendingEmail = `w10-pending-${stamp}@example.test`;
const greenEmail = `w10-green-${stamp}@example.test`;   // akun "lain": datanya tidak boleh tersentuh
const gateEmail = `w10-gate-${stamp}@example.test`;     // akun untuk gerbang verifikasi perangkat
const metricsToken = "wave10-metrics-token";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave10-test-model";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.PUSH_ENABLED = "true";
process.env.PUSH_MAX_PER_USER = "2";
process.env.DEVICE_TRACKING = "true";
process.env.METRICS_TOKEN = metricsToken;
process.env.SMOKE_ACCOUNT_EMAIL = smokeEmail;
// Rute ubah data wajib membawa Origin yang dikenal + token CSRF ganda (cookie coder_csrf = header).
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RETENTION_ENABLED = "false";
// Putaran pekerja latar dibuat sangat panjang: hanya pekerjaan yang dipanggil uji ini yang berjalan,
// supaya pembersih terjadwal tidak berlomba dengan data uji.
process.env.JOB_WORKER_INTERVAL_MS = "3600000";

const startedAtMs = Date.now();
await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const keyMod: any = await import("../src/apikeys.js");
const deviceMod: any = await import("../src/devices.js");
const referralMod: any = await import("../src/referrals.js");
const pushMod: any = await import("../src/push.js");
const configMod: any = await import("../src/config.js");
const config = configMod.config;

const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 160) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const tableCount = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const sessionDigest = (token: string) => createHash("sha256").update(token).digest("hex");

type Profile = { ua?: string; deviceId?: string; lang?: string };

/** Klien HTTP kecil: jar cookie sendiri, token CSRF ganda, dan sidik perangkat yang bisa diatur. */
function client(profile: Profile = {}) {
  const jar = new Map<string, string>();
  let primed = false;
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    // Seperti peramban: cookie CSRF terbit pada permintaan pertama, jadi rute ubah data memuat
    // /health lebih dulu sekali supaya cookie + header bisa dikirim bersamaan (mode CSRF_STRICT).
    if (mutating) await prime();
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: base,
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(mutating && jar.get("coder_csrf") ? { "x-csrf-token": String(jar.get("coder_csrf")) } : {}),
      ...(profile.ua ? { "user-agent": profile.ua } : {}),
      ...(profile.deviceId ? { "x-device-id": profile.deviceId } : {}),
      ...(profile.lang ? { "accept-language": profile.lang } : {}),
      ...extra,
    };
    const response = await fetch(`${base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of raw) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim();
      const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const text = await response.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, headers: response.headers, setCookie: raw.join(" | ") };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server uji belum siap */ } }
  return {
    call, jar,
    get csrf() { return String(jar.get("coder_csrf") ?? ""); },
    get cookies() { return cookieHeader(); },
    clear() { jar.clear(); },
    /** GET biasa supaya cookie CSRF terbit lebih dulu (mode CSRF_STRICT). */
    async bootstrap() { return prime(); },
  };
}

/** Panggilan tanpa cookie sama sekali (untuk rute API kunci dan halaman metrik). */
async function raw(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, text, headers: response.headers };
}

// Akun: admin platform, pemilik, akun smoke, akun lain, dan akun undangan.
const admin = client({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", deviceId: "w10-admin", lang: "id-ID" });
const owner = client({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", deviceId: "w10-desktop", lang: "id-ID" });
const smoke = client({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", deviceId: "w10-smoke", lang: "id-ID" });
const green = client({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0", deviceId: "w10-green", lang: "id-ID" });
const phoneProfile: Profile = { ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile", deviceId: "w10-phone", lang: "id-ID" };
const phone = client(phoneProfile);
const phone2 = client(phoneProfile);
const tabletProfile: Profile = { ua: "Mozilla/5.0 (iPad; CPU OS 17_0) Safari/605.1.15", deviceId: "w10-tablet", lang: "id-ID" };
const tablet = client(tabletProfile);
const tablet2 = client(tabletProfile);
const gate = client({ ua: "Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0", deviceId: "w10-gate", lang: "id-ID" });
const invitee = client({ ua: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) Firefox/121.0", deviceId: "w10-invitee", lang: "id-ID" });
const pending = client({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15", deviceId: "w10-pending", lang: "id-ID" });

// Pemicu kecil: mencatat SETIAP baris `runs` yang disisipkan, karena run mock selesai secepat
// mikro-task sehingga barisnya bisa sudah berstatus selesai saat uji membacanya. Pemicu ini
// milik basis data uji sementara, bukan perubahan berkas atau skema aplikasi.
db.exec(`CREATE TABLE IF NOT EXISTS wave10_run_writes (
  run_id TEXT PRIMARY KEY, api_key_id TEXT, reserved_tokens INTEGER, status TEXT, seen_at TEXT);
CREATE TRIGGER IF NOT EXISTS wave10_runs_insert AFTER INSERT ON runs BEGIN
  INSERT OR REPLACE INTO wave10_run_writes (run_id, api_key_id, reserved_tokens, status, seen_at)
  VALUES (NEW.id, NEW.api_key_id, NEW.reserved_tokens, NEW.status, datetime('now'));
END;`);

for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const ready = await fetch(`${base}/health`); if (ready.ok) break; } catch { /* belum siap */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), data di ${dataDir}`);

// =====================================================================================
// Bagian 0: akun dasar (admin platform, pemilik proyek) + kunci API.
// =====================================================================================
console.log("\n--- Bagian 0: akun & kunci API ---");
await admin.bootstrap();
const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Wave 10" });
check("akun admin platform terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.user?.id), `${adminReg.status} ${short(adminReg.json)}`);
const adminUserId = String(adminReg.json?.user?.id ?? "");

await owner.bootstrap();
const ownerReg = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Wave 10" });
check("akun pemilik terdaftar", ownerReg.status === 201 && Boolean(ownerReg.json?.user?.id), `${ownerReg.status} ${short(ownerReg.json)}`);
const ownerUserId = String(ownerReg.json?.user?.id ?? "");
const ownerWorkspaceId = String(ownerReg.json?.workspace?.id ?? ownerReg.json?.workspaceId ?? "");
check("pemilik punya workspace", Boolean(ownerUserId && ownerWorkspaceId), short(ownerReg.json));

const projectReply = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`, { name: "Proyek Wave 10" });
check("proyek pemilik dibuat", projectReply.status === 201 && Boolean(projectReply.json?.id), `${projectReply.status} ${short(projectReply.json)}`);
const projectId = String(projectReply.json?.id ?? "");

// Klien untuk rute API kunci: tanpa sesi, tetapi wajib membawa Origin + cookie CSRF (mode ketat).
const apiClient = client();
await apiClient.bootstrap();

const writeKeyReply = await owner.call("POST", "/api/v1/api-keys", { name: "wave10-tulis", scopes: ["write"], dailyRequestLimit: 0, dailyTokenLimit: 0 });
const writeKey = String(writeKeyReply.json?.secret ?? "");
const writeKeyId = String(writeKeyReply.json?.key?.id ?? "");
check("kunci API (write) terbit", writeKeyReply.status === 201 && writeKey.startsWith("ck_") && Boolean(writeKeyId), `${writeKeyReply.status} ${short({ key: writeKeyReply.json?.key })}`);

const limitKeyReply = await owner.call("POST", "/api/v1/api-keys", { name: "wave10-batas", scopes: ["read"], dailyRequestLimit: 0, dailyTokenLimit: 5000 });
const limitKeyId = String(limitKeyReply.json?.key?.id ?? "");
check("kunci API dengan batas token 5000 terbit", limitKeyReply.status === 201 && Boolean(limitKeyId), `${limitKeyReply.status} ${short({ key: limitKeyReply.json?.key })}`);

// =====================================================================================
// Bagian A (butir 24): kuota token per kunci menghitung pekerjaan yang sedang berjalan.
// =====================================================================================
console.log("\n--- Bagian A (butir 24): kuota token pekerjaan berjalan ---");

const runColumns = (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((column) => column.name);
check("1. kolom runs.reserved_tokens ada di skema nyata", runColumns.includes("reserved_tokens"), short(runColumns));

const estimateSmall = keyMod.estimateRunTokens("halo", 4000);
const estimateLong = keyMod.estimateRunTokens("x".repeat(400), 4000);
check("2. estimateRunTokens = prompt/4 + jatah keluaran", estimateSmall === 4001 && estimateLong === 4100, short({ estimateSmall, estimateLong }));
check("2b. jatah bawaan dipakai bila argumen kedua kosong", keyMod.estimateRunTokens("halo") === 4001 && config.API_KEY_INFLIGHT_OUTPUT_TOKENS === 4000, short({ bawaan: keyMod.estimateRunTokens("halo"), configValue: config.API_KEY_INFLIGHT_OUTPUT_TOKENS }));

// Run pemeriksaan: baris `runs` nyata, tanpa pekerjaan mesin, supaya angka reservasi bisa dibaca langsung.
const probeRunId = `w10-probe-${stamp}`;
db.prepare("INSERT INTO runs (id, project_id, status, prompt, model, api_key_id, created_at, reserved_tokens) VALUES (?,?,?,?,?,?,?,?)")
  .run(probeRunId, projectId, "queued", "halo", "wave10-test-model", limitKeyId, new Date().toISOString(), 0);
keyMod.reserveRunTokens(probeRunId, estimateLong);
const reservedNow = keyMod.apiKeyReservedTokens(limitKeyId);
const inFlightNow = keyMod.apiKeyInFlight(limitKeyId);
check("3a. reserveRunTokens menulis cadangan ke baris run", Number((db.prepare("SELECT reserved_tokens AS r FROM runs WHERE id=?").get(probeRunId) as any).r) === 4100, short(reservedNow));
check("3b. apiKeyReservedTokens menjumlahkan run queued/running", reservedNow === 4100, short(reservedNow));
check("3c. apiKeyInFlight menyebut run yang sedang ditahan", inFlightNow.length === 1 && inFlightNow[0].runId === probeRunId && inFlightNow[0].tokens === 4100, short(inFlightNow));

// Batas harian 5000 token: cadangan (4100) + terpakai (0) belum menyentuh batas -> masih boleh.
const limitKeyRow = keyMod.getApiKey(ownerUserId, limitKeyId);
const quotaBefore = keyMod.checkApiKeyDailyQuota(limitKeyRow);
check("3d. di bawah batas (4100 < 5000) kuota masih boleh", quotaBefore === null, short(quotaBefore));

// Cadangan dinaikkan sampai menyentuh batas walau tokensUsed sendiri masih 0.
keyMod.reserveRunTokens(probeRunId, 5000);
const quotaBlock = keyMod.checkApiKeyDailyQuota(keyMod.getApiKey(ownerUserId, limitKeyId));
check("3e. cadangan + terpakai >= batas -> 429 API_KEY_DAILY_TOKEN_LIMIT", quotaBlock?.status === 429 && quotaBlock?.error === "API_KEY_DAILY_TOKEN_LIMIT", short(quotaBlock));
check("3f. rincian menunjuk cadangan (reserved), bukan token terpakai", Number(quotaBlock?.detail?.reserved) === 5000 && Number(quotaBlock?.detail?.used) === 0 && Number(quotaBlock?.detail?.total) === 5000, short(quotaBlock?.detail));
check("3g. pesan menjelaskan token ditahan untuk permintaan berjalan", String(quotaBlock?.detail?.message ?? "").includes("menahan 5000"), short(quotaBlock?.detail?.message));

keyMod.releaseRunTokens(probeRunId);
const quotaAfterRelease = keyMod.checkApiKeyDailyQuota(keyMod.getApiKey(ownerUserId, limitKeyId));
check("3h. releaseRunTokens melepas cadangan (kuota boleh lagi)", keyMod.apiKeyReservedTokens(limitKeyId) === 0 && quotaAfterRelease === null, short({ reserved: keyMod.apiKeyReservedTokens(limitKeyId), kuota: quotaAfterRelease }));
db.prepare("DELETE FROM runs WHERE id=?").run(probeRunId);

const keysPage = await owner.call("GET", "/api/v1/api-keys");
const pageKey = (keysPage.json?.keys ?? []).find((key: any) => key.id === writeKeyId);
const snapshot = keyMod.apiKeyQuotaSnapshot(keyMod.getApiKey(ownerUserId, writeKeyId));
check("4. GET /api/v1/api-keys melaporkan tokensReserved + inFlight + quota",
  keysPage.status === 200 && pageKey !== undefined && typeof pageKey.tokensReserved === "number" && Array.isArray(pageKey.inFlight)
  && pageKey.quota !== undefined && "tokensReserved" in pageKey.quota && "tokensRemaining" in pageKey.quota && "tokensUsed" in pageKey.quota,
  short({ status: keysPage.status, key: pageKey && { tokensReserved: pageKey.tokensReserved, quota: pageKey.quota, inFlight: pageKey.inFlight } }));
check("4b. snapshot kuota sepakat dengan rute halaman", Number(pageKey?.quota?.tokensReserved) === snapshot.tokensReserved && Number(pageKey?.tokensReserved) === snapshot.tokensReserved, short({ halaman: pageKey?.quota, modul: snapshot }));

// Jalur publik: kunci menulis pesan -> server menahan perkiraan token pada baris run.
const pubConversation = await apiClient.call("POST", `/api/v1/public/v1/projects/${projectId}/conversations`, { title: "Percakapan kuota" }, { authorization: `Bearer ${writeKey}` });
check("5a. percakapan lewat API kunci dibuat", pubConversation.status === 201 && Boolean(pubConversation.json?.conversation?.id), `${pubConversation.status} ${short(pubConversation.json)}`);
const pubConversationId = String(pubConversation.json?.conversation?.id ?? "");

const pubMessage = await apiClient.call("POST", `/api/v1/public/v1/conversations/${pubConversationId}/messages`, { content: "Tolong jawab singkat soal kuota token." }, { authorization: `Bearer ${writeKey}` });
const pubRunId = String(pubMessage.json?.run?.id ?? "");
const pubReserved = Number(pubMessage.json?.run?.reservedTokens ?? 0);
check("5b. POST pesan publik menjawab 202 dengan run.reservedTokens > 0", pubMessage.status === 202 && pubReserved > 0, `${pubMessage.status} ${short(pubMessage.json)}`);

const insertLog = db.prepare("SELECT run_id AS runId, api_key_id AS apiKeyId, reserved_tokens AS reserved, status FROM wave10_run_writes WHERE run_id=?").get(pubRunId) as { runId: string; apiKeyId: string; reserved: number; status: string } | undefined;
check("5c. baris runs disisipkan dengan reserved_tokens > 0 (tercatat saat INSERT)", Boolean(insertLog) && Number(insertLog!.reserved) > 0, short(insertLog));
check("5d. kunci yang dicatat adalah kunci penulis, bukan kunci lain", String(insertLog?.apiKeyId ?? "") === writeKeyId, short({ dicatat: insertLog?.apiKeyId, diharapkan: writeKeyId }));
check("5e. angka di jawaban sama dengan angka yang ditulis ke basis data", pubReserved === Number(insertLog?.reserved ?? -1), short({ jawaban: pubReserved, basisData: insertLog?.reserved }));

await new Promise((resolve) => setTimeout(resolve, 250));
const pubRunAfter = db.prepare("SELECT status, COALESCE(reserved_tokens,0) AS reserved FROM runs WHERE id=?").get(pubRunId) as { status: string; reserved: number };
check("5f. setelah run selesai cadangan dilepas (reserved_tokens = 0)", Boolean(pubRunAfter) && ["completed", "failed", "cancelled"].includes(String(pubRunAfter.status)) && Number(pubRunAfter.reserved) === 0, short({ ...(pubRunAfter ?? {}), catatan: "run mock selesai sangat cepat" }));
check("5g. run yang sudah selesai tidak lagi dihitung sebagai pekerjaan berjalan", keyMod.apiKeyReservedTokens(writeKeyId) === 0 && keyMod.apiKeyInFlight(writeKeyId).length === 0, short({ reserved: keyMod.apiKeyReservedTokens(writeKeyId) }));

// =====================================================================================
// Bagian B (butir 26): perangkat masuk, pencabutan, blokir admin, gerbang verifikasi,
//                    dan penyalahgunaan undangan (sidik perangkat + email invitee).
// =====================================================================================
console.log("\n--- Bagian B (butir 26): perangkat & anti-abuse undangan ---");

const devicesBeforeLogin = tableCount("SELECT COUNT(*) AS n FROM user_devices WHERE user_id=?", ownerUserId);
const loginPhone = await phone.call("POST", "/api/v1/auth/login", { email: ownerEmail, password });
const phoneDeviceId = String(loginPhone.json?.device?.id ?? "");
check("1a. login merekam perangkat dan menjawab device.id", loginPhone.status === 200 && Boolean(phoneDeviceId), `${loginPhone.status} ${short(loginPhone.json)}`);
check("1b. perangkat yang belum dikenal ditandai newDevice", loginPhone.json?.device?.newDevice === true, short(loginPhone.json?.device));
check("1c. tabel user_devices bertambah satu baris", tableCount("SELECT COUNT(*) AS n FROM user_devices WHERE user_id=?", ownerUserId) === devicesBeforeLogin + 1, short({ sebelum: devicesBeforeLogin, sesudah: tableCount("SELECT COUNT(*) AS n FROM user_devices WHERE user_id=?", ownerUserId) }));

const phoneSession = db.prepare("SELECT device_id AS deviceId FROM auth_sessions WHERE token_hash=?").get(sessionDigest(String(phone.jar.get("coder_session") ?? ""))) as { deviceId: string } | undefined;
check("1d. sesi login terikat ke perangkat itu (auth_sessions.device_id)", String(phoneSession?.deviceId ?? "") === phoneDeviceId, short({ sesi: phoneSession, perangkat: phoneDeviceId }));

const loginPhone2 = await phone2.call("POST", "/api/v1/auth/login", { email: ownerEmail, password });
check("1e. masuk ulang dari sidik yang sama memakai baris perangkat yang sama", loginPhone2.status === 200 && String(loginPhone2.json?.device?.id ?? "") === phoneDeviceId && loginPhone2.json?.device?.newDevice === false,
  short({ status: loginPhone2.status, device: loginPhone2.json?.device }));
check("1f. tidak ada baris perangkat tambahan untuk sidik yang sama", tableCount("SELECT COUNT(*) AS n FROM user_devices WHERE user_id=?", ownerUserId) === devicesBeforeLogin + 1, short(tableCount("SELECT COUNT(*) AS n FROM user_devices WHERE user_id=?", ownerUserId)));

const devicePage = await phone.call("GET", "/api/v1/account/devices");
const phoneEntry = (devicePage.json?.devices ?? []).find((entry: any) => entry.id === phoneDeviceId);
check("2. halaman perangkat memuat perangkat itu dengan current: true",
  devicePage.status === 200 && phoneEntry !== undefined && phoneEntry.current === true,
  short({ status: devicePage.status, entry: phoneEntry }));
check("2b. halaman menyebut gerbang dan batas perangkat", typeof devicePage.json?.verifyRequired === "boolean" && devicePage.json?.tracking === true && Number(devicePage.json?.limit) === config.DEVICE_MAX_PER_USER,
  short({ verifyRequired: devicePage.json?.verifyRequired, tracking: devicePage.json?.tracking, limit: devicePage.json?.limit }));
check("2c. perangkat lain (sesi desktop lama) tidak ditandai current", (devicePage.json?.devices ?? []).every((entry: any) => entry.id === phoneDeviceId || entry.current === false), short(devicePage.json?.devices));

const renamed = await phone.call("PATCH", `/api/v1/account/devices/${phoneDeviceId}`, { label: "HP Uji Dinda" });
check("3a. nama perangkat bisa diubah", renamed.status === 200 && renamed.json?.device?.label === "HP Uji Dinda", `${renamed.status} ${short(renamed.json)}`);
const emptyLabel = await phone.call("PATCH", `/api/v1/account/devices/${phoneDeviceId}`, { label: "   " });
check("3b. nama kosong ditolak 400 INVALID_LABEL", emptyLabel.status === 400 && emptyLabel.json?.error === "INVALID_LABEL", `${emptyLabel.status} ${short(emptyLabel.json)}`);
const longLabel = await phone.call("PATCH", `/api/v1/account/devices/${phoneDeviceId}`, { label: "L".repeat(200) });
// Nama yang terlalu panjang ditolak dengan kalimat jelas, bukan dipotong diam-diam.
check("3c. nama terlalu panjang ditolak 400 DEVICE_LABEL_TOO_LONG",
  longLabel.status === 400 && longLabel.json?.error === "DEVICE_LABEL_TOO_LONG" && String(longLabel.json?.message ?? "").includes("60"),
  `${longLabel.status} ${short(longLabel.json)}`);
check("3c'. nama perangkat tidak berubah setelah penolakan",
  String((await phone.call("GET", "/api/v1/account/devices")).json?.devices?.find?.((entry: any) => entry.id === phoneDeviceId)?.label ?? "") === "HP Uji Dinda", "");

const revoke = await owner.call("DELETE", `/api/v1/account/devices/${phoneDeviceId}`);
check("4a. pencabutan perangkat mengakhiri sesi yang terikat perangkat itu", revoke.status === 200 && Number(revoke.json?.sessionsRemoved) >= 2, `${revoke.status} ${short(revoke.json)}`);
const phoneAfterRevoke = await phone2.call("GET", "/api/v1/account/devices");
check("4b. sesi lama yang dicabut langsung ditolak 401", phoneAfterRevoke.status === 401, `${phoneAfterRevoke.status} ${short(phoneAfterRevoke.json)}`);
check("4c. baris perangkat sudah hilang dari akun", deviceMod.getDevice(ownerUserId, phoneDeviceId) === null && !(await phone.call("GET", "/api/v1/account/devices")).json?.devices?.some((entry: any) => entry.id === phoneDeviceId),
  short({ modul: deviceMod.getDevice(ownerUserId, phoneDeviceId) }));

// Blokir oleh admin platform, dan perangkat yang diblokir tidak boleh masuk lagi.
const loginTablet = await tablet.call("POST", "/api/v1/auth/login", { email: ownerEmail, password });
const tabletDeviceId = String(loginTablet.json?.device?.id ?? "");
check("5a. perangkat kedua tercatat untuk akun yang sama", Boolean(tabletDeviceId) && tabletDeviceId !== phoneDeviceId, short(loginTablet.json?.device));
const ownerDeviceList = await owner.call("GET", "/api/v1/admin/devices");
check("5b. bukan admin -> 403 ADMIN_REQUIRED", ownerDeviceList.status === 403 && ownerDeviceList.json?.error === "ADMIN_REQUIRED", `${ownerDeviceList.status} ${short(ownerDeviceList.json)}`);
const adminDevices = await admin.call("GET", "/api/v1/admin/devices");
check("5c. admin melihat daftar perangkat seluruh platform", adminDevices.status === 200 && Array.isArray(adminDevices.json?.devices) && adminDevices.json.devices.some((entry: any) => entry.id === tabletDeviceId) && Number(adminDevices.json?.summary?.devices) >= 1,
  short({ status: adminDevices.status, jumlah: adminDevices.json?.devices?.length, ringkas: adminDevices.json?.summary }));
const blockReply = await admin.call("POST", `/api/v1/admin/devices/${tabletDeviceId}/block`, { reason: "Diblokir saat uji Wave 10" });
check("5d. admin memblokir perangkat", blockReply.status === 200 && Boolean(blockReply.json?.device?.blockedAt), `${blockReply.status} ${short(blockReply.json)}`);
const blockedLogin = await tablet2.call("POST", "/api/v1/auth/login", { email: ownerEmail, password });
check("5e. perangkat yang diblokir tidak bisa masuk (403 DEVICE_BLOCKED)", blockedLogin.status === 403 && blockedLogin.json?.error === "DEVICE_BLOCKED", `${blockedLogin.status} ${short(blockedLogin.json)}`);

// Gerbang perangkat baru: DEVICE_VERIFY_NEW=on. Uji modul + rute nyata, lalu saklar dikembalikan.
const gateReg = await gate.call("POST", "/api/v1/auth/register", { email: gateEmail, password, displayName: "Akun Gerbang" });
const gateUserId = String(gateReg.json?.user?.id ?? "");
check("6a. akun uji gerbang terdaftar", gateReg.status === 201 && Boolean(gateUserId), `${gateReg.status} ${short(gateReg.json)}`);
config.DEVICE_VERIFY_NEW = "on";
check("6b. saklar DEVICE_VERIFY_NEW=on membuat gerbang aktif (uji modul)", deviceMod.deviceVerifyRequired() === true, short(config.DEVICE_VERIFY_NEW));
const gateModule = deviceMod.checkDeviceGate(gateUserId, null);
check("6c. perangkat belum diverifikasi ditahan dengan DEVICE_NOT_VERIFIED", gateModule.required === true && gateModule.allowed === false && gateModule.error === "DEVICE_NOT_VERIFIED", short(gateModule));
const gateLogin = await gate.call("POST", "/api/v1/auth/login", { email: gateEmail, password });
const gateDeviceId = String(gateLogin.json?.device?.id ?? "");
check("6d. perangkat baru masuk dengan verified=false", gateLogin.status === 200 && Boolean(gateDeviceId) && gateLogin.json?.device?.verified === false && gateLogin.json?.device?.newDevice === true, short(gateLogin.json?.device));
const gateTokenRow = db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id=? AND kind='device_verify' AND used_at IS NULL").get(gateUserId) as { n: number };
check("6e. tautan verifikasi perangkat terbit (auth_tokens kind='device_verify')", Number(gateTokenRow.n) === 1, short(gateTokenRow));
const gateMail = db.prepare("SELECT body FROM email_outbox WHERE user_id=? AND kind='device' ORDER BY created_at DESC LIMIT 1").get(gateUserId) as { body: string } | undefined;
check("6f. surel peringatan perangkat masuk antrean (NOTIFY_EMAIL_ENABLED=false menahan pengiriman, bukan pembuatan)", Boolean(gateMail) && /\/perangkat\?token=/.test(String(gateMail?.body ?? "")), short({ ada: Boolean(gateMail), cocok: /\/perangkat\?token=/.test(String(gateMail?.body ?? "")) }));
const gateRawToken = String(/\/perangkat\?token=([A-Za-z0-9_-]+)/.exec(String(gateMail?.body ?? ""))?.[1] ?? "");
check("6g. token mentah hanya ada di tautan surel (yang disimpan hanya hash-nya)",
  gateRawToken.length > 20 && !db.prepare("SELECT 1 FROM auth_tokens WHERE token_hash=?").get(gateRawToken) && Boolean(db.prepare("SELECT 1 FROM auth_tokens WHERE token_hash=?").get(sessionDigest(gateRawToken))),
  short({ panjang: gateRawToken.length }));
const verifyReply = await gate.call("POST", "/api/v1/account/devices/verify", { token: gateRawToken });
check("6h. token verifikasi menandai perangkat terverifikasi", verifyReply.status === 200 && verifyReply.json?.verified === true && Boolean(verifyReply.json?.device?.verifiedAt),
  short({ status: verifyReply.status, device: verifyReply.json?.device }));
check("6i. user_devices.verified_at terisi untuk perangkat itu", Boolean((db.prepare("SELECT verified_at AS verifiedAt FROM user_devices WHERE id=?").get(gateDeviceId) as any)?.verifiedAt), short(db.prepare("SELECT verified_at AS verifiedAt FROM user_devices WHERE id=?").get(gateDeviceId)));
const verifyAgain = await gate.call("POST", "/api/v1/account/devices/verify", { token: gateRawToken });
check("6j. token sekali pakai: pemakaian kedua ditolak 400 INVALID_TOKEN", verifyAgain.status === 400 && verifyAgain.json?.error === "INVALID_TOKEN", `${verifyAgain.status} ${short(verifyAgain.json)}`);
check("6k. setelah diverifikasi gerbang membuka jalan (uji modul)", deviceMod.checkDeviceGate(gateUserId, gateDeviceId).allowed === true, short(deviceMod.checkDeviceGate(gateUserId, gateDeviceId)));
config.DEVICE_VERIFY_NEW = "off";
check("6l. saklar dikembalikan: gerbang nonaktif lagi", deviceMod.deviceVerifyRequired() === false && deviceMod.checkDeviceGate(gateUserId, null).allowed === true, short(config.DEVICE_VERIFY_NEW));

// Undangan: sidik perangkat yang sama memblokir hadiah.
await invitee.bootstrap();
const inviteeReg = await invitee.call("POST", "/api/v1/auth/register", { email: inviteeEmail, password, displayName: "Invitee Wave 10" });
const inviteeId = String(inviteeReg.json?.user?.id ?? "");
const ownerFingerprints = deviceMod.fingerprintsOf(ownerUserId);
check("7a. akun undangan terdaftar & sidik pemilik tersedia", inviteeReg.status === 201 && ownerFingerprints.length > 0, short({ status: inviteeReg.status, sidik: ownerFingerprints.length }));
if (ownerFingerprints.length > 0) deviceMod.registerDevice({ userId: inviteeId, fingerprint: ownerFingerprints[0], userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0) Safari/605.1.15", ip: "203.0.113.7" });
check("7b. invitee memakai sidik perangkat yang sama dengan pemilik", deviceMod.shareDevice(ownerUserId, inviteeId) === true, short(deviceMod.fingerprintsOf(inviteeId)));
const ownerCode = referralMod.ensureReferralCode(ownerUserId);
const attached = referralMod.attachReferral({ inviteeUserId: inviteeId, inviteeEmail: inviteeEmail, inviteeIp: "203.0.113.7", code: ownerCode });
const invitedRow = referralMod.referralEntryFor(inviteeId);
check("7c. undangan dari perangkat sama dicatat sebagai blocked/SAME_DEVICE", attached.ok === true && invitedRow?.status === "blocked" && invitedRow?.blockedReason === "SAME_DEVICE",
  short({ attached, row: { status: invitedRow?.status, reason: invitedRow?.blockedReason } }));
const blockedQualify = referralMod.qualifyReferralForRun(inviteeId);
check("7d. hadiah tidak dibayar walau run selesai (status blocked)", blockedQualify.status === "blocked" && blockedQualify.reason === "SAME_DEVICE", short(blockedQualify));
check("7e. baris tidak pernah diberi hadiah (inviter_tokens/invitee_tokens = 0)", Number((db.prepare("SELECT inviter_tokens AS a, invitee_tokens AS b FROM referrals WHERE invitee_user_id=?").get(inviteeId) as any)?.a) === 0 && Number((db.prepare("SELECT inviter_tokens AS a, invitee_tokens AS b FROM referrals WHERE invitee_user_id=?").get(inviteeId) as any)?.b) === 0,
  short(db.prepare("SELECT status, inviter_tokens AS a, invitee_tokens AS b FROM referrals WHERE invitee_user_id=?").get(inviteeId)));

// Undangan: hadiah menunggu email invitee terverifikasi.
await pending.bootstrap();
const pendingReg = await pending.call("POST", "/api/v1/auth/register", { email: pendingEmail, password, displayName: "Invitee Pending" });
const pendingId = String(pendingReg.json?.user?.id ?? "");
const inviteeCode = referralMod.ensureReferralCode(inviteeId);
const attachedPending = referralMod.attachReferral({ inviteeUserId: pendingId, inviteeEmail: pendingEmail, inviteeIp: "198.51.100.4", code: inviteeCode });
const pendingRow = referralMod.referralEntryFor(pendingId);
check("8a. undangan tanpa tanda perangkat/IP/email sama tercatat pending", pendingReg.status === 201 && attachedPending.ok === true && pendingRow?.status === "pending" && pendingRow?.blockedReason === null,
  short({ attached: attachedPending, row: { status: pendingRow?.status, reason: pendingRow?.blockedReason } }));
const emailVerified = Number((db.prepare("SELECT email_verified AS v FROM users WHERE id=?").get(pendingId) as any)?.v ?? 0);
const gateRequired = config.REFERRAL_REQUIRE_VERIFIED_EMAIL === true;
check("8b. syarat email terverifikasi aktif & email invitee masih 0", gateRequired && emailVerified === 0, short({ syarat: config.REFERRAL_REQUIRE_VERIFIED_EMAIL, emailVerified }));
const pendingQualify = referralMod.qualifyReferralForRun(pendingId);
check("8c. run selesai tanpa email terverifikasi -> tidak dibayar (EMAIL_NOT_VERIFIED)", pendingQualify.status === "none" && pendingQualify.reason === "EMAIL_NOT_VERIFIED", short(pendingQualify));
check("8d. baris undangan tetap pending, bukan qualified/rewarded", referralMod.referralEntryFor(pendingId)?.status === "pending", short(referralMod.referralEntryFor(pendingId)?.status));

// =====================================================================================
// Bagian C (butir 27, terkait 22): pembersihan data smoke — mode kering, batas akun,
// dan penghapusan yang benar-benar hanya menyentuh data akun smoke.
// =====================================================================================
console.log("\n--- Bagian C (butir 27/22): pembersihan data smoke ---");

const smokeReg = await smoke.call("POST", "/api/v1/auth/register", { email: smokeEmail, password, displayName: "Akun Smoke Wave 10" });
const smokeUserId = String(smokeReg.json?.user?.id ?? "");
const smokeWorkspaceId = String(smokeReg.json?.workspace?.id ?? "");
check("0a. akun smoke uji terdaftar", smokeReg.status === 201 && Boolean(smokeUserId && smokeWorkspaceId), `${smokeReg.status} ${short(smokeReg.json)}`);

const smokeProjectReply = await smoke.call("POST", `/api/v1/workspaces/${smokeWorkspaceId}/projects`, { name: "Proyek smoke Wave 10" });
const smokeProjectId = String(smokeProjectReply.json?.id ?? "");
check("0b. proyek milik akun smoke dibuat", smokeProjectReply.status === 201 && Boolean(smokeProjectId), `${smokeProjectReply.status} ${short(smokeProjectReply.json)}`);
const smokeConversationReply = await smoke.call("POST", `/api/v1/projects/${smokeProjectId}/conversations`, { title: "Percakapan smoke" });
const smokeConversationId = String(smokeConversationReply.json?.conversation?.id ?? "");
check("0c. percakapan smoke dibuat", smokeConversationReply.status === 201 && Boolean(smokeConversationId), `${smokeConversationReply.status} ${short(smokeConversationReply.json)}`);
const smokeMessageReply = await smoke.call("POST", `/api/v1/conversations/${smokeConversationId}/messages`, { content: "Pesan smoke untuk membersihkan data uji." });
check("0d. pesan smoke membuat run (data nyata, bukan tiruan)", smokeMessageReply.status === 202 && Boolean(smokeMessageReply.json?.run?.id), `${smokeMessageReply.status} ${short(smokeMessageReply.json)}`);
const smokeArtifactReply = await smoke.call("POST", `/api/v1/projects/${smokeProjectId}/artifacts`, { name: "smoke.txt", mimeType: "text/plain", contentBase64: Buffer.from("berkas uji smoke").toString("base64") });
const smokeArtifactId = String(smokeArtifactReply.json?.id ?? "");
const smokeArtifactPath = String((db.prepare("SELECT storage_path AS p FROM artifacts WHERE id=?").get(smokeArtifactId) as any)?.p ?? "");
check("0e. artefak kecil diunggah dan berkasnya ada di disk", smokeArtifactReply.status === 201 && existsSync(smokeArtifactPath), `${smokeArtifactReply.status} ${short({ id: smokeArtifactId, ada: existsSync(smokeArtifactPath) })}`);

// Akun lain, supaya bisa dibuktikan datanya TIDAK tersentuh.
await green.bootstrap();
const greenReg = await green.call("POST", "/api/v1/auth/register", { email: greenEmail, password, displayName: "Akun Lain" });
const greenWorkspaceId = String(greenReg.json?.workspace?.id ?? "");
const greenProjectReply = await green.call("POST", `/api/v1/workspaces/${greenWorkspaceId}/projects`, { name: "Proyek akun lain" });
const greenProjectId = String(greenProjectReply.json?.id ?? "");
const greenArtifactReply = await green.call("POST", `/api/v1/projects/${greenProjectId}/artifacts`, { name: "green.txt", mimeType: "text/plain", contentBase64: Buffer.from("berkas akun lain").toString("base64") });
const greenArtifactPath = String((db.prepare("SELECT storage_path AS p FROM artifacts WHERE id=?").get(String(greenArtifactReply.json?.id ?? "")) as any)?.p ?? "");
check("0f. akun lain punya proyek + artefak sendiri", greenReg.status === 201 && greenProjectReply.status === 201 && existsSync(greenArtifactPath), short({ status: greenProjectReply.status, ada: existsSync(greenArtifactPath) }));

const countsSnapshot = () => ({
  projects: tableCount("SELECT COUNT(*) AS n FROM projects"),
  messages: tableCount("SELECT COUNT(*) AS n FROM messages"),
  runs: tableCount("SELECT COUNT(*) AS n FROM runs"),
  artifacts: tableCount("SELECT COUNT(*) AS n FROM artifacts"),
  notifications: tableCount("SELECT COUNT(*) AS n FROM notifications"),
});
const countsBefore = countsSnapshot();

const dryRunReply = await admin.call("POST", "/api/v1/admin/smoke/cleanup", { dryRun: true });
const dryReport = dryRunReply.json?.report;
check("1a. mode kering menyebut akun smoke yang benar", dryRunReply.status === 200 && dryReport?.email === smokeEmail && dryReport?.userFound === true && dryReport?.dryRun === true, `${dryRunReply.status} ${short(dryReport)}`);
check("1b. mode kering melaporkan proyek akun smoke", Array.isArray(dryReport?.projects) && dryReport.projects.includes(smokeProjectId), short(dryReport?.projects));
check("1c. mode kering melaporkan jumlah baris nyata (pesan, run, artefak, notifikasi)",
  Number(dryReport?.rows?.messages) >= 2 && Number(dryReport?.rows?.runs) >= 1 && Number(dryReport?.rows?.artifacts) >= 1 && Number(dryReport?.rows?.notifications) >= 1,
  short(dryReport?.rows));
check("1d. mode kering tidak menghapus apa pun (jumlah tabel tidak berubah)", JSON.stringify(countsSnapshot()) === JSON.stringify(countsBefore), short({ sebelum: countsBefore, sesudah: countsSnapshot() }));
check("1e. berkas artefak masih ada setelah mode kering", existsSync(smokeArtifactPath), short(existsSync(smokeArtifactPath)));

const adminTargetReply = await admin.call("POST", "/api/v1/admin/smoke/cleanup", { dryRun: false, email: adminEmail });
check("4. akun admin ditolak: SMOKE_ACCOUNT_IS_ADMIN dan tidak ada yang dihapus",
  adminTargetReply.status === 200 && adminTargetReply.json?.report?.skipped === "SMOKE_ACCOUNT_IS_ADMIN" && adminTargetReply.json?.report?.projects?.length === 0,
  short(adminTargetReply.json?.report));
check("4b. penolakan itu tidak menghapus data (jumlah tabel tetap)", JSON.stringify(countsSnapshot()) === JSON.stringify(countsBefore), short({ sebelum: countsBefore, sesudah: countsSnapshot() }));

const ownerSmokeReply = await owner.call("POST", "/api/v1/admin/smoke/cleanup", { dryRun: false });
check("5. bukan admin -> 403 ADMIN_REQUIRED", ownerSmokeReply.status === 403 && ownerSmokeReply.json?.error === "ADMIN_REQUIRED", `${ownerSmokeReply.status} ${short(ownerSmokeReply.json)}`);

const runReply = await admin.call("POST", "/api/v1/admin/smoke/cleanup", { dryRun: false });
const runReport = runReply.json?.report;
const countsAfter = countsSnapshot();
check("2a. penghapusan nyata memakai daftar proyek yang sama", runReply.status === 200 && Array.isArray(runReport?.projects) && runReport.projects.includes(smokeProjectId), `${runReply.status} ${short(runReport)}`);
check("2b. baris proyek akun smoke hilang dari basis data", tableCount("SELECT COUNT(*) AS n FROM projects WHERE id=?", smokeProjectId) === 0, short(tableCount("SELECT COUNT(*) AS n FROM projects WHERE id=?", smokeProjectId)));
check("2c. baris percakapan/pesan/run/artefak akun smoke ikut hilang",
  tableCount("SELECT COUNT(*) AS n FROM conversations WHERE project_id=?", smokeProjectId) === 0
  && tableCount("SELECT COUNT(*) AS n FROM runs WHERE project_id=?", smokeProjectId) === 0
  && tableCount("SELECT COUNT(*) AS n FROM artifacts WHERE project_id=?", smokeProjectId) === 0, short({ proyek: smokeProjectId }));
check("2d. berkas artefak akun smoke benar-benar dihapus dari disk", !existsSync(smokeArtifactPath), short({ jalan: smokeArtifactPath, ada: existsSync(smokeArtifactPath) }));
check("2e. notifikasi milik workspace smoke ikut dibersihkan", tableCount("SELECT COUNT(*) AS n FROM notifications WHERE workspace_id=?", smokeWorkspaceId) === 0, short(tableCount("SELECT COUNT(*) AS n FROM notifications WHERE workspace_id=?", smokeWorkspaceId)));
check("2f. jumlah tabel turun (pesan & artefak berkurang)", countsAfter.messages < countsBefore.messages && countsAfter.artifacts < countsBefore.artifacts && countsAfter.projects < countsBefore.projects,
  short({ sebelum: countsBefore, sesudah: countsAfter }));
check("2g. laporan menyebut artefak & pesan yang dihapus", Number(runReport?.artifactsRemoved) >= 1 && Number(runReport?.messagesRemoved) >= 2 && Number(runReport?.filesRemoved) >= 1, short(runReport));
check("2h. akun smoke sendiri tetap ada (hanya datanya yang dibersihkan)", tableCount("SELECT COUNT(*) AS n FROM users WHERE id=?", smokeUserId) === 1, short(tableCount("SELECT COUNT(*) AS n FROM users WHERE id=?", smokeUserId)));
check("2i. jejak audit pembersihan tercatat", tableCount("SELECT COUNT(*) AS n FROM audit_events WHERE action='smoke.cleanup.ran'") >= 1, short(tableCount("SELECT COUNT(*) AS n FROM audit_events WHERE action='smoke.cleanup.ran'")));

check("3. data akun lain tidak tersentuh: proyeknya masih ada", tableCount("SELECT COUNT(*) AS n FROM projects WHERE id=?", greenProjectId) === 1, short(tableCount("SELECT COUNT(*) AS n FROM projects WHERE id=?", greenProjectId)));
check("3b. artefak akun lain masih ada di disk", existsSync(greenArtifactPath), short({ jalan: greenArtifactPath, ada: existsSync(greenArtifactPath) }));
check("3c. arti 'hanya data smoke': laporan tidak menyebut proyek akun lain", !(runReport?.projects ?? []).includes(greenProjectId), short(runReport?.projects));

// =====================================================================================
// Bagian D (butir 28): halaman metrik — teks untuk pemantau, JSON untuk admin.
// =====================================================================================
console.log("\n--- Bagian D (butir 28): metrik ---");

const metricsAnonymous = await raw("GET", "/api/v1/metrics");
check("1a. tanpa token halaman metrik menyembunyikan diri (404)", metricsAnonymous.status === 404, `${metricsAnonymous.status} ${short(metricsAnonymous.json)}`);
const metricsWrongToken = await raw("GET", "/api/v1/metrics", { authorization: "Bearer token-salah" });
check("1b. token salah tetap 404", metricsWrongToken.status === 404, `${metricsWrongToken.status} ${short(metricsWrongToken.json)}`);
const metricsBearer = await raw("GET", "/api/v1/metrics", { authorization: `Bearer ${metricsToken}` });
const metricNames = String(metricsBearer.text ?? "").split("\n").map((line) => line.split(" ")[0].trim()).filter(Boolean);
check("1c. token benar -> 200 text/plain", metricsBearer.status === 200 && String(metricsBearer.headers.get("content-type") ?? "").includes("text/plain"), `${metricsBearer.status} ${short(metricsBearer.headers.get("content-type"))}`);
check("1d. tiap baris eksposisi berformat benar (nama nilai, label hanya di coblai_info)",
  metricNames.length > 10 && String(metricsBearer.text).split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).every((line) => line.includes("{") ? /^[a-z0-9_]+\{[^}]*\}\s-?\d+(\.\d+)?$/.test(line) : /^[a-z0-9_]+\s-?\d+(\.\d+)?$/.test(line)),
  short(String(metricsBearer.text).split("\n").slice(0, 4)));
const namedLines = ["coblai_runs_total", "coblai_devices_total", "coblai_push_subscriptions_active"].filter((name) => metricNames.includes(name));
check("1e. nama baris yang dituntut spesifikasi ada (runs/devices/push)", namedLines.length === 3, short({ ada: namedLines, hilang: ["coblai_runs_total", "coblai_devices_total", "coblai_push_subscriptions_active"].filter((name) => !metricNames.includes(name)) }));
check("1f. baris coblai_schema_version ada dan bernilai sama dengan versi skema",
  metricNames.includes("coblai_schema_version") && Number(/^coblai_schema_version\s+(\d+)$/m.exec(String(metricsBearer.text))?.[1]) === SCHEMA_VERSION,
  short(String(metricsBearer.text).split("\n").find((line) => line.startsWith("coblai_schema_version"))));
check("1g. versi skema tetap terbaca dari label coblai_info", /coblai_info\{[^}]*schema="(\d+)"/.test(String(metricsBearer.text)) && Number(/coblai_info\{[^}]*schema="(\d+)"/.exec(String(metricsBearer.text))?.[1]) === SCHEMA_VERSION,
  short(String(metricsBearer.text).split("\n").find((line) => line.startsWith("coblai_info"))));
const metricsUptime = String(metricsBearer.text).split("\n").find((line) => line.startsWith("coblai_uptime_seconds"));
check("1h. uptime disebut sebagai detik", /^coblai_uptime_seconds \d+$/.test(String(metricsUptime ?? "")), short(metricsUptime));
const metricsQueryToken = await raw("GET", `/api/v1/metrics?token=${metricsToken}`);
check("1i. token lewat parameter ?token= juga diterima", metricsQueryToken.status === 200 && String(metricsQueryToken.text).split("\n")[0] === String(metricsBearer.text).split("\n")[0] && String(metricsQueryToken.text).split("\n").length === String(metricsBearer.text).split("\n").length, `${metricsQueryToken.status}`);

const adminMetrics = await admin.call("GET", "/api/v1/admin/metrics");
check("2a. admin membaca /api/v1/admin/metrics", adminMetrics.status === 200 && typeof adminMetrics.json?.numbers === "object", `${adminMetrics.status} ${short(Object.keys(adminMetrics.json ?? {}))}`);
check("2b. versi skema = 18 (dari tabel migrasi)", Number(adminMetrics.json?.schemaVersion) === SCHEMA_VERSION && Number(adminMetrics.json?.schemaVersion) === 18, short(adminMetrics.json?.schemaVersion));
const liveNumbers = adminMetrics.json?.numbers ?? {};
check("2c. angka cocok dengan hitungan tabel langsung",
  Number(liveNumbers.users_total) === tableCount("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL")
  && Number(liveNumbers.projects_total) === tableCount("SELECT COUNT(*) AS n FROM projects")
  && Number(liveNumbers.messages_total) === tableCount("SELECT COUNT(*) AS n FROM messages")
  && Number(liveNumbers.devices_total) === tableCount("SELECT COUNT(*) AS n FROM user_devices")
  && Number(liveNumbers.push_subscriptions_active) === tableCount("SELECT COUNT(*) AS n FROM push_subscriptions WHERE active=1"),
  short({ metrik: { users: liveNumbers.users_total, projects: liveNumbers.projects_total, messages: liveNumbers.messages_total, devices: liveNumbers.devices_total, push: liveNumbers.push_subscriptions_active },
    tabel: { users: tableCount("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL"), projects: tableCount("SELECT COUNT(*) AS n FROM projects"), messages: tableCount("SELECT COUNT(*) AS n FROM messages"), devices: tableCount("SELECT COUNT(*) AS n FROM user_devices") } }));
check("2d. token terkonfigurasi dilaporkan pada JSON admin", adminMetrics.json?.tokenConfigured === true, short(adminMetrics.json?.tokenConfigured));
check("2e. JSON admin memuat bagian pekerjaan, push, perangkat, dan retensi",
  typeof adminMetrics.json?.jobs === "object" && typeof adminMetrics.json?.push === "object" && typeof adminMetrics.json?.devices === "object" && Number(adminMetrics.json?.retention?.smokeHours) === config.SMOKE_CLEANUP_HOURS,
  short({ jobs: Object.keys(adminMetrics.json?.jobs ?? {}), push: Object.keys(adminMetrics.json?.push ?? {}), retensi: adminMetrics.json?.retention }));
const ownerMetrics = await owner.call("GET", "/api/v1/admin/metrics");
check("2f. bukan admin -> 403 ADMIN_REQUIRED", ownerMetrics.status === 403 && ownerMetrics.json?.error === "ADMIN_REQUIRED", `${ownerMetrics.status} ${short(ownerMetrics.json)}`);

// =====================================================================================
// Bagian E (butir 31): notifikasi peramban — kunci VAPID, batas, hapus, dan kirim uji.
// =====================================================================================
console.log("\n--- Bagian E (butir 31): notifikasi peramban ---");

const pushPage = await owner.call("GET", "/api/v1/account/push");
check("1a. halaman push menyajikan kunci publik VAPID", pushPage.status === 200 && pushPage.json?.enabled === true && /^[A-Za-z0-9_-]{80,}$/.test(String(pushPage.json?.publicKey ?? "")),
  short({ status: pushPage.status, enabled: pushPage.json?.enabled, panjangKunci: String(pushPage.json?.publicKey ?? "").length }));
check("1b. halaman push tidak membocorkan kunci pribadi", !Object.keys(pushPage.json ?? {}).includes("privateKey") && !JSON.stringify(pushPage.json ?? {}).includes("privateKey"),
  short(Object.keys(pushPage.json ?? {})));
check("1c. batas per akun = PUSH_MAX_PER_USER (2 saat uji)", Number(pushPage.json?.max) === config.PUSH_MAX_PER_USER && config.PUSH_MAX_PER_USER === 2, short(pushPage.json?.max));
check("1d. push siap di server (kunci VAPID terpasang)", pushMod.pushConfigured() === true && pushMod.pushStats().configured === true, short(pushMod.pushStats()));

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const p256dh = ecdh.getPublicKey().toString("base64url");
const authSecret = randomBytes(16).toString("base64url");
const badSubscribe = await owner.call("POST", "/api/v1/account/push/subscribe", { endpoint: "http://bukan-https.example/push/1", keys: { p256dh, auth: authSecret } });
check("2a. endpoint bukan https ditolak 400 INVALID_SUBSCRIPTION", badSubscribe.status === 400 && badSubscribe.json?.error === "INVALID_SUBSCRIPTION", `${badSubscribe.status} ${short(badSubscribe.json)}`);
const emptyKeysSubscribe = await owner.call("POST", "/api/v1/account/push/subscribe", { endpoint: "https://contoh.example/push/1" });
check("2b. langganan tanpa kunci ditolak 400", emptyKeysSubscribe.status === 400 && emptyKeysSubscribe.json?.error === "INVALID_SUBSCRIPTION", `${emptyKeysSubscribe.status} ${short(emptyKeysSubscribe.json)}`);

const subscribeOne = await owner.call("POST", "/api/v1/account/push/subscribe", { endpoint: "https://w10-satu.example/push/1", keys: { p256dh, auth: authSecret } });
const subOneId = String(subscribeOne.json?.subscription?.id ?? "");
check("3a. langganan pertama tersimpan (201)", subscribeOne.status === 201 && Boolean(subOneId) && subscribeOne.json?.subscription?.active === 1, `${subscribeOne.status} ${short(subscribeOne.json)}`);
const subscribeTwo = await owner.call("POST", "/api/v1/account/push/subscribe", { endpoint: "https://w10-dua.example/push/2", keys: { p256dh, auth: authSecret } });
const subTwoId = String(subscribeTwo.json?.subscription?.id ?? "");
check("3b. langganan kedua tersimpan (201)", subscribeTwo.status === 201 && Boolean(subTwoId), `${subscribeTwo.status} ${short(subscribeTwo.json)}`);
const subscribeThree = await owner.call("POST", "/api/v1/account/push/subscribe", { endpoint: "https://w10-tiga.example/push/3", keys: { p256dh, auth: authSecret } });
check("3c. langganan ketiga ditolak 409 TOO_MANY_SUBSCRIPTIONS", subscribeThree.status === 409 && subscribeThree.json?.error === "TOO_MANY_SUBSCRIPTIONS", `${subscribeThree.status} ${short(subscribeThree.json)}`);
check("3d. daftar langganan berisi keduanya", tableCount("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?", ownerUserId) === 2, short(tableCount("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?", ownerUserId)));

const removeReply = await owner.call("DELETE", `/api/v1/account/push/subscriptions/${subTwoId}`);
check("4a. langganan bisa dihapus", removeReply.status === 200 && removeReply.json?.removed === true, `${removeReply.status} ${short(removeReply.json)}`);
const pushPageAfter = await owner.call("GET", "/api/v1/account/push");
check("4b. langganan yang dihapus hilang dari daftar", !(pushPageAfter.json?.subscriptions ?? []).some((item: any) => item.id === subTwoId) && (pushPageAfter.json?.subscriptions ?? []).length === 1,
  short(pushPageAfter.json?.subscriptions));
const removeUnknown = await owner.call("DELETE", "/api/v1/account/push/subscriptions/langganan-tidak-ada");
check("4c. langganan yang tidak ada -> 404 SUBSCRIPTION_NOT_FOUND", removeUnknown.status === 404 && removeUnknown.json?.error === "SUBSCRIPTION_NOT_FOUND", `${removeUnknown.status} ${short(removeUnknown.json)}`);

// Kirim uji ke titik akhir yang tidak bisa dijangkau: harus gagal tanpa mematikan langganan.
const pushTest = await owner.call("POST", "/api/v1/account/push/test");
const pushReport = pushTest.json?.report;
check("5a. kirim uji melaporkan percobaan ke langganan aktif", pushTest.status === 200 && Number(pushReport?.subscriptions) === 1 && Number(pushReport?.failed) >= 1, `${pushTest.status} ${short(pushReport)}`);
check("5b. langganan yang gagal tetap aktif (bukan 404/410)", Number(pushReport?.disabled) === 0 && Number((db.prepare("SELECT active FROM push_subscriptions WHERE id=?").get(subOneId) as any)?.active) === 1, short({ report: pushReport, aktif: (db.prepare("SELECT active, failures FROM push_subscriptions WHERE id=?").get(subOneId) as any) }));
check("5c. kegagalan tercatat pada baris langganan (failures > 0)", Number((db.prepare("SELECT failures FROM push_subscriptions WHERE id=?").get(subOneId) as any)?.failures) > 0, short(db.prepare("SELECT failures, last_error AS lastError FROM push_subscriptions WHERE id=?").get(subOneId)));
check("5d. notifikasi dalam aplikasi memanggil push hanya bila siap", pushMod.pushConfigured() === Boolean(config.PUSH_ENABLED), short({ enabled: config.PUSH_ENABLED, configured: pushMod.pushConfigured() }));

// Saklar platform dimatikan: rute menolak, dan kunci yang tersimpan tidak hilang.
const endpointPaused = "https://w10-pause.example/push/9";
config.PUSH_ENABLED = false;
const subscribeDisabled = await owner.call("POST", "/api/v1/account/push/subscribe", { endpoint: endpointPaused, keys: { p256dh, auth: authSecret } });
check("6a. PUSH_ENABLED=false -> rute langganan menjawab 409 PUSH_DISABLED", subscribeDisabled.status === 409 && subscribeDisabled.json?.error === "PUSH_DISABLED", `${subscribeDisabled.status} ${short(subscribeDisabled.json)}`);
const storedVapid = db.prepare("SELECT value FROM platform_settings WHERE key='web_push'").get() as { value: string } | undefined;
const parsedVapid = storedVapid ? JSON.parse(storedVapid.value) as { publicKey?: string; privateKey?: string; createdAt?: string } : {};
check("6b. kunci VAPID tersimpan di platform_settings (dengan kunci pribadi, tidak ditampilkan)",
  Boolean(parsedVapid.publicKey && parsedVapid.privateKey) && String(parsedVapid.publicKey).length > 80 && String(parsedVapid.privateKey).length > 20 && Boolean(parsedVapid.createdAt),
  short({ kunciPublik: String(parsedVapid.publicKey ?? "").length, kunciPribadi: String(parsedVapid.privateKey ?? "").length, dibuat: parsedVapid.createdAt }));
const pushStatsDisabled = pushMod.pushStats();
// Dua fakta yang berbeda: kunci siap DAN kanal dihidupkan. Saat saklar mati, kuncinya tetap ada,
// jadi laporannya `configured: true, enabled: false` — bukan `configured: false` yang menyesatkan.
check("6c. pushStats().configured tetap true walau PUSH_ENABLED=false", pushStatsDisabled.configured === true && pushStatsDisabled.enabled === false, short(pushStatsDisabled));
const sendDisabledReport = await pushMod.sendPushToUser(ownerUserId, { title: "Uji saklar", body: "Tidak boleh terkirim.", link: "/", kind: "system" });
check("6d. pengiriman push saat dimatikan berhenti dengan sebab PUSH_DISABLED", sendDisabledReport.configured === false && sendDisabledReport.skipped === "PUSH_DISABLED" && sendDisabledReport.sent === 0,
  short(sendDisabledReport));
config.PUSH_ENABLED = true;
check("6e. saklar dikembalikan: push siap lagi", pushMod.pushConfigured() === true, short(pushMod.pushStats().configured));

// =====================================================================================
// Bagian F: status-hub memuat kunci baru Wave 10.
// =====================================================================================
console.log("\n--- Bagian F: status-hub ---");
const hub = await owner.call("GET", "/api/v1/status-hub");
check("1. status-hub terbaca pemilik", hub.status === 200 && typeof hub.json === "object", `${hub.status} ${short(hub.json)}`);
check("2. status-hub memuat bagian search, push, dan devices", typeof hub.json?.search === "object" && typeof hub.json?.push === "object" && typeof hub.json?.devices === "object",
  short({ search: Object.keys(hub.json?.search ?? {}), push: Object.keys(hub.json?.push ?? {}), devices: Object.keys(hub.json?.devices ?? {}) }));
check("3. housekeeping menyebut pekerjaan berjalan yang menahan token", typeof hub.json?.housekeeping?.reservedTokensWaiting === "number" && hub.json?.housekeeping?.reservedTokensWaiting >= 0,
  short(hub.json?.housekeeping));
check("4. pembersihan smoke diumumkan apa adanya (mati secara bawaan)", typeof hub.json?.housekeeping?.smokeCleanup === "boolean" && Number(hub.json?.housekeeping?.smokeHours) === config.SMOKE_CLEANUP_HOURS,
  short(hub.json?.housekeeping));
const growthSources = hub.json?.openPlatform?.growthSources;
check("5. sumber pertumbuhan dilaporkan terbuka", Array.isArray(growthSources) && growthSources.length >= 1 && growthSources.every((entry: any) => typeof entry.source === "string" && typeof entry.events === "number"),
  short({ sumber: growthSources?.map((entry: any) => `${entry.source}:${entry.events}`), catatan: "sumber nyata, bukan angka tunggal" }));
check("6. status-hub menyebut aturan CSRF yang sedang aktif", typeof hub.json?.security?.csrfStrict === "boolean" && hub.json?.security?.csrfStrict === config.CSRF_STRICT, short(hub.json?.security));

// =====================================================================================
// Ringkasan.
// =====================================================================================
console.log("");
if (skipped.length) {
  console.log(`SKIP ${skipped.length} pemeriksaan:`);
  for (const entry of skipped) console.log(`  - ${entry}`);
} else {
  console.log("Tidak ada pemeriksaan yang di-skip.");
}
if (failedNames.length) {
  console.log(`GAGAL ${failed} pemeriksaan:`);
  for (const name of failedNames) console.log(`  - ${name}`);
}
const total = passed + failed;
console.log(`${passed}/${total} lulus`);
console.log(`INFO durasi uji ${Math.round((Date.now() - startedAtMs) / 1000)} detik, data uji di ${dataDir}`);
process.exit(failed === 0 ? 0 : 1);

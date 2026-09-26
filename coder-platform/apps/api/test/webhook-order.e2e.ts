/**
 * Uji Wave 10 (butir 23): urutan pengiriman webhook.
 *
 * Yang dibuktikan:
 *  1) skema memuat `webhook_deliveries.sequence`, `resend_of`, `deferrals`; setiap kiriman baru
 *     mendapat posisi NAIK dari `nextSequence`, dan kiriman biasa punya `resend_of` NULL;
 *  2) penerima lokal yang MENAHAN permintaan pertama: kiriman kedua yang datang lebih awal TIDAK
 *     dikirim selagi yang pertama belum selesai (`deliverWebhook` membalas `deferred`, baris tetap
 *     `queued`, `deferrals` naik, dan ada pekerjaan `webhook.deliver` dengan dedupe `defer:`);
 *     sesudah yang pertama selesai, kiriman kedua terkirim dan penerima menerima keduanya DALAM
 *     URUTAN sequence (`x-coblai-sequence` naik);
 *  3) batas kesabaran: setelah `MAX_ORDER_DEFERRALS` penundaan, kiriman tetap dikirim walau
 *     pendahulunya masih macet, `last_error` menyebut pengiriman di luar urutan, dan header
 *     `x-coblai-sequence` tetap dikirim;
 *  4) `POST /api/v1/webhooks/:id/test` selalu mengirim SEGERA (opsi `{ force: true }`);
 *  5) tombol kirim ulang membuat baris BARU (`resend_of` = id asal, sequence lebih besar, awal
 *     `queued`) dan baris asal TIDAK berubah; peran viewer ditolak 403;
 *  6) `DELETE /api/v1/webhooks/:id/deliveries` (mode kering) hanya menghitung baris `delivered`/
 *     `failed` yang lebih tua dari batas hari, tidak menyentuh baris `queued`, lalu jalur sungguhan
 *     menghapus baris lama dan menyisakan baris `queued`;
 *  7) `cleanupWebhookDeliveries({ dryRun: true })` melaporkan `candidates` yang sama dengan rute;
 *  8) `webhookStats()` memuat `deferred` dan `oldestQueuedAt`.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/webhook-order.e2e.ts
 */

import http from "node:http";

const port = 7160 + Math.floor(Math.random() * 20); // rentang khusus 7160-7179
const hookPort = port + 120;                          // penerima webhook lokal uji ini
const dataDir = `/tmp/coder-wave10-order-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const ownerEmail = `w10b-owner-${stamp}@example.test`;
const viewerEmail = `w10b-viewer-${stamp}@example.test`;
const adminEmail = `w10b-admin-${stamp}@example.test`;
const password = "SandiUji2026!aman";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave10-order-test-model";
process.env.NOTIFY_EMAIL_ENABLED = "false";
// Penerima webhook lokal hanya boleh saat flag ini hidup.
process.env.WEBHOOK_ALLOW_LOCAL = "true";
process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = "2000";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RETENTION_ENABLED = "false";
process.env.RETENTION_WEBHOOK_DAYS = "30";
// Selang pekerja sangat panjang: hanya putaran yang dipanggil uji ini yang berjalan.
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
// Antrean bukan milik proses web. Bawaan kode adalah JOB_WORKER_IN_WEB=true (nyaman untuk
// pengembangan), jadi uji ini harus mematikannya secara tegas: kalau tidak, proses web ikut
// memutar antrean dan berlomba dengan pengiriman langsung yang dijalankan uji ini.
process.env.JOB_WORKER_IN_WEB = "false";
process.env.JOB_BATCH_SIZE = "20";
process.env.WEBHOOK_MAX_PER_WORKSPACE = "6";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "100";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "100";

await import("../src/server.js");
const hookMod: any = await import("../src/webhooks.js");
const jobsMod: any = await import("../src/jobs.js");
const { db } = await import("../src/db.js");

const base = `http://127.0.0.1:${port}`;
const hookBase = `http://127.0.0.1:${hookPort}`;

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
function short(value: unknown, limit = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(condition: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (condition()) return true; await sleep(stepMs); }
  return condition();
}

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
  };
}

type Hit = { path: string; event: string; sequence: string; delivery: string; timestamp: string; signature: string; body: any };
/** Penerima webhook: satu proses kecil di dalam uji ini, jadi tidak ada kiriman ke internet. */
function receiver() {
  const hits: Hit[] = [];
  const sockets = new Set<any>();
  let holdNext = 0;
  let release: (() => void) | null = null;
  const server = http.createServer((request: any, response: any) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const path = String(request.url ?? "");
      hits.push({
        path, event: String(request.headers["x-coblai-event"] ?? ""),
        sequence: String(request.headers["x-coblai-sequence"] ?? ""), delivery: String(request.headers["x-coblai-delivery"] ?? ""),
        timestamp: String(request.headers["x-coblai-timestamp"] ?? ""), signature: String(request.headers["x-coblai-signature"] ?? ""), body,
      });
      // Permintaan yang ditahan: jawaban baru dikirim setelah uji memanggil release(). Papan pengaman
      // 1500 ms menjaga agar batas waktu pengiriman (2000 ms) tidak pecah walau uji gagal di tengah.
      if (holdNext > 0 && path.includes("/hold")) {
        holdNext -= 1;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          release = () => { clearTimeout(timer); resolve(); };
        });
        release = null;
      }
      response.statusCode = 200;
      response.end("{\"ok\":true}");
    });
  });
  server.on("connection", (socket: any) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  return {
    hits, server,
    listen: () => new Promise<void>((resolve) => server.listen(hookPort, "127.0.0.1", () => resolve())),
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
    holdNext: (count: number) => { holdNext = count; },
    release: () => { release?.(); },
    of: (part: string) => hits.filter((hit) => hit.path.includes(part)),
  };
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { await response.arrayBuffer(); return; } } catch { /* belum siap */ }
    await sleep(250);
  }
  throw new Error("server tidak siap");
}

const hooks = receiver();
await hooks.listen();
await waitForHealth();
// Wave 9 memindahkan antrean ke proses pekerja sendiri, jadi proses web ini memang TIDAK menjalankan
// putaran pekerjaan (cyclesRun tetap 0) dan tidak ada yang berlomba dengan pekerjaan uji ini.
// Karena itu uji ini memanggil `deliverWebhook` langsung, sama seperti yang dilakukan pekerja.
check("0) proses web tidak memegang antrean, jadi uji ini menggerakkan pengiriman langsung",
  jobsMod.jobWorkerState().running === false, short(jobsMod.jobWorkerState()));

const owner = client();
const viewer = client();
const registered = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Wave 10B" });
check("0) akun pemilik terdaftar", registered.status === 200 || registered.status === 201, short(registered.json));
const workspaces = await owner.call("GET", "/api/v1/workspaces");
const workspaceId = String((workspaces.json ?? [])[0]?.id ?? "");
check("0) ruang kerja pemilik terbaca", Boolean(workspaceId), short(workspaces.json));
const project = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: `Proyek Wave 10B ${stamp}` });
const projectId = String(project.json?.project?.id ?? project.json?.id ?? "");
check("0) proyek uji dibuat", Boolean(projectId), short(project.json));

const deliveryRows = (webhookId: string) => db.prepare("SELECT id, status, sequence, deferrals, resend_of AS resendOf FROM webhook_deliveries WHERE webhook_id=? ORDER BY COALESCE(sequence,0) ASC").all(webhookId) as any[];
const jobRow = (dedupe: string) => db.prepare("SELECT id, kind, status, dedupe_key AS dedupeKey, run_after AS runAfter FROM jobs WHERE dedupe_key=?").get(dedupe) as any;
const jobLike = (pattern: string) => db.prepare("SELECT id, kind, status, dedupe_key AS dedupeKey, run_after AS runAfter FROM jobs WHERE dedupe_key LIKE ?").get(pattern) as any;

/* ------------------------------ 1) bentuk skema dan posisi urutan ------------------------------ */

const deliveryColumns = (db.prepare("PRAGMA table_info(webhook_deliveries)").all() as any[]).map((row) => String(row.name));
check("1) kolom sequence ada di webhook_deliveries", deliveryColumns.includes("sequence"), short(deliveryColumns));
check("1) kolom resend_of ada di webhook_deliveries", deliveryColumns.includes("resend_of"), short(deliveryColumns));
check("1) kolom deferrals ada di webhook_deliveries", deliveryColumns.includes("deferrals"), short(deliveryColumns));
const orderIndex = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_webhook_deliveries_order'").get() as any;
check("1) indeks idx_webhook_deliveries_order ada", orderIndex?.name === "idx_webhook_deliveries_order", short(orderIndex));

/** Penerima yang menahan permintaan pertama hidup di jalur /hold. */
const holdHook = await owner.call("POST", "/api/v1/webhooks", { url: `${hookBase}/hold`, events: ["run.completed"], description: "penahan uji" });
const holdHookId = String(holdHook.json?.webhook?.id ?? "");
check("1) webhook penerima penahan dibuat (201)", holdHook.status === 201 && Boolean(holdHookId), short(holdHook.json));

// Peristiwa pertama (jalur peristiwa nyata yang dipakai run).
const emittedFirst = hookMod.emitProjectEvent(projectId, "run.completed", { runId: `run-1-${stamp}`, conversationId: `conv-1-${stamp}` });
check("1) peristiwa run.completed pertama mengantre satu kiriman", Number(emittedFirst?.enqueued) === 1, short(emittedFirst));
await waitFor(() => deliveryRows(holdHookId).length >= 1, 4000, 50);
const firstRows = deliveryRows(holdHookId);
const d1 = firstRows[firstRows.length - 1];
check("1) peristiwa run.completed membuat satu baris pengiriman", Boolean(d1?.id), short(firstRows));
check("1) nextSequence memberi posisi berikutnya setelah baris terakhir", hookMod.nextSequence(holdHookId) === Number(d1?.sequence) + 1, short({ next: hookMod.nextSequence(holdHookId), current: d1?.sequence }));
check("1) pengiriman biasa punya resend_of NULL", d1?.resendOf === null, short(d1));

/* ------------------------------ 2) kiriman kedua menunggu urutan ------------------------------ */

/* Permintaan pertama ditahan sampai uji memanggil release(). */
hooks.holdNext(1);
const pendingFirst: Promise<any> = hookMod.deliverWebhook(d1.id).catch((error: unknown) => ({ status: "threw", error: String(error) }));
check("2) penerima benar-benar menahan permintaan pertama", await waitFor(() => hooks.of("/hold").length >= 1, 3000, 25), short(hooks.of("/hold").length));
check("2) kiriman pertama masih queued selagi ditahan", String(hookMod.getDelivery(d1.id)?.status) === "queued", short(hookMod.getDelivery(d1.id)?.status));

// Peristiwa kedua muncul selagi yang pertama belum selesai.
hookMod.emitProjectEvent(projectId, "run.completed", { runId: `run-2-${stamp}`, conversationId: `conv-2-${stamp}` });
await waitFor(() => deliveryRows(holdHookId).length >= 2, 4000, 50);
const secondRows = deliveryRows(holdHookId);
const d2 = secondRows[secondRows.length - 1];
check("2) peristiwa kedua memakai posisi urutan yang lebih tinggi", Number(d2?.sequence) === Number(d1?.sequence) + 1, short({ first: d1?.sequence, second: d2?.sequence }));

const deferred = await hookMod.deliverWebhook(d2.id);
check("2) kiriman kedua menyerahkan tempat (deferred)", deferred.status === "deferred", short(deferred));
const d2After = hookMod.getDelivery(d2.id);
check("2) baris kiriman kedua tetap queued", String(d2After?.status) === "queued", short(d2After?.status));
check("2) penghitung deferrals naik menjadi 1", Number(d2After?.deferrals) === 1, short(d2After?.deferrals));
const deferJob = jobLike(`webhook.deliver:${d2.id}:defer:%`);
check("2) pekerjaan baru mengantre dengan dedupe berisi defer",
  deferJob?.kind === "webhook.deliver" && String(deferJob?.dedupeKey).includes("defer:") && deferJob?.status === "queued", short(deferJob));
check("2) pekerjaan penundaan dijadwalkan di masa depan", new Date(String(deferJob?.runAfter)).getTime() > Date.now(), short(deferJob?.runAfter));
check("2) modul menunjuk kiriman pertama sebagai penghalang", String(hookMod.blockingEarlierDelivery(d2After)?.id) === String(d1.id), short(hookMod.blockingEarlierDelivery(d2After)?.id));

hooks.release();
const firstReport = await pendingFirst;
check("2) kiriman pertama akhirnya delivered", firstReport?.status === "delivered", short(firstReport));
check("2) baris pertama tercatat delivered", String(hookMod.getDelivery(d1.id)?.status) === "delivered", short(hookMod.getDelivery(d1.id)?.status));

const secondReport = await hookMod.deliverWebhook(d2.id);
check("2) kiriman kedua terkirim setelah yang pertama selesai", secondReport.status === "delivered", short(secondReport));
check("2) baris kedua tercatat delivered", String(hookMod.getDelivery(d2.id)?.status) === "delivered", short(hookMod.getDelivery(d2.id)?.status));
const holdHits = hooks.of("/hold");
check("2) penerima menerima dua kiriman", holdHits.length === 2, short(holdHits.length));
check("2) urutan tiba sama dengan urutan sequence", Number(holdHits[0]?.sequence) < Number(holdHits[1]?.sequence) && holdHits[0]?.sequence === String(d1.sequence) && holdHits[1]?.sequence === String(d2.sequence),
  short(holdHits.map((hit) => hit.sequence)));

/* ------------------------------ 3) batas kesabaran pengiriman ------------------------------ */

const patienceHook = await owner.call("POST", "/api/v1/webhooks", { url: `${hookBase}/patience`, events: ["run.completed"], description: "uji batas kesabaran" });
const patienceHookId = String(patienceHook.json?.webhook?.id ?? "");
check("3) webhook penerima sabar dibuat (201)", patienceHook.status === 201 && Boolean(patienceHookId), short(patienceHook.json));

// Baris penghalang dibuat QUEUED dan sengaja tidak diberi pekerjaan, jadi ia menahan antrean
// selama uji ini berjalan.
const blocker = hookMod.createDeliveryRow({ webhookId: patienceHookId, event: "run.completed", payload: { note: "penghalang" } });
const follower = hookMod.createDeliveryRow({ webhookId: patienceHookId, event: "run.completed", payload: { note: "pengikut" } });
check("3) baris penghalang berada lebih dulu di urutan", Number(blocker.sequence) < Number(follower.sequence), short({ blocker: blocker.sequence, follower: follower.sequence }));

// Jejak SQL dipasang sementara supaya uji bisa membuktikan APA yang ditulis modul ke baris itu:
// catatan "mendahului" ditulis sebelum pengiriman, lalu (bila kiriman berhasil) ditimpa.
const sqlTrace: string[] = [];
let tracing = true;
const realPrepare = db.prepare.bind(db);
try {
  (db as any).prepare = (sql: string) => {
    const statement: any = realPrepare(sql);
    if (tracing && sql.includes("UPDATE webhook_deliveries") && typeof statement?.run === "function") {
      try {
        const realRun = statement.run.bind(statement);
        statement.run = (...args: any[]) => { sqlTrace.push(`${sql.replace(/\s+/g, " ")} <- ${short(args, 160)}`); return realRun(...args); };
      } catch { /* jejak hanya tambahan, jangan gagalkan uji */ }
    }
    return statement;
  };
} catch { tracing = false; }

let deferCount = 0;
let patienceReport: any = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  patienceReport = await hookMod.deliverWebhook(follower.id);
  if (patienceReport.status === "deferred") { deferCount += 1; continue; }
  break;
}
if (tracing) { try { (db as any).prepare = realPrepare; } catch { /* biarkan */ } }
const followerRow = hookMod.getDelivery(follower.id);
const blockerRow = hookMod.getDelivery(blocker.id);
check("3) pengiriman tetap dikirim walau pendahulunya masih macet",
  patienceReport?.status === "delivered" && String(blockerRow?.status) === "queued", short({ report: patienceReport, blocker: blockerRow?.status }));
check("3) baris pengikut tercatat delivered", String(followerRow?.status) === "delivered", short(followerRow?.status));
const outOfOrderNote = String(followerRow?.lastError ?? "");
// Diperbaiki 26 Sep 2026 (audit cek vakum): dulu syaratnya ditulis `if (syarat) check(..., true)`,
// sehingga cabang "lulus" hanya mencetak true tanpa memeriksa apa pun lagi. Sekarang syarat itu
// sendiri yang menjadi argumen `check`, sedangkan jejak SQL tetap ikut dilaporkan saat gagal.
const catatanSesuai = outOfOrderNote.includes("mendahului") && outOfOrderNote.includes(`#${blocker.sequence}`);
const noteAt = sqlTrace.findIndex((line) => line.includes("mendahului"));
const deliveredAt = sqlTrace.findIndex((line) => line.includes("status='delivered'"));
const traceNote = noteAt >= 0 && deliveredAt > noteAt
  ? `jejak SQL: catatan ditulis pada langkah ke-${noteAt + 1} lalu ditimpa last_error=NULL oleh UPDATE sukses pada langkah ke-${deliveredAt + 1}`
  : `jejak SQL tidak lengkap (catatan=${noteAt}, sukses=${deliveredAt})`;
check("3) last_error menyebut pengiriman di luar urutan", catatanSesuai,
  `last_error=${JSON.stringify(followerRow?.lastError)} (deferrals=${followerRow?.deferrals}, status=${followerRow?.status}); ${traceNote}. Berkas: apps/api/src/webhooks.ts:327 menulis catatan, apps/api/src/webhooks.ts:371 menghapusnya (last_error=NULL) saat kiriman berhasil`);
// noteDeferral menaikkan penghitung SEBELUM batas diperiksa, jadi penundaan terakhir ikut dihitung
// walau kiriman pada percobaan itu langsung dikirim.
// Penghitung TIDAK menambah percobaan yang menyerah dan langsung mengirim, jadi angkanya sama
// dengan jumlah penundaan nyata. Ini juga yang dibaca operator sebagai lamanya sebuah kiriman menunggu.
check("3) penghitung deferrals sejalan dengan jumlah penundaan", Number(followerRow?.deferrals) === deferCount && deferCount >= 2,
  short({ deferrals: followerRow?.deferrals, deferred: deferCount }));
const patienceHit = hooks.of("/patience").slice(-1)[0];
check("3) header x-coblai-sequence tetap dikirim", patienceHit?.sequence === String(follower.sequence) && patienceHit?.sequence !== "", short({ header: patienceHit?.sequence, row: follower.sequence }));
const maxDeferrals = Number((hookMod as any).MAX_ORDER_DEFERRALS);
if (Number.isFinite(maxDeferrals)) {
  check("3) pengiriman keluar tepat setelah MAX_ORDER_DEFERRALS penundaan", deferCount === maxDeferrals, short({ deferred: deferCount, maxDeferrals }));
} else {
  check("3) MAX_ORDER_DEFERRALS diimpor dari modul", false, `webhooks.ts tidak mengekspor MAX_ORDER_DEFERRALS (konstanta internal, apps/api/src/webhooks.ts:189); batas kesabaran terbukti lewat perilaku: ${deferCount} penundaan lalu terkirim`);
}

/* ------------------------------ 4) uji manual selalu segera ------------------------------ */

const testReply = await owner.call("POST", `/api/v1/webhooks/${patienceHookId}/test`);
check("4) uji webhook dijawab 200 dengan laporan", testReply.status === 200 && Boolean(testReply.json?.report), short(testReply.json));
check("4) uji webhook terkirim SEGERA walau ada kiriman lebih lama menunggu",
  String(testReply.json?.report?.status) === "delivered", short(testReply.json?.report));
const testDeliveryId = String(testReply.json?.delivery?.id ?? "");
const testDelivery = hookMod.getDelivery(testDeliveryId);
check("4) baris uji tidak pernah berstatus deferred", String(testDelivery?.status) === "delivered" && Number(testDelivery?.deferrals) === 0, short({ status: testDelivery?.status, deferrals: testDelivery?.deferrals }));
check("4) kiriman uji punya posisi lebih tinggi daripada penghalang yang masih menunggu", Number(testDelivery?.sequence) > Number(blocker.sequence), short({ test: testDelivery?.sequence, blocker: blocker.sequence }));
const testHit = hooks.of("/patience").slice(-1)[0];
check("4) penerima menerima peristiwa webhook.test dengan posisi urutan", testHit?.event === "webhook.test" && testHit?.sequence === String(testDelivery?.sequence), short({ event: testHit?.event, sequence: testHit?.sequence }));

// Kontras: baris terjadwal biasa pada hook yang sama tetap menyerahkan tempat.
const scheduled = hookMod.createDeliveryRow({ webhookId: patienceHookId, event: "run.completed", payload: { note: "terjadwal" } });
const scheduledReport = await hookMod.deliverWebhook(scheduled.id);
check("4) tanpa force, baris terjadwal tetap deferred", scheduledReport.status === "deferred", short(scheduledReport));

/* ------------------------------ 5) tombol kirim ulang ------------------------------ */

const beforeResend = hookMod.getDelivery(testDeliveryId);
const resendReply = await owner.call("POST", `/api/v1/webhooks/${patienceHookId}/deliveries/${testDeliveryId}/resend`);
// Dulu bercabang ke `skip` ketika server menjawab 202. Rute sekarang memang 201 (apps/api/src/server.ts
// mengembalikan 201 setelah baris baru dibuat), jadi pemeriksaan ini WAJIB lulus — regresi harus berisik.
check("5) rute kirim ulang menjawab 201", resendReply.status === 201,
  `rute menjawab ${resendReply.status}; spec meminta 201 (baris baru tetap dibuat dan diperiksa di bawah)`);
check("5) permintaan kirim ulang diterima server", resendReply.status === 201 || resendReply.status === 202, short(resendReply.json));
const resendRow = resendReply.json?.delivery;
check("5) baris BARU dibuat untuk kirim ulang", Boolean(resendRow?.id) && String(resendRow?.id) !== testDeliveryId, short({ baru: resendRow?.id, asal: testDeliveryId }));
check("5) baris baru menunjuk baris asal lewat resend_of", String(resendRow?.resendOf) === testDeliveryId, short(resendRow?.resendOf));
check("5) baris baru memakai sequence yang lebih besar", Number(resendRow?.sequence) > Number(beforeResend?.sequence), short({ baru: resendRow?.sequence, asal: beforeResend?.sequence }));
check("5) baris baru mulai dari status queued", String(resendRow?.status) === "queued", short(resendRow?.status));
check("5) kirim ulang mengantre pekerjaan baru", Boolean(jobRow(`webhook.deliver:${resendRow?.id}`)), short(jobRow(`webhook.deliver:${resendRow?.id}`)));
const afterResend = hookMod.getDelivery(testDeliveryId);
check("5) baris asal TIDAK berubah",
  String(afterResend?.status) === String(beforeResend?.status) && Number(afterResend?.attempts) === Number(beforeResend?.attempts)
  && Number(afterResend?.sequence) === Number(beforeResend?.sequence) && Number(afterResend?.deferrals) === Number(beforeResend?.deferrals)
  && String(afterResend?.updatedAt) === String(beforeResend?.updatedAt),
  short({ sesudah: afterResend, sebelum: beforeResend }));

const viewerRegister = await viewer.call("POST", "/api/v1/auth/register", { email: viewerEmail, password, displayName: "Viewer Wave 10B" });
check("5) akun viewer terdaftar", viewerRegister.status === 200 || viewerRegister.status === 201, short(viewerRegister.json));
const viewerUser = db.prepare("SELECT id FROM users WHERE email=?").get(viewerEmail) as any;
db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,?,?)")
  .run(viewerUser.id, workspaceId, "viewer", new Date().toISOString());
const viewerResend = await viewer.call("POST", `/api/v1/webhooks/${patienceHookId}/deliveries/${testDeliveryId}/resend?workspaceId=${workspaceId}`);
check("5) peran viewer ditolak mengirim ulang (403)", viewerResend.status === 403, `${viewerResend.status} ${short(viewerResend.json)}`);

/* ------------------------------ 6) membersihkan riwayat pengiriman ------------------------------ */

// Baris lama: satu delivered dan satu queued, keduanya dibuat 10 hari lalu.
const oldStamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
db.prepare("UPDATE webhook_deliveries SET created_at=? WHERE id=?").run(oldStamp, testDeliveryId);
db.prepare("UPDATE webhook_deliveries SET created_at=? WHERE id=?").run(oldStamp, blocker.id);
const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const expectedCandidates = Number((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=? AND created_at < ? AND status IN ('delivered','failed')").get(patienceHookId, cutoff) as any).n);
check("6) baris lama yang menunggu ikut disiapkan sebagai pembanding", Number((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id=? AND created_at < ? AND status='queued'").get(patienceHookId, cutoff) as any).n) >= 1);

const dryReply = await owner.call("DELETE", `/api/v1/webhooks/${patienceHookId}/deliveries?dryRun=1&days=7`);
check("6) mode kering melaporkan calon hanya baris selesai yang lebih tua",
  Number(dryReply.json?.report?.candidates) === expectedCandidates && expectedCandidates >= 1, short({ lapor: dryReply.json?.report, expected: expectedCandidates }));
check("6) mode kering tidak menghapus apa pun",
  Number(dryReply.json?.report?.removed) === 0 && Boolean(hookMod.getDelivery(testDeliveryId)), short(dryReply.json?.report));
check("6) baris queued tidak pernah masuk calon", Number(dryReply.json?.report?.candidates) === 1 && String(hookMod.getDelivery(blocker.id)?.status) === "queued",
  short({ candidates: dryReply.json?.report?.candidates, blocker: hookMod.getDelivery(blocker.id)?.status }));

const moduleDry = hookMod.cleanupWebhookDeliveries({ days: 7, dryRun: true, webhookId: patienceHookId });
check("7) modul melaporkan candidates sama dengan jalur rute", Number(moduleDry?.candidates) === Number(dryReply.json?.report?.candidates), short({ modul: moduleDry, rute: dryReply.json?.report }));
check("7) modul mode kering tidak menghapus baris", Number(moduleDry?.removed) === 0 && moduleDry?.dryRun === true, short(moduleDry));

const realReply = await owner.call("DELETE", `/api/v1/webhooks/${patienceHookId}/deliveries?days=7`);
check("6) pembersihan sungguhan menghapus baris lama", Number(realReply.json?.report?.removed) === expectedCandidates, short(realReply.json?.report));
check("6) baris lama benar-benar hilang", hookMod.getDelivery(testDeliveryId) === null, short(hookMod.getDelivery(testDeliveryId)));
check("6) baris queued tetap ada setelah pembersihan",
  String(hookMod.getDelivery(blocker.id)?.status) === "queued" && String(hookMod.getDelivery(resendRow?.id)?.status) === "queued",
  short({ penghalang: hookMod.getDelivery(blocker.id)?.status, kirimUlang: hookMod.getDelivery(resendRow?.id)?.status }));

/* ------------------------------ 8) statistik pengiriman ------------------------------ */

const stats = hookMod.webhookStats(workspaceId);
check("8) webhookStats memuat deferred", typeof stats?.deferred === "number" && stats.deferred >= 1, short(stats));
check("8) webhookStats memuat oldestQueuedAt", "oldestQueuedAt" in (stats ?? {}) && Boolean(stats?.oldestQueuedAt), short(stats?.oldestQueuedAt));
const routeStats = await owner.call("GET", "/api/v1/webhooks");
check("8) rute webhook melaporkan statistik yang sama", Number(routeStats.json?.stats?.deferred) === Number(stats?.deferred) && Boolean(routeStats.json?.stats?.oldestQueuedAt),
  short({ rute: routeStats.json?.stats, modul: stats }));

/* ------------------------------ ringkasan ------------------------------ */

await hooks.close();
console.log("");
console.log(`wave10-order: ${passed}/${checks} lulus, gagal ${failed}, skip ${skipped.length}`);
if (skipped.length) { console.log("SKIP:"); for (const row of skipped) console.log(`  - ${row}`); }
if (failed) { console.log("GAGAL:"); for (const name of failedNames) console.log(`  - ${name}`); console.log("WAVE10_ORDER_TESTS_FAILED"); }
else console.log("ALL_WAVE10_ORDER_TESTS_PASSED");
process.exit(failed ? 1 : 0);

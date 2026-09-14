/**
 * Uji end-to-end lapisan komersial: paket, pesanan, kupon, kredit token, kuota,
 * rekening bank, konfigurasi pembayaran, pendapatan admin, pengguna admin, dan branding.
 *
 * Jalankan: npx tsx apps/api/test/billing.e2e.ts
 *
 * Pola bootstrap meniru delete-flow.e2e.ts dan csrf-limits.e2e.ts: variabel lingkungan
 * diset SEBELUM modul server/config diimpor (config.ts membaca env saat impor), DB memakai
 * DATA_DIR sementara, akun uji didaftarkan lewat HTTP, dan seluruh pemeriksaan lewat HTTP
 * ke 127.0.0.1. Tidak ada email keluar dan tidak ada panggilan jaringan luar.
 *
 * CATATAN KONTRAK (rute komersial belum ada saat suite ini ditulis, jadi kontrak kerja
 * diambil dari permintaan parent; tiga tempat diuji secara lentur dan dilaporkan):
 *   1. Badan JSON bawaan Fastify dibatasi 1 MiB. Badan bukti > 5 MB karena itu bisa
 *      dijawab batas bawaan Fastify sebelum sampai ke pemeriksaan PROOF_TOO_LARGE.
 *      Suite menerima kode PROOF_TOO_LARGE ATAU FST_ERR_CTP_BODY_TOO_LARGE dan
 *      mencetak CATATAN supaya bodyLimit rute bisa dinaikkan.
 *   2. Blokir kuota: billing.ts memakai alasan spesifik DAILY_TOKEN_QUOTA_EXCEEDED /
 *      MONTHLY_TOKEN_QUOTA_EXCEEDED, sedangkan kontrak menyebut QUOTA_EXCEEDED. Suite
 *      menerima keduanya dan tetap mewajibkan status 429 + pesan berbahasa Indonesia.
 *   3. Hanya dua rute yang jalurnya belum pasti dan diuji dengan jalur cadangan:
 *      GET /admin/user-list (cadangan GET /admin/users) dan rute publik branding
 *      (cadangan tanpa awalan /api/v1). Jalur yang benar dicetak sebagai CATATAN.
 */

const ADMIN_EMAIL = "billing-admin@example.test";
const port = 4500 + Math.floor(Math.random() * 400); // hindari port tetap suite lain (3424-3471) dan csrf (3900-4400)
const dataDir = `/tmp/coder-billing-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "billing-test-model";
// Akun ini satu-satunya admin platform, supaya penjaga LAST_ADMIN bisa diuji.
process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;
// Batas rate limit dinaikkan hanya untuk lingkungan uji agar suite tidak kena 429 palsu.
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
const nowIso = () => new Date().toISOString();
/** Potongan teks pendek untuk detail kegagalan. */
function short(value: unknown, limit = 220): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}

type Reply = { status: number; json: any; text: string; path: string };
type ApiClient = { call: (method: string, path: string, body?: unknown) => Promise<Reply>; staleCookie: () => string };

/** Klien kecil dengan cookie sendiri; cookie yang dibersihkan server tidak dipakai lagi. */
function client(): ApiClient {
  let cookie = ""; let stale = "";
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
        if (value.endsWith("=")) { stale = cookie; cookie = ""; } else { cookie = value; stale = value; }
      }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json, text, path };
    },
    staleCookie() { return stale; },
  };
}

/** Coba jalur utama lalu jalur cadangan; dipakai hanya bila letak satu rute belum pasti. */
async function callAnywhere(api: ApiClient, method: string, paths: string[], body?: unknown): Promise<{ reply: Reply; usedPath: string }> {
  let reply = await api.call(method, paths[0], body);
  for (let index = 1; index < paths.length && reply.status === 404; index += 1) reply = await api.call(method, paths[index], body);
  return { reply, usedPath: reply.path };
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

const stamp = Date.now();
const password = "BillingUji123!";
const adminEmail = ADMIN_EMAIL;
const buyerEmail = `billing-buyer-${stamp}@example.test`;
const otherEmail = `billing-other-${stamp}@example.test`;

// ==================================================================== A. paket & kuota
const anon = client();
const admin = client();
const buyer = client();
const other = client();

const serverReady = await waitForHealth();
check("[A] server uji siap menjawab GET /health 200", serverReady, `base=${base}`);

const plansAnon = await anon.call("GET", "/api/v1/billing/plans");
check("[A] GET /billing/plans tanpa sesi -> 401 AUTH_REQUIRED",
  plansAnon.status === 401 && plansAnon.json?.error === "AUTH_REQUIRED", `${plansAnon.status} ${short(plansAnon.json)}`);

const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Uji Billing" });
check("[A] daftar akun admin platform", adminReg.status === 201, `${adminReg.status} ${short(adminReg.json)}`);
const adminUserId = adminReg.json?.user?.id;

const buyerReg = await buyer.call("POST", "/api/v1/auth/register", { email: buyerEmail, password, displayName: "Pembeli Uji" });
check("[A] daftar akun pembeli uji", buyerReg.status === 201, `${buyerReg.status} ${short(buyerReg.json)}`);
const buyerUserId = buyerReg.json?.user?.id;

const otherReg = await other.call("POST", "/api/v1/auth/register", { email: otherEmail, password, displayName: "Pembeli Kedua" });
check("[A] daftar akun pengguna kedua", otherReg.status === 201, `${otherReg.status} ${short(otherReg.json)}`);

const plans = await buyer.call("GET", "/api/v1/billing/plans");
check("[A] GET /billing/plans dengan sesi -> 200 dan currency IDR",
  plans.status === 200 && plans.json?.currency === "IDR", `${plans.status} ${short(plans.json)}`);
const planList: any[] = Array.isArray(plans.json?.plans) ? plans.json.plans : [];
const planCodes = planList.map((plan: any) => plan?.code);
check("[A] paket free, premium, dan enterprise tersedia",
  ["free", "premium", "enterprise"].every((code) => planCodes.includes(code)), JSON.stringify(planCodes));
check("[A] tiap paket punya priceIdr, dailyTokenLimit, monthlyTokenLimit, features",
  planList.length > 0 && planList.every((plan: any) => typeof plan?.priceIdr === "number" && typeof plan?.dailyTokenLimit === "number"
    && typeof plan?.monthlyTokenLimit === "number" && Array.isArray(plan?.features)), short(planList));
const premiumPlan = planList.find((plan: any) => plan?.code === "premium");
const freePlan = planList.find((plan: any) => plan?.code === "free");
const initialPremiumPrice = premiumPlan?.priceIdr;
const initialFreeDailyLimit = freePlan?.dailyTokenLimit;
check("[A] harga awal paket premium 199000", initialPremiumPrice === 199000, `priceIdr=${initialPremiumPrice}`);

const me = await buyer.call("GET", "/api/v1/billing/me");
const meKeys = ["tier", "plan", "subscription", "quota", "orders", "banks", "creditHistory", "payment", "currency"];
check("[A] GET /billing/me -> 200 dan memuat semua bagian",
  me.status === 200 && meKeys.every((key) => key in (me.json ?? {})), `${me.status} ${short(me.json)}`);
const quota = me.json?.quota ?? {};
const quotaKeys = ["usedToday", "usedMonth", "dailyLimit", "monthlyLimit", "creditTokens", "remainingToday", "remainingMonth", "blocked", "reason"];
check("[A] quota memuat pemakaian, batas, kredit, sisa, blocked, dan reason",
  quotaKeys.every((key) => key in quota), short(quota));
check("[A] pengguna baru belum memakai token dan tidak terblokir",
  quota.usedToday === 0 && quota.usedMonth === 0 && quota.blocked === false, short(quota));

const couponMissing = await buyer.call("POST", "/api/v1/billing/coupons/validate", { code: "TIDAK-ADA-UJI", amountIdr: 100000 });
check("[A] validasi kupon tidak ada -> 400 COUPON_NOT_FOUND",
  couponMissing.status === 400 && couponMissing.json?.error === "COUPON_NOT_FOUND", `${couponMissing.status} ${short(couponMissing.json)}`);

const orderUnknownPlan = await buyer.call("POST", "/api/v1/billing/orders", { planCode: "tidak-ada", months: 1 });
check("[A] pesanan paket tak dikenal -> 404 PLAN_NOT_FOUND",
  orderUnknownPlan.status === 404 && orderUnknownPlan.json?.error === "PLAN_NOT_FOUND", `${orderUnknownPlan.status} ${short(orderUnknownPlan.json)}`);

const orderPremium = await buyer.call("POST", "/api/v1/billing/orders", { planCode: "premium", months: 1 });
const premiumOrder = orderPremium.json?.order ?? null;
check("[A] pesanan premium 1 bulan -> 200 status pending",
  orderPremium.status === 200 && premiumOrder?.status === "pending", `${orderPremium.status} ${short(orderPremium.json)}`);
check("[A] pesanan premium totalIdr 199000 = amountIdr - discountIdr",
  premiumOrder?.totalIdr === 199000 && premiumOrder?.amountIdr === (premiumOrder?.totalIdr ?? 0) + (premiumOrder?.discountIdr ?? 0),
  short(premiumOrder));

const orderFree = await other.call("POST", "/api/v1/billing/orders", { planCode: "free", months: 1 });
const freeOrder = orderFree.json?.order ?? null;
check("[A] pesanan paket free -> 200 dan langsung paid (total Rp0)",
  orderFree.status === 200 && freeOrder?.status === "paid" && freeOrder?.totalIdr === 0, `${orderFree.status} ${short(orderFree.json)}`);

const buyerWorkspaces = await buyer.call("GET", "/api/v1/workspaces");
const buyerWorkspaceId = (Array.isArray(buyerWorkspaces.json) ? buyerWorkspaces.json[0]?.id : undefined) ?? buyerReg.json?.workspace?.id;
const projectCreate = await buyer.call("POST", `/api/v1/workspaces/${buyerWorkspaceId}/projects`, { name: "Proyek Uji Billing", slug: `uji-billing-${stamp}` });
const buyerProjectId = projectCreate.json?.id ?? projectCreate.json?.project?.id;
check("[A] proyek uji pembeli siap (untuk lampiran bukti)",
  (projectCreate.status === 201 || projectCreate.status === 200) && typeof buyerProjectId === "string",
  `${projectCreate.status} ${short(projectCreate.json)}`);

const smallPng = Buffer.from("bukti transfer uji", "utf8").toString("base64");
const proof = await buyer.call("POST", `/api/v1/billing/orders/${premiumOrder?.id}/proof`, { filename: "bukti.png", contentBase64: smallPng });
check("[A] unggah bukti .png -> 200 { order, artifactId } dan proofArtifactId terisi",
  proof.status === 200 && typeof proof.json?.artifactId === "string"
    && typeof proof.json?.order?.proofArtifactId === "string" && proof.json.order.proofArtifactId.length > 0,
  `${proof.status} ${short(proof.json)}`);
// Perbedaan dari kontrak tulisan: server menyimpan PATH berkas pada proofArtifactId, sedangkan
// artifactId adalah UUID bukti, jadi keduanya tidak sama. Perilaku server yang diikuti.
if (proof.status === 200 && proof.json?.order?.proofArtifactId === proof.json?.artifactId) {
  console.log("CATATAN: proofArtifactId sama dengan artifactId (sesuai kontrak tulisan).");
} else if (proof.status === 200) {
  console.log("CATATAN: proofArtifactId berisi path berkas, bukan artifactId (beda dari kontrak tulisan; perilaku server diikuti).");
}

const proofOtherUser = await buyer.call("POST", `/api/v1/billing/orders/${freeOrder?.id}/proof`, { filename: "bukti.png", contentBase64: smallPng });
check("[A] bukti untuk pesanan milik pengguna lain -> 404 ORDER_NOT_FOUND",
  proofOtherUser.status === 404 && proofOtherUser.json?.error === "ORDER_NOT_FOUND", `${proofOtherUser.status} ${short(proofOtherUser.json)}`);
const buyerOrdersAfterProof = await buyer.call("GET", "/api/v1/billing/orders");
const buyerOrderRows: any[] = Array.isArray(buyerOrdersAfterProof.json?.orders) ? buyerOrdersAfterProof.json.orders : [];
const premiumOrderReread = buyerOrderRows.find((row: any) => row?.id === premiumOrder?.id);
check("[A] proofArtifactId tersimpan dan terbaca dari GET /billing/orders",
  Boolean(premiumOrderReread?.proofArtifactId), short(premiumOrderReread));

const proofExe = await buyer.call("POST", `/api/v1/billing/orders/${premiumOrder?.id}/proof`, { filename: "virus.exe", contentBase64: smallPng });
check("[A] bukti berakhiran .exe -> 400 PROOF_INVALID",
  proofExe.status === 400 && proofExe.json?.error === "PROOF_INVALID", `${proofExe.status} ${short(proofExe.json)}`);

const proofPaid = await other.call("POST", `/api/v1/billing/orders/${freeOrder?.id}/proof`, { filename: "bukti.png", contentBase64: smallPng });
check("[A] bukti untuk pesanan yang sudah paid -> 409 ORDER_NOT_PENDING",
  proofPaid.status === 409 && proofPaid.json?.error === "ORDER_NOT_PENDING", `${proofPaid.status} ${short(proofPaid.json)}`);

// Badan besar: 7 juta karakter base64 (sekitar 5,25 MB setelah didekode), agar batas 5 MB terlewat
// baik batas diukur pada panjang base64 maupun pada hasil dekode.
let bigReply: Reply | null = null;
try {
  bigReply = await buyer.call("POST", `/api/v1/billing/orders/${premiumOrder?.id}/proof`, { filename: "besar.png", contentBase64: "A".repeat(7_000_000) });
} catch (error) {
  skip("[A] bukti base64 > 5 MB -> 413 PROOF_TOO_LARGE", `pengiriman badan besar gagal di klien: ${String(error)}`);
}
if (bigReply) {
  const bigCode = String(bigReply.json?.code ?? bigReply.json?.error ?? "");
  check("[A] bukti base64 > 5 MB -> 413 PROOF_TOO_LARGE",
    bigReply.status === 413 && (bigCode === "PROOF_TOO_LARGE" || bigCode === "FST_ERR_CTP_BODY_TOO_LARGE"),
    `${bigReply.status} kode=${bigCode}`);
  if (bigCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
    console.log("CATATAN: 413 datang dari batas badan JSON bawaan Fastify (1 MiB), bukan dari pemeriksaan PROOF_TOO_LARGE."
      + " Rute bukti perlu opsi bodyLimit (mis. 12 MiB) supaya pemeriksaan PROOF_TOO_LARGE benar-benar tercapai.");
  }
}

check("[A] GET /billing/orders -> 200 berisi pesanan milik pengguna itu",
  buyerOrdersAfterProof.status === 200 && buyerOrderRows.some((row: any) => row?.id === premiumOrder?.id), `${buyerOrdersAfterProof.status} ${short(buyerOrderRows)}`);
check("[A] GET /billing/orders pengguna pertama tidak memuat pesanan pengguna kedua",
  !buyerOrderRows.some((row: any) => row?.id === freeOrder?.id), short(buyerOrderRows));
const otherOrders = await other.call("GET", "/api/v1/billing/orders");
const otherOrderRows: any[] = Array.isArray(otherOrders.json?.orders) ? otherOrders.json.orders : [];
check("[A] pengguna kedua hanya melihat pesanannya sendiri",
  otherOrders.status === 200 && otherOrderRows.length > 0 && otherOrderRows.every((row: any) => row?.id === freeOrder?.id),
  `${otherOrders.status} ${short(otherOrderRows)}`);

// ======================================================================== B. kupon
const couponCreate = await admin.call("POST", "/api/v1/admin/coupons", { code: "UJI10", percent: 10, maxUses: 5 });
check("[B] admin membuat kupon UJI10 10% -> 200 active true",
  couponCreate.status === 200 && couponCreate.json?.coupon?.active === true && couponCreate.json?.coupon?.percent === 10,
  `${couponCreate.status} ${short(couponCreate.json)}`);

const couponDuplicate = await admin.call("POST", "/api/v1/admin/coupons", { code: "UJI10", percent: 10, maxUses: 5 });
check("[B] kode kupon yang sama -> 409 COUPON_EXISTS",
  couponDuplicate.status === 409 && couponDuplicate.json?.error === "COUPON_EXISTS", `${couponDuplicate.status} ${short(couponDuplicate.json)}`);

const couponValidate = await buyer.call("POST", "/api/v1/billing/coupons/validate", { code: "UJI10", amountIdr: 100000 });
check("[B] validasi UJI10 pada 100000 -> 200 diskon 10000 (10%)",
  couponValidate.status === 200 && couponValidate.json?.discountIdr === 10000 && couponValidate.json?.percent === 10,
  `${couponValidate.status} ${short(couponValidate.json)}`);

const orderCoupon = await buyer.call("POST", "/api/v1/billing/orders", { planCode: "premium", months: 1, couponCode: "UJI10" });
const couponOrder = orderCoupon.json?.order;
check("[B] pesanan premium dengan kupon -> 200 diskon 19900 total 179100",
  orderCoupon.status === 200 && couponOrder?.discountIdr === 19900 && couponOrder?.totalIdr === 179100, `${orderCoupon.status} ${short(orderCoupon.json)}`);

const orderMissingCoupon = await buyer.call("POST", "/api/v1/billing/orders", { planCode: "premium", months: 1, couponCode: "KUPON-HILANG" });
check("[B] pesanan dengan kode kupon tidak ada -> 400 COUPON_NOT_FOUND",
  orderMissingCoupon.status === 400 && orderMissingCoupon.json?.error === "COUPON_NOT_FOUND", `${orderMissingCoupon.status} ${short(orderMissingCoupon.json)}`);

const couponOff = await admin.call("PATCH", "/api/v1/admin/coupons/UJI10", { active: false });
check("[B] PATCH /admin/coupons/UJI10 active=false -> 200",
  couponOff.status === 200 && couponOff.json?.coupon?.active === false, `${couponOff.status} ${short(couponOff.json)}`);

const couponInactive = await buyer.call("POST", "/api/v1/billing/coupons/validate", { code: "UJI10", amountIdr: 100000 });
check("[B] validasi kupon nonaktif -> 400 COUPON_INACTIVE",
  couponInactive.status === 400 && couponInactive.json?.error === "COUPON_INACTIVE", `${couponInactive.status} ${short(couponInactive.json)}`);

// ======================================================= C. admin pesanan & pendapatan
const buyerAdminOrders = await buyer.call("GET", "/api/v1/admin/orders");
check("[C] pengguna biasa GET /admin/orders -> 403 ADMIN_REQUIRED",
  buyerAdminOrders.status === 403 && buyerAdminOrders.json?.error === "ADMIN_REQUIRED", `${buyerAdminOrders.status} ${short(buyerAdminOrders.json)}`);
const buyerRevenue = await buyer.call("GET", "/api/v1/admin/revenue");
check("[C] pengguna biasa GET /admin/revenue -> 403 ADMIN_REQUIRED",
  buyerRevenue.status === 403 && buyerRevenue.json?.error === "ADMIN_REQUIRED", `${buyerRevenue.status} ${short(buyerRevenue.json)}`);
const buyerCoupon = await buyer.call("POST", "/api/v1/admin/coupons", { code: "UJI-BUKAN-ADMIN", percent: 5 });
check("[C] pengguna biasa POST /admin/coupons -> 403 ADMIN_REQUIRED",
  buyerCoupon.status === 403 && buyerCoupon.json?.error === "ADMIN_REQUIRED", `${buyerCoupon.status} ${short(buyerCoupon.json)}`);
const buyerBranding = await buyer.call("PUT", "/api/v1/admin/branding", { appName: "Bukan Admin" });
check("[C] pengguna biasa PUT /admin/branding -> 403 ADMIN_REQUIRED",
  buyerBranding.status === 403 && buyerBranding.json?.error === "ADMIN_REQUIRED", `${buyerBranding.status} ${short(buyerBranding.json)}`);

const adminPending = await admin.call("GET", "/api/v1/admin/orders?status=pending");
const pendingRows: any[] = Array.isArray(adminPending.json?.orders) ? adminPending.json.orders : [];
check("[C] admin GET /admin/orders?status=pending -> 200 hanya baris pending",
  adminPending.status === 200 && pendingRows.length > 0 && pendingRows.every((row: any) => row?.status === "pending"),
  `${adminPending.status} ${short(pendingRows)}`);
check("[C] tiap baris pesanan admin memuat userEmail",
  pendingRows.length > 0 && pendingRows.every((row: any) => typeof row?.userEmail === "string" && row.userEmail.includes("@")), short(pendingRows));
check("[C] pesanan premium pembeli ada di daftar pending",
  pendingRows.some((row: any) => row?.id === premiumOrder?.id), short(pendingRows));

const paidDecision = await admin.call("POST", `/api/v1/admin/orders/${premiumOrder?.id}/decision`, { decision: "paid", note: "transfer masuk" });
check("[C] keputusan paid -> 200 status paid dan decidedAt terisi",
  paidDecision.status === 200 && paidDecision.json?.order?.status === "paid" && Boolean(paidDecision.json?.order?.decidedAt),
  `${paidDecision.status} ${short(paidDecision.json)}`);

const meAfterPaid = await buyer.call("GET", "/api/v1/billing/me");
const paidPlanCode = typeof meAfterPaid.json?.plan === "string" ? meAfterPaid.json.plan : meAfterPaid.json?.plan?.code;
check("[C] setelah pelunasan tier pengguna naik ke premium",
  meAfterPaid.status === 200 && meAfterPaid.json?.tier === "premium" && paidPlanCode === "premium", short(meAfterPaid.json));
const subscription = meAfterPaid.json?.subscription;
check("[C] langganan aktif premium dengan expiresAt di masa depan",
  subscription?.planCode === "premium" && typeof subscription?.expiresAt === "string" && Date.parse(subscription.expiresAt) > Date.now(),
  short(subscription));
const creditAfterPaid = meAfterPaid.json?.quota?.creditTokens;
check("[C] kredit token naik oleh bonus paket premium (5000000)",
  typeof creditAfterPaid === "number" && creditAfterPaid >= 5_000_000, `creditTokens=${creditAfterPaid}`);

const subscriptionsBefore = (db.prepare("SELECT COUNT(*) AS total FROM subscriptions WHERE user_id=?").get(buyerUserId) as { total: number }).total;
const expiresAtBefore = subscription?.expiresAt;
const paidAgain = await admin.call("POST", `/api/v1/admin/orders/${premiumOrder?.id}/decision`, { decision: "paid", note: "ulang" });
check("[C] keputusan paid untuk pesanan yang sudah paid -> 200 idempoten dan tetap paid",
  paidAgain.status === 200 && paidAgain.json?.order?.status === "paid", `${paidAgain.status} ${short(paidAgain.json)}`);
const meAgain = await buyer.call("GET", "/api/v1/billing/me");
check("[C] paid ulang tidak mengubah expiresAt langganan",
  meAgain.json?.subscription?.expiresAt === expiresAtBefore,
  `sebelum=${expiresAtBefore} sesudah=${meAgain.json?.subscription?.expiresAt}`);
const subscriptionsAfter = (db.prepare("SELECT COUNT(*) AS total FROM subscriptions WHERE user_id=?").get(buyerUserId) as { total: number }).total;
check("[C] bukti DB: jumlah baris subscriptions tidak bertambah",
  subscriptionsAfter === subscriptionsBefore, `sebelum=${subscriptionsBefore} sesudah=${subscriptionsAfter}`);

const rejectPaid = await admin.call("POST", `/api/v1/admin/orders/${premiumOrder?.id}/decision`, { decision: "rejected", note: "salah" });
check("[C] keputusan rejected untuk pesanan paid -> 409 ORDER_ALREADY_PAID",
  rejectPaid.status === 409 && rejectPaid.json?.error === "ORDER_ALREADY_PAID", `${rejectPaid.status} ${short(rejectPaid.json)}`);

const revenue = await admin.call("GET", "/api/v1/admin/revenue?days=30");
const revenueJson = revenue.json ?? {};
check("[C] GET /admin/revenue?days=30 -> 200 dengan angka pendapatan lengkap",
  revenue.status === 200 && typeof revenueJson.revenueIdr === "number" && typeof revenueJson.costIdr === "number"
    && typeof revenueJson.marginIdr === "number" && typeof revenueJson.paidOrders === "number"
    && typeof revenueJson.pendingOrders === "number" && typeof revenueJson.usdIdrRate === "number" && revenueJson.usdIdrRate > 0,
  `${revenue.status} ${short(revenueJson)}`);
check("[C] pendapatan 30 hari sudah memuat pesanan yang baru dibayar",
  revenueJson.paidOrders >= 1 && revenueJson.revenueIdr >= 199000, short(revenueJson));

// =============================================== D. rekening & konfigurasi pembayaran
const bankCreate = await admin.call("POST", "/api/v1/admin/banks", { bankName: "BCA", accountNumber: "1234567890", accountHolder: "PT Uji" });
const bankId = bankCreate.json?.bank?.id;
check("[D] admin menambah rekening BCA -> 200 { bank }",
  bankCreate.status === 200 && typeof bankId === "string" && bankCreate.json?.bank?.bankName === "BCA", `${bankCreate.status} ${short(bankCreate.json)}`);
const meBanks = await buyer.call("GET", "/api/v1/billing/me");
const bankRows: any[] = Array.isArray(meBanks.json?.banks) ? meBanks.json.banks : [];
check("[D] rekening muncul di GET /billing/me (1 baris)",
  bankRows.length === 1 && bankRows[0]?.bankName === "BCA", short(bankRows));
const bankDelete = await admin.call("DELETE", `/api/v1/admin/banks/${bankId}`);
check("[D] DELETE /admin/banks/:id -> 200 { ok: true }",
  bankDelete.status === 200 && bankDelete.json?.ok === true, `${bankDelete.status} ${short(bankDelete.json)}`);
const meBanksAfter = await buyer.call("GET", "/api/v1/billing/me");
check("[D] rekening kembali kosong di GET /billing/me",
  Array.isArray(meBanksAfter.json?.banks) && meBanksAfter.json.banks.length === 0, short(meBanksAfter.json?.banks));

const paymentConfig = await admin.call("GET", "/api/v1/admin/payment-config");
check("[D] GET /admin/payment-config -> 200 gateway manual tanpa kunci API",
  paymentConfig.status === 200 && typeof paymentConfig.json?.gateway === "string"
    && paymentConfig.json?.xenditConfigured === false && paymentConfig.json?.midtransConfigured === false,
  `${paymentConfig.status} ${short(paymentConfig.json)}`);
const xenditOn = await admin.call("PUT", "/api/v1/admin/payment-config", { gateway: "xendit", xenditEnabled: true });
check("[D] aktifkan xendit tanpa kunci API -> 400 GATEWAY_NOT_CONFIGURED",
  xenditOn.status === 400 && xenditOn.json?.error === "GATEWAY_NOT_CONFIGURED", `${xenditOn.status} ${short(xenditOn.json)}`);
const manualOn = await admin.call("PUT", "/api/v1/admin/payment-config", { gateway: "manual" });
check("[D] kembali ke gateway manual -> 200",
  manualOn.status === 200 && manualOn.json?.gateway === "manual", `${manualOn.status} ${short(manualOn.json)}`);

// ================================================================ E. paket & kurs (admin)
const planPatch = await admin.call("PATCH", "/api/v1/admin/plans/premium", { priceIdr: 250000 });
check("[E] PATCH /admin/plans/premium -> 200 priceIdr 250000",
  planPatch.status === 200 && planPatch.json?.plan?.priceIdr === 250000, `${planPatch.status} ${short(planPatch.json)}`);
const planPatchMissing = await admin.call("PATCH", "/api/v1/admin/plans/tidak-ada", { priceIdr: 1000 });
check("[E] PATCH paket tak dikenal -> 404 PLAN_NOT_FOUND",
  planPatchMissing.status === 404 && planPatchMissing.json?.error === "PLAN_NOT_FOUND", `${planPatchMissing.status} ${short(planPatchMissing.json)}`);
const currencyPut = await admin.call("PUT", "/api/v1/admin/currency", { rate: 17000 });
check("[E] PUT /admin/currency -> 200 usdIdrRate 17000",
  currencyPut.status === 200 && currencyPut.json?.usdIdrRate === 17000, `${currencyPut.status} ${short(currencyPut.json)}`);

// ================================================================== F. admin pengguna
const userList = await callAnywhere(admin, "GET", ["/api/v1/admin/user-list", "/api/v1/admin/users"]);
const usersFrom = (reply: Reply): any[] => Array.isArray(reply.json?.users) ? reply.json.users : (Array.isArray(reply.json) ? reply.json : []);
const userRows = usersFrom(userList.reply);
check("[F] GET /admin/user-list -> 200 memuat admin dan pengguna uji",
  userList.reply.status === 200 && userRows.some((row: any) => row?.email === adminEmail) && userRows.some((row: any) => row?.email === buyerEmail),
  `${userList.usedPath} ${userList.reply.status} ${short(userRows)}`);
if (userList.usedPath !== "/api/v1/admin/user-list") {
  console.log(`CATATAN: rute /api/v1/admin/user-list menjawab 404, suite memakai ${userList.usedPath} sebagai cadangan (rute itu belum ada/dinonaktifkan).`);
}

const createdEmail = `billing-created-${stamp}@example.test`;
const createUser = await admin.call("POST", "/api/v1/admin/users", { email: createdEmail, displayName: "Pengguna Buatan", password: "BuatanUji123!", tier: "free" });
const createdUser = createUser.json?.user;
check("[F] POST /admin/users -> 200 { user }",
  createUser.status === 200 && typeof createdUser?.id === "string", `${createUser.status} ${short(createUser.json)}`);
const createUserDuplicate = await admin.call("POST", "/api/v1/admin/users", { email: createdEmail, displayName: "Duplikat", password: "BuatanUji123!", tier: "free" });
check("[F] email yang sama -> 409 EMAIL_TAKEN",
  createUserDuplicate.status === 409 && createUserDuplicate.json?.error === "EMAIL_TAKEN", `${createUserDuplicate.status} ${short(createUserDuplicate.json)}`);
const createUserShortPassword = await admin.call("POST", "/api/v1/admin/users", { email: `billing-short-${stamp}@example.test`, displayName: "Sandinya Pendek", password: "123", tier: "free" });
check("[F] kata sandi 123 -> 400 INVALID_PASSWORD",
  createUserShortPassword.status === 400 && createUserShortPassword.json?.error === "INVALID_PASSWORD", `${createUserShortPassword.status} ${short(createUserShortPassword.json)}`);

const tierPatch = await admin.call("PATCH", `/api/v1/admin/users/${createdUser?.id}`, { tier: "premium" });
check("[F] PATCH /admin/users/:id tier premium -> 200", tierPatch.status === 200, `${tierPatch.status} ${short(tierPatch.json)}`);
const userListAfter = await callAnywhere(admin, "GET", ["/api/v1/admin/user-list", "/api/v1/admin/users"]);
const createdRow = usersFrom(userListAfter.reply).find((row: any) => row?.id === createdUser?.id);
check("[F] user-list menampilkan tier premium untuk pengguna itu", createdRow?.tier === "premium", short(createdRow));

const creditGrant = await admin.call("POST", `/api/v1/admin/users/${createdUser?.id}/credit`, { tokens: 1000, note: "bonus uji" });
check("[F] POST /admin/users/:id/credit -> 200 creditTokens minimal 1000",
  creditGrant.status === 200 && typeof creditGrant.json?.creditTokens === "number" && creditGrant.json.creditTokens >= 1000,
  `${creditGrant.status} ${short(creditGrant.json)}`);
const createdClient = client();
const createdLogin = await createdClient.call("POST", "/api/v1/auth/login", { email: createdEmail, password: "BuatanUji123!" });
let createdCredit: number | null = null;
if (createdLogin.status === 200) {
  const createdMe = await createdClient.call("GET", "/api/v1/billing/me");
  createdCredit = createdMe.json?.quota?.creditTokens ?? null;
} else {
  createdCredit = (db.prepare("SELECT COALESCE(SUM(tokens),0) AS total FROM credit_ledger WHERE user_id=?").get(createdUser?.id) as { total: number }).total;
  console.log(`CATATAN: login pengguna buatan gagal (status ${createdLogin.status}); kredit diperiksa lewat tabel credit_ledger.`);
}
check("[F] GET /billing/me pengguna buatan -> creditTokens minimal 1000",
  typeof createdCredit === "number" && createdCredit >= 1000, `login=${createdLogin.status} creditTokens=${createdCredit}`);

const resetQuota = await admin.call("POST", `/api/v1/admin/users/${createdUser?.id}/reset-quota`);
check("[F] POST /admin/users/:id/reset-quota -> 200 { ok, quota }",
  resetQuota.status === 200 && resetQuota.json?.ok === true && Boolean(resetQuota.json?.quota), `${resetQuota.status} ${short(resetQuota.json)}`);

const lastAdminDemote = await admin.call("PATCH", `/api/v1/admin/users/${adminUserId}`, { isAdmin: false });
check("[F] menurunkan admin platform TERAKHIR -> 400 LAST_ADMIN",
  lastAdminDemote.status === 400 && lastAdminDemote.json?.error === "LAST_ADMIN", `${lastAdminDemote.status} ${short(lastAdminDemote.json)}`);

// ==================================================================== G. kuota token
const freeLimitPatch = await admin.call("PATCH", "/api/v1/admin/plans/free", { dailyTokenLimit: 1000 });
check("[G] PATCH /admin/plans/free dailyTokenLimit 1000 -> 200",
  freeLimitPatch.status === 200 && freeLimitPatch.json?.plan?.dailyTokenLimit === 1000, `${freeLimitPatch.status} ${short(freeLimitPatch.json)}`);

const quotaClient = client();
const quotaEmail = `billing-quota-${stamp}@example.test`;
const quotaReg = await quotaClient.call("POST", "/api/v1/auth/register", { email: quotaEmail, password, displayName: "Pengguna Kuota" });
check("[G] daftar pengguna uji kuota (tier free tanpa kredit)", quotaReg.status === 201, `${quotaReg.status} ${short(quotaReg.json)}`);
const quotaUserId = quotaReg.json?.user?.id;

const quotaWorkspaces = await quotaClient.call("GET", "/api/v1/workspaces");
const quotaWorkspaceId = Array.isArray(quotaWorkspaces.json) ? quotaWorkspaces.json[0]?.id : undefined;
check("[G] workspace pengguna kuota terbaca", typeof quotaWorkspaceId === "string", short(quotaWorkspaces.json));
const quotaProjectsCall = await quotaClient.call("GET", `/api/v1/workspaces/${quotaWorkspaceId}/projects`);
let quotaProjects: any[] = Array.isArray(quotaProjectsCall.json) ? quotaProjectsCall.json : [];
if (quotaProjects.length === 0) {
  const madeProject = await quotaClient.call("POST", `/api/v1/workspaces/${quotaWorkspaceId}/projects`, { name: "Proyek Kuota", slug: `proyek-kuota-${stamp}` });
  quotaProjects = madeProject.json?.id ? [madeProject.json] : [];
}
const quotaProjectId = quotaProjects[0]?.id;
check("[G] proyek pengguna kuota siap", typeof quotaProjectId === "string", short(quotaProjects));
const quotaConversation = await quotaClient.call("POST", `/api/v1/projects/${quotaProjectId}/conversations`, { title: "Percakapan Kuota" });
const quotaConversationId = quotaConversation.json?.conversation?.id ?? quotaConversation.json?.id;
check("[G] percakapan pengguna kuota dibuat",
  (quotaConversation.status === 201 || quotaConversation.status === 200) && typeof quotaConversationId === "string",
  `${quotaConversation.status} ${short(quotaConversation.json)}`);

// Pemakaian palsu lewat tabel yang sama dengan pemakaian sungguhan (bentuk tabel dibaca dari src/db.ts).
const fakeRunId = randomUUID();
db.prepare("INSERT INTO runs (id,project_id,status,prompt,created_at) VALUES (?,?,?,?,?)").run(fakeRunId, quotaProjectId, "completed", "uji kuota", nowIso());
db.prepare(`INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,total_tokens,cost_micros,estimated,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  .run(randomUUID(), fakeRunId, quotaProjectId, "uji-model", "uji", 4000, 1000, 5000, 0, 0, nowIso());
const quotaUsageRow = db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS tokens FROM run_usage WHERE project_id=?").get(quotaProjectId) as { tokens: number };
check("[G] bukti DB: run_usage palsu 5000 token tersimpan", quotaUsageRow.tokens === 5000, `tokens=${quotaUsageRow.tokens}`);
const quotaMe = await quotaClient.call("GET", "/api/v1/billing/me");
check("[G] GET /billing/me melihat pemakaian 5000 token hari ini",
  quotaMe.json?.quota?.usedToday === 5000, short(quotaMe.json?.quota));

const blockedMessage = await quotaClient.call("POST", `/api/v1/conversations/${quotaConversationId}/messages`, { content: "halo" });
const blockedCode = String(blockedMessage.json?.error ?? "");
const blockedText = String(blockedMessage.json?.message ?? blockedMessage.json?.detail?.message ?? blockedMessage.json?.reason ?? "");
check("[G] kirim pesan saat kuota harian terlampaui -> 429",
  blockedMessage.status === 429, `${blockedMessage.status} ${short(blockedMessage.json)}`);
check("[G] kode galat kuota token (QUOTA_EXCEEDED atau DAILY_TOKEN_QUOTA_EXCEEDED)",
  blockedCode === "QUOTA_EXCEEDED" || blockedCode === "DAILY_TOKEN_QUOTA_EXCEEDED", `${blockedCode} ${short(blockedMessage.json)}`);
check("[G] pesan galat kuota berbahasa Indonesia", /kuota/i.test(blockedText), short(blockedText));

const restoreLimit = await admin.call("PATCH", "/api/v1/admin/plans/free", { dailyTokenLimit: initialFreeDailyLimit });
check("[G] batas harian paket free dipulihkan ke nilai semula",
  restoreLimit.status === 200 && restoreLimit.json?.plan?.dailyTokenLimit === initialFreeDailyLimit,
  `${restoreLimit.status} ${short(restoreLimit.json)}`);
const quotaMeAfter = await quotaClient.call("GET", "/api/v1/billing/me");
check("[G] setelah batas dipulihkan pengguna kuota tidak terblokir",
  quotaMeAfter.json?.quota?.blocked === false, short(quotaMeAfter.json?.quota));

// ======================================================================== H. branding
const brandingAnon = client();
const publicBranding = await callAnywhere(brandingAnon, "GET", ["/api/v1/branding", "/branding"]);
const brandingJson = publicBranding.reply.json ?? {};
check("[H] GET branding tanpa sesi -> 200 memuat appName, tagline, primaryColor",
  publicBranding.reply.status === 200 && typeof brandingJson.appName === "string" && typeof brandingJson.tagline === "string"
    && typeof brandingJson.primaryColor === "string",
  `${publicBranding.usedPath} ${publicBranding.reply.status} ${short(brandingJson)}`);
if (publicBranding.usedPath !== "/api/v1/branding") {
  console.log(`CATATAN: rute publik branding dipakai di ${publicBranding.usedPath} (jalur /api/v1/branding menjawab 404).`);
}
const brandingPut = await admin.call("PUT", "/api/v1/admin/branding", { appName: "COBLAI Coder Uji", primaryColor: "#123456" });
check("[H] admin PUT /admin/branding -> 200", brandingPut.status === 200, `${brandingPut.status} ${short(brandingPut.json)}`);
const brandingAfter = await callAnywhere(client(), "GET", ["/api/v1/branding", "/branding"]);
check("[H] branding publik berubah (appName dan primaryColor)",
  brandingAfter.reply.json?.appName === "COBLAI Coder Uji" && brandingAfter.reply.json?.primaryColor === "#123456",
  short(brandingAfter.reply.json));
const brandingForbidden = await buyer.call("PUT", "/api/v1/admin/branding", { appName: "Bukan Admin" });
check("[H] pengguna biasa PUT /admin/branding -> 403 ADMIN_REQUIRED",
  brandingForbidden.status === 403 && brandingForbidden.json?.error === "ADMIN_REQUIRED", `${brandingForbidden.status} ${short(brandingForbidden.json)}`);

// ====================================================================== ringkasan
console.log("--- RINGKASAN ---");
console.log(`total pemeriksaan: ${checks}, lulus: ${passed}, gagal: ${failed}, skip: ${skipped.length}`);
for (const item of skipped) console.log(`SKIP ${item}`);

/** Keluarkan sisa stdout lalu keluar dengan kode yang diminta. */
async function finish(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
}

if (failed === 0) {
  console.log("ALL_BILLING_TESTS_PASSED");
  await finish(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
await finish(1);

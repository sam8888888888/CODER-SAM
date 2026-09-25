/**
 * Wave 11C (butir 75) — kupon percobaan (trial).
 *
 * Masalah yang diselesaikan: calon pelanggan perlu mencoba paket berbayar tanpa membayar, tetapi
 * percobaan harus tetap terkendali: satu kali pakai, punya batas waktu, hanya untuk paket yang
 * ditentukan, dan tidak menambah masa langganan diam-diam.
 *
 * Kontrak pemasangan rute: `registerTrialCouponRoutes(app)` dari `wave11c/index.ts`.
 * Berkas ini milik butir 75.
 *
 * Aturan penting yang menentukan bentuk kode:
 *   • Baris `coupons` memakai kolom yang sudah ada (percent=100, max_uses, expires_at) dan dua kolom
 *     penanda butir ini: `trial=1` dan `trial_plan_code` (paket sasaran).
 *   • Kode dibuat acak di server, tanpa huruf/angka yang mudah tertukar (tanpa I, O, 0, 1), dan
 *     diperiksa belum ada di tabel sebelum disimpan.
 *   • Kupon percobaan hanya sah untuk paket yang ditentukan. Untuk paket lain jawabannya
 *     TRIAL_PLAN_ONLY dengan kalimat yang sudah ditetapkan PRD.
 *   • Satu kali pakai: `uses` naik lewat jalur pesanan yang ada, dan pemakaian kedua ditolak
 *     COUPON_EXHAUSTED. `expires_at` TIDAK PERNAH diperpanjang — tidak ada perpanjangan diam-diam.
 *   • Pesanan percobaan harus benar-benar gratis. Bila karena suatu hal totalnya bukan nol,
 *     pesanannya ditolak (TRIAL_NOT_FREE), bukan dibiarkan jadi tagihan tak terduga.
 *   • Masa langganan mengikuti aturan paket yang sudah ada (`plans.period_days`), sedangkan `hours`
 *     hanya mengatur berapa lama KUPON boleh dipakai. Dua hal ini sengaja dipisah dan dilaporkan
 *     apa adanya.
 */
import { randomInt, randomUUID } from "node:crypto";
import { requireUser } from "../auth.js";
import { createOrder, getPlan } from "../billing.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { adminRequired, audit, fail, isPlatformAdmin } from "../wave11a/shared.js";

/** Alfabet kode percobaan: tanpa I, O, 0, dan 1 supaya tidak salah baca saat diketik ulang. */
export const ALFABET_KODE_TRIAL = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PANJANG_KODE_TRIAL = 8;
export const TRIAL_PESAN_PAKET_SALAH = "Kupon percobaan hanya berlaku untuk paket yang ditentukan.";

export type BarisKuponTrial = {
  code: string; percent: number; amountIdr: number; maxUses: number; uses: number;
  expiresAt: string | null; active: boolean; trial: boolean; trialPlanCode: string | null; createdAt: string;
};

function toKuponTrial(row: any): BarisKuponTrial {
  return {
    code: row.code, percent: Number(row.percent), amountIdr: Number(row.amount_idr), maxUses: Number(row.max_uses),
    uses: Number(row.uses), expiresAt: row.expires_at ?? null, active: row.active === 1,
    trial: Number(row.trial ?? 0) === 1, trialPlanCode: row.trial_plan_code ?? null, createdAt: row.created_at,
  };
}

/** Kupon percobaan satu kode, langsung dari tabel (kolom trial tidak dibawa `toCoupon()` biasa). */
export function kuponTrial(code: string): BarisKuponTrial | null {
  const row = db.prepare("SELECT * FROM coupons WHERE code=?").get(String(code ?? "").trim().toUpperCase());
  return row ? toKuponTrial(row) : null;
}

/** Daftar kupon percobaan untuk layar admin. */
export function daftarKuponTrial(limit = 50): BarisKuponTrial[] {
  const rows = db.prepare("SELECT * FROM coupons WHERE trial=1 ORDER BY created_at DESC LIMIT ?").all(Math.min(200, Math.max(1, limit))) as any[];
  return rows.map(toKuponTrial);
}

/**
 * Kode acak tanpa huruf/angka yang mudah tertukar. Pemeriksaan tabrakan dilakukan di sini karena
 * kode adalah kunci utama tabel `coupons`, jadi tabrakan harus dihindari sebelum INSERT.
 */
export function buatKodeTrial(panjang: number = PANJANG_KODE_TRIAL): string {
  const jumlah = Math.max(4, Math.min(24, Math.round(panjang)));
  for (let percobaan = 0; percobaan < 20; percobaan += 1) {
    let kode = "";
    for (let i = 0; i < jumlah; i += 1) kode += ALFABET_KODE_TRIAL[randomInt(0, ALFABET_KODE_TRIAL.length)];
    if (!db.prepare("SELECT 1 FROM coupons WHERE code=?").get(kode)) return kode;
  }
  // Cadangan terakhir: tambahkan bagian acak lagi supaya kode tetap unik dan tetap satu baris.
  return `${buatKodeTrialRaw(jumlah - 4)}${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function buatKodeTrialRaw(jumlah: number): string {
  let kode = "";
  for (let i = 0; i < Math.max(1, jumlah); i += 1) kode += ALFABET_KODE_TRIAL[randomInt(0, ALFABET_KODE_TRIAL.length)];
  return kode;
}

export type HasilBuatKupon = { ok: true; coupon: BarisKuponTrial } | { ok: false; status: number; error: string; message: string };

/**
 * Membuat kupon percobaan: 100% potongan, batas pakai, dan masa berlaku dari `hours`.
 * Rentang `hours` mengikuti batas config (1..720) supaya percobaan tidak bisa dibuat abadi.
 */
export function buatKuponTrial(input: { planCode: string; hours?: number; maxUses?: number }): HasilBuatKupon {
  const planCode = String(input.planCode ?? "").trim();
  if (!planCode) return { ok: false, status: 400, error: "TRIAL_PLAN_REQUIRED", message: "Sebutkan paket yang boleh dicoba dengan kupon ini." };
  const plan = getPlan(planCode);
  if (!plan || !plan.active) return { ok: false, status: 404, error: "PLAN_NOT_FOUND", message: "Paket itu tidak ada atau sedang tidak aktif." };
  const jam = Math.round(Number(input.hours ?? config.TRIAL_COUPON_HOURS));
  if (!Number.isFinite(jam) || jam < 1 || jam > 720) return { ok: false, status: 400, error: "INVALID_TRIAL_HOURS", message: "Masa berlaku kupon percobaan 1 sampai 720 jam." };
  const batasPakai = Math.round(Number(input.maxUses ?? 1));
  if (!Number.isFinite(batasPakai) || batasPakai < 1 || batasPakai > 100) return { ok: false, status: 400, error: "INVALID_TRIAL_MAX_USES", message: "Batas pakai kupon percobaan 1 sampai 100 kali." };

  const code = buatKodeTrial();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + jam * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO coupons (code, percent, amount_idr, max_uses, uses, expires_at, active, created_at, trial, trial_plan_code)
    VALUES (?,100,0,?,0,?,1,?,1,?)`).run(code, batasPakai, expiresAt, createdAt, plan.code);
  return { ok: true, coupon: kuponTrial(code)! };
}

export type HasilPeriksaKupon =
  | { ok: true; kupon: BarisKuponTrial; discountIdr: number }
  | { ok: false; status: number; error: string; message: string };

/**
 * Memeriksa kupon percobaan untuk satu paket.
 *
 * Urutan pemeriksaan: kode ada -> aktif -> belum kedaluwarsa -> paket cocok -> belum habis dipakai.
 * Paket diperiksa sebelum sisa pakai supaya percobaan untuk paket yang salah selalu dijawab
 * TRIAL_PLAN_ONLY, bukan pesan "sudah habis" yang menyesatkan.
 */
export function periksaKuponTrial(code: string, planCode: string, amountIdr: number): HasilPeriksaKupon {
  const row = kuponTrial(code);
  if (!row) return { ok: false, status: 400, error: "COUPON_NOT_FOUND", message: "Kode kupon tidak ditemukan." };
  if (!row.trial) return { ok: false, status: 400, error: "NOT_TRIAL_COUPON", message: "Kode itu bukan kupon percobaan." };
  if (!row.active) return { ok: false, status: 400, error: "COUPON_INACTIVE", message: "Kupon ini sudah dinonaktifkan." };
  const sekarang = new Date().toISOString();
  if (row.expiresAt && row.expiresAt < sekarang) return { ok: false, status: 400, error: "COUPON_EXPIRED", message: "Kupon percobaan ini sudah kedaluwarsa." };
  if (row.trialPlanCode && String(planCode ?? "").trim() && row.trialPlanCode !== String(planCode).trim()) {
    return { ok: false, status: 400, error: "TRIAL_PLAN_ONLY", message: TRIAL_PESAN_PAKET_SALAH };
  }
  if (row.maxUses > 0 && row.uses >= row.maxUses) return { ok: false, status: 400, error: "COUPON_EXHAUSTED", message: "Kupon percobaan ini sudah dipakai." };
  const nominal = Math.max(0, Math.round(amountIdr));
  const discountIdr = Math.min(nominal, Math.round((nominal * row.percent) / 100) + row.amountIdr);
  return { ok: true, kupon: row, discountIdr };
}

/** Langganan yang lahir dari satu pesanan, dipakai rute percobaan untuk membuktikan aktivasi. */
export function langgananPesanan(orderId: string) {
  const row = db.prepare("SELECT id, plan_code AS planCode, status, started_at AS startedAt, expires_at AS expiresAt FROM subscriptions WHERE order_id=? ORDER BY created_at DESC LIMIT 1")
    .get(orderId) as any;
  return row ?? null;
}

/** Rute butir 75: rute admin, rute pemeriksaan, dan rute pesanan percobaan. */
export function registerTrialCouponRoutes(app: any): void {
  app.post("/api/v1/admin/coupons/trial", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const hasil = buatKuponTrial({ planCode: request.body?.planCode, hours: request.body?.hours, maxUses: request.body?.maxUses });
    if (!hasil.ok) return fail(reply, hasil.status, hasil.error, hasil.message);
    audit(request.user!.id, "billing.trial_coupon_created", {
      code: hasil.coupon.code, planCode: hasil.coupon.trialPlanCode, maxUses: hasil.coupon.maxUses, expiresAt: hasil.coupon.expiresAt,
    });
    return reply.code(201).send({
      coupon: hasil.coupon,
      catatan: "Kupon percobaan hanya sah untuk paket yang ditentukan, sekali pakai, dan tidak diperpanjang otomatis.",
    });
  });

  app.get("/api/v1/admin/coupons/trial", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    return { coupons: daftarKuponTrial(Number(request.query?.limit ?? 50) || 50) };
  });

  app.post("/api/v1/billing/trial-coupons/validate", { preHandler: requireUser }, async (request: any, reply: any) => {
    const planCode = String(request.body?.planCode ?? "").trim();
    const plan = getPlan(planCode);
    const nominal = request.body?.amountIdr == null ? (plan?.priceIdr ?? 0) : Math.round(Number(request.body.amountIdr));
    const hasil = periksaKuponTrial(String(request.body?.code ?? ""), planCode, nominal);
    if (!hasil.ok) return fail(reply, hasil.status, hasil.error, hasil.message, { planCode });
    return {
      ok: true, code: hasil.kupon.code, trial: true, trialPlanCode: hasil.kupon.trialPlanCode,
      percent: hasil.kupon.percent, discountIdr: hasil.discountIdr, totalIdr: Math.max(0, nominal - hasil.discountIdr),
      expiresAt: hasil.kupon.expiresAt, maxUses: hasil.kupon.maxUses, uses: hasil.kupon.uses,
    };
  });

  app.post("/api/v1/billing/trial-orders", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const planCode = String(request.body?.planCode ?? "").trim();
    const couponCode = String(request.body?.couponCode ?? "").trim().toUpperCase();
    const plan = getPlan(planCode);
    if (!plan || !plan.active) return fail(reply, 404, "PLAN_NOT_FOUND", "Paket itu tidak ada atau sedang tidak aktif.");
    const hasil = periksaKuponTrial(couponCode, plan.code, plan.priceIdr);
    if (!hasil.ok) return fail(reply, hasil.status, hasil.error, hasil.message, { planCode: plan.code, couponCode });
    // Percobaan selalu satu periode: bulan yang lebih panjang tidak pernah diakui diam-diam.
    const dibuat = createOrder({ userId, planCode: plan.code, months: 1, couponCode: hasil.kupon.code, method: "manual", note: "Pesanan percobaan" });
    if (!dibuat.ok) {
      const status = dibuat.error === "PLAN_NOT_FOUND" ? 404 : 400;
      return fail(reply, status, dibuat.error, "Kupon percobaan tidak bisa dipakai untuk pesanan ini.");
    }
    if (dibuat.order.totalIdr > 0) {
      // Kupon percobaan wajib menutup seluruh biaya; kalau tidak, pesanan dibatalkan agar tidak ada tagihan diam-diam.
      db.prepare("UPDATE orders SET status='cancelled', note=?, updated_at=? WHERE id=?").run("Dibatalkan: kupon percobaan tidak menutup seluruh biaya", new Date().toISOString(), dibuat.order.id);
      return fail(reply, 400, "TRIAL_NOT_FREE", "Kupon percobaan harus menutup seluruh biaya paket.");
    }
    const langganan = langgananPesanan(dibuat.order.id);
    const setelah = kuponTrial(hasil.kupon.code)!;
    audit(userId, "billing.trial_order_created", {
      orderId: dibuat.order.id, planCode: plan.code, couponCode: setelah.code, uses: setelah.uses, expiresAt: setelah.expiresAt,
    });
    return reply.code(201).send({
      order: dibuat.order,
      subscription: langganan,
      trial: { couponCode: setelah.code, trialPlanCode: setelah.trialPlanCode, uses: setelah.uses, maxUses: setelah.maxUses, expiresAt: setelah.expiresAt },
      catatan: "Kupon percobaan sudah terpakai dan masa berlakunya tidak diperpanjang. Masa langganan mengikuti aturan paket.",
    });
  });
}

import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";

/**
 * Commerce layer: plans, orders, coupons, subscriptions, token credit, quota and payment records.
 * All money values are whole Indonesian rupiah (IDR); token values are whole numbers.
 * Nothing here sends data anywhere: payment gateways stay behind their own callback routes.
 */

export type PlanRow = {
  code: string; name: string; description: string; priceIdr: number; periodDays: number; tier: string;
  dailyTokenLimit: number; monthlyTokenLimit: number; bonusTokens: number; features: string[];
  sortOrder: number; active: boolean;
};

export type OrderRow = {
  id: string; userId: string; planCode: string; months: number; amountIdr: number; discountIdr: number;
  totalIdr: number; couponCode: string | null; method: string; status: string; note: string;
  proofArtifactId: string | null; decidedBy: string | null; decidedAt: string | null;
  createdAt: string; updatedAt: string;
};

const nowIso = () => new Date().toISOString();
const isoDay = (date = new Date()) => date.toISOString().slice(0, 10);
const isoMonth = (date = new Date()) => date.toISOString().slice(0, 7);

/* ---------------------------------------------------------------- settings */

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM platform_settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(key, value, nowIso());
}

export function getJsonSetting<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function setJsonSetting(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

const DEFAULT_BRANDING = {
  appName: "COBLAI Coder",
  tagline: "Coder's Omni Builder Labs (AI)",
  primaryColor: "#38bdf8",
  logoUrl: "",
  faviconUrl: "",
  supportEmail: "",
};

export type Branding = typeof DEFAULT_BRANDING;

export function branding(): Branding {
  const saved = getJsonSetting<Partial<Branding>>("branding", {});
  return { ...DEFAULT_BRANDING, ...saved };
}

export function saveBranding(patch: Partial<Branding>): Branding {
  const next = { ...branding(), ...patch };
  setJsonSetting("branding", next);
  return next;
}

export type PaymentConfig = {
  gateway: "manual" | "xendit" | "midtrans";
  xenditEnabled: boolean;
  midtransEnabled: boolean;
  xenditConfigured: boolean;
  midtransConfigured: boolean;
  instructions: string;
  updatedAt?: string;
};

export function paymentConfig(): PaymentConfig {
  const saved = getJsonSetting<Partial<PaymentConfig>>("payment", {});
  return {
    gateway: saved.gateway ?? "manual",
    xenditEnabled: saved.xenditEnabled ?? false,
    midtransEnabled: saved.midtransEnabled ?? false,
    xenditConfigured: Boolean(config.XENDIT_SECRET_KEY),
    midtransConfigured: Boolean(config.MIDTRANS_SERVER_KEY),
    instructions: saved.instructions ?? "Transfer ke salah satu rekening, lalu unggah bukti transfer pada pesanan Anda.",
    updatedAt: saved.updatedAt,
  };
}

export function savePaymentConfig(patch: Partial<PaymentConfig>): PaymentConfig {
  const next = { ...paymentConfig(), ...patch, updatedAt: nowIso() };
  setJsonSetting("payment", next);
  return next;
}

export function usdToIdrRate(): number {
  const raw = Number(getSetting("usd_idr_rate"));
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 17876;
}

export function setUsdToIdrRate(rate: number): number {
  setSetting("usd_idr_rate", String(Math.max(1, Math.round(rate))));
  return usdToIdrRate();
}

/* ------------------------------------------------------------------- plans */

type PlanDbRow = {
  code: string; name: string; description: string; price_idr: number; period_days: number; tier: string;
  daily_token_limit: number; monthly_token_limit: number; bonus_tokens: number; features_json: string;
  sort_order: number; active: number;
};

function toPlan(row: PlanDbRow): PlanRow {
  return {
    code: row.code, name: row.name, description: row.description, priceIdr: row.price_idr,
    periodDays: row.period_days, tier: row.tier, dailyTokenLimit: row.daily_token_limit,
    monthlyTokenLimit: row.monthly_token_limit, bonusTokens: row.bonus_tokens,
    features: (() => { try { return JSON.parse(row.features_json) as string[]; } catch { return []; } })(),
    sortOrder: row.sort_order, active: row.active === 1,
  };
}

/**
 * Seed plans. The prices are starting points for the owner to edit in the admin page,
 * not a claim about the final price list.
 */
type SeedPlan = { code: string; name: string; description: string; priceIdr: number; periodDays: number; tier: string; dailyTokenLimit: number; monthlyTokenLimit: number; bonusTokens: number; features: string[]; sortOrder: number; active: boolean };
const SEED_PLANS: SeedPlan[] = [
  {
    code: "free", name: "Free", description: "Untuk mencoba semua fitur inti tanpa biaya.", priceIdr: 0,
    periodDays: 30, tier: "free", dailyTokenLimit: 400_000, monthlyTokenLimit: 4_000_000, bonusTokens: 0,
    features: ["1 workspace", "Knowledge base + pencarian", "Workflow + jadwal", "Riwayat & biaya pemakaian"],
    sortOrder: 1, active: true,
  },
  {
    code: "premium", name: "Premium", description: "Untuk pemakaian harian dan proyek aktif.", priceIdr: 199_000,
    periodDays: 30, tier: "premium", dailyTokenLimit: 3_000_000, monthlyTokenLimit: 40_000_000, bonusTokens: 5_000_000,
    features: ["Kuota harian 3 juta token", "Bonus 5 juta token", "Anggota tim + peran", "Workflow terjadwal + persetujuan", "Dukungan prioritas"],
    sortOrder: 2, active: true,
  },
  {
    code: "enterprise", name: "Enterprise", description: "Untuk tim besar dan pemakaian berat.", priceIdr: 799_000,
    periodDays: 30, tier: "enterprise", dailyTokenLimit: 20_000_000, monthlyTokenLimit: 400_000_000, bonusTokens: 50_000_000,
    features: ["Kuota harian 20 juta token", "Bonus 50 juta token", "Tanpa batas workspace", "Pendampingan onboarding", "Dukungan utama"],
    sortOrder: 3, active: true,
  },
];

export function ensureDefaultPlans(): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO plans
    (code, name, description, price_idr, period_days, tier, daily_token_limit, monthly_token_limit, bonus_tokens, features_json, sort_order, active, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const plan of SEED_PLANS) {
    insert.run(plan.code, plan.name, plan.description, plan.priceIdr, plan.periodDays, plan.tier,
      plan.dailyTokenLimit, plan.monthlyTokenLimit, plan.bonusTokens, JSON.stringify(plan.features),
      plan.sortOrder, plan.active ? 1 : 0, nowIso());
  }
}

export function listPlans(activeOnly = true): PlanRow[] {
  const rows = db.prepare(`SELECT * FROM plans ${activeOnly ? "WHERE active=1" : ""} ORDER BY sort_order, price_idr`).all() as PlanDbRow[];
  return rows.map(toPlan);
}

export function getPlan(code: string): PlanRow | null {
  const row = db.prepare("SELECT * FROM plans WHERE code=?").get(code) as PlanDbRow | undefined;
  return row ? toPlan(row) : null;
}

export function updatePlan(code: string, patch: Partial<PlanRow>): PlanRow | null {
  const current = getPlan(code);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`UPDATE plans SET name=?, description=?, price_idr=?, period_days=?, tier=?, daily_token_limit=?,
    monthly_token_limit=?, bonus_tokens=?, features_json=?, sort_order=?, active=?, updated_at=? WHERE code=?`)
    .run(next.name, next.description, Math.max(0, Math.round(next.priceIdr)), Math.max(1, Math.round(next.periodDays)),
      next.tier, Math.max(0, Math.round(next.dailyTokenLimit)), Math.max(0, Math.round(next.monthlyTokenLimit)),
      Math.max(0, Math.round(next.bonusTokens)), JSON.stringify(next.features), Math.round(next.sortOrder),
      next.active ? 1 : 0, nowIso(), code);
  return getPlan(code);
}

/* ------------------------------------------------------- tier, credit, quota */

export function userTier(userId: string): string {
  const row = db.prepare("SELECT tier FROM users WHERE id=?").get(userId) as { tier: string } | undefined;
  return row?.tier || "free";
}

export function activeSubscription(userId: string) {
  const row = db.prepare(`SELECT id, plan_code AS planCode, status, started_at AS startedAt, expires_at AS expiresAt, order_id AS orderId
    FROM subscriptions WHERE user_id=? AND status='active' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`)
    .get(userId, nowIso()) as { id: string; planCode: string; status: string; startedAt: string; expiresAt: string; orderId: string | null } | undefined;
  return row ?? null;
}

export function expireSubscriptions(): number {
  const result = db.prepare("UPDATE subscriptions SET status='expired' WHERE status='active' AND expires_at <= ?").run(nowIso());
  return result.changes;
}

export function creditBalance(userId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(tokens),0) AS total FROM credit_ledger WHERE user_id=?").get(userId) as { total: number };
  return row.total;
}

export function grantCredit(userId: string, tokens: number, reason: string, ref?: string | null, note = ""): string {
  const id = randomUUID();
  db.prepare("INSERT INTO credit_ledger (id, user_id, tokens, reason, ref, note, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, userId, Math.round(tokens), reason, ref ?? null, note, nowIso());
  return id;
}

export function creditHistory(userId: string, limit = 50) {
  return db.prepare("SELECT id, tokens, reason, ref, note, created_at AS createdAt FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit);
}

/** Token counts actually consumed by one user. run_usage covers project runs (joined through the
 *  workspace membership), while user_usage covers calls without a project, such as the playground. */
export function tokensUsed(userId: string, since: string): number {
  const row = db.prepare(`SELECT
      COALESCE((SELECT SUM(COALESCE(u.total_tokens, COALESCE(u.input_tokens,0)+COALESCE(u.output_tokens,0)))
        FROM run_usage u JOIN projects p ON p.id = u.project_id JOIN memberships m ON m.workspace_id = p.workspace_id
        WHERE m.user_id=? AND u.created_at >= ?),0)
      + COALESCE((SELECT SUM(u2.total_tokens) FROM user_usage u2 WHERE u2.user_id=? AND u2.created_at >= ?),0)
    AS tokens`).get(userId, since, userId, since) as { tokens: number };
  return row.tokens;
}

export type QuotaState = {
  tier: string; dayKey: string; monthKey: string; usedToday: number; usedMonth: number;
  dailyLimit: number; monthlyLimit: number; creditTokens: number;
  remainingToday: number | null; remainingMonth: number | null; blocked: boolean; reason: string | null;
};

/** Builds the quota picture for one user: tier limits from the active plan, plus purchased credit. */
/** Latest of a period start and the admin reset stamp: the point from which usage counts again. */
function countingSince(userId: string, floorIso: string): string {
  const row = db.prepare("SELECT reset_at AS resetAt FROM token_quotas WHERE user_id=?").get(userId) as { resetAt: string | null } | undefined;
  const resetAt = row?.resetAt ?? null;
  return resetAt && resetAt > floorIso ? resetAt : floorIso;
}

export function quotaState(userId: string): QuotaState {
  const tier = userTier(userId);
  const plan = getPlan(tier) ?? getPlan("free");
  const dayKey = isoDay();
  const monthKey = isoMonth();
  // An admin quota reset only moves the counting start; usage history stays untouched.
  const usedToday = tokensUsed(userId, countingSince(userId, `${dayKey}T00:00:00.000Z`));
  const usedMonth = tokensUsed(userId, countingSince(userId, `${monthKey}-01T00:00:00.000Z`));
  const credit = creditBalance(userId);
  const dailyLimit = plan?.dailyTokenLimit ?? 0;
  const monthlyLimit = plan?.monthlyTokenLimit ?? 0;
  db.prepare(`INSERT INTO token_quotas (user_id, tier, day_key, day_tokens, month_key, month_tokens, updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier, day_key=excluded.day_key,
    day_tokens=excluded.day_tokens, month_key=excluded.month_key, month_tokens=excluded.month_tokens, updated_at=excluded.updated_at`)
    .run(userId, tier, dayKey, usedToday, monthKey, usedMonth, nowIso());
  const dailyCeiling = dailyLimit > 0 ? dailyLimit + credit : 0;
  const monthlyCeiling = monthlyLimit > 0 ? monthlyLimit : 0;
  let blocked = false;
  let reason: string | null = null;
  if (dailyCeiling > 0 && usedToday >= dailyCeiling) { blocked = true; reason = "DAILY_TOKEN_QUOTA_EXCEEDED"; }
  else if (monthlyCeiling > 0 && usedMonth >= monthlyCeiling) { blocked = true; reason = "MONTHLY_TOKEN_QUOTA_EXCEEDED"; }
  return {
    tier, dayKey, monthKey, usedToday, usedMonth, dailyLimit, monthlyLimit, creditTokens: credit,
    remainingToday: dailyCeiling > 0 ? Math.max(0, dailyCeiling - usedToday) : null,
    remainingMonth: monthlyCeiling > 0 ? Math.max(0, monthlyCeiling - usedMonth) : null,
    blocked, reason,
  };
}

/** Returns a block description when the user may not start another run, otherwise null. */
export function quotaGuard(userId: string, workspaceId: string): { status: number; error: string; detail?: Record<string, unknown> } | null {
  // Platform admins keep working even when a customer tier would be exhausted.
  const admin = db.prepare("SELECT is_admin FROM users WHERE id=?").get(userId) as { is_admin: number } | undefined;
  const allowedEmail = config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const email = (db.prepare("SELECT email FROM users WHERE id=?").get(userId) as { email: string } | undefined)?.email?.toLowerCase();
  if (admin?.is_admin === 1 || (email && allowedEmail.includes(email))) return null;
  const state = quotaState(userId);
  if (!state.blocked) return null;
  return {
    status: 429,
    error: state.reason ?? "QUOTA_EXCEEDED",
    detail: {
      tier: state.tier, usedToday: state.usedToday, dailyLimit: state.dailyLimit,
      usedMonth: state.usedMonth, monthlyLimit: state.monthlyLimit, creditTokens: state.creditTokens,
      message: state.reason === "DAILY_TOKEN_QUOTA_EXCEEDED"
        ? "Kuota harian paket Anda sudah habis. Tingkatkan paket atau beli kredit token untuk lanjut."
        : "Kuota bulanan paket Anda sudah habis. Tingkatkan paket untuk lanjut.",
    },
  };
}

/**
 * Charges extra usage against purchased credit. Usage inside the tier limit changes nothing,
 * so the ledger only moves when a run pushes the user past the daily tier limit.
 */
export function chargeQuota(userId: string, tokens: number): { moved: number; balance: number } {
  const plan = getPlan(userTier(userId)) ?? getPlan("free");
  const dailyLimit = plan?.dailyTokenLimit ?? 0;
  if (tokens <= 0 || dailyLimit <= 0) return { moved: 0, balance: creditBalance(userId) };
  const used = tokensUsed(userId, countingSince(userId, `${isoDay()}T00:00:00.000Z`));
  const overflowToday = Math.max(0, used - dailyLimit);
  if (overflowToday <= 0) return { moved: 0, balance: creditBalance(userId) };
  const balance = creditBalance(userId);
  // The same counting start as quotaState, so an admin reset also restarts the overflow charge.
  const since = countingSince(userId, `${isoDay()}T00:00:00.000Z`);
  const alreadyCharged = db.prepare("SELECT COALESCE(-SUM(tokens),0) AS charged FROM credit_ledger WHERE user_id=? AND reason='usage_overflow' AND created_at >= ?")
    .get(userId, since) as { charged: number };
  const due = Math.max(0, overflowToday - alreadyCharged.charged);
  const move = Math.min(due, balance);
  if (move <= 0) return { moved: 0, balance };
  grantCredit(userId, -move, "usage_overflow", null, `Pemakaian di luar kuota harian (${isoDay()})`);
  return { moved: move, balance: creditBalance(userId) };
}

/* ----------------------------------------------------------------- coupons */

export type CouponRow = {
  code: string; percent: number; amountIdr: number; maxUses: number; uses: number;
  expiresAt: string | null; active: boolean; createdAt: string;
};

function toCoupon(row: any): CouponRow {
  return {
    code: row.code, percent: row.percent, amountIdr: row.amount_idr, maxUses: row.max_uses, uses: row.uses,
    expiresAt: row.expires_at, active: row.active === 1, createdAt: row.created_at,
  };
}

export function listCoupons(): CouponRow[] {
  return (db.prepare("SELECT * FROM coupons ORDER BY created_at DESC").all() as any[]).map(toCoupon);
}

export function createCoupon(input: { code: string; percent?: number; amountIdr?: number; maxUses?: number; expiresAt?: string | null }): CouponRow {
  const code = input.code.trim().toUpperCase();
  db.prepare("INSERT INTO coupons (code, percent, amount_idr, max_uses, uses, expires_at, active, created_at) VALUES (?,?,?,?,0,?,1,?)")
    .run(code, Math.max(0, Math.min(100, Math.round(input.percent ?? 0))), Math.max(0, Math.round(input.amountIdr ?? 0)),
      Math.max(0, Math.round(input.maxUses ?? 0)), input.expiresAt ?? null, nowIso());
  return toCoupon(db.prepare("SELECT * FROM coupons WHERE code=?").get(code));
}

export function setCouponActive(code: string, active: boolean): boolean {
  return db.prepare("UPDATE coupons SET active=? WHERE code=?").run(active ? 1 : 0, code.trim().toUpperCase()).changes > 0;
}

export function validateCoupon(code: string, amountIdr: number): { ok: true; discountIdr: number; coupon: CouponRow } | { ok: false; error: string } {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) return { ok: false, error: "COUPON_REQUIRED" };
  const row = db.prepare("SELECT * FROM coupons WHERE code=?").get(normalized);
  if (!row) return { ok: false, error: "COUPON_NOT_FOUND" };
  const coupon = toCoupon(row);
  if (!coupon.active) return { ok: false, error: "COUPON_INACTIVE" };
  if (coupon.expiresAt && coupon.expiresAt < nowIso()) return { ok: false, error: "COUPON_EXPIRED" };
  if (coupon.maxUses > 0 && coupon.uses >= coupon.maxUses) return { ok: false, error: "COUPON_EXHAUSTED" };
  const percent = coupon.percent > 0 ? Math.round((amountIdr * coupon.percent) / 100) : 0;
  const discountIdr = Math.min(amountIdr, percent + coupon.amountIdr);
  return { ok: true, discountIdr, coupon };
}

/* ------------------------------------------------------------------ orders */

function toOrder(row: any): OrderRow {
  return {
    id: row.id, userId: row.user_id, planCode: row.plan_code, months: row.months, amountIdr: row.amount_idr,
    discountIdr: row.discount_idr, totalIdr: row.total_idr, couponCode: row.coupon_code, method: row.method,
    status: row.status, note: row.note, proofArtifactId: row.proof_artifact_id, decidedBy: row.decided_by,
    decidedAt: row.decided_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getOrder(orderId: string): OrderRow | null {
  const row = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
  return row ? toOrder(row) : null;
}

export function listOrders(filter: { userId?: string; status?: string; limit?: number } = {}): OrderRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) { clauses.push("user_id=?"); params.push(filter.userId); }
  if (filter.status) { clauses.push("status=?"); params.push(filter.status); }
  params.push(Math.min(500, Math.max(1, filter.limit ?? 100)));
  const sql = `SELECT * FROM orders ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
  return (db.prepare(sql).all(...(params as any[])) as any[]).map(toOrder);
}

export function createOrder(input: { userId: string; planCode: string; months?: number; couponCode?: string | null; method?: string; note?: string }):
  { ok: true; order: OrderRow } | { ok: false; error: string } {
  const plan = getPlan(input.planCode);
  if (!plan || !plan.active) return { ok: false, error: "PLAN_NOT_FOUND" };
  const months = Math.min(24, Math.max(1, Math.round(input.months ?? 1)));
  const amountIdr = plan.priceIdr * months;
  let discountIdr = 0;
  const couponCode = (input.couponCode || "").trim().toUpperCase() || null;
  if (couponCode) {
    const check = validateCoupon(couponCode, amountIdr);
    if (!check.ok) return { ok: false, error: check.error };
    discountIdr = check.discountIdr;
  }
  const totalIdr = Math.max(0, amountIdr - discountIdr);
  const id = randomUUID();
  const stamp = nowIso();
  const method = (input.method || (totalIdr === 0 ? "free" : "manual")).slice(0, 32);
  db.prepare(`INSERT INTO orders (id, user_id, plan_code, months, amount_idr, discount_idr, total_idr, coupon_code,
    method, status, note, proof_artifact_id, decided_by, decided_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)`)
    .run(id, input.userId, plan.code, months, amountIdr, discountIdr, totalIdr, couponCode, method, "pending",
      (input.note || "").slice(0, 500), stamp, stamp);
  if (couponCode) db.prepare("UPDATE coupons SET uses = uses + 1 WHERE code=?").run(couponCode);
  const order = getOrder(id)!;
  // A free plan or a 100% coupon needs no payment step, so it activates straight away.
  if (totalIdr === 0) {
    markOrderPaid(id, null, "Otomatis: total Rp0");
    return { ok: true, order: getOrder(id)! };
  }
  return { ok: true, order };
}

/** Activates the subscription and grants the plan bonus. Also used by gateway callbacks. */
export function markOrderPaid(orderId: string, adminUserId: string | null, note = ""): { ok: true; order: OrderRow; subscriptionId: string } | { ok: false; error: string } {
  const order = getOrder(orderId);
  if (!order) return { ok: false, error: "ORDER_NOT_FOUND" };
  if (order.status === "paid") return { ok: true, order, subscriptionId: "" };
  const plan = getPlan(order.planCode);
  if (!plan) return { ok: false, error: "PLAN_NOT_FOUND" };
  const stamp = nowIso();
  const startedAt = stamp;
  const base = activeSubscription(order.userId);
  const startMs = base ? Math.max(Date.parse(base.expiresAt), Date.parse(stamp)) : Date.parse(stamp);
  const expiresAt = new Date(startMs + plan.periodDays * order.months * 24 * 3600 * 1000).toISOString();
  const subscriptionId = randomUUID();
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_code, status, started_at, expires_at, order_id, created_at)
    VALUES (?,?,?,'active',?,?,?,?)`).run(subscriptionId, order.userId, plan.code, startedAt, expiresAt, order.id, stamp);
  db.prepare("UPDATE users SET tier=?, updated_at=? WHERE id=?").run(plan.tier, stamp, order.userId);
  if (plan.bonusTokens > 0) grantCredit(order.userId, plan.bonusTokens * order.months, "plan_purchase", order.id, `Bonus paket ${plan.name}`);
  db.prepare("UPDATE orders SET status='paid', decided_by=?, decided_at=?, note=?, updated_at=? WHERE id=?")
    .run(adminUserId, stamp, note.slice(0, 500) || order.note, stamp, order.id);
  return { ok: true, order: getOrder(order.id)!, subscriptionId };
}

export function rejectOrder(orderId: string, adminUserId: string, note = ""): OrderRow | null {
  const order = getOrder(orderId);
  if (!order || order.status === "paid") return null;
  db.prepare("UPDATE orders SET status='rejected', decided_by=?, decided_at=?, note=?, updated_at=? WHERE id=?")
    .run(adminUserId, nowIso(), note.slice(0, 500), nowIso(), orderId);
  return getOrder(orderId);
}

export function attachOrderProof(orderId: string, artifactId: string): void {
  db.prepare("UPDATE orders SET proof_artifact_id=?, updated_at=? WHERE id=?").run(artifactId, nowIso(), orderId);
}

export function recordPayment(input: { orderId: string | null; userId: string | null; provider: string; providerRef?: string | null; amountIdr?: number; status: string; raw?: unknown }): string {
  const id = randomUUID();
  db.prepare("INSERT INTO payments (id, order_id, user_id, provider, provider_ref, amount_idr, status, raw_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, input.orderId, input.userId, input.provider, input.providerRef ?? null, Math.round(input.amountIdr ?? 0),
      input.status, JSON.stringify(input.raw ?? {}).slice(0, 20000), nowIso());
  return id;
}

export function listPayments(orderId: string) {
  return db.prepare("SELECT id, provider, provider_ref AS providerRef, amount_idr AS amountIdr, status, created_at AS createdAt FROM payments WHERE order_id=? ORDER BY created_at DESC").all(orderId);
}

/* ---------------------------------------------------------------- revenue */

export type RevenueSummary = {
  days: number; since: string; revenueIdr: number; costIdr: number; marginIdr: number; marginPercent: number | null;
  paidOrders: number; pendingOrders: number; tokens: number; costUsd: number; usdIdrRate: number;
  activeSubscriptions: number; newSubscriptions: number; creditGrantedTokens: number;
};

/** Revenue, cost and margin for the last N days. Cost comes from run_usage, converted at the stored rate. */
export function revenueSummary(days = 30): RevenueSummary {
  const window = Math.min(365, Math.max(1, Math.round(days)));
  const since = new Date(Date.now() - window * 24 * 3600 * 1000).toISOString();
  const revenue = db.prepare("SELECT COALESCE(SUM(total_idr),0) AS total, COUNT(*) AS count FROM orders WHERE status='paid' AND COALESCE(decided_at, created_at) >= ?").get(since) as { total: number; count: number };
  const pending = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status='pending'").get() as { count: number };
  const usage = db.prepare(`SELECT COALESCE(SUM(cost_micros),0) AS micros,
      COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens,0)+COALESCE(output_tokens,0))),0) AS tokens
    FROM run_usage WHERE created_at >= ?`).get(since) as { micros: number; tokens: number };
  const rate = usdToIdrRate();
  const costUsd = usage.micros / 1_000_000;
  const costIdr = Math.round(costUsd * rate);
  const active = db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE status='active' AND expires_at > ?").get(nowIso()) as { count: number };
  const fresh = db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE created_at >= ?").get(since) as { count: number };
  const credit = db.prepare("SELECT COALESCE(SUM(tokens),0) AS total FROM credit_ledger WHERE tokens > 0 AND created_at >= ?").get(since) as { total: number };
  return {
    days: window, since, revenueIdr: revenue.total, costIdr, marginIdr: revenue.total - costIdr,
    marginPercent: revenue.total > 0 ? Math.round(((revenue.total - costIdr) / revenue.total) * 1000) / 10 : null,
    paidOrders: revenue.count, pendingOrders: pending.count, tokens: usage.tokens, costUsd: Math.round(costUsd * 10000) / 10000,
    usdIdrRate: rate, activeSubscriptions: active.count, newSubscriptions: fresh.count, creditGrantedTokens: credit.total,
  };
}

/* ---------------------------------------------------------- bank accounts */

export function listBankAccounts(activeOnly = true) {
  return db.prepare(`SELECT id, bank_name AS bankName, account_number AS accountNumber, account_holder AS accountHolder,
    note, sort_order AS sortOrder, active, created_at AS createdAt FROM bank_accounts ${activeOnly ? "WHERE active=1" : ""} ORDER BY sort_order, created_at`).all() as any[];
}

export function createBankAccount(input: { bankName: string; accountNumber: string; accountHolder: string; note?: string; sortOrder?: number }) {
  const id = randomUUID();
  db.prepare("INSERT INTO bank_accounts (id, bank_name, account_number, account_holder, note, sort_order, active, created_at) VALUES (?,?,?,?,?,?,1,?)")
    .run(id, input.bankName.slice(0, 80), input.accountNumber.slice(0, 60), input.accountHolder.slice(0, 120),
      (input.note || "").slice(0, 200), Math.round(input.sortOrder ?? 0), nowIso());
  return db.prepare("SELECT id, bank_name AS bankName, account_number AS accountNumber, account_holder AS accountHolder, note FROM bank_accounts WHERE id=?").get(id);
}

export function deleteBankAccount(id: string): boolean {
  return db.prepare("DELETE FROM bank_accounts WHERE id=?").run(id).changes > 0;
}

/** Moves the quota counting start to now, so a blocked user can work again today. */
export function resetQuota(userId: string, reason = "Direset oleh admin"): QuotaState {
  const stamp = nowIso();
  db.prepare(`INSERT INTO token_quotas (user_id, tier, day_key, day_tokens, month_key, month_tokens, updated_at, reset_at)
    VALUES (?,?,?,0,?,0,?,?)
    ON CONFLICT(user_id) DO UPDATE SET reset_at=excluded.reset_at, updated_at=excluded.updated_at`)
    .run(userId, userTier(userId), isoDay(), isoMonth(), stamp, stamp);
  return quotaState(userId);
}

/** Called once at boot: seeds plans and refreshes expired subscriptions. */
export function ensureCommerceSeed(): void {
  ensureDefaultPlans();
  expireSubscriptions();
}

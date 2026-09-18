import { randomUUID, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { grantCredit } from "./billing.js";
import { shareDevice } from "./devices.js";

/** Wave 7: the referral programme.
 *
 *  How it works, and why it is shaped this way:
 *  - Every account gets one short code. The code is public; the reward is not instant.
 *  - A reward is only paid AFTER the invited account finishes its first run. Creating accounts on its
 *    own pays nothing, so mass registration has no value.
 *  - The registration IP is stored on the referral row. When it equals the inviter's own registration
 *    IP, the referral is marked `blocked` with reason SAME_IP instead of being paid.
 *  - HONEST LIMIT: a determined person with two different networks can still create a second account.
 *    Email verification is not enforced on this platform yet, so this check cannot be airtight.
 */

export type ReferralStatus = "pending" | "qualified" | "rewarded" | "blocked";

export type ReferralRow = {
  id: string; code: string; inviterUserId: string; inviteeUserId: string;
  inviteeEmail: string | null; status: ReferralStatus; blockedReason: string | null;
  inviterTokens: number; inviteeTokens: number;
  createdAt: string; qualifiedAt: string | null; rewardedAt: string | null;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: codes get typed by hand

function newCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function referralProgrammeEnabled(): boolean {
  return config.REFERRAL_ENABLED;
}

export function referralLimits() {
  return {
    enabled: config.REFERRAL_ENABLED,
    inviterTokens: config.REFERRAL_INVITER_TOKENS,
    inviteeTokens: config.REFERRAL_INVITEE_TOKENS,
    maxRewardedPerUser: config.REFERRAL_MAX_REWARDED_PER_USER,
  };
}

function rowToReferral(row: Record<string, unknown>): ReferralRow {
  return {
    id: String(row.id), code: String(row.code),
    inviterUserId: String(row.inviter_user_id), inviteeUserId: String(row.invitee_user_id),
    inviteeEmail: (row.invitee_email as string | null) ?? null,
    status: String(row.status) as ReferralStatus,
    blockedReason: (row.blocked_reason as string | null) ?? null,
    inviterTokens: Number(row.inviter_tokens ?? 0), inviteeTokens: Number(row.invitee_tokens ?? 0),
    createdAt: String(row.created_at), qualifiedAt: (row.qualified_at as string | null) ?? null,
    rewardedAt: (row.rewarded_at as string | null) ?? null,
  };
}

/** The code that belongs to one account, created on first use. */
export function ensureReferralCode(userId: string): string {
  const existing = db.prepare("SELECT code FROM referral_codes WHERE user_id=?").get(userId) as { code: string } | undefined;
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = newCode();
    try {
      db.prepare("INSERT INTO referral_codes (code, user_id, created_at, uses, active) VALUES (?,?,?,0,1)")
        .run(code, userId, new Date().toISOString());
      return code;
    } catch {
      /* a collision is extremely unlikely; try another code */
    }
  }
  throw new Error("REFERRAL_CODE_FAILED");
}

/** Replaces the code with a fresh one. Old links stop working; pending referrals keep their code. */
export function rotateReferralCode(userId: string): string {
  db.prepare("DELETE FROM referral_codes WHERE user_id=?").run(userId);
  return ensureReferralCode(userId);
}

export function codeOwner(code: string): { userId: string } | null {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) return null;
  const row = db.prepare("SELECT user_id AS userId, active FROM referral_codes WHERE code=?").get(normalized) as { userId: string; active: number } | undefined;
  if (!row || row.active !== 1) return null;
  return { userId: row.userId };
}

/** Called from registration when the sign-up form carried a referral code. It never throws. */
export function attachReferral(input: {
  inviteeUserId: string; inviteeEmail: string; inviteeIp?: string | null; code?: string | null;
}): { ok: true; referralId: string; inviterUserId: string } | { ok: false; error: string } {
  const raw = (input.code || "").trim().toUpperCase();
  if (!raw) return { ok: false, error: "REFERRAL_CODE_REQUIRED" };
  if (!referralProgrammeEnabled()) return { ok: false, error: "REFERRAL_DISABLED" };
  const owner = codeOwner(raw);
  if (!owner) return { ok: false, error: "REFERRAL_CODE_NOT_FOUND" };
  if (owner.userId === input.inviteeUserId) return { ok: false, error: "REFERRAL_SELF" };
  const inviter = db.prepare("SELECT email, signup_ip AS signupIp FROM users WHERE id=?").get(owner.userId) as { email: string; signupIp: string | null } | undefined;
  if (!inviter) return { ok: false, error: "REFERRAL_CODE_NOT_FOUND" };
  const already = db.prepare("SELECT id FROM referrals WHERE invitee_user_id=?").get(input.inviteeUserId);
  if (already) return { ok: false, error: "REFERRAL_ALREADY_RECORDED" };

  const sameEmail = inviter.email.toLowerCase() === input.inviteeEmail.toLowerCase();
  const sameIp = Boolean(inviter.signupIp && input.inviteeIp && inviter.signupIp === input.inviteeIp);
  // Wave 10 (item 26): the same browser is the strongest sign that one person made both accounts, so
  // it blocks the reward even when the email address and the IP address differ.
  const sameDevice = shareDevice(owner.userId, input.inviteeUserId);
  const blockedReason = sameEmail ? "SAME_EMAIL" : sameIp ? "SAME_IP" : sameDevice ? "SAME_DEVICE" : null;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO referrals (id, code, inviter_user_id, invitee_user_id, invitee_email, invitee_ip, inviter_ip,
      status, blocked_reason, inviter_tokens, invitee_tokens, created_at, qualified_at, rewarded_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,0,?,NULL,NULL)`)
    .run(id, raw, owner.userId, input.inviteeUserId, input.inviteeEmail, input.inviteeIp ?? null, inviter.signupIp ?? null,
      blockedReason ? "blocked" : "pending", blockedReason, now);
  return { ok: true, referralId: id, inviterUserId: owner.userId };
}

/** Called after a run finishes with status `completed`. Pays the reward once, guarded by the row status
 *  and by the per-inviter ceiling. Returns what happened so the caller can notify both sides. */
export function qualifyReferralForRun(inviteeUserId: string): {
  status: "none" | "blocked" | "rewarded" | "ceiling";
  referralId?: string; inviterUserId?: string; inviteeEmail?: string | null;
  inviterTokens?: number; inviteeTokens?: number; reason?: string;
} {
  const row = db.prepare("SELECT * FROM referrals WHERE invitee_user_id=?").get(inviteeUserId) as Record<string, unknown> | undefined;
  if (!row) return { status: "none" };
  const referral = rowToReferral(row);
  if (referral.status === "blocked") return { status: "blocked", referralId: referral.id, reason: referral.blockedReason ?? "BLOCKED" };
  if (referral.status === "rewarded") return { status: "none" };
  // Wave 10 (item 26): a reward is only paid to an account that really proved its email address, so a
  // throwaway address cannot farm the programme. The row stays `pending`, so the reward is paid by a
  // later completed run once the invitee verifies the address.
  const invitee = db.prepare("SELECT email_verified AS emailVerified FROM users WHERE id=?").get(inviteeUserId) as { emailVerified: number } | undefined;
  if (config.REFERRAL_REQUIRE_VERIFIED_EMAIL && Number(invitee?.emailVerified ?? 0) !== 1) {
    return { status: "none", referralId: referral.id, reason: "EMAIL_NOT_VERIFIED" };
  }
  if (!referralProgrammeEnabled()) return { status: "none" };

  const ceiling = config.REFERRAL_MAX_REWARDED_PER_USER;
  if (ceiling > 0) {
    const paid = Number((db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE inviter_user_id=? AND status='rewarded'").get(referral.inviterUserId) as { n: number }).n);
    if (paid >= ceiling) {
      db.prepare("UPDATE referrals SET status='blocked', blocked_reason='CEILING' WHERE id=?").run(referral.id);
      return { status: "ceiling", referralId: referral.id, inviterUserId: referral.inviterUserId };
    }
  }

  const inviterTokens = Math.max(0, config.REFERRAL_INVITER_TOKENS);
  const inviteeTokens = Math.max(0, config.REFERRAL_INVITEE_TOKENS);
  const now = new Date().toISOString();
  db.prepare("UPDATE referrals SET status='qualified', qualified_at=? WHERE id=?").run(now, referral.id);
  if (inviterTokens > 0) grantCredit(referral.inviterUserId, inviterTokens, "referral_inviter", referral.id, `Undangan diterima: ${referral.inviteeEmail ?? referral.inviteeUserId}`);
  if (inviteeTokens > 0) grantCredit(referral.inviteeUserId, inviteeTokens, "referral_invitee", referral.id, "Bonus dari kode undangan");
  db.prepare("UPDATE referrals SET status='rewarded', rewarded_at=?, inviter_tokens=?, invitee_tokens=? WHERE id=?")
    .run(new Date().toISOString(), inviterTokens, inviteeTokens, referral.id);
  db.prepare("UPDATE referral_codes SET uses = uses + 1 WHERE code=?").run(referral.code);
  return {
    status: "rewarded", referralId: referral.id, inviterUserId: referral.inviterUserId,
    inviteeEmail: referral.inviteeEmail, inviterTokens, inviteeTokens,
  };
}

function referralLink(code: string): string {
  return `/?ref=${code}`;
}

/** What one account sees on its own referral screen. */
export function referralSummaryFor(userId: string): {
  enabled: boolean; code: string; link: string; limits: ReturnType<typeof referralLimits>;
  counters: { invited: number; pending: number; qualified: number; rewarded: number; blocked: number };
  tokensEarned: number; recent: ReferralRow[];
} {
  const code = ensureReferralCode(userId);
  const rows = db.prepare("SELECT * FROM referrals WHERE inviter_user_id=? ORDER BY created_at DESC LIMIT 50").all(userId) as Record<string, unknown>[];
  const items = rows.map(rowToReferral);
  const counters = {
    invited: items.length,
    pending: items.filter((r) => r.status === "pending").length,
    qualified: items.filter((r) => r.status === "qualified").length,
    rewarded: items.filter((r) => r.status === "rewarded").length,
    blocked: items.filter((r) => r.status === "blocked").length,
  };
  const tokensEarned = items.reduce((sum, r) => sum + (r.status === "rewarded" ? r.inviterTokens : 0), 0);
  return { enabled: referralProgrammeEnabled(), code, link: referralLink(code), limits: referralLimits(), counters, tokensEarned, recent: items };
}

/** Referrals this account was invited by (used to show "you were invited by" and the pending reward). */
export function referralEntryFor(userId: string): ReferralRow | null {
  const row = db.prepare("SELECT * FROM referrals WHERE invitee_user_id=?").get(userId) as Record<string, unknown> | undefined;
  return row ? rowToReferral(row) : null;
}

export function listReferralsFor(userId: string, limit = 100): ReferralRow[] {
  const rows = db.prepare("SELECT * FROM referrals WHERE inviter_user_id=? ORDER BY created_at DESC LIMIT ?")
    .all(userId, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
  return rows.map(rowToReferral);
}

/** Platform-wide view for the administrator screen. */
export function referralStats(): {
  codes: number; total: number; pending: number; qualified: number; rewarded: number; blocked: number;
  tokensGranted: number; blockedByReason: Array<{ reason: string; count: number }>;
} {
  const count = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  const codes = count("SELECT COUNT(*) AS n FROM referral_codes");
  const by = (status: string) => count("SELECT COUNT(*) AS n FROM referrals WHERE status=?", status);
  return {
    codes,
    total: count("SELECT COUNT(*) AS n FROM referrals"),
    pending: by("pending"), qualified: by("qualified"), rewarded: by("rewarded"), blocked: by("blocked"),
    tokensGranted: count("SELECT COALESCE(SUM(inviter_tokens + invitee_tokens),0) AS n FROM referrals WHERE status='rewarded'"),
    blockedByReason: db.prepare("SELECT COALESCE(blocked_reason,'UNKNOWN') AS reason, COUNT(*) AS count FROM referrals WHERE status='blocked' GROUP BY reason ORDER BY count DESC").all() as Array<{ reason: string; count: number }>,
  };
}

export function referralLeaderboard(limit = 10): Array<{ userId: string; email: string; rewarded: number; tokens: number; invited: number }> {
  return db.prepare(`SELECT r.inviter_user_id AS userId, COALESCE(u.email,'') AS email,
      SUM(CASE WHEN r.status='rewarded' THEN 1 ELSE 0 END) AS rewarded,
      COALESCE(SUM(r.inviter_tokens),0) AS tokens,
      COUNT(*) AS invited
    FROM referrals r LEFT JOIN users u ON u.id = r.inviter_user_id
    GROUP BY r.inviter_user_id ORDER BY rewarded DESC, invited DESC LIMIT ?`)
    .all(Math.max(1, Math.min(50, limit))) as Array<{ userId: string; email: string; rewarded: number; tokens: number; invited: number }>;
}

export function listReferralsAdmin(limit = 100): Array<ReferralRow & { inviterEmail: string; inviteeEmailConfirmed: string }> {
  const rows = db.prepare(`SELECT r.*, COALESCE(i.email,'') AS inviter_email, COALESCE(e.email,'') AS invitee_account_email
      FROM referrals r
      LEFT JOIN users i ON i.id = r.inviter_user_id
      LEFT JOIN users e ON e.id = r.invitee_user_id
      ORDER BY r.created_at DESC LIMIT ?`).all(Math.max(1, Math.min(1000, limit))) as Record<string, unknown>[];
  return rows.map((row) => ({
    ...rowToReferral(row),
    inviterEmail: String(row.inviter_email ?? ""),
    inviteeEmailConfirmed: String(row.invitee_account_email ?? ""),
  }));
}

export function countReferralCodes(): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM referral_codes").get() as { n: number }).n);
}

export { newCode as generateReferralCode };

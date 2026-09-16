/**
 * Rate limiter backed by the application database (Wave 8, 16 Sep 2026).
 *
 * Counters used to live in a Map inside the process, so a restart wiped them and two replicas
 * kept two different counts. Every accepted hit is now one row in `rate_limit_hits`, which keeps
 * the same sliding window behaviour: a key is refused once the window holds `max` hits.
 *
 * The table stays small because each call deletes the hits that already left the window, and a
 * sweep every minute drops the rows of inactive keys.
 */
import { db } from "./db.js";

export type RateLimitRule = { windowMs: number; max: number };

export type RateLimiter = {
  allow(key: string, now?: number): boolean;
  retryAfterSeconds(key: string, now?: number): number;
  reset(key?: string): void;
  size(): number;
};

/** Longest window any rule uses, plus a margin, so a sweep never removes a live hit. */
const SWEEP_AFTER_MS = 20 * 60 * 1000;
/** How often the whole table is swept for rows that belong to no active window. */
const SWEEP_INTERVAL_MS = 60 * 1000;

export function createRateLimiter(rule: RateLimitRule, namespace = "rate"): RateLimiter {
  let lastSweep = 0;
  // Every rule shares one table, so the counter key carries the rule name as well.
  // Without this, a per-minute API count and a per-hour registration count under the
  // same address would be added together and block each other.
  const bucketOf = (key: string) => `${namespace}:${key}`;

  /** Drops rows older than the longest window, whichever key they belong to. */
  function sweep(now: number): void {
    db.prepare("DELETE FROM rate_limit_hits WHERE hit_at <= ?").run(now - SWEEP_AFTER_MS);
  }

  function hitsInWindow(key: string, cutoff: number): number {
    const bucket = bucketOf(key);
    db.prepare("DELETE FROM rate_limit_hits WHERE bucket=? AND hit_at <= ?").run(bucket, cutoff);
    return Number((db.prepare("SELECT COUNT(*) AS total FROM rate_limit_hits WHERE bucket=?").get(bucket) as { total: number }).total);
  }

  return {
    allow(key: string, now: number = Date.now()): boolean {
      const total = hitsInWindow(key, now - rule.windowMs);
      if (total >= rule.max) return false;
      db.prepare("INSERT INTO rate_limit_hits (bucket, hit_at) VALUES (?,?)").run(bucketOf(key), now);
      if (now - lastSweep > SWEEP_INTERVAL_MS) {
        lastSweep = now;
        sweep(now);
      }
      return true;
    },

    retryAfterSeconds(key: string, now: number = Date.now()): number {
      const total = hitsInWindow(key, now - rule.windowMs);
      if (total < rule.max) return 0;
      // The slot frees up when the oldest hit leaves the window.
      const oldest = db.prepare("SELECT hit_at AS hitAt FROM rate_limit_hits WHERE bucket=? ORDER BY hit_at ASC LIMIT 1").get(bucketOf(key)) as { hitAt: number } | undefined;
      if (!oldest) return 0;
      const waitMs = oldest.hitAt + rule.windowMs - now;
      return waitMs <= 0 ? 0 : Math.ceil(waitMs / 1000);
    },

    reset(key?: string): void {
      if (key === undefined) db.prepare("DELETE FROM rate_limit_hits WHERE bucket LIKE ?").run(`${namespace}:%`);
      else db.prepare("DELETE FROM rate_limit_hits WHERE bucket=?").run(bucketOf(key));
    },

    size(): number {
      return Number((db.prepare("SELECT COUNT(DISTINCT bucket) AS total FROM rate_limit_hits WHERE bucket LIKE ?").get(`${namespace}:%`) as { total: number }).total);
    },
  };
}

export type LimiterName = "login" | "register" | "password" | "api" | "referral";

/** Reads a positive integer from the environment so one deployment can tune a limit. */
function envMax(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

// Defaults allow a shared office address or a test suite to work normally, while still
// stopping scripted abuse. Each number can be overridden per deployment or per test run.
const RULES: Record<LimiterName, RateLimitRule> = {
  login: { windowMs: 15 * 60 * 1000, max: envMax("RATE_LIMIT_LOGIN_PER_15MIN", 10) },
  register: { windowMs: 60 * 60 * 1000, max: envMax("RATE_LIMIT_REGISTER_PER_HOUR", 20) },
  password: { windowMs: 60 * 60 * 1000, max: envMax("RATE_LIMIT_PASSWORD_PER_HOUR", 20) },
  api: { windowMs: 60 * 1000, max: envMax("RATE_LIMIT_API_PER_MINUTE", 600) },
  // Wave 7: issuing a new referral code is a write, so it gets its own small window.
  referral: { windowMs: 60 * 60 * 1000, max: envMax("RATE_LIMIT_REFERRAL_PER_HOUR", 20) },
};

/** One shared limiter instance per name, so counters survive across route calls. */
const limiters = new Map<LimiterName, RateLimiter>();

export function limiterFor(name: LimiterName): RateLimiter {
  const existing = limiters.get(name);
  if (existing) return existing;
  const created = createRateLimiter(RULES[name], name);
  limiters.set(name, created);
  return created;
}

/** Honest report for the status hub: where the counters really live. */
export function rateLimitStorage() {
  return { store: "database" as const, table: "rate_limit_hits", rules: Object.fromEntries(Object.entries(RULES).map(([name, rule]) => [name, rule.max])) };
}

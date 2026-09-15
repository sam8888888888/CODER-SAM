/**
 * In-memory sliding window rate limiter with no external dependency.
 * One Map per limiter keeps recent hit timestamps (ms) for every key.
 */
export type RateLimitRule = { windowMs: number; max: number };

export type RateLimiter = {
  allow(key: string, now?: number): boolean;
  retryAfterSeconds(key: string, now?: number): number;
  reset(key?: string): void;
  size(): number;
};

/** Hard cap on tracked keys before the limiter sweeps inactive entries. */
const MAX_KEYS = 5000;

/** Removes timestamps outside the window and drops keys left without hits. */
function prune(stamps: number[], cutoff: number): number[] {
  return stamps.filter((stamp) => stamp > cutoff);
}

export function createRateLimiter(rule: RateLimitRule): RateLimiter {
  const hits = new Map<string, number[]>();

  /** Sweep: drop every key that has no timestamp inside the active window. */
  function sweep(now: number): void {
    const cutoff = now - rule.windowMs;
    for (const [key, stamps] of hits) {
      const fresh = prune(stamps, cutoff);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }

  return {
    allow(key: string, now: number = Date.now()): boolean {
      const cutoff = now - rule.windowMs;
      const stamps = prune(hits.get(key) ?? [], cutoff);
      if (stamps.length >= rule.max) {
        hits.set(key, stamps); // keep the pruned list so retryAfterSeconds stays accurate
        return false;
      }
      stamps.push(now);
      hits.set(key, stamps);
      if (hits.size > MAX_KEYS) sweep(now);
      return true;
    },

    retryAfterSeconds(key: string, now: number = Date.now()): number {
      const stamps = prune(hits.get(key) ?? [], now - rule.windowMs);
      if (stamps.length < rule.max) return 0;
      // The slot frees up when the oldest hit leaves the window.
      const waitMs = Math.min(...stamps) + rule.windowMs - now;
      return waitMs <= 0 ? 0 : Math.ceil(waitMs / 1000);
    },

    reset(key?: string): void {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },

    size(): number {
      return hits.size;
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
  const created = createRateLimiter(RULES[name]);
  limiters.set(name, created);
  return created;
}

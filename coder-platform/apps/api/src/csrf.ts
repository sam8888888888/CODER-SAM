import { randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url encoded: safe for cookies and headers. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Timing-safe string comparison; unequal lengths are rejected without comparing bytes. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export type OriginDecision = { ok: true } | { ok: false; reason: "ORIGIN_MISMATCH" | "CROSS_SITE" };

/**
 * Origin check for state changing requests (CSRF defence level 1).
 * A browser always sends Origin on cross-site POST, so a missing Origin means a
 * non-browser client (curl, server-to-server) or a same-origin navigation.
 */
export function checkRequestOrigin(input: {
  origin?: string;
  secFetchSite?: string;
  host?: string;
  allowedOrigins: string[];
}): OriginDecision {
  const origin = (input.origin ?? "").trim();
  const secFetchSite = (input.secFetchSite ?? "").trim().toLowerCase();

  if (secFetchSite === "same-origin" || secFetchSite === "none") return { ok: true };
  if (secFetchSite === "cross-site") return { ok: false, reason: "CROSS_SITE" };
  if (origin === "") return { ok: true };

  const normalized = origin.replace(/\/$/, "").toLowerCase();
  for (const allowed of input.allowedOrigins) {
    if (allowed.trim().replace(/\/$/, "").toLowerCase() === normalized) return { ok: true };
  }

  const host = (input.host ?? "").trim().toLowerCase();
  if (host !== "" && (normalized === `https://${host}` || normalized === `http://${host}`)) {
    return { ok: true };
  }

  return { ok: false, reason: "ORIGIN_MISMATCH" };
}

/** Cookie options for the readable CSRF cookie (30 days). */
export function csrfCookieOptions(secure: boolean): {
  httpOnly: false;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
} {
  return { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: 30 * 24 * 60 * 60 };
}

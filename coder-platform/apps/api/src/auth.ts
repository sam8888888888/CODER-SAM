import { promisify } from "node:util";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db.js";
import { limiterFor } from "./ratelimit.js";

const derive = (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }) => new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key as Buffer)));
const SESSION_COOKIE = "coder_session";
const SESSION_DAYS = 30;
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1;
// Login shares the sliding window limiter from ratelimit.ts, so one deployment tunes a
// single number (RATE_LIMIT_LOGIN_PER_15MIN) instead of two different hard-coded limits.
const loginAttempts = limiterFor("login");
export function allowLoginAttempt(key: string) {
  return loginAttempts.allow(key);
}

export type AuthUser = { id: string; email: string; displayName: string };
export type AuthRequest = FastifyRequest & { user?: AuthUser };

function tokenDigest(token: string) { return createHash("sha256").update(token).digest("hex"); }
export async function hashPassword(password: string) {
  const salt = randomBytes(16); const derived = await derive(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [, n, r, p, saltText, hashText] = encoded.split("$");
  if (!n || !r || !p || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await derive(password, Buffer.from(saltText, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) }) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function setSessionCookie(reply: FastifyReply, token: string, production: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: production, path: "/", maxAge: SESSION_DAYS * 86400 });
}
export function clearSessionCookie(reply: FastifyReply, production: boolean) {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: production, path: "/" });
}
export function createSession(userId: string, userAgent?: string) {
  const token = randomBytes(32).toString("base64url"); const now = new Date(); const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at,user_agent) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), userId, tokenDigest(token), expires.toISOString(), now.toISOString(), now.toISOString(), (userAgent ?? "").slice(0, 200));
  return token;
}
export function sessionIdForToken(token: string): string | null {
  const row = db.prepare("SELECT id FROM auth_sessions WHERE token_hash=?").get(tokenDigest(token)) as { id: string } | undefined;
  return row?.id ?? null;
}
export function currentSessionId(request: FastifyRequest): string | null {
  const token = request.cookies[SESSION_COOKIE]; return token ? sessionIdForToken(token) : null;
}
export function touchSession(sessionId: string) {
  try { db.prepare("UPDATE auth_sessions SET last_seen_at=? WHERE id=?").run(new Date().toISOString(), sessionId); } catch { /* never break a request for this */ }
}

export function revokeOtherSessions(userId: string, keepSessionId: string | null) {
  if (keepSessionId) db.prepare("DELETE FROM auth_sessions WHERE user_id=? AND id<>?").run(userId, keepSessionId);
  else db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(userId);
}
const lastSeenWrite = new Map<string, number>();
export function getSessionUser(request: FastifyRequest): AuthUser | null {
  const token = request.cookies[SESSION_COOKIE]; if (!token) return null;
  const row = db.prepare("SELECT u.id, u.email, u.display_name AS displayName, s.id AS sessionId FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? ").get(tokenDigest(token), new Date().toISOString()) as (AuthUser & { sessionId: string }) | undefined;
  if (!row) return null;
  // "Last seen" is refreshed at most once per ten minutes to keep requests read only.
  const previous = lastSeenWrite.get(row.sessionId) ?? 0;
  if (Date.now() - previous > 600_000) { lastSeenWrite.set(row.sessionId, Date.now()); touchSession(row.sessionId); }
  return { id: row.id, email: row.email, displayName: row.displayName };
}
export async function requireUser(request: AuthRequest, reply: FastifyReply) {
  const user = getSessionUser(request); if (!user) return reply.code(401).send({ error: "AUTH_REQUIRED" });
  request.user = user;
}
export function deleteSession(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE]; if (token) db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(tokenDigest(token));
}
export { SESSION_COOKIE };

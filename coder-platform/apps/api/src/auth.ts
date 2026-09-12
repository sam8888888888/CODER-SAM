import { promisify } from "node:util";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db.js";

const derive = (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number }) => new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key as Buffer)));
const SESSION_COOKIE = "coder_session";
const SESSION_DAYS = 30;
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
export function allowLoginAttempt(key: string) {
  const now = Date.now(); const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) { loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 }); return true; }
  if (current.count >= 10) return false; current.count += 1; return true;
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
export function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url"); const now = new Date(); const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare("INSERT INTO auth_sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)").run(randomUUID(), userId, tokenDigest(token), expires.toISOString(), now.toISOString());
  return token;
}
export function getSessionUser(request: FastifyRequest): AuthUser | null {
  const token = request.cookies[SESSION_COOKIE]; if (!token) return null;
  const row = db.prepare("SELECT u.id, u.email, u.display_name AS displayName FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? ").get(tokenDigest(token), new Date().toISOString()) as AuthUser | undefined;
  return row ?? null;
}
export async function requireUser(request: AuthRequest, reply: FastifyReply) {
  const user = getSessionUser(request); if (!user) return reply.code(401).send({ error: "AUTH_REQUIRED" });
  request.user = user;
}
export function deleteSession(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE]; if (token) db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(tokenDigest(token));
}
export { SESSION_COOKIE };

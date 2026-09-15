import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";

/** Wave 4: public API keys.
 *  The raw key is shown once, at creation time. Only its sha256 hash is stored, so a database dump
 *  cannot be used to call the API. Every key belongs to one user and one workspace. */

export type ApiScope = "read" | "write";

export type ApiKeyRow = {
  id: string; workspaceId: string | null; userId: string; name: string; prefix: string;
  scopes: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
  requestCount: number; lastIp: string | null;
  /** Wave 6: per-key daily ceilings. 0 means "no key specific ceiling". */
  dailyRequestLimit: number; dailyTokenLimit: number; requestsToday: number; usageDay: string | null;
};

export const API_KEY_PREFIX = "ck";
export const MAX_API_KEYS_PER_USER = 20;

export function parseScopes(input: unknown): ApiScope[] {
  const values = Array.isArray(input) ? input.map(String) : String(input ?? "").split(",");
  const clean = values.map((value) => value.trim().toLowerCase()).filter((value) => value === "read" || value === "write");
  const unique = Array.from(new Set(clean)) as ApiScope[];
  // A write key also reads: nobody expects a key that can send a message but not list a project.
  if (unique.includes("write") && !unique.includes("read")) unique.push("read");
  return unique;
}

export function scopesToString(scopes: ApiScope[]): string { return parseScopes(scopes).join(","); }
export function scopesOf(row: ApiKeyRow): ApiScope[] { return parseScopes(row.scopes); }
export function hasScope(row: ApiKeyRow, scope: ApiScope): boolean { return scopesOf(row).includes(scope); }

export function hashApiKey(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }

/** Creates a new raw key value. The visible prefix helps an operator find the right key later. */
export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const secret = randomBytes(20).toString("hex"); // 40 characters, never stored as such
  const raw = API_KEY_PREFIX + "_" + secret;
  return { raw, prefix: secret.slice(0, 8), hash: hashApiKey(raw) };
}

function toRow(value: any): ApiKeyRow | null {
  if (!value) return null;
  return {
    id: String(value.id), workspaceId: value.workspaceId ?? null, userId: String(value.userId),
    name: String(value.name), prefix: String(value.prefix), scopes: String(value.scopes ?? "read"),
    createdAt: String(value.createdAt), lastUsedAt: value.lastUsedAt ?? null,
    revokedAt: value.revokedAt ?? null, requestCount: Number(value.requestCount ?? 0),
    lastIp: value.lastIp ?? null,
    dailyRequestLimit: Number(value.dailyRequestLimit ?? 0), dailyTokenLimit: Number(value.dailyTokenLimit ?? 0),
    requestsToday: Number(value.requestsToday ?? 0), usageDay: value.usageDay ?? null,
  };
}

const SELECT = `SELECT id, workspace_id AS workspaceId, user_id AS userId, name, prefix, scopes,
  created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt, request_count AS requestCount, last_ip AS lastIp,
  daily_request_limit AS dailyRequestLimit, daily_token_limit AS dailyTokenLimit, requests_today AS requestsToday, usage_day AS usageDay
  FROM api_keys`;

export function countActiveApiKeys(userId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM api_keys WHERE user_id=? AND revoked_at IS NULL").get(userId) as { total: number };
  return row.total;
}

/** A ceiling of 0 means "no key specific ceiling": the account tier limit still applies. */
export function cleanLimit(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Math.round(number), 1_000_000_000);
}

export function createApiKey(input: { userId: string; workspaceId: string | null; name: string; scopes: ApiScope[] | string; dailyRequestLimit?: unknown; dailyTokenLimit?: unknown }): { key: ApiKeyRow; raw: string } {
  const generated = generateApiKey();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const scopes = scopesToString(Array.isArray(input.scopes) ? input.scopes : parseScopes(input.scopes));
  const dailyRequestLimit = cleanLimit(input.dailyRequestLimit ?? config.API_KEY_DAILY_REQUESTS_DEFAULT);
  const dailyTokenLimit = cleanLimit(input.dailyTokenLimit ?? config.API_KEY_DAILY_TOKENS_DEFAULT);
  db.prepare("INSERT INTO api_keys (id,workspace_id,user_id,name,prefix,key_hash,scopes,created_at,request_count,daily_request_limit,daily_token_limit,requests_today,usage_day) VALUES (?,?,?,?,?,?,?,?,0,?,?,0,?)")
    .run(id, input.workspaceId ?? null, input.userId, input.name, generated.prefix, generated.hash, scopes, createdAt, dailyRequestLimit, dailyTokenLimit, todayKey());
  const key = toRow(db.prepare(`${SELECT} WHERE id=?`).get(id));
  return { key: key as ApiKeyRow, raw: generated.raw };
}

export function listApiKeys(userId: string, workspaceId?: string | null): ApiKeyRow[] {
  const rows = workspaceId
    ? db.prepare(`${SELECT} WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC`).all(userId, workspaceId)
    : db.prepare(`${SELECT} WHERE user_id=? ORDER BY created_at DESC`).all(userId);
  return (rows as any[]).map((row) => toRow(row) as ApiKeyRow);
}

export function getApiKey(userId: string, keyId: string): ApiKeyRow | null {
  return toRow(db.prepare(`${SELECT} WHERE id=? AND user_id=?`).get(keyId, userId));
}

export function updateApiKey(userId: string, keyId: string, patch: { name?: unknown; scopes?: unknown; dailyRequestLimit?: unknown; dailyTokenLimit?: unknown }): ApiKeyRow | null {
  const current = getApiKey(userId, keyId);
  if (!current) return null;
  const name = typeof patch.name === "string" ? patch.name.trim() : current.name;
  const scopes = patch.scopes === undefined ? current.scopes : scopesToString(Array.isArray(patch.scopes) ? (patch.scopes as ApiScope[]) : parseScopes(patch.scopes));
  const dailyRequestLimit = patch.dailyRequestLimit === undefined ? current.dailyRequestLimit : cleanLimit(patch.dailyRequestLimit, current.dailyRequestLimit);
  const dailyTokenLimit = patch.dailyTokenLimit === undefined ? current.dailyTokenLimit : cleanLimit(patch.dailyTokenLimit, current.dailyTokenLimit);
  db.prepare("UPDATE api_keys SET name=?, scopes=?, daily_request_limit=?, daily_token_limit=? WHERE id=? AND user_id=?")
    .run(name, scopes, dailyRequestLimit, dailyTokenLimit, keyId, userId);
  return getApiKey(userId, keyId);
}

/** Soft revoke: the row stays for the audit trail, but the key never authenticates again. */
export function revokeApiKey(userId: string, keyId: string): boolean {
  const result = db.prepare("UPDATE api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL").run(new Date().toISOString(), keyId, userId);
  return result.changes > 0;
}

export type ApiKeyAuth = {
  key: ApiKeyRow;
  userId: string;
  email: string;
  displayName: string | null;
  workspaceId: string;
  workspaceName: string;
  role: string;
};

/** Resolves a Bearer token to its owner, and checks that the membership still exists. */
export function authenticateApiKey(raw: string): ApiKeyAuth | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed.startsWith(API_KEY_PREFIX + "_")) return null;
  const row = toRow(db.prepare(`${SELECT} WHERE key_hash=?`).get(hashApiKey(trimmed)));
  if (!row || row.revokedAt) return null;
  const membership = db.prepare(`SELECT m.role AS role, w.id AS workspaceId, w.name AS workspaceName, u.email AS email, u.display_name AS displayName
      FROM memberships m JOIN workspaces w ON w.id=m.workspace_id JOIN users u ON u.id=m.user_id
      WHERE m.user_id=? AND m.workspace_id=?`).get(row.userId, row.workspaceId ?? "") as { role: string; workspaceId: string; workspaceName: string; email: string; displayName: string | null } | undefined;
  if (!membership) return null;
  return { key: row, userId: row.userId, email: membership.email, displayName: membership.displayName ?? null, workspaceId: membership.workspaceId, workspaceName: membership.workspaceName, role: membership.role };
}

export function touchApiKey(keyId: string, ip?: string | null): void {
  db.prepare("UPDATE api_keys SET last_used_at=?, request_count=request_count+1, last_ip=? WHERE id=?").run(new Date().toISOString(), ip ?? null, keyId);
}

/** The day key used for the per-key ceilings. UTC keeps it stable whatever the server clock zone is. */
export function todayKey(at: Date = new Date()): string { return at.toISOString().slice(0, 10); }

/** Restarts the per-key daily counter when the day changed, and returns the fresh number. */
export function refreshApiKeyDay(row: ApiKeyRow): number {
  const today = todayKey();
  if (row.usageDay === today) return row.requestsToday;
  db.prepare("UPDATE api_keys SET requests_today=0, usage_day=? WHERE id=?").run(today, row.id);
  return 0;
}

/** Counts one request against the key. Called after the request itself was accepted. */
export function countApiKeyRequest(keyId: string): void {
  const today = todayKey();
  db.prepare("UPDATE api_keys SET requests_today = CASE WHEN usage_day=? THEN requests_today+1 ELSE 1 END, usage_day=? WHERE id=?").run(today, today, keyId);
}

/** Tokens spent today by the public API calls that used this key. */
export function apiKeyTokensToday(keyId: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(u.total_tokens),0) AS tokens FROM run_usage u
      JOIN runs r ON r.id=u.run_id WHERE r.api_key_id=? AND substr(u.created_at,1,10)=?`).get(keyId, todayKey()) as { tokens: number };
  return Number(row?.tokens ?? 0);
}

/**
 * Checks the daily ceilings of one key before the work is done. Returns null when the call may go on.
 * The account tier limit is checked separately by the caller, so an owner ceiling can never be bypassed
 * by handing out a key with a high per-key ceiling.
 */
export function checkApiKeyDailyQuota(row: ApiKeyRow): { status: number; error: string; detail: Record<string, unknown> } | null {
  const usedRequests = refreshApiKeyDay(row);
  if (row.dailyRequestLimit > 0 && usedRequests >= row.dailyRequestLimit) {
    return { status: 429, error: "API_KEY_DAILY_REQUEST_LIMIT", detail: { limit: row.dailyRequestLimit, used: usedRequests, message: `Kunci ini sudah memakai ${usedRequests} dari ${row.dailyRequestLimit} permintaan hari ini.` } };
  }
  if (row.dailyTokenLimit > 0) {
    const usedTokens = apiKeyTokensToday(row.id);
    if (usedTokens >= row.dailyTokenLimit) {
      return { status: 429, error: "API_KEY_DAILY_TOKEN_LIMIT", detail: { limit: row.dailyTokenLimit, used: usedTokens, message: `Kunci ini sudah memakai ${usedTokens} dari ${row.dailyTokenLimit} token hari ini.` } };
    }
  }
  return null;
}

/** Simple in-memory limiter per key. It protects the engine from a runaway script; a restart clears it. */
const hits = new Map<string, number[]>();
export function checkApiKeyRate(keyId: string): { allowed: boolean; limit: number; used: number } {
  const limit = config.API_KEY_RATE_LIMIT_PER_MINUTE;
  if (limit <= 0) return { allowed: true, limit: 0, used: 0 };
  const now = Date.now();
  const window = (hits.get(keyId) ?? []).filter((stamp) => now - stamp < 60_000);
  const allowed = window.length < limit;
  if (allowed) window.push(now);
  hits.set(keyId, window);
  return { allowed, limit, used: window.length };
}

/**
 * Wave 6: limits a caller can expect. Read from config so the docs and the guard never disagree.
 *
 * `maxActive` dipertahankan karena sudah dipakai halaman Kunci API dan suite Wave 4; `maxKeys` adalah
 * nama barunya. Keduanya memuat angka yang sama supaya tidak ada dua kebenaran.
 */
export const PUBLIC_API_LIMITS = () => ({
  maxActive: MAX_API_KEYS_PER_USER,
  maxKeys: MAX_API_KEYS_PER_USER,
  rateLimitPerMinute: config.API_KEY_RATE_LIMIT_PER_MINUTE,
  dailyRequestsDefault: config.API_KEY_DAILY_REQUESTS_DEFAULT,
  dailyTokensDefault: config.API_KEY_DAILY_TOKENS_DEFAULT,
});

/** Documents the public API surface. Kept next to the keys so both stay in step. */
export const PUBLIC_API_ENDPOINTS: { method: string; path: string; scope: ApiScope; description: string; available: boolean }[] = [
  { method: "GET", path: "/api/v1/public/v1/me", scope: "read", description: "Pemilik kunci dan workspace yang terikat.", available: true },
  { method: "GET", path: "/api/v1/public/v1/workspaces", scope: "read", description: "Workspace yang boleh dibaca kunci ini.", available: true },
  { method: "GET", path: "/api/v1/public/v1/projects", scope: "read", description: "Daftar proyek di workspace kunci.", available: true },
  { method: "GET", path: "/api/v1/public/v1/projects/:projectId/conversations", scope: "read", description: "Percakapan dalam satu proyek.", available: true },
  { method: "GET", path: "/api/v1/public/v1/conversations/:conversationId/messages", scope: "read", description: "Pesan dalam satu percakapan.", available: true },
  { method: "GET", path: "/api/v1/public/v1/projects/:projectId/usage", scope: "read", description: "Ringkasan token dan biaya proyek.", available: true },
  { method: "GET", path: "/api/v1/public/v1/projects/:projectId/artifacts", scope: "read", description: "Metadata artefak (tanpa isi berkas).", available: true },
  // Wave 6: the write pair is served now, so `available` is true and the documentation may promise it.
  { method: "POST", path: "/api/v1/public/v1/projects/:projectId/conversations", scope: "write", description: "Buat percakapan baru.", available: true },
  { method: "POST", path: "/api/v1/public/v1/conversations/:conversationId/messages", scope: "write", description: "Kirim pesan dan jalankan mesin AI. Jawaban menyusul lewat rute pesan.", available: true },
];

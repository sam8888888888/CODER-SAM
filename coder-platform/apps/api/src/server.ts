import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { estimateCostMicros } from "./model-prices.js";
import { buildKnowledgeContext, contentChecksum, deleteDocument, indexDocument, searchChunks } from "./knowledge.js";
import { extractText } from "./text-extract.js";
import { generateTotpSecret, otpAuthUrl, verifyTotp } from "./totp.js";
import { mailerConfigured, passwordResetEmail, sendMail, verificationEmail } from "./mailer.js";
import { db } from "./db.js";
import { currentSessionId, revokeOtherSessions, sessionIdForToken, touchSession } from "./auth.js";
import { engine } from "./engine.js";
import { createExecution, recordAudit, runExecution, scheduleNextRun } from "./workflow-engine.js";
import { allowLoginAttempt, clearSessionCookie, createSession, deleteSession, getSessionUser, hashPassword, requireUser, setSessionCookie, verifyPassword, type AuthRequest } from "./auth.js";

const app = Fastify({ logger: true, trustProxy: false });
type Subscriber = (event: { type: string; data: unknown }) => void;
const subscribers = new Map<string, Set<Subscriber>>();
function publishRunEvent(runId: string, type: string, data: unknown) {
  db.prepare("INSERT INTO run_events (run_id,type,data_json,created_at) VALUES (?,?,?,?)").run(runId, type, JSON.stringify(data), new Date().toISOString());
  for (const send of subscribers.get(runId) ?? []) send({ type, data });
}
function subscribeRun(runId: string, send: Subscriber) { const set = subscribers.get(runId) ?? new Set<Subscriber>(); set.add(send); subscribers.set(runId, set); return () => { set.delete(send); if (!set.size) subscribers.delete(runId); }; }
function membershipRole(workspaceId: string, userId: string) { return (db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(workspaceId,userId) as { role: string } | undefined)?.role; }
function workflowAccess(workflowId: string, userId: string) {
  const row = db.prepare("SELECT w.id, w.project_id AS projectId, w.name, w.description, w.status, p.workspace_id AS workspaceId FROM workflows w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(workflowId) as any;
  if (!row) return null;
  const role = membershipRole(row.workspaceId, userId);
  return role ? { ...row, role } : null;
}

/** True when the user may inspect the whole platform (workspace list, all users, totals). */
function isPlatformAdmin(user: { id: string; email: string }): boolean {
  const allowed = config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(user.email.toLowerCase())) return true;
  const row = db.prepare("SELECT is_admin FROM users WHERE id=?").get(user.id) as { is_admin?: number } | undefined;
  return Boolean(row?.is_admin);
}

/** True when a share of the platform (chat runs, workflow steps) may start for a workspace. */
function workspaceGuards(workspaceId: string) {
  const row = db.prepare("SELECT id, daily_cost_limit_micros AS daily, monthly_cost_limit_micros AS monthly, runs_per_hour_limit AS perHour FROM workspaces WHERE id=?").get(workspaceId) as { id: string; daily: number | null; monthly: number | null; perHour: number | null } | undefined;
  return {
    daily: row?.daily ?? config.DEFAULT_DAILY_COST_LIMIT_MICROS,
    monthly: row?.monthly ?? config.DEFAULT_MONTHLY_COST_LIMIT_MICROS,
    perHour: row?.perHour ?? config.DEFAULT_RUNS_PER_HOUR_LIMIT,
  };
}

/** Cost in micros that a workspace produced today, plus this calendar month. */
function workspaceSpend(workspaceId: string) {
  const day = db.prepare(`SELECT COALESCE(SUM(u.cost_micros),0) AS micros, COUNT(*) AS runs FROM run_usage u JOIN projects p ON p.id=u.project_id WHERE p.workspace_id=? AND u.created_at >= ?`).get(workspaceId, new Date(Date.now() - 86_400_000).toISOString()) as { micros: number; runs: number };
  const month = db.prepare(`SELECT COALESCE(SUM(u.cost_micros),0) AS micros FROM run_usage u JOIN projects p ON p.id=u.project_id WHERE p.workspace_id=? AND u.created_at >= ?`).get(workspaceId, new Date(Date.now() - 30 * 86_400_000).toISOString()) as { micros: number };
  return { dayMicros: day.micros ?? 0, dayRuns: day.runs ?? 0, monthMicros: month.micros ?? 0 };
}

/**
 * Guard for a workspace about to start engine work.
 * Returns null when allowed, or { status, error } describing the block.
 */
function guardWorkspaceUsage(workspaceId: string): { status: number; error: string; detail?: Record<string, unknown> } | null {
  const limits = workspaceGuards(workspaceId);
  const spend = workspaceSpend(workspaceId);
  if (limits.daily > 0 && spend.dayMicros >= limits.daily) return { status: 429, error: "COST_LIMIT_EXCEEDED", detail: { window: "day", limitMicros: limits.daily, usedMicros: spend.dayMicros } };
  if (limits.monthly > 0 && spend.monthMicros >= limits.monthly) return { status: 429, error: "COST_LIMIT_EXCEEDED", detail: { window: "month", limitMicros: limits.monthly, usedMicros: spend.monthMicros } };
  if (limits.perHour > 0 && spend.dayRuns >= limits.perHour) return { status: 429, error: "RUN_RATE_LIMITED", detail: { window: "day", limitRuns: limits.perHour, usedRuns: spend.dayRuns } };
  return null;
}

/** Stores one notification for a user and, when the workspace is known, for its owners and admins. */
function notify(workspaceId: string | null, userId: string | null, kind: string, title: string, body?: string, link?: string) {
  const createdAt = new Date().toISOString();
  const targets = new Set<string>();
  if (userId) targets.add(userId);
  if (workspaceId) {
    const members = db.prepare("SELECT user_id AS userId FROM memberships WHERE workspace_id=? AND role IN ('owner','admin')").all(workspaceId) as { userId: string }[];
    for (const member of members) targets.add(member.userId);
  }
  const insert = db.prepare("INSERT INTO notifications (id,workspace_id,user_id,kind,title,body,link,created_at) VALUES (?,?,?,?,?,?,?,?)");
  db.transaction(() => { for (const target of targets) insert.run(randomUUID(), workspaceId, target, kind, title, body ?? null, link ?? null, createdAt); })();
}

/** Creates a single use token (only its hash is stored) and returns the raw value for the email link. */
function createAuthToken(userId: string, kind: "password_reset" | "email_verify", ttlMinutes: number) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare("UPDATE auth_tokens SET used_at=? WHERE user_id=? AND kind=? AND used_at IS NULL").run(new Date().toISOString(), userId, kind);
  db.prepare("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), userId, kind, hash, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

/** Consumes a token of the given kind and returns the user id, or null when invalid, used or expired. */
function consumeAuthToken(rawToken: string, kind: "password_reset" | "email_verify"): string | null {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const row = db.prepare("SELECT id, user_id AS userId, expires_at AS expiresAt, used_at AS usedAt FROM auth_tokens WHERE token_hash=? AND kind=?").get(hash, kind) as { id: string; userId: string; expiresAt: string; usedAt: string | null } | undefined;
  if (!row || row.usedAt || row.expiresAt < new Date().toISOString()) return null;
  db.prepare("UPDATE auth_tokens SET used_at=? WHERE id=?").run(new Date().toISOString(), row.id);
  return row.userId;
}

/** Sends a verification email when SMTP is configured; reports the delivery state honestly. */
async function sendVerificationEmail(user: { id: string; email: string; displayName: string }) {
  if (!mailerConfigured()) return { sent: false, reason: "EMAIL_NOT_CONFIGURED" as const };
  const { token } = createAuthToken(user.id, "email_verify", 24 * 60);
  const link = `${config.PUBLIC_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const result = await sendMail({ to: user.email, subject: "Verifikasi email COBLAI Coder", text: verificationEmail(user.displayName, link) });
  return result.sent ? { sent: true as const } : { sent: false, reason: result.reason ?? "EMAIL_SEND_FAILED", detail: result.detail };
}

/**
 * Runs one workflow prompt step through the configured agent engine.
 * The step gets its own runs row, so token usage and cost are tracked exactly like a chat run.
 */
async function runWorkflowPrompt(prompt: string, projectId?: string) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const model = config.PRIME_AGENT_MODEL ?? null;
  if (projectId) db.prepare("INSERT INTO runs (id,project_id,status,prompt,started_at,created_at,model) VALUES (?,?,'running',?,?,?,?)").run(runId, projectId, prompt.slice(0, 8000), startedAt, startedAt, model);
  let text = "";
  let usage: any = null;
  try {
    for await (const event of engine.run({ runId, sessionId: runId, prompt, model: model ?? undefined, provider: config.PRIME_AGENT_PROVIDER })) {
      if (event.type === "text") text += typeof event.data === "string" ? event.data : JSON.stringify(event.data);
      if (event.type === "completed") usage = (event.data as { usage?: unknown })?.usage ?? null;
      if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "ENGINE_FAILED"));
    }
  } catch (error) {
    if (projectId) db.prepare("UPDATE runs SET status='failed', error_code='WORKFLOW_STEP_FAILED', finished_at=? WHERE id=?").run(new Date().toISOString(), runId);
    throw error;
  }
  if (projectId) {
    recordRunUsage(runId, projectId, prompt, text, usage);
    db.prepare("UPDATE runs SET status='completed', result=?, finished_at=? WHERE id=?").run(text || null, new Date().toISOString(), runId);
  }
  return text;
}

function startWorkflowExecution(executionId: string) {
  // The runner is bound to the execution project so every step records its own usage row.
  const execution = db.prepare("SELECT project_id AS projectId FROM workflow_executions WHERE id=?").get(executionId) as { projectId?: string } | undefined;
  setImmediate(() => { void runExecution(executionId, (prompt) => runWorkflowPrompt(prompt, execution?.projectId)).catch((error) => app.log.error(error)); });
}

/** Interval scheduler: starts due workflow executions once per minute. */
function startWorkflowScheduler() {
  const timer = setInterval(() => {
    try {
      const due = db.prepare("SELECT id, schedule_interval_minutes AS intervalMinutes FROM workflows WHERE schedule_enabled=1 AND status='published' AND next_run_at IS NOT NULL AND next_run_at <= ?").all(new Date().toISOString()) as any[];
      for (const workflow of due) {
        const executionId = createExecution(workflow.id, "scheduled run", null);
        scheduleNextRun(workflow.id, workflow.intervalMinutes ?? null);
        if (executionId) startWorkflowExecution(executionId);
      }
    } catch (error) { app.log.error(error); }
  }, 60_000);
  timer.unref?.();
}

await app.register(cookie);

// Empty bodies are valid for action endpoints (publish/cancel/retry); malformed JSON stays a 400.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return done(null, {});
  try { done(null, JSON.parse(text)); } catch { const error = new Error("INVALID_JSON") as Error & { statusCode?: number }; error.statusCode = 400; done(error); }
});

/** Turns free text into a url safe slug fragment. */
function slugifyText(value: string) {
  const base = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "proyek";
}

app.get("/health", async () => ({ status: "ok", service: "coder-api", time: new Date().toISOString() }));
app.get("/ready", async (_request, reply) => {
  const result = db.prepare("SELECT 1 AS ok").get() as { ok: number };
  const engineStatus = await engine.health();
  return reply.send({ status: result.ok === 1 ? "ready" : "not_ready", database: "ok", engine: engineStatus });
});

app.get("/api/v1/auth/me", async (request, reply) => {
  const user = getSessionUser(request);
  if (!user) return reply.code(401).send({ error: "AUTH_REQUIRED" });
  return { user };
});
app.post<{ Body: { email?: string; password?: string; displayName?: string } }>("/api/v1/auth/register", async (request, reply) => {
  const email = request.body?.email?.trim().toLowerCase(); const password = request.body?.password ?? ""; const displayName = request.body?.displayName?.trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || !displayName) return reply.code(400).send({ error: "INVALID_REGISTRATION" });
  const now = new Date().toISOString(); const userId = randomUUID(); const workspaceId = randomUUID(); const slug = `workspace-${userId.slice(0, 8)}`;
  try {
    const passwordHash = await hashPassword(password);
    const transaction = db.transaction(() => {
      db.prepare("INSERT INTO users (id,email,display_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(userId,email,displayName,passwordHash,now,now);
      db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)").run(workspaceId,`${displayName}'s Workspace`,slug,now,now);
      db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,?,?)").run(userId,workspaceId,"owner",now);
    }); transaction();
    const token = createSession(userId); setSessionCookie(reply, token, config.NODE_ENV === "production");
    const verification = await sendVerificationEmail({ id: userId, email, displayName });
    notify(workspaceId, userId, "account", "Selamat datang di COBLAI Coder", verification.sent ? "Kami sudah mengirim tautan verifikasi email." : "Verifikasi email belum aktif karena server email belum dikonfigurasi.", "/");
    return reply.code(201).send({ user: { id: userId, email, displayName }, workspace: { id: workspaceId, slug }, emailVerification: verification });
  } catch (error) { if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "EMAIL_EXISTS" }); throw error; }
});
app.post<{ Body: { email?: string; password?: string; code?: string } }>("/api/v1/auth/login", async (request, reply) => {
  const email = request.body?.email?.trim().toLowerCase(); const password = request.body?.password ?? ""; const code = request.body?.code?.trim();
  const key = `${request.ip}:${email ?? "unknown"}`; if (!allowLoginAttempt(key)) return reply.code(429).send({ error: "LOGIN_RATE_LIMITED" });
  // The form accepts either a full email address or the username before the @.
  type LoginRow = { id:string; email:string; displayName:string; passwordHash:string|null; mfaEnabled:number; mfaSecret:string|null; recoveryCodes:string|null };
  const fields = "id,email,display_name AS displayName,password_hash AS passwordHash, mfa_enabled AS mfaEnabled, mfa_secret AS mfaSecret, mfa_recovery_codes AS recoveryCodes";
  let row = email ? db.prepare(`SELECT ${fields} FROM users WHERE email=?`).get(email) as LoginRow|undefined : undefined;
  if (!row && email && !email.includes("@")) {
    // A username is only accepted when exactly one account uses that local part.
    const matches = db.prepare(`SELECT ${fields} FROM users WHERE lower(substr(email,1,instr(email,'@')-1))=?`).all(email) as LoginRow[];
    if (matches.length === 1) row = matches[0];
  }
  if (!row?.passwordHash || !(await verifyPassword(password,row.passwordHash))) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  if (row.mfaEnabled) {
    if (!code) return reply.code(401).send({ error: "MFA_REQUIRED" });
    if (!consumeSecondFactor(row, code)) return reply.code(401).send({ error: "MFA_INVALID_CODE" });
  }
  const token = createSession(row.id, String(request.headers["user-agent"] ?? "")); setSessionCookie(reply, token, config.NODE_ENV === "production");
  return { user: { id: row.id, email: row.email, displayName: row.displayName }, mfaEnabled: Boolean(row.mfaEnabled) };
});
app.post("/api/v1/auth/logout", async (request, reply) => { deleteSession(request); clearSessionCookie(reply, config.NODE_ENV === "production"); return { ok: true }; });

/** Accepts a TOTP code or a single use recovery code. */
function consumeSecondFactor(row: { id: string; mfaSecret: string | null; recoveryCodes: string | null }, code: string): boolean {
  if (row.mfaSecret && verifyTotp(row.mfaSecret, code)) return true;
  const stored: string[] = row.recoveryCodes ? JSON.parse(row.recoveryCodes) : [];
  const digest = createHash("sha256").update(code).digest("hex");
  if (stored.includes(digest)) {
    db.prepare("UPDATE users SET mfa_recovery_codes=?, updated_at=? WHERE id=?").run(JSON.stringify(stored.filter((entry) => entry !== digest)), new Date().toISOString(), row.id);
    return true;
  }
  return false;
}

app.get("/api/v1/auth/sessions", { preHandler: requireUser }, async (request: any) => {
  const current = currentSessionId(request);
  const rows = db.prepare("SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt, user_agent AS userAgent FROM auth_sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC").all(request.user!.id, new Date().toISOString()) as { id: string }[];
  return rows.map((row) => ({ ...row, current: row.id === current }));
});
app.delete<{ Params: { sessionId: string } }>("/api/v1/auth/sessions/:sessionId", { preHandler: requireUser }, async (request: any, reply) => {
  const result = db.prepare("DELETE FROM auth_sessions WHERE id=? AND user_id=?").run(request.params.sessionId, request.user!.id);
  if (!result.changes) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  return { revoked: true, id: request.params.sessionId };
});
app.post<{ Body: { currentPassword?: string; newPassword?: string } }>("/api/v1/auth/password", { preHandler: requireUser }, async (request: any, reply) => {
  const currentPassword = request.body?.currentPassword ?? ""; const newPassword = request.body?.newPassword ?? "";
  if (newPassword.length < 10 || newPassword.length > 200) return reply.code(400).send({ error: "INVALID_PASSWORD" });
  const row = db.prepare("SELECT password_hash AS passwordHash FROM users WHERE id=?").get(request.user!.id) as { passwordHash: string | null } | undefined;
  if (!row?.passwordHash || !(await verifyPassword(currentPassword, row.passwordHash))) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  if (currentPassword === newPassword) return reply.code(400).send({ error: "PASSWORD_UNCHANGED" });
  db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?").run(await hashPassword(newPassword), new Date().toISOString(), request.user!.id);
  revokeOtherSessions(request.user!.id, currentSessionId(request));
  recordAudit(null, request.user!.id, "auth.password_changed", { userId: request.user!.id });
  return { changed: true, otherSessionsRevoked: true };
});
app.post("/api/v1/auth/mfa/setup", { preHandler: requireUser }, async (request: any, reply) => {
  const secret = generateTotpSecret();
  db.prepare("UPDATE users SET mfa_secret=?, updated_at=? WHERE id=?").run(secret, new Date().toISOString(), request.user!.id);
  return { secret, otpauthUrl: otpAuthUrl(secret, request.user!.email), digits: 6, periodSeconds: 30, enabled: false };
});
app.post<{ Body: { code?: string } }>("/api/v1/auth/mfa/enable", { preHandler: requireUser }, async (request: any, reply) => {
  const row = db.prepare("SELECT mfa_secret AS secret FROM users WHERE id=?").get(request.user!.id) as { secret: string | null } | undefined;
  if (!row?.secret) return reply.code(400).send({ error: "MFA_SETUP_REQUIRED" });
  if (!verifyTotp(row.secret, request.body?.code ?? "")) return reply.code(400).send({ error: "MFA_INVALID_CODE" });
  const recovery = Array.from({ length: 6 }, () => randomBytes(5).toString("hex"));
  db.prepare("UPDATE users SET mfa_enabled=1, mfa_recovery_codes=?, updated_at=? WHERE id=?").run(JSON.stringify(recovery.map((entry) => createHash("sha256").update(entry).digest("hex"))), new Date().toISOString(), request.user!.id);
  recordAudit(null, request.user!.id, "auth.mfa_enabled", { userId: request.user!.id });
  return { enabled: true, recoveryCodes: recovery };
});
app.post<{ Body: { password?: string; code?: string } }>("/api/v1/auth/mfa/disable", { preHandler: requireUser }, async (request: any, reply) => {
  const row = db.prepare("SELECT password_hash AS passwordHash, mfa_enabled AS mfaEnabled, mfa_secret AS mfaSecret, mfa_recovery_codes AS recoveryCodes FROM users WHERE id=?").get(request.user!.id) as { passwordHash: string | null; mfaEnabled: number; mfaSecret: string | null; recoveryCodes: string | null } | undefined;
  if (!row?.passwordHash || !(await verifyPassword(request.body?.password ?? "", row.passwordHash))) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  if (row.mfaEnabled && !consumeSecondFactor({ id: request.user!.id, mfaSecret: row.mfaSecret, recoveryCodes: row.recoveryCodes }, request.body?.code ?? "")) return reply.code(400).send({ error: "MFA_INVALID_CODE" });
  db.prepare("UPDATE users SET mfa_enabled=0, mfa_secret=NULL, mfa_recovery_codes=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), request.user!.id);
  recordAudit(null, request.user!.id, "auth.mfa_disabled", { userId: request.user!.id });
  return { enabled: false };
});
app.get("/api/v1/auth/mfa", { preHandler: requireUser }, async (request: any) => {
  const row = db.prepare("SELECT mfa_enabled AS enabled, mfa_secret AS secret FROM users WHERE id=?").get(request.user!.id) as { enabled: number; secret: string | null } | undefined;
  return { enabled: Boolean(row?.enabled), pendingSetup: Boolean(row?.secret && !row?.enabled) };
});

// ---------------------------------------------------------------- account recovery

app.post<{ Body: { token?: string } }>("/api/v1/auth/email/verify", async (request, reply) => {
  const raw = request.body?.token?.trim();
  if (!raw) return reply.code(400).send({ error: "TOKEN_REQUIRED" });
  const userId = consumeAuthToken(raw, "email_verify");
  if (!userId) return reply.code(400).send({ error: "TOKEN_INVALID_OR_EXPIRED" });
  db.prepare("UPDATE users SET email_verified=1, updated_at=? WHERE id=?").run(new Date().toISOString(), userId);
  recordAudit(null, userId, "auth.email_verified", {});
  return { verified: true };
});

app.post("/api/v1/auth/email/verify/request", { preHandler: requireUser }, async (request: any) => {
  const row = db.prepare("SELECT id, email, display_name AS displayName, email_verified AS emailVerified FROM users WHERE id=?").get(request.user!.id) as { id: string; email: string; displayName: string; emailVerified: number } | undefined;
  if (!row) return { sent: false, reason: "USER_NOT_FOUND" };
  if (row.emailVerified) return { sent: false, reason: "ALREADY_VERIFIED" };
  return sendVerificationEmail({ id: row.id, email: row.email, displayName: row.displayName });
});

app.post<{ Body: { email?: string } }>("/api/v1/auth/password/forgot", async (request, reply) => {
  const email = request.body?.email?.trim().toLowerCase();
  if (!email) return reply.code(400).send({ error: "EMAIL_REQUIRED" });
  const user = db.prepare("SELECT id, email, display_name AS displayName FROM users WHERE email=?").get(email) as { id: string; email: string; displayName: string } | undefined;
  // The answer never reveals whether the address exists.
  if (!user) return { ok: true, delivery: mailerConfigured() ? "email" : "unavailable" };
  if (!mailerConfigured()) return { ok: true, delivery: "unavailable", note: "EMAIL_NOT_CONFIGURED" };
  const { token } = createAuthToken(user.id, "password_reset", 60);
  const link = `${config.PUBLIC_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const result = await sendMail({ to: user.email, subject: "Atur ulang kata sandi COBLAI Coder", text: passwordResetEmail(user.displayName, link) });
  if (!result.sent) return reply.code(502).send({ error: result.reason ?? "EMAIL_SEND_FAILED", detail: result.detail });
  recordAudit(null, user.id, "auth.password_reset_requested", {});
  return { ok: true, delivery: "email" };
});

app.post<{ Body: { token?: string; password?: string } }>("/api/v1/auth/password/reset", async (request, reply) => {
  const raw = request.body?.token?.trim(); const password = request.body?.password ?? "";
  if (!raw) return reply.code(400).send({ error: "TOKEN_REQUIRED" });
  if (password.length < 10) return reply.code(400).send({ error: "WEAK_PASSWORD", detail: "minimal 10 karakter" });
  const userId = consumeAuthToken(raw, "password_reset");
  if (!userId) return reply.code(400).send({ error: "TOKEN_INVALID_OR_EXPIRED" });
  const passwordHash = await hashPassword(password);
  db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?").run(passwordHash, new Date().toISOString(), userId);
  // Every other session dies, so a stolen cookie cannot survive a reset.
  db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(userId);
  recordAudit(null, userId, "auth.password_reset_completed", {});
  notify(null, userId, "security", "Kata sandi diatur ulang", "Semua sesi dikeluarkan setelah kata sandi baru dibuat.", "/");
  return { reset: true };
});

// ---------------------------------------------------------------- notifications

app.get<{ Querystring: { unread?: string } }>("/api/v1/notifications", { preHandler: requireUser }, async (request: any) => {
  const limit = Math.min(Number(request.query?.limit ?? 50) || 50, 200);
  const items = db.prepare(`SELECT id, workspace_id AS workspaceId, kind, title, body, link, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(request.user!.id, limit);
  const unread = db.prepare("SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND read_at IS NULL").get(request.user!.id) as { total: number };
  return { notifications: items, unread: unread.total };
});

app.post<{ Params: { notificationId: string } }>("/api/v1/notifications/:notificationId/read", { preHandler: requireUser }, async (request: any, reply) => {
  const result = db.prepare("UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL").run(new Date().toISOString(), request.params.notificationId, request.user!.id);
  if (result.changes === 0) {
    const exists = db.prepare("SELECT 1 FROM notifications WHERE id=? AND user_id=?").get(request.params.notificationId, request.user!.id);
    if (!exists) return reply.code(404).send({ error: "NOTIFICATION_NOT_FOUND" });
  }
  return { read: true };
});

app.post("/api/v1/notifications/read-all", { preHandler: requireUser }, async (request: any) => {
  const result = db.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL").run(new Date().toISOString(), request.user!.id);
  return { read: result.changes };
});

// ---------------------------------------------------------------- platform administration

app.get("/api/v1/admin/overview", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED" });
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM workspaces) AS workspaces, (SELECT COUNT(*) FROM projects) AS projects,
    (SELECT COUNT(*) FROM conversations) AS conversations, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM runs) AS runs,
    (SELECT COUNT(*) FROM workflows) AS workflows, (SELECT COUNT(*) FROM workflow_executions) AS executions`).get() as Record<string, number>;
  const usage = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(cost_micros),0) AS micros, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
    COALESCE(SUM(estimated),0) AS estimatedRuns FROM run_usage`).get() as Record<string, number>;
  const spend = db.prepare(`SELECT COALESCE(SUM(cost_micros),0) AS micros, COUNT(*) AS runs FROM run_usage WHERE created_at >= ?`).get(new Date(Date.now() - 86_400_000).toISOString()) as { micros: number; runs: number };
  const engineStatus = await engine.health();
  return {
    totals, usage: { ...usage, costUsd: Number((usage.micros / 1e6).toFixed(6)) },
    today: { runs: spend.runs, costMicros: spend.micros, costUsd: Number((spend.micros / 1e6).toFixed(6)) },
    engine: engineStatus,
    schemaVersion: (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version,
  };
});

app.get("/api/v1/admin/users", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED" });
  return db.prepare(`SELECT u.id, u.email, u.display_name AS displayName, u.created_at AS createdAt, u.mfa_enabled AS mfaEnabled, u.email_verified AS emailVerified, u.is_admin AS isAdmin,
    (SELECT COUNT(*) FROM memberships m WHERE m.user_id=u.id) AS workspaces, (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id=u.id) AS sessions
    FROM users u ORDER BY u.created_at DESC`).all();
});

app.get("/api/v1/admin/workspaces", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED" });
  return db.prepare(`SELECT w.id, w.name, w.slug, w.created_at AS createdAt, w.daily_cost_limit_micros AS dailyCostLimitMicros, w.monthly_cost_limit_micros AS monthlyCostLimitMicros, w.runs_per_hour_limit AS runsPerHourLimit,
    (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id=w.id) AS members, (SELECT COUNT(*) FROM projects p WHERE p.workspace_id=w.id) AS projects,
    (SELECT COALESCE(SUM(u.cost_micros),0) FROM run_usage u JOIN projects p ON p.id=u.project_id WHERE p.workspace_id=w.id) AS costMicros,
    (SELECT COALESCE(SUM(u.cost_micros),0) FROM run_usage u JOIN projects p ON p.id=u.project_id WHERE p.workspace_id=w.id AND u.created_at >= ?) AS costTodayMicros
    FROM workspaces w ORDER BY w.created_at DESC`).all(new Date(Date.now() - 86_400_000).toISOString());
});

app.post<{ Params: { userId: string }; Body: { enabled?: boolean } }>("/api/v1/admin/users/:userId/admin", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED" });
  const target = db.prepare("SELECT id FROM users WHERE id=?").get(request.params.userId) as { id: string } | undefined;
  if (!target) return reply.code(404).send({ error: "USER_NOT_FOUND" });
  const enabled = request.body?.enabled === false ? 0 : 1;
  db.prepare("UPDATE users SET is_admin=?, updated_at=? WHERE id=?").run(enabled, new Date().toISOString(), request.params.userId);
  recordAudit(null, request.user!.id, enabled ? "admin.granted" : "admin.revoked", { userId: request.params.userId });
  notify(null, request.params.userId, "security", enabled ? "Anda kini admin platform" : "Akses admin dicabut", undefined, "/");
  return { userId: request.params.userId, isAdmin: Boolean(enabled) };
});

app.put<{ Params: { workspaceId: string }; Body: { dailyCostLimitMicros?: number | null; monthlyCostLimitMicros?: number | null; runsPerHourLimit?: number | null } }>("/api/v1/workspaces/:workspaceId/limits", { preHandler: requireUser }, async (request: any, reply) => {
  const role = membershipRole(request.params.workspaceId, request.user!.id);
  if (!role) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (role !== "owner" && role !== "admin") return reply.code(403).send({ error: "OWNER_REQUIRED" });
  const clean = (value: number | null | undefined) => (value === null || value === undefined || Number.isNaN(Number(value)) ? null : Math.max(0, Math.trunc(Number(value))));
  db.prepare("UPDATE workspaces SET daily_cost_limit_micros=?, monthly_cost_limit_micros=?, runs_per_hour_limit=?, updated_at=? WHERE id=?")
    .run(clean(request.body?.dailyCostLimitMicros), clean(request.body?.monthlyCostLimitMicros), clean(request.body?.runsPerHourLimit), new Date().toISOString(), request.params.workspaceId);
  recordAudit(request.params.workspaceId, request.user!.id, "workspace.limits_updated", { body: request.body ?? {} });
  return db.prepare("SELECT id, daily_cost_limit_micros AS dailyCostLimitMicros, monthly_cost_limit_micros AS monthlyCostLimitMicros, runs_per_hour_limit AS runsPerHourLimit FROM workspaces WHERE id=?").get(request.params.workspaceId);
});

// ---------------------------------------------------------------- metrics

app.get("/metrics", async (request, reply) => {
  const token = config.METRICS_TOKEN;
  const provided = (request.headers["x-metrics-token"] as string | undefined) ?? (request.query as { token?: string } | undefined)?.token;
  if (!token || provided !== token) return reply.code(404).send({ error: "NOT_FOUND" });
  const one = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as never[]) as Record<string, number> | undefined)?.value ?? 0);
  const totals = {
    users: one("SELECT COUNT(*) AS value FROM users"),
    workspaces: one("SELECT COUNT(*) AS value FROM workspaces"),
    projects: one("SELECT COUNT(*) AS value FROM projects"),
    conversations: one("SELECT COUNT(*) AS value FROM conversations"),
    messages: one("SELECT COUNT(*) AS value FROM messages"),
    runs: one("SELECT COUNT(*) AS value FROM runs"),
    runs_failed: one("SELECT COUNT(*) AS value FROM runs WHERE status='failed'"),
    workflows: one("SELECT COUNT(*) AS value FROM workflows"),
    executions_failed: one("SELECT COUNT(*) AS value FROM workflow_executions WHERE status='failed'"),
    tokens_input: one("SELECT COALESCE(SUM(input_tokens),0) AS value FROM run_usage"),
    tokens_output: one("SELECT COALESCE(SUM(output_tokens),0) AS value FROM run_usage"),
    cost_micros: one("SELECT COALESCE(SUM(cost_micros),0) AS value FROM run_usage"),
    cost_micros_today: one("SELECT COALESCE(SUM(cost_micros),0) AS value FROM run_usage WHERE created_at >= ?", new Date(Date.now() - 86_400_000).toISOString()),
    estimated_runs: one("SELECT COALESCE(SUM(estimated),0) AS value FROM run_usage"),
    sessions_active: one("SELECT COUNT(*) AS value FROM auth_sessions"),
    schema_version: one("SELECT COALESCE(MAX(version),0) AS value FROM schema_migrations"),
  };
  const lines: string[] = ["# HELP coder_info Static information about the COBLAI Coder API", "# TYPE coder_info gauge", `coder_info{engine="${config.MOCK_ENGINE ? "mock" : "prime-rpc"}"} 1`];
  for (const [key, value] of Object.entries(totals)) lines.push(`coder_${key} ${value}`);
  lines.push("# TYPE coder_uptime_seconds gauge", `coder_uptime_seconds ${Math.round(process.uptime())}`);
  return reply.type("text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
});

app.get("/api/v1/workspaces", { preHandler: requireUser }, async (request: any) => db.prepare("SELECT w.id, w.name, w.slug, w.created_at AS createdAt, w.updated_at AS updatedAt FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at DESC").all(request.user!.id));
app.post<{ Body: { name?: string; slug?: string } }>("/api/v1/workspaces", { preHandler: requireUser }, async (request: any, reply) => {
  const name = request.body?.name?.trim();
  const slug = request.body?.slug?.trim().toLowerCase();
  if (!name || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply.code(400).send({ error: "INVALID_WORKSPACE" });
  const now = new Date().toISOString(); const id = randomUUID();
  try {
    db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)").run(id,name,slug,now,now);
    db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,?,?)").run(request.user!.id,id,"owner",now);
    return reply.code(201).send({ id, name, slug, createdAt: now, updatedAt: now });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "WORKSPACE_SLUG_EXISTS" });
    throw error;
  }
});

app.get<{ Params: { workspaceId: string } }>("/api/v1/workspaces/:workspaceId/projects", { preHandler: requireUser }, async (request: any) => db.prepare("SELECT p.id, p.workspace_id AS workspaceId, p.name, p.slug, p.description, p.created_at AS createdAt, p.updated_at AS updatedAt FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.workspace_id = ? AND m.user_id=? ORDER BY p.created_at DESC").all(request.params.workspaceId, request.user!.id));
app.post<{ Params: { workspaceId: string }; Body: { name?: string; slug?: string; description?: string } }>("/api/v1/workspaces/:workspaceId/projects", { preHandler: requireUser }, async (request: any, reply) => {
  const { workspaceId } = request.params; const body = request.body ?? {}; const name = body.name?.trim();
  // Clients may send a slug; otherwise it is derived from the name so a name alone is enough.
  const slug = body.slug?.trim().toLowerCase() || (name ? `${slugifyText(name)}-${Date.now().toString(36)}` : "");
  if (!name || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply.code(400).send({ error: "INVALID_PROJECT" });
  const role = membershipRole(workspaceId, request.user!.id); if (!role) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" }); if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const now = new Date().toISOString(); const id = randomUUID();
  try {
    db.prepare("INSERT INTO projects (id,workspace_id,name,slug,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id,workspaceId,name,slug,body.description?.trim() ?? "",now,now);
    return reply.code(201).send({ id, workspaceId, name, slug, description: body.description?.trim() ?? "", createdAt: now, updatedAt: now });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "PROJECT_SLUG_EXISTS" });
    throw error;
  }
});

app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/conversations", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  return db.prepare("SELECT id, project_id AS projectId, title, pinned, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE project_id=? ORDER BY pinned DESC, updated_at DESC").all(request.params.projectId);
});
app.post<{ Params: { projectId: string }; Body: { title?: string } }>("/api/v1/projects/:projectId/conversations", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT m.role AS role FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id) as { role: string } | undefined;
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  // Read-only members may not add content to a project.
  if (allowed.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const title = request.body?.title?.trim() || "New conversation"; const id = randomUUID(); const now = new Date().toISOString();
  db.prepare("INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(id,request.params.projectId,title,now,now);
  return reply.code(201).send({ conversation: { id, projectId: request.params.projectId, title, createdAt: now, updatedAt: now } });
});
app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/messages", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  const messages = db.prepare("SELECT id, conversation_id AS conversationId, role, content, run_id AS runId, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(request.params.conversationId);
  return { messages };
});

type KnowledgeContext = { text: string; hits: { documentId: string; title: string; chunkIndex: number }[] };

/** Wraps a user prompt with retrieved project knowledge, so answers can cite the project documents. */
function withKnowledge(prompt: string, knowledge?: KnowledgeContext) {
  if (!knowledge?.text) return prompt;
  return `Gunakan konteks pengetahuan proyek berikut bila relevan. Rujuk sumbernya dengan penanda [1], [2].\n\n${knowledge.text}\n\n---\n\nPertanyaan pengguna:\n${prompt}`;
}

/**
 * Stores token usage for a finished run. Usage reported by the engine is stored as-is;
 * when the engine reports nothing, the numbers are marked estimated = 1.
 */
let modelCache: { at: number; names: string[] } = { at: 0, names: [] };
/** Accepts a model only when the engine catalogue lists it; the catalogue is cached for five minutes. */
function isKnownModel(model: string): boolean {
  if (Date.now() - modelCache.at > 300_000) modelCache = { at: Date.now(), names: engineModelCatalogue().models.map((row) => row.model) };
  if (!modelCache.names.length) return true;
  return modelCache.names.includes(model);
}

function providerForModel(model: string): string | undefined {
  const catalogue = engineModelCatalogue();
  return catalogue.models.find((row) => row.model === model)?.provider ?? config.PRIME_AGENT_PROVIDER;
}

function recordRunUsage(runId: string, projectId: string, prompt: string, answer: string, usage: any) {
  const reported = usage && typeof usage === "object" ? usage : null;
  const hasTokens = typeof reported?.inputTokens === "number" || typeof reported?.outputTokens === "number";
  const inputTokens = hasTokens ? Math.round(reported.inputTokens ?? 0) : Math.ceil(prompt.length / 4);
  const outputTokens = hasTokens ? Math.round(reported.outputTokens ?? 0) : Math.ceil(answer.length / 4);
  const cacheReadTokens = hasTokens ? Math.round(reported.cacheReadTokens ?? 0) : 0;
  const cacheWriteTokens = hasTokens ? Math.round(reported.cacheWriteTokens ?? 0) : 0;
  const totalTokens = typeof reported?.totalTokens === "number" ? Math.round(reported.totalTokens) : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const model = typeof reported?.model === "string" ? reported.model : (config.PRIME_AGENT_MODEL ?? null);
  // Cost is only reported when the engine sent real tokens; the price table resolves the rest.
  const costMicros = hasTokens ? (typeof reported?.costMicros === "number" ? Math.round(reported.costMicros) : estimateCostMicros(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })) : null;
  const provider = model ? providerForModel(model) : config.PRIME_AGENT_PROVIDER ?? null;
  db.prepare("INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,estimated,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), runId, projectId, model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costMicros, hasTokens ? 0 : 1, reported ? JSON.stringify(reported.raw ?? null).slice(0, 4000) : null, new Date().toISOString());
}

async function executeRun(runId: string, projectId: string, prompt: string, conversationId?: string, knowledge?: KnowledgeContext, model?: string) {
  const startedAt = new Date().toISOString();
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(startedAt, runId);
  let text = "";
  try {
    if (knowledge?.hits?.length) publishRunEvent(runId, "knowledge", { hits: knowledge.hits });
    // The conversation id is the engine session id, so follow-up questions keep the earlier turns.
    let usage: any = null;
    for await (const event of engine.run({ runId, sessionId: conversationId ?? runId, prompt: withKnowledge(prompt, knowledge), model: model || config.PRIME_AGENT_MODEL, provider: model ? providerForModel(model) : config.PRIME_AGENT_PROVIDER })) {
      if (event.type !== "completed") publishRunEvent(runId, event.type, event.data);
      if (event.type === "text") text += typeof event.data === "string" ? event.data : JSON.stringify(event.data);
      if (event.type === "completed") usage = (event.data as { usage?: unknown })?.usage ?? null;
      if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "ENGINE_FAILED"));
    }
    recordRunUsage(runId, projectId, prompt, text, usage);
    db.prepare("UPDATE runs SET status='completed', result=?, finished_at=? WHERE id=?").run(text || null, new Date().toISOString(), runId);
    publishRunEvent(runId, "completed", { result: text });
    if (conversationId) db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(),conversationId,"assistant",text || "",runId,new Date().toISOString());
  } catch (error) {
    const message = error instanceof Error ? error.message : "RUN_FAILED";
    db.prepare("UPDATE runs SET status='failed', error_code=?, finished_at=? WHERE id=?").run(message, new Date().toISOString(), runId);
    publishRunEvent(runId, "failed", { message });
    // A failed engine run is worth a notification, because it usually needs a human.
    const owner = db.prepare("SELECT workspace_id AS workspaceId FROM projects WHERE id=?").get(projectId) as { workspaceId: string } | undefined;
    notify(owner?.workspaceId ?? null, null, "run", "Run gagal", `Run ${runId.slice(0, 8)} gagal: ${message.slice(0, 200)}`, "/");
  }
}

app.post<{ Params: { conversationId: string }; Body: { content?: string; model?: string } }>("/api/v1/conversations/:conversationId/messages", { preHandler: requireUser }, async (request: any, reply) => {
  const content = request.body?.content?.trim();
  const model = request.body?.model?.trim() || undefined;
  if (!content || content.length > 100_000) return reply.code(400).send({ error: "INVALID_MESSAGE" });
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
  const conversation = db.prepare("SELECT c.id, c.project_id AS projectId, m.role AS role FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as { id: string; projectId: string; role: string } | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  if (conversation.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const runId = randomUUID(); const messageId = randomUUID(); const now = new Date().toISOString();
  const retrieved = buildKnowledgeContext(conversation.projectId, content);
  const knowledge: KnowledgeContext | undefined = retrieved.hits.length ? { text: retrieved.text, hits: retrieved.hits.map((hit) => ({ documentId: hit.documentId, title: hit.title, chunkIndex: hit.chunkIndex })) } : undefined;
  const transaction = db.transaction(() => {
    db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)").run(runId, conversation.projectId, "queued", content, model ?? config.PRIME_AGENT_MODEL, now);
    db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(messageId, conversation.id, "user", content, runId, now);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversation.id);
  }); transaction();
  void executeRun(runId, conversation.projectId, content, conversation.id, knowledge, model);
  return reply.code(202).send({ message: { id: messageId, conversationId: conversation.id, role: "user", content, runId, createdAt: now }, run: { id: runId, status: "queued" } });
});

/** Run history for one project, newest first. Optional ?conversationId= filter. */
app.get<{ Params: { projectId: string }; Querystring: { conversationId?: string; limit?: string } }>("/api/v1/projects/:projectId/runs", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT p.id FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const limit = Math.min(Math.max(Number(request.query?.limit ?? 50) || 50, 1), 200);
  const conversationId = request.query?.conversationId?.trim() || null;
  // A run reaches its conversation through the messages table, so the link comes from a subquery.
  const rows = db.prepare(`
    SELECT r.id,
           (SELECT m.conversation_id FROM messages m WHERE m.run_id = r.id LIMIT 1) AS conversationId,
           r.status, r.prompt, r.result, r.model, r.error_code AS errorCode,
           r.created_at AS createdAt, r.finished_at AS finishedAt,
           COALESCE(u.input_tokens,0) AS inputTokens, COALESCE(u.output_tokens,0) AS outputTokens,
           COALESCE(u.cost_micros,0) AS costMicros, COALESCE(u.estimated,0) AS estimated
    FROM runs r LEFT JOIN run_usage u ON u.run_id = r.id
    WHERE r.project_id = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.run_id = r.id AND m.conversation_id = ?))
    ORDER BY r.created_at DESC LIMIT ?`).all(request.params.projectId, conversationId, conversationId, limit);
  return { runs: rows.map((row: any) => ({ ...row, costUsd: Number(((row.costMicros ?? 0) / 1_000_000).toFixed(6)) })) };
});

/** Rename a project. Owners and admins of the workspace may do this. */
app.patch<{ Params: { projectId: string }; Body: { name?: string; description?: string } }>("/api/v1/projects/:projectId", { preHandler: requireUser }, async (request: any, reply) => {
  const access = db.prepare("SELECT p.id, p.workspace_id AS workspaceId, m.role AS role FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id) as { id: string; workspaceId: string; role: string } | undefined;
  if (!access) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (access.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const name = request.body?.name?.trim();
  const description = request.body?.description?.trim();
  if (name !== undefined && (!name || name.length > 120)) return reply.code(400).send({ error: "INVALID_PROJECT_NAME" });
  const now = new Date().toISOString();
  db.prepare("UPDATE projects SET name=COALESCE(?,name), description=COALESCE(?,description), updated_at=? WHERE id=?").run(name ?? null, description ?? null, now, access.id);
  const project = db.prepare("SELECT id, workspace_id AS workspaceId, name, slug, description, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id=?").get(access.id);
  recordAudit(access.workspaceId, request.user!.id, "project.updated", { projectId: access.id, name: name ?? null });
  return { project };
});

app.post<{ Params: { projectId: string }; Body: { prompt?: string; model?: string } }>("/api/v1/projects/:projectId/runs", { preHandler: requireUser }, async (request: any, reply) => {
  const prompt = request.body?.prompt?.trim();
  const model = request.body?.model?.trim() || undefined;
  if (!prompt || prompt.length > 100_000) return reply.code(400).send({ error: "INVALID_PROMPT" });
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
  const project = db.prepare("SELECT p.id, p.workspace_id AS workspaceId, m.role AS role FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id) as { id: string; workspaceId: string; role: string } | undefined;
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (project.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  // Cost and speed guards: a workspace can cap how much engine work it starts.
  const guard = guardWorkspaceUsage(project.workspaceId);
  if (guard) {
    notify(project.workspaceId, null, "cost", guard.error === "COST_LIMIT_EXCEEDED" ? "Batas biaya tercapai" : "Batas kecepatan run tercapai",
      guard.error === "COST_LIMIT_EXCEEDED"
        ? `Batas pemakaian tercapai (${JSON.stringify(guard.detail)}). Naikkan batas di Pengaturan workspace atau tunggu periode berikutnya.`
        : `Terlalu banyak run pada periode ini (${JSON.stringify(guard.detail)}).`, "/");
    return reply.code(guard.status).send({ error: guard.error, ...(guard.detail ?? {}) });
  }
  const id = randomUUID(); const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)").run(id, project.id, "queued", prompt, model ?? config.PRIME_AGENT_MODEL, createdAt);
  void executeRun(id, project.id, prompt, undefined, undefined, model);
  return reply.code(202).send({ id, projectId: project.id, status: "queued", prompt, model: model ?? config.PRIME_AGENT_MODEL ?? null, createdAt });
});

app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/events", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT r.id FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE r.id=? AND m.user_id=?").get(request.params.runId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "RUN_NOT_FOUND" });
  reply.hijack(); const response = reply.raw; response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const write = (event: { type: string; data: unknown }) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  const history = db.prepare("SELECT type,data_json AS data FROM run_events WHERE run_id=? ORDER BY id ASC").all(request.params.runId) as { type: string; data: string }[];
  for (const event of history) write({ type: event.type, data: JSON.parse(event.data) });
  const done = history.some((event) => ["completed", "failed"].includes(event.type));
  if (done) { response.end(); return; }
  const unsubscribe = subscribeRun(request.params.runId, write); const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  const close = () => { clearInterval(heartbeat); unsubscribe(); };
  request.raw.on("close", close);
});

app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", { preHandler: requireUser }, async (request: any, reply) => {
  const run = db.prepare("SELECT r.id, r.project_id AS projectId, r.status, r.prompt, r.result, r.model, r.error_code AS errorCode, r.started_at AS startedAt, r.finished_at AS finishedAt, r.created_at AS createdAt FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE r.id=? AND m.user_id=?").get(request.params.runId, request.user!.id);
  if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND" });
  return run;
});

app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/cancel", { preHandler: requireUser }, async (request: any, reply) => {
  const run = db.prepare("SELECT r.id FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE r.id=? AND m.user_id=?").get(request.params.runId, request.user!.id);
  if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND" });
  await engine.cancel(request.params.runId);
  db.prepare("UPDATE runs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','running')").run(new Date().toISOString(), request.params.runId);
  return { ok: true };
});

app.get<{ Params: { artifactId: string } }>("/api/v1/artifacts/:artifactId/download", { preHandler: requireUser }, async (request: any, reply) => {
  const artifact = db.prepare("SELECT a.name, a.mime_type AS mimeType, a.storage_path AS storagePath FROM artifacts a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE a.id=? AND m.user_id=?").get(request.params.artifactId, request.user!.id) as { name: string; mimeType: string; storagePath: string } | undefined;
  if (!artifact) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND" });
  try { const content = await readFile(artifact.storagePath); return reply.header("Content-Disposition", `attachment; filename="${artifact.name.replaceAll('"', "")}"`).type(artifact.mimeType).send(content); }
  catch { return reply.code(404).send({ error: "ARTIFACT_FILE_MISSING" }); }
});
app.post<{ Params: { workspaceId: string }; Body: { email?: string; role?: "owner" | "admin" | "member" | "viewer" } }>("/api/v1/workspaces/:workspaceId/invitations", { preHandler: requireUser }, async (request: any, reply) => {
  const membership = db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(request.params.workspaceId, request.user!.id) as { role: string } | undefined;
  if (!membership) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (membership.role !== "owner") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const email = request.body?.email?.trim().toLowerCase(); const role = request.body?.role ?? "viewer";
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || !["owner","admin","member","viewer"].includes(role)) return reply.code(400).send({ error: "INVALID_INVITATION" });
  const token = randomBytes(32).toString("hex"); const id = randomUUID(); const now = new Date(); const expires = new Date(now.getTime() + 7 * 86400000).toISOString();
  db.prepare("INSERT INTO workspace_invitations (id,workspace_id,email,role,token_hash,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id,request.params.workspaceId,email,role,createHash("sha256").update(token).digest("hex"),expires,request.user!.id,now.toISOString());
  return reply.code(201).send({ id, workspaceId: request.params.workspaceId, email, role, expiresAt: expires, token });
});
app.get<{ Params: { workspaceId: string } }>("/api/v1/workspaces/:workspaceId/members", { preHandler: requireUser }, async (request: any, reply) => {
  const role = membershipRole(request.params.workspaceId, request.user!.id);
  if (!role) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  return db.prepare(`SELECT m.user_id AS userId, u.email, u.display_name AS displayName, m.role, m.created_at AS joinedAt
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.email`).all(request.params.workspaceId);
});

/** Changes a member role. Only owners and admins may do this, and the last owner cannot be demoted. */
app.patch<{ Params: { workspaceId: string; userId: string }; Body: { role?: string } }>("/api/v1/workspaces/:workspaceId/members/:userId", { preHandler: requireUser }, async (request: any, reply) => {
  const actorRole = membershipRole(request.params.workspaceId, request.user!.id);
  if (!actorRole) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!["owner", "admin"].includes(actorRole)) return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const nextRole = String(request.body?.role ?? "");
  if (!["owner", "admin", "member", "viewer"].includes(nextRole)) return reply.code(400).send({ error: "INVALID_ROLE" });
  if (nextRole === "owner" && actorRole !== "owner") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const target = db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(request.params.workspaceId, request.params.userId) as { role: string } | undefined;
  if (!target) return reply.code(404).send({ error: "MEMBER_NOT_FOUND" });
  if (target.role === "owner" && nextRole !== "owner") {
    const owners = (db.prepare("SELECT COUNT(*) AS total FROM memberships WHERE workspace_id=? AND role='owner'").get(request.params.workspaceId) as { total: number }).total;
    if (owners <= 1) return reply.code(409).send({ error: "LAST_OWNER_CANNOT_BE_DEMOTED" });
  }
  db.prepare("UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?").run(nextRole, request.params.workspaceId, request.params.userId);
  recordAudit(request.params.workspaceId, request.user!.id, "member.role_updated", { userId: request.params.userId, from: target.role, to: nextRole });
  return { userId: request.params.userId, role: nextRole };
});

app.delete<{ Params: { workspaceId: string; userId: string } }>("/api/v1/workspaces/:workspaceId/members/:userId", { preHandler: requireUser }, async (request: any, reply) => {
  const actorRole = membershipRole(request.params.workspaceId, request.user!.id);
  if (!actorRole) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!["owner", "admin"].includes(actorRole)) return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const target = db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(request.params.workspaceId, request.params.userId) as { role: string } | undefined;
  if (!target) return reply.code(404).send({ error: "MEMBER_NOT_FOUND" });
  if (target.role === "owner" && actorRole !== "owner") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  if (target.role === "owner") {
    const owners = (db.prepare("SELECT COUNT(*) AS total FROM memberships WHERE workspace_id=? AND role='owner'").get(request.params.workspaceId) as { total: number }).total;
    if (owners <= 1) return reply.code(409).send({ error: "LAST_OWNER_CANNOT_BE_REMOVED" });
  }
  db.prepare("DELETE FROM memberships WHERE workspace_id=? AND user_id=?").run(request.params.workspaceId, request.params.userId);
  recordAudit(request.params.workspaceId, request.user!.id, "member.removed", { userId: request.params.userId, role: target.role });
  return { removed: true, userId: request.params.userId };
});

app.get<{ Params: { workspaceId: string } }>("/api/v1/workspaces/:workspaceId/invitations", { preHandler: requireUser }, async (request: any, reply) => {
  const actorRole = membershipRole(request.params.workspaceId, request.user!.id);
  if (!actorRole) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!["owner", "admin"].includes(actorRole)) return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  return db.prepare("SELECT id, email, role, expires_at AS expiresAt, accepted_at AS acceptedAt, created_at AS createdAt FROM workspace_invitations WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").all(request.params.workspaceId);
});

app.delete<{ Params: { invitationId: string } }>("/api/v1/invitations/:invitationId", { preHandler: requireUser }, async (request: any, reply) => {
  const invitation = db.prepare("SELECT id, workspace_id AS workspaceId, email, accepted_at AS acceptedAt FROM workspace_invitations WHERE id=?").get(request.params.invitationId) as { id: string; workspaceId: string; email: string; acceptedAt: string | null } | undefined;
  if (!invitation) return reply.code(404).send({ error: "INVITATION_NOT_FOUND" });
  const actorRole = membershipRole(invitation.workspaceId, request.user!.id);
  if (!actorRole) return reply.code(404).send({ error: "INVITATION_NOT_FOUND" });
  if (!["owner", "admin"].includes(actorRole)) return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  if (invitation.acceptedAt) return reply.code(409).send({ error: "INVITATION_ALREADY_ACCEPTED" });
  db.prepare("DELETE FROM workspace_invitations WHERE id=?").run(invitation.id);
  recordAudit(invitation.workspaceId, request.user!.id, "invitation.revoked", { invitationId: invitation.id, email: invitation.email });
  return { revoked: true, id: invitation.id };
});

app.post<{ Body: { token?: string } }>("/api/v1/invitations/accept", { preHandler: requireUser }, async (request: any, reply) => {
  const token = request.body?.token?.trim(); if (!token) return reply.code(400).send({ error: "TOKEN_REQUIRED" });
  const invitation = db.prepare("SELECT * FROM workspace_invitations WHERE token_hash=? AND accepted_at IS NULL").get(createHash("sha256").update(token).digest("hex")) as any;
  if (!invitation || new Date(invitation.expires_at).getTime() <= Date.now()) return reply.code(400).send({ error: "INVITATION_INVALID_OR_EXPIRED" });
  if (invitation.email !== request.user!.email.toLowerCase()) return reply.code(403).send({ error: "INVITATION_EMAIL_MISMATCH" });
  const apply = db.transaction(() => { db.prepare("INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role").run(invitation.workspace_id,request.user!.id,invitation.role,new Date().toISOString()); db.prepare("UPDATE workspace_invitations SET accepted_at=? WHERE id=?").run(new Date().toISOString(),invitation.id); }); apply();
  return { accepted: true, workspaceId: invitation.workspace_id, role: invitation.role };
});

app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/workflows", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  return db.prepare("SELECT id, project_id AS projectId, name, description, steps_json AS stepsJson, status, schedule_enabled AS scheduleEnabled, schedule_interval_minutes AS intervalMinutes, next_run_at AS nextRunAt, last_run_at AS lastRunAt, created_at AS createdAt, updated_at AS updatedAt FROM workflows WHERE project_id=? ORDER BY updated_at DESC").all(request.params.projectId).map((w: any) => ({ ...w, steps: JSON.parse(w.stepsJson), stepsJson: undefined, scheduleEnabled: Boolean(w.scheduleEnabled) }));
});
app.post<{ Params: { projectId: string }; Body: { name?: string; description?: string; steps?: unknown[] } }>("/api/v1/projects/:projectId/workflows", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT workspace_id AS workspaceId FROM projects WHERE id=?").get(request.params.projectId) as { workspaceId: string } | undefined;
  const role = project ? membershipRole(project.workspaceId, request.user!.id) : undefined;
  if (!role) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const name = request.body?.name?.trim(); const steps = request.body?.steps;
  if (!name || !Array.isArray(steps) || steps.length > 50 || steps.some((step) => !step || typeof step !== "object")) return reply.code(400).send({ error: "INVALID_WORKFLOW" });
  const id = randomUUID(); const now = new Date().toISOString(); const description = request.body?.description?.trim() ?? "";
  db.prepare("INSERT INTO workflows (id,project_id,name,description,steps_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, request.params.projectId, name, description, JSON.stringify(steps), "draft", now, now);
  return reply.code(201).send({ id, projectId: request.params.projectId, name, description, steps, status: "draft", createdAt: now, updatedAt: now });
});
app.post<{ Params: { executionId: string }; Body: { decision?: string } }>("/api/v1/workflow-executions/:executionId/approval", { preHandler: requireUser }, async (request: any, reply) => {
  const execution = db.prepare("SELECT e.*, p.workspace_id AS workspaceId FROM workflow_executions e JOIN projects p ON p.id=e.project_id WHERE e.id=?").get(request.params.executionId) as any;
  if (!execution || !membershipRole(execution.workspaceId, request.user!.id)) return reply.code(404).send({ error: "EXECUTION_NOT_FOUND" });
  if (execution.approval_status !== "pending" || execution.status !== "awaiting_approval") return reply.code(409).send({ error: "APPROVAL_NOT_PENDING" });
  const decision = request.body?.decision; if (decision !== "approved" && decision !== "rejected") return reply.code(400).send({ error: "INVALID_DECISION" });
  const now = new Date().toISOString();
  db.prepare("UPDATE workflow_executions SET approval_status=?, approved_by=? WHERE id=?").run(decision, request.user!.id, execution.id);
  db.prepare("UPDATE workflow_execution_steps SET status=?, finished_at=? WHERE execution_id=? AND step_index=?").run(decision === "approved" ? "completed" : "rejected", now, execution.id, execution.current_step);
  recordAudit(execution.workspaceId, request.user!.id, `workflow.execution.approval.${decision}`, { executionId: execution.id });
  if (decision === "rejected") {
    db.prepare("UPDATE workflow_executions SET status='failed', error='Approval rejected', finished_at=? WHERE id=?").run(now, execution.id);
    return { id: execution.id, status: "failed", approvalStatus: decision };
  }
  db.prepare("UPDATE workflow_executions SET status='running', current_step=?, cancel_requested=0 WHERE id=?").run((execution.current_step ?? 0) + 1, execution.id);
  startWorkflowExecution(execution.id);
  return { id: execution.id, status: "running", approvalStatus: decision };
});

app.get<{ Params: { executionId: string } }>("/api/v1/workflow-executions/:executionId", { preHandler: requireUser }, async (request: any, reply) => {
  const execution = db.prepare("SELECT e.*, p.workspace_id AS workspaceId FROM workflow_executions e JOIN projects p ON p.id=e.project_id WHERE e.id=?").get(request.params.executionId) as any;
  if (!execution || !membershipRole(execution.workspaceId, request.user!.id)) return reply.code(404).send({ error: "EXECUTION_NOT_FOUND" });
  const steps = db.prepare("SELECT id, step_index AS stepIndex, step_id AS stepId, type, status, input, output, error, started_at AS startedAt, finished_at AS finishedAt FROM workflow_execution_steps WHERE execution_id=? ORDER BY step_index ASC").all(request.params.executionId);
  return {
    id: execution.id, workflowId: execution.workflow_id, projectId: execution.project_id, status: execution.status,
    approvalStatus: execution.approval_status, attempt: execution.attempt, currentStep: execution.current_step,
    input: execution.input, output: execution.output, error: execution.error, createdAt: execution.created_at, steps,
  };
});

app.post<{ Params: { executionId: string } }>("/api/v1/workflow-executions/:executionId/cancel", { preHandler: requireUser }, async (request: any, reply) => {
  const execution = db.prepare("SELECT e.*, p.workspace_id AS workspaceId FROM workflow_executions e JOIN projects p ON p.id=e.project_id WHERE e.id=?").get(request.params.executionId) as any;
  if (!execution || !membershipRole(execution.workspaceId, request.user!.id)) return reply.code(404).send({ error: "EXECUTION_NOT_FOUND" });
  if (["completed", "failed", "cancelled"].includes(execution.status)) return reply.code(409).send({ error: "EXECUTION_ALREADY_FINISHED" });
  const now = new Date().toISOString();
  db.prepare("UPDATE workflow_executions SET cancel_requested=1, status='cancelled', approval_status=CASE WHEN approval_status='pending' THEN 'cancelled' ELSE approval_status END, finished_at=? WHERE id=?").run(now, execution.id);
  recordAudit(execution.workspaceId, request.user!.id, "workflow.execution.cancel_requested", { executionId: execution.id });
  return { id: execution.id, status: "cancelled" };
});

app.post<{ Params: { executionId: string } }>("/api/v1/workflow-executions/:executionId/retry", { preHandler: requireUser }, async (request: any, reply) => {
  const execution = db.prepare("SELECT e.*, p.workspace_id AS workspaceId FROM workflow_executions e JOIN projects p ON p.id=e.project_id WHERE e.id=?").get(request.params.executionId) as any;
  if (!execution || !membershipRole(execution.workspaceId, request.user!.id)) return reply.code(404).send({ error: "EXECUTION_NOT_FOUND" });
  if (execution.status === "running" || execution.status === "awaiting_approval") return reply.code(409).send({ error: "EXECUTION_STILL_ACTIVE" });
  const attempt = Number(execution.attempt ?? 1) + 1;
  const id = createExecution(execution.workflow_id, execution.input, request.user!.id);
  if (!id) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  db.prepare("UPDATE workflow_executions SET attempt=? WHERE id=?").run(attempt, id);
  recordAudit(execution.workspaceId, request.user!.id, "workflow.execution.retried", { previousExecutionId: execution.id, executionId: id, attempt });
  startWorkflowExecution(id);
  return reply.code(202).send({ id, workflowId: execution.workflow_id, attempt, status: "queued" });
});

app.get<{ Params: { workflowId: string } }>("/api/v1/workflows/:workflowId/executions", { preHandler: requireUser }, async (request: any, reply) => {
  const access = workflowAccess(request.params.workflowId, request.user!.id);
  if (!access) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  return db.prepare("SELECT id, workflow_id AS workflowId, project_id AS projectId, status, approval_status AS approvalStatus, attempt, current_step AS currentStep, input, output, error, started_at AS startedAt, finished_at AS finishedAt, created_at AS createdAt FROM workflow_executions WHERE workflow_id=? ORDER BY created_at DESC LIMIT 100").all(request.params.workflowId);
});

app.post<{ Params: { workflowId: string }; Body: { input?: string } }>("/api/v1/workflows/:workflowId/execute", { preHandler: requireUser }, async (request: any, reply) => {
  const access = workflowAccess(request.params.workflowId, request.user!.id);
  if (!access) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  if (access.role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  if (access.status !== "published") return reply.code(409).send({ error: "WORKFLOW_NOT_PUBLISHED" });
  // Workflow prompt steps also cost money, so the same guard applies.
  const workspace = db.prepare("SELECT workspace_id AS workspaceId FROM projects WHERE id=?").get(access.projectId) as { workspaceId: string } | undefined;
  const guard = workspace ? guardWorkspaceUsage(workspace.workspaceId) : null;
  if (guard && workspace) {
    notify(workspace.workspaceId, null, "cost", guard.error === "COST_LIMIT_EXCEEDED" ? "Batas biaya tercapai" : "Batas kecepatan run tercapai", `Eksekusi workflow ditolak (${JSON.stringify(guard.detail ?? {})}).`, "/");
    return reply.code(guard.status).send({ error: guard.error, ...(guard.detail ?? {}) });
  }
  const input = String(request.body?.input ?? "");
  const id = createExecution(access.id, input, request.user!.id);
  if (!id) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  startWorkflowExecution(id);
  return reply.code(202).send({ id, workflowId: access.id, projectId: access.projectId, status: "queued", createdAt: new Date().toISOString() });
});

app.put<{ Params: { workflowId: string }; Body: { name?: string; description?: string; steps?: unknown[] } }>("/api/v1/workflows/:workflowId", { preHandler: requireUser }, async (request: any, reply) => {
  const access = workflowAccess(request.params.workflowId, request.user!.id);
  if (!access) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  if (access.role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const steps = request.body?.steps;
  if (steps !== undefined && (!Array.isArray(steps) || steps.length > 50 || steps.some((step) => !step || typeof step !== "object"))) return reply.code(400).send({ error: "INVALID_WORKFLOW" });
  const name = request.body?.name?.trim() || access.name;
  const description = request.body?.description?.trim() ?? access.description ?? "";
  const now = new Date().toISOString();
  db.prepare("UPDATE workflows SET name=?, description=?, steps_json=COALESCE(?,steps_json), updated_at=? WHERE id=?").run(name, description, steps ? JSON.stringify(steps) : null, now, access.id);
  return { id: access.id, name, description, steps, updatedAt: now };
});

app.post<{ Params: { workflowId: string }; Body: { intervalMinutes?: number; enabled?: boolean } }>("/api/v1/workflows/:workflowId/schedule", { preHandler: requireUser }, async (request: any, reply) => {
  const access = workflowAccess(request.params.workflowId, request.user!.id);
  if (!access) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  if (access.role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const interval = request.body?.intervalMinutes === null || request.body?.intervalMinutes === undefined ? null : Number(request.body.intervalMinutes);
  const enabled = Boolean(request.body?.enabled);
  if (enabled && (!interval || Number.isNaN(interval) || interval < 1 || interval > 20_160)) return reply.code(400).send({ error: "INVALID_SCHEDULE" });
  const now = new Date();
  const next = enabled && interval ? new Date(now.getTime() + interval * 60_000).toISOString() : null;
  db.prepare("UPDATE workflows SET schedule_enabled=?, schedule_interval_minutes=?, next_run_at=?, updated_at=? WHERE id=?").run(enabled ? 1 : 0, interval, next, now.toISOString(), access.id);
  recordAudit(access.workspaceId, request.user!.id, "workflow.schedule.updated", { workflowId: access.id, enabled, intervalMinutes: interval });
  return { id: access.id, scheduleEnabled: enabled, intervalMinutes: interval, nextRunAt: next };
});

app.get<{ Params: { workspaceId: string }; Querystring: { limit?: string } }>("/api/v1/workspaces/:workspaceId/audit", { preHandler: requireUser }, async (request: any, reply) => {
  const role = membershipRole(request.params.workspaceId, request.user!.id);
  if (!role) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  const limit = Math.min(Math.max(Number(request.query?.limit ?? 100), 1), 500);
  return db.prepare("SELECT id, action, actor_user_id AS actorUserId, metadata_json AS metadata, created_at AS createdAt FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?").all(request.params.workspaceId, limit).map((row: any) => ({ ...row, metadata: JSON.parse(row.metadata) }));
});

app.post<{ Params: { workflowId: string } }>("/api/v1/workflows/:workflowId/publish", { preHandler: requireUser }, async (request: any, reply) => {
  const row = db.prepare("SELECT w.id, w.project_id AS projectId, p.workspace_id AS workspaceId FROM workflows w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(request.params.workflowId) as any;
  const role = row ? membershipRole(row.workspaceId, request.user!.id) : undefined;
  if (!row || !role) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const now = new Date().toISOString(); db.prepare("UPDATE workflows SET status='published', updated_at=? WHERE id=?").run(now, row.id);
  return { id: row.id, projectId: row.projectId, status: "published", updatedAt: now };
});

app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/knowledge", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  return db.prepare("SELECT id, project_id AS projectId, title, source_type AS sourceType, checksum, created_at AS createdAt, updated_at AS updatedAt FROM knowledge_documents WHERE project_id=? ORDER BY updated_at DESC").all(request.params.projectId);
});
app.post<{ Params: { projectId: string }; Body: { title?: string; content?: string } }>("/api/v1/projects/:projectId/knowledge", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT p.workspace_id AS workspaceId FROM projects p WHERE p.id=?").get(request.params.projectId) as { workspaceId: string } | undefined;
  const role = project ? membershipRole(project.workspaceId, request.user!.id) : undefined;
  if (!role) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const title = request.body?.title?.trim(); const content = request.body?.content;
  if (!title || typeof content !== "string" || !content.trim() || content.length > 2_000_000) return reply.code(400).send({ error: "INVALID_KNOWLEDGE_DOCUMENT" });
  const id = randomUUID(); const now = new Date().toISOString(); const checksum = createHash("sha256").update(content).digest("hex");
  db.prepare("INSERT INTO knowledge_documents (id,project_id,title,source_type,content,checksum,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id,request.params.projectId,title,"text",content,checksum,now,now);
  db.prepare("INSERT INTO knowledge_search (title,content,document_id) VALUES (?,?,?)").run(title,content,id);
  const chunkCount = indexDocument(id, request.params.projectId, `${title}\n\n${content}`);
  return reply.code(201).send({ id, projectId: request.params.projectId, title, sourceType: "text", checksum, chunkCount, createdAt: now, updatedAt: now });
});
app.get<{ Params: { projectId: string }; Querystring: { q?: string; limit?: string } }>("/api/v1/projects/:projectId/knowledge/search", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const q = request.query?.q?.trim(); if (!q) return reply.code(400).send({ error: "QUERY_REQUIRED" });
  const limit = Math.min(Math.max(Number(request.query?.limit ?? 8) || 8, 1), 20);
  return searchChunks(request.params.projectId, q, limit);
});

/** Uploads a document (txt, md, csv, json, pdf, docx) as Base64, extracts the text and indexes chunks. */
app.post<{ Params: { projectId: string }; Body: { title?: string; filename?: string; contentBase64?: string } }>("/api/v1/projects/:projectId/knowledge/upload", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT p.workspace_id AS workspaceId FROM projects p WHERE p.id=?").get(request.params.projectId) as { workspaceId: string } | undefined;
  const role = project ? membershipRole(project.workspaceId, request.user!.id) : undefined;
  if (!role) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const filename = String(request.body?.filename ?? "").trim();
  const base64 = request.body?.contentBase64;
  if (!filename || typeof base64 !== "string" || !base64) return reply.code(400).send({ error: "INVALID_UPLOAD" });
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return reply.code(400).send({ error: "INVALID_BASE64" });
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) return reply.code(400).send({ error: "FILE_TOO_LARGE" });
  let extracted;
  try { extracted = await extractText(buffer, filename); }
  catch (error) { return reply.code(400).send({ error: String((error as Error).message || "EXTRACTION_FAILED") }); }
  if (!extracted.text.trim()) return reply.code(400).send({ error: "DOCUMENT_HAS_NO_TEXT" });
  const title = request.body?.title?.trim() || filename;
  const id = randomUUID(); const now = new Date().toISOString(); const checksum = contentChecksum(extracted.text);
  const duplicate = db.prepare("SELECT id, title FROM knowledge_documents WHERE project_id=? AND checksum=?").get(request.params.projectId, checksum) as { id: string; title: string } | undefined;
  if (duplicate) return reply.code(409).send({ error: "DOCUMENT_ALREADY_EXISTS", documentId: duplicate.id, title: duplicate.title });
  db.prepare("INSERT INTO knowledge_documents (id,project_id,title,source_type,content,checksum,filename,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, request.params.projectId, title, extracted.kind, extracted.text, checksum, filename, now, now);
  db.prepare("INSERT INTO knowledge_search (title,content,document_id) VALUES (?,?,?)").run(title, extracted.text, id);
  const chunkCount = indexDocument(id, request.params.projectId, `${title}\n\n${extracted.text}`);
  recordAudit(project!.workspaceId, request.user!.id, "knowledge.document.uploaded", { documentId: id, filename, kind: extracted.kind, chunkCount, bytes: buffer.length });
  return reply.code(201).send({ id, projectId: request.params.projectId, title, sourceType: extracted.kind, filename, checksum, chunkCount, characters: extracted.text.length, createdAt: now, updatedAt: now });
});

app.get<{ Params: { projectId: string; documentId: string } }>("/api/v1/projects/:projectId/knowledge/:documentId", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const document = db.prepare("SELECT id, project_id AS projectId, title, source_type AS sourceType, filename, checksum, chunk_count AS chunkCount, length(content) AS characters, created_at AS createdAt, updated_at AS updatedAt FROM knowledge_documents WHERE id=? AND project_id=?").get(request.params.documentId, request.params.projectId);
  if (!document) return reply.code(404).send({ error: "DOCUMENT_NOT_FOUND" });
  const chunks = db.prepare("SELECT chunk_index AS chunkIndex, substr(content, 1, 400) AS preview FROM knowledge_chunks WHERE document_id=? ORDER BY chunk_index LIMIT 50").all(request.params.documentId);
  return { document, chunks };
});

app.delete<{ Params: { projectId: string; documentId: string } }>("/api/v1/projects/:projectId/knowledge/:documentId", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT p.workspace_id AS workspaceId FROM projects p WHERE p.id=?").get(request.params.projectId) as { workspaceId: string } | undefined;
  const role = project ? membershipRole(project.workspaceId, request.user!.id) : undefined;
  if (!role) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const existing = db.prepare("SELECT id FROM knowledge_documents WHERE id=? AND project_id=?").get(request.params.documentId, request.params.projectId);
  if (!existing) return reply.code(404).send({ error: "DOCUMENT_NOT_FOUND" });
  deleteDocument(request.params.documentId);
  recordAudit(project!.workspaceId, request.user!.id, "knowledge.document.deleted", { documentId: request.params.documentId });
  return { deleted: true, id: request.params.documentId };
});;

app.patch<{ Params: { conversationId: string }; Body: { title?: string; pinned?: boolean } }>("/api/v1/conversations/:conversationId", { preHandler: requireUser }, async (request: any, reply) => {
  const conversation = db.prepare("SELECT c.id, c.title, c.pinned, m.role AS role FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as { id: string; title: string; pinned: number; role: string } | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  if (conversation.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const title = request.body?.title === undefined ? conversation.title : String(request.body.title).trim().slice(0, 120);
  if (!title) return reply.code(400).send({ error: "INVALID_TITLE" });
  const pinned = request.body?.pinned === undefined ? conversation.pinned : request.body.pinned ? 1 : 0;
  db.prepare("UPDATE conversations SET title=?, pinned=?, updated_at=? WHERE id=?").run(title, pinned, new Date().toISOString(), conversation.id);
  return { id: conversation.id, title, pinned: Boolean(pinned) };
});

app.delete<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId", { preHandler: requireUser }, async (request: any, reply) => {
  const conversation = db.prepare("SELECT c.id, p.workspace_id AS workspaceId, m.role AS role FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as { id: string; workspaceId: string; role: string } | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  if (conversation.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE conversation_id=?").run(conversation.id);
    db.prepare("DELETE FROM conversations WHERE id=?").run(conversation.id);
  })();
  recordAudit(conversation.workspaceId, request.user!.id, "conversation.deleted", { conversationId: conversation.id });
  return { deleted: true, id: conversation.id };
});

app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/export", { preHandler: requireUser }, async (request: any, reply) => {
  const conversation = db.prepare("SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt, p.id AS projectId FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as Record<string, unknown> | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  const messages = db.prepare("SELECT role, content, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at").all(conversation.id);
  return { format: "coblai.conversation.v1", exportedAt: new Date().toISOString(), conversation, messages };
});

app.post<{ Params: { projectId: string }; Body: { conversation?: { title?: string; messages?: unknown } } }>("/api/v1/projects/:projectId/conversations/import", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT p.workspace_id AS workspaceId FROM projects p WHERE p.id=?").get(request.params.projectId) as { workspaceId: string } | undefined;
  const role = project ? membershipRole(project.workspaceId, request.user!.id) : undefined;
  if (!role) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const payload = request.body?.conversation;
  const rawMessages = Array.isArray(payload?.messages) ? payload!.messages as { role?: unknown; content?: unknown; createdAt?: unknown }[] : null;
  if (!payload || !rawMessages) return reply.code(400).send({ error: "INVALID_IMPORT_PAYLOAD" });
  const rows = rawMessages.filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .slice(0, 500).map((message) => ({ role: message.role as string, content: String(message.content).slice(0, 100_000), createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString() }));
  const conversationId = randomUUID();
  const title = String(payload.title ?? "Imported conversation").trim().slice(0, 120) || "Imported conversation";
  const transaction = db.transaction(() => {
    db.prepare("INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(conversationId, request.params.projectId, title, new Date().toISOString(), new Date().toISOString());
    const insert = db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)");
    for (const row of rows) insert.run(randomUUID(), conversationId, row.role, row.content, null, row.createdAt);
  });
  transaction();
  recordAudit(project!.workspaceId, request.user!.id, "conversation.imported", { conversationId, messages: rows.length });
  return reply.code(201).send({ conversation: { id: conversationId, projectId: request.params.projectId, title, messages: rows.length } });
});

app.get<{ Params: { projectId: string }; Querystring: { days?: string } }>("/api/v1/projects/:projectId/usage", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const days = Math.min(Math.max(Number(request.query?.days ?? 30) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const totals = db.prepare("SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens, COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_micros),0) AS costMicros, COALESCE(SUM(estimated),0) AS estimatedRuns, COUNT(*) - COALESCE(SUM(estimated),0) AS measuredRuns, SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS unpricedRuns FROM run_usage WHERE project_id=? AND created_at>=?").get(request.params.projectId, since) as any;
  const byModel = db.prepare("SELECT COALESCE(model,'unknown') AS model, COALESCE(provider,'unknown') AS provider, COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cost_micros),0) AS costMicros FROM run_usage WHERE project_id=? AND created_at>=? GROUP BY COALESCE(model,'unknown'), COALESCE(provider,'unknown') ORDER BY runs DESC").all(request.params.projectId, since) as any[];
  const daily = db.prepare("SELECT substr(created_at,1,10) AS day, COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cost_micros),0) AS costMicros FROM run_usage WHERE project_id=? AND created_at>=? GROUP BY substr(created_at,1,10) ORDER BY day DESC LIMIT 60").all(request.params.projectId, since) as any[];
  // Keeps sub-cent costs visible: eight decimal places of a US dollar.
  const toUsd = (micros: number | null | undefined) => Number(((micros ?? 0) / 1e6).toFixed(8));
  return {
    days, since,
    totals: { ...totals, costUsd: toUsd(totals.costMicros) },
    byModel: byModel.map((row) => ({ ...row, costUsd: toUsd(row.costMicros) })),
    daily: daily.map((row) => ({ ...row, costUsd: toUsd(row.costMicros) })),
    note: "Tokens come from the engine; runs without engine tokens are estimated from text length (estimatedRuns). Cost uses the published price table and stays null when the model price is unknown (unpricedRuns).",
  };
});

/** Runs the engine CLI once and returns its model catalogue. Never invents models. */
let catalogueCache: { at: number; value: { available: boolean; models: { provider: string; model: string; context: string; maxOutput: string; thinking: boolean; images: boolean }[]; error?: string; note?: string } } | null = null;
/** A successful catalogue is reused for ten minutes, a failure for one, so runs never spawn the CLI twice. */
const CATALOGUE_TTL_MS = 10 * 60 * 1000;
const CATALOGUE_ERROR_TTL_MS = 60 * 1000;

function readEngineModelCatalogue(): { available: boolean; models: { provider: string; model: string; context: string; maxOutput: string; thinking: boolean; images: boolean }[]; error?: string; note?: string } {
  try {
    const binary = config.PRIME_AGENT_BIN ?? "prime-agent";
    const result = spawnSync(binary, ["model", "list"], { encoding: "utf8", timeout: 20_000 });
    if (result.error) return { available: false, models: [], error: String(result.error.message ?? result.error) };
    // The engine CLI writes the table to stderr, so both streams are parsed.
    const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    const header = lines.findIndex((line) => /^provider\s+model\b/.test(line));
    const body = (header >= 0 ? lines.slice(header + 1) : lines).filter((line) => !/^provider\s+model\b/.test(line));
    const models = body.map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/\s{2,}/);
      return { provider: parts[0] ?? "", model: parts[1] ?? "", context: parts[2] ?? "", maxOutput: parts[3] ?? "", thinking: parts[4] === "yes", images: parts[5] === "yes" };
    }).filter((row) => row.model);
    // An empty catalogue usually means the engine has no provider credential yet; keep its message.
    const note = models.length ? undefined : lines.find((line) => line.trim().length > 0)?.trim().slice(0, 300);
    return { available: models.length > 0, models, note };
  } catch (error) {
    return { available: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function engineModelCatalogue(force = false) { return catalogueFor(force); }

/** Reads the engine catalogue from cache unless it is stale; never blocks the event loop on a cache hit. */
function catalogueFor(force: boolean) {
  if (!force && catalogueCache) {
    const ttl = catalogueCache.value.available ? CATALOGUE_TTL_MS : CATALOGUE_ERROR_TTL_MS;
    if (Date.now() - catalogueCache.at < ttl) return catalogueCache.value;
  }
  const value = readEngineModelCatalogue();
  catalogueCache = { at: Date.now(), value };
  return value;
}

app.get("/api/v1/models", { preHandler: requireUser }, async (request: any) => {
  const catalogue = engineModelCatalogue(request?.query?.refresh === "1");
  return { ...catalogue, default: { model: config.PRIME_AGENT_MODEL ?? null, provider: config.PRIME_AGENT_PROVIDER ?? null } };
});

app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/artifacts", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  return db.prepare("SELECT id, project_id AS projectId, run_id AS runId, name, mime_type AS mimeType, size_bytes AS sizeBytes, sha256, created_at AS createdAt FROM artifacts WHERE project_id=? ORDER BY created_at DESC").all(request.params.projectId);
});
app.post<{ Params: { projectId: string }; Body: { name?: string; mimeType?: string; contentBase64?: string; runId?: string } }>("/api/v1/projects/:projectId/artifacts", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT p.workspace_id AS workspaceId FROM projects p WHERE p.id=?").get(request.params.projectId) as { workspaceId: string } | undefined;
  const role = project ? membershipRole(project.workspaceId, request.user!.id) : undefined;
  if (!role) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const name = request.body?.name?.trim(); const mimeType = request.body?.mimeType?.trim(); const encoded = request.body?.contentBase64;
  if (!name || !mimeType || !encoded || encoded.length > 14_000_000 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || name.includes("/") || name.includes("\\")) return reply.code(400).send({ error: "INVALID_ARTIFACT" });
  let content: Buffer; try { content = Buffer.from(encoded, "base64"); } catch { return reply.code(400).send({ error: "INVALID_ARTIFACT_ENCODING" }); }
  if (content.length > 10 * 1024 * 1024) return reply.code(413).send({ error: "ARTIFACT_TOO_LARGE" });
  const id = randomUUID(); const dir = join(config.DATA_DIR, "artifacts", request.params.projectId); await mkdir(dir, { recursive: true }); const storagePath = join(dir, id); await writeFile(storagePath, content, { flag: "wx" });
  const sha256 = createHash("sha256").update(content).digest("hex"); const now = new Date().toISOString();
  db.prepare("INSERT INTO artifacts (id,project_id,run_id,name,mime_type,size_bytes,sha256,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,request.params.projectId,request.body.runId ?? null,name,mimeType,content.length,sha256,storagePath,now);
  return reply.code(201).send({ id, projectId: request.params.projectId, runId: request.body.runId ?? null, name, mimeType, sizeBytes: content.length, sha256, createdAt: now });
});

app.setErrorHandler((error: any, _request, reply) => { app.log.error(error); const status = Number(error.statusCode) >= 400 && Number(error.statusCode) < 500 ? Number(error.statusCode) : 500; return reply.code(status).send({ error: status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR" }); });

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
app.setNotFoundHandler(async (request, reply) => {
  // HEAD is answered like GET so uptime checks and monitors see a healthy page.
  if (!["GET", "HEAD"].includes(request.method) || request.url.startsWith("/api/")) return reply.code(404).send({ error: "NOT_FOUND" });
  const publicDir = normalize(config.PUBLIC_DIR); const requested = decodeURIComponent(request.url.split("?")[0]);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  if (relative.split("/").some((segment) => segment.startsWith(".")) || [".env", ".git", "package.json", "package-lock.json"].includes(relative)) return reply.code(404).send({ error: "NOT_FOUND" });
  const candidate = normalize(join(publicDir, relative));
  if (!candidate.startsWith(publicDir)) return reply.code(404).send({ error: "NOT_FOUND" });
  try { const data = await readFile(candidate); return reply.type(contentTypes[extname(candidate)] ?? "application/octet-stream").send(data); }
  catch { try { const data = await readFile(join(publicDir, "index.html")); return reply.type("text/html; charset=utf-8").send(data); } catch { return reply.code(404).send({ error: "NOT_FOUND" }); } }
});

mkdirSync(config.DATA_DIR, { recursive: true });
startWorkflowScheduler();
await app.listen({ host: config.HOST, port: config.PORT });

// Reads the engine model catalogue once at start-up so the first user request never pays the CLI cost.
setTimeout(() => { try { engineModelCatalogue(); } catch { /* the catalogue is optional, runs still work */ } }, 0);

const stop = async () => { await app.close(); db.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

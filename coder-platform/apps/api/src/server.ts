import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { extname, join, normalize, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { backfillSellCosts, catalogPriceFor, clearPriceOverride, priceView, pricingSettings, pricingTable, quoteCosts, reconcileUsage, savePriceOverride, sellForBaseMicros, setPricingMarkup, validatePrice } from "./pricing.js";
import { vendorPriceCatalogue } from "./vendor-prices.js";
import { buildKnowledgeContext, contentChecksum, deleteDocument, indexDocument, searchChunks } from "./knowledge.js";
import { extractText } from "./text-extract.js";
import { generateTotpSecret, otpAuthUrl, verifyTotp } from "./totp.js";
import { mailerConfigured, passwordResetEmail, sendMail, verificationEmail } from "./mailer.js";
import { db } from "./db.js";
import { currentSessionId, revokeOtherSessions, sessionIdForToken, touchSession } from "./auth.js";
import { engine } from "./engine.js";
import { createExecution, recordAudit, runExecution, scheduleNextRun } from "./workflow-engine.js";
import { allowLoginAttempt, clearSessionCookie, createSession, deleteSession, deviceIdForSession, getSessionUser, hashPassword, requireUser, setSessionCookie, verifyPassword, type AuthRequest } from "./auth.js";
import { checkRequestOrigin, constantTimeEquals, csrfCookieOptions, generateCsrfToken } from "./csrf.js";
import { limiterFor, rateLimitStorage, sweepRateLimitHits } from "./ratelimit.js";
import {
  API_KEY_PREFIX, MAX_API_KEYS_PER_USER, PUBLIC_API_ENDPOINTS, PUBLIC_API_LIMITS, apiKeyInFlight, apiKeyQuotaSnapshot,
  apiKeyReservedTokens, apiKeyTokensToday, authenticateApiKey,
  checkApiKeyDailyQuota, checkApiKeyRate, countActiveApiKeys, countApiKeyRequest,
  createApiKey, estimateRunTokens, getApiKey, hasScope, listApiKeys, parseScopes, releaseRunTokens, reserveRunTokens,
  revokeApiKey, touchApiKey, updateApiKey, type ApiKeyRow, type ApiScope,
} from "./apikeys.js";
/** Wave 6: outgoing webhooks. Events are queued through the Wave 5 job queue so a restart keeps them. */
import {
  blockingEarlierDelivery, cleanupWebhookDeliveries, createDeliveryRow, createWebhook, countWebhooks, deleteWebhook,
  webhookRowById,
  deliverWebhook, emitProjectEvent, getDelivery, getWebhook, listDeliveries, listWebhooks, parseEvents, resendDelivery,
  updateWebhook, validateWebhookUrl, webhookCatalogue, webhookStats, type WebhookEvent,
} from "./webhooks.js";
import {
  deleteOutboxRow, deliverPending, emailEnabled, emailWorkerState, getOutboxRow,
  listOutbox, notificationPrefs, outboxStats, queueEmail, renderEmail, retryEmail, saveNotificationPrefs, type EmailKind,
} from "./outbox.js";
import { ACCOUNT_RECOVERY_DAYS, closedAccounts, retentionPolicy, retentionReport, runRetention } from "./retention.js";
import {
  enqueueJob, getJob, jobStats, jobWorkerState, listJobs, reapAbandonedExecutions, reapAbandonedRuns,
  recoverExpiredLeases, registerJobHandler, retryJob, runJobCycleOnce, startJobWorker, type JobRow,
} from "./jobs.js";
/** Wave 7: growth measurement and the referral programme. */
import {
  GROWTH_EVENTS, backfillGrowthEvents, eventCatalogue, growthEventSources, growthOverview, isGrowthEvent,
  planGrowthBackfill, recordGrowthEvent, topEvents,
} from "./growth.js";
import {
  attachReferral, codeOwner, ensureReferralCode, listReferralsAdmin, listReferralsFor, qualifyReferralForRun,
  referralEntryFor, referralLeaderboard, referralLimits, referralProgrammeEnabled, referralStats, referralSummaryFor,
  rotateReferralCode,
} from "./referrals.js";
import { collectUserData, createExport, deleteExport, expireExports, exportFilePath, getExport, listExports } from "./dataexport.js";
import { describeCron, nextCronRun, validateCronExpression } from "./cron.js";
import {
  activeSubscription, attachOrderProof, branding, chargeQuota, createBankAccount, createOrder, createCoupon,
  creditHistory, deleteBankAccount, ensureCommerceSeed, getOrder, getPlan, grantCredit,
  listBankAccounts, listCoupons, listOrders, listPlans, markOrderPaid, paymentConfig, quotaGuard, quotaState,
  recordPayment, rejectOrder, resetQuota, revenueSummary, saveBranding, savePaymentConfig, setCouponActive,
  setUsdToIdrRate, updatePlan, usdToIdrRate, userTier, validateCoupon,
} from "./billing.js";
/** Wave 10 (items 26, 29, 31): sign-in devices, the global search and browser push. */
import {
  blockDevice, checkDeviceGate, deleteDevice, deviceCount, deviceFor, deviceSummary, deviceVerifyRequired, getDevice,
  DEVICE_LABEL_MAX, listDevices, markDeviceVerified, registerDevice, renameDevice, requestDeviceInfo, revokeDevice, setDeviceTrust, type DeviceRow,
} from "./devices.js";
import { SEARCH_KINDS, globalSearch, rebuildMessageIndex, searchStats, type SearchKind } from "./search.js";
import { registerWave11aRoutes } from "./wave11a/index.js";
import { registerCspRoutes } from "./wave11a/csp.js";
/** Wave 11B (butir 58-67, 72, 83): dewan juri, shadow, pelajaran, benchmark, timeline, resume, jadwal. */
import { registerWave11bRoutes } from "./wave11b/index.js";
import { registerWave11cRoutes } from "./wave11c/index.js";
import { guardWorkspaceUsage, workspaceGuards, workspaceSpend } from "./workspace-guard.js";
import { tampilanNominal } from "./wave11c/bayar.js";
import { registerConnectorJobHandlers } from "./wave11c/connector-job.js";
// Wave 11B (butir 63/72/83): modul wave11b memakai pengirim run, pemeriksa model, dan aturan matriks
// perilaku milik server ini — bukan salinannya.
import { setModelValidator, setRunDispatcher, setThinkingValidator } from "./wave11b/dispatch.js";
import { resolveSessionPersona } from "./wave11b/behavior-matrix.js";
import { recordErrorEvent } from "./wave11b/errors.js";
import { learningBlocks, touchLearnings } from "./wave11b/learnings.js";
import { recordShadowMeasurements, shadowModeActive } from "./wave11b/shadow.js";
import { markInterruptedRuns, markRunResumable } from "./wave11b/resume.js";
import { runDueSchedules } from "./wave11b/schedules.js";
/** Wave 11A (butir 42/45/46/51/52/80): mode, guard, guardrail, skill, KB, dan pagar konteks. */
import { agentModeBlocks, conversationAgentMode } from "./wave11a/mode.js";
import { guardrailBlockFor, guardrailViolations, recordSafetyEvent } from "./wave11a/guardrails.js";
import { platformKnowledgeBlock } from "./wave11a/knowledge-base.js";
import { touchUserSkills, userSkillsBlock } from "./wave11a/skills.js";
import { fallbackModelsFor, isTransientEngineError, MAX_FALLBACK_SWITCHES, runWithModelFallback, validateFallbackModels } from "./wave11a/fallback.js";
import { buildBudgetPlan, contextBudgetChars, registerContextBudgetRoutes } from "./wave11a/context-budget.js";
import { detectPromptHijack, hijackMessage, scanPromptHijack } from "./prompt-guard.js";
/** Wave 11A (butir 48): riwayat revisi artefak. */
/** Wave 11A (butir 44): sewa rahasia per run (isolasi kredensial antar-sesi). */
import { acquireRunSecretEnv, releaseRunSecrets } from "./run-secret-vault.js";
import {
  countSubscriptions, listSubscriptions, publicPushKey, pushConfigured, pushStats, removeSubscription,
  saveSubscription, sendPushToUser,
} from "./push.js";

// trustProxy is on because the API only listens on 127.0.0.1 behind nginx, which sets X-Forwarded-For.
// Without it every request would look like it came from the proxy and rate limits would lump users together.
const app = Fastify({ logger: true, trustProxy: true });
type Subscriber = (event: { type: string; data: unknown }) => void;
const subscribers = new Map<string, Set<Subscriber>>();
function publishRunEvent(runId: string, type: string, data: unknown) {
  db.prepare("INSERT INTO run_events (run_id,type,data_json,created_at) VALUES (?,?,?,?)").run(runId, type, JSON.stringify(data), new Date().toISOString());
  for (const send of subscribers.get(runId) ?? []) send({ type, data });
}
function subscribeRun(runId: string, send: Subscriber) { const set = subscribers.get(runId) ?? new Set<Subscriber>(); set.add(send); subscribers.set(runId, set); return () => { set.delete(send); if (!set.size) subscribers.delete(runId); }; }
/** True when the member may change workspace level settings and delete projects. */
function canManageWorkspace(workspaceId: string, userId: string) {
  const role = membershipRole(workspaceId, userId);
  return role === "owner" || role === "admin";
}

/** Counts the platform admins so the last one can never delete their own account. */
function platformAdminCount() {
  const list = config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const placeholders = list.map(() => "?").join(",");
  const sql = `SELECT COUNT(*) AS total FROM users WHERE is_admin=1${list.length ? ` OR lower(email) IN (${placeholders})` : ""}`;
  return (db.prepare(sql).get(...list) as { total: number }).total;
}

/** Deletes every row that belongs to a project. Children go first so the foreign keys stay satisfied. */
function removeProjectData(projectId: string) {
  db.prepare("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)").run(projectId);
  db.prepare("DELETE FROM workflow_execution_steps WHERE execution_id IN (SELECT id FROM workflow_executions WHERE project_id=?)").run(projectId);
  db.prepare("DELETE FROM workflow_executions WHERE project_id=?").run(projectId);
  db.prepare("DELETE FROM workflows WHERE project_id=?").run(projectId);
  db.prepare("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id=?) OR run_id IN (SELECT id FROM runs WHERE project_id=?)").run(projectId, projectId);
  for (const document of db.prepare("SELECT id FROM knowledge_documents WHERE project_id=?").all(projectId) as { id: string }[]) deleteDocument(document.id);
  db.prepare("DELETE FROM run_usage WHERE project_id=?").run(projectId);
  db.prepare("DELETE FROM artifacts WHERE project_id=?").run(projectId);
  db.prepare("DELETE FROM runs WHERE project_id=?").run(projectId);
  db.prepare("DELETE FROM conversations WHERE project_id=?").run(projectId);
  db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
}

/** Deletes a project row and its children, then removes the stored artifact files. */
async function deleteProjectFully(projectId: string) {
  db.transaction(() => removeProjectData(projectId))();
  await rm(join(config.DATA_DIR, "artifacts", projectId), { recursive: true, force: true }).catch(() => undefined);
}

/** Deletes a workspace, every project inside it, and the related invitations and notifications. */
async function deleteWorkspaceFully(workspaceId: string) {
  for (const project of db.prepare("SELECT id FROM projects WHERE workspace_id=?").all(workspaceId) as { id: string }[]) {
    await deleteProjectFully(project.id);
  }
  db.transaction(() => {
    db.prepare("DELETE FROM workspace_invitations WHERE workspace_id=?").run(workspaceId);
    db.prepare("DELETE FROM memberships WHERE workspace_id=?").run(workspaceId);
    db.prepare("DELETE FROM notifications WHERE workspace_id=?").run(workspaceId);
    db.prepare("DELETE FROM workspaces WHERE id=?").run(workspaceId);
  })();
}

/** Escapes one CSV field. */
function csvField(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function membershipRole(workspaceId: string, userId: string) { return (db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(workspaceId,userId) as { role: string } | undefined)?.role; }
function workflowAccess(workflowId: string, userId: string) {
  const row = db.prepare("SELECT w.id, w.project_id AS projectId, w.name, w.description, w.status, p.workspace_id AS workspaceId FROM workflows w JOIN projects p ON p.id=w.project_id WHERE w.id=?").get(workflowId) as any;
  if (!row) return null;
  const role = membershipRole(row.workspaceId, userId);
  return role ? { ...row, role } : null;
}

/** True when the user may inspect the whole platform (workspace list, all users, totals). */
/** Workspace pribadi tempat tindakan tingkat akun dicatat, supaya audit tidak hilang tanpa jejak. */
function accountAuditWorkspace(userId: string): string | null {
  const row = db.prepare("SELECT workspace_id FROM memberships WHERE user_id=? AND role='owner' ORDER BY created_at LIMIT 1").get(userId) as { workspace_id?: string } | undefined;
  return row?.workspace_id ?? null;
}

function isPlatformAdmin(user: { id: string; email: string }): boolean {
  const allowed = config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(user.email.toLowerCase())) return true;
  const row = db.prepare("SELECT is_admin FROM users WHERE id=?").get(user.id) as { is_admin?: number } | undefined;
  return Boolean(row?.is_admin);
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
  // Wave 4: the same event may also leave by email. It is queued, never sent here, and the person
  // can switch each kind off. Any failure is swallowed: email must not break the request itself.
  for (const target of targets) queueEventEmail(target, kind, title, body, link);
  // Wave 10 (item 31): the same event may also ring the browser. Push is sent in the background so a
  // slow push service can never slow down the request that produced the notification.
  if (pushConfigured()) {
    for (const target of targets) void sendPushToUser(target, { title, body: body ?? "", link: link ?? "/", kind }).catch(() => undefined);
  }
}

/** Kinds that repeat often are collapsed into one email per day, so the inbox stays readable. */
const DAILY_EMAIL_KINDS = new Set(["quota", "cost", "run"]);

function queueEventEmail(userId: string, kind: string, title: string, body?: string, link?: string) {
  try {
    const user = db.prepare("SELECT email FROM users WHERE id=?").get(userId) as { email: string } | undefined;
    if (!user?.email) return;
    const rendered = renderEmail(kind as EmailKind, title, body ?? "", link);
    const dedupeKey = DAILY_EMAIL_KINDS.has(kind) ? `${kind}:${userId}:${new Date().toISOString().slice(0, 10)}` : null;
    queueEmail({ userId, toEmail: user.email, kind: kind as EmailKind, subject: rendered.subject, body: rendered.body, dedupeKey });
  } catch { /* the in-app notification is already stored */ }
}

/** Creates a single use token (only its hash is stored) and returns the raw value for the email link. */
function createAuthToken(userId: string, kind: "password_reset" | "email_verify" | "device_verify", ttlMinutes: number) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare("UPDATE auth_tokens SET used_at=? WHERE user_id=? AND kind=? AND used_at IS NULL").run(new Date().toISOString(), userId, kind);
  db.prepare("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), userId, kind, hash, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

/** Consumes a token of the given kind and returns the user id, or null when invalid, used or expired. */
function consumeAuthToken(rawToken: string, kind: "password_reset" | "email_verify" | "device_verify"): string | null {
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
      const due = db.prepare(`SELECT id, schedule_interval_minutes AS intervalMinutes, schedule_cron AS cron FROM workflows
        WHERE schedule_enabled=1 AND status='published' AND next_run_at IS NOT NULL AND next_run_at <= ?`).all(new Date().toISOString()) as any[];
      for (const workflow of due) {
        const executionId = createExecution(workflow.id, "scheduled run", null);
        if (workflow.cron) {
          // Cron schedules are pinned to the exact minute, so the next run is recomputed from now.
          const next = nextCronRun(String(workflow.cron), new Date());
          db.prepare("UPDATE workflows SET last_run_at=?, next_run_at=? WHERE id=?").run(new Date().toISOString(), next, workflow.id);
        } else {
          scheduleNextRun(workflow.id, workflow.intervalMinutes ?? null);
        }
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

/** Independent limiters for the entry points that can be abused. */
const registerLimiter = limiterFor("register");
const passwordLimiter = limiterFor("password");
const apiLimiter = limiterFor("api");
const allowedOrigins = [config.PUBLIC_BASE_URL].filter(Boolean).map((value) => value.replace(/\/+$/, ""));

/**
 * CSRF defence. Level one always runs: a state changing request whose Origin or
 * Sec-Fetch-Site says it came from another site is refused. Level two runs when
 * CSRF_STRICT is on and additionally requires the double submit token that the
 * public cookie and the x-csrf-token header share.
 */
app.addHook("onRequest", async (request: any, reply) => {
  // The readable token cookie is only issued in token mode, so clients that do not use
  // token mode keep receiving exactly one cookie and existing clients stay compatible.
  if (config.CSRF_STRICT && !request.cookies?.coder_csrf) reply.setCookie("coder_csrf", generateCsrfToken(), csrfCookieOptions(config.NODE_ENV === "production"));
  const method = String(request.method).toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return;
  const path = String(request.url).split("?")[0];
  if (path === "/health" || path === "/ready" || path === "/metrics") return;
  const decision = checkRequestOrigin({
    origin: request.headers.origin as string | undefined,
    secFetchSite: request.headers["sec-fetch-site"] as string | undefined,
    host: request.headers.host as string | undefined,
    allowedOrigins,
  });
  if (!decision.ok) {
    return reply.code(403).send({ error: "CSRF_BLOCKED", reason: decision.reason, message: "Permintaan ditolak karena asal permintaan tidak dikenali. Muat ulang halaman lalu coba lagi." });
  }
  if (config.CSRF_STRICT) {
    const cookie = request.cookies?.coder_csrf as string | undefined;
    const header = request.headers["x-csrf-token"] as string | undefined;
    if (!cookie || !header || !constantTimeEquals(cookie, header)) {
      return reply.code(403).send({ error: "CSRF_TOKEN_REQUIRED", message: "Token keamanan tidak cocok. Muat ulang halaman lalu coba lagi." });
    }
  }
});

/** Keeps one client from flooding the API. Auth routes carry their own tighter limit. */
app.addHook("preHandler", async (request: any, reply) => {
  if (config.NODE_ENV === "test") return; // the end-to-end suites fire hundreds of requests from one address
  const path = String(request.url).split("?")[0];
  if (!path.startsWith("/api/")) return;
  const key = request.ip ?? "unknown";
  if (!apiLimiter.allow(key)) {
    return reply.code(429).send({ error: "RATE_LIMITED", retryAfter: apiLimiter.retryAfterSeconds(key), message: "Terlalu banyak permintaan dari koneksi ini. Tunggu sebentar lalu coba lagi." });
  }
});

/**
 * Wave 11A (butir 79): header keamanan dipasang SEBELUM rute pertama didaftarkan. Fastify menyusun
 * rangkaian hook sebuah rute saat rute itu didaftarkan, jadi hook yang ditambahkan sesudahnya tidak
 * akan ikut berjalan. Urutan di sini penting, bukan selera.
 */
registerCspRoutes(app);

app.get("/health", async () => ({ status: "ok", service: "coder-api", time: new Date().toISOString() }));
app.get("/ready", async (_request, reply) => {
  const result = db.prepare("SELECT 1 AS ok").get() as { ok: number };
  const engineStatus = await engine.health();
  return reply.send({ status: result.ok === 1 ? "ready" : "not_ready", database: "ok", engine: engineStatus });
});

app.get("/api/v1/auth/me", async (request, reply) => {
  const user = getSessionUser(request);
  if (!user) return reply.code(401).send({ error: "AUTH_REQUIRED" });
  // isAdmin, tier and the mail state let the shell show the right pages without extra requests.
  // Wave 8: the shell needs emailVerified, because an unverified account cannot start AI work.
  const row = db.prepare("SELECT email_verified AS emailVerified, deleted_at AS deletedAt FROM users WHERE id=?").get(user.id) as { emailVerified: number; deletedAt: string | null } | undefined;
  return { user: { ...user, isAdmin: isPlatformAdmin(user), tier: userTier(user.id), emailVerified: Boolean(row?.emailVerified), accountClosed: Boolean(row?.deletedAt) } };
});
app.post<{ Body: { email?: string; password?: string; displayName?: string; ref?: string } }>("/api/v1/auth/register", async (request, reply) => {
  if (!registerLimiter.allow(request.ip ?? "unknown")) return reply.code(429).send({ error: "RATE_LIMITED", message: "Terlalu banyak pendaftaran dari koneksi ini. Coba lagi nanti." });
  const email = request.body?.email?.trim().toLowerCase(); const password = request.body?.password ?? ""; const displayName = request.body?.displayName?.trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || !displayName) return reply.code(400).send({ error: "INVALID_REGISTRATION" });
  const now = new Date().toISOString(); const userId = randomUUID(); const workspaceId = randomUUID(); const slug = `workspace-${userId.slice(0, 8)}`;
  try {
    const passwordHash = await hashPassword(password);
    const transaction = db.transaction(() => {
      db.prepare("INSERT INTO users (id,email,display_name,password_hash,created_at,updated_at,signup_ip) VALUES (?,?,?,?,?,?,?)").run(userId,email,displayName,passwordHash,now,now,request.ip ?? null);
      db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)").run(workspaceId,`${displayName}'s Workspace`,slug,now,now);
      db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,?,?)").run(userId,workspaceId,"owner",now);
    }); transaction();
    const token = createSession(userId); setSessionCookie(reply, token, config.NODE_ENV === "production");
    const verification = await sendVerificationEmail({ id: userId, email, displayName });
    notify(workspaceId, userId, "account", "Selamat datang di COBLAI Coder", verification.sent ? "Kami sudah mengirim tautan verifikasi email." : "Verifikasi email belum aktif karena server email belum dikonfigurasi.", "/");
    // Wave 7: count the sign-up and, when the form carried a referral code, record the invitation.
    // Neither step may block registration: a bad code is reported in the response, not as an error.
    recordGrowthEvent("signup", { userId, workspaceId, props: { referred: Boolean(request.body?.ref) } });
    let referral: { accepted: boolean; error?: string } = { accepted: false };
    if (request.body?.ref) {
      const attached = attachReferral({ inviteeUserId: userId, inviteeEmail: email, inviteeIp: request.ip ?? null, code: request.body.ref });
      referral = attached.ok ? { accepted: true } : { accepted: false, error: attached.error };
      if (attached.ok) {
        recordGrowthEvent("referral_joined", { userId, workspaceId, props: { referralId: attached.referralId } });
        notify(null, attached.inviterUserId, "growth", "Ada yang memakai kode undangan Anda", `${displayName} mendaftar dengan kode ${request.body.ref.toUpperCase()}. Hadiah keluar setelah ia menyelesaikan run pertama.`, "/referrals");
      }
    }
    return reply.code(201).send({ user: { id: userId, email, displayName }, workspace: { id: workspaceId, slug }, emailVerification: verification, referral });
  } catch (error) { if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "EMAIL_EXISTS" }); throw error; }
});
app.post<{ Body: { email?: string; password?: string; code?: string } }>("/api/v1/auth/login", async (request, reply) => {
  const email = request.body?.email?.trim().toLowerCase(); const password = request.body?.password ?? ""; const code = request.body?.code?.trim();
  const key = `${request.ip}:${email ?? "unknown"}`; if (!allowLoginAttempt(key)) return reply.code(429).send({ error: "LOGIN_RATE_LIMITED" });
  // The form accepts either a full email address or the username before the @.
  type LoginRow = { id:string; email:string; displayName:string; passwordHash:string|null; mfaEnabled:number; mfaSecret:string|null; recoveryCodes:string|null; deletedAt:string|null; purgeAfter:string|null };
  const fields = "id,email,display_name AS displayName,password_hash AS passwordHash, mfa_enabled AS mfaEnabled, mfa_secret AS mfaSecret, mfa_recovery_codes AS recoveryCodes, deleted_at AS deletedAt, purge_after AS purgeAfter";
  let row = email ? db.prepare(`SELECT ${fields} FROM users WHERE email=?`).get(email) as LoginRow|undefined : undefined;
  if (!row && email && !email.includes("@")) {
    // A username is only accepted when exactly one account uses that local part.
    const matches = db.prepare(`SELECT ${fields} FROM users WHERE lower(substr(email,1,instr(email,'@')-1))=?`).all(email) as LoginRow[];
    if (matches.length === 1) row = matches[0];
  }
  if (!row?.passwordHash || !(await verifyPassword(password,row.passwordHash))) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  if (row.deletedAt) return reply.code(403).send({ error: "ACCOUNT_DELETED", message: `Akun ini sudah ditutup atas permintaan pemiliknya. Admin platform masih bisa memulihkannya${row.purgeAfter ? ` sampai ${row.purgeAfter.slice(0, 10)}` : ""}.` });
  if (row.mfaEnabled) {
    if (!code) return reply.code(401).send({ error: "MFA_REQUIRED" });
    if (!consumeSecondFactor(row, code)) return reply.code(401).send({ error: "MFA_INVALID_CODE" });
  }
  // Wave 10 (item 26): the browser that signs in is recorded, and the session is bound to it so a
  // revoked device also ends its own sessions. When the owner asked for the new-device gate, a device
  // is trusted only after the account holder confirms it through the emailed link.
  const deviceInfo = requestDeviceInfo(request);
  let device: DeviceRow | null = null;
  let newDevice = false;
  if (config.DEVICE_TRACKING) {
    const registered = registerDevice({ userId: row.id, fingerprint: deviceInfo.fingerprint, userAgent: deviceInfo.userAgent, ip: deviceInfo.ip });
    device = registered.device;
    newDevice = registered.isNew;
    if (device.blockedAt) {
      return reply.code(403).send({ error: "DEVICE_BLOCKED", message: device.blockedReason || "Perangkat ini diblokir oleh admin platform. Hubungi admin bila ini keliru." });
    }
    if (newDevice && !deviceVerifyRequired()) markDeviceVerified(row.id, device.id);
  }
  const token = createSession(row.id, deviceInfo.userAgent, device?.id ?? null); setSessionCookie(reply, token, config.NODE_ENV === "production");
  if (newDevice && device && deviceVerifyRequired()) {
    // The link is what turns an unknown browser into a known one, so it is sent after the session exists.
    const issued = createAuthToken(row.id, "device_verify", 24 * 60);
    const link = `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/perangkat?token=${issued.token}`;
    queueEventEmail(row.id, "device", "Perangkat baru masuk ke akun Anda", `Ada masuk dari ${device.label}${deviceInfo.ip ? ` (${deviceInfo.ip})` : ""}. Bila itu bukan Anda, cabut perangkat ini.`, link);
  }
  return { user: { id: row.id, email: row.email, displayName: row.displayName }, mfaEnabled: Boolean(row.mfaEnabled), device: device ? { id: device.id, label: device.label, newDevice, verified: Boolean(device.verifiedAt || device.trusted) } : null };
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
  recordGrowthEvent("email_verified", { userId });
  return { verified: true };
});

app.post("/api/v1/auth/email/verify/request", { preHandler: requireUser }, async (request: any) => {
  const row = db.prepare("SELECT id, email, display_name AS displayName, email_verified AS emailVerified FROM users WHERE id=?").get(request.user!.id) as { id: string; email: string; displayName: string; emailVerified: number } | undefined;
  if (!row) return { sent: false, reason: "USER_NOT_FOUND" };
  if (row.emailVerified) return { sent: false, reason: "ALREADY_VERIFIED" };
  return sendVerificationEmail({ id: row.id, email: row.email, displayName: row.displayName });
});

app.post<{ Body: { email?: string } }>("/api/v1/auth/password/forgot", async (request, reply) => {
  if (!passwordLimiter.allow(request.ip ?? "unknown")) return reply.code(429).send({ error: "RATE_LIMITED", message: "Terlalu banyak permintaan reset kata sandi. Coba lagi nanti." });
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
  if (!passwordLimiter.allow(request.ip ?? "unknown")) return reply.code(429).send({ error: "RATE_LIMITED", message: "Terlalu banyak percobaan reset kata sandi. Coba lagi nanti." });
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
    u.deleted_at AS deletedAt, u.purge_after AS purgeAfter,
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

app.get<{ Params: { workspaceId: string } }>("/api/v1/workspaces/:workspaceId/limits", { preHandler: requireUser }, async (request: any, reply) => {
  const role = membershipRole(request.params.workspaceId, request.user!.id);
  if (!role) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  // Any member may read the limits; the form needs the current numbers, not just the ability to overwrite them.
  const row = db.prepare("SELECT daily_cost_limit_micros AS dailyCostLimitMicros, monthly_cost_limit_micros AS monthlyCostLimitMicros, runs_per_hour_limit AS runsPerHourLimit FROM workspaces WHERE id=?").get(request.params.workspaceId) as any;
  return {
    dailyCostLimitMicros: row?.dailyCostLimitMicros ?? null,
    monthlyCostLimitMicros: row?.monthlyCostLimitMicros ?? null,
    runsPerHourLimit: row?.runsPerHourLimit ?? null,
    effective: {
      dailyCostLimitMicros: row?.dailyCostLimitMicros ?? config.DEFAULT_DAILY_COST_LIMIT_MICROS,
      monthlyCostLimitMicros: row?.monthlyCostLimitMicros ?? config.DEFAULT_MONTHLY_COST_LIMIT_MICROS,
      runsPerHourLimit: row?.runsPerHourLimit ?? config.DEFAULT_RUNS_PER_HOUR_LIMIT,
    },
  };
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
    recordGrowthEvent("project_created", { userId: request.user!.id, workspaceId, props: { projectId: id } });
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
  recordGrowthEvent("conversation_created", { userId: request.user!.id, props: { conversationId: id, projectId: request.params.projectId } });
  return reply.code(201).send({ conversation: { id, projectId: request.params.projectId, title, createdAt: now, updatedAt: now } });
});
/** Downloads one chat attachment. Access follows the conversation, not the file id. */
app.get<{ Params: { attachmentId: string } }>("/api/v1/attachments/:attachmentId", { preHandler: requireUser }, async (request: any, reply) => {
  const row = db.prepare(`SELECT a.name, a.mime_type AS mimeType, a.storage_path AS storagePath FROM message_attachments a
    JOIN messages ms ON ms.id=a.message_id JOIN conversations c ON c.id=ms.conversation_id
    JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE a.id=? AND m.user_id=?`).get(request.params.attachmentId, request.user!.id) as { name: string; mimeType: string; storagePath: string } | undefined;
  if (!row) return reply.code(404).send({ error: "ATTACHMENT_NOT_FOUND" });
  try {
    const data = await readFile(row.storagePath);
    return reply.header("content-type", row.mimeType || "application/octet-stream")
      .header("content-disposition", `inline; filename="${row.name.replace(/[^\w.\- ]+/g, "_")}"`).send(data);
  } catch {
    return reply.code(404).send({ error: "ATTACHMENT_NOT_FOUND", message: "Berkas lampiran sudah tidak ada di server." });
  }
});

/**
 * Branches a conversation: copies every message up to one point into a new conversation in the same
 * project, together with the attachment files, and can start a fresh answer from that point.
 */
app.post<{ Params: { conversationId: string }; Body: { fromMessageId?: string; title?: string; rerun?: boolean; model?: string } }>("/api/v1/conversations/:conversationId/branch", { preHandler: requireUser }, async (request: any, reply) => {
  const source = db.prepare(`SELECT c.id, c.project_id AS projectId, c.title, p.workspace_id AS workspaceId,
      (SELECT m.role FROM memberships m WHERE m.workspace_id=p.workspace_id AND m.user_id=?) AS role
    FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=?`).get(request.user!.id, request.params.conversationId) as { id: string; projectId: string; title: string; workspaceId: string; role: string | null } | undefined;
  if (!source?.role) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  if (source.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const rows = db.prepare("SELECT id, role, content, run_id AS runId, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(source.id) as { id: string; role: string; content: string; runId: string | null; createdAt: string }[];
  const cut = request.body?.fromMessageId?.trim();
  if (cut && !rows.some((row) => row.id === cut)) return reply.code(400).send({ error: "MESSAGE_NOT_FOUND" });
  const copied = cut ? rows.slice(0, rows.findIndex((row) => row.id === cut) + 1) : rows;
  if (!copied.length) return reply.code(400).send({ error: "EMPTY_BRANCH", message: "Percakapan ini belum punya pesan untuk dicabangkan." });
  const model = request.body?.model?.trim() || undefined;
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });

  const newId = randomUUID(); const now = new Date().toISOString();
  const title = String(request.body?.title ?? "").trim().slice(0, 120) || `${source.title} (cabang)`;
  const attachments = attachmentsForConversation(source.id);
  const copiedFiles: { path: string; name: string; mimeType: string; sizeBytes: number }[] = [];
  try {
    for (const message of copied) {
      for (const item of attachments.get(message.id) ?? []) {
        const row = db.prepare("SELECT storage_path AS storagePath FROM message_attachments WHERE id=?").get(item.id) as { storagePath: string } | undefined;
        if (!row) continue;
        const target = join(ATTACHMENT_DIR, `${randomUUID()}${extname(item.name).toLowerCase()}`);
        await copyFile(row.storagePath, target);
        copiedFiles.push({ path: target, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes });
      }
    }
  } catch {
    return reply.code(500).send({ error: "BRANCH_FAILED", message: "Cabang percakapan gagal dibuat. Coba lagi." });
  }
  db.transaction(() => {
    db.prepare("INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(newId, source.projectId, title, now, now);
    let fileIndex = 0;
    for (const message of copied) {
      const messageId = randomUUID();
      db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(messageId, newId, message.role, message.content, null, message.createdAt);
      for (const item of attachments.get(message.id) ?? []) {
        const file = copiedFiles[fileIndex++];
        if (!file) continue;
        db.prepare("INSERT INTO message_attachments (id,message_id,name,mime_type,size_bytes,storage_path,extracted_chars,created_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(randomUUID(), messageId, file.name, file.mimeType, file.sizeBytes, file.path, 0, now);
      }
    }
  })();
  recordAudit(source.workspaceId, request.user!.id, "conversation.branched", { conversationId: newId, from: source.id, messages: copied.length });

  // Optional: answer the last copied user message again in the branch.
  const lastUser = [...copied].reverse().find((row) => row.role === "user");
  let runId: string | null = null;
  if (request.body?.rerun && lastUser) {
    const quotaBlock = quotaGuard(request.user!.id, "");
    if (quotaBlock) return reply.code(201).send({ conversation: { id: newId, projectId: source.projectId, title, createdAt: now }, run: null, warning: quotaBlock.error });
    runId = randomUUID();
    db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)").run(runId, source.projectId, "queued", lastUser.content, model ?? config.PRIME_AGENT_MODEL, now);
    queueRunJob({ runId, projectId: source.projectId, prompt: lastUser.content, conversationId: newId, model, userId: request.user!.id });
  void executeRun(runId, source.projectId, lastUser.content, newId, undefined, model, request.user!.id);
  }
  return reply.code(201).send({ conversation: { id: newId, projectId: source.projectId, title, createdAt: now }, run: runId ? { id: runId, status: "queued" } : null });
});

/** Deletes many artifacts in one call; ids the caller may not touch are reported, not removed. */
app.post<{ Body: { ids?: string[] } }>("/api/v1/artifacts/bulk-delete", { preHandler: requireUser }, async (request: any, reply) => {
  const rawIds: unknown[] = Array.isArray(request.body?.ids) ? request.body.ids : [];
  const ids = [...new Set(rawIds.map((value: unknown) => String(value ?? "").trim()).filter((value: string) => Boolean(value)))].slice(0, 200) as string[];
  if (!ids.length) return reply.code(400).send({ error: "IDS_REQUIRED", message: "Pilih minimal satu artefak yang mau dihapus." });
  let deleted = 0; const skipped: string[] = [];
  for (const id of ids) {
    const artifact = db.prepare(`SELECT a.id, a.name, a.storage_path AS storagePath, p.workspace_id AS workspaceId FROM artifacts a
      JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE a.id=? AND m.user_id=?`)
      .get(id, request.user!.id) as { id: string; name: string; storagePath: string; workspaceId: string } | undefined;
    if (!artifact) { skipped.push(id); continue; }
    const role = membershipRole(artifact.workspaceId, request.user!.id);
    if (!canManageWorkspace(artifact.workspaceId, request.user!.id) && role !== "member") { skipped.push(id); continue; }
    recordAudit(artifact.workspaceId, request.user!.id, "artifact.deleted", { artifactId: artifact.id, name: artifact.name, bulk: true });
    db.prepare("DELETE FROM artifacts WHERE id=?").run(artifact.id);
    await unlink(artifact.storagePath).catch(() => undefined);
    deleted += 1;
  }
  return { deleted, skipped };
});

app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/messages", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  const messages = db.prepare("SELECT id, conversation_id AS conversationId, role, content, run_id AS runId, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(request.params.conversationId) as { id: string }[];
  const attachments = attachmentsForConversation(request.params.conversationId);
  return { messages: messages.map((message) => ({ ...message, attachments: attachments.get(message.id) ?? [] })) };
});

type KnowledgeContext = { text: string; hits: { documentId: string; title: string; chunkIndex: number }[] };

/** Wraps a user prompt with retrieved project knowledge, so answers can cite the project documents. */
function withKnowledge(prompt: string, knowledge?: KnowledgeContext) {
  if (!knowledge?.text) return prompt;
  return `Gunakan konteks pengetahuan proyek berikut bila relevan. Rujuk sumbernya dengan penanda [1], [2].\n\n${knowledge.text}\n\n---\n\nPertanyaan pengguna:\n${prompt}`;
}

/** Builds the knowledge block for a prompt. Both the route and the queue worker use this. */
function knowledgeFor(projectId: string, prompt: string): KnowledgeContext | undefined {
  const retrieved = buildKnowledgeContext(projectId, prompt);
  if (!retrieved.hits.length) return undefined;
  return { text: retrieved.text, hits: retrieved.hits.map((hit) => ({ documentId: hit.documentId, title: hit.title, chunkIndex: hit.chunkIndex })) };
}

/**
 * Wave 5: records a run in the durable queue right after it is stored. The queue entry is the safety
 * net: the route still dispatches the engine call straight away, and the entry only acts when that
 * dispatch never happened (for example the container stopped right after the HTTP reply).
 * `maxAttempts` is 1 on purpose: repeating a run that already reached the engine would spend tokens twice.
 */
function queueRunJob(input: {
  runId: string; projectId: string; prompt: string; conversationId?: string; model?: string; userId: string;
  thinking?: string; personaId?: string | null; autonomous?: boolean;
}) {
  return enqueueJob({
    kind: "run.execute",
    payload: {
      runId: input.runId, projectId: input.projectId, prompt: input.prompt, conversationId: input.conversationId,
      model: input.model, userId: input.userId, thinking: input.thinking, personaId: input.personaId ?? null,
      autonomous: Boolean(input.autonomous),
    },
    maxAttempts: 1,
    runAfter: new Date(Date.now() + 10_000),
    dedupeKey: `run.execute:${input.runId}`,
  });
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

function recordRunUsage(runId: string, projectId: string, prompt: string, answer: string, usage: any, userId?: string) {
  const reported = usage && typeof usage === "object" ? usage : null;
  const hasTokens = typeof reported?.inputTokens === "number" || typeof reported?.outputTokens === "number";
  const inputTokens = hasTokens ? Math.round(reported.inputTokens ?? 0) : Math.ceil(prompt.length / 4);
  const outputTokens = hasTokens ? Math.round(reported.outputTokens ?? 0) : Math.ceil(answer.length / 4);
  const cacheReadTokens = hasTokens ? Math.round(reported.cacheReadTokens ?? 0) : 0;
  const cacheWriteTokens = hasTokens ? Math.round(reported.cacheWriteTokens ?? 0) : 0;
  const totalTokens = typeof reported?.totalTokens === "number" ? Math.round(reported.totalTokens) : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  // Wave 11A (butir 57): biaya memakai model yang benar-benar dipakai; baris run adalah acuannya,
  // sehingga run yang berpindah ke model cadangan tetap ditagih dengan harga model nyata itu.
  const runModel = (db.prepare("SELECT model FROM runs WHERE id=?").get(runId) as { model?: string } | undefined)?.model ?? null;
  const model = typeof reported?.model === "string" ? reported.model : (runModel ?? config.PRIME_AGENT_MODEL ?? null);
  // Cost is only reported when the engine sent real tokens; the price table resolves the rest.
  // The engine number and the catalogue are upstream cost (cost of goods); the billed amount is
  // that cost times the owner markup, stored in its own column (Wave 9, item 19).
  const quote = quoteCosts(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
  const costMicros = !hasTokens ? null : (typeof reported?.costMicros === "number" ? Math.round(reported.costMicros) : quote.baseMicros);
  const sellCostMicros = sellForBaseMicros(costMicros, quote.markup);
  const provider = model ? providerForModel(model) : config.PRIME_AGENT_PROVIDER ?? null;
  db.prepare("INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,sell_cost_micros,estimated,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), runId, projectId, model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costMicros, sellCostMicros, hasTokens ? 0 : 1, reported ? JSON.stringify(reported.raw ?? null).slice(0, 4000) : null, new Date().toISOString());
  // Token over the tier limit is paid from purchased credit. Workflow steps fall back to the workspace owner.
  const payerId = userId ?? (db.prepare("SELECT m.user_id AS userId FROM memberships m JOIN projects p ON p.workspace_id=m.workspace_id WHERE p.id=? AND m.role='owner' LIMIT 1").get(projectId) as { userId: string } | undefined)?.userId;
  if (payerId) chargeQuota(payerId, totalTokens);
}

type RunEngineOptions = { text?: string; thinking?: string; personaId?: string | null; autonomous?: boolean };

async function executeRun(runId: string, projectId: string, prompt: string, conversationId?: string, knowledge?: KnowledgeContext, model?: string, userId?: string, engineOptions?: RunEngineOptions) {
  const startedAt = new Date().toISOString();
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(startedAt, runId);
  recordGrowthEvent("run_started", { userId: userId ?? null, props: { runId, projectId, model: model ?? null } });
  let text = "";
  try {
    if (knowledge?.hits?.length) publishRunEvent(runId, "knowledge", { hits: knowledge.hits });
    // Wave 3: the conversation holds its engine session, which compaction can rotate. The prompt keeps
    // the earlier turns because the engine session does; after compaction the stored summary carries them.
    const settings = userId ? agentSettings(userId) : null;
    const thinking = isThinkingLevel(engineOptions?.thinking) ? String(engineOptions?.thinking)
      : isThinkingLevel(settings?.thinking_level) ? String(settings?.thinking_level) : undefined;
    const personaId = engineOptions?.personaId ?? conversationPersonaId(conversationId);
    // Wave 11A (butir 80): sisipan konteks memakai pagar dan urutan prioritas, bukan ditumpuk bebas.
    const context = userId ? buildSystemBlocks(userId, personaId, conversationId ?? null) : null;
    const appendSystem = context?.blocks ?? [];
    const tools = parseToolsAllow(settings?.tools_allow);
    const autonomous = engineOptions?.autonomous ?? Boolean(settings?.autonomous_default);
    db.prepare("UPDATE runs SET thinking_level=?, persona_id=?, autonomous=?, prompt_chars=?, append_system_chars=? WHERE id=?")
      .run(thinking ?? null, personaId ?? null, autonomous ? 1 : 0, prompt.length, appendSystem.join("").length, runId);
    // Wave 11B (butir 59): mode bayangan hanya MENCATAT perkiraan ukuran konteks. Pencatatannya
    // gagal-aman dan tidak menyentuh `appendSystem`, jadi jawaban tetap identik saat mode mati
    // maupun nyala — yang bertambah hanya catatannya.
    if (userId && shadowModeActive()) recordShadowMeasurements({ userId, runId, promptChars: prompt.length, contextChars: appendSystem.join("").length });
    if (userId && context && context.dropped.length) {
      // Pemotongan dilaporkan apa adanya: berapa karakter dan bagian mana yang tidak dikirim.
      recordAudit(null, userId, "context_budget.trimmed", { runId, budgetChars: context.budgetChars, totalChars: context.totalChars, keptChars: context.keptChars, dropped: context.dropped });
    }
    if (userId && context?.skillIds.length) touchUserSkills(userId, context.skillIds);
    if (userId && context?.learningIds.length) touchLearnings(userId, context.learningIds);
    let usage: any = null;
    // Wave 11A (butir 44): rahasia milik pengguna ini disewa HANYA untuk run ini, diberikan ke proses
    // anak lewat env, dan dilepas di `finally` sehingga run yang gagal pun tidak meninggalkan sewa.
    const secretEnv = userId ? await acquireRunSecretEnv(userId, runId) : {};
    const secretEnvKeys = Object.keys(secretEnv);
    // Wave 11A (butir 57): model cadangan dipakai hanya saat mesin gagal sementara.
    const fallbackModels = userId ? fallbackModelsFor(userId) : [];
    const primaryModel = model || config.PRIME_AGENT_MODEL || "default";
    let outcome;
    try {
      outcome = await runWithModelFallback({
        primary: primaryModel,
        fallbacks: fallbackModels,
        maxSwitches: Math.min(config.ENGINE_FALLBACK_MAX_SWITCHES, MAX_FALLBACK_SWITCHES),
        consume: async (attempt) => {
          let attemptText = "";
          let attemptUsage: unknown = null;
          for await (const event of engine.run({
            runId,
            sessionId: conversationId ? engineSessionFor(conversationId) : runId,
            prompt: withKnowledge(prompt, knowledge),
            model: attempt,
            provider: providerForModel(attempt),
            thinking,
            appendSystem,
            tools,
            autonomous: autonomous ? { maxTurns: settings?.autonomous_max_turns ?? 6, maxTokens: settings?.autonomous_max_tokens ?? 40000 } : undefined,
            env: secretEnvKeys.length ? secretEnv : undefined,
          })) {
            if (event.type !== "completed") publishRunEvent(runId, event.type, event.data);
            if (event.type === "text") attemptText += typeof event.data === "string" ? event.data : JSON.stringify(event.data);
            if (event.type === "completed") attemptUsage = (event.data as { usage?: unknown })?.usage ?? null;
            if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "ENGINE_FAILED"));
          }
          return { text: attemptText, usage: attemptUsage };
        },
        onFallback: (dari, ke, alasan) => {
          // Jejak perpindahan model: kolom `runs` + satu event run + catatan audit.
          db.prepare("UPDATE runs SET fallback_from=COALESCE(fallback_from,?), fallback_count=fallback_count+1 WHERE id=?").run(dari, runId);
          publishRunEvent(runId, "model_fallback", { dari, ke, alasan: alasan.slice(0, 200) });
          recordAudit(null, userId ?? null, "run.model_fallback", { runId, dari, ke });
        },
      });
    } finally {
      releaseRunSecrets(runId);
    }
    text = outcome.text;
    usage = outcome.usage;
    const usedModel = outcome.model;
    // Model yang BENAR-BENAR dipakai dicatat, supaya biaya tidak dihitung dengan model utama.
    if (usedModel !== primaryModel) db.prepare("UPDATE runs SET model=? WHERE id=?").run(usedModel, runId);
    recordRunUsage(runId, projectId, prompt, text, usage);
    db.prepare("UPDATE runs SET status='completed', result=?, finished_at=? WHERE id=?").run(text || null, new Date().toISOString(), runId);
    // Wave 10 (item 24): the run is finished, so its token reservation is returned to the day's budget.
    releaseRunTokens(runId);
    publishRunEvent(runId, "completed", { result: text });
    // Wave 6: tell registered webhooks. The delivery is queued, so a slow receiver never delays the run.
    emitProjectEvent(projectId, "run.completed", { runId, conversationId: conversationId ?? null, model: usedModel, answerChars: text.length });
    // Wave 7: growth accounting and the referral reward. The reward is paid here and only here, so an
    // invitation only pays out after the invited account really finished a run.
    recordGrowthEvent("run_completed", { userId: userId ?? null, props: { runId, projectId, model: usedModel, answerChars: text.length } });
    if (userId) {
      const qualified = qualifyReferralForRun(userId);
      if (qualified.status === "rewarded") {
        recordGrowthEvent("referral_rewarded", { userId, props: { referralId: qualified.referralId, inviterUserId: qualified.inviterUserId } });
        notify(null, qualified.inviterUserId ?? null, "growth", "Hadiah undangan cair",
          `Undangan Anda menyelesaikan run pertama, jadi ${qualified.inviterTokens ?? 0} token masuk ke saldo Anda.`, "/referrals");
        notify(null, userId, "growth", "Bonus undangan cair",
          `Anda memakai kode undangan, jadi ${qualified.inviteeTokens ?? 0} token masuk ke saldo Anda.`, "/paket");
      }
    }
    if (conversationId) db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(),conversationId,"assistant",text || "",runId,new Date().toISOString());
  } catch (error) {
    const message = error instanceof Error ? error.message : "RUN_FAILED";
    db.prepare("UPDATE runs SET status='failed', error_code=?, finished_at=? WHERE id=?").run(message, new Date().toISOString(), runId);
    releaseRunTokens(runId);
    publishRunEvent(runId, "failed", { message });
    emitProjectEvent(projectId, "run.failed", { runId, conversationId: conversationId ?? null, model: model ?? null, error: message.slice(0, 300) });
    recordGrowthEvent("run_failed", { userId: userId ?? null, props: { runId, projectId, error: message.slice(0, 120) } });
    // A failed engine run is worth a notification, because it usually needs a human.
    const owner = db.prepare("SELECT workspace_id AS workspaceId FROM projects WHERE id=?").get(projectId) as { workspaceId: string } | undefined;
    notify(owner?.workspaceId ?? null, null, "run", "Run gagal", `Run ${runId.slice(0, 8)} gagal: ${message.slice(0, 200)}`, "/");
  }
}

/** Chat attachments: bytes on disk, metadata next to the message, text of readable files in the prompt. */
const ATTACHMENT_DIR = resolve(config.DATA_DIR, "attachments");
const ATTACHMENT_MAX_FILES = 5;
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_MAX_ENCODED = 7_000_000;
const ATTACHMENT_PROMPT_CHARS = 20_000;
const ATTACHMENT_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".log": "text/plain", ".sql": "text/plain", ".yml": "text/yaml", ".yaml": "text/yaml",
};
const ATTACHMENT_TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log", ".sql", ".yml", ".yaml", ".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".html", ".htm", ".css", ".xml", ".env", ".ini", ".toml"]);

/** Guesses the content type from the file name; the browser value wins when it is present. */
function attachmentMime(name: string, given?: unknown): string {
  const fromClient = typeof given === "string" ? given.trim() : "";
  return fromClient || ATTACHMENT_EXT[extname(name).toLowerCase()] || "application/octet-stream";
}

/** Only readable text is pasted into the prompt; images and PDFs stay as downloads. */
function attachmentIsText(name: string, mime: string): boolean {
  return mime.startsWith("text/") || ATTACHMENT_TEXT_EXT.has(extname(name).toLowerCase());
}

/** One attachment as the API returns it. */
type AttachmentRow = { id: string; messageId: string; name: string; mimeType: string; sizeBytes: number };

/** Loads the attachments of every message in one conversation, keyed by message id. */
function attachmentsForConversation(conversationId: string): Map<string, AttachmentRow[]> {
  const rows = db.prepare(`SELECT id, message_id AS messageId, name, mime_type AS mimeType, size_bytes AS sizeBytes
    FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?) ORDER BY created_at ASC`)
    .all(conversationId) as AttachmentRow[];
  const grouped = new Map<string, AttachmentRow[]>();
  for (const row of rows) grouped.set(row.messageId, [...(grouped.get(row.messageId) ?? []), row]);
  return grouped;
}

app.post<{ Params: { conversationId: string }; Body: { content?: string; model?: string; thinking?: string; autonomous?: boolean; personaId?: string; attachments?: { name?: string; mimeType?: string; contentBase64?: string }[] } }>("/api/v1/conversations/:conversationId/messages", { preHandler: requireUser, bodyLimit: 40 * 1024 * 1024 }, async (request: any, reply) => {
  const model = request.body?.model?.trim() || undefined;
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
  const thinking = request.body?.thinking?.trim() || undefined;
  if (thinking && !isThinkingLevel(thinking)) return reply.code(400).send({ error: "INVALID_THINKING_LEVEL", allowed: THINKING_LEVELS });
  // Wave 11B (butir 83 ③): persona yang diminta satu sesi belum tentu persona percakapan. Keputusan
  // dan jejak auditnya diambil sesudah percakapan diketahui (lihat `resolveSessionPersona` di bawah).
  const personaDiminta = request.body?.personaId?.trim() || undefined;
  const autonomous = Boolean(request.body?.autonomous);

  // Attachments arrive as base64. They are validated and written to disk before the transaction,
  // because the prompt needs the text of the readable ones straight away.
  const incoming = Array.isArray(request.body?.attachments) ? request.body.attachments : [];
  if (incoming.length > ATTACHMENT_MAX_FILES) return reply.code(400).send({ error: "TOO_MANY_ATTACHMENTS", message: `Maksimal ${ATTACHMENT_MAX_FILES} lampiran untuk satu pesan.` });
  const prepared: { id: string; name: string; mimeType: string; buffer: Buffer; text: string }[] = [];
  for (const item of incoming) {
    const name = String(item?.name ?? "").trim().slice(0, 200);
    const encoded = typeof item?.contentBase64 === "string" ? item.contentBase64.replace(/^data:[^;]+;base64,/, "") : "";
    if (!name || !encoded) return reply.code(400).send({ error: "ATTACHMENT_INVALID", message: "Lampiran harus punya nama berkas dan isi." });
    if (encoded.length > ATTACHMENT_MAX_ENCODED) return reply.code(400).send({ error: "ATTACHMENT_TOO_LARGE", message: "Satu lampiran maksimal 5 MB." });
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length) return reply.code(400).send({ error: "ATTACHMENT_INVALID", message: "Isi lampiran tidak bisa dibaca." });
    if (buffer.length > ATTACHMENT_MAX_BYTES) return reply.code(400).send({ error: "ATTACHMENT_TOO_LARGE", message: "Satu lampiran maksimal 5 MB." });
    const mimeType = attachmentMime(name, item?.mimeType);
    // Reading a file can fail (binary content, damaged pdf): the attachment is still accepted.
    let text = "";
    if (attachmentIsText(name, mimeType)) {
      try { text = String((await extractText(buffer, name)).text ?? "").trim().slice(0, ATTACHMENT_PROMPT_CHARS); } catch { text = ""; }
    }
    prepared.push({ id: randomUUID(), name, mimeType, buffer, text });
  }

  const content = String(request.body?.content ?? "").trim() || (prepared.length ? "(lihat lampiran)" : "");
  if (!content || content.length > 100_000) return reply.code(400).send({ error: "INVALID_MESSAGE" });
  const conversation = db.prepare("SELECT c.id, c.project_id AS projectId, m.role AS role FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as { id: string; projectId: string; role: string } | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  if (conversation.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  // Wave 11B (butir 83 ③): persona sesi menang atas persona percakapan, tetapi penggantiannya dicatat
  // di jejak audit. Bila tidak ada penggantian, hasilnya sama seperti sebelumnya.
  const personaChoice = resolveSessionPersona({
    userId: request.user!.id, conversationId: conversation.id, sessionPersonaId: personaDiminta ?? null, sumber: "pesan",
  });
  const personaId = personaChoice.personaId ?? undefined;
  // Token quota guard: the tier limits how many tokens a customer may spend.
  const quotaBlock = quotaGuard(request.user!.id, "");
  if (quotaBlock) {
    notify(null, request.user!.id, "quota", quotaBlock.error === "DAILY_TOKEN_QUOTA_EXCEEDED" ? "Kuota harian habis" : "Kuota bulanan habis", String((quotaBlock.detail as any)?.message ?? "Kuota token paket Anda habis."), "/");
    return reply.code(quotaBlock.status).send({ error: quotaBlock.error, ...(quotaBlock.detail ?? {}) });
  }

  // Wave 11A (butir 45): filter anti prompt-hijack diperiksa SEBELUM run dibuat, sehingga pesan yang
  // menyerang tidak pernah sampai ke mesin, tidak masuk riwayat, dan tidak menambah biaya.
  if (config.PROMPT_GUARD_ENABLED) {
    const hijack = scanPromptHijack(content);
    if (hijack.blocked) {
      recordAudit(null, request.user!.id, "prompt_hijack_blocked", { conversationId: conversation.id, pola: hijack.pattern, kategori: hijack.category, kutipan: hijack.snippet, panjangPesan: content.length });
      return reply.code(400).send({ error: "PROMPT_BLOCKED", message: hijackMessage(hijack.pattern), pola: hijack.pattern, kategori: hijack.category });
    }
  }
  // Wave 11A (butir 46): aturan larangan milik akun. Aksi yang dilarang TIDAK dijalankan, tetapi
  // percobaannya dicatat supaya pemiliknya melihatnya di halaman Safety.
  const pelanggaran = guardrailViolations(request.user!.id, content);
  if (pelanggaran.length) {
    for (const hit of pelanggaran) {
      recordSafetyEvent({ userId: request.user!.id, ruleId: hit.rule.id, pattern: hit.pattern, snippet: content });
      recordAudit(null, request.user!.id, "safety_violation", { conversationId: conversation.id, ruleId: hit.rule.id, judul: hit.rule.title, pola: hit.pattern, kutipan: content.replace(/\s+/g, " ").slice(0, 200) });
    }
    return reply.code(400).send({
      error: "GUARDRAIL_BLOCKED",
      message: `Permintaan ini dilarang aturan "${pelanggaran[0].rule.title}". Aksi tidak dijalankan.`,
      aturan: pelanggaran.map((hit) => ({ id: hit.rule.id, title: hit.rule.title, pola: hit.pattern })),
    });
  }

  const runId = randomUUID(); const messageId = randomUUID(); const now = new Date().toISOString();
  const storedPaths: string[] = [];
  try {
    if (prepared.length) await mkdir(ATTACHMENT_DIR, { recursive: true });
    for (const file of prepared) {
      const path = join(ATTACHMENT_DIR, `${file.id}${extname(file.name).toLowerCase()}`);
      await writeFile(path, file.buffer);
      storedPaths.push(path);
    }
  } catch {
    await Promise.all(storedPaths.map((path) => unlink(path).catch(() => undefined)));
    return reply.code(500).send({ error: "ATTACHMENT_SAVE_FAILED", message: "Lampiran gagal disimpan. Coba lagi." });
  }

  // The engine only sees text: readable attachments are appended as a labelled block.
  const attachmentBlock = prepared.filter((file) => file.text).map((file) => `Lampiran ${file.name}:
${file.text}`).join("\n\n");
  const prompt = attachmentBlock ? `${content}\n\n---\n${attachmentBlock}` : content;
  const knowledge = knowledgeFor(conversation.projectId, content);
  const transaction = db.transaction(() => {
    db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)").run(runId, conversation.projectId, "queued", prompt, model ?? config.PRIME_AGENT_MODEL, now);
    db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(messageId, conversation.id, "user", content, runId, now);
    for (const file of prepared) {
      db.prepare("INSERT INTO message_attachments (id,message_id,name,mime_type,size_bytes,storage_path,extracted_chars,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(file.id, messageId, file.name, file.mimeType, file.buffer.length, join(ATTACHMENT_DIR, `${file.id}${extname(file.name).toLowerCase()}`), file.text.length, now);
    }
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversation.id);
  }); transaction();
  // Wave 5: the same run is also an entry in the durable queue. If the process dies before or during
  // the engine call, the next process picks the entry up and either dispatches the run or reports it.
  queueRunJob({ runId, projectId: conversation.projectId, prompt, conversationId: conversation.id, model, userId: request.user!.id, thinking, personaId, autonomous });
  // Auto-compaction runs before the engine call, so a long conversation sends a summary instead of
  // the whole history. The run waits for it, while the HTTP reply returns straight away.
  const settings = agentSettings(request.user!.id);
  const messagesNow = messageCount(conversation.id);
  const willCompact = Boolean(settings.auto_compact) && messagesNow >= Number(settings.compact_after_messages);
  void (async () => {
    if (willCompact) await compactConversation(conversation!.id, request.user!.id).catch(() => null);
    await executeRun(runId, conversation!.projectId, prompt, conversation!.id, knowledge, model, request.user!.id, { thinking, personaId, autonomous });
  })();
  return reply.code(202).send({ message: { id: messageId, conversationId: conversation.id, role: "user", content, runId, createdAt: now, attachments: prepared.map((file) => ({ id: file.id, messageId, name: file.name, mimeType: file.mimeType, sizeBytes: file.buffer.length })) }, run: { id: runId, status: "queued", thinkingLevel: thinking ?? settings.thinking_level, autonomous, willCompact, messages: messagesNow } });
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
           COALESCE(u.cost_micros,0) AS costMicros, COALESCE(u.sell_cost_micros,0) AS billedMicros, COALESCE(u.estimated,0) AS estimated
    FROM runs r LEFT JOIN run_usage u ON u.run_id = r.id
    WHERE r.project_id = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.run_id = r.id AND m.conversation_id = ?))
    ORDER BY r.created_at DESC LIMIT ?`).all(request.params.projectId, conversationId, conversationId, limit);
  return { runs: rows.map((row: any) => ({ ...row, costUsd: Number(((row.costMicros ?? 0) / 1_000_000).toFixed(6)), billedUsd: Number(((row.billedMicros ?? 0) / 1_000_000).toFixed(6)) })) };
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

/**
 * Wave 8: a verified email is required before AI work starts, and a closed account cannot start
 * anything at all. The message is written as a full Indonesian sentence, because the dashboard
 * shows it to the user unchanged.
 */
function verificationRequired(): boolean {
  if (config.VERIFY_EMAIL_REQUIRED === "on") return true;
  if (config.VERIFY_EMAIL_REQUIRED === "off") return false;
  return emailEnabled(); // "auto": only demand proof when verification mail can actually be sent
}

function accountGate(userId: string): { status: number; error: string; message: string } | null {
  const row = db.prepare("SELECT email_verified AS emailVerified, deleted_at AS deletedAt, purge_after AS purgeAfter FROM users WHERE id=?").get(userId) as { emailVerified: number; deletedAt: string | null; purgeAfter: string | null } | undefined;
  if (!row) return { status: 403, error: "ACCOUNT_NOT_FOUND", message: "Akun ini tidak ditemukan. Silakan masuk ulang." };
  if (row.deletedAt) return { status: 403, error: "ACCOUNT_DELETED", message: `Akun ini sudah ditutup atas permintaan pemiliknya${row.purgeAfter ? ` dan datanya dihapus permanen setelah ${row.purgeAfter.slice(0, 10)}` : ""}. Hubungi admin platform bila ingin dipulihkan.` };
  if (verificationRequired() && Number(row.emailVerified) !== 1) return { status: 403, error: "EMAIL_NOT_VERIFIED", message: "Verifikasi email dulu sebelum memakai AI. Kami sudah mengirim tautan verifikasi ke email Anda; buka tautan itu, lalu coba lagi." };
  return null;
}

app.post<{ Params: { projectId: string }; Body: { prompt?: string; model?: string } }>("/api/v1/projects/:projectId/runs", { preHandler: requireUser }, async (request: any, reply) => {
  const prompt = request.body?.prompt?.trim();
  const model = request.body?.model?.trim() || undefined;
  if (!prompt || prompt.length > 100_000) return reply.code(400).send({ error: "INVALID_PROMPT" });
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
  const project = db.prepare("SELECT p.id, p.workspace_id AS workspaceId, m.role AS role FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id) as { id: string; workspaceId: string; role: string } | undefined;
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (project.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const gate = usageGate(request);
  if (gate) return reply.code(gate.status).send({ error: gate.error, message: gate.message });
  // Cost and speed guards: a workspace can cap how much engine work it starts.
  const guard = guardWorkspaceUsage(project.workspaceId);
  if (guard) {
    notify(project.workspaceId, null, "cost", guard.error === "COST_LIMIT_EXCEEDED" ? "Batas biaya tercapai" : "Batas kecepatan run tercapai",
      guard.error === "COST_LIMIT_EXCEEDED"
        ? `Batas pemakaian tercapai (${JSON.stringify(guard.detail)}). Naikkan batas di Pengaturan workspace atau tunggu periode berikutnya.`
        : `Terlalu banyak run pada periode ini (${JSON.stringify(guard.detail)}).`, "/");
    return reply.code(guard.status).send({ error: guard.error, ...(guard.detail ?? {}) });
  }
  const quotaBlock = quotaGuard(request.user!.id, project.workspaceId);
  if (quotaBlock) return reply.code(quotaBlock.status).send({ error: quotaBlock.error, ...(quotaBlock.detail ?? {}) });
  // Wave 11A (butir 45/46): jalur run langsung (otonom) memakai pengaman yang sama dengan chat.
  if (config.PROMPT_GUARD_ENABLED) {
    const hijack = scanPromptHijack(prompt);
    if (hijack.blocked) {
      recordAudit(project.workspaceId, request.user!.id, "prompt_hijack_blocked", { projectId: project.id, pola: hijack.pattern, kategori: hijack.category, kutipan: hijack.snippet, panjangPesan: prompt.length });
      return reply.code(400).send({ error: "PROMPT_BLOCKED", message: hijackMessage(hijack.pattern), pola: hijack.pattern, kategori: hijack.category });
    }
  }
  const pelanggaran = guardrailViolations(request.user!.id, prompt);
  if (pelanggaran.length) {
    for (const hit of pelanggaran) {
      recordSafetyEvent({ userId: request.user!.id, ruleId: hit.rule.id, pattern: hit.pattern, snippet: prompt });
      recordAudit(project.workspaceId, request.user!.id, "safety_violation", { projectId: project.id, ruleId: hit.rule.id, judul: hit.rule.title, pola: hit.pattern, kutipan: prompt.replace(/\s+/g, " ").slice(0, 200) });
    }
    return reply.code(400).send({
      error: "GUARDRAIL_BLOCKED",
      message: `Permintaan ini dilarang aturan "${pelanggaran[0].rule.title}". Aksi tidak dijalankan.`,
      aturan: pelanggaran.map((hit) => ({ id: hit.rule.id, title: hit.rule.title, pola: hit.pattern })),
    });
  }
  const id = randomUUID(); const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)").run(id, project.id, "queued", prompt, model ?? config.PRIME_AGENT_MODEL, createdAt);
  queueRunJob({ runId: id, projectId: project.id, prompt, model, userId: request.user!.id });
  void executeRun(id, project.id, prompt, undefined, undefined, model, request.user!.id);
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
  const run = db.prepare("SELECT r.id, r.project_id AS projectId, r.status, r.prompt, r.result, r.model, r.error_code AS errorCode, r.fallback_from AS fallbackFrom, r.fallback_count AS fallbackCount, r.started_at AS startedAt, r.finished_at AS finishedAt, r.created_at AS createdAt FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE r.id=? AND m.user_id=?").get(request.params.runId, request.user!.id);
  if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND" });
  // Wave 11A (butir 46): panel kecil di Riwayat run butuh jejak pelanggaran aturan untuk run ini.
  // Catatan jujur: pelanggaran dicegat SEBELUM run dibuat (server.ts:1168/1308/3658 tidak mengirim
  // runId), jadi daftar ini hampir selalu kosong; jejak lengkap per akun ada di GET /api/v1/safety.
  const violations = db.prepare(`SELECT e.id, e.rule_id AS ruleId, r.title AS judul, r.kind, e.pattern, e.snippet, e.created_at AS createdAt
    FROM safety_events e LEFT JOIN guardrail_rules r ON r.id=e.rule_id
    WHERE e.run_id=? AND e.user_id=? ORDER BY e.created_at ASC`).all(request.params.runId, request.user!.id);
  return { ...run, violations };
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
  return db.prepare("SELECT id, project_id AS projectId, name, description, steps_json AS stepsJson, status, schedule_enabled AS scheduleEnabled, schedule_interval_minutes AS intervalMinutes, schedule_cron AS cron, next_run_at AS nextRunAt, last_run_at AS lastRunAt, created_at AS createdAt, updated_at AS updatedAt FROM workflows WHERE project_id=? ORDER BY updated_at DESC").all(request.params.projectId).map((w: any) => ({ ...w, steps: JSON.parse(w.stepsJson), stepsJson: undefined, scheduleEnabled: Boolean(w.scheduleEnabled), scheduleDescription: w.cron ? describeCron(String(w.cron)) : null }));
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
  const gate = usageGate(request);
  if (gate) return reply.code(gate.status).send({ error: gate.error, message: gate.message });
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

app.post<{ Params: { workflowId: string }; Body: { intervalMinutes?: number; cron?: string | null; enabled?: boolean } }>("/api/v1/workflows/:workflowId/schedule", { preHandler: requireUser }, async (request: any, reply) => {
  const access = workflowAccess(request.params.workflowId, request.user!.id);
  if (!access) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  if (access.role === "viewer") return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  const interval = request.body?.intervalMinutes === null || request.body?.intervalMinutes === undefined ? null : Number(request.body.intervalMinutes);
  const cron = request.body?.cron === null || request.body?.cron === undefined ? null : String(request.body.cron).trim();
  const enabled = Boolean(request.body?.enabled);
  const now = new Date();
  if (enabled && cron) {
    // A cron expression wins over the interval, because it is the more specific instruction.
    const check = validateCronExpression(cron);
    if (!check.ok) return reply.code(400).send({ error: "INVALID_CRON", detail: check.error });
    const next = nextCronRun(cron, now);
    if (!next) return reply.code(400).send({ error: "INVALID_CRON", detail: "Jadwal tidak menghasilkan waktu berikutnya." });
    db.prepare("UPDATE workflows SET schedule_enabled=1, schedule_interval_minutes=NULL, schedule_cron=?, next_run_at=?, updated_at=? WHERE id=?").run(cron, next, now.toISOString(), access.id);
    recordAudit(access.workspaceId, request.user!.id, "workflow.schedule.updated", { workflowId: access.id, enabled: true, cron });
    return { id: access.id, scheduleEnabled: true, intervalMinutes: null, cron, nextRunAt: next, description: describeCron(cron) };
  }
  if (enabled && (!interval || Number.isNaN(interval) || interval < 1 || interval > 20_160)) return reply.code(400).send({ error: "INVALID_SCHEDULE" });
  const next = enabled && interval ? new Date(now.getTime() + interval * 60_000).toISOString() : null;
  db.prepare("UPDATE workflows SET schedule_enabled=?, schedule_interval_minutes=?, schedule_cron=NULL, next_run_at=?, updated_at=? WHERE id=?").run(enabled ? 1 : 0, interval, next, now.toISOString(), access.id);
  recordAudit(access.workspaceId, request.user!.id, "workflow.schedule.updated", { workflowId: access.id, enabled, intervalMinutes: interval });
  return { id: access.id, scheduleEnabled: enabled, intervalMinutes: interval, cron: null, nextRunAt: next };
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
  // Attachment files live on disk, so their paths are read before the rows disappear.
  const berkasLampiran = db.prepare(`SELECT a.storage_path AS storagePath FROM message_attachments a
    JOIN messages ms ON ms.id=a.message_id WHERE ms.conversation_id=?`).all(conversation.id) as { storagePath: string }[];
  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE conversation_id=?").run(conversation.id);
    db.prepare("DELETE FROM conversations WHERE id=?").run(conversation.id);
  })();
  for (const berkas of berkasLampiran) await unlink(berkas.storagePath).catch(() => undefined);
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
  const totals = db.prepare("SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens, COALESCE(SUM(total_tokens),0) AS totalTokens, COALESCE(SUM(cost_micros),0) AS costMicros, COALESCE(SUM(sell_cost_micros),0) AS billedMicros, COALESCE(SUM(estimated),0) AS estimatedRuns, COUNT(*) - COALESCE(SUM(estimated),0) AS measuredRuns, SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS unpricedRuns FROM run_usage WHERE project_id=? AND created_at>=?").get(request.params.projectId, since) as any;
  const byModel = db.prepare("SELECT COALESCE(model,'unknown') AS model, COALESCE(provider,'unknown') AS provider, COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cost_micros),0) AS costMicros, COALESCE(SUM(sell_cost_micros),0) AS billedMicros FROM run_usage WHERE project_id=? AND created_at>=? GROUP BY COALESCE(model,'unknown'), COALESCE(provider,'unknown') ORDER BY runs DESC").all(request.params.projectId, since) as any[];
  const daily = db.prepare("SELECT substr(created_at,1,10) AS day, COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cost_micros),0) AS costMicros, COALESCE(SUM(sell_cost_micros),0) AS billedMicros FROM run_usage WHERE project_id=? AND created_at>=? GROUP BY substr(created_at,1,10) ORDER BY day DESC LIMIT 60").all(request.params.projectId, since) as any[];
  // Keeps sub-cent costs visible: eight decimal places of a US dollar.
  const toUsd = (micros: number | null | undefined) => Number(((micros ?? 0) / 1e6).toFixed(8));
  const markup = pricingSettings().markup;
  return {
    days, since, markup,
    totals: { ...totals, costUsd: toUsd(totals.costMicros), billedUsd: toUsd(totals.billedMicros) },
    byModel: byModel.map((row) => ({ ...row, costUsd: toUsd(row.costMicros), billedUsd: toUsd(row.billedMicros) })),
    daily: daily.map((row) => ({ ...row, costUsd: toUsd(row.costMicros), billedUsd: toUsd(row.billedMicros) })),
    note: "Tokens come from the engine; runs without engine tokens are estimated from text length (estimatedRuns). costMicros is what the platform pays upstream and stays null when the model price is unknown (unpricedRuns); billedMicros is that cost times the owner markup.",
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
  // Wave 11A (butir 48): belum ada revisi saat artefak dibuat. Revisi pertama ditulis oleh PUT,
  // dan isi lama disalin lebih dulu, jadi tidak ada versi yang hilang.
  return reply.code(201).send({ id, projectId: request.params.projectId, runId: request.body.runId ?? null, name, mimeType, sizeBytes: content.length, sha256, createdAt: now, revision: 0 });
});

// ---------------------------------------------------------------- komersial: paket, pesanan, kredit token

/** Email address of a user id, or an empty string when the user is gone. */
function userEmail(userId: string | null | undefined): string {
  if (!userId) return "";
  const row = db.prepare("SELECT email FROM users WHERE id=?").get(userId) as { email: string } | undefined;
  return row?.email ?? "";
}

/** Sends an in-app notification to every platform administrator. */
function notifyAdmins(kind: string, title: string, body: string, link?: string) {
  const allowed = config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const rows = db.prepare("SELECT id, email, is_admin AS isAdmin FROM users").all() as { id: string; email: string; isAdmin: number }[];
  for (const row of rows) {
    if (row.isAdmin === 1 || allowed.includes(row.email.toLowerCase())) notify(null, row.id, kind, title, body, link);
  }
}

/** Public branding so the shell, the manifest and the login page can read the same name. */
app.get("/api/v1/branding", async () => branding());

app.get("/api/v1/billing/plans", { preHandler: requireUser }, async () => ({ plans: listPlans(true), currency: "IDR" }));

/** Everything the billing page needs in one read: tier, quota, orders, banks and payment setup. */
app.get("/api/v1/billing/me", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  const tier = userTier(userId);
  return {
    tier,
    plan: getPlan(tier),
    subscription: activeSubscription(userId),
    quota: quotaState(userId),
    orders: listOrders({ userId, limit: 20 }),
    banks: listBankAccounts(true),
    creditHistory: creditHistory(userId, 20),
    payment: paymentConfig(),
    currency: "IDR",
  };
});

app.get("/api/v1/billing/orders", { preHandler: requireUser }, async (request: any) => ({ orders: listOrders({ userId: request.user!.id, limit: 50 }) }));

app.post<{ Body: { code?: string; amountIdr?: number } }>("/api/v1/billing/coupons/validate", { preHandler: requireUser }, async (request: any, reply) => {
  const amountIdr = Math.max(0, Math.round(Number(request.body?.amountIdr ?? 0)));
  const result = validateCoupon(String(request.body?.code ?? ""), amountIdr);
  if (!result.ok) return reply.code(400).send({ error: result.error, message: "Kupon tidak bisa dipakai. Periksa kembali kodenya." });
  return { code: result.coupon.code, discountIdr: result.discountIdr, percent: result.coupon.percent };
});

app.post<{ Body: { planCode?: string; months?: number; couponCode?: string; note?: string } }>("/api/v1/billing/orders", { preHandler: requireUser }, async (request: any, reply) => {
  const result = createOrder({
    userId: request.user!.id,
    planCode: String(request.body?.planCode ?? "").trim(),
    months: Number(request.body?.months ?? 1),
    couponCode: request.body?.couponCode ?? null,
    note: request.body?.note,
  });
  if (!result.ok) {
    const status = result.error === "PLAN_NOT_FOUND" ? 404 : 400;
    return reply.code(status).send({ error: result.error, message: result.error === "PLAN_NOT_FOUND" ? "Paket tidak ditemukan." : "Kupon tidak bisa dipakai." });
  }
  recordAudit(null, request.user!.id, "billing.order_created", { orderId: result.order.id, planCode: result.order.planCode, totalIdr: result.order.totalIdr, method: result.order.method });
  recordGrowthEvent("order_created", { userId: request.user!.id, props: { orderId: result.order.id, planCode: result.order.planCode, totalIdr: result.order.totalIdr, status: result.order.status } });
  if (result.order.status === "pending") {
    notifyAdmins("billing", "Pesanan baru menunggu pembayaran", `${request.user!.email} memesan paket ${result.order.planCode} senilai Rp${result.order.totalIdr.toLocaleString("id-ID")}.`, "/");
  }
  return { order: result.order };
});

/**
 * Accepts a transfer proof (image or pdf, at most 5 MB). The file stays on the server;
 * orders.proof_artifact_id holds its path there, which is why the reply only returns the id.
 */
app.post<{ Params: { orderId: string }; Body: { filename?: string; contentBase64?: string } }>("/api/v1/billing/orders/:orderId/proof", { preHandler: requireUser, bodyLimit: 12 * 1024 * 1024 }, async (request: any, reply) => {
  const order = getOrder(request.params.orderId);
  if (!order || order.userId !== request.user!.id) return reply.code(404).send({ error: "ORDER_NOT_FOUND", message: "Pesanan tidak ditemukan." });
  if (order.status !== "pending") return reply.code(409).send({ error: "ORDER_NOT_PENDING", message: "Pesanan ini sudah tidak menunggu pembayaran." });
  const filename = String(request.body?.filename ?? "").trim();
  const encoded = String(request.body?.contentBase64 ?? "");
  const ext = extname(filename).toLowerCase();
  const allowedExt = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"];
  if (!filename || filename.length > 120 || !allowedExt.includes(ext) || filename.includes("/") || filename.includes("\\") || !encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return reply.code(400).send({ error: "PROOF_INVALID", message: "Berkas bukti harus gambar (png/jpg/webp/gif) atau pdf." });
  }
  if (encoded.length > 7_000_000) return reply.code(413).send({ error: "PROOF_TOO_LARGE", message: "Ukuran berkas maksimal 5 MB." });
  const content = Buffer.from(encoded, "base64");
  if (content.length > 5 * 1024 * 1024) return reply.code(413).send({ error: "PROOF_TOO_LARGE", message: "Ukuran berkas maksimal 5 MB." });
  const dir = join(config.DATA_DIR, "proofs");
  await mkdir(dir, { recursive: true });
  const proofId = randomUUID();
  const storagePath = join(dir, `${proofId}${ext}`);
  await writeFile(storagePath, content, { flag: "wx" });
  attachOrderProof(order.id, storagePath);
  recordPayment({ orderId: order.id, userId: request.user!.id, provider: "manual_transfer", providerRef: filename, amountIdr: order.totalIdr, status: "proof_uploaded", raw: { filename, bytes: content.length } });
  recordAudit(null, request.user!.id, "billing.proof_uploaded", { orderId: order.id, filename, bytes: content.length });
  notifyAdmins("billing", "Bukti transfer masuk", `Pesanan dari ${userEmail(request.user!.id)} menunggu pemeriksaan admin.`, "/");
  return { order: getOrder(order.id)!, artifactId: proofId };
});

// ---------------------------------------------------------------- admin: pesanan & pendapatan

app.get<{ Querystring: { status?: string } }>("/api/v1/admin/orders", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh membuka daftar pesanan." });
  const status = request.query?.status && ["pending", "paid", "rejected", "cancelled"].includes(request.query.status) ? request.query.status : undefined;
  const orders = listOrders({ status, limit: 200 }).map((order) => {
    // Wave 11C butir 74: admin harus bisa melihat nominal transfer yang harus dicocokkan dengan mutasi bank.
    const nominal = tampilanNominal(order.id);
    return {
      ...order, userEmail: userEmail(order.userId),
      uniqueAmountIdr: nominal?.uniqueAmountIdr ?? null,
      nominalBayarIdr: nominal?.nominalBayarIdr ?? order.totalIdr,
    };
  });
  return { orders };
});

/** Streams an uploaded transfer proof back to an admin. */
app.get<{ Params: { orderId: string } }>("/api/v1/admin/orders/:orderId/proof", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat bukti transfer." });
  const order = getOrder(request.params.orderId);
  if (!order?.proofArtifactId) return reply.code(404).send({ error: "PROOF_NOT_FOUND" });
  const root = join(config.DATA_DIR, "proofs");
  const target = normalize(order.proofArtifactId);
  if (!target.startsWith(root)) return reply.code(404).send({ error: "PROOF_NOT_FOUND" });
  try {
    const data = await readFile(target);
    return reply.type(extname(target) === ".pdf" ? "application/pdf" : `image/${extname(target).replace(".", "")}`).send(data);
  } catch { return reply.code(404).send({ error: "PROOF_NOT_FOUND" }); }
});

app.post<{ Params: { orderId: string }; Body: { decision?: string; note?: string } }>("/api/v1/admin/orders/:orderId/decision", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh memutuskan pesanan." });
  const decision = String(request.body?.decision ?? "");
  if (decision !== "paid" && decision !== "rejected") return reply.code(400).send({ error: "INVALID_DECISION", message: "Keputusan harus paid atau rejected." });
  const existing = getOrder(request.params.orderId);
  if (!existing) return reply.code(404).send({ error: "ORDER_NOT_FOUND", message: "Pesanan tidak ditemukan." });
  if (decision === "rejected" && existing.status === "paid") return reply.code(409).send({ error: "ORDER_ALREADY_PAID", message: "Pesanan ini sudah lunas." });
  if (decision === "paid") {
    // Idempotent: paying twice returns the same order and never creates a second subscription.
    const result = markOrderPaid(existing.id, request.user!.id, String(request.body?.note ?? ""));
    const fresh = result.ok ? result.order : existing;
    if (fresh.status === "paid" && !existing.decidedAt) {
      recordAudit(null, request.user!.id, "billing.order_paid", { orderId: fresh.id, totalIdr: fresh.totalIdr, planCode: fresh.planCode });
      notify(null, fresh.userId, "billing", "Pembayaran diterima", `Paket ${fresh.planCode} sudah aktif. Terima kasih.`, "/");
      recordGrowthEvent("order_paid", { userId: fresh.userId, props: { orderId: fresh.id, planCode: fresh.planCode, totalIdr: fresh.totalIdr } });
    }
    return { order: fresh };
  }
  const rejected = rejectOrder(existing.id, request.user!.id, String(request.body?.note ?? "")) ?? existing;
  recordAudit(null, request.user!.id, "billing.order_rejected", { orderId: rejected.id });
  notify(null, rejected.userId, "billing", "Pesanan ditolak", "Bukti transfer belum bisa diverifikasi. Hubungi admin bila transfernya sudah benar.", "/");
  return { order: rejected };
});

app.get<{ Querystring: { days?: string } }>("/api/v1/admin/revenue", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat pendapatan." });
  return revenueSummary(Number(request.query?.days ?? 30));
});

app.get("/api/v1/admin/coupons", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat kupon." });
  return { coupons: listCoupons() };
});

app.post<{ Body: { code?: string; percent?: number; amountIdr?: number; maxUses?: number; expiresAt?: string | null } }>("/api/v1/admin/coupons", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh membuat kupon." });
  const code = String(request.body?.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) return reply.code(400).send({ error: "INVALID_COUPON", message: "Kode kupon 3-24 karakter: huruf, angka, tanda hubung." });
  const percent = Math.max(0, Math.min(100, Math.round(Number(request.body?.percent ?? 0))));
  const amountIdr = Math.max(0, Math.round(Number(request.body?.amountIdr ?? 0)));
  if (percent <= 0 && amountIdr <= 0) return reply.code(400).send({ error: "INVALID_COUPON", message: "Isi potongan persen atau potongan rupiah." });
  if (db.prepare("SELECT 1 FROM coupons WHERE code=?").get(code)) return reply.code(409).send({ error: "COUPON_EXISTS", message: "Kode kupon itu sudah ada." });
  const coupon = createCoupon({ code, percent, amountIdr, maxUses: Number(request.body?.maxUses ?? 0), expiresAt: request.body?.expiresAt ? String(request.body.expiresAt) : null });
  recordAudit(null, request.user!.id, "billing.coupon_created", { code, percent, amountIdr });
  return { coupon };
});

app.patch<{ Params: { code: string }; Body: { active?: boolean } }>("/api/v1/admin/coupons/:code", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah kupon." });
  const changed = setCouponActive(request.params.code, request.body?.active !== false);
  if (!changed) return reply.code(404).send({ error: "COUPON_NOT_FOUND", message: "Kupon tidak ditemukan." });
  const coupon = listCoupons().find((row) => row.code === request.params.code.toUpperCase());
  return { coupon };
});

app.get("/api/v1/admin/banks", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat rekening." });
  return { banks: listBankAccounts(false) };
});

app.post<{ Body: { bankName?: string; accountNumber?: string; accountHolder?: string; note?: string; sortOrder?: number } }>("/api/v1/admin/banks", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menambah rekening." });
  const bankName = String(request.body?.bankName ?? "").trim();
  const accountNumber = String(request.body?.accountNumber ?? "").trim();
  const accountHolder = String(request.body?.accountHolder ?? "").trim();
  if (!bankName || !accountNumber || !accountHolder) return reply.code(400).send({ error: "INVALID_BANK", message: "Nama bank, nomor rekening dan nama pemilik wajib diisi." });
  const bank = createBankAccount({ bankName, accountNumber, accountHolder, note: request.body?.note, sortOrder: Number(request.body?.sortOrder ?? 0) });
  recordAudit(null, request.user!.id, "billing.bank_created", { bankName });
  return { bank };
});

app.delete<{ Params: { bankId: string } }>("/api/v1/admin/banks/:bankId", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menghapus rekening." });
  if (!deleteBankAccount(request.params.bankId)) return reply.code(404).send({ error: "BANK_NOT_FOUND", message: "Rekening tidak ditemukan." });
  recordAudit(null, request.user!.id, "billing.bank_deleted", { bankId: request.params.bankId });
  return { ok: true };
});

app.get("/api/v1/admin/payment-config", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat konfigurasi pembayaran." });
  return paymentConfig();
});

app.put<{ Body: { gateway?: string; xenditEnabled?: boolean; midtransEnabled?: boolean; instructions?: string } }>("/api/v1/admin/payment-config", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah konfigurasi pembayaran." });
  const gateway = String(request.body?.gateway ?? "manual");
  if (!["manual", "xendit", "midtrans"].includes(gateway)) return reply.code(400).send({ error: "INVALID_GATEWAY", message: "Gateway harus manual, xendit atau midtrans." });
  const xenditEnabled = request.body?.xenditEnabled === true;
  const midtransEnabled = request.body?.midtransEnabled === true;
  if ((gateway === "xendit" || xenditEnabled) && !config.XENDIT_SECRET_KEY) {
    return reply.code(400).send({ error: "GATEWAY_NOT_CONFIGURED", message: "Kunci API Xendit belum dipasang di server. Isi XENDIT_SECRET_KEY dulu." });
  }
  if ((gateway === "midtrans" || midtransEnabled) && !config.MIDTRANS_SERVER_KEY) {
    return reply.code(400).send({ error: "GATEWAY_NOT_CONFIGURED", message: "Kunci API Midtrans belum dipasang di server. Isi MIDTRANS_SERVER_KEY dulu." });
  }
  const saved = savePaymentConfig({ gateway: gateway as "manual" | "xendit" | "midtrans", xenditEnabled, midtransEnabled, instructions: request.body?.instructions });
  recordAudit(null, request.user!.id, "billing.payment_config_saved", { gateway, xenditEnabled, midtransEnabled });
  return saved;
});

app.get("/api/v1/admin/plans", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat paket." });
  return { plans: listPlans(false) };
});

app.patch<{ Params: { code: string }; Body: Record<string, unknown> }>("/api/v1/admin/plans/:code", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah paket." });
  const body = request.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const key of ["name", "description", "tier"] as const) if (typeof body[key] === "string") patch[key] = body[key];
  for (const key of ["priceIdr", "periodDays", "dailyTokenLimit", "monthlyTokenLimit", "bonusTokens", "sortOrder"] as const) {
    if (body[key] !== undefined && Number.isFinite(Number(body[key]))) patch[key] = Math.max(0, Math.round(Number(body[key])));
  }
  if (typeof body.active === "boolean") patch.active = body.active;
  if (Array.isArray(body.features)) patch.features = (body.features as unknown[]).map((item) => String(item)).slice(0, 20);
  const plan = updatePlan(request.params.code, patch as any);
  if (!plan) return reply.code(404).send({ error: "PLAN_NOT_FOUND", message: "Paket tidak ditemukan." });
  recordAudit(null, request.user!.id, "billing.plan_updated", { code: plan.code, patch });
  return { plan };
});

app.put<{ Body: { rate?: number } }>("/api/v1/admin/currency", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah kurs." });
  const rate = Number(request.body?.rate);
  if (!Number.isFinite(rate) || rate <= 0) return reply.code(400).send({ error: "INVALID_RATE", message: "Kurs harus angka lebih besar dari nol." });
  const saved = setUsdToIdrRate(rate);
  recordAudit(null, request.user!.id, "billing.currency_updated", { usdIdrRate: saved });
  return { usdIdrRate: saved };
});

app.put<{ Body: { appName?: string; tagline?: string; primaryColor?: string; logoUrl?: string; faviconUrl?: string; supportEmail?: string } }>("/api/v1/admin/branding", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah branding." });
  const body = request.body ?? {};
  const appName = String(body.appName ?? "").trim();
  if (appName.length < 2 || appName.length > 60) return reply.code(400).send({ error: "INVALID_BRANDING", message: "Nama aplikasi 2-60 karakter." });
  const primaryColor = String(body.primaryColor ?? "").trim();
  if (primaryColor && !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) return reply.code(400).send({ error: "INVALID_BRANDING", message: "Warna utama harus format #rrggbb." });
  const url = (value: unknown) => String(value ?? "").trim().slice(0, 300);
  const saved = saveBranding({
    appName, tagline: String(body.tagline ?? "").trim().slice(0, 120), primaryColor,
    logoUrl: url(body.logoUrl), faviconUrl: url(body.faviconUrl), supportEmail: url(body.supportEmail),
  });
  recordAudit(null, request.user!.id, "platform.branding_updated", { appName: saved.appName });
  return saved;
});

// ---------------------------------------------------------------- admin: pengguna

app.get("/api/v1/admin/user-list", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat daftar pengguna." });
  const rows = db.prepare(`SELECT u.id, u.email, u.display_name AS displayName, COALESCE(u.tier,'free') AS tier,
    u.is_admin AS isAdmin, u.email_verified AS emailVerified, u.created_at AS createdAt,
    u.deleted_at AS deletedAt, u.purge_after AS purgeAfter,
    (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS workspaces
    FROM users u ORDER BY u.created_at DESC`).all() as any[];
  return { users: rows.map((row) => ({ ...row, isAdmin: row.isAdmin === 1, emailVerified: row.emailVerified === 1 })) };
});

/** Admin creates an account: user, personal workspace and quota row in one step. */
app.post<{ Body: { email?: string; displayName?: string; password?: string; tier?: string } }>("/api/v1/admin/users", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menambah pengguna." });
  const email = String(request.body?.email ?? "").trim().toLowerCase();
  const displayName = String(request.body?.displayName ?? "").trim();
  const password = String(request.body?.password ?? "");
  const tier = String(request.body?.tier ?? "free").trim() || "free";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return reply.code(400).send({ error: "INVALID_EMAIL", message: "Format email tidak valid." });
  if (displayName.length < 2 || displayName.length > 80) return reply.code(400).send({ error: "INVALID_DISPLAY_NAME", message: "Nama tampilan 2-80 karakter." });
  if (password.length < 8 || password.length > 200) return reply.code(400).send({ error: "INVALID_PASSWORD", message: "Kata sandi minimal 8 karakter." });
  if (!getPlan(tier)) return reply.code(400).send({ error: "PLAN_NOT_FOUND", message: "Paket tidak ditemukan." });
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) return reply.code(409).send({ error: "EMAIL_TAKEN", message: "Email itu sudah dipakai." });
  const userId = randomUUID();
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const shortId = userId.slice(0, 8);
  const passwordHash = await hashPassword(password);
  db.transaction(() => {
    db.prepare("INSERT INTO users (id,email,display_name,password_hash,created_at,updated_at,tier,email_verified,is_admin) VALUES (?,?,?,?,?,?,?,0,0)")
      .run(userId, email, displayName, passwordHash, now, now, tier);
    db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)").run(workspaceId, `${displayName} Workspace`, `${slugifyText(displayName)}-${shortId}`, now, now);
    db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES (?,?,?,?)").run(userId, workspaceId, "owner", now);
    db.prepare("INSERT INTO token_quotas (user_id,tier,day_key,day_tokens,month_key,month_tokens,updated_at) VALUES (?,?,?,0,?,0,?)")
      .run(userId, tier, now.slice(0, 10), now.slice(0, 7), now);
  })();
  recordAudit(null, request.user!.id, "admin.user_created", { userId, email, tier });
  const row = db.prepare(`SELECT u.id, u.email, u.display_name AS displayName, COALESCE(u.tier,'free') AS tier, u.is_admin AS isAdmin, u.email_verified AS emailVerified, u.created_at AS createdAt,
    (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS workspaces FROM users u WHERE u.id=?`).get(userId) as any;
  return { user: { ...row, isAdmin: false, emailVerified: false } };
});

app.patch<{ Params: { userId: string }; Body: { displayName?: string; tier?: string; isAdmin?: boolean; emailVerified?: boolean; email?: string } }>("/api/v1/admin/users/:userId", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah pengguna." });
  const target = db.prepare("SELECT id, email, display_name AS displayName, is_admin AS isAdmin FROM users WHERE id=?").get(request.params.userId) as { id: string; email: string; displayName: string; isAdmin: number } | undefined;
  if (!target) return reply.code(404).send({ error: "USER_NOT_FOUND", message: "Pengguna tidak ditemukan." });
  const body = request.body ?? {};
  if (body.isAdmin === false) {
    const admins = db.prepare("SELECT id, email, is_admin AS isAdmin FROM users WHERE is_admin=1").all() as { id: string; email: string; isAdmin: number }[];
    const allowed = config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    const effective = new Set([...admins.map((row) => row.id), ...(db.prepare("SELECT id, email FROM users").all() as { id: string; email: string }[]).filter((row) => allowed.includes(row.email.toLowerCase())).map((row) => row.id)]);
    effective.delete(target.id);
    if (effective.size === 0) return reply.code(400).send({ error: "LAST_ADMIN", message: "Admin terakhir tidak boleh diturunkan menjadi pengguna biasa." });
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof body.displayName === "string") {
    const displayName = body.displayName.trim();
    if (displayName.length < 2 || displayName.length > 80) return reply.code(400).send({ error: "INVALID_DISPLAY_NAME", message: "Nama tampilan 2-80 karakter." });
    sets.push("display_name=?"); values.push(displayName);
  }
  if (typeof body.tier === "string") {
    if (!getPlan(body.tier)) return reply.code(400).send({ error: "PLAN_NOT_FOUND", message: "Paket tidak ditemukan." });
    sets.push("tier=?"); values.push(body.tier);
  }
  // Wave 8: an admin can move an account to a new address. The new address counts as unverified
  // until its owner proves it, so the check is reset instead of carried over.
  if (typeof body.email === "string") {
    const email = body.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "INVALID_EMAIL", message: "Alamat email tidak sah." });
    const taken = db.prepare("SELECT id FROM users WHERE lower(email)=? AND id<>?").get(email, target.id) as { id: string } | undefined;
    if (taken) return reply.code(409).send({ error: "EMAIL_EXISTS", message: "Alamat email itu sudah dipakai akun lain." });
    sets.push("email=?"); values.push(email);
    sets.push("email_verified=?"); values.push(0);
  }
  if (typeof body.isAdmin === "boolean") { sets.push("is_admin=?"); values.push(body.isAdmin ? 1 : 0); }
  if (typeof body.emailVerified === "boolean") { sets.push("email_verified=?"); values.push(body.emailVerified ? 1 : 0); }
  if (!sets.length) return reply.code(400).send({ error: "NOTHING_TO_UPDATE", message: "Tidak ada perubahan yang dikirim." });
  sets.push("updated_at=?"); values.push(new Date().toISOString());
  values.push(target.id);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).run(...(values as any[]));
  recordAudit(null, request.user!.id, "admin.user_updated", { userId: target.id, fields: sets.join(",") });
  const row = db.prepare(`SELECT u.id, u.email, u.display_name AS displayName, COALESCE(u.tier,'free') AS tier, u.is_admin AS isAdmin, u.email_verified AS emailVerified, u.created_at AS createdAt,
    (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS workspaces FROM users u WHERE u.id=?`).get(target.id) as any;
  return { user: { ...row, isAdmin: row.isAdmin === 1, emailVerified: row.emailVerified === 1 } };
});

/**
 * Builds a short password that is easy to read out loud, because an admin may have to dictate it:
 * three common words, a dash, and four digits. It is long enough for the scrypt hasher.
 */
function readablePassword(): string {
  const words = ["aman", "cerah", "cepat", "damai", "hijau", "jernih", "kuat", "maju", "nyaman", "pintar", "rapi", "tenang"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${pick()}${pick()}-${digits}`;
}

/**
 * Wave 8: an admin sets a password for any account, which is what Bapak asked for. When the
 * request has no password, a short readable one is generated and returned exactly once, so it can
 * be dictated over the phone. Every existing session is dropped at the same time.
 */
app.post<{ Params: { userId: string }; Body: { password?: string } }>("/api/v1/admin/users/:userId/password", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah kata sandi." });
  const target = db.prepare("SELECT id, email FROM users WHERE id=?").get(request.params.userId) as { id: string; email: string } | undefined;
  if (!target) return reply.code(404).send({ error: "USER_NOT_FOUND", message: "Pengguna tidak ditemukan." });
  const asked = typeof request.body?.password === "string" ? request.body.password.trim() : "";
  if (asked && asked.length < 8) return reply.code(400).send({ error: "WEAK_PASSWORD", message: "Kata sandi minimal 8 karakter." });
  const password = asked || readablePassword();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password); // hashed before the transaction: the hasher is async
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?").run(passwordHash, now, target.id);
    db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(target.id);
    db.prepare("DELETE FROM auth_tokens WHERE user_id=?").run(target.id);
  })();
  recordAudit(null, request.user!.id, "admin.user_password_set", { userId: target.id, generated: !asked });
  notify(null, target.id, "security", "Kata sandi diubah admin", "Admin platform menetapkan kata sandi baru untuk akun Anda. Semua sesi lama sudah diputus.", "/settings");
  return { ok: true, userId: target.id, email: target.email, password, generated: !asked };
});

/** Wave 8: brings back an account that was closed inside its recovery window. */
app.post<{ Params: { userId: string } }>("/api/v1/admin/users/:userId/restore", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh memulihkan akun." });
  const target = db.prepare("SELECT id, email, deleted_at AS deletedAt, purge_after AS purgeAfter FROM users WHERE id=?").get(request.params.userId) as { id: string; email: string; deletedAt: string | null; purgeAfter: string | null } | undefined;
  if (!target) return reply.code(404).send({ error: "USER_NOT_FOUND", message: "Pengguna tidak ditemukan." });
  if (!target.deletedAt) return reply.code(409).send({ error: "ACCOUNT_NOT_CLOSED", message: "Akun ini tidak sedang ditutup." });
  const now = new Date();
  if (target.purgeAfter && target.purgeAfter <= now.toISOString()) return reply.code(409).send({ error: "RECOVERY_WINDOW_PASSED", message: "Masa pemulihan 90 hari sudah lewat, data akun ini sudah dihapus permanen." });
  db.prepare("UPDATE users SET deleted_at=NULL, purge_after=NULL, updated_at=? WHERE id=?").run(now.toISOString(), target.id);
  recordAudit(null, request.user!.id, "admin.user_restored", { userId: target.id });
  return { ok: true, userId: target.id, email: target.email };
});

app.post<{ Params: { userId: string } }>("/api/v1/admin/users/:userId/reset-quota", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mereset kuota." });
  const exists = db.prepare("SELECT 1 FROM users WHERE id=?").get(request.params.userId);
  if (!exists) return reply.code(404).send({ error: "USER_NOT_FOUND", message: "Pengguna tidak ditemukan." });
  const quota = resetQuota(request.params.userId);
  recordAudit(null, request.user!.id, "admin.quota_reset", { userId: request.params.userId });
  notify(null, request.params.userId, "billing", "Kuota direset", "Admin sudah mereset penghitung kuota Anda. Anda bisa memakai platform lagi.", "/");
  return { ok: true, quota };
});

app.post<{ Params: { userId: string }; Body: { tokens?: number; note?: string } }>("/api/v1/admin/users/:userId/credit", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh memberi kredit token." });
  const exists = db.prepare("SELECT 1 FROM users WHERE id=?").get(request.params.userId);
  if (!exists) return reply.code(404).send({ error: "USER_NOT_FOUND", message: "Pengguna tidak ditemukan." });
  const tokens = Math.round(Number(request.body?.tokens ?? 0));
  if (!Number.isFinite(tokens) || tokens === 0 || Math.abs(tokens) > 5_000_000_000) return reply.code(400).send({ error: "INVALID_TOKENS", message: "Jumlah token harus angka bulat dan tidak nol." });
  grantCredit(request.params.userId, tokens, "admin_grant", request.user!.id, String(request.body?.note ?? "").slice(0, 200));
  recordAudit(null, request.user!.id, "admin.credit_granted", { userId: request.params.userId, tokens });
  notify(null, request.params.userId, "billing", "Kredit token ditambahkan", `Admin menambahkan ${tokens.toLocaleString("id-ID")} token ke akun Anda.`, "/");
  const quota = quotaState(request.params.userId);
  return { creditTokens: quota.creditTokens, quota };
});

// ---------------------------------------------------------------- gerbang pembayaran (webhook)

/** Xendit invoice callback. Disabled unless the key and the callback token are both present. */
app.post("/api/v1/webhooks/xendit", async (request: any, reply) => {
  const cfg = paymentConfig();
  if (!cfg.xenditEnabled || !config.XENDIT_SECRET_KEY || !config.XENDIT_CALLBACK_TOKEN) return reply.code(404).send({ error: "GATEWAY_DISABLED" });
  const token = String(request.headers["x-callback-token"] ?? "");
  if (!constantTimeEquals(token, config.XENDIT_CALLBACK_TOKEN)) return reply.code(401).send({ error: "INVALID_CALLBACK_TOKEN" });
  const body = request.body ?? {};
  const orderId = String(body.external_id ?? "").replace(/^coder-/, "");
  const status = String(body.status ?? "").toUpperCase();
  const order = getOrder(orderId);
  recordPayment({ orderId: order?.id ?? null, userId: order?.userId ?? null, provider: "xendit", providerRef: String(body.id ?? ""), amountIdr: Number(body.paid_amount ?? body.amount ?? 0), status, raw: body });
  if (order && ["PAID", "SETTLED"].includes(status)) {
    markOrderPaid(order.id, null, "Otomatis: callback Xendit");
    notify(null, order.userId, "billing", "Pembayaran diterima", "Paket Anda sudah aktif setelah pembayaran Xendit dikonfirmasi.", "/");
  }
  return { ok: true };
});

/** Midtrans transaction notification. Disabled unless the server key is present. */
app.post("/api/v1/webhooks/midtrans", async (request: any, reply) => {
  const cfg = paymentConfig();
  if (!cfg.midtransEnabled || !config.MIDTRANS_SERVER_KEY) return reply.code(404).send({ error: "GATEWAY_DISABLED" });
  const body = request.body ?? {};
  const orderId = String(body.order_id ?? "");
  const status = String(body.transaction_status ?? "").toUpperCase();
  const order = getOrder(orderId);
  recordPayment({ orderId: order?.id ?? null, userId: order?.userId ?? null, provider: "midtrans", providerRef: String(body.transaction_id ?? ""), amountIdr: Number(body.gross_amount ?? 0), status, raw: body });
  if (order && ["SETTLEMENT", "CAPTURE"].includes(status)) {
    markOrderPaid(order.id, null, "Otomatis: callback Midtrans");
    notify(null, order.userId, "billing", "Pembayaran diterima", "Paket Anda sudah aktif setelah pembayaran Midtrans dikonfirmasi.", "/");
  }
  return { ok: true };
});

// ---------------------------------------------------------------- profil & akun

app.patch<{ Body: { displayName?: string } }>("/api/v1/auth/me", { preHandler: requireUser }, async (request: any, reply) => {
  const displayName = String(request.body?.displayName ?? "").trim();
  if (displayName.length < 2 || displayName.length > 80) return reply.code(400).send({ error: "INVALID_DISPLAY_NAME" });
  db.prepare("UPDATE users SET display_name=?, updated_at=? WHERE id=?").run(displayName, new Date().toISOString(), request.user!.id);
  recordAudit(null, request.user!.id, "user.profile_updated", { displayName });
  return { user: { id: request.user!.id, email: request.user!.email, displayName } };
});

/**
 * Deletes the caller's own account. The password and an explicit phrase are both
 * required, and the last platform admin cannot be removed, so nobody locks the
 * platform out of its own administration.
 */
app.delete<{ Body: { password?: string; confirm?: string; exportId?: string } }>("/api/v1/auth/account", { preHandler: requireUser }, async (request: any, reply) => {
  if (String(request.body?.confirm ?? "").trim().toUpperCase() !== "HAPUS AKUN") return reply.code(400).send({ error: "CONFIRM_REQUIRED", message: 'Tulis "HAPUS AKUN" untuk mengonfirmasi.' });
  const row = db.prepare("SELECT password_hash AS passwordHash, deleted_at AS deletedAt FROM users WHERE id=?").get(request.user!.id) as { passwordHash: string | null; deletedAt: string | null } | undefined;
  const password = String(request.body?.password ?? "");
  if (!row?.passwordHash || !password || !(await verifyPassword(password, row.passwordHash))) return reply.code(403).send({ error: "INVALID_PASSWORD", message: "Kata sandi tidak cocok." });
  if (row.deletedAt) return reply.code(409).send({ error: "ACCOUNT_ALREADY_CLOSED", message: "Akun ini sudah ditutup sebelumnya." });
  if (isPlatformAdmin(request.user!) && platformAdminCount() <= 1) return reply.code(409).send({ error: "LAST_ADMIN", message: "Admin platform terakhir tidak boleh menutup akunnya sendiri." });
  const userId = request.user!.id;
  // Wave 8: the user takes a copy of their own data first. The dashboard makes the export, and the
  // newest ready export must be less than a day old, so nobody loses work by accident.
  const usable = listExports(userId).filter((item) => item.status === "ready" && item.expiresAt > new Date().toISOString());
  const wanted = request.body?.exportId;
  const chosen = wanted ? usable.find((item) => item.id === wanted) : usable[0];
  if (!chosen) return reply.code(409).send({ error: "EXPORT_REQUIRED", message: "Unduh dulu salinan data Anda (Pengaturan, bagian Akun). Setelah ekspor dibuat, akun bisa ditutup." });
  if (new Date(chosen.createdAt).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
    return reply.code(409).send({ error: "EXPORT_TOO_OLD", message: "Salinan data terakhir sudah lebih dari 24 jam. Buat ekspor baru dulu, lalu tutup akun." });
  }
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + ACCOUNT_RECOVERY_DAYS * 86_400_000).toISOString();
  // The account is only marked as closed. The rows stay for the recovery window, and the retention
  // pass removes them for good once purge_after has passed.
  db.transaction(() => {
    db.prepare("UPDATE users SET deleted_at=?, purge_after=?, updated_at=? WHERE id=?").run(now.toISOString(), purgeAfter, now.toISOString(), userId);
    db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM auth_tokens WHERE user_id=?").run(userId);
    db.prepare("UPDATE api_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").run(now.toISOString(), userId);
  })();
  recordAudit(null, null, "user.account_closed", { userId, exportId: chosen.id, purgeAfter, recoveryDays: ACCOUNT_RECOVERY_DAYS });
  clearSessionCookie(reply as any, config.NODE_ENV === "production");
  return { ok: true, deletedAt: now.toISOString(), purgeAfter, recoveryDays: ACCOUNT_RECOVERY_DAYS, exportId: chosen.id };
});

// ---------------------------------------------------------------- hapus data

app.delete<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT p.id, p.name, p.workspace_id AS workspaceId FROM projects p WHERE p.id=?").get(request.params.projectId) as { id: string; name: string; workspaceId: string } | undefined;
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const role = membershipRole(project.workspaceId, request.user!.id);
  if (!role) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (!canManageWorkspace(project.workspaceId, request.user!.id)) return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
  recordAudit(project.workspaceId, request.user!.id, "project.deleted", { projectId: project.id, name: project.name });
  await deleteProjectFully(project.id);
  return { ok: true };
});

app.delete<{ Params: { workflowId: string } }>("/api/v1/workflows/:workflowId", { preHandler: requireUser }, async (request: any, reply) => {
  const access = workflowAccess(request.params.workflowId, request.user!.id);
  if (!access) return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  if (access.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const running = db.prepare("SELECT COUNT(*) AS total FROM workflow_executions WHERE workflow_id=? AND status IN ('queued','running','awaiting_approval')").get(access.id) as { total: number };
  if (running.total > 0) return reply.code(409).send({ error: "WORKFLOW_BUSY" });
  recordAudit(access.workspaceId, request.user!.id, "workflow.deleted", { workflowId: access.id, name: access.name });
  db.transaction(() => {
    db.prepare("DELETE FROM workflow_execution_steps WHERE execution_id IN (SELECT id FROM workflow_executions WHERE workflow_id=?)").run(access.id);
    db.prepare("DELETE FROM workflow_executions WHERE workflow_id=?").run(access.id);
    db.prepare("DELETE FROM workflows WHERE id=?").run(access.id);
  })();
  return { ok: true };
});

app.delete<{ Params: { artifactId: string } }>("/api/v1/artifacts/:artifactId", { preHandler: requireUser }, async (request: any, reply) => {
  const artifact = db.prepare(`SELECT a.id, a.name, a.storage_path AS storagePath, p.workspace_id AS workspaceId FROM artifacts a
    JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE a.id=? AND m.user_id=?`)
    .get(request.params.artifactId, request.user!.id) as { id: string; name: string; storagePath: string; workspaceId: string } | undefined;
  if (!artifact) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND" });
  if (!canManageWorkspace(artifact.workspaceId, request.user!.id)) {
    const role = membershipRole(artifact.workspaceId, request.user!.id);
    if (role !== "member") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  }
  recordAudit(artifact.workspaceId, request.user!.id, "artifact.deleted", { artifactId: artifact.id, name: artifact.name });
  db.prepare("DELETE FROM artifacts WHERE id=?").run(artifact.id);
  await unlink(artifact.storagePath).catch(() => undefined);
  return { ok: true };
});

app.delete<{ Params: { workspaceId: string }; Body: { confirm?: string } }>("/api/v1/workspaces/:workspaceId", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = db.prepare("SELECT id, name FROM workspaces WHERE id=?").get(request.params.workspaceId) as { id: string; name: string } | undefined;
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (membershipRole(workspace.id, request.user!.id) !== "owner") return reply.code(403).send({ error: "OWNER_REQUIRED" });
  if (String(request.body?.confirm ?? "").trim() !== workspace.name) return reply.code(400).send({ error: "CONFIRM_REQUIRED", expected: workspace.name });
  const projects = (db.prepare("SELECT COUNT(*) AS total FROM projects WHERE workspace_id=?").get(workspace.id) as { total: number }).total;
  recordAudit(workspace.id, request.user!.id, "workspace.deleted", { name: workspace.name, projects });
  await deleteWorkspaceFully(workspace.id);
  return { ok: true };
});

// ---------------------------------------------------------------- unduh tambahan

app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/usage/export", { preHandler: requireUser }, async (request: any, reply) => {
  const project = db.prepare("SELECT p.id, p.name FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?")
    .get(request.params.projectId, request.user!.id) as { id: string; name: string } | undefined;
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const rows = db.prepare(`SELECT u.created_at AS createdAt, u.model, u.provider, u.run_id AS runId, u.input_tokens AS inputTokens,
    u.output_tokens AS outputTokens, u.cache_read_tokens AS cacheReadTokens, u.total_tokens AS totalTokens, u.cost_micros AS costMicros,
    u.estimated AS estimated FROM run_usage u WHERE u.project_id=? ORDER BY u.created_at`).all(project.id) as any[];
  const lines = ["tanggal,model,provider,run,input_tokens,output_tokens,cache_read_tokens,total_tokens,cost_micros,cost_usd,perkiraan"];
  for (const row of rows) {
    lines.push([row.createdAt, row.model, row.provider, row.runId, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.totalTokens,
      row.costMicros, (Number(row.costMicros ?? 0) / 1e6).toFixed(6), row.estimated ? "ya" : "tidak"].map(csvField).join(","));
  }
  const total = rows.reduce((sum, row) => sum + Number(row.costMicros ?? 0), 0);
  lines.push([`"TOTAL"`, "", "", `${rows.length} run`, "", "", "", "", total, (total / 1e6).toFixed(6), ""].map(csvField).join(","));
  const safeName = project.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "proyek";
  return reply
    .header("Content-Disposition", `attachment; filename="pemakaian-${safeName}.csv"`)
    .type("text/csv; charset=utf-8")
    .send("\uFEFF" + lines.join("\n"));
});

app.get<{ Params: { artifactId: string } }>("/api/v1/artifacts/:artifactId/raw", { preHandler: requireUser }, async (request: any, reply) => {
  const artifact = db.prepare(`SELECT a.name, a.mime_type AS mimeType, a.storage_path AS storagePath FROM artifacts a
    JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE a.id=? AND m.user_id=?`)
    .get(request.params.artifactId, request.user!.id) as { name: string; mimeType: string; storagePath: string } | undefined;
  if (!artifact) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND" });
  try {
    const content = await readFile(artifact.storagePath);
    return reply
      .header("Content-Disposition", `inline; filename="${artifact.name.replaceAll('"', "")}"`)
      .header("X-Content-Type-Options", "nosniff")
      .type(artifact.mimeType)
      .send(content);
  } catch { return reply.code(404).send({ error: "ARTIFACT_FILE_MISSING" }); }
});


// ============================================================
// WAVE 3: agent workspace (memory bank, templates, personas,
// token saver with real compaction, skills, status hub,
// playground, agent map, diff, markdown report)
// ============================================================

/** Reasoning levels the engine really accepts, taken from `prime-agent --help`. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function isThinkingLevel(value: unknown): boolean { return typeof value === "string" && THINKING_LEVELS.includes(value); }

type AgentSettingsRow = {
  thinking_level: string; auto_compact: number; compact_after_messages: number; tools_allow: string;
  autonomous_default: number; autonomous_max_turns: number; autonomous_max_tokens: number;
  fallback_models: string;
};
const AGENT_SETTINGS_DEFAULTS: AgentSettingsRow = { thinking_level: "medium", auto_compact: 1, compact_after_messages: 24, tools_allow: "", autonomous_default: 0, autonomous_max_turns: 6, autonomous_max_tokens: 40000, fallback_models: "[]" };
/** Tools allowlist is free text because the engine owns the tool names: "" = engine default, "none" = no tools. */
function parseToolsAllow(raw: unknown): string[] | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  if (value === "none") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 40);
}

function agentSettings(userId: string): AgentSettingsRow {
  const row = db.prepare("SELECT thinking_level,auto_compact,compact_after_messages,tools_allow,autonomous_default,autonomous_max_turns,autonomous_max_tokens,fallback_models FROM agent_settings WHERE user_id=?").get(userId) as AgentSettingsRow | undefined;
  return row ? { ...AGENT_SETTINGS_DEFAULTS, ...row } : { ...AGENT_SETTINGS_DEFAULTS };
}

function saveAgentSettings(userId: string, patch: Partial<AgentSettingsRow>): AgentSettingsRow {
  const next = { ...agentSettings(userId), ...patch };
  db.prepare(`INSERT INTO agent_settings (user_id,thinking_level,auto_compact,compact_after_messages,tools_allow,autonomous_default,autonomous_max_turns,autonomous_max_tokens,fallback_models,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET thinking_level=excluded.thinking_level, auto_compact=excluded.auto_compact,
      compact_after_messages=excluded.compact_after_messages, tools_allow=excluded.tools_allow,
      autonomous_default=excluded.autonomous_default, autonomous_max_turns=excluded.autonomous_max_turns,
      autonomous_max_tokens=excluded.autonomous_max_tokens, fallback_models=excluded.fallback_models,
      updated_at=excluded.updated_at`)
    .run(userId, next.thinking_level, next.auto_compact, next.compact_after_messages, next.tools_allow, next.autonomous_default, next.autonomous_max_turns, next.autonomous_max_tokens, next.fallback_models ?? "[]", new Date().toISOString());
  return next;
}

/** The default persona of a user, or the requested one when it belongs to that user. */
function personaRow(userId: string, personaId?: string | null) {
  if (personaId) {
    const chosen = db.prepare("SELECT id,name,system_prompt AS systemPrompt,tone,language,model,thinking_level AS thinkingLevel FROM agent_personas WHERE id=? AND user_id=?").get(personaId, userId) as any;
    if (chosen) return chosen;
  }
  return db.prepare("SELECT id,name,system_prompt AS systemPrompt,tone,language,model,thinking_level AS thinkingLevel FROM agent_personas WHERE user_id=? AND is_default=1 ORDER BY updated_at DESC LIMIT 1").get(userId) as any;
}

function conversationPersonaId(conversationId?: string | null): string | null {
  if (!conversationId) return null;
  const row = db.prepare("SELECT persona_id AS personaId FROM conversations WHERE id=?").get(conversationId) as { personaId?: string | null } | undefined;
  return row?.personaId ?? null;
}

/** Wave 11A (butir 80): satu kandidat sisipan beserta prioritasnya. Prioritas besar dipotong lebih dulu. */
type ContextCandidate = { name: string; priority: number; text: string };

/**
 * Wave 11A (butir 42/46/51/52/80): menyusun seluruh sisipan konteks dalam satu tempat.
 *
 * Urutan kirim: mode percakapan (butir 42) → Knowledge Base platform (butir 52) → aturan kualitas
 * akun (butir 46) → persona → memori dipin → skill pengguna (butir 51) → memori lain → ringkasan
 * percakapan. Pagar konteks (butir 80) memotong dari prioritas terendah, jadi KB dan persona selalu
 * bertahan lebih lama daripada skill dan memori biasa. Riwayat percakapan pengguna tidak pernah
 * disusun di sini (mesin memegang sesinya), jadi pagar ini tidak pernah memakan riwayat.
 */
function buildSystemBlocks(userId?: string | null, personaId?: string | null, conversationId?: string | null) {
  const candidates: ContextCandidate[] = [];
  const skillIds: string[] = [];
  const learningIds: string[] = [];
  if (conversationId) {
    const modeBlocks = agentModeBlocks(conversationId);
    // Instruksi mode wajib paling awal dan tidak boleh dipotong: ini pengaman, bukan konteks.
    if (modeBlocks.length) candidates.push({ name: "mode_diskusi", priority: 0, text: modeBlocks.join("\n") });
  }
  const knowledge = platformKnowledgeBlock();
  if (knowledge.block) candidates.push({ name: "knowledge_base", priority: 1, text: knowledge.block });
  if (userId) {
    const persona = personaRow(userId, personaId);
    if (persona) {
      const parts = [`Persona aktif: ${persona.name}.`, String(persona.systemPrompt ?? "").trim()];
      if (String(persona.tone ?? "").trim()) parts.push(`Gaya bicara: ${persona.tone}.`);
      if (persona.language === "id") parts.push("Jawab dalam Bahasa Indonesia yang baku, ringkas, dan jelas.");
      candidates.push({ name: "persona", priority: 2, text: parts.filter(Boolean).join(" ").slice(0, 4000) });
    }
    const quality = guardrailBlockFor(userId);
    if (quality) candidates.push({ name: "guardrail_kualitas", priority: 2, text: quality });
    // Wave 11B (butir 60): memori biasa dan pelajaran berbagi tabel yang sama, dibedakan oleh `kind`,
    // supaya menyalakan/mematikan pelajaran tidak mengubah isi bank memori.
    const memories = db.prepare("SELECT title, body, pinned FROM agent_memories WHERE user_id=? AND enabled=1 AND kind='memory' ORDER BY pinned DESC, updated_at DESC LIMIT 12").all(userId) as { title: string; body: string; pinned: number }[];
    const asText = (rows: { title: string; body: string }[]) => rows.map((memory) => `- ${memory.title}: ${String(memory.body).replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    const pinned = memories.filter((memory) => Boolean(memory.pinned));
    const others = memories.filter((memory) => !memory.pinned);
    if (pinned.length) candidates.push({ name: "memori_dipin", priority: 3, text: `Bank memori dipin (WAJIB dipakai bila relevan, jangan dibacakan mentah):\n${asText(pinned)}` });
    const skills = userSkillsBlock(userId);
    if (skills.block) candidates.push({ name: "skill_pengguna", priority: 4, text: skills.block });
    const learnings = learningBlocks(userId);
    if (learnings.block) candidates.push({ name: "pelajaran_pengguna", priority: 4, text: learnings.block });
    if (others.length) candidates.push({ name: "memori_lain", priority: 5, text: `Bank memori pengguna (pakai bila relevan, jangan dibacakan mentah):\n${asText(others)}` });
    for (const skill of skills.skills) skillIds.push(skill.id);
    for (const learning of learnings.learnings) learningIds.push(learning.id);
  }
  if (conversationId) {
    const summary = db.prepare("SELECT summary FROM conversation_summaries WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1").get(conversationId) as { summary: string } | undefined;
    // Prioritas 0: ringkasan adalah riwayat percakapan pengguna, jadi TIDAK PERNAH dipotong untuk
    // memberi ruang sisipan (butir 80). Sisipan yang dipotong, bukan percakapannya.
    if (summary?.summary) candidates.push({ name: "ringkasan_percakapan", priority: 0, text: `Ringkasan percakapan sebelum pemadatan (pakai sebagai konteks, jangan minta diulang):\n${String(summary.summary).slice(0, 6000)}` });
  }
  const plan = buildBudgetPlan(candidates.map((candidate) => ({ name: candidate.name, priority: candidate.priority, text: candidate.text })), contextBudgetChars());
  return {
    blocks: plan.blocks.map((block) => block.text),
    plan,
    skillIds,
    learningIds,
    dropped: plan.dropped,
    budgetChars: plan.budgetChars,
    totalChars: plan.totalChars,
    keptChars: plan.keptChars,
  };
}

/** Blok sistem untuk satu pengguna; dipakai jalur run dan halaman pratinjau. */
function systemBlocksFor(userId?: string | null, personaId?: string | null, conversationId?: string | null): string[] {
  return buildSystemBlocks(userId, personaId, conversationId).blocks;
}

/** The engine session of a conversation. Compaction replaces it, so the column is the source of truth. */
function engineSessionFor(conversationId: string): string {
  const row = db.prepare("SELECT engine_session_id AS engineSessionId FROM conversations WHERE id=?").get(conversationId) as { engineSessionId?: string | null } | undefined;
  if (row?.engineSessionId) return row.engineSessionId;
  const fresh = randomUUID();
  db.prepare("UPDATE conversations SET engine_session_id=? WHERE id=?").run(fresh, conversationId);
  return fresh;
}

/** Message count of a conversation; used by the auto-compaction trigger. */
function messageCount(conversationId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(conversationId) as { n: number }).n);
}

type CompactionResult = { summary: string; messagesCovered: number; charsBefore: number; charsAfter: number; engineSessionId: string; usage: unknown; source: "engine" | "fallback" };

/**
 * Compaction: the engine summarises the conversation it already holds, the summary is stored, and the
 * engine session is rotated. Later runs get the summary as a system block instead of the full history,
 * which is what actually cuts the tokens sent to the model.
 */
async function compactConversation(conversationId: string, userId: string): Promise<CompactionResult | null> {
  const conversation = db.prepare("SELECT c.id, c.project_id AS projectId, c.engine_session_id AS engineSessionId FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?")
    .get(conversationId, userId) as { id: string; projectId: string; engineSessionId?: string | null } | undefined;
  if (!conversation) return null;
  const messages = db.prepare("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(conversationId) as { role: string; content: string }[];
  const charsBefore = messages.reduce((total, message) => total + message.content.length, 0);
  const sessionId = conversation.engineSessionId ?? conversationId;
  const instruction = "Ringkas seluruh percakapan ini untuk dipakai sebagai konteks lanjutan. Sebutkan: tujuan, keputusan, fakta penting (nama, berkas, angka), dan tugas yang masih terbuka. Padat, maksimal 1200 kata, tanpa basa-basi.";
  let summary = ""; let usage: unknown = null; let source: "engine" | "fallback" = "engine";
  try {
    for await (const event of engine.run({ runId: randomUUID(), sessionId, prompt: instruction, model: config.PRIME_AGENT_MODEL, provider: config.PRIME_AGENT_PROVIDER })) {
      if (event.type === "text") summary += typeof event.data === "string" ? event.data : "";
      if (event.type === "completed") usage = (event.data as { usage?: unknown })?.usage ?? null;
      if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "COMPACT_FAILED"));
    }
  } catch { summary = ""; }
  if (!summary.trim()) {
    // Honest fallback: a trimmed transcript, so compaction never loses the thread entirely.
    source = "fallback";
    summary = messages.slice(-40).map((message) => `${message.role}: ${String(message.content).slice(0, 400)}`).join("\n").slice(0, 6000);
  }
  const freshSession = randomUUID(); const now = new Date().toISOString();
  db.prepare("INSERT INTO conversation_summaries (id,conversation_id,summary,messages_covered,chars_before,chars_after,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(), conversationId, summary, messages.length, charsBefore, summary.length, now);
  db.prepare("UPDATE conversations SET engine_session_id=?, compacted_at=? WHERE id=?").run(freshSession, now, conversationId);
  return { summary, messagesCovered: messages.length, charsBefore, charsAfter: summary.length, engineSessionId: freshSession, usage, source };
}

/** A small unified diff (line based, LCS) for comparing two text artifacts. */
function unifiedDiff(aName: string, aText: string, bName: string, bText: string, context = 3) {
  const a = aText.split("\n").slice(0, 4000); const b = bText.split("\n").slice(0, 4000);
  const n = a.length; const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  type Line = { type: " " | "-" | "+"; text: string; left?: number; right?: number };
  const all: Line[] = []; let i = 0; let j = 0; let added = 0; let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { all.push({ type: " ", text: a[i], left: i + 1, right: j + 1 }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { all.push({ type: "-", text: a[i], left: i + 1 }); removed += 1; i += 1; }
    else { all.push({ type: "+", text: b[j], right: j + 1 }); added += 1; j += 1; }
  }
  while (i < n) { all.push({ type: "-", text: a[i], left: i + 1 }); removed += 1; i += 1; }
  while (j < m) { all.push({ type: "+", text: b[j], right: j + 1 }); added += 1; j += 1; }
  const keep = new Set<number>();
  all.forEach((line, index) => { if (line.type === " ") return; for (let k = index - context; k <= index + context; k += 1) if (k >= 0 && k < all.length) keep.add(k); });
  const lines: Line[] = []; let lastKept = -2;
  for (let index = 0; index < all.length; index += 1) {
    if (!keep.has(index)) continue;
    if (index !== lastKept + 1 && lines.length) lines.push({ type: " ", text: "@@" });
    lines.push(all[index]); lastKept = index;
  }
  return { left: { name: aName, lines: n }, right: { name: bName, lines: m }, added, removed, changes: added + removed, hunks: lines };
}

/** Markdown report: one place that turns stored data into a document the user can keep. */
function markdownReport(kind: string, projectId: string, userId: string, conversationId?: string) {
  const project = db.prepare("SELECT p.id, p.name, p.description, p.created_at AS createdAt, w.name AS workspaceName FROM projects p JOIN workspaces w ON w.id=p.workspace_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(projectId, userId) as any;
  if (!project) return null;
  const now = new Date().toISOString();
  const stamp = `Dibuat: ${now}`;
  if (kind === "conversation") {
    const conversation = conversationId
      ? db.prepare("SELECT id,title,created_at AS createdAt FROM conversations WHERE id=? AND project_id=?").get(conversationId, projectId) as any
      : db.prepare("SELECT id,title,created_at AS createdAt FROM conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 1").get(projectId) as any;
    if (!conversation) return null;
    const messages = db.prepare("SELECT role, content, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(conversation.id) as any[];
    const summaries = db.prepare("SELECT summary, messages_covered AS covered, created_at AS createdAt FROM conversation_summaries WHERE conversation_id=? ORDER BY created_at DESC").all(conversation.id) as any[];
    const body = [`# Laporan percakapan: ${conversation.title}`, "", `Proyek: **${project.name}** (${project.workspaceName})`, stamp, `Pesan: ${messages.length}`, "", "## Ringkasan pemadatan", summaries.length ? summaries.map((row) => `- (${row.covered} pesan, ${row.createdAt}) ${String(row.summary).slice(0, 800)}`).join("\n") : "_Belum ada pemadatan._", "", "## Isi percakapan", ...messages.map((message) => `### ${message.role === "user" ? "Pengguna" : "Asisten"} — ${message.createdAt}\n\n${message.content}`)];
    return { filename: `laporan-percakapan-${conversation.id.slice(0, 8)}.md`, markdown: body.join("\n") };
  }
  if (kind === "project") {
    const conversations = db.prepare("SELECT c.id, c.title, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS messages FROM conversations c WHERE c.project_id=? ORDER BY c.updated_at DESC LIMIT 50").all(projectId) as any[];
    const artifacts = db.prepare("SELECT name, mime_type AS mimeType, size_bytes AS sizeBytes, created_at AS createdAt FROM artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 50").all(projectId) as any[];
    const runs = db.prepare("SELECT id, status, error_code AS errorCode, created_at AS createdAt, finished_at AS finishedAt FROM runs WHERE project_id=? ORDER BY created_at DESC LIMIT 50").all(projectId) as any[];
    const docs = db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE project_id=?").get(projectId) as { n: number };
    const workflowRows = db.prepare("SELECT name, status, schedule_enabled AS scheduleEnabled, schedule_cron AS scheduleCron, schedule_interval_minutes AS intervalMinutes FROM workflows WHERE project_id=?").all(projectId) as any[];
    const body = [`# Laporan proyek: ${project.name}`, "", `Workspace: **${project.workspaceName}**`, stamp, project.description ? `\n${project.description}` : "", "", "## Angka ringkas", `- Percakapan: ${conversations.length}`, `- Run: ${runs.length} (gagal: ${runs.filter((run) => run.status === "failed").length})`, `- Artefak: ${artifacts.length}`, `- Dokumen pengetahuan: ${docs.n}`, `- Workflow: ${workflowRows.length}`, "", "## Percakapan", conversations.length ? conversations.map((row) => `- ${row.title} (${row.messages} pesan) — ${row.id}`).join("\n") : "_Belum ada._", "", "## Artefak", artifacts.length ? artifacts.map((row) => `- ${row.name} (${row.mimeType}, ${row.sizeBytes} byte) — ${row.createdAt}`).join("\n") : "_Belum ada._", "", "## Run terakhir", runs.length ? runs.map((run) => `- ${run.createdAt} ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""} — ${run.id.slice(0, 8)}`).join("\n") : "_Belum ada._", "", "## Workflow", workflowRows.length ? workflowRows.map((row) => `- ${row.name} — ${row.scheduleEnabled ? "berjadwal" : "manual"}, status ${row.status}${row.scheduleCron ? `, cron ${row.scheduleCron}` : row.intervalMinutes ? `, tiap ${row.intervalMinutes} menit` : ""}`).join("\n") : "_Belum ada._"];
    return { filename: `laporan-proyek-${String(project.name).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40)}.md`, markdown: body.join("\n") };
  }
  return null;
}


/** Byte/file statistics of a directory, used by the status hub. Missing paths return null, not zero. */
type DirStats = { files: number; bytes: number; newest: string | null };
async function dirStats(path: string, cap = 4000): Promise<DirStats | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let files = 0; let bytes = 0; let newest: string | null = null;
    const keepNewest = (stamp: string | null) => { if (stamp && (!newest || stamp > newest)) newest = stamp; };
    for (const entry of entries.slice(0, cap)) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        const inner = await dirStats(full, 200);
        if (inner) { files += inner.files; bytes += inner.bytes; keepNewest(inner.newest); }
        continue;
      }
      try { const info = await stat(full); files += 1; bytes += info.size; keepNewest(info.mtime.toISOString()); } catch { /* unreadable entry is skipped on purpose */ }
    }
    return { files, bytes, newest };
  } catch { return null; }
}

// ------------------------------------------------------------
// Token saver & engine options
// ------------------------------------------------------------
app.get("/api/v1/agents/settings", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  return {
    settings: agentSettings(userId),
    fallbackModels: fallbackModelsFor(userId),
    fallbackHelp: "Model cadangan dipakai berurutan hanya saat galat sementara (429/5xx/timeout), maksimal 2 perpindahan per run.",
    thinkingLevels: THINKING_LEVELS,
    toolsAllowHelp: "Kosong = bawaan mesin. Isi 'none' untuk tanpa alat. Atau daftar nama alat dipisah koma.",
    autonomousHelp: "Mode otonom menjalankan mesin sampai batas langkah/token, bukan sekali jawab.",
    quota: quotaState(userId),
  };
});

app.patch<{ Body: { thinkingLevel?: string; autoCompact?: boolean; compactAfterMessages?: number; toolsAllow?: string; autonomousDefault?: boolean; autonomousMaxTurns?: number; autonomousMaxTokens?: number; fallbackModels?: unknown; modelUtama?: string } }>("/api/v1/agents/settings", { preHandler: requireUser }, async (request: any, reply) => {
  const userId = request.user!.id; const body = request.body ?? {}; const patch: Partial<AgentSettingsRow> = {};
  if (body.fallbackModels !== undefined) {
    // Wave 11A (butir 57): model cadangan tidak boleh sama dengan model utama, tanpa duplikat, maks 3.
    const primary = String(body.modelUtama ?? config.PRIME_AGENT_MODEL ?? "").trim() || null;
    const problem = validateFallbackModels(body.fallbackModels, primary);
    if (problem) return reply.code(400).send({ error: "INVALID_FALLBACK_MODELS", message: problem });
    patch.fallback_models = JSON.stringify((body.fallbackModels as unknown[]).map((item) => String(item).trim()).filter(Boolean));
  }
  if (body.thinkingLevel !== undefined) {
    if (!isThinkingLevel(body.thinkingLevel)) return reply.code(400).send({ error: "INVALID_THINKING_LEVEL", allowed: THINKING_LEVELS });
    patch.thinking_level = String(body.thinkingLevel);
  }
  if (body.autoCompact !== undefined) patch.auto_compact = body.autoCompact ? 1 : 0;
  if (body.compactAfterMessages !== undefined) {
    const value = Number(body.compactAfterMessages);
    if (!Number.isFinite(value) || value < 4 || value > 500) return reply.code(400).send({ error: "INVALID_COMPACT_THRESHOLD", message: "Ambang pemadatan antara 4 dan 500 pesan." });
    patch.compact_after_messages = Math.round(value);
  }
  if (body.toolsAllow !== undefined) patch.tools_allow = String(body.toolsAllow).trim().slice(0, 400);
  if (body.autonomousDefault !== undefined) patch.autonomous_default = body.autonomousDefault ? 1 : 0;
  if (body.autonomousMaxTurns !== undefined) {
    const value = Number(body.autonomousMaxTurns);
    if (!Number.isFinite(value) || value < 1 || value > 50) return reply.code(400).send({ error: "INVALID_AUTONOMOUS_TURNS", message: "Batas langkah antara 1 dan 50." });
    patch.autonomous_max_turns = Math.round(value);
  }
  if (body.autonomousMaxTokens !== undefined) {
    const value = Number(body.autonomousMaxTokens);
    if (!Number.isFinite(value) || value < 1000 || value > 500000) return reply.code(400).send({ error: "INVALID_AUTONOMOUS_TOKENS", message: "Batas token antara 1.000 dan 500.000." });
    patch.autonomous_max_tokens = Math.round(value);
  }
  return { settings: saveAgentSettings(userId, patch) };
});

/** Honest preview of what the platform will send to the engine for a conversation. */
app.get<{ Querystring: { conversationId?: string; personaId?: string } }>("/api/v1/agents/preview", { preHandler: requireUser }, async (request: any, reply) => {
  const userId = request.user!.id;
  const settings = agentSettings(userId);
  const conversationId = request.query?.conversationId?.trim() || null;
  if (conversationId) {
    const allowed = db.prepare("SELECT 1 FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(conversationId, userId);
    if (!allowed) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  }
  const askedPersonaId = request.query?.personaId?.trim() || conversationPersonaId(conversationId);
  // systemBlocksFor() falls back to the account default persona, so the preview reports that same
  // persona instead of "null" while blocks are plainly being sent.
  const blocks = systemBlocksFor(userId, askedPersonaId, conversationId);
  const effectivePersona = personaRow(userId, askedPersonaId);
  const currentPersona = blocks.length && effectivePersona ? effectivePersona : null;
  const conversation = conversationId
    ? db.prepare("SELECT id, engine_session_id AS engineSessionId, compacted_at AS compactedAt, persona_id AS personaId FROM conversations WHERE id=?").get(conversationId) as any
    : null;
  const summaryCount = conversationId ? Number((db.prepare("SELECT COUNT(*) AS n FROM conversation_summaries WHERE conversation_id=?").get(conversationId) as { n: number }).n) : 0;
  const flags: string[] = [];
  flags.push(`--model ${config.PRIME_AGENT_MODEL ?? "(bawaan)"}`);
  flags.push(`--thinking ${settings.thinking_level}`);
  blocks.forEach(() => flags.push("--append-system-prompt <blok>"));
  const tools = parseToolsAllow(settings.tools_allow);
  if (tools) flags.push(tools.length ? `--tools ${tools.join(",")}` : "--no-tools");
  if (settings.autonomous_default) flags.push(`--autonomous --autonomous-max-turns ${settings.autonomous_max_turns} --autonomous-max-tokens ${settings.autonomous_max_tokens}`);
  return {
    settings,
    persona: currentPersona ?? null,
    personaSource: currentPersona ? (askedPersonaId ? "dipilih" : "bawaan akun") : null,
    blocks,
    flags,
    conversation,
    session: conversation?.engineSessionId ? await dirStats(join(config.ENGINE_ROOT_DIR, conversation.engineSessionId)) : null,
    summaryCount,
    messages: conversationId ? messageCount(conversationId) : 0,
    notes: [
      "Blok di atas dikirim sebagai --append-system-prompt, jadi bukan bagian dari pesan pengguna.",
      "Pemadatan mengganti sesi mesin; ringkasan lama tetap dikirim sebagai satu blok.",
      tools === undefined ? "Allowlist alat kosong: mesin memakai bawaannya." : tools.length ? "Allowlist alat aktif." : "Semua alat dimatikan untuk akun ini.",
    ],
  };
});

// ------------------------------------------------------------
// Memory bank
// ------------------------------------------------------------
app.get<{ Querystring: { limit?: string } }>("/api/v1/memories", { preHandler: requireUser }, async (request: any) => {
  const limit = Math.min(Math.max(Number(request.query?.limit ?? 100) || 100, 1), 300);
  const memories = db.prepare("SELECT id,title,body,tags,pinned,enabled,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM agent_memories WHERE user_id=? AND kind='memory' ORDER BY pinned DESC, updated_at DESC LIMIT ?").all(request.user!.id, limit);
  return { memories };
});

app.post<{ Body: { title?: string; body?: string; tags?: string; pinned?: boolean } }>("/api/v1/memories", { preHandler: requireUser }, async (request: any, reply) => {
  const title = String(request.body?.title ?? "").trim().slice(0, 200);
  const body = String(request.body?.body ?? "").trim().slice(0, 8000);
  if (!title || !body) return reply.code(400).send({ error: "INVALID_MEMORY", message: "Judul dan isi memori wajib diisi." });
  const id = randomUUID(); const now = new Date().toISOString();
  db.prepare("INSERT INTO agent_memories (id,user_id,title,body,tags,pinned,enabled,use_count,created_at,updated_at) VALUES (?,?,?,?,?,?,1,0,?,?)")
    .run(id, request.user!.id, title, body, String(request.body?.tags ?? "").trim().slice(0, 200), request.body?.pinned ? 1 : 0, now, now);
  return reply.code(201).send({ memory: db.prepare("SELECT id,title,body,tags,pinned,enabled,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM agent_memories WHERE id=?").get(id) });
});

app.patch<{ Params: { memoryId: string }; Body: { title?: string; body?: string; tags?: string; pinned?: boolean; enabled?: boolean } }>("/api/v1/memories/:memoryId", { preHandler: requireUser }, async (request: any, reply) => {
  const existing = db.prepare("SELECT id,user_id AS userId FROM agent_memories WHERE id=? AND kind='memory'").get(request.params.memoryId) as { id: string; userId: string } | undefined;
  if (!existing || existing.userId !== request.user!.id) return reply.code(404).send({ error: "MEMORY_NOT_FOUND" });
  const body = request.body ?? {};
  const title = body.title !== undefined ? String(body.title).trim().slice(0, 200) : undefined;
  if (title === "") return reply.code(400).send({ error: "INVALID_MEMORY", message: "Judul tidak boleh kosong." });
  db.prepare(`UPDATE agent_memories SET title=COALESCE(?,title), body=COALESCE(?,body), tags=COALESCE(?,tags),
    pinned=COALESCE(?,pinned), enabled=COALESCE(?,enabled), updated_at=? WHERE id=?`)
    .run(title ?? null, body.body !== undefined ? String(body.body).slice(0, 8000) : null, body.tags !== undefined ? String(body.tags).slice(0, 200) : null,
      body.pinned !== undefined ? (body.pinned ? 1 : 0) : null, body.enabled !== undefined ? (body.enabled ? 1 : 0) : null, new Date().toISOString(), existing.id);
  return { memory: db.prepare("SELECT id,title,body,tags,pinned,enabled,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM agent_memories WHERE id=?").get(existing.id) };
});

app.delete<{ Params: { memoryId: string } }>("/api/v1/memories/:memoryId", { preHandler: requireUser }, async (request: any, reply) => {
  const existing = db.prepare("SELECT id,user_id AS userId FROM agent_memories WHERE id=? AND kind='memory'").get(request.params.memoryId) as { id: string; userId: string } | undefined;
  if (!existing || existing.userId !== request.user!.id) return reply.code(404).send({ error: "MEMORY_NOT_FOUND" });
  db.prepare("DELETE FROM agent_memories WHERE id=?").run(existing.id);
  return { deleted: true };
});

// ------------------------------------------------------------
// Prompt templates and slash commands
// ------------------------------------------------------------
app.get("/api/v1/prompt-templates", { preHandler: requireUser }, async (request: any) => {
  const templates = db.prepare("SELECT id,name,body,description,slash,tags,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM prompt_templates WHERE user_id=? ORDER BY use_count DESC, name LIMIT 300").all(request.user!.id);
  return { templates };
});

app.post<{ Body: { name?: string; body?: string; description?: string; slash?: string; tags?: string } }>("/api/v1/prompt-templates", { preHandler: requireUser }, async (request: any, reply) => {
  const name = String(request.body?.name ?? "").trim().slice(0, 120);
  const body = String(request.body?.body ?? "").trim().slice(0, 10000);
  if (!name || !body) return reply.code(400).send({ error: "INVALID_TEMPLATE", message: "Nama dan isi template wajib diisi." });
  const slash = String(request.body?.slash ?? "").trim().replace(/^\/+/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || null;
  if (slash) {
    const taken = db.prepare("SELECT 1 FROM prompt_templates WHERE user_id=? AND slash=?").get(request.user!.id, slash);
    if (taken) return reply.code(409).send({ error: "SLASH_TAKEN", message: `Perintah /${slash} sudah dipakai.` });
  }
  const id = randomUUID(); const now = new Date().toISOString();
  db.prepare("INSERT INTO prompt_templates (id,user_id,name,body,description,slash,tags,use_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)")
    .run(id, request.user!.id, name, body, String(request.body?.description ?? "").trim().slice(0, 400), slash, String(request.body?.tags ?? "").trim().slice(0, 200), now, now);
  return reply.code(201).send({ template: db.prepare("SELECT id,name,body,description,slash,tags,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM prompt_templates WHERE id=?").get(id) });
});

app.patch<{ Params: { templateId: string }; Body: { name?: string; body?: string; description?: string; slash?: string; tags?: string } }>("/api/v1/prompt-templates/:templateId", { preHandler: requireUser }, async (request: any, reply) => {
  const existing = db.prepare("SELECT id,user_id AS userId FROM prompt_templates WHERE id=?").get(request.params.templateId) as { id: string; userId: string } | undefined;
  if (!existing || existing.userId !== request.user!.id) return reply.code(404).send({ error: "TEMPLATE_NOT_FOUND" });
  const body = request.body ?? {};
  const slash = body.slash !== undefined ? (String(body.slash).trim().replace(/^\/+/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || null) : undefined;
  if (slash) {
    const taken = db.prepare("SELECT 1 FROM prompt_templates WHERE user_id=? AND slash=? AND id<>?").get(request.user!.id, slash, existing.id);
    if (taken) return reply.code(409).send({ error: "SLASH_TAKEN", message: `Perintah /${slash} sudah dipakai.` });
  }
  db.prepare(`UPDATE prompt_templates SET name=COALESCE(?,name), body=COALESCE(?,body), description=COALESCE(?,description),
    slash=COALESCE(?,slash), tags=COALESCE(?,tags), updated_at=? WHERE id=?`)
    .run(body.name !== undefined ? String(body.name).trim().slice(0, 120) : null, body.body !== undefined ? String(body.body).slice(0, 10000) : null,
      body.description !== undefined ? String(body.description).slice(0, 400) : null, slash ?? null, body.tags !== undefined ? String(body.tags).slice(0, 200) : null,
      new Date().toISOString(), existing.id);
  return { template: db.prepare("SELECT id,name,body,description,slash,tags,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM prompt_templates WHERE id=?").get(existing.id) };
});

app.delete<{ Params: { templateId: string } }>("/api/v1/prompt-templates/:templateId", { preHandler: requireUser }, async (request: any, reply) => {
  const existing = db.prepare("SELECT id,user_id AS userId FROM prompt_templates WHERE id=?").get(request.params.templateId) as { id: string; userId: string } | undefined;
  if (!existing || existing.userId !== request.user!.id) return reply.code(404).send({ error: "TEMPLATE_NOT_FOUND" });
  db.prepare("DELETE FROM prompt_templates WHERE id=?").run(existing.id);
  return { deleted: true };
});

/** Marks a template as used and returns the filled text, so the composer can insert it. */
app.post<{ Params: { templateId: string }; Body: { variables?: Record<string, string> } }>("/api/v1/prompt-templates/:templateId/use", { preHandler: requireUser }, async (request: any, reply) => {
  const template = db.prepare("SELECT id,body,name FROM prompt_templates WHERE id=? AND user_id=?").get(request.params.templateId, request.user!.id) as { id: string; body: string; name: string } | undefined;
  if (!template) return reply.code(404).send({ error: "TEMPLATE_NOT_FOUND" });
  let text = template.body;
  const variables = request.body?.variables ?? {};
  for (const [key, value] of Object.entries(variables)) text = text.split(`{{${key}}}`).join(String(value).slice(0, 2000));
  db.prepare("UPDATE prompt_templates SET use_count=use_count+1, updated_at=? WHERE id=?").run(new Date().toISOString(), template.id);
  return { id: template.id, name: template.name, text, remainingVariables: [...text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((match) => match[1]) };
});

// ------------------------------------------------------------
// Agent personas
// ------------------------------------------------------------
app.get("/api/v1/personas", { preHandler: requireUser }, async (request: any) => {
  const personas = db.prepare("SELECT id,name,system_prompt AS systemPrompt,tone,language,model,thinking_level AS thinkingLevel,is_default AS isDefault,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM agent_personas WHERE user_id=? ORDER BY is_default DESC, name LIMIT 200").all(request.user!.id);
  return { personas };
});

app.post<{ Body: { name?: string; systemPrompt?: string; tone?: string; language?: string; model?: string; thinkingLevel?: string; makeDefault?: boolean } }>("/api/v1/personas", { preHandler: requireUser }, async (request: any, reply) => {
  const name = String(request.body?.name ?? "").trim().slice(0, 120);
  const systemPrompt = String(request.body?.systemPrompt ?? "").trim().slice(0, 8000);
  if (!name || !systemPrompt) return reply.code(400).send({ error: "INVALID_PERSONA", message: "Nama dan system prompt wajib diisi." });
  const model = request.body?.model?.trim() || null;
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
  const thinkingLevel = request.body?.thinkingLevel && isThinkingLevel(request.body.thinkingLevel) ? String(request.body.thinkingLevel) : "medium";
  const id = randomUUID(); const now = new Date().toISOString();
  db.prepare("INSERT INTO agent_personas (id,user_id,name,system_prompt,tone,language,model,thinking_level,is_default,use_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)")
    .run(id, request.user!.id, name, systemPrompt, String(request.body?.tone ?? "").trim().slice(0, 300), request.body?.language === "en" ? "en" : "id", model, thinkingLevel, request.body?.makeDefault ? 1 : 0, now, now);
  if (request.body?.makeDefault) db.prepare("UPDATE agent_personas SET is_default=0 WHERE user_id=? AND id<>?").run(request.user!.id, id);
  return reply.code(201).send({ persona: db.prepare("SELECT id,name,system_prompt AS systemPrompt,tone,language,model,thinking_level AS thinkingLevel,is_default AS isDefault,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM agent_personas WHERE id=?").get(id) });
});

app.patch<{ Params: { personaId: string }; Body: { name?: string; systemPrompt?: string; tone?: string; language?: string; model?: string; thinkingLevel?: string } }>("/api/v1/personas/:personaId", { preHandler: requireUser }, async (request: any, reply) => {
  const existing = db.prepare("SELECT id,user_id AS userId FROM agent_personas WHERE id=?").get(request.params.personaId) as { id: string; userId: string } | undefined;
  if (!existing || existing.userId !== request.user!.id) return reply.code(404).send({ error: "PERSONA_NOT_FOUND" });
  const body = request.body ?? {};
  const model = body.model !== undefined ? (body.model.trim() || null) : undefined;
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
  const thinkingLevel = body.thinkingLevel !== undefined ? (isThinkingLevel(body.thinkingLevel) ? String(body.thinkingLevel) : null) : undefined;
  if (thinkingLevel === null) return reply.code(400).send({ error: "INVALID_THINKING_LEVEL", allowed: THINKING_LEVELS });
  db.prepare(`UPDATE agent_personas SET name=COALESCE(?,name), system_prompt=COALESCE(?,system_prompt), tone=COALESCE(?,tone),
    language=COALESCE(?,language), model=COALESCE(?,model), thinking_level=COALESCE(?,thinking_level), updated_at=? WHERE id=?`)
    .run(body.name !== undefined ? String(body.name).trim().slice(0, 120) : null, body.systemPrompt !== undefined ? String(body.systemPrompt).slice(0, 8000) : null,
      body.tone !== undefined ? String(body.tone).slice(0, 300) : null, body.language !== undefined ? (body.language === "en" ? "en" : "id") : null,
      model ?? null, thinkingLevel ?? null, new Date().toISOString(), existing.id);
  return { persona: db.prepare("SELECT id,name,system_prompt AS systemPrompt,tone,language,model,thinking_level AS thinkingLevel,is_default AS isDefault,use_count AS useCount,created_at AS createdAt,updated_at AS updatedAt FROM agent_personas WHERE id=?").get(existing.id) };
});

app.delete<{ Params: { personaId: string } }>("/api/v1/personas/:personaId", { preHandler: requireUser }, async (request: any, reply) => {
  const existing = db.prepare("SELECT id,user_id AS userId FROM agent_personas WHERE id=?").get(request.params.personaId) as { id: string; userId: string } | undefined;
  if (!existing || existing.userId !== request.user!.id) return reply.code(404).send({ error: "PERSONA_NOT_FOUND" });
  db.prepare("DELETE FROM agent_personas WHERE id=?").run(existing.id);
  db.prepare("UPDATE users SET default_persona_id=NULL WHERE id=? AND default_persona_id=?").run(request.user!.id, existing.id);
  // Conversations that used it fall back to the user default persona.
  db.prepare("UPDATE conversations SET persona_id=NULL WHERE persona_id=?").run(existing.id);
  return { deleted: true };
});

app.post<{ Params: { personaId: string } }>("/api/v1/personas/:personaId/default", { preHandler: requireUser }, async (request: any, reply) => {
  const existing = db.prepare("SELECT id,user_id AS userId FROM agent_personas WHERE id=?").get(request.params.personaId) as { id: string; userId: string } | undefined;
  if (!existing || existing.userId !== request.user!.id) return reply.code(404).send({ error: "PERSONA_NOT_FOUND" });
  db.prepare("UPDATE agent_personas SET is_default=0 WHERE user_id=?").run(request.user!.id);
  db.prepare("UPDATE agent_personas SET is_default=1, updated_at=? WHERE id=?").run(new Date().toISOString(), existing.id);
  db.prepare("UPDATE users SET default_persona_id=? WHERE id=?").run(existing.id, request.user!.id);
  return { isDefault: true, personaId: existing.id };
});

/** Persona per conversation: the agent keeps its role when the user returns to the thread. */
app.patch<{ Params: { conversationId: string }; Body: { personaId?: string | null; title?: string } }>("/api/v1/conversations/:conversationId/persona", { preHandler: requireUser }, async (request: any, reply) => {
  const conversation = db.prepare("SELECT c.id, c.project_id AS projectId, m.role AS role FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as { id: string; projectId: string; role: string } | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  if (conversation.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  const personaId = request.body?.personaId === null || request.body?.personaId === "" ? null : String(request.body?.personaId ?? "").trim() || null;
  if (personaId) {
    const persona = db.prepare("SELECT 1 FROM agent_personas WHERE id=? AND user_id=?").get(personaId, request.user!.id);
    if (!persona) return reply.code(404).send({ error: "PERSONA_NOT_FOUND" });
  }
  db.prepare("UPDATE conversations SET persona_id=? WHERE id=?").run(personaId, conversation.id);
  return { conversationId: conversation.id, personaId };
});


// ------------------------------------------------------------
// Skills catalogue and status hub
// ------------------------------------------------------------
/** The catalogue only lists capabilities the platform really has, with the value it can prove. */
app.get("/api/v1/skills", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  const health = await engine.health();
  const catalogue = engineModelCatalogue();
  const payments = paymentConfig();
  const counts = {
    memories: Number((db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=?").get(userId) as { n: number }).n),
    templates: Number((db.prepare("SELECT COUNT(*) AS n FROM prompt_templates WHERE user_id=?").get(userId) as { n: number }).n),
    personas: Number((db.prepare("SELECT COUNT(*) AS n FROM agent_personas WHERE user_id=?").get(userId) as { n: number }).n),
    knowledge: Number((db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents d JOIN projects p ON p.id=d.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?").get(userId) as { n: number }).n),
    artifacts: Number((db.prepare("SELECT COUNT(*) AS n FROM artifacts a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?").get(userId) as { n: number }).n),
    workflows: Number((db.prepare("SELECT COUNT(*) AS n FROM workflows w JOIN projects p ON p.id=w.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?").get(userId) as { n: number }).n),
    conversations: Number((db.prepare("SELECT COUNT(*) AS n FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?").get(userId) as { n: number }).n),
  };
  const skills = [
    { key: "engine", name: "Mesin AI", available: health.available, detail: health.available ? `terhubung (${health.version ?? "versi tidak dilaporkan"})` : "tidak terhubung", needs: health.available ? null : "mesin agen harus hidup", group: "Inti" },
    { key: "models", name: "Katalog model", available: catalogue.models.length > 0, detail: `${catalogue.models.length} model terdaftar`, needs: catalogue.models.length ? null : "katalog mesin kosong", group: "Inti" },
    { key: "thinking", name: "Tingkat penalaran", available: true, detail: `pilihan: ${THINKING_LEVELS.join(", ")}`, needs: null, group: "Penghemat token" },
    { key: "tools", name: "Allowlist alat", available: true, detail: "atur daftar alat, atau matikan semua alat", needs: null, group: "Penghemat token" },
    { key: "compact", name: "Pemadatan percakapan", available: true, detail: `otomatis setelah ${agentSettings(userId).compact_after_messages} pesan (bisa diatur)`, needs: null, group: "Penghemat token" },
    { key: "autonomous", name: "Mode otonom", available: true, detail: "mesin lanjut sampai batas langkah dan token", needs: null, group: "Eksekusi" },
    { key: "memory", name: "Bank memori", available: true, detail: `${counts.memories} catatan aktif`, needs: null, group: "Konteks" },
    { key: "templates", name: "Template prompt & slash", available: true, detail: `${counts.templates} template`, needs: null, group: "Konteks" },
    { key: "personas", name: "Persona agen", available: true, detail: `${counts.personas} persona`, needs: null, group: "Konteks" },
    { key: "knowledge", name: "Pencarian pengetahuan (FTS5)", available: true, detail: `${counts.knowledge} dokumen terindeks`, needs: null, group: "Konteks" },
    { key: "chat", name: "Percakapan + lampiran", available: true, detail: `${counts.conversations} percakapan milik Anda`, needs: null, group: "Kerja" },
    { key: "artifacts", name: "Artefak & unduhan", available: true, detail: `${counts.artifacts} artefak`, needs: null, group: "Kerja" },
    { key: "workflows", name: "Workflow + gerbang persetujuan", available: true, detail: `${counts.workflows} workflow`, needs: null, group: "Kerja" },
    { key: "diff", name: "Pembanding artefak (diff)", available: true, detail: "bandingkan dua artefak teks", needs: null, group: "Bukti" },
    { key: "report", name: "Laporan Markdown", available: true, detail: "percakapan atau proyek", needs: null, group: "Bukti" },
    { key: "status", name: "Status hub", available: true, detail: "kesehatan mesin, basis data, dan penyimpanan", needs: null, group: "Ops" },
    { key: "mail", name: "Surat transaksional", available: mailerConfigured(), detail: mailerConfigured() ? `pengirim ${config.SMTP_FROM}` : "SMTP belum diisi", needs: mailerConfigured() ? null : "kredensial SMTP", group: "Ops" },
    { key: "gateway", name: "Gateway pembayaran", available: payments.xenditEnabled || payments.midtransEnabled, detail: payments.xenditEnabled || payments.midtransEnabled ? `aktif: ${payments.gateway}` : "belum aktif", needs: payments.xenditEnabled || payments.midtransEnabled ? null : "kunci Xendit/Midtrans", group: "Ops" },
    { key: "manual_payment", name: "Transfer manual + bukti", available: true, detail: "pesanan manual dan unggah bukti", needs: null, group: "Komersial" },
    { key: "quota", name: "Kuota token & kredit", available: true, detail: `${quotaState(userId).usedToday ?? 0} token terpakai hari ini`, needs: null, group: "Komersial" },
    { key: "pwa", name: "PWA (bisa dipasang)", available: true, detail: "manifest + ikon 192/512/maskable", needs: null, group: "Antarmuka" },
    { key: "theme_palette", name: "Tema & palet perintah", available: true, detail: "tema terang/gelap, Ctrl+K", needs: null, group: "Antarmuka" },
  ];
  const groups = [...new Set(skills.map((skill) => skill.group))];
  return { skills, groups, engine: health, storage: { data: await dirStats(config.DATA_DIR), engineSessions: await dirStats(config.ENGINE_ROOT_DIR) } };
});

/* ---------------------------------------------------------------------------
 * Wave 7: growth. Onboarding, the referral programme, honest quota warnings,
 * the admin growth view, and the public files search engines look for.
 * ------------------------------------------------------------------------- */

const referralLimiter = limiterFor("referral");

/** One row per first-time step, so the Home card can point at the next useful action. */
function onboardingStepsFor(userId: string) {
  const one = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  const emailVerified = Number((db.prepare("SELECT email_verified AS v FROM users WHERE id=?").get(userId) as { v: number } | undefined)?.v ?? 0) === 1;
  const projects = one("SELECT COUNT(*) AS n FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?", userId);
  const conversations = one("SELECT COUNT(*) AS n FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?", userId);
  const runsDone = one("SELECT COUNT(*) AS n FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=? AND r.status='completed'", userId);
  const keys = one("SELECT COUNT(*) AS n FROM api_keys WHERE user_id=? AND revoked_at IS NULL", userId);
  const teammates = one("SELECT COUNT(*) AS n FROM memberships m WHERE m.workspace_id IN (SELECT workspace_id FROM memberships WHERE user_id=?) AND m.user_id<>?", userId, userId);
  const steps = [
    { key: "verify_email", label: "Verifikasi email", done: emailVerified, hint: "Buka tautan verifikasi di kotak masuk Anda.", link: "/" },
    { key: "first_project", label: "Buat proyek pertama", done: projects > 0, hint: "Proyek adalah tempat percakapan dan berkas berkumpul.", link: "/projects" },
    { key: "first_conversation", label: "Mulai percakapan", done: conversations > 0, hint: "Tulis permintaan pertama Anda, sekecil apa pun.", link: "/projects" },
    { key: "first_run", label: "Selesaikan satu run AI", done: runsDone > 0, hint: "Run pertama biasanya selesai di bawah satu menit.", link: "/projects" },
    { key: "connect_team_or_key", label: "Undang tim atau buat kunci API", done: teammates > 0 || keys > 0, hint: "Bagikan akses lewat Tim, atau pakai kunci API untuk otomatisasi.", link: "/team" },
  ];
  const done = steps.filter((step) => step.done).length;
  const dismissed = Boolean(db.prepare("SELECT dismissed_at AS d FROM onboarding_state WHERE user_id=?").get(userId));
  return {
    steps, done, total: steps.length,
    percent: Math.round((done / steps.length) * 100),
    nextStep: steps.find((step) => !step.done)?.key ?? null,
    complete: done === steps.length,
    dismissed,
    counts: { projects, conversations, runsDone, keys, teammates, emailVerified },
  };
}

/** The referral panel of the signed-in account. The code is created on first view. */
app.get("/api/v1/referrals/me", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  return { ...referralSummaryFor(userId), invitedBy: referralEntryFor(userId), site: config.PUBLIC_BASE_URL };
});

app.get<{ Querystring: { limit?: string } }>("/api/v1/referrals", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  const limit = Number(request.query?.limit ?? 100);
  return {
    code: ensureReferralCode(userId),
    referrals: listReferralsFor(userId, Number.isFinite(limit) ? limit : 100),
    invitedBy: referralEntryFor(userId),
    limits: referralLimits(),
  };
});

/** A fresh code invalidates older links. Limited so it cannot be used as a free random generator. */
app.post("/api/v1/referrals/code", { preHandler: requireUser }, async (request: any, reply) => {
  const userId = request.user!.id;
  if (!referralLimiter.allow(`ref:${userId}`)) {
    return reply.code(429).send({ error: "RATE_LIMITED", message: `Terlalu sering. Coba lagi dalam ${referralLimiter.retryAfterSeconds(`ref:${userId}`)} detik.` });
  }
  const code = rotateReferralCode(userId);
  recordAudit(null, userId, "referral.code_rotated", { code });
  return { code, link: `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/?ref=${code}` };
});

/** The invitation the signed-in account arrived with, including a pending reward. */
app.get("/api/v1/onboarding", { preHandler: requireUser }, async (request: any) => onboardingStepsFor(request.user!.id));

app.post("/api/v1/onboarding/dismiss", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO onboarding_state (user_id, dismissed_at, updated_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET dismissed_at=excluded.dismissed_at, updated_at=excluded.updated_at`).run(userId, now, now);
  const state = onboardingStepsFor(userId);
  if (state.complete) recordGrowthEvent("onboarding_completed", { userId });
  return { dismissed: true, onboarding: state };
});

/** An honest quota warning: real numbers, no invented scarcity. It drives the small shell banner. */
app.get("/api/v1/billing/quota-alert", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  const quota = quotaState(userId);
  const share = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);
  const dayPercent = share(quota.usedToday, quota.dailyLimit);
  const monthPercent = share(quota.usedMonth, quota.monthlyLimit);
  const percent = Math.max(dayPercent, monthPercent);
  const level = quota.blocked ? "exceeded" : percent >= 95 ? "critical" : percent >= 80 ? "warning" : "ok";
  const messages: Record<string, string> = {
    ok: "Pemakaian token masih longgar.",
    warning: `Pemakaian token sudah ${percent}% dari batas paket ${quota.tier}.`,
    critical: `Pemakaian token sudah ${percent}% dari batas paket ${quota.tier}. Sisa sedikit.`,
    exceeded: `Batas paket ${quota.tier} sudah terpakai penuh. Run berikutnya akan ditolak sampai batas direset atau paket dinaikkan.`,
  };
  return {
    level, percent, dayPercent, monthPercent,
    usedToday: quota.usedToday, dailyLimit: quota.dailyLimit, usedMonth: quota.usedMonth, monthlyLimit: quota.monthlyLimit,
    remainingToday: quota.remainingToday, remainingMonth: quota.remainingMonth,
    creditTokens: quota.creditTokens, tier: quota.tier, blocked: quota.blocked, reason: quota.reason,
    message: messages[level], packagePath: "/paket", refreshSeconds: 300,
  };
});

/** Platform-wide growth numbers. Administrators only: the funnel is business information. */
app.get<{ Querystring: { days?: string } }>("/api/v1/admin/growth", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat angka pertumbuhan." });
  const asked = Number(request.query?.days ?? config.GROWTH_WINDOW_DAYS);
  const days = Number.isFinite(asked) && asked > 0 ? Math.min(365, Math.round(asked)) : config.GROWTH_WINDOW_DAYS;
  const overview = growthOverview(days);
  return {
    ...overview,
    windowDays: days,
    referrals: referralStats(),
    leaderboard: referralLeaderboard(10),
    referralLimits: referralLimits(),
  };
});

app.get<{ Querystring: { limit?: string } }>("/api/v1/admin/referrals", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat daftar undangan." });
  const asked = Number(request.query?.limit ?? 100);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(500, Math.round(asked)) : 100;
  return { stats: referralStats(), leaderboard: referralLeaderboard(10), referrals: listReferralsAdmin(limit) };
});

/** Public catalogue of the write and read API. No session and no secret: it is documentation. */
app.get("/api/v1/public/docs", async () => ({
  product: "COBLAI Coder",
  baseUrl: `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/v1/public/v1`,
  version: process.env.APP_VERSION ?? null,
  auth: {
    scheme: "ApiKey",
    header: "Authorization",
    example: "Authorization: ApiKey ck_...",
    scopes: ["read", "write"],
    note: "Kunci dibuat di halaman Kunci API. Nilai kunci hanya tampil sekali saat dibuat.",
  },
  endpoints: PUBLIC_API_ENDPOINTS,
  limits: PUBLIC_API_LIMITS(),
  webhook: {
    enabled: true,
    events: webhookCatalogue().map((item) => item.event),
    signatureHeader: "x-coblai-signature",
    signatureFormat: "sha256=<hmac sha256 dari '<timestamp>.<body json>'>",
    headers: ["x-coblai-event", "x-coblai-delivery", "x-coblai-timestamp", "x-coblai-signature"],
    retries: { attempts: config.WEBHOOK_MAX_ATTEMPTS, timeoutMs: config.WEBHOOK_DELIVERY_TIMEOUT_MS, backoffSeconds: "5 x percobaan" },
  },
  errors: [
    { code: "API_KEY_REQUIRED", meaning: "Header Authorization tidak memuat kunci yang dikenal." },
    { code: "API_KEY_SCOPE_REQUIRED", meaning: "Kunci tidak punya izin yang dibutuhkan rute ini." },
    { code: "API_KEY_RATE_LIMITED", meaning: "Terlalu banyak permintaan per menit untuk kunci ini." },
    { code: "API_KEY_DAILY_REQUEST_LIMIT", meaning: "Batas jumlah permintaan harian kunci sudah tercapai." },
    { code: "API_KEY_DAILY_TOKEN_LIMIT", meaning: "Batas token harian kunci sudah tercapai." },
  ],
  page: `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/docs`,
}));

/** Search engines: the public pages only. The application shell is private. */
app.get("/robots.txt", async (_request, reply) => reply.type("text/plain; charset=utf-8").send(
  [`User-agent: *`, `Allow: /$`, `Allow: /harga`, `Allow: /docs`, `Disallow: /api/`, `Sitemap: ${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/sitemap.xml`, ""].join("\n"),
));

app.get("/sitemap.xml", async (_request, reply) => {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const today = new Date().toISOString().slice(0, 10);
  const urls = ["/", "/harga", "/docs"];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((path) => `  <url><loc>${base}${path}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq></url>`).join("\n")
    + `\n</urlset>\n`;
  return reply.type("application/xml; charset=utf-8").send(body);
});

/** One screen with the platform health an operator needs, all values read from the running system. */
app.get("/api/v1/status-hub", { preHandler: requireUser }, async (request: any) => {
  const userId = request.user!.id;
  const health = await engine.health();
  const startedAt = Date.now();
  let databaseOk = false; let databaseDetail = "";
  try {
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    databaseDetail = String(row ? Object.values(row)[0] ?? "" : "");
    databaseOk = databaseDetail.toLowerCase() === "ok";
  } catch (error) { databaseDetail = error instanceof Error ? error.message : "unknown"; }
  const migrations = db.prepare("SELECT version, note, applied_at AS appliedAt FROM schema_migrations ORDER BY version DESC LIMIT 5").all();
  const tables = Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n);
  const counts = {
    users: Number((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n),
    workspaces: Number((db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number }).n),
    projects: Number((db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n),
    conversations: Number((db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n),
    messages: Number((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n),
    runs: Number((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n),
    failedRuns: Number((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='failed'").get() as { n: number }).n),
    artifacts: Number((db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n),
    orders: Number((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n),
    pendingOrders: Number((db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending'").get() as { n: number }).n),
  };
  const todayTokens = Number((db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS n FROM run_usage WHERE created_at >= ?").get(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) as { n: number }).n);
  const payments = paymentConfig();
  const catalogue = engineModelCatalogue();
  const lastRuns = db.prepare("SELECT r.id, r.status, r.model, r.error_code AS errorCode, r.created_at AS createdAt, r.finished_at AS finishedAt, u.cost_micros AS costMicros FROM runs r LEFT JOIN run_usage u ON u.run_id=r.id ORDER BY r.created_at DESC LIMIT 10").all();
  return {
    version: process.env.APP_VERSION ?? process.env.npm_package_version ?? null,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    engine: { ...health, models: catalogue.models.length, note: catalogue.note ?? null, error: catalogue.error ?? null },
    database: { ok: databaseOk, detail: databaseDetail, tables, migrations },
    counts,
    money: { todayTokens, payments: { gateway: payments.gateway, xenditEnabled: payments.xenditEnabled, midtransEnabled: payments.midtransEnabled, xenditConfigured: payments.xenditConfigured, midtransConfigured: payments.midtransConfigured } },
    /** Wave 9 (item 19): the price console state, so an operator can see the resale margin at a glance. */
    aiPricing: (() => {
      const settings = pricingSettings();
      const table = pricingTable({ days: 30, limit: 1, only: "used" });
      // Butir 19: jumlah harga resmi vendor yang menimpa katalog mesin, supaya bisa diperiksa dari luar.
      const vendor = vendorPriceCatalogue();
      const reconciled = reconcileUsage(30, 5);
      return { reconciliation: reconciled.totals, reconciliationRows: reconciled.rows, markup: settings.markup, currency: settings.currency, updatedAt: settings.updatedAt, overrideCount: table.overrideCount, catalogSize: table.catalogSize, costMicros30d: table.totals.baseMicros, billedMicros30d: table.totals.sellMicros, marginMicros30d: table.totals.marginMicros, vendorPrices: vendor.length, vendorCheckedAt: vendor[0]?.price.checkedAt ?? null, vendorModels: vendor.map((row) => row.model) };
    })(),
    mail: { configured: mailerConfigured(), from: config.SMTP_FROM, host: config.SMTP_HOST ? `${config.SMTP_HOST}:${config.SMTP_PORT}` : null, secure: config.SMTP_SECURE },
    security: { csrfStrict: config.CSRF_STRICT, sessionCookie: "httpOnly", adminEmails: config.PLATFORM_ADMIN_EMAILS.split(",").map((item) => item.trim()).filter(Boolean).length, metricsEnabled: Boolean(config.METRICS_TOKEN),
      /** Wave 8: whether an unverified email blocks AI work, and why. */
      verifyEmailRequired: verificationRequired(), verifyEmailMode: config.VERIFY_EMAIL_REQUIRED },
    limits: { dailyCostMicros: config.DEFAULT_DAILY_COST_LIMIT_MICROS, monthlyCostMicros: config.DEFAULT_MONTHLY_COST_LIMIT_MICROS, runsPerHour: config.DEFAULT_RUNS_PER_HOUR_LIMIT, engineTimeoutMs: config.ENGINE_TIMEOUT_MS },
    openPlatform: {
      activeKeys: Number((db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").get() as { n: number }).n),
      publicEndpoints: PUBLIC_API_ENDPOINTS.filter((endpoint) => endpoint.available).length,
      publicEndpointsPlanned: PUBLIC_API_ENDPOINTS.filter((endpoint) => !endpoint.available).length,
      emailOutbox: outboxStats(),
      emailWorker: emailWorkerState(),
      retention: retentionPolicy(),
      /** Wave 8: where the rate limit counters live and how the closed account window works. */
      rateLimits: rateLimitStorage(),
      closedAccounts: (() => { const rows = closedAccounts(); return { waiting: rows.waiting.length, due: rows.due.length, recoveryDays: ACCOUNT_RECOVERY_DAYS }; })(),
      readyExports: Number((db.prepare("SELECT COUNT(*) AS n FROM data_exports WHERE status='ready'").get() as { n: number }).n),
      emailEnabled: emailEnabled(),
      /** Wave 6: outgoing webhooks and the per-key ceilings of the public API. */
      webhooks: webhookStats(),
      keyLimits: PUBLIC_API_LIMITS(),
      webhookAllowLocal: config.WEBHOOK_ALLOW_LOCAL,
      /** Wave 7: the referral programme and the event log that feeds the growth screen. */
      referrals: referralStats(),
      referralLimits: referralLimits(),
      growthEvents: Number((db.prepare("SELECT COUNT(*) AS n FROM growth_events").get() as { n: number }).n),
      growthWindowDays: config.GROWTH_WINDOW_DAYS,
      /** Wave 10 (item 25/32C): where the recorded events came from, so a backfill is visible here. */
      growthSources: growthEventSources(),
    },
    /** Wave 10 (item 29): the state of the message index and the search limits. */
    search: { ...searchStats(), kinds: SEARCH_KINDS.length, maxResults: config.SEARCH_MAX_RESULTS },
    /** Wave 10 (item 31): browser push, next to the email channel that already exists. */
    push: { ...pushStats(), enabled: config.PUSH_ENABLED, subject: config.PUSH_SUBJECT, maxPerUser: config.PUSH_MAX_PER_USER },
    /** Wave 10 (item 26/32B): the sign-in devices and the optional gate. */
    devices: { ...deviceSummary(), tracking: config.DEVICE_TRACKING, mode: config.DEVICE_VERIFY_NEW, verifyRequired: deviceVerifyRequired(), maxPerUser: config.DEVICE_MAX_PER_USER },
    /** Wave 10 (items 23 and 27): what the scheduled clean-up would remove, and whether it really deletes. */
    housekeeping: {
      retentionDryRun: config.RETENTION_DRY_RUN, webhookDays: config.RETENTION_WEBHOOK_DAYS,
      smokeCleanup: config.SMOKE_CLEANUP_ENABLED, smokeHours: config.SMOKE_CLEANUP_HOURS, smokeAccount: config.SMOKE_ACCOUNT_EMAIL,
      reservedTokensWaiting: Number((db.prepare("SELECT COALESCE(SUM(COALESCE(reserved_tokens,0)),0) AS n FROM runs WHERE status IN ('queued','running')").get() as { n: number }).n),
    },
    /** Wave 5: the durable queue. These numbers say whether background work is keeping up. */
    backgroundWork: {
      queue: jobStats(),
      worker: jobWorkerState(),
      reapOnBoot: config.JOB_REAP_ON_BOOT,
      leaseMs: config.JOB_LEASE_MS,
      orphanAfterMs: config.JOB_ORPHAN_AFTER_MS,
    },
    storage: { data: await dirStats(config.DATA_DIR), engineSessions: await dirStats(config.ENGINE_ROOT_DIR) },
    lastRuns,
    backup: { note: "Cadangan otomatis dijalankan cron 03:17 di host (di luar container), jadi isi direktori cadangan tidak bisa dibaca dari sini.", cron: "17 3 * * *" },
    queue: { pendingOrders: counts.pendingOrders },
  };
});

// ------------------------------------------------------------
// Playground
// ------------------------------------------------------------
/** Runs one prompt without a project, for trying a model, a persona, or a thinking level. */
app.post<{ Body: { prompt?: string; model?: string; thinking?: string; personaId?: string; useMemory?: boolean; autonomous?: boolean } }>("/api/v1/playground/run", { preHandler: requireUser }, async (request: any, reply) => {
  const prompt = String(request.body?.prompt ?? "").trim();
  if (!prompt || prompt.length > 8000) return reply.code(400).send({ error: "INVALID_PROMPT", message: "Tulis pertanyaan 1-8000 karakter." });
  const userId = request.user!.id;
  const quotaBlock = quotaGuard(userId, "");
  if (quotaBlock) return reply.code(quotaBlock.status).send({ error: quotaBlock.error, ...(quotaBlock.detail ?? {}) });
  // Wave 11A (butir 45): playground pun menolak pesan yang mencoba mengubah instruksi dasar.
  if (config.PROMPT_GUARD_ENABLED) {
    const hijack = scanPromptHijack(prompt);
    if (hijack.blocked) {
      recordAudit(null, userId, "prompt_hijack_blocked", { asal: "playground", pola: hijack.pattern, kategori: hijack.category, kutipan: hijack.snippet, panjangPesan: prompt.length });
      return reply.code(400).send({ error: "PROMPT_BLOCKED", message: hijackMessage(hijack.pattern), pola: hijack.pattern, kategori: hijack.category });
    }
  }
  const settings = agentSettings(userId);
  const thinking = isThinkingLevel(request.body?.thinking) ? String(request.body?.thinking) : settings.thinking_level;
  const model = request.body?.model?.trim() || undefined;
  if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
  const blocks = request.body?.useMemory === false ? [] : systemBlocksFor(userId, request.body?.personaId ?? null, null);
  const autonomous = Boolean(request.body?.autonomous);
  const sessionId = randomUUID(); const started = Date.now();
  const playgroundRunId = randomUUID();
  // The playground is a real engine call, so it must honour the same tool allowlist as a chat run.
  const playgroundTools = parseToolsAllow(settings.tools_allow);
  let text = ""; let usage: unknown = null;
  // Wave 11A (butir 57): jalur sinkron ini pun berpindah ke model cadangan saat galat sementara, dan
  // melaporkan 502 ENGINE_UNAVAILABLE bila semua percobaan habis.
  const primaryPlaygroundModel = model || config.PRIME_AGENT_MODEL || "default";
  let modelDipakai = primaryPlaygroundModel;
  let pindahModel = 0;
  try {
    const outcome = await runWithModelFallback({
      primary: primaryPlaygroundModel,
      fallbacks: fallbackModelsFor(userId),
      maxSwitches: Math.min(config.ENGINE_FALLBACK_MAX_SWITCHES, MAX_FALLBACK_SWITCHES),
      consume: async (attempt) => {
        let attemptText = ""; let attemptUsage: unknown = null;
        for await (const event of engine.run({
          runId: playgroundRunId, sessionId, prompt,
          model: attempt, provider: providerForModel(attempt),
          thinking, appendSystem: blocks, tools: playgroundTools ?? undefined,
          autonomous: autonomous ? { maxTurns: settings.autonomous_max_turns, maxTokens: settings.autonomous_max_tokens } : undefined,
        })) {
          if (event.type === "text") attemptText += typeof event.data === "string" ? event.data : "";
          if (event.type === "completed") attemptUsage = (event.data as { usage?: unknown })?.usage ?? null;
          if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "ENGINE_FAILED"));
        }
        return { text: attemptText, usage: attemptUsage };
      },
      onFallback: (dari, ke, alasan) => recordAudit(null, userId, "playground.model_fallback", { dari, ke, alasan: alasan.slice(0, 200) }),
    });
    text = outcome.text; usage = outcome.usage; modelDipakai = outcome.model; pindahModel = outcome.switches;
  } catch (error) {
    const pesan = error instanceof Error ? error.message : "Mesin gagal menjawab.";
    if (pesan === "ENGINE_UNAVAILABLE") return reply.code(502).send({ error: "ENGINE_UNAVAILABLE", message: "Model utama dan semua model cadangan gagal karena galat sementara (429/5xx/timeout). Coba lagi sebentar lagi atau ganti model." });
    return reply.code(502).send({ error: "PLAYGROUND_FAILED", message: pesan });
  }
  const reported = usage as { totalTokens?: number; inputTokens?: number; outputTokens?: number; model?: string } | null;
  const tokens = Math.round(Number(reported?.totalTokens ?? 0) || Math.ceil(prompt.length / 4) + Math.ceil(text.length / 4));
  // A playground call has no project, so run_usage cannot hold it; user_usage makes the tokens visible
  // to quotaState() and to the usage figures. Without this row the call was free and unreported.
  const reportedTokens = typeof reported?.totalTokens === "number" || typeof reported?.inputTokens === "number" || typeof reported?.outputTokens === "number";
  const usageModel = typeof reported?.model === "string" ? reported.model : modelDipakai;
  const inputTokens = reportedTokens ? Math.round(reported?.inputTokens ?? 0) : Math.ceil(prompt.length / 4);
  const outputTokens = reportedTokens ? Math.round(reported?.outputTokens ?? 0) : Math.ceil(text.length / 4);
  const playgroundQuote = quoteCosts(usageModel, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const costMicros = playgroundQuote.baseMicros;
  const sellCostMicros = sellForBaseMicros(costMicros, playgroundQuote.markup);
  db.prepare("INSERT INTO user_usage (id,user_id,run_id,source,model,provider,input_tokens,output_tokens,total_tokens,cost_micros,sell_cost_micros,estimated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), userId, playgroundRunId, "playground", usageModel, usageModel ? providerForModel(usageModel) : config.PRIME_AGENT_PROVIDER ?? null, inputTokens, outputTokens, tokens, costMicros, sellCostMicros, reportedTokens ? 0 : 1, new Date().toISOString());
  chargeQuota(userId, tokens);
  return { text, usage, thinking, autonomous, model: usageModel, modelUtama: primaryPlaygroundModel, pindahModel, systemBlocks: blocks.length, tools: playgroundTools ?? null, tokens, durationMs: Date.now() - started, sessionId };
});

// ------------------------------------------------------------
// Compaction
// ------------------------------------------------------------
app.post<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/compact", { preHandler: requireUser }, async (request: any, reply) => {
  const conversation = db.prepare("SELECT c.id, c.project_id AS projectId, p.workspace_id AS workspaceId, m.role AS role FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as { id: string; projectId: string; workspaceId: string; role: string } | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  if (conversation.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  // Compacting an empty conversation would spend engine tokens on a meaningless summary and rotate the
  // engine session for nothing, so it is refused before any work happens.
  const existing = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(conversation.id) as { n: number };
  if (existing.n === 0) return reply.code(400).send({ error: "NO_MESSAGES_TO_COMPACT", message: "Percakapan ini belum punya pesan untuk diringkas." });
  const result = await compactConversation(conversation.id, request.user!.id);
  if (!result) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  recordAudit(conversation.workspaceId, request.user!.id, "conversation.compacted", { conversationId: conversation.id, messagesCovered: result.messagesCovered, charsBefore: result.charsBefore, charsAfter: result.charsAfter, source: result.source });
  return { compacted: true, ...result };
});

app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/summaries", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  const summaries = db.prepare("SELECT id, summary, messages_covered AS messagesCovered, chars_before AS charsBefore, chars_after AS charsAfter, created_at AS createdAt FROM conversation_summaries WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20").all(request.params.conversationId);
  const conversation = db.prepare("SELECT engine_session_id AS engineSessionId, compacted_at AS compactedAt FROM conversations WHERE id=?").get(request.params.conversationId);
  return { summaries, conversation, messages: messageCount(request.params.conversationId) };
});

// ------------------------------------------------------------
// Agent map: conversations, engine sessions, and the run tree
// ------------------------------------------------------------
app.get<{ Querystring: { limit?: string } }>("/api/v1/agents/map", { preHandler: requireUser }, async (request: any) => {
  const limit = Math.min(Math.max(Number(request.query?.limit ?? 30) || 30, 1), 100);
  const rows = db.prepare(`SELECT c.id, c.title, c.updated_at AS updatedAt, c.engine_session_id AS engineSessionId, c.compacted_at AS compactedAt,
      c.persona_id AS personaId, p.id AS projectId, p.name AS projectName, w.name AS workspaceName,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS messages,
      (SELECT COUNT(*) FROM conversation_summaries s WHERE s.conversation_id=c.id) AS summaries
    FROM conversations c JOIN projects p ON p.id=c.project_id JOIN workspaces w ON w.id=p.workspace_id
    JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE m.user_id=? ORDER BY c.updated_at DESC LIMIT ?`).all(request.user!.id, limit) as any[];
  const sessions = [];
  for (const row of rows) {
    sessions.push({
      conversationId: row.id, title: row.title, projectId: row.projectId, projectName: row.projectName, workspaceName: row.workspaceName,
      updatedAt: row.updatedAt, messages: row.messages, summaries: row.summaries, compactedAt: row.compactedAt, personaId: row.personaId,
      engineSessionId: row.engineSessionId ?? null,
      engineSession: row.engineSessionId ? await dirStats(join(config.ENGINE_ROOT_DIR, row.engineSessionId)) : null,
      runs: db.prepare(`SELECT r.id, r.status, r.model, r.thinking_level AS thinkingLevel, r.autonomous, r.parent_run_id AS parentRunId,
          r.error_code AS errorCode, r.prompt_chars AS promptChars, r.append_system_chars AS appendSystemChars,
          r.created_at AS createdAt, r.finished_at AS finishedAt, COALESCE(u.total_tokens,0) AS totalTokens
        FROM runs r LEFT JOIN run_usage u ON u.run_id=r.id
        WHERE EXISTS (SELECT 1 FROM messages m WHERE m.run_id=r.id AND m.conversation_id=?)
        ORDER BY r.created_at DESC LIMIT 10`).all(row.id),
    });
  }
  return { sessions, engine: await engine.health(), engineRoot: config.ENGINE_ROOT_DIR, rootStorage: await dirStats(config.ENGINE_ROOT_DIR), note: "Sesi mesin dipakai bergantian: percakapan yang sudah dipadatkan memakai sesi baru." };
});

// ------------------------------------------------------------
// Artifact diff
// ------------------------------------------------------------
app.get<{ Params: { artifactId: string; otherId: string }; Querystring: { context?: string } }>("/api/v1/artifacts/:artifactId/diff/:otherId", { preHandler: requireUser }, async (request: any, reply) => {
  const load = (id: string) => db.prepare(`SELECT a.id, a.name, a.mime_type AS mimeType, a.size_bytes AS sizeBytes, a.storage_path AS storagePath
    FROM artifacts a JOIN projects p ON p.id=a.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE a.id=? AND m.user_id=?`)
    .get(id, request.user!.id) as { id: string; name: string; mimeType: string; sizeBytes: number; storagePath: string } | undefined;
  const left = load(request.params.artifactId); const right = load(request.params.otherId);
  if (!left || !right) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND" });
  if (left.id === right.id) return reply.code(400).send({ error: "SAME_ARTIFACT", message: "Pilih dua artefak yang berbeda." });
  const READ_LIMIT = 400_000;
  if (left.sizeBytes > READ_LIMIT || right.sizeBytes > READ_LIMIT) return reply.code(413).send({ error: "ARTIFACT_TOO_LARGE", message: "Diff dibatasi 400 KB per artefak." });
  let leftText = ""; let rightText = "";
  try { leftText = (await readFile(left.storagePath)).toString("utf8"); rightText = (await readFile(right.storagePath)).toString("utf8"); }
  catch { return reply.code(404).send({ error: "ARTIFACT_FILE_MISSING" }); }
  const context = Math.min(Math.max(Number(request.query?.context ?? 3) || 3, 0), 20);
  return unifiedDiff(left.name, leftText, right.name, rightText, context);
});

// ------------------------------------------------------------
// Markdown report
// ------------------------------------------------------------
app.get<{ Params: { projectId: string }; Querystring: { kind?: string; conversationId?: string } }>("/api/v1/projects/:projectId/report.md", { preHandler: requireUser }, async (request: any, reply) => {
  const kind = (request.query?.kind ?? "project").toLowerCase();
  if (!["project", "conversation"].includes(kind)) return reply.code(400).send({ error: "UNKNOWN_REPORT_KIND", message: "Jenis laporan: project atau conversation." });
  const report = markdownReport(kind, request.params.projectId, request.user!.id, request.query?.conversationId);
  if (!report) return reply.code(404).send({ error: "REPORT_NOT_AVAILABLE", message: kind === "conversation" ? "Proyek ini belum punya percakapan." : "Proyek tidak ditemukan." });
  return reply
    .header("Content-Disposition", `attachment; filename="${report.filename}"`)
    .header("X-Content-Type-Options", "nosniff")
    .type("text/markdown; charset=utf-8")
    .send(report.markdown);
});

app.setErrorHandler((error: any, request: any, reply) => {
  app.log.error(error);
  const status = Number(error.statusCode) >= 400 && Number(error.statusCode) < 500 ? Number(error.statusCode) : 500;
  // Wave 11B (butir 66): galat server dicatat ke `error_events` supaya bisa ditelusuri tanpa masuk
  // ke container. Pencatatan ini gagal-aman dan melewati permintaan yang jelas bukan galat server;
  // pesannya disaring dulu oleh recordErrorEvent sebelum disimpan.
  if (status >= 500) {
    recordErrorEvent({
      kind: "server", code: String(error?.code ?? error?.name ?? "INTERNAL_ERROR"), message: String(error?.message ?? error),
      userId: request?.user?.id ?? null, runId: request?.params?.runId ?? null,
    });
  }
  return reply.code(status).send({ error: status < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR" });
});

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

// ---------------------------------------------------------------- public API keys (Wave 4)
// A key is a Bearer token for scripts and third parties. Only its hash is stored, and the public
// surface is read-only for now, so a leaked key can never change data.

const API_KEY_NAME_MIN = 2;
const API_KEY_NAME_MAX = 60;

type ApiAuth = { key: ApiKeyRow; userId: string; email: string; displayName: string | null; workspaceId: string; workspaceName: string; role: string };

/** Rejects a request unless it carries a valid, unrevoked key with the needed scope. */
function requireApiKey(scope: ApiScope) {
  return async (request: any, reply: any) => {
    const header = String(request.headers?.authorization ?? "");
    const raw = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!raw) return reply.code(401).send({ error: "API_KEY_REQUIRED", message: "Sertakan header Authorization: Bearer <kunci>." });
    const auth = authenticateApiKey(raw);
    if (!auth) return reply.code(401).send({ error: "API_KEY_INVALID", message: "Kunci API tidak dikenal, sudah dicabut, atau keanggotaan workspace-nya hilang." });
    if (!hasScope(auth.key as any, scope)) return reply.code(403).send({ error: "API_KEY_SCOPE_REQUIRED", message: `Kunci ini tidak punya izin "${scope}".` });
    // Wave 6: the daily ceiling of the key is checked before any work is done. The account tier ceiling
    // is checked again inside the write routes, so a generous key cannot push the owner past the tier.
    const daily = checkApiKeyDailyQuota(auth.key as any);
    if (daily) return reply.code(daily.status).send({ error: daily.error, ...daily.detail });
    const rate = checkApiKeyRate(auth.key.id);
    if (!rate.allowed) return reply.code(429).send({ error: "API_KEY_RATE_LIMITED", message: `Batas ${rate.limit} permintaan per menit untuk kunci ini terlampaui.` });
    (request as any).apiAuth = auth;
    touchApiKey(auth.key.id, request.ip ?? null);
    countApiKeyRequest(auth.key.id);
  };
}

/** Every public endpoint works inside the workspace the key is bound to. */
function apiProjectFor(auth: ApiAuth, projectId: string) {
  return db.prepare("SELECT id, workspace_id AS workspaceId, name, created_at AS createdAt FROM projects WHERE id=? AND workspace_id=?").get(projectId, auth.workspaceId) as { id: string; workspaceId: string; name: string; createdAt: string } | undefined;
}

function apiConversationFor(auth: ApiAuth, conversationId: string) {
  return db.prepare(`SELECT c.id, c.project_id AS projectId, c.title, c.created_at AS createdAt
      FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=? AND p.workspace_id=?`).get(conversationId, auth.workspaceId) as { id: string; projectId: string; title: string; createdAt: string } | undefined;
}

app.get("/api/v1/api-keys", { preHandler: requireUser }, async (request: any) => {
  // Wave 6: every key reports what it spent today, so a per-key ceiling can be chosen with real numbers.
  const keys = listApiKeys(request.user!.id, request.query?.workspaceId ?? null)
    .map((key) => ({
      ...key, tokensToday: apiKeyTokensToday(key.id),
      // Wave 10 (item 24): runs that are still working already hold part of today's token ceiling, so
      // the number a caller sees matches the number the quota check uses.
      tokensReserved: apiKeyReservedTokens(key.id),
      quota: apiKeyQuotaSnapshot(key),
      inFlight: apiKeyInFlight(key.id),
    }));
  return {
    keys,
    // The raw value is never returned again, only the visible prefix helps to identify a key.
    note: "Nilai kunci hanya ditampilkan sekali saat dibuat. Yang tersimpan adalah hash-nya.",
    limits: PUBLIC_API_LIMITS(),
    scopesAvailable: ["read", "write"],
  };
});

app.get("/api/v1/api-keys/docs", { preHandler: requireUser }, async () => ({
  prefix: API_KEY_PREFIX,
  scopes: ["read", "write"],
  phase: "baca dan tulis",
  rateLimitPerMinute: config.API_KEY_RATE_LIMIT_PER_MINUTE,
  limits: PUBLIC_API_LIMITS(),
  endpoints: PUBLIC_API_ENDPOINTS.filter((endpoint) => endpoint.available),
  // Rute yang masih direncanakan tetap dipisah. Setelah Wave 6 daftar ini kosong, dan itu memang benar.
  plannedEndpoints: PUBLIC_API_ENDPOINTS.filter((endpoint) => !endpoint.available),
  writeNote: "Rute tulis menjawab 202: pekerjaan mesin berjalan di latar, jawabannya muncul di rute pesan.",
  keyLimitsNote: "Batas per kunci (0 = tanpa batas khusus kunci) adalah lapisan kedua; kuota paket pemilik tetap berlaku.",
  webhooks: {
    events: webhookCatalogue(),
    headers: ["x-coblai-event", "x-coblai-delivery", "x-coblai-timestamp", "x-coblai-signature"],
    signature: 'x-coblai-signature berisi "sha256=<hmac sha256 dari \"<timestamp>.<body>\">" memakai rahasia webhook.',
    retry: `Percobaan ulang lewat antrean pekerjaan, maksimal ${config.WEBHOOK_MAX_ATTEMPTS} kali, jeda 5 detik dikali jumlah percobaan.`,
  },
  example: {
    curl: `curl -H "Authorization: Bearer ${API_KEY_PREFIX}_..." ${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/v1/public/v1/me`,
    writeCurl: `curl -X POST -H "Authorization: Bearer ${API_KEY_PREFIX}_..." -H "content-type: application/json" -d '{"content":"Halo"}' ${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/v1/public/v1/conversations/<conversationId>/messages`,
  },
}));

app.post<{ Body: { name?: string; scopes?: unknown; workspaceId?: string; dailyRequestLimit?: unknown; dailyTokenLimit?: unknown } }>("/api/v1/api-keys", { preHandler: requireUser }, async (request: any, reply) => {
  // Wave 8: a key can start AI work, so the same email verification rule applies here.
  // Wave 10 (item 26): and the same device rule.
  const keyGate = usageGate(request);
  if (keyGate) return reply.code(keyGate.status).send({ error: keyGate.error, message: keyGate.message });
  const name = String(request.body?.name ?? "").trim();
  if (name.length < API_KEY_NAME_MIN || name.length > API_KEY_NAME_MAX) {
    return reply.code(400).send({ error: "INVALID_KEY_NAME", message: `Nama kunci ${API_KEY_NAME_MIN}-${API_KEY_NAME_MAX} karakter.` });
  }
  const scopes = parseScopes(request.body?.scopes ?? "read");
  if (!scopes.length) return reply.code(400).send({ error: "INVALID_KEY_SCOPES", message: 'Pilih minimal satu izin: "read" atau "write".' });
  // Wave 6: "write" is served now, so it is handed out. The per-key ceilings are optional and default
  // to the platform value, which is 0 (no key specific ceiling).
  const membership = request.body?.workspaceId
    ? db.prepare("SELECT m.workspace_id AS workspaceId, m.role AS role FROM memberships m WHERE m.user_id=? AND m.workspace_id=?").get(request.user!.id, request.body.workspaceId) as { workspaceId: string; role: string } | undefined
    : db.prepare("SELECT m.workspace_id AS workspaceId, m.role AS role FROM memberships m WHERE m.user_id=? ORDER BY m.created_at ASC LIMIT 1").get(request.user!.id) as { workspaceId: string; role: string } | undefined;
  if (!membership) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND", message: "Workspace tidak ditemukan untuk akun ini." });
  if (membership.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY" });
  if (countActiveApiKeys(request.user!.id) >= MAX_API_KEYS_PER_USER) {
    return reply.code(409).send({ error: "TOO_MANY_API_KEYS", message: `Maksimal ${MAX_API_KEYS_PER_USER} kunci aktif. Cabut dulu salah satu.` });
  }
  const created = createApiKey({
    userId: request.user!.id, workspaceId: membership.workspaceId, name, scopes,
    dailyRequestLimit: request.body?.dailyRequestLimit, dailyTokenLimit: request.body?.dailyTokenLimit,
  });
  recordAudit(membership.workspaceId, request.user!.id, "api_key.created", {
    keyId: created.key.id, prefix: created.key.prefix, scopes: created.key.scopes,
    dailyRequestLimit: created.key.dailyRequestLimit, dailyTokenLimit: created.key.dailyTokenLimit,
  });
  recordGrowthEvent("api_key_created", { userId: request.user!.id, workspaceId: membership.workspaceId, props: { scopes: created.key.scopes } });
  return reply.code(201).send({ key: created.key, secret: created.raw, workspaceId: membership.workspaceId, warning: "Salin sekarang. Nilai ini tidak bisa ditampilkan lagi." });
});

app.patch<{ Params: { keyId: string }; Body: { name?: string; scopes?: unknown; dailyRequestLimit?: unknown; dailyTokenLimit?: unknown } }>("/api/v1/api-keys/:keyId", { preHandler: requireUser }, async (request: any, reply) => {
  const current = getApiKey(request.user!.id, request.params.keyId);
  if (!current) return reply.code(404).send({ error: "API_KEY_NOT_FOUND" });
  if (request.body?.name !== undefined) {
    const name = String(request.body.name).trim();
    if (name.length < API_KEY_NAME_MIN || name.length > API_KEY_NAME_MAX) return reply.code(400).send({ error: "INVALID_KEY_NAME", message: `Nama kunci ${API_KEY_NAME_MIN}-${API_KEY_NAME_MAX} karakter.` });
  }
  if (request.body?.scopes !== undefined) {
    const scopes = parseScopes(request.body.scopes);
    if (!scopes.length) return reply.code(400).send({ error: "INVALID_KEY_SCOPES", message: "Pilih minimal satu izin." });
  }
  const updated = updateApiKey(request.user!.id, request.params.keyId, {
    name: request.body?.name, scopes: request.body?.scopes,
    dailyRequestLimit: request.body?.dailyRequestLimit, dailyTokenLimit: request.body?.dailyTokenLimit,
  });
  recordAudit(current.workspaceId, request.user!.id, "api_key.updated", { keyId: current.id, scopes: updated?.scopes ?? current.scopes });
  return { key: updated };
});

app.delete<{ Params: { keyId: string } }>("/api/v1/api-keys/:keyId", { preHandler: requireUser }, async (request: any, reply) => {
  const current = getApiKey(request.user!.id, request.params.keyId);
  if (!current) return reply.code(404).send({ error: "API_KEY_NOT_FOUND" });
  // Mencabut ulang tidak boleh dilaporkan sebagai sukses: jejak pencabutan tidak berubah.
  if (current.revokedAt) return reply.code(409).send({ error: "API_KEY_ALREADY_REVOKED", message: "Kunci ini sudah dicabut.", revokedAt: current.revokedAt });
  revokeApiKey(request.user!.id, request.params.keyId);
  recordAudit(current.workspaceId, request.user!.id, "api_key.revoked", { keyId: current.id, prefix: current.prefix });
  return { revoked: true, keyId: current.id };
});

// ---------------------------------------------------------------- public read API (Bearer)

app.get("/api/v1/public/v1/me", { preHandler: requireApiKey("read") }, async (request: any) => {
  const auth = request.apiAuth as ApiAuth;
  const quota = quotaState(auth.userId);
  return {
    user: { id: auth.userId, email: auth.email, displayName: auth.displayName },
    workspace: { id: auth.workspaceId, name: auth.workspaceName, role: auth.role },
    key: {
      id: auth.key.id, name: auth.key.name, prefix: auth.key.prefix, scopes: auth.key.scopes,
      // Wave 6: pemakai kunci bisa melihat batas hariannya sendiri dan pemakaian hari ini.
      dailyRequestLimit: auth.key.dailyRequestLimit, dailyTokenLimit: auth.key.dailyTokenLimit,
      requestsToday: auth.key.requestsToday, tokensToday: apiKeyTokensToday(auth.key.id),
    },
    quota: { tier: quota.tier, usedToday: quota.usedToday, dailyLimit: quota.dailyLimit, usedMonth: quota.usedMonth, monthlyLimit: quota.monthlyLimit },
  };
});

app.get("/api/v1/public/v1/workspaces", { preHandler: requireApiKey("read") }, async (request: any) => {
  const auth = request.apiAuth as ApiAuth;
  return { workspaces: [{ id: auth.workspaceId, name: auth.workspaceName, role: auth.role }] };
});

app.get("/api/v1/public/v1/projects", { preHandler: requireApiKey("read") }, async (request: any) => {
  const auth = request.apiAuth as ApiAuth;
  const projects = db.prepare("SELECT id, name, description, created_at AS createdAt FROM projects WHERE workspace_id=? ORDER BY created_at DESC").all(auth.workspaceId);
  return { projects };
});

app.get<{ Params: { projectId: string } }>("/api/v1/public/v1/projects/:projectId/conversations", { preHandler: requireApiKey("read") }, async (request: any, reply) => {
  const auth = request.apiAuth as ApiAuth;
  const project = apiProjectFor(auth, request.params.projectId);
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const conversations = db.prepare("SELECT id, title, pinned, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE project_id=? ORDER BY updated_at DESC").all(project.id);
  return { project: { id: project.id, name: project.name }, conversations };
});

app.get<{ Params: { conversationId: string } }>("/api/v1/public/v1/conversations/:conversationId/messages", { preHandler: requireApiKey("read") }, async (request: any, reply) => {
  const auth = request.apiAuth as ApiAuth;
  const conversation = apiConversationFor(auth, request.params.conversationId);
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  const messages = db.prepare("SELECT id, role, content, run_id AS runId, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(conversation.id);
  return { conversation: { id: conversation.id, title: conversation.title, projectId: conversation.projectId }, messages };
});

app.get<{ Params: { projectId: string } }>("/api/v1/public/v1/projects/:projectId/usage", { preHandler: requireApiKey("read") }, async (request: any, reply) => {
  const auth = request.apiAuth as ApiAuth;
  const project = apiProjectFor(auth, request.params.projectId);
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const totals = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_micros),0) AS costMicros
      FROM run_usage WHERE project_id=?`).get(project.id) as { runs: number; tokens: number; costMicros: number };
  const byModel = db.prepare(`SELECT COALESCE(model,'(tanpa model)') AS model, COUNT(*) AS runs, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_micros),0) AS costMicros
      FROM run_usage WHERE project_id=? GROUP BY model ORDER BY tokens DESC`).all(project.id);
  return { project: { id: project.id, name: project.name }, totals, byModel };
});

app.get<{ Params: { projectId: string } }>("/api/v1/public/v1/projects/:projectId/artifacts", { preHandler: requireApiKey("read") }, async (request: any, reply) => {
  const auth = request.apiAuth as ApiAuth;
  const project = apiProjectFor(auth, request.params.projectId);
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  // Metadata only: a key cannot pull file contents out of the platform.
  const artifacts = db.prepare("SELECT id, name, mime_type AS mimeType, size_bytes AS sizeBytes, sha256, created_at AS createdAt FROM artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 200").all(project.id);
  return { project: { id: project.id, name: project.name }, artifacts, note: "Isi berkas tidak disajikan lewat API kunci." };
});

// ------------------------------------------------- public write API (Bearer, scope "write") (Wave 6)
// A write call is charged to the key owner. Two ceilings apply: the account tier (checked here with
// quotaGuard) and the per-key daily ceiling (checked in requireApiKey). The engine call itself runs in
// the background, so the HTTP answer is 202 and the caller reads the answer from the message route.

app.post<{ Params: { projectId: string }; Body: { title?: string } }>("/api/v1/public/v1/projects/:projectId/conversations", { preHandler: requireApiKey("write") }, async (request: any, reply) => {
  const auth = request.apiAuth as ApiAuth;
  const project = apiProjectFor(auth, request.params.projectId);
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  if (auth.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY", message: "Kunci milik anggota viewer tidak boleh mengubah data." });
  const title = String(request.body?.title ?? "").trim().slice(0, 120) || "Percakapan API";
  const id = randomUUID(); const now = new Date().toISOString();
  db.prepare("INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, project.id, title, now, now);
  recordAudit(auth.workspaceId, auth.userId, "public.conversation.created", { conversationId: id, projectId: project.id, keyId: auth.key.id });
  recordGrowthEvent("conversation_created", { userId: auth.userId, workspaceId: auth.workspaceId, props: { conversationId: id, projectId: project.id, via: "public-api" } });
  return reply.code(201).send({ conversation: { id, projectId: project.id, title, createdAt: now, updatedAt: now } });
});

app.post<{ Params: { conversationId: string }; Body: { content?: string; model?: string; thinking?: string } }>(
  "/api/v1/public/v1/conversations/:conversationId/messages",
  { preHandler: requireApiKey("write") },
  async (request: any, reply) => {
    const auth = request.apiAuth as ApiAuth;
    const model = typeof request.body?.model === "string" && request.body.model.trim() ? request.body.model.trim() : undefined;
    if (model && !isKnownModel(model)) return reply.code(400).send({ error: "UNKNOWN_MODEL" });
    const thinking = typeof request.body?.thinking === "string" ? request.body.thinking.trim() : "";
    if (thinking && !isThinkingLevel(thinking)) return reply.code(400).send({ error: "INVALID_THINKING_LEVEL", allowed: THINKING_LEVELS });
    const content = String(request.body?.content ?? "").trim();
    if (!content || content.length > 100_000) return reply.code(400).send({ error: "INVALID_MESSAGE", message: "Isi pesan wajib diisi, maksimal 100000 karakter." });
    const conversation = apiConversationFor(auth, request.params.conversationId);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
    if (auth.role === "viewer") return reply.code(403).send({ error: "VIEWER_READ_ONLY", message: "Kunci milik anggota viewer tidak boleh mengirim pesan." });
    // Wave 11A (butir 45/46): API publik TIDAK boleh menjadi jalan pintas. Filter prompt-hijack dan
    // aturan larangan diperiksa sebelum run dibuat, sama seperti jalur antarmuka.
    if (config.PROMPT_GUARD_ENABLED) {
      const hijack = scanPromptHijack(content);
      if (hijack.blocked) {
        recordAudit(auth.workspaceId, auth.userId, "prompt_hijack_blocked", { conversationId: conversation.id, via: "public-api", pola: hijack.pattern, kategori: hijack.category, kutipan: hijack.snippet, panjangPesan: content.length });
        return reply.code(400).send({ error: "PROMPT_BLOCKED", message: hijackMessage(hijack.pattern), pola: hijack.pattern, kategori: hijack.category });
      }
    }
    const pelanggaran = guardrailViolations(auth.userId, content);
    if (pelanggaran.length) {
      for (const hit of pelanggaran) {
        recordSafetyEvent({ userId: auth.userId, ruleId: hit.rule.id, pattern: hit.pattern, snippet: content });
        recordAudit(auth.workspaceId, auth.userId, "safety_violation", { conversationId: conversation.id, via: "public-api", ruleId: hit.rule.id, judul: hit.rule.title, pola: hit.pattern, kutipan: content.replace(/\s+/g, " ").slice(0, 200) });
      }
      return reply.code(400).send({
        error: "GUARDRAIL_BLOCKED",
        message: `Permintaan ini dilarang aturan "${pelanggaran[0].rule.title}". Aksi tidak dijalankan.`,
        aturan: pelanggaran.map((hit) => ({ id: hit.rule.id, title: hit.rule.title, pola: hit.pattern })),
      });
    }
    const quotaBlock = quotaGuard(auth.userId, "");
    if (quotaBlock) return reply.code(quotaBlock.status).send({ error: quotaBlock.error, ...(quotaBlock.detail ?? {}) });

    const runId = randomUUID(); const messageId = randomUUID();
    const now = new Date().toISOString();
    const knowledge = knowledgeFor(conversation.projectId, content);
    // Wave 10 (item 24): a run that is still working already spends part of the day's ceiling. The
    // reservation is an estimate, and it is cleared as soon as the run reaches a final state.
    const reservedTokens = estimateRunTokens(content + (knowledge?.text ?? ""), config.API_KEY_INFLIGHT_OUTPUT_TOKENS);
    // Attachments are not part of the public write API: a key may send text only. That limit is stated
    // in the docs instead of being discovered by a 400.
    const transaction = db.transaction(() => {
      db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,api_key_id,created_at,reserved_tokens) VALUES (?,?,?,?,?,?,?,?)")
        .run(runId, conversation.projectId, "queued", content, model ?? config.PRIME_AGENT_MODEL, auth.key.id, now, reservedTokens);
      db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(messageId, conversation.id, "user", content, runId, now);
      db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversation.id);
    });
    transaction();
    queueRunJob({ runId, projectId: conversation.projectId, prompt: content, conversationId: conversation.id, model, userId: auth.userId, thinking: thinking || undefined, personaId: null, autonomous: false });
    recordAudit(auth.workspaceId, auth.userId, "public.message.created", { conversationId: conversation.id, projectId: conversation.projectId, runId, keyId: auth.key.id, model: model ?? null });
    const settings = agentSettings(auth.userId);
    void (async () => {
      await executeRun(runId, conversation.projectId, content, conversation.id, knowledge, model, auth.userId, { thinking: thinking || undefined, personaId: null, autonomous: false });
    })();
    return reply.code(202).send({
      message: { id: messageId, conversationId: conversation.id, role: "user", content, runId, createdAt: now },
      run: { id: runId, status: "queued", model: model ?? config.PRIME_AGENT_MODEL, thinkingLevel: thinking || settings.thinking_level, reservedTokens },
      read: { messages: `/api/v1/public/v1/conversations/${conversation.id}/messages` },
    });
  },
);

// ---------------------------------------------------------------- outgoing webhooks (Wave 6)

/** The workspace a session request works in: the asked one, or the oldest membership. */
function sessionWorkspaceFor(userId: string, requested?: unknown): { workspaceId: string; role: string } | null {
  const wanted = typeof requested === "string" ? requested.trim() : "";
  const row = wanted
    ? db.prepare("SELECT m.workspace_id AS workspaceId, m.role AS role FROM memberships m WHERE m.user_id=? AND m.workspace_id=?").get(userId, wanted)
    : db.prepare("SELECT m.workspace_id AS workspaceId, m.role AS role FROM memberships m WHERE m.user_id=? ORDER BY m.created_at ASC LIMIT 1").get(userId);
  return (row as { workspaceId: string; role: string } | undefined) ?? null;
}

function mayManageWebhooks(role: string): boolean { return role === "owner" || role === "admin"; }

app.get<{ Querystring: { workspaceId?: string } }>("/api/v1/webhooks", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.query?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  return {
    webhooks: listWebhooks(workspace.workspaceId),
    stats: webhookStats(workspace.workspaceId),
    events: webhookCatalogue(),
    limits: {
      maxPerWorkspace: config.WEBHOOK_MAX_PER_WORKSPACE, maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
      timeoutMs: config.WEBHOOK_DELIVERY_TIMEOUT_MS, allowLocal: config.WEBHOOK_ALLOW_LOCAL,
    },
    note: "Rahasia penandatanganan hanya tampil sekali saat webhook dibuat. Alamat lokal ditolak kecuali WEBHOOK_ALLOW_LOCAL=true.",
    canManage: mayManageWebhooks(workspace.role),
  };
});

app.post<{ Body: { url?: string; events?: unknown; description?: string; workspaceId?: string } }>("/api/v1/webhooks", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.body?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!mayManageWebhooks(workspace.role)) return reply.code(403).send({ error: "OWNER_REQUIRED", message: "Hanya owner atau admin workspace yang boleh mendaftarkan webhook." });
  const url = validateWebhookUrl(request.body?.url);
  if (!url.ok) return reply.code(400).send({ error: url.error, message: url.message });
  if (countWebhooks(workspace.workspaceId) >= config.WEBHOOK_MAX_PER_WORKSPACE) {
    return reply.code(409).send({ error: "TOO_MANY_WEBHOOKS", message: `Maksimal ${config.WEBHOOK_MAX_PER_WORKSPACE} webhook per workspace.` });
  }
  const created = createWebhook({
    workspaceId: workspace.workspaceId, userId: request.user!.id, url: url.url,
    events: parseEvents(request.body?.events), description: request.body?.description ?? null,
  });
  recordAudit(workspace.workspaceId, request.user!.id, "webhook.created", { webhookId: created.webhook.id, url: created.webhook.url, events: created.webhook.events });
  recordGrowthEvent("webhook_created", { userId: request.user!.id, workspaceId: workspace.workspaceId, props: { webhookId: created.webhook.id } });
  return reply.code(201).send({
    webhook: created.webhook, secret: created.secret,
    warning: "Salin rahasia ini sekarang. Dipakai untuk memeriksa header x-coblai-signature.",
  });
});

app.patch<{ Params: { id: string }; Body: { url?: string; events?: unknown; active?: boolean; description?: string | null; workspaceId?: string } }>("/api/v1/webhooks/:id", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.body?.workspaceId ?? request.query?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!mayManageWebhooks(workspace.role)) return reply.code(403).send({ error: "OWNER_REQUIRED", message: "Hanya owner atau admin workspace yang boleh mengubah webhook." });
  const current = getWebhook(workspace.workspaceId, request.params.id);
  if (!current) return reply.code(404).send({ error: "WEBHOOK_NOT_FOUND", message: "Webhook itu tidak ditemukan di ruang kerja ini." });
  if (request.body?.url !== undefined) {
    const url = validateWebhookUrl(request.body.url);
    if (!url.ok) return reply.code(400).send({ error: url.error, message: url.message });
  }
  const updated = updateWebhook(workspace.workspaceId, request.params.id, {
    url: request.body?.url, events: request.body?.events, active: request.body?.active, description: request.body?.description,
  });
  recordAudit(workspace.workspaceId, request.user!.id, "webhook.updated", { webhookId: current.id, active: updated?.active ?? current.active });
  return { webhook: updated };
});

app.delete<{ Params: { id: string } }>("/api/v1/webhooks/:id", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.query?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!mayManageWebhooks(workspace.role)) return reply.code(403).send({ error: "OWNER_REQUIRED", message: "Hanya owner atau admin workspace yang boleh menghapus webhook." });
  const current = getWebhook(workspace.workspaceId, request.params.id);
  if (!current) return reply.code(404).send({ error: "WEBHOOK_NOT_FOUND", message: "Webhook itu tidak ditemukan di ruang kerja ini." });
  deleteWebhook(workspace.workspaceId, request.params.id);
  recordAudit(workspace.workspaceId, request.user!.id, "webhook.deleted", { webhookId: current.id, url: current.url });
  // Riwayat pengiriman ikut terhapus karena barisnya menempel pada webhook (ON DELETE CASCADE).
  return { deleted: true, webhookId: current.id, note: "Riwayat pengiriman webhook ini ikut terhapus." };
});

app.get<{ Params: { id: string }; Querystring: { limit?: string; workspaceId?: string } }>("/api/v1/webhooks/:id/deliveries", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.query?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  const hook = getWebhook(workspace.workspaceId, request.params.id);
  if (!hook) return reply.code(404).send({ error: "WEBHOOK_NOT_FOUND", message: "Webhook itu tidak ditemukan di ruang kerja ini." });
  return { webhook: hook, deliveries: listDeliveries(hook.id, Number(request.query?.limit ?? 50) || 50) };
});

/** One immediate attempt, so a human can see the receiver answer without waiting for an event. */
app.post<{ Params: { id: string }; Querystring: { workspaceId?: string } }>("/api/v1/webhooks/:id/test", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.query?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!mayManageWebhooks(workspace.role)) return reply.code(403).send({ error: "OWNER_REQUIRED", message: "Hanya owner atau admin workspace yang boleh menguji webhook." });
  const hook = getWebhook(workspace.workspaceId, request.params.id);
  if (!hook) return reply.code(404).send({ error: "WEBHOOK_NOT_FOUND", message: "Webhook itu tidak ditemukan di ruang kerja ini." });
  const delivery = createDeliveryRow({
    webhookId: hook.id, event: "webhook.test",
    payload: { message: "Pesan uji dari COBLAI Coder.", url: hook.url, triggeredBy: request.user!.id },
  });
  let report: { status: string; responseStatus: number | null; error: string | null; durationMs: number } = { status: "failed", responseStatus: null, error: "Uji gagal.", durationMs: 0 };
  try {
    // A manual test skips the order gate: the person clicking wants the answer now.
    const result = await deliverWebhook(delivery.id, { force: true });
    report = { status: result.status, responseStatus: result.responseStatus, error: result.error, durationMs: result.durationMs };
  } catch (error) {
    // Kegagalan penerima bukan kegagalan server ini: jawabannya tetap 200 dengan laporan jujur.
    report = { status: "failed", responseStatus: null, error: error instanceof Error ? error.message : "Pengiriman gagal.", durationMs: 0 };
  }
  recordAudit(workspace.workspaceId, request.user!.id, "webhook.tested", { webhookId: hook.id, status: report.status, responseStatus: report.responseStatus });
  return { report, delivery: getDelivery(delivery.id) };
});

// ---------------------------------------------------------------- public pricing (no session)

app.get("/api/v1/public/plans", async () => {
  const plans = listPlans(true);
  const gates = paymentConfig();
  return {
    branding: branding(),
    currency: "IDR",
    usdToIdrRate: usdToIdrRate(),
    // Only on/off flags leave this endpoint, never a key or a secret.
    gateways: { xendit: Boolean((gates as any)?.xendit?.enabled), midtrans: Boolean((gates as any)?.midtrans?.enabled), manualTransfer: true },
    plans: plans.map((plan) => ({
      code: plan.code, name: plan.name, description: plan.description, priceIdr: plan.priceIdr, periodDays: plan.periodDays,
      tier: plan.tier, dailyTokenLimit: plan.dailyTokenLimit, monthlyTokenLimit: plan.monthlyTokenLimit, bonusTokens: plan.bonusTokens,
      features: plan.features ?? null,
    })),
  };
});


// ---------------------------------------------------------------- account privacy and data export (Wave 4)

app.get("/api/v1/account/privacy", { preHandler: requireUser }, async (request: any) => {
  const { sections } = collectUserData(request.user!.id);
  const exports = listExports(request.user!.id);
  return {
    policy: retentionPolicy(),
    sectionsInExport: sections,
    storedTotals: { sections: sections.length, rows: sections.reduce((sum, item) => sum + item.rows, 0) },
    exports: exports.slice(0, 10),
    email: emailWorkerState(),
    notes: [
      "Kata sandi (hash), kode pemulihan MFA, dan nilai kunci API tidak pernah ikut dalam ekspor.",
      "Berkas ekspor kedaluwarsa sendiri dan dihapus otomatis oleh pembersihan retensi.",
      "Penghapusan akun tersedia di Pengaturan > Keamanan akun, dan menghapus data terkait.",
    ],
  };
});

app.post("/api/v1/account/export", { preHandler: requireUser }, async (request: any, reply) => {
  const created = await createExport(request.user!.id);
  recordAudit(accountAuditWorkspace(request.user!.id), request.user!.id, "account.export.created", { exportId: created.row.id, rows: created.sections.reduce((sum, item) => sum + item.rows, 0) });
  return reply.code(201).send({
    export: { ...created.row, sections: created.sections },
    sections: created.sections,
    downloadUrl: `/api/v1/account/exports/${created.row.id}/download`,
    message: `Berkas ekspor siap (${created.row.sizeBytes} byte) dan berlaku sampai ${created.row.expiresAt}.`,
  });
});

app.get("/api/v1/account/exports", { preHandler: requireUser }, async (request: any) => ({ exports: listExports(request.user!.id) }));

app.get<{ Params: { exportId: string } }>("/api/v1/account/exports/:exportId/download", { preHandler: requireUser }, async (request: any, reply) => {
  const found = getExport(request.user!.id, request.params.exportId);
  if (!found) return reply.code(404).send({ error: "EXPORT_NOT_FOUND" });
  if (found.status !== "ready" || found.expiresAt < new Date().toISOString()) return reply.code(410).send({ error: "EXPORT_EXPIRED", message: "Berkas ekspor ini sudah kedaluwarsa. Buat ekspor baru." });
  let text: string;
  try { text = await readFile(exportFilePath(found.id), "utf8"); }
  catch { return reply.code(410).send({ error: "EXPORT_FILE_MISSING", message: "Berkas ekspor tidak ada di penyimpanan. Buat ekspor baru." }); }
  reply.header("content-type", "application/json; charset=utf-8");
  reply.header("content-disposition", `attachment; filename="coblai-data-akun-${found.createdAt.slice(0, 10)}.json"`);
  return reply.send(text);
});

app.delete<{ Params: { exportId: string } }>("/api/v1/account/exports/:exportId", { preHandler: requireUser }, async (request: any, reply) => {
  const removed = await deleteExport(request.user!.id, request.params.exportId);
  if (!removed) return reply.code(404).send({ error: "EXPORT_NOT_FOUND" });
  recordAudit(accountAuditWorkspace(request.user!.id), request.user!.id, "account.export.deleted", { exportId: request.params.exportId });
  return { deleted: true, exportId: request.params.exportId };
});

// ---------------------------------------------------------------- email notification preferences (Wave 4)

app.get("/api/v1/account/notification-preferences", { preHandler: requireUser }, async (request: any) => ({
  preferences: notificationPrefs(request.user!.id),
  email: emailWorkerState(),
  kinds: [
    { key: "emailQuota", label: "Kuota token hampir atau sudah habis" },
    { key: "emailRuns", label: "Kegagalan menjalankan agen" },
    { key: "emailBilling", label: "Pesanan, pembayaran, dan langganan" },
    { key: "emailTeam", label: "Undangan dan perubahan anggota tim" },
    { key: "emailSecurity", label: "Keamanan akun: kata sandi, MFA, email" },
  ],
  note: "Pemberitahuan di dalam aplikasi selalu aktif. Saklar di atas hanya mengatur salinan lewat email.",
}));

app.put("/api/v1/account/notification-preferences", { preHandler: requireUser }, async (request: any) => {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const preferences = saveNotificationPrefs(request.user!.id, body);
  recordAudit(accountAuditWorkspace(request.user!.id), request.user!.id, "account.notification_preferences.updated", { preferences });
  return { preferences, message: "Preferensi email disimpan." };
});

// ---------------------------------------------------------------- admin: AI price console (Wave 9, item 19)

/**
 * The price console. The owner sees, for every model: the published price from the engine catalogue,
 * the price really paid (when set), the markup, and the amount billed to customers. Money is shown
 * both as cost of goods (what the platform pays) and as the billed amount, never mixed.
 */
app.get("/api/v1/admin/pricing", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat harga AI." });
  const table = pricingTable({
    search: typeof request.query?.search === "string" ? request.query.search : undefined,
    only: request.query?.only === "used" || request.query?.only === "overridden" ? request.query.only : "all",
    limit: Number(request.query?.limit ?? 500) || 500,
    days: Number(request.query?.days ?? 30) || 30,
  });
  return {
    markup: table.markup, currency: table.currency, updatedAt: table.updatedAt, updatedBy: table.updatedBy,
    catalogSize: table.catalogSize, overrideCount: table.overrideCount, days: table.days,
    models: table.models.map((row) => ({ ...row, marginMicros: row.sellMicros - row.baseMicros })),
    totals: table.totals,
    note: "costMicros = yang Anda bayar ke penyedia AI. sellMicros = yang ditagihkan ke pelanggan (harga x markup).",
  };
});

/**
 * Butir 19: rekonsiliasi biaya. Membandingkan biaya yang tercatat dengan biaya yang seharusnya
 * menurut harga yang berlaku sekarang (termasuk tarif puncak vendor per jam). Read-only.
 */
app.get("/api/v1/admin/pricing/reconcile", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat rekonsiliasi biaya AI." });
  const days = Number(request.query?.days ?? 30) || 30;
  const limit = Number(request.query?.limit ?? 20) || 20;
  return reconcileUsage(days, limit);
});

/** Sets the markup factor applied on top of every model price. 1 means selling at cost. */
app.put<{ Body: { markup?: number | string } }>("/api/v1/admin/pricing/settings", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah markup." });
  const raw = request.body?.markup;
  const markup = Number(raw);
  if (!Number.isFinite(markup)) return reply.code(400).send({ error: "INVALID_MARKUP", message: "Markup harus berupa angka, misalnya 1.5 untuk 1,5 kali harga dasar." });
  if (markup < 0.1 || markup > 100) return reply.code(400).send({ error: "MARKUP_OUT_OF_RANGE", message: "Markup harus antara 0,1 dan 100." });
  const settings = setPricingMarkup(markup, request.user!.id);
  recordAudit(null, request.user!.id, "admin.pricing_updated", { markup: settings.markup });
  // The billed column is recomputed from the stored upstream cost, so the whole history agrees with
  // the markup that is in force now. The cost of goods is never touched.
  const runs = db.prepare("UPDATE run_usage SET sell_cost_micros = CAST(ROUND(COALESCE(cost_micros,0) * ?) AS INTEGER)").run(settings.markup);
  db.prepare("UPDATE user_usage SET sell_cost_micros = CAST(ROUND(COALESCE(cost_micros,0) * ?) AS INTEGER)").run(settings.markup);
  return {
    ok: true, markup: settings.markup, updatedAt: settings.updatedAt,
    rowsUpdated: runs.changes, totals: pricingTable({ days: 30, limit: 1 }).totals,
    message: `Markup disimpan: harga jual = harga dasar x ${settings.markup}.`,
  };
});

/** Stores the real price paid for one model, in US dollars per million tokens. */
app.put<{ Params: { model: string }, Body: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }>("/api/v1/admin/pricing/models/:model", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah harga model." });
  const model = String(request.params.model ?? "").trim();
  if (!model || model.length > 200) return reply.code(400).send({ error: "INVALID_MODEL", message: "Nama model tidak sah." });
  const input = { input: Number(request.body?.input), output: Number(request.body?.output), cacheRead: Number(request.body?.cacheRead ?? 0), cacheWrite: Number(request.body?.cacheWrite ?? 0) };
  const problem = validatePrice(input);
  if (problem) return reply.code(400).send({ error: "INVALID_PRICE", message: problem });
  const view = savePriceOverride(model, input, request.user!.id);
  recordAudit(null, request.user!.id, "admin.pricing_updated", { model, price: view.base });
  return { ok: true, price: view, message: `Harga ${model} disimpan: ${view.base.input} / ${view.base.output} USD per 1 juta token.` };
});

/** Drops an owner price and returns the model to the published catalogue price. */
app.delete<{ Params: { model: string } }>("/api/v1/admin/pricing/models/:model", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengubah harga model." });
  const model = String(request.params.model ?? "").trim();
  const removed = clearPriceOverride(model);
  if (!removed) return reply.code(404).send({ error: "PRICE_NOT_OVERRIDDEN", message: "Model ini belum pernah diberi harga sendiri." });
  recordAudit(null, request.user!.id, "admin.pricing_reset", { model });
  return { ok: true, price: priceView(model), message: `Harga ${model} dikembalikan ke daftar resmi.` };
});

/** A single model price, used by the editor when the table is filtered. */
app.get<{ Params: { model: string } }>("/api/v1/admin/pricing/models/:model", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat harga AI." });
  const model = String(request.params.model ?? "").trim();
  const settings = pricingSettings();
  const view = priceView(model, settings.markup);
  return { ...view, markup: settings.markup, catalog: catalogPriceFor(model) };
});

// ---------------------------------------------------------------- admin: background jobs (Wave 5)

/** Queue health for the admin console: what is waiting, what failed, and what the worker is doing. */
app.get("/api/v1/admin/jobs", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat antrean pekerjaan." });
  const status = typeof request.query?.status === "string" ? request.query.status : undefined;
  const kind = typeof request.query?.kind === "string" ? request.query.kind : undefined;
  const limit = Number(request.query?.limit ?? 50);
  return {
    worker: jobWorkerState(),
    stats: jobStats(),
    jobs: listJobs({ status, kind, limit }),
    kinds: ["run.execute", "email.deliver", "retention.run", "run.reap", "workflow.reap"],
  };
});

/** Puts a finished or failed job back in the queue. A job that is still pending is refused. */
app.post<{ Params: { jobId: string } }>("/api/v1/admin/jobs/:jobId/retry", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mengulang pekerjaan." });
  const job = getJob(request.params.jobId);
  if (!job) return reply.code(404).send({ error: "JOB_NOT_FOUND", message: "Pekerjaan itu tidak ada di antrean." });
  const result = retryJob(job.id);
  if (!result.ok) return reply.code(409).send({ error: result.reason, message: "Pekerjaan masih menunggu atau sedang dikerjakan." });
  recordAudit(accountAuditWorkspace(request.user!.id), request.user!.id, "admin.job.retried", { jobId: job.id, kind: job.kind, previousStatus: job.status });
  return { retried: true, job: getJob(job.id) };
});

/** One queue cycle on demand. Useful right after a deploy, and used by the test suite. */
app.post("/api/v1/admin/jobs/tick", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menjalankan antrean." });
  const cycle = await runJobCycleOnce({ owner: `admin-${request.user!.id}`, limit: 5 });
  recordAudit(accountAuditWorkspace(request.user!.id), request.user!.id, "admin.job.cycle", { claimed: cycle.claimed, succeeded: cycle.succeeded, failed: cycle.failed });
  return { cycle, stats: jobStats(), worker: jobWorkerState() };
});

// ---------------------------------------------------------------- admin: email outbox and retention (Wave 4)

app.get("/api/v1/admin/email-outbox", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh membuka antrean email." });
  const status = typeof request.query?.status === "string" ? request.query.status : undefined;
  const limit = Number(request.query?.limit ?? 50);
  return {
    worker: emailWorkerState(),
    stats: outboxStats(),
    emails: listOutbox({ status, limit }),
    note: config.NOTIFY_EMAIL_ENABLED
      ? "Antrean email aktif. Pesan terkirim otomatis oleh pekerja latar setiap menit."
      : "NOTIFY_EMAIL_ENABLED=false, jadi pesan hanya masuk antrean dan belum dikirim.",
  };
});

app.post<{ Params: { emailId: string } }>("/api/v1/admin/email-outbox/:emailId/retry", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh mencoba ulang pengiriman." });
  const retried = retryEmail(request.params.emailId);
  if (!retried) return reply.code(404).send({ error: "EMAIL_NOT_RETRYABLE", message: "Pesan tidak ada atau statusnya masih menunggu." });
  recordAudit(null, request.user!.id, "admin.email_outbox.retry", { emailId: request.params.emailId });
  return { retried: true, emailId: request.params.emailId };
});

app.post("/api/v1/admin/email-outbox/deliver", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menjalankan pengiriman email." });
  const report = await deliverPending(20);
  recordAudit(null, request.user!.id, "admin.email_outbox.deliver", report);
  return report;
});

app.delete<{ Params: { emailId: string } }>("/api/v1/admin/email-outbox/:emailId", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menghapus pesan antrean." });
  const row = getOutboxRow(request.params.emailId);
  if (!row) return reply.code(404).send({ error: "EMAIL_NOT_FOUND", message: "Pesan antrean itu tidak ada." });
  // A pending row is safe to remove while the worker is off (nothing is in flight). While sending is
  // enabled the row is kept so a message cannot disappear in the middle of a delivery attempt.
  const workerEnabled = emailEnabled();
  if (row.status === "pending" && workerEnabled) {
    return reply.code(409).send({ error: "EMAIL_IN_FLIGHT", message: "Pengiriman email sedang aktif, jadi pesan yang masih menunggu tidak bisa dihapus. Kirim ulang atau matikan NOTIFY_EMAIL_ENABLED dulu." });
  }
  const removed = deleteOutboxRow(request.params.emailId, !workerEnabled);
  if (!removed) return reply.code(409).send({ error: "EMAIL_IN_FLIGHT", message: "Pesan tidak bisa dihapus saat ini." });
  recordAudit(null, request.user!.id, "admin.email_outbox.deleted", { emailId: request.params.emailId, status: row.status });
  return { deleted: true, emailId: request.params.emailId, status: row.status };
});

app.get("/api/v1/admin/retention", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat kebijakan retensi." });
  const report = retentionReport();
  return {
    ...report,
    // The default is a report only. Nothing is deleted until an operator asks for it and the flag is on.
    enabled: report.policy.enabled,
    note: report.policy.enabled
      ? "Retensi aktif. Pekerja latar menjalankan pembersihan setiap 6 jam."
      : "RETENTION_ENABLED=false, jadi laporan ini hanya menghitung. Tidak ada data yang dihapus.",
  };
});

app.post("/api/v1/admin/retention/run", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menjalankan retensi." });
  const dryRun = request.body?.dryRun !== false;
  const result = runRetention({ dryRun });
  const expired = await expireExports();
  recordAudit(null, request.user!.id, "admin.retention.run", { dryRun: result.dryRun, totalRemoved: result.totalRemoved, expiredExports: expired.marked });
  return {
    ...result,
    expiredExports: expired,
    message: result.dryRun
      ? `Mode uji: tidak ada data yang dihapus. Kirim {"dryRun": false} untuk benar-benar menghapus.`
      : `Retensi selesai: ${result.totalRemoved} baris dihapus.`,
  };
});

/* ---------------------------------------------------------------- Wave 11A (v0.21.0) */
// Rute baru (butir 42-57, 79, 80) tinggal di `apps/api/src/wave11a/**`; server.ts hanya menyambung.
registerWave11aRoutes(app);
// Wave 11A (butir 80): laporan pagar konteks memakai penyusun blok yang sama dengan jalur run.
registerContextBudgetRoutes(app, (userId, personaId, conversationId) => buildSystemBlocks(userId, personaId, conversationId).plan);

/* ---------------------------------------------------------------- Wave 11B (v0.22.0) */
// Rute baru (butir 58-67, 72, 83) tinggal di `apps/api/src/wave11b/**`; server.ts hanya menyambung.
registerWave11bRoutes(app);
// Wave 11C (butir 68-82): modul ditambahkan bertahap di wave11c/index.ts.
registerWave11cRoutes(app);
// Wave 11B: jalur eksekusi mesin tetap MILIK server. Modul wave11b (lanjutkan run, jadwal prompt)
// memakai jalur yang sama lewat penitian fungsi ini, jadi tidak ada rumus kuota/biaya kedua.
setRunDispatcher((input) => executeRun(
  input.runId, input.projectId, input.prompt, input.conversationId ?? undefined,
  knowledgeFor(input.projectId, input.prompt), input.model ?? undefined, input.userId,
  { thinking: input.thinking ?? undefined, personaId: input.personaId ?? null, autonomous: Boolean(input.autonomous) },
));
setModelValidator(isKnownModel);
setThinkingValidator(isThinkingLevel);

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

/* ---------------- Wave 5: pekerjaan latar yang tahan restart ---------------- */

/** Finds the workspace of a project, so background repairs can be written to the audit log. */
function projectAuditWorkspace(projectId: string): string | null {
  const row = db.prepare("SELECT workspace_id FROM projects WHERE id=?").get(projectId) as { workspace_id?: string } | undefined;
  return row?.workspace_id ?? null;
}

/**
 * Wave 4 used two in-process timers (email every minute, retention every six hours). Both are replaced
 * by the durable queue: each pass is a row in `jobs`, so a restart does not lose the pass and two
 * processes cannot run the same pass at once.
 */
/** Wave 10 (item 26): the device gate sits next to the email gate before any AI work starts. */
function deviceGate(request: any): { status: number; error: string; message: string } | null {
  if (!config.DEVICE_TRACKING) return null;
  const gate = checkDeviceGate(request.user!.id, deviceIdForSession(currentSessionId(request)));
  if (gate.allowed) return null;
  return { status: 403, error: gate.error ?? "DEVICE_NOT_VERIFIED", message: gate.message ?? "Perangkat ini belum diverifikasi." };
}

/** Both account gates in one call, so every AI entry point checks the same two things. */
function usageGate(request: any): { status: number; error: string; message: string } | null {
  return accountGate(request.user!.id) ?? deviceGate(request);
}

/** Wave 10 (item 26): the platform view of sign-in devices, newest first. */
function adminDeviceList(limit: number): Array<Record<string, unknown>> {
  const size = Math.min(200, Math.max(1, limit));
  return db.prepare(`SELECT d.id, d.user_id AS userId, u.email, d.label, d.platform, d.last_ip AS lastIp,
      d.first_seen_at AS firstSeenAt, d.last_seen_at AS lastSeenAt, d.seen_count AS seenCount,
      d.trusted, d.verified_at AS verifiedAt, d.blocked_at AS blockedAt, d.blocked_reason AS blockedReason,
      (SELECT COUNT(*) FROM auth_sessions s WHERE s.device_id = d.id AND s.expires_at > datetime('now')) AS sessions
    FROM user_devices d LEFT JOIN users u ON u.id = d.user_id
    ORDER BY d.last_seen_at DESC LIMIT ?`).all(size) as Array<Record<string, unknown>>;
}

/**
 * Wave 10 (item 27): the safe removal of leftover smoke data. Only data inside workspaces where the
 * smoke account is the ONLY member is touched, the account itself stays, and a platform admin account
 * is refused outright. `dryRun` counts the rows without deleting anything.
 */
async function cleanupSmokeData(input: { dryRun: boolean; email: string }) {
  const email = String(input.email ?? "").trim().toLowerCase();
  const empty = { email, userId: null as string | null, userFound: false, workspaces: [] as string[], projects: [] as string[], rows: {} as Record<string, number>, artifactsRemoved: 0, messagesRemoved: 0, filesRemoved: 0, dryRun: input.dryRun, skipped: null as string | null };
  const user = db.prepare("SELECT id, email, is_admin AS isAdmin FROM users WHERE lower(email)=?").get(email) as { id: string; email: string; isAdmin: number } | undefined;
  if (!user) return { ...empty };
  if (isPlatformAdmin({ id: user.id, email: user.email })) return { ...empty, userId: user.id, userFound: true, skipped: "SMOKE_ACCOUNT_IS_ADMIN" };
  // A workspace is smoking ground only when this account is its single member and its owner.
  const workspaces = db.prepare(`SELECT w.id AS id FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
    WHERE m.user_id=? AND m.role='owner'
    AND (SELECT COUNT(*) FROM memberships other WHERE other.workspace_id=w.id)=1`).all(user.id) as { id: string }[];
  const workspaceIds = workspaces.map((row) => row.id);
  const emptyReport = (skipped: string | null) => ({ ...empty, userId: user.id, userFound: true, skipped });
  if (workspaceIds.length === 0) return emptyReport("NO_SMOKE_WORKSPACE");
  const marks = workspaceIds.map(() => "?").join(",");
  const projects = db.prepare(`SELECT id FROM projects WHERE workspace_id IN (${marks})`).all(...workspaceIds) as { id: string }[];
  const projectIds = projects.map((row) => row.id);
  const count = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  const runs = projectIds.length ? count(`SELECT COUNT(*) AS n FROM runs WHERE project_id IN (${projectIds.map(() => "?").join(",")})`, ...projectIds) : 0;
  const messages = projectIds.length ? count(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id IN (${projectIds.map(() => "?").join(",")}))`, ...projectIds) : 0;
  const artifacts = projectIds.length ? count(`SELECT COUNT(*) AS n FROM artifacts WHERE project_id IN (${projectIds.map(() => "?").join(",")})`, ...projectIds) : 0;
  const outbox = count("SELECT COUNT(*) AS n FROM email_outbox WHERE lower(to_email)=? AND status='pending'", email);
  const notifications = count(`SELECT COUNT(*) AS n FROM notifications WHERE workspace_id IN (${marks})`, ...workspaceIds);
  const report = {
    ...empty, userId: user.id, userFound: true, workspaces: workspaceIds, projects: projectIds,
    rows: { runs, messages, artifacts, outbox, notifications },
    artifactsRemoved: artifacts, messagesRemoved: messages, skipped: null as string | null,
  };
  if (input.dryRun) return report;
  for (const projectId of projectIds) await deleteProjectFully(projectId);
  db.transaction(() => {
    db.prepare("DELETE FROM workspace_invitations WHERE workspace_id IN (" + marks + ")").run(...workspaceIds);
    db.prepare("DELETE FROM notifications WHERE workspace_id IN (" + marks + ")").run(...workspaceIds);
    db.prepare("DELETE FROM api_keys WHERE user_id=?").run(user.id);
    db.prepare("DELETE FROM email_outbox WHERE lower(to_email)=? AND status='pending'").run(email);
  })();
  recordAudit(null, null, "smoke.cleanup.ran", { userId: user.id, email, projects: projectIds.length, runs, messages, artifacts });
  return { ...report, filesRemoved: projectIds.length };
}

/** The shape the database currently has; the number comes from the migration table, not a constant. */
function schemaVersion(): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined;
  return Number(row?.version ?? 0);
}

/** Wave 10 (item 28): the numbers a monitoring agent reads, as plain text. */
function metricsNumbers(): Record<string, number> {
  const one = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
  const jobs = jobStats();
  const usage = db.prepare(`SELECT COALESCE(SUM(cost_micros),0) AS cost, COALESCE(SUM(COALESCE(sell_cost_micros, cost_micros)),0) AS billed,
      COALESCE(SUM(total_tokens),0) AS tokens FROM run_usage`).get() as { cost: number; billed: number; tokens: number };
  return {
    users_total: one("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL"),
    users_closed: one("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NOT NULL"),
    users_verified: one("SELECT COUNT(*) AS n FROM users WHERE email_verified=1"),
    workspaces_total: one("SELECT COUNT(*) AS n FROM workspaces"),
    projects_total: one("SELECT COUNT(*) AS n FROM projects"),
    conversations_total: one("SELECT COUNT(*) AS n FROM conversations"),
    messages_total: one("SELECT COUNT(*) AS n FROM messages"),
    runs_total: one("SELECT COUNT(*) AS n FROM runs"),
    runs_active: one("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')"),
    runs_completed: one("SELECT COUNT(*) AS n FROM runs WHERE status='completed'"),
    runs_failed: one("SELECT COUNT(*) AS n FROM runs WHERE status='failed'"),
    tokens_total: usage.tokens,
    cost_micros_total: usage.cost,
    billed_micros_total: usage.billed,
    jobs_queued: jobs.queued, jobs_running: jobs.running, jobs_failed: jobs.failed,
    jobs_oldest_queued_seconds: jobs.oldestQueuedAt ? Math.max(0, Math.round((Date.now() - Date.parse(jobs.oldestQueuedAt)) / 1000)) : 0,
    webhooks_total: one("SELECT COUNT(*) AS n FROM webhooks WHERE active=1"),
    webhook_deliveries_queued: one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status='queued'"),
    webhook_deliveries_deferred: one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE COALESCE(deferrals,0) > 0"),
    webhook_deliveries_failed: one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status='failed'"),
    devices_total: one("SELECT COUNT(*) AS n FROM user_devices"),
    devices_blocked: one("SELECT COUNT(*) AS n FROM user_devices WHERE blocked_at IS NOT NULL"),
    push_subscriptions_active: one("SELECT COUNT(*) AS n FROM push_subscriptions WHERE active=1"),
    messages_indexed: one("SELECT COUNT(*) AS n FROM message_search"),
    search_terms: one("SELECT COUNT(*) AS n FROM knowledge_documents"),
    email_pending: one("SELECT COUNT(*) AS n FROM email_outbox WHERE status='pending'"),
    email_failed: one("SELECT COUNT(*) AS n FROM email_outbox WHERE status='failed'"),
    api_keys_active: one("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL"),
    audit_events_total: one("SELECT COUNT(*) AS n FROM audit_events"),
  };
}

/** Wave 10 (item 28): the plain text face, with one line per number so any scraper can read it. */
function metricsText(): string {
  const numbers = metricsNumbers();
  const lines = [
    "# COBLAI Coder metrics. Token terpisah: kirim Authorization: Bearer <METRICS_TOKEN>.",
    `coblai_info{version="${process.env.APP_VERSION ?? "dev"}",schema="${schemaVersion()}"} 1`,
    // Baris polos memudahkan alat pengumpul yang tidak membaca label, misalnya pemeriksa versi skema.
    `coblai_schema_version ${schemaVersion()}`,
    `coblai_uptime_seconds ${Math.round(process.uptime())}`,
  ];
  for (const [key, value] of Object.entries(numbers)) lines.push(`coblai_${key} ${value}`);
  lines.push("");
  return lines.join("\n");
}

/** Wave 10 (item 28): the same numbers as JSON for the dashboard page. */
function metricsSnapshot() {
  const createdAt = db.prepare("SELECT value FROM platform_settings WHERE key='server_started_at'").get() as { value: string } | undefined;
  return {
    generatedAt: new Date().toISOString(), version: process.env.APP_VERSION ?? "dev", schemaVersion: schemaVersion(),
    uptimeSeconds: Math.round(process.uptime()), startedAt: createdAt?.value ?? null,
    numbers: metricsNumbers(), jobs: jobStats(), worker: jobWorkerState(),
    search: searchStats(), push: pushStats(), devices: deviceSummary(), health: { database: "ok", dataDir: config.DATA_DIR },
    tokenConfigured: Boolean(config.METRICS_TOKEN),
    retention: { dryRun: config.RETENTION_DRY_RUN, webhookDays: config.RETENTION_WEBHOOK_DAYS, smokeCleanup: config.SMOKE_CLEANUP_ENABLED, smokeHours: config.SMOKE_CLEANUP_HOURS },
  };
}

// ---------------------------------------------------------------- Wave 10 (items 21 to 32D)

/**
 * Item 29: one search box over everything the caller is allowed to read. Access follows the
 * memberships of the caller, so a hit can never come from a workspace the caller cannot open.
 */
app.get<{ Querystring: { q?: string; limit?: string; kinds?: string } }>("/api/v1/search", { preHandler: requireUser }, async (request: any, reply) => {
  const query = String(request.query?.q ?? "").trim();
  if (query.length > 200) return reply.code(400).send({ error: "SEARCH_QUERY_TOO_LONG", message: "Kata kunci maksimal 200 karakter." });
  // One letter matches half the database and shows nothing useful, so the caller is told plainly
  // instead of being handed a huge, meaningless list.
  if (query.length < 2) return reply.code(400).send({ error: "SEARCH_QUERY_TOO_SHORT", message: "Ketik minimal 2 huruf untuk mencari." });
  const requested = String(request.query?.kinds ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const kinds = requested.filter((kind) => (SEARCH_KINDS as readonly string[]).includes(kind)) as SearchKind[];
  const limit = Number(request.query?.limit ?? config.SEARCH_MAX_RESULTS) || config.SEARCH_MAX_RESULTS;
  return globalSearch({ userId: request.user!.id, query, limit, kinds: kinds.length ? kinds : undefined });
});

app.get("/api/v1/search/status", { preHandler: requireUser }, async () => ({
  index: searchStats(), kinds: SEARCH_KINDS, maxResults: config.SEARCH_MAX_RESULTS,
  note: "Indeks pesan diisi otomatis sejak skema 18. Jalankan ulang bila pesan lama belum muncul.",
}));

app.post("/api/v1/admin/search/reindex", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh membangun ulang indeks pencarian." });
  const before = searchStats();
  const indexed = rebuildMessageIndex();
  return { before, indexed, after: searchStats() };
});

/** Item 31: the browser push channel. Email stays as it is; push is a second, faster channel. */
app.get("/api/v1/account/push", { preHandler: requireUser }, async (request: any) => ({
  ...publicPushKey(), subscriptions: listSubscriptions(request.user!.id, false), max: config.PUSH_MAX_PER_USER,
  stats: pushStats(request.user!.id),
  note: "Simpan langganan dari peramban dengan izin notifikasi. Bila push dimatikan admin, halaman ini tidak mengirim apa pun.",
}));

app.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } }>("/api/v1/account/push/subscribe", { preHandler: requireUser }, async (request: any, reply) => {
  if (!config.PUSH_ENABLED) return reply.code(409).send({ error: "PUSH_DISABLED", message: "Notifikasi peramban sedang dimatikan admin platform." });
  if (!pushConfigured()) return reply.code(503).send({ error: "PUSH_UNAVAILABLE", message: "Kunci push belum siap di server. Coba lagi nanti." });
  const endpoint = String(request.body?.endpoint ?? "");
  const p256dh = String(request.body?.keys?.p256dh ?? "");
  const auth = String(request.body?.keys?.auth ?? "");
  if (!endpoint.startsWith("https://") || !p256dh || !auth) {
    return reply.code(400).send({ error: "INVALID_SUBSCRIPTION", message: "Data langganan push tidak lengkap." });
  }
  if (countSubscriptions(request.user!.id) >= config.PUSH_MAX_PER_USER) {
    return reply.code(409).send({ error: "TOO_MANY_SUBSCRIPTIONS", message: `Maksimal ${config.PUSH_MAX_PER_USER} peramban per akun. Hapus salah satu dulu.` });
  }
  const saved = saveSubscription({ userId: request.user!.id, endpoint, p256dh, auth, userAgent: String(request.headers["user-agent"] ?? "").slice(0, 200) });
  return reply.code(201).send({ subscription: saved, note: "Peramban ini akan menerima pemberitahuan yang sama dengan notifikasi dalam aplikasi." });
});

app.delete<{ Params: { id: string } }>("/api/v1/account/push/subscriptions/:id", { preHandler: requireUser }, async (request: any, reply) => {
  const removed = removeSubscription(request.user!.id, request.params.id);
  if (!removed) return reply.code(404).send({ error: "SUBSCRIPTION_NOT_FOUND", message: "Langganan push itu tidak ditemukan." });
  return { removed: true };
});

app.post("/api/v1/account/push/test", { preHandler: requireUser }, async (request: any, reply) => {
  if (!pushConfigured()) return reply.code(503).send({ error: "PUSH_UNAVAILABLE", message: "Kunci push belum siap di server. Coba lagi nanti." });
  const report = await sendPushToUser(request.user!.id, {
    title: "Uji notifikasi COBLAI Coder", body: "Bila pesan ini muncul, notifikasi peramban sudah aktif.", link: "/", kind: "system",
  });
  return { report, note: "Peramban yang menolak akan dinonaktifkan otomatis." };
});

/** Item 26 / 32B: the devices an account signs in from. Advisory plus revocable. */
app.get("/api/v1/account/devices", { preHandler: requireUser }, async (request: any) => ({
  devices: listDevices(request.user!.id, deviceIdForSession(currentSessionId(request))),
  verifyRequired: deviceVerifyRequired(), tracking: config.DEVICE_TRACKING, mode: config.DEVICE_VERIFY_NEW,
  limit: config.DEVICE_MAX_PER_USER,
  note: "Cabut perangkat yang tidak Anda kenali. Sesi yang terikat perangkat itu ikut berakhir.",
}));

app.patch<{ Params: { deviceId: string }; Body: { label?: string; trusted?: boolean } }>("/api/v1/account/devices/:deviceId", { preHandler: requireUser }, async (request: any, reply) => {
  const device = getDevice(request.user!.id, request.params.deviceId);
  if (!device) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "Perangkat itu tidak ada di akun Anda." });
  let updated: DeviceRow | null = device;
  if (typeof request.body?.label === "string") {
    // Nama perangkat dipakai di daftar dan notifikasi, jadi panjangnya dibatasi dan pelanggarannya
    // diberitahukan apa adanya alih-alih dipotong diam-diam.
    if (request.body.label.trim().length > DEVICE_LABEL_MAX) {
      return reply.code(400).send({ error: "DEVICE_LABEL_TOO_LONG", message: `Nama perangkat maksimal ${DEVICE_LABEL_MAX} karakter.` });
    }
    const renamed = renameDevice(request.user!.id, device.id, request.body.label);
    if (!renamed) return reply.code(400).send({ error: "INVALID_LABEL", message: "Nama perangkat tidak boleh kosong." });
    updated = renamed;
  }
  if (typeof request.body?.trusted === "boolean") updated = setDeviceTrust(request.user!.id, device.id, request.body.trusted) ?? updated;
  return { device: updated };
});

/** The emailed link. The token is single use and expires in 24 hours. */
app.post<{ Body: { token?: string } }>("/api/v1/account/devices/verify", { preHandler: requireUser }, async (request: any, reply) => {
  const userId = consumeAuthToken(String(request.body?.token ?? ""), "device_verify");
  if (!userId) return reply.code(400).send({ error: "INVALID_TOKEN", message: "Tautan verifikasi perangkat sudah kedaluwarsa atau sudah dipakai. Masuk ulang untuk meminta tautan baru." });
  if (userId !== request.user!.id) return reply.code(403).send({ error: "TOKEN_OTHER_ACCOUNT", message: "Tautan itu milik akun lain. Masuk dengan akun yang benar." });
  const info = requestDeviceInfo(request);
  const registered = registerDevice({ userId, fingerprint: info.fingerprint, userAgent: info.userAgent, ip: info.ip });
  markDeviceVerified(userId, registered.device.id);
  return { verified: true, device: getDevice(userId, registered.device.id) };
});

app.delete<{ Params: { deviceId: string } }>("/api/v1/account/devices/:deviceId", { preHandler: requireUser }, async (request: any, reply) => {
  const device = getDevice(request.user!.id, request.params.deviceId);
  if (!device) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "Perangkat itu tidak ada di akun Anda." });
  const revoked = revokeDevice(request.user!.id, device.id);
  deleteDevice(request.user!.id, device.id);
  recordAudit(null, request.user!.id, "device.revoked", { deviceId: device.id, label: device.label, sessionsRemoved: revoked?.sessionsRemoved ?? 0 });
  return { removed: true, sessionsRemoved: revoked?.sessionsRemoved ?? 0, note: "Perangkat dicabut dan sesinya diakhiri. Bila perangkat itu masih terbuka, pengguna harus masuk ulang." };
});

app.get("/api/v1/admin/devices", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat daftar perangkat." });
  return { summary: deviceSummary(), devices: adminDeviceList(Number(request.query?.limit ?? 50) || 50), gate: { tracking: config.DEVICE_TRACKING, mode: config.DEVICE_VERIFY_NEW } };
});

app.post<{ Params: { deviceId: string }; Body: { reason?: string } }>("/api/v1/admin/devices/:deviceId/block", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh memblokir perangkat." });
  const row = db.prepare("SELECT id, user_id AS userId FROM user_devices WHERE id=?").get(request.params.deviceId) as { id: string; userId: string } | undefined;
  if (!row) return reply.code(404).send({ error: "DEVICE_NOT_FOUND", message: "Perangkat itu tidak ditemukan." });
  const blocked = blockDevice(row.userId, row.id, String(request.body?.reason ?? "Diblokir admin platform."));
  const revoked = revokeDevice(row.userId, row.id);
  recordAudit(null, request.user!.id, "device.blocked", { deviceId: row.id, userId: row.userId, reason: String(request.body?.reason ?? "").slice(0, 120) });
  return { device: blocked, sessionsRemoved: revoked?.sessionsRemoved ?? 0 };
});

/** Item 23: a fresh delivery row for one earlier delivery, so the order history stays readable. */
app.post<{ Params: { id: string; deliveryId: string } }>("/api/v1/webhooks/:id/deliveries/:deliveryId/resend", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.query?.workspaceId ?? request.body?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!mayManageWebhooks(workspace.role)) return reply.code(403).send({ error: "OWNER_REQUIRED", message: "Hanya owner atau admin workspace yang boleh mengirim ulang peristiwa webhook." });
  const hook = getWebhook(workspace.workspaceId, request.params.id);
  if (!hook) return reply.code(404).send({ error: "WEBHOOK_NOT_FOUND", message: "Webhook itu tidak ditemukan di ruang kerja ini." });
  const delivery = getDelivery(request.params.deliveryId);
  if (!delivery || delivery.webhookId !== hook.id) return reply.code(404).send({ error: "WEBHOOK_DELIVERY_NOT_FOUND", message: "Riwayat pengiriman itu tidak ditemukan pada webhook ini." });
  const result = resendDelivery(delivery.id);
  if ("error" in result) {
    const status = result.error === "WEBHOOK_DELIVERY_PENDING" ? 409 : 404;
    return reply.code(status).send({ error: result.error, message: result.message });
  }
  recordAudit(workspace.workspaceId, request.user!.id, "webhook.resent", { webhookId: hook.id, deliveryId: result.delivery.id, resendOf: delivery.id, jobId: result.jobId });
  return reply.code(201).send({ delivery: result.delivery, jobId: result.jobId, note: "Peristiwa dikirim sebagai baris baru, jadi riwayat lama tetap utuh." });
});

/** Item 23: the delivery log is trimmed by choice, and queued rows are never touched. */
app.delete<{ Params: { id: string }; Querystring: { days?: string; dryRun?: string; workspaceId?: string } }>("/api/v1/webhooks/:id/deliveries", { preHandler: requireUser }, async (request: any, reply) => {
  const workspace = sessionWorkspaceFor(request.user!.id, request.query?.workspaceId);
  if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  if (!mayManageWebhooks(workspace.role)) return reply.code(403).send({ error: "OWNER_REQUIRED", message: "Hanya owner atau admin workspace yang boleh membersihkan riwayat pengiriman." });
  const hook = getWebhook(workspace.workspaceId, request.params.id);
  if (!hook) return reply.code(404).send({ error: "WEBHOOK_NOT_FOUND", message: "Webhook itu tidak ditemukan di ruang kerja ini." });
  const dryRun = String(request.query?.dryRun ?? "") === "1" || String(request.query?.dryRun ?? "") === "true";
  const days = Number(request.query?.days ?? config.RETENTION_WEBHOOK_DAYS) || config.RETENTION_WEBHOOK_DAYS;
  const report = cleanupWebhookDeliveries({ days, dryRun, webhookId: hook.id });
  if (!dryRun) recordAudit(workspace.workspaceId, request.user!.id, "webhook.deliveries.cleaned", { webhookId: hook.id, days, removed: report.removed });
  return { report, note: dryRun ? "Mode kering: tidak ada baris yang dihapus." : "Baris yang masih menunggu atau sedang dicoba ulang tidak dihapus." };
});

/** Item 27: removes exactly the rows a smoke run leaves behind, on an explicit request. */
app.post<{ Body: { dryRun?: boolean; email?: string } }>("/api/v1/admin/smoke/cleanup", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh membersihkan data uji." });
  const dryRun = request.body?.dryRun === undefined ? true : Boolean(request.body.dryRun);
  const email = String(request.body?.email ?? config.SMOKE_ACCOUNT_EMAIL).trim().toLowerCase();
  const report = await cleanupSmokeData({ dryRun, email });
  recordAudit(null, request.user!.id, "smoke.cleanup", { dryRun, email, projects: report.projects.length, artifacts: report.artifactsRemoved, messages: report.messagesRemoved });
  return { report, note: dryRun ? "Mode kering: tidak ada data yang dihapus." : "Hanya data akun uji yang dihapus; akun dan workspace-nya tetap ada." };
});

/** Item 25 / 32C: what a backfill would add, and then the backfill itself. */
app.get("/api/v1/admin/growth/backfill", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat rencana backfill pertumbuhan." });
  return { plan: planGrowthBackfill(), sources: growthEventSources(), recorded: growthOverview(Number(request.query?.days ?? 30) || 30) };
});

app.post<{ Body: { apply?: boolean } }>("/api/v1/admin/growth/backfill", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh menjalankan backfill pertumbuhan." });
  const apply = Boolean(request.body?.apply);
  const report = backfillGrowthEvents({ apply });
  if (apply) recordAudit(null, request.user!.id, "growth.backfilled", { inserted: report.inserted, candidates: report.totalCandidates });
  return { report, sources: growthEventSources(), note: apply ? "Baris yang sudah ada tidak digandakan." : "Mode kering: kirim { \"apply\": true } untuk menyimpan." };
});

/** Item 28: the plain text face for a monitoring agent. The token is required, or the route hides. */
app.get("/api/v1/metrics", async (request: any, reply) => {
  const token = String(config.METRICS_TOKEN ?? "");
  const supplied = String(request.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "") || String(request.query?.token ?? "");
  if (!token || supplied !== token) return reply.code(404).send({ error: "NOT_FOUND", message: "Halaman ini tidak tersedia." });
  reply.header("content-type", "text/plain; charset=utf-8");
  return metricsText();
});

app.get("/api/v1/admin/metrics", { preHandler: requireUser }, async (request: any, reply) => {
  if (!isPlatformAdmin(request.user!)) return reply.code(403).send({ error: "ADMIN_REQUIRED", message: "Hanya admin platform yang boleh melihat angka operasional." });
  return metricsSnapshot();
});

function registerBackgroundHandlers() {
  // The safety net for a run whose dispatch never happened because the process stopped.
  registerJobHandler("run.execute", async (payload: any) => {
    const runId = String(payload?.runId ?? "");
    const row = db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status?: string } | undefined;
    if (!row) return { skipped: "RUN_NOT_FOUND" };
    if (row.status !== "queued") return { skipped: `RUN_${String(row.status).toUpperCase()}` };
    const knowledge = knowledgeFor(String(payload.projectId), String(payload.prompt));
    void executeRun(runId, String(payload.projectId), String(payload.prompt), payload.conversationId ?? undefined, knowledge,
      payload.model ?? undefined, String(payload.userId), {
        thinking: payload.thinking ?? undefined, personaId: payload.personaId ?? null, autonomous: Boolean(payload.autonomous),
      });
    return { dispatched: true };
  });

  registerJobHandler("email.deliver", async () => {
    const report = await deliverPending(20);
    return { enabled: report.enabled, sent: report.sent, failed: report.failed, skipped: report.skipped, pending: report.pending };
  });

  /**
   * Wave 8: lists the files that belong to accounts whose recovery window has passed. The rows of
   * a workspace with no members left are removed by the retention pass, so the file list is built
   * before that pass runs.
   */
  function filesForClosedAccounts(now = new Date()): { projectIds: string[]; attachmentPaths: string[] } {
    const due = "SELECT id FROM users WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= ?";
    const projects = db.prepare(`SELECT p.id AS id FROM projects p WHERE p.workspace_id IN (
      SELECT m.workspace_id FROM memberships m WHERE m.user_id IN (${due}) AND m.role='owner'
      AND (SELECT COUNT(*) FROM memberships other WHERE other.workspace_id=m.workspace_id)=1)`).all(now.toISOString()) as { id: string }[];
    if (projects.length === 0) return { projectIds: [], attachmentPaths: [] };
    const marks = projects.map(() => "?").join(",");
    const attachments = db.prepare(`SELECT a.storage_path AS storagePath FROM message_attachments a
      JOIN messages ms ON ms.id=a.message_id JOIN conversations c ON c.id=ms.conversation_id
      WHERE c.project_id IN (${marks})`).all(...projects.map((project) => project.id)) as { storagePath: string }[];
    return { projectIds: projects.map((project) => project.id), attachmentPaths: attachments.map((row) => row.storagePath) };
  }

  registerJobHandler("retention.run", async () => {
    // Wave 8: the files of a workspace that is about to disappear are collected first, because
    // after the delete pass the rows that point at them are gone.
    const files = filesForClosedAccounts();
    const result = runRetention();
    for (const projectId of files.projectIds) await rm(join(config.DATA_DIR, "artifacts", projectId), { recursive: true, force: true }).catch(() => undefined);
    for (const path of files.attachmentPaths) await rm(path, { force: true }).catch(() => undefined);
    await expireExports().catch(() => undefined);
    if (!result.dryRun && result.totalRemoved > 0) console.log(`[retention] removed ${result.totalRemoved} rows`);
    return { dryRun: result.dryRun, totalRemoved: result.totalRemoved, accountsPurged: result.purgedAccounts ?? 0,
      workspacesRemoved: (result.removedWorkspaces ?? []).length, filesRemoved: files.projectIds.length + files.attachmentPaths.length, reason: result.reason ?? null };
  });

  // Repairs abandoned runs. Nothing is touched while it is still inside the lease window.
  registerJobHandler("run.reap", async () => {
    const report = reapAbandonedRuns();
    for (const run of report.runs) {
      recordAudit(projectAuditWorkspace(run.projectId), null, "run.reaped", { runId: run.id, reason: "WORKER_LOST", startedAt: run.startedAt });
      // Wave 11B (butir 63): run yang putus ditandai bisa dilanjutkan, bukan sekadar mati.
      markRunResumable(run.id);
    }
    return { marked: report.marked, resumable: report.runs.length };
  });

  registerJobHandler("workflow.reap", async () => {
    const report = reapAbandonedExecutions();
    for (const execution of report.executions) {
      recordAudit(projectAuditWorkspace(projectIdOfExecution(execution.id)), null, "workflow.execution.reaped", { executionId: execution.id, reason: "WORKER_LOST" });
    }
    return { marked: report.marked };
  });

  // Wave 6: one delivery attempt per job. The queue supplies the retry and its backoff, so a receiver
  // that is down for a while still gets the event once it comes back (up to WEBHOOK_MAX_ATTEMPTS).
  registerJobHandler("webhook.deliver", async (payload: any) => {
    const deliveryId = String(payload?.deliveryId ?? "");
    let report: { status: string; responseStatus: number | null; durationMs: number };
    try {
      report = await deliverWebhook(deliveryId);
    } catch (error) {
      // Wave 10 (item 31): the last attempt tells the workspace owner, so a broken receiver is not
      // discovered days later. The queue still owns the retry itself.
      const delivery = getDelivery(deliveryId);
      if (delivery && delivery.attempts >= config.WEBHOOK_MAX_ATTEMPTS) {
        const hook = webhookRowById(delivery.webhookId);
        notify(hook?.workspaceId ?? null, null, "webhook", "Webhook gagal berkali-kali",
          `Pengiriman ${delivery.event} ke ${hook?.url ?? "alamat webhook"} gagal ${delivery.attempts} kali. Periksa alamat dan penerimanya.`, "/webhooks");
      }
      throw error;
    }
    if (report.status === "deferred") {
      // The row waits for an earlier event; the deferral enqueued its own next attempt.
      return { deliveryId, status: report.status, deferred: true, responseStatus: null, durationMs: 0 };
    }
    return { deliveryId, status: report.status, responseStatus: report.responseStatus, durationMs: report.durationMs };
  });

  /** Wave 10 (items 23 and 27): the scheduled trim of delivery history and smoke data. */
  registerJobHandler("smoke.cleanup", async () => {
    const report = await cleanupSmokeData({ dryRun: config.RETENTION_DRY_RUN, email: config.SMOKE_ACCOUNT_EMAIL });
    const trimmed = cleanupWebhookDeliveries({ days: config.RETENTION_WEBHOOK_DAYS, dryRun: config.RETENTION_DRY_RUN });
    return {
      smoke: { dryRun: report.dryRun, skipped: report.skipped, projects: report.projects.length, rows: report.rows },
      webhooks: { cutoff: trimmed.cutoff, days: config.RETENTION_WEBHOOK_DAYS, candidates: trimmed.candidates, removed: trimmed.removed, dryRun: trimmed.dryRun },
    };
  });

  /**
   * Butir 15b: sapuan tabel `rate_limit_hits` milik pekerja terjadwal. Di produksi
   * (`JOB_WORKER_IN_WEB=false`) proses web tidak lagi menyapu, sehingga banyak replika web tidak
   * mengerjakan hal yang sama berulang-ulang. Hasilnya dilaporkan apa adanya supaya bisa diperiksa.
   */
  registerJobHandler("ratelimit.sweep", async () => {
    const swept = sweepRateLimitHits();
    return { removed: swept.removed, cutoff: new Date(swept.cutoff).toISOString(), sweepInWeb: config.RATE_LIMIT_SWEEP_IN_WEB };
  });

  /**
   * Wave 11B (butir 72): jadwal prompt memakai pekerja `jobs` yang sudah ada, bukan penjadwal baru.
   * Setiap menit pekerja ini mencari jadwal yang sudah waktunya dan menjalankannya satu kali.
   */
  registerJobHandler("schedule.run", async () => {
    const report = await runDueSchedules();
    for (const item of report.dilewati) {
      recordAudit(null, item.userId, "schedule.skipped", { scheduleId: item.scheduleId, reason: item.reason });
    }
    return { due: report.due, dijalankan: report.dijalankan, dilewati: report.dilewati.length };
  });

  /**
   * Wave 11B (butir 63): pemindai run yang putus. Mesin yang mati tidak meninggalkan jejak sendiri,
   * jadi penandanya diperiksa berkala — sama seperti `run.reap`, tetapi hanya untuk menandai.
   */
  // Wave 11C butir 82: pengiriman konektor berjalan di proses pekerja terpisah.
  registerConnectorJobHandlers();
  registerJobHandler("resume.scan", async () => {
    const marked = markInterruptedRuns();
    return { marked };
  });
}

/** A workflow execution stores its project, which is used for the audit entry of a repair. */
function projectIdOfExecution(executionId: string): string {
  const row = db.prepare("SELECT project_id FROM workflow_executions WHERE id=?").get(executionId) as { project_id?: string } | undefined;
  return row?.project_id ?? "";
}

/**
 * Starts the queue worker. At start-up this process owns no work yet, so a run still marked running (or
 * a workflow execution still marked running) was left behind by the previous process. Single-process
 * deployments repair those rows at once; set JOB_REAP_ON_BOOT=false if the API ever runs in more than
 * one process at a time.
 *
 * Wave 9 (item 17): only ONE process may own the queue. In production the API runs with
 * JOB_WORKER_IN_WEB=false and the dedicated container (`dist/api/worker.js`, WORKER_ONLY=true) owns the
 * queue: leases, the boot repair, and the interval cycles. Without that rule two processes would fight
 * over the same rows, and the API would mark a healthy long run as lost while the worker was running it.
 */
function startBackgroundWork() {
  registerBackgroundHandlers();
  if (!config.JOB_WORKER_IN_WEB && !config.WORKER_ONLY) {
    console.log("[jobs] antrean milik proses pekerja terpisah (JOB_WORKER_IN_WEB=false); proses ini hanya melayani HTTP");
    return;
  }
  const recovered = recoverExpiredLeases();
  let boot = { runs: 0, executions: 0 };
  if (config.JOB_REAP_ON_BOOT) {
    const runs = reapAbandonedRuns(new Date(), config.JOB_REAP_BOOT_MIN_AGE_MS);
    const executions = reapAbandonedExecutions(new Date(), config.JOB_REAP_BOOT_MIN_AGE_MS);
    for (const run of runs.runs) recordAudit(projectAuditWorkspace(run.projectId), null, "run.reaped", { runId: run.id, reason: "WORKER_LOST_ON_BOOT", startedAt: run.startedAt });
    for (const execution of executions.executions) {
      recordAudit(projectAuditWorkspace(projectIdOfExecution(execution.id)), null, "workflow.execution.reaped", { executionId: execution.id, reason: "WORKER_LOST_ON_BOOT" });
    }
    boot = { runs: runs.marked, executions: executions.marked };
  }
  startJobWorker();
  void runJobCycleOnce({ owner: `boot-${process.pid}` }).catch(() => undefined);
  console.log(`[jobs] worker aktif (setiap ${config.JOB_WORKER_INTERVAL_MS} ms): sewa-dipulihkan=${recovered} run-ditinggalkan=${boot.runs} eksekusi-ditinggalkan=${boot.executions}`);
}

startBackgroundWork();
ensureCommerceSeed();
// Billed amounts written before the price column existed are filled in, so a database restored from
// an older backup does not report zero revenue and a negative margin in the price console.
{
  const filled = backfillSellCosts();
  if (filled > 0) console.log(`[pricing] harga jual baris lama dilengkapi: ${filled} baris`);
}
if (config.WORKER_ONLY) {
  // The dedicated worker container must never listen: nginx points at the API container only.
  console.log("[worker] HTTP tidak dijalankan (WORKER_ONLY=true); proses ini hanya mengerjakan antrean");
} else {
  await app.listen({ host: config.HOST, port: config.PORT });
  // Reads the engine model catalogue once at start-up so the first user request never pays the CLI cost.
  setTimeout(() => { try { engineModelCatalogue(); } catch { /* the catalogue is optional, runs still work */ } }, 0);
}

const stop = async () => { await app.close(); db.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

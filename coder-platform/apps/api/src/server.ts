import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { db } from "./db.js";
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

/** Runs one workflow prompt step through the configured agent engine. */
async function runWorkflowPrompt(prompt: string) {
  const runId = randomUUID();
  let text = "";
  for await (const event of engine.run({ runId, sessionId: runId, prompt })) {
    if (event.type === "text") text += typeof event.data === "string" ? event.data : JSON.stringify(event.data);
    if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "ENGINE_FAILED"));
  }
  return text;
}

function startWorkflowExecution(executionId: string) {
  setImmediate(() => { void runExecution(executionId, runWorkflowPrompt).catch((error) => app.log.error(error)); });
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
    return reply.code(201).send({ user: { id: userId, email, displayName }, workspace: { id: workspaceId, slug } });
  } catch (error) { if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "EMAIL_EXISTS" }); throw error; }
});
app.post<{ Body: { email?: string; password?: string } }>("/api/v1/auth/login", async (request, reply) => {
  const email = request.body?.email?.trim().toLowerCase(); const password = request.body?.password ?? "";
  const key = `${request.ip}:${email ?? "unknown"}`; if (!allowLoginAttempt(key)) return reply.code(429).send({ error: "LOGIN_RATE_LIMITED" });
  const row = email ? db.prepare("SELECT id,email,display_name AS displayName,password_hash AS passwordHash FROM users WHERE email=?").get(email) as { id:string; email:string; displayName:string; passwordHash:string|null }|undefined : undefined;
  if (!row?.passwordHash || !(await verifyPassword(password,row.passwordHash))) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  const token = createSession(row.id); setSessionCookie(reply, token, config.NODE_ENV === "production");
  return { user: { id: row.id, email: row.email, displayName: row.displayName } };
});
app.post("/api/v1/auth/logout", async (request, reply) => { deleteSession(request); clearSessionCookie(reply, config.NODE_ENV === "production"); return { ok: true }; });

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
  const { workspaceId } = request.params; const body = request.body ?? {}; const name = body.name?.trim(); const slug = body.slug?.trim().toLowerCase();
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
  return db.prepare("SELECT id, project_id AS projectId, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE project_id=? ORDER BY updated_at DESC").all(request.params.projectId);
});
app.post<{ Params: { projectId: string }; Body: { title?: string } }>("/api/v1/projects/:projectId/conversations", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
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

async function executeRun(runId: string, projectId: string, prompt: string, conversationId?: string) {
  const startedAt = new Date().toISOString();
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(startedAt, runId);
  let text = "";
  try {
    for await (const event of engine.run({ runId, sessionId: runId, prompt })) {
      if (event.type !== "completed") publishRunEvent(runId, event.type, event.data);
      if (event.type === "text") text += typeof event.data === "string" ? event.data : JSON.stringify(event.data);
      if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "ENGINE_FAILED"));
    }
    db.prepare("UPDATE runs SET status='completed', result=?, finished_at=? WHERE id=?").run(text || null, new Date().toISOString(), runId);
    publishRunEvent(runId, "completed", { result: text });
    if (conversationId) db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(),conversationId,"assistant",text || "",runId,new Date().toISOString());
  } catch (error) {
    const message = error instanceof Error ? error.message : "RUN_FAILED";
    db.prepare("UPDATE runs SET status='failed', error_code=?, finished_at=? WHERE id=?").run(message, new Date().toISOString(), runId);
    publishRunEvent(runId, "failed", { message });
  }
}

app.post<{ Params: { conversationId: string }; Body: { content?: string } }>("/api/v1/conversations/:conversationId/messages", { preHandler: requireUser }, async (request: any, reply) => {
  const content = request.body?.content?.trim();
  if (!content || content.length > 100_000) return reply.code(400).send({ error: "INVALID_MESSAGE" });
  const conversation = db.prepare("SELECT c.id, c.project_id AS projectId FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id) as { id: string; projectId: string } | undefined;
  if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  const runId = randomUUID(); const messageId = randomUUID(); const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare("INSERT INTO runs (id,project_id,status,prompt,created_at) VALUES (?,?,?,?,?)").run(runId, conversation.projectId, "queued", content, now);
    db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(messageId, conversation.id, "user", content, runId, now);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversation.id);
  }); transaction();
  void executeRun(runId, conversation.projectId, content, conversation.id);
  return reply.code(202).send({ message: { id: messageId, conversationId: conversation.id, role: "user", content, runId, createdAt: now }, run: { id: runId, status: "queued" } });
});

app.post<{ Params: { projectId: string }; Body: { prompt?: string } }>("/api/v1/projects/:projectId/runs", { preHandler: requireUser }, async (request: any, reply) => {
  const prompt = request.body?.prompt?.trim();
  if (!prompt || prompt.length > 100_000) return reply.code(400).send({ error: "INVALID_PROMPT" });
  const project = db.prepare("SELECT p.id, p.workspace_id AS workspaceId FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id) as { id: string; workspaceId: string } | undefined;
  if (!project) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const id = randomUUID(); const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO runs (id,project_id,status,prompt,created_at) VALUES (?,?,?,?,?)").run(id, project.id, "queued", prompt, createdAt);
  void executeRun(id, project.id, prompt);
  return reply.code(202).send({ id, projectId: project.id, status: "queued", prompt, createdAt });
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
  const run = db.prepare("SELECT r.id, r.project_id AS projectId, r.status, r.prompt, r.result, r.error_code AS errorCode, r.started_at AS startedAt, r.finished_at AS finishedAt, r.created_at AS createdAt FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE r.id=? AND m.user_id=?").get(request.params.runId, request.user!.id);
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
  const transaction = db.transaction(() => {
    db.prepare("INSERT INTO knowledge_documents (id,project_id,title,source_type,content,checksum,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id,request.params.projectId,title,"text",content,checksum,now,now);
    db.prepare("INSERT INTO knowledge_search (title,content,document_id) VALUES (?,?,?)").run(title,content,id);
  }); transaction();
  return reply.code(201).send({ id, projectId: request.params.projectId, title, sourceType: "text", checksum, createdAt: now, updatedAt: now });
});
app.get<{ Params: { projectId: string }; Querystring: { q?: string; limit?: string } }>("/api/v1/projects/:projectId/knowledge/search", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?").get(request.params.projectId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "PROJECT_NOT_FOUND" });
  const q = request.query?.q?.trim(); const limit = Math.min(Math.max(Number(request.query?.limit ?? 10) || 10, 1), 50);
  if (!q) return reply.code(400).send({ error: "QUERY_REQUIRED" });
  const rows = db.prepare("SELECT d.id, d.title, d.project_id AS projectId, snippet(knowledge_search, 1, '<mark>', '</mark>', '…', 24) AS snippet FROM knowledge_search JOIN knowledge_documents d ON d.id=knowledge_search.document_id WHERE d.project_id=? AND knowledge_search MATCH ? ORDER BY rank LIMIT ?").all(request.params.projectId, q.replace(/[\"']/g, " "), limit);
  return { query: q, results: rows };
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
  if (request.method !== "GET" || request.url.startsWith("/api/")) return reply.code(404).send({ error: "NOT_FOUND" });
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

const stop = async () => { await app.close(); db.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

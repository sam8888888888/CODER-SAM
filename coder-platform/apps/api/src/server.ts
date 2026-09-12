import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { UnconfiguredEngine, type AgentEngine } from "./engine-adapter.js";
import { clearSessionCookie, createSession, deleteSession, getSessionUser, hashPassword, requireUser, setSessionCookie, verifyPassword, type AuthRequest } from "./auth.js";

const app = Fastify({ logger: true, trustProxy: false });
const engine: AgentEngine = new UnconfiguredEngine();
await app.register(cookie);

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
  const exists = db.prepare("SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?").get(workspaceId, request.user!.id); if (!exists) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  const now = new Date().toISOString(); const id = randomUUID();
  try {
    db.prepare("INSERT INTO projects (id,workspace_id,name,slug,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id,workspaceId,name,slug,body.description?.trim() ?? "",now,now);
    return reply.code(201).send({ id, workspaceId, name, slug, description: body.description?.trim() ?? "", createdAt: now, updatedAt: now });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "PROJECT_SLUG_EXISTS" });
    throw error;
  }
});

async function executeRun(runId: string, projectId: string, prompt: string) {
  const startedAt = new Date().toISOString();
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(startedAt, runId);
  let text = "";
  try {
    for await (const event of engine.run({ runId, sessionId: runId, prompt })) {
      if (event.type === "text") text += typeof event.data === "string" ? event.data : JSON.stringify(event.data);
      if (event.type === "failed") throw new Error(String((event.data as { message?: string })?.message ?? "ENGINE_FAILED"));
    }
    db.prepare("UPDATE runs SET status='completed', result=?, finished_at=? WHERE id=?").run(text || null, new Date().toISOString(), runId);
  } catch (error) {
    db.prepare("UPDATE runs SET status='failed', error_code=?, finished_at=? WHERE id=?").run(error instanceof Error ? error.message : "RUN_FAILED", new Date().toISOString(), runId);
  }
}

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

app.setErrorHandler((error, _request, reply) => { app.log.error(error); return reply.code(500).send({ error: "INTERNAL_ERROR" }); });

mkdirSync(config.DATA_DIR, { recursive: true });
await app.listen({ host: config.HOST, port: config.PORT });

const stop = async () => { await app.close(); db.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { db } from "./db.js";
import { MockEngine, UnconfiguredEngine, type AgentEngine } from "./engine-adapter.js";
import { allowLoginAttempt, clearSessionCookie, createSession, deleteSession, getSessionUser, hashPassword, requireUser, setSessionCookie, verifyPassword, type AuthRequest } from "./auth.js";

const app = Fastify({ logger: true, trustProxy: false });
const engine: AgentEngine = config.MOCK_ENGINE ? new MockEngine() : new UnconfiguredEngine();
type Subscriber = (event: { type: string; data: unknown }) => void;
const subscribers = new Map<string, Set<Subscriber>>();
function publishRunEvent(runId: string, type: string, data: unknown) {
  db.prepare("INSERT INTO run_events (run_id,type,data_json,created_at) VALUES (?,?,?,?)").run(runId, type, JSON.stringify(data), new Date().toISOString());
  for (const send of subscribers.get(runId) ?? []) send({ type, data });
}
function subscribeRun(runId: string, send: Subscriber) { const set = subscribers.get(runId) ?? new Set<Subscriber>(); set.add(send); subscribers.set(runId, set); return () => { set.delete(send); if (!set.size) subscribers.delete(runId); }; }
function membershipRole(workspaceId: string, userId: string) { return (db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(workspaceId,userId) as { role: string } | undefined)?.role; }
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
  return reply.code(201).send({ id, projectId: request.params.projectId, title, createdAt: now, updatedAt: now });
});
app.get<{ Params: { conversationId: string } }>("/api/v1/conversations/:conversationId/messages", { preHandler: requireUser }, async (request: any, reply) => {
  const allowed = db.prepare("SELECT 1 FROM conversations c JOIN projects p ON p.id=c.project_id JOIN memberships m ON m.workspace_id=p.workspace_id WHERE c.id=? AND m.user_id=?").get(request.params.conversationId, request.user!.id);
  if (!allowed) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
  return db.prepare("SELECT id, conversation_id AS conversationId, role, content, run_id AS runId, created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at ASC").all(request.params.conversationId);
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

app.setErrorHandler((error, _request, reply) => { app.log.error(error); return reply.code(500).send({ error: "INTERNAL_ERROR" }); });

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
app.setNotFoundHandler(async (request, reply) => {
  if (request.method !== "GET" || request.url.startsWith("/api/")) return reply.code(404).send({ error: "NOT_FOUND" });
  const publicDir = normalize(config.PUBLIC_DIR); const requested = decodeURIComponent(request.url.split("?")[0]);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, ""); const candidate = normalize(join(publicDir, relative));
  if (!candidate.startsWith(publicDir)) return reply.code(404).send({ error: "NOT_FOUND" });
  try { const data = await readFile(candidate); return reply.type(contentTypes[extname(candidate)] ?? "application/octet-stream").send(data); }
  catch { try { const data = await readFile(join(publicDir, "index.html")); return reply.type("text/html; charset=utf-8").send(data); } catch { return reply.code(404).send({ error: "NOT_FOUND" }); } }
});

mkdirSync(config.DATA_DIR, { recursive: true });
await app.listen({ host: config.HOST, port: config.PORT });

const stop = async () => { await app.close(); db.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

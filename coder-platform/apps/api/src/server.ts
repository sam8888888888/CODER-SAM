import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { UnconfiguredEngine } from "./engine-adapter.js";

const app = Fastify({ logger: true, trustProxy: false });
const engine = new UnconfiguredEngine();
await app.register(cookie);

app.get("/health", async () => ({ status: "ok", service: "coder-api", time: new Date().toISOString() }));
app.get("/ready", async (_request, reply) => {
  const result = db.prepare("SELECT 1 AS ok").get() as { ok: number };
  const engineStatus = await engine.health();
  return reply.send({ status: result.ok === 1 ? "ready" : "not_ready", database: "ok", engine: engineStatus });
});

app.get("/api/v1/workspaces", async () => db.prepare("SELECT id, name, slug, created_at AS createdAt, updated_at AS updatedAt FROM workspaces ORDER BY created_at DESC").all());
app.post<{ Body: { name?: string; slug?: string } }>("/api/v1/workspaces", async (request, reply) => {
  const name = request.body?.name?.trim();
  const slug = request.body?.slug?.trim().toLowerCase();
  if (!name || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply.code(400).send({ error: "INVALID_WORKSPACE" });
  const now = new Date().toISOString(); const id = randomUUID();
  try {
    db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)").run(id,name,slug,now,now);
    return reply.code(201).send({ id, name, slug, createdAt: now, updatedAt: now });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "WORKSPACE_SLUG_EXISTS" });
    throw error;
  }
});

app.get<{ Params: { workspaceId: string } }>("/api/v1/workspaces/:workspaceId/projects", async (request) => db.prepare("SELECT id, workspace_id AS workspaceId, name, slug, description, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE workspace_id = ? ORDER BY created_at DESC").all(request.params.workspaceId));
app.post<{ Params: { workspaceId: string }; Body: { name?: string; slug?: string; description?: string } }>("/api/v1/workspaces/:workspaceId/projects", async (request, reply) => {
  const { workspaceId } = request.params; const body = request.body ?? {}; const name = body.name?.trim(); const slug = body.slug?.trim().toLowerCase();
  if (!name || !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return reply.code(400).send({ error: "INVALID_PROJECT" });
  const exists = db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(workspaceId); if (!exists) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
  const now = new Date().toISOString(); const id = randomUUID();
  try {
    db.prepare("INSERT INTO projects (id,workspace_id,name,slug,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id,workspaceId,name,slug,body.description?.trim() ?? "",now,now);
    return reply.code(201).send({ id, workspaceId, name, slug, description: body.description?.trim() ?? "", createdAt: now, updatedAt: now });
  } catch (error) {
    if (String(error).includes("UNIQUE")) return reply.code(409).send({ error: "PROJECT_SLUG_EXISTS" });
    throw error;
  }
});

app.setErrorHandler((error, _request, reply) => { app.log.error(error); return reply.code(500).send({ error: "INTERNAL_ERROR" }); });

mkdirSync(config.DATA_DIR, { recursive: true });
await app.listen({ host: config.HOST, port: config.PORT });

const stop = async () => { await app.close(); db.close(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);

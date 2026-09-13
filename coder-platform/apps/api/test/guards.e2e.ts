/**
 * Cost and speed guard suite: workspace limits block engine work and raise notifications.
 * Usage: npx tsx apps/api/test/guards.e2e.ts
 */
import { randomUUID } from "node:crypto";
const port = 3456;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-guards-${Date.now()}`; process.env.MOCK_ENGINE = "true";
process.env.DEFAULT_DAILY_COST_LIMIT_MICROS = "0"; process.env.DEFAULT_MONTHLY_COST_LIMIT_MICROS = "0"; process.env.DEFAULT_RUNS_PER_HOUR_LIMIT = "0";
await import("../src/server.js");
const { db } = await import("../src/db.js");
await new Promise((r) => setTimeout(r, 1200));
const base = `http://127.0.0.1:${port}`;
function client() {
  let cookie = "";
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json };
  };
}
let pass = 0; let fail = 0;
function check(name: string, ok: boolean, info = "") { if (ok) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} ${info}`); } }

const owner = client();
const reg = await owner("POST", "/api/v1/auth/register", { email: `guard-${randomUUID().slice(0, 8)}@example.test`, password: "GuardTest12345!", displayName: "Guard" });
const workspaceId = reg.json.workspace.id;
const project = await owner("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Guards", slug: `g-${Date.now()}` });
const projectId = project.json.id;

check("run allowed while unlimited", (await owner("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "halo" })).status === 202);

const limits = await owner("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: 1_000_000, monthlyCostLimitMicros: 0, runsPerHourLimit: 0 });
check("owner can set limits", limits.status === 200 && limits.json?.dailyCostLimitMicros === 1_000_000, JSON.stringify(limits.json));
const readLimits = await owner("GET", `/api/v1/workspaces/${workspaceId}/limits`);
check("owner can read the limits back", readLimits.status === 200 && readLimits.json?.dailyCostLimitMicros === 1_000_000 && readLimits.json?.effective?.dailyCostLimitMicros === 1_000_000, `${readLimits.status} ${JSON.stringify(readLimits.json)}`);

// Simulate a spent budget by writing a usage row, the same way a finished run would.
const spendRun = randomUUID();
db.prepare("INSERT INTO runs (id,project_id,status,prompt,created_at) VALUES (?,?,'completed','x',?)").run(spendRun, projectId, new Date().toISOString());
db.prepare("INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,cost_micros,estimated,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)")
  .run(randomUUID(), spendRun, projectId, "deepseek-v4-flash", "deepseek", 100, 10, 2_000_000, new Date().toISOString());

const blocked = await owner("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "halo lagi" });
check("cost limit blocks the run", blocked.status === 429 && blocked.json?.error === "COST_LIMIT_EXCEEDED", `${blocked.status} ${JSON.stringify(blocked.json)}`);
check("block response states the window and limit", blocked.json?.window === "day" && blocked.json?.limitMicros === 1_000_000, JSON.stringify(blocked.json));
const notes = await owner("GET", "/api/v1/notifications");
check("cost notification raised", (notes.json?.notifications ?? []).some((item: any) => item.kind === "cost" && /Batas biaya/.test(item.title)), JSON.stringify(notes.json).slice(0, 200));

check("limits can be raised again", (await owner("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: null, monthlyCostLimitMicros: null, runsPerHourLimit: 1 })).status === 200);
const rateBlocked = await owner("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "halo ketiga" });
check("run rate limit blocks the run", rateBlocked.status === 429 && rateBlocked.json?.error === "RUN_RATE_LIMITED", `${rateBlocked.status} ${JSON.stringify(rateBlocked.json)}`);

check("limits can be cleared", (await owner("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: 0, monthlyCostLimitMicros: 0, runsPerHourLimit: 0 })).status === 200);
check("run works again after clearing limits", (await owner("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "halo keempat" })).status === 202);

const member = client();
const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
await member("POST", "/api/v1/auth/register", { email: memberEmail, password: "GuardTest12345!", displayName: "Member" });
const invite = await owner("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: memberEmail, role: "member" });
await member("POST", "/api/v1/invitations/accept", { token: invite.json.token ?? invite.json.invitation?.token });
const forbidden = await member("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: 5_000_000 });
check("plain member cannot change limits", forbidden.status === 403 && forbidden.json?.error === "OWNER_REQUIRED", `${forbidden.status} ${JSON.stringify(forbidden.json)}`);
const memberReadLimits = await member("GET", `/api/v1/workspaces/${workspaceId}/limits`);
check("plain member may read the limits", memberReadLimits.status === 200 && typeof memberReadLimits.json?.effective?.monthlyCostLimitMicros === "number", `${memberReadLimits.status} ${JSON.stringify(memberReadLimits.json)}`);

// Workflow execution must obey the same cost guard.
const workflow = await owner("POST", `/api/v1/projects/${projectId}/workflows`, { name: "wf guard", steps: [{ id: "a", type: "prompt", prompt: "hai" }] });
await owner("POST", `/api/v1/workflows/${workflow.json.id}/publish`);
await owner("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: 1000 });
const workflowBlocked = await owner("POST", `/api/v1/workflows/${workflow.json.id}/execute`, { input: "x" });
check("cost limit blocks workflow execution", workflowBlocked.status === 429 && workflowBlocked.json?.error === "COST_LIMIT_EXCEEDED", `${workflowBlocked.status} ${JSON.stringify(workflowBlocked.json)}`);
await owner("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: 0 });
const workflowAllowed = await owner("POST", `/api/v1/workflows/${workflow.json.id}/execute`, { input: "x" });
check("workflow runs after clearing the limit", workflowAllowed.status === 202, `${workflowAllowed.status} ${JSON.stringify(workflowAllowed.json)}`);

const schema = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
check("schema version recorded", schema.version >= 6, String(schema.version));

console.log(fail === 0 ? "ALL_GUARD_TESTS_PASSED" : `GUARD_FAILURES=${fail}`);
console.log(`GUARD_SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Real provider usage check: the engine must report tokens and the API must price the run from the
 * published price table (estimated=0, cost>0). Needs a provider key in the environment.
 * Usage: PRIME_AGENT_PROVIDER=deepseek PRIME_AGENT_MODEL=deepseek-v4-flash npx tsx apps/api/test/real-usage.e2e.ts
 */
import { randomUUID } from "node:crypto";

const port = 3448;
process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-real-usage-${Date.now()}`;
process.env.MOCK_ENGINE = "false";
process.env.PRIME_AGENT_BIN = process.env.PRIME_AGENT_BIN ?? "prime-agent";
process.env.PRIME_AGENT_PROVIDER = process.env.PRIME_AGENT_PROVIDER ?? "deepseek";
process.env.PRIME_AGENT_MODEL = process.env.PRIME_AGENT_MODEL ?? "deepseek-v4-flash";
process.env.ENGINE_ROOT_DIR = `${process.env.DATA_DIR}/engine-sessions`;

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 1200));

const base = `http://127.0.0.1:${port}`;
let cookie = "";
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

const model = process.env.PRIME_AGENT_MODEL!;
const registered = await call("POST", "/api/v1/auth/register", { email: `realusage-${randomUUID().slice(0, 8)}@example.test`, password: "Usage12345!", displayName: "Real Usage" });
check("register works", Boolean(registered.json.workspace?.id), JSON.stringify(registered.json).slice(0, 160));
const projectId = (await call("POST", `/api/v1/workspaces/${registered.json.workspace.id}/projects`, { name: "Real", slug: `r-${Date.now()}` })).json.id;
const conversation = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "real usage" });
const sent = await call("POST", `/api/v1/conversations/${conversation.json.conversation.id}/messages`, { content: "Balas satu kata: siap", model });
check("message accepted", sent.status === 202, JSON.stringify(sent.json).slice(0, 160));
let run: any = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  run = (await call("GET", `/api/v1/runs/${sent.json.run.id}`)).json;
  if (["completed", "failed", "cancelled"].includes(run?.status)) break;
}
check("run completed with text", run?.status === "completed" && String(run?.result ?? "").trim().length > 0, `status=${run?.status} result=${String(run?.result).slice(0, 60)}`);

const usage = await call("GET", `/api/v1/projects/${projectId}/usage?days=30`);
const totals = usage.json.totals;
check("usage comes from the engine, not an estimate", totals.runs === 1 && totals.estimatedRuns === 0 && totals.measuredRuns === 1, JSON.stringify(totals));
check("input tokens are reported", totals.inputTokens > 0, String(totals.inputTokens));
check("output tokens are reported", totals.outputTokens > 0, String(totals.outputTokens));
check("total tokens are reported", totals.totalTokens === totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens, JSON.stringify(totals));
check("cost is priced from the price table", totals.costMicros > 0 && totals.unpricedRuns === 0, JSON.stringify(totals));
check("cost in US dollars matches the micros", Math.abs(totals.costUsd * 1_000_000 - totals.costMicros) < 1, `${totals.costUsd} vs ${totals.costMicros}`);
console.log(`INFO real usage: ${JSON.stringify(totals)}`);
console.log(failures === 0 ? "ALL_REAL_USAGE_TESTS_PASSED" : `REAL_USAGE_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

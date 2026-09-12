/**
 * Real provider end-to-end test: chat run, SSE stream and a workflow prompt step.
 * Requires a provider key in the environment (for example DEEPSEEK_API_KEY).
 * Usage: PRIME_AGENT_MODEL=deepseek-v4-flash PRIME_AGENT_PROVIDER=deepseek npx tsx apps/api/test/real-ai.e2e.ts
 */
import { randomUUID } from "node:crypto";

const port = 3424;
process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-real-ai-${Date.now()}`;
process.env.MOCK_ENGINE = "false";
process.env.PRIME_AGENT_BIN = process.env.PRIME_AGENT_BIN ?? "prime-agent";
process.env.ENGINE_ROOT_DIR = `${process.env.DATA_DIR}/engine-sessions`;

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 1200));

const base = `http://127.0.0.1:${port}`;
let cookie = "";
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

const register = await call("POST", "/api/v1/auth/register", { email: `real-${randomUUID().slice(0, 8)}@example.test`, password: "RealAiTest123!", displayName: "Real AI" });
check("register works", register.status === 201, JSON.stringify(register.json));
const workspaceId = register.json.workspace.id;
const project = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "AI Project", slug: `ai-${Date.now()}` });
const projectId = project.json.id;
check("project created", Boolean(projectId));

// 1. Chat run with streaming, using the real provider.
const conversation = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "AI chat" });
const conversationId = conversation.json.conversation.id;
const sent = await call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Balas tepat satu kata: siap" });
check("message accepted", [200, 201, 202].includes(sent.status) && Boolean(sent.json.run?.id), JSON.stringify(sent.json));
const runId = sent.json.run.id;

const streamed = await new Promise<string>(async (resolve) => {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); resolve("TIMEOUT"); }, 120000);
  try {
    const response = await fetch(`${base}/api/v1/runs/${runId}/events`, { headers: { cookie, accept: "text/event-stream" }, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: completed")) break;
    }
    clearTimeout(timer); resolve(buffer);
  } catch (error) { clearTimeout(timer); resolve(`ERROR ${String(error)}`); }
});
check("SSE stream completed", streamed.includes("event: completed"), streamed.slice(0, 200));
check("SSE stream carries model text", /event: text[\s\S]{0,200}siap/.test(streamed), streamed.slice(0, 400));

const messages = await call("GET", `/api/v1/conversations/${conversationId}/messages`);
const assistant = messages.json.messages.find((message: any) => message.role === "assistant");
check("assistant reply stored with real text", Boolean(assistant?.content?.trim()), JSON.stringify(messages.json)?.slice(0, 200));
check("message history API returns a messages array", Array.isArray(messages.json.messages), JSON.stringify(Object.keys(messages.json ?? {})));

// 2. Workflow prompt step through the real provider.
const workflow = await call("POST", `/api/v1/projects/${projectId}/workflows`, { name: "AI step", steps: [{ id: "ask", type: "prompt", prompt: "Balas tepat satu kata: siap" }] });
await call("POST", `/api/v1/workflows/${workflow.json.id}/publish`);
const execution = await call("POST", `/api/v1/workflows/${workflow.json.id}/execute`, { input: "" });
let detail: any = null;
for (let attempt = 0; attempt < 150; attempt += 1) {
  detail = (await call("GET", `/api/v1/workflow-executions/${execution.json.id}`)).json;
  if (["completed", "failed", "cancelled"].includes(detail?.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check("workflow prompt step completed", detail?.status === "completed", JSON.stringify({ status: detail?.status, error: detail?.error })?.slice(0, 300));
const stepOutput = detail?.steps?.[0]?.output ?? "";
check("workflow step captured model output", stepOutput.includes("siap"), JSON.stringify(stepOutput).slice(0, 200));
const audit = await call("GET", `/api/v1/workspaces/${workspaceId}/audit`);
const actions = (audit.json ?? []).map((row: any) => row.action);
check("audit records the real run", actions.includes("workflow.execution.completed"), JSON.stringify(actions.slice(0, 6)));

console.log(failures === 0 ? "REAL_AI_TESTS_PASSED" : `REAL_AI_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

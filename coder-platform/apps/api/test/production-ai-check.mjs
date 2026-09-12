/**
 * Verifies real AI in production: model catalogue, chat answer, workflow prompt step and usage.
 * Requires CODER_EMAIL and CODER_PASSWORD (the smoke bot account).
 */
const BASE = process.env.BASE_URL ?? "https://coder.sam.university";
let cookie = "";
let failures = 0;
function check(name, ok, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }
async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const login = await call("POST", "/api/v1/auth/login", { email: process.env.CODER_EMAIL, password: process.env.CODER_PASSWORD });
check("login works", login.status === 200, JSON.stringify(login.json)?.slice(0, 120));
const catalogue = await call("GET", "/api/v1/models");
check("model catalogue is not empty", Array.isArray(catalogue.json.models) && catalogue.json.models.length > 0, JSON.stringify(catalogue.json)?.slice(0, 200));
const model = catalogue.json.models?.[0]?.model ?? "deepseek-v4-flash";
check("configured default model is reported", Boolean(catalogue.json.default?.model), JSON.stringify(catalogue.json.default));

const workspaces = await call("GET", "/api/v1/workspaces");
// A fresh project keeps the usage window clean, so the totals describe only this check.
const workspaceId = workspaces.json[0].id;
const project = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: `AI check ${Date.now()}`, slug: `ai-check-${Date.now()}` });
const projectId = project.json.id;
check("check project created", Boolean(projectId), JSON.stringify(project.json)?.slice(0, 160));

const conversation = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: `AI check ${Date.now()}` });
const conversationId = conversation.json.conversation.id;
const sent = await call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Balas satu kata saja: siap", model });
check("message accepted", sent.status === 202, JSON.stringify(sent.json)?.slice(0, 160));
const runId = sent.json.run?.id;
let run = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await wait(3000);
  const detail = await call("GET", `/api/v1/runs/${runId}`);
  run = detail.json;
  if (["completed", "failed", "cancelled"].includes(run?.status)) break;
}
check("chat run completed with an answer", run?.status === "completed" && typeof run?.result === "string" && run.result.trim().length > 0, `status=${run?.status} error=${run?.errorCode} result=${String(run?.result).slice(0, 120)}`);
console.log(`INFO chat answer: ${String(run?.result ?? "").trim().slice(0, 80)}`);
check("chat run recorded the selected model", run?.model === model, `model=${run?.model}`);

const messages = await call("GET", `/api/v1/conversations/${conversationId}/messages`);
const assistant = (messages.json?.messages ?? []).find((row) => row.role === "assistant");
check("assistant message stored", Boolean(assistant && assistant.content?.trim().length > 0), JSON.stringify(messages.json).slice(0, 160));

const flow = await call("POST", `/api/v1/projects/${projectId}/workflows`, { name: `AI step check ${Date.now()}`, steps: [{ id: "ask", type: "prompt", prompt: "Balas satu kata: siap" }] });
await call("POST", `/api/v1/workflows/${flow.json.id}/publish`);
const executed = await call("POST", `/api/v1/workflows/${flow.json.id}/execute`, { input: "" });
check("workflow execution accepted", executed.status === 202 || executed.status === 200, JSON.stringify(executed.json)?.slice(0, 160));
let execution = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await wait(3000);
  const detail = await call("GET", `/api/v1/workflow-executions/${executed.json.id}`);
  execution = detail.json;
  if (["completed", "failed", "cancelled"].includes(execution?.status)) break;
}
check("workflow prompt step completed", execution?.status === "completed", `status=${execution?.status} error=${String(execution?.error ?? "").slice(0, 200)}`);
const promptStep = (execution?.steps ?? []).find((step) => step.type === "prompt");
check("workflow step stored output", Boolean(promptStep && String(promptStep.output ?? "").trim().length > 0), JSON.stringify(promptStep)?.slice(0, 200));
console.log(`INFO workflow step output: ${String(promptStep?.output ?? "").trim().slice(0, 80)}`);

const usage = await call("GET", `/api/v1/projects/${projectId}/usage?days=30`);
const totals = usage.json?.totals ?? {};
// Two engine runs in this project: the chat run and the workflow prompt step.
check("usage counts both engine runs", totals.runs === 2, JSON.stringify(totals));
check("usage reports engine tokens", totals.inputTokens > 0 && totals.outputTokens > 0, JSON.stringify(totals));
check("usage is measured, not estimated", totals.estimatedRuns === 0 && totals.measuredRuns === 2, JSON.stringify(totals));
check("usage prices every run in US dollars", totals.costMicros > 0 && totals.costUsd > 0 && totals.unpricedRuns === 0, JSON.stringify(totals));
console.log(`INFO usage: ${JSON.stringify(usage.json?.totals)}`);

await call("DELETE", `/api/v1/conversations/${conversationId}`);
console.log(failures === 0 ? "PRODUCTION_AI_CHECK_PASSED" : `PRODUCTION_AI_CHECK_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

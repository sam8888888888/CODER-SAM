/**
 * End-to-end test for the workflow engine over the real HTTP API.
 * Run: npx tsx apps/api/test/workflow-engine.e2e.ts
 */
process.env.DATA_DIR = `/tmp/coder-wf-e2e-${Date.now()}`;
process.env.PORT = "3422";
process.env.MOCK_ENGINE = "true";
process.env.NODE_ENV = "test";

let cookie = "";
let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name} ${detail}`);
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:3422${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

async function waitFor(executionId: string, wanted: string[], timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await call("GET", `/api/v1/workflow-executions/${executionId}`);
    if (last.json && wanted.includes(last.json.status)) return last.json;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return last?.json;
}

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 300));

const registered = await call("POST", "/api/v1/auth/register", { email: `wf-${Date.now()}@example.test`, password: "Strong-pass-123!", displayName: "WF Tester" });
check("register returns 201", registered.status === 201, JSON.stringify(registered.json));
const workspaceId = registered.json.workspace.id;

const project = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "WF Project", slug: `wf-${Date.now()}` });
check("project created", project.status === 201 || project.status === 200, JSON.stringify(project.json));
const projectId = project.json.id;

// Workflow with prompt -> condition -> approval -> prompt -> branch -> prompt (skipped) -> prompt
const steps = [
  { id: "start", type: "prompt", prompt: "Analisa: {{input}}" },
  { id: "gate", type: "condition", field: "steps.start", op: "contains", value: "Received", goto: "skip-me" },
  { id: "human", type: "approval", value: "Perlu persetujuan" },
  { id: "after", type: "prompt", prompt: "Lanjut setelah approval" },
  { id: "route", type: "branch", cases: [{ field: "steps.after", op: "contains", value: "Lanjut", goto: "finish" }], default: "skip-me" },
  { id: "skip-me", type: "prompt", prompt: "Tidak boleh jalan" },
  { id: "finish", type: "prompt", prompt: "Selesai" },
];
const workflow = await call("POST", `/api/v1/projects/${projectId}/workflows`, { name: "Approval flow", steps });
check("workflow created 201", workflow.status === 201, JSON.stringify(workflow.json));
const workflowId = workflow.json.id;

const tooEarly = await call("POST", `/api/v1/workflows/${workflowId}/execute`, { input: "halo" });
check("execute blocked before publish (409)", tooEarly.status === 409 && tooEarly.json.error === "WORKFLOW_NOT_PUBLISHED", JSON.stringify(tooEarly.json));

await call("POST", `/api/v1/workflows/${workflowId}/publish`);
const started = await call("POST", `/api/v1/workflows/${workflowId}/execute`, { input: "halo dunia" });
check("execute accepted 202", started.status === 202, JSON.stringify(started.json));
const executionId = started.json.id;

const paused = await waitFor(executionId, ["awaiting_approval", "failed"]);
check("workflow pauses on approval step", paused?.status === "awaiting_approval", JSON.stringify(paused?.status));
check("approval status pending", paused?.approvalStatus === "pending", String(paused?.approvalStatus));
check("prompt step ran through engine", String(paused?.steps?.[0]?.output ?? "").includes("Received: Analisa: halo dunia"), JSON.stringify(paused?.steps?.[0]?.output));
check("condition step evaluated true", String(paused?.steps?.[1]?.output ?? "").includes("\"passed\":true"), JSON.stringify(paused?.steps?.[1]?.output));

const approved = await call("POST", `/api/v1/workflow-executions/${executionId}/approval`, { decision: "approved" });
check("approval accepted", approved.status === 200 && approved.json.approvalStatus === "approved", JSON.stringify(approved.json));

const done = await waitFor(executionId, ["completed", "failed"]);
check("workflow completed after approval", done?.status === "completed", JSON.stringify(done?.status));
check("branch skipped the unused step", !String(done?.output ?? "").includes("Tidak boleh jalan"), String(done?.output).slice(0, 200));
check("branch jumped to finish step", String(done?.output ?? "").includes("finish"), String(done?.output).slice(0, 200));
check("step records stored", Array.isArray(done?.steps) && done.steps.length >= 6, `steps=${done?.steps?.length}`);

const retried = await call("POST", `/api/v1/workflow-executions/${executionId}/retry`);
check("retry accepted 202", retried.status === 202 && retried.json.attempt === 2, JSON.stringify(retried.json));
await waitFor(retried.json.id, ["completed", "failed", "awaiting_approval"]);

// Rejected approval path
const execution2 = await call("POST", `/api/v1/workflows/${workflowId}/execute`, { input: "tolak" });
const paused2 = await waitFor(execution2.json.id, ["awaiting_approval"]);
check("second run pauses on approval", paused2?.status === "awaiting_approval", String(paused2?.status));
const rejected = await call("POST", `/api/v1/workflow-executions/${execution2.json.id}/approval`, { decision: "rejected" });
check("reject marks execution failed", rejected.status === 200 && rejected.json.status === "failed", JSON.stringify(rejected.json));

// Cancel path with a delay step
const slow = await call("POST", `/api/v1/projects/${projectId}/workflows`, {
  name: "Slow flow",
  steps: [{ id: "wait", type: "delay", seconds: 1 }, { id: "after-wait", type: "prompt", prompt: "harusnya tidak jalan" }],
});
await call("POST", `/api/v1/workflows/${slow.json.id}/publish`);
const slowRun = await call("POST", `/api/v1/workflows/${slow.json.id}/execute`, { input: "" });
await new Promise((resolve) => setTimeout(resolve, 200));
const cancelled = await call("POST", `/api/v1/workflow-executions/${slowRun.json.id}/cancel`);
check("cancel accepted", cancelled.status === 200 && cancelled.json.status === "cancelled", JSON.stringify(cancelled.json));
const cancelFinal = await waitFor(slowRun.json.id, ["cancelled"]);
check("cancelled execution stays cancelled", cancelFinal?.status === "cancelled", String(cancelFinal?.status));
const cancelAgain = await call("POST", `/api/v1/workflow-executions/${slowRun.json.id}/cancel`);
check("cancel twice rejected 409", cancelAgain.status === 409, JSON.stringify(cancelAgain.json));

// Schedule
const scheduled = await call("POST", `/api/v1/workflows/${workflowId}/schedule`, { enabled: true, intervalMinutes: 30 });
check("schedule enabled", scheduled.status === 200 && Boolean(scheduled.json.nextRunAt), JSON.stringify(scheduled.json));
const listed = await call("GET", `/api/v1/projects/${projectId}/workflows`);
const listedWorkflow = (listed.json as any[]).find((item) => item.id === workflowId);
check("workflow list exposes schedule fields for UI", listedWorkflow?.scheduleEnabled === true && listedWorkflow?.intervalMinutes === 30, JSON.stringify(listedWorkflow?.scheduleEnabled));

// Step editor update
const edited = await call("PUT", `/api/v1/workflows/${workflowId}`, { name: "Approval flow v2", steps: [{ id: "only", type: "prompt", prompt: "baru" }] });
check("workflow steps updated", edited.status === 200, JSON.stringify(edited.json));
const afterEdit = await call("GET", `/api/v1/projects/${projectId}/workflows`);
check("updated steps persisted", (afterEdit.json as any[]).find((item) => item.id === workflowId)?.steps?.length === 1, "steps not persisted");

// Audit trail
const audit = await call("GET", `/api/v1/workspaces/${workspaceId}/audit`);
const actions = Array.isArray(audit.json) ? audit.json.map((row: any) => row.action) : [];
check("audit records workflow execution", actions.includes("workflow.execution.completed"), JSON.stringify(actions));
check("audit records approval", actions.some((action: string) => action.startsWith("workflow.execution.approval")), JSON.stringify(actions));

console.log(failures === 0 ? "ALL_WORKFLOW_TESTS_PASSED" : `WORKFLOW_TEST_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Production smoke test for the workflow engine. Runs against a live domain.
 * Usage: BASE_URL=https://... CODER_EMAIL=... CODER_PASSWORD=... node apps/api/test/production-smoke.mjs
 */
const BASE = process.env.BASE_URL ?? "https://coder.sam.university";
const EMAIL = process.env.CODER_EMAIL;
const PASSWORD = process.env.CODER_PASSWORD;
if (!EMAIL || !PASSWORD) { console.log("SKIP missing credentials in env"); process.exit(2); }

let cookie = "";
let failures = 0;
function check(name, ok, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

async function waitFor(executionId, wanted, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call("GET", `/api/v1/workflow-executions/${executionId}`);
    if (wanted.includes(last.json?.status)) return last.json;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last?.json;
}

const login = await call("POST", "/api/v1/auth/login", { email: EMAIL, password: PASSWORD });
check("login works", login.status === 200 && Boolean(login.json?.user), JSON.stringify(login.json));
if (login.status !== 200) process.exit(1);

const workspaces = await call("GET", "/api/v1/workspaces");
const workspaceId = workspaces.json[0].id;
const projects = await call("GET", `/api/v1/workspaces/${workspaceId}/projects`);
let projectId = projects.json[0]?.id;
if (!projectId) {
  const created = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Workflow Prod", slug: `workflow-prod-${Date.now()}` });
  projectId = created.json.id;
}
check("project available", Boolean(projectId), JSON.stringify(projects.json));

// Approval flow that needs no AI provider: condition -> approval -> delay
const approvalFlow = await call("POST", `/api/v1/projects/${projectId}/workflows`, {
  name: `Approval prod ${Date.now()}`,
  steps: [
    { id: "gate", type: "condition", field: "input", op: "contains", value: "ok", goto: "stop" },
    { id: "human", type: "approval", value: "Perlu persetujuan pemilik" },
    { id: "wait", type: "delay", seconds: 1 },
  ],
});
check("workflow created", approvalFlow.status === 201, JSON.stringify(approvalFlow.json));
const approvalWorkflowId = approvalFlow.json.id;
const publish = await call("POST", `/api/v1/workflows/${approvalWorkflowId}/publish`);
check("workflow published", publish.status === 200 && publish.json.status === "published", JSON.stringify(publish.json));

const run = await call("POST", `/api/v1/workflows/${approvalWorkflowId}/execute`, { input: "ok jalan" });
check("execution started", run.status === 202 && Boolean(run.json.id), JSON.stringify(run.json));
const paused = await waitFor(run.json.id, ["awaiting_approval", "failed", "completed"]);
check("execution pauses on approval step", paused?.status === "awaiting_approval", JSON.stringify(paused?.status));
check("condition step recorded", paused?.steps?.[0]?.status === "completed", JSON.stringify(paused?.steps?.[0]?.status));

const approve = await call("POST", `/api/v1/workflow-executions/${run.json.id}/approval`, { decision: "approved" });
check("approval accepted", approve.status === 200 && approve.json.status === "running", JSON.stringify(approve.json));
const finished = await waitFor(run.json.id, ["completed", "failed"]);
check("execution resumes and completes after approval", finished?.status === "completed", JSON.stringify(finished?.status));
check("delay step ran", finished?.steps?.some((step) => step.type === "delay" && step.status === "completed"), JSON.stringify(finished?.steps?.map((step) => step.status)));

// Cancel flow
const cancelFlow = await call("POST", `/api/v1/projects/${projectId}/workflows`, { name: `Cancel prod ${Date.now()}`, steps: [{ id: "w1", type: "delay", seconds: 3 }, { id: "w2", type: "delay", seconds: 1 }] });
await call("POST", `/api/v1/workflows/${cancelFlow.json.id}/publish`);
const cancelRun = await call("POST", `/api/v1/workflows/${cancelFlow.json.id}/execute`, { input: "" });
const cancel = await call("POST", `/api/v1/workflow-executions/${cancelRun.json.id}/cancel`);
check("cancel accepted", cancel.status === 200 && cancel.json.status === "cancelled", JSON.stringify(cancel.json));
const cancelFinal = await waitFor(cancelRun.json.id, ["cancelled"], 15000);
check("cancelled execution stays cancelled", cancelFinal?.status === "cancelled", JSON.stringify(cancelFinal?.status));

// Retry flow
const retry = await call("POST", `/api/v1/workflow-executions/${cancelRun.json.id}/retry`);
check("retry creates new attempt", retry.status === 202 && retry.json.attempt === 2, JSON.stringify(retry.json));
await call("POST", `/api/v1/workflow-executions/${retry.json.id}/cancel`);

// Schedule
const schedule = await call("POST", `/api/v1/workflows/${approvalWorkflowId}/schedule`, { enabled: true, intervalMinutes: 120 });
check("schedule enabled with next run", schedule.status === 200 && Boolean(schedule.json.nextRunAt), JSON.stringify(schedule.json));
const listed = await call("GET", `/api/v1/projects/${projectId}/workflows`);
const listedWorkflow = listed.json.find((item) => item.id === approvalWorkflowId);
check("schedule visible in workflow list", listedWorkflow?.scheduleEnabled === true && listedWorkflow?.intervalMinutes === 120, JSON.stringify(listedWorkflow?.scheduleEnabled));
const unschedule = await call("POST", `/api/v1/workflows/${approvalWorkflowId}/schedule`, { enabled: false, intervalMinutes: null });
check("schedule can be disabled", unschedule.status === 200 && unschedule.json.nextRunAt === null, JSON.stringify(unschedule.json));

// Step editor update keeps the workflow usable
const edit = await call("PUT", `/api/v1/workflows/${approvalWorkflowId}`, { name: listedWorkflow.name, steps: [{ id: "only", type: "approval", value: "final check" }] });
check("workflow steps editable", edit.status === 200, JSON.stringify(edit.json));

// Audit trail
const audit = await call("GET", `/api/v1/workspaces/${workspaceId}/audit`);
const actions = Array.isArray(audit.json) ? audit.json.map((row) => row.action) : [];
check("audit records execution start", actions.includes("workflow.execution.started"), JSON.stringify(actions.slice(0, 8)));
check("audit records approval decision", actions.includes("workflow.execution.approval.approved"), JSON.stringify(actions.slice(0, 8)));
check("audit records cancel", actions.includes("workflow.execution.cancel_requested"), JSON.stringify(actions.slice(0, 8)));
check("audit records schedule change", actions.includes("workflow.schedule.updated"), JSON.stringify(actions.slice(0, 8)));

// Knowledge base: upload, index, search, delete
const token = `TOKEN-${Date.now()}`;
const document = await call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, {
  filename: "catatan-live.txt",
  contentBase64: Buffer.from(`Catatan rilis produksi.\n\n${"Baris pengisi untuk pengujian chunking dokumen produksi. ".repeat(60)}\n\nToken produksi adalah ${token}.`).toString("base64"),
});
check("knowledge upload works", document.status === 201 && document.json.chunkCount > 1, JSON.stringify(document.json)?.slice(0, 200));
const knowledgeSearch = await call("GET", `/api/v1/projects/${projectId}/knowledge/search?q=${encodeURIComponent(token)}`);
check("knowledge search finds the uploaded text", Array.isArray(knowledgeSearch.json) && knowledgeSearch.json.some((hit) => hit.content.includes(token)), JSON.stringify(knowledgeSearch.json)?.slice(0, 200));
const duplicateDocument = await call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, {
  filename: "catatan-live.txt",
  contentBase64: Buffer.from(`Catatan rilis produksi.\n\n${"Baris pengisi untuk pengujian chunking dokumen produksi. ".repeat(60)}\n\nToken produksi adalah ${token}.`).toString("base64"),
});
check("duplicate knowledge upload rejected", duplicateDocument.status === 409, JSON.stringify(duplicateDocument.json));
const documentDetail = await call("GET", `/api/v1/projects/${projectId}/knowledge/${document.json.id}`);
check("knowledge document detail exposes chunks", documentDetail.status === 200 && documentDetail.json.chunks.length > 0, JSON.stringify(documentDetail.json)?.slice(0, 160));
const documentDelete = await call("DELETE", `/api/v1/projects/${projectId}/knowledge/${document.json.id}`);
check("knowledge document deleted", documentDelete.status === 200 && documentDelete.json.deleted === true, JSON.stringify(documentDelete.json));
const searchAfterDelete = await call("GET", `/api/v1/projects/${projectId}/knowledge/search?q=${encodeURIComponent(token)}`);
check("deleted knowledge leaves no search hit", Array.isArray(searchAfterDelete.json) && !searchAfterDelete.json.some((hit) => hit.content.includes(token)), JSON.stringify(searchAfterDelete.json)?.slice(0, 160));

// Team: members, invitation, revoke
const members = await call("GET", `/api/v1/workspaces/${workspaceId}/members`);
check("member list works", members.status === 200 && members.json.some((member) => member.role === "owner"), JSON.stringify(members.json)?.slice(0, 200));
const invite = await call("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: `smoke-${Date.now()}@example.test`, role: "viewer" });
check("invitation created", invite.status === 201 && Boolean(invite.json.token), JSON.stringify(invite.json)?.slice(0, 160));
const inviteList = await call("GET", `/api/v1/workspaces/${workspaceId}/invitations`);
check("invitation listed", inviteList.status === 200 && inviteList.json.some((row) => row.id === invite.json.id), JSON.stringify(inviteList.json)?.slice(0, 160));
const revoke = await call("DELETE", `/api/v1/invitations/${invite.json.id}`);
check("invitation revoked", revoke.status === 200 && revoke.json.revoked === true, JSON.stringify(revoke.json));
const artifacts = await call("GET", `/api/v1/projects/${projectId}/artifacts`);
check("artifact list works", artifacts.status === 200 && Array.isArray(artifacts.json), JSON.stringify(artifacts.json)?.slice(0, 160));

// Conversation management and usage tracking
const exportable = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Smoke chat" });
const exportId = exportable.json.conversation.id;
const rename = await call("PATCH", `/api/v1/conversations/${exportId}`, { title: "Smoke chat renamed", pinned: true });
check("conversation renamed and pinned", rename.status === 200 && rename.json.pinned === true && rename.json.title === "Smoke chat renamed", JSON.stringify(rename.json));
const conversationList = await call("GET", `/api/v1/projects/${projectId}/conversations`);
check("conversation list exposes pinned", conversationList.json.some((row) => row.id === exportId && row.pinned === 1), JSON.stringify(conversationList.json)?.slice(0, 160));
const exportedConversation = await call("GET", `/api/v1/conversations/${exportId}/export`);
check("conversation export works", exportedConversation.status === 200 && exportedConversation.json.format === "coblai.conversation.v1", JSON.stringify(exportedConversation.json)?.slice(0, 160));
const importedConversation = await call("POST", `/api/v1/projects/${projectId}/conversations/import`, { conversation: { title: "Smoke imported", messages: [{ role: "user", content: "halo" }, { role: "assistant", content: "hai" }] } });
check("conversation import works", importedConversation.status === 201 && importedConversation.json.conversation.messages === 2, JSON.stringify(importedConversation.json));
const usage = await call("GET", `/api/v1/projects/${projectId}/usage?days=30`);
check("usage endpoint responds", usage.status === 200 && typeof usage.json.totals.runs === "number", JSON.stringify(usage.json)?.slice(0, 200));
const deletedConversation = await call("DELETE", `/api/v1/conversations/${exportId}`);
check("conversation deleted", deletedConversation.status === 200 && deletedConversation.json.deleted === true, JSON.stringify(deletedConversation.json));

console.log(failures === 0 ? "PRODUCTION_SMOKE_PASSED" : `PRODUCTION_SMOKE_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

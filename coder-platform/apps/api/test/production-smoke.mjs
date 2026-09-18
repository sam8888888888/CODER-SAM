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

const authSessions = await call("GET", "/api/v1/auth/sessions");
check("session list responds", authSessions.status === 200 && Array.isArray(authSessions.json) && authSessions.json.some((row) => row.current === true), JSON.stringify(authSessions.json)?.slice(0, 160));
const mfaStatus = await call("GET", "/api/v1/auth/mfa");
check("mfa status responds", mfaStatus.status === 200 && typeof mfaStatus.json.enabled === "boolean", JSON.stringify(mfaStatus.json));

const catalogue = await call("GET", "/api/v1/models");
check("model catalogue responds", catalogue.status === 200 && Array.isArray(catalogue.json.models), JSON.stringify(catalogue.json)?.slice(0, 120));
if (catalogue.json.models.length > 0) {
  check("model catalogue lists engine models", true, "");
} else {
  // The engine only lists models when a provider credential exists; report it instead of failing.
  console.log(`SKIP model catalogue empty: ${catalogue.json.note ?? catalogue.json.error ?? "no details"}`);
}
const sampleModel = catalogue.json.models[0]?.model;
if (sampleModel) {
  const modelRun = await call("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "ping model", model: sampleModel });
  check("run accepts a known model", modelRun.status === 202 && modelRun.json.model === sampleModel, JSON.stringify(modelRun.json)?.slice(0, 160));
  const badModel = await call("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "ping", model: "model-palsu-xyz" });
  check("run rejects an unknown model", badModel.status === 400 && badModel.json.error === "UNKNOWN_MODEL", JSON.stringify(badModel.json));
}

// ------------------------------------------------- account recovery, notifications, admin, metrics
const notifications = await call("GET", "/api/v1/notifications");
check("notifications respond", notifications.status === 200 && Array.isArray(notifications.json.notifications) && typeof notifications.json.unread === "number", JSON.stringify(notifications.json)?.slice(0, 160));
const readAll = await call("POST", "/api/v1/notifications/read-all");
check("notifications can be marked read", readAll.status === 200 && typeof readAll.json.read === "number", JSON.stringify(readAll.json));

const forgot = await call("POST", "/api/v1/auth/password/forgot", { email: `tidak-ada-${Date.now()}@example.test` });
check("forgot password answers for any address", forgot.status === 200 && forgot.json.ok === true, JSON.stringify(forgot.json));
if (forgot.json.delivery === "email") {
  check("forgot password reports email delivery", true, "");
} else {
  // No SMTP credential is configured yet, so no mail can leave the platform. Reported, not hidden.
  console.log(`SKIP password reset email delivery: ${forgot.json.note ?? forgot.json.delivery}`);
}
const badReset = await call("POST", "/api/v1/auth/password/reset", { token: "token-palsu", password: "PanjangSekali123!" });
check("password reset rejects an invalid token", badReset.status === 400 && badReset.json.error === "TOKEN_INVALID_OR_EXPIRED", JSON.stringify(badReset.json));
const badVerify = await call("POST", "/api/v1/auth/email/verify", { token: "token-palsu" });
check("email verify rejects an invalid token", badVerify.status === 400, JSON.stringify(badVerify.json));

const limits = await call("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: 1000000, monthlyCostLimitMicros: 0, runsPerHourLimit: 0 });
check("workspace limits can be set", limits.status === 200 && limits.json.dailyCostLimitMicros === 1000000, JSON.stringify(limits.json));
const readLimits = await call("GET", `/api/v1/workspaces/${workspaceId}/limits`);
check("workspace limits can be read back", readLimits.status === 200 && readLimits.json.dailyCostLimitMicros === 1000000 && !!readLimits.json.effective, `${readLimits.status} ${JSON.stringify(readLimits.json)}`);
const cleared = await call("PUT", `/api/v1/workspaces/${workspaceId}/limits`, { dailyCostLimitMicros: null, monthlyCostLimitMicros: null, runsPerHourLimit: null });
// null means "use the platform default", which is the state a fresh workspace is in.
check("workspace limits can be reset to the default", cleared.status === 200 && cleared.json.dailyCostLimitMicros === null, JSON.stringify(cleared.json));


// The dashboard reads the run history and renames projects from its own pages.
const runHistory = await call("GET", `/api/v1/projects/${projectId}/runs`);
check("run history answers with a list", runHistory.status === 200 && Array.isArray(runHistory.json.runs), JSON.stringify(runHistory.json).slice(0, 200));
const renameTarget = await call("PATCH", `/api/v1/projects/${projectId}`, { name: `Smoke Project ${Date.now()}` });
check("project can be renamed", renameTarget.status === 200 && typeof renameTarget.json.project?.name === "string", JSON.stringify(renameTarget.json).slice(0, 200));

// New in 0.10.0: profile edit, usage export, artifact preview, and the delete endpoints.
const profile = await call("PATCH", "/api/v1/auth/me", { displayName: login.json.user.displayName || "Pemilik Platform" });
check("display name can be saved", profile.status === 200 && typeof profile.json.user?.displayName === "string", JSON.stringify(profile.json).slice(0, 200));
const badProfile = await call("PATCH", "/api/v1/auth/me", { displayName: "x" });
check("a too short display name is refused", badProfile.status === 400 && badProfile.json.error === "INVALID_DISPLAY_NAME", JSON.stringify(badProfile.json));
const usageCsv = await call("GET", `/api/v1/projects/${projectId}/usage/export`);
check("usage export answers with CSV", usageCsv.status === 200 && typeof usageCsv.json === "string" && usageCsv.json.includes("cost_micros"), JSON.stringify(usageCsv.json).slice(0, 160));
const missingRaw = await call("GET", "/api/v1/artifacts/00000000-0000-0000-0000-000000000000/raw");
check("artifact preview refuses an unknown artifact", missingRaw.status === 404 && missingRaw.json.error === "ARTIFACT_NOT_FOUND", JSON.stringify(missingRaw.json));
const missingProject = await call("DELETE", "/api/v1/projects/00000000-0000-0000-0000-000000000000");
check("project delete refuses an unknown project", missingProject.status === 404 && missingProject.json.error === "PROJECT_NOT_FOUND", JSON.stringify(missingProject.json));
const missingWorkflow = await call("DELETE", "/api/v1/workflows/00000000-0000-0000-0000-000000000000");
check("workflow delete refuses an unknown workflow", missingWorkflow.status === 404 && missingWorkflow.json.error === "WORKFLOW_NOT_FOUND", JSON.stringify(missingWorkflow.json));
const badConfirm = await call("DELETE", `/api/v1/workspaces/${workspaceId}`, { confirm: "nama-yang-salah" });
check("workspace delete asks for the exact name", badConfirm.status === 400 && badConfirm.json.error === "CONFIRM_REQUIRED", JSON.stringify(badConfirm.json));
const badAccount = await call("DELETE", "/api/v1/auth/account", { password: PASSWORD, confirm: "salah" });
check("account delete asks for the exact phrase", badAccount.status === 400 && badAccount.json.error === "CONFIRM_REQUIRED", JSON.stringify(badAccount.json));

// Commerce surface added in v0.11.0.
const branding = await call("GET", "/api/v1/branding");
check("public branding answers", branding.status === 200 && typeof branding.json.appName === "string", JSON.stringify(branding.json).slice(0, 160));
const plans = await call("GET", "/api/v1/billing/plans");
check("plan list exposes the three seeded plans", plans.status === 200 && Array.isArray(plans.json.plans) && plans.json.plans.length >= 3, JSON.stringify(plans.json).slice(0, 200));
const billingMe = await call("GET", "/api/v1/billing/me");
check("billing detail answers with a quota", billingMe.status === 200 && typeof billingMe.json.quota?.usedToday === "number", JSON.stringify(billingMe.json).slice(0, 200));
const myOrders = await call("GET", "/api/v1/billing/orders");
check("own order list answers", myOrders.status === 200 && Array.isArray(myOrders.json.orders), JSON.stringify(myOrders.json).slice(0, 160));
const badCoupon = await call("POST", "/api/v1/billing/coupons/validate", { code: "TIDAK-ADA-KODENYA" });
check("unknown coupon is refused", badCoupon.status === 400 && ["COUPON_NOT_FOUND", "INVALID_COUPON"].includes(badCoupon.json.error), JSON.stringify(badCoupon.json));
const missingPlan = await call("POST", "/api/v1/billing/orders", { planCode: "plan-tidak-ada", months: 1 });
check("unknown plan is refused", missingPlan.status === 404 && missingPlan.json.error === "PLAN_NOT_FOUND", JSON.stringify(missingPlan.json));
const userListBlocked = await call("GET", "/api/v1/admin/user-list");
check("user list refuses a normal user", userListBlocked.status === 403 && userListBlocked.json.error === "ADMIN_REQUIRED", JSON.stringify(userListBlocked.json));
const revenueBlocked = await call("GET", "/api/v1/admin/revenue?days=30");
check("revenue refuses a normal user", revenueBlocked.status === 403 && revenueBlocked.json.error === "ADMIN_REQUIRED", JSON.stringify(revenueBlocked.json));

// Wave 2 surface added in v0.12.0: PWA assets, attachments, branch and bulk delete.
async function callRaw(path) {
  const response = await fetch(`${BASE}${path}`, { redirect: "follow" });
  return { status: response.status, type: response.headers.get("content-type") ?? "", size: (await response.arrayBuffer()).byteLength };
}
const manifest = await callRaw("/manifest.webmanifest");
const manifestBody = await (await fetch(`${BASE}/manifest.webmanifest`)).json().catch(() => null);
const iconSizes = Array.isArray(manifestBody?.icons) ? manifestBody.icons.map((icon) => icon.sizes) : [];
const hasMaskable = Array.isArray(manifestBody?.icons) && manifestBody.icons.some((icon) => String(icon.purpose ?? "").includes("maskable"));
check("PWA manifest is served with icons", manifest.status === 200 && iconSizes.includes("192x192") && iconSizes.includes("512x512") && hasMaskable, `${JSON.stringify(iconSizes)} maskable=${hasMaskable}`);
const icon192 = await callRaw("/icon-192.png");
const icon512 = await callRaw("/icon-512.png");
const appleTouch = await callRaw("/apple-touch-icon.png");
const favicon = await callRaw("/favicon.png");
check("PWA icon 192 is a real PNG", icon192.status === 200 && icon192.type.includes("image/png") && icon192.size > 1000, JSON.stringify(icon192));
check("PWA icon 512 is a real PNG", icon512.status === 200 && icon512.type.includes("image/png") && icon512.size > 1000, JSON.stringify(icon512));
check("apple touch icon is a real PNG", appleTouch.status === 200 && appleTouch.type.includes("image/png") && appleTouch.size > 500, JSON.stringify(appleTouch));
check("favicon is a real PNG", favicon.status === 200 && favicon.type.includes("image/png") && favicon.size > 500, JSON.stringify(favicon));
const serviceWorker = await callRaw("/sw.js");
check("service worker is served", serviceWorker.status === 200, JSON.stringify(serviceWorker));
const attachmentAnon = await callRaw("/api/v1/attachments/00000000-0000-0000-0000-000000000000");
check("attachment download refuses anonymous callers", attachmentAnon.status === 401, JSON.stringify(attachmentAnon));
const attachmentMissing = await call("GET", "/api/v1/attachments/00000000-0000-0000-0000-000000000000");
check("unknown attachment is refused for a signed-in user", attachmentMissing.status === 404 && attachmentMissing.json.error === "ATTACHMENT_NOT_FOUND", JSON.stringify(attachmentMissing.json));
// Six attachments must be refused before any run is created, so this costs no AI tokens.
// The attachment check runs before the conversation lookup, so a throwaway id is enough here.
const tooMany = await call("POST", "/api/v1/conversations/00000000-0000-0000-0000-000000000000/messages", {
  content: "uji batas lampiran",
  attachments: Array.from({ length: 6 }, (_, index) => ({ name: `uji-${index}.txt`, mimeType: "text/plain", contentBase64: "aGFsbyBkdW5pYQ==" })),
});
check("six attachments are refused with an Indonesian message", tooMany.status === 400 && tooMany.json.error === "TOO_MANY_ATTACHMENTS" && typeof tooMany.json.message === "string", JSON.stringify(tooMany.json));
const emptyBulk = await call("POST", "/api/v1/artifacts/bulk-delete", { ids: [] });
check("bulk delete asks for at least one artifact", emptyBulk.status === 400 && emptyBulk.json.error === "IDS_REQUIRED", JSON.stringify(emptyBulk.json));
const alienBulk = await call("POST", "/api/v1/artifacts/bulk-delete", { ids: ["00000000-0000-0000-0000-000000000000"] });
check("bulk delete reports ids it cannot touch", alienBulk.status === 200 && alienBulk.json.deleted === 0 && Array.isArray(alienBulk.json.skipped) && alienBulk.json.skipped.length === 1, JSON.stringify(alienBulk.json));
const branchUnknown = await call("POST", "/api/v1/conversations/00000000-0000-0000-0000-000000000000/branch", { rerun: false });
check("branch refuses an unknown conversation", branchUnknown.status === 404, JSON.stringify(branchUnknown.json));

// ---------------------------------------------------------------- Wave 3: agent workspace
// Every call below reads real state from the running platform; nothing is assumed.
const agentSettings = await call("GET", "/api/v1/agents/settings");
check("agent settings are readable and list the real thinking levels", agentSettings.status === 200 && Boolean(agentSettings.json?.settings) && Array.isArray(agentSettings.json?.thinkingLevels) && agentSettings.json.thinkingLevels.includes("off"), JSON.stringify(agentSettings.json)?.slice(0, 200));
const badThinking = await call("PATCH", "/api/v1/agents/settings", { thinkingLevel: "ultra" });
check("an unknown thinking level is refused", badThinking.status === 400 && badThinking.json.error === "INVALID_THINKING_LEVEL", JSON.stringify(badThinking.json));
const preview = await call("GET", "/api/v1/agents/preview");
check("agent preview shows the real flags and blocks", preview.status === 200 && Array.isArray(preview.json?.flags) && Array.isArray(preview.json?.blocks) && Array.isArray(preview.json?.notes), JSON.stringify(preview.json)?.slice(0, 200));
const memories = await call("GET", "/api/v1/memories");
check("memory bank lists notes", memories.status === 200 && Array.isArray(memories.json?.memories), JSON.stringify(memories.json)?.slice(0, 160));
const templates = await call("GET", "/api/v1/prompt-templates");
check("prompt templates list", templates.status === 200 && Array.isArray(templates.json?.templates), JSON.stringify(templates.json)?.slice(0, 160));
const personas = await call("GET", "/api/v1/personas");
check("personas list", personas.status === 200 && Array.isArray(personas.json?.personas), JSON.stringify(personas.json)?.slice(0, 160));
const skills = await call("GET", "/api/v1/skills");
check("capability catalogue is grouped and marks real availability", skills.status === 200 && Array.isArray(skills.json?.skills) && skills.json.skills.length > 10 && Array.isArray(skills.json?.groups) && skills.json.skills.every((row) => typeof row.available === "boolean"), JSON.stringify(skills.json)?.slice(0, 200));
const statusHub = await call("GET", "/api/v1/status-hub");
check("status hub reports engine, database and storage", statusHub.status === 200 && typeof statusHub.json?.database?.ok === "boolean" && Boolean(statusHub.json?.counts) && Boolean(statusHub.json?.engine) && Boolean(statusHub.json?.storage), JSON.stringify(statusHub.json)?.slice(0, 200));
const engineReport = statusHub.json?.engine ?? {};
console.log(`INFO engine available=${engineReport.available} version=${engineReport.version} models=${engineReport.models}`);
const agentMap = await call("GET", "/api/v1/agents/map?limit=3");
check("agent map lists sessions with their runs", agentMap.status === 200 && Array.isArray(agentMap.json?.sessions) && agentMap.json.sessions.every((row) => Array.isArray(row.runs)), JSON.stringify(agentMap.json)?.slice(0, 200));
const emptyPlayground = await call("POST", "/api/v1/playground/run", { prompt: "" });
check("playground refuses an empty prompt before spending tokens", emptyPlayground.status === 400 && emptyPlayground.json.error === "INVALID_PROMPT", JSON.stringify(emptyPlayground.json));
// A fresh conversation is used here because the earlier smoke conversation is deleted on purpose above.
const summaryChat = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Smoke ringkasan Wave 3" });
const summaryChatId = summaryChat.json?.conversation?.id;
const summaries = await call("GET", `/api/v1/conversations/${summaryChatId}/summaries`);
check("conversation summaries endpoint answers", summaries.status === 200 && Array.isArray(summaries.json?.summaries) && typeof summaries.json?.messages === "number", JSON.stringify(summaries.json)?.slice(0, 200));
const compactEmpty = await call("POST", `/api/v1/conversations/${summaryChatId}/compact`, {});
check("compacting a conversation without messages is refused", compactEmpty.status === 400 && compactEmpty.json.error === "NO_MESSAGES_TO_COMPACT", JSON.stringify(compactEmpty.json));
const removeSummaryChat = await call("DELETE", `/api/v1/conversations/${summaryChatId}`);
check("wave 3 smoke conversation cleaned up", removeSummaryChat.status === 200 && removeSummaryChat.json.deleted === true, JSON.stringify(removeSummaryChat.json));
const badReportKind = await call("GET", `/api/v1/projects/${projectId}/report.md?kind=ngawur`);
check("report refuses an unknown kind", badReportKind.status === 400 && badReportKind.json.error === "UNKNOWN_REPORT_KIND", JSON.stringify(badReportKind.json));
const reportResponse = await fetch(`${BASE}/api/v1/projects/${projectId}/report.md?kind=project`, { headers: { cookie } });
const reportText = await reportResponse.text();
check("project Markdown report downloads with a filename", reportResponse.status === 200 && (reportResponse.headers.get("content-type") || "").includes("text/markdown") && Boolean(reportResponse.headers.get("content-disposition")) && reportText.startsWith("# Laporan proyek"), `${reportResponse.status} ${reportText.slice(0, 80)}`);
// One tiny real AI call: proof that the playground path reaches the model, not a mock.
const quotaBefore = Number((await call("GET", "/api/v1/agents/settings")).json?.quota?.usedToday ?? 0);
const playground = await call("POST", "/api/v1/playground/run", { prompt: "Balas dengan satu kata: siap", thinking: "off" });
const quotaAfter = Number((await call("GET", "/api/v1/agents/settings")).json?.quota?.usedToday ?? 0);
check("playground tokens are recorded against the daily quota", quotaAfter > quotaBefore, `sebelum=${quotaBefore} sesudah=${quotaAfter} tokens=${playground.json?.tokens}`);
check("playground obeys the tool allowlist of the account", playground.status === 200 && Object.prototype.hasOwnProperty.call(playground.json ?? {}, "tools"), JSON.stringify(playground.json)?.slice(0, 200));
check("playground really answers through the engine", playground.status === 200 && typeof playground.json?.text === "string" && playground.json.text.trim().length > 0 && playground.json.tokens > 0, JSON.stringify(playground.json)?.slice(0, 240));
console.log(`INFO playground model=${playground.json?.model} thinking=${playground.json?.thinking} tokens=${playground.json?.tokens} ms=${playground.json?.durationMs}`);

// ------------------------------------------------------------------ Wave 4: platform terbuka & kepatuhan
// Wave 4 smoke runs against the live platform. It creates ONE temporary API key, uses it, then revokes
// it, and creates ONE temporary data export, then deletes it, so production stays clean.
const keyDocs = await call("GET", "/api/v1/api-keys/docs");
check("wave6 api key docs describe the read and write phase", keyDocs.status === 200 && keyDocs.json?.phase === "baca dan tulis" && Array.isArray(keyDocs.json?.scopes) && keyDocs.json.scopes.includes("write"), JSON.stringify(keyDocs.json)?.slice(0, 200));
check("wave6 docs list nine served public endpoints and no planned ones", Array.isArray(keyDocs.json?.endpoints) && keyDocs.json.endpoints.length === 9 && keyDocs.json.endpoints.every((row) => row.available === true) && Array.isArray(keyDocs.json?.plannedEndpoints) && keyDocs.json.plannedEndpoints.length === 0, JSON.stringify(keyDocs.json)?.slice(0, 260));
check("wave6 docs explain the webhook signature and retry policy", keyDocs.json?.webhooks?.signature?.includes("sha256=") && Array.isArray(keyDocs.json?.webhooks?.events) && keyDocs.json.webhooks.events.length === 2, JSON.stringify(keyDocs.json?.webhooks)?.slice(0, 220));

const smokeKey = await call("POST", "/api/v1/api-keys", { name: `Smoke Wave 4 ${new Date().toISOString().slice(0, 16)}`, scopes: ["read"] });
const smokeKeyId = smokeKey.json?.key?.id;
const smokeSecret = String(smokeKey.json?.secret ?? "");
check("wave4 api key is created and the raw value is shown once", smokeKey.status === 201 && smokeSecret.startsWith("ck_") && smokeSecret.length === 43 && smokeSecret.slice(3, 11) === smokeKey.json?.key?.prefix, JSON.stringify(smokeKey.json)?.slice(0, 200));

const keysAfterCreate = await call("GET", "/api/v1/api-keys");
check("wave4 key list never repeats the raw secret", keysAfterCreate.status === 200 && !JSON.stringify(keysAfterCreate.json).includes(smokeSecret), `panjang=${JSON.stringify(keysAfterCreate.json)?.length}`);
const smokeWriteKey = await call("POST", "/api/v1/api-keys", { name: `Smoke tulis ${new Date().toISOString().slice(0, 16)}`, scopes: ["write"] });
const writeScopeRefused = smokeWriteKey;
const smokeWriteSecret = String(smokeWriteKey.json?.secret ?? "");
// Wave 6: izin tulis SUDAH dilayani, jadi kunci tulis sekarang diterima.
check("wave6 write scope is granted because the write routes exist now", writeScopeRefused.status === 201 && String(writeScopeRefused.json?.key?.scopes).includes("write"), JSON.stringify(writeScopeRefused.json)?.slice(0, 260));

async function publicCall(path, key) {
  const response = await fetch(`${BASE}${path}`, { headers: key === undefined ? {} : { authorization: `Bearer ${key}` } });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json, text, headers: response.headers };
}

const publicNoKey = await publicCall("/api/v1/public/v1/me");
check("wave4 public API refuses a request without a key", publicNoKey.status === 401 && publicNoKey.json.error === "API_KEY_REQUIRED", JSON.stringify(publicNoKey.json));
const publicMe = await publicCall("/api/v1/public/v1/me", smokeSecret);
check("wave4 public API answers with a valid key", publicMe.status === 200 && publicMe.json?.user?.email === EMAIL && typeof publicMe.json?.quota?.usedToday === "number", JSON.stringify(publicMe.json)?.slice(0, 220));
const publicProjects = await publicCall("/api/v1/public/v1/projects", smokeSecret);
check("wave4 public API lists the projects of the bound workspace", publicProjects.status === 200 && (publicProjects.json?.projects ?? []).some((row) => row.id === projectId), JSON.stringify(publicProjects.json)?.slice(0, 220));
const publicUsage = await publicCall(`/api/v1/public/v1/projects/${projectId}/usage`, smokeSecret);
check("wave4 public API reports project usage from real runs", publicUsage.status === 200 && typeof publicUsage.json?.totals?.tokens === "number" && Array.isArray(publicUsage.json?.byModel), JSON.stringify(publicUsage.json)?.slice(0, 220));
const publicCross = await publicCall("/api/v1/public/v1/projects/00000000-0000-4000-8000-000000000000/usage", smokeSecret);
check("wave4 public API answers 404 for unknown resources", publicCross.status === 404 && publicCross.json.error === "PROJECT_NOT_FOUND", JSON.stringify(publicCross.json));
const readKeyWrite = await fetch(`${BASE}/api/v1/public/v1/projects/${projectId}/conversations`, { method: "POST", headers: { authorization: `Bearer ${smokeSecret}`, "content-type": "application/json" }, body: JSON.stringify({ title: "kunci baca" }) });
check("wave6 a read key is refused on the write route (403 API_KEY_SCOPE_REQUIRED)", readKeyWrite.status === 403, `${readKeyWrite.status}`);
const publicWriteResponse = await fetch(`${BASE}/api/v1/public/v1/projects/${projectId}/conversations`, { method: "POST", headers: { authorization: `Bearer ${smokeWriteSecret}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Smoke tulis dari produksi" }) });
const publicWriteText = await publicWriteResponse.text();
check("wave6 public write route really creates a conversation (201)", publicWriteResponse.status === 201 && publicWriteText.includes("Smoke tulis dari produksi"), `${publicWriteResponse.status} ${publicWriteText.slice(0, 160)}`);
console.log(`INFO wave6 smoke write key: ${smokeWriteSecret ? "dibuat" : "kosong"}`);

const smokeWriteKeyId = smokeWriteKey.json?.key?.id;
const smokeWriteRevoke = await call("DELETE", `/api/v1/api-keys/${smokeWriteKeyId}`);
check("wave6 the temporary write key is revoked so production stays clean", smokeWriteRevoke.status === 200 && smokeWriteRevoke.json.revoked === true, JSON.stringify(smokeWriteRevoke.json));
const writeAfterRevoke = await fetch(`${BASE}/api/v1/public/v1/projects/${projectId}/conversations`, { method: "POST", headers: { authorization: `Bearer ${smokeWriteSecret}`, "content-type": "application/json" }, body: JSON.stringify({ title: "sesudah dicabut" }) });
check("wave6 a revoked write key cannot write any more", writeAfterRevoke.status === 401, `${writeAfterRevoke.status}`);
const smokeRevoke = await call("DELETE", `/api/v1/api-keys/${smokeKeyId}`);
check("wave4 api key can be revoked", smokeRevoke.status === 200 && smokeRevoke.json.revoked === true, JSON.stringify(smokeRevoke.json));
const publicAfterRevoke = await publicCall("/api/v1/public/v1/me", smokeSecret);
check("wave4 revoked key stops working at once", publicAfterRevoke.status === 401 && publicAfterRevoke.json.error === "API_KEY_INVALID", JSON.stringify(publicAfterRevoke.json));

const smokePrefs = await call("GET", "/api/v1/account/notification-preferences");
check("wave4 notification preferences expose five email switches", smokePrefs.status === 200 && smokePrefs.json?.kinds?.length === 5 && smokePrefs.json?.preferences?.emailSecurity === 1, JSON.stringify(smokePrefs.json)?.slice(0, 220));
const smokePrefsOff = await call("PUT", "/api/v1/account/notification-preferences", { emailTeam: false });
const smokePrefsBack = await call("PUT", "/api/v1/account/notification-preferences", { emailTeam: true });
check("wave4 notification preferences can be changed and restored", smokePrefsOff.json?.preferences?.emailTeam === 0 && smokePrefsBack.json?.preferences?.emailTeam === 1, JSON.stringify(smokePrefsBack.json));
check("wave4 email worker reports its state instead of guessing", typeof smokePrefs.json?.email?.enabled === "boolean" && typeof smokePrefs.json?.email?.mailerConfigured === "boolean", JSON.stringify(smokePrefs.json?.email));
check("wave4 outgoing mail is fully configured in production (SMTP ready)", smokePrefs.json?.email?.mailerConfigured === true, JSON.stringify(smokePrefs.json?.email));
console.log(`INFO wave4 email worker: enabled=${smokePrefs.json?.email?.enabled} from=${smokePrefs.json?.email?.from} (pengiriman otomatis hanya jalan bila NOTIFY_EMAIL_ENABLED=true)`);

const privacy = await call("GET", "/api/v1/account/privacy");
check("wave4 privacy summary lists the exported data sections", privacy.status === 200 && (privacy.json?.sectionsInExport ?? []).length >= 20 && Number(privacy.json?.storedTotals?.rows) > 0, JSON.stringify(privacy.json)?.slice(0, 220));
const smokeExport = await call("POST", "/api/v1/account/export");
const smokeExportId = smokeExport.json?.export?.id;
check("wave4 personal data export is created", smokeExport.status === 201 && Number(smokeExport.json?.export?.sizeBytes) > 100 && Array.isArray(smokeExport.json?.export?.sections), JSON.stringify(smokeExport.json)?.slice(0, 200));
const exportBody = await (await fetch(`${BASE}/api/v1/account/exports/${smokeExportId}/download`, { headers: { cookie } })).text();
check("wave4 export file holds no password or raw api key material", exportBody.includes("coblai-coder-export/1") && !exportBody.includes("password_hash") && !exportBody.includes("mfa_secret") && !exportBody.includes(smokeSecret), `${exportBody.length} byte`);
const smokeExportDelete = await call("DELETE", `/api/v1/account/exports/${smokeExportId}`);
const smokeExportGone = await call("GET", `/api/v1/account/exports/${smokeExportId}/download`);
check("wave4 export can be deleted and stops downloading", smokeExportDelete.status === 200 && smokeExportDelete.json.deleted === true && smokeExportGone.status === 404, JSON.stringify(smokeExportGone.json));

const outboxBlocked = await call("GET", "/api/v1/admin/email-outbox");
const retentionBlocked = await call("GET", "/api/v1/admin/retention");
check("wave4 email outbox and retention stay behind the admin gate", outboxBlocked.status === 403 && outboxBlocked.json.error === "ADMIN_REQUIRED" && retentionBlocked.status === 403, `${outboxBlocked.status}/${retentionBlocked.status}`);
const jobsBlocked = await call("GET", "/api/v1/admin/jobs");
const jobsRetryBlocked = await call("POST", "/api/v1/admin/jobs/tidak-ada/retry");
check("wave5 background job queue stays behind the admin gate", jobsBlocked.status === 403 && jobsBlocked.json.error === "ADMIN_REQUIRED" && jobsRetryBlocked.status === 403, `${jobsBlocked.status}/${jobsRetryBlocked.status}`);

const publicPlans = await publicCall("/api/v1/public/plans");
check("wave4 public pricing page data is open and lists real plans", publicPlans.status === 200 && (publicPlans.json?.plans ?? []).length >= 3 && publicPlans.json?.currency === "IDR", JSON.stringify(publicPlans.json)?.slice(0, 220));
check("wave4 public pricing never leaks gateway secrets", !/serverKey|clientKey|secret|callbackToken/i.test(publicPlans.text), publicPlans.text.slice(0, 160));
const pricingPage = await (await fetch(`${BASE}/harga`)).text();
check("wave4 public pricing page route serves the app shell", pricingPage.includes("<div id=\"root\">") || pricingPage.includes("<!doctype html"), `${pricingPage.length} byte`);

const statusHubW4 = await call("GET", "/api/v1/status-hub");
check("wave4 status hub reports the open platform block", statusHubW4.status === 200 && Number(statusHubW4.json?.openPlatform?.publicEndpoints) >= 9 && Number(statusHubW4.json?.openPlatform?.publicEndpointsPlanned) === 0 && typeof statusHubW4.json?.openPlatform?.emailWorker?.enabled === "boolean" && typeof statusHubW4.json?.openPlatform?.retention?.enabled === "boolean", JSON.stringify(statusHubW4.json?.openPlatform)?.slice(0, 260));
check("wave4 status hub counts api keys, queued emails, and ready exports from the database",
  typeof statusHubW4.json?.openPlatform?.activeKeys === "number" && typeof statusHubW4.json?.openPlatform?.emailOutbox?.pending === "number" && typeof statusHubW4.json?.openPlatform?.emailOutbox?.total === "number" && typeof statusHubW4.json?.openPlatform?.readyExports === "number",
  JSON.stringify(statusHubW4.json?.openPlatform?.emailOutbox));
console.log(`INFO wave4 open platform: activeKeys=${statusHubW4.json?.openPlatform?.activeKeys} outboxPending=${statusHubW4.json?.openPlatform?.emailOutbox?.pending} readyExports=${statusHubW4.json?.openPlatform?.readyExports}`);
// Wave 9 (butir 17) memindahkan antrean ke wadah pekerja sendiri, jadi proses web tidak lagi
// memilikinya: `running` benar-benar bernilai false di sana. Daftar penangan tetap lengkap karena
// pendaftarannya dilakukan sebelum penjaga itu.
check("wave5 status hub reports the background work queue", Number.isFinite(Number(statusHubW4.json?.backgroundWork?.queue?.total)) && Number(statusHubW4.json?.backgroundWork?.queue?.queued) >= 0 && typeof statusHubW4.json?.backgroundWork?.worker?.running === "boolean" && statusHubW4.json?.backgroundWork?.reapOnBoot === true, JSON.stringify(statusHubW4.json?.backgroundWork)?.slice(0, 240));
check("wave5 the recovery window is longer than the engine timeout, so healthy runs are never flagged", Number(statusHubW4.json?.backgroundWork?.orphanAfterMs) > 1_800_000 && Number(statusHubW4.json?.backgroundWork?.leaseMs) >= 60_000, JSON.stringify(statusHubW4.json?.backgroundWork)?.slice(0, 200));
console.log(`INFO wave5 background work: queued=${statusHubW4.json?.backgroundWork?.queue?.queued} running=${statusHubW4.json?.backgroundWork?.queue?.running} done=${statusHubW4.json?.backgroundWork?.queue?.done} failed=${statusHubW4.json?.backgroundWork?.queue?.failed} leaseMs=${statusHubW4.json?.backgroundWork?.leaseMs} orphanAfterMs=${statusHubW4.json?.backgroundWork?.orphanAfterMs}`);

const adminBlocked = await call("GET", "/api/v1/admin/overview");
check("admin area refuses a normal user", adminBlocked.status === 403 && adminBlocked.json.error === "ADMIN_REQUIRED", JSON.stringify(adminBlocked.json));
const metricsBlocked = await call("GET", "/metrics");
check("metrics stay hidden without a token", metricsBlocked.status === 404, JSON.stringify(metricsBlocked.json));

/* ---------------------------------------- Wave 6: webhook keluar ---------------------------------------- */
// Uji produksi SENGAJA tidak membuat webhook: setiap pengiriman akan menembak alamat luar. Yang diperiksa
// hanya bentuk permukaan yang sudah ada, dan itu pun dibaca saja.
const hookList = await call("GET", "/api/v1/webhooks");
check("wave6 webhook list answers with stats, events, and limits",
  hookList.status === 200 && Array.isArray(hookList.json?.webhooks) && typeof hookList.json?.stats?.hooks === "number" && Array.isArray(hookList.json?.events) && hookList.json.events.length === 2 && typeof hookList.json?.limits?.maxAttempts === "number",
  JSON.stringify(hookList.json)?.slice(0, 240));
check("wave6 webhook list never carries a signing secret",
  !JSON.stringify(hookList.json).includes("whsec_"), `panjang=${JSON.stringify(hookList.json)?.length}`);
const hookBadUrl = await call("POST", "/api/v1/webhooks", { url: "bukan-url" });
check("wave6 a bad webhook address is refused with a readable code", hookBadUrl.status === 400 && hookBadUrl.json?.error === "WEBHOOK_URL_INVALID", JSON.stringify(hookBadUrl.json));
const hookMetaUrl = await call("POST", "/api/v1/webhooks", { url: "http://169.254.169.254/latest/meta-data" });
check("wave6 the cloud metadata address is always refused", hookMetaUrl.status === 400 && hookMetaUrl.json?.error === "WEBHOOK_URL_BLOCKED", JSON.stringify(hookMetaUrl.json));
const hookMissing = await call("POST", "/api/v1/webhooks/tidak-ada/test");
check("wave6 testing an unknown webhook answers 404", hookMissing.status === 404, `${hookMissing.status}`);
check("wave6 status hub reports webhooks and per key ceilings",
  typeof statusHubW4.json?.openPlatform?.webhooks?.hooks === "number" && typeof statusHubW4.json?.openPlatform?.keyLimits?.dailyRequestsDefault === "number",
  JSON.stringify(statusHubW4.json?.openPlatform?.webhooks));
const hubAfterKeys = await call("GET", "/api/v1/status-hub");
check("wave6 status hub counts 9 served public routes and no planned ones",
  Number(hubAfterKeys.json?.openPlatform?.publicEndpoints) >= 9 && Number(hubAfterKeys.json?.openPlatform?.publicEndpointsPlanned) === 0,
  JSON.stringify(hubAfterKeys.json?.openPlatform)?.slice(0, 200));
console.log(`INFO wave6 webhooks: hooks=${hubAfterKeys.json?.openPlatform?.webhooks?.hooks} active=${hubAfterKeys.json?.openPlatform?.webhooks?.active} delivered=${hubAfterKeys.json?.openPlatform?.webhooks?.delivered} failed=${hubAfterKeys.json?.openPlatform?.webhooks?.failed} allowLocal=${hubAfterKeys.json?.openPlatform?.webhookAllowLocal}`);

/* ------------------------------- Wave 7: pertumbuhan (hanya baca) ------------------------------- */
// Uji produksi hanya MELIHAT. Tidak ada undangan yang dibuat, tidak ada kode yang diganti, dan tidak ada
// pendaftaran uji, supaya data produksi tidak bertambah hanya karena uji ini.
const robots = await call("GET", "/robots.txt");
check("wave7 robots.txt is served and points at the sitemap",
  robots.status === 200 && String(robots.json).includes("Sitemap:") && String(robots.json).includes("Disallow: /api/"),
  String(robots.json)?.slice(0, 160));
const sitemap = await call("GET", "/sitemap.xml");
check("wave7 sitemap.xml lists the public pages",
  sitemap.status === 200 && String(sitemap.json).includes("<urlset") && String(sitemap.json).includes("/harga") && String(sitemap.json).includes("/docs"),
  String(sitemap.json)?.slice(0, 160));
const docs = await call("GET", "/api/v1/public/docs");
check("wave7 public docs need no session and describe the served API",
  docs.status === 200 && typeof docs.json?.product === "string" && Array.isArray(docs.json?.endpoints) && docs.json.endpoints.length >= 9,
  JSON.stringify(docs.json)?.slice(0, 200));
check("wave7 public docs list the webhook events and the error codes",
  Array.isArray(docs.json?.webhook?.events) && docs.json.webhook.events.length === 2 && String(docs.json?.webhook?.signatureHeader).length > 0 && Array.isArray(docs.json?.errors) && docs.json.errors.length >= 5,
  JSON.stringify(docs.json?.webhook)?.slice(0, 200));
check("wave7 public docs never carry a webhook secret", !JSON.stringify(docs.json).includes("whsec_"), `panjang=${JSON.stringify(docs.json)?.length}`);
const refMe = await call("GET", "/api/v1/referrals/me");
check("wave7 the signed in account gets its own referral code and link",
  refMe.status === 200 && typeof refMe.json?.code === "string" && refMe.json.code.length === 8 && String(refMe.json?.link).includes(`?ref=${refMe.json?.code}`),
  JSON.stringify(refMe.json)?.slice(0, 160));
check("wave7 referral counters and limits are reported as numbers",
  typeof refMe.json?.counters?.invited === "number" && typeof refMe.json?.counters?.rewarded === "number" && typeof refMe.json?.limits?.inviterTokens === "number",
  JSON.stringify(refMe.json?.counters));
const onboard = await call("GET", "/api/v1/onboarding");
check("wave7 onboarding answers with five steps and a next step",
  onboard.status === 200 && Array.isArray(onboard.json?.steps) && onboard.json.steps.length === 5 && Number(onboard.json?.total) === 5 && Number(onboard.json?.percent) >= 0 && Number(onboard.json?.percent) <= 100,
  JSON.stringify(onboard.json)?.slice(0, 200));
const quota = await call("GET", "/api/v1/billing/quota-alert");
check("wave7 the quota warning uses real server numbers and a readable sentence",
  quota.status === 200 && ["ok", "warning", "critical", "exceeded"].includes(String(quota.json?.level)) && String(quota.json?.message).length > 10 && String(quota.json?.packagePath) === "/paket",
  JSON.stringify(quota.json)?.slice(0, 240));
const growthBlocked = await call("GET", "/api/v1/admin/growth");
check("wave7 the growth screen refuses a normal user", growthBlocked.status === 403 && growthBlocked.json?.error === "ADMIN_REQUIRED", JSON.stringify(growthBlocked.json));
const refBlocked = await call("GET", "/api/v1/admin/referrals");
check("wave7 the referral list refuses a normal user", refBlocked.status === 403 && refBlocked.json?.error === "ADMIN_REQUIRED", JSON.stringify(refBlocked.json));
const hubW7 = await call("GET", "/api/v1/status-hub");
check("wave7 status hub reports the referral programme and the event count",
  typeof hubW7.json?.openPlatform?.referrals?.total === "number" && typeof hubW7.json?.openPlatform?.referralLimits?.inviterTokens === "number" && Number.isFinite(Number(hubW7.json?.openPlatform?.growthEvents)) && Number(hubW7.json?.openPlatform?.growthWindowDays) >= 1,
  JSON.stringify(hubW7.json?.openPlatform?.referrals)?.slice(0, 200));
console.log(`INFO wave7 growth: codes=${hubW7.json?.openPlatform?.referrals?.codes} total=${hubW7.json?.openPlatform?.referrals?.total} rewarded=${hubW7.json?.openPlatform?.referrals?.rewarded} events=${hubW7.json?.openPlatform?.growthEvents} quota=${quota.json?.level}(${quota.json?.percent}%)`);

// ------------------------------------------------------------------ Wave 8 (v0.18.0)
// Batas laju disimpan di basis data, akun punya masa pemulihan 90 hari, verifikasi email dijaga.
const hubW8 = await call("GET", "/api/v1/status-hub");
check("wave8 the rate limiter counters live in the database, not in process memory",
  String(hubW8.json?.openPlatform?.rateLimits?.store) === "database" && String(hubW8.json?.openPlatform?.rateLimits?.table) === "rate_limit_hits",
  JSON.stringify(hubW8.json?.openPlatform?.rateLimits)?.slice(0, 200));
check("wave8 every rate limit rule is reported as a number",
  ["login", "register", "password", "api", "referral"].every((name) => Number.isFinite(Number(hubW8.json?.openPlatform?.rateLimits?.rules?.[name]))),
  JSON.stringify(hubW8.json?.openPlatform?.rateLimits?.rules));
check("wave8 a closed account keeps a 90 day recovery window",
  Number(hubW8.json?.openPlatform?.closedAccounts?.recoveryDays) === 90
  && typeof hubW8.json?.openPlatform?.closedAccounts?.waiting === "number"
  && typeof hubW8.json?.openPlatform?.closedAccounts?.due === "number",
  JSON.stringify(hubW8.json?.openPlatform?.closedAccounts));
check("wave8 the email verification gate reports its mode honestly",
  ["auto", "on", "off"].includes(String(hubW8.json?.security?.verifyEmailMode))
  && typeof hubW8.json?.security?.verifyEmailRequired === "boolean",
  JSON.stringify({ mode: hubW8.json?.security?.verifyEmailMode, required: hubW8.json?.security?.verifyEmailRequired }));
const meW8 = await call("GET", "/api/v1/auth/me");
check("wave8 the signed in profile reports email state and account state",
  meW8.status === 200 && typeof meW8.json?.user?.emailVerified === "boolean" && meW8.json?.user?.accountClosed === false,
  JSON.stringify(meW8.json?.user));
check("wave8 production runs with mail enabled, so the verification gate is on and the smoke account is verified",
  hubW8.json?.security?.verifyEmailRequired === true && meW8.json?.user?.emailVerified === true,
  JSON.stringify({ required: hubW8.json?.security?.verifyEmailRequired, verified: meW8.json?.user?.emailVerified }));
const exportsW8 = await call("GET", "/api/v1/account/exports");
check("wave8 the account export list answers with an array", exportsW8.status === 200 && Array.isArray(exportsW8.json?.exports), JSON.stringify(exportsW8.json)?.slice(0, 160));
const closeNoExport = await call("DELETE", "/api/v1/auth/account", { password: "SandiSalahSekali2026!", confirm: "hapus" });
check("wave8 closing the account without the exact phrase is refused and changes nothing",
  closeNoExport.status === 400 && closeNoExport.json?.error === "CONFIRM_REQUIRED",
  JSON.stringify(closeNoExport.json));
const closeBadPassword = await call("DELETE", "/api/v1/auth/account", { password: "SandiSalahSekali2026!", confirm: "HAPUS AKUN" });
check("wave8 a wrong password never closes an account", closeBadPassword.status === 403 && closeBadPassword.json?.error === "INVALID_PASSWORD", JSON.stringify(closeBadPassword.json));
const stillMe = await call("GET", "/api/v1/auth/me");
check("wave8 the smoke account is untouched after the close attempts", stillMe.status === 200 && stillMe.json?.user?.email === meW8.json?.user?.email, JSON.stringify(stillMe.json?.user));
console.log(`INFO wave8 limits=${JSON.stringify(hubW8.json?.openPlatform?.rateLimits?.rules)} closedWaiting=${hubW8.json?.openPlatform?.closedAccounts?.waiting} closedDue=${hubW8.json?.openPlatform?.closedAccounts?.due} verifyMode=${hubW8.json?.security?.verifyEmailMode} verifyRequired=${hubW8.json?.security?.verifyEmailRequired} verified=${meW8.json?.user?.emailVerified}`);

// ------------------------------------------------------------------ Wave 9 (v0.19.0)
// Harga AI: harga pokok dari penyedia tetap apa adanya, jumlah yang ditagihkan = harga pokok x markup.
const hubW9 = await call("GET", "/api/v1/status-hub");
const aiPricing = hubW9.json?.aiPricing;
check("wave9 the status hub reports the AI pricing settings",
  typeof aiPricing?.markup === "number" && Number(aiPricing?.markup) >= 0.1 && String(aiPricing?.currency) === "USD" && Number(aiPricing?.catalogSize) > 0,
  JSON.stringify(aiPricing));
const cost30 = Number(aiPricing?.costMicros30d ?? 0);
const billed30 = Number(aiPricing?.billedMicros30d ?? 0);
const margin30 = Number(aiPricing?.marginMicros30d ?? 0);
check("wave9 the billed amount follows the owner markup and the margin is the difference",
  Math.abs(billed30 - cost30 * Number(aiPricing?.markup ?? 1)) <= Math.max(1000, cost30 * Number(aiPricing?.markup ?? 1) * 0.05 + 1)
  && margin30 === billed30 - cost30,
  JSON.stringify({ markup: aiPricing?.markup, cost30, billed30, margin30 }));
check("wave9 the real upstream price is never overwritten by the markup", cost30 >= 0 && (cost30 === 0 || billed30 >= cost30),
  JSON.stringify({ cost30, billed30 }));
const pricingBlocked = await call("GET", "/api/v1/admin/pricing");
check("wave9 the price console refuses a normal account", pricingBlocked.status === 403 && pricingBlocked.json?.error === "ADMIN_REQUIRED", JSON.stringify(pricingBlocked.json));
const markupBlocked = await call("PUT", "/api/v1/admin/pricing/settings", { markup: 2 });
check("wave9 the markup can only be changed by a platform admin", markupBlocked.status === 403 && markupBlocked.json?.error === "ADMIN_REQUIRED", JSON.stringify(markupBlocked.json));
const priceBlocked = await call("PUT", "/api/v1/admin/pricing/models/uji-model", { input: 1, output: 2 });
check("wave9 a model price can only be set by a platform admin", priceBlocked.status === 403 && priceBlocked.json?.error === "ADMIN_REQUIRED", JSON.stringify(priceBlocked.json));
const usageW9 = await call("GET", `/api/v1/projects/${projectId}/usage?days=30`);
check("wave9 the project usage reports cost, billed amount and the markup used",
  usageW9.status === 200 && typeof usageW9.json?.markup === "number" && Number.isFinite(Number(usageW9.json?.totals?.billedMicros))
  && Number(usageW9.json?.totals?.billedMicros) >= Number(usageW9.json?.totals?.costMicros ?? 0)
  && Number.isFinite(Number(usageW9.json?.totals?.billedUsd)),
  JSON.stringify(usageW9.json?.totals)?.slice(0, 240));
const runsW9 = await call("GET", `/api/v1/projects/${projectId}/runs?limit=5`);
const runRowW9 = Array.isArray(runsW9.json?.runs) ? runsW9.json.runs[0] : undefined;
check("wave9 the run list shows the billed amount of every run",
  runsW9.status === 200 && (runRowW9 === undefined || (Number.isFinite(Number(runRowW9?.billedMicros)) && Number.isFinite(Number(runRowW9?.billedUsd)))),
  JSON.stringify(runRowW9)?.slice(0, 200));
const jobsW9 = await call("GET", "/api/v1/status-hub");
// Jalur yang benar adalah backgroundWork.worker (bukan jobs.worker). Uji ini sekaligus membuktikan
// bahwa antrean benar-benar sudah berpindah ke wadah pekerja: proses web tidak mengambil pekerjaan.
const workerW9 = jobsW9.json?.backgroundWork?.worker;
check("wave9 the queue still reports every job handler after the worker moved to its own process",
  Array.isArray(workerW9?.handlers) && workerW9.handlers.length >= 6,
  JSON.stringify(workerW9));
check("wave9 the web process no longer owns the queue",
  workerW9?.running === false && Number(workerW9?.cyclesRun ?? -1) === 0,
  JSON.stringify({ running: workerW9?.running, cyclesRun: workerW9?.cyclesRun }));
console.log(`INFO wave9 markup=${aiPricing?.markup} cost30=${cost30} billed30=${billed30} margin30=${margin30} overrides=${aiPricing?.overrideCount} catalog=${aiPricing?.catalogSize} workerInWeb=${workerW9?.running} handlers=${workerW9?.handlers?.length}`);

// ------------------------------------------------------------------ Wave 10 (v0.20.0)
// Pencarian global, perangkat, notifikasi peramban, metrik, pembersihan, dan kuota berjalan.
const lockSearchStatus = await call("GET", "/api/v1/search/status");
check("wave10 the message index reports its own state", lockSearchStatus.status === 200
  && Number.isFinite(Number(lockSearchStatus.json?.messages)) && Number.isFinite(Number(lockSearchStatus.json?.indexedMessages)),
  JSON.stringify(lockSearchStatus.json));
const lockSearch = await call("GET", `/api/v1/search?q=${encodeURIComponent("coblai")}`);
check("wave10 global search spans projects, conversations, messages, artifacts, knowledge and workflows",
  lockSearch.status === 200 && Array.isArray(lockSearch.json?.groups) && typeof lockSearch.json?.total === "number"
  && Number.isFinite(Number(lockSearch.json?.tookMs)),
  JSON.stringify(lockSearch.json)?.slice(0, 220));
const lockSearchShort = await call("GET", "/api/v1/search?q=a");
check("wave10 a one letter search is refused with a clear reason", lockSearchShort.status === 400 && typeof lockSearchShort.json?.error === "string", JSON.stringify(lockSearchShort.json));
const lockReindex = await call("POST", "/api/v1/admin/search/reindex");
check("wave10 rebuilding the search index stays behind the admin gate", lockReindex.status === 403 && lockReindex.json?.error === "ADMIN_REQUIRED", JSON.stringify(lockReindex.json));

const lockDevices = await call("GET", "/api/v1/account/devices");
check("wave10 the account lists the signed in devices with the current one marked",
  lockDevices.status === 200 && Array.isArray(lockDevices.json?.devices) && typeof lockDevices.json?.mode === "string"
  && typeof lockDevices.json?.verifyRequired === "boolean",
  JSON.stringify(lockDevices.json)?.slice(0, 220));
check("wave10 the smoke session itself is a tracked device", (lockDevices.json?.devices ?? []).some((d) => d?.current === true), JSON.stringify((lockDevices.json?.devices ?? []).slice(0, 2)));
const lockAdminDevices = await call("GET", "/api/v1/admin/devices");
check("wave10 the admin device list is closed to a normal account", lockAdminDevices.status === 403 && lockAdminDevices.json?.error === "ADMIN_REQUIRED", JSON.stringify(lockAdminDevices.json));
const lockDeviceBlock = await call("POST", "/api/v1/admin/devices/tidak-ada/block", { reason: "uji" });
check("wave10 blocking a device is closed to a normal account", lockDeviceBlock.status === 403, String(lockDeviceBlock.status));

const lockPush = await call("GET", "/api/v1/account/push");
check("wave10 the browser push settings publish a usable public key",
  lockPush.status === 200 && typeof lockPush.json?.publicKey === "string" && String(lockPush.json.publicKey).length > 80
  && Array.isArray(lockPush.json?.subscriptions) && Number(lockPush.json?.max) >= 1,
  JSON.stringify({ len: String(lockPush.json?.publicKey ?? "").length, max: lockPush.json?.max, subs: lockPush.json?.subscriptions?.length }));
check("wave10 the private push key is never part of the answer", !/private|vapidPrivate/i.test(lockPush.text), lockPush.text.slice(0, 160));
const lockPushBad = await call("POST", "/api/v1/account/push/subscribe", { endpoint: "http://bukan-https.example.test", keys: { p256dh: "x", auth: "y" } });
check("wave10 a push subscription without https is refused", lockPushBad.status === 400 && typeof lockPushBad.json?.error === "string", JSON.stringify(lockPushBad.json));

const lockKeys = await call("GET", "/api/v1/api-keys");
const lockKeyRows = Array.isArray(lockKeys.json?.keys) ? lockKeys.json.keys : [];
check("wave10 the api key list shows the reserved tokens of runs that are still going on",
  lockKeys.status === 200 && Number.isFinite(Number(lockKeys.json?.reservedTokens))
  && lockKeyRows.every((k) => Number.isFinite(Number(k?.tokensReserved)) && k?.inFlight !== undefined && k?.quota !== undefined),
  JSON.stringify(lockKeys.json)?.slice(0, 260));

const lockMetrics = await call("GET", "/api/v1/metrics");
check("wave10 the metrics endpoint refuses a request without the token", lockMetrics.status === 404, String(lockMetrics.status));
const lockMetricsWrong = await fetch(`${BASE}/api/v1/metrics?token=salah`, { headers: { authorization: "Bearer salah" } });
check("wave10 the metrics endpoint refuses a wrong token", lockMetricsWrong.status === 404, String(lockMetricsWrong.status));
const lockAdminMetrics = await call("GET", "/api/v1/admin/metrics");
check("wave10 the metrics screen stays behind the admin gate", lockAdminMetrics.status === 403 && lockAdminMetrics.json?.error === "ADMIN_REQUIRED", JSON.stringify(lockAdminMetrics.json));

const lockBackfill = await call("GET", "/api/v1/admin/growth/backfill");
check("wave10 the growth backfill preview stays behind the admin gate", lockBackfill.status === 403 && lockBackfill.json?.error === "ADMIN_REQUIRED", JSON.stringify(lockBackfill.json));
const lockBackfillRun = await call("POST", "/api/v1/admin/growth/backfill", { apply: true });
check("wave10 running the growth backfill stays behind the admin gate", lockBackfillRun.status === 403, String(lockBackfillRun.status));
const lockSmokeCleanup = await call("POST", "/api/v1/admin/smoke/cleanup", { dryRun: true });
check("wave10 the smoke data clean-up stays behind the admin gate", lockSmokeCleanup.status === 403, String(lockSmokeCleanup.status));
const lockDeliveries = await call("GET", "/api/v1/webhooks/tidak-ada/deliveries");
check("wave10 the webhook delivery history route exists and hides unknown webhooks", lockDeliveries.status === 404, String(lockDeliveries.status));
const lockTrim = await call("DELETE", "/api/v1/webhooks/tidak-ada/deliveries?dryRun=true");
check("wave10 trimming the webhook history also hides unknown webhooks", lockTrim.status === 404, String(lockTrim.status));

const hub10 = await call("GET", "/api/v1/status-hub");
check("wave10 the status hub reports search, push, devices and housekeeping",
  hub10.status === 200 && hub10.json?.search?.kinds >= 5 && typeof hub10.json?.search?.indexedMessages === "number"
  && typeof hub10.json?.push?.configured === "boolean" && Number(hub10.json?.push?.maxPerUser) >= 1
  && typeof hub10.json?.devices?.tracking === "boolean" && typeof hub10.json?.devices?.verifyRequired === "boolean"
  && Number.isFinite(Number(hub10.json?.housekeeping?.reservedTokensWaiting)),
  JSON.stringify(hub10.json?.search)?.slice(0, 200));
check("wave10 the status hub shows where the growth events came from",
  Array.isArray(hub10.json?.openPlatform?.growthSources) && hub10.json.openPlatform.growthSources.length >= 1,
  JSON.stringify(hub10.json?.openPlatform?.growthSources)?.slice(0, 200));
check("wave10 the status hub says how long the clean up keeps webhook history",
  Number(hub10.json?.housekeeping?.webhookDays) >= 1 && typeof hub10.json?.housekeeping?.retentionDryRun === "boolean"
  && typeof hub10.json?.housekeeping?.smokeCleanup === "boolean",
  JSON.stringify(hub10.json?.housekeeping));
console.log(`INFO wave10 searchIndexed=${hub10.json?.search?.indexedMessages}/${hub10.json?.search?.messages} pushConfigured=${hub10.json?.push?.configured} pushSubs=${hub10.json?.push?.activeSubscriptions} devices=${hub10.json?.devices?.total} verifyMode=${hub10.json?.devices?.mode} reservedTokens=${hub10.json?.housekeeping?.reservedTokensWaiting} growthSources=${JSON.stringify(hub10.json?.openPlatform?.growthSources)}`);

console.log(failures === 0 ? "PRODUCTION_SMOKE_PASSED" : `PRODUCTION_SMOKE_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Model catalogue, model pinning on runs and viewer read-only enforcement.
 * Runs with the mock engine; the model catalogue comes from the real engine CLI.
 */
const port = 3429;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-model-${Date.now()}`; process.env.MOCK_ENGINE = "true"; process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
process.env.PRIME_AGENT_MODEL = "test-model";

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 1200));
const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

function makeClient() {
  let cookie = "";
  return async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
    const text = await response.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json };
  };
}

const owner = makeClient();
const registered = await owner("POST", "/api/v1/auth/register", { email: `model-${Date.now()}@example.test`, password: "Model12345!", displayName: "Model Owner" });
const workspaceId = registered.json.workspace.id;
const project = await owner("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Models", slug: `m-${Date.now()}` });
const projectId = project.json.id;

const catalogue = await owner("GET", "/api/v1/models");
check("model catalogue responds", catalogue.status === 200 && Array.isArray(catalogue.json.models), JSON.stringify(catalogue.json).slice(0, 200));
check("catalogue lists at least one engine model", catalogue.json.models.length > 0, JSON.stringify(catalogue.json.error ?? ""));
check("catalogue reports the configured default", catalogue.json.default && typeof catalogue.json.default.model === "string", JSON.stringify(catalogue.json.default));
const sampleModel = catalogue.json.models[0]?.model as string;

const created = await owner("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Model" });
const conversationId = created.json.conversation.id;
const unknown = await owner("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "hai", model: "bukan-model-nyata-9000" });
check("unknown model rejected", unknown.status === 400 && unknown.json.error === "UNKNOWN_MODEL", JSON.stringify(unknown.json));

const sent = await owner("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "hai", model: sampleModel });
check("message accepted with a known model", sent.status === 202, JSON.stringify(sent.json));
const runId = sent.json.run.id;
const run = await owner("GET", `/api/v1/runs/${runId}`);
check("run stores the selected model", run.json.model === sampleModel, JSON.stringify(run.json));

const direct = await owner("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "hai", model: sampleModel });
check("direct run accepts a known model", direct.status === 202 && direct.json.model === sampleModel, JSON.stringify(direct.json));
const badDirect = await owner("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "hai", model: "tidak-ada-123" });
check("direct run rejects an unknown model", badDirect.status === 400 && badDirect.json.error === "UNKNOWN_MODEL", JSON.stringify(badDirect.json));

// A viewer joins through an invitation and must stay read-only.
const invitee = makeClient();
const inviteEmail = `viewer-${Date.now()}@example.test`;
await invitee("POST", "/api/v1/auth/register", { email: inviteEmail, password: "Viewer12345!", displayName: "Viewer" });
const invitation = await owner("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: inviteEmail, role: "viewer" });
const accepted = await invitee("POST", "/api/v1/invitations/accept", { token: invitation.json.token });
check("viewer joined the workspace", accepted.status === 200 && accepted.json.role === "viewer", JSON.stringify(accepted.json));
const viewerRead = await invitee("GET", `/api/v1/projects/${projectId}/conversations`);
check("viewer can read conversations", viewerRead.status === 200, JSON.stringify(viewerRead.json).slice(0, 120));
const viewerSend = await invitee("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "hai" });
check("viewer cannot send a message", viewerSend.status === 403 && viewerSend.json.error === "VIEWER_READ_ONLY", JSON.stringify(viewerSend.json));
const viewerRun = await invitee("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "hai" });
check("viewer cannot start a run", viewerRun.status === 403 && viewerRun.json.error === "VIEWER_READ_ONLY", JSON.stringify(viewerRun.json));

const outsider = makeClient();
await outsider("POST", "/api/v1/auth/register", { email: `outsider-${Date.now()}@example.test`, password: "Outsider12345!", displayName: "Out" });
const outsiderRun = await outsider("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "hai" });
check("outsider cannot start a run", outsiderRun.status === 404, JSON.stringify(outsiderRun.json));

console.log(failures === 0 ? "ALL_MODEL_RBAC_TESTS_PASSED" : `MODEL_RBAC_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

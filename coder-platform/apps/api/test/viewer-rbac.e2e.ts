/**
 * Viewer RBAC suite: a read-only member must not change project or workspace content.
 * Usage: npx tsx apps/api/test/viewer-rbac.e2e.ts
 */
import { randomUUID } from "node:crypto";
const port = 3454;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-viewer-e2e-${Date.now()}`; process.env.MOCK_ENGINE = "true";
await import("../src/server.js");
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

const owner = client(); const viewer = client(); const outsider = client();
const reg = await owner("POST", "/api/v1/auth/register", { email: `owner-${randomUUID().slice(0, 8)}@example.test`, password: "Viewer12345!", displayName: "Owner" });
const workspaceId = reg.json.workspace.id;
const project = await owner("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Viewer", slug: `v-${Date.now()}` });
const projectId = project.json.id;
const conversation = await owner("POST", `/api/v1/projects/${projectId}/conversations`, { title: "milik owner" });
const conversationId = conversation.json.conversation.id;
const workflow = await owner("POST", `/api/v1/projects/${projectId}/workflows`, { name: "wf", steps: [{ id: "a", type: "prompt", prompt: "hai" }] });
const workflowId = workflow.json.id;
const execution = await owner("POST", `/api/v1/workflows/${workflowId}/execute`, { input: "" });

const viewerEmail = `viewer-${randomUUID().slice(0, 8)}@example.test`;
await viewer("POST", "/api/v1/auth/register", { email: viewerEmail, password: "Viewer12345!", displayName: "Viewer" });
const invite = await owner("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: viewerEmail, role: "viewer" });
check("viewer invitation accepted", (await viewer("POST", "/api/v1/invitations/accept", { token: invite.json.token ?? invite.json.invitation?.token })).status === 200);
await outsider("POST", "/api/v1/auth/register", { email: `outsider-${randomUUID().slice(0, 8)}@example.test`, password: "Viewer12345!", displayName: "Outsider" });

check("viewer can read conversations", (await viewer("GET", `/api/v1/projects/${projectId}/conversations`)).status === 200);
check("viewer can read usage", (await viewer("GET", `/api/v1/projects/${projectId}/usage`)).status === 200);

const writes: [string, string, string, unknown?][] = [
  ["create conversation", "POST", `/api/v1/projects/${projectId}/conversations`, { title: "x" }],
  ["rename conversation", "PATCH", `/api/v1/conversations/${conversationId}`, { title: "diubah" }],
  ["delete conversation", "DELETE", `/api/v1/conversations/${conversationId}`],
  ["send message", "POST", `/api/v1/projects/${projectId}/runs`, { prompt: "x" }],
  ["create workflow", "POST", `/api/v1/projects/${projectId}/workflows`, { name: "x", steps: [] }],
  ["update workflow", "PUT", `/api/v1/workflows/${workflowId}`, { name: "diubah", steps: [] }],
  ["publish workflow", "POST", `/api/v1/workflows/${workflowId}/publish`],
  ["schedule workflow", "POST", `/api/v1/workflows/${workflowId}/schedule`, { intervalMinutes: 5, enabled: true }],
  ["execute workflow", "POST", `/api/v1/workflows/${workflowId}/execute`, { input: "x" }],
  ["create text knowledge", "POST", `/api/v1/projects/${projectId}/knowledge`, { title: "x", content: "y" }],
  ["delete knowledge", "DELETE", `/api/v1/projects/${projectId}/knowledge/00000000-0000-0000-0000-000000000000`],
  ["upload artifact", "POST", `/api/v1/projects/${projectId}/artifacts`, { name: "a.txt", mimeType: "text/plain", contentBase64: Buffer.from("hi").toString("base64") }],
  ["import conversation", "POST", `/api/v1/projects/${projectId}/conversations/import`, { conversation: { title: "z", messages: [] } }],
  ["create project", "POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "p", slug: `p-${Date.now()}` }],
  ["invite member", "POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: `x-${Date.now()}@example.test`, role: "viewer" }],
  ["patch member role", "PATCH", `/api/v1/workspaces/${workspaceId}/members/${reg.json.user.id}`, { role: "viewer" }],
  ["remove member", "DELETE", `/api/v1/workspaces/${workspaceId}/members/${reg.json.user.id}`],
];
for (const [name, method, path, body] of writes) {
  const result = await viewer(method, path, body);
  check(`viewer blocked: ${name}`, result.status === 403, `status=${result.status} body=${JSON.stringify(result.json)?.slice(0, 90)}`);
}

const outsiderReads = await outsider("GET", `/api/v1/projects/${projectId}/conversations`);
check("outsider cannot read project conversations", outsiderReads.status === 404 || outsiderReads.status === 403, `status=${outsiderReads.status}`);
const outsiderWrite = await outsider("POST", `/api/v1/projects/${projectId}/conversations`, { title: "x" });
check("outsider cannot create conversation", outsiderWrite.status === 404 || outsiderWrite.status === 403, `status=${outsiderWrite.status}`);
const outsiderUsage = await outsider("GET", `/api/v1/projects/${projectId}/usage`);
check("outsider cannot read usage", outsiderUsage.status === 404 || outsiderUsage.status === 403, `status=${outsiderUsage.status}`);

console.log(fail === 0 ? "ALL_VIEWER_RBAC_TESTS_PASSED" : `VIEWER_RBAC_FAILURES=${fail}`);
console.log(`VIEWER_RBAC_SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

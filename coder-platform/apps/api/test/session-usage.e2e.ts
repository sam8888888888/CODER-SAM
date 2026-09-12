
/**
 * Conversation management (rename, pin, delete, export, import), run cancel and usage tracking.
 * Runs with the mock engine.
 */
const port = 3428;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-session-${Date.now()}`; process.env.MOCK_ENGINE = "true"; process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
process.env.PRIME_AGENT_MODEL = "test-model";

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 1200));
const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

let cookie = "";
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

const registered = await call("POST", "/api/v1/auth/register", { email: `session-${Date.now()}@example.test`, password: "Session123!", displayName: "Session" });
const workspaceId = registered.json.workspace.id;
const project = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Sessions", slug: `s-${Date.now()}` });
const projectId = project.json.id;
const created = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Awal" });
const conversationId = created.json.conversation.id;
check("conversation created", Boolean(conversationId));

const renamed = await call("PATCH", `/api/v1/conversations/${conversationId}`, { title: "Rencana rilis", pinned: true });
check("conversation renamed and pinned", renamed.status === 200 && renamed.json.title === "Rencana rilis" && renamed.json.pinned === true, JSON.stringify(renamed.json));
const list = await call("GET", `/api/v1/projects/${projectId}/conversations`);
check("list exposes pinned state", list.json.some((row: any) => row.id === conversationId && row.pinned === 1), JSON.stringify(list.json));
const blankTitle = await call("PATCH", `/api/v1/conversations/${conversationId}`, { title: "   " });
check("blank title rejected", blankTitle.status === 400, JSON.stringify(blankTitle.json));

const answered = await call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Halo, tolong ringkas rencana rilis." });
check("message accepted with run", answered.status === 202 && Boolean(answered.json.run.id), JSON.stringify(answered.json).slice(0, 160));
await new Promise((resolve) => setTimeout(resolve, 2000));

const exported = await call("GET", `/api/v1/conversations/${conversationId}/export`);
check("export contains both turns", exported.status === 200 && exported.json.messages.length === 2 && exported.json.format === "coblai.conversation.v1", JSON.stringify(exported.json).slice(0, 200));

const imported = await call("POST", `/api/v1/projects/${projectId}/conversations/import`, { conversation: { title: exported.json.conversation.title, messages: exported.json.messages } });
check("import creates a conversation", imported.status === 201 && imported.json.conversation.messages === 2, JSON.stringify(imported.json));
const importedMessages = await call("GET", `/api/v1/conversations/${imported.json.conversation.id}/messages`);
check("imported messages readable", importedMessages.json.messages.length === 2, JSON.stringify(importedMessages.json).slice(0, 160));
const badImport = await call("POST", `/api/v1/projects/${projectId}/conversations/import`, { conversation: { title: "x" } });
check("import without messages rejected", badImport.status === 400, JSON.stringify(badImport.json));

const usage = await call("GET", `/api/v1/projects/${projectId}/usage?days=7`);
check("usage totals recorded", usage.status === 200 && usage.json.totals.runs === 1 && usage.json.totals.outputTokens > 0, JSON.stringify(usage.json).slice(0, 240));
check("usage marked estimated when engine reports nothing", Number(usage.json.totals.estimatedRuns) === 1, JSON.stringify(usage.json.totals));
check("usage by model groups the configured model", usage.json.byModel.length === 1 && usage.json.byModel[0].model === "test-model", JSON.stringify(usage.json.byModel));
check("usage daily bucket present", usage.json.daily.length === 1, JSON.stringify(usage.json.daily));

const removed = await call("DELETE", `/api/v1/conversations/${conversationId}`);
check("conversation deleted", removed.status === 200 && removed.json.deleted === true, JSON.stringify(removed.json));
const missing = await call("GET", `/api/v1/conversations/${conversationId}/messages`);
check("deleted conversation no longer readable", missing.status === 404, JSON.stringify(missing.json));
const audit = await call("GET", `/api/v1/workspaces/${workspaceId}/audit`);
const actions = (audit.json ?? []).map((row: any) => row.action);
check("audit records conversation delete", actions.includes("conversation.deleted"), JSON.stringify(actions.slice(0, 6)));
check("audit records conversation import", actions.includes("conversation.imported"), JSON.stringify(actions.slice(0, 6)));

console.log(failures === 0 ? "ALL_SESSION_USAGE_TESTS_PASSED" : `SESSION_USAGE_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

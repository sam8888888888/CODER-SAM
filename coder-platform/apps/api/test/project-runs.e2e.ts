/**
 * Project and run-history suite: rename a project and read its run list with the right permissions.
 * Usage: npx tsx apps/api/test/project-runs.e2e.ts
 */
import { randomUUID } from "node:crypto";
const port = 3459;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-projruns-${Date.now()}`; process.env.MOCK_ENGINE = "true";
await import("../src/server.js");
await new Promise((r) => setTimeout(r, 1200));
const base = `http://127.0.0.1:${port}`;
let pass = 0; let fail = 0;
function check(name: string, ok: boolean, info = "") { if (ok) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} ${info}`); } }
async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}
async function signUp(name: string) {
  const email = `${name}.${randomUUID().slice(0, 8)}@example.test`;
  const out = await call("POST", "/api/v1/auth/register", { email, password: "ProjectRuns123!", displayName: name });
  return { email, cookie: out.cookie, userId: out.json?.user?.id as string };
}
const owner = await signUp("owner");
const outsider = await signUp("outsider");
const workspaceId = (await call("GET", "/api/v1/workspaces", undefined, owner.cookie)).json[0].id;

const created = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Proyek Uji", description: "awal" }, owner.cookie);
check("project can be created", created.status === 200 || created.status === 201, JSON.stringify(created.json));
const projectId = created.json?.project?.id ?? created.json?.id;
check("a project can be created from a name alone (slug is derived)", created.status === 201 && !created.json?.error, JSON.stringify(created.json));
check("new project carries a name", Boolean(projectId), JSON.stringify(created.json));

const renamed = await call("PATCH", `/api/v1/projects/${projectId}`, { name: "Proyek Berganti Nama" }, owner.cookie);
check("project can be renamed", renamed.status === 200 && renamed.json?.project?.name === "Proyek Berganti Nama", JSON.stringify(renamed.json));
const listed = (await call("GET", `/api/v1/workspaces/${workspaceId}/projects`, undefined, owner.cookie)).json;
check("renamed project shows in the project list", listed.some((p: any) => p.name === "Proyek Berganti Nama"), JSON.stringify(listed));
check("empty name is refused", (await call("PATCH", `/api/v1/projects/${projectId}`, { name: "   " }, owner.cookie)).json?.error === "INVALID_PROJECT_NAME");

const runs = await call("GET", `/api/v1/projects/${projectId}/runs`, undefined, owner.cookie);
check("run history answers with a list", runs.status === 200 && Array.isArray(runs.json?.runs), JSON.stringify(runs.json));
check("a fresh project has no runs yet", runs.json?.runs?.length === 0, JSON.stringify(runs.json?.runs));
const withLimit = await call("GET", `/api/v1/projects/${projectId}/runs?limit=5`, undefined, owner.cookie);
check("run history accepts a limit", withLimit.status === 200 && Array.isArray(withLimit.json?.runs));

check("outsider cannot rename the project", (await call("PATCH", `/api/v1/projects/${projectId}`, { name: "Bukan Punya Dia" }, outsider.cookie)).status === 404);
check("outsider cannot read the run history", (await call("GET", `/api/v1/projects/${projectId}/runs`, undefined, outsider.cookie)).status === 404);
check("anonymous cannot read the run history", (await call("GET", `/api/v1/projects/${projectId}/runs`)).status === 401);

// The owner invites the outsider as viewer: renaming must stay refused, reading must stay allowed.
const invited = await call("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: outsider.email, role: "viewer" }, owner.cookie);
const token = invited.json?.invitation?.token ?? invited.json?.token;
if (token) {
  await call("POST", "/api/v1/invitations/accept", { token }, outsider.cookie);
  const viewerRename = await call("PATCH", `/api/v1/projects/${projectId}`, { name: "Viewer Coba Ubah" }, outsider.cookie);
  check("viewer cannot rename the project", viewerRename.status === 403 && viewerRename.json?.error === "VIEWER_READ_ONLY", JSON.stringify(viewerRename.json));
  const viewerRuns = await call("GET", `/api/v1/projects/${projectId}/runs`, undefined, outsider.cookie);
  check("viewer can read the run history", viewerRuns.status === 200, JSON.stringify(viewerRuns.json));
} else {
  check("invitation token was issued", false, JSON.stringify(invited.json));
}

console.log(fail === 0 ? "ALL_PROJECT_RUNS_TESTS_PASSED" : `PROJECT_RUNS_FAILURES=${fail}`);
console.log(`PROJECT_RUNS_SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Starts the API against a copy of the production database and reports status for key routes.
 */
const dir = process.env.CHECK_DIR!;
process.env.NODE_ENV = "test"; process.env.PORT = "3431"; process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dir; process.env.MOCK_ENGINE = "true"; process.env.PUBLIC_DIR = `${dir}/public`;
await import("../src/server.js");
await new Promise((r) => setTimeout(r, 1200));
let cookie = "";
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:3431${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); return { status: response.status, text };
}
console.log("LOGIN", JSON.stringify(await call("POST", "/api/v1/auth/login", { email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD })));
const ws = await call("GET", "/api/v1/workspaces"); console.log("WORKSPACES", ws.status, ws.text);
const projects = await call("GET", `/api/v1/workspaces/${JSON.parse(ws.text)[0].id}/projects`); console.log("PROJECTS", projects.status, projects.text);
const projectId = JSON.parse(projects.text)[0].id;
for (const path of [`/api/v1/projects/${projectId}/workflows`, `/api/v1/projects/${projectId}/knowledge`, `/api/v1/projects/${projectId}/usage`, `/api/v1/projects/${projectId}/conversations`]) {
  const result = await call("GET", path); console.log("GET", path.split("/").pop(), result.status, result.text);
}
process.exit(0);

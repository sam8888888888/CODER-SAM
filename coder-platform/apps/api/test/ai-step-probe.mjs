
const BASE = "https://coder.sam.university";
let cookie = "";
async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
}
const login = await call("POST", "/api/v1/auth/login", { email: process.env.CODER_EMAIL, password: process.env.CODER_PASSWORD });
const workspaces = await call("GET", "/api/v1/workspaces");
const projects = await call("GET", `/api/v1/workspaces/${workspaces.json[0].id}/projects`);
const projectId = projects.json[0].id;
const flow = await call("POST", `/api/v1/projects/${projectId}/workflows`, { name: `AI prompt prod ${Date.now()}`, steps: [{ id: "ask", type: "prompt", prompt: "Balas satu kata: siap" }] });
await call("POST", `/api/v1/workflows/${flow.json.id}/publish`);
const run = await call("POST", `/api/v1/workflows/${flow.json.id}/execute`, { input: "" });
await new Promise((r) => setTimeout(r, 12000));
const detail = await call("GET", `/api/v1/workflow-executions/${run.json.id}`);
console.log("STATUS", detail.json.status);
console.log("ERROR", JSON.stringify(detail.json.error));
console.log("STEP", JSON.stringify(detail.json.steps.map((s) => ({ type: s.type, status: s.status, error: s.error }))));


const port = 3427;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-up-probe-${Date.now()}`; process.env.MOCK_ENGINE = "true"; process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
await import("../src/server.js");
await new Promise((r) => setTimeout(r, 1000));
const { readFile } = await import("node:fs/promises");
let cookie = "";
async function call(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
}
const reg = await call("POST", "/api/v1/auth/register", { email: `p-${Date.now()}@example.test`, password: "Probe12345!", displayName: "P" });
const ws = reg.json.workspace.id;
const project = await call("POST", `/api/v1/workspaces/${ws}/projects`, { name: "P", slug: `p-${Date.now()}` });
const buffer = await readFile(new URL("./fixtures/sample.docx", import.meta.url));
const upload = await call("POST", `/api/v1/projects/${project.json.id}/knowledge/upload`, { filename: "kebijakan.docx", contentBase64: buffer.toString("base64") });
console.log("UPLOAD_STATUS", upload.status, JSON.stringify(upload.json).slice(0, 200));
process.exit(0);

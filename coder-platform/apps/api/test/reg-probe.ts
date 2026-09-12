const port = 3427;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-probe-${Date.now()}`; process.env.MOCK_ENGINE = "true"; process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
await import("../src/server.js");
await new Promise((r) => setTimeout(r, 1200));
const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `probe-${Date.now()}@example.test`, password: "Model123!", displayName: "Probe" }) });
console.log("REGISTER", response.status, (await response.text()).slice(0, 300));
process.exit(0);

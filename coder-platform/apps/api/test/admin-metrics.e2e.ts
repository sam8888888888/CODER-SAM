/**
 * Platform administration and metrics suite.
 * Usage: npx tsx apps/api/test/admin-metrics.e2e.ts
 */
import { randomUUID } from "node:crypto";
const port = 3457;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-admin-${Date.now()}`; process.env.MOCK_ENGINE = "true";
process.env.METRICS_TOKEN = "test-metrics-token";
process.env.PLATFORM_ADMIN_EMAILS = "";
await import("../src/server.js");
const { db } = await import("../src/db.js");
await new Promise((r) => setTimeout(r, 1200));
const base = `http://127.0.0.1:${port}`;
function client() {
  let cookie = "";
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  };
}
let pass = 0; let fail = 0;
function check(name: string, ok: boolean, info = "") { if (ok) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} ${info}`); } }

const admin = client(); const plain = client();
const adminReg = await admin("POST", "/api/v1/auth/register", { email: `admin-${randomUUID().slice(0, 8)}@example.test`, password: "AdminTest12345!", displayName: "Admin" });
await plain("POST", "/api/v1/auth/register", { email: `plain-${randomUUID().slice(0, 8)}@example.test`, password: "AdminTest12345!", displayName: "Plain" });

check("non admin is refused", (await plain("GET", "/api/v1/admin/overview")).status === 403);
check("admin endpoints are not open to anonymous callers", (await client()("GET", "/api/v1/admin/users")).status === 401);
check("metrics hidden without token", (await admin("GET", "/metrics")).json?.error === "NOT_FOUND");

db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(adminReg.json.user.id);

const overview = await admin("GET", "/api/v1/admin/overview");
check("admin overview answers", overview.status === 200, `${overview.status} ${JSON.stringify(overview.json)?.slice(0, 120)}`);
check("overview counts users", overview.json?.totals?.users >= 2, JSON.stringify(overview.json?.totals));
check("overview reports engine health", typeof overview.json?.engine?.available === "boolean", JSON.stringify(overview.json?.engine));
check("overview reports schema version", overview.json?.schemaVersion >= 6, String(overview.json?.schemaVersion));
check("overview reports cost in dollars", typeof overview.json?.usage?.costUsd === "number", JSON.stringify(overview.json?.usage));

const users = await admin("GET", "/api/v1/admin/users");
check("admin lists every user", Array.isArray(users.json) && users.json.length >= 2, JSON.stringify(users.json)?.slice(0, 120));
check("user rows hide password hashes", !JSON.stringify(users.json).includes("password"), "sensitive field leaked");
const workspaces = await admin("GET", "/api/v1/admin/workspaces");
check("admin lists every workspace with cost", Array.isArray(workspaces.json) && typeof workspaces.json[0]?.costMicros === "number", JSON.stringify(workspaces.json)?.slice(0, 140));

const metricsBad = await admin("GET", "/metrics?token=wrong");
check("metrics rejects a wrong token", metricsBad.json?.error === "NOT_FOUND");
const metrics = await admin("GET", "/metrics?token=test-metrics-token");
check("metrics answers with the right token", metrics.status === 200 && /coder_runs \d+/.test(metrics.text), metrics.text?.slice(0, 120));
check("metrics exposes cost and tokens", /coder_cost_micros \d+/.test(metrics.text) && /coder_tokens_input \d+/.test(metrics.text), metrics.text?.slice(0, 200));
check("metrics stays text and not JSON", String(metrics.text).startsWith("# HELP coder_info"));

const other = client();
const otherReg = await other("POST", "/api/v1/auth/register", { email: `grant-${randomUUID().slice(0, 8)}@example.test`, password: "AdminTest12345!", displayName: "Granted" });
const grant = await admin("POST", `/api/v1/admin/users/${otherReg.json.user.id}/admin`, { enabled: true });
check("admin can grant admin rights", grant.status === 200 && grant.json?.isAdmin === true, JSON.stringify(grant.json));
check("granted user reaches admin area", (await other("GET", "/api/v1/admin/overview")).status === 200);
const revoke = await admin("POST", `/api/v1/admin/users/${otherReg.json.user.id}/admin`, { enabled: false });
check("admin can revoke admin rights", revoke.json?.isAdmin === false, JSON.stringify(revoke.json));
check("revoked user is refused again", (await other("GET", "/api/v1/admin/overview")).status === 403);
check("granting raises a security notification", (await other("GET", "/api/v1/notifications")).json?.notifications?.some((item: any) => item.kind === "security"));

console.log(fail === 0 ? "ALL_ADMIN_METRICS_TESTS_PASSED" : `ADMIN_METRICS_FAILURES=${fail}`);
console.log(`ADMIN_METRICS_SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Login identity suite: the form accepts an email address or the username, and wrong input is refused clearly.
 * Usage: npx tsx apps/api/test/login-identity.e2e.ts
 */
import { randomUUID } from "node:crypto";
const port = 3458;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-login-${Date.now()}`; process.env.MOCK_ENGINE = "true";
await import("../src/server.js");
await new Promise((r) => setTimeout(r, 1200));
const base = `http://127.0.0.1:${port}`;
let pass = 0; let fail = 0;
function check(name: string, ok: boolean, info = "") { if (ok) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} ${info}`); } }
async function login(body: unknown) {
  const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
const suffix = randomUUID().slice(0, 8);
const email = `Login.${suffix}@Example.Test`;
const username = `login.${suffix}`;
const password = "LoginIdentity123!";
await fetch(`${base}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, displayName: "Login Test" }) });

check("email address signs in", (await login({ email, password })).status === 200);
check("uppercase email still signs in", (await login({ email: email.toUpperCase(), password })).status === 200);
check("email with spaces still signs in", (await login({ email: `  ${email}  `, password })).status === 200);
const byUsername = await login({ email: username, password });
check("username (part before the @) signs in", byUsername.status === 200, JSON.stringify(byUsername.json));
check("username login returns the full email", byUsername.json?.user?.email === email.toLowerCase(), JSON.stringify(byUsername.json?.user));
check("wrong password is refused", (await login({ email, password: "PasswordSalah123!" })).json?.error === "INVALID_CREDENTIALS");
check("wrong username is refused", (await login({ email: `tidak-ada-${suffix}`, password })).json?.error === "INVALID_CREDENTIALS");
check("empty password is refused", (await login({ email, password: "" })).json?.error === "INVALID_CREDENTIALS");

// Two accounts that share a username must not be guessed by username alone.
const shared = `shared.${suffix}`;
await fetch(`${base}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${shared}@satu.test`, password, displayName: "Satu" }) });
await fetch(`${base}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${shared}@dua.test`, password, displayName: "Dua" }) });
check("ambiguous username is refused", (await login({ email: shared, password })).json?.error === "INVALID_CREDENTIALS");
check("ambiguous username still works with the full email", (await login({ email: `${shared}@dua.test`, password })).status === 200);

console.log(fail === 0 ? "ALL_LOGIN_IDENTITY_TESTS_PASSED" : `LOGIN_IDENTITY_FAILURES=${fail}`);
console.log(`LOGIN_IDENTITY_SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

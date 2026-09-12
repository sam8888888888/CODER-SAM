/**
 * Account security: password change, session management and TOTP two factor login.
 * Runs with the mock engine; no network provider is needed.
 */
import { totp } from "../src/totp.js";

const port = 3426;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-security-${Date.now()}`; process.env.MOCK_ENGINE = "true"; process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
process.env.PRIME_AGENT_MODEL = "test-model";

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 1200));
const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

function makeClient() {
  let cookie = "";
  return {
    call: async function call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
      const text = await response.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json };
    },
    get cookie() { return cookie; },
  };
}

const email = `security-${Date.now()}@example.test`;
const password = "Security12345!";
const client = makeClient();
const registered = await client.call("POST", "/api/v1/auth/register", { email, password, displayName: "Security" });
check("account registered", registered.status === 201 || registered.status === 200, JSON.stringify(registered.json).slice(0, 120));

const sessions = await client.call("GET", "/api/v1/auth/sessions");
check("session list works", sessions.status === 200 && Array.isArray(sessions.json) && sessions.json.length === 1, JSON.stringify(sessions.json));
check("current session is flagged", sessions.json[0]?.current === true, JSON.stringify(sessions.json[0]));

const wrongCurrent = await client.call("POST", "/api/v1/auth/password", { currentPassword: "salah-sekali", newPassword: "Another12345!" });
check("password change rejects a wrong current password", wrongCurrent.status === 401, JSON.stringify(wrongCurrent.json));
const shortPassword = await client.call("POST", "/api/v1/auth/password", { currentPassword: password, newPassword: "pendek" });
check("password change rejects a short password", shortPassword.status === 400 && shortPassword.json.error === "INVALID_PASSWORD", JSON.stringify(shortPassword.json));

// A second device signs in; changing the password must keep this device and drop the other.
const otherDevice = makeClient();
const otherLogin = await otherDevice.call("POST", "/api/v1/auth/login", { email, password });
check("second device signs in", otherLogin.status === 200, JSON.stringify(otherLogin.json));
const afterSecondDevice = await client.call("GET", "/api/v1/auth/sessions");
check("two sessions are listed", afterSecondDevice.json.length === 2, JSON.stringify(afterSecondDevice.json));

const changed = await client.call("POST", "/api/v1/auth/password", { currentPassword: password, newPassword: "Changed12345!" });
check("password changed", changed.status === 200 && changed.json.changed === true, JSON.stringify(changed.json));
check("other sessions were revoked", (await otherDevice.call("GET", "/api/v1/auth/me")).status === 401, "other device still signed in");
check("current session survived", (await client.call("GET", "/api/v1/auth/me")).status === 200, "current device was signed out");
check("old password no longer works", (await makeClient().call("POST", "/api/v1/auth/login", { email, password })).status === 401, "old password accepted");
const relogin = await makeClient().call("POST", "/api/v1/auth/login", { email, password: "Changed12345!" });
check("new password works", relogin.status === 200, JSON.stringify(relogin.json));

const beforeSetup = await client.call("GET", "/api/v1/auth/mfa");
check("mfa starts disabled", beforeSetup.json.enabled === false && beforeSetup.json.pendingSetup === false, JSON.stringify(beforeSetup.json));
const setup = await client.call("POST", "/api/v1/auth/mfa/setup");
check("mfa setup returns a secret and an otpauth url", setup.status === 200 && typeof setup.json.secret === "string" && setup.json.otpauthUrl.startsWith("otpauth://totp/"), JSON.stringify(setup.json).slice(0, 160));
let secret = setup.json.secret as string;
const disableBeforeEnable = await client.call("POST", "/api/v1/auth/mfa/disable", { password: "Changed12345!", code: "000000" });
check("mfa disable needs a valid code only when enabled", disableBeforeEnable.status === 200 || disableBeforeEnable.json.error === "MFA_INVALID_CODE", JSON.stringify(disableBeforeEnable.json));
if (disableBeforeEnable.status === 200) { const again = await client.call("POST", "/api/v1/auth/mfa/setup"); secret = again.json.secret as string; } // a fresh setup clears the previous secret
const badEnable = await client.call("POST", "/api/v1/auth/mfa/enable", { code: "000000" });
check("mfa enable rejects a wrong code", badEnable.status === 400 && badEnable.json.error === "MFA_INVALID_CODE", JSON.stringify(badEnable.json));
const goodEnable = await client.call("POST", "/api/v1/auth/mfa/enable", { code: totp(secret) });
check("mfa enable accepts the current code", goodEnable.status === 200 && goodEnable.json.enabled === true && goodEnable.json.recoveryCodes.length === 6, JSON.stringify(goodEnable.json).slice(0, 160));
const recovery = goodEnable.json.recoveryCodes as string[];

const noCode = await makeClient().call("POST", "/api/v1/auth/login", { email, password: "Changed12345!" });
check("login without a code is refused", noCode.status === 401 && noCode.json.error === "MFA_REQUIRED", JSON.stringify(noCode.json));
const wrongCode = await makeClient().call("POST", "/api/v1/auth/login", { email, password: "Changed12345!", code: "123456" });
check("login with a wrong code is refused", wrongCode.status === 401 && wrongCode.json.error === "MFA_INVALID_CODE", JSON.stringify(wrongCode.json));
const rightCode = await makeClient().call("POST", "/api/v1/auth/login", { email, password: "Changed12345!", code: totp(secret) });
check("login with a valid code succeeds", rightCode.status === 200 && rightCode.json.mfaEnabled === true, JSON.stringify(rightCode.json));
const recoveryLogin = await makeClient().call("POST", "/api/v1/auth/login", { email, password: "Changed12345!", code: recovery[0] });
check("a recovery code signs in once", recoveryLogin.status === 200, JSON.stringify(recoveryLogin.json));
const reuseRecovery = await makeClient().call("POST", "/api/v1/auth/login", { email, password: "Changed12345!", code: recovery[0] });
check("a used recovery code is refused", reuseRecovery.status === 401 && reuseRecovery.json.error === "MFA_INVALID_CODE", JSON.stringify(reuseRecovery.json));
check("mfa reports enabled", (await client.call("GET", "/api/v1/auth/mfa")).json.enabled === true, "mfa flag wrong");

const badDisable = await client.call("POST", "/api/v1/auth/mfa/disable", { password: "salah-sekali", code: totp(secret) });
check("mfa disable rejects a wrong password", badDisable.status === 401, JSON.stringify(badDisable.json));
const noCodeDisable = await client.call("POST", "/api/v1/auth/mfa/disable", { password: "Changed12345!", code: "000000" });
check("mfa disable rejects a wrong code", noCodeDisable.status === 400 && noCodeDisable.json.error === "MFA_INVALID_CODE", JSON.stringify(noCodeDisable.json));
const disabled = await client.call("POST", "/api/v1/auth/mfa/disable", { password: "Changed12345!", code: totp(secret) });
check("mfa disabled with the right code", disabled.status === 200 && disabled.json.enabled === false, JSON.stringify(disabled.json));
const plainLogin = await makeClient().call("POST", "/api/v1/auth/login", { email, password: "Changed12345!" });
check("login works without a code after disabling", plainLogin.status === 200, JSON.stringify(plainLogin.json));

const revokeTarget = await client.call("GET", "/api/v1/auth/sessions");
const other = revokeTarget.json.find((row: any) => !row.current) ?? revokeTarget.json[0];
const revoked = await client.call("DELETE", `/api/v1/auth/sessions/${other.id}`);
check("session revoked by id", revoked.status === 200 && revoked.json.revoked === true, JSON.stringify(revoked.json));
const unknownRevoke = await client.call("DELETE", "/api/v1/auth/sessions/tidak-ada");
check("unknown session id is rejected", unknownRevoke.status === 404, JSON.stringify(unknownRevoke.json));

console.log(failures === 0 ? "ALL_ACCOUNT_SECURITY_TESTS_PASSED" : `ACCOUNT_SECURITY_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

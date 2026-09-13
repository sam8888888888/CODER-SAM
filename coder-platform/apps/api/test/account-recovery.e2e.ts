/**
 * Account recovery suite: email verification, password reset, notifications and platform administration.
 * A local fake SMTP server records the delivered mail, so delivery is proven without external mail.
 * Usage: npx tsx apps/api/test/account-recovery.e2e.ts
 */
import net from "node:net";
import { randomUUID } from "node:crypto";

// Fake SMTP server: speaks just enough of the protocol and records every DATA payload.
const received: string[] = [];
const smtp = net.createServer((socket) => {
  let inData = false; let buffer = ""; let current = ""; let authStep = 0;
  socket.write("220 fake-smtp ready\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\r\n");
    while (index !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (inData) {
        if (line === ".") { inData = false; received.push(current); current = ""; socket.write("250 2.0.0 queued\r\n"); }
        else current += `${line}\n`;
      } else if (/^(EHLO|HELO)/i.test(line)) socket.write("250-fake-smtp\r\n250 AUTH LOGIN\r\n");
      else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; socket.write("334 VXNlcm5hbWU6\r\n"); }
      else if (authStep === 1) { authStep = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); }
      else if (authStep === 2) { authStep = 0; socket.write("235 2.7.0 authenticated\r\n"); }
      else if (/^MAIL FROM/i.test(line) || /^RCPT TO/i.test(line)) socket.write("250 OK\r\n");
      else if (/^DATA/i.test(line)) { inData = true; socket.write("354 end with .\r\n"); }
      else if (/^QUIT/i.test(line)) { socket.write("221 bye\r\n"); socket.end(); }
      else socket.write("250 OK\r\n");
      index = buffer.indexOf("\r\n");
    }
  });
  socket.on("error", () => { /* client closed */ });
});
await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
const smtpPort = (smtp.address() as net.AddressInfo).port;

const port = 3455;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-recovery-${Date.now()}`; process.env.MOCK_ENGINE = "true";
process.env.SMTP_HOST = "127.0.0.1"; process.env.SMTP_PORT = String(smtpPort); process.env.SMTP_USER = "no-reply"; process.env.SMTP_PASSWORD = "secret";
process.env.SMTP_FROM = "COBLAI Coder <no-reply@coder.sam.university>";
process.env.PUBLIC_BASE_URL = "https://coder.sam.university";
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

const email = `recover-${randomUUID().slice(0, 8)}@example.test`;
const clientA = client();
const registered = await clientA("POST", "/api/v1/auth/register", { email, password: "Original12345!", displayName: "Recovery" });
check("register returns 201", registered.status === 201, JSON.stringify(registered.json)?.slice(0, 120));
check("register reports email verification as sent", registered.json?.emailVerification?.sent === true, JSON.stringify(registered.json?.emailVerification));
check("verification mail delivered", received.some((mail) => /verify-email\?token=/.test(mail)), `mailCount=${received.length}`);

const verifyMail = received.reverse().find((mail) => /verify-email\?token=/.test(mail)) ?? "";
const verifyToken = /verify-email\?token=([^\s]+)/.exec(verifyMail)?.[1] ?? "";
check("verification token present", verifyToken.length > 10);
const verified = await clientA("POST", "/api/v1/auth/email/verify", { token: decodeURIComponent(verifyToken) });
check("email verify accepted", verified.status === 200 && verified.json?.verified === true, JSON.stringify(verified.json));
const verifyAgain = await clientA("POST", "/api/v1/auth/email/verify", { token: decodeURIComponent(verifyToken) });
check("verification token is single use", verifyAgain.status === 400 && verifyAgain.json?.error === "TOKEN_INVALID_OR_EXPIRED", JSON.stringify(verifyAgain.json));

const welcome = await clientA("GET", "/api/v1/notifications");
check("welcome notification exists", (welcome.json?.notifications ?? []).some((item: any) => item.kind === "account"), JSON.stringify(welcome.json).slice(0, 160));
check("unread counter works", welcome.json?.unread >= 1, String(welcome.json?.unread));
const firstId = welcome.json?.notifications?.[0]?.id;
check("notification marked read", (await clientA("POST", `/api/v1/notifications/${firstId}/read`)).json?.read === true);
check("read-all works", typeof (await clientA("POST", "/api/v1/notifications/read-all")).json?.read === "number");

// Forgot password: an unknown address must answer the same way as a known one.
const unknown = await client()("POST", "/api/v1/auth/password/forgot", { email: `nobody-${randomUUID().slice(0, 6)}@example.test` });
check("forgot password hides unknown accounts", unknown.status === 200 && unknown.json?.ok === true, JSON.stringify(unknown.json));

const forgot = await client()("POST", "/api/v1/auth/password/forgot", { email });
check("forgot password accepted", forgot.status === 200 && forgot.json?.delivery === "email", JSON.stringify(forgot.json));
const resetMail = received.reverse().find((mail) => /reset-password\?token=/.test(mail)) ?? "";
const resetToken = decodeURIComponent(/reset-password\?token=([^\s]+)/.exec(resetMail)?.[1] ?? "");
check("reset mail delivered with token", resetToken.length > 10);

const weak = await client()("POST", "/api/v1/auth/password/reset", { token: resetToken, password: "short" });
check("weak password rejected", weak.status === 400 && weak.json?.error === "WEAK_PASSWORD", JSON.stringify(weak.json));

const reset = await client()("POST", "/api/v1/auth/password/reset", { token: resetToken, password: "BrandNew12345!" });
check("password reset accepted", reset.status === 200 && reset.json?.reset === true, JSON.stringify(reset.json));
check("new password works", (await client()("POST", "/api/v1/auth/login", { email, password: "BrandNew12345!" })).status === 200);
check("old password rejected", (await client()("POST", "/api/v1/auth/login", { email, password: "Original12345!" })).status === 401);
check("old session revoked after reset", (await clientA("GET", "/api/v1/auth/me")).status === 401);
const reuse = await client()("POST", "/api/v1/auth/password/reset", { token: resetToken, password: "Another12345!" });
check("reset token is single use", reuse.status === 400, JSON.stringify(reuse.json));

// When SMTP is missing, the API must say so instead of pretending it sent mail.
const { config } = await import("../src/config.js");
const savedHost = config.SMTP_HOST;
config.SMTP_HOST = undefined;
const withoutSmtp = await client()("POST", "/api/v1/auth/password/forgot", { email });
check("forgot password reports unavailable mail honestly", withoutSmtp.json?.delivery === "unavailable" && withoutSmtp.json?.note === "EMAIL_NOT_CONFIGURED", JSON.stringify(withoutSmtp.json));
config.SMTP_HOST = savedHost;

console.log(`RECOVERY_SMTP_MESSAGES=${received.length}`);
console.log(fail === 0 ? "ALL_ACCOUNT_RECOVERY_TESTS_PASSED" : `ACCOUNT_RECOVERY_FAILURES=${fail}`);
console.log(`ACCOUNT_RECOVERY_SUMMARY pass=${pass} fail=${fail}`);
smtp.close();
process.exit(fail === 0 ? 0 : 1);


/**
 * E2E: klien SMTP platform (apps/api/src/mailer.ts) melawan server SMTP tiruan.
 * Jalankan: npx tsx apps/api/test/mailer.e2e.ts
 *
 * Kenapa suite ini ada: pada 13 Sep 2026 ditemukan bug nyata. Server SMTP asli
 * (mailcow) menolak dengan "530 Must issue a STARTTLS command first" karena klien
 * hanya membaca baris TERAKHIR balasan EHLO, sehingga kapabilitas STARTTLS
 * (yang dikirim sebagai baris lanjutan "250-STARTTLS") tidak pernah terlihat.
 * Suite ini mengunci perilaku yang benar:
 *   A) jalur biasa + AUTH LOGIN + DATA,
 *   B) jalur STARTTLS (EHLO multi-baris, upgrade TLS, EHLO ulang, lalu kirim),
 *   C) kredensial ditolak, koneksi ditolak, server diam (timeout),
 *   D) SMTP_HOST kosong -> EMAIL_NOT_CONFIGURED (tidak pernah memalsukan sukses).
 *
 * Sertifikat self-signed dibuat saat suite berjalan lewat openssl, dan hanya untuk
 * proses uji ini NODE_TLS_REJECT_UNAUTHORIZED=0 dipakai.
 */
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

let pass = 0;
let fail = 0;
let checkNumber = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  checkNumber += 1;
  if (condition) { pass += 1; console.log(`PASS ${checkNumber}) ${name}`); }
  else { fail += 1; console.log(`FAIL ${checkNumber}) ${name}${extra === undefined ? "" : " | " + JSON.stringify(extra)}`); }
}

if (process.env.MAILER_MODE === "unconfigured") {
  const { mailerConfigured, sendMail } = await import("../src/mailer.js");
  const configured = mailerConfigured();
  const result = await sendMail({ to: "someone@example.test", subject: "x", text: "y" });
  console.log(JSON.stringify({ mode: "unconfigured", configured, result }));
  process.exit(result.sent === false && result.reason === "EMAIL_NOT_CONFIGURED" && configured === false ? 0 : 1);
}

/** Sertifikat self-signed untuk server STARTTLS tiruan. */
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailer-cert-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
  "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem"),
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const keyPem = fs.readFileSync(path.join(certDir, "key.pem"));
const certPem = fs.readFileSync(path.join(certDir, "cert.pem"));

process.env.NODE_ENV = "test";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // hanya sertifikat self-signed pada suite ini
process.env.SMTP_HOST = "127.0.0.1";
/** Port tetap: config.ts membaca SMTP_PORT saat impor, jadi semua server tiruan memakai port ini. */
const SMTP_PORT = String(3960 + Math.floor(Math.random() * 30));
process.env.SMTP_PORT = SMTP_PORT;
process.env.SMTP_SECURE = "false";
process.env.SMTP_USER = "noreply@example.test";
process.env.SMTP_PASSWORD = "rahasia-uji-123";
process.env.SMTP_FROM = "COBLAI Coder <noreply@example.test>";
process.env.PUBLIC_BASE_URL = "https://coder.sam.university";

const { mailerConfigured, sendMail, verificationEmail, passwordResetEmail } = await import("../src/mailer.js");

type Recorded = {
  commands: string[];
  authUser?: string;
  authPassword?: string;
  mailFrom?: string;
  rcptTo?: string;
  data?: string;
  ehloCount: number;
  tlsUsed: boolean;
  peerAuthorized?: boolean;
};

/** Server SMTP tiruan: cukup lengkap untuk menguji klien STARTTLS + AUTH LOGIN. */
function startFakeServer(options: { advertiseStartTls: boolean; rejectAuth?: boolean; silent?: boolean }) {
  const recorded: Recorded = { commands: [], ehloCount: 0, tlsUsed: false };
  const server = net.createServer((socket) => {
    if (options.silent) return; // sengaja tidak menyapa: menguji timeout klien
    let current: net.Socket = socket;
    const secureContext = tls.createSecureContext({ key: keyPem, cert: certPem });
    let buffer = "";
    let awaiting: "none" | "authUser" | "authPassword" = "none";
    let inData = false;
    const write = (text: string) => current.write(text);

    const greeting = () => write("220 fake.mail.test ESMTP siap\r\n");

    const handleLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          write("250 2.0.0 Ok: queued\r\n");
        } else {
          recorded.data = (recorded.data ?? "") + line + "\n";
        }
        return;
      }
      recorded.commands.push(line);
      const upper = line.toUpperCase();
      if (awaiting === "authUser") { recorded.authUser = Buffer.from(line, "base64").toString(); awaiting = "authPassword"; write("334 UGFzc3dvcmQ6\r\n"); return; }
      if (awaiting === "authPassword") {
        recorded.authPassword = Buffer.from(line, "base64").toString();
        awaiting = "none";
        if (options.rejectAuth) write("535 5.7.8 Authentication credentials invalid\r\n");
        else write("235 2.7.0 Authentication successful\r\n");
        return;
      }
      if (upper.startsWith("EHLO")) {
        recorded.ehloCount += 1;
        const lines = ["250-fake.mail.test", "250-PIPELINING", "250-AUTH LOGIN PLAIN"];
        if (options.advertiseStartTls) lines.push("250-STARTTLS");
        lines.push("250 SIZE 10485760");
        write(lines.join("\r\n") + "\r\n");
        return;
      }
      if (upper === "STARTTLS") {
        write("220 2.0.0 Ready to start TLS\r\n");
        const secured = new tls.TLSSocket(current, { isServer: true, secureContext });
        secured.on("secure", () => {
          recorded.tlsUsed = true;
          recorded.peerAuthorized = secured.authorized;
          bind(secured);
        });
        secured.on("error", () => { /* klien menutup koneksi */ });
        return;
      }
      if (upper.startsWith("AUTH LOGIN")) { awaiting = "authUser"; write("334 VXNlcm5hbWU6\r\n"); return; }
      if (upper.startsWith("AUTH PLAIN")) { if (options.rejectAuth) write("535 5.7.8 Authentication credentials invalid\r\n"); else write("235 2.7.0 Authentication successful\r\n"); return; }
      if (upper.startsWith("MAIL FROM")) {
        if (options.advertiseStartTls && !recorded.tlsUsed) { write("530 5.7.0 Must issue a STARTTLS command first\r\n"); return; }
        recorded.mailFrom = line;
        write("250 2.1.0 Ok\r\n");
        return;
      }
      if (upper.startsWith("RCPT TO")) { recorded.rcptTo = line; write("250 2.1.5 Ok\r\n"); return; }
      if (upper === "DATA") { inData = true; write("354 End data with <CR><LF>.<CR><LF>\r\n"); return; }
      if (upper === "QUIT") { write("221 2.0.0 Bye\r\n"); current.end(); return; }
      write("250 2.0.0 Ok\r\n");
    };

    const bind = (target: net.Socket) => {
      current = target;
      buffer = "";
      target.setEncoding("utf8");
      target.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\r\n");
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handleLine(line);
          index = buffer.indexOf("\r\n");
        }
      });
      target.on("error", () => { /* diabaikan */ });
    };

    bind(socket);
    greeting();
  });
  return new Promise<{ recorded: Recorded; port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(Number(process.env.SMTP_PORT), "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({ recorded, port: address.port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** Jalankan ulang suite ini dengan SMTP_HOST kosong, di proses terpisah. */
function spawnUnconfiguredCheck() {
  const env = { ...process.env, MAILER_MODE: "unconfigured", SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "" };
  const result = spawnSync("npx", ["tsx", "apps/api/test/mailer.e2e.ts"], { env, encoding: "utf8", cwd: process.cwd(), timeout: 120_000 });
  return { status: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
}

check("SMTP_HOST terisi -> mailerConfigured() true", mailerConfigured() === true);

// --- A) jalur biasa (tanpa STARTTLS) + AUTH LOGIN + DATA ---
const plainServer = await startFakeServer({ advertiseStartTls: false });
const plainResult = await sendMail({ to: "samianpacing@gmail.com", subject: "Atur ulang kata sandi COBLAI Coder", text: passwordResetEmail("Bapak Samian", "https://coder.sam.university/reset-password?token=abc123") });
check("A) surat terkirim tanpa STARTTLS (sent true)", plainResult.sent === true, plainResult);
check("A) server menerima AUTH LOGIN", plainServer.recorded.commands.some((line) => line.toUpperCase().includes("AUTH LOGIN")));
check("A) nama pengguna AUTH benar", plainServer.recorded.authUser === "noreply@example.test", plainServer.recorded.authUser);
check("A) kata sandi AUTH benar", plainServer.recorded.authPassword === "rahasia-uji-123");
check("A) MAIL FROM memakai alamat di dalam SMTP_FROM", (plainServer.recorded.mailFrom ?? "").includes("<noreply@example.test>"), plainServer.recorded.mailFrom);
check("A) RCPT TO ke penerima", (plainServer.recorded.rcptTo ?? "").includes("<samianpacing@gmail.com>"));
check("A) isi surat memuat tautan reset", (plainServer.recorded.data ?? "").includes("reset-password?token=abc123"));
check("A) isi surat memuat masa berlaku 60 menit", (plainServer.recorded.data ?? "").includes("60 menit"));
check("A) header From memakai nama tampilan", (plainServer.recorded.data ?? "").includes("From: COBLAI Coder <noreply@example.test>"));
check("A) header To dan Subject ikut terkirim", (plainServer.recorded.data ?? "").includes("To: samianpacing@gmail.com") && (plainServer.recorded.data ?? "").includes("Subject: Atur ulang kata sandi COBLAI Coder"));
await plainServer.close();

// --- B) jalur STARTTLS (inilah bug yang diperbaiki) ---
const tlsServer = await startFakeServer({ advertiseStartTls: true });
const tlsResult = await sendMail({ to: "samianpacing@gmail.com", subject: "Verifikasi email COBLAI Coder", text: verificationEmail("Bapak Samian", "https://coder.sam.university/verify-email?token=xyz789") });
check("B) surat terkirim setelah STARTTLS (sent true)", tlsResult.sent === true, tlsResult);
check("B) klien benar-benar mengirim perintah STARTTLS", tlsServer.recorded.commands.some((line) => line.toUpperCase() === "STARTTLS"), tlsServer.recorded.commands.slice(0, 6));
check("B) handshake TLS terjadi (tlsUsed)", tlsServer.recorded.tlsUsed === true);
check("B) EHLO diulang setelah TLS (>= 2 kali)", tlsServer.recorded.ehloCount >= 2, tlsServer.recorded.ehloCount);
check("B) MAIL FROM dikirim SETELAH TLS", tlsServer.recorded.tlsUsed === true && (tlsServer.recorded.mailFrom ?? "").includes("<noreply@example.test>"));
check("B) isi surat memuat tautan verifikasi 24 jam", (tlsServer.recorded.data ?? "").includes("verify-email?token=xyz789") && (tlsServer.recorded.data ?? "").includes("24 jam"));
check("B) AUTH LOGIN tetap dipakai di dalam sesi TLS", tlsServer.recorded.authUser === "noreply@example.test");
await tlsServer.close();

// --- C) kegagalan dilaporkan apa adanya ---
const badAuthServer = await startFakeServer({ advertiseStartTls: false, rejectAuth: true });
const badAuth = await sendMail({ to: "samianpacing@gmail.com", subject: "x", text: "y" });
check("C) kredensial ditolak -> sent false + EMAIL_SEND_FAILED", badAuth.sent === false && badAuth.reason === "EMAIL_SEND_FAILED", badAuth);
check("C) alasan kegagalan memuat balasan 535 dari server", (badAuth.detail ?? "").includes("535"), badAuth.detail);
await badAuthServer.close();

// Semua server tiruan sudah ditutup: port yang sama sekarang benar-benar kosong.
const refused = await sendMail({ to: "samianpacing@gmail.com", subject: "x", text: "y" });
check("C) koneksi ditolak -> sent false dengan detail ECONNREFUSED", refused.sent === false && (refused.detail ?? "").includes("ECONNREFUSED"), refused);

const silentServer = await startFakeServer({ advertiseStartTls: false, silent: true });
const startedAt = Date.now();
const silent = await sendMail({ to: "samianpacing@gmail.com", subject: "x", text: "y" });
const silentMs = Date.now() - startedAt;
check("C) server diam -> sent false (tidak menggantung selamanya)", silent.sent === false, silent);
check("C) server diam -> berhenti karena batas waktu internal (< 20 detik)", silentMs < 20_000, { silentMs });
await silentServer.close();

// --- D) SMTP_HOST kosong: jangan pernah memalsukan keberhasilan ---
const child = spawnUnconfiguredCheck();
check("D) proses dengan SMTP_HOST kosong berhenti normal (exit 0)", child.status === 0, { status: child.status, out: child.out.slice(-200) });
check("D) proses itu melaporkan EMAIL_NOT_CONFIGURED dan configured=false", child.out.includes('"reason":"EMAIL_NOT_CONFIGURED"') && child.out.includes('"configured":false'), child.out.slice(-300));

console.log(`RINGKASAN cek: lulus=${pass} gagal=${fail} total=${checkNumber}`);
console.log(fail === 0 ? "ALL_MAILER_TESTS_PASSED" : "MAILER_TESTS_FAILED");
process.exit(fail === 0 ? 0 : 1);

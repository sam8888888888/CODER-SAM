import net from "node:net";
import tls from "node:tls";
import { config } from "./config.js";

/**
 * Minimal SMTP client, written with node:net so the platform needs no extra dependency.
 * It supports plain connections, STARTTLS and AUTH LOGIN. Every failure is reported,
 * never hidden: when SMTP is not configured, callers get { sent: false, reason: "EMAIL_NOT_CONFIGURED" }.
 */
export type MailMessage = { to: string; subject: string; text: string; html?: string };
export type MailResult = { sent: boolean; reason?: string; detail?: string };

export function mailerConfigured(): boolean {
  return Boolean(config.SMTP_HOST);
}

function fromAddress(): string {
  const match = /<([^>]+)>/.exec(config.SMTP_FROM);
  return match ? match[1] : config.SMTP_FROM.trim();
}

function encodeMime(message: MailMessage): string {
  const headers = [
    `From: ${config.SMTP_FROM}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${message.text.replace(/\n/g, "\r\n")}`;
}

type SmtpSession = { socket: net.Socket | tls.TLSSocket; buffer: string; lines: string[]; multiline: string[]; waiters: ((line: string) => void)[]; capabilities: string[] };

function attach(session: SmtpSession, socket: net.Socket | tls.TLSSocket, timeoutMs: number) {
  session.socket = socket;
  session.buffer = "";
  session.multiline = [];
  // Batas waktu hanya menutup soket: destroy(Error) memicu peristiwa "error" tanpa penangan.
  socket.setTimeout(timeoutMs, () => socket.destroy());
  socket.on("data", (chunk) => {
    session.buffer += chunk.toString("utf8");
    let index = session.buffer.indexOf("\r\n");
    while (index !== -1) {
      const line = session.buffer.slice(0, index);
      session.buffer = session.buffer.slice(index + 2);
      // Multi line replies use "250-" on every line but the last, which uses "250 ".
      // Continuation lines must be kept: EHLO capability detection (STARTTLS, AUTH) reads them.
      if (/^\d{3}-/.test(line)) {
        session.multiline.push(line);
      } else {
        const reply = [...session.multiline, line].join("\n");
        session.multiline = [];
        const waiter = session.waiters.shift();
        if (waiter) waiter(reply);
        else session.lines.push(reply);
      }
      index = session.buffer.indexOf("\r\n");
    }
  });
}

function nextLine(session: SmtpSession, timeoutMs: number): Promise<string> {
  const queued = session.lines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMTP_NO_REPLY")), timeoutMs);
    session.waiters.push((line) => { clearTimeout(timer); resolve(line); });
  });
}

async function command(session: SmtpSession, text: string, timeoutMs: number, expect: number[] = [250]): Promise<string> {
  session.socket.write(`${text}\r\n`);
  const line = await nextLine(session, timeoutMs);
  const code = Number(line.slice(0, 3));
  if (!expect.includes(code)) throw new Error(`SMTP_COMMAND_FAILED ${text.split(" ")[0]} ${line.slice(0, 160)}`);
  return line;
}

/** Sends one plain text email through the configured SMTP server. */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  if (!mailerConfigured()) return { sent: false, reason: "EMAIL_NOT_CONFIGURED" };
  const timeoutMs = 15_000;
  let plain: net.Socket | null = null;
  try {
    plain = await new Promise<net.Socket>((resolve, reject) => {
      const socket = config.SMTP_SECURE
        ? tls.connect({ host: config.SMTP_HOST!, port: config.SMTP_PORT, servername: config.SMTP_HOST! })
        : net.connect({ host: config.SMTP_HOST!, port: config.SMTP_PORT });
      socket.setTimeout(timeoutMs, () => socket.destroy());
      socket.once("error", reject);
      socket.once(config.SMTP_SECURE ? "secureConnect" : "connect", () => resolve(socket));
    });
    plain.removeAllListeners("error");
    // Setelah tersambung, galat soket tidak boleh lagi melempar peristiwa "error" tanpa penangan
    // (itu mematikan proses API). Hasilnya tetap dilaporkan lewat batas waktu.
    plain.on("error", () => { /* ditangani lewat batas waktu / balasan perintah */ });
    const session: SmtpSession = { socket: plain, buffer: "", lines: [], multiline: [], waiters: [], capabilities: [] };
    attach(session, plain, timeoutMs);
    await nextLine(session, timeoutMs); // server greeting
    const ehlo = await command(session, `EHLO ${config.PUBLIC_BASE_URL.replace(/^https?:\/\//, "")}`, timeoutMs);
    session.capabilities = ehlo.split("\n").map((line) => line.slice(4).toUpperCase());
    if (!config.SMTP_SECURE && session.capabilities.some((cap) => cap.startsWith("STARTTLS"))) {
      await command(session, "STARTTLS", timeoutMs, [220]);
      const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket = tls.connect({ socket: session.socket as net.Socket, servername: config.SMTP_HOST! });
        socket.setTimeout(timeoutMs, () => socket.destroy());
        socket.once("error", reject);
        socket.once("secureConnect", () => resolve(socket));
      });
      secured.removeAllListeners("error");
      secured.on("error", () => { /* ditangani lewat batas waktu / balasan perintah */ });
      session.lines = [];
      session.buffer = "";
      attach(session, secured, timeoutMs);
      const ehlo2 = await command(session, `EHLO ${config.PUBLIC_BASE_URL.replace(/^https?:\/\//, "")}`, timeoutMs);
      session.capabilities = ehlo2.split("\n").map((line) => line.slice(4).toUpperCase());
    }
    if (config.SMTP_USER && config.SMTP_PASSWORD) {
      await command(session, "AUTH LOGIN", timeoutMs, [334]);
      await command(session, Buffer.from(config.SMTP_USER).toString("base64"), timeoutMs, [334]);
      await command(session, Buffer.from(config.SMTP_PASSWORD).toString("base64"), timeoutMs, [235]);
    }
    await command(session, `MAIL FROM:<${fromAddress()}>`, timeoutMs);
    await command(session, `RCPT TO:<${message.to}>`, timeoutMs, [250, 251]);
    await command(session, "DATA", timeoutMs, [354]);
    const body = encodeMime(message).replace(/\r\n\./g, "\r\n..");
    session.socket.write(`${body}\r\n.\r\n`);
    const done = await nextLine(session, timeoutMs);
    if (Number(done.slice(0, 3)) !== 250) throw new Error(`SMTP_SEND_FAILED ${done.slice(0, 160)}`);
    session.socket.write("QUIT\r\n");
    session.socket.end();
    return { sent: true };
  } catch (error) {
    try { plain?.destroy(); } catch { /* already closed */ }
    return { sent: false, reason: "EMAIL_SEND_FAILED", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Verification email body. */
export function verificationEmail(displayName: string, link: string): MailMessage["text"] {
  return `Halo ${displayName},\n\nTerima kasih sudah mendaftar di COBLAI Coder.\nKlik tautan ini untuk memverifikasi alamat email Anda (berlaku 24 jam):\n\n${link}\n\nBila Anda tidak merasa mendaftar, abaikan email ini.\n\nSalam,\nCOBLAI Coder`;
}

/** Password reset email body. */
export function passwordResetEmail(displayName: string, link: string): MailMessage["text"] {
  return `Halo ${displayName},\n\nAda permintaan atur ulang kata sandi untuk akun COBLAI Coder Anda.\nKlik tautan ini untuk membuat kata sandi baru (berlaku 60 menit):\n\n${link}\n\nSemua sesi lain akan dikeluarkan setelah kata sandi diganti.\nBila Anda tidak meminta ini, abaikan email ini; kata sandi Anda tidak berubah.\n\nSalam,\nCOBLAI Coder`;
}

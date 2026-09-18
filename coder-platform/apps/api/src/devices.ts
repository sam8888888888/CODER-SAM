import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { db } from "./db.js";
import { config } from "./config.js";
import { emailEnabled } from "./outbox.js";

/** Wave 10 (item 26 + 32b): the device an account signs in from.
 *
 *  A device is a hash of the browser's own id (when the client sends one), the user agent string and
 *  the preferred language. The hash is what we store, so the page can list "the same browser" without
 *  keeping a full fingerprint. Devices are what makes the referral programme harder to farm with many
 *  accounts on one machine, and they give the owner a way to end a session he does not recognise.
 */

export type DeviceRow = {
  id: string; userId: string; fingerprint: string; label: string; platform: string | null;
  userAgent: string | null; firstIp: string | null; lastIp: string | null;
  firstSeenAt: string; lastSeenAt: string; seenCount: number; trusted: number;
  verifiedAt: string | null; blockedAt: string | null; blockedReason: string | null;
};

const FIELDS = "id, user_id AS userId, fingerprint, label, platform, user_agent AS userAgent, first_ip AS firstIp, last_ip AS lastIp, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, seen_count AS seenCount, trusted, verified_at AS verifiedAt, blocked_at AS blockedAt, blocked_reason AS blockedReason";

const BROWSERS: Array<[string, string]> = [
  ["edg/", "Edge"], ["opr/", "Opera"], ["chrome/", "Chrome"], ["firefox/", "Firefox"],
  ["safari/", "Safari"], ["msie", "Internet Explorer"],
];

export function devicePlatform(userAgent: string): string {
  const ua = (userAgent || "").toLowerCase();
  if (!ua) return "Tidak dikenal";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) return "iOS";
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macOS";
  if (ua.includes("linux")) return "Linux";
  return "Tidak dikenal";
}

export function deviceBrowser(userAgent: string): string {
  const ua = (userAgent || "").toLowerCase();
  for (const [needle, name] of BROWSERS) if (ua.includes(needle)) return name;
  return "Peramban";
}

export function deviceLabel(userAgent: string, platform = devicePlatform(userAgent)): string {
  return `${deviceBrowser(userAgent)} di ${platform}`;
}

/** The stored identity of one device. Nothing here can be reversed into the original headers. */
export function deviceFingerprint(input: { userAgent?: string | null; deviceId?: string | null; language?: string | null }): string {
  const parts = [
    (input.userAgent ?? "").slice(0, 200),
    (input.deviceId ?? "").slice(0, 64),
    ((input.language ?? "").split(",")[0] ?? "").slice(0, 40),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" ? text : "";
}

/** Everything the caller needs about the browser that made this request. */
export function requestDeviceInfo(request: FastifyRequest): { fingerprint: string; label: string; platform: string; userAgent: string; ip: string | null; clientDeviceId: string | null } {
  const userAgent = header(request, "user-agent").slice(0, 200);
  const clientDeviceId = header(request, "x-device-id").slice(0, 64) || null;
  const platform = devicePlatform(userAgent);
  return {
    fingerprint: deviceFingerprint({ userAgent, deviceId: clientDeviceId, language: header(request, "accept-language") }),
    label: deviceLabel(userAgent, platform),
    platform,
    userAgent,
    ip: typeof request.ip === "string" ? request.ip : null,
    clientDeviceId,
  };
}

/** Records the sign-in. `isNew` tells the caller that this account has never used this browser. */
export function registerDevice(input: { userId: string; fingerprint: string; userAgent?: string | null; ip?: string | null }): { device: DeviceRow; isNew: boolean } {
  const now = new Date().toISOString();
  const userAgent = (input.userAgent ?? "").slice(0, 200);
  const existing = db.prepare(`SELECT ${FIELDS} FROM user_devices WHERE user_id=? AND fingerprint=?`).get(input.userId, input.fingerprint) as DeviceRow | undefined;
  if (existing) {
    db.prepare("UPDATE user_devices SET last_seen_at=?, last_ip=?, seen_count=seen_count+1 WHERE id=?")
      .run(now, input.ip ?? existing.lastIp ?? null, existing.id);
    const fresh = db.prepare(`SELECT ${FIELDS} FROM user_devices WHERE id=?`).get(existing.id) as DeviceRow;
    return { device: fresh, isNew: false };
  }
  // Ceiling: the oldest unused browser is dropped first, so the list stays useful instead of full.
  if (deviceCount(input.userId) >= config.DEVICE_MAX_PER_USER) {
    db.prepare(`DELETE FROM user_devices WHERE id IN (SELECT id FROM user_devices WHERE user_id=?
      ORDER BY last_seen_at ASC LIMIT 1)`).run(input.userId);
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO user_devices (id,user_id,fingerprint,label,platform,user_agent,first_ip,last_ip,first_seen_at,last_seen_at,seen_count,trusted,verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,0,?)`)
    .run(id, input.userId, input.fingerprint, deviceLabel(userAgent), devicePlatform(userAgent), userAgent, input.ip ?? null, input.ip ?? null, now, now, null);
  return { device: db.prepare(`SELECT ${FIELDS} FROM user_devices WHERE id=?`).get(id) as DeviceRow, isNew: true };
}

/** The stored row for one sign-in, or null when the browser is new/unknown. */
export function deviceFor(userId: string, fingerprint: string): DeviceRow | null {
  return (db.prepare(`SELECT ${FIELDS} FROM user_devices WHERE user_id=? AND fingerprint=?`).get(userId, fingerprint) as DeviceRow | undefined) ?? null;
}

export function getDevice(userId: string, deviceId: string): DeviceRow | null {
  return (db.prepare(`SELECT ${FIELDS} FROM user_devices WHERE user_id=? AND id=?`).get(userId, deviceId) as DeviceRow | undefined) ?? null;
}

export function listDevices(userId: string, currentDeviceId?: string | null): Array<DeviceRow & { sessions: number; current: boolean }> {
  const rows = db.prepare(`SELECT ${FIELDS} FROM user_devices WHERE user_id=? ORDER BY last_seen_at DESC`).all(userId) as DeviceRow[];
  const counts = db.prepare("SELECT device_id AS deviceId, COUNT(*) AS n FROM auth_sessions WHERE user_id=? AND expires_at>? GROUP BY device_id")
    .all(userId, new Date().toISOString()) as Array<{ deviceId: string | null; n: number }>;
  const byDevice = new Map(counts.map((row) => [row.deviceId ?? "", Number(row.n)]));
  return rows.map((row) => ({ ...row, sessions: byDevice.get(row.id) ?? 0, current: Boolean(currentDeviceId && row.id === currentDeviceId) }));
}

export function deviceCount(userId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM user_devices WHERE user_id=?").get(userId) as { n: number }).n);
}

/** Panjang nama perangkat yang diterima. Rute menolak yang lebih panjang, fungsi ini hanya pagar akhir. */
export const DEVICE_LABEL_MAX = 60;

export function renameDevice(userId: string, deviceId: string, label: string): DeviceRow | null {
  const clean = String(label ?? "").trim().slice(0, DEVICE_LABEL_MAX);
  if (!clean) return null;
  const result = db.prepare("UPDATE user_devices SET label=? WHERE id=? AND user_id=?").run(clean, deviceId, userId);
  return result.changes ? getDevice(userId, deviceId) : null;
}

export function setDeviceTrust(userId: string, deviceId: string, trusted: boolean): DeviceRow | null {
  const result = db.prepare("UPDATE user_devices SET trusted=? WHERE id=? AND user_id=?").run(trusted ? 1 : 0, deviceId, userId);
  return result.changes ? getDevice(userId, deviceId) : null;
}

/** Marking a device verified is what the emailed link does (item 26, optional gate). */
export function markDeviceVerified(userId: string, deviceId: string): DeviceRow | null {
  const result = db.prepare("UPDATE user_devices SET verified_at=? WHERE id=? AND user_id=?").run(new Date().toISOString(), deviceId, userId);
  return result.changes ? getDevice(userId, deviceId) : null;
}

export function blockDevice(userId: string, deviceId: string, reason: string): DeviceRow | null {
  const result = db.prepare("UPDATE user_devices SET blocked_at=?, blocked_reason=? WHERE id=? AND user_id=?").run(new Date().toISOString(), reason.slice(0, 120), deviceId, userId);
  return result.changes ? getDevice(userId, deviceId) : null;
}

/** Ending a device ends every session that came from it, which is the point of the action. */
export function revokeDevice(userId: string, deviceId: string): { sessionsRemoved: number } | null {
  const device = getDevice(userId, deviceId);
  if (!device) return null;
  let removed = 0;
  db.transaction(() => {
    const result = db.prepare("DELETE FROM auth_sessions WHERE user_id=? AND device_id=?").run(userId, deviceId);
    removed = Number(result.changes ?? 0);
  })();
  return { sessionsRemoved: removed };
}

export function deleteDevice(userId: string, deviceId: string): boolean {
  return db.prepare("DELETE FROM user_devices WHERE id=? AND user_id=?").run(deviceId, userId).changes > 0;
}

/** Every device hash of one account; used by the referral device check. */
export function fingerprintsOf(userId: string): string[] {
  const rows = db.prepare("SELECT fingerprint FROM user_devices WHERE user_id=?").all(userId) as Array<{ fingerprint: string }>;
  return rows.map((row) => row.fingerprint);
}

/** True when two accounts signed in from at least one common device. */
export function shareDevice(userA: string, userB: string): boolean {
  if (!userA || !userB) return false;
  const row = db.prepare(`SELECT 1 AS hit FROM user_devices a JOIN user_devices b ON a.fingerprint=b.fingerprint
    WHERE a.user_id=? AND b.user_id=? LIMIT 1`).get(userA, userB) as { hit: number } | undefined;
  return Boolean(row);
}

export function devicesMatching(fingerprint: string): string[] {
  const rows = db.prepare("SELECT DISTINCT user_id AS userId FROM user_devices WHERE fingerprint=?").all(fingerprint) as Array<{ userId: string }>;
  return rows.map((row) => row.userId);
}

/** The gate of item 26. `auto` follows the mail server, exactly like the email gate of Wave 8. */
export function deviceVerifyRequired(): boolean {
  if (!config.DEVICE_TRACKING) return false;
  if (config.DEVICE_VERIFY_NEW === "on") return true;
  if (config.DEVICE_VERIFY_NEW === "off") return false;
  return emailEnabled();
}

export type DeviceGate = { required: boolean; allowed: boolean; error?: string; message?: string };

/** Called before AI work: a new device must be verified when the owner asked for that gate. */
export function checkDeviceGate(userId: string, deviceId: string | null): DeviceGate {
  if (!deviceVerifyRequired()) return { required: false, allowed: true };
  if (!deviceId) return { required: true, allowed: false, error: "DEVICE_NOT_VERIFIED", message: "Sesi ini belum dikenali sebagai perangkat Anda. Buka tautan verifikasi yang dikirim ke email, lalu coba lagi." };
  const device = getDevice(userId, deviceId);
  if (!device) return { required: true, allowed: false, error: "DEVICE_NOT_VERIFIED", message: "Perangkat ini belum terdaftar. Buka tautan verifikasi yang dikirim ke email, lalu coba lagi." };
  if (device.verifiedAt || device.trusted) return { required: true, allowed: true };
  return { required: true, allowed: false, error: "DEVICE_NOT_VERIFIED", message: "Perangkat ini belum diverifikasi. Buka tautan verifikasi yang dikirim ke email, lalu coba lagi." };
}

export function deviceSummary(): { devices: number; users: number; newLast24h: number; trusted: number; blocked: number } {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const one = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  return {
    devices: one("SELECT COUNT(*) AS n FROM user_devices"),
    users: one("SELECT COUNT(DISTINCT user_id) AS n FROM user_devices"),
    newLast24h: one("SELECT COUNT(*) AS n FROM user_devices WHERE first_seen_at >= ?", since),
    trusted: one("SELECT COUNT(*) AS n FROM user_devices WHERE trusted=1"),
    blocked: one("SELECT COUNT(*) AS n FROM user_devices WHERE blocked_at IS NOT NULL"),
  };
}

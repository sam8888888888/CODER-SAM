import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { db } from "./db.js";
import { config } from "./config.js";
import { getJsonSetting, setJsonSetting } from "./billing.js";

/** Wave 10 (item 31): browser push, next to the in-app bell and email.
 *
 *  The VAPID key pair is generated once and kept in `platform_settings`, so no secret has to be copied
 *  into an environment file. Every send is best effort: a browser that answers 404 or 410 has dropped
 *  its subscription and is switched off instead of being retried forever.
 */

export type PushSubscriptionRow = {
  id: string; userId: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null;
  createdAt: string; lastSeenAt: string; lastSuccessAt: string | null; lastError: string | null;
  failures: number; active: number;
};

type VapidRecord = { publicKey: string; privateKey: string; subject: string; createdAt: string };

const VAPID_KEY = "web_push";

const SUB_FIELDS = "id, user_id AS userId, endpoint, p256dh, auth, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt, last_success_at AS lastSuccessAt, last_error AS lastError, failures, active";

/** Reads the key pair, creating it on first use. Returns null when push is switched off. */
export function vapidKeys(): VapidRecord | null {
  if (!config.PUSH_ENABLED) return null;
  const stored = getJsonSetting<VapidRecord | null>(VAPID_KEY, null);
  if (stored?.publicKey && stored?.privateKey) {
    if (stored.subject !== config.PUSH_SUBJECT) {
      const updated = { ...stored, subject: config.PUSH_SUBJECT };
      setJsonSetting(VAPID_KEY, updated);
      return updated;
    }
    return stored;
  }
  const generated = webpush.generateVAPIDKeys();
  const record: VapidRecord = { publicKey: generated.publicKey, privateKey: generated.privateKey, subject: config.PUSH_SUBJECT, createdAt: new Date().toISOString() };
  setJsonSetting(VAPID_KEY, record);
  return record;
}

/** What the browser needs before it can ask for permission. The private key never leaves here. */
export function publicPushKey(): { enabled: boolean; publicKey: string | null; subject: string } {
  const keys = vapidKeys();
  return { enabled: Boolean(keys), publicKey: keys?.publicKey ?? null, subject: config.PUSH_SUBJECT };
}

function configure(): VapidRecord | null {
  const keys = vapidKeys();
  if (!keys) return null;
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  return keys;
}

export function pushConfigured(): boolean {
  return Boolean(vapidKeys());
}

/** Reads the saved key pair WITHOUT looking at the switch. An operator needs to know whether the
 *  keys are already in place even when the channel is switched off, so the numbers stay honest. */
function storedVapidKeys(): VapidRecord | null {
  const stored = getJsonSetting<VapidRecord | null>(VAPID_KEY, null);
  return stored?.publicKey && stored.privateKey ? stored : null;
}

export function listSubscriptions(userId: string, onlyActive = true): PushSubscriptionRow[] {
  const where = onlyActive ? "AND active=1" : "";
  return db.prepare(`SELECT ${SUB_FIELDS} FROM push_subscriptions WHERE user_id=? ${where} ORDER BY created_at DESC`).all(userId) as PushSubscriptionRow[];
}

export function countSubscriptions(userId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=? AND active=1").get(userId) as { n: number }).n);
}

/** One browser may subscribe again and again; the endpoint is the identity, so it is upserted. */
export function saveSubscription(input: { userId: string; endpoint: string; p256dh: string; auth: string; userAgent?: string | null }): PushSubscriptionRow {
  const now = new Date().toISOString();
  const endpoint = String(input.endpoint ?? "").trim().slice(0, 1000);
  const p256dh = String(input.p256dh ?? "").trim().slice(0, 200);
  const auth = String(input.auth ?? "").trim().slice(0, 100);
  if (!endpoint || !p256dh || !auth) throw new Error("SUBSCRIPTION_INCOMPLETE");
  const existing = db.prepare("SELECT id FROM push_subscriptions WHERE endpoint=?").get(endpoint) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE push_subscriptions SET user_id=?, p256dh=?, auth=?, user_agent=?, last_seen_at=?, active=1, failures=0, last_error=NULL WHERE id=?")
      .run(input.userId, p256dh, auth, (input.userAgent ?? "").slice(0, 200), now, existing.id);
    return db.prepare(`SELECT ${SUB_FIELDS} FROM push_subscriptions WHERE id=?`).get(existing.id) as PushSubscriptionRow;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created_at,last_seen_at,active)
    VALUES (?,?,?,?,?,?,?,?,1)`).run(id, input.userId, endpoint, p256dh, auth, (input.userAgent ?? "").slice(0, 200), now, now);
  return db.prepare(`SELECT ${SUB_FIELDS} FROM push_subscriptions WHERE id=?`).get(id) as PushSubscriptionRow;
}

export function removeSubscription(userId: string, id: string): boolean {
  return db.prepare("DELETE FROM push_subscriptions WHERE id=? AND user_id=?").run(id, userId).changes > 0;
}

export function removeByEndpoint(endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint);
}

function deactivate(id: string, reason: string): void {
  db.prepare("UPDATE push_subscriptions SET active=0, failures=failures+1, last_error=? WHERE id=?").run(reason.slice(0, 200), id);
}

function noteFailure(id: string, reason: string): void {
  db.prepare("UPDATE push_subscriptions SET failures=failures+1, last_error=?, last_seen_at=? WHERE id=?").run(reason.slice(0, 200), new Date().toISOString(), id);
}

export type PushReport = { configured: boolean; subscriptions: number; sent: number; failed: number; disabled: number; skipped?: string };

/** Sends one notification to every browser the user registered. Never throws at the caller. */
export async function sendPushToUser(userId: string, payload: { title: string; body?: string; link?: string; kind?: string }): Promise<PushReport> {
  const keys = configure();
  if (!keys) return { configured: false, subscriptions: 0, sent: 0, failed: 0, disabled: 0, skipped: "PUSH_DISABLED" };
  const rows = listSubscriptions(userId);
  if (!rows.length) return { configured: true, subscriptions: 0, sent: 0, failed: 0, disabled: 0, skipped: "NO_SUBSCRIPTION" };
  const body = JSON.stringify({ title: payload.title, body: payload.body ?? "", link: payload.link ?? "/", kind: payload.kind ?? "info", at: new Date().toISOString() });
  let sent = 0, failed = 0, disabled = 0;
  for (const row of rows) {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, { TTL: 12 * 60 * 60 });
      sent += 1;
      db.prepare("UPDATE push_subscriptions SET last_success_at=?, last_seen_at=?, failures=0, last_error=NULL WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), row.id);
    } catch (error) {
      failed += 1;
      const status = Number((error as { statusCode?: number }).statusCode ?? 0);
      const message = error instanceof Error ? error.message : String(error);
      if (status === 404 || status === 410) { deactivate(row.id, message); disabled += 1; }
      else noteFailure(row.id, message);
    }
  }
  return { configured: true, subscriptions: rows.length, sent, failed, disabled };
}

/** With a userId the numbers describe one account; without one they describe the whole platform. */
export function pushStats(userId?: string): { configured: boolean; enabled: boolean; subscriptions: number; activeSubscriptions: number; users: number; deliverable: number; failed: number; deliveredLast24h: number } {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const scope = userId ? " AND user_id = ?" : "";
  const args = userId ? [userId] : [];
  const one = (sql: string, ...extra: unknown[]) => Number((db.prepare(sql).get(...args, ...extra) as { n: number }).n);
  return {
    // `configured` = kunci VAPID siap; `enabled` = kanal dihidupkan admin. Dua fakta yang berbeda,
    // jadi keduanya dilaporkan terpisah dan tidak ada yang menyesatkan.
    configured: Boolean(storedVapidKeys()),
    enabled: config.PUSH_ENABLED,
    subscriptions: one(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE 1=1${scope}`),
    activeSubscriptions: one(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE active=1${scope}`),
    users: one(`SELECT COUNT(DISTINCT user_id) AS n FROM push_subscriptions WHERE active=1${scope}`),
    deliverable: one(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE active=1${scope}`),
    failed: one(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE active=1 AND failures > 0${scope}`),
    deliveredLast24h: one(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE active=1 AND last_success_at >= ?${scope}`, since),
  };
}

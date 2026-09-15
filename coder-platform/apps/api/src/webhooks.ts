import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { enqueueJob } from "./jobs.js";

/** Wave 6: outgoing webhooks.
 *  The platform tells an outside system what happened (a run finished or failed) by POSTing a signed
 *  JSON body to a URL the workspace owner registered. Delivery goes through the durable job queue from
 *  Wave 5, so a restart does not lose an event: the row stays `queued` and the next process delivers it.
 *
 *  Two limits are stated honestly here instead of being hidden:
 *   - the URL check refuses obvious internal targets, but the host name is NOT resolved, so a public
 *     name that points at a private address is not blocked;
 *   - a delivery is retried up to WEBHOOK_MAX_ATTEMPTS times; after that the row stays `failed`. */

export const WEBHOOK_EVENTS = ["run.completed", "run.failed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookRow = {
  id: string; workspaceId: string; userId: string; url: string;
  events: WebhookEvent[]; active: boolean; description: string | null;
  createdAt: string; updatedAt: string; lastDeliveryAt: string | null; lastStatus: string | null; failureCount: number;
};

export type WebhookDeliveryRow = {
  id: string; webhookId: string; event: string; payload: unknown; status: string; attempts: number;
  responseStatus: number | null; lastError: string | null; durationMs: number | null; jobId: string | null;
  createdAt: string; updatedAt: string; deliveredAt: string | null;
};

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return WEBHOOK_EVENTS.includes(String(value) as WebhookEvent);
}

/** Only known events are stored. An empty list means "run.completed", the most common choice. */
export function parseEvents(input: unknown): WebhookEvent[] {
  const values = Array.isArray(input) ? input.map(String) : String(input ?? "").split(",");
  const clean = values.map((value) => value.trim()).filter((value) => isWebhookEvent(value)) as WebhookEvent[];
  const unique = Array.from(new Set(clean));
  return unique.length ? unique : ["run.completed"];
}

const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "metadata.goog"]);

/** Refuses a URL that cannot safely receive a request. Returns a machine code plus a readable reason. */
export function validateWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string; message: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "WEBHOOK_URL_REQUIRED", message: "Alamat webhook wajib diisi." };
  if (text.length > 500) return { ok: false, error: "WEBHOOK_URL_TOO_LONG", message: "Alamat webhook maksimal 500 karakter." };
  let parsed: URL;
  try { parsed = new URL(text); } catch { return { ok: false, error: "WEBHOOK_URL_INVALID", message: "Alamat webhook bukan URL yang sah. Contoh: https://contoh.com/hook." }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "WEBHOOK_URL_INVALID", message: "Alamat webhook harus memakai http atau https." };
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return { ok: false, error: "WEBHOOK_URL_BLOCKED", message: "Alamat itu menunjuk ke layanan metadata dan selalu ditolak." };
  const localNames = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
  const looksLocal = localNames.has(host) || host.endsWith(".local") || host.endsWith(".internal");
  if (looksLocal && !config.WEBHOOK_ALLOW_LOCAL) {
    return { ok: false, error: "WEBHOOK_URL_BLOCKED", message: "Alamat lokal ditolak. Pasang WEBHOOK_ALLOW_LOCAL=true hanya untuk uji atau pemasangan lokal." };
  }
  return { ok: true, url: parsed.toString() };
}

function toHookRow(value: any): WebhookRow {
  return {
    id: String(value.id), workspaceId: String(value.workspaceId), userId: String(value.userId), url: String(value.url),
    events: parseEvents(value.events), active: Number(value.active) === 1, description: value.description ?? null,
    createdAt: String(value.createdAt), updatedAt: String(value.updatedAt),
    lastDeliveryAt: value.lastDeliveryAt ?? null, lastStatus: value.lastStatus ?? null, failureCount: Number(value.failureCount ?? 0),
  };
}

function toDeliveryRow(value: any): WebhookDeliveryRow | null {
  if (!value) return null;
  let payload: unknown = null;
  try { payload = JSON.parse(String(value.payload ?? "{}")); } catch { payload = null; }
  return {
    id: String(value.id), webhookId: String(value.webhookId), event: String(value.event), payload,
    status: String(value.status), attempts: Number(value.attempts ?? 0),
    responseStatus: value.responseStatus === null || value.responseStatus === undefined ? null : Number(value.responseStatus),
    lastError: value.lastError ?? null, durationMs: value.durationMs === null || value.durationMs === undefined ? null : Number(value.durationMs),
    jobId: value.jobId ?? null, createdAt: String(value.createdAt), updatedAt: String(value.updatedAt), deliveredAt: value.deliveredAt ?? null,
  };
}

const HOOK_COLUMNS = `id, workspace_id AS workspaceId, user_id AS userId, url, events, active, description,
  created_at AS createdAt, updated_at AS updatedAt, last_delivery_at AS lastDeliveryAt, last_status AS lastStatus, failure_count AS failureCount`;
const DELIVERY_COLUMNS = `id, webhook_id AS webhookId, event, payload, status, attempts, response_status AS responseStatus,
  last_error AS lastError, duration_ms AS durationMs, job_id AS jobId, created_at AS createdAt, updated_at AS updatedAt, delivered_at AS deliveredAt`;

export function countWebhooks(workspaceId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM webhooks WHERE workspace_id=?").get(workspaceId) as { total: number };
  return row.total;
}

export function createWebhook(input: { workspaceId: string; userId: string; url: string; events: WebhookEvent[]; description?: string | null }): { webhook: WebhookRow; secret: string } {
  const id = randomUUID();
  const secret = "whsec_" + randomBytes(24).toString("hex");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO webhooks (id,workspace_id,user_id,url,secret,events,active,description,created_at,updated_at,failure_count) VALUES (?,?,?,?,?,?,1,?,?,?,0)")
    .run(id, input.workspaceId, input.userId, input.url, secret, input.events.join(","), input.description ?? null, now, now);
  return { webhook: getWebhookRow(id) as WebhookRow, secret };
}

function getWebhookRow(id: string): WebhookRow | null {
  const row = db.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE id=?`).get(id);
  return row ? toHookRow(row) : null;
}

/** Public shape: the signing secret NEVER leaves the server after creation. */
export function listWebhooks(workspaceId: string): WebhookRow[] {
  const rows = db.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE workspace_id=? ORDER BY created_at DESC`).all(workspaceId) as any[];
  return rows.map(toHookRow);
}

export function getWebhook(workspaceId: string, id: string): WebhookRow | null {
  const row = db.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE id=? AND workspace_id=?`).get(id, workspaceId);
  return row ? toHookRow(row) : null;
}

/** Internal use only: delivery needs the secret, so it never reaches a route response. */
function webhookWithSecret(id: string): (WebhookRow & { secret: string }) | null {
  const row = db.prepare(`SELECT ${HOOK_COLUMNS}, secret FROM webhooks WHERE id=?`).get(id) as any;
  return row ? { ...toHookRow(row), secret: String(row.secret) } : null;
}

export function updateWebhook(workspaceId: string, id: string, patch: { url?: unknown; events?: unknown; active?: unknown; description?: unknown }): WebhookRow | null {
  const current = getWebhook(workspaceId, id);
  if (!current) return null;
  const url = patch.url === undefined ? current.url : String(patch.url).trim();
  const events = patch.events === undefined ? current.events : parseEvents(patch.events);
  const active = patch.active === undefined ? (current.active ? 1 : 0) : (patch.active ? 1 : 0);
  const description = patch.description === undefined ? current.description : (patch.description === null ? null : String(patch.description).slice(0, 300));
  db.prepare("UPDATE webhooks SET url=?, events=?, active=?, description=?, updated_at=? WHERE id=? AND workspace_id=?")
    .run(url, events.join(","), active, description, new Date().toISOString(), id, workspaceId);
  return getWebhook(workspaceId, id);
}

export function deleteWebhook(workspaceId: string, id: string): boolean {
  const result = db.prepare("DELETE FROM webhooks WHERE id=? AND workspace_id=?").run(id, workspaceId);
  return result.changes > 0;
}

export function listDeliveries(webhookId: string, limit = 50): WebhookDeliveryRow[] {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT ?`).all(webhookId, size) as any[];
  return rows.map((row) => toDeliveryRow(row) as WebhookDeliveryRow);
}

export function getDelivery(id: string): WebhookDeliveryRow | null {
  return toDeliveryRow(db.prepare(`SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id=?`).get(id));
}

/** Active hooks of one workspace that asked for this event. */
export function hooksFor(workspaceId: string, event: WebhookEvent): (WebhookRow & { secret: string })[] {
  const rows = db.prepare(`SELECT ${HOOK_COLUMNS}, secret FROM webhooks WHERE workspace_id=? AND active=1`).all(workspaceId) as any[];
  return rows.map((row) => ({ ...toHookRow(row), secret: String(row.secret) })).filter((hook) => hook.events.includes(event));
}

/** The body that is signed and sent. Kept in one place so the signature always matches the payload. */
function deliveryBody(delivery: WebhookDeliveryRow): string {
  return JSON.stringify({ id: delivery.id, event: delivery.event, createdAt: delivery.createdAt, data: delivery.payload ?? {} });
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Stores one delivery row. `jobId` is empty when the caller sends the request straight away. */
export function createDeliveryRow(input: { webhookId: string; event: string; payload: unknown; jobId?: string | null; id?: string }): WebhookDeliveryRow {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO webhook_deliveries (id,webhook_id,event,payload,status,attempts,job_id,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?)")
    .run(id, input.webhookId, input.event, JSON.stringify(input.payload ?? {}), "queued", input.jobId ?? null, now, now);
  return getDelivery(id) as WebhookDeliveryRow;
}

/** Queues one delivery. The dedupe key is the delivery id, so a retry never creates a second event. */
export function createDelivery(input: { webhookId: string; event: WebhookEvent; payload: unknown }): { delivery: WebhookDeliveryRow; jobId: string } {
  const id = randomUUID();
  // Baris dibuat SEBELUM pekerjaan diantre: pekerja latar bisa mengambil pekerjaan lebih cepat daripada
  // pembuatan baris, dan penangan yang tidak menemukan barisnya akan melapor gagal tanpa alasan.
  const delivery = createDeliveryRow({ id, webhookId: input.webhookId, event: input.event, payload: input.payload });
  const job = enqueueJob({ kind: "webhook.deliver", payload: { deliveryId: id }, maxAttempts: config.WEBHOOK_MAX_ATTEMPTS, dedupeKey: `webhook.deliver:${id}` });
  if (job.id) db.prepare("UPDATE webhook_deliveries SET job_id=?, updated_at=? WHERE id=?").run(job.id, new Date().toISOString(), id);
  return { delivery, jobId: job.id ?? "" };
}

/**
 * Tells every hook in a workspace about an event. It never throws: a broken webhook must not fail a run.
 * The deliveries are queued immediately, so the caller is not slowed down by a slow receiver.
 */
export function emitWebhookEvent(input: { workspaceId: string; projectId?: string | null; event: WebhookEvent; payload: Record<string, unknown> }): { enqueued: number; deliveries: string[] } {
  try {
    const hooks = hooksFor(input.workspaceId, input.event);
    const ids: string[] = [];
    for (const hook of hooks) {
      const created = createDelivery({ webhookId: hook.id, event: input.event, payload: { ...input.payload, projectId: input.projectId ?? null } });
      ids.push(created.delivery.id);
    }
    return { enqueued: ids.length, deliveries: ids };
  } catch {
    // A missing table or a full disk must not break the run that triggered the event.
    return { enqueued: 0, deliveries: [] };
  }
}

/** Convenience wrapper used by the run paths: resolves the workspace from the project first. */
export function emitProjectEvent(projectId: string, event: WebhookEvent, payload: Record<string, unknown>): { enqueued: number } {
  const row = db.prepare("SELECT workspace_id AS workspaceId FROM projects WHERE id=?").get(projectId) as { workspaceId: string } | undefined;
  if (!row) return { enqueued: 0 };
  return { enqueued: emitWebhookEvent({ workspaceId: row.workspaceId, projectId, event, payload }).enqueued };
}

export type DeliveryReport = { status: string; responseStatus: number | null; error: string | null; durationMs: number };

/**
 * One delivery attempt. The queue handler calls this, and the "test" route calls it once, so the same
 * signing and recording code is used in both places.
 */
export async function deliverWebhook(deliveryId: string): Promise<DeliveryReport> {
  const delivery = getDelivery(deliveryId);
  if (!delivery) throw new Error("WEBHOOK_DELIVERY_NOT_FOUND");
  const hook = webhookWithSecret(delivery.webhookId);
  const now = new Date().toISOString();
  const attempts = delivery.attempts + 1;
  if (!hook) {
    db.prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, last_error=?, updated_at=? WHERE id=?").run(attempts, "Webhook sudah dihapus.", now, deliveryId);
    return { status: "failed", responseStatus: null, error: "Webhook sudah dihapus.", durationMs: 0 };
  }
  if (!hook.active) {
    db.prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, last_error=?, updated_at=? WHERE id=?").run(attempts, "Webhook sedang dimatikan.", now, deliveryId);
    return { status: "failed", responseStatus: null, error: "Webhook sedang dimatikan.", durationMs: 0 };
  }

  const body = deliveryBody(delivery);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const started = Date.now();
  let status = 0;
  let error: string | null = null;
  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "COBLAI-Coder-Webhook/1",
        "x-coblai-event": delivery.event,
        "x-coblai-delivery": delivery.id,
        "x-coblai-timestamp": timestamp,
        "x-coblai-signature": signPayload(hook.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(config.WEBHOOK_DELIVERY_TIMEOUT_MS),
    });
    status = response.status;
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) error = `Penerima menjawab ${response.status}.`;
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 300) : "Pengiriman gagal.";
  }
  const durationMs = Date.now() - started;
  const finishedAt = new Date().toISOString();
  if (!error && status >= 200 && status < 300) {
    db.prepare("UPDATE webhook_deliveries SET status='delivered', attempts=?, response_status=?, last_error=NULL, duration_ms=?, updated_at=?, delivered_at=? WHERE id=?")
      .run(attempts, status, durationMs, finishedAt, finishedAt, deliveryId);
    db.prepare("UPDATE webhooks SET last_delivery_at=?, last_status=?, failure_count=0, updated_at=? WHERE id=?").run(finishedAt, `delivered:${status}`, finishedAt, hook.id);
    return { status: "delivered", responseStatus: status, error: null, durationMs };
  }
  db.prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, response_status=?, last_error=?, duration_ms=?, updated_at=? WHERE id=?")
    .run(attempts, status || null, error, durationMs, finishedAt, deliveryId);
  db.prepare("UPDATE webhooks SET last_delivery_at=?, last_status=?, failure_count=failure_count+1, updated_at=? WHERE id=?").run(finishedAt, `failed:${status || "no-response"}`, finishedAt, hook.id);
  // Throwing makes the job queue retry with its own backoff; the row keeps the last error for the operator.
  throw new Error(error ?? "Pengiriman webhook gagal.");
}

export function webhookStats(workspaceId?: string): { hooks: number; active: number; deliveries: number; queued: number; delivered: number; failed: number; lastDeliveryAt: string | null } {
  const filter = workspaceId ? " WHERE workspace_id=?" : "";
  const args = workspaceId ? [workspaceId] : [];
  const hooks = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(active),0) AS active FROM webhooks${filter}`).get(...args) as { total: number; active: number };
  const delivered = db.prepare(`SELECT COUNT(*) AS total FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.status='delivered'${workspaceId ? " AND w.workspace_id=?" : ""}`).get(...args) as { total: number };
  const failed = db.prepare(`SELECT COUNT(*) AS total FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.status='failed'${workspaceId ? " AND w.workspace_id=?" : ""}`).get(...args) as { total: number };
  const queued = db.prepare(`SELECT COUNT(*) AS total FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.status='queued'${workspaceId ? " AND w.workspace_id=?" : ""}`).get(...args) as { total: number };
  const last = db.prepare(`SELECT MAX(d.created_at) AS at FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id${filter}`).get(...args) as { at: string | null };
  return { hooks: Number(hooks.total), active: Number(hooks.active), deliveries: Number(queued.total) + Number(delivered.total) + Number(failed.total), queued: Number(queued.total), delivered: Number(delivered.total), failed: Number(failed.total), lastDeliveryAt: last.at ?? null };
}

/** Documents the event names so the UI and the docs never drift apart. */
export function webhookCatalogue(): { event: WebhookEvent; description: string }[] {
  return [
    { event: "run.completed", description: "Run mesin AI selesai dan jawabannya tersimpan." },
    { event: "run.failed", description: "Run mesin AI gagal; isi pesan galat ikut dikirim." },
  ];
}

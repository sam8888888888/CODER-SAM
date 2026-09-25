/**
 * Wave 11A (butir 46): Safety Constraint + Guardrails.
 *
 * Dua jenis aturan per akun:
 *  - `kualitas`  : diarahkan ke mesin lewat `appendSystem[]` (maks 10 aturan terbaru dipakai).
 *  - `larangan`  : isi `body` adalah daftar pola (dipisah koma atau baris baru). Bila pesan pengguna
 *                  memuat salah satu pola, aksinya TIDAK dijalankan dan pelanggaran dicatat.
 *
 * Aturan hanya milik pembuatnya; tidak ada jalan pintas lewat API publik atau akun lain.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { audit, fail } from "./shared.js";

export const GUARDRAIL_KINDS = ["kualitas", "larangan"] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

/** Batas aturan aktif yang disuntik ke prompt; sisanya tetap tersimpan tapi tidak dikirim. */
export const GUARDRAIL_INJECT_LIMIT = 10;
/** Batas jumlah aturan per akun supaya halaman tetap terkelola. */
export const GUARDRAIL_MAX_RULES = 20;

export type GuardrailRule = {
  id: string; userId: string; kind: GuardrailKind; title: string; body: string;
  enabled: number; sortOrder: number; createdAt: string; updatedAt: string;
};

const SELECT_RULE = "SELECT id, user_id AS userId, kind, title, body, enabled, sort_order AS sortOrder, created_at AS createdAt, updated_at AS updatedAt FROM guardrail_rules";

/** Aturan aktif yang boleh dikirim ke mesin: 10 terbaru menurut urutan lalu pembaruan. */
export function activeGuardrailRules(userId: string, limit = GUARDRAIL_INJECT_LIMIT): GuardrailRule[] {
  return db.prepare(`${SELECT_RULE} WHERE user_id=? AND enabled=1 ORDER BY sort_order ASC, updated_at DESC LIMIT ?`).all(userId, limit) as GuardrailRule[];
}

/** Blok teks untuk `appendSystem[]`, atau null bila tidak ada aturan aktif. */
export function guardrailBlockFor(userId: string): string | null {
  const rules = activeGuardrailRules(userId);
  if (!rules.length) return null;
  const lines = rules.map((rule) => `- ${rule.title}: ${String(rule.body).replace(/\s+/g, " ").slice(0, 600)}`);
  return `Aturan pemakaian dari akun ini (WAJIB dipatuhi, jangan dilanggar):\n${lines.join("\n")}`;
}

/** Pola larangan dari isi satu aturan (koma atau baris baru sebagai pemisah). */
export function prohibitionPatterns(body: string): string[] {
  return String(body ?? "").split(/[\n,;]+/).map((item) => item.trim().toLowerCase()).filter((item) => item.length >= 3);
}

/** Aturan `larangan` yang dilanggar oleh sebuah teks (pencocokan tidak peka huruf besar/kecil). */
export function guardrailViolations(userId: string, text: string): { rule: GuardrailRule; pattern: string }[] {
  const value = String(text ?? "").toLowerCase();
  if (!value.trim()) return [];
  const hits: { rule: GuardrailRule; pattern: string }[] = [];
  for (const rule of activeGuardrailRules(userId)) {
    if (rule.kind !== "larangan") continue;
    const matched = prohibitionPatterns(rule.body).find((pattern) => value.includes(pattern));
    if (matched) hits.push({ rule, pattern: matched });
  }
  return hits;
}

/** Mencatat satu pelanggaran. Kutipan dibatasi 200 karakter dan tidak pernah memuat isi penuh. */
export function recordSafetyEvent(input: { userId: string; runId?: string | null; ruleId?: string | null; pattern: string; snippet?: string }): void {
  db.prepare("INSERT INTO safety_events (id,user_id,run_id,rule_id,pattern,snippet,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(), input.userId, input.runId ?? null, input.ruleId ?? null, String(input.pattern ?? "").slice(0, 120), String(input.snippet ?? "").replace(/\s+/g, " ").slice(0, 200), new Date().toISOString());
}

/** Ringkasan pelanggaran satu akun, plus daftar kejadian terbaru. */
export function safetySummary(userId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const totals = db.prepare("SELECT COUNT(*) AS total, MAX(created_at) AS terakhir FROM safety_events WHERE user_id=? AND created_at >= ?").get(userId, since) as { total: number; terakhir: string | null };
  const byRule = db.prepare(`SELECT e.rule_id AS ruleId, r.title AS title, COUNT(*) AS jumlah, MAX(e.created_at) AS terakhir
      FROM safety_events e LEFT JOIN guardrail_rules r ON r.id=e.rule_id
      WHERE e.user_id=? AND e.created_at >= ? GROUP BY e.rule_id ORDER BY jumlah DESC`).all(userId, since) as { ruleId: string | null; title: string | null; jumlah: number; terakhir: string }[];
  const events = db.prepare("SELECT id, rule_id AS ruleId, run_id AS runId, pattern, snippet, created_at AS createdAt FROM safety_events WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(userId);
  return { windowDays: days, total: totals.total ?? 0, terakhir: totals.terakhir ?? null, byRule, events };
}

function readRule(userId: string, id: string): GuardrailRule | null {
  return (db.prepare(`${SELECT_RULE} WHERE id=? AND user_id=?`).get(id, userId) as GuardrailRule | undefined) ?? null;
}

/** Validasi isi aturan; mengembalikan pesan Indonesia bila tidak sah, atau null bila sah. */
export function validateRule(input: { kind?: unknown; title?: unknown; body?: unknown }): { error: string; message: string } | null {
  if (input.kind !== undefined && !(GUARDRAIL_KINDS as readonly string[]).includes(String(input.kind))) {
    return { error: "INVALID_GUARDRAIL_KIND", message: "Jenis aturan harus 'kualitas' atau 'larangan'." };
  }
  if (input.title !== undefined && !String(input.title).trim()) return { error: "INVALID_GUARDRAIL_TITLE", message: "Judul aturan wajib diisi." };
  if (input.title !== undefined && String(input.title).length > 120) return { error: "INVALID_GUARDRAIL_TITLE", message: "Judul aturan maksimal 120 karakter." };
  if (input.body !== undefined && !String(input.body).trim()) return { error: "INVALID_GUARDRAIL_BODY", message: "Isi aturan wajib diisi." };
  if (input.body !== undefined && String(input.body).length > 2000) return { error: "INVALID_GUARDRAIL_BODY", message: "Isi aturan maksimal 2.000 karakter." };
  if (input.body !== undefined) {
    const patterns = prohibitionPatternsForValidation(String(input.body));
    if (patterns.some((item) => item.length > 120)) return { error: "INVALID_GUARDRAIL_BODY", message: "Satu pola larangan maksimal 120 karakter." };
  }
  return null;
}

/** Pola larangan tanpa menyaring panjang minimum, supaya pola terlalu pendek bisa ditolak jelas. */
function prohibitionPatternsForValidation(body: string): string[] {
  return String(body ?? "").split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

export function registerGuardrailRoutes(app: any): void {
  app.get("/api/v1/guardrails", { preHandler: requireUser }, async (request: any) => {
    const userId = request.user!.id;
    return {
      rules: db.prepare(`${SELECT_RULE} WHERE user_id=? ORDER BY sort_order ASC, updated_at DESC`).all(userId),
      kinds: GUARDRAIL_KINDS, injectLimit: GUARDRAIL_INJECT_LIMIT, maxRules: GUARDRAIL_MAX_RULES,
      help: "Aturan 'kualitas' dikirim ke agen sebagai instruksi. Aturan 'larangan' berisi pola (pisahkan dengan koma) yang membuat permintaan ditolak sebelum dijalankan.",
    };
  });

  app.post("/api/v1/guardrails", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const invalid = validateRule(request.body ?? {});
    if (invalid) return fail(reply, 400, invalid.error, invalid.message);
    const kind = String(request.body?.kind ?? "larangan") as GuardrailKind;
    const title = String(request.body?.title ?? "").trim();
    const body = String(request.body?.body ?? "").trim();
    if (!title) return fail(reply, 400, "INVALID_GUARDRAIL_TITLE", "Judul aturan wajib diisi.");
    if (!body) return fail(reply, 400, "INVALID_GUARDRAIL_BODY", "Isi aturan wajib diisi.");
    const total = Number((db.prepare("SELECT COUNT(*) AS n FROM guardrail_rules WHERE user_id=?").get(userId) as { n: number }).n);
    if (total >= GUARDRAIL_MAX_RULES) return fail(reply, 400, "TOO_MANY_GUARDRAILS", `Maksimal ${GUARDRAIL_MAX_RULES} aturan per akun.`);
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare("INSERT INTO guardrail_rules (id,user_id,kind,title,body,enabled,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, userId, kind, title.slice(0, 120), body.slice(0, 2000), request.body?.enabled === false ? 0 : 1, Number.isFinite(Number(request.body?.sortOrder)) ? Math.round(Number(request.body?.sortOrder)) : 0, now, now);
    audit(userId, "guardrail.created", { ruleId: id, kind, title });
    return reply.code(201).send({ rule: readRule(userId, id) });
  });

  app.patch("/api/v1/guardrails/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const rule = readRule(userId, request.params.id);
    if (!rule) return fail(reply, 404, "GUARDRAIL_NOT_FOUND", "Aturan tidak ditemukan.");
    const invalid = validateRule(request.body ?? {});
    if (invalid) return fail(reply, 400, invalid.error, invalid.message);
    const next = {
      kind: request.body?.kind !== undefined ? String(request.body.kind) : rule.kind,
      title: request.body?.title !== undefined ? String(request.body.title).trim().slice(0, 120) : rule.title,
      body: request.body?.body !== undefined ? String(request.body.body).trim().slice(0, 2000) : rule.body,
      enabled: request.body?.enabled !== undefined ? (request.body.enabled ? 1 : 0) : rule.enabled,
      sortOrder: request.body?.sortOrder !== undefined && Number.isFinite(Number(request.body.sortOrder)) ? Math.round(Number(request.body.sortOrder)) : rule.sortOrder,
    };
    db.prepare("UPDATE guardrail_rules SET kind=?, title=?, body=?, enabled=?, sort_order=?, updated_at=? WHERE id=? AND user_id=?")
      .run(next.kind, next.title, next.body, next.enabled, next.sortOrder, new Date().toISOString(), rule.id, userId);
    audit(userId, "guardrail.updated", { ruleId: rule.id, enabled: next.enabled, kind: next.kind });
    return { rule: readRule(userId, rule.id) };
  });

  app.delete("/api/v1/guardrails/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const rule = readRule(userId, request.params.id);
    if (!rule) return fail(reply, 404, "GUARDRAIL_NOT_FOUND", "Aturan tidak ditemukan.");
    db.prepare("DELETE FROM guardrail_rules WHERE id=? AND user_id=?").run(rule.id, userId);
    audit(userId, "guardrail.deleted", { ruleId: rule.id, title: rule.title });
    return { deleted: true, id: rule.id };
  });

  app.get("/api/v1/safety", { preHandler: requireUser }, async (request: any) => safetySummary(request.user!.id));
}

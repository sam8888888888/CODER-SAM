/**
 * Wave 11A (butir 80): pagar konteks total.
 *
 * Seluruh sisipan (`appendSystem[]`) dihitung terhadap satu pagar karakter. Pemotongan dilakukan
 * berurutan dari prioritas terendah, dicatat apa adanya, dan tidak pernah mengorbankan instruksi
 * mode (prioritas 0) maupun riwayat percakapan pengguna (riwayat tidak pernah masuk daftar sisipan).
 */
import { z } from "zod";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { adminRequired, audit, fail, isPlatformAdmin, platformSetting, savePlatformSetting } from "./shared.js";

export const CONTEXT_BUDGET_KEY = "context_budget_chars";
export const CONTEXT_BUDGET_MIN = 1000;
export const CONTEXT_BUDGET_MAX = 200000;

/** Nama tiap bagian sisipan beserta kalimat penjelas untuk halaman Pemakaian. */
export const CONTEXT_PARTS: Record<string, string> = {
  mode_diskusi: "Instruksi mode Diskusi (tidak pernah dipotong)",
  knowledge_base: "Knowledge Base platform",
  persona: "Persona/aturan kualitas akun",
  guardrail_kualitas: "Aturan kualitas dari halaman Guardrails",
  memori_dipin: "Memori yang dipin",
  skill_pengguna: "Skill milik pengguna",
  memori_lain: "Memori lain",
  ringkasan_percakapan: "Ringkasan percakapan setelah pemadatan (tidak pernah dipotong)",
};

/** Pagar konteks aktif: pengaturan platform bila ada, kalau tidak bawaan config (12.000). */
export function contextBudgetChars(): number {
  const raw = platformSetting(CONTEXT_BUDGET_KEY);
  const parsed = Number(raw);
  if (raw !== null && Number.isFinite(parsed) && parsed >= CONTEXT_BUDGET_MIN && parsed <= CONTEXT_BUDGET_MAX) return Math.round(parsed);
  return config.CONTEXT_BUDGET_CHARS;
}

export type BudgetBlock = { name: string; priority: number; text: string };
export type BudgetDrop = { name: string; chars: number; alasan: "prioritas_terendah" | "dipotong_sebagian" };

/**
 * Memotong daftar sisipan supaya total tidak pernah melebihi pagar.
 *
 * Aturan: blok berprioritas lebih besar dibuang lebih dulu (utuh bila cukup, dipotong sebagian bila
 * masih melebihi). Blok prioritas 0 dipertahankan apa pun yang terjadi karena itu instruksi pengaman.
 */
export function buildBudgetPlan(input: BudgetBlock[], budgetChars: number) {
  const blocks = input.map((block) => ({ ...block }));
  const dropped: BudgetDrop[] = [];
  const totalChars = blocks.reduce((total, block) => total + block.text.length, 0);
  const sum = () => blocks.reduce((total, block) => total + block.text.length, 0);
  // 1) Buang blok utuh mulai dari prioritas terbesar (paling tidak penting).
  for (const block of [...blocks].sort((a, b) => b.priority - a.priority)) {
    if (sum() <= budgetChars) break;
    if (block.priority <= 0) continue;
    const index = blocks.findIndex((item) => item.name === block.name);
    if (index < 0) continue;
    blocks.splice(index, 1);
    dropped.push({ name: block.name, chars: block.text.length, alasan: "prioritas_terendah" });
  }
  // 2) Blok wajib saja masih melebihi pagar: potong teksnya dari prioritas terbesar.
  for (const block of [...blocks].sort((a, b) => b.priority - a.priority)) {
    if (sum() <= budgetChars) break;
    if (block.priority <= 0) continue;
    const over = sum() - budgetChars;
    const keep = Math.max(0, block.text.length - over);
    if (keep === block.text.length) continue;
    dropped.push({ name: block.name, chars: block.text.length - keep, alasan: "dipotong_sebagian" });
    block.text = block.text.slice(0, keep);
  }
  return { blocks, dropped, budgetChars, totalChars, keptChars: sum(), overBudget: sum() > budgetChars };
}

/** Laporan jujur: apa yang dikirim, apa yang dipotong, dan berapa pagarnya. */
export function budgetReport(plan: ReturnType<typeof buildBudgetPlan>) {
  const sent = new Set(plan.blocks.map((block) => block.name));
  const dropped = new Map(plan.dropped.map((item) => [item.name, item]));
  const blocks = [...sent].map((name) => {
    const block = plan.blocks.find((item) => item.name === name)!;
    return { name, priority: block.priority, chars: block.text.length, keterangan: CONTEXT_PARTS[name] ?? name, terkirim: true };
  });
  for (const item of plan.dropped) {
    if (sent.has(item.name)) {
      const existing = blocks.find((block) => block.name === item.name);
      if (existing) existing.keterangan = `${existing.keterangan} (dipotong sebagian)`;
      continue;
    }
    blocks.push({ name: item.name, priority: -1, chars: 0, keterangan: `${CONTEXT_PARTS[item.name] ?? item.name} — TIDAK dikirim (${item.alasan === "prioritas_terendah" ? "prioritas terendah" : "dipotong sebagian"}: ${item.chars} karakter)` , terkirim: false });
  }
  return {
    budgetChars: plan.budgetChars,
    keptChars: plan.keptChars,
    totalCharsBeforeTrim: plan.totalChars,
    overBudget: plan.overBudget,
    dipotong: plan.dropped,
    blocks,
    catatan: plan.dropped.length
      ? "Sebagian sisipan tidak dikirim karena melewati pagar konteks. Riwayat percakapan pengguna tidak pernah dipotong untuk memberi ruang."
      : "Semua sisipan terkirim utuh; tidak ada yang dipotong.",
  };
}

const budgetSchema = z.coerce.number().int().min(CONTEXT_BUDGET_MIN).max(CONTEXT_BUDGET_MAX);

export function registerContextBudgetRoutes(app: any, buildBlocks: (userId: string, personaId: string | null, conversationId: string | null) => ReturnType<typeof buildBudgetPlan>) {
  app.get("/api/v1/context-budget/report", { preHandler: requireUser }, async (request: any) => {
    const plan = buildBlocks(request.user!.id, null, request.query?.conversationId?.trim() || null);
    return { ...budgetReport(plan), limitMin: CONTEXT_BUDGET_MIN, limitMax: CONTEXT_BUDGET_MAX, defaultChars: config.CONTEXT_BUDGET_CHARS };
  });

  app.put("/api/v1/admin/context-budget", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    if (request.body?.chars === null || request.body?.chars === undefined) {
      savePlatformSetting(CONTEXT_BUDGET_KEY, "");
      audit(request.user!.id, "admin.context_budget_reset", { budgetChars: config.CONTEXT_BUDGET_CHARS });
      return { budgetChars: contextBudgetChars(), diatur: false };
    }
    const parsed = budgetSchema.safeParse(request.body?.chars);
    if (!parsed.success) return fail(reply, 400, "INVALID_CONTEXT_BUDGET", `Pagar konteks harus angka ${CONTEXT_BUDGET_MIN}-${CONTEXT_BUDGET_MAX} karakter.`);
    savePlatformSetting(CONTEXT_BUDGET_KEY, String(parsed.data));
    audit(request.user!.id, "admin.context_budget_updated", { budgetChars: parsed.data });
    return { budgetChars: contextBudgetChars(), diatur: true };
  });
}

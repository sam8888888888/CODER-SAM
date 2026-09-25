/**
 * Wave 11B (butir 63/72): satu tempat untuk membuat run baru di luar rute chat biasa.
 *
 * Alasan modul ini ada: melanjutkan run (butir 63) dan menjalankan jadwal (butir 72) sama-sama perlu
 * membuat baris `runs` lalu menyerahkannya ke mesin. Jalur eksekusi mesin hanya boleh ada SATU, jadi
 * `server.ts` menyerahkan fungsinya ke sini lewat `setRunDispatcher` — modul wave11b tidak menyalin
 * jalur eksekusi, dan tidak ada dua rumus biaya/kuota.
 *
 * Pola pengiriman meniru jalur chat yang sudah ada: baris `runs` ditulis lebih dulu, mesin dipanggil
 * langsung, dan satu entri antrean (`run.execute`) tetap dibuat sebagai jaring pengaman bila proses
 * mati tepat setelah balasan HTTP. Pekerja antrean hanya mengeksekusi run yang masih berstatus
 * `queued`, sehingga run yang sudah jalan/selesai/gagal TIDAK pernah dieksekusi dua kali.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { enqueueJob } from "../jobs.js";

export type RunDispatchInput = {
  runId: string; projectId: string; prompt: string; userId: string;
  conversationId?: string | null; model?: string | null; thinking?: string | null;
  personaId?: string | null; autonomous?: boolean; resumedFrom?: string | null;
};

export type RunDispatcher = (input: RunDispatchInput) => unknown;

let dispatcher: RunDispatcher | null = null;

/** Dipasang sekali oleh `server.ts` saat modul rute dimuat. */
export function setRunDispatcher(fn: RunDispatcher): void { dispatcher = fn; }

/** Entri antrean cadangan untuk satu run. */
export function enqueueRun(input: RunDispatchInput): { queued: boolean; id: string | null; reason?: string } {
  return enqueueJob({
    kind: "run.execute",
    payload: {
      runId: input.runId, projectId: input.projectId, prompt: input.prompt,
      conversationId: input.conversationId ?? null, model: input.model ?? undefined,
      userId: input.userId, thinking: input.thinking ?? undefined,
      personaId: input.personaId ?? null, autonomous: Boolean(input.autonomous),
    },
    maxAttempts: 1,
    runAfter: new Date(Date.now() + 10_000),
  });
}

/**
 * Menulis baris run baru lalu mengirimnya ke mesin.
 * `jalur` dilaporkan apa adanya supaya pemanggil (dan uji) tahu apakah run dikirim langsung atau
 * hanya masuk antrean — dua-duanya sah, tetapi tidak boleh ditebak.
 */
export async function createRunAndDispatch(
  input: Omit<RunDispatchInput, "runId">,
): Promise<{ runId: string; jalur: "langsung" | "antrean" }> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO runs
      (id, project_id, status, prompt, model, created_at, autonomous, persona_id, thinking_level, resumed_from, resume_state)
      VALUES (?,?,?,?,?,?,?,?,?,?,'none')`)
    .run(runId, input.projectId, "queued", input.prompt, input.model ?? config.PRIME_AGENT_MODEL ?? null, now,
      input.autonomous ? 1 : 0, input.personaId ?? null, input.thinking ?? null, input.resumedFrom ?? null);
  const payload: RunDispatchInput = { ...input, runId };
  if (!dispatcher) {
    enqueueRun(payload);
    return { runId, jalur: "antrean" };
  }
  try {
    // Sengaja TIDAK ditunggu: seperti jalur chat, balasan HTTP keluar sebelum mesin selesai.
    void Promise.resolve(dispatcher(payload)).catch(() => undefined);
    enqueueRun(payload);
    return { runId, jalur: "langsung" };
  } catch {
    enqueueRun(payload);
    return { runId, jalur: "antrean" };
  }
}

/** Proyek yang dipakai sebuah percakapan, dipakai jadwal saat hanya percakapan yang diisi. */
export function projectOfConversation(conversationId: string): string | null {
  const row = db.prepare("SELECT project_id AS projectId FROM conversations WHERE id=?").get(conversationId) as
    { projectId?: string } | undefined;
  return row?.projectId ? String(row.projectId) : null;
}

/* ------------------------------------------------------------------ validasi nama model */
/**
 * `isKnownModel` dan daftar tingkat berpikir tinggal di `server.ts` (katalog mesin dibaca dari CLI
 * mesin). Modul wave11b tidak boleh menyalin daftar kedua, jadi `server.ts` menitipkan pemeriksanya
 * ke sini lewat `setModelValidator` / `setThinkingValidator`.
 */
let modelValidator: ((model: string) => boolean) | null = null;
let thinkingValidator: ((value: unknown) => boolean) | null = null;

export function setModelValidator(fn: (model: string) => boolean): void { modelValidator = fn; }
export function setThinkingValidator(fn: (value: unknown) => boolean): void { thinkingValidator = fn; }

/** Nama model yang dikenal mesin. Tanpa pemeriksa dari server, hanya bentuknya yang diperiksa. */
export function isKnownModelName(model: string): boolean {
  const value = model.trim();
  if (!value || value.length > 120) return false;
  return modelValidator ? modelValidator(value) : true;
}

/** Tingkat berpikir yang sah. Tanpa pemeriksa dari server, hanya bentuknya yang diperiksa. */
export function isThinkingLevelName(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return thinkingValidator ? thinkingValidator(value) : true;
}

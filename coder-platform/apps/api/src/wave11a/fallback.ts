/**
 * Wave 11A (butir 57): fallback model otomatis.
 *
 * Berkas ini memuat aturan dan pembacaan daftar model cadangan. Perpindahan modelnya sendiri
 * dijalankan di `executeRun` (server.ts) karena di sanalah mesin dipanggil.
 *
 * Aturan wajib: hanya galat SEMENTARA (429/5xx/timeout/koneksi) yang boleh memicu perpindahan,
 * maksimal 2 perpindahan per run, dan model yang dipakai selalu dilaporkan apa adanya.
 */
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { fail } from "./shared.js";

export const MAX_FALLBACK_MODELS = 3;
export const MAX_FALLBACK_SWITCHES = 2;

/** Membaca kolom `agent_settings.fallback_models` (JSON array) dengan aman. */
export function parseFallbackModels(raw: unknown): string[] {
  const value = typeof raw === "string" ? raw : JSON.stringify(raw ?? []);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean).slice(0, MAX_FALLBACK_MODELS) : [];
  } catch { return []; }
}

/** Pesan Indonesia bila susunan tidak sah, atau null bila sah. */
export function validateFallbackModels(input: unknown, primaryModel?: string | null): string | null {
  if (!Array.isArray(input)) return "Model cadangan harus berupa daftar nama model.";
  if (input.length > MAX_FALLBACK_MODELS) return `Maksimal ${MAX_FALLBACK_MODELS} model cadangan.`;
  const names = input.map((item) => String(item).trim()).filter(Boolean);
  if (names.some((name) => name.length > 120)) return "Nama model terlalu panjang.";
  if (new Set(names).size !== names.length) return "Model cadangan tidak boleh sama satu sama lain.";
  if (primaryModel && names.includes(primaryModel)) return "Model cadangan tidak boleh sama dengan model utama.";
  return null;
}

const TRANSIENT_PATTERNS = [/\b429\b/, /\b50[0-4]\b/, /rate.?limit/i, /too many requests/i, /timeout/i, /timed out/i, /ETIMEDOUT/i, /ECONNRESET/i, /ECONNREFUSED/i, /EAI_AGAIN/i, /socket hang up/i, /overloaded/i, /temporarily unavailable/i, /engine unavailable/i];
const PERMANENT_PATTERNS = [/\b400\b/, /\b401\b/, /\b403\b/, /\b404\b/, /\b422\b/, /INVALID_/i, /UNAUTHORIZED/i, /FORBIDDEN/i, /MODEL_UNKNOWN/i, /NOT_CONFIGURED/i];

/**
 * Galat sementara boleh memicu perpindahan model; galat permintaan salah tidak boleh, karena
 * mencoba ulang dengan model lain hanya menyembunyikan kesalahan pengguna dan menambah biaya.
 */
export function isTransientEngineError(message: unknown): boolean {
  const value = String(message ?? "");
  if (!value.trim()) return false;
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(value))) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(value));
}

export function fallbackModelsFor(userId: string): string[] {
  const row = db.prepare("SELECT fallback_models AS fallbackModels FROM agent_settings WHERE user_id=?").get(userId) as { fallbackModels?: string } | undefined;
  return parseFallbackModels(row?.fallbackModels ?? "[]");
}

export function registerFallbackRoutes(app: any): void {
  app.get("/api/v1/agents/fallback", { preHandler: requireUser }, async (request: any) => {
    const models = fallbackModelsFor(request.user!.id);
    return {
      models, maxModels: MAX_FALLBACK_MODELS, maxSwitchesPerRun: MAX_FALLBACK_SWITCHES,
      help: "Model cadangan dipakai berurutan hanya saat galat sementara (429, 5xx, timeout). Galat permintaan (400/401/403/404) tidak memicu perpindahan.",
    };
  });
}

/** Hasil satu perjalanan mesin beserta model yang benar-benar dipakai. */
export type FallbackOutcome = { model: string; switches: number; usage: unknown; text: string };

/**
 * Wave 11A (butir 57): menjalankan satu permintaan mesin, lalu berpindah ke model cadangan HANYA
 * bila galatnya sementara (429/5xx/timeout/koneksi) dan jatah perpindahan belum habis.
 * Galat permintaan salah (400/401/403/404) langsung dilempar supaya tidak menutupi masalah nyata.
 * Bila semua percobaan habis, galat yang dilempar adalah `ENGINE_UNAVAILABLE`.
 */
export async function runWithModelFallback(input: {
  primary: string;
  fallbacks: string[];
  maxSwitches: number;
  consume: (model: string) => Promise<{ text: string; usage: unknown }>;
  onFallback?: (dari: string, ke: string, alasan: string) => void;
}): Promise<FallbackOutcome> {
  const attempts = [input.primary, ...input.fallbacks.filter((item) => item && item !== input.primary)];
  let switches = 0;
  let lastError = "ENGINE_FAILED";
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const result = await input.consume(attempt);
      return { model: attempt, switches, usage: result.usage, text: result.text };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "ENGINE_FAILED";
      const next = attempts[index + 1];
      const canSwitch = Boolean(next) && switches < input.maxSwitches && isTransientEngineError(lastError);
      if (!canSwitch) throw new Error(switches > 0 ? "ENGINE_UNAVAILABLE" : lastError);
      switches += 1;
      input.onFallback?.(attempt, next!, lastError);
    }
  }
  throw new Error("ENGINE_UNAVAILABLE");
}

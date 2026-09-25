/**
 * Wave 11A (butir 42): Mode Diskusi per percakapan.
 *
 * Mode disimpan di kolom `conversations.agent_mode`. Saat mode `diskusi`, instruksi tegas dikirim
 * sebagai blok sistem PALING AWAL, sebelum blok lain, supaya mesin membacanya lebih dulu.
 */
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { audit, conversationAccess, fail, mayWrite } from "./shared.js";

export const AGENT_MODES = ["diskusi", "eksekusi"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Instruksi yang dikirim ke mesin saat mode diskusi aktif (teks disalin dari acuan chat, dirapikan). */
export const MODE_DISKUSI_BLOCK = "【MODE DISKUSI】Kita DISKUSI dulu: JANGAN mengeksekusi apa pun (jangan membuat atau mengubah berkas, jangan menjalankan alat apa pun). Sampaikan analisis, pilihan pendekatan, risiko, dan rencana langkah. Tunggu persetujuan eksplisit dari pengguna sebelum melakukan perubahan apa pun.";

/** Mode satu percakapan; percakapan tanpa id (jalur langsung) memakai mode eksekusi. */
export function conversationAgentMode(conversationId?: string | null): AgentMode {
  if (!conversationId) return "eksekusi";
  const row = db.prepare("SELECT agent_mode AS agentMode FROM conversations WHERE id=?").get(conversationId) as { agentMode?: string } | undefined;
  return row?.agentMode === "diskusi" ? "diskusi" : "eksekusi";
}

/** Blok mode yang disisipkan ke `appendSystem[]` (kosong saat mode eksekusi). */
export function agentModeBlocks(conversationId?: string | null): string[] {
  return conversationAgentMode(conversationId) === "diskusi" ? [MODE_DISKUSI_BLOCK] : [];
}

export function registerModeRoutes(app: any): void {
  app.get("/api/v1/conversations/:conversationId/mode", { preHandler: requireUser }, async (request: any, reply: any) => {
    const access = conversationAccess(request.params.conversationId, request.user!.id);
    if (!access) return fail(reply, 404, "CONVERSATION_NOT_FOUND", "Percakapan tidak ditemukan.");
    const row = db.prepare("SELECT agent_mode AS mode, updated_at AS updatedAt FROM conversations WHERE id=?").get(access.id) as { mode?: string; updatedAt?: string } | undefined;
    return {
      conversationId: access.id, mode: row?.mode === "diskusi" ? "diskusi" : "eksekusi",
      bolehUbah: mayWrite(access.role), updatedAt: row?.updatedAt ?? null,
      catatan: row?.mode === "diskusi" ? "Mode diskusi: agen hanya menganalisis, tidak menulis berkas." : "Mode eksekusi: agen boleh mengubah berkas.",
    };
  });

  app.put("/api/v1/conversations/:conversationId/mode", { preHandler: requireUser }, async (request: any, reply: any) => {
    const access = conversationAccess(request.params.conversationId, request.user!.id);
    if (!access) return fail(reply, 404, "CONVERSATION_NOT_FOUND", "Percakapan tidak ditemukan.");
    if (!mayWrite(access.role)) return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran viewer hanya boleh membaca.");
    const mode = String(request.body?.mode ?? "").trim().toLowerCase();
    if (!(AGENT_MODES as readonly string[]).includes(mode)) return fail(reply, 400, "INVALID_AGENT_MODE", "Mode harus 'diskusi' atau 'eksekusi'.");
    const now = new Date().toISOString();
    db.prepare("UPDATE conversations SET agent_mode=?, updated_at=? WHERE id=?").run(mode, now, access.id);
    audit(request.user!.id, "conversation.mode_changed", { conversationId: access.id, mode, sebelumnya: access.agentMode });
    return { conversationId: access.id, mode, bolehUbah: true, updatedAt: now };
  });
}

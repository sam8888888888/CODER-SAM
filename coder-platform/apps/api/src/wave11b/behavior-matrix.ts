/**
 * Wave 11B (butir 83): matriks perilaku gabungan.
 *
 * Tiga aturan yang mengikat, semuanya diuji (wave11b §11), bukan diasumsikan:
 *   ① MODE_DISKUSI_MENANG  — percakapan mode diskusi tetap diskusi, juga saat dipicu jadwal:
 *                            tidak ada run, tidak ada biaya, tidak ada artefak.
 *   ② OTONOM_WAJIB_PENANDA — run otonom hanya boleh mulai dari jadwal yang penanda `autonomous`
 *                            disetel eksplisit oleh pemiliknya. Tanpa penanda, jadwal berjalan
 *                            sebagai run biasa; kehendak bawaan akun (autonomous_default) TIDAK
 *                            boleh menyulap jadwal menjadi otonom.
 *   ③ PERSONA_SESI_WAJIB_JEJAK — persona bot per sesi tidak boleh menimpa persona percakapan
 *                            tanpa jejak audit. Setiap penggantian dicatat di `audit_events`
 *                            dengan aksi `persona.session_override` (persona lama + persona baru).
 *
 * Aturan ditulis juga di `docs/ARCHITECTURE.md` bagian "Matriks perilaku Wave 11B".
 */
import { db } from "../db.js";
import { audit } from "../wave11a/shared.js";

export type MatrixRuleId = "MODE_DISKUSI_MENANG" | "OTONOM_WAJIB_PENANDA" | "PERSONA_SESI_WAJIB_JEJAK";

export const MATRIX_RULES: { id: MatrixRuleId; aturan: string; caraUji: string }[] = [
  {
    id: "MODE_DISKUSI_MENANG",
    aturan: "Jadwal atau pemicu otomatis apa pun yang menemui percakapan mode diskusi TIDAK membuat run: pemicunya dilewati, alasannya dicatat, dan pesannya tetap diskusi.",
    caraUji: "Jalankan jadwal pada percakapan mode diskusi lalu periksa jumlah baris `runs` tidak bertambah.",
  },
  {
    id: "OTONOM_WAJIB_PENANDA",
    aturan: "Run otonom dari jadwal hanya sah bila kolom `prompt_schedules.autonomous` disetel 1. Tanpa penanda itu jadwal berjalan sebagai run biasa, walau akun punya bawaan otonom.",
    caraUji: "Jalankan jadwal tanpa penanda dan dengan penanda, lalu bandingkan `runs.autonomous` dan gema opsi mesin.",
  },
  {
    id: "PERSONA_SESI_WAJIB_JEJAK",
    aturan: "Persona yang dipakai satu sesi/kanal tidak menimpa persona percakapan secara diam-diam: setiap penggantian meninggalkan jejak audit berisi persona lama dan persona baru.",
    caraUji: "Kirim pesan dengan persona berbeda dari persona percakapan, lalu periksa baris `audit_events` aksi `persona.session_override`.",
  },
];

export type ScheduleDecision = {
  dijalankan: boolean;
  alasan: string;
  autonomous: boolean;
  catatan: string;
};

/**
 * Keputusan butir 83 ① dan ② untuk satu jadwal.
 * Percakapan yang tidak ditemukan diperlakukan sebagai "tidak ada mode diskusi" (tidak ada
 * percakapan = tidak ada yang dilindungi), dan itu dicatat di `catatan`.
 */
export function decideScheduledExecution(input: {
  conversationId?: string | null;
  autonomousRequested: boolean;
}): ScheduleDecision {
  if (input.conversationId) {
    const row = db.prepare("SELECT agent_mode AS mode FROM conversations WHERE id=?").get(input.conversationId) as
      { mode?: string } | undefined;
    if (row?.mode === "diskusi") {
      return {
        dijalankan: false, alasan: "MODE_DISKUSI", autonomous: false,
        catatan: "Percakapan ini mode diskusi: jadwal tetap diskusi dan tidak mengeksekusi apa pun.",
      };
    }
  }
  const autonomous = input.autonomousRequested === true;
  return {
    dijalankan: true, alasan: "", autonomous,
    catatan: autonomous
      ? "Jadwal meminta otonom secara eksplisit (autonomous: true), jadi run berjalan otonom."
      : "Tanpa penanda autonomous: true di jadwal, run ini berjalan sebagai run biasa — bawaan otonom akun tidak dipakai.",
  };
}

export type SessionPersonaInput = {
  userId: string;
  conversationId?: string | null;
  sessionPersonaId?: string | null;
  sumber?: string;
};

export type SessionPersonaResult = {
  personaId: string | null;
  diganti: boolean;
  catatan: string;
};

/**
 * Keputusan butir 83 ③. `persona_percakapan` adalah persona resmi percakapan; `persona_sesi` adalah
 * persona yang diminta satu sesi (mis. bot kanal). Bila berbeda, persona sesi menang TETAPI
 * perbedaannya wajib meninggalkan jejak audit — bukan penggantian diam-diam.
 */
export function resolveSessionPersona(input: SessionPersonaInput): SessionPersonaResult {
  const sessionPersonaId = input.sessionPersonaId?.trim() || null;
  if (!sessionPersonaId) {
    const konteks = input.conversationId
      ? db.prepare("SELECT persona_id AS personaId FROM conversations WHERE id=?").get(input.conversationId) as { personaId?: string | null } | undefined
      : undefined;
    return { personaId: konteks?.personaId ?? null, diganti: false, catatan: "Tidak ada persona sesi; persona percakapan dipakai apa adanya." };
  }
  const percakapan = input.conversationId
    ? db.prepare("SELECT persona_id AS personaId FROM conversations WHERE id=?").get(input.conversationId) as { personaId?: string | null } | undefined
    : undefined;
  const personaPercakapan = percakapan?.personaId ?? null;
  if (!personaPercakapan || personaPercakapan === sessionPersonaId) {
    return { personaId: sessionPersonaId, diganti: false, catatan: "Persona sesi dipakai tanpa menimpa persona percakapan." };
  }
  audit(input.userId, "persona.session_override", {
    conversationId: input.conversationId ?? null,
    personaPercakapan,
    personaSesi: sessionPersonaId,
    sumber: input.sumber ?? "pesan",
  });
  return {
    personaId: sessionPersonaId, diganti: true,
    catatan: "Persona sesi menimpa persona percakapan; penggantian dicatat di jejak audit (persona.session_override).",
  };
}

/** Ringkasan aturan + jumlah bukti audit, dipakai laporan dan uji. */
export function matrixSummary(): { rules: typeof MATRIX_RULES; jejakOverridePersona: number } {
  const row = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='persona.session_override'").get() as { n: number };
  return { rules: MATRIX_RULES, jejakOverridePersona: Number(row?.n ?? 0) };
}

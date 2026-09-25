/**
 * Wave 11B (59) — Shadow-First Rollout.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 59; jangan diubah pemilik butir lain.
 *
 * Aturan keras butir ini: modul HANYA mencatat ukuran. Ia tidak pernah menyentuh prompt, konteks,
 * maupun daftar `appendSystem`, sehingga jawaban run wajib identik saat mode mati dan saat mode nyala.
 * Semua pencatatan gagal-aman (`try/catch`): gagal mencatat tidak boleh menghentikan run.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { adminRequired, audit, fail, isPlatformAdmin, platformSetting, savePlatformSetting } from "../wave11a/shared.js";

/** Kunci pengaturan platform tempat mode bayangan disimpan. */
export const SHADOW_MODE_KEY = "shadow_mode";
/** Jenis ukuran yang dicatat; nilainya dipakai apa adanya oleh rute pengukuran. */
export const SHADOW_KINDS = ["prompt", "konteks"] as const;
const SHADOW_LIMIT_DEFAULT = 50;
const SHADOW_LIMIT_MAX = 500;

/** Ukuran terkecil yang pernah dicatat, dipakai hanya untuk memagari masukan yang tidak masuk akal. */
function normalisasiAngka(value: unknown): number {
  const angka = Number(value);
  if (!Number.isFinite(angka) || angka < 0) return 0;
  return Math.floor(angka);
}

/** Perkiraan token dari jumlah karakter: chars/4 dibulatkan ke atas. Ini PERKIRAAN, bukan pemakaian nyata. */
export function perkiraanToken(chars: number): number {
  return Math.ceil(normalisasiAngka(chars) / 4);
}

/**
 * True bila mode bayangan menyala. Sumber kebenaran: pengaturan platform `shadow_mode`; bila admin
 * belum pernah mengubahnya, bawaan diambil dari `config.SHADOW_MODE` ("off").
 */
export function shadowModeActive(): boolean {
  try {
    const raw = (platformSetting(SHADOW_MODE_KEY) ?? config.SHADOW_MODE ?? "off").trim().toLowerCase();
    return raw === "on";
  } catch {
    // Gagal membaca pengaturan = anggap mati. Mode nyala tidak pernah dipaksa oleh kegagalan baca.
    return false;
  }
}

/** Nilai mode yang tersimpan apa adanya (untuk dilaporkan ke admin). */
function modeTersimpan(): "off" | "on" {
  return shadowModeActive() ? "on" : "off";
}

/**
 * Mencatat ukuran perkiraan. WAJIB gagal-aman: kegagalan mencatat tidak boleh menghentikan run.
 *
 * Baris yang ditulis ada dua untuk satu run: kind 'prompt' (panjang prompt pengguna) dan kind
 * 'konteks' (panjang seluruh sisipan `appendSystem`). Bila tabelnya hilang atau kolomnya berubah,
 * fungsi ini berhenti diam-diam — run tetap berjalan seperti biasa.
 */
export function recordShadowMeasurements(input: { userId: string; runId: string; promptChars: number; contextChars: number }): void {
  try {
    if (!input?.userId) return;
    // Penjagaan kedua: server.ts sudah memeriksa mode lebih dulu, tetapi pencatat ini juga menolak
    // menulis saat mode mati supaya tidak ada baris bayangan yang lolos dari jalur lain.
    if (!shadowModeActive()) return;
    const sekarang = new Date().toISOString();
    const baris: { kind: string; chars: number }[] = [
      { kind: "prompt", chars: normalisasiAngka(input.promptChars) },
      { kind: "konteks", chars: normalisasiAngka(input.contextChars) },
    ];
    const tambah = db.prepare("INSERT INTO shadow_measurements (id,user_id,run_id,kind,chars,tokens_est,created_at) VALUES (?,?,?,?,?,?,?)");
    for (const item of baris) tambah.run(randomUUID(), input.userId, input.runId ?? null, item.kind, item.chars, perkiraanToken(item.chars), sekarang);
  } catch {
    // Sengaja tidak melempar: mencatat ukuran adalah pekerjaan sampingan, bukan syarat run.
  }
}

/** Memasang rute admin shadow: GET/PUT /api/v1/admin/shadow dan GET /api/v1/admin/shadow/measurements. */
export function registerShadowRoutes(app: any): void {
  app.get("/api/v1/admin/shadow", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const total = Number((db.prepare("SELECT COUNT(*) AS n FROM shadow_measurements").get() as { n: number }).n ?? 0);
    const barisMode = db.prepare("SELECT updated_at AS updatedAt FROM platform_settings WHERE key=?").get(SHADOW_MODE_KEY) as { updatedAt?: string } | undefined;
    return {
      mode: modeTersimpan(),
      catatan: "Mode bayangan hanya MENCATAT perkiraan ukuran konteks. Jawaban run tidak berubah: prompt dan sisipan konteks tidak disentuh, dan kegagalan mencatat dilewati.",
      kinds: [...SHADOW_KINDS],
      total,
      updatedAt: barisMode?.updatedAt ?? null,
    };
  });

  app.put("/api/v1/admin/shadow", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const mode = String(request.body?.mode ?? "").trim().toLowerCase();
    if (mode !== "on" && mode !== "off") return fail(reply, 400, "INVALID_SHADOW_MODE", "Mode bayangan hanya 'on' atau 'off'.");
    savePlatformSetting(SHADOW_MODE_KEY, mode);
    audit(request.user!.id, "admin.shadow_mode_updated", { mode });
    return {
      mode,
      diterapkanPadaRunBerikutnya: true,
      catatan: mode === "on"
        ? "Mulai run berikutnya, ukuran prompt dan konteks dicatat sebagai perkiraan. Jawaban tidak berubah."
        : "Mulai run berikutnya, pengukuran bayangan berhenti. Tidak ada perubahan pada jawaban.",
    };
  });

  app.get("/api/v1/admin/shadow/measurements", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const diminta = Number(request.query?.limit ?? SHADOW_LIMIT_DEFAULT);
    const limit = Math.min(Math.max(Number.isFinite(diminta) && diminta > 0 ? Math.floor(diminta) : SHADOW_LIMIT_DEFAULT, 1), SHADOW_LIMIT_MAX);
    const total = Number((db.prepare("SELECT COUNT(*) AS n FROM shadow_measurements").get() as { n: number }).n ?? 0);
    const perJenis = db.prepare("SELECT kind, COUNT(*) AS n FROM shadow_measurements GROUP BY kind").all() as { kind: string; n: number }[];
    const byKind: Record<string, number> = { prompt: 0, konteks: 0 };
    for (const item of perJenis) byKind[item.kind] = Number(item.n);
    const akhir = db.prepare("SELECT id, user_id AS userId, run_id AS runId, kind, chars, tokens_est AS tokensEst, created_at AS createdAt FROM shadow_measurements ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
    return {
      total,
      byKind,
      akhir,
      catatan: "Angka ini PERKIRAAN ukuran, bukan perilaku.",
    };
  });
}

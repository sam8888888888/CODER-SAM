/**
 * Wave 11B (66) — Laporan galat admin + ekspor.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 66; jangan diubah pemilik butir lain.
 *
 * Penyaringan rahasia dilakukan SEBELUM baris ditulis, bukan saat dibaca: laporan galat sering
 * dibagikan ke orang lain, jadi isi tabel harus sudah bersih saat tersimpan. Pola yang dibuang:
 * kunci API (`Bearer ...`), `SECRETS_KEY=`/`password=`/`api_key=`/`token=`/`secret=`, token panjang
 * (>= 20 karakter alfanumerik bercampur huruf dan angka), awalan `sk-...`, dan isi `enc:v1:`.
 *
 * Pemilihan `user_id`: pengguna yang SEDANG memanggil tetap disimpan, karena tanpa itu laporan galat
 * tidak bisa ditelusuri ke akun yang kena (dan `dataexport.ts` sudah mengekspor baris milik pengguna
 * itu kepada pemiliknya). Baris tanpa pemanggil (pekerja latar, permintaan tanpa login) disimpan
 * dengan `user_id` NULL dan tetap muncul di laporan admin. Tidak ada kolom kedua untuk keduanya,
 * sehingga laporan dan ekspor memakai sumber yang sama.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { adminRequired, isPlatformAdmin } from "../wave11a/shared.js";

/** Panjang maksimum pesan yang disimpan; sisa potongan dibuang agar tabel tidak membengkak. */
export const ERROR_MESSAGE_MAX = 800;
/** Penanda pengganti bagian yang dianggap rahasia. */
export const ERROR_REDACTION = "[disunting]";
/** Batas jumlah baris per ekspor; laporan besar diambil bertahap lewat `from`/`to`. */
export const ERROR_EXPORT_MAX = 5000;

const BATAS_DEFAULT = 100;
const BATAS_MAX = 500;

/**
 * Membuang rahasia dari satu pesan galat. Urutan penting: pola berlabel (`Bearer`, `password=`)
 * dibersihkan lebih dulu, baru token panjang yang berdiri sendiri, supaya labelnya tidak ikut hilang
 * dan laporan tetap bisa dibaca.
 */
export function scrubErrorSecrets(input: string): string {
  let teks = String(input ?? "");
  // 1) Kunci API gaya header.
  teks = teks.replace(/\b(bearer)\s+[A-Za-z0-9._\-+/=]{6,}/gi, `$1 ${ERROR_REDACTION}`);
  // 2) Pasangan label=nilai untuk nama yang jelas rahasia.
  teks = teks.replace(/\b(secrets?_key|api_?key|password|passwd|token|secret|authorization|access_?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_all, label: string, pemisah: string) => `${label}${pemisah}${ERROR_REDACTION}`);
  // 3) Isi kotak rahasia platform.
  teks = teks.replace(/enc:v1:[A-Za-z0-9+/=_-]+/gi, `enc:v1:${ERROR_REDACTION}`);
  // 4) Awalan kunci gaya OpenAI.
  teks = teks.replace(/\bsk-[A-Za-z0-9._\-]{6,}/g, `sk-${ERROR_REDACTION}`);
  // 4b) Kunci API platform `ck_<40 heksadesimal>` (apikeys.ts). Pola 5 di bawah TIDAK menangkapnya:
  // garis bawah adalah karakter kata, jadi batas kata tidak ada di antara `ck_` dan heksadesimalnya.
  // Tanpa langkah ini kunci API utuh bocor ke `error_events` dan ke ekspor CSV (temuan audit).
  teks = teks.replace(/\bck_[0-9a-f]{16,}\b/gi, `ck_${ERROR_REDACTION}`);
  // 4c) Kunci lain yang memakai awalan bergaris bawah (mis. `wh_`, `api_`) dengan badan panjang.
  teks = teks.replace(/\b[a-z]{2,6}_[0-9a-f]{24,}\b/gi, (_all, awalan: string) => `${awalan}_${ERROR_REDACTION}`);
  // 5) Token panjang yang berdiri sendiri: >= 20 karakter alfanumerik DAN bercampur huruf+angka.
  teks = teks.replace(/\b[A-Za-z0-9]{20,}\b/g, (token: string) => (/[0-9]/.test(token) && /[A-Za-z]/.test(token) ? ERROR_REDACTION : token));
  return teks.slice(0, ERROR_MESSAGE_MAX);
}

/** Mencatat galat setelah rahasia disaring. WAJIB gagal-aman (tidak pernah melempar). */
export function recordErrorEvent(input: { kind?: string; code?: string; message: string; runId?: string | null; userId?: string | null }): void {
  try {
    if (!config.ERROR_EVENTS_ENABLED) return;
    const message = scrubErrorSecrets(input?.message ?? "");
    if (!message) return;
    db.prepare("INSERT INTO error_events (id,kind,code,message,run_id,user_id,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), String(input?.kind ?? "server").slice(0, 40) || "server", String(input?.code ?? "").slice(0, 80),
        message, input?.runId ?? null, input?.userId ?? null, new Date().toISOString());
  } catch {
    // Pencatatan galat tidak boleh menjadi galat berikutnya.
  }
}

/** Batas waktu yang diterima: tanggal saja (`2026-09-01`) atau cap waktu ISO yang bisa diuraikan. */
function batasWaktu(value: unknown, akhirHari: boolean): string | null {
  const teks = String(value ?? "").trim();
  if (!teks) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(teks)) return `${teks}${akhirHari ? "T23:59:59.999Z" : "T00:00:00.000Z"}`;
  const cap = new Date(teks);
  if (Number.isNaN(cap.getTime())) return null;
  return cap.toISOString();
}

function csvCell(value: unknown): string {
  const teks = value === null || value === undefined ? "" : String(value);
  return `"${teks.replace(/"/g, '""')}"`;
}

/** Memasang rute admin: GET /api/v1/admin/errors dan GET /api/v1/admin/errors/export.csv. */
export function registerErrorRoutes(app: any): void {
  app.get("/api/v1/admin/errors", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const kind = String(request.query?.kind ?? "").trim();
    const dari = batasWaktu(request.query?.from, false);
    const sampai = batasWaktu(request.query?.to, true);
    if (request.query?.from && !dari) return reply.code(400).send({ error: "INVALID_DATE", message: "Format `from` harus YYYY-MM-DD atau cap waktu ISO." });
    if (request.query?.to && !sampai) return reply.code(400).send({ error: "INVALID_DATE", message: "Format `to` harus YYYY-MM-DD atau cap waktu ISO." });
    const diminta = Number(request.query?.limit ?? BATAS_DEFAULT);
    const limit = Math.min(Math.max(Number.isFinite(diminta) && diminta > 0 ? Math.floor(diminta) : BATAS_DEFAULT, 1), BATAS_MAX);
    const syarat: string[] = []; const nilai: unknown[] = [];
    if (kind) { syarat.push("kind=?"); nilai.push(kind); }
    if (dari) { syarat.push("created_at >= ?"); nilai.push(dari); }
    if (sampai) { syarat.push("created_at <= ?"); nilai.push(sampai); }
    const where = syarat.length ? ` WHERE ${syarat.join(" AND ")}` : "";
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM error_events${where}`).get(...nilai as any[]) as { n: number }).n ?? 0);
    const rows = db.prepare(`SELECT id, kind, code, message, run_id AS runId, user_id AS userId, created_at AS createdAt
      FROM error_events${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...nilai as any[], limit);
    return {
      total, kind: kind || null, from: dari, to: sampai, rows,
      catatan: "Pesan sudah disaring dari rahasia sebelum disimpan. Retensi 30 hari; baris tanpa pemanggil disimpan tanpa user_id.",
    };
  });

  app.get("/api/v1/admin/errors/export.csv", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const kind = String(request.query?.kind ?? "").trim();
    const dari = batasWaktu(request.query?.from, false);
    const sampai = batasWaktu(request.query?.to, true);
    if (request.query?.from && !dari) return reply.code(400).send({ error: "INVALID_DATE", message: "Format `from` harus YYYY-MM-DD atau cap waktu ISO." });
    if (request.query?.to && !sampai) return reply.code(400).send({ error: "INVALID_DATE", message: "Format `to` harus YYYY-MM-DD atau cap waktu ISO." });
    const syarat: string[] = []; const nilai: unknown[] = [];
    if (kind) { syarat.push("kind=?"); nilai.push(kind); }
    if (dari) { syarat.push("created_at >= ?"); nilai.push(dari); }
    if (sampai) { syarat.push("created_at <= ?"); nilai.push(sampai); }
    const where = syarat.length ? ` WHERE ${syarat.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT id, kind, code, message, run_id AS runId, user_id AS userId, created_at AS createdAt
      FROM error_events${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`).all(...nilai as any[], ERROR_EXPORT_MAX) as Record<string, unknown>[];
    const header = ["id", "kind", "code", "runId", "userId", "message", "createdAt"];
    const lines = [header.join(","), ...rows.map((row) => header.map((kolom) => csvCell(row[kolom])).join(","))];
    return reply
      .header("Content-Disposition", 'attachment; filename="coder-error-events.csv"')
      .header("X-Content-Type-Options", "nosniff")
      .type("text/csv; charset=utf-8")
      .send(`${lines.join("\n")}\n`);
  });
}

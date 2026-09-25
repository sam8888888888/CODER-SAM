/**
 * Wave 11B (62) — Replay timeline + pratinjau sesi.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 62; jangan diubah pemilik butir lain.
 *
 * Sumber data HANYA dua tabel yang sudah ada:
 *   • `run_events` — urutan peristiwa nyata yang ditulis `publishRunEvent` di server.ts;
 *   • `runs`       — kepala (run dibuat) dan ekor (selesai/gagal/dibatalkan) run.
 * Tidak ada tabel kedua dan tidak ada langkah yang dikarang: setiap langkah berasal dari satu baris nyata.
 */
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { fail } from "../wave11a/shared.js";

/**
 * Batas jumlah langkah supaya run raksasa tetap cepat. Bila batas ini terpakai, pemotongannya
 * dilaporkan apa adanya di `catatan` (tidak disembunyikan).
 */
export const TIMELINE_MAX_STEPS = 2000;

type Langkah = { seq: number; at: string; kind: string; name: string; summary: string; status: string };

/** Membaca `data_json` dengan aman: satu baris rusak tidak boleh menggagalkan seluruh timeline. */
function bacaData(raw: unknown): any {
  if (typeof raw !== "string" || !raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Memotong teks panjang menjadi satu baris ringkas. */
function rapikan(teks: unknown, max = 200): string {
  if (teks === null || teks === undefined) return "";
  const value = typeof teks === "string" ? teks : (() => { try { return JSON.stringify(teks); } catch { return String(teks); } })();
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Jenis peristiwa mesin dipetakan apa adanya; tidak ada jenis baru yang diciptakan. */
function jenisDari(tipe: string): string {
  switch (tipe) {
    case "tool": return "alat";
    case "knowledge": return "konteks";
    case "model_fallback": return "model";
    case "completed": return "selesai";
    case "failed": return "gagal";
    default: return "lain";
  }
}

function namaDari(tipe: string, data: any): string {
  switch (tipe) {
    case "tool": return rapikan(data?.name ?? data?.tool ?? data?.toolName ?? "alat", 80) || "alat";
    case "knowledge": return "Konteks basis pengetahuan";
    case "model_fallback": return `Pindah model ke ${rapikan(data?.ke ?? "?", 60)}`;
    case "completed": return "Run selesai";
    case "failed": return "Run gagal";
    default: return tipe;
  }
}

function ringkasanDari(tipe: string, data: any): string {
  switch (tipe) {
    case "tool": return rapikan(data?.summary ?? data?.args ?? data?.input ?? data?.command ?? "", 240);
    case "knowledge": {
      const hits = Array.isArray(data?.hits) ? data.hits : [];
      const judul = hits.slice(0, 3).map((hit: any) => rapikan(hit?.title ?? hit?.id ?? "?", 40)).filter(Boolean).join(", ");
      return `${hits.length} potongan konteks dikirim ke mesin${judul ? `: ${judul}` : ""}.`;
    }
    case "model_fallback": return rapikan(`Dari ${data?.dari ?? "?"}: ${data?.alasan ?? "tanpa alasan dilaporkan"}`, 240);
    case "completed": {
      const hasil = typeof data?.result === "string" ? data.result : "";
      return hasil ? `Jawaban ${hasil.length} karakter: ${rapikan(hasil, 160)}` : "Run selesai tanpa teks jawaban.";
    }
    case "failed": return rapikan(data?.message ?? data?.error ?? "Mesin melaporkan kegagalan.", 240);
    default: return rapikan(data, 240);
  }
}

function statusDari(tipe: string, data: any): string {
  if (tipe === "failed") return "gagal";
  if (tipe === "completed") return "selesai";
  if (typeof data?.status === "string" && data.status.trim()) return rapikan(data.status, 40);
  if (data?.ok === false || data?.error || data?.errorCode) return "gagal";
  return "selesai";
}

/**
 * Menyusun urutan dari data yang sudah ada (run_events + runs); null bila run bukan milik pengguna.
 *
 * Urutan langkah mengikuti waktu baris nyata: mula-mula baris `runs` (dibuat), lalu baris `run_events`
 * terurut `created_at ASC, id ASC`, lalu penutup dari baris `runs` bila peristiwa penutup belum ada.
 * Baris peristiwa bertipe `text` (potongan jawaban) tidak dipecah menjadi langkah tersendiri supaya
 * daftar tetap terbaca; jumlahnya dilaporkan rute lewat `catatan`.
 */
export function runTimeline(runId: string, userId: string): any[] | null {
  const id = String(runId ?? "").trim();
  if (!id) return null;
  const run = db.prepare(`SELECT r.id, r.status, r.model, r.prompt, r.error_code AS errorCode, r.result,
      r.created_at AS createdAt, r.finished_at AS finishedAt
    FROM runs r JOIN projects p ON p.id=r.project_id JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE r.id=? AND m.user_id=?`).get(id, userId) as any;
  if (!run) return null;

  const langkah: Langkah[] = [];
  const tambah = (at: unknown, kind: string, name: string, summary: string, status: string) => {
    langkah.push({ seq: langkah.length + 1, at: String(at ?? run.createdAt ?? ""), kind, name, summary, status });
  };

  tambah(run.createdAt, "run", "run dibuat",
    `Model ${rapikan(run.model ?? "(belum dipilih)", 60)}; permintaan: ${rapikan(run.prompt, 160)}`, "dibuat");

  const events = db.prepare("SELECT id, type, data_json AS data, created_at AS createdAt FROM run_events WHERE run_id=? ORDER BY created_at ASC, id ASC")
    .all(id) as { id: number; type: string; data: string; createdAt: string }[];

  let adaPenutup = false;
  let dipotongKarenaBatas = false;
  for (const event of events) {
    const tipe = String(event.type ?? "");
    if (tipe === "text") continue; // potongan jawaban: dilaporkan sebagai hitungan, bukan langkah
    if (langkah.length >= TIMELINE_MAX_STEPS) { dipotongKarenaBatas = true; break; }
    const data = bacaData(event.data);
    if (tipe === "completed" || tipe === "failed") adaPenutup = true;
    tambah(event.createdAt, jenisDari(tipe), namaDari(tipe, data), ringkasanDari(tipe, data), statusDari(tipe, data));
  }

  // Ekor dari baris `runs` hanya ditambahkan bila peristiwanya belum tercatat di `run_events`,
  // supaya tidak ada langkah kembar.
  const status = String(run.status ?? "");
  if (!dipotongKarenaBatas && !adaPenutup && ["completed", "failed", "cancelled"].includes(status)) {
    if (status === "completed") {
      const hasil = typeof run.result === "string" ? run.result : "";
      tambah(run.finishedAt ?? run.createdAt, "selesai", "run selesai",
        hasil ? `Jawaban ${hasil.length} karakter: ${rapikan(hasil, 160)}` : "Run selesai tanpa teks jawaban.", "selesai");
    } else if (status === "failed") {
      tambah(run.finishedAt ?? run.createdAt, "gagal", "run gagal", rapikan(run.errorCode ?? "Mesin melaporkan kegagalan.", 240), "gagal");
    } else {
      tambah(run.finishedAt ?? run.createdAt, "dibatalkan", "run dibatalkan", "Run dihentikan sebelum selesai.", "dibatalkan");
    }
  }
  return langkah;
}

/** Memasang rute GET /api/v1/runs/:runId/timeline. */
export function registerTimelineRoutes(app: any): void {
  app.get("/api/v1/runs/:runId/timeline", { preHandler: requireUser }, async (request: any, reply: any) => {
    const runId = String(request.params?.runId ?? "");
    const langkah = runTimeline(runId, request.user!.id);
    // 404, bukan 403: run milik ruang kerja lain tidak boleh membocorkan keberadaannya.
    if (!langkah) return fail(reply, 404, "RUN_NOT_FOUND", "Run tidak ditemukan di ruang kerja Anda.");
    const hitung = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN type='text' THEN 1 ELSE 0 END),0) AS teks FROM run_events WHERE run_id=?").get(runId) as { total: number; teks: number };
    const status = String((db.prepare("SELECT status FROM runs WHERE id=?").get(runId) as { status?: string } | undefined)?.status ?? "unknown");
    const jumlahBaris = Number(hitung?.total ?? 0);
    const barisTeks = Number(hitung?.teks ?? 0);
    // Langkah minimum = 1 (run dibuat) + peristiwa bukan teks; bila lebih pendek dari itu, batas terpakai.
    const dipotong = langkah.length < 1 + (jumlahBaris - barisTeks);
    return {
      runId,
      status,
      total: langkah.length,
      langkah,
      catatan: [
        `${langkah.length} langkah disusun dari ${jumlahBaris} baris run_events dan baris runs; tidak ada langkah yang dikarang.`,
        barisTeks > 0
          ? `${barisTeks} baris peristiwa teks jawaban digabung, tidak dipecah menjadi langkah tersendiri.`
          : "Tidak ada baris peristiwa teks jawaban pada run ini.",
        dipotong ? `Jumlah langkah dipotong di batas ${TIMELINE_MAX_STEPS}; sisanya tidak ditampilkan.` : "",
        "Run milik ruang kerja lain menjawab 404 RUN_NOT_FOUND supaya keberadaannya tidak bocor.",
      ].filter(Boolean).join(" "),
    };
  });
}

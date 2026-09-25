/**
 * Wave 11B (58) — Dewan Juri.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 58; jangan diubah pemilik butir lain.
 *
 * Aturan butir ini yang menentukan bentuk kode:
 *   • SETIAP juri = satu `run` NYATA. Baris `runs` ditulis, mesin dipanggil, dan `run_usage`
 *     diisi lewat helper harga yang sudah ada. Karena itu biaya terlihat sebelum (perkiraan) dan
 *     sesudah (cost_micros) dijalankan.
 *   • Juri dijalankan berurutan per gelombang dengan batas `COUNCIL_MAX_PARALLEL`, maksimum
 *     `COUNCIL_MAX_JURORS` juri.
 *   • Juri yang gagal TIDAK merobohkan hasil: barisnya tetap ditulis dengan `error_code`, juri
 *     lain tetap selesai, dan status dewan menjadi `completed`. Bila SEMUA juri gagal -> `failed`.
 *   • Kuota token dihormati: pemeriksaan sebelum jalan (429) dan sebelum tiap juri (juri itu
 *     dilewati dengan `error_code = QUOTA_EXCEEDED`, tanpa membuat run baru).
 *
 * Catatan uang (diputuskan sendiri, dilaporkan ke lead): `cost_micros` yang disimpan dan
 * dikembalikan adalah HARGA JUAL (`run_usage.sell_cost_micros`), sama seperti perkiraan butir 56
 * yang memakai harga jual. Harga dasar (modal) tetap disediakan lewat `biayaDasarMicros`.
 */
import { randomUUID } from "node:crypto";
import { requireUser } from "../auth.js";
import { chargeQuota, quotaGuard } from "../billing.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { engine } from "../engine.js";
import { priceView, quoteCosts, sellForBaseMicros } from "../pricing.js";
import { estimateTokensFromChars } from "../wave11a/estimate.js";
import { MAX_FALLBACK_SWITCHES, fallbackModelsFor, runWithModelFallback } from "../wave11a/fallback.js";
import { audit, conversationAccess, fail, mayWrite } from "../wave11a/shared.js";

/** Asumsi panjang jawaban satu juri saat memperkirakan biaya SEBELUM dijalankan. */
export const COUNCIL_ASSUMED_OUTPUT_TOKENS = 256;
/** Batas materi yang dinilai: menjaga prompt dan biaya tetap masuk akal. */
export const COUNCIL_MATERIAL_MAX_CHARS = 200_000;
const JUROR_NAME_MAX_CHARS = 120;
const CATATAN_MAX_CHARS = 400;
const RINGKASAN_MAX_CHARS = 900;

/* ------------------------------------------------------------------ prompt */

/**
 * Prompt tugas juri. Satu juri = satu putaran mesin yang berdiri sendiri, jadi prompt ini memuat
 * materi, pertanyaan, dan aturan bentuk jawaban.
 *
 * Bentuk jawaban diminta sebagai JSON tanpa contoh berkurung, supaya pembaca jawaban tidak
 * tertipu contoh di dalam prompt itu sendiri.
 */
export function promptJuri(juror: string, material: string, question: string): string {
  return [
    `Anda anggota dewan juri dengan nama "${juror}".`,
    "Tugas Anda menilai materi di bawah ini terhadap pertanyaan yang diajukan.",
    "Balas HANYA dengan satu objek JSON, tanpa penjelasan di luar objek itu.",
    "Objek tersebut wajib memuat kunci: verdict (salah satu dari setuju, menolak, atau ragu),",
    "score (angka 0 sampai 100), dan notes (catatan singkat alasan penilaian, maksimal 400 karakter).",
    "",
    `Pertanyaan: ${question}`,
    "",
    "Materi yang dinilai:",
    material,
  ].join("\n");
}

/* ----------------------------------------------------- pembacaan jawaban juri */

export type VerdictJuri = { verdict: string; score: number | null; notes: string };

/** Mengambil objek JSON pertama di dalam teks jawaban; null bila tidak ada. */
function cariObjekJson(teks: string): Record<string, unknown> | null {
  let dicoba = 0;
  for (let i = 0; i < teks.length; i += 1) {
    if (teks[i] !== "{") continue;
    if (dicoba >= 20) return null;
    dicoba += 1;
    let dalam = 0;
    for (let j = i; j < teks.length; j += 1) {
      const huruf = teks[j];
      if (huruf === "{") dalam += 1;
      else if (huruf === "}") {
        dalam -= 1;
        if (dalam === 0) {
          const potongan = teks.slice(i, j + 1);
          try {
            const nilai = JSON.parse(potongan);
            if (nilai && typeof nilai === "object" && !Array.isArray(nilai)) return nilai as Record<string, unknown>;
          } catch { /* potongan ini bukan JSON yang sah: coba kandidat berikutnya */ }
          break;
        }
      }
    }
  }
  return null;
}

/** Menyeragamkan kata verdict yang ditulis juri. */
export function normalisasiVerdict(nilai: unknown): string {
  const teks = String(nilai ?? "").trim().toLowerCase().replace(/[.\s]+$/, "");
  if (!teks) return "";
  if (["setuju", "lolos", "terima", "diterima", "accept", "accepted", "approve", "approved", "pass", "ok"].includes(teks)) return "setuju";
  if (["menolak", "tolak", "ditolak", "reject", "rejected", "deny", "denied", "fail", "gagal"].includes(teks)) return "menolak";
  if (["ragu", "ragu-ragu", "tidak yakin", "unsure", "uncertain", "mixed", "netral"].includes(teks)) return "ragu";
  return teks.slice(0, 40);
}

/** Skor 0-100, atau null bila juri tidak memberi angka yang bisa dipakai. */
export function normalisasiSkor(nilai: unknown): number | null {
  if (nilai === null || nilai === undefined || typeof nilai === "boolean") return null;
  const angka = Number(nilai);
  if (!Number.isFinite(angka)) return null;
  return Math.max(0, Math.min(100, Math.round(angka)));
}

function ambilTeks(nilai: unknown, batas: number): string {
  const teks = typeof nilai === "string" ? nilai : (nilai === null || nilai === undefined ? "" : JSON.stringify(nilai));
  return teks.replace(/\s+/g, " ").trim().slice(0, batas);
}

/**
 * Membaca jawaban juri menjadi verdict + skor + catatan.
 *
 * Bila jawaban tidak memuat objek JSON bervedict, hasilnya ditulis APA ADANYA sebagai
 * `tidak-terbaca` beserta potongan jawabannya. Tidak ada tebakan dari kata kunci di dalam prompt
 * (kata setuju/menolak/ragu muncul di prompt, jadi menebak dari kata itu akan menipu pembaca).
 */
export function bacaVerdictJuri(jawaban: unknown): VerdictJuri {
  const teks = String(jawaban ?? "");
  const objek = cariObjekJson(teks);
  if (objek) {
    const mentah = objek.verdict ?? objek.putusan ?? objek.keputusan;
    const verdict = normalisasiVerdict(mentah);
    if (verdict) {
      return {
        verdict,
        score: normalisasiSkor(objek.score ?? objek.skor ?? objek.nilai),
        notes: ambilTeks(objek.notes ?? objek.catatan ?? objek.alasan, CATATAN_MAX_CHARS),
      };
    }
  }
  const potongan = ambilTeks(teks, CATATAN_MAX_CHARS - 60);
  return {
    verdict: "tidak-terbaca",
    score: null,
    notes: potongan ? `Jawaban tanpa verdict terstruktur: ${potongan}` : "Jawaban juri kosong.",
  };
}

/* --------------------------------------------------------------- ringkasan */

export type BarisRingkas = { juror: string; verdict: string; score: number | null; errorCode: string | null };

/** Ringkasan dewan apa adanya: hitungan suara, rata-rata skor, dan juri yang gagal. */
export function ringkasDewan(baris: BarisRingkas[]): string {
  const hitung = (nama: string) => baris.filter((row) => row.verdict === nama).length;
  const gagal = baris.filter((row) => Boolean(row.errorCode));
  const kosong = baris.filter((row) => !row.errorCode && row.verdict !== "setuju" && row.verdict !== "menolak" && row.verdict !== "ragu");
  const skor = baris.map((row) => row.score).filter((nilai): nilai is number => typeof nilai === "number");
  const bagian: string[] = [`Dewan juri: ${baris.length} juri dijalankan.`];
  const sah = hitung("setuju") + hitung("menolak") + hitung("ragu");
  if (sah) {
    bagian.push(`Suara terbaca: setuju ${hitung("setuju")}, menolak ${hitung("menolak")}, ragu ${hitung("ragu")}.`);
    const tertinggi = Math.max(hitung("setuju"), hitung("menolak"), hitung("ragu"));
    const pemenang = (["setuju", "menolak", "ragu"] as const).filter((nama) => hitung(nama) === tertinggi);
    bagian.push(tertinggi * 2 > sah
      ? `Mayoritas menyatakan ${pemenang[0]}.`
      : `Tidak ada mayoritas mutlak: ${pemenang.join(" dan ")} sama kuat.`);
  } else {
    bagian.push("Tidak ada suara yang terbaca sebagai verdict.");
  }
  if (skor.length) bagian.push(`Rata-rata skor ${Math.round(skor.reduce((total, nilai) => total + nilai, 0) / skor.length)} dari ${skor.length} juri yang memberi angka.`);
  if (kosong.length) bagian.push(`Jawaban tanpa verdict terstruktur: ${kosong.map((row) => row.juror).join(", ")}.`);
  if (gagal.length) bagian.push(`Juri gagal: ${gagal.map((row) => `${row.juror} (${row.errorCode})`).join(", ")}.`);
  return bagian.join(" ").slice(0, RINGKASAN_MAX_CHARS);
}

/* ------------------------------------------------------------- proyek induk */

export type AnchorHasil =
  | { projectId: string; workspaceId: string; role: string }
  | { error: "conversation" | "project" | "viewer" | "required" };

/**
 * Menentukan proyek tempat run juri dicatat.
 *
 * Setiap juri adalah run nyata, dan tabel `runs` wajib punya proyek. Karena itu rutenya memakai
 * proyek percakapan bila ada, proyek yang disebut pemanggil bila sah, atau proyek pertama milik
 * pengguna. Tanpa proyek sama sekali, permintaannya ditolak dengan 400 PROJECT_REQUIRED.
 */
export function selesaikanProyek(userId: string, projectIdRaw: unknown, conversationIdRaw: unknown): AnchorHasil {
  const conversationId = String(conversationIdRaw ?? "").trim();
  if (conversationId) {
    const akses = conversationAccess(conversationId, userId);
    if (!akses) return { error: "conversation" };
    if (!mayWrite(akses.role)) return { error: "viewer" };
    return { projectId: akses.projectId, workspaceId: akses.workspaceId, role: akses.role };
  }
  const projectId = String(projectIdRaw ?? "").trim();
  if (projectId) {
    const baris = db.prepare(`SELECT p.id AS projectId, p.workspace_id AS workspaceId, m.role AS role
      FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?`)
      .get(projectId, userId) as { projectId: string; workspaceId: string; role: string } | undefined;
    if (!baris) return { error: "project" };
    if (!mayWrite(baris.role)) return { error: "viewer" };
    return baris;
  }
  const punya = db.prepare(`SELECT p.id AS projectId, p.workspace_id AS workspaceId, m.role AS role
    FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=?
    ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END, p.created_at ASC LIMIT 1`)
    .get(userId) as { projectId: string; workspaceId: string; role: string } | undefined;
  if (!punya) return { error: "required" };
  if (!mayWrite(punya.role)) return { error: "viewer" };
  return punya;
}

/* --------------------------------------------------------------- perkiraan */

export type PerkiraanDewan = { perkiraanBiayaMicros: number; promptChars: number; tanpaHarga: string[] };

/**
 * Perkiraan biaya dewan SEBELUM dijalankan.
 *
 * Sisi masukan dihitung dari prompt juri yang sebenarnya (bukan angka kira-kira), sedangkan
 * panjang jawaban belum diketahui sehingga dipakai `COUNCIL_ASSUMED_OUTPUT_TOKENS`. Harga memakai
 * helper harga yang sudah ada (`quoteCosts`), harga jual, dan tidak ada rumus harga kedua di sini.
 */
export function perkiraanDewan(jurors: string[], material: string, question: string): PerkiraanDewan {
  let perkiraanBiayaMicros = 0;
  let promptChars = 0;
  const tanpaHarga: string[] = [];
  for (const juror of jurors) {
    const prompt = promptJuri(juror, material, question);
    promptChars = prompt.length;
    const quote = quoteCosts(juror, { inputTokens: estimateTokensFromChars(prompt.length), outputTokens: COUNCIL_ASSUMED_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (quote.sellMicros === null) { tanpaHarga.push(juror); continue; }
    perkiraanBiayaMicros += quote.sellMicros;
  }
  return { perkiraanBiayaMicros, promptChars, tanpaHarga };
}

/** Catatan sebelum jalan: asal angka dan batas yang berlaku. */
export function catatanSebelumJalan(jurors: string[], perkiraan: PerkiraanDewan, bawaan: boolean): string {
  const bagian = [
    `Perkiraan biaya memakai harga jual untuk ${jurors.length} juri; panjang jawaban belum diketahui sehingga dipakai asumsi ${COUNCIL_ASSUMED_OUTPUT_TOKENS} token jawaban per juri. Angka ini perkiraan, biaya nyata muncul di GET /api/v1/council/runs/:id.`,
    `Juri dijalankan berurutan dengan batas paralel ${config.COUNCIL_MAX_PARALLEL}, maksimum ${config.COUNCIL_MAX_JURORS} juri.`,
  ];
  if (bawaan) bagian.push(`Daftar juri tidak disebut, jadi dewan memakai model bawaan akun (${jurors.join(", ")}). Sebut beberapa model untuk membandingkan penilaian.`);
  if (perkiraan.tanpaHarga.length) bagian.push(`Biaya untuk ${perkiraan.tanpaHarga.join(", ")} belum diketahui karena modelnya tidak ada di katalog harga.`);
  return bagian.join(" ").slice(0, RINGKASAN_MAX_CHARS);
}

/** Catatan sesudah jalan: selisih biaya nyata vs perkiraan, dijelaskan apa adanya. */
export function catatanHasilJalan(input: {
  perkiraanBiayaMicros: number; costMicros: number; biayaDasarMicros: number;
  promptTokens: number; jawabanTokens: number; juriSelesai: number; juriGagal: number;
}): string {
  const selisih = input.costMicros - input.perkiraanBiayaMicros;
  const arah = selisih === 0 ? "sama dengan perkiraan" : (selisih > 0 ? "lebih mahal dari perkiraan" : "lebih murah dari perkiraan");
  const rataPrompt = input.juriSelesai ? Math.round(input.promptTokens / input.juriSelesai) : 0;
  const rataJawaban = input.juriSelesai ? Math.round((input.jawabanTokens / input.juriSelesai) * 10) / 10 : 0;
  return [
    `Biaya nyata ${input.costMicros} micros (harga jual) ${arah} ${input.perkiraanBiayaMicros} micros; selisih ${Math.abs(selisih)} micros.`,
    `Harga dasar (modal) run juri: ${input.biayaDasarMicros} micros.`,
    `Juri selesai ${input.juriSelesai}, gagal ${input.juriGagal}.`,
    `Pemakaian nyata ${rataPrompt} token masukan dan ${rataJawaban} token jawaban per juri, sedangkan perkiraan memakai asumsi ${COUNCIL_ASSUMED_OUTPUT_TOKENS} token jawaban per juri.`,
    "Selisih karena panjang jawaban nyata berbeda dari asumsi, bukan karena harga berbeda (keduanya memakai harga jual dari helper harga yang sama).",
  ].join(" ").slice(0, RINGKASAN_MAX_CHARS);
}

/* ------------------------------------------------------------- pencatatan run */

type PemakaianMasuk = { runId: string; projectId: string; userId: string; model: string; prompt: string; answer: string; usage: unknown };

/** Menulis satu baris `run_usage` dengan aturan yang sama seperti run biasa di server. */
function catatPemakaian(input: PemakaianMasuk): void {
  const dilaporkan = input.usage && typeof input.usage === "object" ? input.usage as Record<string, unknown> : null;
  const adaToken = typeof dilaporkan?.inputTokens === "number" || typeof dilaporkan?.outputTokens === "number";
  const inputTokens = adaToken ? Math.round(Number(dilaporkan?.inputTokens ?? 0)) : estimateTokensFromChars(input.prompt.length);
  const outputTokens = adaToken ? Math.round(Number(dilaporkan?.outputTokens ?? 0)) : estimateTokensFromChars(input.answer.length);
  const cacheReadTokens = adaToken ? Math.round(Number(dilaporkan?.cacheReadTokens ?? 0)) : 0;
  const cacheWriteTokens = adaToken ? Math.round(Number(dilaporkan?.cacheWriteTokens ?? 0)) : 0;
  const totalTokens = typeof dilaporkan?.totalTokens === "number"
    ? Math.round(Number(dilaporkan.totalTokens))
    : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const model = typeof dilaporkan?.model === "string" && dilaporkan.model ? dilaporkan.model : input.model;
  const quote = quoteCosts(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
  const biayaDasar = !adaToken ? null : (typeof dilaporkan?.costMicros === "number" ? Math.round(Number(dilaporkan.costMicros)) : quote.baseMicros);
  db.prepare(`INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,sell_cost_micros,estimated,raw_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(), input.runId, input.projectId, model, priceView(model).provider ?? config.PRIME_AGENT_PROVIDER ?? null,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, biayaDasar, sellForBaseMicros(biayaDasar, quote.markup),
    adaToken ? 0 : 1, dilaporkan ? JSON.stringify(dilaporkan.raw ?? null).slice(0, 4000) : null, new Date().toISOString(),
  );
  chargeQuota(input.userId, totalTokens);
}

/** Biaya satu run dari tabel `run_usage`: dasar (modal) dan jual (ditagihkan). */
function biayaRun(runId: string): { baseMicros: number; sellMicros: number; inputTokens: number; outputTokens: number } {
  const baris = db.prepare(`SELECT COALESCE(SUM(cost_micros),0) AS baseMicros, COALESCE(SUM(sell_cost_micros),0) AS sellMicros,
      COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
    FROM run_usage WHERE run_id=?`).get(runId) as { baseMicros: number; sellMicros: number; inputTokens: number; outputTokens: number };
  return baris;
}

/** Kode galat ringkas untuk baris verdict; pesan panjang tetap disimpan di catatan. */
export function kodeGalatJuri(pesan: unknown): string {
  const teks = String(pesan ?? "").trim();
  if (/^[A-Z][A-Z0-9_]{2,39}$/.test(teks)) return teks;
  const pertama = teks.split(/[\s:]+/)[0] ?? "";
  return /^[A-Z][A-Z0-9_]{2,39}$/.test(pertama) ? pertama : "JUROR_FAILED";
}

/** Menjalankan pekerjaan per gelombang: `batas` pekerjaan bersamaan, gelombang berikutnya menunggu. */
export async function jalankanBerurutanBersamaan<T, R>(nilai: T[], batas: number, kerja: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const lebar = Math.max(1, Math.floor(Number(batas)) || 1);
  const hasil: R[] = [];
  for (let mulai = 0; mulai < nilai.length; mulai += lebar) {
    const gelombang = nilai.slice(mulai, mulai + lebar);
    const selesai = await Promise.all(gelombang.map((item, urutan) => kerja(item, mulai + urutan)));
    hasil.push(...selesai);
  }
  return hasil;
}

export type HasilJuri = {
  juror: string; runId: string | null; verdict: string; score: number | null; notes: string;
  costMicros: number; baseMicros: number; errorCode: string | null; answerChars: number; latencyMs: number;
};

/**
 * Menjalankan SATU juri sebagai satu run nyata.
 *
 * Juri yang gagal mengembalikan baris hasil dengan `errorCode` terisi, bukan melempar galat:
 * kegagalan satu juri tidak boleh menghentikan dewan.
 */
async function jalankanSatuJuri(input: { userId: string; projectId: string; juror: string; material: string; question: string }): Promise<HasilJuri> {
  const prompt = promptJuri(input.juror, input.material, input.question);
  const runId = randomUUID();
  const mulai = new Date().toISOString();
  const jamMulai = Date.now();
  db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)").run(runId, input.projectId, "queued", prompt, input.juror, mulai);
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(mulai, runId);
  let teks = "";
  try {
    const hasil = await runWithModelFallback({
      primary: input.juror,
      fallbacks: fallbackModelsFor(input.userId),
      maxSwitches: Math.min(config.ENGINE_FALLBACK_MAX_SWITCHES, MAX_FALLBACK_SWITCHES),
      consume: async (percobaan) => {
        let potongan = "";
        let pemakaian: unknown = null;
        for await (const peristiwa of engine.run({
          runId, sessionId: runId, prompt, model: percobaan,
          provider: priceView(percobaan).provider ?? config.PRIME_AGENT_PROVIDER ?? undefined,
        })) {
          if (peristiwa.type === "text") potongan += typeof peristiwa.data === "string" ? peristiwa.data : JSON.stringify(peristiwa.data);
          if (peristiwa.type === "completed") pemakaian = (peristiwa.data as { usage?: unknown })?.usage ?? null;
          if (peristiwa.type === "failed") {
            // Kode galat dari mesin dipakai apa adanya supaya baris verdict/results bisa dibaca mesin.
            const galat = peristiwa.data as { code?: string; message?: string } | null;
            const kode = String(galat?.code ?? "ENGINE_FAILED").trim() || "ENGINE_FAILED";
            throw new Error(`${kode}: ${String(galat?.message ?? "").trim() || "mesin melaporkan gagal tanpa pesan"}`);
          }
        }
        return { text: potongan, usage: pemakaian };
      },
    });
    teks = hasil.text;
    if (hasil.model !== input.juror) db.prepare("UPDATE runs SET model=? WHERE id=?").run(hasil.model, runId);
    catatPemakaian({ runId, projectId: input.projectId, userId: input.userId, model: hasil.model, prompt, answer: teks, usage: hasil.usage });
    db.prepare("UPDATE runs SET status='completed', result=?, finished_at=? WHERE id=?").run(teks || null, new Date().toISOString(), runId);
    const biaya = biayaRun(runId);
    const verdict = bacaVerdictJuri(teks);
    return {
      juror: input.juror, runId, verdict: verdict.verdict, score: verdict.score, notes: verdict.notes,
      costMicros: biaya.sellMicros, baseMicros: biaya.baseMicros, errorCode: null, answerChars: teks.length, latencyMs: Date.now() - jamMulai,
    };
  } catch (galat) {
    const pesan = galat instanceof Error ? galat.message : "JUROR_FAILED";
    db.prepare("UPDATE runs SET status='failed', error_code=?, finished_at=? WHERE id=?").run(pesan.slice(0, 200), new Date().toISOString(), runId);
    const biaya = biayaRun(runId);
    return {
      juror: input.juror, runId, verdict: "", score: null, notes: `Juri gagal: ${pesan.slice(0, CATATAN_MAX_CHARS)}`,
      costMicros: biaya.sellMicros, baseMicros: biaya.baseMicros, errorCode: kodeGalatJuri(pesan), answerChars: teks.length, latencyMs: Date.now() - jamMulai,
    };
  }
}

/* ---------------------------------------------------------------- bantu rute */

/** Daftar juri bawaan: model bawaan platform. Satu juri, supaya tidak ada tagihan tak diminta. */
export function juriBawaan(): string[] {
  return [String(config.PRIME_AGENT_MODEL ?? "default").trim() || "default"];
}

function bacaJsonArray(nilai: unknown): string[] {
  try {
    const parsed = typeof nilai === "string" ? JSON.parse(nilai) : nilai;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch { return []; }
}

/** Validasi daftar juri dari badan permintaan; mengembalikan pesan galat atau daftar yang bersih. */
export function periksaJuri(mentah: unknown): { error?: { code: string; message: string }; jurors?: string[]; bawaan: boolean } {
  if (mentah === undefined || mentah === null) return { jurors: juriBawaan(), bawaan: true };
  if (!Array.isArray(mentah)) return { error: { code: "INVALID_JUROR", message: "Daftar juri harus berupa daftar nama model." }, bawaan: false };
  const bersih = mentah.map((item) => String(item ?? "").trim());
  if (bersih.length > config.COUNCIL_MAX_JURORS) {
    return { error: { code: "COUNCIL_JUROR_LIMIT", message: `Dewan juri maksimal ${config.COUNCIL_MAX_JURORS} juri.` }, bawaan: false };
  }
  if (!bersih.length || bersih.some((nama) => !nama || nama.length > JUROR_NAME_MAX_CHARS)) {
    return { error: { code: "INVALID_JUROR", message: `Nama juri tidak boleh kosong dan maksimal ${JUROR_NAME_MAX_CHARS} karakter.` }, bawaan: false };
  }
  if (new Set(bersih).size !== bersih.length) {
    return { error: { code: "INVALID_JUROR", message: "Juri yang sama tidak boleh didaftarkan dua kali." }, bawaan: false };
  }
  return { jurors: bersih, bawaan: false };
}

/* ------------------------------------------------------------------- rute */

type IsiDewan = { error: { code: string; message: string } } | { material: string; question: string; jurors: string[]; bawaan: boolean };

/**
 * Memeriksa isi permintaan dewan juri. Dipakai rute perkiraan DAN rute jalan, supaya perkiraan
 * yang dilihat pengguna dihitung dari permintaan yang bentuknya sama persis dengan yang dijalankan.
 */
export function periksaIsiDewan(body: any): IsiDewan {
  const material = String(body?.material ?? "");
  if (!material.trim()) return { error: { code: "COUNCIL_MATERIAL_REQUIRED", message: "Materi yang dinilai belum diisi." } };
  if (material.length > COUNCIL_MATERIAL_MAX_CHARS) return { error: { code: "COUNCIL_MATERIAL_TOO_LONG", message: `Materi maksimal ${COUNCIL_MATERIAL_MAX_CHARS} karakter.` } };
  const question = String(body?.question ?? "");
  if (!question.trim()) return { error: { code: "COUNCIL_QUESTION_REQUIRED", message: "Pertanyaan untuk dewan juri belum diisi, jadi juri tidak tahu apa yang harus dinilai." } };
  if (question.length > 20_000) return { error: { code: "COUNCIL_QUESTION_TOO_LONG", message: "Pertanyaan maksimal 20.000 karakter." } };
  const juri = periksaJuri(body?.jurors);
  if (juri.error) return { error: juri.error };
  return { material, question, jurors: juri.jurors!, bawaan: juri.bawaan };
}

/**
 * Memasang rute dewan juri:
 *   POST /api/v1/council/estimate  -> perkiraan biaya sebelum jalan (tidak menulis apa pun)
 *   POST /api/v1/council/run       -> menjalankan dewan (202)
 *   GET  /api/v1/council/runs/:id  -> hasil lengkap + biaya nyata
 *   GET  /api/v1/council/runs      -> daftar 20 dewan terakhir
 */
export function registerCouncilRoutes(app: any): void {
  app.post("/api/v1/council/estimate", { preHandler: requireUser }, async (request: any, reply: any) => {
    const isi = periksaIsiDewan(request.body);
    if ("error" in isi) return fail(reply, 400, isi.error.code, isi.error.message);
    const perkiraan = perkiraanDewan(isi.jurors, isi.material, isi.question);
    return {
      jurors: isi.jurors,
      perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros,
      promptChars: perkiraan.promptChars,
      assumedOutputTokens: COUNCIL_ASSUMED_OUTPUT_TOKENS,
      catatan: catatanSebelumJalan(isi.jurors, perkiraan, isi.bawaan),
    };
  });

  app.post("/api/v1/council/run", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const isi = periksaIsiDewan(request.body);
    if ("error" in isi) return fail(reply, 400, isi.error.code, isi.error.message);
    const material = isi.material;
    const question = isi.question;

    // Peran dan kepemilikan diperiksa lewat helper bersama, bukan dengan salinan aturan baru.
    const anchor = selesaikanProyek(userId, request.body?.projectId, request.body?.conversationId);
    if ("error" in anchor) {
      // Kegagalan di sini selalu berarti izin atau kepemilikan, bukan galat bentuk permintaan.

      if (anchor.error === "conversation") return fail(reply, 404, "CONVERSATION_NOT_FOUND", "Percakapan itu bukan milik Anda.");
      if (anchor.error === "project") return fail(reply, 404, "PROJECT_NOT_FOUND", "Proyek itu bukan milik Anda.");
      if (anchor.error === "viewer") return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran viewer hanya bisa membaca, jadi tidak bisa meminta penilaian dewan.");
      return fail(reply, 400, "PROJECT_REQUIRED", "Buat proyek dulu: setiap juri dicatat sebagai satu run di dalam proyek.");
    }

    const blokir = quotaGuard(userId, anchor.workspaceId);
    if (blokir) return fail(reply, blokir.status, blokir.error, String(blokir.detail?.message ?? "Kuota token paket Anda sudah habis."), blokir.detail ?? {});

    const jurors = isi.jurors;
    const perkiraan = perkiraanDewan(jurors, material, question);
    const councilRunId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO council_runs (id,user_id,project_id,conversation_id,material,question,status,summary,cost_micros,jurors,created_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      councilRunId, userId, anchor.projectId, String(request.body?.conversationId ?? "").trim() || null,
      material, question, "running", "", 0, JSON.stringify(jurors), now, null,
    );
    audit(userId, "council.run_started", { councilRunId, jurors, materialChars: material.length, perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros });

    // Juri dijalankan per gelombang; tiap juri memeriksa kuota sendiri sebelum mesin dipanggil.
    // Catatan jujur: juri di dalam SATU gelombang berjalan bersamaan, jadi pemeriksaan kuota mereka
    // terjadi pada saat yang sama. Yang dicegah di sini adalah juri di gelombang berikutnya tetap
    // dijalankan padahal kuota sudah habis karena gelombang sebelumnya.
    const hasil = await jalankanBerurutanBersamaan(jurors, config.COUNCIL_MAX_PARALLEL, async (nama: string): Promise<HasilJuri> => {
      const blokirJuri = quotaGuard(userId, anchor.workspaceId);
      if (blokirJuri) {
        return {
          juror: nama, runId: null, verdict: "", score: null,
          notes: `Juri dilewati: ${String(blokirJuri.detail?.message ?? "kuota token habis")}`,
          costMicros: 0, baseMicros: 0, errorCode: "QUOTA_EXCEEDED", answerChars: 0, latencyMs: 0,
        };
      }
      return jalankanSatuJuri({ userId, projectId: anchor.projectId, juror: nama, material, question });
    });

    const sekarang = new Date().toISOString();
    for (const baris of hasil) {
      db.prepare(`INSERT INTO council_verdicts (id,council_run_id,juror,verdict,score,notes,run_id,cost_micros,error_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), councilRunId, baris.juror, baris.verdict, baris.score, baris.notes,
        baris.runId, baris.costMicros, baris.errorCode, sekarang,
      );
    }
    const berhasil = hasil.filter((baris) => !baris.errorCode);
    const status = berhasil.length ? "completed" : "failed";
    const costMicros = hasil.reduce((total, baris) => total + baris.costMicros, 0);
    const biayaDasarMicros = hasil.reduce((total, baris) => total + baris.baseMicros, 0);
    const summary = ringkasDewan(hasil.map((baris) => ({ juror: baris.juror, verdict: baris.verdict, score: baris.score, errorCode: baris.errorCode })));
    db.prepare("UPDATE council_runs SET status=?, summary=?, cost_micros=?, finished_at=? WHERE id=?").run(status, summary, costMicros, sekarang, councilRunId);
    audit(userId, "council.run_finished", { councilRunId, status, jurors: jurors.length, juriGagal: hasil.length - berhasil.length, costMicros, perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros });

    return reply.code(202).send({
      councilRunId,
      status,
      jurors,
      perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros,
      catatan: catatanSebelumJalan(jurors, perkiraan, isi.bawaan),
      costMicros,
      biayaDasarMicros,
      summary,
    });
  });

  app.get("/api/v1/council/runs/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const baris = db.prepare(`SELECT id, status, question, material, jurors, summary, cost_micros AS costMicros,
        created_at AS createdAt, finished_at AS finishedAt FROM council_runs WHERE id=? AND user_id=?`)
      .get(request.params.id, request.user!.id) as {
        id: string; status: string; question: string; material: string; jurors: string; summary: string;
        costMicros: number; createdAt: string; finishedAt: string | null;
      } | undefined;
    if (!baris) return fail(reply, 404, "COUNCIL_NOT_FOUND", "Dewan juri itu tidak ada atau bukan milik Anda.");
    const verdicts = db.prepare(`SELECT id, juror, verdict, score, notes, run_id AS runId, cost_micros AS costMicros,
        error_code AS errorCode, created_at AS createdAt FROM council_verdicts WHERE council_run_id=? ORDER BY created_at ASC, id ASC`).all(baris.id);
    const jurors = bacaJsonArray(baris.jurors);
    const perkiraan = perkiraanDewan(jurors, baris.material, baris.question);
    const dasar = db.prepare(`SELECT COALESCE(SUM(u.cost_micros),0) AS baseMicros, COALESCE(SUM(u.sell_cost_micros),0) AS sellMicros,
        COALESCE(SUM(u.input_tokens),0) AS inputTokens, COALESCE(SUM(u.output_tokens),0) AS outputTokens
      FROM run_usage u JOIN council_verdicts v ON v.run_id=u.run_id WHERE v.council_run_id=?`)
      .get(baris.id) as { baseMicros: number; sellMicros: number; inputTokens: number; outputTokens: number };
    const daftarVerdict = verdicts as { errorCode: string | null }[];
    const juriGagal = daftarVerdict.filter((row) => Boolean(row.errorCode)).length;
    return {
      id: baris.id,
      status: baris.status,
      question: baris.question,
      materialChars: baris.material.length,
      jurors,
      summary: baris.summary,
      costMicros: baris.costMicros,
      createdAt: baris.createdAt,
      finishedAt: baris.finishedAt,
      verdicts,
      perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros,
      biayaDasarMicros: dasar.baseMicros,
      catatan: catatanHasilJalan({
        perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros,
        costMicros: baris.costMicros,
        biayaDasarMicros: dasar.baseMicros,
        promptTokens: dasar.inputTokens,
        jawabanTokens: dasar.outputTokens,
        juriSelesai: verdicts.length - juriGagal,
        juriGagal,
      }),
    };
  });

  app.get("/api/v1/council/runs", { preHandler: requireUser }, async (request: any) => {
    const baris = db.prepare(`SELECT r.id, r.status, r.question, r.jurors, r.summary, r.cost_micros AS costMicros,
        r.created_at AS createdAt, r.finished_at AS finishedAt,
        (SELECT COUNT(*) FROM council_verdicts v WHERE v.council_run_id=r.id) AS verdictCount,
        (SELECT COUNT(*) FROM council_verdicts v WHERE v.council_run_id=r.id AND v.error_code IS NOT NULL) AS failedCount,
        (SELECT LENGTH(r.material)) AS materialChars
      FROM council_runs r WHERE r.user_id=? ORDER BY r.created_at DESC, r.id DESC LIMIT 20`).all(request.user!.id) as any[];
    return {
      runs: baris.map((row) => ({ ...row, jurors: bacaJsonArray(row.jurors) })),
      catatan: "Daftar memuat 20 dewan juri terakhir milik akun Anda. Tiap juri adalah satu run nyata, jadi biaya per juri terlihat di GET /api/v1/council/runs/:id.",
    };
  });
}

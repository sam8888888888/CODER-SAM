/**
 * Wave 11B (61) — Benchmark + uji model.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 61; jangan diubah pemilik butir lain.
 *
 * Aturan butir ini:
 *   • Soal TETAP dibaca dari `apps/api/benchmark/questions.json` (maks 10 soal); tidak ada soal
 *     yang dibuat saat berjalan, supaya hasil antar waktu bisa dibandingkan.
 *   • Perkiraan biaya WAJIB dihitung dulu; menjalankan benchmark tanpa angka perkiraan yang cocok
 *     ditolak (ESTIMATE_REQUIRED / ESTIMATE_MISMATCH). Harga memakai helper butir 56 + `quoteCosts`.
 *   • Tiap pasangan (model, soal) menyimpan satu baris `benchmark_results` beserta biaya dan waktu,
 *     dan satu baris `run_usage` supaya tokennya ikut terhitung kuota.
 *   • Model yang gagal ditandai `error_code` dan TIDAK menghentikan model lain.
 *   • Kuota token dihormati lewat penjaga kuota yang sudah ada (`quotaGuard`), dan tiap pasangan
 *     ditagihkan lewat `chargeQuota` seperti run biasa.
 *
 * Catatan uang (diputuskan sendiri, dilaporkan ke lead): `cost_micros` yang disimpan dan
 * dikembalikan adalah HARGA JUAL (`run_usage.sell_cost_micros`), sama seperti perkiraan butir 56.
 * Harga dasar (modal) tersedia lewat `biayaDasarMicros`.
 *
 * Perbaikan audit Wave 11 (temuan F7 butir 61): biaya satu pasangan dibaca dari BARIS `run_usage`
 * milik pasangan itu (`WHERE id=?`), bukan `SUM(sell_cost_micros) WHERE run_id=?`. Sebelum
 * perbaikan, karena satu `run_id` dipakai semua pasangan, angka yang tersimpan = biaya kumulatif
 * (laporan 5690 micros padahal biaya sebenarnya 404 micros), dan ringkasan per model ikut membengkak.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireUser } from "../auth.js";
import { chargeQuota, quotaGuard } from "../billing.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { engine } from "../engine.js";
import { priceView, quoteCosts, sellForBaseMicros } from "../pricing.js";
import { estimateTokensFromChars } from "../wave11a/estimate.js";
import { MAX_FALLBACK_SWITCHES, fallbackModelsFor, runWithModelFallback } from "../wave11a/fallback.js";
import { audit, fail } from "../wave11a/shared.js";
import { kodeGalatJuri, selesaikanProyek } from "./council.js";

/** Asumsi panjang jawaban satu soal saat memperkirakan biaya SEBELUM dijalankan. */
export const BENCHMARK_ASSUMED_OUTPUT_TOKENS = 512;
/** Batas soal di berkas: PRD menyebut maksimal 10 soal tetap. */
export const BENCHMARK_QUESTIONS_MAX = 10;
const MODEL_NAME_MAX_CHARS = 120;
const CATATAN_MAX_CHARS = 900;

export type SoalBenchmark = { id: string; text: string };

/** Lokasi berkas soal di repo, sekaligus jalur cadangan bila proses dijalankan dari akar lain. */
function jalurSoal(): string[] {
  const diSini = dirname(fileURLToPath(import.meta.url));
  return [
    join(diSini, "..", "..", "benchmark", "questions.json"),
    join(process.cwd(), "apps", "api", "benchmark", "questions.json"),
    join(process.cwd(), "benchmark", "questions.json"),
  ];
}

let cacheSoal: { sumber: string; soal: SoalBenchmark[] } | null = null;

/**
 * Membaca soal tetap dari berkas dan memotongnya pada batas yang berlaku.
 *
 * Berkasnya milik butir 61: `{ "questions": [ { "id": "...", "text": "..." } ] }`, maksimal 10 soal.
 * Berkas yang tidak terbaca atau tidak berbentuk dilaporkan sebagai galat, bukan diam-diam diganti
 * soal karangan.
 */
export function loadBenchmarkQuestions(limit: number = config.BENCHMARK_QUESTION_LIMIT): SoalBenchmark[] {
  if (!cacheSoal) {
    let mentah = "";
    let sumber = "";
    for (const kandidat of jalurSoal()) {
      try { mentah = readFileSync(kandidat, "utf8"); sumber = kandidat; break; } catch { /* coba jalur berikutnya */ }
    }
    if (!mentah) throw new Error("BENCHMARK_QUESTIONS_MISSING");
    let parsed: unknown = null;
    try { parsed = JSON.parse(mentah); } catch { throw new Error("BENCHMARK_QUESTIONS_INVALID"); }
    const daftar = (parsed as { questions?: unknown })?.questions;
    if (!Array.isArray(daftar) || !daftar.length) throw new Error("BENCHMARK_QUESTIONS_INVALID");
    const soal = daftar.map((item, index) => {
      const baris = item as { id?: unknown; text?: unknown };
      return { id: String(baris?.id ?? `q${index + 1}`).trim(), text: String(baris?.text ?? "").trim() };
    }).filter((item) => item.id && item.text);
    if (!soal.length) throw new Error("BENCHMARK_QUESTIONS_INVALID");
    cacheSoal = { sumber, soal };
  }
  const diminta = Number(limit);
  const batas = Math.max(1, Math.min(BENCHMARK_QUESTIONS_MAX, Number.isFinite(diminta) && diminta > 0 ? Math.floor(diminta) : BENCHMARK_QUESTIONS_MAX));
  return cacheSoal.soal.slice(0, batas);
}

/** Sumber berkas soal yang benar-benar dibaca; dipakai rute untuk melaporkan keadaan apa adanya. */
export function sumberSoal(): string {
  loadBenchmarkQuestions();
  return cacheSoal?.sumber ?? "";
}

/* ------------------------------------------------------------------ prompt */

/** Prompt satu soal. Kalimatnya sama untuk semua model supaya perbandingannya adil. */
export function promptSoal(text: string): string {
  return [
    "Anda mengikuti uji model pada soal tetap.",
    "Jawab soal berikut dengan ringkas namun lengkap, langsung pada pokoknya.",
    "",
    `Soal: ${text}`,
  ].join("\n");
}

/* --------------------------------------------------------------- perkiraan */

export type PerkiraanBenchmark = {
  perkiraanBiayaMicros: number; questionCount: number; tanpaHarga: string[];
  perModel: { model: string; biayaMicros: number }[];
};

/**
 * Perkiraan biaya benchmark SEBELUM dijalankan: (jumlah model x jumlah soal) panggilan mesin.
 * Sisi masukan dihitung dari prompt soal yang sebenarnya; sisi jawaban memakai asumsi
 * `BENCHMARK_ASSUMED_OUTPUT_TOKENS` karena panjang jawaban belum diketahui.
 */
export function perkiraanBenchmark(models: string[], soal: SoalBenchmark[] = loadBenchmarkQuestions()): PerkiraanBenchmark {
  const perModel: { model: string; biayaMicros: number }[] = [];
  const tanpaHarga: string[] = [];
  let total = 0;
  for (const model of models) {
    let biaya = 0;
    let adaHarga = false;
    for (const satu of soal) {
      const quote = quoteCosts(model, { inputTokens: estimateTokensFromChars(promptSoal(satu.text).length), outputTokens: BENCHMARK_ASSUMED_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 });
      if (quote.sellMicros === null) continue;
      adaHarga = true;
      biaya += quote.sellMicros;
    }
    if (!adaHarga) { tanpaHarga.push(model); continue; }
    perModel.push({ model, biayaMicros: biaya });
    total += biaya;
  }
  return { perkiraanBiayaMicros: total, questionCount: soal.length, tanpaHarga, perModel };
}

/** Catatan sebelum jalan: asal angka perkiraan dan batas yang berlaku. */
export function catatanPerkiraan(perkiraan: PerkiraanBenchmark): string {
  const bagian = [
    `Perkiraan ${perkiraan.perkiraanBiayaMicros} micros dihitung dari harga jual untuk ${perkiraan.perModel.length} model dikali ${perkiraan.questionCount} soal tetap.`,
    `Panjang jawaban belum diketahui, jadi dipakai asumsi ${BENCHMARK_ASSUMED_OUTPUT_TOKENS} token jawaban per soal. Angka ini perkiraan, bukan tagihan.`,
    `Batas platform: maksimal ${config.BENCHMARK_MAX_MODELS} model dan ${config.BENCHMARK_QUESTION_LIMIT} soal.`,
  ];
  if (perkiraan.tanpaHarga.length) bagian.push(`Model tanpa harga di katalog: ${perkiraan.tanpaHarga.join(", ")}.`);
  return bagian.join(" ").slice(0, CATATAN_MAX_CHARS);
}

/** Catatan sesudah jalan: biaya nyata vs perkiraan, dijelaskan apa adanya. */
export function catatanHasilBenchmark(input: {
  perkiraanBiayaMicros: number; costMicros: number; biayaDasarMicros: number;
  soalTerjawab: number; soalGagal: number; inputTokens: number; outputTokens: number;
}): string {
  const selisih = input.costMicros - input.perkiraanBiayaMicros;
  const arah = selisih === 0 ? "sama dengan perkiraan" : (selisih > 0 ? "lebih mahal dari perkiraan" : "lebih murah dari perkiraan");
  const rataJawaban = input.soalTerjawab ? Math.round((input.outputTokens / input.soalTerjawab) * 10) / 10 : 0;
  const rataMasukan = input.soalTerjawab ? Math.round(input.inputTokens / input.soalTerjawab) : 0;
  return [
    `Biaya nyata ${input.costMicros} micros (harga jual) ${arah} ${input.perkiraanBiayaMicros} micros; selisih ${Math.abs(selisih)} micros.`,
    `Harga dasar (modal) seluruh panggilan: ${input.biayaDasarMicros} micros.`,
    `Soal terjawab ${input.soalTerjawab}, gagal ${input.soalGagal}.`,
    `Pemakaian nyata rata-rata ${rataMasukan} token masukan dan ${rataJawaban} token jawaban per soal, sedangkan perkiraan memakai asumsi ${BENCHMARK_ASSUMED_OUTPUT_TOKENS} token jawaban per soal.`,
    "Selisih berasal dari panjang jawaban nyata yang berbeda dari asumsi, bukan dari harga yang berbeda.",
  ].join(" ").slice(0, CATATAN_MAX_CHARS);
}

/* -------------------------------------------------------------------- skor */

const KATA_MIN_PANJANG = 4;
const STOPWORD = new Set(["yang", "untuk", "dengan", "tidak", "dalam", "pada", "dari", "akan", "atau", "juga", "bisa", "agar", "karena", "adalah", "sudah", "masih", "bila", "jika", "kode", "model", "ini", "itu"]);

function kataKunci(teks: string): Set<string> {
  return new Set(String(teks ?? "").toLowerCase().split(/[^a-z0-9]+/i)
    .map((kata) => kata.trim())
    .filter((kata) => kata.length >= KATA_MIN_PANJANG && !STOPWORD.has(kata) && !/^\d+$/.test(kata)));
}

/**
 * Skor kesepakatan antar model untuk SATU soal, dalam persen 0-100.
 *
 * Angkanya = bagian kata kunci jawaban ini yang juga muncul di jawaban model LAIN untuk soal yang
 * sama. Ini ukuran KESEPAKATAN, bukan ukuran kebenaran: tanpa jawaban kunci, kebenaran tidak bisa
 * dinilai dan itu ditulis apa adanya di catatan. Bila hanya satu model yang menjawab, skornya null.
 */
export function skorKesepakatan(jawaban: string[], indeks: number): number | null {
  const semua = jawaban.map((teks) => kataKunci(teks));
  const ini = semua[indeks];
  if (!ini || ini.size === 0) return null;
  const lain = new Set<string>();
  for (let i = 0; i < semua.length; i += 1) {
    if (i === indeks) continue;
    for (const kata of semua[i]) lain.add(kata);
  }
  if (lain.size === 0) return null;
  let cocok = 0;
  for (const kata of ini) if (lain.has(kata)) cocok += 1;
  return Math.round((cocok / ini.size) * 100);
}

/* ------------------------------------------------------------- pencatatan run */

type PemakaianBenchmark = { runId: string; projectId: string; userId: string; model: string; prompt: string; answer: string; usage: unknown };

/**
 * Menulis satu baris `run_usage` per panggilan mesin, dengan aturan yang sama seperti run biasa.
 *
 * Mengembalikan id baris yang baru ditulis. Satu `run_id` dipakai bersama SEMUA pasangan
 * (model x soal), jadi biaya satu pasangan hanya boleh dibaca dari barisnya sendiri; membaca
 * `SUM(...) WHERE run_id=?` akan menumpuk biaya pasangan sebelumnya (audit Wave 11 butir 61, F7).
 */
function catatPemakaian(input: PemakaianBenchmark): string {
  const dilaporkan = input.usage && typeof input.usage === "object" ? input.usage as Record<string, unknown> : null;
  const adaToken = typeof dilaporkan?.inputTokens === "number" || typeof dilaporkan?.outputTokens === "number";
  const inputTokens = adaToken ? Math.round(Number(dilaporkan?.inputTokens ?? 0)) : estimateTokensFromChars(input.prompt.length);
  const outputTokens = adaToken ? Math.round(Number(dilaporkan?.outputTokens ?? 0)) : estimateTokensFromChars(input.answer.length);
  const totalTokens = typeof dilaporkan?.totalTokens === "number" ? Math.round(Number(dilaporkan.totalTokens)) : inputTokens + outputTokens;
  const model = typeof dilaporkan?.model === "string" && dilaporkan.model ? dilaporkan.model : input.model;
  const quote = quoteCosts(model, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const biayaDasar = !adaToken ? null : (typeof dilaporkan?.costMicros === "number" ? Math.round(Number(dilaporkan.costMicros)) : quote.baseMicros);
  const idBaris = randomUUID();
  db.prepare(`INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,sell_cost_micros,estimated,raw_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    idBaris, input.runId, input.projectId, model, priceView(model).provider ?? config.PRIME_AGENT_PROVIDER ?? null,
    inputTokens, outputTokens, 0, 0, totalTokens, biayaDasar, sellForBaseMicros(biayaDasar, quote.markup),
    adaToken ? 0 : 1, dilaporkan ? JSON.stringify(dilaporkan.raw ?? null).slice(0, 4000) : null, new Date().toISOString(),
  );
  chargeQuota(input.userId, totalTokens);
  return idBaris;
}

type HasilSatuPanggilan = { answer: string; costMicros: number; baseMicros: number; latencyMs: number; errorCode: string | null; modelDipakai: string };

/** Satu panggilan mesin untuk sepasang (model, soal); kegagalan dikembalikan sebagai hasil, bukan dilempar. */
async function panggilSatu(input: { userId: string; runId: string; projectId: string; model: string; soal: SoalBenchmark }): Promise<HasilSatuPanggilan> {
  const prompt = promptSoal(input.soal.text);
  const jamMulai = Date.now();
  try {
    const hasil = await runWithModelFallback({
      primary: input.model,
      fallbacks: fallbackModelsFor(input.userId),
      maxSwitches: Math.min(config.ENGINE_FALLBACK_MAX_SWITCHES, MAX_FALLBACK_SWITCHES),
      consume: async (percobaan) => {
        let potongan = "";
        let pemakaian: unknown = null;
        for await (const peristiwa of engine.run({
          runId: input.runId, sessionId: `${input.runId}:${input.soal.id}`, prompt, model: percobaan,
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
    const idBarisUsage = catatPemakaian({ runId: input.runId, projectId: input.projectId, userId: input.userId, model: hasil.model, prompt, answer: hasil.text, usage: hasil.usage });
    // Biaya dibaca kembali dari tabel setelah barisnya ditulis, supaya angkanya berasal dari basis data.
    // Dibaca PER BARIS (`WHERE id=?`), bukan `SUM(...) WHERE run_id=?`: run ini menampung semua
    // pasangan, jadi SUM akan menumpuk biaya pasangan sebelumnya ke pasangan yang sedang dihitung
    // (audit Wave 11 butir 61 F7: laporan 5690 micros vs 404 micros sebenarnya).
    const biaya = db.prepare("SELECT COALESCE(cost_micros,0) AS baseMicros, COALESCE(sell_cost_micros,0) AS sellMicros, created_at AS terakhir FROM run_usage WHERE id=?").get(idBarisUsage) as { baseMicros: number; sellMicros: number; terakhir: string };
    return { answer: hasil.text, costMicros: biaya.sellMicros, baseMicros: biaya.baseMicros, latencyMs: Date.now() - jamMulai, errorCode: null, modelDipakai: hasil.model };
  } catch (galat) {
    const pesan = galat instanceof Error ? galat.message : "ENGINE_FAILED";
    return { answer: "", costMicros: 0, baseMicros: 0, latencyMs: Date.now() - jamMulai, errorCode: kodeGalatJuri(pesan), modelDipakai: input.model };
  }
}

/* -------------------------------------------------------------------- rute */

/** Memvalidasi daftar model: mengembalikan pesan galat atau daftar bersih. */
export function periksaModel(mentah: unknown): { error?: { code: string; message: string }; models?: string[] } {
  if (!Array.isArray(mentah) || !mentah.length) return { error: { code: "MODEL_REQUIRED", message: "Sebutkan minimal satu model yang mau diuji." } };
  const bersih = mentah.map((item) => String(item ?? "").trim());
  if (bersih.length > config.BENCHMARK_MAX_MODELS) {
    return { error: { code: "BENCHMARK_MODEL_LIMIT", message: `Benchmark maksimal ${config.BENCHMARK_MAX_MODELS} model.` } };
  }
  if (bersih.some((nama) => !nama || nama.length > MODEL_NAME_MAX_CHARS)) {
    return { error: { code: "INVALID_MODEL", message: `Nama model tidak boleh kosong dan maksimal ${MODEL_NAME_MAX_CHARS} karakter.` } };
  }
  if (new Set(bersih).size !== bersih.length) {
    return { error: { code: "INVALID_MODEL", message: "Model yang sama tidak boleh diuji dua kali." } };
  }
  const tanpaHarga = bersih.filter((nama) => priceView(nama).source === "none");
  if (tanpaHarga.length) {
    return { error: { code: "INVALID_MODEL", message: `Model ${tanpaHarga.join(", ")} tidak ada di katalog harga, jadi biayanya tidak bisa dihitung.` } };
  }
  return { models: bersih };
}

/** Ringkasan per model: dijawab, gagal, biaya, dan rata-rata waktu. */
export function ringkasPerModel(baris: { model: string; errorCode: string | null; costMicros: number; latencyMs: number | null }[]): { model: string; dijawab: number; gagal: number; biayaMicros: number; rataLatencyMs: number | null }[] {
  const urut: string[] = [];
  const peta = new Map<string, { model: string; dijawab: number; gagal: number; biayaMicros: number; totalLatency: number; jumlahLatency: number }>();
  for (const satu of baris) {
    if (!peta.has(satu.model)) {
      urut.push(satu.model);
      peta.set(satu.model, { model: satu.model, dijawab: 0, gagal: 0, biayaMicros: 0, totalLatency: 0, jumlahLatency: 0 });
    }
    const isi = peta.get(satu.model)!;
    if (satu.errorCode) isi.gagal += 1;
    else {
      isi.dijawab += 1;
      if (typeof satu.latencyMs === "number") { isi.totalLatency += satu.latencyMs; isi.jumlahLatency += 1; }
    }
    isi.biayaMicros += satu.costMicros;
  }
  return urut.map((nama) => {
    const isi = peta.get(nama)!;
    return { model: isi.model, dijawab: isi.dijawab, gagal: isi.gagal, biayaMicros: isi.biayaMicros, rataLatencyMs: isi.jumlahLatency ? Math.round(isi.totalLatency / isi.jumlahLatency) : null };
  });
}

/** Menandai baris `runs` milik satu benchmark: id benchmark ditulis di prompt supaya bisa dicari lagi. */
export function promptRunBenchmark(benchmarkRunId: string, jumlahModel: number, jumlahSoal: number): string {
  return `Benchmark ${benchmarkRunId} - ${jumlahModel} model x ${jumlahSoal} soal`;
}

function cariRunBenchmark(benchmarkRunId: string): { id: string; projectId: string } | null {
  const baris = db.prepare("SELECT id, project_id AS projectId FROM runs WHERE prompt LIKE ? ORDER BY created_at ASC LIMIT 1")
    .get(`Benchmark ${benchmarkRunId} - %`) as { id: string; projectId: string } | undefined;
  return baris ?? null;
}

/** Memasang rute benchmark: POST /api/v1/benchmark/estimate, POST /api/v1/benchmark/run, GET /api/v1/benchmark/runs/:id. */
export function registerBenchmarkRoutes(app: any): void {
  app.post("/api/v1/benchmark/estimate", { preHandler: requireUser }, async (request: any, reply: any) => {
    const model = periksaModel(request.body?.models);
    if (model.error) return fail(reply, 400, model.error.code, model.error.message);
    let soal: SoalBenchmark[];
    try { soal = loadBenchmarkQuestions(); }
    catch { return fail(reply, 500, "BENCHMARK_QUESTIONS_MISSING", "Berkas soal benchmark tidak terbaca di server, jadi perkiraan tidak bisa dihitung."); }
    const perkiraan = perkiraanBenchmark(model.models!, soal);
    return {
      models: model.models,
      questionCount: perkiraan.questionCount,
      perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros,
      perModel: perkiraan.perModel,
      sumberSoal: sumberSoal(),
      catatan: catatanPerkiraan(perkiraan),
    };
  });

  app.post("/api/v1/benchmark/run", { preHandler: requireUser }, async (request: any, reply: any) => {
    const user = request.user!;
    const model = periksaModel(request.body?.models);
    if (model.error) return fail(reply, 400, model.error.code, model.error.message);
    let soal: SoalBenchmark[];
    try { soal = loadBenchmarkQuestions(); }
    catch { return fail(reply, 500, "BENCHMARK_QUESTIONS_MISSING", "Berkas soal benchmark tidak terbaca di server, jadi benchmark tidak bisa dijalankan."); }
    const perkiraan = perkiraanBenchmark(model.models!, soal);

    const diKirim = request.body?.estimatedCostMicros;
    if (diKirim === undefined || diKirim === null || !Number.isFinite(Number(diKirim))) {
      return fail(reply, 400, "ESTIMATE_REQUIRED", "Hitung dulu perkiraan biaya sebelum menjalankan benchmark.");
    }
    if (Math.round(Number(diKirim)) !== perkiraan.perkiraanBiayaMicros) {
      return fail(reply, 400, "ESTIMATE_MISMATCH", `Perkiraan biaya yang dikirim (${Math.round(Number(diKirim))} micros) tidak sama dengan hitungan untuk daftar model itu.`, { perkiraanSekarang: perkiraan.perkiraanBiayaMicros });
    }

    const anchor = selesaikanProyek(user.id, undefined, undefined);
    if ("error" in anchor) return fail(reply, 400, "PROJECT_REQUIRED", "Buat proyek dulu: biaya tiap panggilan benchmark dicatat pada run di dalam proyek.");

    const blokir = quotaGuard(user.id, anchor.workspaceId);
    if (blokir) return fail(reply, blokir.status, blokir.error, String(blokir.detail?.message ?? "Kuota token paket Anda sudah habis."), blokir.detail ?? {});

    const benchmarkRunId = randomUUID();
    const runId = randomUUID();
    const models = model.models!;
    const now = new Date().toISOString();
    // Satu baris `runs` menandai SATU benchmark; tiap pasangan menulis barisnya sendiri di run_usage
    // (kolom run_usage.project_id wajib terisi, jadi benchmark memakai proyek pertama milik pengguna).
    // Karena `run_id` dipakai bersama, biaya tiap pasangan dibaca dari baris run_usage pasangan itu
    // sendiri (lihat `panggilSatu`), bukan dari jumlah seluruh run.
    db.prepare("INSERT INTO runs (id,project_id,status,prompt,model,created_at) VALUES (?,?,?,?,?,?)")
      .run(runId, anchor.projectId, "running", promptRunBenchmark(benchmarkRunId, models.length, soal.length), models[0] ?? null, now);
    db.prepare(`INSERT INTO benchmark_runs (id,user_id,status,model_list,question_count,estimated_cost_micros,cost_micros,created_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(benchmarkRunId, user.id, "running", JSON.stringify(models), soal.length, perkiraan.perkiraanBiayaMicros, 0, now, null);
    audit(user.id, "benchmark.run_started", { benchmarkRunId, models, questionCount: soal.length, perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros });

    type Baris = { id: string; model: string; soal: SoalBenchmark; answer: string; score: number | null; costMicros: number; latencyMs: number; errorCode: string | null };
    const baris: Baris[] = [];
    let kuotaHabis = false;
    for (const nama of models) {
      for (const satu of soal) {
        if (!kuotaHabis) {
          const blokirPasangan = quotaGuard(user.id, anchor.workspaceId);
          if (blokirPasangan) kuotaHabis = true;
        }
        if (kuotaHabis) {
          baris.push({ id: randomUUID(), model: nama, soal: satu, answer: "", score: null, costMicros: 0, latencyMs: 0, errorCode: "QUOTA_EXCEEDED" });
          continue;
        }
        const hasil = await panggilSatu({ userId: user.id, runId, projectId: anchor.projectId, model: nama, soal: satu });
        baris.push({ id: randomUUID(), model: nama, soal: satu, answer: hasil.answer, score: null, costMicros: hasil.costMicros, latencyMs: hasil.latencyMs, errorCode: hasil.errorCode });
      }
    }

    // Skor kesepakatan dihitung setelah semua jawaban terkumpul: butuh jawaban model lain pada soal yang sama.
    for (const satu of soal) {
      const kelompok = baris.filter((row) => row.soal.id === satu.id && !row.errorCode);
      const jawaban = kelompok.map((row) => row.answer);
      kelompok.forEach((row, indeks) => { row.score = skorKesepakatan(jawaban, indeks); });
    }

    const sekarang = new Date().toISOString();
    for (const satu of baris) {
      db.prepare(`INSERT INTO benchmark_results (id,benchmark_run_id,model,question_id,question,answer,score,latency_ms,cost_micros,error_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        satu.id, benchmarkRunId, satu.model, satu.soal.id, satu.soal.text, satu.answer,
        satu.score, satu.latencyMs, satu.costMicros, satu.errorCode, sekarang,
      );
    }
    const berhasil = baris.filter((row) => !row.errorCode);
    const costMicros = baris.reduce((total, row) => total + row.costMicros, 0);
    const status = berhasil.length ? "completed" : "failed";
    const ringkasan = ringkasPerModel(baris);
    db.prepare("UPDATE benchmark_runs SET status=?, cost_micros=?, finished_at=? WHERE id=?").run(status, costMicros, sekarang, benchmarkRunId);
    db.prepare("UPDATE runs SET status=?, result=?, finished_at=? WHERE id=?")
      .run(berhasil.length ? "completed" : "failed", `Benchmark ${models.length} model x ${soal.length} soal: ${berhasil.length} jawaban tersimpan.`, sekarang, runId);
    audit(user.id, "benchmark.run_finished", { benchmarkRunId, status, models, soal: soal.length, costMicros, perkiraanBiayaMicros: perkiraan.perkiraanBiayaMicros });

    return reply.code(202).send({
      benchmarkRunId,
      status,
      models,
      questionCount: soal.length,
      estimatedCostMicros: perkiraan.perkiraanBiayaMicros,
      catatan: catatanPerkiraan(perkiraan),
      costMicros,
      ringkasan,
    });
  });

  app.get("/api/v1/benchmark/runs/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const baris = db.prepare(`SELECT id, status, model_list AS modelList, question_count AS questionCount,
        estimated_cost_micros AS estimatedCostMicros, cost_micros AS costMicros, created_at AS createdAt, finished_at AS finishedAt
      FROM benchmark_runs WHERE id=? AND user_id=?`).get(request.params.id, request.user!.id) as {
        id: string; status: string; modelList: string; questionCount: number; estimatedCostMicros: number;
        costMicros: number; createdAt: string; finishedAt: string | null;
      } | undefined;
    if (!baris) return fail(reply, 404, "BENCHMARK_NOT_FOUND", "Benchmark itu tidak ada atau bukan milik Anda.");
    const hasil = db.prepare(`SELECT id, model, question_id AS questionId, question, answer, score, latency_ms AS latencyMs,
        cost_micros AS costMicros, error_code AS errorCode, created_at AS createdAt FROM benchmark_results
      WHERE benchmark_run_id=? ORDER BY model ASC, question_id ASC, id ASC`)
      .all(baris.id) as { id: string; model: string; errorCode: string | null; costMicros: number; latencyMs: number | null }[];
    const run = cariRunBenchmark(baris.id);
    const dasar = run
      ? db.prepare(`SELECT COALESCE(SUM(cost_micros),0) AS baseMicros, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
          FROM run_usage WHERE run_id=?`).get(run.id) as { baseMicros: number; inputTokens: number; outputTokens: number }
      : { baseMicros: 0, inputTokens: 0, outputTokens: 0 };
    const terjawab = hasil.filter((row) => !row.errorCode);
    return {
      id: baris.id,
      status: baris.status,
      models: JSON.parse(baris.modelList) as string[],
      questionCount: baris.questionCount,
      estimatedCostMicros: baris.estimatedCostMicros,
      costMicros: baris.costMicros,
      createdAt: baris.createdAt,
      finishedAt: baris.finishedAt,
      results: hasil,
      ringkasan: { perModel: ringkasPerModel(hasil) },
      biayaDasarMicros: dasar.baseMicros,
      catatan: catatanHasilBenchmark({
        perkiraanBiayaMicros: baris.estimatedCostMicros,
        costMicros: baris.costMicros,
        biayaDasarMicros: dasar.baseMicros,
        soalTerjawab: terjawab.length,
        soalGagal: hasil.length - terjawab.length,
        inputTokens: dasar.inputTokens,
        outputTokens: dasar.outputTokens,
      }),
    };
  });
}

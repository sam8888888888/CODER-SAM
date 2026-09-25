/**
 * Wave 11A (butir 56): kalkulator biaya di Playground.
 *
 * Hitungannya memakai HARGA JUAL (harga dasar x markup pemilik), yaitu angka yang benar-benar
 * ditagihkan. Rute ini TIDAK menulis `runs`, `user_usage`, atau catatan audit, jadi menekan tombol
 * "Hitung saja" tidak menambah pemakaian.
 */
import { requireUser } from "../auth.js";
import { usdToIdrRate, quotaState } from "../billing.js";
import { priceView, pricingSettings } from "../pricing.js";
import { fail } from "./shared.js";

/** Perkiraan token dari panjang teks: aturan yang sama dipakai `recordRunUsage` saat mesin diam. */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(Math.max(0, chars) / 4));
}

export function registerEstimateRoutes(app: any): void {
  app.post("/api/v1/playground/estimate", { preHandler: requireUser }, async (request: any, reply: any) => {
    const model = String(request.body?.model ?? "").trim();
    if (!model) return fail(reply, 400, "MODEL_REQUIRED", "Sebutkan model yang ingin dihitung.");
    const view = priceView(model);
    if (view.source === "none") return fail(reply, 404, "MODEL_UNKNOWN", `Model '${model}' tidak ada di katalog harga. Cek ejaan namanya.`);
    const prompt = String(request.body?.prompt ?? "");
    const inputChars = Number.isFinite(Number(request.body?.inputChars)) ? Number(request.body.inputChars) : prompt.length;
    const inputTokens = estimateTokensFromChars(inputChars);
    const outputTokens = Number.isFinite(Number(request.body?.outputTokens)) ? Math.max(0, Math.round(Number(request.body.outputTokens))) : 0;
    const runs = Number.isFinite(Number(request.body?.runs)) ? Math.max(1, Math.min(100, Math.round(Number(request.body.runs)))) : 1;
    // Harga jual per satu juta token (USD), lalu dikonversi ke mikrodolar dan ke rupiah.
    const perMillion = (rate: number, tokens: number) => (tokens / 1e6) * rate;
    const sellUsd = perMillion(view.sell.input, inputTokens) + perMillion(view.sell.output, outputTokens);
    const estimatedCostMicros = Math.round(sellUsd * 1e6) * runs;
    const rate = usdToIdrRate();
    const estimatedCostIdr = Math.round((estimatedCostMicros / 1e6) * rate);
    const quota = quotaState(request.user!.id);
    const dailyCeiling = quota.dailyLimit > 0 ? quota.dailyLimit + quota.creditTokens : 0;
    const percentOfDailyQuota = dailyCeiling > 0 ? Math.round(((inputTokens * runs) / dailyCeiling) * 10000) / 100 : null;
    return {
      model,
      promptChars: inputChars,
      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, runs },
      hargaJualPerJuta: { input: view.sell.input, output: view.sell.output, mataUang: "USD" },
      markup: pricingSettings().markup,
      priceSource: view.source,
      estimatedCostMicros,
      estimatedCostIdr,
      usdIdrRate: rate,
      percentOfDailyQuota,
      dailyLimitTokens: quota.dailyLimit,
      catatan: outputTokens
        ? "Perkiraan memakai harga jual (sudah termasuk markup) dan token keluaran yang Anda sebutkan. Angka ini perkiraan, bukan tagihan."
        : "Perkiraan hanya menghitung token masukan karena panjang jawaban belum diketahui (sebut 'outputTokens' untuk memperhitungkannya). Angka ini perkiraan, bukan tagihan.",
      tanpaEfekSamping: true,
    };
  });
}

/**
 * Wave 11A (butir 56): kalkulator biaya di Playground.
 *
 * Perbaikan audit butir 56 (26 Sep 2026): perhitungan memakai `quoteCosts()` dari `pricing.ts`,
 * yaitu fungsi yang SAMA dengan jalur penagihan nyata (`recordRunUsage` di server.ts, rute
 * playground, council, benchmark). Sebelumnya berkas ini mengalikan sendiri `priceView().sell`,
 * sehingga faktor tarif puncak vendor (`DEEPSEEK_PEAK_MULTIPLIER`, dua kali tarif luar puncak)
 * tidak ikut terhitung: pada jam puncak DeepSeek perkiraan bisa SEPARUH tagihan nyata. Tidak ada
 * rumus harga kedua di berkas ini.
 *
 * Rute ini TIDAK menulis `runs`, `user_usage`, atau catatan audit, jadi menekan tombol
 * "Hitung saja" tidak menambah pemakaian.
 */
import { requireUser } from "../auth.js";
import { usdToIdrRate, quotaState } from "../billing.js";
import { priceView, quoteCosts } from "../pricing.js";
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
    // Satu sumber kebenaran: `quoteCosts` menghitung harga pokok (termasuk faktor tarif puncak
    // vendor bila saat ini berlaku) lalu harga jual = pokok x markup pemilik. Jalur penagihan nyata
    // memakai fungsi yang sama, jadi perkiraan tidak bisa lagi menyimpang dari tagihan.
    const quote = quoteCosts(model, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (quote.sellMicros === null) return fail(reply, 404, "MODEL_UNKNOWN", `Model '${model}' tidak ada di katalog harga. Cek ejaan namanya.`);
    const estimatedCostMicros = quote.sellMicros * runs;
    const rate = usdToIdrRate();
    const estimatedCostIdr = Math.round((estimatedCostMicros / 1e6) * rate);
    const quota = quotaState(request.user!.id);
    const dailyCeiling = quota.dailyLimit > 0 ? quota.dailyLimit + quota.creditTokens : 0;
    const percentOfDailyQuota = dailyCeiling > 0 ? Math.round(((inputTokens * runs) / dailyCeiling) * 10000) / 100 : null;
    const catatanDasar = outputTokens
      ? "Perkiraan memakai harga jual (sudah termasuk markup) dan token keluaran yang Anda sebutkan. Angka ini perkiraan, bukan tagihan."
      : "Perkiraan hanya menghitung token masukan karena panjang jawaban belum diketahui (sebut 'outputTokens' untuk memperhitungkannya). Angka ini perkiraan, bukan tagihan.";
    return {
      model,
      promptChars: inputChars,
      tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, runs },
      // Daftar harga jual per 1 juta token TANPA faktor puncak; tarif yang benar-benar dipakai
      // dilaporkan terpisah di `tarifPuncak`, supaya angka lebih besar tidak muncul tanpa sebab.
      hargaJualPerJuta: { input: view.sell.input, output: view.sell.output, mataUang: "USD" },
      markup: quote.markup,
      priceSource: view.source,
      /** Apakah angka ini memakai tarif puncak vendor (mis. DeepSeek x2) saat dihitung. */
      tarifPuncak: { aktif: quote.peak, faktor: quote.peakMultiplier, alasan: quote.peakReason },
      estimatedCostMicros,
      estimatedCostIdr,
      usdIdrRate: rate,
      percentOfDailyQuota,
      dailyLimitTokens: quota.dailyLimit,
      catatan: quote.peak
        ? `${catatanDasar} Perhitungan ini memakai tarif puncak vendor (x${quote.peakMultiplier}): ${quote.peakReason}. Di luar jam puncak angkanya lebih kecil.`
        : catatanDasar,
      tanpaEfekSamping: true,
    };
  });
}

/**
 * Harga resmi vendor vs katalog mesin (butir 19, v0.20.2).
 *
 * Kenapa berkas ini ada: `model-prices.ts` adalah berkas yang DIHASILKAN dari katalog paket
 * prime-agent, dan katalog itu memuat harga DeepSeek yang sudah tidak berlaku. Akibatnya
 * `cost_micros` (harga pokok) tercatat lebih kecil daripada tagihan DeepSeek yang sebenarnya,
 * dan angka itu ikut terbawa ke `sell_cost_micros`.
 *
 * Berkas ini adalah lapisan koreksi yang ditulis tangan, dengan tanggal pemeriksaan dan alamat
 * sumbernya, supaya tidak hilang saat katalog mesin disegarkan ulang.
 *
 * Sumber (diperiksa 21 Sep 2026): https://api-docs.deepseek.com/quick_start/pricing/
 *  - Nama model resmi sekarang `deepseek-flash` (versi DeepSeek-V4.1-Flash) dan `deepseek-v4-pro`.
 *  - Nama lama `deepseek-v4-flash` dan `deepseek-v4-flash-vision-exp` masih diterima, tetapi
 *    dilayani oleh V4.1-Flash dan DITAGIH dengan harga Flash.
 *  - Tarif puncak (peak) dua kali tarif luar puncak. Jam puncak: 01:00-04:00 dan 06:00-10:00 UTC,
 *    Senin-Jumat, di luar hari libur nasional Tiongkok. Selebihnya tarif luar puncak.
 *  - Harga di bawah adalah tarif LUAR PUNCAK dalam dolar AS per 1 juta token.
 */
import type { ModelPrice } from "./model-prices.js";

export type VendorPrice = ModelPrice & {
  /** Kapan angka ini diperiksa dari halaman resmi vendor. */
  checkedAt: string;
  /** Alamat halaman resmi tempat angka ini diambil. */
  source: string;
  /** Nama model resmi yang menggantikan id ini, bila id ini sudah warisan. */
  replacedBy?: string;
  /** Catatan singkat kenapa angkanya berbeda dari katalog mesin. */
  note: string;
};

const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
const CHECKED_AT = "2026-09-21";

/**
 * Harga resmi vendor, tarif luar puncak. Kuncinya adalah id model seperti yang dipakai mesin.
 * `deepseek-flash` sengaja ikut: katalog mesin 0.9.4 belum mengenalnya, dan tanpa baris ini
 * pemakaian model bernama resmi akan tercatat sebagai "tanpa harga" (biaya tidak terhitung).
 */
export const VENDOR_PRICES: Record<string, VendorPrice> = {
  "deepseek-flash": {
    provider: "deepseek", input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0,
    checkedAt: CHECKED_AT, source: DEEPSEEK_PRICING_URL,
    note: "Nama resmi DeepSeek-V4.1-Flash; belum ada di katalog mesin 0.9.4.",
  },
  "deepseek-v4-flash": {
    provider: "deepseek", input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0,
    checkedAt: CHECKED_AT, source: DEEPSEEK_PRICING_URL, replacedBy: "deepseek-flash",
    note: "Nama warisan, ditagih dengan harga Flash. Katalog mesin menulis input 0,14 / output 0,28.",
  },
  "deepseek-v4-flash-vision-exp": {
    provider: "deepseek", input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0,
    checkedAt: CHECKED_AT, source: DEEPSEEK_PRICING_URL, replacedBy: "deepseek-flash",
    note: "Nama warisan; permintaan dilayani V4.1-Flash dan ditagih harga Flash.",
  },
  "deepseek-v4-pro": {
    provider: "deepseek", input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0,
    checkedAt: CHECKED_AT, source: DEEPSEEK_PRICING_URL,
    note: "Katalog mesin menulis input 0,435 / output 0,87 - lebih murah dari tarif resmi.",
  },
};

/** Tarif puncak DeepSeek = dua kali tarif luar puncak. */
export const DEEPSEEK_PEAK_MULTIPLIER = 2;

/** Jam puncak DeepSeek dalam UTC: 01:00-04:00 dan 06:00-10:00, Senin-Jumat. */
export const DEEPSEEK_PEAK_WINDOWS_UTC: readonly [number, number][] = [[1, 4], [6, 10]];

export type PeakInfo = {
  peak: boolean;
  multiplier: number;
  /** Jam UTC saat pemeriksaan, supaya hasilnya bisa diperiksa ulang. */
  hourUtc: number;
  /** 0 = Minggu ... 6 = Sabtu (UTC). */
  dayUtc: number;
  reason: string;
};

/**
 * Apakah satu saat masuk tarif puncak DeepSeek. Hari libur nasional Tiongkok tidak bisa dihitung
 * dari jam saja, jadi hitungan ini bisa MENAKSIR TERLALU TINGGI pada jam puncak di hari libur.
 */
export function deepSeekPeak(at: Date | number = Date.now(), model?: string | null): PeakInfo {
  const date = at instanceof Date ? at : new Date(at);
  const hourUtc = date.getUTCHours();
  const dayUtc = date.getUTCDay();
  const looksLikeDeepSeek = model === undefined || model === null || String(model).toLowerCase().includes("deepseek");
  if (!looksLikeDeepSeek) {
    return { peak: false, multiplier: 1, hourUtc, dayUtc, reason: "model bukan DeepSeek" };
  }
  const weekday = dayUtc >= 1 && dayUtc <= 5;
  const inWindow = DEEPSEEK_PEAK_WINDOWS_UTC.some(([from, to]) => hourUtc >= from && hourUtc < to);
  const peak = weekday && inWindow;
  return {
    peak,
    multiplier: peak ? DEEPSEEK_PEAK_MULTIPLIER : 1,
    hourUtc,
    dayUtc,
    reason: peak
      ? `jam puncak (${hourUtc}:00 UTC, hari ${dayUtc})`
      : weekday ? `di luar jendela puncak (${hourUtc}:00 UTC)` : "akhir pekan (tarif luar puncak)",
  };
}

/** Harga vendor untuk satu model, atau null bila vendor ini tidak punya koreksi untuk model itu. */
export function vendorPriceFor(model?: string | null): VendorPrice | null {
  if (!model) return null;
  return VENDOR_PRICES[model] ?? null;
}

/** Daftar id model yang punya koreksi harga vendor (dipakai halaman harga dan uji). */
export function vendorPriceCatalogue(): { model: string; price: VendorPrice }[] {
  return Object.entries(VENDOR_PRICES).map(([model, price]) => ({ model, price }));
}

export type VendorCounts = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/**
 * Biaya satu pemakaian menurut harga resmi vendor, dalam sepersejuta dolar AS.
 * Mengembalikan null bila vendor ini tidak punya koreksi untuk model tersebut, supaya pemanggil
 * bisa jatuh ke katalog mesin - bukan menebak.
 */
export function vendorCostMicros(model: string | undefined | null, counts: VendorCounts, at: Date | number = Date.now()): { micros: number; peak: PeakInfo; price: VendorPrice } | null {
  const price = vendorPriceFor(model);
  if (!price) return null;
  const peak = deepSeekPeak(at, model);
  const usd = ((counts.inputTokens ?? 0) / 1e6) * price.input
    + ((counts.outputTokens ?? 0) / 1e6) * price.output
    + ((counts.cacheReadTokens ?? 0) / 1e6) * price.cacheRead
    + ((counts.cacheWriteTokens ?? 0) / 1e6) * price.cacheWrite;
  return { micros: Math.round(usd * peak.multiplier * 1e6), peak, price };
}

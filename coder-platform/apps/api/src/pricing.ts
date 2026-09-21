/**
 * AI price console (Wave 9, item 19).
 *
 * The engine ships a published price list (model-prices.ts, USD per million tokens). Those are the
 * prices the platform itself is charged upstream. This module lets the owner of the platform:
 *   - replace the published price of any model with the real price actually paid,
 *   - set one markup factor that is applied on top of every model, so the platform can resell.
 *
 * Two numbers are kept apart on purpose:
 *   - cost_micros      = what the platform pays upstream (cost of goods). The markup never touches it.
 *   - sell_cost_micros = cost_micros * markup, the amount billed to the customer.
 * A markup of 1 makes both equal, so every existing row keeps its meaning.
 */
import { db } from "./db.js";
import { MODEL_PRICES, priceForModel as catalogPrice, type ModelPrice } from "./model-prices.js";
import { DEEPSEEK_PEAK_MULTIPLIER, deepSeekPeak, vendorPriceFor, type VendorPrice } from "./vendor-prices.js";

export type PriceNumbers = { input: number; output: number; cacheRead: number; cacheWrite: number };
/**
 * Dari mana harga pokok diambil: `override` = keputusan pemilik platform, `vendor` = harga resmi
 * vendor (butir 19, lapisan koreksi `vendor-prices.ts`), `catalog` = katalog mesin, `none` = tidak ada.
 */
export type PriceSource = "catalog" | "override" | "vendor" | "none";
export type PriceView = {
  model: string;
  provider: string | null;
  source: PriceSource;
  base: PriceNumbers;
  sell: PriceNumbers;
  updatedAt: string | null;
  updatedBy: string | null;
  /**
   * Butir 19: keterangan harga resmi vendor untuk model ini, supaya halaman harga bisa menunjukkan
   * asal angkanya. `null` bila model ini tidak punya koreksi vendor.
   */
  vendor: { checkedAt: string; source: string; note: string; replacedBy: string | null; peakMultiplier: number } | null;
};
export type PricingSettings = { markup: number; currency: string; updatedAt: string | null; updatedBy: string | null };

const SETTINGS_KEY = "ai_pricing";
const MAX_PRICE_PER_MTOK = 100_000;
const MIN_MARKUP = 0.1;
const MAX_MARKUP = 100;

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const nowIso = () => new Date().toISOString();

/* --------------------------------------------------------------- settings */

/** Markup factor from the platform settings row. 1 means "sell at cost". */
export function pricingSettings(): PricingSettings {
  const row = db.prepare("SELECT value, updated_at AS updatedAt FROM platform_settings WHERE key=?").get(SETTINGS_KEY) as { value: string; updatedAt: string } | undefined;
  const fallback: PricingSettings = { markup: 1, currency: "USD", updatedAt: null, updatedBy: null };
  if (!row?.value) return fallback;
  try {
    const parsed = JSON.parse(row.value) as { markup?: unknown; currency?: unknown; updatedBy?: unknown };
    const markup = clampMarkup(Number(parsed.markup ?? 1));
    return { markup, currency: typeof parsed.currency === "string" && parsed.currency ? parsed.currency : "USD", updatedAt: row.updatedAt, updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null };
  } catch {
    // A corrupt row must not break billing: fall back to selling at cost and say so in the status.
    return { ...fallback, updatedAt: row.updatedAt };
  }
}

function clampMarkup(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_MARKUP, Math.max(MIN_MARKUP, Math.round(value * 10_000) / 10_000));
}

/** Stores the markup factor. Returns the stored value so the caller can report what really happened. */
export function setPricingMarkup(markup: number, actorId?: string | null): PricingSettings {
  const value = clampMarkup(markup);
  db.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(SETTINGS_KEY, JSON.stringify({ markup: value, currency: "USD", updatedBy: actorId ?? null }), nowIso());
  return pricingSettings();
}

/**
 * Housekeeping step run once at start up. Usage rows written by an older release have no billed
 * amount, because the column did not exist yet. If such a database is restored from a backup the
 * price console would report zero revenue and a negative margin, so the missing amounts are filled
 * in from the stored upstream cost. Only rows with no value at all are touched, which makes the step
 * safe to repeat on every start.
 */
export function backfillSellCosts(): number {
  const markup = pricingSettings().markup;
  const runs = db.prepare("UPDATE run_usage SET sell_cost_micros = CAST(ROUND(COALESCE(cost_micros,0) * ?) AS INTEGER) WHERE sell_cost_micros IS NULL").run(markup);
  const users = db.prepare("UPDATE user_usage SET sell_cost_micros = CAST(ROUND(COALESCE(cost_micros,0) * ?) AS INTEGER) WHERE sell_cost_micros IS NULL").run(markup);
  return Number(runs.changes) + Number(users.changes);
}

/* --------------------------------------------------------------- prices */

let overrideCache: Map<string, PriceNumbers & { updatedAt: string; updatedBy: string | null }> | null = null;

function overrides(): Map<string, PriceNumbers & { updatedAt: string; updatedBy: string | null }> {
  if (overrideCache) return overrideCache;
  const map = new Map<string, PriceNumbers & { updatedAt: string; updatedBy: string | null }>();
  const rows = db.prepare(`SELECT model, input_per_mtok AS input, output_per_mtok AS output,
      cache_read_per_mtok AS cacheRead, cache_write_per_mtok AS cacheWrite,
      updated_at AS updatedAt, updated_by AS updatedBy FROM model_price_overrides`).all() as any[];
  for (const row of rows) map.set(String(row.model), { input: Number(row.input), output: Number(row.output), cacheRead: Number(row.cacheRead), cacheWrite: Number(row.cacheWrite), updatedAt: String(row.updatedAt), updatedBy: row.updatedBy ?? null });
  overrideCache = map;
  return map;
}

/** Drops the in-process cache. Called after every write so a second process sees the change quickly. */
export function reloadPriceCache(): void { overrideCache = null; }

/**
 * Harga pokok berlapis: keputusan pemilik (`override`) menang, lalu harga resmi vendor
 * (`vendor-prices.ts`), lalu katalog mesin. Harga vendor dipakai tanpa faktor puncak; faktor puncak
 * baru diterapkan saat menghitung biaya satu pemakaian (`quoteCosts`), karena tarifnya bergantung jam.
 */
function basePriceFor(model: string): { base: PriceNumbers; source: PriceSource } {
  const override = overrides().get(model);
  if (override) return { base: { input: override.input, output: override.output, cacheRead: override.cacheRead, cacheWrite: override.cacheWrite }, source: "override" };
  const vendor: VendorPrice | null = vendorPriceFor(model);
  if (vendor) return { base: { input: vendor.input, output: vendor.output, cacheRead: vendor.cacheRead, cacheWrite: vendor.cacheWrite }, source: "vendor" };
  const catalog: ModelPrice | null = catalogPrice(model);
  if (catalog) return { base: { input: catalog.input, output: catalog.output, cacheRead: catalog.cacheRead, cacheWrite: catalog.cacheWrite }, source: "catalog" };
  return { base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: "none" };
}

function sellOf(base: PriceNumbers, markup: number): PriceNumbers {
  return { input: round6(base.input * markup), output: round6(base.output * markup), cacheRead: round6(base.cacheRead * markup), cacheWrite: round6(base.cacheWrite * markup) };
}

/**
 * The published catalogue price of a model, ignoring any owner override. The console uses it as the
 * comparison line, which is impossible through priceView() because that one always prefers the override.
 * Returns null when the engine catalogue does not know the model.
 */
export function catalogPriceFor(model: string): PriceNumbers | null {
  const catalog: ModelPrice | null = catalogPrice(model);
  if (!catalog) return null;
  return { input: catalog.input, output: catalog.output, cacheRead: catalog.cacheRead, cacheWrite: catalog.cacheWrite };
}

/** Price view for one model: which price is used, what it costs and what the customer is charged. */
export function priceView(model: string, markup = pricingSettings().markup): PriceView {
  const { base, source } = basePriceFor(model);
  const override = overrides().get(model);
  const vendor = vendorPriceFor(model);
  return {
    model,
    provider: vendor?.provider ?? catalogPrice(model)?.provider ?? null,
    source,
    base,
    sell: sellOf(base, markup),
    updatedAt: override?.updatedAt ?? null,
    updatedBy: override?.updatedBy ?? null,
    vendor: vendor ? { checkedAt: vendor.checkedAt, source: vendor.source, note: vendor.note, replacedBy: vendor.replacedBy ?? null, peakMultiplier: DEEPSEEK_PEAK_MULTIPLIER } : null,
  };
}

export type TokenCounts = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/**
 * Cost of one call in millionths of a US dollar. `baseMicros` is what the platform pays,
 * `sellMicros` is what the customer is charged. Both are null when the model has no price at all,
 * so an unknown model is reported as unpriced instead of being silently treated as free.
 */
export type CostQuote = {
  baseMicros: number | null;
  sellMicros: number | null;
  markup: number;
  source: PriceSource;
  /** Butir 19: apakah tarif puncak vendor dipakai untuk pemakaian ini. */
  peak: boolean;
  peakMultiplier: number;
  peakReason: string;
};

export function quoteCosts(model: string | undefined | null, counts: TokenCounts, at: Date | number = Date.now()): CostQuote {
  const settings = pricingSettings();
  if (!model) return { baseMicros: null, sellMicros: null, markup: settings.markup, source: "none", peak: false, peakMultiplier: 1, peakReason: "model tidak disebut" };
  const { base, source } = basePriceFor(model);
  if (source === "none") return { baseMicros: null, sellMicros: null, markup: settings.markup, source, peak: false, peakMultiplier: 1, peakReason: "tanpa harga" };
  // Faktor tarif puncak hanya berlaku untuk harga resmi vendor. Keputusan pemilik platform dan
  // katalog mesin sudah berupa angka tetap, jadi tidak dikalikan lagi.
  const peak = source === "vendor" ? deepSeekPeak(at, model) : { peak: false, multiplier: 1, hourUtc: 0, dayUtc: 0, reason: "bukan tarif vendor" };
  const per = (rate: number, tokens?: number) => ((tokens ?? 0) / 1e6) * rate;
  const baseUsd = (per(base.input, counts.inputTokens) + per(base.output, counts.outputTokens) + per(base.cacheRead, counts.cacheReadTokens) + per(base.cacheWrite, counts.cacheWriteTokens)) * peak.multiplier;
  const baseMicros = Math.round(baseUsd * 1e6);
  return { baseMicros, sellMicros: Math.round(baseMicros * settings.markup), markup: settings.markup, source, peak: peak.peak, peakMultiplier: peak.multiplier, peakReason: peak.reason };
}

/** Recomputes the billed amount for an already stored base cost (used when the markup changes). */
export function sellForBaseMicros(baseMicros: number | null | undefined, markup = pricingSettings().markup): number | null {
  if (baseMicros === null || baseMicros === undefined) return null;
  return Math.round(Number(baseMicros) * markup);
}

/* --------------------------------------------------------------- writes */

export type PriceInput = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

/** Validates owner supplied prices. Returns an Indonesian message when the input is not usable. */
export function validatePrice(input: PriceInput): string | null {
  for (const [label, value] of [["harga masukan", input.input], ["harga keluaran", input.output], ["harga cache baca", input.cacheRead ?? 0], ["harga cache tulis", input.cacheWrite ?? 0]] as [string, unknown][]) {
    const number = Number(value);
    if (!Number.isFinite(number)) return `${label} harus berupa angka.`;
    if (number < 0) return `${label} tidak boleh negatif.`;
    if (number > MAX_PRICE_PER_MTOK) return `${label} terlalu besar (maksimum ${MAX_PRICE_PER_MTOK} USD per 1 juta token).`;
  }
  return null;
}

export function savePriceOverride(model: string, input: PriceInput, actorId?: string | null): PriceView {
  const clean = {
    input: round6(Number(input.input)), output: round6(Number(input.output)),
    cacheRead: round6(Number(input.cacheRead ?? 0)), cacheWrite: round6(Number(input.cacheWrite ?? 0)),
  };
  db.prepare(`INSERT INTO model_price_overrides (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, currency, updated_at, updated_by)
      VALUES (?,?,?,?,?,'USD',?,?)
      ON CONFLICT(model) DO UPDATE SET input_per_mtok=excluded.input_per_mtok, output_per_mtok=excluded.output_per_mtok,
        cache_read_per_mtok=excluded.cache_read_per_mtok, cache_write_per_mtok=excluded.cache_write_per_mtok,
        updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(model, clean.input, clean.output, clean.cacheRead, clean.cacheWrite, nowIso(), actorId ?? null);
  reloadPriceCache();
  return priceView(model);
}

export function clearPriceOverride(model: string): boolean {
  const removed = db.prepare("DELETE FROM model_price_overrides WHERE model=?").run(model).changes > 0;
  reloadPriceCache();
  return removed;
}

export function overrideCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM model_price_overrides").get() as { n: number }).n;
}

/* --------------------------------------------------------------- reporting */

type UsageRow = { model: string | null; runs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; baseMicros: number; sellMicros: number };

/** Models that really produced usage in the window, with the money spent and billed. */
export function usageByModel(days = 30): UsageRow[] {
  const since = new Date(Date.now() - Math.min(3650, Math.max(1, Math.round(days))) * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT model, COUNT(*) AS runs,
      COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
      COALESCE(SUM(cost_micros),0) AS baseMicros, COALESCE(SUM(sell_cost_micros),0) AS sellMicros
    FROM run_usage WHERE created_at >= ? GROUP BY model ORDER BY baseMicros DESC`).all(since) as any[];
  return rows.map((row) => ({ ...row, model: row.model ?? null, runs: Number(row.runs) })) as UsageRow[];
}

/* ------------------------------------------------- butir 19: rekonsiliasi biaya */

export type ReconciliationRow = {
  model: string;
  provider: string | null;
  source: PriceSource;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Biaya yang benar-benar tercatat di basis data saat pemakaian terjadi. */
  recordedMicros: number;
  /** Biaya yang sama bila dihitung ulang dengan harga yang berlaku sekarang. */
  correctedMicros: number;
  /** Selisih dalam sepersejuta dolar AS dan dalam persen (dibulatkan 1 angka). */
  driftMicros: number;
  driftPercent: number;
  /** Berapa baris pemakaian jatuh pada jam puncak vendor. */
  peakBuckets: number;
};

export type Reconciliation = {
  days: number;
  generatedAt: string;
  rows: ReconciliationRow[];
  totals: { runs: number; recordedMicros: number; correctedMicros: number; driftMicros: number; driftPercent: number; unpricedRuns: number };
  note: string;
};

/**
 * Membandingkan biaya yang TERCATAT dengan biaya yang SEHARUSNYA menurut harga yang berlaku
 * sekarang, per jam pemakaian. Pengelompokan per jam dipakai karena tarif puncak vendor bergantung
 * pada jam. Jam pada `created_at` ditafsirkan sebagai UTC; baris dengan bentuk waktu yang tidak sah
 * dihitung dengan waktu sekarang supaya tidak menebak jam lain. Semua angka dibaca dari basis data.
 */
export function reconcileUsage(days = 30, limit = 20): Reconciliation {
  const window = Math.min(3650, Math.max(1, Math.round(days)));
  const since = new Date(Date.now() - window * 86_400_000).toISOString();
  const buckets = db.prepare(`SELECT substr(created_at,1,13) AS bucket, COALESCE(model,'') AS model, COUNT(*) AS runs,
      COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,
      COALESCE(SUM(cost_micros),0) AS recordedMicros, COALESCE(SUM(sell_cost_micros),0) AS sellMicros,
      SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END) AS unpricedRuns
    FROM run_usage WHERE created_at >= ? GROUP BY bucket, COALESCE(model,'') ORDER BY bucket`).all(since) as any[];

  const perModel = new Map<string, ReconciliationRow>();
  let unpricedTotal = 0;
  for (const bucket of buckets) {
    const model = String(bucket.model || "");
    const counts = { inputTokens: Number(bucket.inputTokens), outputTokens: Number(bucket.outputTokens), cacheReadTokens: Number(bucket.cacheReadTokens), cacheWriteTokens: Number(bucket.cacheWriteTokens) };
    // Jam bucket ditafsirkan sebagai UTC; bila tidak sah, pakai waktu sekarang supaya tidak menebak jam lain.
    const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(String(bucket.bucket)) ? Date.parse(`${bucket.bucket}:00:00Z`) : Date.now();
    const quote = quoteCosts(model || null, counts, stamp);
    const row: ReconciliationRow = perModel.get(model) ?? { model: model || "(tanpa model)", provider: null, source: "none", runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, recordedMicros: 0, correctedMicros: 0, driftMicros: 0, driftPercent: 0, peakBuckets: 0 };
    const { base, source } = basePriceFor(model);
    row.provider = vendorPriceFor(model)?.provider ?? catalogPrice(model)?.provider ?? null;
    row.source = source;
    row.runs += Number(bucket.runs);
    row.inputTokens += counts.inputTokens;
    row.outputTokens += counts.outputTokens;
    row.cacheReadTokens += counts.cacheReadTokens;
    row.cacheWriteTokens += counts.cacheWriteTokens;
    row.recordedMicros += Number(bucket.recordedMicros);
    row.correctedMicros += quote.baseMicros ?? 0;
    if (quote.peak) row.peakBuckets += 1;
    if (source === "none" || (base.input === 0 && base.output === 0)) unpricedTotal += Number(bucket.unpricedRuns);
    perModel.set(model, row);
  }

  const rows = [...perModel.values()].map((row) => {
    const driftMicros = row.correctedMicros - row.recordedMicros;
    return { ...row, driftMicros, driftPercent: row.recordedMicros > 0 ? Math.round((driftMicros / row.recordedMicros) * 1000) / 10 : (driftMicros > 0 ? 100 : 0) };
  }).sort((left, right) => Math.abs(right.driftMicros) - Math.abs(left.driftMicros));

  const recordedMicros = rows.reduce((sum, row) => sum + row.recordedMicros, 0);
  const correctedMicros = rows.reduce((sum, row) => sum + row.correctedMicros, 0);
  const driftMicros = correctedMicros - recordedMicros;
  return {
    days: window,
    generatedAt: new Date().toISOString(),
    rows: rows.slice(0, Math.max(1, limit)),
    totals: {
      runs: rows.reduce((sum, row) => sum + row.runs, 0),
      recordedMicros,
      correctedMicros,
      driftMicros,
      driftPercent: recordedMicros > 0 ? Math.round((driftMicros / recordedMicros) * 1000) / 10 : 0,
      unpricedRuns: unpricedTotal,
    },
    note: "correctedMicros dihitung ulang dengan harga yang berlaku sekarang (termasuk tarif puncak vendor per jam). Selisih positif berarti biaya yang tercatat lebih kecil daripada seharusnya.",
  };
}

export type PricingTable = {

  markup: number; currency: string; updatedAt: string | null; updatedBy: string | null;
  catalogSize: number; overrideCount: number; days: number;
  models: (PriceView & { used: boolean; runs: number; baseMicros: number; sellMicros: number })[];
  totals: { runs: number; baseMicros: number; sellMicros: number; marginMicros: number; pricedRuns: number; unpricedRuns: number; modelsUsed: number };
};

/**
 * The whole price console in one payload: the effective price of every model that matters
 * (priced by the owner, or actually used, plus the catalogue rows matching a search), together
 * with what was spent and billed in the window.
 */
export function pricingTable(options: { search?: string; only?: "used" | "overridden" | "all"; limit?: number; days?: number } = {}): PricingTable {
  const settings = pricingSettings();
  const days = Math.min(3650, Math.max(1, Math.round(options.days ?? 30)));
  const usage = usageByModel(days);
  const usageByModelName = new Map(usage.map((row) => [row.model ?? "", row]));
  const search = (options.search ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const models: PricingTable["models"] = [];

  const push = (model: string) => {
    if (seen.has(model)) return;
    const row = usageByModelName.get(model);
    const view = priceView(model, settings.markup);
    seen.add(model);
    models.push({ ...view, used: Boolean(row), runs: row?.runs ?? 0, baseMicros: row?.baseMicros ?? 0, sellMicros: row?.sellMicros ?? 0 });
  };

  for (const row of usage) if (row.model) push(row.model);
  for (const model of overrides().keys()) push(model);
  if (!options.only || options.only === "all" || search) {
    for (const model of Object.keys(MODEL_PRICES)) { if (search && !model.toLowerCase().includes(search)) continue; push(model); }
  }
  const filtered = search ? models.filter((row) => row.model.toLowerCase().includes(search)) : models;
  const limit = Math.min(5000, Math.max(1, Math.round(options.limit ?? 500)));
  const trimmed = filtered.slice(0, limit);

  const priced = usage.filter((row) => row.baseMicros > 0);
  const totals = {
    runs: usage.reduce((sum, row) => sum + row.runs, 0),
    baseMicros: usage.reduce((sum, row) => sum + row.baseMicros, 0),
    sellMicros: usage.reduce((sum, row) => sum + row.sellMicros, 0),
    marginMicros: 0,
    pricedRuns: priced.reduce((sum, row) => sum + row.runs, 0),
    unpricedRuns: usage.filter((row) => row.baseMicros === 0).reduce((sum, row) => sum + row.runs, 0),
    modelsUsed: usage.length,
  };
  totals.marginMicros = totals.sellMicros - totals.baseMicros;

  return { ...settings, catalogSize: Object.keys(MODEL_PRICES).length, overrideCount: overrideCount(), days, models: trimmed, totals };
}

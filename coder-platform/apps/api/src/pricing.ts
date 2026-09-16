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

export type PriceNumbers = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type PriceSource = "catalog" | "override" | "none";
export type PriceView = {
  model: string;
  provider: string | null;
  source: PriceSource;
  base: PriceNumbers;
  sell: PriceNumbers;
  updatedAt: string | null;
  updatedBy: string | null;
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

function basePriceFor(model: string): { base: PriceNumbers; source: PriceSource } {
  const override = overrides().get(model);
  if (override) return { base: { input: override.input, output: override.output, cacheRead: override.cacheRead, cacheWrite: override.cacheWrite }, source: "override" };
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
  return {
    model,
    provider: catalogPrice(model)?.provider ?? null,
    source,
    base,
    sell: sellOf(base, markup),
    updatedAt: override?.updatedAt ?? null,
    updatedBy: override?.updatedBy ?? null,
  };
}

export type TokenCounts = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/**
 * Cost of one call in millionths of a US dollar. `baseMicros` is what the platform pays,
 * `sellMicros` is what the customer is charged. Both are null when the model has no price at all,
 * so an unknown model is reported as unpriced instead of being silently treated as free.
 */
export function quoteCosts(model: string | undefined | null, counts: TokenCounts): { baseMicros: number | null; sellMicros: number | null; markup: number; source: PriceSource } {
  const settings = pricingSettings();
  if (!model) return { baseMicros: null, sellMicros: null, markup: settings.markup, source: "none" };
  const { base, source } = basePriceFor(model);
  if (source === "none") return { baseMicros: null, sellMicros: null, markup: settings.markup, source };
  const per = (rate: number, tokens?: number) => ((tokens ?? 0) / 1e6) * rate;
  const baseUsd = per(base.input, counts.inputTokens) + per(base.output, counts.outputTokens) + per(base.cacheRead, counts.cacheReadTokens) + per(base.cacheWrite, counts.cacheWriteTokens);
  const baseMicros = Math.round(baseUsd * 1e6);
  return { baseMicros, sellMicros: Math.round(baseMicros * settings.markup), markup: settings.markup, source };
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

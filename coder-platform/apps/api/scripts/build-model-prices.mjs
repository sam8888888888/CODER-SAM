/**
 * Generates apps/api/src/model-prices.ts from the model catalogue that ships with the installed
 * prime-agent package. Prices are US dollars per million tokens, exactly as published there.
 * Refresh it after a prime-agent upgrade: node apps/api/scripts/build-model-prices.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Finds the prime-agent package root by following the installed binary. */
function packageRoot() {
  const binary = process.env.PRIME_AGENT_BIN || "prime-agent";
  const resolved = realpathSync(execFileSync("which", [binary], { encoding: "utf8" }).trim());
  let dir = dirname(resolved);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "dist", "bundle"))) return dir;
    const nested = join(dir, "node_modules", "prime-agent");
    if (existsSync(join(nested, "dist", "bundle"))) return nested;
    dir = dirname(dir);
  }
  throw new Error(`prime-agent bundle not found from ${resolved}`);
}

const root = packageRoot();
const bundleDir = join(root, "dist", "bundle");
const chunks = readdirSync(bundleDir)
  .filter((file) => file.endsWith(".js") && !file.endsWith(".map"))
  .map((file) => readFileSync(join(bundleDir, file), "utf8"))
  .filter((text) => text.includes("cost:") && text.includes("contextWindow"));

const toNumber = (raw) => {
  const value = Number(String(raw).replace(/_/g, ""));
  return Number.isFinite(value) ? value : null;
};
const prices = {};
for (const text of chunks) {
  const entry = /"?([a-z0-9][a-z0-9._:-]*)"?:\s*\{\s*id:\s*"([^"]+)"[\s\S]{0,900}?provider:\s*"([^"]+)"[\s\S]{0,900}?cost:\s*\{([^}]*)\}/g;
  let match;
  while ((match = entry.exec(text))) {
    const model = match[2];
    const fields = {};
    for (const pair of match[4].split(",")) {
      const [key, rawValue] = pair.split(":").map((part) => part?.trim());
      if (!key || rawValue === undefined) continue;
      const value = toNumber(rawValue);
      if (value !== null) fields[key] = value;
    }
    if (!("input" in fields) && !("output" in fields)) continue;
    if (!prices[model]) prices[model] = { provider: match[3], ...fields };
  }
}
const sorted = Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)));
const lines = Object.entries(sorted).map(([model, price]) => `  ${JSON.stringify(model)}: { provider: ${JSON.stringify(price.provider)}, input: ${price.input ?? 0}, output: ${price.output ?? 0}, cacheRead: ${price.cacheRead ?? 0}, cacheWrite: ${price.cacheWrite ?? 0} },`);
const file = `/**
 * GENERATED FILE - do not edit by hand.
 * Source: the model catalogue bundled with prime-agent ${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}.
 * Refresh after an engine upgrade: node apps/api/scripts/build-model-prices.mjs
 * Prices are US dollars per million tokens, taken as published by the engine catalogue.
 */
export type ModelPrice = { provider: string; input: number; output: number; cacheRead: number; cacheWrite: number };

export const MODEL_PRICES: Record<string, ModelPrice> = {
${lines.join("\n")}
};

/** Token counts reported by the engine for one run. */
export type TokenCounts = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };

/** Returns the published price for a model id, or null when the model is unknown. */
export function priceForModel(model?: string | null): ModelPrice | null {
  if (!model) return null;
  return MODEL_PRICES[model] ?? null;
}

/**
 * Cost in millionths of a US dollar for the reported tokens, or null when the model price is
 * unknown. Nothing is guessed: an unknown model returns null so callers can report "unknown".
 */
export function estimateCostMicros(model: string | undefined | null, counts: TokenCounts): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  const usd = ((counts.inputTokens ?? 0) / 1e6) * price.input + ((counts.outputTokens ?? 0) / 1e6) * price.output + ((counts.cacheReadTokens ?? 0) / 1e6) * price.cacheRead + ((counts.cacheWriteTokens ?? 0) / 1e6) * price.cacheWrite;
  return Math.round(usd * 1e6);
}
`;
writeFileSync(new URL("../src/model-prices.ts", import.meta.url), file);
console.log(`MODEL_PRICES_WRITTEN ${Object.keys(sorted).length} models from ${chunks.length} chunks`);
console.log("SAMPLE", JSON.stringify({ "deepseek-v4-flash": sorted["deepseek-v4-flash"], "deepseek-v4-pro": sorted["deepseek-v4-pro"] }));

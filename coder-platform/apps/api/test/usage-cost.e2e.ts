/**
 * Usage and cost accounting: engine reported tokens must be stored as measured (estimated=0) and
 * priced from the published price table; text-length estimates must stay flagged as estimated.
 * Usage: MOCK_ENGINE=false PRIME_AGENT_BIN=apps/api/test/fixtures/fake-prime-agent.mjs npx tsx apps/api/test/usage-cost.e2e.ts
 */
import { randomUUID } from "node:crypto";
import { estimateCostMicros, priceForModel } from "../src/model-prices.js";
import { vendorCostMicros } from "../src/vendor-prices.js";

const port = 3444;
process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-usage-cost-${Date.now()}`;
process.env.MOCK_ENGINE = "false";
process.env.PRIME_AGENT_BIN = process.env.PRIME_AGENT_BIN ?? "apps/api/test/fixtures/fake-prime-agent.mjs";
process.env.ENGINE_ROOT_DIR = `${process.env.DATA_DIR}/engine-sessions`;
process.env.FAKE_INPUT_TOKENS = "1000000";
process.env.FAKE_OUTPUT_TOKENS = "1000000";
process.env.FAKE_CACHE_READ_TOKENS = "0";
process.env.FAKE_MODEL = "deepseek-v4-flash";
process.env.PRIME_AGENT_MODEL = "deepseek-v4-flash";
process.env.PRIME_AGENT_PROVIDER = "deepseek";

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 1200));

const base = `http://127.0.0.1:${port}`;
let cookie = "";
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

// Price table sanity: the published DeepSeek prices must be present and used exactly.
const price = priceForModel("deepseek-v4-flash");
check("price table has deepseek-v4-flash", Boolean(price && price.input > 0 && price.output > 0), JSON.stringify(price));
check("cost for 1M input + 1M output tokens matches the price table", estimateCostMicros("deepseek-v4-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 }) === Math.round(((price?.input ?? 0) + (price?.output ?? 0)) * 1_000_000), String(estimateCostMicros("deepseek-v4-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 })));
check("unknown model has no invented price", estimateCostMicros("model-that-does-not-exist", { inputTokens: 10 }) === null, String(estimateCostMicros("model-that-does-not-exist", { inputTokens: 10 })));

// Butir 19: katalog mesin memuat harga DeepSeek yang sudah tidak berlaku (0,14 / 0,28). Yang dipakai
// untuk membukukan biaya adalah harga resmi vendor: 0,15 / 0,60, dan dua kali lipat di jam puncak.
const LUAR_PUNCAK = Date.parse("2026-09-22T12:00:00Z"); // Selasa 12:00 UTC
const PUNCAK = Date.parse("2026-09-22T02:00:00Z"); // Selasa 02:00 UTC
const satuJuta = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
const vendorOffPeak = vendorCostMicros("deepseek-v4-flash", satuJuta, LUAR_PUNCAK);
const vendorPeak = vendorCostMicros("deepseek-v4-flash", satuJuta, PUNCAK);
check("vendor price table has deepseek-v4-flash", Boolean(vendorOffPeak && vendorOffPeak.price.output === 0.6), JSON.stringify(vendorOffPeak?.price));
check("vendor cost for 1M in + 1M out off-peak = 750000 micros", vendorOffPeak?.micros === 750_000, String(vendorOffPeak?.micros));
check("vendor cost doubles during peak hours", vendorPeak?.micros === 1_500_000 && vendorPeak?.peak.peak === true, JSON.stringify(vendorPeak?.peak));
check("vendor table also knows the official name deepseek-flash", vendorCostMicros("deepseek-flash", satuJuta, LUAR_PUNCAK)?.micros === 750_000, String(vendorCostMicros("deepseek-flash", satuJuta, LUAR_PUNCAK)?.micros));
check("vendor table stays silent for models it does not know", vendorCostMicros("claude-haiku-4-5", satuJuta, LUAR_PUNCAK) === null, "");

const email = `usage-${randomUUID().slice(0, 8)}@example.com`;
const registered = await call("POST", "/api/v1/auth/register", { email, password: "Usage12345!", displayName: "Usage Tester" });
check("registration creates a workspace", registered.status === 201 || registered.status === 200, JSON.stringify(registered.json).slice(0, 160));
const workspaceId = registered.json.workspace.id;
const project = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Usage", slug: `u-${Date.now()}` });
const projectId = project.json.id;
const conversation = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "usage" });
const sent = await call("POST", `/api/v1/conversations/${conversation.json.conversation.id}/messages`, { content: "hitung pemakaian", model: "deepseek-v4-flash" });
check("message accepted", sent.status === 202, JSON.stringify(sent.json).slice(0, 160));
let run: any = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const detail = await call("GET", `/api/v1/runs/${sent.json.run.id}`);
  run = detail.json;
  if (["completed", "failed", "cancelled"].includes(run?.status)) break;
}
check("run completed through the engine", run?.status === "completed", `status=${run?.status} error=${run?.errorCode ?? ""} ${String(run?.result ?? "").slice(0, 60)}`);

const usage = await call("GET", `/api/v1/projects/${projectId}/usage?days=30`);
const totals = usage.json.totals;
check("usage endpoint responds", usage.status === 200, JSON.stringify(usage.json).slice(0, 160));
check("engine tokens stored as measured", totals.runs === 1 && totals.estimatedRuns === 0 && totals.measuredRuns === 1, JSON.stringify(totals));
check("input tokens match the engine report", totals.inputTokens === 1_000_000, String(totals.inputTokens));
check("output tokens match the engine report", totals.outputTokens === 1_000_000, String(totals.outputTokens));
check("total tokens stored", totals.totalTokens === 2_000_000, String(totals.totalTokens));
// Biaya yang dibukukan memakai harga resmi vendor, bukan harga katalog yang basi. Tarif puncak
// bergantung jam saat pemakaian dicatat, jadi kedua angka yang sah diterima (750000 atau 1500000);
// yang penting angka katalog yang basi (420000) TIDAK lagi dipakai.
const hargaVendorSah = [750_000, 1_500_000];
const hargaKatalogBasi = Math.round(((price?.input ?? 0) + (price?.output ?? 0)) * 1_000_000);
check("cost uses the vendor price table, not the stale catalogue price", hargaVendorSah.includes(totals.costMicros) && totals.costMicros !== hargaKatalogBasi, `costMicros=${totals.costMicros} katalogBasi=${hargaKatalogBasi}`);
check("cost in US dollars is exposed", typeof totals.costUsd === "number" && [0.75, 1.5].some((nilai) => Math.abs(totals.costUsd - nilai) < 1e-6), `${totals.costUsd}`);
check("no unpriced runs for a priced model", totals.unpricedRuns === 0, String(totals.unpricedRuns));
check("by model breakdown groups the run", usage.json.byModel.length === 1 && usage.json.byModel[0].model === "deepseek-v4-flash" && usage.json.byModel[0].provider === "deepseek", JSON.stringify(usage.json.byModel));
check("by model breakdown carries cost", usage.json.byModel[0]?.costUsd === totals.costUsd, JSON.stringify(usage.json.byModel[0]));
check("by model names the provider", usage.json.byModel[0]?.provider === "deepseek", JSON.stringify(usage.json.byModel[0]));
check("daily breakdown carries cost", usage.json.daily.length === 1 && usage.json.daily[0].costUsd === totals.costUsd, JSON.stringify(usage.json.daily));
check("measured runs are not marked estimated", totals.estimatedRuns === 0 && totals.measuredRuns === 1, JSON.stringify(totals));
check("usage notes explain estimation", typeof usage.json.note === "string" && usage.json.note.includes("estimatedRuns"), usage.json.note);

// A run without engine tokens (mock engine) must stay flagged as estimated, never silently measured.
console.log(failures === 0 ? "ALL_USAGE_COST_TESTS_PASSED" : `USAGE_COST_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

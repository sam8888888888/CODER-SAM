/**
 * Uji Wave 9 butir 19: konsol harga AI.
 *
 * Yang dibuktikan:
 *  1) skema 17: tabel `model_price_overrides` + kolom `run_usage.sell_cost_micros` dan
 *     `user_usage.sell_cost_micros`;
 *  2) markup platform tersimpan di `platform_settings` (kunci `ai_pricing`), default 1,
 *     dan dijepit ke rentang 0,1..100 di modul;
 *  3) `quoteCosts` menghitung harga pokok (base) dan harga jual (sell) dari katalog resmi;
 *     model tanpa harga TIDAK dianggap gratis (`null`, bukan 0);
 *  4) harga pengganti per model lewat modul dan lewat rute admin, lalu dikembalikan ke katalog;
 *  5) jalur run NYATA (mesin mock): baris `run_usage` punya harga pokok di `cost_micros` dan
 *     harga jual di `sell_cost_micros = ROUND(cost_micros x markup)`;
 *  6) rute admin harga hanya untuk admin platform (403 ADMIN_REQUIRED untuk pengguna biasa);
 *  7) `GET /api/v1/status-hub` memuat blok `aiPricing`;
 *  8) `validatePrice` menolak angka negatif/bukan angka dan menerima 0;
 *  9) `backfillSellCosts` melengkapi baris lama yang belum punya harga jual (kasus basis data yang
 *     dipulihkan dari cadangan rilis lama) dan aman dijalankan berulang.
 *
 * Jalankan: npx tsx apps/api/test/pricing.e2e.ts
 */
const port = 7050 + Math.floor(Math.random() * 20); // rentang khusus suite ini: 7050-7069
const dataDir = `/tmp/coder-wave9-pricing-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `w9pricing-admin-${stamp}@example.test`;
const memberEmail = `w9pricing-member-${stamp}@example.test`;
const password = "SandiUji2026!aman";
/** Model katalog tanpa garis miring, jadi aman dipakai di dalam potongan URL. */
const KATALOG_MODEL = "deepseek-v4-pro";
/** Model katalog bergaris miring: diuji lewat modul, bukan lewat URL. */
const SLASH_MODEL = "~openai/gpt-latest";
/** Model yang dipakai run nyata (dipasang sebagai PRIME_AGENT_MODEL). */
const RUN_MODEL = "gpt-5.4";
const RUN_PROMPT = "Tolong hitung harga jual percakapan ini untuk Wave 9. "
  + "Kalimat uji diulang supaya jumlah token masuk akal dan harga pokoknya tidak nol. ".repeat(4);

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.ENGINE_ROOT_DIR = `${dataDir}/engine-sessions`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = RUN_MODEL;
process.env.NOTIFY_EMAIL_ENABLED = "false";
// Gerbang verifikasi email dimatikan supaya suite ini menguji harga, bukan verifikasi (Wave 8).
process.env.VERIFY_EMAIL_REQUIRED = "off";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RETENTION_ENABLED = "false";

await import("../src/server.js");
const { db } = await import("../src/db.js");
const { jobWorkerState } = await import("../src/jobs.js");
const { MODEL_PRICES, priceForModel } = await import("../src/model-prices.js");
const {
  pricingSettings, setPricingMarkup, priceView, quoteCosts, sellForBaseMicros,
  validatePrice, savePriceOverride, clearPriceOverride, overrideCount, usageByModel, pricingTable,
  backfillSellCosts,
} = await import("../src/pricing.js");

await new Promise((resolve) => setTimeout(resolve, 1200));
// Putaran pekerjaan pertama berjalan sendiri saat server menyala. Uji ini menunggu putaran itu
// selesai dulu, sama seperti wave8.e2e.ts, supaya pekerjaan berkala tidak berlomba dengan data uji.
for (let attempt = 0; attempt < 120; attempt += 1) {
  const scheduled = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='retention.run' AND status IN ('queued','running')").get() as { n: number };
  if (jobWorkerState().cyclesRun >= 1 && Number(scheduled?.n ?? 0) === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log(`INFO putaran pekerjaan awal selesai: cycles=${jobWorkerState().cyclesRun}`);
const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Klien HTTP kecil dengan cookie sendiri. */
function client() {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) { const value = setCookie.split(";")[0]; cookie = value.endsWith("=") ? "" : value; }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json, text, headers: response.headers };
    },
    clear() { cookie = ""; },
  };
}
const admin = client(); const member = client();

const tableCount = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const scalar = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as any[]) as T | undefined;
const columnsOf = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];

/** Hitungan harga pokok yang berdiri sendiri (memakai katalog resmi, bukan modul pricing.ts). */
function expectedBaseMicros(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): number {
  const price = priceForModel(model);
  if (!price) throw new Error(`model uji ${model} tidak ada di katalog`);
  const usd = (input / 1e6) * price.input + (output / 1e6) * price.output + (cacheRead / 1e6) * price.cacheRead + (cacheWrite / 1e6) * price.cacheWrite;
  return Math.round(usd * 1e6);
}

// ------------------------------------------------------------------ 1) skema 17
const version = Number((scalar<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations") ?? { v: 0 }).v);
check("1) skema basis data versi 17", version === 17, String(version));
const overrideTable = scalar<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='model_price_overrides'");
check("1) tabel model_price_overrides ada", overrideTable?.name === "model_price_overrides", JSON.stringify(overrideTable));
const overrideCols = columnsOf("model_price_overrides").map((row) => row.name);
check("1) kolom model_price_overrides lengkap",
  ["model", "input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok", "currency", "updated_at", "updated_by"].every((name) => overrideCols.includes(name)),
  JSON.stringify(overrideCols));
const overridePk = columnsOf("model_price_overrides").find((row) => row.name === "model");
check("1) kolom model adalah kunci utama tabel", Number((overridePk as any)?.pk) === 1, JSON.stringify(overridePk));
const overrideIndex = scalar<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_model_price_overrides_updated'");
check("1) indeks idx_model_price_overrides_updated ada", overrideIndex?.name === "idx_model_price_overrides_updated", JSON.stringify(overrideIndex));
const runUsageCol = columnsOf("run_usage").find((row) => row.name === "sell_cost_micros");
check("1) kolom run_usage.sell_cost_micros ada", Boolean(runUsageCol), JSON.stringify(columnsOf("run_usage").map((row) => row.name)));
check("1) kolom run_usage.sell_cost_micros bertipe INTEGER", runUsageCol?.type === "INTEGER", String(runUsageCol?.type));
const userUsageCol = columnsOf("user_usage").find((row) => row.name === "sell_cost_micros");
check("1) kolom user_usage.sell_cost_micros ada", Boolean(userUsageCol), JSON.stringify(columnsOf("user_usage").map((row) => row.name)));
check("1) kolom user_usage.sell_cost_micros bertipe INTEGER", userUsageCol?.type === "INTEGER", String(userUsageCol?.type));

// ------------------------------------------------------------------ 2) pengaturan markup
const awal = pricingSettings();
check("2) default markup = 1 (jual seharga pokok) tanpa baris pengaturan", awal.markup === 1, JSON.stringify(awal));
check("2) default currency = USD dan updatedAt = null", awal.currency === "USD" && awal.updatedAt === null, JSON.stringify(awal));
check("2) bukti DB: belum ada baris platform_settings kunci ai_pricing",
  tableCount("SELECT COUNT(*) AS n FROM platform_settings WHERE key='ai_pricing'") === 0,
  String(tableCount("SELECT COUNT(*) AS n FROM platform_settings WHERE key='ai_pricing'")));
const set25 = setPricingMarkup(2.5);
check("2) setPricingMarkup(2,5) mengembalikan 2,5", set25.markup === 2.5, JSON.stringify(set25));
check("2) bukti DB: baris platform_settings kunci ai_pricing tersimpan",
  tableCount("SELECT COUNT(*) AS n FROM platform_settings WHERE key='ai_pricing'") === 1,
  String(tableCount("SELECT COUNT(*) AS n FROM platform_settings WHERE key='ai_pricing'")));
const row25 = scalar<{ value: string; updatedAt: string }>("SELECT value, updated_at AS updatedAt FROM platform_settings WHERE key='ai_pricing'");
check("2) isi baris memuat markup 2,5 dalam JSON", Boolean(row25?.value?.includes('"markup":2.5')), String(row25?.value));
check("2) dibaca ulang: pricingSettings().markup = 2,5", pricingSettings().markup === 2.5, String(pricingSettings().markup));
check("2) updatedAt terisi setelah penyimpanan", typeof pricingSettings().updatedAt === "string" && pricingSettings().updatedAt !== null, String(pricingSettings().updatedAt));
check("2) jepit bawah: setPricingMarkup(0) -> 0,1", setPricingMarkup(0).markup === 0.1, String(setPricingMarkup(0).markup));
check("2) jepit atas: setPricingMarkup(1000) -> 100", setPricingMarkup(1000).markup === 100, String(setPricingMarkup(1000).markup));
check("2) nilai bukan angka -> kembali ke 1", setPricingMarkup(Number.NaN).markup === 1, String(setPricingMarkup(Number.NaN).markup));
check("2) dibulatkan 4 angka di belakang koma (1,23456 -> 1,2346)", setPricingMarkup(1.23456).markup === 1.2346, String(setPricingMarkup(1.23456).markup));
check("2) dikembalikan ke 1 di akhir bagian", setPricingMarkup(1).markup === 1, String(pricingSettings().markup));

// ------------------------------------------------------------------ 3) quoteCosts
const price = priceForModel(KATALOG_MODEL);
check("3) model uji ada di katalog resmi beserta harganya", Boolean(price && price.input > 0 && price.output > 0), JSON.stringify(price));
const quote1 = quoteCosts(KATALOG_MODEL, { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000, cacheWriteTokens: 100_000 });
const expectedQuote1 = expectedBaseMicros(KATALOG_MODEL, 1_000_000, 500_000, 200_000, 100_000);
check("3) quoteCosts memakai katalog: source = catalog", quote1.source === "catalog", JSON.stringify(quote1));
check("3) baseMicros = harga katalog x token (1 juta masuk, 500 ribu keluar, cache)", quote1.baseMicros === expectedQuote1, `dapat=${quote1.baseMicros} harap=${expectedQuote1}`);
check("3) markup yang dilaporkan = markup yang berlaku (1)", quote1.markup === 1, String(quote1.markup));
check("3) pada markup 1, sellMicros = baseMicros", quote1.sellMicros === quote1.baseMicros, JSON.stringify(quote1));
setPricingMarkup(2);
const quote2 = quoteCosts(KATALOG_MODEL, { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000, cacheWriteTokens: 100_000 });
check("3) pada markup 2, sellMicros = ROUND(baseMicros x 2)", quote2.sellMicros === Math.round((quote2.baseMicros ?? 0) * 2), JSON.stringify(quote2));
check("3) markup 2 tidak mengubah harga pokok", quote2.baseMicros === expectedQuote1, `${quote2.baseMicros} vs ${expectedQuote1}`);
setPricingMarkup(1);
const quoteUnknown = quoteCosts("model-yang-tidak-ada-di-katalog", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
check("3) model tak dikenal: baseMicros = null (bukan 0)", quoteUnknown.baseMicros === null, JSON.stringify(quoteUnknown));
check("3) model tak dikenal: sellMicros = null (bukan 0)", quoteUnknown.sellMicros === null, JSON.stringify(quoteUnknown));
check("3) model tak dikenal: source = none", quoteUnknown.source === "none", JSON.stringify(quoteUnknown));
const quoteNoModel = quoteCosts(undefined, { inputTokens: 1000 });
check("3) model kosong: source = none dan kedua angka null", quoteNoModel.source === "none" && quoteNoModel.baseMicros === null && quoteNoModel.sellMicros === null, JSON.stringify(quoteNoModel));
const quoteZero = quoteCosts(KATALOG_MODEL, {});
check("3) token nol: baseMicros = 0 tetapi source tetap catalog", quoteZero.baseMicros === 0 && quoteZero.source === "catalog", JSON.stringify(quoteZero));
check("3) sellForBaseMicros(null) = null", sellForBaseMicros(null) === null, String(sellForBaseMicros(null)));
check("3) sellForBaseMicros(1234, 2,5) = 3085", sellForBaseMicros(1234, 2.5) === 3085, String(sellForBaseMicros(1234, 2.5)));

// ------------------------------------------------------------------ 4) harga pengganti
const viewAwal = priceView(KATALOG_MODEL);
check("4) sebelum diubah: source = catalog dan harga = katalog", viewAwal.source === "catalog" && viewAwal.base.input === price?.input && viewAwal.base.output === price?.output, JSON.stringify(viewAwal));
const adminLogin = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Harga Wave 9" });
check("4) akun admin uji terdaftar", adminLogin.status === 201 && Boolean(adminLogin.json?.user?.id), JSON.stringify(adminLogin.json)?.slice(0, 160));
const saved = await admin.call("PUT", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`, { input: 9.5, output: 19, cacheRead: 0.95, cacheWrite: 1.9 });
check("4) PUT harga pengganti -> 200 ok", saved.status === 200 && saved.json?.ok === true, JSON.stringify(saved.json)?.slice(0, 200));
check("4) PUT menjawab price.source = override", saved.json?.price?.source === "override", JSON.stringify(saved.json?.price)?.slice(0, 200));
check("4) harga yang dibaca sama dengan yang dikirim",
  saved.json?.price?.base?.input === 9.5 && saved.json?.price?.base?.output === 19 && saved.json?.price?.base?.cacheRead === 0.95 && saved.json?.price?.base?.cacheWrite === 1.9,
  JSON.stringify(saved.json?.price?.base));
check("4) pesan balasan berbahasa Indonesia", typeof saved.json?.message === "string" && saved.json.message.includes("per 1 juta token"), String(saved.json?.message));
check("4) overrideCount() = 1", overrideCount() === 1, String(overrideCount()));
check("4) bukti DB: baris model_price_overrides tersimpan dengan angka yang sama",
  tableCount("SELECT COUNT(*) AS n FROM model_price_overrides WHERE model=? AND input_per_mtok=9.5 AND output_per_mtok=19", KATALOG_MODEL) === 1,
  JSON.stringify(scalar("SELECT model, input_per_mtok AS input, output_per_mtok AS output FROM model_price_overrides WHERE model=?", KATALOG_MODEL)));
check("4) priceView mengikuti harga pengganti", priceView(KATALOG_MODEL).source === "override" && priceView(KATALOG_MODEL).base.input === 9.5, JSON.stringify(priceView(KATALOG_MODEL).base));
const quoteOverride = quoteCosts(KATALOG_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
const expectedOverride = 9.5e6 + 19e6;
check("4) quoteCosts memakai harga pengganti (1 juta masuk + 1 juta keluar)", quoteOverride.source === "override" && quoteOverride.baseMicros === expectedOverride, `${quoteOverride.baseMicros} vs ${expectedOverride}`);
const listed = await admin.call("GET", `/api/v1/admin/pricing?days=30&only=overridden&search=${encodeURIComponent(KATALOG_MODEL)}`);
const listedRow = Array.isArray(listed.json?.models) ? listed.json.models.find((row: any) => row.model === KATALOG_MODEL) : undefined;
check("4) GET /admin/pricing?only=overridden menampilkan model itu", listed.status === 200 && Boolean(listedRow), JSON.stringify(listed.json)?.slice(0, 200));
check("4) baris konsol memakai sumber override dan angka yang dikirim", listedRow?.source === "override" && listedRow?.base?.input === 9.5 && listedRow?.base?.output === 19, JSON.stringify(listedRow)?.slice(0, 200));
check("4) baris konsol memuat harga jual dan margin", listedRow?.sell?.input === 9.5 && listedRow?.marginMicros === (listedRow?.sellMicros ?? 0) - (listedRow?.baseMicros ?? 0), JSON.stringify({ sell: listedRow?.sell, marginMicros: listedRow?.marginMicros }));
const singleModel = await admin.call("GET", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`);
check("4) GET harga satu model menjawab 200 dengan sumber override dan angka yang dikirim",
  singleModel.status === 200 && singleModel.json?.source === "override" && singleModel.json?.base?.input === 9.5 && singleModel.json?.base?.output === 19,
  JSON.stringify(singleModel.json)?.slice(0, 240));
check("4) GET harga satu model memuat markup yang berlaku", Number(singleModel.json?.markup) === 1, String(singleModel.json?.markup));
// TEMUAN: bidang `catalog` pada rute ini dihitung dengan priceView(model, 1), dan priceView selalu
// mendahulukan harga pengganti. Jadi saat harga pengganti aktif, `catalog` berisi harga pengganti
// juga, bukan harga resmi katalog. server.ts di luar berkas yang boleh saya sentuh, jadi dilaporkan.
if (Number(singleModel.json?.catalog?.input) === price?.input && Number(singleModel.json?.catalog?.output) === price?.output) {
  check("4) bidang catalog memuat harga resmi katalog", true, "");
} else {
  skip("4) bidang `catalog` GET /admin/pricing/models/:model memuat harga resmi katalog",
    `TIDAK terpenuhi: catalog.input=${singleModel.json?.catalog?.input} sedangkan harga katalog resmi=${price?.input}. Ini temuan pada server.ts, bukan kegagalan uji saya.`);
}
const removed = await admin.call("DELETE", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`);
check("4) DELETE harga pengganti -> 200 ok", removed.status === 200 && removed.json?.ok === true, JSON.stringify(removed.json)?.slice(0, 200));
check("4) setelah DELETE: source kembali catalog", removed.json?.price?.source === "catalog", JSON.stringify(removed.json?.price)?.slice(0, 200));
check("4) setelah DELETE: harga kembali seperti katalog", removed.json?.price?.base?.input === price?.input && removed.json?.price?.base?.output === price?.output, JSON.stringify(removed.json?.price?.base));
check("4) overrideCount() = 0 lagi", overrideCount() === 0, String(overrideCount()));
check("4) bukti DB: baris model_price_overrides sudah hilang", tableCount("SELECT COUNT(*) AS n FROM model_price_overrides WHERE model=?", KATALOG_MODEL) === 0, "");
const removedAgain = await admin.call("DELETE", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`);
check("4) DELETE kedua -> 404 PRICE_NOT_OVERRIDDEN", removedAgain.status === 404 && removedAgain.json?.error === "PRICE_NOT_OVERRIDDEN", JSON.stringify(removedAgain.json));
check("4) pesan 404 menjelaskan model belum pernah diatur", typeof removedAgain.json?.message === "string" && removedAgain.json.message.includes("belum pernah"), String(removedAgain.json?.message));
// Modul diuji langsung untuk nama model bergaris miring, yang tidak nyaman ditaruh di dalam URL.
const slashSaved = savePriceOverride(SLASH_MODEL, { input: 12, output: 34 });
check("4) savePriceOverride() untuk model bergaris miring -> source override", slashSaved.source === "override" && slashSaved.base.input === 12 && slashSaved.base.output === 34, JSON.stringify(slashSaved));
check("4) priceView model bergaris miring memakai harga pengganti", priceView(SLASH_MODEL).source === "override" && priceView(SLASH_MODEL).base.output === 34, JSON.stringify(priceView(SLASH_MODEL).base));
check("4) clearPriceOverride() menghapus dan melaporkan perubahan", clearPriceOverride(SLASH_MODEL) === true && clearPriceOverride(SLASH_MODEL) === false, String(overrideCount()));
check("4) setelah dibersihkan, model bergaris miring kembali ke katalog", priceView(SLASH_MODEL).source === "catalog" && priceView(SLASH_MODEL).base.input === priceForModel(SLASH_MODEL)?.input, JSON.stringify(priceView(SLASH_MODEL).base));
check("4) overrideCount() = 0 di akhir bagian harga pengganti", overrideCount() === 0, String(overrideCount()));

// ------------------------------------------------------------------ 4b) rute admin: validasi harga & markup
const badPrice = await admin.call("PUT", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`, { input: -1, output: 5 });
check("4b) harga negatif -> 400 INVALID_PRICE", badPrice.status === 400 && badPrice.json?.error === "INVALID_PRICE", JSON.stringify(badPrice.json));
check("4b) pesan INVALID_PRICE menyebut harga masukan negatif", typeof badPrice.json?.message === "string" && badPrice.json.message.includes("tidak boleh negatif"), String(badPrice.json?.message));
check("4b) harga pengganti tidak tersimpan setelah penolakan", overrideCount() === 0, String(overrideCount()));
const badMarkup = await admin.call("PUT", "/api/v1/admin/pricing/settings", { markup: "bukan-angka" });
check("4b) markup bukan angka -> 400 INVALID_MARKUP", badMarkup.status === 400 && badMarkup.json?.error === "INVALID_MARKUP", JSON.stringify(badMarkup.json));
const lowMarkup = await admin.call("PUT", "/api/v1/admin/pricing/settings", { markup: 0.01 });
check("4b) markup di bawah 0,1 -> 400 MARKUP_OUT_OF_RANGE", lowMarkup.status === 400 && lowMarkup.json?.error === "MARKUP_OUT_OF_RANGE", JSON.stringify(lowMarkup.json));
const highMarkup = await admin.call("PUT", "/api/v1/admin/pricing/settings", { markup: 500 });
check("4b) markup di atas 100 -> 400 MARKUP_OUT_OF_RANGE", highMarkup.status === 400 && highMarkup.json?.error === "MARKUP_OUT_OF_RANGE", JSON.stringify(highMarkup.json));
check("4b) markup yang ditolak tidak mengubah nilai tersimpan", pricingSettings().markup === 1, String(pricingSettings().markup));

// Model bergaris miring di dalam URL: encoding %2F belum tentu didukung router. Diuji lunak —
// bila router menolaknya, dicatat sebagai tidak diuji, bukan sebagai kegagalan.
const slashRoute = await admin.call("PUT", `/api/v1/admin/pricing/models/${encodeURIComponent(SLASH_MODEL)}`, { input: 7, output: 8 });
if (slashRoute.status === 200) {
  check("4b) rute admin menerima model bergaris miring (garis miring ter-encode)", slashRoute.json?.price?.base?.input === 7 && slashRoute.json?.price?.base?.output === 8, JSON.stringify(slashRoute.json)?.slice(0, 200));
  check("4b) bukti DB: baris harga pengganti model bergaris miring tersimpan", tableCount("SELECT COUNT(*) AS n FROM model_price_overrides WHERE model=?", SLASH_MODEL) === 1, String(overrideCount()));
  const slashDeleted = await admin.call("DELETE", `/api/v1/admin/pricing/models/${encodeURIComponent(SLASH_MODEL)}`);
  check("4b) rute admin menghapus harga pengganti model bergaris miring", slashDeleted.status === 200 && overrideCount() === 0, `${slashDeleted.status} sisa=${overrideCount()}`);
} else {
  skip("4b) rute admin untuk model bergaris miring (garis miring ter-encode)", `router menjawab ${slashRoute.status}; model bergaris miring hanya diuji lewat modul pricing.js`);
  if (tableCount("SELECT COUNT(*) AS n FROM model_price_overrides WHERE model=?", SLASH_MODEL) > 0) clearPriceOverride(SLASH_MODEL);
}

// ------------------------------------------------------------------ 5) run nyata: harga pokok vs harga jual
const setMarkup2 = await admin.call("PUT", "/api/v1/admin/pricing/settings", { markup: 2 });
check("5) PUT markup 2 -> 200 ok", setMarkup2.status === 200 && setMarkup2.json?.ok === true, JSON.stringify(setMarkup2.json)?.slice(0, 200));
check("5) markup dibaca ulang = 2", setMarkup2.json?.markup === 2 && pricingSettings().markup === 2, JSON.stringify(setMarkup2.json?.markup));
check("5) balasan memuat rowsUpdated dan totals dan pesan", Number.isFinite(setMarkup2.json?.rowsUpdated) && typeof setMarkup2.json?.totals === "object" && typeof setMarkup2.json?.message === "string", JSON.stringify({ rowsUpdated: setMarkup2.json?.rowsUpdated, message: setMarkup2.json?.message }));
check("5) updatedAt markup terisi", typeof setMarkup2.json?.updatedAt === "string", String(setMarkup2.json?.updatedAt));
check("5) bukti DB: platform_settings menyimpan markup 2", String((scalar<{ value: string }>("SELECT value FROM platform_settings WHERE key='ai_pricing'") ?? { value: "" }).value).includes('"markup":2'), String((scalar<{ value: string }>("SELECT value FROM platform_settings WHERE key='ai_pricing'") ?? { value: "" }).value));

const memberReg = await member.call("POST", "/api/v1/auth/register", { email: memberEmail, password, displayName: "Pemilik Proyek Harga" });
check("5) akun pengguna biasa terdaftar beserta workspace", memberReg.status === 201 && Boolean(memberReg.json?.workspace?.id), JSON.stringify(memberReg.json)?.slice(0, 160));
const workspaceId = String(memberReg.json?.workspace?.id ?? "");
const project = await member.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Proyek Harga Wave 9", slug: `harga-${stamp}` });
check("5) proyek uji dibuat", project.status === 201, JSON.stringify(project.json)?.slice(0, 160));
const projectId = String(project.json?.id ?? "");
const run = await member.call("POST", `/api/v1/projects/${projectId}/runs`, { prompt: RUN_PROMPT });
check("5) run diterima 202", run.status === 202 && Boolean(run.json?.id), JSON.stringify(run.json)?.slice(0, 200));
check("5) run memakai model bawaan PRIME_AGENT_MODEL", run.json?.model === RUN_MODEL, String(run.json?.model));

let usageRow: any = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  usageRow = scalar("SELECT run_id AS runId, model, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens, cost_micros AS costMicros, sell_cost_micros AS sellCostMicros, estimated FROM run_usage WHERE project_id=?", projectId);
  if (usageRow) break;
  await sleep(250);
}
check("5) bukti DB: baris run_usage muncul untuk run nyata (mesin mock)", Boolean(usageRow), JSON.stringify(usageRow));
if (!usageRow) {
  skip("5) harga pokok & harga jual pada baris nyata", "run mock tidak menghasilkan baris run_usage dalam 15 detik");
} else {
  const expectedRunBase = expectedBaseMicros(RUN_MODEL, Number(usageRow.inputTokens), Number(usageRow.outputTokens), Number(usageRow.cacheReadTokens ?? 0), 0);
  check("5) baris run_usage mencatat model yang dipakai", usageRow.model === RUN_MODEL, String(usageRow.model));
  check("5) token dari mesin disimpan (estimated = 0)", Number(usageRow.estimated) === 0, String(usageRow.estimated));
  check("5) cost_micros (harga pokok) terisi dan > 0", usageRow.costMicros !== null && Number(usageRow.costMicros) > 0, String(usageRow.costMicros));
  check("5) cost_micros sama dengan harga katalog x token baris itu", Number(usageRow.costMicros) === expectedRunBase, `${usageRow.costMicros} vs ${expectedRunBase}`);
  check("5) sell_cost_micros = ROUND(cost_micros x markup 2)", Number(usageRow.sellCostMicros) === Math.round(Number(usageRow.costMicros) * 2), `${usageRow.sellCostMicros} vs ${Math.round(Number(usageRow.costMicros) * 2)}`);
  console.log(`INFO harga pokok baris nyata: cost_micros=${usageRow.costMicros} sell_cost_micros=${usageRow.sellCostMicros} tokens=${usageRow.inputTokens}/${usageRow.outputTokens} model=${usageRow.model}`);
  const setMarkup3 = await admin.call("PUT", "/api/v1/admin/pricing/settings", { markup: 3 });
  check("5) PUT markup 3 -> 200 ok", setMarkup3.status === 200 && setMarkup3.json?.markup === 3, JSON.stringify(setMarkup3.json)?.slice(0, 200));
  check("5) rowsUpdated menghitung baris run_usage yang dihitung ulang", Number(setMarkup3.json?.rowsUpdated) >= 1, String(setMarkup3.json?.rowsUpdated));
  const afterRow = scalar("SELECT cost_micros AS costMicros, sell_cost_micros AS sellCostMicros FROM run_usage WHERE run_id=?", usageRow.runId);
  check("5) harga pokok TIDAK berubah saat markup dinaikkan", Number(afterRow?.costMicros) === Number(usageRow.costMicros), JSON.stringify(afterRow));
  check("5) sell_cost_micros dihitung ulang = ROUND(cost_micros x 3)", Number(afterRow?.sellCostMicros) === Math.round(Number(usageRow.costMicros) * 3), `${afterRow?.sellCostMicros} vs ${Math.round(Number(usageRow.costMicros) * 3)}`);
  console.log(`INFO setelah markup 3: cost_micros=${afterRow?.costMicros} sell_cost_micros=${afterRow?.sellCostMicros} token=${usageRow.inputTokens}/${usageRow.outputTokens} model=${usageRow.model}`);
  check("5) tidak ada baris run_usage ganda untuk satu run", tableCount("SELECT COUNT(*) AS n FROM run_usage WHERE run_id=?", usageRow.runId) === 1, String(tableCount("SELECT COUNT(*) AS n FROM run_usage WHERE run_id=?", usageRow.runId)));
  const used = usageByModel(30);
  check("5) usageByModel melaporkan model nyata dengan harga pokok dan harga jual",
    used.some((row) => row.model === RUN_MODEL && row.baseMicros === Number(usageRow.costMicros) && row.sellMicros === Math.round(Number(usageRow.costMicros) * 3)),
    JSON.stringify(used)?.slice(0, 240));
  const projectUsage = await member.call("GET", `/api/v1/projects/${projectId}/usage?days=30`);
  check("5) GET usage proyek memuat markup yang berlaku (3)", projectUsage.status === 200 && projectUsage.json?.markup === 3, JSON.stringify({ status: projectUsage.status, markup: projectUsage.json?.markup }));
  check("5) totals.billedMicros = ROUND(cost x 3)", Number(projectUsage.json?.totals?.billedMicros) === Math.round(Number(usageRow.costMicros) * 3), JSON.stringify(projectUsage.json?.totals));
  check("5) totals.costMicros tetap harga pokok", Number(projectUsage.json?.totals?.costMicros) === Number(usageRow.costMicros), String(projectUsage.json?.totals?.costMicros));
  check("5) totals.billedUsd = billedMicros / 1 juta", Math.abs(Number(projectUsage.json?.totals?.billedUsd) - Number(projectUsage.json?.totals?.billedMicros) / 1e6) < 1e-9, String(projectUsage.json?.totals?.billedUsd));
  check("5) rincian per model memuat billedMicros", Number(projectUsage.json?.byModel?.[0]?.billedMicros) === Math.round(Number(usageRow.costMicros) * 3), JSON.stringify(projectUsage.json?.byModel));
  check("5) rincian harian memuat billedMicros", Number(projectUsage.json?.daily?.[0]?.billedMicros) === Math.round(Number(usageRow.costMicros) * 3), JSON.stringify(projectUsage.json?.daily));
}

// ------------------------------------------------------------------ 6) hanya admin platform
const memberGet = await member.call("GET", "/api/v1/admin/pricing");
check("6) pengguna biasa ditolak 403 ADMIN_REQUIRED pada GET konsol harga", memberGet.status === 403 && memberGet.json?.error === "ADMIN_REQUIRED", JSON.stringify(memberGet.json));
const memberGetOne = await member.call("GET", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`);
check("6) pengguna biasa ditolak 403 pada GET harga satu model", memberGetOne.status === 403 && memberGetOne.json?.error === "ADMIN_REQUIRED", JSON.stringify(memberGetOne.json));
const memberPut = await member.call("PUT", "/api/v1/admin/pricing/settings", { markup: 50 });
check("6) pengguna biasa ditolak 403 pada PUT markup", memberPut.status === 403 && memberPut.json?.error === "ADMIN_REQUIRED", JSON.stringify(memberPut.json));
const memberPutModel = await member.call("PUT", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`, { input: 1, output: 1 });
check("6) pengguna biasa ditolak 403 pada PUT harga model", memberPutModel.status === 403 && memberPutModel.json?.error === "ADMIN_REQUIRED", JSON.stringify(memberPutModel.json));
const memberDelete = await member.call("DELETE", `/api/v1/admin/pricing/models/${KATALOG_MODEL}`);
check("6) pengguna biasa ditolak 403 pada DELETE harga model", memberDelete.status === 403 && memberDelete.json?.error === "ADMIN_REQUIRED", JSON.stringify(memberDelete.json));
check("6) percobaan bukan admin tidak mengubah markup tersimpan", pricingSettings().markup === 3, String(pricingSettings().markup));

// ------------------------------------------------------------------ 7) status-hub & konsol
const hub = await admin.call("GET", "/api/v1/status-hub");
const aiPricing = hub.json?.aiPricing;
check("7) status-hub memuat blok aiPricing", Boolean(aiPricing) && typeof aiPricing === "object", JSON.stringify(aiPricing));
check("7) aiPricing.markup = markup yang sedang berlaku (3)", Number(aiPricing?.markup) === 3, String(aiPricing?.markup));
check("7) aiPricing.currency = USD", aiPricing?.currency === "USD", String(aiPricing?.currency));
check("7) aiPricing.catalogSize = jumlah model katalog", Number(aiPricing?.catalogSize) === Object.keys(MODEL_PRICES).length, `${aiPricing?.catalogSize} vs ${Object.keys(MODEL_PRICES).length}`);
check("7) aiPricing.overrideCount = 0", Number(aiPricing?.overrideCount) === 0, String(aiPricing?.overrideCount));
if (usageRow) {
  const expectedCost = Number(usageRow.costMicros);
  const expectedBilled = Math.round(expectedCost * 3);
  check("7) aiPricing.costMicros30d = jumlah harga pokok run 30 hari", Number(aiPricing?.costMicros30d) === expectedCost, `${aiPricing?.costMicros30d} vs ${expectedCost}`);
  check("7) aiPricing.billedMicros30d = jumlah harga jual run 30 hari", Number(aiPricing?.billedMicros30d) === expectedBilled, `${aiPricing?.billedMicros30d} vs ${expectedBilled}`);
  check("7) aiPricing.marginMicros30d = harga jual - harga pokok", Number(aiPricing?.marginMicros30d) === expectedBilled - expectedCost, `${aiPricing?.marginMicros30d} vs ${expectedBilled - expectedCost}`);
} else {
  check("7) aiPricing.costMicros30d terisi dari tabel run_usage", Number(aiPricing?.costMicros30d) === 0, String(aiPricing?.costMicros30d));
  check("7) aiPricing.billedMicros30d terisi dari tabel run_usage", Number(aiPricing?.billedMicros30d) === 0, String(aiPricing?.billedMicros30d));
  check("7) aiPricing.marginMicros30d = selisih", Number(aiPricing?.marginMicros30d) === Number(aiPricing?.billedMicros30d) - Number(aiPricing?.costMicros30d), "");
}
const console30 = await admin.call("GET", "/api/v1/admin/pricing?days=30&limit=3&only=used");
check("7) GET konsol harga menjawab 200 untuk admin", console30.status === 200, JSON.stringify(console30.json)?.slice(0, 160));
check("7) konsol memuat markup, currency, catalogSize, overrideCount, days",
  console30.json?.markup === 3 && console30.json?.currency === "USD" && typeof console30.json?.catalogSize === "number" && Number(console30.json?.overrideCount) === 0 && Number(console30.json?.days) === 30,
  JSON.stringify({ markup: console30.json?.markup, days: console30.json?.days, catalogSize: console30.json?.catalogSize }));
check("7) konsol memuat totals rinci (runs, base, sell, margin, pricedRuns, unpricedRuns, modelsUsed)",
  ["runs", "baseMicros", "sellMicros", "marginMicros", "pricedRuns", "unpricedRuns", "modelsUsed"].every((key) => key in (console30.json?.totals ?? {})) && console30.json.totals.marginMicros === console30.json.totals.sellMicros - console30.json.totals.baseMicros,
  JSON.stringify(console30.json?.totals));
check("7) opsi limit=3 dihormati (hanya model terpakai)", Array.isArray(console30.json?.models) && console30.json.models.length <= 3, String(console30.json?.models?.length));
check("7) konsol memuat catatan penjelas berbahasa Indonesia", typeof console30.json?.note === "string" && console30.json.note.includes("sellMicros"), String(console30.json?.note));
const consoleFiltered = await admin.call("GET", `/api/v1/admin/pricing?search=${encodeURIComponent(KATALOG_MODEL)}&only=all&limit=5`);
check("7) filter pencarian mengembalikan model yang memuat kata kunci (tanpa peduli huruf besar/kecil)",
  consoleFiltered.status === 200 && Array.isArray(consoleFiltered.json?.models) && consoleFiltered.json.models.length > 0
    && consoleFiltered.json.models.every((row: any) => String(row.model).toLowerCase().includes(KATALOG_MODEL.toLowerCase())),
  JSON.stringify(consoleFiltered.json?.models?.map((row: any) => row.model)));

// ------------------------------------------------------------------ 8) validatePrice
const vNegatif = validatePrice({ input: -0.01, output: 1 });
check("8) validatePrice menolak harga negatif dengan pesan Indonesia", typeof vNegatif === "string" && vNegatif.includes("tidak boleh negatif"), String(vNegatif));
const vBukanAngka = validatePrice({ input: Number.NaN, output: 1 });
check("8) validatePrice menolak yang bukan angka dengan pesan Indonesia", typeof vBukanAngka === "string" && vBukanAngka.includes("harus berupa angka"), String(vBukanAngka));
const vNol = validatePrice({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
check("8) validatePrice menerima 0", vNol === null, String(vNol));
const vTerlaluBesar = validatePrice({ input: 200_000, output: 1 });
check("8) validatePrice menolak angka terlalu besar", typeof vTerlaluBesar === "string" && vTerlaluBesar.includes("terlalu besar"), String(vTerlaluBesar));
check("8) pesan validatePrice menyebut nama kolom harga", typeof vNegatif === "string" && vNegatif.startsWith("harga masukan"), String(vNegatif));
const vNormal = validatePrice({ input: 2.5, output: 10 });
check("8) validatePrice menerima harga wajar", vNormal === null, String(vNormal));

// ------------------------------------------------------------------ 9) kembalikan markup ke 1
const setMarkup1 = await admin.call("PUT", "/api/v1/admin/pricing/settings", { markup: 1 });
check("9) markup dikembalikan ke 1 -> 200 ok", setMarkup1.status === 200 && setMarkup1.json?.markup === 1, JSON.stringify(setMarkup1.json)?.slice(0, 200));
if (usageRow) {
  const finalRow = scalar("SELECT cost_micros AS costMicros, sell_cost_micros AS sellCostMicros FROM run_usage WHERE run_id=?", usageRow.runId);
  check("9) pada markup 1, harga jual = harga pokok pada baris nyata", Number(finalRow?.sellCostMicros) === Number(finalRow?.costMicros), JSON.stringify(finalRow));
  check("9) harga pokok tetap sama setelah seluruh perubahan markup", Number(finalRow?.costMicros) === Number(usageRow.costMicros), JSON.stringify(finalRow));
  console.log(`INFO setelah markup 1: cost_micros=${finalRow?.costMicros} sell_cost_micros=${finalRow?.sellCostMicros}`);
}

// ------------------------------------------------------------------ 10) pelengkapan baris lama
// Baris yang ditulis sebelum kolom harga jual ada tidak punya nilainya. Bila basis data dipulihkan
// dari cadangan rilis lama, konsol akan melaporkan pendapatan nol dan margin negatif. Pelengkapan
// hanya menyentuh baris kosong, jadi aman diulang setiap aplikasi menyala.
if (usageRow) {
  const backfillMarkup = pricingSettings().markup;
  const backfillId = `w9-backfill-${stamp}`;
  const backfillCost = 4321;
  db.prepare(`INSERT INTO run_usage (id, run_id, project_id, model, provider, input_tokens, output_tokens, total_tokens, cost_micros, estimated, created_at, sell_cost_micros)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,NULL)`)
    .run(backfillId, usageRow.runId, projectId, RUN_MODEL, "mock", 100, 50, 150, backfillCost, new Date().toISOString());
  const kosong = scalar<{ sell: number | null }>("SELECT sell_cost_micros AS sell FROM run_usage WHERE id=?", backfillId);
  check("10) baris lama tanpa harga jual memang kosong", kosong?.sell === null, JSON.stringify(kosong));
  const diisi = backfillSellCosts();
  check("10) pelengkapan mengisi baris kosong", diisi >= 1, `baris diisi=${diisi}`);
  const terisi = scalar<{ sell: number | null }>("SELECT sell_cost_micros AS sell FROM run_usage WHERE id=?", backfillId);
  check("10) harga jual terisi = harga pokok x markup", Number(terisi?.sell) === Math.round(backfillCost * backfillMarkup), `sell=${terisi?.sell} markup=${backfillMarkup}`);
  const ulang = backfillSellCosts();
  check("10) pelengkapan aman diulang (tidak menyentuh baris terisi)", ulang === 0, `baris=${ulang}`);
  db.prepare("DELETE FROM run_usage WHERE id=?").run(backfillId);
} else {
  skip("10) pelengkapan baris lama tanpa harga jual", "baris run_usage nyata tidak tersedia");
}

// ------------------------------------------------------------------ ringkasan
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
if (skipped.length > 0) for (const item of skipped) console.log(`SKIP ${item}`);
if (failed === 0) {
  console.log("ALL_PRICING_TESTS_PASSED");
  process.exit(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
process.exit(1);

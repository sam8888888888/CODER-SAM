/**
 * Uji Wave 11A (butir 79): header Content-Security-Policy + netralisasi HTML dokumen.
 *
 * Yang dibuktikan berkas ini:
 *  - header CSP benar-benar terkirim pada HTML dashboard, JSON API, 404, 401, dan jawaban yang
 *    ditolak lebih awal oleh hook CSRF;
 *  - kebijakan wajib PRD ada semua: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`,
 *    `frame-ancestors 'self'`, `base-uri 'self'`, tanpa `unsafe-eval` dan tanpa `unsafe-inline`
 *    untuk skrip; `img-src`/`frame-src` memuat `blob:` untuk pratinjau;
 *  - berkas artefak mentah (`/api/v1/artifacts/:id/raw`) disajikan dengan CSP paling ketat
 *    (`sandbox`, `script-src 'none'`) karena isinya tidak dipercaya;
 *  - pembersih HTML (`html-sanitize.ts`) membuang skrip, iframe, object, embed, link, form,
 *    `meta http-equiv`, penangan `on*`, `javascript:`, dan `data:text/html` — termasuk yang
 *    disamarkan dengan entitas — sementara HTML bersih tetap utuh;
 *  - di peramban Chromium sungguhan: seluruh halaman dashboard termuat tanpa satu pun galat CSP,
 *    dan dokumen HTML berbahaya (mentah, hasil sanitasi, dan hasil netralisasi) diukur benar-benar
 *    tidak menjalankan skrip. Ada uji pembanding (kontrol): HTML mentah TANPA CSP memang
 *    menjalankan skripnya, jadi penanda `window.__pwned` ini terbukti bekerja.
 *
 * Keputusan `style-src-attr` diambil dari pengukuran, bukan selera: dashboard memakai banyak
 * atribut `style={{...}}` (React menulisnya lewat CSSOM), jadi jumlah galat CSP per halaman diukur
 * lebih dulu. Bila 0 galat, `style-src-attr 'unsafe-inline'` TIDAK dipasang.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11a-csp.e2e.ts
 *
 * Catatan jujur: berkas ini hanya menambah berkas uji baru (dan berkas milik butir 79).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Akar repo: berkas uji ini ada di apps/api/test/. */
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const DASHBOARD_DIR = "/workspace/coblai-dinda/coder-dashboard";
const DIST_DIR = `${DASHBOARD_DIR}/dist`;

/** Port butir 79 = 7262. Bila port itu sedang dipakai suite lain, ambil port bebas di rentang 11A. */
async function freePort(preferred: number): Promise<number> {
  const candidates = [preferred, ...Array.from({ length: 30 }, (_, index) => 7240 + index).filter((value) => value !== preferred)];
  for (const candidate of candidates) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(candidate, "127.0.0.1");
    });
    if (free) return candidate;
  }
  throw new Error("tidak ada port bebas di rentang Wave 11A");
}

const port = await freePort(7262);
const dataDir = `/tmp/coder-wave11a-csp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const ownerEmail = `w11a-csp-${stamp}@example.test`;
// SPA hasil build dipakai apa adanya bila ada, supaya pengukuran dilakukan pada halaman sungguhan.
const useBuiltDashboard = existsSync(`${DIST_DIR}/index.html`);
const publicDir = useBuiltDashboard ? DIST_DIR : `${dataDir}/public`;
if (!useBuiltDashboard) {
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><html lang=\"id\"><head><title>Dashboard uji</title></head><body><div id=\"root\"></div></body></html>");
}

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = publicDir;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave11a-csp-model";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.PLATFORM_ADMIN_EMAILS = ownerEmail;
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.DEVICE_TRACKING = "false";
process.env.CSP_ENABLED = "true";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const configMod: any = await import("../src/config.js");
const sanitizeMod: any = await import("../src/html-sanitize.js");
const cspMod: any = await import("../src/wave11a/csp.js");
const { config } = configMod;
const { sanitizeHtml, neutralizeHtml, hasDangerousHtml, isSafeUrl, sanitizeSvg } = sanitizeMod;

const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${String(detail).slice(0, 300)}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 200) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);

/** Klien HTTP kecil: jar cookie + token CSRF ganda, sama seperti suite Wave 11 yang lain. */
function client() {
  const jar = new Map<string, string>();
  let primed = false;
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    if (mutating) await prime();
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: base,
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(mutating && jar.get("coder_csrf") ? { "x-csrf-token": String(jar.get("coder_csrf")) } : {}),
      ...extra,
    };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of raw) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim();
      const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const text = await response.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, headers: response.headers, setCookie: raw.join(" | ") };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server uji belum siap */ } }
  return { call, jar, bootstrap: prime, get cookies() { return cookieHeader(); }, get csrf() { return String(jar.get("coder_csrf") ?? ""); } };
}

const owner = client();
const anon = client();

for (let attempt = 0; attempt < 120; attempt += 1) {
  try { const ready = await fetch(`${base}/health`); if (ready.ok) break; } catch { /* belum siap */ }
  await sleep(200);
}
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), PUBLIC_DIR=${publicDir}`);
console.log(`INFO dashboard hasil build dipakai: ${useBuiltDashboard ? "ya" : "tidak (SPA dist belum ada)"}`);

// =====================================================================================
// Bagian 1: kebijakan CSP itu sendiri (unit) — dipakai sebagai dasar pemeriksaan HTTP.
// =====================================================================================
console.log("\n--- Bagian 1: isi kebijakan CSP ---");
function directivesOf(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const pieces = trimmed.split(/\s+/);
    out[pieces[0].toLowerCase()] = pieces.slice(1).join(" ");
  }
  return out;
}
const policy = cspMod.CSP_POLICY as string;
const artifactPolicy = cspMod.CSP_POLICY_ARTIFACT as string;
check("CSP_ENABLED dibaca true dari konfigurasi", config.CSP_ENABLED === true, String(config.CSP_ENABLED));
check("default-src 'self' ada di kebijakan", directivesOf(policy)["default-src"] === "'self'", policy);
check("script-src 'self' ada di kebijakan", directivesOf(policy)["script-src"] === "'self'", directivesOf(policy)["script-src"]);
check("kebijakan TIDAK memuat unsafe-eval", !/unsafe-eval/.test(policy), policy);
check("kebijakan TIDAK memuat unsafe-inline (skrip inline dilarang A6 PRD)", !/unsafe-inline/.test(policy), policy);
check("object-src 'none' ada di kebijakan", directivesOf(policy)["object-src"] === "'none'", directivesOf(policy)["object-src"]);
check("frame-ancestors 'self' ada di kebijakan", directivesOf(policy)["frame-ancestors"] === "'self'", directivesOf(policy)["frame-ancestors"]);
check("base-uri 'self' ada di kebijakan", directivesOf(policy)["base-uri"] === "'self'", directivesOf(policy)["base-uri"]);
check("img-src memuat blob: untuk pratinjau", /\bblob:/.test(directivesOf(policy)["img-src"] ?? ""), directivesOf(policy)["img-src"]);
check("frame-src memuat blob: untuk pratinjau", /\bblob:/.test(directivesOf(policy)["frame-src"] ?? ""), directivesOf(policy)["frame-src"]);
check("style-src memuat fonts.googleapis.com dan font-src memuat fonts.gstatic.com",
  /fonts\.googleapis\.com/.test(directivesOf(policy)["style-src"] ?? "") && /fonts\.gstatic\.com/.test(directivesOf(policy)["font-src"] ?? ""),
  `${directivesOf(policy)["style-src"]} | ${directivesOf(policy)["font-src"]}`);
check("kebijakan artefak mentah memakai sandbox + script-src 'none'",
  /\bsandbox\b/.test(artifactPolicy) && directivesOf(artifactPolicy)["script-src"] === "'none'", artifactPolicy);
check("pemilih kebijakan: /raw dan /download dapat kebijakan artefak, rute lain tidak",
  cspMod.policyFor("/api/v1/artifacts/abc/raw") === artifactPolicy
  && cspMod.policyFor("/api/v1/artifacts/abc/download?x=1") === artifactPolicy
  && cspMod.policyFor("/api/v1/artifacts/abc/diff/def") === policy
  && cspMod.policyFor("/") === policy,
  "pemilih kebijakan salah");
check("kebijakan artefak juga tanpa unsafe-eval", !/unsafe-eval/.test(artifactPolicy), artifactPolicy);
check("pemilih kebijakan sadar tipe isi: HTML/SVG/XML/JSON dibungkus, PDF dan biner tidak",
  cspMod.policyUntukRespons("/", "text/html; charset=utf-8") === policy
  && cspMod.policyUntukRespons("/api/v1/artifacts/a/raw", "text/html") === artifactPolicy
  && cspMod.policyUntukRespons("/api/v1/artifacts/a/raw", "image/svg+xml") === artifactPolicy
  && cspMod.policyUntukRespons("/api/v1/artifacts/a/raw", "application/pdf") === null
  && cspMod.policyUntukRespons("/api/v1/artifacts/a/raw", "image/png") === null
  && cspMod.policyUntukRespons("/api/v1/artifacts/a/raw", "application/octet-stream") === null
  && cspMod.policyUntukRespons("/api/v1/artifacts/a/raw", "") === artifactPolicy
  && cspMod.policyUntukRespons("/health", "application/json") === policy
  && cspMod.policyUntukRespons("/index.html", "") === policy,
  "pemilih kebijakan berbasis tipe isi salah");

// Lapisan nginx menyajikan halaman galatnya sendiri, jadi berkas konfigurasinya juga wajib memuat
// kebijakan yang sama; dua kebijakan berbeda akan saling mempersempit tanpa sengaja.
const berkasNginx = join(repoRoot, "nginx", "coder.sam.university.conf");
const isiNginx = existsSync(berkasNginx) ? readFileSync(berkasNginx, "utf8") : "";
check("nginx/coder.sam.university.conf memuat CSP yang sama persis dengan API",
  isiNginx.includes(`"${policy}"`), isiNginx.slice(0, 80));
check("nginx memakai flag always supaya CSP juga terkirim pada halaman galatnya",
  /add_header\s+Content-Security-Policy\s+"[^"]+"\s+always;/.test(isiNginx), "add_header selalu tidak ditemukan");

// =====================================================================================
// Bagian 2: header CSP benar-benar terkirim (HTTP nyata, bukan hanya konstanta).
// =====================================================================================
console.log("\n--- Bagian 2: header CSP terkirim ---");
const rootPage = await anon.call("GET", "/");
const rootCsp = rootPage.headers.get("content-security-policy");
console.log(`INFO GET / -> ${rootPage.status} ${String(rootPage.headers.get("content-type"))}`);
check("HTML dashboard dijawab 200 sebagai text/html", rootPage.status === 200 && /text\/html/.test(String(rootPage.headers.get("content-type"))), `${rootPage.status} ${String(rootPage.headers.get("content-type"))}`);
check("HTML dashboard memuat header Content-Security-Policy", Boolean(rootCsp), String(rootCsp));
check("CSP HTML dashboard sama dengan kebijakan resmi", rootCsp === policy, String(rootCsp).slice(0, 120));

const health = await anon.call("GET", "/health");
check("JSON API (/health) memuat header CSP", health.status === 200 && Boolean(health.headers.get("content-security-policy")), `${health.status} ${String(health.headers.get("content-security-policy"))}`);

const apiUnknown = await anon.call("GET", "/api/v1/tidak-ada-rute-ini");
check("404 rute API memuat header CSP", apiUnknown.status === 404 && Boolean(apiUnknown.headers.get("content-security-policy")), `${apiUnknown.status} ${String(apiUnknown.headers.get("content-security-policy"))}`);

const staticUnknown = await anon.call("GET", "/halaman-spa-tidak-ada");
check("404 alamat bukan API disajikan SPA dan tetap memuat header CSP",
  staticUnknown.status === 200 && /text\/html/.test(String(staticUnknown.headers.get("content-type"))) && Boolean(staticUnknown.headers.get("content-security-policy")),
  `${staticUnknown.status} ${String(staticUnknown.headers.get("content-type"))} csp=${String(staticUnknown.headers.get("content-security-policy")).slice(0, 40)}`);

const unauth = await anon.call("GET", "/api/v1/auth/me");
check("jawaban 401 (tanpa sesi) memuat header CSP", unauth.status === 401 && Boolean(unauth.headers.get("content-security-policy")), `${unauth.status} ${String(unauth.headers.get("content-security-policy"))}`);

// Jawaban yang dikirim lebih awal oleh hook CSRF: di sinilah jaring pengaman `onSend` diuji.
const csrfBlocked = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST", headers: { "content-type": "application/json", origin: "https://jahat.example" },
  body: JSON.stringify({ email: "x@example.test", password: "salah-sekali" }),
});
const csrfCsp = csrfBlocked.headers.get("content-security-policy");
await csrfBlocked.text();
check("jawaban yang ditolak CSRF (403) tetap memuat header CSP", csrfBlocked.status === 403 && Boolean(csrfCsp), `${csrfBlocked.status} ${String(csrfCsp)}`);

const options = await fetch(`${base}/health`, { method: "OPTIONS" });
const optionsCsp = options.headers.get("content-security-policy");
await options.text();
check("jawaban metode lain (OPTIONS) tetap memuat header CSP", Boolean(optionsCsp), String(optionsCsp));

const headerValue = String(rootCsp ?? "");
check("header yang terkirim tidak memuat unsafe-eval dan tidak memuat unsafe-inline untuk skrip",
  !/unsafe-eval/.test(headerValue) && !/unsafe-inline/.test(headerValue), headerValue);
check("header yang terkirim memuat keempat direktif wajib PRD",
  /default-src 'self'/.test(headerValue) && /script-src 'self'/.test(headerValue)
  && /object-src 'none'/.test(headerValue) && /frame-ancestors 'self'/.test(headerValue) && /base-uri 'self'/.test(headerValue),
  headerValue);

// =====================================================================================
// Bagian 3: pembersih HTML (html-sanitize.ts) — skrip & vektor jahat dibuang, isi bersih utuh.
// =====================================================================================
console.log("\n--- Bagian 3: pembersih HTML ---");

/** Contoh dokumen bersih: harus keluar utuh. */
const HTML_BERSIH = "<h1 id=\"judul\">Judul</h1><p>Halo <strong>dunia</strong> &amp; <em>teman</em></p>"
  + "<ul><li>satu</li><li>dua</li></ul><table><tr><td>1</td><td>2</td></tr></table>"
  + "<a href=\"https://contoh.test/dok\">tautan aman</a>";

/** Contoh dokumen jahat: semua vektor dari daftar butir 79 dipasang sekaligus. */
const HTML_JAHAT = [
  "<!doctype html><html lang=\"id\"><head><title>Dokumen Uji</title>",
  "<meta http-equiv=\"refresh\" content=\"0; url=https://jahat.example/redirect\">",
  "<link rel=\"stylesheet\" href=\"https://jahat.example/jahat.css\">",
  "</head><body>",
  "<h1 id=\"judul\">Dokumen Uji</h1>",
  "<p>Isi <strong>dokumen</strong> yang harus tetap terbaca.</p>",
  "<ul><li>satu</li><li>dua</li></ul>",
  "<script>window.__pwned = 1; document.title = \"PWNED\";</script>",
  "<img src=\"tidak-ada.png\" onerror=\"window.__pwned = 2\">",
  "<a href=\"javascript:window.__pwned=3\">tautan jahat</a>",
  "<a href=\"java&#x73;cript:window.__pwned=4\">tautan berentitas</a>",
  "<iframe src=\"javascript:window.__pwned=5\"></iframe>",
  "<object data=\"jahat.swf\"></object><embed src=\"jahat.swf\">",
  "<form action=\"/api/v1/auth/login\"><input name=\"email\" value=\"a@b.test\"></form>",
  "<div style=\"color:red\" onclick=\"window.__pwned = 6\">gaya inline</div>",
  "<!-- <script>window.__pwned = 7</script> -->",
  "<svg onload=\"window.__pwned=8\"><circle r=\"1\"></circle></svg>",
  "</body></html>",
].join("");

const hasilBersih = sanitizeHtml(HTML_BERSIH);
check("HTML bersih tetap utuh (h1, strong, em, ul/li, table/td)", ["<h1", "<strong>", "<em>", "<li>", "<table>", "<td>"].every((part) => hasilBersih.includes(part)), hasilBersih);
check("tautan aman https tetap dipertahankan", hasilBersih.includes("href=\"https://contoh.test/dok\""), hasilBersih);
check("entitas teks &amp; tidak rusak", hasilBersih.includes("&amp;"), hasilBersih);

const hasilJahat = sanitizeHtml(HTML_JAHAT);
check("sanitizeHtml membuang tag <script>", !/<script/i.test(hasilJahat), hasilJahat.slice(0, 200));
check("isi skrip tidak ikut tampil sebagai teks", !/__pwned/.test(hasilJahat), hasilJahat.slice(0, 200));
check("sanitizeHtml membuang penangan kejadian on* (onerror/onclick/onload)", !/\son[a-z]+\s*=/i.test(hasilJahat), hasilJahat.slice(0, 200));
check("sanitizeHtml membuang tautan javascript:", !/javascript\s*:/i.test(hasilJahat), hasilJahat.slice(0, 200));
check("sanitizeHtml membuang tautan javascript: yang disamarkan entitas", !/java&#x73;cript/i.test(hasilJahat) && !/href=/.test(hasilJahat), hasilJahat.slice(0, 200));
check("sanitizeHtml membuang <iframe>, <object>, <embed>, <link>, <form>",
  !/<(iframe|object|embed|link|form)\b/i.test(hasilJahat), hasilJahat.slice(0, 200));
check("sanitizeHtml membuang <meta http-equiv> dan <svg>", !/<meta\b/i.test(hasilJahat) && !/<svg\b/i.test(hasilJahat), hasilJahat.slice(0, 200));
check("sanitizeHtml membuang atribut style dan komentar berisi skrip",
  !/style=/.test(hasilJahat) && !/<!--/.test(hasilJahat), hasilJahat.slice(0, 200));
check("isi dokumen tetap terbaca sesudah dibersihkan (h1 + strong + li)",
  hasilJahat.includes("<h1") && hasilJahat.includes("<strong>") && hasilJahat.includes("<li>") && hasilJahat.includes("Dokumen Uji"),
  hasilJahat);

const hasilNetral = neutralizeHtml(HTML_JAHAT);
check("neutralizeHtml membuang SEMUA atribut", !/=\s*["']/.test(hasilNetral), hasilNetral);
check("neutralizeHtml membuang tautan dan gambar", !/<a\b/i.test(hasilNetral) && !/<img\b/i.test(hasilNetral), hasilNetral);
check("neutralizeHtml tetap menyimpan teks dokumen", hasilNetral.includes("Dokumen Uji") && !/__pwned/.test(hasilNetral), hasilNetral.slice(0, 200));

const pola: Array<[string, boolean]> = [
  ["tag script", true], ["penangan onerror", true], ["tautan javascript:", true],
  ["tautan javascript: berentitas", true], ["iframe", true], ["meta refresh", true], ["form", true],
  ["data:text/html", true], ["link stylesheet luar", true], ["dokumen bersih", false],
];
const contohPola: Record<string, string> = {
  "tag script": "<p>halo</p><script>alert(1)</script>",
  "penangan onerror": "<img src=\"x\" onerror=\"alert(1)\">",
  "tautan javascript:": "<a href=\"javascript:alert(1)\">x</a>",
  "tautan javascript: berentitas": "<a href=\"java&#x73;cript:alert(1)\">x</a>",
  "iframe": "<iframe src=\"https://jahat.test\"></iframe>",
  "meta refresh": "<meta http-equiv=\"refresh\" content=\"0;url=https://jahat.test\">",
  "form": "<form action=\"https://jahat.test\"><input name=\"a\"></form>",
  "data:text/html": "<a href=\"data:text/html,<b>x</b>\">x</a>",
  "link stylesheet luar": "<link rel=\"stylesheet\" href=\"https://jahat.test/x.css\">",
  "dokumen bersih": HTML_BERSIH,
};
for (const [nama, harusBahaya] of pola) {
  check(`hasDangerousHtml menilai "${nama}" = ${harusBahaya ? "berbahaya" : "aman"}`,
    hasDangerousHtml(contohPola[nama]) === harusBahaya, String(hasDangerousHtml(contohPola[nama])));
}
check("kata biasa seperti \"ongkos=\" tidak dianggap penangan kejadian", hasDangerousHtml("<p>Total ongkos= 10 ribu</p>") === false, "false positive");

const urlUji: Array<[string, boolean]> = [
  ["javascript:alert(1)", false], ["java&#x73;cript:alert(1)", false], ["JaVaScRiPt:alert(1)", false],
  ["java\tscript:alert(1)", false], ["data:text/html,<script>alert(1)</script>", false],
  ["data:image/png;base64,AAAA", true], ["/relatif/gambar.png", true],
  ["https://contoh.test/x", true], ["#anchor", true], ["mailto:a@b.test", true],
];
for (const [nilai, aman] of urlUji) {
  check(`isSafeUrl("${nilai.replace(/\t/g, "\\t").slice(0, 30)}") = ${aman}`, isSafeUrl(nilai) === aman, String(isSafeUrl(nilai)));
}
check("skrip tanpa penutup membuang sisa dokumen (seperti peramban)", !/alert/.test(sanitizeHtml("teks sebelum<script>alert(1)")), sanitizeHtml("teks sebelum<script>alert(1)"));
check("tag tak dikenal dibuang tetapi teksnya tetap", sanitizeHtml("<marquee>halo</marquee>").includes("halo"), sanitizeHtml("<marquee>halo</marquee>"));
check("teks bertanda < di-escape supaya tidak jadi tag", sanitizeHtml("1 < 2 & 3").includes("&lt; 2"), sanitizeHtml("1 < 2 & 3"));

const svgJahat = "<svg viewBox=\"0 0 10 10\"><script>alert(1)</script><rect width=\"10\" height=\"10\" fill=\"red\" onload=\"alert(2)\"/></svg>";
const svgBersih = sanitizeSvg(svgJahat);
check("sanitizeSvg membuang skrip dan onload, menyimpan bentuknya",
  !/<script/i.test(svgBersih) && !/onload/i.test(svgBersih) && /viewBox="0 0 10 10"/.test(svgBersih) && /fill="red"/.test(svgBersih), svgBersih);

const targetBlank = sanitizeHtml("<a href=\"https://contoh.test\" target=\"_blank\">x</a>");
check("tautan target=\"_blank\" mendapat rel=\"noopener noreferrer\"", /rel="noopener noreferrer"/.test(targetBlank), targetBlank);

// Berapa atribut style inline di dashboard? Angka ini yang dipakai memutuskan style-src-attr.
function hitungAtributStyleInline(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { total += hitungAtributStyleInline(full); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const matches = readFileSync(full, "utf8").match(/style=\{\{/g);
    total += matches ? matches.length : 0;
  }
  return total;
}
const jumlahStyleInline = existsSync(`${DASHBOARD_DIR}/src`) ? hitungAtributStyleInline(`${DASHBOARD_DIR}/src`) : 0;
console.log(`INFO atribut style={{...}} terukur di dashboard src: ${jumlahStyleInline} pemakaian`);
check("pengukuran atribut style inline dashboard berjalan (> 0)", jumlahStyleInline > 0, String(jumlahStyleInline));

// =====================================================================================
// Bagian 4: artefak HTML berbahaya lewat API nyata (unggah -> jawaban /raw).
// =====================================================================================
console.log("\n--- Bagian 4: artefak HTML berbahaya lewat API ---");
await owner.bootstrap();
const pendaftaran = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Wave 11A" });
check("akun uji terdaftar", pendaftaran.status === 201 && Boolean(pendaftaran.json?.user?.id), `${pendaftaran.status} ${short(pendaftaran.json)}`);
const workspaceId = String(pendaftaran.json?.workspace?.id ?? "");
const proyek = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Proyek CSP", slug: `csp-${stamp}` });
const projectId = String(proyek.json?.id ?? "");
check("proyek uji dibuat", (proyek.status === 200 || proyek.status === 201) && Boolean(projectId), `${proyek.status} ${short(proyek.json)}`);

const artefak = await owner.call("POST", `/api/v1/projects/${projectId}/artifacts`, {
  name: "dokumen-jahat.html", mimeType: "text/html",
  contentBase64: Buffer.from(HTML_JAHAT, "utf8").toString("base64"),
});
const artifactId = String(artefak.json?.id ?? "");
check("artefak HTML berbahaya terunggah", artefak.status === 201 && Boolean(artifactId), `${artefak.status} ${short(artefak.json)}`);

const jawabanRaw = await owner.call("GET", `/api/v1/artifacts/${artifactId}/raw`);
check("jawaban /raw memakai kebijakan artefak paling ketat (sandbox + script-src 'none')",
  jawabanRaw.headers.get("content-security-policy") === artifactPolicy, String(jawabanRaw.headers.get("content-security-policy")).slice(0, 90));
check("jawaban /raw tetap menyajikan berkas aslinya (server tidak mengubah isi artefak)",
  jawabanRaw.text.includes("<script>") && jawabanRaw.text.includes("__pwned"), jawabanRaw.text.slice(0, 120));
check("jawaban /raw disajikan inline sebagai text/html dengan nosniff",
  /text\/html/.test(String(jawabanRaw.headers.get("content-type"))) && jawabanRaw.headers.get("x-content-type-options") === "nosniff",
  `${String(jawabanRaw.headers.get("content-type"))} nosniff=${String(jawabanRaw.headers.get("x-content-type-options"))}`);

const unggahArtefak = async (nama: string, mimeType: string, isi: Buffer): Promise<string> => {
  const jawaban = await owner.call("POST", `/api/v1/projects/${projectId}/artifacts`, { name: nama, mimeType, contentBase64: isi.toString("base64") });
  return String(jawaban.json?.id ?? "");
};
const SVG_JAHAT = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned=9"><script>window.__pwned=9;</script><rect width="10" height="10"/></svg>';
const artefakSvg = await unggahArtefak("gambar.svg", "image/svg+xml", Buffer.from(SVG_JAHAT, "utf8"));
const jawabanSvg = await owner.call("GET", `/api/v1/artifacts/${artefakSvg}/raw`);
check("SVG di /raw memakai kebijakan artefak paling ketat",
  jawabanSvg.headers.get("content-security-policy") === artifactPolicy, String(jawabanSvg.headers.get("content-security-policy")).slice(0, 80));

// PDF & biner TIDAK dibungkus CSP: penampil PDF Chrome menyisipkan plugin di dokumen itu, dan
// `object-src 'none'` membuat pratinjau kosong (lihat catatan di apps/api/src/wave11a/csp.ts).
const artefakPdf = await unggahArtefak("laporan.pdf", "application/pdf", Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "utf8"));
const jawabanPdf = await owner.call("GET", `/api/v1/artifacts/${artefakPdf}/raw`);
check("PDF di /raw TIDAK diberi CSP supaya pratinjau PDF peramban tidak kosong",
  jawabanPdf.status === 200 && jawabanPdf.headers.get("content-security-policy") === null,
  `${jawabanPdf.status} csp=${String(jawabanPdf.headers.get("content-security-policy"))}`);
check("PDF tetap disajikan sebagai application/pdf inline",
  /application\/pdf/.test(String(jawabanPdf.headers.get("content-type"))) && /inline/.test(String(jawabanPdf.headers.get("content-disposition"))),
  `${String(jawabanPdf.headers.get("content-type"))} ${String(jawabanPdf.headers.get("content-disposition"))}`);
const artefakPng = await unggahArtefak("gambar.png", "image/png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
const jawabanPng = await owner.call("GET", `/api/v1/artifacts/${artefakPng}/raw`);
check("gambar PNG di /raw tidak dibungkus CSP (biner, tidak bisa menjalankan markup)",
  jawabanPng.headers.get("content-security-policy") === null && /image\/png/.test(String(jawabanPng.headers.get("content-type"))),
  String(jawabanPng.headers.get("content-security-policy")));

// =====================================================================================
// Bagian 5: peramban Chromium sungguhan — dashboard tetap jalan & skrip dokumen tidak jalan.
// =====================================================================================
console.log("\n--- Bagian 5: peramban sungguhan ---");
const playwrightEntry = `${DASHBOARD_DIR}/node_modules/playwright/index.mjs`;
let chromium: any = null;
if (existsSync(playwrightEntry)) {
  try { chromium = (await import(playwrightEntry)).chromium; }
  catch (error) { console.log(`INFO playwright gagal dimuat: ${String(error).slice(0, 160)}`); }
}
if (!chromium || !useBuiltDashboard) {
  skip("uji peramban (halaman dashboard + artefak + kontrol sanitizer)",
    chromium ? "dist/ dashboard belum dibangun" : "playwright tidak tersedia");
} else {
  // Server kecil TANPA CSP: dipakai sebagai pembanding supaya uji ini tidak bisa "lulus palsu".
  const berkasDir = join(dataDir, "pratinjau");
  mkdirSync(berkasDir, { recursive: true });
  const isiSanitize = sanitizeHtml(HTML_JAHAT);
  const isiNetral = neutralizeHtml(HTML_JAHAT);
  writeFileSync(join(berkasDir, "sanitize.html"), isiSanitize);
  writeFileSync(join(berkasDir, "netral.html"), isiNetral);
  // Kontrol memakai salinan TANPA baris `<meta http-equiv="refresh">`: baris itu membuat peramban
  // langsung berpindah ke halaman lain, sehingga penanda `window.__pwned` ikut hilang dan kontrolnya
  // akan tampak "gagal" padahal skripnya memang jalan. Sisanya identik dengan HTML_JAHAT.
  const HTML_KONTROL = HTML_JAHAT.replace(/<meta http-equiv="refresh"[^>]*>/, "");
  writeFileSync(join(berkasDir, "kontrol.html"), HTML_KONTROL);
  // Dua dokumen tambahan menguji kebijakan CSP-nya sendiri di peramban: yang satu memuat skrip inline
  // (harus DIBLOKIR), yang satu memuat skrip dari origin yang sama (harus DIIZINKAN, karena
  // `script-src 'self'`). Dokumen terakhir ini memastikan kebijakan ini bukan "blokir semuanya".
  writeFileSync(join(berkasDir, "csp-block.html"), HTML_KONTROL);
  writeFileSync(join(berkasDir, "csp-allow.html"), "<h1>Dokumen ber-CSP</h1><script src=\"/izin.js\"></script>");
  writeFileSync(join(berkasDir, "izin.js"), "window.__diizinkan = 1;");
  // Kontrol SVG tanpa CSP: membuktikan skrip dalam SVG memang bisa jalan, lalu diuji ulang lewat /raw.
  const SVG_KONTROL = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned=9;</script><rect width="10" height="10"/></svg>';
  writeFileSync(join(berkasDir, "jahat.svg"), SVG_KONTROL);
  // Halaman ber-iframe `srcdoc`: dipakai mengukur apakah iframe srcdoc mewarisi CSP halaman induknya.
  // `#a` (atribut style di markup) dan `#b` (blok <style>) dipakai mengukur apakah gaya inline yang
  // ADA DI MARKUP ikut diblokir, berbeda dengan gaya yang ditulis React lewat CSSOM.
  const HALAMAN_SRDOC = `<h1 id="a" style="color: blue">gaya atribut</h1><style>h2 { color: red }</style><h2 id="b">gaya blok</h2><iframe id="f" srcdoc="<p>pratinjau</p><script>parent.__dariSrdoc=1;<\/script>"></iframe>`;
  writeFileSync(join(berkasDir, "srcdoc.html"), HALAMAN_SRDOC);
  const peta: Record<string, string> = { "/sanitize": "sanitize.html", "/netral": "netral.html", "/kontrol": "kontrol.html", "/srcdoc-kontrol": "srcdoc.html" };
  const serverLokal = createHttpServer((request, response) => {
    const rute = String(request.url ?? "/").split("?")[0];
    if (rute === "/izin.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(readFileSync(join(berkasDir, "izin.js")));
      return;
    }
    if (rute === "/csp-block" || rute === "/csp-allow" || rute === "/srcdoc-block") {
      const nama = rute === "/csp-block" ? "csp-block.html" : rute === "/csp-allow" ? "csp-allow.html" : "srcdoc.html";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": policy });
      response.end(readFileSync(join(berkasDir, nama)));
      return;
    }
    if (rute === "/jahat.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" }); // sengaja tanpa CSP
      response.end(readFileSync(join(berkasDir, "jahat.svg")));
      return;
    }
    const nama = peta[rute];
    if (!nama) { response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); response.end("tidak ada"); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); // sengaja tanpa CSP
    response.end(readFileSync(join(berkasDir, nama)));
  });
  let portLokal = 0;
  for (let attempt = 0; attempt < 25 && portLokal === 0; attempt += 1) {
    const kandidat = 7300 + Math.floor(Math.random() * 300);
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(kandidat, "127.0.0.1");
    });
    if (bebas) portLokal = kandidat;
  }
  await new Promise<void>((resolve) => serverLokal.listen(portLokal, "127.0.0.1", () => resolve()));

  const peramban = await chromium.launch({ args: ["--no-sandbox"] });
  const konteks = await peramban.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const tokenSesi = owner.jar.get("coder_session");
  if (tokenSesi) await konteks.addCookies([{ name: "coder_session", value: tokenSesi, url: base, httpOnly: true, sameSite: "Lax" }]);
  const halaman = await konteks.newPage();
  const galatCsp: string[] = []; const galatLain: string[] = []; const galatJs: string[] = [];
  halaman.on("console", (pesan: any) => {
    if (pesan.type() !== "error") return;
    const teks = String(pesan.text());
    if (/Content Security Policy|Refused to/i.test(teks)) galatCsp.push(teks); else galatLain.push(teks);
  });
  halaman.on("pageerror", (error: any) => galatJs.push(String(error?.message ?? error)));
  const perHalaman: Record<string, number> = {};
  try {
    // ----- 5a) dashboard: semua halaman termuat, nol galat CSP.
    const jawabanAwal = await halaman.goto(base, { waitUntil: "domcontentloaded" });
    const cspDiPeramban = jawabanAwal ? jawabanAwal.headers()["content-security-policy"] : "";
    check("peramban benar-benar menerima header CSP pada dokumen dashboard", Boolean(cspDiPeramban) && /default-src 'self'/.test(String(cspDiPeramban)), String(cspDiPeramban).slice(0, 90));
    await halaman.waitForSelector("nav.page-nav", { timeout: 20000 }).catch(() => undefined);
    const jumlahLink = await halaman.locator("nav.page-nav .page-link").count();
    // Sejak v0.24.1 menu samping DIKELOMPOKKAN dan kelompok yang tertutup tidak merender isinya, jadi
    // "jumlah .page-link > 5" tidak lagi sah sebagai bukti menu muncul. Yang diperiksa sekarang: kepala
    // kelompok lengkap, ada kolom cari menu, ada menu yang tampil, dan membuka satu kelompok benar-benar
    // MENAMBAH menu di DOM (jadi ini bukan pemeriksaan yang selalu lulus).
    const jumlahKepala = await halaman.locator("nav.page-nav [data-testid^='nav-grup-']").count();
    const adaCari = await halaman.locator("nav.page-nav [data-testid='nav-cari-menu']").count();
    const kepalaKedua = halaman.locator("nav.page-nav [data-testid^='nav-grup-']").nth(1);
    let jumlahSetelahBuka = jumlahLink;
    if (jumlahKepala > 1) {
      await kepalaKedua.click({ timeout: 5000 }).catch(() => undefined);
      await halaman.waitForTimeout(300);
      jumlahSetelahBuka = await halaman.locator("nav.page-nav .page-link").count();
    }
    check("dashboard hasil build termuat di peramban (menu samping muncul)", jumlahKepala >= 5 && jumlahLink >= 1 && adaCari === 1 && jumlahSetelahBuka > jumlahLink, `kepala_kelompok=${jumlahKepala} link=${jumlahLink} kolom_cari=${adaCari} link_sesudah_kelompok_dibuka=${jumlahSetelahBuka}`);
    check("halaman awal dashboard tanpa galat CSP", galatCsp.length === 0, galatCsp.slice(0, 2).join(" | "));

    const aturanCss = await halaman.evaluate(() => {
      let total = 0;
      for (const lembar of Array.from(document.styleSheets)) { try { total += lembar.cssRules.length; } catch { /* lintas asal */ } }
      return total;
    });
    check("stylesheet dashboard benar-benar termuat (aturan CSS terbaca > 50)", Number(aturanCss) > 50, String(aturanCss));
    const lembarGaya = await halaman.evaluate(() => Array.from(document.styleSheets).map((lembar: any) => {
      let aturan = -1;
      try { aturan = lembar.cssRules.length; } catch { aturan = -1; }
      return `${String(lembar.href ?? "(inline)").slice(0, 80)} -> ${aturan}`;
    }));
    console.log(`INFO lembar gaya di dashboard: ${JSON.stringify(lembarGaya)}`);
    const elemenBergaya = await halaman.evaluate(() => document.querySelectorAll("[style]").length);
    console.log(`INFO elemen ber-atribut style di DOM halaman awal: ${elemenBergaya} (React menulisnya lewat CSSOM, bukan lewat CSP style-src-attr)`);
    check("dashboard memang memakai gaya inline di DOM dan tetap tanpa galat CSP",
      Number(elemenBergaya) > 0 && galatCsp.length === 0, `${elemenBergaya} elemen ber-atribut style, galat CSP ${galatCsp.length}`);

    for (let index = 0; index < jumlahLink; index += 1) {
      const sebelum = galatCsp.length;
      const tautan = halaman.locator("nav.page-nav .page-link").nth(index);
      const label = String((await tautan.textContent().catch(() => "")) ?? "").trim() || `halaman-${index}`;
      await tautan.click({ timeout: 5000 }).catch(() => undefined);
      await halaman.waitForTimeout(700);
      const teks = String(await halaman.locator("main.main").innerText().catch(() => ""));
      perHalaman[label] = galatCsp.length - sebelum;
      check(`halaman "${label}" termuat tanpa galat CSP`, perHalaman[label] === 0, galatCsp.slice(sebelum, sebelum + 2).join(" | "));
      check(`halaman "${label}" tidak kosong (isi terender)`, teks.trim().length >= 20, `${teks.trim().length} karakter`);
    }
    console.log(`INFO galat CSP per halaman (nama -> jumlah): ${JSON.stringify(perHalaman)}`);
    console.log(`INFO galat konsol selain CSP: ${galatLain.length}${galatLain.length ? " -> " + galatLain.slice(0, 3).join(" | ").slice(0, 300) : ""}`);
    check("tidak ada satu pun galat CSP di seluruh halaman dashboard", galatCsp.length === 0, galatCsp.slice(0, 3).join(" | "));
    check("tidak ada galat JavaScript tak tertangkap di dashboard", galatJs.length === 0, galatJs.slice(0, 3).join(" | "));

    // Putaran kedua TANPA memblokir service worker: `registerSW.js` dari vite-plugin-pwa harus
    // tetap boleh didaftarkan (`script-src 'self'`), dan tidak boleh memunculkan galat CSP baru.
    const konteksSw = await peramban.newContext({ viewport: { width: 1280, height: 860 } });
    if (tokenSesi) await konteksSw.addCookies([{ name: "coder_session", value: tokenSesi, url: base, httpOnly: true, sameSite: "Lax" }]);
    const halamanSw = await konteksSw.newPage();
    const galatCspSw: string[] = [];
    halamanSw.on("console", (pesan: any) => { if (pesan.type() === "error" && /Content Security Policy|Refused to/i.test(String(pesan.text()))) galatCspSw.push(String(pesan.text())); });
    await halamanSw.goto(base, { waitUntil: "domcontentloaded" });
    await halamanSw.waitForTimeout(2500);
    const jumlahSw = await halamanSw.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length).catch(() => -1);
    check("dashboard dengan service worker aktif tetap tanpa galat CSP", galatCspSw.length === 0, galatCspSw.slice(0, 2).join(" | "));
    console.log(`INFO service worker: ${String(jumlahSw)} pendaftaran aktif, galat CSP ${galatCspSw.length}`);
    await konteksSw.close().catch(() => undefined);

    // ----- 5b) artefak HTML berbahaya yang disajikan API: skripnya tidak boleh jalan.
    const jawabanArtefak = await halaman.goto(`${base}/api/v1/artifacts/${artifactId}/raw`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(600);
    const cspArtefak = jawabanArtefak ? jawabanArtefak.headers()["content-security-policy"] : "";
    check("peramban menerima kebijakan artefak (sandbox) saat membuka /raw", /sandbox/.test(String(cspArtefak)), String(cspArtefak).slice(0, 90));
    const ukurArtefak = await halaman.evaluate(() => ({ href: location.pathname, pwned: (window as any).__pwned ?? null, judul: document.title, teks: document.body.innerText }));
    console.log(`INFO artefak /raw di peramban: ${JSON.stringify({ href: ukurArtefak.href, pwned: ukurArtefak.pwned, judul: ukurArtefak.judul, teks: String(ukurArtefak.teks).slice(0, 60) })}`);
    check("artefak HTML berbahaya lewat API TIDAK menjalankan skrip", ukurArtefak.pwned === null, JSON.stringify(ukurArtefak));
    check("judul dokumen artefak tetap judul aslinya (skrip tidak jalan)", ukurArtefak.judul === "Dokumen Uji", String(ukurArtefak.judul));
    check("meta refresh berbahaya di artefak tertahan (peramban tidak berpindah halaman)",
      String(ukurArtefak.href).includes("/raw") && !/jahat\.example/.test(String(ukurArtefak.href)), String(ukurArtefak.href));
    check("isi dokumen artefak tetap terbaca di peramban (kebijakan ketat tidak mengosongkan pratinjau)",
      /Dokumen Uji/.test(String(ukurArtefak.teks)), String(ukurArtefak.teks).slice(0, 120));

    // ----- 5c) KONTROL: dokumen yang sama TANPA CSP memang menjalankan skripnya.
    await halaman.goto(`http://127.0.0.1:${portLokal}/kontrol`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(600);
    const ukurKontrol = await halaman.evaluate(() => ({ href: location.pathname, pwned: (window as any).__pwned ?? null, judul: document.title }));
    check("KONTROL: HTML mentah tanpa CSP memang menjalankan skrip (penanda uji ini bekerja)",
      ukurKontrol.pwned !== null && /PWNED/.test(String(ukurKontrol.judul)) && ukurKontrol.href === "/kontrol",
      JSON.stringify(ukurKontrol));
    console.log(`INFO kontrol tanpa CSP: ${JSON.stringify(ukurKontrol)}`);

    // ----- 5c-2) kebijakan CSP itu sendiri: skrip inline diblokir, skrip satu origin diizinkan.
    const sebelumCspBlock = galatCsp.length;
    await halaman.goto(`http://127.0.0.1:${portLokal}/csp-block`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(600);
    const ukurCspBlock = await halaman.evaluate(() => ({ href: location.pathname, pwned: (window as any).__pwned ?? null, judul: document.title }));
    check("KONTROL ALAT UKUR: pelanggaran CSP benar-benar terbaca oleh pendengar konsol uji ini",
      galatCsp.length > sebelumCspBlock, `galat baru ${galatCsp.length - sebelumCspBlock}, contoh: ${galatCsp.slice(sebelumCspBlock, sebelumCspBlock + 1).join("").slice(0, 140)}`);
    console.log(`INFO contoh pelanggaran CSP yang terbaca: ${galatCsp.slice(sebelumCspBlock, sebelumCspBlock + 1).join(" ").slice(0, 200)}`);
    check("skrip inline pada dokumen ber-CSP tidak berjalan di peramban",
      ukurCspBlock.pwned === null && !/PWNED/.test(String(ukurCspBlock.judul)) && ukurCspBlock.href === "/csp-block", JSON.stringify(ukurCspBlock));
    await halaman.goto(`http://127.0.0.1:${portLokal}/csp-allow`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(500);
    const ukurCspAllow = await halaman.evaluate(() => (window as any).__diizinkan ?? null);
    check("skrip dari origin yang sama tetap diizinkan (script-src 'self' bukan blokir semuanya)", ukurCspAllow === 1, String(ukurCspAllow));
    // Galat CSP dari dua dokumen kontrol di atas sengaja terjadi; hitungan dashboard diambil sebelum ini.
    console.log(`INFO kontrol CSP: galat terdeteksi ${galatCsp.length - sebelumCspBlock} untuk dokumen ber-CSP, skrip satu origin=${String(ukurCspAllow)}`);

    // ----- 5c-3) SVG berbahaya: kontrol tanpa CSP vs jawaban /raw ber-kebijakan artefak.
    await halaman.goto(`http://127.0.0.1:${portLokal}/jahat.svg`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(400);
    const pwnedSvgKontrol = await halaman.evaluate(() => (window as any).__pwned ?? null);
    check("KONTROL: SVG tanpa CSP memang menjalankan skripnya", pwnedSvgKontrol === 9, String(pwnedSvgKontrol));
    await halaman.goto(`${base}/api/v1/artifacts/${artefakSvg}/raw`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(400);
    const pwnedSvgApi = await halaman.evaluate(() => (window as any).__pwned ?? null);
    check("SVG berbahaya lewat /raw TIDAK menjalankan skrip di peramban", pwnedSvgApi === null, String(pwnedSvgApi));

    // ----- 5c-4) iframe `srcdoc` mewarisi CSP halaman induknya (dipakai pratinjau HTML dashboard).
    const ukurWarnaGaya = () => halaman.evaluate(() => [
      getComputedStyle(document.getElementById("a") as Element).color,
      getComputedStyle(document.getElementById("b") as Element).color,
    ]);
    await halaman.goto(`http://127.0.0.1:${portLokal}/srcdoc-kontrol`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(500);
    const srcdocKontrol = await halaman.evaluate(() => (window as any).__dariSrdoc ?? null);
    const warnaKontrol = await ukurWarnaGaya();
    check("KONTROL: iframe srcdoc tanpa CSP menjalankan skrip pratinjaunya", srcdocKontrol === 1, String(srcdocKontrol));
    check("KONTROL: tanpa CSP gaya inline di markup memang berlaku (atribut biru, blok merah)",
      warnaKontrol[0] === "rgb(0, 0, 255)" && warnaKontrol[1] === "rgb(255, 0, 0)", JSON.stringify(warnaKontrol));
    await halaman.goto(`http://127.0.0.1:${portLokal}/srcdoc-block`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(500);
    const srcdocBerCsp = await halaman.evaluate(() => (window as any).__dariSrdoc ?? null);
    const isiSrcdoc = await halaman.evaluate(() => String((document.getElementById("f") as any)?.contentDocument?.body?.innerText ?? "").slice(0, 40));
    check("iframe srcdoc MEWARISI CSP induk: skrip di dalam pratinjau tidak berjalan", srcdocBerCsp === null, String(srcdocBerCsp));
    check("isi pratinjau srcdoc tetap tampil walau skripnya diblokir", /pratinjau/.test(isiSrcdoc), isiSrcdoc);
    // Gaya inline YANG ADA DI MARKUP (berbeda dari gaya ala React lewat CSSOM) diblokir oleh
    // `style-src` tanpa `unsafe-inline`. Penting untuk pratinjau dokumen: isinya tetap terbaca,
    // tetapi tampilannya kehilangan gaya inline. Diukur, bukan diduga.
    const warnaBerCsp = await ukurWarnaGaya();
    check("gaya inline di MARKUP diblokir CSP (atribut style dan blok <style> tidak berlaku)",
      warnaBerCsp[0] !== "rgb(0, 0, 255)" && warnaBerCsp[1] !== "rgb(255, 0, 0)", JSON.stringify(warnaBerCsp));
    console.log(`INFO srcdoc: skrip kontrol=${String(srcdocKontrol)} vs ber-CSP=${String(srcdocBerCsp)}; warna gaya kontrol=${JSON.stringify(warnaKontrol)} vs ber-CSP=${JSON.stringify(warnaBerCsp)} (pratinjau HTML dashboard memakai srcdoc+allow-scripts, jadi skrip inline di dalam pratinjau tidak jalan)`);

    // ----- 5d) hasil sanitizeHtml: tanpa skrip, isi dokumen tetap terbaca.
    await halaman.goto(`http://127.0.0.1:${portLokal}/sanitize`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(600);
    const pwnedSanitize = await halaman.evaluate(() => (window as any).__pwned ?? null);
    const hrefSanitize = await halaman.evaluate(() => location.pathname);
    const teksSanitize = await halaman.evaluate(() => document.body.innerText);
    const sisaBahaya = await halaman.evaluate(() => document.querySelectorAll("iframe,object,embed,form,[onerror],[onclick],[onload]").length);
    check("hasil sanitizeHtml tidak menjalankan skrip walau tanpa CSP", pwnedSanitize === null && hrefSanitize === "/sanitize", `${String(pwnedSanitize)} href=${hrefSanitize}`);
    check("hasil sanitizeHtml masih memuat isi dokumen", /Dokumen Uji/.test(String(teksSanitize)) && /satu/.test(String(teksSanitize)), String(teksSanitize).slice(0, 120));
    check("hasil sanitizeHtml tidak menyisakan iframe/object/embed/form/penangan kejadian", Number(sisaBahaya) === 0, String(sisaBahaya));

    // ----- 5e) hasil neutralizeHtml: paling ketat, tanpa atribut sama sekali.
    await halaman.goto(`http://127.0.0.1:${portLokal}/netral`, { waitUntil: "domcontentloaded" });
    await halaman.waitForTimeout(600);
    const pwnedNetral = await halaman.evaluate(() => (window as any).__pwned ?? null);
    const hrefNetral = await halaman.evaluate(() => location.pathname);
    const adaAtribut = await halaman.evaluate(() => Array.from(document.querySelectorAll("*")).some((el) => el.attributes.length > 0));
    check("hasil neutralizeHtml tidak menjalankan skrip", pwnedNetral === null && hrefNetral === "/netral", `${String(pwnedNetral)} href=${hrefNetral}`);
    check("hasil neutralizeHtml tidak menyisakan atribut apa pun", adaAtribut === false, String(adaAtribut));
  } catch (error) {
    check("alur uji peramban selesai tanpa galat tak terduga", false, String((error as Error)?.message ?? error));
  } finally {
    await konteks.close().catch(() => undefined);
    await peramban.close().catch(() => undefined);
    serverLokal.close();
  }
}

// =====================================================================================
// Ringkasan
// =====================================================================================
// Bersihkan direktori data sementara supaya /tmp tidak menumpuk tiap kali suite ini dijalankan.
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* hanya sisa berkas sementara */ }

console.log("");
for (const item of skipped) console.log(`SKIP-TOTAL ${item}`);
console.log(`wave11a-csp: ${passed}/${passed + failed} lulus, gagal ${failed}, skip ${skipped.length}`);
if (failed > 0) { console.log(`WAVE11A_CSP_FAILED ${failedNames.join(" | ")}`); process.exit(1); }
console.log("WAVE11A_CSP_PASSED");
process.exit(0);

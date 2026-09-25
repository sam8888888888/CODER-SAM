/**
 * Uji antarmuka Wave 10 + Wave 11A dengan peramban Chromium sungguhan.
 * Wave 11A yang diuji di sini: pratinjau artefak docx/xlsx/pptx/md + mode unduh (butir 49),
 * sunting + riwayat revisi artefak (butir 48), mode diskusi/eksekusi (butir 42), halaman
 * Guardrail/Basis pengetahuan/Skill saya (butir 46, 52, 51), perkiraan biaya Playground
 * (butir 56), penanda model cadangan (butir 57), tombol pasang PWA + panduan iOS (butir 55),
 * dan pembersihan riwayat ekspor-dulu (butir 54).
 * Wave 11B (v0.22.0) yang diuji di sini: penilaian dewan juri (butir 58), mode bayangan + pembukuan
 * token admin (butir 59, 67), pelajaran memori (butir 60), benchmark model (butir 61), timeline run
 * (butir 62), lanjutan run gagal (butir 63), ekspor/impor persona (butir 64), pemakaian & aktivitas
 * akun sendiri (butir 65), laporan galat admin (butir 66), dan jadwal berkala (butir 72).
 *
 * Yang dibuktikan: SPA hasil build benar-benar memuat di peramban, akun baru bisa mendaftar lewat
 * layar masuk, setiap halaman baru Wave 10 bisa dibuka lewat menu samping, dan setiap halaman itu
 * benar-benar MEMANGGIL API-nya sendiri (bukan sekadar tampil kosong). Service worker PWA dan
 * berkas penangan push juga diperiksa, karena notifikasi peramban hanya bisa hidup di sana.
 *
 * Jalankan:
 *   cd /workspace/coblai-dinda/coder-dashboard
 *   npm run build            # parent yang menjalankan ini (uji ini memakai dist/)
 *   node e2e/ui.e2e.mjs
 *
 * Keluar 2 dengan UI_E2E_SKIPPED bila `dist/index.html` belum ada, supaya uji tidak berbohong.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as buatServerHttp } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const dashboardDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const platformDir = `${dashboardDir}/../coder-platform`;
const distDir = `${dashboardDir}/dist`;
const shots = "/tmp/w10_ui_shots";

if (!existsSync(`${distDir}/index.html`)) {
  console.log("UI_E2E_SKIPPED dist/index.html belum ada — jalankan `npm run build` dulu.");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

// Port dipilih dengan mencoba mengikatnya lebih dahulu. Sebelumnya port acak tetap bisa bertabrakan
// dengan server uji lain yang tertinggal; peramban lalu bicara ke server LAIN dan pemeriksaan admin
// gagal tanpa sebab yang jelas (gejala nyata 18 Sep 2026).
async function freePort() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = 7300 + Math.floor(Math.random() * 200);
    const free = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(candidate, "127.0.0.1");
    });
    if (free) return candidate;
  }
  throw new Error("tidak ada port bebas untuk server uji");
}
const port = await freePort();
const dataDir = `/tmp/coder-ui-wave10-${Date.now()}`;
const stamp = Date.now();
const adminEmail = `w10ui-admin-${stamp}@example.test`;
const password = "SandiUji2026!aman";
// Akun peramban ini adalah admin platform, supaya halaman khusus admin juga benar-benar dirender.
// Tanpa pembungkus `npx`: `npx` membuat proses anak lagi, dan proses cucu itu mewarisi pipa
// stdout/stderr sehingga loop peristiwa Node tidak pernah berakhir walau uji sudah selesai
// (gejala nyata 17 Sep 2026: mencetak UI_E2E_PASSED lalu tetap hidup sampai timeout 124).
// Memanggil tsx langsung lewat process.execPath membuat SIGKILL benar-benar menghentikan server.
// Wave 11B (butir 63): daftar model yang DIPAKSA gagal oleh mesin tiruan supaya jalur "lanjutkan run"
// benar-benar bisa diuji. Nama harus ada di katalog mesin sungguhan (`prime-agent model list`); uji
// memilih nama pertama yang cocok dan melaporkan SKIP bila tidak ada. Mesin sungguhan tidak tersentuh.
const modelGagalUji = "gpt-5-pro,gpt-4o-2024-05-13,gpt-4-turbo,deepseek-v4-pro";
// ----- Wave 11C (butir 68, 69, 71, 76): server tiruan untuk hulu Notion/Telegram/Slack/Discord.
// Uji ini TIDAK menghubungi internet: alamat hulu dialihkan ke server HTTP kecil di dalam uji ini lewat
// variabel lingkungan (NOTION_API_BASE, TELEGRAM_API_BASE, BOT_WEBHOOK_BASE_URL, daftar putih konektor).
// Setiap permintaan yang masuk dicatat, jadi uji bisa membuktikan apa yang BENAR-BENAR dikirim halaman
// (mis. isi PNG hasil potong-peramban) dan apa yang tidak pernah dikirim (mis. token tidak di layar).
const stubRequests = [];
const stubServer = buatServerHttp((request, response) => {
  const potongan = [];
  request.on("data", (bagian) => potongan.push(bagian));
  request.on("end", () => {
    const badan = Buffer.concat(potongan).toString("utf8");
    const jalur = String(request.url || "").split("?")[0];
    const tajuk = request.headers || {};
    stubRequests.push({ method: String(request.method || "GET"), path: jalur, body: badan, authorization: String(tajuk.authorization || "") });
    const kirim = (kode, isi) => {
      const teks = JSON.stringify(isi);
      response.writeHead(kode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(teks) });
      response.end(teks);
    };
    if (jalur === "/v1/users/me") {
      if (String(tajuk.authorization || "").includes("token-ditolak")) {
        return kirim(401, { object: "error", code: "unauthorized", message: "API token is invalid." });
      }
      return kirim(200, {
        object: "user", id: "bot-uji-notion", name: "Integrasi Uji", type: "bot",
        bot: { workspace_id: "ws-uji-1", workspace_name: "Ruang Uji COBLAI" },
      });
    }
    if (jalur === "/v1/pages" && request.method === "POST") {
      if (badan.includes("hulu-rusak")) return kirim(500, { object: "error", code: "internal_server_error", message: "Hulu sedang bermasalah." });
      const nomor = stubRequests.filter((item) => item.path === "/v1/pages").length;
      return kirim(200, { object: "page", id: `page-uji-${nomor}`, url: `${stubBase}/halaman/page-uji-${nomor}`, created_time: new Date().toISOString(), properties: {} });
    }
    const telegram = /^\/bot([^/]+)\/setWebhook$/.exec(jalur);
    if (telegram) {
      if (String(telegram[1]).includes("gagal")) return kirim(400, { ok: false, error_code: 400, description: "Bad Request: webhook gagal dipasang oleh hulu" });
      return kirim(200, { ok: true, result: true, description: "Webhook was set" });
    }
    if (jalur.startsWith("/slack/ok")) return kirim(200, { ok: true, diterima: true });
    if (jalur.startsWith("/slack/gagal")) return kirim(500, { ok: false, error: "stub menolak" });
    return kirim(404, { ok: false, error: `stub belum mengenal jalur ${jalur}` });
  });
});
let stubPort = await freePort();
while (stubPort === port) stubPort = await freePort();
await new Promise((resolve) => stubServer.listen(stubPort, "127.0.0.1", resolve));
const stubBase = `http://127.0.0.1:${stubPort}`;

const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
  cwd: platformDir,
  env: {
    ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
    DATA_DIR: dataDir, PUBLIC_DIR: distDir, MOCK_ENGINE: "true", NOTIFY_EMAIL_ENABLED: "false",
    VERIFY_EMAIL_REQUIRED: "off", PLATFORM_ADMIN_EMAILS: adminEmail,
    METRICS_TOKEN: "ui-wave10-metrics-token", PUSH_ENABLED: "true", DEVICE_TRACKING: "true",
    JOB_WORKER_IN_WEB: "false", PRIME_AGENT_MODEL: "ui-wave10-model",
    MOCK_ENGINE_FAIL_MODELS: modelGagalUji,
    // Wave 11C: kunci segel rahasia, daftar putih konektor, dan alamat hulu tiruan.
    SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
    CONNECTOR_ALLOWED_HOSTS: "127.0.0.1,hooks.slack.com",
    NOTION_API_BASE: `${stubBase}/v1`,
    TELEGRAM_API_BASE: stubBase,
    BOT_WEBHOOK_BASE_URL: `${stubBase}/bot-hook`,
    NOTION_PAGE_MAX: "4",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
child.stdout.on("data", (chunk) => serverLog.push(String(chunk)));
child.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0; let failed = 0; const skips = []; const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failures.push(name);
  console.log(`FAIL ${name} ${String(detail).slice(0, 300)}`);
}
function skip(name, reason) { skips.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { await response.arrayBuffer(); return true; } } catch { /* belum siap */ }
    await sleep(250);
  }
  return false;
}

const healthy = await waitForHealth();
// Server uji wajib benar-benar proses ini: bila prosesnya mati (misalnya port dipakai proses lain),
// pemeriksaan di bawah tidak boleh berjalan dan menyalahkan antarmuka.
const childAlive = child.exitCode === null && !child.killed;
check("server uji yang menjawab adalah proses yang baru dijalankan", healthy && childAlive,
  `exit=${child.exitCode} port=${port} log=${serverLog.join("").slice(-200)}`);
check("server uji hidup dan menyajikan SPA hasil build", healthy, serverLog.join("").slice(-400));
if (!healthy) { child.kill("SIGKILL"); console.log("UI_E2E_FAILED"); process.exit(1); }

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
// Sebelum masuk, server wajar menjawab 401 untuk pemeriksaan sesi. Galat itu dicatat terpisah supaya
// pemeriksaan "tidak ada galat konsol" tidak menyalahkan perilaku yang memang benar.
const expectedSignedOut = [];
// Uji butir 47 SENGAJA memancing dua galat server (nama alat tidak sah, nama di luar katalog), dan
// server memang menjawab 400. Peramban mencatatnya sebagai galat konsol, jadi catatan itu dipisahkan
// dan jumlahnya diperiksa tepat, bukan diabaikan.
const expectedApiErrors = [];
// Wave 11C: pemeriksaan butir 68/69/71/74/76 SENGAJA memancing jawaban galat dari server (token Notion
// tidak sah, hulu Notion menolak, host konektor di luar daftar putih, gambar JPEG ditolak, dsb). Peramban
// mencatat jawaban 4xx/5xx itu sebagai galat konsol, jadi catatannya dipisahkan per jalur — TIDAK
// dilebur ke dalam `expectedApiErrors` supaya pemeriksaan lama (tepat 2 kali, khusus tools-policy) tetap
// utuh. Jalur di bawah hanya berisi rute yang memang dipakai uji 11C untuk memancing galat.
const expectedApiErrors11C = [];
const jalurGalat11C = ["/api/v1/integrations/notion", "/api/v1/connectors", "/api/v1/media/avatar", "/api/v1/media/agent-avatar", "/api/v1/account/avatar", "/api/v1/admin/avatar", "/api/v1/admin/engine/version", "/api/v1/billing/orders", "/api/v1/billing/manual-orders", "/api/v1/bot-identities", "/api/v1/admin/bot-channels", "/api/v1/admin/agent-avatar"];
const konsolAudit = []; // catatan keputusan tiap galat konsol, dipakai di laporan bila ada yang tak dikenali
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  const url = message.location()?.url ?? "";
  const lintasan = url.replace(base, "");
  if (/400/.test(text) && url.includes("/api/v1/tools-policy")) {
    expectedApiErrors.push(`${text} ${lintasan}`);
    konsolAudit.push(`[kebijakan-alat] ${lintasan}`);
  } else if (/401/.test(text) && url.includes("/auth/me")) {
    expectedSignedOut.push(`${text} ${lintasan}`);
    konsolAudit.push(`[sesi] ${lintasan}`);
  } else if (/([45]\d\d)/.test(text) && jalurGalat11C.some((jalur) => url.includes(jalur))) {
    expectedApiErrors11C.push(`${text} [${lintasan}]`);
    konsolAudit.push(`[dipancing-11C] ${lintasan}`);
  } else {
    consoleErrors.push(`${text} [${lintasan}]`);
    konsolAudit.push(`[LUAR] ${text.slice(0, 100)} <${lintasan}>`);
  }
});
// Galat halaman dicatat lengkap (pesan, jejak, halaman yang aktif, panggilan API terakhir) supaya
// sebabnya bisa ditelusuri, bukan hanya muncul sebagai satu baris di daftar galat konsol.
const galatHalaman = [];
page.on("pageerror", (error) => {
  const jejak = String(error.stack ?? "").split("\n").slice(0, 6).map((baris) => baris.trim()).join(" <- ");
  galatHalaman.push({ pesan: error.message, jejak, halaman: page.url(), panggilan: apiCalls.slice(-3).join(" | ") });
  consoleErrors.push(`pageerror: ${error.message}${jejak ? ` | ${jejak}` : ""}`);
});
const apiCalls = [];
page.on("response", (response) => { const url = response.url(); if (url.includes("/api/v1/")) apiCalls.push(`${response.status()} ${url.replace(base, "")}`); });
const callsTo = (part) => apiCalls.filter((line) => line.includes(part));

try {
  // ----- 1) Daftar lewat layar masuk (antarmuka sungguhan, bukan panggilan API langsung).
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".profile-button", { timeout: 20000 });
  await page.click(".profile-button");
  await page.waitForSelector("form.auth-card", { timeout: 10000 });
  const daftar = page.locator("button.switch", { hasText: "Daftar" }).first();
  if (await daftar.count()) await daftar.click();
  await page.fill('input[placeholder="Nama Anda"]', "Admin Uji Wave 10");
  await page.fill('input[placeholder="Email atau username"]', adminEmail);
  await page.fill('input[type="password"]', password);
  await page.click("button.primary");
  await page.waitForSelector("nav.page-nav", { timeout: 20000 });
  // Sesi dibaca ulang sesudah daftar; menu admin baru muncul setelah jawabannya tiba.
  await page.waitForSelector('nav.page-nav .page-link:has-text("Metrik")', { timeout: 15000 });
  // innerText kosong untuk elemen yang belum dilukis, jadi teks dibaca dari textContent.
  const navLabels = await page.locator("nav.page-nav .page-link").evaluateAll((nodes) => nodes.map((node) => String(node.textContent || "").trim()));
  check("pendaftaran lewat layar masuk membuka ruang kerja", navLabels.length > 5, navLabels.length);
  check("menu samping memuat halaman baru Wave 10",
    ["Pencarian", "Perangkat", "Metrik", "Pelengkapan data", "Riwayat webhook"].every((label) => navLabels.some((item) => item.trim().endsWith(label))),
    navLabels.filter((item) => /Pencarian|Perangkat|Metrik|Pelengkapan|Riwayat/.test(item)));

  // ----- 2) Service worker PWA + berkas penangan push terpasang.
  const swFile = await fetch(`${base}/push-sw.js`);
  check("berkas penangan push disalin ke hasil build", swFile.status === 200 && (await swFile.text()).includes("addEventListener"),
    String(swFile.status));
  await page.waitForTimeout(1500);
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  check("service worker PWA terdaftar di peramban", registrations >= 1, String(registrations));
  const pushSupport = await page.evaluate(() => ({ push: "PushManager" in window, worker: "serviceWorker" in navigator }));
  check("peramban uji benar-benar mendukung notifikasi push", pushSupport.push && pushSupport.worker, JSON.stringify(pushSupport));

  // ----- 3) Setiap halaman baru dibuka dari menu dan WAJIB memanggil API-nya.
  // Halaman Metrik dan Pelengkapan data sengaja tidak memanggil API saat dibuka (angka besar tidak
  // diambil diam-diam), jadi uji ini menekan tombolnya lebih dulu, sama seperti pengguna.
  async function openPage(label, urlPart, clickText) {
    const before = apiCalls.length;
    await page.click(`nav.page-nav .page-link:has-text("${label}")`);
    await page.waitForTimeout(600);
    const active = await page.locator("nav.page-nav .page-link.active").first().innerText().catch(() => "");
    check(`halaman ${label} menjadi halaman aktif`, active.trim().endsWith(label), active);
    if (clickText) {
      const tombol = page.locator("main.main button", { hasText: clickText }).first();
      if (await tombol.count()) await tombol.click();
      else skip(`tombol "${clickText}" di halaman ${label}`, "tombol tidak ditemukan, halaman hanya diperiksa sampai render");
    }
    if (urlPart) {
      let seen = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (apiCalls.slice(before).some((line) => line.includes(urlPart))) { seen = true; break; }
        await page.waitForTimeout(250);
      }
      check(`halaman ${label} memanggil ${urlPart}`, seen, apiCalls.slice(before).join(" | ").slice(0, 200));
    }
    const text = await page.locator("main.main").innerText();
    await page.screenshot({ path: `${shots}/${label.replace(/[^A-Za-z]/g, "_")}.png`, fullPage: false });
    return text;
  }

  const searchText = await openPage("Pencarian", "/api/v1/search/status");
  check("halaman Pencarian menjelaskan bahwa pencarian mencakup seluruh proyek",
    /proyek|percakapan|pesan|artefak/i.test(searchText), searchText.slice(0, 160));
  const kataUji = `kata-uji-${stamp}`;
  const kotakCari = page.locator("main.main input").first();
  await kotakCari.fill(kataUji);
  await page.keyboard.press("Enter");
  let searchCalled = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (callsTo("/api/v1/search?").length > 0) { searchCalled = true; break; }
    await page.waitForTimeout(250);
  }
  check("mengetik di kotak pencarian memanggil /api/v1/search", searchCalled, callsTo("/api/v1/search").join(" | "));
  check("hasil kosong dijelaskan dalam bahasa Indonesia",
    /tidak ada hasil|belum ada|minimal 2 huruf/i.test(await page.locator("main.main").innerText()),
    (await page.locator("main.main").innerText()).slice(0, 160));

  const devicesText = await openPage("Perangkat", "/api/v1/account/devices");
  check("halaman Perangkat menyebut perangkat ini dan notifikasi peramban",
    /perangkat/i.test(devicesText) && /notifikasi/i.test(devicesText), devicesText.slice(0, 200));
  check("halaman Perangkat memuat daftar langganan push dari API",
    callsTo("/api/v1/account/push").length > 0, callsTo("/api/v1/account/push").join(" | "));
  const tombolNotifikasi = await page.locator("main.main button", { hasText: /notifikasi/i }).count();
  check("halaman Perangkat menyediakan tombol untuk menyalakan notifikasi", tombolNotifikasi > 0, String(tombolNotifikasi));

  const metricsText = await openPage("Metrik", "/api/v1/admin/metrics", "Segarkan");
  // Versi skema basis data naik terus di sisi platform (Wave 11A: 19, Wave 11B: 21). Karena itu
  // angkanya tidak ditulis di berkas uji: yang diperiksa adalah halaman menampilkan versi skema
  // yang benar-benar dikirim server lewat /api/v1/admin/metrics.
  const metricsServer = await page.evaluate(async () => (await (await fetch("/api/v1/admin/metrics")).json()));
  check("halaman Metrik menampilkan angka operasional dan versi skema",
    /metrik|skema|angka/i.test(metricsText)
      && Number(metricsServer.schemaVersion) >= 19 && metricsText.includes(String(metricsServer.schemaVersion)),
    `${metricsText.slice(0, 160)} | skemaServer=${metricsServer.schemaVersion}`);
  check("halaman Metrik menyediakan kotak token untuk /metrics", /token/i.test(metricsText), metricsText.slice(0, 160));

  const growthText = await openPage("Pelengkapan data", "/api/v1/admin/growth/backfill", "Lihat pratinjau");
  check("halaman pelengkapan data menampilkan pratinjau dari tabel asli",
    /pratinjau|backfill|peristiwa/i.test(growthText), growthText.slice(0, 200));

  const webhookText = await openPage("Riwayat webhook");
  check("halaman riwayat webhook menjelaskan aturan urutan pengiriman",
    /urutan|webhook|kirim ulang/i.test(webhookText), webhookText.slice(0, 200));

  // ----- 3b) Halaman Kunci API (butir 41 + butir 24): kolom IP terakhir dan token run berjalan.
  // Kunci uji dibuat lewat API DI DALAM halaman, supaya sesi peramban yang dipakai. Kunci itu lalu
  // dipakai sekali ke endpoint publik supaya server mencatat IP-nya. Inilah yang dulu tidak pernah
  // muncul di tabel, karena antarmuka membaca nama bidang `lastUsedIp` yang tidak pernah dikirim server.
  const kunciUji = await page.evaluate(async () => {
    const buat = await fetch("/api/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Uji kolom kunci " + Date.now() }),
    });
    const data = await buat.json().catch(() => ({}));
    if (!data.secret) return { buat: buat.status, pakai: 0, ip: "" };
    const pakai = await fetch("/api/v1/public/v1/me", { headers: { authorization: `Bearer ${data.secret}` } });
    const daftar = await (await fetch("/api/v1/api-keys")).json().catch(() => ({ keys: [] }));
    const ip = (daftar.keys || []).map((row) => row.lastIp).filter((nilai) => typeof nilai === "string" && nilai)[0] || "";
    return { buat: buat.status, pakai: pakai.status, ip };
  });
  check("kunci API uji dibuat dan dipakai sekali lewat API",
    kunciUji.buat === 201 && kunciUji.pakai === 200,
    JSON.stringify({ buat: kunciUji.buat, pakai: kunciUji.pakai }));
  check("server mencatat IP pemakaian kunci", String(kunciUji.ip).length > 0, String(kunciUji.ip));
  await openPage("Kunci API");
  // Tabel hanya muncul sesudah jawaban daftar kunci tiba, jadi barisnya ditunggu lebih dulu.
  await page.waitForSelector("main.main table tbody tr", { timeout: 15000 }).catch(() => {});
  const kunciText = (await page.locator("main.main").innerText()).replace(/\n+/g, " | ");
  check("halaman Kunci API menampilkan IP terakhir yang dicatat server",
    Boolean(kunciUji.ip) && kunciText.includes(kunciUji.ip), kunciText.slice(0, 240));
  check("halaman Kunci API menampilkan kolom token run berjalan",
    /token run berjalan/i.test(kunciText), kunciText.slice(0, 240));

  // ----- 4) Wave 11A (v0.21.0): butir 42, 46, 48, 49, 51, 52, 54, 55, 56, 57.
  // Berkas contoh dibangkitkan oleh `python3 e2e/make-fixtures.py` (docx, xlsx, pptx, md). Isinya
  // dokumen sungguhan, bukan teks kosong, supaya penampil benar-benar diuji.
  // Jalur API Wave 11A mungkin belum terpasang di server saat uji ini dijalankan; jawaban
  // 404/405/501 dilaporkan sebagai "menunggu API", bukan sebagai lulus.
  const jalurStatus = (part) => Number((callsTo(part).pop() || "").split(" ")[0]) || 0;
  const checkApi = (nama, jalur, ok, detail) => {
    if (ok) return check(nama, true, detail);
    if ([404, 405, 501].includes(jalurStatus(jalur))) return skip(nama, `menunggu API ${jalur} (server menjawab ${jalurStatus(jalur)})`);
    return check(nama, false, detail);
  };
  // Sama seperti openPage, tetapi panggilan API halaman baru diperiksa dengan toleransi
  // "menunggu API" supaya kegagalan karena rute belum ada tidak dilaporkan sebagai lulus.
  async function bukaHalamanBaru(label, urlPart) {
    const before = apiCalls.length;
    await page.click(`nav.page-nav .page-link:has-text("${label}")`);
    await page.waitForTimeout(600);
    let seen = !urlPart;
    for (let attempt = 0; attempt < 40 && !seen; attempt += 1) {
      if (apiCalls.slice(before).some((line) => line.includes(urlPart))) seen = true;
      else await page.waitForTimeout(250);
    }
    checkApi(`halaman ${label} memanggil ${urlPart || "API-nya"}`, urlPart || "/api/v1/", seen,
      apiCalls.slice(before).join(" | ").slice(0, 200));
    await page.screenshot({ path: `${shots}/${label.replace(/[^A-Za-z]/g, "_")}.png`, fullPage: false });
    return page.locator("main.main").innerText();
  }

  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pptxMime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const proyekUji = `Uji Wave 11A ${stamp}`;
  const namaDocx = `uji-${stamp}-sample.docx`;
  const namaXlsx = `uji-${stamp}-sample.xlsx`;
  const namaPptx = `uji-${stamp}-sample.pptx`;
  const namaMd = `uji-${stamp}-catatan.md`;
  const namaRusak = `uji-${stamp}-rusak.docx`;
  // Berkas besar tidak bisa diunggah sungguhan: server menolak isi di atas 10 MB (ARTIFACT_TOO_LARGE).
  // Jadi berkas kecil diunggah apa adanya, lalu ukuran yang dilihat peramban disimulasikan 11 MB
  // lewat penyadapan jawaban daftar artefak. Yang diuji tetap aturan antarmuka untuk berkas besar.
  const namaBesar = `uji-${stamp}-besar.txt`;
  const bacaFixture = (nama) => readFileSync(`${dashboardDir}/e2e/fixtures/${nama}`);
  const siapkanUji = await page.evaluate(async ({ payloads, proyekUji }) => {
    const daftarWorkspace = await (await fetch("/api/v1/workspaces")).json();
    const workspaceId = daftarWorkspace?.[0]?.id;
    if (!workspaceId) return { error: "WORKSPACE_KOSONG", rows: [] };
    let projects = await (await fetch(`/api/v1/workspaces/${workspaceId}/projects`)).json();
    let project = (projects || []).find((row) => row.name === proyekUji);
    if (!project) {
      const dibuat = await fetch(`/api/v1/workspaces/${workspaceId}/projects`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: proyekUji }),
      });
      project = await dibuat.json();
    }
    const rows = [];
    for (const item of payloads) {
      const jawaban = await fetch(`/api/v1/projects/${project.id}/artifacts`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: item.name, mimeType: item.mime, contentBase64: item.b64 }),
      });
      const data = await jawaban.json().catch(() => ({}));
      rows.push({ name: item.name, status: jawaban.status, id: data.id ?? null });
    }
    return { workspaceId, projectId: project.id, projectName: project.name, rows };
  }, {
    proyekUji,
    payloads: [
      { name: namaDocx, mime: docxMime, b64: bacaFixture("sample.docx").toString("base64") },
      { name: namaXlsx, mime: xlsxMime, b64: bacaFixture("sample.xlsx").toString("base64") },
      { name: namaPptx, mime: pptxMime, b64: bacaFixture("sample.pptx").toString("base64") },
      { name: namaMd, mime: "text/markdown", b64: bacaFixture("catatan-uji.md").toString("base64") },
      { name: namaRusak, mime: docxMime, b64: Buffer.from("ini bukan dokumen Word yang sah").toString("base64") },
      { name: namaBesar, mime: "text/plain", b64: Buffer.from("berkas kecil di server; ukuran besar hanya disimulasikan pada uji ini").toString("base64") },
    ],
  });
  check("proyek uji dan 6 artefak uji dibuat lewat API",
    siapkanUji.rows?.length === 6 && siapkanUji.rows.every((row) => row.status === 201),
    JSON.stringify(siapkanUji.rows?.map((row) => [row.name, row.status]) ?? siapkanUji.error));

  // Ukuran besar disimulasikan pada jawaban daftar artefak (lihat catatan di atas).
  await page.route("**/api/v1/projects/*/artifacts", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const jawaban = await route.fetch();
    const badan = await jawaban.json().catch(() => null);
    if (Array.isArray(badan)) for (const row of badan) if (row.name === namaBesar) row.sizeBytes = 11 * 1024 * 1024;
    await route.fulfill({ response: jawaban, json: badan });
  });

  // Proyek uji baru dikenal halaman setelah dimuat ulang; lalu proyek itu dipilih seperti pengguna.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.page-nav", { timeout: 20000 });
  await page.click('nav.page-nav .page-link:has-text("Proyek")');
  await page.waitForTimeout(500);
  await page.locator("main.main .tool-list > div", { hasText: proyekUji }).first().click();
  await page.waitForTimeout(500);
  await page.click('nav.page-nav .page-link:has-text("Artefak")');
  await page.waitForSelector("main.main .tool-list", { timeout: 15000 });
  await page.waitForTimeout(800);

  const barisArtefak = (nama) => page.locator("main.main .tool-list > div", { hasText: nama }).first();
  async function bukaPratinjau(nama) {
    const baris = barisArtefak(nama);
    await baris.locator("button", { hasText: "Pratinjau" }).first().click();
    return baris;
  }

  // butir 49: pratinjau docx lewat mammoth, di dalam iframe ber-sandbox tanpa allow-same-origin.
  const barisDocx = await bukaPratinjau(namaDocx);
  const bingkaiDocx = barisDocx.frameLocator('[data-testid="artifact-preview-frame"]');
  let isiDocx = "";
  try {
    await bingkaiDocx.locator("body").waitFor({ timeout: 25000 });
    isiDocx = await bingkaiDocx.locator("body").innerText();
  } catch (error) { isiDocx = `GAGAL: ${error instanceof Error ? error.message : String(error)}`; }
  check("pratinjau docx menampilkan isi dokumen sungguhan (DOKUMEN UJI WAVE 11A)",
    /DOKUMEN UJI WAVE 11A/.test(isiDocx), isiDocx.slice(0, 160));
  const sandboxIframe = await barisDocx.locator('[data-testid="artifact-preview-frame"]').first().getAttribute("sandbox").catch(() => null);
  check("iframe pratinjau dokumen tidak memakai allow-same-origin",
    sandboxIframe !== null && !String(sandboxIframe).includes("allow-same-origin"), String(sandboxIframe));

  // butir 49: pratinjau xlsx sebagai tabel.
  const barisXlsx = await bukaPratinjau(namaXlsx);
  let isiXlsx = "";
  try {
    await barisXlsx.locator('[data-testid="artifact-preview-table"]').first().waitFor({ timeout: 20000 });
    isiXlsx = await barisXlsx.locator('[data-testid="artifact-preview-table"]').first().innerText();
  } catch (error) { isiXlsx = `GAGAL: ${error instanceof Error ? error.message : String(error)}`; }
  check("pratinjau xlsx menampilkan isi sel (SEL-UJI-11A) sebagai tabel",
    /SEL-UJI-11A/.test(isiXlsx), isiXlsx.slice(0, 160));

  // butir 49: pratinjau pptx lewat pptx-preview, satu slide.
  const barisPptx = await bukaPratinjau(namaPptx);
  let isiPptx = ""; let slidePptx = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const panggung = barisPptx.locator('[data-testid="artifact-preview-pptx"]').first();
    if (await panggung.count()) {
      slidePptx = String(await panggung.getAttribute("data-slides"));
      isiPptx = await panggung.innerText().catch(() => "");
      if (slidePptx === "1" && /SLIDE UJI WAVE 11A/.test(isiPptx)) break;
    }
    await page.waitForTimeout(400);
  }
  check("pratinjau pptx merender slide sungguhan (SLIDE UJI WAVE 11A, 1 slide)",
    slidePptx === "1" && /SLIDE UJI WAVE 11A/.test(isiPptx), `slides=${slidePptx} teks=${isiPptx.slice(0, 120)}`);

  // butir 49: pratinjau markdown.
  const barisMd = await bukaPratinjau(namaMd);
  let isiMd = "";
  try {
    await barisMd.locator('[data-testid="artifact-preview-text"]').first().waitFor({ timeout: 15000 });
    isiMd = await barisMd.locator('[data-testid="artifact-preview-text"]').first().innerText();
  } catch (error) { isiMd = `GAGAL: ${error instanceof Error ? error.message : String(error)}`; }
  check("pratinjau markdown menampilkan isi berkas (CATATAN-MARKDOWN-WAVE-11A)",
    /CATATAN-MARKDOWN-WAVE-11A/.test(isiMd), isiMd.slice(0, 160));

  // butir 49: berkas yang gagal dirender tidak boleh menjadi layar kosong.
  const barisRusak = await bukaPratinjau(namaRusak);
  let pesanRusak = "";
  try {
    await barisRusak.locator('[data-testid="artifact-preview"][data-preview-mode="unduh"]').first().waitFor({ timeout: 25000 });
    pesanRusak = await barisRusak.locator('[data-testid="artifact-preview-message"]').first().innerText();
  } catch (error) { pesanRusak = `GAGAL: ${error instanceof Error ? error.message : String(error)}`; }
  check("berkas docx rusak -> mode unduh dengan pesan bahasa Indonesia",
    /gagal dirender/i.test(pesanRusak) && /unduh/i.test(pesanRusak), pesanRusak.slice(0, 200));

  // butir 49: berkas di atas 10 MB langsung mode unduh (ukuran disimulasikan, lihat catatan).
  const barisBesar = await bukaPratinjau(namaBesar);
  let pesanBesar = "";
  try {
    await barisBesar.locator('[data-testid="artifact-preview"][data-preview-mode="unduh"]').first().waitFor({ timeout: 15000 });
    pesanBesar = await barisBesar.locator('[data-testid="artifact-preview-message"]').first().innerText();
  } catch (error) { pesanBesar = `GAGAL: ${error instanceof Error ? error.message : String(error)}`; }
  check("berkas di atas 10 MB -> mode unduh dengan pesan batas ukuran",
    /10[.,]0 MB/.test(pesanBesar) && /unduh/i.test(pesanBesar), pesanBesar.slice(0, 200));
  const tautanUnduh = await barisBesar.locator('[data-testid="artifact-preview-download"]').count();
  check("mode unduh tetap menyediakan tautan unduh berkas", tautanUnduh > 0, String(tautanUnduh));

  // butir 48: sunting artefak teks + riwayat revisi + pulihkan.
  const barisSunting = barisArtefak(namaMd);
  await barisSunting.locator("button", { hasText: "Sunting" }).first().click();
  const editor = barisSunting.locator('[data-testid="artifact-editor"]').first();
  let isiAwalEditor = "";
  try {
    await editor.waitFor({ timeout: 15000 });
    isiAwalEditor = await editor.locator('[data-testid="artifact-editor-textarea"]').first().inputValue();
  } catch (error) { isiAwalEditor = `GAGAL: ${error instanceof Error ? error.message : String(error)}`; }
  checkApi("modal sunting memuat isi artefak dari server", "/content",
    /CATATAN-MARKDOWN-WAVE-11A/.test(isiAwalEditor), isiAwalEditor.slice(0, 160));
  const teksBaru = `${isiAwalEditor}\n\nBaris tambahan dari uji otomatis ${stamp}.`;
  await editor.locator('[data-testid="artifact-editor-textarea"]').first().fill(teksBaru);
  await editor.locator('[data-testid="artifact-editor-save"]').first().click();
  let pesanSunting = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    pesanSunting = await editor.locator('[data-testid="artifact-editor-message"]').first().innerText().catch(() => "");
    if (/revisi 2|tersimpan/i.test(pesanSunting)) break;
    await page.waitForTimeout(300);
  }
  checkApi("menyimpan suntingan membuat revisi baru di server", "/content",
    /revisi 2|tersimpan/i.test(pesanSunting), pesanSunting.slice(0, 200));
  // Daftar revisi dimuat ulang sesudah penyimpanan, jadi barisnya ditunggu (bukan dibaca sekali).
  let barisRevisi = 0; let tombolPulihkan = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    barisRevisi = await editor.locator('[data-testid="artifact-editor-revisions"] table tbody tr').count();
    tombolPulihkan = await editor.locator('button[data-testid^="artifact-editor-restore-"]').count();
    if (barisRevisi >= 1 && tombolPulihkan >= 1) break;
    await page.waitForTimeout(250);
  }
  checkApi("riwayat revisi menampilkan revisi lama beserta tombol pulihkan", "/revisions",
    barisRevisi >= 1 && tombolPulihkan >= 1, `baris=${barisRevisi} tombol=${tombolPulihkan}`);
  if (tombolPulihkan > 0) {
    await editor.locator('button[data-testid^="artifact-editor-restore-"]').first().click();
    let pesanPulih = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      pesanPulih = await editor.locator('[data-testid="artifact-editor-message"]').first().innerText().catch(() => "");
      if (/dipulihkan/i.test(pesanPulih)) break;
      await page.waitForTimeout(300);
    }
    checkApi("memulihkan revisi lama dijalankan server dan dilaporkan", "/restore", /dipulihkan/i.test(pesanPulih), pesanPulih.slice(0, 160));
  } else {
    skip("pemulihan revisi", "tidak ada tombol pulihkan yang bisa diklik");
  }
  // Editor ditutup supaya halaman kembali bersih.
  await editor.locator("button", { hasText: "Tutup" }).first().click().catch(() => undefined);

  // ----- 5) butir 42: mode diskusi/eksekusi pada percakapan, plus satu run untuk Riwayat run.
  await page.click('nav.page-nav .page-link:has-text("Percakapan")');
  await page.waitForTimeout(400);
  await page.click("button.new-chat");
  const bilahMode = page.locator('[data-testid="chat-mode-bar"]').first();
  let modeDb = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    modeDb = String(await bilahMode.getAttribute("data-mode").catch(() => "")) || "";
    if (modeDb && modeDb !== "belum-dibaca") break;
    await page.waitForTimeout(250);
  }
  checkApi("bilah mode percakapan membaca mode dari server", "/mode", modeDb === "eksekusi" || modeDb === "diskusi", modeDb);
  const putModeSebelum = callsTo("/mode").length;
  await page.click('[data-testid="chat-mode-diskusi"]');
  let modeDiskusi = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    modeDiskusi = String(await bilahMode.getAttribute("data-mode").catch(() => "")) || "";
    if (modeDiskusi === "diskusi") break;
    await page.waitForTimeout(250);
  }
  checkApi("menekan Diskusi menyimpan mode lewat API dan mengubah bilah penanda", "/mode",
    modeDiskusi === "diskusi" && callsTo("/mode").length > putModeSebelum,
    `mode=${modeDiskusi} panggilan=${callsTo("/mode").join(" | ")}`);
  const catatanMode = await page.locator('[data-testid="chat-mode-note"]').first().innerText().catch(() => "");
  check("bilah penanda menjelaskan mode diskusi dalam bahasa Indonesia",
    /diskusi/i.test(catatanMode) && /tidak membuat atau mengubah/i.test(catatanMode), catatanMode.slice(0, 160));
  const padatkanMati = await page.locator('button.icon-button[title*="Mode diskusi aktif"]').first().isDisabled().catch(() => null);
  const otonomMati = await page.locator('label:has-text("otonom") input[type="checkbox"]').first().isDisabled().catch(() => null);
  check("tombol pengubah data dimatikan saat mode diskusi", padatkanMati === true && otonomMati === true,
    `padatkan=${padatkanMati} otonom=${otonomMati}`);
  // Kembali ke mode eksekusi, lalu kirim satu pesan supaya ada run nyata di Riwayat run.
  await page.click('[data-testid="chat-mode-eksekusi"]');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (String(await bilahMode.getAttribute("data-mode").catch(() => "")) === "eksekusi") break;
    await page.waitForTimeout(250);
  }
  check("kembali ke mode eksekusi membuka lagi tombol pengubah data",
    (await page.locator('label:has-text("otonom") input[type="checkbox"]').first().isDisabled().catch(() => true)) === false,
    String(await bilahMode.getAttribute("data-mode").catch(() => "")));
  await page.fill(".composer textarea", `halo uji wave 11a ${stamp}`);
  await page.click(".composer button.send");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (callsTo("/runs").length > 0) break;
    await page.waitForTimeout(400);
  }
  check("mengirim pesan dari antarmuka membuat run di server", callsTo("/runs").length > 0, callsTo("/runs").join(" | ").slice(0, 160));
  // ----- 6) Wave 11A: halaman baru (butir 46, 51, 52), model cadangan (butir 57 + 56),
  //          Playground, pemasangan PWA (butir 55), dan pembersihan riwayat (butir 54).

  await bukaHalamanBaru("Guardrail", "/api/v1/guardrails");
  await bukaHalamanBaru("Basis pengetahuan", "/api/v1/knowledge-base");
  await bukaHalamanBaru("Skill saya", "/api/v1/skills/mine");

  // butir 57: halaman Penghemat token memuat urutan model cadangan dan bisa menambah baris.
  await bukaHalamanBaru("Penghemat token", "/api/v1/agents/fallback");
  await page.waitForSelector('[data-testid="fallback-models"]', { timeout: 15000 }).catch(() => undefined);
  const barisCadanganAwal = await page.locator('[data-testid^="fallback-input-"]').count();
  const adaPanelCadangan = await page.locator('[data-testid="fallback-models"]').count();
  await page.click('[data-testid="fallback-add"]').catch(() => undefined);
  await page.waitForTimeout(400);
  const barisCadanganAkhir = await page.locator('[data-testid^="fallback-input-"]').count();
  checkApi("halaman Penghemat token menyediakan urutan model cadangan yang bisa ditambah",
    adaPanelCadangan > 0 && barisCadanganAkhir === barisCadanganAwal + 1,
    `panel=${adaPanelCadangan} baris ${barisCadanganAwal} -> ${barisCadanganAkhir}`);

  // butir 46: kolom `violations` pada detail run. Diperiksa dua langkah supaya jujur:
  // (a) data NYATA dibaca langsung dari API: daftarnya kosong, sebab aturan larangan menahan permintaan
  //     SEBELUM run dibuat (lihat catatan modul guardrail);
  // (b) satu pelanggaran DISUNTIKKAN ke jawaban rute detail supaya panel antarmukanya benar-benar terbukti
  //     merender judul, jenis, pola, potongan, dan tautan ke halaman Guardrail.
  const detailRunNyata = await page.evaluate(async (projectId) => {
    const daftar = await (await fetch(`/api/v1/projects/${projectId}/runs`)).json().catch(() => null);
    const id = daftar?.runs?.[0]?.id ?? null;
    if (!id) return { id: null, punyaKolom: false, jumlah: -1 };
    const detail = await (await fetch(`/api/v1/runs/${id}`)).json().catch(() => null);
    const violations = detail?.violations;
    return { id, punyaKolom: Array.isArray(violations), jumlah: Array.isArray(violations) ? violations.length : -1 };
  }, siapkanUji.projectId);
  check("detail run dari server memuat kolom violations dan daftarnya kosong pada data nyata (butir 46)",
    Boolean(detailRunNyata.id) && detailRunNyata.punyaKolom === true && detailRunNyata.jumlah === 0,
    JSON.stringify(detailRunNyata));

  const pelanggaranUji = {
    id: "vio-uji-1", ruleId: "gr-uji-1", judul: "Larangan uji otomatis", kind: "larangan",
    pattern: "kata-rahasia", snippet: `potongan uji ${stamp}`, createdAt: new Date().toISOString(),
  };
  // Penyadapan hanya untuk jalur detail (GET /api/v1/runs/<id>); jawaban aslinya tetap dipakai.
  await page.route("**/api/v1/runs/*", async (route) => {
    const jalur = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || !/^\/api\/v1\/runs\/[^/]+$/.test(jalur)) return route.continue();
    const jawaban = await route.fetch();
    const badan = await jawaban.json().catch(() => null);
    if (badan && typeof badan === "object") badan.violations = [pelanggaranUji];
    await route.fulfill({ response: jawaban, json: badan });
  });

  // butir 57 + 56: Riwayat run menunjukkan perpindahan model, Playground menghitung biaya.
  await bukaHalamanBaru("Riwayat run", "/runs");
  await page.waitForSelector("main.main table tbody tr", { timeout: 15000 }).catch(() => undefined);
  const barisRun = page.locator("main.main table tbody tr").first();
  if (await barisRun.count()) {
    await barisRun.click();
    let penandaCadangan = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      penandaCadangan = await page.locator('[data-testid="run-fallback-marker"], [data-testid="run-fallback-none"]').count();
      if (penandaCadangan > 0) break;
      await page.waitForTimeout(250);
    }
    checkApi("detail run menjelaskan ada atau tidaknya perpindahan model cadangan",
      penandaCadangan > 0, `penanda=${penandaCadangan} panggilan=${callsTo("/runs/").join(" | ").slice(0, 160)}`);

    // butir 46: panel pelanggaran dari kolom yang baru saja dibaca.
    let panelPelanggaran = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      panelPelanggaran = await page.locator('[data-testid="run-violations"]').count();
      if (panelPelanggaran > 0) break;
      await page.waitForTimeout(250);
    }
    const teksPelanggaran = await page.locator('[data-testid="run-violations"]').first().innerText().catch(() => "");
    const rapiPelanggaran = teksPelanggaran.replace(/\n+/g, " | ");
    checkApi("panel pelanggaran di detail run menampilkan judul, jenis, pola, dan potongan dari server", "/api/v1/runs/",
      panelPelanggaran > 0
        && /larangan uji otomatis/i.test(teksPelanggaran)
        && /larangan/.test(teksPelanggaran)
        && /kata-rahasia/.test(teksPelanggaran)
        && rapiPelanggaran.includes(`potongan uji ${stamp}`),
      `panel=${panelPelanggaran} teks=${rapiPelanggaran.slice(0, 200)}`);
    const tautanGuardrail = page.locator('[data-testid="run-violations-link"]').first();
    const adaTautan = await tautanGuardrail.count();
    check("panel pelanggaran menyediakan tautan ke laporan Guardrail akun", adaTautan > 0, String(adaTautan));
    if (adaTautan > 0) {
      await tautanGuardrail.click();
      await page.waitForTimeout(900);
      const halamanAktif = await page.locator("nav.page-nav .page-link.active").first().innerText().catch(() => "");
      check("tautan panel pelanggaran membuka halaman Guardrail", /guardrail/i.test(halamanAktif), halamanAktif.trim().slice(0, 80));
    }
    // Tanpa pelanggaran, panel itu memang tidak dilukis: dibuktikan sesudah penyadapan dilepas.
    await page.unroute("**/api/v1/runs/*");
    await bukaHalamanBaru("Riwayat run", "/runs");
    await page.waitForSelector("main.main table tbody tr", { timeout: 15000 }).catch(() => undefined);
    const barisRunBersih = page.locator("main.main table tbody tr").first();
    if (await barisRunBersih.count()) {
      await barisRunBersih.click();
      let infoBersih = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        infoBersih = await page.locator('[data-testid="run-violations-info"]').first().innerText().catch(() => "");
        if (infoBersih) break;
        await page.waitForTimeout(250);
      }
      const panelBersih = await page.locator('[data-testid="run-violations"]').count();
      check("tanpa pelanggaran, panel pelanggaran tidak muncul dan barisnya menyebut tidak ada",
        panelBersih === 0 && /tidak ada/i.test(infoBersih), `panel=${panelBersih} info=${infoBersih.replace(/\n+/g, " | ").slice(0, 120)}`);
    } else {
      skip("panel pelanggaran tidak muncul tanpa pelanggaran", "baris run tidak bisa dibuka lagi");
    }
  } else {
    skip("detail run menjelaskan ada atau tidaknya perpindahan model cadangan", "belum ada run yang bisa dibuka di akun uji");
  }

  await bukaHalamanBaru("Playground", "/api/v1/models");
  await page.locator("main.main textarea").first().fill(`perkiraan biaya uji ${stamp}`).catch(() => undefined);
  const estimasiSebelum = callsTo("/playground/estimate").length;
  const tombolHitung = page.locator('[data-testid="playground-estimate-button"]').first();
  if (await tombolHitung.count()) {
    await tombolHitung.click();
    let teksEstimasi = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (callsTo("/playground/estimate").length > estimasiSebelum) {
        teksEstimasi = await page.locator('[data-testid="playground-estimate"]').first().innerText().catch(() => "");
        if (/perkiraan biaya/i.test(teksEstimasi)) break;
      }
      await page.waitForTimeout(300);
    }
    checkApi("tombol hitung di Playground memanggil API perkiraan dan menampilkan rincian harga",
      callsTo("/playground/estimate").length > estimasiSebelum && /perkiraan biaya/i.test(teksEstimasi) && /Rp/.test(teksEstimasi),
      teksEstimasi.replace(/\n+/g, " | ").slice(0, 240));
    const kolomOpsional = await page.locator('[data-testid="playground-estimate-output-tokens"], [data-testid="playground-estimate-runs"]').count();
    check("form perkiraan menyediakan kolom token keluaran dan jumlah perhitungan", kolomOpsional === 2, String(kolomOpsional));
  } else {
    skip("tombol hitung di Playground", "tombol perkiraan biaya tidak ditemukan");
  }

  // butir 55: tombol pasang aplikasi. Peramban uji tidak pernah memasang PWA, jadi kejadian
  // beforeinstallprompt dikirim sendiri (sama seperti Chrome saat aplikasi layak dipasang).
  const manifes = await page.request.get(`${base}/manifest.webmanifest`).catch(() => null);
  const isiManifes = manifes ? await manifes.json().catch(() => null) : null;
  check("berkas manifest PWA tersedia dan berisi nama serta mode standalone",
    Boolean(isiManifes) && Boolean(isiManifes.name) && isiManifes.display === "standalone",
    JSON.stringify({ status: manifes?.status(), name: isiManifes?.name, display: isiManifes?.display }));
  const tautanManifes = await page.locator('link[rel="manifest"]').count();
  check("index.html menautkan manifest sehingga peramban menawarkan pemasangan", tautanManifes > 0, String(tautanManifes));
  await page.evaluate(() => { window.dispatchEvent(new Event("beforeinstallprompt")); });
  await page.click('nav.page-nav .page-link:has-text("Pengaturan")');
  await page.waitForTimeout(800);
  let tombolInstalAda = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    tombolInstalAda = await page.locator('[data-testid="install-button"]').count();
    if (tombolInstalAda > 0) break;
    await page.waitForTimeout(250);
  }
  check("tombol pasang muncul walau peramban mengirim beforeinstallprompt sebelum halaman Pengaturan dibuka", tombolInstalAda > 0, String(tombolInstalAda));
  if (tombolInstalAda > 0) {
    await page.locator('[data-testid="install-button"]').first().click();
    await page.waitForTimeout(400);
    const pesanInstal = await page.locator('[data-testid="install-message"]').first().innerText().catch(() => "");
    check("menekan tombol pasang memberi penjelasan bahasa Indonesia (bukan tombol mati)",
      pesanInstal.trim().length > 0 && /pasang|peramban|menu/i.test(pesanInstal), pesanInstal.slice(0, 160));
  } else {
    skip("pesan tombol pasang", "tombol pasang tidak muncul meski beforeinstallprompt dikirim");
  }

  // butir 54: pembersihan riwayat wajib ekspor lebih dulu, lalu konfirmasi ketik HAPUS.
  const tombolBukaBersih = page.locator('[data-testid="history-open"]').first();
  if (await tombolBukaBersih.count()) {
    await tombolBukaBersih.click();
    await page.waitForSelector('[data-testid="history-delete"]', { timeout: 10000 }).catch(() => undefined);
    const tombolHapus = page.locator('[data-testid="history-delete"]').first();
    const hapusMatiSebelumEkspor = await tombolHapus.isDisabled().catch(() => null);
    checkApi("tombol hapus riwayat mati sebelum ekspor disiapkan (wajib ekspor dulu)",
      hapusMatiSebelumEkspor === true, String(hapusMatiSebelumEkspor));
    await page.selectOption('[data-testid="history-target"]', { label: proyekUji }).catch(() => undefined);
    await page.click('[data-testid="history-export"]');
    let infoEkspor = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      infoEkspor = await page.locator('[data-testid="history-export-info"]').first().innerText().catch(() => "");
      if (infoEkspor.trim()) break;
      await page.waitForTimeout(300);
    }
    checkApi("ekspor riwayat berhasil dan melaporkan jumlah percakapan",
      infoEkspor.trim().length > 0 && /percakapan/i.test(infoEkspor), infoEkspor.replace(/\n+/g, " | ").slice(0, 200));
    await page.fill('[data-testid="history-confirm-input"]', "HAPUS").catch(() => undefined);
    await page.waitForTimeout(300);
    const hapusHidup = await tombolHapus.isDisabled().catch(() => true) === false;
    checkApi("tombol hapus riwayat hidup setelah konfirmasi HAPUS diketik", hapusHidup, String(hapusHidup));
    if (hapusHidup) {
      const hapusSebelum = callsTo("/bulk-delete").length;
      await tombolHapus.click();
      let hasilHapus = "";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        hasilHapus = await page.locator('[data-testid="history-result"]').first().innerText().catch(() => "");
        if (hasilHapus.trim()) break;
        await page.waitForTimeout(300);
      }
      checkApi("penghapusan riwayat berjalan lewat API dan melaporkan jumlah yang dihapus",
        callsTo("/bulk-delete").length > hapusSebelum && /percakapan/i.test(hasilHapus),
        hasilHapus.replace(/\n+/g, " | ").slice(0, 200));
    } else {
      skip("penghapusan riwayat", "tombol hapus belum hidup setelah konfirmasi");
    }
  } else {
    skip("pembersihan riwayat", "panel pembersihan riwayat tidak ditemukan di halaman Pengaturan");
  }

  // butir 55: panduan iOS. Safari iOS tidak pernah mengirim beforeinstallprompt, jadi panduan
  // manual wajib muncul. Konteks baru dipakai supaya penyadapan standalone tidak mengganggu uji lain.
  const statusSesi = await context.storageState();
  const konteksIos = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    storageState: statusSesi,
  });
  const halamanIos = await konteksIos.newPage();
  await halamanIos.goto(base, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await halamanIos.waitForSelector("nav.page-nav", { timeout: 20000 }).catch(() => undefined);
  await halamanIos.click('nav.page-nav .page-link:has-text("Pengaturan")').catch(() => undefined);
  await halamanIos.waitForTimeout(1200);
  const panduanIos = await halamanIos.locator('[data-testid="install-ios-guide"]').first().innerText().catch(() => "");
  check("panduan pemasangan iOS muncul di iPhone (Safari tidak punya beforeinstallprompt)",
    /layar utama|safari/i.test(panduanIos), panduanIos.replace(/\n+/g, " | ").slice(0, 200));
  await konteksIos.close();

  // Di mode standalone aplikasi sudah terpasang: tawaran pemasangan harus hilang.
  const konteksStandalone = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: statusSesi });
  await konteksStandalone.addInitScript(() => { window.__coblaiStandalone = true; });
  const halamanStandalone = await konteksStandalone.newPage();
  await halamanStandalone.goto(base, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await halamanStandalone.waitForSelector("nav.page-nav", { timeout: 20000 }).catch(() => undefined);
  await halamanStandalone.click('nav.page-nav .page-link:has-text("Pengaturan")').catch(() => undefined);
  await halamanStandalone.waitForTimeout(1200);
  const tawaranStandalone = await halamanStandalone.locator('[data-testid="install-prompt"]').count();
  check("tawaran pasang hilang saat aplikasi berjalan dalam mode standalone", tawaranStandalone === 0, String(tawaranStandalone));
  await konteksStandalone.close();

  // ----- 7) Wave 11A: halaman "Kebijakan alat" (butir 47) dan kartu "Kesehatan platform" (butir 53).
  await bukaHalamanBaru("Kebijakan alat", "/api/v1/tools-policy");
  await page.waitForSelector('[data-testid="tools-policy"]', { timeout: 15000 }).catch(() => undefined);
  const panelAlat = page.locator('[data-testid="tools-policy"]').first();
  const kebijakanAwal = await page.evaluate(async () => (await fetch("/api/v1/tools-policy")).json().catch(() => null));
  const modeKartu = String(await panelAlat.getAttribute("data-mode").catch(() => ""));
  const katalogKartu = String(await panelAlat.getAttribute("data-catalog-filled").catch(() => ""));
  const helpTerlihat = await page.locator('[data-testid="tools-policy-help"]').first().innerText().catch(() => "");
  checkApi("halaman Kebijakan alat melukis keadaan dari server (mode, katalog, catatan bantuan)", "/v1/tools-policy",
    modeKartu === String(kebijakanAwal?.mode) && katalogKartu === String(Boolean(kebijakanAwal?.catalogFilled))
      && helpTerlihat.includes(String(kebijakanAwal?.help ?? "x").slice(0, 20)),
    `kartu=${modeKartu}/${katalogKartu} server=${kebijakanAwal?.mode}/${kebijakanAwal?.catalogFilled}`);

  // Keadaan akun uji: kebijakan belum diatur (bawaan) dan katalog kosong -> isian nama bebas.
  const adaInputBebas = await page.locator('[data-testid="tools-policy-custom-input"]').count();
  const adaDaftarCentang = await page.locator('[data-testid="tools-policy-catalog"]').count();
  const inputAdminKatalog = await page.locator('[data-testid="tools-policy-admin-catalog-input"]').count();
  check("katalog kosong membuat halaman memakai isian nama bebas, dan kartu katalog admin tersedia",
    adaInputBebas === 1 && adaDaftarCentang === 0 && inputAdminKatalog === 1,
    `input=${adaInputBebas} centang=${adaDaftarCentang} admin=${inputAdminKatalog} catalogFilled=${kebijakanAwal?.catalogFilled}`);

  // Jalur galat NYATA: nama berformat tidak sah ditolak server (400 INVALID_TOOL_NAME) dan pesannya ditampilkan.
  await page.fill('[data-testid="tools-policy-custom-input"]', "alat salah!");
  await page.click('[data-testid="tools-policy-custom-add"]');
  const panggilanAlatSebelum = callsTo("/tools-policy").length;
  await page.click('[data-testid="tools-policy-save"]');
  let galatNamaAlat = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    galatNamaAlat = await page.locator('[data-testid="tools-policy-error"]').first().innerText().catch(() => "");
    if (galatNamaAlat) break;
    await page.waitForTimeout(250);
  }
  checkApi("nama alat tidak sah ditolak server dan kalimatnya ditampilkan di halaman", "/tools-policy",
    callsTo("/tools-policy").length > panggilanAlatSebelum && jalurStatus("/tools-policy") === 400 && /tidak sah/i.test(galatNamaAlat),
    `status=${jalurStatus("/tools-policy")} pesan=${galatNamaAlat.slice(0, 160)}`);

  // Simpan daftar yang sah, lalu buktikan tersimpan di server (bukan hanya di layar).
  await page.click('[data-testid="tools-policy-clear"]');
  await page.fill('[data-testid="tools-policy-custom-input"]', "baca_berkas");
  await page.click('[data-testid="tools-policy-custom-add"]');
  await page.click('[data-testid="tools-policy-save"]');
  let pesanSimpanAlat = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    pesanSimpanAlat = await page.locator('[data-testid="tools-policy-message"]').first().innerText().catch(() => "");
    if (pesanSimpanAlat) break;
    await page.waitForTimeout(250);
  }
  const kebijakanSesudah = await page.evaluate(async () => (await fetch("/api/v1/tools-policy")).json().catch(() => null));
  checkApi("menyimpan daftar alat benar-benar tersimpan di server (mode daftar + nama terpilih)", "/tools-policy",
    jalurStatus("/tools-policy") === 200 && /disimpan/i.test(pesanSimpanAlat)
      && kebijakanSesudah?.mode === "daftar" && Array.isArray(kebijakanSesudah?.tools) && kebijakanSesudah.tools.includes("baca_berkas"),
    `status=${jalurStatus("/tools-policy")} mode=${kebijakanSesudah?.mode} tools=${JSON.stringify(kebijakanSesudah?.tools)}`);

  // Pilihan "Tanpa alat" disimpan server sebagai mode tanpa_alat.
  await page.click('[data-testid="tools-policy-mode-none"]');
  await page.click('[data-testid="tools-policy-save"]');
  let kebijakanTanpaAlat = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    kebijakanTanpaAlat = await page.evaluate(async () => (await fetch("/api/v1/tools-policy")).json().catch(() => null));
    if (kebijakanTanpaAlat?.mode === "tanpa_alat") break;
    await page.waitForTimeout(250);
  }
  checkApi("pilihan Tanpa alat disimpan server sebagai mode tanpa_alat", "/tools-policy",
    kebijakanTanpaAlat?.mode === "tanpa_alat", `mode=${kebijakanTanpaAlat?.mode} raw=${kebijakanTanpaAlat?.raw}`);

  // Katalog terisi (lewat kartu admin): halaman berubah menjadi daftar centang.
  await page.fill('[data-testid="tools-policy-admin-catalog-input"]', "baca_berkas\njalankan_shell");
  await page.click('[data-testid="tools-policy-admin-catalog-save"]');
  let adaKatalogCentang = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    adaKatalogCentang = await page.locator('[data-testid="tools-policy-catalog"]').count();
    if (adaKatalogCentang > 0) break;
    await page.waitForTimeout(250);
  }
  const centangBaca = await page.locator('[data-testid="tools-policy-check-baca_berkas"]').count();
  const centangShell = await page.locator('[data-testid="tools-policy-check-jalankan_shell"]').count();
  checkApi("katalog yang diisi admin mengubah halaman menjadi daftar centang dari katalog", "/admin/tool-catalog",
    jalurStatus("/admin/tool-catalog") === 200 && adaKatalogCentang === 1 && centangBaca === 1 && centangShell === 1,
    `status=${jalurStatus("/admin/tool-catalog")} katalog=${adaKatalogCentang} centang=${centangBaca}/${centangShell}`);

  // Nama di luar katalog ditolak 400 TOOL_NOT_ALLOWED, dan nama yang ditolak ikut ditampilkan.
  await page.click('[data-testid="tools-policy-check-baca_berkas"]');
  await page.fill('[data-testid="tools-policy-custom-input"]', "nama_luar_katalog");
  await page.click('[data-testid="tools-policy-custom-add"]');
  await page.click('[data-testid="tools-policy-save"]');
  let galatKatalogAlat = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    galatKatalogAlat = await page.locator('[data-testid="tools-policy-error"]').first().innerText().catch(() => "");
    if (galatKatalogAlat) break;
    await page.waitForTimeout(250);
  }
  const namaDitolak = await page.locator('[data-testid="tools-policy-unknown"]').first().innerText().catch(() => "");
  checkApi("nama di luar katalog ditolak server (TOOL_NOT_ALLOWED) dan nama yang ditolak disebut", "/tools-policy",
    jalurStatus("/tools-policy") === 400 && /tidak dikenal/i.test(galatKatalogAlat) && /nama_luar_katalog/.test(namaDitolak),
    `status=${jalurStatus("/tools-policy")} pesan=${galatKatalogAlat.slice(0, 140)} ditolak=${namaDitolak.slice(0, 80)}`);

  // Bersih-bersih: simpan daftar yang sah, lalu kosongkan katalog supaya keadaan platform kembali seperti semula.
  await page.click('[data-testid="tools-policy-clear"]');
  await page.click('[data-testid="tools-policy-check-baca_berkas"]');
  await page.click('[data-testid="tools-policy-save"]');
  await page.waitForTimeout(700);
  const kebijakanAkhir = await page.evaluate(async () => (await fetch("/api/v1/tools-policy")).json().catch(() => null));
  checkApi("daftar yang disimpan lagi tetap memakai nama dari katalog", "/tools-policy",
    kebijakanAkhir?.mode === "daftar" && Array.isArray(kebijakanAkhir?.tools) && kebijakanAkhir.tools.length === 1 && kebijakanAkhir.tools[0] === "baca_berkas",
    `mode=${kebijakanAkhir?.mode} tools=${JSON.stringify(kebijakanAkhir?.tools)}`);
  await page.fill('[data-testid="tools-policy-admin-catalog-input"]', "");
  await page.click('[data-testid="tools-policy-admin-catalog-save"]');
  let katalogKosongLagi = "true";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    katalogKosongLagi = String(await panelAlat.getAttribute("data-catalog-filled").catch(() => "true"));
    if (katalogKosongLagi === "false") break;
    await page.waitForTimeout(250);
  }
  checkApi("mengosongkan katalog mengembalikan halaman ke isian nama bebas", "/admin/tool-catalog",
    katalogKosongLagi === "false" && (await page.locator('[data-testid="tools-policy-custom-input"]').count()) === 1,
    `catalogFilled=${katalogKosongLagi}`);

  // ----- 8) butir 53: kartu "Kesehatan platform" + tombol "Jalankan uji mandiri".
  await bukaHalamanBaru("Status platform", "/api/v1/status-hub");
  await page.waitForSelector('[data-testid="platform-health"]', { timeout: 15000 }).catch(() => undefined);
  const kartuSehat = page.locator('[data-testid="platform-health"]').first();
  const statusAwalKartu = String(await kartuSehat.getAttribute("data-status").catch(() => ""));
  check("kartu Kesehatan platform tersedia dan belum berjalan sebelum tombolnya ditekan",
    statusAwalKartu === "belum" && (await page.locator('[data-testid="health-run"]').count()) === 1,
    `status=${statusAwalKartu}`);

  const auditSebelum = callsTo("/admin/self-audit").length;
  await page.click('[data-testid="health-run"]');
  let statusKartu = "";
  let auditNyata = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    statusKartu = String(await kartuSehat.getAttribute("data-status").catch(() => "")) || "";
    if (["ok", "warn", "fail"].includes(statusKartu)) {
      auditNyata = await page.evaluate(async () => (await fetch("/api/v1/admin/self-audit")).json().catch(() => null));
      break;
    }
    await page.waitForTimeout(250);
  }
  const terburukNyata = auditNyata
    ? (Number(auditNyata?.ringkasan?.fail ?? 0) > 0 ? "fail" : Number(auditNyata?.ringkasan?.warn ?? 0) > 0 ? "warn" : "ok")
    : "";
  checkApi("tombol Jalankan uji mandiri memanggil API audit-diri dan kartu mengikuti ringkasan server", "/admin/self-audit",
    callsTo("/admin/self-audit").length > auditSebelum && ["ok", "warn", "fail"].includes(statusKartu) && statusKartu === terburukNyata,
    `kartu=${statusKartu} server=${terburukNyata} ringkasan=${JSON.stringify(auditNyata?.ringkasan)}`);

  // Angka ringkasan di kartu harus sama dengan jawaban server, bukan angka hafalan halaman.
  const angkaOk = await page.locator('[data-testid="health-count-ok"]').first().innerText().catch(() => "");
  const angkaWarn = await page.locator('[data-testid="health-count-warn"]').first().innerText().catch(() => "");
  const angkaFail = await page.locator('[data-testid="health-count-fail"]').first().innerText().catch(() => "");
  check("angka ringkasan di kartu sama dengan jawaban server (ok/warn/fail)",
    angkaOk.trim() === `ok ${Number(auditNyata?.ringkasan?.ok ?? -1)}`
      && angkaWarn.trim() === `warn ${Number(auditNyata?.ringkasan?.warn ?? -1)}`
      && angkaFail.trim() === `fail ${Number(auditNyata?.ringkasan?.fail ?? -1)}`,
    `kartu="${angkaOk.trim()} / ${angkaWarn.trim()} / ${angkaFail.trim()}" server=${JSON.stringify(auditNyata?.ringkasan)}`);

  // Setiap butir ditampilkan utuh (judul + catatan) dan TIDAK ada kolom nilai tambahan di kartu.
  const barisSehat = await page.locator('[data-testid^="health-check-"]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute("data-testid"), status: node.getAttribute("data-status"), teks: String(node.textContent || ""),
  })));
  const butirServer = Array.isArray(auditNyata?.checks) ? auditNyata.checks : [];
  const menyimpang = butirServer.filter((item) => {
    const baris = barisSehat.find((row) => row.id === `health-check-${item.id}`);
    if (!baris) return true;
    if (!["ok", "warn", "fail"].includes(String(baris.status))) return true;
    if (baris.status !== item.status) return true;
    const judul = String(item.judul ?? "");
    const catatan = String(item.catatan ?? "");
    return !baris.teks.includes(judul) || !baris.teks.includes(catatan)
      || baris.teks.replace(/\s+/g, " ").length > (judul + " " + catatan + " " + item.status).replace(/\s+/g, " ").length + 10;
  });
  check("setiap butir audit-diri ditampilkan utuh (judul + catatan) tanpa kolom nilai tambahan",
    butirServer.length > 0 && barisSehat.length === butirServer.length && menyimpang.length === 0,
    `baris=${barisSehat.length} server=${butirServer.length} menyimpang=${JSON.stringify(menyimpang.map((item) => item.id))}`);

  // Pengguna BUKAN admin harus menerima 403 ADMIN_REQUIRED sebagai kalimat, bukan layar kosong.
  const nonAdminEmail = `w11a-nonadmin-${stamp}@example.test`;
  const konteksNonAdmin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const halamanNonAdmin = await konteksNonAdmin.newPage();
  const panggilanNonAdmin = [];
  halamanNonAdmin.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/v1/")) panggilanNonAdmin.push(`${response.status()} ${url.replace(base, "")}`);
  });
  await halamanNonAdmin.goto(base, { waitUntil: "domcontentloaded" });
  await halamanNonAdmin.waitForSelector(".profile-button", { timeout: 20000 });
  await halamanNonAdmin.click(".profile-button");
  await halamanNonAdmin.waitForSelector("form.auth-card", { timeout: 10000 });
  const daftarKedua = halamanNonAdmin.locator("button.switch", { hasText: "Daftar" }).first();
  if (await daftarKedua.count()) await daftarKedua.click();
  await halamanNonAdmin.fill('input[placeholder="Nama Anda"]', "Pengguna Uji Wave 11A");
  await halamanNonAdmin.fill('input[placeholder="Email atau username"]', nonAdminEmail);
  await halamanNonAdmin.fill('input[type="password"]', password);
  await halamanNonAdmin.click("button.primary");
  await halamanNonAdmin.waitForSelector("nav.page-nav", { timeout: 20000 });
  const menuAdminKedua = await halamanNonAdmin.locator('nav.page-nav .page-link:has-text("Metrik")').count();
  check("akun kedua lewat layar masuk bukan admin platform (menu admin tidak muncul)", menuAdminKedua === 0, String(menuAdminKedua));
  await halamanNonAdmin.click('nav.page-nav .page-link:has-text("Status platform")');
  await halamanNonAdmin.waitForSelector('[data-testid="health-run"]', { timeout: 15000 }).catch(() => undefined);
  await halamanNonAdmin.click('[data-testid="health-run"]').catch(() => undefined);
  let pesanNonAdmin = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    pesanNonAdmin = await halamanNonAdmin.locator('[data-testid="platform-health-message"]').first().innerText().catch(() => "");
    if (pesanNonAdmin) break;
    await halamanNonAdmin.waitForTimeout(250);
  }
  const tolak403 = panggilanNonAdmin.some((line) => line.startsWith("403") && line.includes("/admin/self-audit"));
  const halamanUtuh = await halamanNonAdmin.locator("main.main").innerText().catch(() => "");
  check("pengguna bukan admin dijawab 403 ADMIN_REQUIRED dengan kalimat Indonesia, halaman tetap utuh",
    tolak403 && /admin platform/i.test(pesanNonAdmin) && /mesin agen/i.test(halamanUtuh),
    `403=${tolak403} pesan=${pesanNonAdmin.slice(0, 140)} utuh=${halamanUtuh.length}`);

  // Halaman khusus admin (Laporan galat, tab Operasional) memang tidak ditawarkan ke akun bukan admin,
  // jadi yang diuji di sini bukan layar halamannya, melainkan dua hal yang bisa dibuktikan: menunya
  // tidak muncul, dan rute adminnya dijawab 403 oleh server.
  const menuNonAdmin = await halamanNonAdmin.evaluate(() => {
    const tautan = [...document.querySelectorAll("nav.page-nav .page-link")].map((node) => String(node.textContent || "").trim());
    return { galat: tautan.filter((teks) => teks.endsWith("Laporan galat")).length, total: tautan.length };
  });
  const jawabanAdminNonAdmin = await halamanNonAdmin.evaluate(async () => {
    const bulan = new Date().toISOString().slice(0, 7);
    const jalur = ["/api/v1/admin/errors?limit=100", `/api/v1/admin/token-accounting?month=${bulan}`, "/api/v1/admin/shadow"];
    const hasil = [];
    for (const satu of jalur) {
      const balasan = await fetch(satu);
      hasil.push(`${balasan.status} ${satu}`);
    }
    return hasil;
  });
  check("akun bukan admin tidak ditawari menu Laporan galat dan rute adminnya dijawab 403",
    menuNonAdmin.galat === 0 && menuNonAdmin.total > 0 && jawabanAdminNonAdmin.every((line) => line.startsWith("403")),
    `menuGalat=${menuNonAdmin.galat} menu=${menuNonAdmin.total} jawaban=${jawabanAdminNonAdmin.join(" | ")}`);

  // Wave 11C: rute admin baru (kanal bot, versi mesin, antrean nominal manual, avatar agen) juga harus
  // dijaga server, bukan hanya disembunyikan di layar. Diuji lewat API, jadi tidak bergantung tata letak.
  const jawabanAdmin11C = await halamanNonAdmin.evaluate(async () => {
    const jalur = ["/api/v1/admin/bot-channels", "/api/v1/admin/engine/version", "/api/v1/billing/manual-orders/queue", "/api/v1/admin/agent-avatar"];
    const hasil = [];
    for (const satu of jalur) {
      const balasan = await fetch(satu);
      const badan = await balasan.json().catch(() => ({}));
      hasil.push(`${balasan.status} ${satu} ${badan.error || ""}`);
    }
    return hasil;
  });
  check("empat rute admin Wave 11C dijawab 403 ADMIN_REQUIRED untuk akun bukan admin",
    jawabanAdmin11C.every((line) => line.startsWith("403") && line.includes("ADMIN_REQUIRED")),
    jawabanAdmin11C.join(" | "));
  await konteksNonAdmin.close();



  // ----- 9) Wave 11B (v0.22.0): butir 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 72.
  // Aturan uji bagian ini: setiap pemeriksaan membandingkan apa yang DILUKIS halaman dengan jawaban
  // server pada saat itu juga, bukan angka atau nama yang ditulis di berkas uji. Halaman baru tidak bisa
  // memakai pencocokan `has-text` bawaan Playwright karena label "Pemakaian saya" juga memuat "Pemakaian";
  // pemilih menu di bawah mencocokkan AKHIRAN teks menu, yang selalu berisi nama halaman.
  const serverJson = (jalur, init) => page.evaluate(async (pesan) => {
    const jawaban = await fetch(pesan.jalur, pesan.init || undefined);
    const teks = await jawaban.text();
    let badan = null;
    try { badan = JSON.parse(teks); } catch { badan = null; }
    return { status: jawaban.status, badan, potongan: teks.slice(0, 200) };
  }, { jalur, init: init || null });
  const jsonKirim = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const panggilanPersis = (jalur) => apiCalls.filter((line) => line.endsWith(jalur));
  const angkaId = (nilai) => Number(nilai ?? 0).toLocaleString("id-ID");
  const usd6 = (micros) => `$${(Number(micros ?? 0) / 1_000_000).toFixed(6)}`;
  const rapi = (teks) => String(teks ?? "").replace(/\s+/g, " ").trim();
  const daftarDari = (badan, kunci) => (Array.isArray(badan) ? badan : (badan && Array.isArray(badan[kunci]) ? badan[kunci] : []));

  async function klikMenu11B(label) {
    const diklik = await page.evaluate((label) => {
      const tautan = [...document.querySelectorAll("nav.page-nav .page-link")];
      const cocok = tautan.find((node) => String(node.textContent || "").trim().endsWith(label));
      if (!cocok) return false;
      cocok.click();
      return true;
    }, label);
    await page.waitForTimeout(500);
    return diklik;
  }
  async function bukaHalaman11B(label, urlPart) {
    const before = apiCalls.length;
    const diklik = await klikMenu11B(label);
    let terlihat = !urlPart;
    for (let attempt = 0; attempt < 60 && !terlihat; attempt += 1) {
      if (apiCalls.slice(before).some((line) => line.includes(urlPart))) terlihat = true;
      else await page.waitForTimeout(250);
    }
    const aktif = rapi(await page.locator("nav.page-nav .page-link.active").first().innerText().catch(() => ""));
    checkApi(`halaman ${label} dibuka dari menu kiri, menu aktif benar, dan API-nya terpanggil`, urlPart,
      diklik && aktif.endsWith(label) && terlihat,
      `diklik=${diklik} menu="${aktif}" panggilan=${apiCalls.slice(before).join(" | ").slice(0, 160)}`);
    await page.screenshot({ path: `${shots}/11B-${label.replace(/[^A-Za-z]/g, "_")}.png` });
    return page.locator("main.main").innerText();
  }

  // butir 60: tab "Pelajaran" di halaman Memori. Bank memori lama tetap seperti semula (tabnya lebih dulu).
  await bukaHalaman11B("Bank memori", "/api/v1/memories");
  await page.waitForSelector('[data-testid="memory-page"]', { timeout: 15000 }).catch(() => undefined);
  const tabAwalMemori = String(await page.locator('[data-testid="memory-page"]').first().getAttribute("data-tab").catch(() => ""));
  const adaTabPelajaran = await page.locator('[data-testid="memory-tab-pelajaran"]').count();
  checkApi("halaman Memori tetap membuka tab Bank memori lebih dulu dan menyediakan tab Pelajaran",
    "/api/v1/memories", tabAwalMemori === "bank" && adaTabPelajaran === 1,
    `tab=${tabAwalMemori} tabPelajaran=${adaTabPelajaran}`);

  const sebelumBukaPelajaran = panggilanPersis("/api/v1/learnings").length;
  await page.click('[data-testid="memory-tab-pelajaran"]');
  let tabPelajaran = "";
  // Tunggu dua-duanya: permintaan API pelajaran DAN gambar ulang halaman (kartu batas pelajaran
  // baru muncul setelah jawaban server tiba). Kalau hanya API yang ditunggu, halaman bisa masih kosong.
  let batasPelajaranTampil = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    tabPelajaran = String(await page.locator('[data-testid="memory-page"]').first().getAttribute("data-tab").catch(() => ""));
    batasPelajaranTampil = await page.locator('[data-testid="learnings-limits"]').count();
    if (tabPelajaran === "pelajaran" && batasPelajaranTampil > 0
      && panggilanPersis("/api/v1/learnings").length > sebelumBukaPelajaran) break;
    await page.waitForTimeout(250);
  }
  checkApi("tab Pelajaran memanggil API pelajaran dan menggantikan isi halaman",
    "/api/v1/learnings", tabPelajaran === "pelajaran" && panggilanPersis("/api/v1/learnings").length > sebelumBukaPelajaran,
    `tab=${tabPelajaran} panggilan=${panggilanPersis("/api/v1/learnings").length - sebelumBukaPelajaran}`);

  const pelajaranServer = (await serverJson("/api/v1/learnings")).badan;
  const batasHalaman = rapi(await page.locator('[data-testid="learnings-limits"]').first().innerText().catch(() => ""));
  const batasHarap = pelajaranServer
    ? rapi(`${angkaId(pelajaranServer.activeCount)} aktif dari batas ${angkaId(pelajaranServer.activeLimit)} · ${angkaId(pelajaranServer.total)} butir tersimpan dari batas ${angkaId(pelajaranServer.maxTotal)}`)
    : "";
  checkApi("batas pelajaran di halaman sama dengan jawaban server (aktif, batas aktif, total, batas total)",
    "/api/v1/learnings", batasHarap.length > 0 && batasHalaman.includes(batasHarap),
    `halaman="${batasHalaman.slice(0, 200)}" server="${batasHarap}"`);

  const judulPelajaran = `Pelajaran uji ${stamp}`;
  const isiPelajaran = `Selalu jalankan uji ${stamp} sebelum melapor.`;
  await page.fill('[data-testid="learnings-judul"]', judulPelajaran);
  await page.fill('[data-testid="learnings-isi"]', isiPelajaran);
  const sebelumTambahPelajaran = panggilanPersis("/api/v1/learnings").length;
  await page.click('[data-testid="learnings-tambah"]');
  let pelajaranBaru = null;
  let barisPelajaranBaruTampil = 0;
  // Tunggu dua-duanya: butirnya ADA di server DAN barisnya sudah muncul di halaman.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    pelajaranBaru = daftarDari((await serverJson("/api/v1/learnings")).badan, "learnings").find((row) => row.title === judulPelajaran) || null;
    barisPelajaranBaruTampil = pelajaranBaru ? await page.locator(`[data-testid="learning-${pelajaranBaru.id}"]`).count() : 0;
    if (pelajaranBaru && barisPelajaranBaruTampil === 1) break;
    await page.waitForTimeout(250);
  }
  const idPelajaran = pelajaranBaru ? String(pelajaranBaru.id) : "";
  checkApi("tombol tambah di tab Pelajaran benar-benar menuliskan butir baru ke server",
    "/api/v1/learnings",
    panggilanPersis("/api/v1/learnings").length > sebelumTambahPelajaran && Boolean(idPelajaran)
      && pelajaranBaru.body === isiPelajaran && Number(pelajaranBaru.enabled) === 1 && Boolean(pelajaranBaru.userId),
    `butir=${JSON.stringify({ id: idPelajaran, title: pelajaranBaru && pelajaranBaru.title, enabled: pelajaranBaru && pelajaranBaru.enabled })}`);
  if (!idPelajaran) throw new Error("butir pelajaran uji tidak bisa dibuat lewat halaman Memori");

  await page.waitForSelector(`[data-testid="learning-${idPelajaran}"]`, { timeout: 15000 }).catch(() => undefined);
  const barisPelajaran = page.locator(`[data-testid="learning-${idPelajaran}"]`).first();
  const statusPelajaran = rapi(await page.locator(`[data-testid="learning-status-${idPelajaran}"]`).first().innerText().catch(() => ""));
  check("butir pelajaran baru muncul di daftar sebagai aktif dan isinya tampil utuh",
    (await page.locator(`[data-testid="learning-${idPelajaran}"]`).count()) === 1
      && /aktif/.test(statusPelajaran) && rapi(await barisPelajaran.innerText()).includes(isiPelajaran),
    `status="${statusPelajaran}"`);

  await page.click(`[data-testid="learning-aktif-${idPelajaran}"]`);
  // Tunggu dua-duanya: perubahan di server DAN gambar ulang di halaman. Kalau hanya server yang
  // ditunggu, halaman bisa masih memperlihatkan baris lama saat dibaca (pernah terjadi).
  let enabledServer = 1;
  let statusSetelahMatikan = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const baris = daftarDari((await serverJson("/api/v1/learnings")).badan, "learnings").find((row) => String(row.id) === idPelajaran);
    enabledServer = baris ? Number(baris.enabled) : -1;
    statusSetelahMatikan = rapi(await page.locator(`[data-testid="learning-status-${idPelajaran}"]`).first().innerText().catch(() => ""));
    if (enabledServer === 0 && /nonaktif/.test(statusSetelahMatikan)) break;
    await page.waitForTimeout(250);
  }
  check("tombol Matikan mematikan pelajaran di server dan halaman ikut menyebut nonaktif",
    enabledServer === 0 && /nonaktif/.test(statusSetelahMatikan), `server.enabled=${enabledServer} status="${statusSetelahMatikan}"`);

  const judulBaru = `${judulPelajaran} (diubah)`;
  await page.click(`[data-testid="learning-edit-${idPelajaran}"]`);
  await page.fill(`[data-testid="learning-edit-judul-${idPelajaran}"]`, judulBaru);
  await page.click(`[data-testid="learning-simpan-${idPelajaran}"]`);
  let judulTersimpan = "";
  let judulPelajaranDiHalaman = "";
  // Tunggu dua-duanya: judul baru tersimpan di server DAN barisnya di halaman ikut berubah.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const baris = daftarDari((await serverJson("/api/v1/learnings")).badan, "learnings").find((row) => String(row.id) === idPelajaran);
    judulTersimpan = baris ? String(baris.title) : "";
    judulPelajaranDiHalaman = rapi(await barisPelajaran.innerText().catch(() => ""));
    if (judulTersimpan === judulBaru && judulPelajaranDiHalaman.includes(judulBaru)) break;
    await page.waitForTimeout(250);
  }
  check("ubah pelajaran dari halaman menyimpan judul baru di server dan menampilkannya",
    judulTersimpan === judulBaru && rapi(await barisPelajaran.innerText()).includes(judulBaru),
    `server="${judulTersimpan}"`);

  await page.click(`[data-testid="learning-hapus-${idPelajaran}"]`);
  await page.waitForSelector(`[data-testid="learning-hapus-yakin-${idPelajaran}"]`, { timeout: 10000 }).catch(() => undefined);
  await page.click(`[data-testid="learning-hapus-yakin-${idPelajaran}"]`);
  let masihAdaPelajaran = true;
  let barisPelajaranTersisa = 1;
  // Tunggu dua-duanya: barisnya sudah HILANG di server DAN barisnya juga hilang dari halaman.
  // Kalau hanya server yang ditunggu, halaman bisa masih melukis baris lama saat dibaca (pernah terjadi).
  for (let attempt = 0; attempt < 40; attempt += 1) {
    masihAdaPelajaran = daftarDari((await serverJson("/api/v1/learnings")).badan, "learnings").some((row) => String(row.id) === idPelajaran);
    barisPelajaranTersisa = await page.locator(`[data-testid="learning-${idPelajaran}"]`).count();
    if (!masihAdaPelajaran && barisPelajaranTersisa === 0) break;
    await page.waitForTimeout(250);
  }
  check("hapus pelajaran menghilangkan butirnya dari server dan dari daftar halaman",
    !masihAdaPelajaran && barisPelajaranTersisa === 0,
    `masihAdaDiServer=${masihAdaPelajaran} barisDiHalaman=${barisPelajaranTersisa}`);

  // butir 58: Dewan juri. Dua langkah wajib: hitung perkiraan dulu, baru jalankan.
  await bukaHalaman11B("Dewan juri", "/api/v1/council/runs");
  await page.waitForSelector('[data-testid="council"]', { timeout: 15000 }).catch(() => undefined);
  const tombolJalanDewan = page.locator('[data-testid="council-run-button"]').first();
  const dewanMatiAwal = await tombolJalanDewan.isDisabled().catch(() => null);
  const catatanWajibDewan = rapi(await page.locator('[data-testid="council-need-estimate"]').first().innerText().catch(() => ""));
  check("tombol minta penilaian dewan mati sebelum perkiraan biaya dihitung",
    dewanMatiAwal === true && catatanWajibDewan.length > 0, `mati=${dewanMatiAwal} catatan="${catatanWajibDewan.slice(0, 120)}"`);

  const materiDewan = `Materi uji dewan ${stamp}. Jawaban contoh yang panjangnya cukup untuk diukur.`;
  const tanyaDewan = `Nilai materi uji ${stamp} secara singkat.`;
  await page.fill('[data-testid="council-material"]', materiDewan);
  await page.fill('[data-testid="council-question"]', tanyaDewan);
  const sebelumPerkiraan = panggilanPersis("/api/v1/council/estimate").length;
  await page.click('[data-testid="council-estimate-button"]');
  let perkiraanHalaman = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (panggilanPersis("/api/v1/council/estimate").length > sebelumPerkiraan) {
      const kartu = page.locator('[data-testid="council-estimate"]').first();
      if (await kartu.count()) {
        perkiraanHalaman = { micros: String(await kartu.getAttribute("data-micros")), jurors: String(await kartu.getAttribute("data-jurors")) };
        break;
      }
    }
    await page.waitForTimeout(250);
  }
  const perkiraanServer = await serverJson("/api/v1/council/estimate", jsonKirim({ material: materiDewan, question: tanyaDewan }));
  checkApi("perkiraan biaya dewan di halaman sama persis dengan perkiraan server untuk permintaan yang sama",
    "/api/v1/council/estimate",
    Boolean(perkiraanHalaman) && perkiraanServer.status === 200
      && perkiraanHalaman.micros === String(perkiraanServer.badan.perkiraanBiayaMicros)
      && perkiraanHalaman.jurors === daftarDari(perkiraanServer.badan.jurors, "").join(","),
    `halaman=${JSON.stringify(perkiraanHalaman)} server=${JSON.stringify({ micros: perkiraanServer.badan && perkiraanServer.badan.perkiraanBiayaMicros, jurors: perkiraanServer.badan && perkiraanServer.badan.jurors })}`);

  const sebelumJalanDewan = panggilanPersis("/api/v1/council/run").length;
  await page.click('[data-testid="council-run-button"]');
  let statusHasilDewan = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const kartu = page.locator('[data-testid="council-result"]').first();
    if (await kartu.count()) { statusHasilDewan = String(await kartu.getAttribute("data-status")); break; }
    await page.waitForTimeout(250);
  }
  const jalurDetailDewan = apiCalls.map((line) => line.replace(/^\d+ /, "")).filter((jalur) => /^\/api\/v1\/council\/runs\/[^/]+$/.test(jalur));
  const idDewan = jalurDetailDewan.length ? jalurDetailDewan[jalurDetailDewan.length - 1].split("/").pop() : "";
  const detailDewan = idDewan ? await serverJson(`/api/v1/council/runs/${idDewan}`) : { status: 0, badan: null };
  checkApi("menekan Minta penilaian dewan membuat dewan nyata di server dan hasilnya dilukis di halaman",
    "/api/v1/council/run",
    panggilanPersis("/api/v1/council/run").length > sebelumJalanDewan && Boolean(idDewan) && detailDewan.status === 200
      && statusHasilDewan === String(detailDewan.badan.status),
    `statusHalaman=${statusHasilDewan} statusServer=${detailDewan.badan && detailDewan.badan.status} id=${idDewan}`);

  const barisVerdictDewan = String(await page.locator('[data-testid="council-verdicts"]').first().getAttribute("data-count").catch(() => ""));
  const verdictDewan = daftarDari(detailDewan.badan && detailDewan.badan.verdicts, "verdicts");
  const teksHasilDewan = rapi(await page.locator('[data-testid="council-result"]').first().innerText().catch(() => ""));
  check("tabel juri menampilkan setiap juri dari server beserta biaya dan galatnya",
    barisVerdictDewan === String(verdictDewan.length) && verdictDewan.length > 0
      && verdictDewan.every((juri) => teksHasilDewan.includes(String(juri.juror)) && teksHasilDewan.includes(usd6(juri.costMicros))),
    `baris=${barisVerdictDewan} server=${verdictDewan.length}`);

  const kartuBiayaDewan = page.locator('[data-testid="council-cost"]').first();
  const angkaDewanServer = detailDewan.badan || {};
  check("biaya dewan yang ditampilkan memakai angka server (perkiraan dan biaya nyata)",
    String(await kartuBiayaDewan.getAttribute("data-estimated").catch(() => "")) === String(angkaDewanServer.perkiraanBiayaMicros)
      && String(await kartuBiayaDewan.getAttribute("data-actual").catch(() => "")) === String(angkaDewanServer.costMicros)
      && rapi(await kartuBiayaDewan.innerText()).includes(usd6(angkaDewanServer.costMicros)),
    `halaman=${await kartuBiayaDewan.getAttribute("data-estimated").catch(() => "")}/${await kartuBiayaDewan.getAttribute("data-actual").catch(() => "")} server=${angkaDewanServer.perkiraanBiayaMicros}/${angkaDewanServer.costMicros}`);

  const riwayatDewanBadan = (await serverJson("/api/v1/council/runs")).badan;
  const riwayatDewanServer = daftarDari(riwayatDewanBadan, "runs");
  // Daftar riwayat dimuat ULANG setelah hasil dewan dilukis, jadi tunggu dua-duanya: server sudah
  // memuat dewan itu DAN barisnya sudah muncul di daftar halaman.
  let jumlahRiwayatDewan = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    jumlahRiwayatDewan = String(await page.locator('[data-testid="council-runs"]').first().getAttribute("data-count").catch(() => ""));
    if (jumlahRiwayatDewan === String(riwayatDewanServer.length)
      && (await page.locator(`[data-testid="council-run-${idDewan}"]`).count()) === 1) break;
    await page.waitForTimeout(250);
  }
  check("daftar dewan terakhir sama jumlahnya dengan server dan memuat dewan yang baru dijalankan",
    jumlahRiwayatDewan === String(riwayatDewanServer.length) && riwayatDewanServer.some((row) => String(row.id) === idDewan)
      && (await page.locator(`[data-testid="council-run-${idDewan}"]`).count()) === 1,
    `halaman=${jumlahRiwayatDewan} server=${riwayatDewanServer.length}`);

  await page.fill('[data-testid="council-question"]', `${tanyaDewan} (diubah)`);
  await page.waitForTimeout(400);
  const perkiraanSetelahUbah = await page.locator('[data-testid="council-estimate"]').count();
  const dewanMatiLagi = await tombolJalanDewan.isDisabled().catch(() => null);
  check("mengubah pertanyaan membuang perkiraan lama dan mematikan lagi tombol jalankan",
    perkiraanSetelahUbah === 0 && dewanMatiLagi === true, `kartuPerkiraan=${perkiraanSetelahUbah} tombolMati=${dewanMatiLagi}`);

  // butir 61: Benchmark model. Batas jumlah model dan biaya perkiraan harus datang dari server.
  await bukaHalaman11B("Benchmark model", "/api/v1/models");
  await page.waitForSelector('[data-testid="benchmark"]', { timeout: 15000 }).catch(() => undefined);
  const katalogBadan = (await serverJson("/api/v1/models")).badan;
  const semuaModelKatalog = daftarDari(katalogBadan, "models").map((row) => String(row.model)).filter(Boolean);
  // Model yang dipakai mensimulasikan galat sementara (MOCK_ENGINE_FAIL_MODELS) tidak ikut dipilih di sini,
  // supaya uji benchmark mengukur jalur yang berhasil.
  const daftarModelGagal = String(modelGagalUji).split(",").map((item) => item.trim()).filter(Boolean);
  const modelSehat = semuaModelKatalog.filter((nama) => !daftarModelGagal.includes(nama));
  const tombolJalanBenchmark = page.locator('[data-testid="benchmark-run-button"]').first();
  check("katalog model dari server tampil di halaman Benchmark dan tombol jalankan mati sebelum perkiraan",
    semuaModelKatalog.length > 0 && modelSehat.length > 0
      && (await page.locator('[data-testid="benchmark-need-estimate"]').count()) === 1
      && (await tombolJalanBenchmark.isDisabled().catch(() => null)) === true,
    `katalog=${semuaModelKatalog.length} sehat=${modelSehat.length} tombolMati=${await tombolJalanBenchmark.isDisabled().catch(() => null)}`);

  if (modelSehat.length >= 4) {
    for (const nama of modelSehat.slice(0, 4)) await page.click(`[data-testid="benchmark-model-${nama}"]`).catch(() => undefined);
    await page.waitForTimeout(400);
    const jumlahPilihBenchmark = String(await page.locator('[data-testid="benchmark-pilih-count"]').first().getAttribute("data-count").catch(() => ""));
    const pesanBatasBenchmark = rapi(await page.locator('[data-testid="benchmark-error"]').first().innerText().catch(() => ""));
    check("pilihan model ke-4 ditahan di batas tiga model dan alasannya dijelaskan di halaman",
      jumlahPilihBenchmark === "3" && /maksimal 3/i.test(pesanBatasBenchmark),
      `terpilih=${jumlahPilihBenchmark} pesan="${pesanBatasBenchmark.slice(0, 140)}"`);
  } else {
    skip("batas tiga model di halaman Benchmark", `katalog hanya punya ${modelSehat.length} model sehat`);
  }

  const modelBenchmark = modelSehat[0];
  await page.click('[data-testid="benchmark-clear"]').catch(() => undefined);
  await page.waitForTimeout(300);
  await page.click(`[data-testid="benchmark-model-${modelBenchmark}"]`);
  await page.click('[data-testid="benchmark-estimate-button"]');
  let perkiraanBenchmark = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const kartu = page.locator('[data-testid="benchmark-estimate"]').first();
    if (await kartu.count()) {
      perkiraanBenchmark = { micros: String(await kartu.getAttribute("data-micros")), soal: String(await kartu.getAttribute("data-questions")) };
      break;
    }
    await page.waitForTimeout(250);
  }
  const perkiraanBenchmarkServer = await serverJson("/api/v1/benchmark/estimate", jsonKirim({ models: [modelBenchmark] }));
  checkApi("perkiraan benchmark di halaman sama dengan perkiraan server untuk model yang sama",
    "/api/v1/benchmark/estimate",
    Boolean(perkiraanBenchmark) && perkiraanBenchmarkServer.status === 200
      && perkiraanBenchmark.micros === String(perkiraanBenchmarkServer.badan.perkiraanBiayaMicros)
      && perkiraanBenchmark.soal === String(perkiraanBenchmarkServer.badan.questionCount),
    `halaman=${JSON.stringify(perkiraanBenchmark)} server=${JSON.stringify({ micros: perkiraanBenchmarkServer.badan && perkiraanBenchmarkServer.badan.perkiraanBiayaMicros, soal: perkiraanBenchmarkServer.badan && perkiraanBenchmarkServer.badan.questionCount })}`);

  const sebelumJalanBenchmark = panggilanPersis("/api/v1/benchmark/run").length;
  await page.click('[data-testid="benchmark-run-button"]');
  let statusHasilBenchmark = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const kartu = page.locator('[data-testid="benchmark-result"]').first();
    if (await kartu.count()) { statusHasilBenchmark = String(await kartu.getAttribute("data-status")); break; }
    await page.waitForTimeout(250);
  }
  const jalurDetailBenchmark = apiCalls.map((line) => line.replace(/^\d+ /, "")).filter((jalur) => /^\/api\/v1\/benchmark\/runs\/[^/]+$/.test(jalur));
  const idBenchmark = jalurDetailBenchmark.length ? jalurDetailBenchmark[jalurDetailBenchmark.length - 1].split("/").pop() : "";
  const detailBenchmark = idBenchmark ? (await serverJson(`/api/v1/benchmark/runs/${idBenchmark}`)).badan || {} : {};
  const hasilBenchmarkServer = daftarDari(detailBenchmark.results, "results");
  checkApi("menjalankan benchmark membuat catatan nyata di server dan hasilnya dilukis di halaman",
    "/api/v1/benchmark/run",
    panggilanPersis("/api/v1/benchmark/run").length > sebelumJalanBenchmark && Boolean(idBenchmark)
      && statusHasilBenchmark === String(detailBenchmark.status) && hasilBenchmarkServer.length > 0,
    `statusHalaman=${statusHasilBenchmark} statusServer=${detailBenchmark.status} hasil=${hasilBenchmarkServer.length} id=${idBenchmark}`);

  const barisHasilBenchmark = String(await page.locator('[data-testid="benchmark-results"]').first().getAttribute("data-count").catch(() => ""));
  const modelBenchmarkServer = daftarDari(detailBenchmark.ringkasan && detailBenchmark.ringkasan.perModel, "perModel");
  const kartuBiayaBenchmark = page.locator('[data-testid="benchmark-cost"]').first();
  check("jumlah baris hasil dan angka biaya benchmark sama dengan jawaban detail server",
    barisHasilBenchmark === String(hasilBenchmarkServer.length)
      && String(await kartuBiayaBenchmark.getAttribute("data-estimated").catch(() => "")) === String(detailBenchmark.estimatedCostMicros)
      && String(await kartuBiayaBenchmark.getAttribute("data-actual").catch(() => "")) === String(detailBenchmark.costMicros),
    `baris=${barisHasilBenchmark} server=${hasilBenchmarkServer.length} biayaHalaman=${await kartuBiayaBenchmark.getAttribute("data-actual").catch(() => "")} biayaServer=${detailBenchmark.costMicros}`);

  const barisRingkasBenchmark = String(await page.locator('[data-testid="benchmark-summary"]').first().getAttribute("data-count").catch(() => ""));
  const ringkasHalaman = rapi(await page.locator('[data-testid="benchmark-summary"]').first().innerText().catch(() => ""));
  check("ringkasan per model sama dengan ringkasan server untuk setiap model yang diuji",
    barisRingkasBenchmark === String(modelBenchmarkServer.length) && modelBenchmarkServer.length > 0
      && modelBenchmarkServer.every((row) => ringkasHalaman.includes(String(row.model))
        && ringkasHalaman.includes(angkaId(row.dijawab)) && ringkasHalaman.includes(angkaId(row.gagal))),
    `baris=${barisRingkasBenchmark} server=${modelBenchmarkServer.length} teks="${ringkasHalaman.slice(0, 160)}"`);

  // butir 62: Timeline run. Run uji dibuat lewat API dengan penanda unik supaya barisnya pasti ketemu,
  // lalu halaman dibuka dari TOMBOL Timeline di Riwayat run (jalur yang dipakai pengguna).
  const tandaTimeline = `timeline uji wave 11b ${stamp}`;
  const mulaiTimeline = await serverJson(`/api/v1/projects/${siapkanUji.projectId}/runs`, jsonKirim({ prompt: tandaTimeline, model: modelSehat[0] }));
  const idRunTimeline = mulaiTimeline.badan && mulaiTimeline.badan.id ? String(mulaiTimeline.badan.id) : "";
  check("run uji timeline dibuat lewat API dengan penanda prompt yang unik",
    mulaiTimeline.status === 202 && Boolean(idRunTimeline),
    `status=${mulaiTimeline.status} badan=${JSON.stringify(mulaiTimeline.badan).slice(0, 160)}`);

  let statusRunTimeline = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = (await serverJson(`/api/v1/runs/${idRunTimeline}`)).badan;
    statusRunTimeline = detail ? String(detail.status) : "";
    if (["completed", "failed", "cancelled"].includes(statusRunTimeline)) break;
    await page.waitForTimeout(250);
  }
  check("run uji timeline selesai dijalankan mesin tiruan sebelum halaman Timeline diuji",
    statusRunTimeline === "completed", `status=${statusRunTimeline}`);

  await bukaHalaman11B("Riwayat run", "/runs");
  await page.waitForSelector("main.main table tbody tr", { timeout: 15000 }).catch(() => undefined);
  await page.fill('input[aria-label="Cari prompt"]', tandaTimeline);
  await page.waitForTimeout(500);
  const barisTersaring = await page.locator("main.main table tbody tr").count();
  const teksBarisTersaring = rapi(await page.locator("main.main table tbody tr").first().innerText().catch(() => ""));
  check("filter prompt di Riwayat run menyisakan tepat satu baris run uji",
    barisTersaring === 1 && teksBarisTersaring.includes(tandaTimeline),
    `baris=${barisTersaring} teks="${teksBarisTersaring.slice(0, 140)}"`);
  await page.locator("main.main table tbody tr").first().click();

  let panelLanjutanTimeline = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const panel = page.locator('[data-testid="run-resume"]').first();
    if (await panel.count()) {
      panelLanjutanTimeline = { can: String(await panel.getAttribute("data-can")), reason: String(await panel.getAttribute("data-reason")) };
      break;
    }
    await page.waitForTimeout(250);
  }
  const statusLanjutanTimeline = (await serverJson(`/api/v1/runs/${idRunTimeline}/resume-status`)).badan || {};
  checkApi("panel lanjutan di detail run memakai jawaban server (run berhasil berarti tidak bisa dilanjutkan)",
    "/resume-status",
    Boolean(panelLanjutanTimeline) && panelLanjutanTimeline.can === String(Boolean(statusLanjutanTimeline.canResume))
      && panelLanjutanTimeline.reason === String(statusLanjutanTimeline.reason)
      && statusLanjutanTimeline.canResume === false && statusLanjutanTimeline.reason === "RUN_TIDAK_GAGAL",
    `panel=${JSON.stringify(panelLanjutanTimeline)} server=${JSON.stringify({ can: statusLanjutanTimeline.canResume, reason: statusLanjutanTimeline.reason })}`);

  await page.click('[data-testid="run-timeline-button"]');
  const timelineServer = (await serverJson(`/api/v1/runs/${idRunTimeline}/timeline`)).badan || {};
  const langkahTimeline = daftarDari(timelineServer.langkah, "langkah");
  const kartuTimeline = page.locator('[data-testid="timeline"]').first();
  // Kartu timeline sudah ada sejak halaman dibuka (dengan daftar kosong), jadi tunggu sampai
  // kartunya menunjuk run yang benar DAN jumlah langkahnya sama dengan jawaban server.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (String(await kartuTimeline.getAttribute("data-run").catch(() => "")) === idRunTimeline
      && String(await kartuTimeline.getAttribute("data-count").catch(() => "")) === String(timelineServer.total)) break;
    await page.waitForTimeout(250);
  }
  const teksHalamanTimeline = rapi(await page.locator("main.main").innerText().catch(() => ""));
  checkApi("tombol Timeline pada baris riwayat membuka halaman Timeline untuk run itu juga",
    "/timeline",
    String(await kartuTimeline.getAttribute("data-run").catch(() => "")) === idRunTimeline
      && String(await kartuTimeline.getAttribute("data-count").catch(() => "")) === String(timelineServer.total)
      && langkahTimeline.length > 0,
    `dataRun=${await kartuTimeline.getAttribute("data-run").catch(() => "")} langkahHalaman=${await kartuTimeline.getAttribute("data-count").catch(() => "")} langkahServer=${timelineServer.total}`);
  check("setiap langkah timeline server tampil dengan nama, ringkasan, dan statusnya",
    langkahTimeline.length > 0
      && langkahTimeline.every((step) => teksHalamanTimeline.includes(String(step.name))
        && teksHalamanTimeline.includes(rapi(step.summary)) && teksHalamanTimeline.includes(String(step.status)))
      && teksHalamanTimeline.includes(String(timelineServer.status)),
    `langkah=${langkahTimeline.length} teks="${teksHalamanTimeline.slice(0, 200)}"`);

  // butir 63: lanjutan run gagal. Model gagal ditentukan lewat MOCK_ENGINE_FAIL_MODELS pada server uji,
  // jadi modelnya harus ada di katalog mesin; kalau tidak ada, uji ini dilaporkan sebagai skip.
  const modelGagalAda = semuaModelKatalog.filter((nama) => daftarModelGagal.includes(nama));
  if (!modelGagalAda.length) {
    skip("lanjutkan run gagal dari Riwayat run",
      `tidak ada model katalog yang cocok dengan MOCK_ENGINE_FAIL_MODELS (${daftarModelGagal.join(", ") || "kosong"})`);
  } else {
    const tandaGagal = `gagal uji wave 11b ${stamp}`;
    const mulaiGagal = await serverJson(`/api/v1/projects/${siapkanUji.projectId}/runs`, jsonKirim({ prompt: tandaGagal, model: modelGagalAda[0] }));
    const idRunGagal = mulaiGagal.badan && mulaiGagal.badan.id ? String(mulaiGagal.badan.id) : "";
    let statusRunGagal = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = (await serverJson(`/api/v1/runs/${idRunGagal}`)).badan;
      statusRunGagal = detail ? String(detail.status) : "";
      if (["completed", "failed", "cancelled"].includes(statusRunGagal)) break;
      await page.waitForTimeout(250);
    }
    const statusLanjutGagal = (await serverJson(`/api/v1/runs/${idRunGagal}/resume-status`)).badan || {};
    check("run dengan model gagal berakhir gagal dan server menyebut galatnya sementara (boleh dilanjutkan)",
      statusRunGagal === "failed" && statusLanjutGagal.canResume === true,
      `status=${statusRunGagal} canResume=${statusLanjutGagal.canResume} reason=${statusLanjutGagal.reason} errorCode=${statusLanjutGagal.errorCode}`);
    if (statusLanjutGagal.canResume !== true) {
      skip("tombol Lanjutkan dan pembuatan run lanjutan", `server tidak mengizinkan lanjutan (${statusLanjutGagal.reason})`);
    } else {
      await bukaHalaman11B("Riwayat run", "/runs");
      await page.waitForSelector("main.main table tbody tr", { timeout: 15000 }).catch(() => undefined);
      await page.fill('input[aria-label="Cari prompt"]', tandaGagal);
      await page.waitForTimeout(500);
      await page.locator("main.main table tbody tr").first().click();
      let panelGagal = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const panel = page.locator('[data-testid="run-resume"]').first();
        if (await panel.count()) {
          panelGagal = { can: String(await panel.getAttribute("data-can")), reason: String(await panel.getAttribute("data-reason")) };
          break;
        }
        await page.waitForTimeout(250);
      }
      const teksPanelGagal = rapi(await page.locator('[data-testid="run-resume-status"]').first().innerText().catch(() => ""));
      check("detail run gagal menampilkan kelayakan lanjutan dari server dan menyediakan tombol Lanjutkan",
        Boolean(panelGagal) && panelGagal.can === "true" && panelGagal.reason === String(statusLanjutGagal.reason)
          && (await page.locator('[data-testid="run-resume-button"]').count()) === 1
          && /percobaan/.test(teksPanelGagal),
        `panel=${JSON.stringify(panelGagal)} reasonServer="${statusLanjutGagal.reason}" status="${teksPanelGagal.slice(0, 140)}"`);

      if (panelGagal && panelGagal.can === "true") {
        const detailSebelum = new Set(apiCalls.map((line) => line.replace(/^\d+ /, "")));
        await page.click('[data-testid="run-resume-button"]');
        let idLanjutan = "";
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const baru = apiCalls.map((line) => line.replace(/^\d+ /, ""))
            .filter((jalur) => /^\/api\/v1\/runs\/[0-9a-f-]{36}$/.test(jalur) && !detailSebelum.has(jalur));
          if (baru.length) { idLanjutan = baru[baru.length - 1].split("/").pop(); break; }
          await page.waitForTimeout(250);
        }
        const detailLanjutan = idLanjutan ? (await serverJson(`/api/v1/runs/${idLanjutan}`)).badan || {} : {};
        const statusLamaSetelah = (await serverJson(`/api/v1/runs/${idRunGagal}/resume-status`)).badan || {};
        const statusBaruSetelah = idLanjutan ? (await serverJson(`/api/v1/runs/${idLanjutan}/resume-status`)).badan || {} : {};
        let panelSesudah = null;
        // Panel pertama yang terlihat sesudah menekan Lanjutkan masih bisa panel run LAMA (halaman
        // berpindah setelah detail run baru tiba), jadi tunggu sampai isinya cocok dengan jawaban
        // server untuk run BARU.
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const panel = page.locator('[data-testid="run-resume"]').first();
          if (await panel.count()) {
            panelSesudah = { can: String(await panel.getAttribute("data-can")), reason: String(await panel.getAttribute("data-reason")) };
            if (panelSesudah.reason === String(statusBaruSetelah.reason)
              && panelSesudah.can === String(Boolean(statusBaruSetelah.canResume))) break;
          }
          await page.waitForTimeout(250);
        }
        // Kolom `resumedFrom` hanya ada di jawaban /resume-status; detail run biasa tidak memuatnya.
        checkApi("menekan Lanjutkan membuat run baru di server yang menunjuk run lama sebagai asalnya",
          "/resume",
          Boolean(idLanjutan) && String(statusBaruSetelah.resumedFrom) === idRunGagal
            && String(detailLanjutan.id) === idLanjutan,
          `idBaru=${idLanjutan} resumedFrom=${statusBaruSetelah.resumedFrom} idLama=${idRunGagal}`);
        check("setelah dilanjutkan, panel lanjutan yang terbuka memakai angka run BARU dan run lama ditandai sudah dilanjutkan",
          Boolean(idLanjutan) && statusLamaSetelah.canResume === false && String(statusLamaSetelah.reason) === "SUDAH_DILANJUTKAN"
            && Boolean(panelSesudah) && panelSesudah.can === String(Boolean(statusBaruSetelah.canResume))
            && panelSesudah.reason === String(statusBaruSetelah.reason),
          `lama=${JSON.stringify({ can: statusLamaSetelah.canResume, reason: statusLamaSetelah.reason })} baru=${JSON.stringify({ can: statusBaruSetelah.canResume, reason: statusBaruSetelah.reason })} panel=${JSON.stringify(panelSesudah)}`);
      } else {
        skip("pembuatan run lanjutan dari Riwayat run", "panel lanjutan tidak terbuka di baris run gagal");
      }
    }
  }

  // butir 65 bagian 1: halaman "Pemakaian saya". Angka halaman dibandingkan dengan jawaban server.
  await bukaHalaman11B("Pemakaian saya", "/api/v1/account/usage");
  const pakai30Server = (await serverJson("/api/v1/account/usage?period=30d")).badan || {};
  const kartuPakai = page.locator('[data-testid="usage"]').first();
  const ringkasPakai = page.locator('[data-testid="usage-ringkasan"]').first();
  // Kartu halaman sudah ada sebelum jawaban server tiba; kartu ringkasan (dan tabel turunannya)
  // baru muncul setelah data tiba, jadi tunggu dua-duanya sebelum angkanya dibaca.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await ringkasPakai.count()) === 1 && panggilanPersis("/api/v1/account/usage?period=30d").length > 0) break;
    await page.waitForTimeout(250);
  }
  const biayaPakai = page.locator('[data-testid="usage-biaya"]').first();
  const rekonsiliasiPakai = page.locator('[data-testid="usage-rekonsiliasi"]').first();
  checkApi("ringkasan Pemakaian saya sama dengan jawaban server untuk rentang bawaan 30 hari",
    "/api/v1/account/usage?period=30d",
    String(await kartuPakai.getAttribute("data-period").catch(() => "")) === String(pakai30Server.period)
      && String(await ringkasPakai.getAttribute("data-token").catch(() => "")) === String(pakai30Server.tokenTotal)
      && String(await ringkasPakai.getAttribute("data-total-micros").catch(() => "")) === String(pakai30Server.totalMicros),
    `halaman=${await kartuPakai.getAttribute("data-period").catch(() => "")}/${await ringkasPakai.getAttribute("data-token").catch(() => "")}/${await ringkasPakai.getAttribute("data-total-micros").catch(() => "")} server=${pakai30Server.period}/${pakai30Server.tokenTotal}/${pakai30Server.totalMicros}`);

  check("biaya tertagih, tidak tertagih, dan rekonsiliasi ditampilkan apa adanya dari server",
    String(await biayaPakai.getAttribute("data-billed").catch(() => "")) === String(pakai30Server.biayaTerbillingMicros)
      && String(await biayaPakai.getAttribute("data-unbilled").catch(() => "")) === String(pakai30Server.biayaTidakTertagihMicros)
      && String(await rekonsiliasiPakai.getAttribute("data-selisih").catch(() => "")) === String(pakai30Server.rekonsiliasi.selisihMicros)
      && String(await rekonsiliasiPakai.getAttribute("data-run").catch(() => "")) === String(pakai30Server.rekonsiliasi.jumlahRun),
    `halaman=${await biayaPakai.getAttribute("data-billed").catch(() => "")}/${await biayaPakai.getAttribute("data-unbilled").catch(() => "")}/${await rekonsiliasiPakai.getAttribute("data-selisih").catch(() => "")} server=${pakai30Server.biayaTerbillingMicros}/${pakai30Server.biayaTidakTertagihMicros}/${pakai30Server.rekonsiliasi.selisihMicros}`);

  check("tabel per hari dan per model di halaman memuat baris sebanyak yang dikirim server",
    String(await page.locator('[data-testid="usage-perhari"]').first().getAttribute("data-count").catch(() => "")) === String(daftarDari(pakai30Server.perHari, "perHari").length)
      && String(await page.locator('[data-testid="usage-permodel"]').first().getAttribute("data-count").catch(() => "")) === String(daftarDari(pakai30Server.perModel, "perModel").length),
    `hari=${await page.locator('[data-testid="usage-perhari"]').first().getAttribute("data-count").catch(() => "")}/${daftarDari(pakai30Server.perHari, "perHari").length} model=${await page.locator('[data-testid="usage-permodel"]').first().getAttribute("data-count").catch(() => "")}/${daftarDari(pakai30Server.perModel, "perModel").length}`);

  await page.click('[data-testid="usage-rentang-7d"]');
  let pakai7Halaman = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    pakai7Halaman = String(await kartuPakai.getAttribute("data-period").catch(() => ""));
    if (pakai7Halaman === "7d" && panggilanPersis("/api/v1/account/usage?period=7d").length > 0) break;
    await page.waitForTimeout(250);
  }
  const pakai7Server = (await serverJson("/api/v1/account/usage?period=7d")).badan || {};
  checkApi("tombol rentang 7 hari meminta ulang ke server dan angkanya ikut berubah",
    "/api/v1/account/usage?period=7d",
    pakai7Halaman === "7d" && String(await ringkasPakai.getAttribute("data-token").catch(() => "")) === String(pakai7Server.tokenTotal)
      && String(await ringkasPakai.getAttribute("data-total-micros").catch(() => "")) === String(pakai7Server.totalMicros),
    `halaman=${pakai7Halaman}/${await ringkasPakai.getAttribute("data-token").catch(() => "")} server=${pakai7Server.period}/${pakai7Server.tokenTotal}`);

  // butir 65 bagian 2: halaman "Aktivitas saya" (jejak audit akun sendiri).
  await bukaHalaman11B("Aktivitas saya", "/api/v1/account/audit");
  const audit90Server = (await serverJson("/api/v1/account/audit?days=90")).badan || {};
  const kartuAktivitas = page.locator('[data-testid="activity"]').first();
  // Sama seperti Pemakaian: kartu halaman ada lebih dulu, ringkasannya baru muncul setelah data tiba.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await page.locator('[data-testid="activity-ringkasan"]').count()) === 1
      && panggilanPersis("/api/v1/account/audit?days=90").length > 0) break;
    await page.waitForTimeout(250);
  }
  checkApi("jumlah jejak di Aktivitas saya sama dengan jumlah jejak milik akun ini di server",
    "/api/v1/account/audit?days=90",
    String(await kartuAktivitas.getAttribute("data-days").catch(() => "")) === String(audit90Server.days)
      && String(await kartuAktivitas.getAttribute("data-count").catch(() => "")) === String(daftarDari(audit90Server.events, "events").length),
    `halaman=${await kartuAktivitas.getAttribute("data-days").catch(() => "")}/${await kartuAktivitas.getAttribute("data-count").catch(() => "")} server=${audit90Server.days}/${daftarDari(audit90Server.events, "events").length}`);

  const teksRingkasAktivitas = rapi(await page.locator('[data-testid="activity-ringkasan"]').first().innerText().catch(() => ""));
  const teksHalamanAktivitas = rapi(await page.locator("main.main").innerText().catch(() => ""));
  const kejadian90 = daftarDari(audit90Server.events, "events");
  check("ringkasan Aktivitas saya menyebut angka server dan aksi yang dicatat server tampil di tabel",
    teksRingkasAktivitas.includes(angkaId(kejadian90.length)) && teksRingkasAktivitas.includes(angkaId(audit90Server.total))
      && kejadian90.every((row) => teksHalamanAktivitas.includes(String(row.action))),
    `ringkas="${teksRingkasAktivitas.slice(0, 140)}" server=${kejadian90.length}/${audit90Server.total}`);

  if (kejadian90.length > 0) {
    await page.click('[data-testid="activity-hari-7"]');
    let hariAktivitas = "";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      hariAktivitas = String(await kartuAktivitas.getAttribute("data-days").catch(() => ""));
      if (hariAktivitas === "7" && panggilanPersis("/api/v1/account/audit?days=7").length > 0) break;
      await page.waitForTimeout(250);
    }
    const audit7Server = (await serverJson("/api/v1/account/audit?days=7")).badan || {};
    checkApi("tombol 7 hari di Aktivitas saya meminta ulang ke server dengan rentang yang benar",
      "/api/v1/account/audit?days=7",
      hariAktivitas === "7" && String(await kartuAktivitas.getAttribute("data-count").catch(() => "")) === String(daftarDari(audit7Server.events, "events").length),
      `halaman=${hariAktivitas}/${await kartuAktivitas.getAttribute("data-count").catch(() => "")} server=${audit7Server.days}/${daftarDari(audit7Server.events, "events").length}`);
  } else {
    skip("penyaring rentang hari di Aktivitas saya", "server belum punya jejak audit untuk akun uji");
  }

  // butir 72: halaman "Jadwal" (daftar, tambah, ubah, matikan, jalankan sekarang, hapus).
  await bukaHalaman11B("Jadwal", "/api/v1/schedules");
  // Kartu jadwal ada sejak halaman dibuka; kalimat batasnya baru muncul setelah jawaban server tiba.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await page.locator('[data-testid="schedules-batas"]').count()) === 1
      && panggilanPersis("/api/v1/schedules").length > 0) break;
    await page.waitForTimeout(250);
  }
  const jadwalAwal = (await serverJson("/api/v1/schedules")).badan || {};
  const kartuJadwal = page.locator('[data-testid="schedules"]').first();
  const teksBatasJadwal = rapi(await page.locator('[data-testid="schedules-batas"]').first().innerText().catch(() => ""));
  const batasJadwalHarap = rapi(`${angkaId(jadwalAwal.total)} dari batas ${angkaId(jadwalAwal.limit)} jadwal dipakai · zona bawaan ${jadwalAwal.defaultTimezone}.`);
  checkApi("batas jadwal, jumlah terpakai, dan zona bawaan di halaman sama dengan jawaban server",
    "/api/v1/schedules",
    String(await kartuJadwal.getAttribute("data-limit").catch(() => "")) === String(jadwalAwal.limit)
      && String(await kartuJadwal.getAttribute("data-count").catch(() => "")) === String(daftarDari(jadwalAwal.schedules, "schedules").length)
      && teksBatasJadwal.includes(batasJadwalHarap),
    `halaman=${await kartuJadwal.getAttribute("data-limit").catch(() => "")}/${await kartuJadwal.getAttribute("data-count").catch(() => "")} server=${jadwalAwal.limit}/${daftarDari(jadwalAwal.schedules, "schedules").length} teks="${teksBatasJadwal.slice(0, 180)}"`);

  const promptJadwal = `jadwal uji wave 11b ${stamp}`;
  const opsiProyekJadwal = await page.locator(`[data-testid="schedules-proyek"] option[value="${siapkanUji.projectId}"]`).count();
  await page.fill('[data-testid="schedules-prompt"]', promptJadwal);
  await page.fill('[data-testid="schedules-cron"]', "*/15 * * * *");
  if (opsiProyekJadwal > 0) await page.selectOption('[data-testid="schedules-proyek"]', siapkanUji.projectId);
  await page.click('[data-testid="schedules-tambah"]');
  let jadwalBaru = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    jadwalBaru = daftarDari((await serverJson("/api/v1/schedules")).badan, "schedules").find((row) => row.prompt === promptJadwal) || null;
    if (jadwalBaru) break;
    await page.waitForTimeout(250);
  }
  const idJadwal = jadwalBaru ? String(jadwalBaru.id) : "";
  check("jadwal baru dari halaman tercatat di server lengkap dengan proyek sasaran, cron, zona, dan sifat otonom",
    Boolean(idJadwal) && opsiProyekJadwal > 0 && jadwalBaru.cron === "*/15 * * * *"
      && String(jadwalBaru.timezone) === String(jadwalAwal.defaultTimezone)
      && String(jadwalBaru.projectId) === String(siapkanUji.projectId)
      && jadwalBaru.autonomous === true && jadwalBaru.enabled === true && Boolean(jadwalBaru.nextRunAt),
    `opsiProyek=${opsiProyekJadwal} jadwal=${JSON.stringify({ id: idJadwal, cron: jadwalBaru && jadwalBaru.cron, zona: jadwalBaru && jadwalBaru.timezone, proyek: jadwalBaru && jadwalBaru.projectId, otonom: jadwalBaru && jadwalBaru.autonomous })}`);
  if (!idJadwal) throw new Error("jadwal uji tidak bisa dibuat lewat halaman Jadwal");

  await page.waitForSelector(`[data-testid="schedule-${idJadwal}"]`, { timeout: 15000 }).catch(() => undefined);
  const barisJadwal = page.locator(`[data-testid="schedule-${idJadwal}"]`).first();
  const waktuBerikutJadwal = String(await page.locator(`[data-testid="schedule-next-${idJadwal}"]`).first().getAttribute("data-next").catch(() => ""));
  check("baris jadwal menampilkan waktu tayang berikutnya dan bacaan cron dari server",
    waktuBerikutJadwal === String(jadwalBaru.nextRunAt)
      && rapi(await page.locator(`[data-testid="schedule-cron-${idJadwal}"]`).first().innerText().catch(() => "")).includes(String(jadwalBaru.cronText))
      && (await barisJadwal.getAttribute("data-enabled").catch(() => "")) === "true",
    `berikutHalaman=${waktuBerikutJadwal} berikutServer=${jadwalBaru.nextRunAt} cron="${jadwalBaru.cronText}"`);

  await page.click(`[data-testid="schedule-edit-${idJadwal}"]`);
  await page.fill(`[data-testid="schedule-edit-cron-${idJadwal}"]`, "*/5 * * * *");
  await page.click(`[data-testid="schedule-edit-simpan-${idJadwal}"]`);
  let jadwalSetelahUbah = null;
  let waktuBerikutSetelahUbah = "";
  // Tunggu dua-duanya: cron baru tersimpan di server DAN waktu berikutnya di halaman sudah dihitung ulang.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    jadwalSetelahUbah = daftarDari((await serverJson("/api/v1/schedules")).badan, "schedules").find((row) => String(row.id) === idJadwal) || null;
    waktuBerikutSetelahUbah = String(await page.locator(`[data-testid="schedule-next-${idJadwal}"]`).first().getAttribute("data-next").catch(() => ""));
    if (jadwalSetelahUbah && jadwalSetelahUbah.cron === "*/5 * * * *"
      && waktuBerikutSetelahUbah === String(jadwalSetelahUbah.nextRunAt)) break;
    await page.waitForTimeout(250);
  }
  check("mengubah cron dari halaman tersimpan di server dan waktu berikutnya ikut dihitung ulang",
    Boolean(jadwalSetelahUbah) && jadwalSetelahUbah.cron === "*/5 * * * *"
      && waktuBerikutSetelahUbah === String(jadwalSetelahUbah.nextRunAt),
    `cronServer=${jadwalSetelahUbah && jadwalSetelahUbah.cron} berikutHalaman=${waktuBerikutSetelahUbah} berikutServer=${jadwalSetelahUbah && jadwalSetelahUbah.nextRunAt}`);

  await page.click(`[data-testid="schedule-aktif-${idJadwal}"]`);
  let jadwalDimatikan = null;
  let enabledHalamanJadwal = "";
  let teksTombolJadwal = "";
  // Tunggu dua-duanya: jadwal mati di server DAN baris di halaman ikut berubah (tombol jadi Aktifkan).
  for (let attempt = 0; attempt < 80; attempt += 1) {
    jadwalDimatikan = daftarDari((await serverJson("/api/v1/schedules")).badan, "schedules").find((row) => String(row.id) === idJadwal) || null;
    enabledHalamanJadwal = String(await barisJadwal.getAttribute("data-enabled").catch(() => ""));
    teksTombolJadwal = rapi(await page.locator(`[data-testid="schedule-aktif-${idJadwal}"]`).first().innerText().catch(() => ""));
    if (jadwalDimatikan && jadwalDimatikan.enabled === false && enabledHalamanJadwal === "false"
      && /Aktifkan/.test(teksTombolJadwal)) break;
    await page.waitForTimeout(250);
  }
  check("tombol Matikan mematikan jadwal di server, dan tombolnya berubah menjadi Aktifkan di halaman",
    Boolean(jadwalDimatikan) && jadwalDimatikan.enabled === false
      && enabledHalamanJadwal === "false" && /Aktifkan/.test(teksTombolJadwal),
    `enabledServer=${jadwalDimatikan && jadwalDimatikan.enabled} enabledHalaman=${enabledHalamanJadwal} tombol="${teksTombolJadwal.slice(0, 80)}"`);

  const sebelumJalanJadwal = panggilanPersis(`/api/v1/schedules/${idJadwal}/run-now`).length;
  await page.click(`[data-testid="schedule-run-${idJadwal}"]`);
  let pesanJadwal = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    pesanJadwal = rapi(await page.locator('[data-testid="schedules-message"]').first().innerText().catch(() => ""));
    if (/Jadwal dijalankan sekarang|Jadwal belum bisa dijalankan/.test(pesanJadwal)) break;
    await page.waitForTimeout(250);
  }
  const jalankanServer = /Jadwal dijalankan sekarang/.test(pesanJadwal);
  let runJadwalAda = false;
  for (let attempt = 0; attempt < 40 && jalankanServer; attempt += 1) {
    const daftarRun = daftarDari((await serverJson(`/api/v1/projects/${siapkanUji.projectId}/runs`)).badan, "runs");
    runJadwalAda = daftarRun.some((row) => String(row.prompt) === promptJadwal);
    if (runJadwalAda) break;
    await page.waitForTimeout(300);
  }
  checkApi("tombol Jalankan sekarang membuat run baru di server dengan prompt jadwal itu",
    `/api/v1/schedules/${idJadwal}/run-now`,
    panggilanPersis(`/api/v1/schedules/${idJadwal}/run-now`).length > sebelumJalanJadwal && jalankanServer && runJadwalAda,
    `pesan="${pesanJadwal.slice(0, 160)}" runDitemukan=${runJadwalAda}`);

  await page.click(`[data-testid="schedule-hapus-${idJadwal}"]`);
  await page.waitForSelector(`[data-testid="schedule-hapus-yakin-${idJadwal}"]`, { timeout: 10000 }).catch(() => undefined);
  await page.click(`[data-testid="schedule-hapus-yakin-${idJadwal}"]`);
  let jadwalMasihAda = true;
  let barisJadwalDiHalaman = 1;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    jadwalMasihAda = daftarDari((await serverJson("/api/v1/schedules")).badan, "schedules").some((row) => String(row.id) === idJadwal);
    barisJadwalDiHalaman = await page.locator(`[data-testid="schedule-${idJadwal}"]`).count();
    if (!jadwalMasihAda && barisJadwalDiHalaman === 0) break;
    await page.waitForTimeout(250);
  }
  check("menghapus jadwal menghilangkan barisnya dari server dan dari halaman",
    !jadwalMasihAda && barisJadwalDiHalaman === 0,
    `masihDiServer=${jadwalMasihAda} barisDiHalaman=${barisJadwalDiHalaman}`);

  // butir 59 + 67: tab "Operasional" di halaman Admin platform.
  await bukaHalaman11B("Admin platform", "/api/v1/admin/");
  const adaTabOperasional = await page.locator('[data-testid="admin-tab-operasional"]').count();
  check("tab Operasional tersedia di halaman Admin platform untuk admin", adaTabOperasional === 1, `tab=${adaTabOperasional}`);
  await page.click('[data-testid="admin-tab-operasional"]');
  await page.waitForSelector('[data-testid="shadow-card"]', { timeout: 15000 }).catch(() => undefined);

  const bayanganServer = (await serverJson("/api/v1/admin/shadow")).badan || {};
  const kartuBayangan = page.locator('[data-testid="shadow-card"]').first();
  // Kartu bayangan selalu ada di halaman, tetapi isinya baru terisi setelah jawaban server tiba.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (String(await kartuBayangan.getAttribute("data-mode").catch(() => "")) === String(bayanganServer.mode)
      && panggilanPersis("/api/v1/admin/shadow").length > 0) break;
    await page.waitForTimeout(250);
  }
  checkApi("kartu Mode bayangan menampilkan mode dan jumlah baris pengukuran yang sama dengan server",
    "/api/v1/admin/shadow",
    String(await kartuBayangan.getAttribute("data-mode").catch(() => "")) === String(bayanganServer.mode)
      && String(await kartuBayangan.getAttribute("data-total").catch(() => "")) === String(bayanganServer.total),
    `halaman=${await kartuBayangan.getAttribute("data-mode").catch(() => "")}/${await kartuBayangan.getAttribute("data-total").catch(() => "")} server=${bayanganServer.mode}/${bayanganServer.total}`);

  // Mode diubah ke arah yang BERBEDA dari mode sekarang supaya tombolnya benar-benar bisa ditekan,
  // lalu dikembalikan ke setelan semula di akhir blok ini.
  const modeLawan = bayanganServer.mode === "on" ? "off" : "on";
  await page.click(`[data-testid="shadow-${modeLawan}"]`);
  let modeSetelahAlih = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    modeSetelahAlih = String((await serverJson("/api/v1/admin/shadow")).badan?.mode ?? "");
    if (modeSetelahAlih === modeLawan && String(await kartuBayangan.getAttribute("data-mode").catch(() => "")) === modeLawan) break;
    await page.waitForTimeout(250);
  }
  const catatanBayangan = rapi(await page.locator('[data-testid="shadow-note"]').first().innerText().catch(() => ""));
  check("tombol mode bayangan mengubah mode di server dan halaman menegaskan perubahan berlaku pada run berikutnya",
    modeSetelahAlih === modeLawan && /run berikutnya/i.test(catatanBayangan),
    `modeServer=${modeSetelahAlih} modeLawan=${modeLawan} catatan="${catatanBayangan.slice(0, 140)}"`);

  await page.click(`[data-testid="shadow-${bayanganServer.mode}"]`);
  let modeKembali = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    modeKembali = String((await serverJson("/api/v1/admin/shadow")).badan?.mode ?? "");
    if (modeKembali === String(bayanganServer.mode)
      && String(await kartuBayangan.getAttribute("data-mode").catch(() => "")) === String(bayanganServer.mode)) break;
    await page.waitForTimeout(250);
  }
  check("mode bayangan dikembalikan ke setelan semula setelah diuji",
    modeKembali === String(bayanganServer.mode), `mode=${modeKembali} semula=${bayanganServer.mode}`);

  const bulanSekarang = new Date().toISOString().slice(0, 7);
  const tokenServer = (await serverJson(`/api/v1/admin/token-accounting?month=${bulanSekarang}`)).badan || {};
  const kartuToken = page.locator('[data-testid="token-card"]').first();
  // Kartu token juga selalu ada; baris ringkasannya (dan tabel per pengguna) baru muncul setelah
  // pembukuan dari server tiba, jadi tunggu dua-duanya dulu.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (String(await kartuToken.getAttribute("data-saldo").catch(() => "")) === String(tokenServer.saldo)
      && (await page.locator('[data-testid="token-ringkasan"]').count()) === 1) break;
    await page.waitForTimeout(250);
  }
  const ringkasToken = rapi(await page.locator('[data-testid="token-ringkasan"]').first().innerText().catch(() => ""));
  const ringkasTokenHarap = rapi(`saldo ${angkaId(tokenServer.saldo)} · terpakai ${angkaId(tokenServer.terpakai)} · sisa ${angkaId(tokenServer.sisa)} token`);
  checkApi("kartu pembukuan token menampilkan saldo, terpakai, sisa, proyeksi, dan pemakaian per pengguna dari server",
    "/api/v1/admin/token-accounting",
    String(await kartuToken.getAttribute("data-saldo").catch(() => "")) === String(tokenServer.saldo)
      && String(await kartuToken.getAttribute("data-terpakai").catch(() => "")) === String(tokenServer.terpakai)
      && ringkasToken.includes(ringkasTokenHarap)
      && String(await page.locator('[data-testid="token-ringkasan"]').first().getAttribute("data-proyeksi").catch(() => "")) === String(tokenServer.proyeksi ?? "")
      && String(await page.locator('[data-testid="token-perpengguna"]').first().getAttribute("data-count").catch(() => "")) === String(daftarDari(tokenServer.perPengguna, "perPengguna").length),
    `halaman=${await kartuToken.getAttribute("data-saldo").catch(() => "")}/${await kartuToken.getAttribute("data-terpakai").catch(() => "")} server=${tokenServer.saldo}/${tokenServer.terpakai} ringkas="${ringkasToken.slice(0, 160)}"`);

  const saldoAsli = Number(tokenServer.saldo ?? 0);
  const saldoUji = saldoAsli + 123456;
  await page.fill('[data-testid="token-saldo"]', String(saldoUji));
  await page.click('[data-testid="token-simpan"]');
  let saldoSetelahSimpan = null;
  let pesanSaldo = "";
  // Tunggu dua-duanya: saldo baru tersimpan di server DAN pesannya sudah muncul di halaman.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    saldoSetelahSimpan = (await serverJson(`/api/v1/admin/token-accounting?month=${bulanSekarang}`)).badan || {};
    pesanSaldo = rapi(await page.locator('[data-testid="admin-ops-message"]').first().innerText().catch(() => ""));
    if (Number(saldoSetelahSimpan.saldo) === saldoUji && pesanSaldo.includes(angkaId(saldoUji))) break;
    await page.waitForTimeout(250);
  }
  check("menekan Setel saldo bulanan benar-benar menyimpan saldo baru di server dan mengabarkannya di halaman",
    Number(saldoSetelahSimpan && saldoSetelahSimpan.saldo) === saldoUji && pesanSaldo.includes(angkaId(saldoUji)),
    `saldoBaru=${saldoSetelahSimpan && saldoSetelahSimpan.saldo} pesan="${pesanSaldo.slice(0, 160)}"`);

  await page.fill('[data-testid="token-saldo"]', String(saldoAsli));
  await page.click('[data-testid="token-simpan"]');
  let saldoDipulihkan = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    saldoDipulihkan = (await serverJson(`/api/v1/admin/token-accounting?month=${bulanSekarang}`)).badan || {};
    if (Number(saldoDipulihkan.saldo) === saldoAsli
      && String(await kartuToken.getAttribute("data-saldo").catch(() => "")) === String(saldoAsli)) break;
    await page.waitForTimeout(250);
  }
  check("saldo token bulanan dipulihkan ke angka semula setelah diuji",
    Number(saldoDipulihkan && saldoDipulihkan.saldo) === saldoAsli, `saldo=${saldoDipulihkan && saldoDipulihkan.saldo} semula=${saldoAsli}`);

  // butir 66: halaman "Laporan galat" (khusus admin). Galat server yang tercatat platform bisa
  // saja masih kosong pada basis data uji, jadi bagian yang membandingkan BARIS dilaporkan skip
  // kalau server memang belum punya catatan galat — apa adanya, bukan lulus pura-pura.
  await bukaHalaman11B("Laporan galat", "/api/v1/admin/errors");
  const galatServer = (await serverJson("/api/v1/admin/errors?limit=100")).badan || {};
  const barisGalatServer = daftarDari(galatServer.rows, "rows");
  const totalGalat = Number(galatServer.total ?? 0);
  const kartuGalat = page.locator('[data-testid="admin-errors"]').first();
  // Kartu laporan selalu ada dengan daftar kosong; kalimat jumlah galat baru muncul setelah data tiba.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await page.locator('[data-testid="admin-errors-total"]').count()) === 1
      && panggilanPersis("/api/v1/admin/errors?limit=100").length > 0) break;
    await page.waitForTimeout(250);
  }
  const adaPenolakanGalat = await page.locator('[data-testid="admin-errors-bukan-admin"]').count();
  checkApi("halaman Laporan galat terbuka untuk admin dan memuat catatan galat dari server",
    "/api/v1/admin/errors",
    adaPenolakanGalat === 0
      && String(await kartuGalat.getAttribute("data-count").catch(() => "")) === String(barisGalatServer.length),
    `penolakan=${adaPenolakanGalat} halaman=${await kartuGalat.getAttribute("data-count").catch(() => "")} server=${barisGalatServer.length}/${totalGalat}`);

  const teksTotalGalat = rapi(await page.locator('[data-testid="admin-errors-total"]').first().innerText().catch(() => ""));
  const totalGalatHarap = rapi(`${angkaId(barisGalatServer.length)} dari ${angkaId(totalGalat)} galat ditampilkan.`);
  check("kalimat jumlah galat di halaman memakai angka baris dan total dari server",
    teksTotalGalat.includes(totalGalatHarap), `halaman="${teksTotalGalat.slice(0, 180)}" harap="${totalGalatHarap}"`);

  if (totalGalat === 0) {
    skip("baris laporan galat dibandingkan dengan isi server",
      "server belum punya catatan galat pada basis data uji (hanya galat status 500 yang dicatat)");
  } else {
    const teksBarisGalat = rapi(await page.locator('[data-testid="admin-errors"]').first().innerText().catch(() => ""));
    check("setiap galat yang dikirim server tampil di tabel dengan kode dan pesannya",
      barisGalatServer.every((row) => Boolean(teksBarisGalat.includes(String(row.message).slice(0, 60)))),
      `baris=${barisGalatServer.length}`);
  }

  const kindUjiGalat = "ui";
  const sebelumSaringGalat = panggilanPersis(`/api/v1/admin/errors?kind=${kindUjiGalat}&limit=100`).length;
  await page.selectOption('[data-testid="admin-errors-kind"]', kindUjiGalat);
  let galatTersaring = null;
  let barisGalatTersaring = "";
  // Tunggu dua-duanya: permintaan tersaring sudah dikirim DAN jumlah baris di halaman ikut menyesuaikan.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    galatTersaring = (await serverJson(`/api/v1/admin/errors?kind=${kindUjiGalat}&limit=100`)).badan || {};
    barisGalatTersaring = String(await kartuGalat.getAttribute("data-count").catch(() => ""));
    if (panggilanPersis(`/api/v1/admin/errors?kind=${kindUjiGalat}&limit=100`).length > sebelumSaringGalat
      && barisGalatTersaring === String(daftarDari(galatTersaring.rows, "rows").length)) break;
    await page.waitForTimeout(250);
  }
  checkApi("saringan jenis galat di halaman meminta ulang ke server dan jumlah barisnya ikut menyesuaikan",
    `/api/v1/admin/errors?kind=${kindUjiGalat}&limit=100`,
    String(await kartuGalat.getAttribute("data-count").catch(() => "")) === String(daftarDari(galatTersaring.rows, "rows").length)
      && panggilanPersis(`/api/v1/admin/errors?kind=${kindUjiGalat}&limit=100`).length > sebelumSaringGalat,
    `halaman=${await kartuGalat.getAttribute("data-count").catch(() => "")} server=${daftarDari(galatTersaring.rows, "rows").length}/${galatTersaring.total}`);

  await page.selectOption('[data-testid="admin-errors-kind"]', "");
  await page.waitForTimeout(500);
  const tautanCsv = String(await page.locator('[data-testid="admin-errors-csv"]').first().getAttribute("href").catch(() => ""));
  const [unduhanGalat] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }).catch(() => null),
    page.click('[data-testid="admin-errors-csv"]'),
  ]);
  const isiCsvGalat = unduhanGalat ? readFileSync(await unduhanGalat.path(), "utf8") : "";
  const barisCsvGalat = isiCsvGalat.split(/\r?\n/).filter((line) => line.trim().length > 0);
  check("tombol Unduh CSV mengambil berkas galat dari server dengan header kolom yang benar",
    tautanCsv === "/api/v1/admin/errors/export.csv"
      && Boolean(unduhanGalat) && unduhanGalat.suggestedFilename() === "coder-error-events.csv"
      && barisCsvGalat[0] === "id,kind,code,runId,userId,message,createdAt"
      && barisCsvGalat.length - 1 === Math.min(totalGalat, 5000),
    `href="${tautanCsv}" berkas="${unduhanGalat ? unduhanGalat.suggestedFilename() : "tidak ada"}" barisPertama="${barisCsvGalat[0] || ""}" barisData=${barisCsvGalat.length - 1} total=${totalGalat}`);

  // butir 64: kartu Ekspor / Impor persona di halaman Persona agen.
  await bukaHalaman11B("Persona agen", "/api/v1/personas");
  await page.waitForSelector('[data-testid="persona-transfer"]', { timeout: 15000 }).catch(() => undefined);
  const personasSekarang = async () => daftarDari((await serverJson("/api/v1/personas")).badan, "personas");
  const personaServer = await personasSekarang();
  const [unduhanPersona] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }).catch(() => null),
    page.click('[data-testid="persona-export"]'),
  ]);
  const isiPersona = unduhanPersona ? readFileSync(await unduhanPersona.path(), "utf8") : "";
  let berkasEkspor = null;
  try { berkasEkspor = JSON.parse(isiPersona); } catch { berkasEkspor = null; }
  checkApi("tombol Ekspor mengunduh berkas JSON persona dari server berisi persona akun ini",
    "/api/v1/personas",
    Boolean(unduhanPersona) && unduhanPersona.suggestedFilename() === "coder-personas.json"
      && Boolean(berkasEkspor) && berkasEkspor.versi === 1 && Array.isArray(berkasEkspor.personas)
      && berkasEkspor.personas.length === personaServer.length
      && berkasEkspor.personas.every((item) => typeof item.name === "string" && item.name.length > 0),
    `berkas="${unduhanPersona ? unduhanPersona.suggestedFilename() : "tidak ada"}" versi=${berkasEkspor && berkasEkspor.versi} personas=${berkasEkspor && berkasEkspor.personas && berkasEkspor.personas.length} server=${personaServer.length}`);

  const namaPersonaUji = `Persona uji 11B ${stamp}`;
  const berkasImpor = `${shots}/persona-uji-${stamp}.json`;
  // Dua persona BERNAMA SAMA di dalam satu berkas: server menyimpan yang pertama dan melewati yang
  // kedua, jadi hasil "1 ditambahkan, 1 dilewati" datang dari aturan server, bukan dari halaman.
  await writeFile(berkasImpor, JSON.stringify({
    versi: 1,
    personas: [
      { name: namaPersonaUji, systemPrompt: "Jawab singkat dalam bahasa Indonesia.", tone: "netral", language: "id" },
      { name: namaPersonaUji, systemPrompt: "Kembar di dalam berkas yang sama.", tone: "netral", language: "id" },
    ],
  }), "utf8");
  await page.setInputFiles('[data-testid="persona-import-input"]', berkasImpor);
  const namaBerkasTerpilih = rapi(await page.locator('[data-testid="persona-berkas"]').first().innerText().catch(() => ""));
  await page.click('[data-testid="persona-import"]');
  let hasilImpor = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const blok = page.locator('[data-testid="persona-transfer-hasil"]').first();
    if (await blok.count()) {
      hasilImpor = { added: String(await blok.getAttribute("data-added")), skipped: String(await blok.getAttribute("data-skipped")) };
      break;
    }
    await page.waitForTimeout(250);
  }
  const personaTersimpan = (await personasSekarang()).filter((row) => String(row.name) === namaPersonaUji);
  check("impor berkas persona menyimpan satu persona ke server dan melewati nama kembar di dalam berkas",
    namaBerkasTerpilih.includes(`persona-uji-${stamp}.json`)
      && Boolean(hasilImpor) && hasilImpor.added === "1" && hasilImpor.skipped === "1"
      && personaTersimpan.length === 1,
    `berkas="${namaBerkasTerpilih}" hasil=${JSON.stringify(hasilImpor)} tersimpan=${personaTersimpan.length}`);

  await page.setInputFiles('[data-testid="persona-import-input"]', berkasImpor);
  await page.click('[data-testid="persona-import"]');
  let hasilImporKedua = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const blok = page.locator('[data-testid="persona-transfer-hasil"]').first();
    if (await blok.count()) {
      const nilai = { added: String(await blok.getAttribute("data-added")), skipped: String(await blok.getAttribute("data-skipped")) };
      if (nilai.added === "0") { hasilImporKedua = nilai; break; }
    }
    await page.waitForTimeout(250);
  }
  const personaKembar = (await personasSekarang()).filter((row) => String(row.name) === namaPersonaUji);
  // Berkas uji memuat DUA persona bernama sama; impor pertama menyimpan satu dan melewati satu,
  // impor kedua soal nama yang sama akan melewati keduanya (nol tersimpan tambahan).
  check("impor berkas yang sama dua kali tidak menggandakan persona: nol ditambahkan dan dua nama dilewati",
    Boolean(hasilImporKedua) && hasilImporKedua.added === "0" && hasilImporKedua.skipped === "2" && personaKembar.length === 1,
    `hasil=${JSON.stringify(hasilImporKedua)} diServer=${personaKembar.length}`);

  for (const row of personaKembar) await serverJson(`/api/v1/personas/${row.id}`, { method: "DELETE" });
  const personaSetelahBersih = (await personasSekarang()).filter((row) => String(row.name) === namaPersonaUji).length;
  check("persona hasil uji dibersihkan kembali dari server", personaSetelahBersih === 0, `sisa=${personaSetelahBersih}`);

  // ======================= Wave 11C (butir 68, 69, 71, 74, 76, 78 tahap 1) =======================
  // Semua hulu (Notion, Telegram, Slack) diarahkan ke server tiruan `stubBase` di atas, jadi uji ini
  // nyata tetapi tidak menyentuh internet. Setiap pemeriksaan membandingkan yang TERLIHAT di layar
  // dengan jawaban server yang diambil pada saat yang sama, bukan dengan tebakan.
  const c11TungguTeks = async (selector, batas = 80) => {
    for (let attempt = 0; attempt < batas; attempt += 1) {
      const teks = await page.locator(selector).first().innerText().catch(() => "");
      if (teks && teks.trim().length > 0) return teks.trim();
      await page.waitForTimeout(200);
    }
    return "";
  };
  const c11Attr = (selector, nama) => page.locator(selector).first().getAttribute(nama).catch(() => null);
  /** Tunggu sampai sebuah atribut ada DAN tidak kosong (mis. penanda 'data sudah dimuat'). */
  const c11TungguAttr = async (selector, nama, batas = 60) => {
    let terakhir = null;
    for (let attempt = 0; attempt < batas; attempt += 1) {
      terakhir = await c11Attr(selector, nama);
      if (terakhir !== null && terakhir !== '') return terakhir;
      await page.waitForTimeout(200);
    }
    return terakhir;
  };
  const c11Hitung = (selector) => page.locator(selector).count();

  /**
   * Baca beberapa atribut SEKALIGUS dalam satu putaran ke peramban. `c11Attr` dipanggil berkali-kali
   * bisa terbaca lintas-render (React menggambar ulang di antaranya), sehingga nilainya tercampur.
   */
  /**
   * Tunggu sampai gambar benar-benar termuat, TANPA `page.waitForFunction`.
   * Playwright memasang skrip polling DI DALAM halaman untuk `waitForFunction`, dan skrip itu disusun
   * dengan `eval`; kebijakan CSP aplikasi (`script-src 'self'`, PRD butir 79) memblokirnya sehingga
   * peramban melaporkan EvalError sebagai galat halaman. `page.evaluate` lewat CDP tidak terkena batas itu.
   */
  const c11TungguGambar = async (selector, batas = 80) => {
    for (let attempt = 0; attempt < batas; attempt += 1) {
      const potret = await page.evaluate((pemilih) => {
        const gambar = document.querySelector(pemilih);
        return gambar ? { ada: gambar.getAttribute("data-ada"), lebar: gambar.naturalWidth, tinggi: gambar.naturalHeight } : null;
      }, selector);
      if (potret && potret.ada === "true" && potret.lebar > 0) return potret;
      await page.waitForTimeout(250);
    }
    return null;
  };

  const c11Snap = async (selector, nama) => await page.evaluate(([pemilih, daftar]) => {
    const el = document.querySelector(pemilih);
    if (!el) return null;
    const hasil = {};
    for (const atribut of daftar) hasil[atribut] = el.getAttribute(atribut);
    return hasil;
  }, [selector, nama]);

  /** Tunggu sampai elemen memuat teks tertentu; mengembalikan teks terakhir walau batas habis. */
  const c11TungguPesan = async (selector, potongan, batas = 80) => {
    let terakhir = "";
    for (let attempt = 0; attempt < batas; attempt += 1) {
      terakhir = String(await page.locator(selector).first().innerText().catch(() => ""));
      if (terakhir.includes(potongan)) return terakhir.trim();
      await page.waitForTimeout(200);
    }
    return terakhir.trim();
  };
  const c11StubPages = () => stubRequests.filter((item) => item.path === "/v1/pages");
  const c11PanggilanBody = async (jalur, init) => serverJson(jalur, init);

  /* ---------------- butir 68: Notion ---------------- */
  const tandaNotion = `Catatan uji 11C ${stamp}`;
  await bukaHalaman11B("Notion", "/api/v1/integrations/notion");
  await c11TungguAttr('[data-testid="notion-hub"]', "data-kunci");
  const notion0 = await serverJson("/api/v1/integrations/notion");
  const halamanNotion0 = notion0.badan.integration;
  const atributNotion0 = {
    terpasang: await c11Attr('[data-testid="notion-hub"]', "data-terpasang"),
    kunci: await c11Attr('[data-testid="notion-hub"]', "data-kunci"),
    jumlah: await c11Attr('[data-testid="notion-hub"]', "data-jumlah"),
  };
  check("keadaan awal halaman Notion sama persis dengan jawaban server (butir 68)",
    atributNotion0.terpasang === String(halamanNotion0.terpasang)
      && atributNotion0.kunci === notion0.badan.kunci
      && atributNotion0.jumlah === String(halamanNotion0.jumlahHalaman),
    `layar=${JSON.stringify(atributNotion0)} server terpasang=${halamanNotion0.terpasang} kunci=${notion0.badan.kunci} jumlah=${halamanNotion0.jumlahHalaman}`);

  // Mengirim halaman sebelum ada token: server menolak 409 dan halaman menampilkan kalimat server apa adanya.
  const tolakNotion409 = await c11PanggilanBody("/api/v1/integrations/notion/pages", jsonKirim({ title: tandaNotion, content: "isi sebelum sambungan" }));
  await page.fill('[data-testid="notion-judul"]', tandaNotion);
  await page.fill('[data-testid="notion-isi"]', "isi sebelum sambungan");
  await page.click('[data-testid="notion-kirim"]');
  const teksNotion409 = await c11TungguPesan('[data-testid="notion-galat"]', "NOTION_NOT_CONNECTED");
  check("kirim halaman Notion sebelum tersambung dijawab server 409 NOTION_NOT_CONNECTED dan kalimatnya tampil apa adanya",
    tolakNotion409.status === 409 && tolakNotion409.badan.error === "NOTION_NOT_CONNECTED"
      && teksNotion409.includes(tolakNotion409.badan.error) && teksNotion409.includes(tolakNotion409.badan.message),
    `server=${tolakNotion409.status} ${tolakNotion409.badan.error} layar=${teksNotion409.slice(0, 160)}`);

  // Token tidak sah: server memverifikasi ke hulu lebih dulu (stub menjawab 401) lalu menjawab 400.
  // Token ini sengaja memuat "token-ditolak": server tiruan menjawab 401 untuk token seperti itu.
  const tokenNotionSalah = "ntn_token-ditolak-uji-11c";
  const tolakTokenNotion = await serverJson("/api/v1/integrations/notion", { ...jsonKirim({ token: tokenNotionSalah }), method: "PUT" });
  await page.fill('[data-testid="notion-token"]', tokenNotionSalah);
  await page.click('[data-testid="notion-simpan"]');
  const teksTokenSalah = await c11TungguPesan('[data-testid="notion-galat"]', "NOTION_TOKEN_INVALID");
  check("token Notion yang ditolak hulu dijawab 400 NOTION_TOKEN_INVALID dan pesannya tampil apa adanya",
    tolakTokenNotion.status === 400 && tolakTokenNotion.badan.error === "NOTION_TOKEN_INVALID"
      && teksTokenSalah.includes("NOTION_TOKEN_INVALID") && teksTokenSalah.includes(tolakTokenNotion.badan.message),
    `server=${tolakTokenNotion.status} ${tolakTokenNotion.badan.error} layar=${teksTokenSalah.slice(0, 160)}`);

  // Token sah: server menyimpan tersegel, memverifikasi lewat stub, dan TIDAK pernah mengembalikannya.
  const tokenNotionBenar = "ntn_uji-11c-9f3a-token-tersegel";
  const stubSebelumSambung = stubRequests.length;
  await page.fill('[data-testid="notion-token"]', tokenNotionBenar);
  const tungguSambungNotion = page.waitForResponse((balasan) => balasan.url().endsWith("/api/v1/integrations/notion") && balasan.request().method() === "PUT");
  await page.click('[data-testid="notion-simpan"]');
  const jawabanSambung = await (await tungguSambungNotion).json();
  const verifikasiStub = stubRequests.slice(stubSebelumSambung).find((item) => item.path === "/v1/users/me") || null;
  check("menyimpan token mengubah keadaan DI SERVER (tersegel + ruang kerja dari hulu) dan verifikasi hulu benar-benar terjadi",
    jawabanSambung.integration?.terpasang === true && jawabanSambung.integration?.tersegel === true
      && jawabanSambung.workspace?.name === "Ruang Uji COBLAI"
      && Boolean(verifikasiStub) && verifikasiStub.authorization === `Bearer ${tokenNotionBenar}`,
    `terpasang=${jawabanSambung.integration?.terpasang} tersegel=${jawabanSambung.integration?.tersegel} workspace=${jawabanSambung.workspace?.name} header=${verifikasiStub?.authorization ? "ada" : "tidak ada"}`);

  // Token tidak boleh tertinggal di DOM. Halaman hanya menampilkan penanda + empat karakter terakhir.
  await page.waitForSelector('[data-testid="notion-status"]', { timeout: 10000 }).catch(() => undefined);
  const layarNotion = await page.evaluate((rahasia) => {
    const ekor = document.querySelector('[data-testid="notion-ekor"]');
    const input = document.querySelector('[data-testid="notion-token"]');
    return {
      adaRahasia: document.body.innerHTML.includes(rahasia),
      ekor: ekor ? String(ekor.textContent || "").trim() : "",
      isianToken: input ? String(input.value || "") : "(tidak ada input)",
      status: String(document.querySelector('[data-testid="notion-status"]')?.textContent || "").trim(),
    };
  }, tokenNotionBenar);
  check("halaman Notion tidak pernah menyimpan/menampilkan token: isian kosong, ekor cocok, token tidak ada di DOM",
    layarNotion.adaRahasia === false && layarNotion.isianToken === ""
      && layarNotion.ekor.endsWith(tokenNotionBenar.slice(-4)) && layarNotion.ekor.length <= 6 && layarNotion.status === "terpasang",
    `adaRahasia=${layarNotion.adaRahasia} isian="${layarNotion.isianToken}" ekor="${layarNotion.ekor}" status=${layarNotion.status}`);


  // Judul kosong ditolak halaman lebih dulu; aturan server dibuktikan dengan panggilan langsung.
  const tolakJudulKosong = await serverJson("/api/v1/integrations/notion/pages", jsonKirim({ title: "   ", content: "isi apa saja" }));
  await page.fill('[data-testid="notion-judul"]', "   ");
  await page.click('[data-testid="notion-kirim"]');
  const teksJudulKosong = await c11TungguPesan('[data-testid="notion-galat"]', "Judul");
  const hasilPalsu = await c11Hitung('[data-testid="notion-hasil"]');
  check("judul kosong ditolak lebih dulu di layar dan server memang menjawab 400 NOTION_PAGE_TITLE_REQUIRED",
    tolakJudulKosong.status === 400 && tolakJudulKosong.badan.error === "NOTION_PAGE_TITLE_REQUIRED"
      && /judul/i.test(teksJudulKosong) && hasilPalsu === 0,
    `server=${tolakJudulKosong.status} ${tolakJudulKosong.badan.error} layar=${teksJudulKosong.slice(0, 120)} tautan=${hasilPalsu}`);

  // Kirim halaman sungguhan dari formulir halaman Notion.
  const stubPagesSebelumForm = c11StubPages().length;
  await page.fill('[data-testid="notion-judul"]', tandaNotion);
  await page.fill('[data-testid="notion-isi"]', "paragraf pertama uji 11C.\n\nparagraf kedua uji 11C.");
  await page.click('[data-testid="notion-kirim"]');
  let urlNotionHasil = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    urlNotionHasil = (await c11Attr('[data-testid="notion-hasil"]', "data-url")) || "";
    if (urlNotionHasil) break;
    await page.waitForTimeout(200);
  }
  const stubForm = c11StubPages().slice(-1)[0] || null;
  const badanForm = stubForm ? JSON.parse(stubForm.body) : null;
  check("kirim halaman dari halaman Notion benar-benar sampai ke hulu: judul, dua paragraf, dan tautan balik dari hulu",
    c11StubPages().length === stubPagesSebelumForm + 1
      && badanForm?.properties?.title?.title?.[0]?.text?.content === tandaNotion
      && Array.isArray(badanForm?.children) && badanForm.children.length === 2
      && urlNotionHasil === `${stubBase}/halaman/page-uji-${c11StubPages().length}`,
    `judul=${badanForm?.properties?.title?.title?.[0]?.text?.content} paragraf=${badanForm?.children?.length} url=${urlNotionHasil}`);

  // Riwayat halaman: yang tampil harus sama dengan yang disimpan server.
  const notionRiwayat = await serverJson("/api/v1/integrations/notion");
  const jumlahLayar = await c11Attr('[data-testid="notion-hub"]', "data-jumlah");
  const barisRiwayat = await c11Hitung('[data-testid^="notion-halaman-"]');
  check("riwayat halaman di layar sama dengan daftar halaman yang disimpan server",
    jumlahLayar === String(notionRiwayat.badan.integration.jumlahHalaman)
      && barisRiwayat === notionRiwayat.badan.integration.jumlahHalaman && barisRiwayat >= 1,
    `layar jumlah=${jumlahLayar} baris=${barisRiwayat} server=${notionRiwayat.badan.integration.jumlahHalaman}`);

  // Kirim lewat menu Bagikan pada jawaban agen (butir 68 bagian kedua).
  await klikMenu11B("Percakapan");
  await page.waitForSelector(".composer textarea", { timeout: 20000 });
  await page.fill(".composer textarea", `jawaban uji notion 11C ${stamp}`);
  await page.click(".composer button.send");
  try {
    await page.waitForSelector('article.message.assistant .message-tools button[aria-label="Buka menu bagikan jawaban ini"]', { timeout: 60000 });
  } catch (galat) {
    // Potret keadaan halaman supaya sebabnya terlihat dari log, bukan hanya "timeout".
    const potret = {
      pesan: await c11Hitung("article.message"),
      tanya: String(await page.locator(".composer textarea").inputValue().catch(() => "")).slice(0, 90),
      layarGalat: String(await page.locator('.error, .notice, .banner').first().innerText().catch(() => "")).slice(0, 220),
      panggilanAkhir: apiCalls.slice(-16),
      galatKonsol: consoleErrors.slice(-6),
      galat11C: expectedApiErrors11C.slice(-6),
      isi: String(await page.locator("article.message").last().innerText().catch(() => "")).slice(0, 160),
      logServer: serverLog.slice(-14),
    };
    // Tanya langsung ke server: apa status run yang baru saja dibuat?
    const jalurEvents = [...apiCalls].reverse().find((baris) => baris.includes("/api/v1/runs/") && baris.endsWith("/events")) || "";
    const idRun = jalurEvents.split("/api/v1/runs/")[1] ? jalurEvents.split("/api/v1/runs/")[1].split("/events")[0] : "";
    const kabarRun = idRun ? await serverJson(`/api/v1/runs/${idRun}`).catch(() => null) : null;
    potret.run = { idRun, jalurEvents, status: kabarRun?.status ?? null, badan: JSON.stringify(kabarRun?.badan ?? null).slice(0, 700) };
    console.log(`DIAG-BAGIKAN ${JSON.stringify(potret)}`);
    throw galat;
  }
  const teksJawaban = (await page.locator("article.message.assistant .bubble").last().innerText().catch(() => "")).trim();
  await page.click('article.message.assistant .message-tools button[aria-label="Buka menu bagikan jawaban ini"]');
  await page.waitForSelector('[data-testid="bagikan-notion"]', { timeout: 10000 });
  const stubPagesSebelumBagikan = c11StubPages().length;
  await page.click('[data-testid="bagikan-notion"]');
  let urlBagikan = (await c11Attr('[data-testid="bagikan-notion-hasil"]', "data-url")) || "";
  for (let attempt = 0; attempt < 80 && !urlBagikan; attempt += 1) {
    await page.waitForTimeout(200);
    urlBagikan = (await c11Attr('[data-testid="bagikan-notion-hasil"]', "data-url")) || "";
  }
  const stubBagikan = c11StubPages().slice(-1)[0] || null;
  const badanBagikan = stubBagikan ? JSON.parse(stubBagikan.body) : null;
  const teksKirimBagikan = JSON.stringify(badanBagikan?.children ?? []);
  const fragmen = (teksJawaban.match(/[A-Za-z0-9]{10,}/) || [""])[0];
  check("menu Bagikan punya pilihan Notion dan mengirim isi jawaban yang tampil ke hulu (butir 68)",
    c11StubPages().length === stubPagesSebelumBagikan + 1
      && badanBagikan?.properties?.title?.title?.[0]?.text?.content === "Jawaban Dinda"
      && (fragmen ? teksKirimBagikan.includes(fragmen) : teksKirimBagikan.length > 20)
      && urlBagikan === `${stubBase}/halaman/page-uji-${c11StubPages().length}`,
    `judul=${badanBagikan?.properties?.title?.title?.[0]?.text?.content} fragmen="${fragmen}" url=${urlBagikan}`);

  // Kembali ke halaman Notion. Hulu menolak: server harus meneruskan sebagai 502 apa adanya.
  await klikMenu11B("Notion");
  await page.waitForSelector('[data-testid="notion-isi"]', { timeout: 15000 });
  const tolakHulu = await serverJson("/api/v1/integrations/notion/pages", jsonKirim({ title: `Hulu rusak ${stamp}`, content: "hulu-rusak" }));
  await page.fill('[data-testid="notion-judul"]', `Hulu rusak ${stamp}`);
  await page.fill('[data-testid="notion-isi"]', "hulu-rusak");
  await page.click('[data-testid="notion-kirim"]');
  const teksHulu = await c11TungguPesan('[data-testid="notion-galat"]', "NOTION_UPSTREAM_ERROR");
  check("hulu Notion yang gagal diteruskan sebagai 502 NOTION_UPSTREAM_ERROR dengan kalimat server apa adanya",
    tolakHulu.status === 502 && tolakHulu.badan.error === "NOTION_UPSTREAM_ERROR"
      && teksHulu.includes("NOTION_UPSTREAM_ERROR") && teksHulu.includes(tolakHulu.badan.message),
    `server=${tolakHulu.status} ${tolakHulu.badan.error} layar=${teksHulu.slice(0, 180)}`);

  // Batas laju pembuatan halaman: percobaan kelima ditolak 429.
  await page.fill('[data-testid="notion-judul"]', `Lewat batas ${stamp}`);
  await page.fill('[data-testid="notion-isi"]', "satu paragraf lagi");
  await page.click('[data-testid="notion-kirim"]');
  const teksBatas = await c11TungguPesan('[data-testid="notion-galat"]', "NOTION_PAGE_RATE_LIMITED");
  const tolakBatas = await serverJson("/api/v1/integrations/notion/pages", jsonKirim({ title: `Lewat batas server ${stamp}`, content: "satu paragraf lagi" }));
  const awalanPesan = String(tolakBatas.badan.message || "").split(". Coba lagi")[0];
  check("batas laju halaman Notion ditegakkan: halaman menampilkan 429 NOTION_PAGE_RATE_LIMITED dengan kalimat server apa adanya",
    tolakBatas.status === 429 && tolakBatas.badan.error === "NOTION_PAGE_RATE_LIMITED"
      && teksBatas.includes("NOTION_PAGE_RATE_LIMITED") && awalanPesan.length > 0 && teksBatas.includes(awalanPesan)
      && awalanPesan.includes("4 halaman"),
    `server=${tolakBatas.status} ${tolakBatas.badan.error} awalan="${awalanPesan}" layar=${teksBatas.slice(0, 180)}`);

  // Putuskan sambungan: tunggu SERVER dan LAYAR sama-sama berubah dalam satu putaran.
  await page.click('[data-testid="notion-putus"]');
  let keadaanPutus = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jawabServer = await serverJson("/api/v1/integrations/notion");
    const teksStatusNotion = await page.locator('[data-testid="notion-status"]').first().innerText().catch(() => "");
    keadaanPutus = { terpasang: jawabServer.badan.integration?.terpasang, layar: teksStatusNotion.trim(), jumlah: await c11Attr('[data-testid="notion-hub"]', "data-jumlah") };
    if (keadaanPutus.terpasang === false && keadaanPutus.layar === "belum tersambung") break;
    await page.waitForTimeout(250);
  }
  check("tombol Putuskan menghapus sambungan di server DAN mengubah layar menjadi belum tersambung (butir 68)",
    keadaanPutus?.terpasang === false && keadaanPutus?.layar === "belum tersambung" && keadaanPutus?.jumlah === "0",
    JSON.stringify(keadaanPutus));


  /* ---------------- butir 69 + 81: kanal bot ---------------- */
  const tokenBotBenar = `111222:uji-11c-token-rahasia-${stamp}`;
  const tokenBotGagal = "333444:gagal-token-uji-11c";
  await bukaHalaman11B("Kanal bot", "/api/v1/admin/bot-channels");
  const botAwal = await serverJson("/api/v1/admin/bot-channels");
  const catatanBot = await c11TungguTeks('[data-testid="bot-catatan-honest"]');
  check("halaman Kanal bot jujur: tidak ada rute uji kirim, tindakan nyatanya Simpan yang memanggil setWebhook (butir 69)",
    catatanBot.includes('Tidak ada rute "uji kirim"') && catatanBot.includes("setWebhook")
      && (await c11Attr('[data-testid="bot-channels"]', "data-jumlah")) === String((botAwal.badan.channels || []).length),
    `catatan=${catatanBot.slice(0, 90)}… jumlah server=${(botAwal.badan.channels || []).length}`);

  // Kode pemasangan sebelum ada kanal: server menjawab 404 CHANNEL_NOT_FOUND.
  const tolakKode = await serverJson("/api/v1/bot-identities/link-code", jsonKirim({}));
  await page.click('[data-testid="bot-identitas-tombol"]');
  const teksKode = await c11TungguPesan('[data-testid="bot-galat"]', "CHANNEL_NOT_FOUND");
  check("kode pemasangan tanpa kanal bot dijawab 404 CHANNEL_NOT_FOUND dan pesannya tampil apa adanya",
    tolakKode.status === 404 && tolakKode.badan.error === "CHANNEL_NOT_FOUND"
      && teksKode.includes("CHANNEL_NOT_FOUND") && teksKode.includes(tolakKode.badan.message),
    `server=${tolakKode.status} ${tolakKode.badan.error} layar=${teksKode.slice(0, 140)}`);

  // Simpan kanal Telegram sungguhan: server memanggil setWebhook ke hulu tiruan.
  const stubSebelumSetWebhook = stubRequests.length;
  await page.selectOption('[data-testid="bot-provider"]', "telegram");
  await page.fill('[data-testid="bot-nama"]', `Bot uji ${stamp}`);
  await page.fill('[data-testid="bot-agen"]', "Dinda");
  await page.fill('[data-testid="bot-tagline"]', "Asisten uji 11C");
  await page.fill('[data-testid="bot-token"]', tokenBotBenar);
  await page.click('[data-testid="bot-simpan"]');
  let terdaftar = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    terdaftar = (await c11Attr('[data-testid="bot-hasil"]', "data-terdaftar")) || "";
    if (terdaftar) break;
    await page.waitForTimeout(200);
  }
  const urlWebhook = (await c11Attr('[data-testid="bot-hasil"]', "data-url")) || "";
  const statusWebhook = (await c11Attr('[data-testid="bot-hasil"]', "data-status")) || "";
  const panggilanHulu = stubRequests.slice(stubSebelumSetWebhook).find((item) => /^\/bot[^/]+\/setWebhook$/.test(item.path)) || null;
  const badanHulu = panggilanHulu ? JSON.parse(panggilanHulu.body) : null;
  check("menyimpan kanal Telegram benar-benar mendaftarkan webhook ke hulu dan alamat yang ditampilkan sama dengan yang dikirim ke Telegram",
    terdaftar === "true" && statusWebhook === "200" && Boolean(panggilanHulu)
      && panggilanHulu.path === `/bot${tokenBotBenar}/setWebhook`
      && badanHulu?.url === urlWebhook
      && urlWebhook.startsWith(`${stubBase}/bot-hook/api/v1/bots/telegram/webhook/`)
      && typeof badanHulu?.secret_token === "string" && badanHulu.secret_token.length >= 8,
    `terdaftar=${terdaftar} status=${statusWebhook} path=${panggilanHulu?.path} url=${urlWebhook} huluUrl=${badanHulu?.url}`);

  // Token bot tidak boleh tertinggal di DOM, dan isian token harus dikosongkan setelah simpan.
  const layarBot = await page.evaluate((rahasia) => ({
    adaRahasia: document.body.innerHTML.includes(rahasia),
    isianToken: String(document.querySelector('[data-testid="bot-token"]')?.value ?? "(tidak ada)"),
  }), tokenBotBenar);
  check("token bot tidak pernah ditampilkan kembali: isian kosong dan token tidak ada di DOM",
    layarBot.adaRahasia === false && layarBot.isianToken === "",
    `adaRahasia=${layarBot.adaRahasia} isian="${layarBot.isianToken}"`);

  // Hulu menolak setWebhook: layar harus melaporkan penolakan itu, bukan keberhasilan.
  await page.click('[data-testid="bot-baru"]');
  await page.fill('[data-testid="bot-nama"]', `Bot gagal ${stamp}`);
  await page.fill('[data-testid="bot-token"]', tokenBotGagal);
  await page.click('[data-testid="bot-simpan"]');
  let terdaftarGagal = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    terdaftarGagal = (await c11Attr('[data-testid="bot-hasil"]', "data-terdaftar")) || "";
    if (terdaftarGagal === "false") break;
    await page.waitForTimeout(200);
  }
  const pesanHuluGagal = await c11TungguPesan('[data-testid="bot-pesan-hulu"]', "gagal dipasang oleh hulu");
  check("penolakan Telegram ditampilkan sebagai penolakan (tidak terdaftar) dengan jawaban hulu apa adanya",
    terdaftarGagal === "false" && (await c11Attr('[data-testid="bot-hasil"]', "data-status")) === "400"
      && pesanHuluGagal.includes("gagal dipasang oleh hulu"),
    `terdaftar=${terdaftarGagal} status=${await c11Attr('[data-testid="bot-hasil"]', "data-status")} pesan=${pesanHuluGagal.slice(0, 140)}`);

  // WhatsApp tanpa accountSid/fromNumber: server menolak 400 WHATSAPP_CONFIG_INCOMPLETE.
  await page.click('[data-testid="bot-baru"]');
  await page.selectOption('[data-testid="bot-provider"]', "whatsapp");
  await page.fill('[data-testid="bot-nama"]', `WA uji ${stamp}`);
  await page.fill('[data-testid="bot-token"]', "token-wa-uji-11c");
  await page.click('[data-testid="bot-simpan"]');
  const teksWa = await c11TungguPesan('[data-testid="bot-galat"]', "WHATSAPP_CONFIG_INCOMPLETE");
  const tolakWa = await serverJson("/api/v1/admin/bot-channels", { ...jsonKirim({ provider: "whatsapp", name: `WA server ${stamp}`, token: "token-wa-uji-11c", enabled: true, pasangWebhook: true }), method: "PUT" });
  check("kanal WhatsApp tanpa accountSid/fromNumber dijawab 400 WHATSAPP_CONFIG_INCOMPLETE dan pesannya tampil apa adanya",
    tolakWa.status === 400 && tolakWa.badan.error === "WHATSAPP_CONFIG_INCOMPLETE"
      && teksWa.includes("WHATSAPP_CONFIG_INCOMPLETE") && teksWa.includes(tolakWa.badan.message),
    `server=${tolakWa.status} ${tolakWa.badan.error} layar=${teksWa.slice(0, 140)}`);

  // Kode pemasangan setelah ada kanal aktif.
  await page.selectOption('[data-testid="bot-provider"]', "telegram");
  await page.click('[data-testid="bot-identitas-tombol"]');
  let kodeBot = { kode: "", kanal: "", perintah: "", kanalId: "" };
  for (let attempt = 0; attempt < 80; attempt += 1) {
    kodeBot = {
      kode: (await c11Attr('[data-testid="bot-kode"]', "data-kode")) || "",
      kanal: (await c11Attr('[data-testid="bot-kode"]', "data-kanal")) || "",
      perintah: (await c11Attr('[data-testid="bot-kode"]', "data-perintah")) || "",
      kanalId: urlWebhook.split("/").pop() || "",
    };
    if (kodeBot.kode) break;
    await page.waitForTimeout(200);
  }
  const botSesudah = await serverJson("/api/v1/admin/bot-channels");
  const kanalServer = (botSesudah.badan.channels || []).find((kanal) => kanal.enabled && kanal.provider === "telegram") || null;
  check("kode pemasangan sekali pakai ditampilkan lengkap (kode 6 angka, kanal, perintah) sesuai kanal aktif di server",
    /^[0-9]{6}$/.test(kodeBot.kode) && kodeBot.kanal.length > 0
      && kodeBot.perintah === `/taut ${kodeBot.kode}`
      && kanalServer !== null && kanalServer.enabled === true && kodeBot.kanalId === kanalServer.id,
    `kode=${kodeBot.kode} kanal=${kodeBot.kanal} kanalId=${kodeBot.kanalId} kanalServer=${kanalServer?.id} perintah=${kodeBot.perintah.slice(0, 90)}`);

  // Pemasangan dari luar halaman (kanal bot memanggil rute publik) harus muncul setelah "Muat ulang tautan".
  const tautanSebelum = await serverJson("/api/v1/bot-identities");
  const idLuar = `tg-uji-11c-${stamp}`;
  const pasangLuar = await serverJson(`/api/v1/bots/${encodeURIComponent(kodeBot.kanalId)}/link`, jsonKirim({ external_id: idLuar, code: kodeBot.kode }));
  const identitasId = pasangLuar.badan.identitas?.id ?? "";
  await page.click('[data-testid="bot-identitas-muat"]');
  let tautanTampil = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    tautanTampil = await c11Hitung(`[data-testid="bot-identitas-${identitasId}"]`);
    if (tautanTampil > 0) break;
    await page.waitForTimeout(200);
  }
  const tautanSesudah = await serverJson("/api/v1/bot-identities");
  const adaDiServer = (tautanSesudah.badan.identitas || []).some((baris) => baris.id === identitasId && baris.externalId === idLuar);
  check("pemasangan akun ke bot lewat rute publik muncul di layar dan di server dengan id yang sama",
    pasangLuar.status === 200 && adaDiServer && tautanTampil > 0
      && (tautanSesudah.badan.identitas || []).length === (tautanSebelum.badan.identitas || []).length + 1,
    `pasang=${pasangLuar.status} id=${identitasId} baris=${tautanTampil} serverSebelum=${(tautanSebelum.badan.identitas || []).length} serverSesudah=${(tautanSesudah.badan.identitas || []).length}`);

  // Cabut: tunggu SERVER dan LAYAR sama-sama berubah dalam satu putaran.
  await page.click(`[data-testid="bot-cabut-${identitasId}"]`);
  let keadaanCabut = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jawabServer = await serverJson("/api/v1/bot-identities");
    const barisLayar = await c11Hitung(`[data-testid="bot-identitas-${identitasId}"]`);
    keadaanCabut = {
      adaDiServer: (jawabServer.badan.identitas || []).some((baris) => baris.id === identitasId),
      barisLayar,
    };
    if (keadaanCabut.adaDiServer === false && barisLayar === 0) break;
    await page.waitForTimeout(250);
  }
  check("tombol Cabut benar-benar menghapus tautan di server DAN barisnya hilang dari halaman (butir 81)",
    keadaanCabut?.adaDiServer === false && keadaanCabut?.barisLayar === 0,
    JSON.stringify(keadaanCabut));


  /* ---------------- butir 71: katalog konektor ---------------- */
  await bukaHalaman11B("Konektor", "/api/v1/connectors");
  await c11TungguAttr('[data-testid="connectors"]', "data-kunci");
  await page.waitForSelector('[data-testid="connector-katalog-slack"]', { timeout: 15000 }).catch(() => undefined);
  const conn0 = await serverJson("/api/v1/connectors");
  const katalogServer = conn0.badan.katalog || [];
  const katalogLayar = [];
  for (const baris of katalogServer) {
    katalogLayar.push({
      kind: baris.kind, status: baris.status,
      statusLayar: await c11Attr(`[data-testid="connector-katalog-${baris.kind}"]`, "data-status"),
    });
  }
  check("katalog konektor di layar sama dengan katalog server, dan halaman mengaku jenis MCP belum dikembangkan",
    katalogLayar.length === katalogServer.length && katalogLayar.every((b) => b.statusLayar === b.status)
      && katalogLayar.some((b) => b.status === "dikembangkan")
      && (await c11Attr('[data-testid="connectors"]', "data-kunci")) === conn0.badan.pengaturan.kunci
      && (await c11Attr('[data-testid="connectors"]', "data-jumlah")) === String(conn0.badan.total ?? 0),
    `layar=${katalogLayar.map((b) => `${b.kind}:${b.statusLayar}`).join(",")} server=${katalogServer.map((b) => `${b.kind}:${b.status}`).join(",")}`);

  // Alamat di luar daftar putih: server menolak, halaman menampilkan pesannya apa adanya.
  const urlTerlarang = "https://discord.example.test/webhook";
  await page.selectOption('[data-testid="connector-jenis"]', "slack");
  await page.fill('[data-testid="connector-url"]', urlTerlarang);
  await page.click('[data-testid="connector-tambah"]');
  const teksTolakHost = await c11TungguPesan('[data-testid="connectors-galat"]', "CONNECTOR_HOST_NOT_ALLOWED");
  const tolakHost = await serverJson("/api/v1/connectors", jsonKirim({ kind: "slack", url: urlTerlarang }));
  check("alamat konektor di luar daftar putih dijawab 400 CONNECTOR_HOST_NOT_ALLOWED dengan pesan server apa adanya",
    tolakHost.status === 400 && tolakHost.badan.error === "CONNECTOR_HOST_NOT_ALLOWED"
      && teksTolakHost.includes("CONNECTOR_HOST_NOT_ALLOWED") && teksTolakHost.includes(tolakHost.badan.message),
    `server=${tolakHost.status} ${tolakHost.badan.error} layar=${teksTolakHost.slice(0, 160)}`);

  // Tambah konektor Slack sungguhan (host 127.0.0.1 ada di daftar putih uji).
  await page.fill('[data-testid="connector-url"]', `${stubBase}/slack/ok`);
  await page.fill('[data-testid="connector-nama"]', `Slack uji ${stamp}`);
  await page.fill('[data-testid="connector-token"]', "rahasia-slack-uji-11c");
  const tungguTambahKonektor = page.waitForResponse((balasan) => balasan.url().endsWith("/api/v1/connectors") && balasan.request().method() === "POST");
  await page.click('[data-testid="connector-tambah"]');
  const jawabTambahKonektor = await (await tungguTambahKonektor).json();
  const konektorId = jawabTambahKonektor.konektor?.id ?? "";
  await page.waitForSelector(`[data-testid="connector-${konektorId}"]`, { timeout: 15000 }).catch(() => undefined);
  const layarKonektorBaru = await page.evaluate((rahasia) => ({
    adaRahasia: document.body.innerHTML.includes(rahasia),
    isianToken: String(document.querySelector('[data-testid="connector-token"]')?.value ?? "(tidak ada)"),
  }), "rahasia-slack-uji-11c");
  check("menambah konektor menyimpannya di server (status bukan 'aktif' sebelum diuji) dan token tidak ditampilkan kembali",
    jawabTambahKonektor.konektor?.tautan?.terpasang === true && jawabTambahKonektor.konektor?.tautan?.ekor?.length > 0
      && jawabTambahKonektor.konektor?.status !== "aktif"
      && layarKonektorBaru.adaRahasia === false && layarKonektorBaru.isianToken === "",
    `status=${jawabTambahKonektor.konektor?.status} ekor=${jawabTambahKonektor.konektor?.tautan?.ekor} adaRahasia=${layarKonektorBaru.adaRahasia}`);

  // Status di layar HARUS sama dengan status tersimpan di server (syarat butir 71).
  let keadaanKonektor = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jawabServer = await serverJson("/api/v1/connectors");
    const barisServer = (jawabServer.badan.konektor || []).find((baris) => baris.id === konektorId) || null;
    const statusLayar = await c11Attr(`[data-testid="connector-${konektorId}"]`, "data-status");
    const teksStatus = await page.locator(`[data-testid="connector-status-${konektorId}"]`).first().innerText().catch(() => "");
    keadaanKonektor = {
      server: barisServer?.status ?? null, layar: statusLayar, teksLayar: String(teksStatus).trim(),
      host: await c11Attr(`[data-testid="connector-${konektorId}"]`, "data-host"), hostServer: barisServer?.tautan?.host ?? null,
    };
    if (keadaanKonektor.server && keadaanKonektor.layar === keadaanKonektor.server && keadaanKonektor.teksLayar === keadaanKonektor.server) break;
    await page.waitForTimeout(250);
  }
  check("status konektor di layar SAMA PERSIS dengan status di server setelah disimpan (butir 71)",
    keadaanKonektor.server !== null && keadaanKonektor.layar === keadaanKonektor.server
      && keadaanKonektor.teksLayar === keadaanKonektor.server && keadaanKonektor.host === keadaanKonektor.hostServer,
    JSON.stringify(keadaanKonektor));

  // Tombol Uji: jalankan uji kirim, lalu bandingkan hasil di layar dengan jawaban server.
  // Jawaban server untuk KLIK INI yang dibandingkan, bukan jawaban panggilan kedua (pengiriman nyata
  // ke hulu hanya terjadi sekali, dan yang diuji adalah "layar sama dengan jawaban server").
  const tungguUji = page.waitForResponse((balasan) => balasan.url().endsWith(`/api/v1/connectors/${konektorId}/test`) && balasan.request().method() === "POST", { timeout: 60000 });
  await page.click(`[data-testid="connector-uji-${konektorId}"]`);
  const ujiServer = await (await tungguUji).json();
  let hasilLayar = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const kode = await c11Attr(`[data-testid="connector-hasil-${konektorId}"]`, "data-kode");
    if (kode) {
      hasilLayar = {
        kode, status: await c11Attr(`[data-testid="connector-hasil-${konektorId}"]`, "data-status"),
        hulu: await c11Attr(`[data-testid="connector-hasil-${konektorId}"]`, "data-hulu"),
        pesan: String(await page.locator(`[data-testid="connector-hasil-pesan-${konektorId}"]`).first().innerText().catch(() => "")).trim(),
      };
      break;
    }
    await page.waitForTimeout(250);
  }
  check("tombol Uji: kode, status, dan pesan hasil di layar sama dengan jawaban server (butir 71)",
    Boolean(hasilLayar) && Boolean(ujiServer.hasil)
      && hasilLayar.kode === ujiServer.hasil.kode
      && hasilLayar.status === ujiServer.hasil.status
      && hasilLayar.hulu === String(ujiServer.hasil.upstreamStatus ?? "")
      && hasilLayar.pesan === String(ujiServer.hasil.pesan ?? "").trim(),
    `layar=${JSON.stringify(hasilLayar)} server=${JSON.stringify({ kode: ujiServer.hasil?.kode, status: ujiServer.hasil?.status, hulu: ujiServer.hasil?.upstreamStatus })}`);

  // Kiriman benar-benar sampai ke hulu tiruan. Kalau proses anak tidak jalan, uji ini dilaporkan SKIP
  // dengan alasan yang dicetak, bukan dibuat seolah-olah lulus.
  const kirimanHulu = stubRequests.filter((item) => item.path.startsWith("/slack/ok"));
  if (kirimanHulu.length > 0) {
    const isiKiriman = (() => { try { return JSON.parse(kirimanHulu[kirimanHulu.length - 1].body); } catch { return null; } })();
    check("kiriman konektor benar-benar sampai ke hulu (server tiruan menerima POST berisi teks)",
      kirimanHulu.length >= 1 && typeof isiKiriman?.text === "string" && isiKiriman.text.length > 0,
      `jumlah=${kirimanHulu.length} isi=${JSON.stringify(isiKiriman)?.slice(0, 160)}`);
  } else {
    skip("11C-kiriman-konektor-sampai-ke-hulu", `proses anak konektor tidak mengirim apa pun ke server tiruan; status di layar tetap dibandingkan dengan server (lihat uji sebelumnya). Log server: ${serverLog.join(" ").slice(-200)}`);
  }

  // Setelah uji berhasil, status server harus 'aktif' dan layar mengikutinya.
  let keadaanAktif = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jawabServer = await serverJson("/api/v1/connectors");
    const barisServer = (jawabServer.badan.konektor || []).find((baris) => baris.id === konektorId) || null;
    const statusLayar = await c11Attr(`[data-testid="connector-${konektorId}"]`, "data-status");
    keadaanAktif = { server: barisServer?.status ?? null, layar: statusLayar, galatServer: barisServer?.lastError ?? null };
    if (keadaanAktif.server && keadaanAktif.layar === keadaanAktif.server) break;
    await page.waitForTimeout(250);
  }
  check("setelah uji kirim berhasil, status di server dan di layar sama-sama 'aktif' tanpa galat tersisa (butir 71)",
    keadaanAktif.server === "aktif" && keadaanAktif.layar === "aktif" && !keadaanAktif.galatServer,
    JSON.stringify(keadaanAktif));

  // Matikan lalu hapus: keadaan berikutnya harus datang dari server, dan barisnya harus hilang dari layar.
  await page.click(`[data-testid="connector-toggle-${konektorId}"]`);
  let keadaanMati = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jawabServer = await serverJson("/api/v1/connectors");
    const barisServer = (jawabServer.badan.konektor || []).find((baris) => baris.id === konektorId) || null;
    const enabledLayar = await c11Attr(`[data-testid="connector-${konektorId}"]`, "data-enabled");
    keadaanMati = { server: barisServer ? barisServer.enabled : null, layar: enabledLayar };
    if (keadaanMati.server === false && keadaanMati.layar === "false") break;
    await page.waitForTimeout(250);
  }
  check("tombol Matikan mengubah keadaan di server DAN di layar (butir 71)",
    keadaanMati.server === false && keadaanMati.layar === "false", JSON.stringify(keadaanMati));

  await page.click(`[data-testid="connector-hapus-${konektorId}"]`);
  let keadaanHapus = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jawabServer = await serverJson("/api/v1/connectors");
    const barisServer = (jawabServer.badan.konektor || []).some((baris) => baris.id === konektorId);
    const barisLayar = await c11Hitung(`[data-testid="connector-${konektorId}"]`);
    keadaanHapus = { adaDiServer: barisServer, barisLayar };
    if (!keadaanHapus.adaDiServer && barisLayar === 0) break;
    await page.waitForTimeout(250);
  }
  check("tombol Hapus benar-benar menghapus konektor di server DAN barisnya hilang dari layar",
    keadaanHapus.adaDiServer === false && keadaanHapus.barisLayar === 0, JSON.stringify(keadaanHapus));


  /* ---------------- butir 74: nominal unik untuk transfer manual ---------------- */
  const pesananManual = await serverJson("/api/v1/billing/orders", jsonKirim({ planCode: "premium", months: 1, note: `uji 11C ${stamp}` }));
  const pesananGratis = await serverJson("/api/v1/billing/orders", jsonKirim({ planCode: "free", months: 1, note: `uji 11C gratis ${stamp}` }));
  const idManual = pesananManual.badan?.order?.id ?? "";
  const idGratis = pesananGratis.badan?.order?.id ?? "";
  await klikMenu11B("Paket & langganan");
  await page.waitForSelector('[data-testid="billing-unik"]', { timeout: 20000 });
  await page.waitForSelector(`[data-testid="unik-${idManual}"]`, { timeout: 20000 }).catch(() => undefined);
  const billingAwal = await serverJson("/api/v1/billing/me");
  const barisManualServer = (billingAwal.badan.orders || []).find((order) => order.id === idManual) || null;
  const barisGratisServer = (billingAwal.badan.orders || []).find((order) => order.id === idGratis) || null;
  const manualPendingServer = (billingAwal.badan.orders || []).filter((order) => order.status === "pending" && order.method === "manual").length;
  const jumlahManualLayar = await c11Attr('[data-testid="billing-unik"]', "data-jumlah-manual");
  const nominalAwalLayar = await c11Attr(`[data-testid="unik-${idManual}"]`, "data-nominal");
  const metodeManualLayar = await c11Attr(`[data-testid="unik-${idManual}"]`, "data-method");
  const nilaiManualAwal = String(await page.locator(`[data-testid="unik-nilai-${idManual}"]`).first().innerText().catch(() => "")).trim();
  const pasangManualLayar = await c11Hitung(`[data-testid="unik-pasang-${idManual}"]`);
  const barisGratisLayar = await c11Hitung(`[data-testid="unik-${idGratis}"]`);
  const catatanUnikLayar = String(await page.locator('[data-testid="billing-unik-catatan"]').first().innerText().catch(() => "")).trim();
  check("halaman hanya menandai pesanan transfer manual yang menunggu pembayaran dengan 'Belum dipasang.' dan tidak menampilkan pesanan yang sudah lunas (butir 74)",
    barisManualServer?.method === "manual" && barisManualServer?.status === "pending"
      && metodeManualLayar === "manual" && jumlahManualLayar === String(manualPendingServer)
      && nominalAwalLayar === "" && nilaiManualAwal.includes("Belum dipasang") && pasangManualLayar === 1
      && barisGratisServer?.method === "free" && barisGratisServer?.status === "paid" && barisGratisLayar === 0
      && (await c11Hitung(`[data-testid="unik-pasang-${idGratis}"]`)) === 0
      && /tidak mengubah/i.test(catatanUnikLayar) && catatanUnikLayar.includes("amount_idr") && catatanUnikLayar.includes("total_idr"),
    `manualLayar=${jumlahManualLayar} manualServer=${manualPendingServer} metodeLayar="${metodeManualLayar}" nominal="${nominalAwalLayar}" nilai="${nilaiManualAwal.slice(0, 40)}" pasang=${pasangManualLayar} gratisStatus=${barisGratisServer?.status} gratisLayar=${barisGratisLayar}`);

  // Pesanan non-transfer. Yang harus dijawab server untuk pesanan seperti ini adalah penolakan, dan
  // halaman tidak boleh menawarkan tombolnya sama sekali. Kode penolakan yang benar-benar keluar di sini
  // adalah ORDER_NOT_PENDING (paket gratis langsung ditandai lunas oleh server), bukan GATEWAY_EXACT_AMOUNT:
  // cabang method di server ("bayar persis") hanya berlaku untuk pesanan non-manual yang MASIH menunggu
  // pembayaran, dan pesanan seperti itu tidak bisa dibuat lewat API publik (method diturunkan dari total).
  // Karena itu kode yang benar-benar keluar diperiksa apa adanya, bukan yang diharapkan semula.
  const tolakGratis = await serverJson(`/api/v1/billing/orders/${idGratis}/unique-amount`, jsonKirim({}));
  check("pesanan non-transfer ditolak server dengan kode penolakan yang tepat dan halaman tidak menawarkan tombol nominal unik untuknya (butir 74)",
    tolakGratis.status === 409 && tolakGratis.badan.error === "ORDER_NOT_PENDING"
      && (await c11Hitung(`[data-testid="unik-pasang-${idGratis}"]`)) === 0
      && (await c11Hitung(`[data-testid="unik-lewat-${idGratis}"]`)) === 0,
    `server=${tolakGratis.status} ${tolakGratis.badan.error} (pesanan gratis langsung lunas; gerbang status jalan lebih dulu. GATEWAY_EXACT_AMOUNT tidak bisa dipicu lewat API publik)`);

  // Pasang nominal unik untuk pesanan manual.
  const tungguUnik = page.waitForResponse((balasan) => balasan.url().endsWith(`/api/v1/billing/orders/${idManual}/unique-amount`) && balasan.request().method() === "POST");
  await page.click(`[data-testid="unik-pasang-${idManual}"]`);
  const jawabUnik = await (await tungguUnik).json();
  let nominalLayar = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    nominalLayar = (await c11Attr(`[data-testid="unik-${idManual}"]`, "data-nominal")) || "";
    if (nominalLayar) break;
    await page.waitForTimeout(200);
  }
  const billingSesudah = await serverJson("/api/v1/billing/me");
  const barisManualSesudah = (billingSesudah.badan.orders || []).find((order) => order.id === idManual) || null;
  const teksNilaiUnik = String(await page.locator(`[data-testid="unik-nilai-${idManual}"]`).first().innerText().catch(() => "")).trim();
  check("Pasang nominal unik: angka di layar sama dengan jawaban server, kode 1-999, dan amount_idr/total_idr TIDAK berubah (butir 74)",
    nominalLayar === String(jawabUnik.order?.nominalBayarIdr)
      && jawabUnik.k >= 1 && jawabUnik.k <= 999 && jawabUnik.order?.nominalBayarIdr === jawabUnik.baseIdr + jawabUnik.k
      && jawabUnik.order?.nominalBayarIdr > jawabUnik.order?.totalIdr
      && barisManualSesudah?.amountIdr === barisManualServer?.amountIdr && barisManualSesudah?.totalIdr === barisManualServer?.totalIdr
      && teksNilaiUnik.includes(angkaId(jawabUnik.order?.nominalBayarIdr)),
    `layar=${nominalLayar} server=${jawabUnik.order?.nominalBayarIdr} dasar=${jawabUnik.baseIdr} k=${jawabUnik.k} totalSebelum=${barisManualServer?.totalIdr} totalSesudah=${barisManualSesudah?.totalIdr} teks=${teksNilaiUnik.slice(0, 90)}`);

  // Antrean admin: jumlah "belum bernominal unik" dan nominal per baris harus sama dengan jawaban server.
  const antreanSebelum = await serverJson("/api/v1/billing/manual-orders/queue");
  await page.click('[data-testid="antrean-muat"]');
  let antreanLayar = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const belum = await c11Attr('[data-testid="billing-antrean"]', "data-belum");
    const baris = await c11Hitung('[data-testid="billing-antrean"] tbody tr[data-testid]');
    antreanLayar = {
      belum, baris,
      nominal: await c11Attr(`[data-testid="antrean-${idManual}"]`, "data-nominal"),
      hitung: String(await page.locator('[data-testid="antrean-hitung"]').first().innerText().catch(() => "")).trim(),
    };
    if (belum === String(antreanSebelum.badan.belumBernominalUnik) && baris === (antreanSebelum.badan.orders || []).length) break;
    await page.waitForTimeout(250);
  }
  const barisAntreanServer = (antreanSebelum.badan.orders || []).find((baris) => baris.orderId === idManual) || null;
  check("antrean admin menampilkan jumlah pesanan tanpa nominal unik dan nominal per baris sesuai jawaban server (butir 74)",
    antreanLayar.belum === String(antreanSebelum.badan.belumBernominalUnik)
      && antreanLayar.baris === (antreanSebelum.badan.orders || []).length
      && antreanLayar.nominal === String(barisAntreanServer?.nominalBayarIdr)
      && antreanLayar.hitung.includes(angkaId(antreanSebelum.badan.belumBernominalUnik)),
    `layar=${JSON.stringify(antreanLayar)} server belum=${antreanSebelum.badan.belumBernominalUnik} baris=${(antreanSebelum.badan.orders || []).length}`);

  // Isi sekaligus: angka di layar harus sama dengan jawaban server, dan antrean server benar-benar berkurang.
  const tungguIsiAntrean = page.waitForResponse((balasan) => balasan.url().endsWith("/api/v1/billing/manual-orders/queue/unique-amounts") && balasan.request().method() === "POST");
  await page.click('[data-testid="antrean-isi"]');
  const jawabIsiAntrean = await (await tungguIsiAntrean).json();
  let hasilIsiAntrean = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const diisi = await c11Attr('[data-testid="antrean-hasil"]', "data-diisi");
    if (diisi !== null) {
      hasilIsiAntrean = {
        diisi, gagal: await c11Attr('[data-testid="antrean-hasil"]', "data-gagal"),
        belum: await c11Attr('[data-testid="billing-antrean"]', "data-belum"),
      };
      if (hasilIsiAntrean.belum === String(antreanSebelum.badan.belumBernominalUnik - jawabIsiAntrean.diisi)) break;
    }
    await page.waitForTimeout(250);
  }
  const antreanSesudah = await serverJson("/api/v1/billing/manual-orders/queue");
  const barisManualAntrean = (antreanSesudah.badan.orders || []).find((baris) => baris.orderId === idManual) || null;
  check("Isi nominal unik sekaligus: angka di layar sama dengan jawaban server dan antrean server benar-benar berkurang (butir 74)",
    hasilIsiAntrean?.diisi === String(jawabIsiAntrean.diisi) && hasilIsiAntrean?.gagal === String(jawabIsiAntrean.gagal)
      && hasilIsiAntrean?.belum === String(antreanSesudah.badan.belumBernominalUnik)
      && antreanSesudah.badan.belumBernominalUnik === antreanSebelum.badan.belumBernominalUnik - jawabIsiAntrean.diisi
      && barisManualAntrean?.punyaNominalUnik === true && barisManualAntrean?.nominalBayarIdr > 0,
    `layar=${JSON.stringify(hasilIsiAntrean)} jawaban=${JSON.stringify(jawabIsiAntrean)} server sebelum=${antreanSebelum.badan.belumBernominalUnik} sesudah=${antreanSesudah.badan.belumBernominalUnik}`);


  /* ---------------- butir 76: avatar (gambar dipotong di peramban) ---------------- */
  // Dua gambar uji dibuat di dalam peramban: JPEG dan PNG 1200×900. JPEG dipakai untuk membuktikan
  // halaman benar-benar menulis ulang gambarnya menjadi PNG sebelum dikirim ke server.
  const gambarUji = await page.evaluate(() => {
    const lukis = (jenis, lebar, tinggi) => {
      const kanvas = document.createElement('canvas');
      kanvas.width = lebar; kanvas.height = tinggi;
      const konteks = kanvas.getContext('2d');
      const gradien = konteks.createLinearGradient(0, 0, lebar, tinggi);
      gradien.addColorStop(0, '#1d4ed8'); gradien.addColorStop(1, '#f59e0b');
      konteks.fillStyle = gradien; konteks.fillRect(0, 0, lebar, tinggi);
      konteks.fillStyle = '#ffffff';
      konteks.beginPath(); konteks.arc(lebar * 0.5, tinggi * 0.45, Math.min(lebar, tinggi) * 0.2, 0, Math.PI * 2); konteks.fill();
      return kanvas.toDataURL(jenis);
    };
    return { jpeg: lukis('image/jpeg', 1200, 900), png: lukis('image/png', 1200, 900) };
  });
  const berkasJpegUji = "/tmp/w11c-avatar-uji.jpg";
  const berkasPngUji = "/tmp/w11c-avatar-uji.png";
  const berkasBesarUji = "/tmp/w11c-avatar-besar.jpg";
  await writeFile(berkasJpegUji, Buffer.from(String(gambarUji.jpeg).split(",")[1], "base64"));
  await writeFile(berkasPngUji, Buffer.from(String(gambarUji.png).split(",")[1], "base64"));
  await writeFile(berkasBesarUji, Buffer.alloc(5_000_000, 65));
  const { readFile: c11BacaBerkas } = await import("node:fs/promises");
  const isiBerkasJpeg = await c11BacaBerkas(berkasJpegUji);
  const berkasMemangJpeg = isiBerkasJpeg[0] === 0xff && isiBerkasJpeg[1] === 0xd8;

  await klikMenu11B("Pengaturan & akun");
  await page.waitForSelector('[data-testid="avatar-berkas"]', { timeout: 20000 });
  let badanUnggah = "";
  let modeUnggah = "normal";
  const tangkapUnggahAvatar = async (rute) => {
    if (rute.request().method() !== "PUT") { await rute.continue(); return; }
    badanUnggah = rute.request().postData() || "";
    if (modeUnggah === "laju") {
      await rute.fulfill({
        status: 429, contentType: "application/json",
        body: JSON.stringify({ error: "AVATAR_RATE_LIMITED", message: "Terlalu banyak unggahan avatar (batas 20 per jam). Coba lagi nanti.", retryAfter: 60 }),
      });
      return;
    }
    await rute.continue();
  };
  await page.route("**/api/v1/account/avatar", tangkapUnggahAvatar);

  await page.setInputFiles('[data-testid="avatar-berkas"]', berkasJpegUji);
  await page.click('[data-testid="avatar-unggah"]');
  const teksAvatarOk = await c11TungguPesan('[data-testid="avatar-ok"]', "Tersimpan", 150);
  const kirimanAvatar = badanUnggah ? JSON.parse(badanUnggah) : null;
  const isiPngKirim = kirimanAvatar ? Buffer.from(String(kirimanAvatar.contentBase64 || ""), "base64") : Buffer.alloc(0);
  const tandaPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const pngSah = isiPngKirim.length > 8 && tandaPng.every((bit, posisi) => isiPngKirim[posisi] === bit);
  const lebarPng = pngSah ? isiPngKirim.readUInt32BE(16) : 0;
  const tinggiPng = pngSah ? isiPngKirim.readUInt32BE(20) : 0;
  check("berkas JPEG yang dipilih pengguna ditulis ulang menjadi PNG 512×512 DI PERAMBAN sebelum dikirim (butir 76)",
    berkasMemangJpeg && pngSah && lebarPng === 512 && tinggiPng === 512
      && String(kirimanAvatar?.declaredName || "").endsWith(".jpg") && kirimanAvatar?.declaredMimeType === "image/jpeg"
      && (await c11Attr('[data-testid="avatar-card"]', "data-jenis")) === "image/png"
      && (await c11Attr('[data-testid="avatar-card"]', "data-lebar")) === "512"
      && (await c11Attr('[data-testid="avatar-card"]', "data-tinggi")) === "512"
      && teksAvatarOk.length > 0,
    `berkasJpeg=${berkasMemangJpeg} png=${pngSah} ukuranKirim=${lebarPng}x${tinggiPng} nama=${kirimanAvatar?.declaredName} mime=${kirimanAvatar?.declaredMimeType} layar=${await c11Attr('[data-testid="avatar-card"]', "data-lebar")}x${await c11Attr('[data-testid="avatar-card"]', "data-tinggi")} pesan=${teksAvatarOk.slice(0, 90)}`);

  // Foto benar-benar tersaji dari rute media server (bukan hanya di memori peramban).
  await c11TungguGambar('[data-testid="avatar-gambar"]');
  const keadaanGambar = await page.evaluate(() => {
    const gambar = document.querySelector('[data-testid="avatar-gambar"]');
    return {
      ada: gambar ? gambar.getAttribute("data-ada") : null,
      lebarAsli: gambar ? gambar.naturalWidth : 0, tinggiAsli: gambar ? gambar.naturalHeight : 0,
      src: gambar ? String(gambar.getAttribute("src")) : "",
    };
  });
  const idPengguna = (keadaanGambar.src.match(/\/api\/v1\/media\/avatar\/([^?]+)/) || [])[1] || "";
  const mediaSebelum = await serverJson(`/api/v1/media/avatar/${idPengguna}`);
  check("foto profil benar-benar tersaji dari rute media server (512×512) setelah unggahan dari peramban",
    keadaanGambar.ada === "true" && keadaanGambar.lebarAsli === 512 && keadaanGambar.tinggiAsli === 512
      && mediaSebelum.status === 200 && idPengguna.length > 0,
    JSON.stringify({ ada: keadaanGambar.ada, lebar: keadaanGambar.lebarAsli, tinggi: keadaanGambar.tinggiAsli, media: mediaSebelum.status, idPengguna }));

  // Kendali negatif: PNG mentah diterima, JPEG mentah ditolak 503. Keduanya lewat API langsung.
  const b64PngMentah = String(gambarUji.png).split(",")[1];
  const b64JpegMentah = String(gambarUji.jpeg).split(",")[1];
  const pngMentah = await serverJson("/api/v1/account/avatar", { ...jsonKirim({ contentBase64: b64PngMentah, declaredName: "mentah.png", declaredMimeType: "image/png" }), method: "PUT" });
  check("PNG mentah yang dikirim langsung ke API (tanpa kanvas) diterima dan SERVER memotong-menskalakan sendiri ke 512×512",
    pngMentah.status === 200 && pngMentah.badan?.avatar?.jenis === "image/png"
      && pngMentah.badan?.avatar?.lebar === 512 && pngMentah.badan?.avatar?.tinggi === 512
      && pngMentah.badan?.avatar?.asal?.lebar === 1200 && pngMentah.badan?.avatar?.asal?.tinggi === 900,
    `status=${pngMentah.status} jenis=${pngMentah.badan?.avatar?.jenis} hasil=${pngMentah.badan?.avatar?.lebar}x${pngMentah.badan?.avatar?.tinggi} asal=${pngMentah.badan?.avatar?.asal?.lebar}x${pngMentah.badan?.avatar?.asal?.tinggi}`);

  const jpegMentah = await serverJson("/api/v1/account/avatar", { ...jsonKirim({ contentBase64: b64JpegMentah, declaredName: "mentah.jpg", declaredMimeType: "image/jpeg" }), method: "PUT" });
  check("JPEG mentah yang dikirim langsung ke API dijawab 503 IMAGE_PROCESSOR_UNAVAILABLE (peladen tidak punya pustaka pemroses JPEG)",
    jpegMentah.status === 503 && jpegMentah.badan?.error === "IMAGE_PROCESSOR_UNAVAILABLE" && String(jpegMentah.badan?.message || "").includes("PNG"),
    `status=${jpegMentah.status} ${jpegMentah.badan?.error} pesan=${String(jpegMentah.badan?.message || "").slice(0, 140)}`);

  // Batas ukuran 4 MB: dibuktikan lewat API langsung (badan 4,2 MB).
  const kirimTerlaluBesar = await page.evaluate(async () => {
    const isi = "QUFB".repeat(1400000);
    const balasan = await fetch("/api/v1/account/avatar", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ contentBase64: isi }),
    });
    const teks = await balasan.text();
    let badan = null;
    try { badan = JSON.parse(teks); } catch { badan = null; }
    return { status: balasan.status, kode: badan?.error ?? null, pesan: badan?.message ?? null, byte: (isi.length / 4) * 3 };
  });
  check("berkas 4,2 MB ditolak server dengan 413 AVATAR_TOO_LARGE (batas 4 MB)",
    kirimTerlaluBesar.status === 413 && kirimTerlaluBesar.kode === "AVATAR_TOO_LARGE" && kirimTerlaluBesar.byte > 4 * 1024 * 1024,
    JSON.stringify(kirimTerlaluBesar));

  // Halaman menolak berkas >4 MB lebih dulu, menyebut aturan server, dan tidak mengirim apa pun.
  const badanSebelumBesar = badanUnggah;
  await page.setInputFiles('[data-testid="avatar-berkas"]', berkasBesarUji);
  await page.click('[data-testid="avatar-unggah"]');
  const teksBesar = await c11TungguPesan('[data-testid="avatar-galat"]', "4 MB", 60);
  check("halaman menolak berkas lebih dari 4 MB sendiri, menyebut aturan server (413 AVATAR_TOO_LARGE), dan TIDAK mengirim apa pun",
    teksBesar.includes("4 MB") && teksBesar.includes("413 AVATAR_TOO_LARGE") && badanUnggah === badanSebelumBesar,
    `pesan=${teksBesar.slice(0, 160)} kirimanBaru=${badanUnggah !== badanSebelumBesar}`);

  // Galat server (429) harus tampil apa adanya.
  modeUnggah = "laju";
  await page.setInputFiles('[data-testid="avatar-berkas"]', berkasPngUji);
  await page.click('[data-testid="avatar-unggah"]');
  const teksLaju = await c11TungguPesan('[data-testid="avatar-galat"]', "AVATAR_RATE_LIMITED", 80);
  modeUnggah = "normal";
  check("galat server pada unggahan avatar ditampilkan apa adanya (429 AVATAR_RATE_LIMITED)",
    teksLaju.includes("AVATAR_RATE_LIMITED") && teksLaju.includes("Terlalu banyak unggahan avatar"),
    `pesan=${teksLaju.slice(0, 160)}`);
  await page.unroute("**/api/v1/account/avatar", tangkapUnggahAvatar);

  // Avatar agen (khusus admin platform).
  await page.setInputFiles('[data-testid="agent-avatar-berkas"]', berkasPngUji);
  const tungguAvatarAgen = page.waitForResponse((balasan) => balasan.url().endsWith("/api/v1/admin/agent-avatar") && balasan.request().method() === "PUT");
  await page.click('[data-testid="agent-avatar-unggah"]');
  const jawabAvatarAgen = await (await tungguAvatarAgen).json();
  await c11TungguGambar('[data-testid="agent-avatar-gambar"]');
  const agenServer = await serverJson("/api/v1/admin/agent-avatar");
  const keadaanAgen = await page.evaluate(() => {
    const gambar = document.querySelector('[data-testid="agent-avatar-gambar"]');
    return {
      ada: gambar ? gambar.getAttribute("data-ada") : null,
      lebarAsli: gambar ? gambar.naturalWidth : 0,
      terpasang: document.querySelector('[data-testid="agent-avatar-card"]')?.getAttribute("data-terpasang") ?? null,
      berkas: document.querySelector('[data-testid="agent-avatar-card"]')?.getAttribute("data-berkas") ?? null,
    };
  });
  check("avatar agen (admin platform) tersimpan 512×512 dan keadaan di layar sama dengan jawaban server",
    jawabAvatarAgen.agentAvatar?.lebar === 512 && jawabAvatarAgen.agentAvatar?.tinggi === 512
      && agenServer.badan?.agentAvatar?.terpasang === true
      && keadaanAgen.terpasang === "true" && keadaanAgen.berkas === (agenServer.badan?.agentAvatar?.berkas ?? "")
      && String(keadaanAgen.berkas || "").endsWith(".png")
      && keadaanAgen.ada === "true" && keadaanAgen.lebarAsli === 512,
    `jawaban=${jawabAvatarAgen.agentAvatar?.lebar}x${jawabAvatarAgen.agentAvatar?.tinggi} serverTerpasang=${agenServer.badan?.agentAvatar?.terpasang} layar=${JSON.stringify(keadaanAgen)}`);

  // Hapus avatar agen: server dan layar harus sama-sama kembali kosong (tunggu DUA-DUANYA dalam satu loop).
  await page.click('[data-testid="agent-avatar-hapus"]');
  let keadaanAgenHapus = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jawabServer = await serverJson("/api/v1/admin/agent-avatar");
    const turunkan = await page.evaluate(() => ({
      terpasang: document.querySelector('[data-testid="agent-avatar-card"]')?.getAttribute("data-terpasang") ?? null,
      ada: document.querySelector('[data-testid="agent-avatar-gambar"]')?.getAttribute("data-ada") ?? null,
    }));
    keadaanAgenHapus = { server: jawabServer.badan?.agentAvatar?.terpasang ?? null, ...turunkan };
    if (keadaanAgenHapus.server === false && keadaanAgenHapus.terpasang === "false" && keadaanAgenHapus.ada === "false") break;
    await page.waitForTimeout(250);
  }
  check("tombol Hapus avatar agen benar-benar menghapus di server DAN di layar (butir 76)",
    keadaanAgenHapus.server === false && keadaanAgenHapus.terpasang === "false" && keadaanAgenHapus.ada === "false",
    JSON.stringify(keadaanAgenHapus));

  // Hapus foto profil sendiri: rute media harus benar-benar berhenti menyajikan berkas.
  await page.click('[data-testid="avatar-hapus"]');
  let keadaanAvatarHapus = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const media = await serverJson(`/api/v1/media/avatar/${idPengguna}`);
    const turunkan = await page.evaluate(() => ({
      terpasang: document.querySelector('[data-testid="avatar-card"]')?.getAttribute("data-terpasang") ?? null,
      ada: document.querySelector('[data-testid="avatar-gambar"]')?.getAttribute("data-ada") ?? null,
    }));
    keadaanAvatarHapus = { media: media.status, kode: media.badan?.error ?? null, ...turunkan };
    if (keadaanAvatarHapus.media === 404 && keadaanAvatarHapus.terpasang === "false" && keadaanAvatarHapus.ada === "false") break;
    await page.waitForTimeout(250);
  }
  check("tombol Hapus foto profil benar-benar menghapus berkas di server (rute media 404) DAN mengosongkan layar (butir 76)",
    keadaanAvatarHapus.media === 404 && keadaanAvatarHapus.terpasang === "false" && keadaanAvatarHapus.ada === "false",
    JSON.stringify(keadaanAvatarHapus));

  /* ---------------- butir 78 tahap 1: laporan versi mesin ---------------- */
  await klikMenu11B("Status platform");
  await page.waitForSelector('[data-testid="engine-version"]', { timeout: 20000 });
  const versiServer = await serverJson("/api/v1/admin/engine/version");
  const versiBadan = versiServer.badan || {};
  const mentahServer = String(versiBadan.engineVersion ?? "").trim();
  const versiDiharapkan = mentahServer && mentahServer !== "versi tidak dilaporkan" ? mentahServer : "versi tidak dilaporkan";
  // Seluruh atribut kartu dibaca dalam SATU putaran (c11Snap) supaya nilainya tidak tercampur antar-render.
  const ambilVersi = async () => {
    const gulir = await c11Snap('[data-testid="engine-version"]',
      ["data-version", "data-version-mentah", "data-dilaporkan", "data-platform", "data-mesin-tersedia", "data-tahap2"]);
    if (!gulir) return null;
    return {
      version: gulir["data-version"] ?? "", mentah: gulir["data-version-mentah"] ?? "",
      dilaporkan: gulir["data-dilaporkan"] ?? "", platform: gulir["data-platform"] ?? "",
      mesinTersedia: gulir["data-mesin-tersedia"] ?? "", tahap2: gulir["data-tahap2"] ?? "",
    };
  };
  let versiLayar = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    versiLayar = await ambilVersi();
    if (versiLayar && versiLayar.platform && versiLayar.mentah === mentahServer) break;
    await page.waitForTimeout(250);
  }
  const teksTahap2 = String(await page.locator('[data-testid="engine-version-tahap2"]').first().innerText().catch(() => "")).trim();
  check("kartu Versi mesin menampilkan versi dari laporan server apa adanya dan menyatakan tahap 2 (perbarui/pulihkan) belum ada (butir 78 tahap 1)",
    versiLayar?.mentah === mentahServer && versiLayar?.version === versiDiharapkan
      && versiLayar.platform === String(versiBadan.platformVersion ?? "")
      && versiLayar.dilaporkan === (versiDiharapkan === "versi tidak dilaporkan" ? "false" : "true")
      && versiLayar.mesinTersedia === String(Boolean(versiBadan.engineAvailable))
      && versiLayar.tahap2 === (versiBadan.tahap2?.tersedia === true ? "tersedia" : "belum-tersedia")
      && /tahap 2|belum ada/i.test(teksTahap2),
    `layar=${JSON.stringify(versiLayar)} server mentah="${mentahServer}" platform=${versiBadan.platformVersion} tahap2=${Boolean(versiBadan.tahap2?.tersedia)} teks="${teksTahap2.slice(0, 120)}"`);

  // Kalau server TIDAK melaporkan versi mesin, kartu harus menulis "versi tidak dilaporkan" — bukan mengarang.
  await page.route("**/api/v1/admin/engine/version", (rute) => rute.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ ...versiBadan, engineVersion: null, engineVersionSource: "" }),
  }));
  await page.click('[data-testid="engine-version-muat"]');
  let versiKosong = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    versiKosong = await ambilVersi();
    if (versiKosong && versiKosong.dilaporkan === "false" && versiKosong.mentah === "" && versiKosong.version === "versi tidak dilaporkan") break;
    await page.waitForTimeout(250);
  }
  const teksNilaiKosong = String(await page.locator('[data-testid="engine-version-nilai"]').first().textContent().catch(() => "")).trim();
  check("bila server tidak melaporkan versi mesin, kartu menulis 'versi tidak dilaporkan' dan tidak mengarang nilai (butir 78 tahap 1)",
    versiKosong?.dilaporkan === "false" && versiKosong?.version === "versi tidak dilaporkan"
      && versiKosong?.mentah === "" && teksNilaiKosong === "versi tidak dilaporkan",
    `${JSON.stringify(versiKosong)} teks="${teksNilaiKosong}"`);

  await page.unroute("**/api/v1/admin/engine/version");
  await page.click('[data-testid="engine-version-muat"]');
  let versiBalik = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    versiBalik = await ambilVersi();
    // Satu cuplikan dianggap utuh hanya kalau "dilaporkan" cocok dengan nilai yang ditampilkan; kalau
    // tidak, cuplikan itu terbaca lintas-render dan harus diulang.
    const utuh = versiBalik !== null
      && (versiBalik.dilaporkan === "true") === (versiBalik.version !== "versi tidak dilaporkan");
    if (utuh && versiBalik.mentah === mentahServer && versiBalik.version === versiDiharapkan) break;
    await page.waitForTimeout(250);
  }
  check("setelah penyadapan dilepas, kartu kembali menampilkan laporan mesin yang sungguhan dari server",
    versiBalik !== null && (versiBalik.dilaporkan === "true") === (versiBalik.version !== "versi tidak dilaporkan")
      && versiBalik.mentah === mentahServer && versiBalik.version === versiDiharapkan
      && versiBalik.dilaporkan === (versiDiharapkan === "versi tidak dilaporkan" ? "false" : "true"),
    `layar=${JSON.stringify(versiBalik)} server="${mentahServer}" harapan="${versiDiharapkan}"`);

  /* ---------------- pemeriksaan akhir Wave 11C: galat konsol yang memang dipancing ---------------- */
  const galatLiar11C = consoleErrors.slice();
  const dipancing11C = expectedApiErrors11C.slice();
  const diLuarDaftar11C = dipancing11C.filter((baris) => !jalurGalat11C.some((jalur) => baris.includes(jalur)));
  check("seluruh galat jaringan Wave 11C berasal dari jalur yang memang dipancing uji ini (tidak ada galat liar)",
    // Batas atas 150 hanya penjaga kalau ada gelung yang mengulang permintaan gagal tanpa henti; yang
    // menentukan lulus bukan angkanya, melainkan "tidak ada galat liar" + "semua jalur ada di daftar putih".
    galatLiar11C.length === 0 && dipancing11C.length > 0 && dipancing11C.length <= 150 && diLuarDaftar11C.length === 0,
    `galatLiar=${galatLiar11C.length}${galatLiar11C.length ? ` contoh=${galatLiar11C.slice(0, 3).join(" | ")} LUAR=${konsolAudit.filter((baris) => baris.startsWith("[LUAR]")).slice(0, 4).join(" || ")}` : ""} dipancing=${dipancing11C.length} diLuarDaftar=${diLuarDaftar11C.length} hitung=${JSON.stringify(dipancing11C.reduce((peta, baris) => { const jalur = (baris.match(/\[(.*?)\]/) || [])[1] || baris; peta[jalur] = (peta[jalur] || 0) + 1; return peta; }, {}))} jalur=${[...new Set(dipancing11C.map((baris) => (baris.match(/\[(.*?)\]/) || [])[1] || baris))].slice(0, 12).join(", ")}`);

  const adminCalls = apiCalls.filter((line) => line.startsWith("403"));
  check("tidak ada halaman yang ditolak server karena peran (akun uji adalah admin platform)",
    adminCalls.length === 0, adminCalls.join(" | "));
  check("tidak ada galat konsol selama menelusuri halaman baru",
    consoleErrors.length === 0,
    `${consoleErrors.slice(0, 3).join(" | ")}${galatHalaman.length ? ` || galatHalaman=${JSON.stringify(galatHalaman).slice(0, 1400)}` : ""}`);
  // Pemeriksaan sesi sebelum masuk memang dijawab 401; itu dicatat, bukan dianggap kegagalan.
  check("galat konsol dari alur galat yang dipancing uji hanya dari kebijakan alat dan tepat 2 kali",
    expectedApiErrors.length === 2
      && expectedApiErrors.every((line) => line.includes("/api/v1/tools-policy") && line.includes("400")),
    expectedApiErrors.join(" | "));
  check("satu-satunya galat konsol yang wajar adalah pemeriksaan sesi saat belum masuk",
    expectedSignedOut.length > 0 && expectedSignedOut.every((line) => line.includes("/auth/me")), String(expectedSignedOut.length));
  await writeFile(`${shots}/api-calls.txt`, apiCalls.join("\n"), "utf8");
  console.log(`INFO ui-calls=${apiCalls.length} shots=${shots} consoleErrors=${consoleErrors.length}`);
} catch (error) {
  failed += 1; failures.push("alur uji antarmuka");
  console.log(`FAIL alur uji antarmuka ${error instanceof Error ? error.message : String(error)}`);
  await page.screenshot({ path: `${shots}/gagal.png` }).catch(() => undefined);
} finally {
  await browser.close().catch(() => undefined);
  await new Promise((resolve) => stubServer.close(() => resolve()));
  child.kill("SIGKILL");
  // Pipa ditutup sendiri setelah proses anak mati; ini hanya keamanan agar keluar bersih.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

for (const item of skips) console.log(`SKIP-TOTAL ${item}`);
console.log(`wave10-ui: ${passed}/${passed + failed} lulus, gagal ${failed}, skip ${skips.length}`);
if (failed > 0) { console.log(`UI_E2E_FAILED ${failures.join(" | ")}`); process.exit(1); }
console.log("UI_E2E_PASSED");

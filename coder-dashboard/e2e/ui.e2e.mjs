/**
 * Uji antarmuka Wave 10 (butir 22 + 32D) dengan peramban Chromium sungguhan.
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
import { existsSync, mkdirSync } from "node:fs";
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

const port = 7290 + Math.floor(Math.random() * 9);
const dataDir = `/tmp/coder-ui-wave10-${Date.now()}`;
const stamp = Date.now();
const adminEmail = `w10ui-admin-${stamp}@example.test`;
const password = "SandiUji2026!aman";
// Akun peramban ini adalah admin platform, supaya halaman khusus admin juga benar-benar dirender.
// Tanpa pembungkus `npx`: `npx` membuat proses anak lagi, dan proses cucu itu mewarisi pipa
// stdout/stderr sehingga loop peristiwa Node tidak pernah berakhir walau uji sudah selesai
// (gejala nyata 17 Sep 2026: mencetak UI_E2E_PASSED lalu tetap hidup sampai timeout 124).
// Memanggil tsx langsung lewat process.execPath membuat SIGKILL benar-benar menghentikan server.
const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
  cwd: platformDir,
  env: {
    ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
    DATA_DIR: dataDir, PUBLIC_DIR: distDir, MOCK_ENGINE: "true", NOTIFY_EMAIL_ENABLED: "false",
    VERIFY_EMAIL_REQUIRED: "off", PLATFORM_ADMIN_EMAILS: adminEmail,
    METRICS_TOKEN: "ui-wave10-metrics-token", PUSH_ENABLED: "true", DEVICE_TRACKING: "true",
    JOB_WORKER_IN_WEB: "false", PRIME_AGENT_MODEL: "ui-wave10-model",
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
check("server uji hidup dan menyajikan SPA hasil build", healthy, serverLog.join("").slice(-400));
if (!healthy) { child.kill("SIGKILL"); console.log("UI_E2E_FAILED"); process.exit(1); }

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
// Sebelum masuk, server wajar menjawab 401 untuk pemeriksaan sesi. Galat itu dicatat terpisah supaya
// pemeriksaan "tidak ada galat konsol" tidak menyalahkan perilaku yang memang benar.
const expectedSignedOut = [];
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  const url = message.location()?.url ?? "";
  if (/401/.test(text) && url.includes("/auth/me")) expectedSignedOut.push(`${text} ${url.replace(base, "")}`);
  else consoleErrors.push(`${text} [${url.replace(base, "")}]`);
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
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
  check("halaman Metrik menampilkan angka operasional dan versi skema",
    /metrik|skema|angka/i.test(metricsText) && /18/.test(metricsText), metricsText.slice(0, 200));
  check("halaman Metrik menyediakan kotak token untuk /metrics", /token/i.test(metricsText), metricsText.slice(0, 160));

  const growthText = await openPage("Pelengkapan data", "/api/v1/admin/growth/backfill", "Lihat pratinjau");
  check("halaman pelengkapan data menampilkan pratinjau dari tabel asli",
    /pratinjau|backfill|peristiwa/i.test(growthText), growthText.slice(0, 200));

  const webhookText = await openPage("Riwayat webhook");
  check("halaman riwayat webhook menjelaskan aturan urutan pengiriman",
    /urutan|webhook|kirim ulang/i.test(webhookText), webhookText.slice(0, 200));

  const adminCalls = apiCalls.filter((line) => line.startsWith("403"));
  check("tidak ada halaman yang ditolak server karena peran (akun uji adalah admin platform)",
    adminCalls.length === 0, adminCalls.join(" | "));
  check("tidak ada galat konsol selama menelusuri halaman baru",
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  // Pemeriksaan sesi sebelum masuk memang dijawab 401; itu dicatat, bukan dianggap kegagalan.
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
  child.kill("SIGKILL");
  // Pipa ditutup sendiri setelah proses anak mati; ini hanya keamanan agar keluar bersih.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

for (const item of skips) console.log(`SKIP-TOTAL ${item}`);
console.log(`wave10-ui: ${passed}/${passed + failed} lulus, gagal ${failed}, skip ${skips.length}`);
if (failed > 0) { console.log(`UI_E2E_FAILED ${failures.join(" | ")}`); process.exit(1); }
console.log("UI_E2E_PASSED");

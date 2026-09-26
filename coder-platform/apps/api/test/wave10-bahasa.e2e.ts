/**
 * Uji Wave 10 butir 30: keputusan tetap "Bahasa Indonesia saja" benar-benar berlaku.
 *
 * Yang dibuktikan:
 *  1) dokumen keputusan ada dan memuat isi keputusan (tanpa i18n, kode mesin + kalimat Indonesia);
 *  2) rute baru Wave 10 menjawab galat dengan kalimat Indonesia, bukan kode mentah: pencarian,
 *     perangkat, push, dan webhook;
 *  3) aturan umum: setiap `message` adalah kalimat (diakhiri titik), bukan kode HURUF_BESAR,
 *     dan jumlahnya wajar (bukan kosong);
 *  4) pengecualian yang disengaja: `GET /metrics` tanpa token menjawab kode tanpa pesan.
 *
 * Jalankan: npx tsx apps/api/test/wave10-bahasa.e2e.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const port = 7220 + Math.floor(Math.random() * 10); // rentang khusus suite ini: 7220-7229
const dataDir = `/tmp/coder-wave10-bahasa-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const adminEmail = `w10bahasa-admin-${stamp}@example.test`;
const ownerEmail = `w10bahasa-owner-${stamp}@example.test`;
const password = "SandiUji2026!aman";

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "wave10-bahasa-model";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.VERIFY_EMAIL_REQUIRED = "off";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_IN_WEB = "false";
process.env.PUSH_ENABLED = "true";
process.env.METRICS_TOKEN = `w10bahasa-metrics-${stamp}`;

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 800));
const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0; let skipped = 0;
const failedNames: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
/**
 * Satu-satunya jalan melewati pemeriksaan. Ringkasan berkas ini dulu mencetak `skip=0` secara
 * HARFIAH, jadi pemeriksaan yang dilewati tidak akan terlihat sama sekali. Sekarang jumlahnya
 * dihitung sungguhan dan dilaporkan juga sebagai `SKIP-TOTAL`.
 */
function skip(name: string, reason: string) { skipped += 1; console.log(`SKIP ${name} · ${reason}`); }

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
      return { status: response.status, json, text };
    },
  };
}

/** Kalimat Indonesia yang bisa dibaca: ada huruf, ada spasi, diakhiri titik, bukan kode mesin. */
function kalimatIndonesia(nilai: unknown): boolean {
  const teks = String(nilai ?? "");
  if (teks.length < 10) return false;
  if (!/^[A-Z]/.test(teks)) return false;
  if (!teks.includes(" ")) return false;
  if (!teks.endsWith(".")) return false;
  if (/^[A-Z_]+$/.test(teks)) return false;
  return /[a-z]{3,}/.test(teks);
}

const admin = client(); const owner = client();
const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Bahasa Wave 10" });
const ownerReg = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Bahasa Wave 10" });
check("akun uji terdaftar", adminReg.status === 201 && ownerReg.status === 201 && Boolean(ownerReg.json?.workspace?.id), `${adminReg.status}/${ownerReg.status}`);

// ------------------------------------------------------------------ 1) dokumen keputusan
const docPath = fileURLToPath(new URL("../../../docs/KEPUTUSAN_BAHASA_INDONESIA.md", import.meta.url));
const doc = readFileSync(docPath, "utf8");
check("1) dokumen keputusan bahasa ada dan memuat keputusan tanpa i18n",
  doc.includes("Tidak ada i18n") && doc.includes("Indonesia saja") && doc.includes("NOT_FOUND") && doc.includes("error` = kode mesin"),
  `${doc.length} bita`);
check("1) dokumen menyebut uji penjaganya", doc.includes("wave10-bahasa.e2e.ts"), "");

// ------------------------------------------------------------------ 2) rute baru Wave 10
const jawaban: { path: string; status: number; error: string; message: unknown }[] = [];
const pendek = await owner.call("GET", "/api/v1/search?q=a");
jawaban.push({ path: "search q=1 huruf", status: pendek.status, error: String(pendek.json?.error), message: pendek.json?.message });
check("2) kata kunci terlalu pendek dijawab 400 dengan kalimat Indonesia",
  pendek.status === 400 && pendek.json?.error === "SEARCH_QUERY_TOO_SHORT" && kalimatIndonesia(pendek.json?.message), JSON.stringify(pendek.json)?.slice(0, 160));

const panjang = await owner.call("GET", `/api/v1/search?q=${"a".repeat(201)}`);
jawaban.push({ path: "search q=201 huruf", status: panjang.status, error: String(panjang.json?.error), message: panjang.json?.message });
check("2) kata kunci terlalu panjang dijawab 400 dengan kalimat Indonesia",
  panjang.status === 400 && panjang.json?.error === "SEARCH_QUERY_TOO_LONG" && kalimatIndonesia(panjang.json?.message), JSON.stringify(panjang.json)?.slice(0, 160));

const label = await owner.call("PATCH", "/api/v1/account/devices/tidak-ada", { label: "x".repeat(80) });
jawaban.push({ path: "perangkat tidak ada", status: label.status, error: String(label.json?.error), message: label.json?.message });
check("2) perangkat yang tidak ada dijawab 404 dengan kalimat Indonesia",
  label.status === 404 && label.json?.error === "DEVICE_NOT_FOUND" && kalimatIndonesia(label.json?.message), JSON.stringify(label.json)?.slice(0, 160));

const perangkat = await owner.call("GET", "/api/v1/account/devices");
check("2) daftar perangkat memuat catatan berbahasa Indonesia",
  perangkat.status === 200 && kalimatIndonesia(perangkat.json?.note), JSON.stringify(perangkat.json)?.slice(0, 120));

const push = await owner.call("POST", "/api/v1/account/push/subscribe", { endpoint: "http://bukan-https", keys: { p256dh: "", auth: "" } });
jawaban.push({ path: "langganan push tidak lengkap", status: push.status, error: String(push.json?.error), message: push.json?.message });
check("2) langganan push yang tidak lengkap dijawab 400 dengan kalimat Indonesia",
  push.status === 400 && push.json?.error === "INVALID_SUBSCRIPTION" && kalimatIndonesia(push.json?.message), JSON.stringify(push.json)?.slice(0, 160));

const hook = await owner.call("GET", `/api/v1/webhooks/${crypto.randomUUID()}/deliveries`);
jawaban.push({ path: "webhook tidak ada", status: hook.status, error: String(hook.json?.error), message: hook.json?.message });
check("2) webhook yang tidak ada dijawab 404 dengan kalimat Indonesia",
  hook.status === 404 && String(hook.json?.error ?? "").startsWith("WEBHOOK") && kalimatIndonesia(hook.json?.message), JSON.stringify(hook.json)?.slice(0, 160));

// ------------------------------------------------------------------ 3) aturan umum
// Penjaga panjang (sejenis temuan B9 di wave11c-bayar): dua saringan di bawah memakai `.filter()`,
// jadi daftar `jawaban` yang kosong akan lulus tanpa membuktikan apa pun. Jumlahnya diperiksa dulu.
check("3) daftar jawaban yang disaring tidak kosong (penjaga anti-lulus-vakum)", jawaban.length >= 5, `jumlah=${jawaban.length}`);
const tanpaPesan = jawaban.filter((item) => !kalimatIndonesia(item.message));
check("3) semua jawaban galat rute baru memakai kalimat Indonesia",
  tanpaPesan.length === 0, JSON.stringify(tanpaPesan).slice(0, 300));

const kodeMentah = jawaban.filter((item) => String(item.message).trim() === item.error);
check("3) tidak ada `message` yang hanya mengulang kode mesin", kodeMentah.length === 0, JSON.stringify(kodeMentah).slice(0, 240));

const kodeTerpakai = jawaban.map((item) => item.error);
check("3) kode mesin tetap stabil dan huruf besar bergaris bawah",
  kodeTerpakai.length >= 5 && kodeTerpakai.every((kode) => /^[A-Z][A-Z_]+$/.test(kode)), JSON.stringify(kodeTerpakai));

// ------------------------------------------------------------------ 4) pengecualian yang disengaja
const metrik = await admin.call("GET", "/metrics");
check("4) /metrics tanpa token menjawab 404 tanpa pesan (keberadaan rute disembunyikan)",
  metrik.status === 404 && metrik.json?.error === "NOT_FOUND" && metrik.json?.message === undefined,
  JSON.stringify(metrik.json)?.slice(0, 120));
const metrikBenar = await admin.call("GET", `/metrics?token=${process.env.METRICS_TOKEN}`);
// Rute /metrics menyusun teksnya sendiri (angka total), jadi yang diperiksa cukup bentuk Prometheus.
check("4) /metrics dengan token menjawab teks Prometheus, bukan galat",
  metrikBenar.status === 200 && /^# HELP /m.test(metrikBenar.text) && /coder_schema_version/.test(metrikBenar.text), metrikBenar.text.slice(0, 80));

// ------------------------------------------------------------------ ringkasan
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped}`);
if (skipped > 0) console.log(`SKIP-TOTAL ${skipped}`);
console.log(`RINGKASAN: ${passed}/${passed + failed} lulus`);
if (failed === 0) {
  console.log("ALL_WAVE10_BAHASA_TESTS_PASSED");
  process.exit(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
process.exit(1);

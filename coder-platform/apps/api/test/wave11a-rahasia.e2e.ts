/**
 * Uji Wave 11A (v0.21.0) butir 43, 44, dan 53 — rahasia pengguna, isolasi kredensial per run,
 * dan audit-diri admin.
 *
 * Yang dibuktikan:
 *  §1 Modul `secrets.ts` (butir 43): bolak-balik segel/buka AES-256-GCM, IV acak (ciphertext berubah
 *     walau nilai sama), tag GCM menolak ciphertext/tag yang diubah dan kunci yang berbeda, kunci
 *     absen/salah -> `SECRETS_KEY_MISSING`, nilai lama tanpa segel tetap terbaca, `maskSecret` tidak
 *     membocorkan rahasia pendek.
 *  §2 Rute rahasia (butir 43): PUT menyimpan terenkripsi, GET hanya nama/label/ekor, galat 400/404/503,
 *     baris basis data tidak memuat teks polos, audit tidak memuat nilai, ekspor data pengguna tidak
 *     memuat nilai rahasia, dan dua pengguna terisolasi.
 *  §3 `run-secret-vault.ts` (butir 44): env per run saja, `process.env` global tidak pernah tersentuh,
 *     dua run bersamaan tidak saling melihat, pengguna lain tidak muncul, sewa bersih setelah rilis
 *     termasuk saat run gagal, dan kegagalan kunci tidak meninggalkan sewa.
 *  §4 Audit-diri (butir 53): laporan 10 pemeriksaan, jujur saat ada temuan (baris belum tersegel, bocor
 *     ke catatan audit, sewa menggantung, retensi mati, izin folder longgar), tidak pernah memuat nilai
 *     rahasia, admin saja.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11a-rahasia.e2e.ts
 *
 * Catatan pilihan uji kunci: `secrets.ts` membaca `process.env.SECRETS_KEY` pada saat dipakai (bukan
 * disalin saat modul dimuat). Karena itu jalur "kunci absen / kunci salah" bisa diuji di proses yang
 * sama dengan mengubah variabel lingkungan lalu mengembalikannya. Sebagai bukti tambahan, satu
 * pemeriksaan menjalankan proses anak TANPA `SECRETS_KEY` sama sekali (proses terpisah, modul dimuat
 * dari nol) dan memeriksa ulang `secretsKeyState()` + kode galatnya.
 *
 * Catatan jujur: berkas ini hanya menambah berkas uji baru + berkas milik butir 43/44/53; tidak ada
 * berkas agen lain yang diubah. Bagian yang sengaja tidak diuji di sini dicetak sebagai SKIP.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mencari port bebas di rentang Wave 11A (7240-7269); nomor utama dicoba lebih dulu.
 *
 * Pemeriksaan ini ditambahkan setelah suite pemimpin gagal palsu ketika ada server uji lain yang
 * masih memegang port: server baru tidak bisa mengikat port, lalu permintaan uji nyasar ke server
 * lama (yang tidak tahu variabel lingkungan milik proses ini).
 */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 40 }, () => 7240 + Math.floor(Math.random() * 30))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang Wave 11A (7240-7269): ada server uji yang belum keluar?");
}

const port = await cariPortBebas(7241); // rentang Wave 11A 7240-7269
const dataDir = `/tmp/coder-wave11a-cred-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11a-admin-${stamp}@example.test`;
const aliceEmail = `w11a-alice-${stamp}@example.test`;
const bobEmail = `w11a-bob-${stamp}@example.test`;

// Kunci induk uji: 32 byte base64 yang sah, dan kunci lain yang juga sah (untuk membuktikan
// ciphertext tidak bisa dibuka dengan kunci berbeda).
const goodKey = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

const plainAlice = "sk-rahasia-uji-1234567890";        // 23 karakter, ekor harus "…7890"
const plainBob = "token-bob-abcdefgh";                 // ekor "…efgh"
const plainLegacy = "token-lama-tanpa-segel-123456";   // ekor "…3456"
const plainShort = "rahasia7";                         // 8 karakter -> ekor "…sia7"
const plainTiny = "pndk7";                             // 5 karakter -> ekor dikosongkan
const marker = "enc:v1:";
const plainLong = "x".repeat(4096);                    // tepat di batas, harus diterima

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.SECRETS_KEY = goodKey;

const startedAtMs = Date.now();
await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const secretsMod: any = await import("../src/secrets.js");
const vaultMod: any = await import("../src/run-secret-vault.js");
const selfauditMod: any = await import("../src/selfaudit.js");
const config = (await import("../src/config.js")).config;

const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
/** Ringkasan pendek untuk pesan gagal. Nilai rahasia tidak pernah dimasukkan ke sini. */
const short = (value: unknown, max = 200) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
/** True bila teks memuat sebuah nilai rahasia. Hanya hasil boolean yang dicetak. */
const memuat = (text: string, value: string) => String(text).includes(value);
const countRows = (sql: string, ...params: unknown[]) => Number(((db.prepare(sql).get(...(params as never[])) as { n?: number } | undefined)?.n) ?? 0);

type Profile = { ua?: string; deviceId?: string; lang?: string };

/** Klien HTTP kecil dengan jar cookie sendiri + token CSRF ganda (sama seperti suite Wave 10). */
function client(profile: Profile = {}) {
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
      ...(profile.ua ? { "user-agent": profile.ua } : {}),
      ...(profile.deviceId ? { "x-device-id": profile.deviceId } : {}),
      ...(profile.lang ? { "accept-language": profile.lang } : {}),
      ...extra,
    };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const rawCookies = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of rawCookies) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim();
      const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const text = await response.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server uji belum siap */ } }
  return { call, jar, get csrf() { return String(jar.get("coder_csrf") ?? ""); }, async bootstrap() { return prime(); } };
}

// Akun: admin platform (dari PLATFORM_ADMIN_EMAILS), dua pengguna pemilik rahasia, dan klien tanpa sesi.
const admin = client({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0", deviceId: "w11a-admin", lang: "id-ID" });
const alice = client({ ua: "Mozilla/5.0 (X11; Linux x86_64) Firefox/122.0", deviceId: "w11a-alice", lang: "id-ID" });
const bob = client({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15", deviceId: "w11a-bob", lang: "id-ID" });
const anon = client();

for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const ready = await fetch(`${base}/health`); if (ready.ok) break; } catch { /* belum siap */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), data di ${dataDir}`);

// =====================================================================================
// Bagian 0: akun dasar.
// =====================================================================================
console.log("\n--- Bagian 0: akun uji ---");
await admin.bootstrap();
const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Wave 11A" });
check("0.1 akun admin platform terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.user?.id), `${adminReg.status} ${short(adminReg.json)}`);
const adminUserId = String(adminReg.json?.user?.id ?? "");

await alice.bootstrap();
const aliceReg = await alice.call("POST", "/api/v1/auth/register", { email: aliceEmail, password, displayName: "Alice Wave 11A" });
check("0.2 akun alice terdaftar", aliceReg.status === 201 && Boolean(aliceReg.json?.user?.id), `${aliceReg.status}`);
const aliceUserId = String(aliceReg.json?.user?.id ?? "");

await bob.bootstrap();
const bobReg = await bob.call("POST", "/api/v1/auth/register", { email: bobEmail, password, displayName: "Bob Wave 11A" });
check("0.3 akun bob terdaftar", bobReg.status === 201 && Boolean(bobReg.json?.user?.id), `${bobReg.status}`);
const bobUserId = String(bobReg.json?.user?.id ?? "");

// =====================================================================================
// Bagian 1 (butir 43): modul enkripsi rahasia.
// =====================================================================================
console.log("\n--- Bagian 1 (butir 43): modul secrets.ts ---");

check("1.1 penanda segel versi 1 = enc:v1:", secretsMod.sealedPrefix === marker, short(secretsMod.sealedPrefix));
check("1.2 isSealed hanya benar untuk teks berpenanda",
  secretsMod.isSealed(`${marker}aaa`) === true && secretsMod.isSealed("teks-polos") === false && secretsMod.isSealed(12345) === false && secretsMod.isSealed(null) === false);

const sealedAlice = String(secretsMod.sealSecret(plainAlice));
const bagian = sealedAlice.slice(marker.length).split(":");
check("1.3 bentuk segel = enc:v1:<iv>:<tag>:<cipher> (base64)",
  sealedAlice.startsWith(marker) && bagian.length === 3
  && Buffer.from(bagian[0], "base64").length === 12 && Buffer.from(bagian[1], "base64").length === 16 && Buffer.from(bagian[2], "base64").length > 0,
  short({ iv: Buffer.from(bagian[0] ?? "", "base64").length, tag: Buffer.from(bagian[1] ?? "", "base64").length, cipher: Buffer.from(bagian[2] ?? "", "base64").length }));
check("1.4 buka(segel(nilai)) = nilai asli", secretsMod.openSecret(sealedAlice) === plainAlice);
check("1.5 ciphertext tidak memuat teks asli", !memuat(sealedAlice, plainAlice));

const sealedAlice2 = String(secretsMod.sealSecret(plainAlice));
const bagian2 = sealedAlice2.slice(marker.length).split(":");
check("1.6 IV acak: dua segel nilai sama -> ciphertext BERBEDA",
  sealedAlice2 !== sealedAlice && bagian2[0] !== bagian[0] && bagian2[2] !== bagian[2],
  short({ ivSama: bagian2[0] === bagian[0], cipherSama: bagian2[2] === bagian[2] }));
check("1.7 kedua segel membuka nilai yang sama", secretsMod.openSecret(sealedAlice2) === plainAlice);

/** Menyegel ulang dengan isi rusak: ciphertext diubah, tag diubah. Hasilnya harus ditolak GCM. */
async function codeOf(run: () => unknown): Promise<string> {
  try { run(); return "tidak-melempar"; } catch (error: any) { return String(error?.code ?? error?.name ?? error); }
}
const cipherRusak = `${marker}${bagian[0]}:${bagian[1]}:${Buffer.from(Buffer.from(bagian[2], "base64").map((byte, index) => (index === 0 ? byte ^ 0xff : byte))).toString("base64")}`;
check("1.8 ciphertext diubah -> SECRET_DECRYPT_FAILED", (await codeOf(() => secretsMod.openSecret(cipherRusak))) === "SECRET_DECRYPT_FAILED");
const tagRusak = `${marker}${bagian[0]}:${Buffer.from(Buffer.alloc(16, 9)).toString("base64")}:${bagian[2]}`;
check("1.9 tag GCM diubah -> SECRET_DECRYPT_FAILED", (await codeOf(() => secretsMod.openSecret(tagRusak))) === "SECRET_DECRYPT_FAILED");
check("1.10 bentuk segel dipotong -> SECRET_DECRYPT_FAILED", (await codeOf(() => secretsMod.openSecret(`${marker}aaa:bbb`))) === "SECRET_DECRYPT_FAILED");

// Kunci lain yang juga sah: segel lama tidak bisa dibuka, dan bukan galat "kunci hilang".
process.env.SECRETS_KEY = otherKey;
check("1.11 kunci berbeda (sah) -> SECRET_DECRYPT_FAILED", (await codeOf(() => secretsMod.openSecret(sealedAlice))) === "SECRET_DECRYPT_FAILED");
check("1.12 nilai WARISAN tanpa segel tetap terbaca walau kunci berbeda", secretsMod.openSecret(plainLegacy) === plainLegacy);
process.env.SECRETS_KEY = goodKey;

check("1.13 maskSecret: ekor 4 karakter terakhir untuk nilai panjang",
  secretsMod.maskSecret(plainAlice).terpasang === true && secretsMod.maskSecret(plainAlice).ekor === "…7890" && secretsMod.maskSecret(plainBob).ekor === "…efgh",
  short(secretsMod.maskSecret(plainAlice)));
check("1.14 maskSecret: nilai ≤ 7 karakter ekornya dikosongkan",
  secretsMod.maskSecret(plainTiny).ekor === "" && secretsMod.maskSecret(plainShort).ekor === "…sia7",
  short({ tiny: secretsMod.maskSecret(plainTiny).ekor, delapan: secretsMod.maskSecret(plainShort).ekor }));
check("1.15 maskSecret tidak pernah memuat nilai utuh", !memuat(JSON.stringify(secretsMod.maskSecret(plainAlice)), plainAlice));

check("1.16 secretsKeyState = ok saat kunci 32 byte base64 sah", secretsMod.secretsKeyState() === "ok", short(secretsMod.secretsKeyState()));
process.env.SECRETS_KEY = "bukan-base64!!";
check("1.17 secretsKeyState = invalid saat kunci ada tapi tidak sah", secretsMod.secretsKeyState() === "invalid", short(secretsMod.secretsKeyState()));
check("1.18 kunci tidak sah -> sealSecret melempar SECRETS_KEY_MISSING", (await codeOf(() => secretsMod.sealSecret("apa saja"))) === "SECRETS_KEY_MISSING");
process.env.SECRETS_KEY = "";
check("1.19 secretsKeyState = missing saat kunci kosong", secretsMod.secretsKeyState() === "missing", short(secretsMod.secretsKeyState()));
check("1.20 kunci kosong -> sealSecret melempar SECRETS_KEY_MISSING", (await codeOf(() => secretsMod.sealSecret("apa saja"))) === "SECRETS_KEY_MISSING");
check("1.21 kunci kosong -> nilai tersegel tidak dibuka", (await codeOf(() => secretsMod.openSecret(sealedAlice))) === "SECRETS_KEY_MISSING");
process.env.SECRETS_KEY = goodKey;

const panjangSegel = String(secretsMod.sealSecret(plainLong));
check("1.22 nilai 4096 karakter (batas) tersegel dan terbuka lagi",
  secretsMod.openSecret(panjangSegel).length === 4096 && secretsMod.openSecret(panjangSegel) === plainLong);
check("1.23 nilai 4097 karakter ditolak modul", (await codeOf(() => secretsMod.sealSecret("y".repeat(4097)))) === "RangeError");
check("1.24 tryOpenSecret melaporkan kegagalan tanpa melempar",
  secretsMod.tryOpenSecret(cipherRusak).ok === false && secretsMod.tryOpenSecret(cipherRusak).code === "SECRET_DECRYPT_FAILED"
  && secretsMod.tryOpenSecret(sealedAlice).ok === true && secretsMod.tryOpenSecret(sealedAlice).value === plainAlice);

// Proses ANAK tanpa SECRETS_KEY sama sekali: modul dimuat dari nol di proses terpisah.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const secretsSourcePath = fileURLToPath(new URL("../src/secrets.ts", import.meta.url));
if (existsSync(tsxBin)) {
  mkdirSync(dataDir, { recursive: true });
  const probePath = join(dataDir, "probe-tanpa-kunci.mts");
  writeFileSync(probePath, [
    `import * as mod from ${JSON.stringify(secretsSourcePath)};`,
    "const hasil: Record<string, unknown> = { state: mod.secretsKeyState() };",
    "try { mod.sealSecret(\"abc\"); hasil.seal = \"tidak-melempar\"; } catch (error: any) { hasil.seal = error?.code ?? String(error); }",
    `try { mod.openSecret(mod.sealedPrefix + "aaaa:bbbb:cccc"); hasil.open = "tidak-melempar"; } catch (error: any) { hasil.open = error?.code ?? String(error); }`,
    "console.log(\"PROBE \" + JSON.stringify(hasil));",
  ].join("\n"), "utf8");
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string" && key !== "SECRETS_KEY") childEnv[key] = value;
  const child = spawnSync(process.execPath, [tsxBin, probePath], { cwd: repoRoot, env: childEnv, encoding: "utf8", timeout: 90_000 });
  const line = String(child.stdout ?? "").split("\n").find((entry) => entry.startsWith("PROBE "));
  let hasil: any = null; try { hasil = line ? JSON.parse(line.slice(6)) : null; } catch { hasil = null; }
  check("1.25 proses anak tanpa SECRETS_KEY: state missing, segel & buka melempar SECRETS_KEY_MISSING",
    hasil?.state === "missing" && hasil?.seal === "SECRETS_KEY_MISSING" && hasil?.open === "SECRETS_KEY_MISSING",
    short({ hasil, stderr: String(child.stderr ?? "").slice(0, 120) }));
} else {
  skip("1.25 proses anak tanpa SECRETS_KEY", `binari tsx tidak ada di ${tsxBin}`);
}

// =====================================================================================
// Bagian 2 (butir 43): rute rahasia pengguna — simpan, daftar, galat, isolasi, ekspor.
// =====================================================================================
console.log("\n--- Bagian 2 (butir 43): rute /api/v1/account/secrets ---");

const put1 = await alice.call("PUT", "/api/v1/account/secrets/openai_key", { value: plainAlice, label: "Kunci OpenAI" });
check("2.1 PUT menyimpan rahasia (201) dan menjawab nama/label/ekor tanpa nilai",
  put1.status === 201 && put1.json?.secret?.name === "openai_key" && put1.json?.secret?.label === "Kunci OpenAI"
  && put1.json?.secret?.terpasang === true && put1.json?.secret?.ekor === "…7890" && put1.json?.secret?.tersegel === true,
  short({ status: put1.status, secret: put1.json?.secret }));
check("2.2 jawaban PUT tidak memuat nilai asli", !memuat(put1.text, plainAlice));

const rowAlice = db.prepare("SELECT id, secret_ciphertext AS stored, label FROM user_secrets WHERE user_id=? AND name=?").get(aliceUserId, "openai_key") as any;
check("2.3 baris basis data tersegel versi 1", String(rowAlice?.stored ?? "").startsWith(marker));
check("2.4 baris basis data tidak memuat teks asli", !memuat(String(rowAlice?.stored ?? ""), plainAlice) && !memuat(JSON.stringify(rowAlice ?? {}), plainAlice));
check("2.5 seluruh tabel rahasia bebas teks polos",
  countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE secret_ciphertext NOT LIKE ?", `${marker}%`) === 0);

const list1 = await alice.call("GET", "/api/v1/account/secrets");
const entry1 = ((list1.json?.secrets ?? []) as any[]).find((item) => item.name === "openai_key");
check("2.6 GET daftar: nama, label, terpasang, ekor, tersegel, updatedAt",
  list1.status === 200 && Boolean(entry1) && entry1.label === "Kunci OpenAI" && entry1.terpasang === true
  && entry1.ekor === "…7890" && entry1.tersegel === true && typeof entry1.updatedAt === "string" && entry1.updatedAt.length >= 10,
  short({ status: list1.status, entry: entry1 }));
check("2.7 jawaban GET daftar tidak memuat nilai asli maupun ciphertext",
  !memuat(list1.text, plainAlice) && !memuat(list1.text, String(rowAlice?.stored ?? "x")));
check("2.8 GET daftar melaporkan keadaan kunci dan batas panjang",
  list1.json?.kunci === "ok" && Number(list1.json?.batasKarakter) === 4096, short({ kunci: list1.json?.kunci, batas: list1.json?.batasKarakter }));

const kosong = await alice.call("PUT", "/api/v1/account/secrets/kosong_uji", { value: "" });
const spasi = await alice.call("PUT", "/api/v1/account/secrets/spasi_uji", { value: "   " });
const angka = await alice.call("PUT", "/api/v1/account/secrets/angka_uji", { value: 12345 });
check("2.9 nilai kosong / hanya spasi / bukan teks -> 400 INVALID_SECRET_VALUE",
  [kosong, spasi, angka].every((reply) => reply.status === 400 && reply.json?.error === "INVALID_SECRET_VALUE"),
  short([kosong.status, spasi.status, angka.status]));

const namaSalah = ["KunciBesar", "kunci-besar", "a".repeat(41), "kunci besar"];
const jawabNama: any[] = [];
for (const name of namaSalah) jawabNama.push(await alice.call("PUT", `/api/v1/account/secrets/${encodeURIComponent(name)}`, { value: "nilai-uji-panjang" }));
check("2.10 nama tidak sah (huruf besar, tanda hubung, >40, spasi) -> 400 INVALID_SECRET_NAME",
  jawabNama.every((reply) => reply.status === 400 && reply.json?.error === "INVALID_SECRET_NAME"),
  short(jawabNama.map((reply) => reply.status)));

const terlaluPanjang = await alice.call("PUT", "/api/v1/account/secrets/panjang_uji", { value: "z".repeat(4097) });
check("2.11 nilai 4097 karakter -> 400 SECRET_TOO_LONG", terlaluPanjang.status === 400 && terlaluPanjang.json?.error === "SECRET_TOO_LONG", `${terlaluPanjang.status} ${short(terlaluPanjang.json?.error)}`);
const batas = await alice.call("PUT", "/api/v1/account/secrets/batas_uji", { value: plainLong });
check("2.12 nilai tepat 4096 karakter diterima (201) dengan ekor benar", batas.status === 201 && batas.json?.secret?.ekor === "…xxxx", `${batas.status} ${short(batas.json?.secret?.ekor)}`);
const hapusBatas = await alice.call("DELETE", "/api/v1/account/secrets/batas_uji");
check("2.13 DELETE menghapus barisnya dari basis data",
  hapusBatas.status === 200 && hapusBatas.json?.deleted === true && countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE user_id=? AND name=?", aliceUserId, "batas_uji") === 0,
  `${hapusBatas.status} ${short(hapusBatas.json)}`);
const hapusHilang = await alice.call("DELETE", "/api/v1/account/secrets/tidak_ada_sama_sekali");
check("2.14 DELETE nama yang tidak ada -> 404 SECRET_NOT_FOUND", hapusHilang.status === 404 && hapusHilang.json?.error === "SECRET_NOT_FOUND");
check("2.15 permintaan yang ditolak tidak membuat baris apa pun",
  countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE user_id=?", aliceUserId) === 1,
  short(countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE user_id=?", aliceUserId)));

const up1 = await alice.call("PUT", "/api/v1/account/secrets/ganti_uji", { value: "nilai-pertama-abcdefgh", label: "Pertama" });
const stored1 = String((db.prepare("SELECT secret_ciphertext AS stored FROM user_secrets WHERE user_id=? AND name=?").get(aliceUserId, "ganti_uji") as any)?.stored ?? "");
const up2 = await alice.call("PUT", "/api/v1/account/secrets/ganti_uji", { value: "nilai-kedua-ijklmnop" });
const stored2 = String((db.prepare("SELECT secret_ciphertext AS stored FROM user_secrets WHERE user_id=? AND name=?").get(aliceUserId, "ganti_uji") as any)?.stored ?? "");
check("2.16 PUT kedua mengganti nilai (ciphertext berubah, tetap satu baris)",
  up1.status === 201 && up2.status === 200 && stored2 !== stored1 && stored1 !== ""
  && countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE user_id=? AND name=?", aliceUserId, "ganti_uji") === 1,
  short({ pertama: up1.status, kedua: up2.status }));
check("2.17 label lama dipertahankan saat PUT kedua tanpa label, ekor ikut nilai baru",
  up2.json?.secret?.label === "Pertama" && up2.json?.secret?.ekor === "…mnop", short(up2.json?.secret));
check("2.18 nilai pertama tidak bisa lagi dibuka dari baris baru", secretsMod.openSecret(stored2) === "nilai-kedua-ijklmnop");
check("2.19 jawaban PUT kedua tidak memuat nilai baru maupun lama",
  !memuat(up2.text, "nilai-kedua-ijklmnop") && !memuat(up2.text, "nilai-pertama-abcdefgh"));

const tiny = await alice.call("PUT", "/api/v1/account/secrets/rahasia_pendek", { value: plainTiny });
check("2.20 nilai 5 karakter: ekor dikosongkan dan nilai tidak muncul di jawaban",
  tiny.status === 201 && tiny.json?.secret?.ekor === "" && !memuat(tiny.text, plainTiny), short({ status: tiny.status, ekor: tiny.json?.secret?.ekor }));

// -------------------------------------------------------------------- isolasi antar pengguna
const bobPut = await bob.call("PUT", "/api/v1/account/secrets/bob_token", { value: plainBob });
check("2.21 bob menyimpan rahasianya sendiri (ekor benar)", bobPut.status === 201 && bobPut.json?.secret?.ekor === "…efgh");
const bobList = await bob.call("GET", "/api/v1/account/secrets");
const aliceList = await alice.call("GET", "/api/v1/account/secrets");
check("2.22 daftar bob hanya memuat rahasia bob",
  bobList.status === 200 && ((bobList.json?.secrets ?? []) as any[]).length === 1 && bobList.json.secrets[0].name === "bob_token",
  short((bobList.json?.secrets ?? []).map((item: any) => item.name)));
check("2.23 daftar alice tidak memuat rahasia bob", !memuat(aliceList.text, "bob_token") && !memuat(aliceList.text, plainBob));
check("2.24 daftar bob tidak memuat rahasia alice", !memuat(bobList.text, "openai_key") && !memuat(bobList.text, plainAlice));
const bobSame = await bob.call("PUT", "/api/v1/account/secrets/openai_key", { value: "nilai-bob-yang-lain" });
const aliceOpenai = db.prepare("SELECT secret_ciphertext AS stored FROM user_secrets WHERE user_id=? AND name=?").get(aliceUserId, "openai_key") as any;
check("2.25 nama sama di akun berbeda tidak saling menimpa",
  bobSame.status === 201 && String(aliceOpenai?.stored ?? "") === String(rowAlice?.stored ?? "") && secretsMod.openSecret(String(aliceOpenai?.stored ?? "")) === plainAlice);

// ---------------------------------------------------------- data warisan (tanpa segel) di DB
const legacyId = `w11a-legacy-${stamp}`;
const nowIso = new Date().toISOString();
db.prepare("INSERT INTO user_secrets (id,user_id,name,label,secret_ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
  .run(legacyId, bobUserId, "legacy_token", "Data lama", plainLegacy, nowIso, nowIso);
const bobListLegacy = await bob.call("GET", "/api/v1/account/secrets");
const legacyEntry = ((bobListLegacy.json?.secrets ?? []) as any[]).find((item) => item.name === "legacy_token");
check("2.26 baris warisan tanpa segel tetap dilayani (tersegel: false, ekor benar)",
  Boolean(legacyEntry) && legacyEntry.tersegel === false && legacyEntry.terpasang === true && legacyEntry.ekor === "…3456" && legacyEntry.bisaDibuka === true,
  short(legacyEntry));
check("2.27 daftar tetap tidak membocorkan nilai warisan", !memuat(bobListLegacy.text, plainLegacy));
check("2.28 nilai warisan bisa dipakai run (dibaca apa adanya)",
  secretsMod.openSecret(plainLegacy) === plainLegacy
  && countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE secret_ciphertext NOT LIKE ?", `${marker}%`) === 1);

// ------------------------------------------------------------------ ekspor data pengguna
const exportCreate = await alice.call("POST", "/api/v1/account/export");
const exportId = String(exportCreate.json?.export?.id ?? "");
check("2.29 ekspor data akun dibuat (201)", exportCreate.status === 201 && Boolean(exportId), `${exportCreate.status} ${short(exportCreate.json?.error)}`);
const exportGet = await alice.call("GET", `/api/v1/account/exports/${exportId}/download`);
check("2.30 berkas ekspor tidak memuat nilai rahasia alice",
  exportGet.status === 200 && !memuat(exportGet.text, plainAlice) && !memuat(exportGet.text, "nilai-kedua-ijklmnop") && !memuat(exportGet.text, plainTiny),
  `${exportGet.status} ${short(exportGet.text.length)}`);
check("2.31 berkas ekspor tidak memuat ciphertext tersegel", !memuat(exportGet.text, marker) && !memuat(exportGet.text, String(rowAlice?.stored ?? "x")));
const privacy = await alice.call("GET", "/api/v1/account/privacy");
check("2.32 halaman privasi juga bebas nilai rahasia", privacy.status === 200 && !memuat(privacy.text, plainAlice) && !memuat(privacy.text, marker));

// ----------------------------------------------------------------- kunci absen (503) saat menulis
process.env.SECRETS_KEY = "";
const putNoKey = await alice.call("PUT", "/api/v1/account/secrets/kunci_hilang_uji", { value: "nilai-baru-abcdefgh" });
check("2.33 tanpa SECRETS_KEY -> PUT 503 SECRETS_KEY_MISSING",
  putNoKey.status === 503 && putNoKey.json?.error === "SECRETS_KEY_MISSING" && String(putNoKey.json?.message ?? "").includes("belum dikonfigurasi"),
  `${putNoKey.status} ${short(putNoKey.json)}`);
check("2.34 tanpa kunci tidak ada baris baru dan tidak ada teks polos",
  countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE name=?", "kunci_hilang_uji") === 0
  && countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE secret_ciphertext LIKE ?", "%nilai-baru-abcdefgh%") === 0);
const listNoKey = await alice.call("GET", "/api/v1/account/secrets");
check("2.35 tanpa kunci daftar tetap terbaca dan jujur (kunci: missing, ekor kosong)",
  listNoKey.status === 200 && listNoKey.json?.kunci === "missing"
  && ((listNoKey.json?.secrets ?? []) as any[]).every((item) => item.ekor === "" && item.bisaDibuka === false),
  short({ status: listNoKey.status, kunci: listNoKey.json?.kunci }));
const hapusTanpaKunci = await alice.call("DELETE", "/api/v1/account/secrets/ganti_uji");
check("2.36 DELETE bekerja tanpa kunci dan barisnya benar-benar hilang",
  hapusTanpaKunci.status === 200 && countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE user_id=? AND name=?", aliceUserId, "ganti_uji") === 0);
process.env.SECRETS_KEY = goodKey;
check("2.37 kunci dikembalikan: daftar sehat lagi",
  (await alice.call("GET", "/api/v1/account/secrets")).json?.kunci === "ok");

// ----------------------------------------------------------------------- catatan audit
const auditRows = db.prepare("SELECT action, metadata_json AS metadata FROM audit_events WHERE actor_user_id=? AND action LIKE 'account.secret%'").all(aliceUserId) as Array<{ action: string; metadata: string }>;
check("2.38 audit mencatat tindakan rahasia (nama + panjang), tanpa nilai",
  auditRows.length >= 4 && auditRows.some((row) => row.action === "account.secret.created") && auditRows.some((row) => row.action === "account.secret.deleted")
  && auditRows.every((row) => !memuat(row.metadata, plainAlice) && !memuat(row.metadata, "nilai-kedua-ijklmnop") && !memuat(row.metadata, marker)),
  short(auditRows.map((row) => row.action)));
check("2.39 tidak ada nilai rahasia maupun penanda segel di seluruh catatan audit",
  countRows("SELECT COUNT(*) AS n FROM audit_events WHERE instr(metadata_json, ?) > 0", plainAlice) === 0
  && countRows("SELECT COUNT(*) AS n FROM audit_events WHERE instr(metadata_json, ?) > 0", marker) === 0);
check("2.40 sisa rahasia alice tepat dua (openai_key, rahasia_pendek)",
  countRows("SELECT COUNT(*) AS n FROM user_secrets WHERE user_id=?", aliceUserId) === 2);

// =====================================================================================
// Bagian 3 (butir 44): sewa rahasia per run — isolasi hanya lewat env proses anak.
// =====================================================================================
console.log("\n--- Bagian 3 (butir 44): run-secret-vault.ts ---");

const envA = await vaultMod.acquireRunSecretEnv(aliceUserId, "run-a1");
check("3.1 sewa alice menghasilkan CODER_SECRET_<NAMA> untuk rahasia alice saja",
  envA.CODER_SECRET_OPENAI_KEY === plainAlice && envA.CODER_SECRET_RAHASIA_PENDEK === plainTiny
  && Object.keys(envA).sort().join(",") === "CODER_SECRET_OPENAI_KEY,CODER_SECRET_RAHASIA_PENDEK",
  short(Object.keys(envA)));
check("3.2 env run alice tidak memuat rahasia bob", envA.CODER_SECRET_BOB_TOKEN === undefined && envA.CODER_SECRET_LEGACY_TOKEN === undefined);
check("3.3 rahasia tidak pernah masuk process.env global",
  !Object.keys(process.env).some((key) => key.startsWith("CODER_SECRET_")) && process.env.CODER_SECRET_OPENAI_KEY === undefined);

const envB = await vaultMod.acquireRunSecretEnv(bobUserId, "run-b1");
// Bob juga menyimpan nama `openai_key` (uji 2.25), jadi nama yang sama boleh muncul di dua run.
// Yang wajib terpisah adalah NILAI-nya: env bob tidak boleh memuat nilai milik alice, dan sebaliknya.
check("3.4 sewa bob menghasilkan env bob saja (termasuk openai_key versi bob)",
  envB.CODER_SECRET_BOB_TOKEN === plainBob && envB.CODER_SECRET_OPENAI_KEY === "nilai-bob-yang-lain"
  && Object.keys(envB).sort().join(",") === "CODER_SECRET_BOB_TOKEN,CODER_SECRET_LEGACY_TOKEN,CODER_SECRET_OPENAI_KEY"
  && !Object.values(envB).includes(plainAlice),
  short(Object.keys(envB)));
check("3.5 dua run bersamaan tidak saling melihat rahasia (nama sama, nilai terpisah)",
  !Object.values(envB).includes(plainAlice) && !Object.values(envA).includes(plainBob)
  && envA.CODER_SECRET_BOB_TOKEN === undefined && envA.CODER_SECRET_LEGACY_TOKEN === undefined
  && envB.CODER_SECRET_RAHASIA_PENDEK === undefined);
check("3.6 rahasia warisan (tanpa segel) tetap sampai ke env run", envB.CODER_SECRET_LEGACY_TOKEN === plainLegacy);

const leaseList = vaultMod.activeSecretLeases();
check("3.7 daftar sewa memuat bentuk {runId,userId,names,at}",
  Array.isArray(leaseList) && leaseList.length === 2
  && leaseList.every((lease: any) => typeof lease.runId === "string" && typeof lease.userId === "string" && Array.isArray(lease.names) && typeof lease.at === "string"),
  short(leaseList.map((lease: any) => `${lease.runId}:${lease.names.length}`)));
check("3.8 daftar sewa tidak memuat nilai rahasia",
  !memuat(JSON.stringify(leaseList), plainAlice) && !memuat(JSON.stringify(leaseList), plainBob) && !memuat(JSON.stringify(leaseList), plainLegacy));
const envCopy = vaultMod.secretEnvForLease("run-a1");
envCopy.CODER_SECRET_OPENAI_KEY = "diubah-di-salinan";
check("3.9 secretEnvForLease mengembalikan salinan (sewa tidak ikut berubah)", vaultMod.secretEnvForLease("run-a1").CODER_SECRET_OPENAI_KEY === plainAlice);
envA.CODER_SECRET_OPENAI_KEY = "diubah-di-objek-hasil";
check("3.10 objek hasil acquire juga salinan", vaultMod.secretEnvForLease("run-a1").CODER_SECRET_OPENAI_KEY === plainAlice);

check("3.11 releaseRunSecrets melepas sewa alice saja, sewa bob tetap hidup",
  vaultMod.releaseRunSecrets("run-a1") === true && Object.keys(vaultMod.secretEnvForLease("run-a1")).length === 0
  && vaultMod.activeSecretLeases().some((lease: any) => lease.runId === "run-b1")
  && !vaultMod.activeSecretLeases().some((lease: any) => lease.runId === "run-a1"));
check("3.12 melepas sewa yang sudah lepas tidak menghapus apa pun", vaultMod.releaseRunSecrets("run-a1") === false);
check("3.13 setelah rilis, env siap pakai run itu kosong", Object.keys(vaultMod.secretEnvForLease("run-a1")).length === 0);

let pesanGagal = "";
try {
  await vaultMod.acquireRunSecretEnv(aliceUserId, "run-gagal");
  throw new Error("mesin run meledak");
} catch (error: any) {
  pesanGagal = String(error?.message ?? error);
} finally {
  vaultMod.releaseRunSecrets("run-gagal");
}
check("3.14 run gagal (lewat finally) tetap membersihkan sewa",
  pesanGagal === "mesin run meledak" && Object.keys(vaultMod.secretEnvForLease("run-gagal")).length === 0
  && !vaultMod.activeSecretLeases().some((lease: any) => lease.runId === "run-gagal"));

let galatPembungkus = "";
try {
  await vaultMod.withRunSecretEnv(aliceUserId, "run-bungkus", async (env: Record<string, string>) => {
    if (env.CODER_SECRET_OPENAI_KEY !== plainAlice) throw new Error("env tidak sampai ke pekerjaan");
    throw new Error("gagal di dalam pekerjaan");
  });
} catch (error: any) {
  galatPembungkus = String(error?.message ?? error);
}
check("3.15 withRunSecretEnv meneruskan galat dan tetap melepas sewa",
  galatPembungkus === "gagal di dalam pekerjaan" && Object.keys(vaultMod.secretEnvForLease("run-bungkus")).length === 0);

await vaultMod.acquireRunSecretEnv(aliceUserId, "run-tabrakan");
const envTabrakan = await vaultMod.acquireRunSecretEnv(bobUserId, "run-tabrakan");
check("3.16 runId sama dipakai pengguna lain: sewa terakhir menang, nilai tidak tercampur",
  envTabrakan.CODER_SECRET_OPENAI_KEY === "nilai-bob-yang-lain" && envTabrakan.CODER_SECRET_BOB_TOKEN === plainBob
  && envTabrakan.CODER_SECRET_RAHASIA_PENDEK === undefined && !Object.values(envTabrakan).includes(plainAlice)
  && vaultMod.secretEnvForLease("run-tabrakan").CODER_SECRET_OPENAI_KEY === "nilai-bob-yang-lain");
vaultMod.releaseRunSecrets("run-tabrakan");

process.env.SECRETS_KEY = "";
let kodeAcquire = "tidak-melempar";
try { await vaultMod.acquireRunSecretEnv(aliceUserId, "run-tanpa-kunci"); } catch (error: any) { kodeAcquire = String(error?.code ?? error); }
check("3.17 sewa tanpa SECRETS_KEY melempar SECRETS_KEY_MISSING", kodeAcquire === "SECRETS_KEY_MISSING", short(kodeAcquire));
check("3.18 sewa yang gagal tidak meninggalkan jejak sewa",
  Object.keys(vaultMod.secretEnvForLease("run-tanpa-kunci")).length === 0
  && !vaultMod.activeSecretLeases().some((lease: any) => lease.runId === "run-tanpa-kunci"));
process.env.SECRETS_KEY = goodKey;

const envKosong = await vaultMod.acquireRunSecretEnv(adminUserId, "run-bersih");
check("3.19 pengguna tanpa rahasia mendapat env kosong (bukan galat)", Object.keys(envKosong).length === 0 && typeof envKosong === "object");
const sebelumStale = vaultMod.activeSecretLeases().length;
const dilepasStale = vaultMod.releaseStaleRunSecrets(new Date(Date.now() + 2 * 60 * 60 * 1000));
check("3.20 releaseStaleRunSecrets melepas sewa yang menggantung",
  sebelumStale >= 2 && dilepasStale === sebelumStale && vaultMod.activeSecretLeases().length === 0,
  short({ sebelumStale, dilepasStale }));

// =====================================================================================
// Bagian 4 (butir 53): audit-diri kredensial + konfigurasi.
// =====================================================================================
console.log("\n--- Bagian 4 (butir 53): /api/v1/admin/self-audit ---");

const pick = (reply: any, id: string) => ((reply?.json?.checks ?? []) as any[]).find((entry) => entry.id === id);
const pickReport = (report: any, id: string) => ((report?.checks ?? []) as any[]).find((entry) => entry.id === id);
const SEBELUM_AUDIT_SEWA = countRows("SELECT COUNT(*) AS n FROM user_secrets");
const SEBELUM_AUDIT_CATATAN = countRows("SELECT COUNT(*) AS n FROM audit_events");

const audit1 = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.1 admin platform mendapat laporan audit-diri", audit1.status === 200 && Array.isArray(audit1.json?.checks), `${audit1.status} ${short(audit1.json?.error)}`);
check("4.2 laporan memuat paling sedikit 7 pemeriksaan (nyata: 10)",
  (audit1.json?.checks ?? []).length >= 7, short((audit1.json?.checks ?? []).length));
check("4.3 setiap pemeriksaan punya id, judul, status ok|warn|fail, dan catatan",
  ((audit1.json?.checks ?? []) as any[]).every((entry) => typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.judul === "string" && entry.judul.length > 0 && ["ok", "warn", "fail"].includes(entry.status)
    && typeof entry.catatan === "string" && entry.catatan.length > 0),
  short((audit1.json?.checks ?? []).map((entry: any) => `${entry.id}:${entry.status}`)));
check("4.4 ringkasan cocok dengan hitungan nyata",
  Number(audit1.json?.ringkasan?.ok) + Number(audit1.json?.ringkasan?.warn) + Number(audit1.json?.ringkasan?.fail) === (audit1.json?.checks ?? []).length
  && Number(audit1.json?.ringkasan?.ok) === (audit1.json?.checks ?? []).filter((entry: any) => entry.status === "ok").length
  && Number(audit1.json?.ringkasan?.fail) === (audit1.json?.checks ?? []).filter((entry: any) => entry.status === "fail").length,
  short(audit1.json?.ringkasan));
check("4.5 laporan (dan catatannya) tidak memuat nilai rahasia maupun penanda segel",
  !memuat(audit1.text, plainAlice) && !memuat(audit1.text, plainBob) && !memuat(audit1.text, plainLegacy) && !memuat(audit1.text, marker));
check("4.6 laporan memuat cap waktu ranAt yang sah", typeof audit1.json?.ranAt === "string" && audit1.json.ranAt.length >= 20, short(audit1.json?.ranAt));

check("4.7 temuan nyata dilaporkan apa adanya: baris warisan belum tersegel -> fail",
  pick(audit1, "secrets_tersegel")?.status === "fail" && memuat(String(pick(audit1, "secrets_tersegel")?.catatan ?? ""), "1 baris belum tersegel (teks polos)"),
  short(pick(audit1, "secrets_tersegel")));
const jumlahRahasia = countRows("SELECT COUNT(*) AS n FROM user_secrets");
const jumlahPenggunaRahasia = countRows("SELECT COUNT(DISTINCT user_id) AS n FROM user_secrets");
check("4.8 jumlah rahasia dilaporkan tanpa nilai (angka cocok dengan basis data)",
  memuat(String(pick(audit1, "ringkasan_rahasia")?.catatan ?? ""), `${jumlahRahasia} baris rahasia milik ${jumlahPenggunaRahasia} pengguna`)
  && memuat(String(pick(audit1, "ringkasan_rahasia")?.catatan ?? ""), "1 belum tersegel"),
  short({ catatan: pick(audit1, "ringkasan_rahasia")?.catatan, jumlahRahasia, jumlahPenggunaRahasia }));
check("4.9 kunci induk sehat -> ok", pick(audit1, "secrets_key")?.status === "ok", short(pick(audit1, "secrets_key")));
check("4.10 catatan audit bersih -> ok", pick(audit1, "audit_bebas_rahasia")?.status === "ok", short(pick(audit1, "audit_bebas_rahasia")));
check("4.11 penanda segel hanya di kolom rahasia -> ok", pick(audit1, "segel_hanya_di_tabel_rahasia")?.status === "ok", short(pick(audit1, "segel_hanya_di_tabel_rahasia")));
check("4.12 basis data & folder data -> ok",
  pick(audit1, "basis_data")?.status === "ok" && pick(audit1, "izin_folder_data")?.status === "ok",
  short([pick(audit1, "basis_data")?.status, pick(audit1, "izin_folder_data")?.status]));
check("4.13 retensi mati dilaporkan warn (tidak dipaksa ok)", pick(audit1, "retensi_aktif")?.status === "warn", short(pick(audit1, "retensi_aktif")));
check("4.14 CSP mengikuti konfigurasi yang berlaku", pick(audit1, "csp_aktif")?.status === (config.CSP_ENABLED ? "ok" : "warn"), short(pick(audit1, "csp_aktif")));
check("4.15 sewa rahasia dilaporkan (tidak ada yang menggantung)", pick(audit1, "sewa_rahasia")?.status === "ok", short(pick(audit1, "sewa_rahasia")));

const auditAlice = await alice.call("GET", "/api/v1/admin/self-audit");
check("4.16 bukan admin -> 403 ADMIN_REQUIRED", auditAlice.status === 403 && auditAlice.json?.error === "ADMIN_REQUIRED", `${auditAlice.status} ${short(auditAlice.json)}`);
const auditAnon = await anon.call("GET", "/api/v1/admin/self-audit");
check("4.17 tanpa sesi -> 401 AUTH_REQUIRED", auditAnon.status === 401 && auditAnon.json?.error === "AUTH_REQUIRED", `${auditAnon.status} ${short(auditAnon.json)}`);

// --------------------------------------------- laporan mengikuti konfigurasi yang berubah
const retentionAwal = config.RETENTION_ENABLED; const dryRunAwal = config.RETENTION_DRY_RUN;
config.RETENTION_ENABLED = true; config.RETENTION_DRY_RUN = true;
const auditRetensi = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.18 retensi dinyalakan -> ok (mode kering disebut)",
  pick(auditRetensi, "retensi_aktif")?.status === "ok" && memuat(String(pick(auditRetensi, "retensi_aktif")?.catatan ?? ""), "mode kering"),
  short(pick(auditRetensi, "retensi_aktif")));
config.RETENTION_ENABLED = retentionAwal; config.RETENTION_DRY_RUN = dryRunAwal;
check("4.19 retensi dikembalikan ke mati -> warn lagi", pick(await admin.call("GET", "/api/v1/admin/self-audit"), "retensi_aktif")?.status === "warn");

const cspAwal = config.CSP_ENABLED;
config.CSP_ENABLED = false;
const auditCsp = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.20 CSP dimatikan -> warn", pick(auditCsp, "csp_aktif")?.status === "warn" && memuat(String(pick(auditCsp, "csp_aktif")?.catatan ?? ""), "CSP_ENABLED mati"), short(pick(auditCsp, "csp_aktif")));
config.CSP_ENABLED = cspAwal;
check("4.21 CSP dikembalikan -> ok", pick(await admin.call("GET", "/api/v1/admin/self-audit"), "csp_aktif")?.status === "ok");

const modeAwal = statSync(dataDir).mode & 0o777;
chmodSync(dataDir, 0o777);
const auditTerbuka = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.22 folder data dapat ditulis siapa saja -> warn",
  pick(auditTerbuka, "izin_folder_data")?.status === "warn" && memuat(String(pick(auditTerbuka, "izin_folder_data")?.catatan ?? ""), "dapat ditulis siapa saja"),
  short(pick(auditTerbuka, "izin_folder_data")?.catatan));
chmodSync(dataDir, modeAwal);
check("4.23 izin folder dikembalikan -> ok", pick(await admin.call("GET", "/api/v1/admin/self-audit"), "izin_folder_data")?.status === "ok");

// --------------------------------------------- sewa menggantung (waktu uji dimajukan)
await vaultMod.acquireRunSecretEnv(aliceUserId, "run-lama");
check("4.24 sewa yang masih segar -> ok", pickReport(selfauditMod.runSelfAudit(), "sewa_rahasia")?.status === "ok");
const auditMasaDepan = selfauditMod.runSelfAudit(new Date(Date.now() + 2 * 60 * 60 * 1000));
check("4.25 sewa lebih tua dari 1 jam -> warn",
  pickReport(auditMasaDepan, "sewa_rahasia")?.status === "warn" && memuat(String(pickReport(auditMasaDepan, "sewa_rahasia")?.catatan ?? ""), "lebih tua dari 1 jam"),
  short(pickReport(auditMasaDepan, "sewa_rahasia")));
vaultMod.releaseRunSecrets("run-lama");
check("4.26 sewa dilepas lagi -> ok", pickReport(selfauditMod.runSelfAudit(), "sewa_rahasia")?.status === "ok");

// ------------------- temuan yang disuntikkan langsung lewat basis data (bukan lewat API)
const targetRow = db.prepare("SELECT id, secret_ciphertext AS stored FROM user_secrets WHERE user_id=? AND name=?").get(aliceUserId, "openai_key") as any;
db.prepare("UPDATE user_secrets SET secret_ciphertext=? WHERE id=?").run(plainAlice, targetRow.id);
const auditRusak = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.27 baris yang dirusak uji terdeteksi: bertambah jadi 2 baris belum tersegel -> fail",
  pick(auditRusak, "secrets_tersegel")?.status === "fail" && memuat(String(pick(auditRusak, "secrets_tersegel")?.catatan ?? ""), "2 baris belum tersegel"),
  short(pick(auditRusak, "secrets_tersegel")));
check("4.28 laporan tetap tidak memuat nilai rahasia walau ada temuan",
  !memuat(auditRusak.text, plainAlice) && !memuat(auditRusak.text, plainBob) && !memuat(auditRusak.text, plainLegacy) && !memuat(auditRusak.text, marker));
check("4.29 ringkasan jujur: ada fail, bukan selalu ok",
  Number(auditRusak.json?.ringkasan?.fail) >= 1 && Number(auditRusak.json?.ringkasan?.ok) >= 1, short(auditRusak.json?.ringkasan));
db.prepare("UPDATE user_secrets SET secret_ciphertext=? WHERE id=?").run(String(targetRow.stored), targetRow.id);
check("4.30 baris dikembalikan tersegel oleh uji",
  String((db.prepare("SELECT secret_ciphertext AS stored FROM user_secrets WHERE id=?").get(targetRow.id) as any)?.stored ?? "").startsWith(marker));
// Baris warisan dari uji 2.26 memang masih ada, jadi statusnya kembali "fail" dengan hitungan 1.
const auditPulih = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.31 temuan buatan uji hilang lagi (kembali ke 1 baris warisan saja)",
  pick(auditPulih, "secrets_tersegel")?.status === "fail"
  && memuat(String(pick(auditPulih, "secrets_tersegel")?.catatan ?? ""), "1 baris belum tersegel (teks polos) dari"),
  short(pick(auditPulih, "secrets_tersegel")));

const leakId = `w11a-leak-${stamp}`;
const leakValueId = `w11a-leak-nilai-${stamp}`;
db.prepare("INSERT INTO audit_events (id,workspace_id,actor_user_id,action,metadata_json,created_at) VALUES (?,?,?,?,?,?)")
  .run(leakId, null, aliceUserId, "w11a.uji.bocor", JSON.stringify({ catatan: `${marker}aaaa:bbbb:cccc` }), new Date().toISOString());
db.prepare("INSERT INTO audit_events (id,workspace_id,actor_user_id,action,metadata_json,created_at) VALUES (?,?,?,?,?,?)")
  .run(leakValueId, null, aliceUserId, "w11a.uji.bocor.nilai", JSON.stringify({ rahasia: plainAlice }), new Date().toISOString());
const auditBocor = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.32 rahasia bocor ke catatan audit terdeteksi -> fail",
  pick(auditBocor, "audit_bebas_rahasia")?.status === "fail" && memuat(String(pick(auditBocor, "audit_bebas_rahasia")?.catatan ?? ""), "baris audit memuat"),
  short(pick(auditBocor, "audit_bebas_rahasia")));
check("4.33 penanda segel di kolom lain (audit_events.metadata_json) terdeteksi -> fail",
  pick(auditBocor, "segel_hanya_di_tabel_rahasia")?.status === "fail" && memuat(String(pick(auditBocor, "segel_hanya_di_tabel_rahasia")?.catatan ?? ""), "audit_events"),
  short(pick(auditBocor, "segel_hanya_di_tabel_rahasia")?.catatan));
check("4.34 laporan yang gagal pun tidak memuat nilai rahasia atau potongan ciphertext",
  !memuat(auditBocor.text, plainAlice) && !memuat(auditBocor.text, "aaaa:bbbb") && !memuat(auditBocor.text, marker));
db.prepare("DELETE FROM audit_events WHERE id IN (?,?)").run(leakId, leakValueId);
check("4.35 setelah baris buatan dihapus, kedua pemeriksaan kembali ok",
  pick(await admin.call("GET", "/api/v1/admin/self-audit"), "audit_bebas_rahasia")?.status === "ok"
  && pick(await admin.call("GET", "/api/v1/admin/self-audit"), "segel_hanya_di_tabel_rahasia")?.status === "ok");

process.env.SECRETS_KEY = "";
const auditTanpaKunci = await admin.call("GET", "/api/v1/admin/self-audit");
check("4.36 tanpa SECRETS_KEY: pemeriksaan kunci fail (jujur, bukan ok)",
  pick(auditTanpaKunci, "secrets_key")?.status === "fail" && memuat(String(pick(auditTanpaKunci, "secrets_key")?.catatan ?? ""), "503"), short(pick(auditTanpaKunci, "secrets_key")));
process.env.SECRETS_KEY = goodKey;
check("4.37 kunci dikembalikan: pemeriksaan kunci ok lagi", pick(await admin.call("GET", "/api/v1/admin/self-audit"), "secrets_key")?.status === "ok");

// Audit-diri harus benar-benar hanya membaca.
selfauditMod.runSelfAudit();
selfauditMod.runSelfAudit();
check("4.38 audit-diri hanya membaca: jumlah baris rahasia & catatan audit tidak berubah",
  countRows("SELECT COUNT(*) AS n FROM user_secrets") === SEBELUM_AUDIT_SEWA && countRows("SELECT COUNT(*) AS n FROM audit_events") === SEBELUM_AUDIT_CATATAN,
  short({ rahasia: [SEBELUM_AUDIT_SEWA, countRows("SELECT COUNT(*) AS n FROM user_secrets")], catatan: [SEBELUM_AUDIT_CATATAN, countRows("SELECT COUNT(*) AS n FROM audit_events")] }));

// Header CSP sungguhan dipasang modul CSP (butir 79, slice agen lain). Kalau belum ada, dicatat
// sebagai SKIP dengan sebabnya, bukan digagalkan di suite ini.
const health = await fetch(`${base}/health`);
const headerCsp = health.headers.get("content-security-policy");
if (headerCsp) check("4.39 header CSP benar-benar terpasang di jawaban HTTP", headerCsp.length > 10, short(headerCsp.slice(0, 40)));
else skip("4.39 header CSP di jawaban HTTP", "belum terpasang pada branch ini (modul CSP butir 79 diisi agen lain); audit-diri hanya memeriksa config.CSP_ENABLED");

// =====================================================================================
// Ringkasan.
// =====================================================================================
console.log("");
if (skipped.length) {
  console.log(`SKIP ${skipped.length} pemeriksaan:`);
  for (const entry of skipped) console.log(`  - ${entry}`);
} else {
  console.log("Tidak ada pemeriksaan yang di-skip.");
}
if (failedNames.length) {
  console.log(`GAGAL ${failed} pemeriksaan:`);
  for (const name of failedNames) console.log(`  - ${name}`);
}
const total = passed + failed;
console.log(`${passed}/${total} lulus`);
console.log(`INFO durasi uji ${Math.round((Date.now() - startedAtMs) / 1000)} detik, data uji di ${dataDir}`);
process.exit(failed === 0 ? 0 : 1);

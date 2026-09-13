/**
 * E2E: cookie CSRF (coder_csrf), hook onRequest CSRF, dan rate limit per IP.
 * Jalankan: npx tsx apps/api/test/csrf-limits.e2e.ts
 *
 * Pola bootstrap meniru session-usage.e2e.ts: variabel env diset SEBELUM modul
 * server/config diimpor, karena config.ts (CSRF_STRICT) dan ratelimit.ts (batas)
 * membaca env saat impor. Server tidak mengekspor `app`, jadi suite ini memakai
 * HTTP ke 127.0.0.1 (bukan app.inject). DB memakai file sementara sendiri.
 *
 * Batas rate limit di suite ini dikecilkan lewat env supaya cepat diuji:
 *   RATE_LIMIT_REGISTER_PER_HOUR=3, RATE_LIMIT_PASSWORD_PER_HOUR=3.
 * Angka default produksi tidak diubah oleh suite ini.
 */
const port = 3900 + Math.floor(Math.random() * 500); // hindari tabrakan dengan port tetap suite lain (3424-3460)
const dataDir = `/tmp/coder-csrf-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
process.env.NODE_ENV = "test";
process.env.CSRF_STRICT = "true";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PRIME_AGENT_MODEL = "test-model";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "3";
process.env.RATE_LIMIT_PASSWORD_PER_HOUR = "3";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "10";
process.env.RATE_LIMIT_API_PER_MINUTE = "2";

await import("../src/server.js");

const base = `http://127.0.0.1:${port}`;

/** Batas yang dipakai suite ini (dibaca server dari env di atas). */
const REGISTER_LIMIT = 3;
const PASSWORD_LIMIT = 3;
/** auth.ts masih memakai angka tetap 10 percobaan / 15 menit per IP+email. */
const LOGIN_LIMIT = 10;

/** Token tetap: cookie dan header harus sama persis (double submit). */
const TOKEN = "csrf-test-token-aaaaaaaaaaaaaaaaaaaaaaaa";

let attempts = 0;
let readinessAttempts = 0;
const passed: string[] = [];
const failed: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed.push(name);
  else failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` :: ${detail}`}`);
}

type Reply = { status: number; body: string; json: any; setCookies: string[] };

/** Satu permintaan HTTP; setiap panggilan dihitung sebagai satu percobaan. */
async function send(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  attempts += 1;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.text();
  const raw = typeof (response.headers as any).getSetCookie === "function"
    ? ((response.headers as any).getSetCookie() as string[])
    : [response.headers.get("set-cookie")];
  let json: any = null;
  try { json = body ? JSON.parse(body) : null; } catch { json = body; }
  return { status: response.status, body, json, setCookies: raw.filter((line): line is string => Boolean(line)) };
}

/** Nilai satu cookie dari daftar Set-Cookie. */
function cookieValue(setCookies: string[], name: string): string | undefined {
  const line = setCookies.find((item) => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(";")[0] : undefined;
}

/** Atribut satu cookie (tanpa nilai) untuk pemeriksaan bendera keamanan. */
function cookieLine(setCookies: string[], name: string): string {
  return setCookies.find((item) => item.startsWith(`${name}=`)) ?? "";
}

/** Header CSRF: cookie publik + header harus identik. */
function csrf(token = TOKEN, ip?: string): Record<string, string> {
  return {
    cookie: `coder_csrf=${token}`,
    "x-csrf-token": token,
    ...(ip ? { "x-forwarded-for": ip } : {}),
  };
}

/** Menunggu server siap; respons 200 pertama dipakai sebagai bukti cek (a). */
async function waitForFirstHealth(): Promise<Reply> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    readinessAttempts += 1;
    try {
      const reply = await send("GET", "/health");
      if (reply.status === 200) return reply;
    } catch { /* server belum menerima koneksi */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server tidak siap setelah 15 detik");
}

const loginBody = { email: "tidak-ada@example.test", password: "Rahasia12345!" };

// ---------------------------------------------------------------- (a) cookie
const firstHealth = await waitForFirstHealth();
const firstLine = cookieLine(firstHealth.setCookies, "coder_csrf");
const firstToken = cookieValue(firstHealth.setCookies, "coder_csrf") ?? "";
check("(a1) respons pertama GET /health menyetel cookie coder_csrf", Boolean(firstToken), `set-cookie=${JSON.stringify(firstHealth.setCookies)}`);
check("(a2) atribut cookie: Max-Age 30 hari, SameSite=Lax, Path=/, bukan HttpOnly",
  /Max-Age=2592000/i.test(firstLine) && /SameSite=Lax/i.test(firstLine) && /Path=\//i.test(firstLine) && !/HttpOnly/i.test(firstLine),
  firstLine);
check("(a3) nilai token acak cukup panjang (>= 32 karakter)", firstToken.length >= 32, `panjang=${firstToken.length}`);

// Klien yang sudah membawa cookie tidak boleh ditimpa nilai baru.
const healthWithCookie = await send("GET", "/health", { headers: { cookie: `coder_csrf=${firstToken}` } });
const rewritten = cookieValue(healthWithCookie.setCookies, "coder_csrf");
check("(a4) respons berikutnya tidak mengganti cookie yang sudah dikirim klien", rewritten === undefined || rewritten === firstToken, `nilai baru=${rewritten ?? "(tidak ada set-cookie)"}`);

// Cookie juga diset pada endpoint lain saat cookie belum ada.
const meNoCookie = await send("GET", "/api/v1/auth/me");
check("(a5) endpoint lain (GET /api/v1/auth/me) juga menyetel coder_csrf bila belum ada",
  meNoCookie.status === 401 && Boolean(cookieValue(meNoCookie.setCookies, "coder_csrf")), `${meNoCookie.status} ${JSON.stringify(meNoCookie.setCookies)}`);

// ------------------------------------------------------------- (b)(c)(d) token
const loginNoToken = await send("POST", "/api/v1/auth/login", { body: loginBody });
check("(b) POST /api/v1/auth/login tanpa x-csrf-token -> 403 CSRF_TOKEN_REQUIRED",
  loginNoToken.status === 403 && loginNoToken.json?.error === "CSRF_TOKEN_REQUIRED", `${loginNoToken.status} ${loginNoToken.body.slice(0, 120)}`);

const loginWrongToken = await send("POST", "/api/v1/auth/login", { headers: { cookie: `coder_csrf=${TOKEN}`, "x-csrf-token": `${TOKEN}-beda` }, body: loginBody });
check("(c) x-csrf-token tidak sama dengan cookie -> 403 CSRF_TOKEN_REQUIRED",
  loginWrongToken.status === 403 && loginWrongToken.json?.error === "CSRF_TOKEN_REQUIRED", `${loginWrongToken.status} ${loginWrongToken.body.slice(0, 120)}`);

const loginHeaderOnly = await send("POST", "/api/v1/auth/login", { headers: { "x-csrf-token": TOKEN }, body: loginBody });
check("(c2) header benar tanpa cookie coder_csrf -> 403 CSRF_TOKEN_REQUIRED",
  loginHeaderOnly.status === 403 && loginHeaderOnly.json?.error === "CSRF_TOKEN_REQUIRED", `${loginHeaderOnly.status} ${loginHeaderOnly.body.slice(0, 120)}`);

const loginOkToken = await send("POST", "/api/v1/auth/login", { headers: csrf(), body: loginBody });
check(`(d) token cocok -> lolos lapisan CSRF (bukan 403), dapat ${loginOkToken.status}`,
  loginOkToken.status !== 403 && loginOkToken.json?.error !== "CSRF_TOKEN_REQUIRED", `${loginOkToken.status} ${loginOkToken.body.slice(0, 120)}`);

// -------------------------------------------------------------- (e)(f) origin
const loginCrossSite = await send("POST", "/api/v1/auth/login", { headers: { ...csrf(), origin: "https://jahat.example", "sec-fetch-site": "cross-site" }, body: loginBody });
check("(e) origin lain + sec-fetch-site cross-site -> 403 CSRF_BLOCKED walau token benar",
  loginCrossSite.status === 403 && loginCrossSite.json?.error === "CSRF_BLOCKED", `${loginCrossSite.status} ${loginCrossSite.body.slice(0, 140)}`);

const loginSameOrigin = await send("POST", "/api/v1/auth/login", { headers: { ...csrf(), origin: "https://jahat.example", "sec-fetch-site": "same-origin" }, body: loginBody });
check("(f) sec-fetch-site same-origin -> bukan 403 CSRF_BLOCKED",
  loginSameOrigin.json?.error !== "CSRF_BLOCKED", `${loginSameOrigin.status} ${loginSameOrigin.body.slice(0, 140)}`);

const loginOriginOnly = await send("POST", "/api/v1/auth/login", { headers: { ...csrf(), origin: "https://jahat.example" }, body: loginBody });
check("(f2) origin host lain tanpa sec-fetch-site -> 403 CSRF_BLOCKED",
  loginOriginOnly.status === 403 && loginOriginOnly.json?.error === "CSRF_BLOCKED", `${loginOriginOnly.status} ${loginOriginOnly.body.slice(0, 140)}`);

// ------------------------------------------------------------------- (g) safe
const healthNoToken = await send("GET", "/health");
check("(g) GET /health tanpa token tetap 200", healthNoToken.status === 200, String(healthNoToken.status));

// ------------------------------------------------- (h) register: 3 lalu ke-4
const registerIp = "198.51.100.201";
const registerStatuses: number[] = [];
for (let index = 1; index <= REGISTER_LIMIT; index += 1) {
  const reply = await send("POST", "/api/v1/auth/register", {
    headers: csrf(TOKEN, registerIp),
    body: { email: `csrf-register-${Date.now()}-${index}@example.test`, password: "Register12345!", displayName: `Csrf ${index}` },
  });
  registerStatuses.push(reply.status);
}
check(`(h1) register ${REGISTER_LIMIT} kali dari IP sama semuanya 201`, registerStatuses.every((status) => status === 201), JSON.stringify(registerStatuses));
const registerBlocked = await send("POST", "/api/v1/auth/register", {
  headers: csrf(TOKEN, registerIp),
  body: { email: `csrf-register-${Date.now()}-x@example.test`, password: "Register12345!", displayName: "Csrf X" },
});
check(`(h2) register ke-${REGISTER_LIMIT + 1} dari IP sama -> 429 RATE_LIMITED`,
  registerBlocked.status === 429 && registerBlocked.json?.error === "RATE_LIMITED", `${registerBlocked.status} ${registerBlocked.body.slice(0, 120)}`);
const registerOtherIp = await send("POST", "/api/v1/auth/register", {
  headers: csrf(TOKEN, "198.51.100.209"),
  body: { email: `csrf-register-${Date.now()}-y@example.test`, password: "Register12345!", displayName: "Csrf Y" },
});
check("(h3) IP lain tidak ikut kena batas register", registerOtherIp.status === 201, `${registerOtherIp.status} ${registerOtherIp.body.slice(0, 120)}`);

// ------------------------- (i)(j) forgot + reset berbagi satu limiter "password"
const sharedIp = "198.51.100.202";
const sharedCalls: { label: string; path: string; body: unknown }[] = [
  { label: "forgot#1", path: "/api/v1/auth/password/forgot", body: { email: "tidak-ada@example.test" } },
  { label: "forgot#2", path: "/api/v1/auth/password/forgot", body: { email: "tidak-ada@example.test" } },
  { label: "reset#1", path: "/api/v1/auth/password/reset", body: { token: "token-palsu", password: "Reset12345!" } },
];
const sharedDone: string[] = [];
for (const call of sharedCalls) {
  const reply = await send("POST", call.path, { headers: csrf(TOKEN, sharedIp), body: call.body });
  sharedDone.push(`${call.label}:${reply.status}`);
}
check(`(i+j) forgot+reset berbagi limiter: ${PASSWORD_LIMIT} permintaan pertama (2 forgot + 1 reset) bukan 429`,
  sharedDone.every((entry) => !entry.endsWith(":429")), JSON.stringify(sharedDone));
const sharedBlocked = await send("POST", "/api/v1/auth/password/reset", { headers: csrf(TOKEN, sharedIp), body: { token: "token-palsu", password: "Reset12345!" } });
check(`(i+j2) permintaan ke-${PASSWORD_LIMIT + 1} pada limiter gabungan -> 429 RATE_LIMITED`,
  sharedBlocked.status === 429 && sharedBlocked.json?.error === "RATE_LIMITED", `${sharedBlocked.status} ${sharedBlocked.body.slice(0, 120)}`);

// Batas per endpoint diuji di IP terpisah supaya tidak tercampur.
const forgotIp = "198.51.100.203";
const forgotStatuses: number[] = [];
for (let index = 1; index <= PASSWORD_LIMIT; index += 1) {
  const reply = await send("POST", "/api/v1/auth/password/forgot", { headers: csrf(TOKEN, forgotIp), body: { email: "tidak-ada@example.test" } });
  forgotStatuses.push(reply.status);
}
const forgotBlocked = await send("POST", "/api/v1/auth/password/forgot", { headers: csrf(TOKEN, forgotIp), body: { email: "tidak-ada@example.test" } });
check(`(i) forgot ${PASSWORD_LIMIT} kali dari IP sama bukan 429, ke-${PASSWORD_LIMIT + 1} -> 429`,
  forgotStatuses.every((status) => status === 200) && forgotBlocked.status === 429 && forgotBlocked.json?.error === "RATE_LIMITED",
  `${JSON.stringify(forgotStatuses)} lalu ${forgotBlocked.status} ${forgotBlocked.body.slice(0, 120)}`);

const resetIp = "198.51.100.204";
const resetStatuses: number[] = [];
for (let index = 1; index <= PASSWORD_LIMIT; index += 1) {
  const reply = await send("POST", "/api/v1/auth/password/reset", { headers: csrf(TOKEN, resetIp), body: { token: "token-palsu", password: "Reset12345!" } });
  resetStatuses.push(reply.status);
}
const resetBlocked = await send("POST", "/api/v1/auth/password/reset", { headers: csrf(TOKEN, resetIp), body: { token: "token-palsu", password: "Reset12345!" } });
check(`(j) reset ${PASSWORD_LIMIT} kali dari IP sama bukan 429, ke-${PASSWORD_LIMIT + 1} -> 429`,
  resetStatuses.every((status) => status === 400) && resetBlocked.status === 429 && resetBlocked.json?.error === "RATE_LIMITED",
  `${JSON.stringify(resetStatuses)} lalu ${resetBlocked.status} ${resetBlocked.body.slice(0, 120)}`);

// --------------------------------------------------- (k) login lama: 10 lalu 11
const loginIp = "198.51.100.211";
const loginStatuses: number[] = [];
for (let index = 1; index <= LOGIN_LIMIT; index += 1) {
  const reply = await send("POST", "/api/v1/auth/login", { headers: csrf(TOKEN, loginIp), body: loginBody });
  loginStatuses.push(reply.status);
}
check(`(k1) login gagal ${LOGIN_LIMIT} kali dari IP+email sama tidak ada 429`, loginStatuses.every((status) => status === 401), JSON.stringify(loginStatuses));
const loginBlocked = await send("POST", "/api/v1/auth/login", { headers: csrf(TOKEN, loginIp), body: loginBody });
check(`(k2) login ke-${LOGIN_LIMIT + 1} -> 429 LOGIN_RATE_LIMITED (regresi limiter lama)`,
  loginBlocked.status === 429 && loginBlocked.json?.error === "LOGIN_RATE_LIMITED", `${loginBlocked.status} ${loginBlocked.body.slice(0, 120)}`);

// ------------------------------- tambahan: limiter global /api/* mati saat test
const apiIp = "198.51.100.220";
const apiStatuses: number[] = [];
for (let index = 0; index < 4; index += 1) {
  const reply = await send("GET", "/api/v1/auth/me", { headers: { "x-forwarded-for": apiIp } });
  apiStatuses.push(reply.status);
}
check("(tambahan) limiter global /api/* (RATE_LIMIT_API_PER_MINUTE=2) tidak aktif saat NODE_ENV=test",
  apiStatuses.every((status) => status !== 429), JSON.stringify(apiStatuses));

// ---------------------------------------------------- (l)(m) bukti + hitungan
console.log(`BUKTI cookie coder_csrf dari respons pertama /health (8 karakter pertama): ${firstToken.slice(0, 8)}...`);
console.log(`BUKTI x-csrf-token yang dipakai suite ini (8 karakter pertama): ${TOKEN.slice(0, 8)}...`);

console.log("--- RINGKASAN ---");
console.log(`(m) total percobaan HTTP: ${attempts} (termasuk ${readinessAttempts} percobaan tunggu server)`);
console.log(`cek dijalankan: ${passed.length + failed.length}, lulus: ${passed.length}, gagal: ${failed.length}`);
console.log(`batas yang diuji: register=${REGISTER_LIMIT}/jam (env), forgot+reset berbagi limiter=${PASSWORD_LIMIT}/jam (env), login=${LOGIN_LIMIT}/15 menit (angka tetap di auth.ts)`);

/** Drain stdout lalu keluar dengan kode yang diminta. */
async function finish(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
}

if (failed.length === 0) {
  console.log("ALL_CSRF_LIMIT_TESTS_PASSED");
  await finish(0);
}
for (const name of failed) console.log(`FAILED ${name}`);
await finish(1);

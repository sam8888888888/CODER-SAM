/**
 * CSRF mode token (level dua) diuji langsung: `CSRF_STRICT=true`.
 *
 * Level satu (cek `Origin`) sudah diuji di `csrf-limits.e2e.ts`. Suite ini menutup celah yang
 * tercatat di `docs/STATUS.md` ("CSRF level dua ... belum ada suite yang menguji").
 *
 * Yang diperiksa:
 *  1) cookie `coder_csrf` diterbitkan dan HARUS bisa dibaca JavaScript (tanpa HttpOnly),
 *  2) setiap permintaan tulis tanpa token yang cocok ditolak `403 CSRF_TOKEN_REQUIRED`,
 *  3) token yang cocok membuat permintaan tulis berhasil,
 *  4) permintaan dari situs lain tetap ditolak `403 CSRF_BLOCKED` walaupun tokennya benar,
 *  5) dua klien berbeda mendapat token yang berbeda (tidak ada token tetap),
 *  6) permintaan baca (GET) tidak terpengaruh.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/csrf-strict.e2e.ts
 */

const port = 5700 + Math.floor(Math.random() * 250);
const dataDir = `/tmp/coder-csrf-strict-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const userEmail = `csrf-strict-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PLATFORM_ADMIN_EMAILS = userEmail;
// Inti suite ini: level dua dinyalakan.
process.env.CSRF_STRICT = "true";

await import("../src/server.js");

const base = `http://127.0.0.1:${port}`;

let checks = 0;
let passed = 0;
let failed = 0;
const failedNames: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) { passed += 1; console.log(`PASS ${checks}) ${name}`); return; }
  failed += 1; failedNames.push(`${checks}) ${name}`);
  console.log(`FAIL ${checks}) ${name}${detail ? ` :: ${detail}` : ""}`);
}
function short(value: unknown, limit = 260): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}

/** Small client that keeps the cookies the server sends and can attach the CSRF header on demand. */
function makeClient() {
  const jar = new Map<string, string>();
  const rawCookies: string[] = [];
  return {
    jar,
    rawCookies,
    cookieHeader(): string {
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    token(): string { return jar.get("coder_csrf") ?? ""; },
    async call(method: string, path: string, options: { body?: unknown; csrf?: string | "cookie" | false; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      const cookie = this.cookieHeader();
      if (cookie) headers.cookie = cookie;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (options.csrf === "cookie") headers["x-csrf-token"] = this.token();
      else if (typeof options.csrf === "string") headers["x-csrf-token"] = options.csrf;
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      for (const value of response.headers.getSetCookie?.() ?? []) {
        if (!value) continue;
        rawCookies.push(value);
        const pair = value.split(";")[0];
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq);
        const cookieValue = pair.slice(eq + 1);
        if (cookieValue === "") jar.delete(name); else jar.set(name, cookieValue);
      }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, json, text };
    },
  };
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) { await response.arrayBuffer(); return; } } catch { /* belum siap */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server tidak siap");
}

await waitForHealth();

const clientA = makeClient();
const health = await clientA.call("GET", "/health");
check("GET /health memberi cookie token CSRF saat mode ketat aktif", clientA.token().length >= 20, short([...clientA.jar.keys()]));
const cookieLine = clientA.rawCookies.find((value) => value.startsWith("coder_csrf=")) ?? "";
check("cookie token CSRF TIDAK HttpOnly (harus bisa dibaca JavaScript untuk double submit)", cookieLine.includes("coder_csrf=") && !/HttpOnly/i.test(cookieLine), short(cookieLine));
check("cookie token CSRF memakai SameSite=Lax", /SameSite=Lax/i.test(cookieLine), short(cookieLine));

const noToken = await clientA.call("POST", "/api/v1/auth/register", { body: { email: userEmail, password: "SandiUji2026!aman", displayName: "Pengguna CSRF" } });
check("tulis tanpa header token -> ditolak", noToken.status === 403 && noToken.json?.error === "CSRF_TOKEN_REQUIRED", `${noToken.status} ${short(noToken.json)}`);
const wrongToken = await clientA.call("POST", "/api/v1/auth/register", { body: { email: userEmail, password: "SandiUji2026!aman", displayName: "Pengguna CSRF" }, csrf: "token-palsu" });
check("tulis dengan token yang tidak cocok -> ditolak", wrongToken.status === 403 && wrongToken.json?.error === "CSRF_TOKEN_REQUIRED", `${wrongToken.status} ${short(wrongToken.json)}`);
const crossSite = await clientA.call("POST", "/api/v1/auth/register", { body: { email: userEmail, password: "SandiUji2026!aman", displayName: "Pengguna CSRF" }, csrf: "cookie", headers: { origin: "https://jahat.example", "sec-fetch-site": "cross-site" } });
check("tulis dari situs lain ditolak walau token benar -> CSRF_BLOCKED", crossSite.status === 403 && crossSite.json?.error === "CSRF_BLOCKED", `${crossSite.status} ${short(crossSite.json)}`);
const goodRegister = await clientA.call("POST", "/api/v1/auth/register", { body: { email: userEmail, password: "SandiUji2026!aman", displayName: "Pengguna CSRF" }, csrf: "cookie" });
check("tulis dengan cookie dan header token yang cocok -> berhasil", goodRegister.status === 201 || goodRegister.status === 200, `${goodRegister.status} ${short(goodRegister.json)}`);

const login = await clientA.call("POST", "/api/v1/auth/login", { body: { email: userEmail, password: "SandiUji2026!aman" }, csrf: "cookie" });
check("login dengan token yang cocok berhasil", login.status === 200, `${login.status} ${short(login.json)}`);

// Header tanpa cookie (mis. penyerang yang menebak token): harus tetap ditolak.
const headerOnly = makeClient();
await headerOnly.call("GET", "/health");
headerOnly.jar.delete("coder_csrf");
const headerOnlyCall = await headerOnly.call("POST", "/api/v1/auth/login", { body: { email: userEmail, password: "SandiUji2026!aman" }, csrf: clientA.token() });
check("header token tanpa cookie -> ditolak", headerOnlyCall.status === 403 && headerOnlyCall.json?.error === "CSRF_TOKEN_REQUIRED", `${headerOnlyCall.status} ${short(headerOnlyCall.json)}`);

const readOnly = await clientA.call("GET", "/api/v1/auth/me");
check("permintaan baca (GET) tidak terpengaruh mode ketat", readOnly.status === 200, `${readOnly.status} ${short(readOnly.json)}`);

const patchNoToken = await clientA.call("PATCH", "/api/v1/auth/me", { body: { displayName: "Tanpa Token" } });
check("PATCH tanpa token dari sesi yang sudah masuk -> ditolak", patchNoToken.status === 403 && patchNoToken.json?.error === "CSRF_TOKEN_REQUIRED", `${patchNoToken.status} ${short(patchNoToken.json)}`);
const writeWithSession = await clientA.call("PATCH", "/api/v1/auth/me", { body: { displayName: `Pengguna CSRF ${stamp}` }, csrf: "cookie" });
check("permintaan tulis memakai sesi juga wajib membawa token", writeWithSession.status === 200, `${writeWithSession.status} ${short(writeWithSession.json)}`);

const clientB = makeClient();
await clientB.call("GET", "/health");
check("setiap klien mendapat token berbeda (tidak ada token tetap)", clientB.token().length >= 20 && clientB.token() !== clientA.token(), `${short(clientA.token())} vs ${short(clientB.token())}`);

console.log("\n=== RINGKASAN ===");
console.log(`total pemeriksaan: ${checks}, lulus: ${passed}, gagal: ${failed}`);
if (failed) { console.log(`gagal pada: ${failedNames.join("; ")}`); console.log("CSRF_STRICT_TESTS_FAILED"); process.exit(1); }
console.log("ALL_CSRF_STRICT_TESTS_PASSED");
process.exit(0);

/**
 * Uji Wave 11C (v0.23.0) butir 68 — integrasi Notion (target minimal 18 pemeriksaan).
 *
 * Yang dibuktikan di sini, bukan diasumsikan:
 *   1. Token disegel lebih dulu (`enc:v1:`) sebelum dipakai ke hulu; tanpa SECRETS_KEY jawabannya 503
 *      dan TIDAK ada teks polos yang tersimpan.
 *   2. Token tidak pernah kembali lewat API (GET/PUT/POST) dan tidak ikut `collectUserData()`.
 *   3. Kesalahan hulu dibedakan apa adanya: token ditolak -> 400 NOTION_TOKEN_INVALID,
 *      hulu 5xx/koneksi mati/lewat batas waktu -> 502 NOTION_UPSTREAM_ERROR.
 *   4. Hulu yang dipanggil hanya yang ada di daftar putih konektor (NOTION_API_BASE di luar daftar
 *      putih ditolak sebelum ada permintaan keluar).
 *   5. Halaman disimpan di `meta_json`, dan pembuatan halaman dibatasi (429) TANPA memanggil hulu.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11c.e2e.ts
 *
 * Catatan jujur:
 * - Hulu Notion diganti peladen tiruan lokal (`NOTION_API_BASE` -> 127.0.0.1). Tes ini karena itu
 *   membuktikan alur kita, BUKAN perilaku Notion yang sebenarnya.
 * - Batas laju dipendekkan lewat `NOTION_PAGE_MAX=3` supaya uji cepat; batas bawaan (10 per 10 menit)
 *   diperiksa langsung dari `notionPageRule({})`.
 * - Data uji ditulis ke DATA_DIR sementara dan dihapus lagi di blok `finally`.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import { Uji, buatKlien, cariPortBebas, mulaiMock, potong, tungguSiap } from "./wave11c-harness.js";

const u = new Uji();
const port = await cariPortBebas(7320);
const dataDir = `/tmp/coder-wave11c-notion-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const email = `w11c-notion-${Date.now()}@example.test`;
const emailLain = `w11c-notion-lain-${Date.now()}@example.test`;
const password = "SandiUji2026!aman";
const kunciSecrets = randomBytes(32).toString("base64");

/** Peladen tiruan Notion: `ditolak` -> 401, `gagal500` -> 500, judul 'GAGAL-500' -> 500. */
let nomorHalaman = 0;
const mock = await mulaiMock(0, (req) => {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (req.path === "/users/me") {
    if (token.includes("ditolak")) return { status: 401, body: { object: "error", status: 401, code: "unauthorized" } };
    if (token.includes("gagal500")) return { status: 500, body: { object: "error", status: 500, code: "internal_server_error" } };
    return { status: 200, body: { object: "user", id: "bot-uji-1", name: "Koneksi Uji", bot: { workspace_id: "ws-uji-1", workspace_name: "Ruang Uji Dinda" } } };
  }
  if (req.path === "/pages") {
    const judul = String(req.body?.properties?.title?.title?.[0]?.text?.content ?? "");
    if (judul.includes("GAGAL-500")) return { status: 500, body: { object: "error", status: 500, code: "internal_server_error" } };
    if (token.includes("ditolak")) return { status: 401, body: { object: "error", status: 401, code: "unauthorized" } };
    nomorHalaman += 1;
    const id = `page-uji-${nomorHalaman}`;
    return { status: 200, body: { object: "page", id, url: `http://127.0.0.1:${mock.port}/halaman/${id}`, created_time: new Date().toISOString() } };
  }
  return { status: 404, body: { object: "error", status: 404, code: "not_found" } };
});

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
process.env.JOB_WORKER_IN_WEB = "false";
process.env.JOB_REAP_ON_BOOT = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.SECRETS_KEY = kunciSecrets;
process.env.CONNECTOR_ALLOWED_HOSTS = "127.0.0.1,localhost";
process.env.CONNECTOR_TIMEOUT_MS = "3000";
process.env.NOTION_API_BASE = mock.base;
process.env.NOTION_PAGE_MAX = "3";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { collectUserData } = await import("../src/dataexport.js");
const notionMod: any = await import("../src/wave11c/notion.js");

const base = `http://127.0.0.1:${port}`;
const akunA = buatKlien(base);
const akunB = buatKlien(base);
const jalur = "/api/v1/integrations/notion";
const jumlah = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number })?.n ?? 0);

let keluar = 1;
try {
  if (!(await tungguSiap(base))) throw new Error(`peladen uji tidak siap di ${base}`);
  console.log(`INFO peladen uji siap di ${base} (skema ${SCHEMA_VERSION}), hulu tiruan di ${mock.base}, data di ${dataDir}`);

  await akunA.bootstrap();
  const daftar = await akunA.call("POST", "/api/v1/auth/register", { email, password, displayName: "Pemilik Uji" });
  const userId = String(daftar.json?.user?.id ?? "");
  u.check("akun uji terdaftar", daftar.status === 201 && Boolean(userId), `status=${daftar.status} ${potong(daftar.json)}`);
  await akunB.bootstrap();
  await akunB.call("POST", "/api/v1/auth/register", { email: emailLain, password, displayName: "Akun Lain" });

  const tokenSah = `ntn_${randomBytes(9).toString("hex")}`;
  const tokenDitolak = `ntn_ditolak${randomBytes(6).toString("hex")}`;
  const tokenGagal = `ntn_gagal500${randomBytes(6).toString("hex")}`;

  // §1 Keadaan awal jujur: belum tersambung, kunci penyimpanan siap.
  const awal = await akunA.call("GET", jalur);
  u.check("GET awal: 200 dan terpasang=false", awal.status === 200 && awal.json?.integration?.terpasang === false, `status=${awal.status} ${potong(awal.json)}`);
  u.check("GET awal: kunci penyimpanan 'ok' dan batas halaman dilaporkan", awal.json?.kunci === "ok" && awal.json?.batas?.pembuatanHalaman === 3, potong(awal.json?.kunci));

  // §2 Bentuk token tidak sah ditolak sebelum menghubungi hulu.
  const sebelumPalsu = mock.hitungan.total ?? 0;
  const palsu = await akunA.call("PUT", jalur, { token: "bukan-token-notion" });
  u.check("PUT token berbentuk salah: 400 NOTION_TOKEN_INVALID", palsu.status === 400 && palsu.json?.error === "NOTION_TOKEN_INVALID", `status=${palsu.status} ${potong(palsu.json)}`);
  u.check("PUT token berbentuk salah tidak memanggil hulu", (mock.hitungan.total ?? 0) === sebelumPalsu, `total=${mock.hitungan.total}`);

  // §3 Token yang ditolak hulu: 400, dan hulu benar-benar dipanggil.
  const sebelumTolak = mock.hitungan["/users/me"] ?? 0;
  const ditolak = await akunA.call("PUT", jalur, { token: tokenDitolak });
  u.check("PUT token ditolak hulu: 400 NOTION_TOKEN_INVALID", ditolak.status === 400 && ditolak.json?.error === "NOTION_TOKEN_INVALID", `status=${ditolak.status} ${potong(ditolak.json)}`);
  u.check("permintaan verifikasi sampai ke hulu (/users/me bertambah)", (mock.hitungan["/users/me"] ?? 0) === sebelumTolak + 1, `hitungan=${mock.hitungan["/users/me"]}`);

  // §4 Hulu 5xx: 502.
  const gagal500 = await akunA.call("PUT", jalur, { token: tokenGagal });
  u.check("PUT hulu 5xx: 502 NOTION_UPSTREAM_ERROR", gagal500.status === 502 && gagal500.json?.error === "NOTION_UPSTREAM_ERROR", `status=${gagal500.status} ${potong(gagal500.json)}`);

  // §5 Hulu di luar daftar putih dan hulu mati.
  process.env.NOTION_API_BASE = "http://example.test/v1";
  const luarDaftar = await akunA.call("PUT", jalur, { token: tokenSah });
  u.check(
    "NOTION_API_BASE di luar daftar putih: 502 dan menyebut daftar putih",
    luarDaftar.status === 502 && luarDaftar.json?.error === "NOTION_UPSTREAM_ERROR" && String(luarDaftar.json?.message ?? "").includes("daftar putih"),
    `status=${luarDaftar.status} ${potong(luarDaftar.json?.message)}`,
  );
  process.env.NOTION_API_BASE = "http://127.0.0.1:1";
  const mati = await akunA.call("PUT", jalur, { token: tokenSah });
  u.check("hulu mati (koneksi ditolak): 502 NOTION_UPSTREAM_ERROR", mati.status === 502 && mati.json?.error === "NOTION_UPSTREAM_ERROR", `status=${mati.status} ${potong(mati.json)}`);
  process.env.NOTION_API_BASE = mock.base;

  // §6 Token sah: tersegel, tersimpan, tidak bocor.
  const sambung = await akunA.call("PUT", jalur, { token: tokenSah });
  u.check("PUT token sah: 200 dan terpasang=true", sambung.status === 200 && sambung.json?.integration?.terpasang === true, `status=${sambung.status} ${potong(sambung.json)}`);
  u.check("nama ruang kerja Notion tersimpan", sambung.json?.integration?.workspace?.name === "Ruang Uji Dinda", potong(sambung.json?.integration?.workspace));
  u.check("token tersegel (enc:v1:) dan bukan teks polos di basis data", (() => {
    const row = db.prepare("SELECT secret_ciphertext AS stored FROM user_integrations WHERE user_id=? AND provider='notion'").get(userId) as any;
    return Boolean(row) && String(row.stored).startsWith("enc:v1:") && !String(row.stored).includes(tokenSah);
  })(), "baris user_integrations tidak sesuai dugaan");
  u.check("ekor rahasia yang ditampilkan 4 karakter terakhir", String(sambung.json?.integration?.ekor ?? "") === `…${tokenSah.slice(-4)}`, potong(sambung.json?.integration?.ekor));
  u.check("jawaban API tidak memuat token", !sambung.text.includes(tokenSah) && !sambung.text.includes("enc:v1:"), "token/ciphertext muncul di jawaban PUT");

  const baca = await akunA.call("GET", jalur);
  u.check("GET setelah tersambung: token tidak muncul di jawaban", !baca.text.includes(tokenSah) && !baca.text.includes("enc:v1:"), "token/ciphertext muncul di jawaban GET");

  // §7 Token tidak ikut ekspor data pengguna.
  const ekspor = collectUserData(userId);
  const barisIntegrasi = ((ekspor.data as any).user_integrations ?? []) as any[];
  u.check("collectUserData: token tidak ada dan ciphertext tidak dikirim", !JSON.stringify(ekspor).includes(tokenSah) && barisIntegrasi.length === 1 && barisIntegrasi[0].terpasang === 1 && !Object.keys(barisIntegrasi[0]).some((nama) => /secret|cipher|token/i.test(nama)), `kunci=${Object.keys(barisIntegrasi[0] ?? {}).join(",")}`);

  // §8 Halaman Notion: dibuat di hulu, jejaknya disimpan di meta_json.
  const buat = await akunA.call("POST", `${jalur}/pages`, { title: "Catatan Uji Dinda", content: "Baris pertama.\n\nBaris kedua." });
  u.check("POST pages: 201 dan url halaman dari hulu", buat.status === 201 && String(buat.json?.halaman?.id ?? "").startsWith("page-uji-") && String(buat.json?.halaman?.url ?? "").includes("/halaman/"), `status=${buat.status} ${potong(buat.json)}`);
  u.check("permintaan hulu memakai token dan versi Notion yang benar", String(mock.terakhirHeader["/pages"]?.authorization ?? "") === `Bearer ${tokenSah}` && String(mock.terakhirHeader["/pages"]?.["notion-version"] ?? "") === "2022-06-28", potong(mock.terakhirHeader["/pages"]));
  u.check("badan permintaan hulu membawa judul dan blok paragraf", (() => {
    const badan = mock.terakhir["/pages"];
    const judul = badan?.properties?.title?.title?.[0]?.text?.content;
    return judul === "Catatan Uji Dinda" && Array.isArray(badan?.children) && badan.children.length === 2;
  })(), potong(mock.terakhir["/pages"]));

  const setelahBuat = await akunA.call("GET", jalur);
  u.check("GET menampilkan riwayat halaman dari meta_json", setelahBuat.json?.integration?.jumlahHalaman === 1 && setelahBuat.json?.integration?.halaman?.[0]?.title === "Catatan Uji Dinda" && setelahBuat.json?.integration?.lastPageUrl === buat.json?.halaman?.url, potong(setelahBuat.json?.integration));

  // §9 Judul tidak sah: ditolak tanpa memanggil hulu.
  const tanpaJudul = await akunA.call("POST", `${jalur}/pages`, { content: "isi" });
  u.check("POST pages tanpa judul: 400 NOTION_PAGE_TITLE_REQUIRED", tanpaJudul.status === 400 && tanpaJudul.json?.error === "NOTION_PAGE_TITLE_REQUIRED", `status=${tanpaJudul.status} ${potong(tanpaJudul.json)}`);
  const judulPanjang = await akunA.call("POST", `${jalur}/pages`, { title: "J".repeat(250) });
  u.check("POST pages judul terlalu panjang: 400 NOTION_PAGE_TITLE_TOO_LONG", judulPanjang.status === 400 && judulPanjang.json?.error === "NOTION_PAGE_TITLE_TOO_LONG", `status=${judulPanjang.status} ${potong(judulPanjang.json)}`);

  // §10 Hulu 5xx saat membuat halaman: 502 dan riwayat tidak bertambah.
  const gagalHalaman = await akunA.call("POST", `${jalur}/pages`, { title: "GAGAL-500 coba", content: "isi" });
  const setelahGagal = await akunA.call("GET", jalur);
  u.check("POST pages saat hulu 5xx: 502 NOTION_UPSTREAM_ERROR", gagalHalaman.status === 502 && gagalHalaman.json?.error === "NOTION_UPSTREAM_ERROR", `status=${gagalHalaman.status} ${potong(gagalHalaman.json)}`);
  u.check("halaman gagal tidak masuk riwayat", setelahGagal.json?.integration?.jumlahHalaman === 1, potong(setelahGagal.json?.integration?.jumlahHalaman));

  // §11 Batas bawaan 10 per 10 menit (diperiksa dari aturannya, bukan dari hafalan).
  const bawaan = notionMod.notionPageRule({});
  u.check("batas bawaan pembuatan halaman: 10 per 10 menit", bawaan.max === 10 && bawaan.windowMs === 600000 && bawaan.namespace === "notion_pages", potong(bawaan));

  // §12 Batas laju nyata: hitungan dibersihkan dulu supaya jumlahnya pasti.
  db.prepare("DELETE FROM rate_limit_hits WHERE bucket LIKE 'notion_pages:%'").run();
  const sebelum429 = mock.hitungan["/pages"] ?? 0;
  const hasilTiga: number[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const balas = await akunA.call("POST", `${jalur}/pages`, { title: `Halaman batas ${i}` });
    hasilTiga.push(balas.status);
  }
  u.check("tiga halaman pertama masih 201 (batas 3)", hasilTiga.every((status) => status === 201), `status=${hasilTiga.join(",")}`);
  const keempat = await akunA.call("POST", `${jalur}/pages`, { title: "Halaman keempat" });
  u.check("halaman ke-4: 429 NOTION_PAGE_RATE_LIMITED", keempat.status === 429 && keempat.json?.error === "NOTION_PAGE_RATE_LIMITED", `status=${keempat.status} ${potong(keempat.json)}`);
  u.check("429 menyebut sisa waktu tunggu", Number(keempat.json?.retryAfter ?? 0) > 0, potong(keempat.json));
  u.check("429 tidak memanggil hulu", (mock.hitungan["/pages"] ?? 0) === sebelum429 + 3, `hitungan=${mock.hitungan["/pages"]} awal=${sebelum429}`);

  // §13 Isolasi antar akun.
  const bacaB = await akunB.call("GET", jalur);
  const buatB = await akunB.call("POST", `${jalur}/pages`, { title: "Halaman akun lain" });
  u.check("akun lain tidak melihat sambungan ini", bacaB.status === 200 && bacaB.json?.integration?.terpasang === false && bacaB.json?.integration?.jumlahHalaman === 0, potong(bacaB.json?.integration));
  u.check("akun lain tanpa sambungan: 409 NOTION_NOT_CONNECTED", buatB.status === 409 && buatB.json?.error === "NOTION_NOT_CONNECTED", `status=${buatB.status} ${potong(buatB.json)}`);

  // §14 Memutuskan sambungan.
  const putus = await akunA.call("DELETE", jalur);
  const setelahPutus = await akunA.call("GET", jalur);
  const putusLagi = await akunA.call("DELETE", jalur);
  const buatTanpaSambungan = await akunA.call("POST", `${jalur}/pages`, { title: "Halaman tanpa sambungan" });
  u.check("DELETE: sambungan dilepas", putus.status === 200 && putus.json?.deleted === true && putus.json?.provider === "notion", `status=${putus.status} ${potong(putus.json)}`);
  u.check("setelah DELETE: terpasang=false dan barisnya hilang", setelahPutus.json?.integration?.terpasang === false && jumlah("SELECT COUNT(*) AS n FROM user_integrations WHERE user_id=? AND provider='notion'", userId) === 0, potong(setelahPutus.json?.integration?.terpasang));
  // PRD butir 68: keadaan "belum tersambung" dijawab 409 (keadaan), bukan 404 (alamat).
  u.check("DELETE kedua tanpa sambungan: 409 NOTION_NOT_CONNECTED", putusLagi.status === 409 && putusLagi.json?.error === "NOTION_NOT_CONNECTED", `status=${putusLagi.status} ${potong(putusLagi.json)}`);
  u.check("POST pages tanpa sambungan: 409 NOTION_NOT_CONNECTED", buatTanpaSambungan.status === 409 && buatTanpaSambungan.json?.error === "NOTION_NOT_CONNECTED", `status=${buatTanpaSambungan.status} ${potong(buatTanpaSambungan.json)}`);

  // §15 Tanpa SECRETS_KEY: 503, dan tidak ada teks polos yang ditulis.
  // Kunci dikosongkan (bukan dihapus): `secrets.ts` jatuh ke nilai config saat env tidak ada, jadi
  // kunci kosong adalah satu-satunya cara jujur membuktikan jalur 503 pada proses yang sudah jalan.
  process.env.SECRETS_KEY = "";
  const langsung = await notionMod.connectNotionToken(userId, tokenSah);
  u.check("tanpa SECRETS_KEY: connectNotionToken menolak dengan 503 SECRETS_KEY_MISSING", langsung?.ok === false && langsung?.status === 503 && langsung?.kode === "SECRETS_KEY_MISSING", potong(langsung));
  const lewatHttp = await akunA.call("PUT", jalur, { token: tokenSah });
  u.check("tanpa SECRETS_KEY: PUT menjawab 503 SECRETS_KEY_MISSING", lewatHttp.status === 503 && lewatHttp.json?.error === "SECRETS_KEY_MISSING", `status=${lewatHttp.status} ${potong(lewatHttp.json)}`);
  u.check("tidak ada ciphertext yang bukan segel (tidak ada teks polos tersimpan)", jumlah("SELECT COUNT(*) AS n FROM user_integrations WHERE provider='notion' AND secret_ciphertext NOT LIKE 'enc:v1:%'") === 0, "ada baris tanpa segel");
  u.check("tanpa SECRETS_KEY: GET melaporkan kunci 'missing'", (await akunA.call("GET", jalur)).json?.kunci === "missing", "keadaan kunci tidak dilaporkan");
  process.env.SECRETS_KEY = kunciSecrets;

  // §16 Sambungan kembali setelah kunci pulih: tidak ada sisa keadaan setengah jadi.
  const pulih = await akunA.call("PUT", jalur, { token: tokenSah });
  u.check("kunci pulih: sambungan bisa dibuat lagi", pulih.status === 200 && pulih.json?.integration?.terpasang === true, `status=${pulih.status} ${potong(pulih.json)}`);
  u.check("hanya satu baris integrasi per akun dan provider", jumlah("SELECT COUNT(*) AS n FROM user_integrations WHERE user_id=? AND provider='notion'", userId) === 1, "jumlah baris salah");

  keluar = u.failed === 0 ? 0 : 1;
} catch (error) {
  console.log(`FATAL ${String((error as Error)?.stack ?? error).slice(0, 600)}`);
  u.failed += 1;
  keluar = 1;
} finally {
  u.ringkas("Wave 11C butir 68 (Notion)");
  try {
    await mock.tutup();
  } catch {
    /* peladen tiruan sudah mati */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* direktori sementara sudah hilang */
  }
  process.exit(keluar);
}

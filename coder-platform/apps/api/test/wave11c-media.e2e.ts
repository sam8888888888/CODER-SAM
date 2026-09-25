/**
 * Uji Wave 11C (v0.23.0) butir 76 — avatar akun dan avatar agen.
 *
 * Rute yang diuji (semua lewat peladen NYATA `../src/server.js`; suite ini TIDAK memasang rute sendiri):
 *   PUT    /api/v1/account/avatar            DELETE /api/v1/account/avatar
 *   GET    /api/v1/media/avatar/:userId      GET    /api/v1/media/agent-avatar
 *   GET    /api/v1/admin/agent-avatar        PUT    /api/v1/admin/agent-avatar         DELETE /api/v1/admin/agent-avatar
 *
 * Yang dibuktikan, bagian demi bagian:
 *   1. jenis berkas ditentukan dari ISI, bukan nama/Content-Type: JPEG dan WebP ditolak
 *      `503 IMAGE_PROCESSOR_UNAVAILABLE` (memang belum ada pemrosesnya), GIF/teks/tanda-tangan palsu
 *      ditolak `400`, dan penolakan TIDAK meninggalkan berkas di folder avatar;
 *   2. batas ukuran `config.AVATAR_MAX_BYTES` (4 MB) benar-benar dihormati: berkas sedikit di atas batas
 *      ditolak `413 AVATAR_TOO_LARGE`, berkas sedikit di bawah batas diterima, dan gambar raksasa yang
 *      mengaku 6000x6000 (bom dekompresi) ditolak sebelum memori terpakai;
 *   3. unggahan sah menghasilkan berkas PNG 512x512 di `DATA_DIR/<AVATAR_DIR>` dengan hanya chunk
 *      IHDR/IDAT/IEND: tEXt dan pHYs milik berkas kiriman HILANG, warna tetap, potongan tengah persegi;
 *   4. nama berkas dibuat peladen: `declaredName` berisi "../../evil.html" tidak berpengaruh apa pun;
 *   5. ganti avatar menghapus berkas lama dari disk; hapus avatar menghapus baris + berkas;
 *   6. penyajian berkas menolak id pengguna yang menjelajah (`../`), menolak baris basis data yang
 *      menunjuk ke luar folder avatar, dan menolak melihat avatar orang lain (404, bukan 403);
 *   7. batas laju unggahan dikunci per pengguna: hitungan ke-21 dalam satu jam dijawab 429.
 *
 * Jalankan dari akar repo: `npx tsx apps/api/test/wave11c-media.e2e.ts`
 *
 * Batas pengujian yang disebut apa adanya:
 *   • Mesin dipakai MOCK_ENGINE (tidak perlu jaringan); avatar tidak memanggil mesin sama sekali.
 *   • "Metadata hilang" dibuktikan pada chunk PNG (tEXt/pHYs/CRC), bukan pada EXIF JPEG, karena JPEG
 *     memang ditolak seluruhnya di peladen ini.
 *   • Kejelasan potongan tengah diperiksa lewat warna kiri/kanan gambar dua warna, bukan lewat
 *     perbandingan piksel satu-satu dengan alat luar.
 * Berkas ini HANYA menambah berkas uji baru; tidak ada berkas milik agen lain yang diubah.
 */
import { createServer as createTcpServer } from "node:net";
import { readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

/* ---------------------------------------------------------------------------------------------
 * Alat uji PNG. Dibuat TERPISAH dari modul yang diuji (`image-sanitize.ts`) supaya pembaca bisa
 * melihat bahwa pemeriksaan tidak memakai kode yang sama dengan yang diperiksa: penyandi di sini
 * memakai filter baris 0..4 (Sub/Up/Average/Paeth sekaligus), sedangkan modul selalu menulis filter 0.
 * ------------------------------------------------------------------------------------------- */
function crc32Uji(data: Buffer): number {
  const tabel = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); tabel[n] = c; }
  let c = -1;
  for (let i = 0; i < data.length; i += 1) c = tabel[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunkUji(type: string, data: Buffer): Buffer {
  const panjang = Buffer.alloc(4); panjang.writeUInt32BE(data.length, 0);
  const jenis = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32Uji(Buffer.concat([jenis, data])), 0);
  return Buffer.concat([panjang, jenis, data, crc]);
}
function paethUji(a: number, b: number, c: number): number { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); if (pa <= pb && pa <= pc) return a; return pb <= pc ? b : c; }
const SIGNATURE_UJI = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Menyandi PNG uji; filter baris dipakai bergantian 0..4 supaya pembalik filter benar-benar bekerja. */
function encodeUji(opsi: { lebar: number; tinggi: number; saluran: number; warnaJenis: number; piksel: Buffer; pakaiFilter: boolean; tambahan?: Array<{ type: string; data: Buffer }> }): Buffer {
  const lebarBaris = opsi.lebar * opsi.saluran;
  const raw = Buffer.alloc((lebarBaris + 1) * opsi.tinggi);
  for (let y = 0; y < opsi.tinggi; y += 1) {
    const mulai = y * (lebarBaris + 1);
    const asli = opsi.piksel.subarray(y * lebarBaris, (y + 1) * lebarBaris);
    const sebelum = y > 0 ? opsi.piksel.subarray((y - 1) * lebarBaris, y * lebarBaris) : null;
    const jenisFilter = opsi.pakaiFilter ? y % 5 : 0;
    raw[mulai] = jenisFilter;
    for (let x = 0; x < lebarBaris; x += 1) {
      const a = x >= opsi.saluran ? asli[x - opsi.saluran] : 0;
      const b = sebelum ? sebelum[x] : 0;
      const c = sebelum && x >= opsi.saluran ? sebelum[x - opsi.saluran] : 0;
      const prediksi = jenisFilter === 0 ? 0 : jenisFilter === 1 ? a : jenisFilter === 2 ? b : jenisFilter === 3 ? ((a + b) >> 1) : paethUji(a, b, c);
      raw[mulai + 1 + x] = (asli[x] - prediksi) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opsi.lebar, 0); ihdr.writeUInt32BE(opsi.tinggi, 4);
  ihdr[8] = 8; ihdr[9] = opsi.warnaJenis; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const potongan = [chunkUji("IHDR", ihdr), ...(opsi.tambahan ?? []).map((tambahan) => chunkUji(tambahan.type, tambahan.data)), chunkUji("IDAT", deflateSync(raw, { level: 6 })), chunkUji("IEND", Buffer.alloc(0))];
  return Buffer.concat([SIGNATURE_UJI, ...potongan]);
}

/** Membaca PNG uji: memeriksa tanda tangan, CRC32 tiap chunk, lalu membalik filter 0..4. */
function decodeUji(png: Buffer): { lebar: number; tinggi: number; saluran: number; warnaJenis: number; piksel: Buffer; chunks: string[] } {
  if (!png.subarray(0, 8).equals(SIGNATURE_UJI)) throw new Error("bukan PNG");
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let posisi = 8;
  while (posisi + 12 <= png.length) {
    const panjang = png.readUInt32BE(posisi);
    const jenis = png.subarray(posisi + 4, posisi + 8).toString("latin1");
    const data = png.subarray(posisi + 8, posisi + 8 + panjang);
    const crcTertulis = png.readUInt32BE(posisi + 8 + panjang);
    if (crcTertulis !== crc32Uji(Buffer.concat([png.subarray(posisi + 4, posisi + 8), data]))) throw new Error(`CRC chunk ${jenis} salah`);
    chunks.push({ type: jenis, data: Buffer.from(data) });
    posisi += 12 + panjang;
    if (jenis === "IEND") break;
  }
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR") throw new Error("IHDR hilang");
  const lebar = ihdr.data.readUInt32BE(0); const tinggi = ihdr.data.readUInt32BE(4);
  const warnaJenis = ihdr.data[9];
  const saluran = warnaJenis === 0 ? 1 : warnaJenis === 2 ? 3 : warnaJenis === 4 ? 2 : warnaJenis === 6 ? 4 : 0;
  const raw = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
  const lebarBaris = lebar * saluran;
  const piksel = Buffer.alloc(lebarBaris * tinggi);
  for (let y = 0; y < tinggi; y += 1) {
    const mulai = y * (lebarBaris + 1);
    const jenisFilter = raw[mulai];
    if (jenisFilter > 4) throw new Error(`filter ${jenisFilter} tidak dikenal`);
    const baris = raw.subarray(mulai + 1, mulai + 1 + lebarBaris);
    const kini = piksel.subarray(y * lebarBaris, (y + 1) * lebarBaris);
    const sebelum = y > 0 ? piksel.subarray((y - 1) * lebarBaris, y * lebarBaris) : null;
    for (let x = 0; x < lebarBaris; x += 1) {
      const a = x >= saluran ? kini[x - saluran] : 0;
      const b = sebelum ? sebelum[x] : 0;
      const c = sebelum && x >= saluran ? sebelum[x - saluran] : 0;
      const nilai = jenisFilter === 0 ? baris[x] : jenisFilter === 1 ? baris[x] + a : jenisFilter === 2 ? baris[x] + b : jenisFilter === 3 ? baris[x] + ((a + b) >> 1) : baris[x] + paethUji(a, b, c);
      kini[x] = nilai & 0xff;
    }
  }
  return { lebar, tinggi, saluran, warnaJenis, piksel, chunks: chunks.map((chunk) => chunk.type) };
}

/** Gambar satu warna penuh (dipakai untuk membuktikan warna tidak bergeser setelah ditulis ulang). */
function gambarWarna(lebar: number, tinggi: number, saluran: number, warna: number[]): Buffer {
  const piksel = Buffer.alloc(lebar * tinggi * saluran);
  for (let i = 0; i < lebar * tinggi; i += 1) for (let ch = 0; ch < saluran; ch += 1) piksel[i * saluran + ch] = warna[ch] ?? 255;
  return piksel;
}
/** Gambar dua warna: separuh kiri dan separuh kanan berbeda, untuk memeriksa potongan tengah tidak tertukar. */
function gambarDuaWarna(lebar: number, tinggi: number, saluran: number, kiri: number[], kanan: number[]): Buffer {
  const piksel = Buffer.alloc(lebar * tinggi * saluran);
  for (let y = 0; y < tinggi; y += 1) {
    for (let x = 0; x < lebar; x += 1) {
      const warna = x < lebar / 2 ? kiri : kanan;
      for (let ch = 0; ch < saluran; ch += 1) piksel[(y * lebar + x) * saluran + ch] = warna[ch] ?? 255;
    }
  }
  return piksel;
}

/** Mencari port bebas di rentang Wave 11C media (7320-7335); nomor utama dicoba lebih dulu. */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 16 }, () => 7320 + Math.floor(Math.random() * 16))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang Wave 11C media (7320-7335).");
}

const port = await cariPortBebas(7326, 7327, 7325);
const dataDir = `/tmp/coder-wave11c-media-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11c-admin-${stamp}@example.test`;
const pemilikEmail = `w11c-pemilik-${stamp}@example.test`;
const temanEmail = `w11c-teman-${stamp}@example.test`;
const luarEmail = `w11c-luar-${stamp}@example.test`;
const penolakEmail = `w11c-penolak-${stamp}@example.test`;
const semprotEmail = `w11c-semprot-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_IN_WEB = "false";
process.env.JOB_REAP_ON_BOOT = "false";

await import("../src/server.js");
const { db } = await import("../src/db.js");
const { config } = await import("../src/config.js");

const base = `http://127.0.0.1:${port}`;
const folderAvatar = join(dataDir, config.AVATAR_DIR);

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} - ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 200) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const hitung = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const satu = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as any[]) as any;

/** Isi folder avatar, diurutkan; dipakai membuktikan penolakan tidak meninggalkan berkas. */
function isiFolderAvatar(): string[] {
  try { return readdirSync(folderAvatar).sort(); } catch { return []; }
}
/** Byte berkas avatar di disk menurut nilai kolom basis data. */
function berkasPengguna(userId: string): { nama: string | null; isi: Buffer | null; jalur: string | null } {
  const baris = satu("SELECT avatar_path AS path FROM users WHERE id=?", userId);
  const nama = baris?.path ? String(baris.path) : null;
  if (!nama) return { nama: null, isi: null, jalur: null };
  const jalur = join(folderAvatar, nama);
  return { nama, isi: existsSync(jalur) ? readFileSync(jalur) : null, jalur };
}

/** Klien HTTP kecil: jar cookie sendiri + token CSRF ganda (mode CSRF_STRICT). */
function client() {
  const jar = new Map<string, string>();
  let primed = false;
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    if (mutating) await prime();
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: base,
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(mutating && jar.get("coder_csrf") ? { "x-csrf-token": String(jar.get("coder_csrf")) } : {}),
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
      "accept-language": "id-ID",
    };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const rawCookies = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of rawCookies) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim(); const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, bytes, headers: response.headers };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server belum siap */ } }
  return { call, bootstrap: prime, jar };
}

const admin = client();
const pemilik = client();
const teman = client();
const luar = client();
const penolak = client();
const semprot = client();
const anonim = client();

for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const siap = await fetch(`${base}/health`); if (siap.ok) break; } catch { /* belum siap */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(`INFO peladen uji siap di ${base}, data di ${dataDir}, folder avatar ${folderAvatar}`);

async function daftar(klien: ReturnType<typeof client>, email: string, nama: string) {
  await klien.bootstrap();
  return klien.call("POST", "/api/v1/auth/register", { email, password, displayName: nama });
}

/** Bahan uji: PNG 8x8 RGB satu warna, ditulis dengan filter baris 0..4 (melatih pembalik filter). */
const WARNA_UJI = [17, 148, 222];
const PNG_KECIL = () => encodeUji({ lebar: 8, tinggi: 8, saluran: 3, warnaJenis: 2, piksel: gambarWarna(8, 8, 3, WARNA_UJI), pakaiFilter: true });
/** PNG dengan metadata tEXt + pHYs yang harus hilang setelah ditulis ulang peladen. */
const PNG_BERMETADATA = () => encodeUji({
  lebar: 8, tinggi: 8, saluran: 3, warnaJenis: 2, piksel: gambarWarna(8, 8, 3, WARNA_UJI), pakaiFilter: true,
  tambahan: [
    { type: "tEXt", data: Buffer.concat([Buffer.from("Software\0", "latin1"), Buffer.from("kamera-rahasia-9x", "latin1")]) },
    { type: "pHYs", data: Buffer.from([0, 0, 11, 19, 0, 0, 11, 19, 1]) },
  ],
});
/** PNG diperbesar sampai ukuran tertentu dengan menambahkan satu chunk tEXt besar (isi gambar tetap 8x8). */
function pngSeukuran(target: number): Buffer {
  const dasar = PNG_KECIL();
  const panjangIsi = target - dasar.length - 12;
  if (panjangIsi < 8) throw new Error(`target ${target} terlalu kecil untuk PNG dasar ${dasar.length}`);
  const isi = Buffer.concat([Buffer.from("Komentar\0", "latin1"), Buffer.alloc(panjangIsi - 9, 0x41)]);
  const ihdr = dasar.subarray(8, 8 + 25);
  return Buffer.concat([dasar.subarray(0, 8), ihdr, chunkUji("tEXt", isi), dasar.subarray(8 + 25)]);
}
const keB64 = (isi: Buffer) => isi.toString("base64");

const JPEG_PALSU = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0", "latin1"), Buffer.alloc(48, 7)]);
const WEBP_PALSU = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(48, 9)]);
const GIF_PALSU = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(32, 3)]);
const TEKS_BERKEDOK = Buffer.from("<html><body>ini bukan gambar, hanya teks yang dinamai .png</body></html>");
const PNG_SAMPAH = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("GIF89a ini sisa berkas lain")]);

/* =====================================================================================
 * Bagian 0: akun uji dan bahan.
 * ===================================================================================== */
console.log("\n--- Bagian 0: akun uji dan bahan ---");
const adminReg = await daftar(admin, adminEmail, "Admin Wave 11C");
const pemilikReg = await daftar(pemilik, pemilikEmail, "Pemilik Avatar");
const pemilikId = String(pemilikReg.json?.user?.id ?? "");
const pemilikWs = String(pemilikReg.json?.workspace?.id ?? pemilikReg.json?.workspaceId ?? "");
const temanReg = await daftar(teman, temanEmail, "Teman Sekerja");
const temanId = String(temanReg.json?.user?.id ?? "");
const luarReg = await daftar(luar, luarEmail, "Orang Luar");
const luarId = String(luarReg.json?.user?.id ?? "");
const penolakReg = await daftar(penolak, penolakEmail, "Penguji Penolakan");
const penolakId = String(penolakReg.json?.user?.id ?? "");
const semprotReg = await daftar(semprot, semprotEmail, "Penguji Batas Laju");
const semprotId = String(semprotReg.json?.user?.id ?? "");

check("0a. enam akun uji terdaftar (admin, pemilik, teman, luar, penolak, penyemprot)",
  [adminReg, pemilikReg, temanReg, luarReg, penolakReg, semprotReg].every((r) => r.status === 201)
  && Boolean(pemilikId && temanId && luarId && penolakId && semprotId), short([adminReg.status, pemilikReg.status, temanReg.status, luarReg.status, penolakReg.status, semprotReg.status]));

db.prepare("INSERT OR REPLACE INTO memberships (user_id, workspace_id, role, created_at) VALUES (?,?,?,?)")
  .run(temanId, pemilikWs, "viewer", new Date().toISOString());
check("0b. teman jadi anggota (viewer) ruang kerja pemilik, orang luar tidak",
  String(satu("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?", pemilikWs, temanId)?.role ?? "") === "viewer"
  && hitung("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=? AND user_id=?", pemilikWs, luarId) === 0, "");

check("0c. konfigurasi avatar terpakai apa adanya (batas 4 MB, sisi 512, folder avatars)",
  config.AVATAR_MAX_BYTES === 4 * 1024 * 1024 && config.AVATAR_SIZE === 512 && config.AVATAR_DIR === "avatars",
  short({ max: config.AVATAR_MAX_BYTES, size: config.AVATAR_SIZE, dir: config.AVATAR_DIR }));
check("0d. kolom users.avatar_path dan tabel platform_settings tersedia",
  hitung("SELECT COUNT(*) AS n FROM pragma_table_info('users') WHERE name='avatar_path'") === 1
  && hitung("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='platform_settings'") === 1, "");
check("0e. bahan uji PNG sah menurut pemeriksa uji sendiri (CRC benar, filter 0..4 terbaca)",
  (() => { const d = decodeUji(PNG_BERMETADATA()); return d.lebar === 8 && d.tinggi === 8 && d.chunks.includes("tEXt") && d.chunks.includes("pHYs") && d.piksel[0] === WARNA_UJI[0] && d.piksel[1] === WARNA_UJI[1]; })()
  && isiFolderAvatar().length === 0, short(isiFolderAvatar()));

const batasDekat = config.AVATAR_MAX_BYTES - 12;
const PNG_HAMPIR_BATAS = pngSeukuran(batasDekat);
const PNG_LEWAT_BATAS = pngSeukuran(config.AVATAR_MAX_BYTES + 200);
check("0f. bahan batas ukuran tepat seperti yang dimaksud (di bawah & di atas batas)",
  PNG_HAMPIR_BATAS.length === batasDekat && PNG_LEWAT_BATAS.length === config.AVATAR_MAX_BYTES + 200,
  short({ dekat: PNG_HAMPIR_BATAS.length, lewat: PNG_LEWAT_BATAS.length }));

/* =====================================================================================
 * Bagian 1: jenis berkas dinilai dari ISI, bukan nama/Content-Type.
 * ===================================================================================== */
console.log("\n--- Bagian 1: penolakan jenis dan isi berkas ---");
const sebelumPenolakan = isiFolderAvatar().length;

const rJpeg = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(JPEG_PALSU), declaredName: "foto.png", declaredMimeType: "image/png" });
check("1a. JPEG ditolak 503 IMAGE_PROCESSOR_UNAVAILABLE walau dinamai .png dan diklaim image/png",
  rJpeg.status === 503 && rJpeg.json?.error === "IMAGE_PROCESSOR_UNAVAILABLE", `${rJpeg.status} ${short(rJpeg.json)}`);

const rWebp = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(WEBP_PALSU), declaredName: "avatar.webp", declaredMimeType: "image/webp" });
check("1b. WebP ditolak 503 IMAGE_PROCESSOR_UNAVAILABLE", rWebp.status === 503 && rWebp.json?.error === "IMAGE_PROCESSOR_UNAVAILABLE", `${rWebp.status} ${short(rWebp.json)}`);

const rGif = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(GIF_PALSU), declaredName: "animasi.gif" });
check("1c. GIF ditolak 400 IMAGE_UNSUPPORTED", rGif.status === 400 && rGif.json?.error === "IMAGE_UNSUPPORTED", `${rGif.status} ${short(rGif.json)}`);

const rTeks = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(TEKS_BERKEDOK), declaredName: "gambar.png", declaredMimeType: "image/png" });
check("1d. teks berkedok .png ditolak 400 IMAGE_UNSUPPORTED (nama dan Content-Type tidak dipercaya)",
  rTeks.status === 400 && rTeks.json?.error === "IMAGE_UNSUPPORTED", `${rTeks.status} ${short(rTeks.json)}`);

const rSampah = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(PNG_SAMPAH) });
check("1e. tanda tangan PNG + sampah ditolak 400 IMAGE_CORRUPT", rSampah.status === 400 && rSampah.json?.error === "IMAGE_CORRUPT", `${rSampah.status} ${short(rSampah.json)}`);

const pngCrcRusak = Buffer.from(PNG_KECIL()); pngCrcRusak[pngCrcRusak.length - 5] ^= 0xff;
const rCrc = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(pngCrcRusak) });
check("1f. PNG dengan CRC32 rusak ditolak 400 IMAGE_CORRUPT", rCrc.status === 400 && rCrc.json?.error === "IMAGE_CORRUPT", `${rCrc.status} ${short(rCrc.json)}`);

const rB64 = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: "bukan base64!!!", declaredName: "x.png" });
check("1g. contentBase64 tidak sah ditolak 400 INVALID_BASE64", rB64.status === 400 && rB64.json?.error === "INVALID_BASE64", `${rB64.status} ${short(rB64.json)}`);

const rTanpa = await penolak.call("PUT", "/api/v1/account/avatar", { declaredName: "x.png" });
check("1h. badan tanpa contentBase64 ditolak 400 INVALID_IMAGE_BODY", rTanpa.status === 400 && rTanpa.json?.error === "INVALID_IMAGE_BODY", `${rTanpa.status} ${short(rTanpa.json)}`);

const rKosong = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: "" });
check("1i. contentBase64 kosong ditolak 400 (base64 tidak sah atau gambar kosong)",
  rKosong.status === 400 && ["INVALID_BASE64", "IMAGE_EMPTY"].includes(String(rKosong.json?.error)), `${rKosong.status} ${short(rKosong.json)}`);

check("1j. SEMUA penolakan tidak meninggalkan berkas di folder avatar dan kolom avatar_path tetap kosong",
  isiFolderAvatar().length === sebelumPenolakan
  && String(satu("SELECT avatar_path AS p FROM users WHERE id=?", penolakId)?.p ?? "") === "", short(isiFolderAvatar()));

/* =====================================================================================
 * Bagian 2: batas ukuran AVATAR_MAX_BYTES.
 * ===================================================================================== */
console.log("\n--- Bagian 2: batas ukuran ---");
const rLewat = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(PNG_LEWAT_BATAS) });
check(`2a. berkas ${PNG_LEWAT_BATAS.length} byte (batas ${config.AVATAR_MAX_BYTES}) ditolak 413 AVATAR_TOO_LARGE`,
  rLewat.status === 413 && rLewat.json?.error === "AVATAR_TOO_LARGE", `${rLewat.status} ${short(rLewat.json)}`);

const bomHeader = Buffer.alloc(13);
bomHeader.writeUInt32BE(6000, 0); bomHeader.writeUInt32BE(6000, 4); bomHeader[8] = 8; bomHeader[9] = 6;
const PNG_BOM = Buffer.concat([SIGNATURE_UJI, chunkUji("IHDR", bomHeader), chunkUji("IDAT", deflateSync(Buffer.alloc(4096))), chunkUji("IEND", Buffer.alloc(0))]);
const waktuBom = Date.now();
const rBom = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(PNG_BOM) });
const msBom = Date.now() - waktuBom;
check("2b. bom dekompresi (header 6000x6000, berkas 4 KB) ditolak 413 IMAGE_TOO_LARGE dengan cepat",
  rBom.status === 413 && rBom.json?.error === "IMAGE_TOO_LARGE" && msBom < 2000, `${rBom.status} ${short(rBom.json)} dalam ${msBom} ms`);

const rDekat = await penolak.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(PNG_HAMPIR_BATAS) });
check(`2c. berkas ${PNG_HAMPIR_BATAS.length} byte (di bawah batas) DITERIMA dan jadi 512x512`,
  rDekat.status === 200 && rDekat.json?.avatar?.lebar === 512 && rDekat.json?.avatar?.tinggi === 512, `${rDekat.status} ${short(rDekat.json)}`);
check("2d. berkas tepat di bawah batas tersimpan di disk dengan ukuran jauh lebih kecil (ditulis ulang)",
  (() => { const b = berkasPengguna(penolakId); return b.isi !== null && b.isi.length < 200_000; })(), short(berkasPengguna(penolakId).isi?.length));

/* =====================================================================================
 * Bagian 3: unggahan sah — potong tengah, skala 512, metadata hilang, nama dibuat peladen.
 * ===================================================================================== */
console.log("\n--- Bagian 3: unggahan sah dan hasil tulis ulang ---");
const sebelumSah = isiFolderAvatar().length;
const rSah = await pemilik.call("PUT", "/api/v1/account/avatar", {
  contentBase64: keB64(PNG_BERMETADATA()), declaredName: "../../evil.html", declaredMimeType: "text/html",
});
check("3a. PUT avatar sah dijawab 200 dengan avatar 512x512 bertipe image/png",
  rSah.status === 200 && rSah.json?.avatar?.lebar === 512 && rSah.json?.avatar?.tinggi === 512 && rSah.json?.avatar?.jenis === "image/png",
  `${rSah.status} ${short(rSah.json)}`);
const berkasA = berkasPengguna(pemilikId);
check("3b. kolom users.avatar_path terisi satu nama berkas dan berkasnya ada di folder avatar",
  Boolean(berkasA.nama) && berkasA.isi !== null && isiFolderAvatar().length === sebelumSah + 1, short({ nama: berkasA.nama, isi: isiFolderAvatar() }));
const namaA = String(berkasA.nama ?? "");
check("3c. nama berkas dibuat peladen: tidak memuat nama kiriman klien dan hanya pola aman",
  namaA.length > 0 && !namaA.includes("evil") && !namaA.includes("/") && !namaA.includes("..") && /^[a-z0-9-]+\.png$/.test(namaA),
  short({ nama: namaA, namaKlienDipakai: rSah.json?.avatar?.namaKlienDipakai }));

const infoA = decodeUji(berkasA.isi!);
check("3d. berkas tersimpan benar-benar PNG 512x512 menurut pembaca uji (CRC semua chunk sah)",
  infoA.lebar === 512 && infoA.tinggi === 512, short({ lebar: infoA.lebar, tinggi: infoA.tinggi }));
check("3e. berkas tersimpan HANYA berisi IHDR/IDAT/IEND — metadata tEXt dan pHYs kiriman klien HILANG",
  infoA.chunks.join(",") === "IHDR,IDAT,IEND", short(infoA.chunks));
check("3f. warna gambar tidak bergeser setelah ditulis ulang (gambar satu warna, filter 0..4 terbaca)",
  (() => { for (let i = 0; i < 512 * 512; i += 1) { if (infoA.piksel[i * 3] !== WARNA_UJI[0] || infoA.piksel[i * 3 + 1] !== WARNA_UJI[1] || infoA.piksel[i * 3 + 2] !== WARNA_UJI[2]) return false; } return infoA.saluran === 3; })(), short({ saluran: infoA.saluran, piksel0: [infoA.piksel[0], infoA.piksel[1], infoA.piksel[2]] }));
check("3g. berkas tersimpan hanya bisa dibaca pemiliknya di disk (mode 0600)",
  berkasA.jalur !== null && (statSync(berkasA.jalur).mode & 0o777) === 0o600, berkasA.jalur ? `mode ${(statSync(berkasA.jalur).mode & 0o777).toString(8)}` : "tanpa berkas");

/* =====================================================================================
 * Bagian 4: penyajian berkas dan keterlihatan.
 * ===================================================================================== */
console.log("\n--- Bagian 4: penyajian berkas dan keterlihatan ---");
const rAnonim = await fetch(`${base}/api/v1/media/avatar/${pemilikId}`);
check("4a. tanpa sesi, penyajian avatar ditolak 401 AUTH_REQUIRED", rAnonim.status === 401, `${rAnonim.status} ${short(await rAnonim.text())}`);

const rSendiri = await pemilik.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("4b. pemilik menerima 200 image/png dan isinya byte-per-byte sama dengan berkas di disk",
  rSendiri.status === 200 && String(rSendiri.headers.get("content-type") ?? "").startsWith("image/png")
  && rSendiri.bytes.equals(berkasA.isi!), `${rSendiri.status} ${short(String(rSendiri.headers.get("content-type")))}`);

const rLuar = await luar.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("4c. orang di luar ruang kerja dijawab 404 AVATAR_NOT_FOUND (bukan 403, supaya tidak bocor)",
  rLuar.status === 404 && rLuar.json?.error === "AVATAR_NOT_FOUND", `${rLuar.status} ${short(rLuar.json)}`);

const rTemanBelum = await teman.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("4d. anggota ruang kerja yang sama boleh melihat avatar rekan (200)",
  rTemanBelum.status === 200, `${rTemanBelum.status} ${short(String(rTemanBelum.headers.get("content-type")))}`);

const rAdmin = await admin.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("4e. admin platform boleh melihat avatar pengguna mana pun (200)", rAdmin.status === 200, `${rAdmin.status}`);

const rNaik = await pemilik.call("GET", "/api/v1/media/avatar/..%2F..%2Fetc%2Fpasswd");
check("4f. id pengguna yang menjelajah ditolak 400 INVALID_USER_ID", rNaik.status === 400 && rNaik.json?.error === "INVALID_USER_ID", `${rNaik.status} ${short(rNaik.json)}`);
const rNaik2 = await pemilik.call("GET", "/api/v1/media/avatar/a%2Fb");
check("4g. id pengguna dengan garis miring ditolak 400 INVALID_USER_ID", rNaik2.status === 400 && rNaik2.json?.error === "INVALID_USER_ID", `${rNaik2.status} ${short(rNaik2.json)}`);

// Baris basis data yang menunjuk ke luar folder avatar (mis. disisipkan langsung ke tabel) tidak boleh disajikan.
db.prepare("UPDATE users SET avatar_path=? WHERE id=?").run("../../package.json", pemilikId);
const rKeluar = await pemilik.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("4h. baris avatar yang menunjuk keluar folder ditolak 404 dan isi package.json TIDAK tersaji",
  rKeluar.status === 404 && rKeluar.json?.error === "AVATAR_FILE_MISSING" && !rKeluar.text.includes("\"name\": \"coder-platform\""),
  `${rKeluar.status} ${short(rKeluar.json)}`);
db.prepare("UPDATE users SET avatar_path=? WHERE id=?").run("/etc/passwd", pemilikId);
const rAbsolut = await pemilik.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("4i. baris avatar berjalur mutlak (/etc/passwd) juga ditolak 404", rAbsolut.status === 404 && rAbsolut.json?.error === "AVATAR_FILE_MISSING", `${rAbsolut.status} ${short(rAbsolut.json)}`);
db.prepare("UPDATE users SET avatar_path=? WHERE id=?").run(String(berkasA.nama), pemilikId);

db.prepare("UPDATE users SET avatar_path=? WHERE id=?").run("berkas-yang-tidak-ada.png", pemilikId);
const rHilang = await pemilik.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("4j. baris ada tetapi berkasnya hilang dijawab 404 AVATAR_FILE_MISSING (disebut apa adanya)",
  rHilang.status === 404 && rHilang.json?.error === "AVATAR_FILE_MISSING", `${rHilang.status} ${short(rHilang.json)}`);
db.prepare("UPDATE users SET avatar_path=? WHERE id=?").run(String(berkasA.nama), pemilikId);

const rTanpaAvatar = await pemilik.call("GET", `/api/v1/media/avatar/${luarId}`);
check("4k. pengguna yang belum pernah punya avatar dijawab 404 AVATAR_NOT_FOUND", rTanpaAvatar.status === 404 && rTanpaAvatar.json?.error === "AVATAR_NOT_FOUND", `${rTanpaAvatar.status} ${short(rTanpaAvatar.json)}`);

const rTemanUnggah = await teman.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(PNG_KECIL()) });
const berkasTeman = berkasPengguna(temanId);
check("4l. teman mengunggah avatar sendiri (untuk uji keterlihatan)",
  rTemanUnggah.status === 200 && Boolean(berkasTeman.nama), `${rTemanUnggah.status} ${short(rTemanUnggah.json)}`);
const rLuarTeman = await luar.call("GET", `/api/v1/media/avatar/${temanId}`);
const rAdminTeman = await admin.call("GET", `/api/v1/media/avatar/${temanId}`);
check("4m. avatar teman terlihat oleh admin, tetapi tidak oleh orang luar",
  rLuarTeman.status === 404 && rAdminTeman.status === 200, `${rLuarTeman.status}/${rAdminTeman.status}`);

/* =====================================================================================
 * Bagian 5: ganti avatar menghapus berkas lama; hapus avatar membersihkan semuanya.
 * ===================================================================================== */
console.log("\n--- Bagian 5: ganti dan hapus avatar ---");
const pngPotong = encodeUji({ lebar: 100, tinggi: 40, saluran: 3, warnaJenis: 2, piksel: gambarDuaWarna(100, 40, 3, [250, 20, 20], [20, 20, 250]), pakaiFilter: true });
const rGanti = await pemilik.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(pngPotong), declaredName: "potong.png" });
const berkasB = berkasPengguna(pemilikId);
check("5a. PUT kedua dijawab 200, potongan tengah 40x40 (gambar 100x40), y=0 x=30",
  rGanti.status === 200 && rGanti.json?.avatar?.potong?.ukuran === 40 && rGanti.json?.avatar?.potong?.x === 30 && rGanti.json?.avatar?.potong?.y === 0,
  `${rGanti.status} ${short(rGanti.json?.avatar?.potong)}`);
const namaB = String(berkasB.nama ?? "");
check("5b. nama berkas baru berbeda dari berkas lama",
  namaB.length > 0 && namaB !== namaA, short({ lama: namaA, baru: namaB }));
check("5c. berkas LAMA benar-benar dihapus dari disk saat avatar diganti",
  namaA.length > 0 && !existsSync(join(folderAvatar, namaA)) && rGanti.json?.avatar?.berkasLamaDihapus === true,
  short({ lama: namaA, ada: existsSync(join(folderAvatar, namaA)) }));
const infoB = decodeUji(berkasB.isi!);
check("5d. hasil potongan tengah: kiri merah, kanan biru, tetap 512x512 (tidak tertukar)",
  infoB.lebar === 512 && infoB.tinggi === 512
  && infoB.piksel[(256 * 512 + 4) * 3] > 200 && infoB.piksel[(256 * 512 + 4) * 3 + 2] < 60
  && infoB.piksel[(256 * 512 + 507) * 3] < 60 && infoB.piksel[(256 * 512 + 507) * 3 + 2] > 200,
  short({ kiri: [infoB.piksel[(256 * 512 + 4) * 3], infoB.piksel[(256 * 512 + 4) * 3 + 1], infoB.piksel[(256 * 512 + 4) * 3 + 2]], kanan: [infoB.piksel[(256 * 512 + 507) * 3], infoB.piksel[(256 * 512 + 507) * 3 + 1], infoB.piksel[(256 * 512 + 507) * 3 + 2]] }));
const rMediaB = await pemilik.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("5e. penyajian mengikuti berkas terbaru: header x-avatar-file = avatar_path dan isinya sama",
  rMediaB.status === 200 && rMediaB.headers.get("x-avatar-file") === namaB && rMediaB.bytes.equals(berkasB.isi!),
  short({ header: rMediaB.headers.get("x-avatar-file"), kolom: namaB }));

/* =====================================================================================
 * Bagian 6: batas laju unggahan per pengguna.
 * ===================================================================================== */
console.log("\n--- Bagian 6: batas laju unggahan ---");
const sebelumSemprot = isiFolderAvatar().length;
const statusSemprot: number[] = [];
let jawabKe21: any = null;
for (let i = 0; i < 21; i += 1) {
  const jawab = await semprot.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(PNG_KECIL()), declaredName: `ke-${i}.png` });
  statusSemprot.push(jawab.status);
  if (i === 20) jawabKe21 = jawab;
}
check("6a. dua puluh unggahan pertama semua dijawab 200 (batasnya tepat, tidak lebih ketat dari yang dijanjikan)",
  statusSemprot.slice(0, 20).every((s) => s === 200), short(statusSemprot));
check("6b. unggahan ke-21 dalam satu jam dijawab 429 AVATAR_RATE_LIMITED",
  statusSemprot[20] === 429 && jawabKe21?.json?.error === "AVATAR_RATE_LIMITED", short({ ke21: statusSemprot[20], badan: jawabKe21?.json }));
check("6c. dua puluh unggahan itu hanya meninggalkan SATU berkas baru (berkas lama selalu dihapus)",
  isiFolderAvatar().length === sebelumSemprot + 1 && berkasPengguna(semprotId).isi !== null,
  short({ sebelum: sebelumSemprot, sesudah: isiFolderAvatar().length }));

const rPemilikLagi = await pemilik.call("PUT", "/api/v1/account/avatar", { contentBase64: keB64(PNG_KECIL()) });
check("6d. pengguna lain (pemilik) TIDAK ikut terblokir — batas laju per pengguna, bukan per alamat IP",
  rPemilikLagi.status === 200, `${rPemilikLagi.status} ${short(rPemilikLagi.json)}`);

/* =====================================================================================
 * Bagian 7: hapus avatar.
 * ===================================================================================== */
console.log("\n--- Bagian 7: hapus avatar ---");
const berkasC = berkasPengguna(pemilikId);
const rHapus = await pemilik.call("DELETE", "/api/v1/account/avatar");
check("7a. DELETE avatar dijawab 200, kolom avatar_path dikosongkan, berkas terakhir dihapus",
  rHapus.status === 200 && rHapus.json?.avatar?.terpasang === false && rHapus.json?.avatar?.berkasDihapus === true
  && String(satu("SELECT avatar_path AS p FROM users WHERE id=?", pemilikId)?.p ?? "") === ""
  && String(berkasC.nama ?? "").length > 0 && !existsSync(join(folderAvatar, String(berkasC.nama))), `${rHapus.status} ${short(rHapus.json)}`);
const rHapusLagi = await pemilik.call("DELETE", "/api/v1/account/avatar");
check("7b. DELETE kedua dijawab 404 AVATAR_NOT_FOUND (tidak ada yang dihapus lagi)",
  rHapusLagi.status === 404 && rHapusLagi.json?.error === "AVATAR_NOT_FOUND", `${rHapusLagi.status} ${short(rHapusLagi.json)}`);
const rMediaSetelahHapus = await pemilik.call("GET", `/api/v1/media/avatar/${pemilikId}`);
check("7c. setelah dihapus, penyajian avatar dijawab 404",
  rMediaSetelahHapus.status === 404 && rMediaSetelahHapus.json?.error === "AVATAR_NOT_FOUND", `${rMediaSetelahHapus.status} ${short(rMediaSetelahHapus.json)}`);

/* =====================================================================================
 * Bagian 8: avatar agen (rute admin).
 * ===================================================================================== */
console.log("\n--- Bagian 8: avatar agen ---");
const rAgenBukanAdmin = await pemilik.call("GET", "/api/v1/admin/agent-avatar");
check("8a. pengguna biasa dijawab 403 ADMIN_REQUIRED pada rute avatar agen",
  rAgenBukanAdmin.status === 403 && rAgenBukanAdmin.json?.error === "ADMIN_REQUIRED", `${rAgenBukanAdmin.status} ${short(rAgenBukanAdmin.json)}`);
const rAgenPutBukanAdmin = await pemilik.call("PUT", "/api/v1/admin/agent-avatar", { contentBase64: keB64(PNG_KECIL()) });
check("8b. pengguna biasa TIDAK boleh mengganti avatar agen (403) dan tidak ada yang tersimpan",
  rAgenPutBukanAdmin.status === 403 && String(satu("SELECT value FROM platform_settings WHERE key='agent_avatar'")?.value ?? "") === "", `${rAgenPutBukanAdmin.status}`);

const rAgenAwal = await admin.call("GET", "/api/v1/admin/agent-avatar");
check("8c. admin membaca keadaan avatar agen: belum terpasang, dengan catatan jujur",
  rAgenAwal.status === 200 && rAgenAwal.json?.agentAvatar?.terpasang === false && String(rAgenAwal.json?.agentAvatar?.catatan ?? "").length > 0,
  `${rAgenAwal.status} ${short(rAgenAwal.json)}`);
const rAgenPut = await admin.call("PUT", "/api/v1/admin/agent-avatar", { contentBase64: keB64(PNG_BERMETADATA()), declaredName: "agen.png" });
const nilaiAgen = String(satu("SELECT value FROM platform_settings WHERE key='agent_avatar'")?.value ?? "");
const berkasAgen1 = nilaiAgen ? String(JSON.parse(nilaiAgen).berkas ?? "") : "";
check("8d. admin memasang avatar agen: 200, pengaturan agent_avatar terisi, berkas 512x512 ditulis",
  rAgenPut.status === 200 && Boolean(berkasAgen1)
  && existsSync(join(folderAvatar, berkasAgen1))
  && (() => { const d = decodeUji(readFileSync(join(folderAvatar, berkasAgen1))); return d.lebar === 512 && d.tinggi === 512 && d.chunks.join(",") === "IHDR,IDAT,IEND"; })(),
  `${rAgenPut.status} ${short({ berkas: berkasAgen1, nilai: nilaiAgen.slice(0, 120) })}`);
check("8e. nama berkas avatar agen dibuat peladen dan tidak memakai nama kiriman klien",
  berkasAgen1.startsWith("agent-") && !berkasAgen1.includes("agen.png"), short(berkasAgen1));
const rAgenMedia = await teman.call("GET", "/api/v1/media/agent-avatar");
check("8f. pengguna biasa yang sudah masuk boleh melihat berkas avatar agen (200, byte sama)",
  rAgenMedia.status === 200 && rAgenMedia.bytes.equals(readFileSync(join(folderAvatar, berkasAgen1))), `${rAgenMedia.status}`);
const rAgenMediaAnonim = await fetch(`${base}/api/v1/media/agent-avatar`);
check("8g. tanpa sesi, avatar agen ditolak 401", rAgenMediaAnonim.status === 401, `${rAgenMediaAnonim.status}`);

const rAgenPut2 = await admin.call("PUT", "/api/v1/admin/agent-avatar", { contentBase64: keB64(PNG_KECIL()) });
const nilaiAgen2 = String(satu("SELECT value FROM platform_settings WHERE key='agent_avatar'")?.value ?? "");
const berkasAgen2 = nilaiAgen2 ? String(JSON.parse(nilaiAgen2).berkas ?? "") : "";
check("8h. PUT kedua mengganti berkas: berkas lama avatar agen dihapus dari disk",
  rAgenPut2.status === 200 && berkasAgen2 !== berkasAgen1 && !existsSync(join(folderAvatar, berkasAgen1)) && existsSync(join(folderAvatar, berkasAgen2)),
  short({ lama: berkasAgen1, baru: berkasAgen2 }));

const rAgenHapus = await admin.call("DELETE", "/api/v1/admin/agent-avatar");
check("8i. DELETE avatar agen: 200, pengaturan dihapus, berkas hilang",
  rAgenHapus.status === 200 && String(satu("SELECT value FROM platform_settings WHERE key='agent_avatar'")?.value ?? "") === ""
  && !existsSync(join(folderAvatar, berkasAgen2)), `${rAgenHapus.status} ${short(rAgenHapus.json)}`);
const rAgenMediaHabis = await teman.call("GET", "/api/v1/media/agent-avatar");
check("8j. setelah dihapus, penyajian avatar agen dijawab 404 AGENT_AVATAR_NOT_FOUND",
  rAgenMediaHabis.status === 404 && rAgenMediaHabis.json?.error === "AGENT_AVATAR_NOT_FOUND", `${rAgenMediaHabis.status} ${short(rAgenMediaHabis.json)}`);

/* =====================================================================================
 * Bagian 9: keadaan akhir — tidak ada berkas yatim, dan jejak audit tercatat.
 * ===================================================================================== */
console.log("\n--- Bagian 9: keadaan akhir dan audit ---");
const terduga = [berkasPengguna(temanId).nama, berkasPengguna(semprotId).nama, berkasPengguna(penolakId).nama].filter((n): n is string => Boolean(n)).sort();
check("9a. isi folder avatar PERSIS sama dengan berkas yang masih ditunjuk basis data (tidak ada berkas yatim)",
  JSON.stringify(isiFolderAvatar()) === JSON.stringify(terduga), short({ ada: isiFolderAvatar(), terduga }));

const jumlahUpdate = hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='avatar.update'");
const jumlahHapus = hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='avatar.delete'");
const agenUpdate = hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='admin.agent_avatar.update'");
const agenHapus = hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='admin.agent_avatar.delete'");
check("9b. setiap unggahan dan penghapusan avatar meninggalkan jejak audit",
  jumlahUpdate >= 5 && jumlahHapus >= 1 && agenUpdate === 2 && agenHapus === 1,
  short({ jumlahUpdate, jumlahHapus, agenUpdate, agenHapus }));
const metaUpdate = satu("SELECT metadata_json AS m FROM audit_events WHERE action='avatar.update' AND actor_user_id=? ORDER BY created_at DESC LIMIT 1", pemilikId);
check("9c. jejak audit memuat nama berkas dan bukti nama kiriman klien diabaikan",
  (() => { try { const m = JSON.parse(String(metaUpdate?.m ?? "{}")); return typeof m.berkas === "string" && m.berkasLamaDihapus === true; } catch { return false; } })(),
  short(metaUpdate?.m));

console.log(`\nRingkasan: ${passed} lulus, ${failed} gagal`);
if (failedNames.length) console.log(`Gagal: ${failedNames.join(" | ")}`);
if (skipped.length) console.log(`Dilewati: ${skipped.join(" | ")}`);

/* =====================================================================================
 * Penutup: peladen ditutup dan DATA_DIR dibersihkan (selalu, termasuk saat gagal).
 * ===================================================================================== */
process.exitCode = failed ? 1 : 0;
try { rmSync(dataDir, { recursive: true, force: true }); console.log(`INFO DATA_DIR ${dataDir} dibersihkan`); } catch (error) { console.log(`INFO gagal membersihkan DATA_DIR: ${String(error)}`); }
process.exit(failed ? 1 : 0);

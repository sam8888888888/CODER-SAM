/**
 * Wave 11C (butir 76) — avatar agen & foto profil.
 *
 * Kontrak pemasangan rute: `registerAvatarRoutes(app)` dipanggil sekali dari `wave11c/index.ts`
 * (konvensi A2 PRD Wave 11); `server.ts` dan `wave11c/index.ts` milik lead, bukan berkas ini.
 *
 * Konvensi jawaban: setiap rute JSON membalas dengan pembungkus — `{ avatar: {...} }` untuk avatar
 * pengguna dan `{ agentAvatar: {...} }` untuk avatar agen. Rute media membalas BERKAS gambar, bukan JSON.
 *
 * Aturan yang dipegang berkas ini:
 *  • rahasia tidak ada di sini: avatar bukan rahasia, tetapi berkas mentah kiriman klien TIDAK PERNAH
 *    disimpan. Setiap unggahan ditulis ulang oleh `image-sanitize.ts` (metadata dibuang, dipotong
 *    persegi 512x512, hanya PNG 8-bit).
 *  • nama berkas tersimpan selalu dibuat peladen (tidak ada satu byte pun dari nama kiriman klien).
 *  • jalur berkas selalu diperiksa ada di dalam folder avatar; nama dari basis data yang menjelajah
 *    ditolak sebelum berkas dibuka.
 *  • batas laju per pengguna (bukan per alamat IP), supaya satu akun tidak membanjiri disk.
 *
 * Batas yang disebut apa adanya: JPEG dan WebP ditolak `503 IMAGE_PROCESSOR_UNAVAILABLE` karena di
 * peladen ini tidak ada pustaka pemroses gambar, dan menyimpan berkas mentah dilarang.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { createRateLimiter } from "../ratelimit.js";
import { adminRequired, audit, fail, isPlatformAdmin, platformSetting, savePlatformSetting } from "../wave11a/shared.js";
import { ImageError, bersihkanGambarAvatar, infoPng, sniffImageKind } from "./image-sanitize.js";

/** Kunci `platform_settings` tempat avatar agen disimpan (isinya JSON, berkasnya di folder avatar). */
export const AGENT_AVATAR_KEY = "agent_avatar";

/** Batas unggahan avatar per pengguna per jam. Lebih kecil dari batas API umum karena menulis berkas. */
export const AVATAR_UPLOAD_PER_HOUR = 20;

/** Batas laju khusus unggahan avatar, dikunci per pengguna (id), bukan per alamat IP. */
const pembatasUnggah = createRateLimiter({ windowMs: 60 * 60 * 1000, max: AVATAR_UPLOAD_PER_HOUR }, "avatar-upload");

/**
 * Batas isi permintaan: base64 dari `AVATAR_MAX_BYTES` + kelonggaran, supaya gambar yang sedikit
 * melebihi batas tetap sampai ke pemeriksa ukuran dan dijawab `413 AVATAR_TOO_LARGE` dengan pesan jelas
 * (bukan dipotong diam-diam oleh pengurai badan permintaan).
 */
const BATAS_BADAN = Math.ceil((config.AVATAR_MAX_BYTES * 4) / 3) + 64 * 1024;

/** Id pengguna yang diterima: huruf/angka/garis/dash saja. Ini menolak "../" sebelum apa pun dibuka. */
const POLA_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Folder avatar di dalam DATA_DIR (dibuat bila belum ada). */
export function folderAvatar(): string {
  const folder = join(config.DATA_DIR, config.AVATAR_DIR);
  mkdirSync(folder, { recursive: true });
  return folder;
}

/** Nama berkas tersimpan: dibuat peladen, awalan tetap, akhiran acak 8 byte. */
function namaBerkasBaru(awalan: string): string {
  return `${awalan}-${randomBytes(8).toString("hex")}.png`;
}

/**
 * Jalur berkas avatar dari nama yang tersimpan di basis data. Mengembalikan null bila nama itu bukan
 * nama berkas polos di dalam folder avatar (menolak "../", garis miring, dan jalur absolut).
 */
export function jalurBerkasAvatar(tersimpan: unknown): string | null {
  const nama = String(tersimpan ?? "").trim();
  if (!nama || nama !== basename(nama) || nama.includes("/") || nama.includes("\\") || nama.includes("..")) return null;
  const folder = resolve(config.DATA_DIR, config.AVATAR_DIR);
  const jalur = resolve(folder, nama);
  if (jalur === folder || !jalur.startsWith(folder + sep)) return null;
  return jalur;
}

/** Menghapus satu berkas avatar; mengembalikan true hanya bila berkasnya benar-benar hilang. */
function hapusBerkasAvatar(tersimpan: unknown): boolean {
  const jalur = jalurBerkasAvatar(tersimpan);
  if (!jalur || !existsSync(jalur)) return false;
  try { rmSync(jalur, { force: true }); } catch { return false; }
  return !existsSync(jalur);
}

/** Pemeriksaan berkas tersimpan: ukuran, dan ukuran gambar dibaca ulang dari header berkasnya. */
export function infoBerkasAvatar(tersimpan: string): { berkas: string; ukuran: number; lebar: number; tinggi: number; jenis: string } | null {
  const jalur = jalurBerkasAvatar(tersimpan);
  if (!jalur || !existsSync(jalur) || !statSync(jalur).isFile()) return null;
  const isi = readFileSync(jalur);
  const info = infoPng(isi);
  return { berkas: basename(jalur), ukuran: isi.length, lebar: info.width, tinggi: info.height, jenis: sniffImageKind(isi) };
}

/** Keadaan avatar pengguna: dibaca dari kolom `users.avatar_path` + berkasnya. */
export function keadaanAvatarPengguna(userId: string): { terpasang: boolean; berkas: string | null; ukuran: number | null; lebar: number | null; tinggi: number | null } {
  const baris = db.prepare("SELECT avatar_path AS path FROM users WHERE id=?").get(userId) as { path?: string | null } | undefined;
  const tersimpan = baris?.path ?? null;
  if (!tersimpan) return { terpasang: false, berkas: null, ukuran: null, lebar: null, tinggi: null };
  const info = infoBerkasAvatar(tersimpan);
  if (!info) return { terpasang: false, berkas: tersimpan, ukuran: null, lebar: null, tinggi: null };
  return { terpasang: true, berkas: info.berkas, ukuran: info.ukuran, lebar: info.lebar, tinggi: info.tinggi };
}

export type KeadaanAvatarAgen = {
  terpasang: boolean; berkas: string | null; ukuran: number | null; lebar: number | null; tinggi: number | null;
  diperbaruiPada: string | null; oleh: string | null; catatan: string;
};

/** Keadaan avatar agen: nilai `platform_settings.agent_avatar` + berkasnya. Selalu bisa dibaca. */
export function keadaanAvatarAgen(): KeadaanAvatarAgen {
  const mentah = platformSetting(AGENT_AVATAR_KEY);
  if (!mentah) return { terpasang: false, berkas: null, ukuran: null, lebar: null, tinggi: null, diperbaruiPada: null, oleh: null, catatan: "Avatar agen belum pernah dipasang." };
  let nilai: { berkas?: string; diperbaruiPada?: string; oleh?: string } = {};
  try { nilai = JSON.parse(mentah) as typeof nilai; } catch {
    return { terpasang: false, berkas: null, ukuran: null, lebar: null, tinggi: null, diperbaruiPada: null, oleh: null, catatan: "Nilai pengaturan agent_avatar rusak (bukan JSON); tidak ada berkas yang disajikan." };
  }
  const berkas = typeof nilai.berkas === "string" ? nilai.berkas : "";
  const info = berkas ? infoBerkasAvatar(berkas) : null;
  if (!info) {
    return { terpasang: false, berkas: berkas || null, ukuran: null, lebar: null, tinggi: null, diperbaruiPada: nilai.diperbaruiPada ?? null, oleh: nilai.oleh ?? null, catatan: "Pengaturan menunjuk berkas yang tidak ada atau tidak sah di folder avatar." };
  }
  return { terpasang: true, berkas: info.berkas, ukuran: info.ukuran, lebar: info.lebar, tinggi: info.tinggi, diperbaruiPada: nilai.diperbaruiPada ?? null, oleh: nilai.oleh ?? null, catatan: "Berkas ada dan sudah diperiksa ukurannya dari header berkas." };
}

/** Dua pengguna dianggap saling mengenal bila mereka anggota ruang kerja yang sama. */
export function berbagiRuangKerja(a: string, b: string): boolean {
  const baris = db.prepare(`SELECT COUNT(*) AS n FROM memberships m1 JOIN memberships m2 ON m2.workspace_id = m1.workspace_id
    WHERE m1.user_id=? AND m2.user_id=?`).get(a, b) as { n: number } | undefined;
  return Number(baris?.n ?? 0) > 0;
}

/** Base64 ketat: hanya abjad/base64 yang diterima, panjang kelipatan 4. */
function dekodeBase64(teks: string): Buffer {
  const bersih = teks.trim();
  if (!bersih || bersih.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(bersih)) throw new Error("INVALID_BASE64");
  const isi = Buffer.from(bersih, "base64");
  if (!isi.length) throw new Error("INVALID_BASE64");
  return isi;
}

/** Menerjemahkan galat pembersih gambar menjadi jawaban HTTP; galat lain dibiarkan naik. */
function jawabGalatGambar(reply: any, error: unknown) {
  if (error instanceof ImageError) return fail(reply, error.status, error.code, error.message);
  throw error;
}

export function registerAvatarRoutes(app: any): void {
  /* ------------------------------------------------------------- avatar pengguna sendiri */

  /**
   * PUT /api/v1/account/avatar — unggah avatar sendiri.
   * Badan permintaan JSON `{ contentBase64, declaredName?, declaredMimeType? }`; dua medan terakhir
   * hanya dicatat sebagai "diabaikan", karena jenis gambar ditentukan dari isi berkas.
   */
  app.put("/api/v1/account/avatar", { preHandler: requireUser, bodyLimit: BATAS_BADAN }, async (request: any, reply: any) => {
    const userId = String(request.user!.id);
    if (!pembatasUnggah.allow(userId)) {
      return fail(reply, 429, "AVATAR_RATE_LIMITED", `Terlalu banyak unggahan avatar (batas ${AVATAR_UPLOAD_PER_HOUR} per jam). Coba lagi nanti.`, {
        retryAfter: pembatasUnggah.retryAfterSeconds(userId),
      });
    }
    const mentahB64 = typeof request.body?.contentBase64 === "string" ? request.body.contentBase64 : null;
    if (mentahB64 === null) return fail(reply, 400, "INVALID_IMAGE_BODY", "Isi permintaan harus JSON {\"contentBase64\": \"...\"}.");
    let isi: Buffer;
    try { isi = dekodeBase64(mentahB64); }
    catch { return fail(reply, 400, "INVALID_BASE64", "Nilai contentBase64 bukan base64 yang sah."); }
    if (isi.length === 0) return fail(reply, 400, "IMAGE_EMPTY", "Berkas gambar kosong.");
    if (isi.length > config.AVATAR_MAX_BYTES) {
      return fail(reply, 413, "AVATAR_TOO_LARGE", `Ukuran berkas ${isi.length} byte melebihi batas ${config.AVATAR_MAX_BYTES} byte.`);
    }

    let hasil: ReturnType<typeof bersihkanGambarAvatar>;
    try { hasil = bersihkanGambarAvatar(isi, config.AVATAR_SIZE); }
    catch (error) { return jawabGalatGambar(reply, error); }

    const sebelumnya = db.prepare("SELECT avatar_path AS path FROM users WHERE id=?").get(userId) as { path?: string | null } | undefined;
    const nama = namaBerkasBaru("avatar");
    const folder = folderAvatar();
    writeFileSync(join(folder, nama), hasil.png, { mode: 0o600 });
    db.prepare("UPDATE users SET avatar_path=?, updated_at=? WHERE id=?").run(nama, new Date().toISOString(), userId);
    const berkasLamaDihapus = sebelumnya?.path ? hapusBerkasAvatar(sebelumnya.path) : false;
    audit(userId, "avatar.update", {
      berkas: nama, ukuran: hasil.png.length, lebar: hasil.lebar, tinggi: hasil.tinggi,
      asalLebar: hasil.asal.lebar, asalTinggi: hasil.asal.tinggi, chunkDibuang: hasil.chunkDibuang,
      berkasLama: sebelumnya?.path ?? null, berkasLamaDihapus,
      namaKlienDiabaikan: typeof request.body?.declaredName === "string" ? request.body.declaredName.slice(0, 120) : null,
      jenisKlienDiabaikan: typeof request.body?.declaredMimeType === "string" ? request.body.declaredMimeType.slice(0, 120) : null,
    });
    return {
      avatar: {
        userId, terpasang: true, berkas: nama, ukuran: hasil.png.length, lebar: hasil.lebar, tinggi: hasil.tinggi,
        jenis: "image/png", asal: hasil.asal, potong: hasil.potong, berkasLamaDihapus,
        namaKlienDipakai: false,
        catatan: "Gambar ditulis ulang peladen: metadata dibuang, dipotong persegi dari tengah, diskalakan ke sisi tetap. Nama berkas dibuat peladen.",
      },
    };
  });

  /** DELETE /api/v1/account/avatar — hapus avatar sendiri beserta berkasnya. */
  app.delete("/api/v1/account/avatar", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = String(request.user!.id);
    const baris = db.prepare("SELECT avatar_path AS path FROM users WHERE id=?").get(userId) as { path?: string | null } | undefined;
    if (!baris?.path) return fail(reply, 404, "AVATAR_NOT_FOUND", "Avatar belum ada, jadi tidak ada yang dihapus.");
    const nama = baris.path;
    db.prepare("UPDATE users SET avatar_path=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), userId);
    const berkasDihapus = hapusBerkasAvatar(nama);
    audit(userId, "avatar.delete", { berkas: nama, berkasDihapus });
    return { avatar: { userId, terpasang: false, berkasDihapus, berkas: nama } };
  });

  /* ------------------------------------------------------------- penyajian berkas */

  /** GET /api/v1/media/avatar/:userId — menyajikan berkas avatar dari folder avatar saja. */
  app.get("/api/v1/media/avatar/:userId", { preHandler: requireUser }, async (request: any, reply: any) => {
    const diminta = String(request.params?.userId ?? "");
    if (!POLA_ID.test(diminta)) return fail(reply, 400, "INVALID_USER_ID", "Id pengguna tidak sah (huruf, angka, garis, dan dash saja).");
    const baris = db.prepare("SELECT id, avatar_path AS path FROM users WHERE id=?").get(diminta) as { id: string; path?: string | null } | undefined;
    if (!baris?.path) return fail(reply, 404, "AVATAR_NOT_FOUND", "Pengguna ini belum punya avatar.");
    const penglihat = String(request.user!.id);
    // Avatar hanya terlihat oleh pemiliknya, admin platform, dan orang yang berbagi ruang kerja.
    // Pengguna lain dijawab 404 (bukan 403) supaya keberadaan avatar tidak bocor.
    if (penglihat !== baris.id && !isPlatformAdmin(request.user!) && !berbagiRuangKerja(penglihat, baris.id)) {
      return fail(reply, 404, "AVATAR_NOT_FOUND", "Avatar ini tidak terlihat oleh akun Anda.");
    }
    const jalur = jalurBerkasAvatar(baris.path);
    if (!jalur || !existsSync(jalur) || !statSync(jalur).isFile()) return fail(reply, 404, "AVATAR_FILE_MISSING", "Baris avatar ada, tetapi berkasnya tidak ada di folder avatar.");
    const isi = readFileSync(jalur);
    // Nama berkas berubah setiap kali avatar diganti, jadi singgahan peramban tidak menyajikan gambar lama.
    return reply.type("image/png").header("cache-control", "private, max-age=300").header("x-avatar-file", basename(jalur)).send(isi);
  });

  /** GET /api/v1/media/agent-avatar — avatar agen platform untuk pengguna yang sudah masuk. */
  app.get("/api/v1/media/agent-avatar", { preHandler: requireUser }, async (_request: any, reply: any) => {
    const keadaan = keadaanAvatarAgen();
    if (!keadaan.terpasang || !keadaan.berkas) return fail(reply, 404, "AGENT_AVATAR_NOT_FOUND", "Avatar agen belum dipasang.");
    const jalur = jalurBerkasAvatar(keadaan.berkas);
    if (!jalur || !existsSync(jalur)) return fail(reply, 404, "AVATAR_FILE_MISSING", "Pengaturan avatar agen menunjuk berkas yang tidak ada.");
    return reply.type("image/png").header("cache-control", "private, max-age=300").header("x-avatar-file", basename(jalur)).send(readFileSync(jalur));
  });

  /* ------------------------------------------------------------- avatar agen (admin) */

  /** GET /api/v1/admin/agent-avatar — keadaan saja, TIDAK pernah mengembalikan isi berkas. */
  app.get("/api/v1/admin/agent-avatar", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const keadaan = keadaanAvatarAgen();
    return { agentAvatar: { ...keadaan, mediaPath: keadaan.terpasang ? "/api/v1/media/agent-avatar" : null } };
  });

  /** PUT /api/v1/admin/agent-avatar — pasang/ganti avatar agen. Badan sama dengan avatar pengguna. */
  app.put("/api/v1/admin/agent-avatar", { preHandler: requireUser, bodyLimit: BATAS_BADAN }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const adminId = String(request.user!.id);
    const mentahB64 = typeof request.body?.contentBase64 === "string" ? request.body.contentBase64 : null;
    if (mentahB64 === null) return fail(reply, 400, "INVALID_IMAGE_BODY", "Isi permintaan harus JSON {\"contentBase64\": \"...\"}.");
    let isi: Buffer;
    try { isi = dekodeBase64(mentahB64); }
    catch { return fail(reply, 400, "INVALID_BASE64", "Nilai contentBase64 bukan base64 yang sah."); }
    if (isi.length === 0) return fail(reply, 400, "IMAGE_EMPTY", "Berkas gambar kosong.");
    if (isi.length > config.AVATAR_MAX_BYTES) {
      return fail(reply, 413, "AVATAR_TOO_LARGE", `Ukuran berkas ${isi.length} byte melebihi batas ${config.AVATAR_MAX_BYTES} byte.`);
    }

    let hasil: ReturnType<typeof bersihkanGambarAvatar>;
    try { hasil = bersihkanGambarAvatar(isi, config.AVATAR_SIZE); }
    catch (error) { return jawabGalatGambar(reply, error); }

    const sebelum = keadaanAvatarAgen();
    const nama = namaBerkasBaru("agent");
    writeFileSync(join(folderAvatar(), nama), hasil.png, { mode: 0o600 });
    const diperbaruiPada = new Date().toISOString();
    savePlatformSetting(AGENT_AVATAR_KEY, JSON.stringify({ berkas: nama, ukuran: hasil.png.length, lebar: hasil.lebar, tinggi: hasil.tinggi, diperbaruiPada, oleh: adminId }));
    const berkasLamaDihapus = sebelum.berkas ? hapusBerkasAvatar(sebelum.berkas) : false;
    audit(adminId, "admin.agent_avatar.update", {
      berkas: nama, ukuran: hasil.png.length, asalLebar: hasil.asal.lebar, asalTinggi: hasil.asal.tinggi,
      chunkDibuang: hasil.chunkDibuang, berkasLama: sebelum.berkas, berkasLamaDihapus,
    });
    return { agentAvatar: { ...keadaanAvatarAgen(), berkasLamaDihapus, mediaPath: "/api/v1/media/agent-avatar" } };
  });

  /** DELETE /api/v1/admin/agent-avatar — lepas avatar agen dan hapus berkasnya. */
  app.delete("/api/v1/admin/agent-avatar", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const keadaan = keadaanAvatarAgen();
    if (!keadaan.berkas && !platformSetting(AGENT_AVATAR_KEY)) {
      return fail(reply, 404, "AGENT_AVATAR_NOT_FOUND", "Avatar agen belum dipasang, jadi tidak ada yang dihapus.");
    }
    const berkasDihapus = keadaan.berkas ? hapusBerkasAvatar(keadaan.berkas) : false;
    db.prepare("DELETE FROM platform_settings WHERE key=?").run(AGENT_AVATAR_KEY);
    audit(String(request.user!.id), "admin.agent_avatar.delete", { berkas: keadaan.berkas, berkasDihapus });
    return { agentAvatar: { terpasang: false, berkas: null, ukuran: null, lebar: null, tinggi: null, diperbaruiPada: null, oleh: null, berkasDihapus, catatan: "Avatar agen dilepas; berkas dan pengaturannya dihapus." } };
  });
}

/**
 * Wave 11C (butir 81): identitas kanal bot (pemasangan chat/nomor ke akun platform).
 *
 * Alur: pengguna masuk dasbor -> `POST /api/v1/bot-identities/link-code` -> dapat kode 6 angka yang
 * berlaku `BOT_LINK_CODE_TTL_MINUTES` menit dan hanya bisa dipakai SEKALI. Kode dikirim ke bot
 * (`/taut <kode>`) atau dipasang lewat `POST /api/v1/bots/:channelId/link`.
 *
 * Di basis data kode TIDAK pernah disimpan apa adanya: kolom `code_hash` memuat SHA-256 dari
 * `bot-link:<channelId>:<kode>`. Baris yang belum dipakai diberi `external_id = 'pending:<uuid>'`
 * (skema v21 tidak punya kolom status) dan dihapus/diubah saat pemasangan berhasil. Percobaan salah
 * dibatasi `BOT_LINK_MAX_ATTEMPTS` per (kanal, identitas) memakai pembatas laju bersama.
 *
 * Satu external_id hanya boleh melayani satu akun: penautan ke akun lain ditolak 409.
 */
import { randomInt, randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { audit, fail, isPlatformAdmin } from "../wave11a/shared.js";
import { channelById, hashKode, tautkanIdentitas, type BotProvider } from "./bot-core.js";

const CARA_PAKAI = "Kirim kode ini ke bot sebagai perintah: /taut <kode>. Kode hanya bisa dipakai sekali dan berlaku terbatas.";

function kodeBaru(): string {
  // 6 angka, dipilih acak seragam (000000..999999) supaya tidak bisa ditebak dari urutan.
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Kanal tujuan: yang diminta, atau kanal aktif pertama (Telegram lebih dulu) bila tidak disebut. */
function kanalTujuan(channelId: string) {
  if (channelId) return channelById(channelId);
  const aktif = db.prepare("SELECT id FROM bot_channels WHERE enabled=1 ORDER BY CASE provider WHEN 'telegram' THEN 0 ELSE 1 END, created_at ASC LIMIT 1")
    .get() as { id?: string } | undefined;
  return aktif?.id ? channelById(String(aktif.id)) : undefined;
}

const IDENT_COLUMNS = `bi.id AS id, bi.channel_id AS channelId, bc.provider AS provider, bc.name AS kanal,
  bi.external_id AS externalId, bi.user_id AS userId, bi.linked_at AS linkedAt, bi.used_at AS usedAt`;

function identitasMilik(userId: string) {
  return db.prepare(`SELECT ${IDENT_COLUMNS} FROM bot_identities bi JOIN bot_channels bc ON bc.id = bi.channel_id
    WHERE bi.user_id=? AND bi.external_id NOT LIKE 'pending:%' ORDER BY bi.linked_at ASC`).all(userId) as Array<Record<string, unknown>>;
}

export function registerBotIdentityRoutes(app: any): void {
  /** Terbitkan kode pemasangan sekali pakai untuk pengguna yang sedang masuk. */
  app.post("/api/v1/bot-identities/link-code", { preHandler: requireUser }, async (request: any, reply: any) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const channel = kanalTujuan(String(body.channelId ?? "").trim());
    if (!channel) return fail(reply, 404, "CHANNEL_NOT_FOUND", "Belum ada kanal bot yang aktif. Minta admin mengaktifkan kanal dulu.");
    if (!channel.enabled) return fail(reply, 403, "CHANNEL_DISABLED", "Kanal bot ini sedang dimatikan admin.");
    const userId = String(request.user!.id);
    const kode = kodeBaru();
    const sekarang = new Date();
    const kedaluwarsa = new Date(sekarang.getTime() + config.BOT_LINK_CODE_TTL_MINUTES * 60_000).toISOString();
    // Kode lama yang belum dipakai dibuang: satu pengguna satu kode aktif per kanal.
    db.prepare("DELETE FROM bot_identities WHERE channel_id=? AND user_id=? AND external_id LIKE 'pending:%'").run(channel.id, userId);
    const id = randomUUID();
    db.prepare(`INSERT INTO bot_identities (id, channel_id, external_id, user_id, linked_at, code_hash, code_expires_at, used_at)
      VALUES (?,?,?,?,?,?,?,NULL)`)
      .run(id, channel.id, `pending:${randomUUID()}`, userId, sekarang.toISOString(), hashKode(channel.id, kode), kedaluwarsa);
    audit(userId, "bot_identity.link_code_created", { channelId: channel.id, identityId: id, berlakuMenit: config.BOT_LINK_CODE_TTL_MINUTES });
    return {
      kode: {
        kode, identityId: id, channelId: channel.id, kanal: channel.name, provider: channel.provider as BotProvider,
        berlakuMenit: config.BOT_LINK_CODE_TTL_MINUTES, kedaluwarsa, caraPakai: CARA_PAKAI,
        perintah: `/taut ${kode}`, maksPercobaan: config.BOT_LINK_MAX_ATTEMPTS,
      },
    };
  });

  /** Daftar identitas milik pengguna (tanpa rahasia apa pun). */
  app.get("/api/v1/bot-identities", { preHandler: requireUser }, async (request: any) => {
    return { identitas: identitasMilik(String(request.user!.id)) };
  });

  /** Pemasangan dari luar kanal (mis. tombol di dasbor atau skrip kanal): kode sebagai rahasianya. */
  app.post("/api/v1/bots/:channelId/link", async (request: any, reply: any) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const externalId = String(body.external_id ?? body.externalId ?? "").trim();
    const kode = String(body.code ?? body.kode ?? "").trim();
    if (!externalId) return fail(reply, 400, "EXTERNAL_ID_REQUIRED", "Isi 'external_id' (chat id Telegram atau nomor WhatsApp).");
    const hasil = tautkanIdentitas(String(request.params?.channelId ?? ""), externalId, kode);
    if (!hasil.ok) return fail(reply, hasil.status, hasil.error, hasil.message);
    const identitas = hasil.identitas;
    return {
      identitas: {
        id: identitas.id, channelId: identitas.channelId, externalId: identitas.externalId,
        userId: identitas.userId, linkedAt: identitas.linkedAt,
      },
      pesan: hasil.pesan,
    };
  });

  /** Cabut tautan: pemilik boleh mencabut miliknya; admin boleh mencabut milik siapa pun. */
  app.delete("/api/v1/bot-identities/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const id = String(request.params?.id ?? "");
    const baris = db.prepare("SELECT id, user_id AS userId, channel_id AS channelId, external_id AS externalId FROM bot_identities WHERE id=?")
      .get(id) as { id: string; userId: string; channelId: string; externalId: string } | undefined;
    if (!baris) return fail(reply, 404, "IDENTITY_NOT_FOUND", "Identitas bot tidak ditemukan.");
    const pemilik = String(request.user!.id) === String(baris.userId);
    const admin = isPlatformAdmin(request.user!);
    if (!pemilik && !admin) return fail(reply, 403, "FORBIDDEN", "Hanya pemilik identitas atau admin platform yang boleh mencabut tautan ini.");
    db.prepare("DELETE FROM bot_identities WHERE id=?").run(id);
    audit(String(request.user!.id), "bot_identity.revoked", {
      identityId: id, channelId: baris.channelId, externalId: baris.externalId, olehAdminLain: !pemilik && admin,
    });
    return { dihapus: true, id, oleh: pemilik ? "pemilik" : "admin" };
  });
}

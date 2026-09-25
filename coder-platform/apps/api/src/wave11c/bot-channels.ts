/**
 * Wave 11C (butir 69/70): pengaturan kanal bot oleh admin platform.
 *
 * `GET /api/v1/admin/bot-channels` menampilkan seluruh kanal dalam bentuk TERSAMAR; `PUT` membuat
 * atau mengubah satu kanal (token bot / auth token Twilio disegel, nama agen, tagline, enabled).
 * Rahasia tidak pernah dikembalikan API — hanya `{ terpasang, ekor }`.
 *
 * Saat kanal Telegram disimpan dengan token bot dan `BOT_WEBHOOK_BASE_URL` terisi, modul ini juga
 * mendaftarkan webhook ke Telegram (`setWebhook`) dengan rahasia yang sama seperti yang dibandingkan
 * rute webhook. Alamat hulu memakai `config.TELEGRAM_API_BASE`, jadi bisa dialihkan di uji.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { SecretsKeyError, maskSecret, tryOpenSecret } from "../secrets.js";
import { adminRequired, audit, fail, isPlatformAdmin } from "../wave11a/shared.js";
import {
  channelById, channelConfig, channelSecret, dasarWebhookPublik, panggilTelegram, sealForStorage, type BotChannelRow, type BotProvider, webhookPath,
} from "./bot-core.js";

const PROVIDERS: BotProvider[] = ["telegram", "whatsapp"];


/** Bentuk kanal untuk API: tanpa rahasia, hanya penanda terpasang dan ekornya. */
function channelView(channel: BotChannelRow, tambahan: Record<string, unknown> = {}) {
  const cfg = channelConfig(channel);
  const token = String((cfg as { token?: unknown }).token ?? (cfg as { authToken?: unknown }).authToken ?? "");
  const rahasia = tryOpenSecret(String(channel.configCiphertext ?? ""));
  const tokenAda = Boolean(token) || (String(channel.configCiphertext ?? "").length > 0);
  const secret = channelSecret(channel);
  return {
    id: channel.id,
    provider: channel.provider,
    name: channel.name,
    enabled: Boolean(channel.enabled),
    agentName: channel.agentName,
    tagline: channel.tagline,
    rahasia: tokenAda
      ? { ...maskSecret(token), dapatDibaca: rahasia.ok, jenis: channel.provider === "telegram" ? "token bot" : "auth token" }
      : { terpasang: false, ekor: "", dapatDibaca: rahasia.ok, jenis: channel.provider === "telegram" ? "token bot" : "auth token" },
    webhook: {
      jalur: webhookPath(channel),
      rahasiaTerpasang: Boolean(secret),
      url: dasarWebhookPublik() ? dasarWebhookPublik() + webhookPath(channel) : null,
      ...tambahan,
    },
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function daftarKanal(): BotChannelRow[] {
  return db.prepare(`SELECT id, provider, name, config_ciphertext AS configCiphertext, enabled,
      agent_name AS agentName, tagline, webhook_secret AS webhookSecret, created_at AS createdAt, updated_at AS updatedAt
    FROM bot_channels ORDER BY created_at ASC`).all() as BotChannelRow[];
}

export function registerBotChannelRoutes(app: any): void {
  app.get("/api/v1/admin/bot-channels", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    return { channels: daftarKanal().map((channel) => channelView(channel)) };
  });

  app.put("/api/v1/admin/bot-channels", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = String(body.id ?? "").trim();
    const sekarang = channelById(id);
    if (id && !sekarang) return fail(reply, 404, "CHANNEL_NOT_FOUND", "Kanal bot tidak ditemukan.");
    const providerRaw = String(body.provider ?? sekarang?.provider ?? "").trim().toLowerCase();
    if (!PROVIDERS.includes(providerRaw as BotProvider)) {
      return fail(reply, 400, "INVALID_PROVIDER", "Penyedia kanal harus 'telegram' atau 'whatsapp'.");
    }
    const provider = providerRaw as BotProvider;
    const tokenBaru = typeof body.token === "string" ? body.token.trim() : "";
    const accountSid = typeof body.accountSid === "string" ? body.accountSid.trim() : "";
    const fromNumber = typeof body.fromNumber === "string" ? body.fromNumber.trim() : "";
    if (!sekarang && !tokenBaru) {
      return fail(reply, 400, "TOKEN_REQUIRED", provider === "telegram"
        ? "Token bot Telegram wajib diisi saat membuat kanal."
        : "Auth token Twilio wajib diisi saat membuat kanal.");
    }
    // Isi rahasia digabung: kolom yang tidak dikirim tidak menghapus nilai lama.
    const cfg = { ...channelConfig(sekarang ?? ({ configCiphertext: "" } as BotChannelRow)) } as Record<string, string>;
    if (tokenBaru) { if (provider === "telegram") cfg.token = tokenBaru; else cfg.authToken = tokenBaru; }
    if (accountSid) cfg.accountSid = accountSid;
    if (fromNumber) cfg.fromNumber = fromNumber;
    if (provider === "telegram") delete cfg.authToken;
    if (provider === "whatsapp" && (!String(cfg.authToken ?? "") || !String(cfg.accountSid ?? "") || !String(cfg.fromNumber ?? ""))) {
      return fail(reply, 400, "WHATSAPP_CONFIG_INCOMPLETE", "Kanal WhatsApp butuh auth token Twilio, Account SID, dan nomor pengirim (From).");
    }
    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 80)
      : (sekarang?.name || (provider === "telegram" ? "Bot Telegram" : "Bot WhatsApp"));
    const agentName = typeof body.agentName === "string" ? body.agentName.trim().slice(0, 60) : (sekarang?.agentName ?? "Asisten");
    const tagline = typeof body.tagline === "string" ? body.tagline.trim().slice(0, 120) : (sekarang?.tagline ?? "");
    const enabled = typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : (sekarang?.enabled ?? 0);
    const rahasiaBaru = typeof body.webhookSecret === "string" && body.webhookSecret.trim().length >= 8
      ? body.webhookSecret.trim().slice(0, 200) : null;
    let ciphertext: string;
    let secretTersegel: string;
    try {
      ciphertext = sealForStorage(JSON.stringify(cfg));
      secretTersegel = sealForStorage(rahasiaBaru ?? (channelSecret(sekarang ?? ({ webhookSecret: "" } as BotChannelRow)) || randomBytes(24).toString("hex")));
    } catch (error) {
      if (error instanceof SecretsKeyError) {
        return fail(reply, 503, "SECRETS_KEY_MISSING", "Penyimpanan rahasia platform belum dikonfigurasi, jadi token bot tidak bisa disimpan.");
      }
      throw error;
    }
    const now = new Date().toISOString();
    // `||`, bukan `??`: saat membuat kanal baru `id` bernilai "" (bukan null), dan id kosong akan
    // menghasilkan kanal tanpa id sehingga jalur webhook-nya rusak.
    const channelId = String(sekarang?.id || id || randomUUID());
    if (sekarang) {
      db.prepare(`UPDATE bot_channels SET provider=?, name=?, config_ciphertext=?, enabled=?, agent_name=?, tagline=?, webhook_secret=?, updated_at=? WHERE id=?`)
        .run(provider, name, ciphertext, enabled, agentName, tagline, secretTersegel, now, channelId);
    } else {
      db.prepare(`INSERT INTO bot_channels (id, provider, name, config_ciphertext, enabled, agent_name, tagline, webhook_secret, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(channelId, provider, name, ciphertext, enabled, agentName, tagline, secretTersegel, now, now);
    }
    const kanal = channelById(channelId)!;
    // Pendaftaran webhook Telegram: dilakukan platform supaya rahasia tidak perlu diketik manual.
    let info: Record<string, unknown> = { terdaftar: false, pesan: "Pendaftaran webhook hanya untuk kanal Telegram." };
    if (provider === "telegram" && tokenBaru && body.pasangWebhook !== false) {
      const base = dasarWebhookPublik();
      if (!base) {
        info = { terdaftar: false, url: null, pesan: "Alamat publik platform belum diisi (BOT_WEBHOOK_BASE_URL / PUBLIC_BASE_URL), jadi webhook tidak didaftarkan otomatis." };
      } else {
        const url = `${base}${webhookPath(kanal)}`;
        const hasil = await panggilTelegram(kanal, "setWebhook", { url, secret_token: channelSecret(kanal), allowed_updates: ["message"] });
        info = { terdaftar: hasil.ok, url, status: hasil.status, pesan: hasil.ok ? "Webhook terdaftar di Telegram." : hasil.text };
      }
    }
    audit(request.user!.id, "bot_channel.saved", {
      channelId, provider, name, enabled: Boolean(enabled), tokenDiganti: Boolean(tokenBaru),
      agentName, tagline, webhookTerdaftar: Boolean(info.terdaftar),
    });
    return { channel: channelView(kanal, info) };
  });
}

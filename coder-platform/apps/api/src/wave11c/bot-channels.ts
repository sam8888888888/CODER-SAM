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
 *
 * Butir 69 (v0.23.1): `POST /api/v1/admin/bot-channels/:id/test` mengirim SATU pesan uji lewat kanal
 * yang TERSIMPAN, memakai pemanggil Telegram yang sama dengan balasan sungguhan (`kirimTelegram`,
 * termasuk jatuh ke teks polos saat Markdown ditolak). Rute ini hanya untuk admin platform, dibatasi
 * 3 percobaan / 10 menit per kanal, dan TIDAK PERNAH mengembalikan token bot. Kegagalan hulu dijawab
 * apa adanya: 502 TELEGRAM_UPSTREAM_ERROR dengan teks jawaban Telegram di `detail.pesanHulu`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { SecretsKeyError, maskSecret, tryOpenSecret } from "../secrets.js";
import { createRateLimiter } from "../ratelimit.js";
import { adminRequired, audit, fail, isPlatformAdmin } from "../wave11a/shared.js";
import {
  channelById, channelConfig, channelSecret, dasarWebhookPublik, kirimTelegram, panggilTelegram, sealForStorage, type BotChannelRow, type BotProvider, webhookPath,
} from "./bot-core.js";

const PROVIDERS: BotProvider[] = ["telegram", "whatsapp"];

/**
 * Batas laju "uji kirim": 3 percobaan / 10 menit per KANAL (bukan per admin), supaya satu kanal yang
 * bermasalah tidak bisa dihujani percobaan berulang dari banyak tab. Bisa dinaikkan lewat
 * `BOT_TEST_PER_10MIN` bila operator memang butuh lebih.
 */
const BOT_TEST_PER_WINDOW = Math.max(1, Math.floor(Number(process.env.BOT_TEST_PER_10MIN ?? "") || 3));
const BOT_TEST_WINDOW_MS = 10 * 60 * 1000;
/** Diekspor supaya suite bisa mengosongkan baknya sebelum membuktikan batas laju benar-benar bekerja. */
export const testSendLimiter = createRateLimiter({ windowMs: BOT_TEST_WINDOW_MS, max: BOT_TEST_PER_WINDOW }, "bot-test");

/**
 * Tujuan uji: chat id yang dikirim admin, atau - bila admin tidak mengisi - external_id yang paling
 * baru dipasang ke kanal ini. Baris `pending:` tidak dihitung karena belum tentu chat nyata.
 * Hasil kosong berarti tidak ada tujuan yang bisa dibuktikan, jadi rute menjawab 409 BOT_TEST_TARGET_MISSING.
 */
function tujuanUji(channelId: string, dariBadan: string): string {
  if (dariBadan) return dariBadan;
  const baris = db.prepare(`SELECT external_id AS externalId FROM bot_identities
    WHERE channel_id=? AND external_id NOT LIKE 'pending:%' ORDER BY linked_at DESC LIMIT 1`).get(channelId) as { externalId?: string } | undefined;
  return String(baris?.externalId ?? "").trim();
}

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

  /**
   * Butir 69 (v0.23.1): kirim SATU pesan uji ke kanal bot yang tersimpan.
   * Urutan pemeriksaan: sesi (`requireUser`) -> admin platform -> kanal ada -> kanal Telegram ->
   * tujuan ada -> token ada -> batas laju -> hulu. Batas laju diperiksa SESUDAH pemeriksaan bentuk
   * supaya kanal yang belum lengkap tidak memakan jatah percobaan admin.
   */
  app.post("/api/v1/admin/bot-channels/:id/test", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const kanal = channelById(String(request.params?.id ?? ""));
    if (!kanal) return fail(reply, 404, "CHANNEL_NOT_FOUND", "Kanal bot tidak ditemukan.");
    if (kanal.provider !== "telegram") {
      // Kanal WhatsApp belum punya jalur uji yang jujur, jadi permintaannya ditolak alih-alih
      // berpura-pura berhasil. Alasannya ikut di `detail` supaya bisa dibaca mesin.
      return fail(reply, 409, "BOT_TEST_UNSUPPORTED_PROVIDER", "Uji kirim baru tersedia untuk kanal Telegram.", {
        detail: { provider: kanal.provider, penyediaDidukung: ["telegram"] },
      });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tujuan = tujuanUji(kanal.id, String(body.chatId ?? body.ke ?? "").trim());
    const token = String((channelConfig(kanal) as { token?: unknown }).token ?? "").trim();
    if (!tujuan || !token) {
      return fail(reply, 409, "BOT_TEST_TARGET_MISSING", !token
        ? "Kanal Telegram ini belum lengkap: token bot belum tersimpan, jadi pesan uji tidak bisa dikirim."
        : "Tidak ada tujuan uji. Isi chat id, atau pasang satu akun ke kanal ini lebih dulu supaya ada tujuan yang tersimpan.", {
        detail: { kekurangan: [!token ? "token" : null, !tujuan ? "tujuan" : null].filter(Boolean), kanal: kanal.id },
      });
    }
    if (!testSendLimiter.allow(kanal.id)) {
      const tunggu = testSendLimiter.retryAfterSeconds(kanal.id);
      return fail(reply, 429, "BOT_TEST_RATE_LIMITED", `Maksimal ${BOT_TEST_PER_WINDOW} uji kirim per 10 menit untuk satu kanal. Coba lagi setelah ${tunggu} detik.`, {
        detail: { max: BOT_TEST_PER_WINDOW, windowMs: BOT_TEST_WINDOW_MS, retryAfter: tunggu, kanal: kanal.id },
      });
    }
    const teks = String(body.teks ?? "").trim().slice(0, 3000) || "Uji kirim dari COBLAI Coder.";
    let hasil;
    try {
      // Pemanggil yang sama dengan balasan sungguhan: Markdown lebih dulu, lalu teks polos.
      hasil = await kirimTelegram(kanal, tujuan, teks);
    } catch (error) {
      const pesanHulu = String((error as Error)?.message ?? error);
      audit(request.user!.id, "bot_channel.tested", {
        channelId: kanal.id, provider: kanal.provider, tujuanEkor: tujuan.slice(-4), terkirim: false, jalur: "koneksi", galat: pesanHulu,
      });
      return fail(reply, 502, "TELEGRAM_UPSTREAM_ERROR", "Telegram tidak bisa dihubungi dari platform.", {
        detail: { pesanHulu, statusHulu: [], jalur: "koneksi" },
      });
    }
    if (!hasil.ok) {
      // Alasan hulu ikut dicatat di audit (`galat`) supaya penolakan bisa DITELUSURI, bukan hanya dilihat
      // sekali di layar. Ini juga jejak yang dibutuhkan admin saat Telegram mengganti pesan galatnya.
      audit(request.user!.id, "bot_channel.tested", {
        channelId: kanal.id, provider: kanal.provider, tujuanEkor: tujuan.slice(-4), terkirim: false,
        jalur: hasil.jalur, statusHulu: hasil.statuses, galat: hasil.pesan,
      });
      // Jawaban hulu diteruskan APA ADANYA di `detail.pesanHulu`; layar tidak pernah menulis "berhasil".
      return fail(reply, 502, "TELEGRAM_UPSTREAM_ERROR", `Telegram menolak pesan uji (HTTP ${hasil.statuses.join(",") || "tanpa jawaban"}).`, {
        detail: { pesanHulu: hasil.pesan, statusHulu: hasil.statuses, jalur: hasil.jalur },
      });
    }
    audit(request.user!.id, "bot_channel.tested", {
      channelId: kanal.id, provider: kanal.provider, tujuanEkor: tujuan.slice(-4), terkirim: true,
      jalur: hasil.jalur, statusHulu: hasil.statuses, panjangTeks: teks.length,
    });
    // Jawaban sukses tidak memuat rahasia: hanya bentuk kanal yang sudah tersamar (`channelView`).
    return {
      terkirim: true, jalur: hasil.jalur, statusHulu: hasil.statuses, tujuan,
      panjangTeks: teks.length, pesanHulu: hasil.pesan, kanal: channelView(kanal),
    };
  });
}

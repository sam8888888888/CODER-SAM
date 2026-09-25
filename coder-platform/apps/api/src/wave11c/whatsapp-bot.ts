/**
 * Wave 11C (butir 70): webhook bot WhatsApp lewat Twilio.
 *
 * Keamanan: tanda tangan `X-Twilio-Signature` = HMAC-SHA1 (base64) atas URL publik permintaan
 * ditambah seluruh parameter form yang diurutkan menurut nama, memakai auth token Twilio kanal.
 * URL publik dihitung dari `BOT_WEBHOOK_BASE_URL` (lalu `PUBLIC_BASE_URL`), kalau tidak dari header
 * `x-forwarded-proto`/`x-forwarded-host`/`host`. Tanpa tanda tangan yang sah: 401 SIGNATURE_INVALID.
 *
 * Balasan selalu berbentuk TwiML kosong (200) supaya Twilio tidak mengulang kirim; isi jawaban
 * dikirim menyusul lewat pekerja `bot.reply` ke API Messages Twilio. Tanda `?format=json` hanya untuk
 * pemeriksaan manual/uji — Twilio tidak pernah mengirimnya.
 */
import { createHmac } from "node:crypto";
import {
  channelById, channelConfig, dasarWebhookPublik, kirimWhatsApp, tanganiPesanMasuk, teksSamaAman, type WhatsappConfig,
} from "./bot-core.js";
import { fail } from "../wave11a/shared.js";

const TWIML_KOSONG = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>";

/** Tanda tangan Twilio: HMAC-SHA1 atas URL + pasangan parameter terurut (nama lalu nilai). */
export function tandaTanganTwilio(authToken: string, url: string, params: Record<string, string>): string {
  let bahan = url;
  for (const nama of Object.keys(params).sort()) bahan += `${nama}${params[nama]}`;
  return createHmac("sha1", authToken).update(Buffer.from(bahan, "utf8")).digest("base64");
}

/** URL publik seperti yang dilihat Twilio (di balik proxy) supaya tanda tangan bisa dihitung ulang. */
export function urlPublik(request: any): string {
  // Dasar yang sama dengan pendaftaran webhook (BOT_WEBHOOK_BASE_URL lalu PUBLIC_BASE_URL), supaya
  // URL yang ditandatangani Twilio selalu sama dengan URL yang kita pakai untuk memverifikasi.
  const dasar = dasarWebhookPublik();
  if (dasar) return `${dasar}${request.url}`;
  const proto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
  return `${proto}://${host}${request.url}`;
}

/** Parameter form apa adanya (string), baik body sudah diurai Fastify maupun masih mentah. */
export function parameterForm(body: unknown): Record<string, string> {
  const hasil: Record<string, string> = {};
  if (!body) return hasil;
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    for (const [nama, nilai] of new URLSearchParams(String(body))) hasil[nama] = nilai;
    return hasil;
  }
  if (typeof body === "object") {
    for (const [nama, nilai] of Object.entries(body as Record<string, unknown>)) {
      if (nilai === undefined || nilai === null) continue;
      hasil[nama] = Array.isArray(nilai) ? String(nilai[0]) : String(nilai);
    }
  }
  return hasil;
}

export function registerWhatsappBotRoutes(app: any): void {
  // Twilio mengirim webhook sebagai `application/x-www-form-urlencoded`, sedangkan Fastify hanya
  // mengenal JSON secara bawaan. Tipe isi ini didaftarkan modul ini sendiri (tanpa mengubah
  // server.ts): isi mentah diteruskan apa adanya, lalu `parameterForm` yang mengurainya. Tanpa ini
  // webhook WhatsApp menjawab 415 dan tanda tangan Twilio tidak pernah bisa dihitung.
  try {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req: unknown, body: string, done: (error: Error | null, hasil?: unknown) => void) => {
      done(null, body);
    });
  } catch { /* sudah didaftarkan pemanggil lain: tidak masalah, isi tetap diteruskan sebagai teks */ }
  app.post("/api/v1/bots/whatsapp/webhook/:channelId", async (request: any, reply: any) => {
    const channel = channelById(String(request.params?.channelId ?? ""));
    if (!channel || channel.provider !== "whatsapp") {
      return fail(reply, 404, "CHANNEL_NOT_FOUND", "Kanal bot WhatsApp tidak ditemukan.");
    }
    if (!channel.enabled) return fail(reply, 403, "CHANNEL_DISABLED", "Kanal bot ini sedang dimatikan admin.");
    const cfg = channelConfig(channel) as Partial<WhatsappConfig>;
    const authToken = String(cfg.authToken ?? "");
    const params = parameterForm(request.body);
    const tandaTangan = String(request.headers["x-twilio-signature"] ?? "");
    const diharapkan = authToken ? tandaTanganTwilio(authToken, urlPublik(request), params) : "";
    if (!authToken || !tandaTangan || !diharapkan || !teksSamaAman(tandaTangan, diharapkan)) {
      return fail(reply, 401, "SIGNATURE_INVALID", "Tanda tangan webhook WhatsApp tidak sah.");
    }
    const dari = String(params.From ?? "");
    const isi = String(params.Body ?? "");
    const nomorKanal = String((cfg as Partial<WhatsappConfig>).fromNumber ?? "");
    if (nomorKanal && String(params.To ?? "") && String(params.To) !== nomorKanal) {
      return fail(reply, 400, "TO_NUMBER_MISMATCH", "Webhook ini bukan untuk nomor pengirim kanal ini.");
    }
    const mintaJson = String(request.query?.format ?? "").toLowerCase() === "json";
    if (!dari || !isi.trim()) {
      return mintaJson ? { diterima: false, alasan: "TIDAK_ADA_TEKS" }
        : reply.code(200).header("content-type", "application/xml").send(TWIML_KOSONG);
    }
    const hasil = await tanganiPesanMasuk({
      channel, provider: "whatsapp", externalId: dari, chatId: dari,
      chatLabel: String(params.ProfileName ?? dari), isGroup: false, text: isi,
    });
    let balasan: { terkirim: boolean; statusHulu: number[] } | null = null;
    if (hasil.balasan) {
      const kirim = await kirimWhatsApp(channel, dari, hasil.balasan).catch(() => null);
      balasan = { terkirim: Boolean(kirim?.ok), statusHulu: kirim?.statuses ?? [] };
    }
    const ringkas = {
      diterima: hasil.terima, error: hasil.error, runId: hasil.runId,
      conversationId: hasil.conversationId, jalur: hasil.jalur, balasan,
    };
    if (mintaJson) return ringkas;
    return reply.code(200).header("content-type", "application/xml").send(TWIML_KOSONG);
  });
}

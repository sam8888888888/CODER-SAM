/**
 * Wave 11C (butir 69): webhook bot Telegram.
 *
 * Rute ini publik (Telegram yang memanggil), jadi keamanannya bergantung pada rahasia header
 * `X-Telegram-Bot-Api-Secret-Token` yang dibandingkan dengan `bot_channels.webhook_secret` kanal
 * (perbandingan waktu-tetap). Tanpa rahasia yang cocok: 401 SIGNATURE_INVALID, dan pesan TIDAK pernah
 * sampai ke jalur run.
 *
 * Seluruh aturan pesan (pemasangan, pagar akun, kuota, filter hijack, larangan, percakapan + run,
 * antrean balasan) ada di `bot-core.ts`; berkas ini hanya menerjemahkan update Telegram dan mengirim
 * balasan penolakan supaya pengguna tahu apa yang terjadi.
 */
import { channelById, channelSecret, kirimTelegram, panggilTelegram, tanganiPesanMasuk, teksSamaAman } from "./bot-core.js";
import { fail } from "../wave11a/shared.js";

/** Kirim teks penolakan apa adanya (teks polos) supaya tidak ada kegagalan format kedua. */
async function kirimPenolakan(channel: Parameters<typeof kirimTelegram>[0], chatId: string, teks: string) {
  if (!chatId) return { terkirim: false, jalur: "teks_polos", foto: null, statuses: [] as number[], pesan: "chat id kosong" };
  try {
    const hasil = await panggilTelegram(channel, "sendMessage", { chat_id: chatId, text: teks });
    return { terkirim: hasil.ok, jalur: "teks_polos", foto: null, statuses: [hasil.status], pesan: hasil.text };
  } catch (error) {
    return { terkirim: false, jalur: "teks_polos", foto: null, statuses: [] as number[], pesan: String((error as Error).message) };
  }
}

export function registerTelegramBotRoutes(app: any): void {
  app.post("/api/v1/bots/telegram/webhook/:channelId", async (request: any, reply: any) => {
    const channel = channelById(String(request.params?.channelId ?? ""));
    if (!channel || channel.provider !== "telegram") {
      return fail(reply, 404, "CHANNEL_NOT_FOUND", "Kanal bot Telegram tidak ditemukan.");
    }
    if (!channel.enabled) return fail(reply, 403, "CHANNEL_DISABLED", "Kanal bot ini sedang dimatikan admin.");
    const rahasia = channelSecret(channel);
    const dikirim = String(request.headers["x-telegram-bot-api-secret-token"] ?? "");
    if (!rahasia || !dikirim || !teksSamaAman(dikirim, rahasia)) {
      return fail(reply, 401, "SIGNATURE_INVALID", "Rahasia webhook Telegram tidak sah.");
    }
    const update = (request.body ?? {}) as Record<string, any>;
    const message = update.message ?? update.edited_message ?? null;
    if (!message) return { diterima: false, alasan: "UPDATE_TIDAK_DIDUKUNG" };
    const chat = (message.chat ?? {}) as Record<string, any>;
    const from = (message.from ?? {}) as Record<string, any>;
    const teks = String(message.text ?? message.caption ?? "");
    if (!teks.trim()) return { diterima: false, alasan: "TIDAK_ADA_TEKS" };
    const tipe = String(chat.type ?? "private");
    const isGroup = tipe === "group" || tipe === "supergroup";
    const chatId = String(chat.id ?? from.id ?? "");
    const externalId = isGroup ? String(from.id ?? chat.id ?? "") : String(chat.id ?? from.id ?? "");
    const label = String(chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? chat.username ?? "");
    const hasil = await tanganiPesanMasuk({
      channel, provider: "telegram", externalId, chatId, chatLabel: label, isGroup, text: teks,
    });
    const balasan = hasil.balasan ? await kirimPenolakan(channel, chatId, hasil.balasan) : null;
    return {
      diterima: hasil.terima,
      error: hasil.error,
      runId: hasil.runId,
      conversationId: hasil.conversationId,
      jalur: hasil.jalur,
      balasan: balasan ? { terkirim: balasan.terkirim, jalur: balasan.jalur, statusHulu: balasan.statuses } : null,
    };
  });
}

/**
 * Wave 11C (v0.23.0): satu titik sambung untuk seluruh rute baru gelombang ini.
 *
 * `server.ts` hanya memanggil `registerWave11cRoutes(app)`; rincian fitur tetap di modulnya
 * masing-masing (konvensi A2 PRD Wave 11). Berkas ini milik lead — impor ditambahkan bertahap,
 * hanya untuk modul yang sudah ada DAN lolos transform, supaya proses API tidak pernah gagal
 * dimuat karena berkas yang masih setengah jadi.
 */
import { registerNotionRoutes } from "./notion.js";
import { registerConnectorRoutes } from "./connectors.js";
import { registerGroupRoutes } from "./grup.js";
import { registerPaymentAmountRoutes } from "./bayar.js";
import { registerTrialCouponRoutes } from "./kupon.js";
import { registerAvatarRoutes } from "./avatar.js";
import { registerEngineVersionRoutes } from "./engine-version.js";
import { registerBotChannelRoutes } from "./bot-channels.js";
import { registerTelegramBotRoutes } from "./telegram-bot.js";
import { registerWhatsappBotRoutes } from "./whatsapp-bot.js";
import { registerBotIdentityRoutes } from "./bot-identities.js";

/** Mendaftarkan rute Wave 11C. Pemanggilannya dilakukan sekali dari `server.ts`. */
export function registerWave11cRoutes(app: any): void {
  // Butir 68: integrasi Notion (halaman yang dipilih pengguna).
  registerNotionRoutes(app);
  // Butir 71: katalog konektor (Slack / Discord / MCP).
  registerConnectorRoutes(app);
  // Butir 69/70/81: kanal bot, webhook Telegram, webhook WhatsApp, dan identitas terpaut.
  // Impor bot-channels/telegram/whatsapp juga memuat bot-core.ts, yaitu tempat handler pekerjaan
  // `bot.reply` mendaftarkan diri (registerJobHandler) saat modul dimuat.
  registerBotChannelRoutes(app);
  registerTelegramBotRoutes(app);
  registerWhatsappBotRoutes(app);
  registerBotIdentityRoutes(app);
  // Butir 73: percakapan grup multi-agen.
  registerGroupRoutes(app);
  // Butir 74: nominal unik untuk transfer manual.
  registerPaymentAmountRoutes(app);
  // Butir 75: kupon percobaan (TRIAL).
  registerTrialCouponRoutes(app);
  // Butir 76: avatar akun + avatar agen (image-sanitize.ts menulis ulang PNG sendiri).
  registerAvatarRoutes(app);
  // Butir 78 tahap 1: hanya membaca versi mesin. Tahap 2 menunggu keputusan K5.
  registerEngineVersionRoutes(app);
}

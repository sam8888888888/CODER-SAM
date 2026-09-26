/**
 * Wave 11C (butir 69/70/81): inti kanal bot Telegram & WhatsApp.
 *
 * Pesan masuk dari kanal mana pun lewat SATU jalur yang sama dengan web:
 *   1. pagar akun (email terverifikasi / akun ditutup) + kuota token milik PENGGUNA pemilik chat,
 *   2. filter prompt-hijack (butir 45) dan larangan akun (butir 46),
 *   3. percakapan nyata + run lewat `createRunAndDispatch` (wave11b/dispatch.ts) — jalur yang juga
 *      dipakai chat dan jadwal, jadi tidak ada rumus kuota/biaya kedua di modul ini.
 * Tidak ada bypass: pesan yang ditolak TIDAK membuat baris `runs`.
 *
 * Balasan agen tidak dikirim di dalam permintaan webhook (Telegram/Twilio menuntut balasan cepat).
 * Jawaban dikirim pekerja `bot.reply` — jenis pekerjaan yang sudah terdaftar di jobs.ts — dan
 * handler-nya didaftarkan modul ini lewat `registerJobHandler`, sehingga jobs.ts dan server.ts tidak
 * perlu diubah untuk pekerjaan ini.
 *
 * Dua pembaca konfigurasi sengaja membaca `process.env` lebih dulu dengan bawaan `config.*`
 * (`BOT_GROUP_ENABLED`, `BOT_REPLY_MAX_CHARS`), supaya bendera itu bisa dibuktikan berubah di dalam
 * satu proses uji tanpa memuat ulang modul. PENGERASAN: jalur env-first itu hanya hidup di LUAR
 * produksi — saat `NODE_ENV=production` yang berlaku `config.*` (lihat `knobUjiHidup`). Sisanya
 * memakai `config.*` apa adanya.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { quotaGuard } from "../billing.js";
import { mailerConfigured } from "../mailer.js";
import { createRateLimiter } from "../ratelimit.js";
import { enqueueJob, registerJobHandler } from "../jobs.js";
import { openSecret, sealSecret, tryOpenSecret } from "../secrets.js";
import { hijackMessage, scanPromptHijack } from "../prompt-guard.js";
import { guardrailViolations, recordSafetyEvent } from "../wave11a/guardrails.js";
import { audit } from "../wave11a/shared.js";
import { createRunAndDispatch } from "../wave11b/dispatch.js";

export type BotProvider = "telegram" | "whatsapp";

export type BotChannelRow = {
  id: string; provider: BotProvider; name: string; configCiphertext: string; enabled: number;
  agentName: string; tagline: string; webhookSecret: string; createdAt: string; updatedAt: string;
};

/** Kolom kanal apa adanya; rahasia tetap tersegel sampai benar-benar dipakai. */
const CHANNEL_COLUMNS = `id, provider, name, config_ciphertext AS configCiphertext, enabled,
  agent_name AS agentName, tagline, webhook_secret AS webhookSecret, created_at AS createdAt, updated_at AS updatedAt`;

export function channelById(channelId: string): BotChannelRow | undefined {
  return db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM bot_channels WHERE id=?`).get(channelId) as BotChannelRow | undefined;
}

export function channelByProvider(provider: BotProvider, hanyaAktif = false): BotChannelRow | undefined {
  const sql = `SELECT ${CHANNEL_COLUMNS} FROM bot_channels WHERE provider=?${hanyaAktif ? " AND enabled=1" : ""} ORDER BY created_at ASC LIMIT 1`;
  return db.prepare(sql).get(provider) as BotChannelRow | undefined;
}

/** Jalur webhook publik satu kanal; dipakai jawaban API dan pendaftaran webhook ke Telegram. */
export function webhookPath(channel: { id: string; provider: BotProvider }): string {
  return `/api/v1/bots/${channel.provider}/webhook/${channel.id}`;
}

/** Isi rahasia kanal yang sudah dibuka (`openSecret` melewati nilai lama yang belum tersegel). */
export type TelegramConfig = { token: string };
export type WhatsappConfig = { authToken: string; accountSid: string; fromNumber: string };

export function channelConfig(channel: BotChannelRow): Record<string, unknown> {
  const teks = tryOpenSecret(String(channel.configCiphertext ?? ""));
  if (!teks.ok || !teks.value.trim()) return {};
  try { return JSON.parse(teks.value) as Record<string, unknown>; } catch { return {}; }
}

/** Rahasia webhook kanal (disegel saat disimpan); kosong berarti kanal belum bisa diverifikasi. */
export function channelSecret(channel: BotChannelRow): string {
  const hasil = tryOpenSecret(String(channel.webhookSecret ?? ""));
  return hasil.ok ? hasil.value : "";
}

/** Menyegel satu nilai rahasia; galat kunci diteruskan supaya rute bisa menjawab 503. */
export function sealForStorage(value: string): string {
  return sealSecret(value);
}

/**
 * Dasar URL publik untuk kanal bot. Urutan: `BOT_WEBHOOK_BASE_URL` (kunci resmi, khusus bot) lalu
 * `PUBLIC_BASE_URL` platform. Dipakai untuk menampilkan/mendaftarkan webhook DAN untuk menghitung
 * ulang URL yang ditandatangani Twilio, jadi keduanya tidak bisa berbeda.
 */
export function dasarWebhookPublik(): string {
  const khusus = String(process.env.BOT_WEBHOOK_BASE_URL ?? config.BOT_WEBHOOK_BASE_URL ?? "").replace(/\/+$/, "");
  return khusus || String(config.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
}

/** Nama agen + tagline yang dipakai sebagai kepala balasan (diatur admin lewat PUT kanal). */
export function kepalaBalasan(channel: BotChannelRow): string {
  const nama = String(channel.agentName ?? "").trim() || String(channel.name ?? "").trim() || "Asisten";
  const tagline = String(channel.tagline ?? "").trim();
  return tagline ? `${nama} — ${tagline}` : nama;
}

/** Perbandingan rahasia yang tidak membocorkan waktu: dua sisi di-hash lebih dulu. */
export function teksSamaAman(a: string, b: string): boolean {
  const x = createHash("sha256").update(String(a), "utf8").digest();
  const y = createHash("sha256").update(String(b), "utf8").digest();
  return timingSafeEqual(x, y);
}

/**
 * Jalur "nilai proses lebih dulu" di bawah adalah KNOB UJI: hanya untuk suite/lokal supaya bendera bisa
 * berubah di dalam satu proses tanpa memuat ulang modul. DI PRODUKSI (`NODE_ENV=production`) jalur itu
 * MATI: yang berlaku selalu `config` (skema tervalidasi), supaya satu variabel lingkungan tidak bisa
 * diam-diam mengubah perilaku bot. `env` bisa diberikan pemanggil (pola sama seperti `connectorLimits`)
 * sehingga perilaku produksi bisa diuji tanpa mengubah lingkungan proses.
 */
function knobUjiHidup(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? process.env.NODE_ENV) !== "production";
}

/** Bendera grup: di luar produksi nilai proses lebih dulu, lalu bawaan config (lihat catatan di atas). */
export function botGroupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!knobUjiHidup(env)) return config.BOT_GROUP_ENABLED;
  const mentah = env.BOT_GROUP_ENABLED;
  if (mentah === undefined) return config.BOT_GROUP_ENABLED;
  return mentah === "true" || mentah === "1";
}

/** Batas panjang balasan: di luar produksi nilai proses lebih dulu, lalu bawaan config (catatan di atas). */
export function botReplyMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  if (!knobUjiHidup(env)) return config.BOT_REPLY_MAX_CHARS;
  const angka = Number(env.BOT_REPLY_MAX_CHARS);
  return Number.isFinite(angka) && angka >= 200 ? Math.floor(angka) : config.BOT_REPLY_MAX_CHARS;
}

/** Batas laju pesan masuk per (kanal, pengguna): satu nomor tidak bisa membanjiri platform. */
export const inboundLimiter = createRateLimiter(
  { windowMs: 60_000, max: Number(process.env.BOT_INBOUND_PER_MINUTE ?? config.BOT_INBOUND_PER_MINUTE) || config.BOT_INBOUND_PER_MINUTE }, "bot-in");

/** Batas percobaan kode pemasangan per (kanal, external_id): salah terus -> 429. */
export const linkAttemptLimiter = createRateLimiter(
  { windowMs: 15 * 60_000, max: config.BOT_LINK_MAX_ATTEMPTS }, "bot-link");

/**
 * Pembatas KEDUA rute pemasangan, dikunci per ALAMAT pemanggil (dipakai `bot-identities.ts`).
 * Alasan: pembatas per (kanal, external_id) di atas bisa dilewati dengan mengganti `external_id`
 * setiap percobaan, sedangkan ruang tebakan kode 6 angka hanya 10^6. Yang dihitung HANYA percobaan
 * yang GAGAL, jadi satu alamat kantor (NAT) tidak terblokir karena pemasangan yang berhasil.
 */
export const BOT_LINK_IP_MAX_FAILURES = 20;
export const linkIpFailureLimiter = createRateLimiter(
  { windowMs: 15 * 60_000, max: BOT_LINK_IP_MAX_FAILURES }, "bot-link-ip");

/* ------------------------------------------------------------------ pagar akun & kuota */

/**
 * Sama seperti pagar jalur web: akun terverifikasi (bila wajib) dan kuota token tier milik pengguna.
 * Perhatikan: kuota diperiksa lewat `quotaGuard` yang sama, per PENGGUNA — bukan per obrolan/grup.
 */
export function verificationRequired(): boolean {
  if (config.VERIFY_EMAIL_REQUIRED === "on") return true;
  if (config.VERIFY_EMAIL_REQUIRED === "off") return false;
  return config.NOTIFY_EMAIL_ENABLED && mailerConfigured();
}

export type BotGate = { status: number; error: string; message: string };

export function botGate(userId: string): BotGate | null {
  const row = db.prepare("SELECT email_verified AS emailVerified, deleted_at AS deletedAt FROM users WHERE id=?")
    .get(userId) as { emailVerified: number; deletedAt: string | null } | undefined;
  if (!row) return { status: 403, error: "ACCOUNT_NOT_FOUND", message: "Akun ini tidak ditemukan. Silakan masuk ke dasbor dan pasang ulang kanal bot." };
  if (row.deletedAt) return { status: 403, error: "ACCOUNT_DELETED", message: "Akun pemilik chat ini sudah ditutup, jadi bot tidak bisa melanjutkan. Hubungi admin platform bila ingin dipulihkan." };
  if (verificationRequired() && Number(row.emailVerified) !== 1) {
    return { status: 403, error: "EMAIL_NOT_VERIFIED", message: "Email akun Anda belum diverifikasi. Buka tautan verifikasi yang kami kirim, lalu kirim pesan lagi ke bot ini." };
  }
  const kuota = quotaGuard(userId, "");
  if (kuota) {
    const detail = (kuota.detail ?? {}) as Record<string, unknown>;
    return {
      status: kuota.status, error: kuota.error,
      message: String(detail.message ?? "Kuota token paket Anda sudah habis. Tingkatkan paket atau beli kredit token untuk lanjut."),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ percakapan bot */

const PROJECT_NAMA = "Asisten Bot";
const PROJECT_SLUG = "asisten-bot";

/** Ruang kerja pribadi pengguna (peran owner), tempat proyek percakapan bot dibuat. */
export function workspaceForUser(userId: string): string | null {
  const row = db.prepare("SELECT workspace_id AS workspaceId FROM memberships WHERE user_id=? AND role='owner' ORDER BY created_at LIMIT 1")
    .get(userId) as { workspaceId?: string } | undefined;
  if (row?.workspaceId) return String(row.workspaceId);
  const fallback = db.prepare("SELECT workspace_id AS workspaceId FROM memberships WHERE user_id=? ORDER BY created_at LIMIT 1")
    .get(userId) as { workspaceId?: string } | undefined;
  return fallback?.workspaceId ? String(fallback.workspaceId) : null;
}

/**
 * Proyek tujuan percakapan bot. Percakapan bot harus punya proyek nyata (skema `runs.project_id`
 * wajib), jadi proyek "Asisten Bot" dibuat sekali per ruang kerja pribadi pengguna. Hasilnya
 * dipastikan selalu sama (slug unik per ruang kerja), sehingga pengaitan percakapan bisa diuji.
 */
export function ensureBotProject(userId: string): string | null {
  const workspaceId = workspaceForUser(userId);
  if (!workspaceId) return null;
  const ada = db.prepare("SELECT id FROM projects WHERE workspace_id=? AND slug=?").get(workspaceId, PROJECT_SLUG) as { id?: string } | undefined;
  if (ada?.id) return String(ada.id);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, workspace_id, name, slug, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, workspaceId, PROJECT_NAMA, PROJECT_SLUG, "Percakapan otomatis dari kanal bot.", now, now);
  return id;
}

/** Judul penanda percakapan bot: memuat penanda obrolan supaya satu chat selalu memakai satu percakapan. */
export function penandaPercakapan(channel: BotChannelRow, kunci: string): string {
  return `Bot ${channel.provider} [${channel.id.slice(0, 8)}:${kunci}]`;
}

export function botConversation(channel: BotChannelRow, projectId: string, kunci: string, label: string): string {
  const judul = `${penandaPercakapan(channel, kunci)} ${label}`.slice(0, 200);
  const ada = db.prepare("SELECT id FROM conversations WHERE project_id=? AND title=? ORDER BY created_at ASC LIMIT 1")
    .get(projectId, judul) as { id?: string } | undefined;
  if (ada?.id) return String(ada.id);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, projectId, judul, now, now);
  return id;
}

/* ------------------------------------------------------------------ identitas kanal (butir 81) */

export function hashKode(channelId: string, kode: string): string {
  return createHash("sha256").update(`bot-link:${channelId}:${kode}`).digest("hex");
}

export type IdentitasRow = {
  id: string; channelId: string; externalId: string; userId: string;
  linkedAt: string; codeHash: string; codeExpiresAt: string | null; usedAt: string | null;
};

export function identitasTerpasang(channelId: string, externalId: string): IdentitasRow | undefined {
  return db.prepare(`SELECT id, channel_id AS channelId, external_id AS externalId, user_id AS userId,
      linked_at AS linkedAt, code_hash AS codeHash, code_expires_at AS codeExpiresAt, used_at AS usedAt
    FROM bot_identities WHERE channel_id=? AND external_id=?`).get(channelId, externalId) as IdentitasRow | undefined;
}

/** Identitas yang masih menunggu kode (belum tertaut ke external_id nyata). */
function identitasMenunggu(channelId: string, kode: string): IdentitasRow | undefined {
  return db.prepare(`SELECT id, channel_id AS channelId, external_id AS externalId, user_id AS userId,
      linked_at AS linkedAt, code_hash AS codeHash, code_expires_at AS codeExpiresAt, used_at AS usedAt
    FROM bot_identities WHERE channel_id=? AND code_hash=? AND used_at IS NULL`).get(channelId, hashKode(channelId, kode)) as IdentitasRow | undefined;
}

export type HasilTaut = { ok: true; identitas: IdentitasRow; pesan: string } | { ok: false; status: number; error: string; message: string };

/**
 * Menautkan satu external_id (chat_id Telegram / nomor WhatsApp) ke satu akun, memakai kode sekali pakai.
 * Aturan: satu external_id = satu akun; kode salah/kedaluwarsa/sudah dipakai ditolak; percobaan dibatasi.
 */
export function tautkanIdentitas(channelId: string, externalId: string, kode: string): HasilTaut {
  const channel = channelById(channelId);
  if (!channel) return { ok: false, status: 404, error: "CHANNEL_NOT_FOUND", message: "Kanal bot tidak ditemukan." };
  if (!channel.enabled) return { ok: false, status: 403, error: "CHANNEL_DISABLED", message: "Kanal bot ini sedang dimatikan admin." };
  const id = String(externalId ?? "").trim();
  if (!id || id.length > 80 || /\s/.test(id)) {
    return { ok: false, status: 400, error: "EXTERNAL_ID_INVALID", message: "Identitas chat tidak sah." };
  }
  const kodeBersih = String(kode ?? "").replace(/\D/g, "");
  if (kodeBersih.length !== 6) return { ok: false, status: 400, error: "LINK_CODE_INVALID", message: "Kode pemasangan harus 6 angka." };
  const kunci = `${channelId}:${id}`;
  if (!linkAttemptLimiter.allow(kunci)) {
    return {
      ok: false, status: 429, error: "TOO_MANY_LINK_ATTEMPTS",
      message: `Percobaan pemasangan terlalu banyak (batas ${config.BOT_LINK_MAX_ATTEMPTS} kali). Tunggu sekitar 15 menit, lalu buat kode baru dari dasbor.`,
    };
  }
  const baris = identitasMenunggu(channelId, kodeBersih);
  if (!baris) return { ok: false, status: 400, error: "LINK_CODE_INVALID", message: "Kode pemasangan salah atau sudah dipakai. Buat kode baru di dasbor: Pengaturan → Kanal Bot." };
  const kedaluwarsa = baris.codeExpiresAt ? new Date(String(baris.codeExpiresAt)).getTime() : 0;
  if (!kedaluwarsa || kedaluwarsa < Date.now()) {
    return { ok: false, status: 400, error: "LINK_CODE_EXPIRED", message: `Kode pemasangan sudah kedaluwarsa (berlaku ${config.BOT_LINK_CODE_TTL_MINUTES} menit). Buat kode baru di dasbor.` };
  }
  const sudahAda = identitasTerpasang(channelId, id);
  if (sudahAda && String(sudahAda.userId) !== String(baris.userId)) {
    return { ok: false, status: 409, error: "EXTERNAL_ID_TAKEN", message: "Chat ini sudah tertaut ke akun lain. Cabut dulu tautannya dari akun itu, atau pakai akun yang sama." };
  }
  const now = new Date().toISOString();
  if (sudahAda) {
    // Baris nyata sudah ada dan memang milik pengguna kode ini: cukup buang baris menunggunya.
    db.prepare("DELETE FROM bot_identities WHERE id=?").run(baris.id);
    linkAttemptLimiter.reset(kunci);
    audit(String(baris.userId), "bot_identity.linked", { channelId, channel: channel.name, externalId: id, idempotent: true });
    return { ok: true, identitas: sudahAda, pesan: "Chat ini memang sudah tertaut ke akun Anda." };
  }
  db.prepare("UPDATE bot_identities SET external_id=?, linked_at=?, code_hash='', code_expires_at=NULL, used_at=? WHERE id=?")
    .run(id, now, now, baris.id);
  linkAttemptLimiter.reset(kunci);
  const hasil = identitasTerpasang(channelId, id)!;
  audit(String(baris.userId), "bot_identity.linked", { channelId, channel: channel.name, externalId: id, identityId: hasil.id });
  return { ok: true, identitas: hasil, pesan: `Chat ini berhasil dipasangkan ke akun Anda. Silakan kirim pesan seperti biasa.` };
}

/* ------------------------------------------------------------------ alur pesan masuk */

export type PesanMasuk = {
  channel: BotChannelRow;
  provider: BotProvider;
  externalId: string;
  chatId: string;
  chatLabel: string;
  isGroup: boolean;
  text: string;
};

export type HasilPesan = {
  terima: boolean;
  status: number;
  error: string | null;
  runId: string | null;
  conversationId: string | null;
  jalur: "langsung" | "antrean" | null;
  balasan: string | null;
};

const CARA_PASANG = "Balas dengan perintah /taut <kode> (contoh: /taut 123456). Kode 6 angka dibuat di dasbor: Pengaturan → Kanal Bot.";

/** Perintah pemasangan yang dikirim langsung ke bot: `/taut 123456` (boleh tanpa garis miring). */
const PERINTAH_TAUT = /^\s*\/?(taut|link|pasang)\s+(\d{6})\s*$/i;

/**
 * Seluruh aturan pesan masuk kanal bot. Fungsi ini murni bekerja di server: rute webhook hanya
 * memverifikasi tanda tangan lalu memanggilnya.
 */
export async function tanganiPesanMasuk(pesan: PesanMasuk): Promise<HasilPesan> {
  const { channel, provider, externalId, chatId } = pesan;
  const kosong: HasilPesan = { terima: false, status: 200, error: null, runId: null, conversationId: null, jalur: null, balasan: null };
  const teks = String(pesan.text ?? "").trim();
  if (!teks) return { ...kosong, error: "TIDAK_ADA_TEKS" };
  if (teks.length > 100_000) {
    return { ...kosong, status: 400, error: "PESAN_TERLALU_PANJANG", balasan: "Pesan terlalu panjang (maksimal 100.000 karakter). Mohon diringkas dulu." };
  }
  if (!inboundLimiter.allow(`${channel.id}:${externalId}`)) {
    return {
      ...kosong, status: 429, error: "BOT_RATE_LIMITED",
      balasan: "Pesan Anda terlalu sering dalam satu menit. Mohon tunggu sebentar, lalu kirim lagi.",
    };
  }
  if (pesan.isGroup && !botGroupEnabled()) {
    return {
      ...kosong, status: 403, error: "BOT_GROUP_DISABLED",
      balasan: "Bot ini belum diaktifkan untuk grup. Kirim pesan lewat obrolan pribadi dengan bot, atau minta admin mengaktifkan mode grup.",
    };
  }
  // Perintah pemasangan dilayani lebih dulu: chat yang belum tertaut harus bisa memasang dirinya.
  const perintah = PERINTAH_TAUT.exec(teks);
  if (perintah) {
    const hasil = tautkanIdentitas(channel.id, externalId, perintah[2]);
    return {
      ...kosong, status: hasil.ok ? 200 : hasil.status,
      error: hasil.ok ? null : hasil.error, balasan: hasil.ok ? hasil.pesan : hasil.message,
    };
  }
  const identitas = identitasTerpasang(channel.id, externalId);
  if (!identitas) {
    return {
      ...kosong, status: 403, error: "BOT_NOT_LINKED",
      balasan: `Chat ini belum dipasangkan ke akun COBLAI. ${CARA_PASANG}`,
    };
  }
  const userId = String(identitas.userId);
  const gate = botGate(userId);
  if (gate) {
    audit(userId, "bot.message_blocked", { channelId: channel.id, provider, externalId, alasan: gate.error });
    return { ...kosong, status: gate.status, error: gate.error, balasan: gate.message };
  }
  // Butir 45: pesan yang menyerang instruksi dasar tidak pernah sampai ke mesin dan tidak menambah biaya.
  if (config.PROMPT_GUARD_ENABLED) {
    const hijack = scanPromptHijack(teks);
    if (hijack.blocked) {
      audit(userId, "prompt_hijack_blocked", { channelId: channel.id, provider, externalId, pola: hijack.pattern, kategori: hijack.category, kutipan: hijack.snippet });
      return { ...kosong, status: 400, error: "PROMPT_BLOCKED", balasan: hijackMessage(hijack.pattern) };
    }
  }
  // Butir 46: larangan milik akun berlaku sama di kanal bot seperti di web.
  const pelanggaran = guardrailViolations(userId, teks);
  if (pelanggaran.length) {
    for (const hit of pelanggaran) {
      recordSafetyEvent({ userId, ruleId: hit.rule.id, pattern: hit.pattern, snippet: teks });
      audit(userId, "safety_violation", { channelId: channel.id, provider, ruleId: hit.rule.id, judul: hit.rule.title, pola: hit.pattern });
    }
    return {
      ...kosong, status: 400, error: "GUARDRAIL_BLOCKED",
      balasan: `Permintaan ini dilarang aturan "${pelanggaran[0].rule.title}". Aksi tidak dijalankan.`,
    };
  }
  const projectId = ensureBotProject(userId);
  if (!projectId) {
    return { ...kosong, status: 409, error: "WORKSPACE_NOT_FOUND", balasan: "Akun ini belum punya ruang kerja, jadi percakapan bot belum bisa dibuat. Buka dasbor dulu sekali." };
  }
  const kunci = pesan.isGroup ? `grup:${chatId}` : `dm:${externalId}`;
  const label = String(pesan.chatLabel ?? "").trim().slice(0, 120) || externalId;
  const conversationId = botConversation(channel, projectId, kunci, label);
  const hasilRun = await createRunAndDispatch({
    projectId, prompt: teks, userId, conversationId, personaId: null, autonomous: false,
  });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)")
    .run(randomUUID(), conversationId, "user", teks.slice(0, 100_000), hasilRun.runId, now);
  db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
  enqueueJob({
    kind: "bot.reply",
    payload: { runId: hasilRun.runId, channelId: channel.id, chatId, externalId, conversationId },
    maxAttempts: 5,
  });
  audit(userId, "bot.message_accepted", {
    channelId: channel.id, provider, externalId, conversationId, runId: hasilRun.runId,
    grup: Boolean(pesan.isGroup), panjang: teks.length,
  });
  return { terima: true, status: 200, error: null, runId: hasilRun.runId, conversationId, jalur: hasilRun.jalur, balasan: null };
}

/* ------------------------------------------------------------------ kirim balasan */

export type KirimHasil = { ok: boolean; jalur: "markdown" | "teks_polos" | "foto"; foto: string | null; statuses: number[]; pesan: string };

function batasWaktu(): AbortSignal | undefined {
  const ms = Number(process.env.BOT_HTTP_TIMEOUT_MS ?? config.BOT_HTTP_TIMEOUT_MS);
  const angka = Number.isFinite(ms) && ms > 0 ? ms : 15000;
  try { return AbortSignal.timeout(angka); } catch { return undefined; }
}

/** Panggilan HTTP ke API Telegram; alamat hulu selalu bisa dialihkan lewat `TELEGRAM_API_BASE`. */
export async function panggilTelegram(channel: BotChannelRow, method: string, body: Record<string, unknown>) {
  const cfg = channelConfig(channel) as Partial<TelegramConfig>;
  const token = String(cfg.token ?? "");
  const base = String(config.TELEGRAM_API_BASE).replace(/\/+$/, "");
  const url = `${base}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: batasWaktu(),
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text: text.slice(0, 800) };
}

/**
 * Kirim Markdown; bila hulu menolak format (400 "can't parse entities"), kirim ulang sebagai teks polos.
 * Fallback ini wajib: jawaban agen sering memuat karakter Markdown yang tidak seimbang.
 */
async function kirimTelegramSatu(channel: BotChannelRow, method: "sendMessage" | "sendPhoto", body: Record<string, unknown>): Promise<KirimHasil> {
  const pertama = await panggilTelegram(channel, method, { ...body, parse_mode: "Markdown" });
  if (pertama.ok) return { ok: true, jalur: "markdown", foto: null, statuses: [pertama.status], pesan: "" };
  const tolakFormat = pertama.status === 400 && /parse|entit/i.test(pertama.text);
  if (tolakFormat) {
    const kedua = await panggilTelegram(channel, method, body);
    return { ok: kedua.ok, jalur: "teks_polos", foto: null, statuses: [pertama.status, kedua.status], pesan: kedua.ok ? "" : kedua.text };
  }
  return { ok: false, jalur: "markdown", foto: null, statuses: [pertama.status], pesan: pertama.text };
}

/** Tautan gambar pertama di dalam jawaban (Markdown `![](...)` maupun URL polos). */
export function cariTautanGambar(teks: string): string | null {
  const markdown = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/.exec(teks);
  if (markdown) return markdown[1];
  const polos = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp))/i.exec(teks);
  return polos ? polos[1] : null;
}

export function potongBalasan(teks: string): { teks: string; dipotong: boolean } {
  const batas = botReplyMaxChars();
  if (teks.length <= batas) return { teks, dipotong: false };
  return { teks: `${teks.slice(0, batas)}\n… (balasan dipotong karena batas panjang pesan)`, dipotong: true };
}

/** Balasan lengkap: kepala (nama agen + tagline) + isi jawaban yang sudah dipotong. */
export function formatBalasan(channel: BotChannelRow, isi: string): string {
  const potong = potongBalasan(String(isi).trim());
  return `${kepalaBalasan(channel)}\n\n${potong.teks}`;
}

export async function kirimTelegram(channel: BotChannelRow, chatId: string, teks: string): Promise<KirimHasil> {
  const foto = cariTautanGambar(teks);
  if (foto) {
    const caption = teks.slice(0, 1024);
    const hasilFoto = await kirimTelegramSatu(channel, "sendPhoto", { chat_id: chatId, photo: foto, caption });
    const sisa = teks.slice(1024);
    const statuses = [...hasilFoto.statuses];
    if (sisa.trim()) {
      const hasilSisa = await kirimTelegramSatu(channel, "sendMessage", { chat_id: chatId, text: sisa });
      statuses.push(...hasilSisa.statuses);
    }
    return { ok: hasilFoto.ok, jalur: "foto", foto, statuses, pesan: hasilFoto.pesan };
  }
  return kirimTelegramSatu(channel, "sendMessage", { chat_id: chatId, text: teks });
}

/** Kirim balasan WhatsApp lewat API Twilio (alamat hulu bisa dialihkan lewat `TWILIO_API_BASE`). */
export async function kirimWhatsApp(channel: BotChannelRow, ke: string, teks: string): Promise<KirimHasil> {
  const cfg = channelConfig(channel) as Partial<WhatsappConfig>;
  const base = String(process.env.TWILIO_API_BASE ?? config.TWILIO_API_BASE).replace(/\/+$/, "");
  const accountSid = String(cfg.accountSid ?? "");
  const url = `${base}/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${String(cfg.authToken ?? "")}`).toString("base64");
  const form = new URLSearchParams({ From: String(cfg.fromNumber ?? ""), To: ke, Body: teks });
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: batasWaktu(),
  });
  const text = await response.text();
  return { ok: response.ok, jalur: "teks_polos", foto: null, statuses: [response.status], pesan: text.slice(0, 800) };
}

/** Satu pintu pengiriman balasan untuk semua kanal. */
export function kirimBalasan(channel: BotChannelRow, chatId: string, teks: string): Promise<KirimHasil> {
  return channel.provider === "whatsapp" ? kirimWhatsApp(channel, chatId, teks) : kirimTelegram(channel, chatId, teks);
}

/* ------------------------------------------------------------------ pekerjaan bot.reply */

export type BotReplyPayload = { runId: string; channelId: string; chatId: string; externalId?: string };

function tungguRun(runId: string, batasMs: number): Promise<{ status: string; result: string | null; errorCode: string | null }> {
  return new Promise((resolve) => {
    const sampai = Date.now() + Math.max(500, batasMs);
    const periksa = () => {
      const row = db.prepare("SELECT status, result, error_code AS errorCode FROM runs WHERE id=?").get(runId) as
        { status: string; result: string | null; errorCode: string | null } | undefined;
      if (row && ["completed", "failed", "cancelled"].includes(String(row.status))) return resolve(row);
      if (Date.now() >= sampai) return resolve(row ?? { status: "queued", result: null, errorCode: null });
      setTimeout(periksa, 150);
    };
    periksa();
  });
}

/**
 * Handler pekerjaan `bot.reply`: menunggu run selesai (dengan batas waktu), lalu mengirim jawaban.
 * Selama run masih jalan, pekerjaan dilempar (`throw`) supaya antrean mencobanya lagi.
 */
export async function antarBalasanBot(payload: BotReplyPayload) {
  const channel = channelById(String(payload?.channelId ?? ""));
  if (!channel) throw new Error("KANAL_BOT_TIDAK_DITEMUKAN");
  if (!payload?.runId || !payload?.chatId) throw new Error("PAYLOAD_BOT_TIDAK_LENGKAP");
  const batasMs = Number(process.env.BOT_REPLY_WAIT_MS ?? config.BOT_REPLY_WAIT_MS);
  const run = await tungguRun(String(payload.runId), Number.isFinite(batasMs) ? batasMs : 60_000);
  if (["queued", "running"].includes(String(run.status))) throw new Error("BOT_RUN_BELUM_SELESAI");
  const isi = run.status === "completed" ? String(run.result ?? "").trim() : "";
  const teks = isi
    ? formatBalasan(channel, isi)
    : `Maaf, jawaban untuk pesan ini gagal dibuat${run.errorCode ? ` (${run.errorCode})` : ""}. Silakan coba lagi sebentar lagi.`;
  const hasil = await kirimBalasan(channel, String(payload.chatId), teks);
  audit(null, "bot.reply_sent", {
    channelId: channel.id, provider: channel.provider, runId: String(payload.runId),
    terkirim: hasil.ok, jalur: hasil.jalur, foto: hasil.foto, statusHulu: hasil.statuses,
  });
  return { terkirim: hasil.ok, jalur: hasil.jalur, foto: hasil.foto, statusHulu: hasil.statuses, panjangTeks: teks.length };
}

// Handler didaftarkan saat modul dimuat, jadi proses web maupun pekerja memakai satu penangan saja.
registerJobHandler("bot.reply", antarBalasanBot);

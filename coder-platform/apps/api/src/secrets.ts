/**
 * Wave 11A (butir 43): satu-satunya jalur menyimpan rahasia pengguna dalam keadaan terenkripsi.
 *
 * Rahasia disimpan sebagai teks tersegel berformat `enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>`, dienkripsi
 * dengan AES-256-GCM. Kunci induk diambil dari `SECRETS_KEY` (32 byte, base64). Nilai rahasia hanya
 * dibuka saat dipakai; modul ini tidak pernah mencatat nilainya ke log.
 *
 * Aturan yang dijaga modul ini:
 * - `SECRETS_KEY` kosong atau tidak sah -> `SecretsKeyError` dengan `code = "SECRETS_KEY_MISSING"`,
 *   supaya rute bisa menjawab 503 dan TIDAK menulis teks polos.
 * - Nilai lama yang belum tersegel (tanpa awalan `enc:v1:`) tetap dibaca apa adanya.
 * - Ciphertext yang rusak atau diubah ditolak oleh tag GCM -> `SECRET_DECRYPT_FAILED`.
 *
 * Kunci dibaca pada saat dipakai (bukan disalin ke variabel global) supaya kunci yang salah atau
 * hilang selalu terlihat pada panggilan pertama, dan supaya uji bisa membuktikan jalur 503 dengan
 * menghapus `process.env.SECRETS_KEY` tanpa memuat ulang proses.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

/** Penanda segel versi 1. Nilai lama tanpa penanda ini dianggap teks polos warisan. */
export const sealedPrefix = "enc:v1:";

/** Panjang maksimum satu nilai rahasia, dipakai rute untuk menjawab 400 SECRET_TOO_LONG. */
export const SECRET_VALUE_MAX_CHARS = 4096;

/** Panjang nilai minimum yang ekornya masih boleh ditampilkan (`…abcd`). */
export const SECRET_TAIL_MIN_CHARS = 8;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretsKeyCode = "SECRETS_KEY_MISSING" | "SECRET_DECRYPT_FAILED";

/** Galat rahasia dengan kode mesin, supaya rute bisa menerjemahkannya menjadi 503 atau 500. */
export class SecretsKeyError extends Error {
  readonly code: SecretsKeyCode;
  constructor(code: SecretsKeyCode, message: string) {
    super(message);
    this.name = "SecretsKeyError";
    this.code = code;
  }
}

/** Bentuk hasil penyamaran nilai: cukup untuk dikenal pemiliknya, tidak untuk dipakai. */
export type MaskedSecret = { terpasang: true; ekor: string };

/** Kunci mentah: nilai proses lebih dulu (kunci paling segar), lalu nilai yang dibaca `config` saat mulai. */
function rawSecretsKey(): string {
  const fromProcess = process.env.SECRETS_KEY;
  if (typeof fromProcess === "string") return fromProcess;
  return config.SECRETS_KEY ?? "";
}

/** Menerjemahkan kunci base64 menjadi 32 byte. Kunci absen, salah panjang, atau bukan base64 ditolak. */
function decodeSecretsKey(): Buffer {
  const raw = rawSecretsKey().trim();
  if (!raw) throw new SecretsKeyError("SECRETS_KEY_MISSING", "Penyimpanan rahasia belum dikonfigurasi.");
  const key = Buffer.from(raw, "base64");
  const normalised = raw.replace(/=+$/, "");
  if (key.length !== KEY_BYTES || key.toString("base64").replace(/=+$/, "") !== normalised) {
    throw new SecretsKeyError("SECRETS_KEY_MISSING", "Kunci SECRETS_KEY harus 32 byte dalam base64.");
  }
  return key;
}

/** Keadaan kunci untuk audit-diri: `ok` (ada dan sah), `missing` (kosong), `invalid` (ada, tidak sah). */
export function secretsKeyState(): "ok" | "missing" | "invalid" {
  if (!rawSecretsKey().trim()) return "missing";
  try {
    decodeSecretsKey();
    return "ok";
  } catch {
    return "invalid";
  }
}

/** True bila nilai tersimpan sudah tersegel versi 1. Nilai bukan teks tidak pernah dianggap tersegel. */
export function isSealed(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(sealedPrefix);
}

/** Menyegel satu nilai rahasia. IV acak 12 byte -> ciphertext berbeda walau nilainya sama. */
export function sealSecret(plain: string): string {
  if (typeof plain !== "string") throw new TypeError("Nilai rahasia harus berupa teks.");
  if (plain.length > SECRET_VALUE_MAX_CHARS) {
    throw new RangeError(`Nilai rahasia melebihi ${SECRET_VALUE_MAX_CHARS} karakter.`);
  }
  const key = decodeSecretsKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${sealedPrefix}${iv.toString("base64")}:${tag.toString("base64")}:${body.toString("base64")}`;
}

/** Membuka nilai tersimpan. Nilai tanpa segel dikembalikan apa adanya (kompatibel dengan data lama). */
export function openSecret(stored: string): string {
  if (typeof stored !== "string") throw new SecretsKeyError("SECRET_DECRYPT_FAILED", "Rahasia tersimpan bukan teks.");
  if (!isSealed(stored)) return stored;
  const parts = stored.slice(sealedPrefix.length).split(":");
  if (parts.length !== 3) throw new SecretsKeyError("SECRET_DECRYPT_FAILED", "Bentuk rahasia tersegel tidak dikenali.");
  const key = decodeSecretsKey();
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const body = Buffer.from(parts[2], "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretsKeyError("SECRET_DECRYPT_FAILED", "Bentuk rahasia tersegel tidak dikenali.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Tag GCM menolak ciphertext yang diubah, kunci yang berbeda, atau data yang rusak.
    throw new SecretsKeyError("SECRET_DECRYPT_FAILED", "Rahasia tidak bisa dibuka (kunci berbeda atau data berubah).");
  }
}

// Nama cadangan sesuai PRD butir 43 (`encryptSecret`/`decryptSecret`). Nama utama tetap
// `sealSecret`/`openSecret` yang sudah dipakai seluruh kode; alias ini hanya supaya nama di PRD
// tetap bisa dipanggil tanpa menggandakan logika.
export const encryptSecret = sealSecret;
export const decryptSecret = openSecret;

/** Membuka tanpa melempar: dipakai daftar rahasia dan audit-diri yang harus tetap berjalan. */
export function tryOpenSecret(stored: string): { ok: true; value: string } | { ok: false; code: SecretsKeyCode } {
  try {
    return { ok: true, value: openSecret(stored) };
  } catch (error) {
    const code = error instanceof SecretsKeyError ? error.code : "SECRET_DECRYPT_FAILED";
    return { ok: false, code };
  }
}

/**
 * Menyamarkan nilai supaya hanya bisa dikenali pemiliknya: `{ terpasang: true, ekor: "…abcd" }`.
 * Nilai yang lebih pendek dari 8 karakter ekornya dikosongkan, karena ekor 4 karakter dari nilai
 * pendek sama dengan membocorkan hampir seluruh rahasia.
 */
export function maskSecret(value: string): MaskedSecret {
  const text = typeof value === "string" ? value : "";
  return { terpasang: true, ekor: text.length >= SECRET_TAIL_MIN_CHARS ? `…${text.slice(-4)}` : "" };
}

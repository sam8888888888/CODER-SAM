import { createHmac, randomBytes } from "node:crypto";

/**
 * RFC 4226 (HOTP) and RFC 6238 (TOTP) implementation with no external dependency.
 * The secret is base32 as described in RFC 4648 (upper case letters and digits 2-7).
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0; let value = 0; let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new Error("INVALID_BASE32_SECRET");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(bytes = 20): string { return base32Encode(randomBytes(bytes)); }

export function hotp(secret: string, counter: number, digits = 6): string {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totp(secret: string, options: { digits?: number; stepSeconds?: number; at?: number } = {}): string {
  const { digits = 6, stepSeconds = 30, at = Date.now() } = options;
  return hotp(secret, Math.floor(at / 1000 / stepSeconds), digits);
}

/** Accepts the current code plus one step before and after to allow small clock drift. */
export function verifyTotp(secret: string, token: string, options: { digits?: number; stepSeconds?: number; at?: number; window?: number } = {}): boolean {
  const { digits = 6, stepSeconds = 30, at = Date.now(), window = 1 } = options;
  const candidate = String(token ?? "").replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return false;
  const counter = Math.floor(at / 1000 / stepSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    if (hotp(secret, counter + offset, digits) === candidate) return true;
  }
  return false;
}

export function otpAuthUrl(secret: string, email: string, issuer = "COBLAI Coder"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

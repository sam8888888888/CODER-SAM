/**
 * Wave 11C (butir 68/71/82): satu-satunya pintu keluar jaringan untuk konektor dan integrasi.
 *
 * Aturan modul ini:
 *  1. Setiap alamat keluar WAJIB lolos daftar putih `CONNECTOR_ALLOWED_HOSTS` sebelum dikirimi data;
 *     alamat di luar daftar ditolak sebelum ada satu byte pun yang keluar.
 *  2. Setiap permintaan punya batas waktu dan TIDAK mengikuti pengalihan, supaya daftar putih tidak
 *     bisa dilewati lewat 302 ke host lain.
 *  3. Daftar putih dan batas waktu dibaca ulang dari lingkungan setiap kali dipakai, supaya uji e2e
 *     bisa mengarahkan lalu lintas ke peladen tiruan lokal (127.0.0.1) tanpa memuat ulang proses.
 */
import { config } from "../config.js";

export type OutboundUrlOk = { ok: true; url: URL; host: string };
export type OutboundUrlFailed = { ok: false; code: "CONNECTOR_URL_INVALID" | "CONNECTOR_HOST_NOT_ALLOWED"; message: string };
export type OutboundUrlDecision = OutboundUrlOk | OutboundUrlFailed;

export type OutboundReply =
  | { ok: true; status: number; body: unknown; text: string; durasiMs: number }
  | {
      ok: false;
      code: "CONNECTOR_TIMEOUT" | "CONNECTOR_NETWORK_ERROR" | "CONNECTOR_UPSTREAM_ERROR";
      status: number | null;
      message: string;
      durasiMs: number;
    };

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/** Host yang boleh dihubungi konektor. Daftar putih, bukan daftar hitam: kosong berarti tidak ada. */
export function allowedOutboundHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.CONNECTOR_ALLOWED_HOSTS ?? config.CONNECTOR_ALLOWED_HOSTS ?? "");
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Memeriksa satu alamat tujuan sebelum dipakai. Bentuk yang salah dan host di luar daftar putih
 * menghasilkan kode berbeda, supaya pengguna bisa membedakan salah tulis dengan kebijakan platform.
 */
export function checkOutboundUrl(rawUrl: unknown, env: NodeJS.ProcessEnv = process.env): OutboundUrlDecision {
  const text = String(rawUrl ?? "").trim();
  if (!text) return { ok: false, code: "CONNECTOR_URL_INVALID", message: "Alamat tujuan belum diisi." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: "CONNECTOR_URL_INVALID", message: `Alamat "${text.slice(0, 80)}" bukan URL yang sah.` };
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    return { ok: false, code: "CONNECTOR_URL_INVALID", message: "Hanya alamat http atau https yang boleh dipakai konektor." };
  }
  const host = url.hostname.toLowerCase();
  if (!allowedOutboundHosts(env).includes(host)) {
    return {
      ok: false,
      code: "CONNECTOR_HOST_NOT_ALLOWED",
      message: `Host "${host}" tidak ada di daftar putih konektor (CONNECTOR_ALLOWED_HOSTS).`,
    };
  }
  return { ok: true, url, host };
}

/** Host dari sebuah alamat, atau null bila tidak bisa dibaca. Dipakai untuk laporan tanpa URL penuh. */
export function hostOf(rawUrl: unknown): string | null {
  try {
    return new URL(String(rawUrl ?? "")).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Batas waktu satu permintaan keluar, dibaca dari lingkungan lebih dulu supaya uji bisa memendekkannya. */
export function outboundTimeoutMs(env: NodeJS.ProcessEnv = process.env, fallback = config.CONNECTOR_TIMEOUT_MS): number {
  const raw = Number(env.CONNECTOR_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : fallback;
}

/** Satu permintaan HTTP dengan batas waktu. Selalu mengembalikan objek, tidak pernah melempar. */
export async function outboundRequest(
  url: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number },
): Promise<OutboundReply> {
  const mulai = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method ?? "POST",
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
      // Tanpa ini, sebuah 302 ke host lain akan membuat daftar putih bisa dilewati.
      redirect: "error",
    });
    const teks = (await response.text().catch(() => "")).slice(0, 4000);
    const durasiMs = Date.now() - mulai;
    let body: unknown = teks;
    try {
      body = teks ? JSON.parse(teks) : null;
    } catch {
      body = teks;
    }
    if (!response.ok) {
      return { ok: false, code: "CONNECTOR_UPSTREAM_ERROR", status: response.status, message: `Hulu menjawab ${response.status}.`, durasiMs };
    }
    return { ok: true, status: response.status, body, text: teks, durasiMs };
  } catch (error) {
    const durasiMs = Date.now() - mulai;
    const nama = (error as Error)?.name;
    if (nama === "AbortError" || nama === "TimeoutError") {
      return { ok: false, code: "CONNECTOR_TIMEOUT", status: null, message: `Hulu tidak menjawab dalam ${init.timeoutMs} ms.`, durasiMs };
    }
    return {
      ok: false,
      code: "CONNECTOR_NETWORK_ERROR",
      status: null,
      message: String((error as Error)?.message ?? error).slice(0, 200),
      durasiMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

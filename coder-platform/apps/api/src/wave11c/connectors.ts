/**
 * Wave 11C (butir 71): katalog konektor + kirim uji yang jujur.
 *
 * Aturan yang dijaga modul ini:
 *  1. KATALOG melaporkan tiga tingkat dengan jujur: `platform` (apa yang platform sediakan) dan
 *     `sambungan_pengguna` (apa yang pengguna sudah pasang). 'aktif' HANYA setelah kirim berhasil.
 *  2. Rahasia TIDAK PERNAH keluar: alamat webhook tidak pernah dikembalikan utuh (hanya host + ekor),
 *     token MCP tidak pernah dikembalikan sama sekali. Semua disegel di `config_ciphertext`.
 *  3. Alamat di luar daftar putih ditolak SEBELUM disimpan (400 CONNECTOR_HOST_NOT_ALLOWED), dan
 *     diperiksa lagi oleh proses anak saat mengirim (daftar putih dibaca dua kali).
 *  4. Alat MCP hanya boleh dipakai bila admin platform menuliskannya di `platform_settings.mcp_allowed_tools`.
 *     Bawaan kosong = MCP tertutup (403 MCP_TOOL_NOT_ALLOWED), bukan "terbuka dengan sendirinya".
 *     Daftar itu ditulis lewat `GET/PUT /api/v1/admin/mcp-allowed-tools` (khusus admin platform);
 *     tanpa rute itu tidak ada satu pun jalan bagi pelanggan untuk membuka MCP.
 *  5. Kirim/uji dibatasi laju per pengguna (`rate_limit_hits`), supaya satu akun tidak bisa membanjiri hulu.
 */
import { config } from "../config.js";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { createRateLimiter, type RateLimiter } from "../ratelimit.js";
import { SecretsKeyError, sealSecret, secretsKeyState } from "../secrets.js";
import { adminRequired, audit, fail, isPlatformAdmin } from "../wave11a/shared.js";
import { checkOutboundUrl, allowedOutboundHosts } from "./connector-outbound.js";
import {
  CONNECTOR_KINDS,
  CONNECTOR_STATUSES,
  MAX_MCP_TOOLS,
  MCP_TOOL_PATTERN,
  MAX_NAME_CHARS,
  MAX_TOOLS,
  MAX_TOKEN_CHARS,
  MAX_URL_CHARS,
  catalogueFor,
  connectorRowForUser,
  connectorView,
  deleteConnectorRow,
  isConnectorKind,
  listConnectorRows,
  mcpAllowedTools,
  mcpToolsAllowed,
  openConnectorConfig,
  saveConnectorRow,
  setMcpAllowedTools,
  updateConnectorState,
} from "./connector-store.js";
import { connectorLimits, deliverConnectorWithJob } from "./connector-job.js";

type Body = Record<string, unknown>;

/** Batas laju kirim/uji konektor per pengguna. Dipakai rute `POST /api/v1/connectors/:id/test`. */
export const CONNECTOR_TEST_RULE = { windowMs: 10 * 60 * 1000, max: 12 } as const;
let limiterUji: RateLimiter | null = null;
function connectorTestLimiter(): RateLimiter {
  if (!limiterUji) limiterUji = createRateLimiter({ ...CONNECTOR_TEST_RULE }, "connector_test");
  return limiterUji;
}

/** Memeriksa daftar putih alat MCP dari admin platform. Nama dinormalkan ke huruf kecil. */
function periksaDaftarAlatMcp(nilai: unknown): { ok: true; alat: string[] } | { ok: false; ditolak: string[]; pesan: string } {
  if (!Array.isArray(nilai)) {
    return { ok: false, ditolak: [], pesan: "Daftar alat MCP harus berupa larik nama alat (contoh: [\"kirim_pesan\"])." };
  }
  const mentah = nilai.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (mentah.length > MAX_MCP_TOOLS) {
    return { ok: false, ditolak: mentah.slice(MAX_MCP_TOOLS), pesan: `Maksimal ${MAX_MCP_TOOLS} alat MCP dalam satu daftar putih.` };
  }
  const ditolak = mentah.filter((item) => !MCP_TOOL_PATTERN.test(item));
  if (ditolak.length) {
    return { ok: false, ditolak, pesan: "Nama alat MCP hanya boleh huruf kecil, angka, titik, garis bawah, titik dua, dan tanda hubung (maksimal 64 karakter)." };
  }
  return { ok: true, alat: mentah };
}

function daftarAlat(nilai: unknown): { ok: true; alat: string[] } | { ok: false; kode: string; pesan: string } {
  if (nilai === undefined || nilai === null) return { ok: true, alat: [] };
  if (!Array.isArray(nilai)) return { ok: false, kode: "MCP_TOOL_LIST_INVALID", pesan: "Daftar alat MCP harus berupa larik nama alat." };
  const alat = nilai.map((item) => String(item).trim()).filter(Boolean);
  if (alat.length > MAX_TOOLS) return { ok: false, kode: "MCP_TOO_MANY_TOOLS", pesan: `Satu konektor MCP maksimal memakai ${MAX_TOOLS} alat.` };
  return { ok: true, alat };
}

/** Memvalidasi masukan konfigurasi konektor. Dipakai POST dan PATCH supaya aturannya tidak bercabang. */
function periksaKonfigurasi(input: { kind: string; url: unknown; token: unknown; alat: unknown; nama: unknown; wajibUrl: boolean }):
  | { ok: true; url: string; token: string; alat: string[]; nama: string }
  | { ok: false; status: number; kode: string; pesan: string; detail?: Record<string, unknown> } {
  const url = String(input.url ?? "").trim();
  if (!url && input.wajibUrl) return { ok: false, status: 400, kode: "CONNECTOR_URL_REQUIRED", pesan: "Alamat tujuan konektor belum diisi." };
  if (url.length > MAX_URL_CHARS) return { ok: false, status: 400, kode: "CONNECTOR_URL_TOO_LONG", pesan: `Alamat maksimal ${MAX_URL_CHARS} karakter.` };
  if (url) {
    const cek = checkOutboundUrl(url);
    if (!cek.ok) {
      return {
        ok: false,
        status: 400,
        kode: cek.code,
        pesan: cek.code === "CONNECTOR_HOST_NOT_ALLOWED" ? `${cek.message} Daftar putih saat ini: ${allowedOutboundHosts().join(", ") || "(kosong)"}.` : cek.message,
        detail: { daftarPutihHost: allowedOutboundHosts() },
      };
    }
  }
  const token = String(input.token ?? "").trim();
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, status: 400, kode: "CONNECTOR_TOKEN_TOO_LONG", pesan: `Token maksimal ${MAX_TOKEN_CHARS} karakter.` };
  const nama = String(input.nama ?? "").trim();
  if (nama.length > MAX_NAME_CHARS) return { ok: false, status: 400, kode: "CONNECTOR_NAME_TOO_LONG", pesan: `Nama konektor maksimal ${MAX_NAME_CHARS} karakter.` };
  const alat = daftarAlat(input.alat);
  if (!alat.ok) return { ok: false, status: 400, kode: alat.kode, pesan: alat.pesan };
  if (input.kind === "mcp") {
    const izin = mcpToolsAllowed(alat.alat);
    if (!izin.ok) {
      return {
        ok: false,
        status: 403,
        kode: "MCP_TOOL_NOT_ALLOWED",
        pesan: `Alat MCP berikut belum diizinkan admin platform: ${izin.ditolak.join(", ")}.`,
        detail: { ditolak: izin.ditolak, diizinkan: mcpAllowedTools() },
      };
    }
  }
  return { ok: true, url, token, alat: alat.alat, nama };
}

function segel(konfigurasi: { url: string; token: string; alat: string[]; nama: string }): { ok: true; ciphertext: string } | { ok: false; kode: string } {
  try {
    return { ok: true, ciphertext: sealSecret(JSON.stringify(konfigurasi)) };
  } catch (error) {
    const kode = error instanceof SecretsKeyError ? error.code : "SECRET_SEAL_FAILED";
    return { ok: false, kode };
  }
}

export function registerConnectorRoutes(app: any): void {
  app.get("/api/v1/connectors", { preHandler: requireUser }, async (request: any) => {
    const userId = request.user!.id;
    const rows = listConnectorRows(userId);
    const batas = connectorLimits();
    const diizinkan = mcpAllowedTools();
    return {
      katalog: catalogueFor(userId),
      konektor: rows.map(connectorView),
      total: rows.length,
      pengaturan: {
        kunci: secretsKeyState(),
        jenisKonektor: [...CONNECTOR_KINDS],
        statusSah: [...CONNECTOR_STATUSES],
        mcpAllowedTools: diizinkan,
        mcpTerbuka: diizinkan.length > 0,
        daftarPutihHost: allowedOutboundHosts(),
        // Menandakan pekerjaan (termasuk `connector.deliver`) dijalankan di proses web atau di proses
        // pekerja khusus. Diturunkan dari key yang benar-benar menentukan penjalanan pekerjaan.
        pekerjaDalamProses: config.JOB_WORKER_IN_WEB && !config.WORKER_ONLY,
        batasMenungguHuluMs: batas.childAbortMs,
        batasHidupProsesAnakMs: batas.parentDeadlineMs,
        maksimalKonektor: 20,
      },
      catatan:
        "Status 'aktif' hanya diberikan setelah hulu menjawab 2xx. Alamat webhook tidak pernah dikembalikan utuh (hanya host dan empat karakter terakhir), dan token tidak pernah dikembalikan.",
    };
  });

  app.post("/api/v1/connectors", { preHandler: requireUser }, async (request: any, reply: any) => {
    const body = (request.body ?? {}) as Body;
    const kind = String(body.kind ?? "").trim().toLowerCase();
    if (!isConnectorKind(kind)) {
      return fail(reply, 400, "CONNECTOR_KIND_INVALID", `Jenis konektor harus salah satu dari: ${CONNECTOR_KINDS.join(", ")}.`, { jenis: [...CONNECTOR_KINDS] });
    }
    const userId = request.user!.id;
    if (listConnectorRows(userId).filter((row) => row.kind === kind).length >= 10) {
      return fail(reply, 400, "CONNECTOR_LIMIT_REACHED", "Maksimal 10 sambungan per jenis konektor.");
    }
    const periksa = periksaKonfigurasi({ kind, url: body.url, token: body.token, alat: body.alat, nama: body.nama, wajibUrl: true });
    if (!periksa.ok) return fail(reply, periksa.status, periksa.kode, periksa.pesan, periksa.detail ?? {});
    const disegel = segel({ url: periksa.url, token: periksa.token, alat: periksa.alat, nama: periksa.nama });
    if (!disegel.ok) {
      return fail(reply, 503, disegel.kode, "Penyimpanan rahasia belum siap, jadi konektor tidak disimpan dan tidak ada rahasia yang ditulis sebagai teks polos.");
    }
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    const row = saveConnectorRow({ userId, kind, configCiphertext: disegel.ciphertext, enabled, status: "siap", lastError: "" });
    audit(userId, "connector.created", { connectorId: row.id, kind, enabled, host: periksa.url ? checkOutboundUrl(periksa.url).ok : false, alat: periksa.alat });
    return reply.code(201).send({ konektor: connectorView(row), pesan: "Konektor disimpan dengan status 'siap'. Kirim uji untuk membuktikan sambungannya." });
  });

  app.patch("/api/v1/connectors/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = connectorRowForUser(request.params.id, request.user!.id);
    if (!row) return fail(reply, 404, "CONNECTOR_NOT_FOUND", "Konektor tidak ditemukan.");
    const body = (request.body ?? {}) as Body;
    const lama = openConnectorConfig(row);
    if (!lama.ok) return fail(reply, 503, lama.kode, "Konfigurasi konektor tidak bisa dibuka.");
    const gabung = {
      url: body.url === undefined ? lama.config.url : body.url,
      token: body.token === undefined ? lama.config.token : body.token,
      alat: body.alat === undefined ? lama.config.alat : body.alat,
      nama: body.nama === undefined ? lama.config.nama : body.nama,
    };
    const periksa = periksaKonfigurasi({ kind: row.kind, url: gabung.url, token: gabung.token, alat: gabung.alat, nama: gabung.nama, wajibUrl: true });
    if (!periksa.ok) return fail(reply, periksa.status, periksa.kode, periksa.pesan, periksa.detail ?? {});
    const disegel = segel({ url: periksa.url, token: periksa.token, alat: periksa.alat, nama: periksa.nama });
    if (!disegel.ok) return fail(reply, 503, disegel.kode, "Penyimpanan rahasia belum siap, jadi perubahan tidak disimpan.");
    const now = new Date().toISOString();
    const field: string[] = ["config_ciphertext=?", "updated_at=?"];
    const nilai: unknown[] = [disegel.ciphertext, now];
    if (body.enabled !== undefined) {
      field.push("enabled=?");
      nilai.push(body.enabled ? 1 : 0);
    }
    // Perubahan konfigurasi membatalkan bukti kirim: status kembali 'siap' sampai ada kirim baru.
    field.push("status=?", "last_error=?");
    nilai.push("siap", "", row.id, request.user!.id);
    db.prepare(`UPDATE connectors SET ${field.join(", ")} WHERE id=? AND user_id=?`).run(...nilai);
    const baru = connectorRowForUser(row.id, request.user!.id)!;
    audit(request.user!.id, "connector.updated", { connectorId: row.id, kind: row.kind, enabled: baru.enabled === 1, ubahRahasia: body.url !== undefined || body.token !== undefined });
    return { konektor: connectorView(baru), pesan: "Perubahan disimpan. Status kembali 'siap' sampai kirim berikutnya berhasil." };
  });

  app.delete("/api/v1/connectors/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const dihapus = deleteConnectorRow(request.params.id, request.user!.id);
    if (!dihapus) return fail(reply, 404, "CONNECTOR_NOT_FOUND", "Konektor tidak ditemukan.");
    audit(request.user!.id, "connector.deleted", { connectorId: request.params.id });
    return { deleted: true, id: request.params.id };
  });

  app.post("/api/v1/connectors/:id/test", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = connectorRowForUser(request.params.id, request.user!.id);
    if (!row) return fail(reply, 404, "CONNECTOR_NOT_FOUND", "Konektor tidak ditemukan.");
    if (secretsKeyState() !== "ok") {
      return fail(reply, 503, "SECRETS_KEY_MISSING", "Penyimpanan rahasia belum dikonfigurasi, jadi konektor tidak bisa dibuka.");
    }
    const limiter = connectorTestLimiter();
    const kunci = `user:${request.user!.id}`;
    if (!limiter.allow(kunci)) {
      return fail(reply, 429, "CONNECTOR_TEST_RATE_LIMITED", `Maksimal ${CONNECTOR_TEST_RULE.max} kirim/uji per ${Math.round(CONNECTOR_TEST_RULE.windowMs / 60000)} menit. Coba lagi setelah ${limiter.retryAfterSeconds(kunci)} detik.`, { retryAfter: limiter.retryAfterSeconds(kunci), max: CONNECTOR_TEST_RULE.max });
    }
    const body = (request.body ?? {}) as Body;
    const teks = String(body.teks ?? "Uji kirim dari COBLAI Coder.").slice(0, 3000);
    const kirim = await deliverConnectorWithJob({ connectorId: row.id, userId: request.user!.id, teks, jenis: "uji" });
    const baru = connectorRowForUser(row.id, request.user!.id) ?? row;
    const hasil = kirim.hasil;
    if (hasil?.kode === "MCP_TOOL_NOT_ALLOWED") {
      return fail(reply, 403, "MCP_TOOL_NOT_ALLOWED", hasil.pesan, { konektor: connectorView(baru), hasil, pekerjaan: { id: kirim.jobId, diklaim: kirim.diklaim } });
    }
    if (hasil?.kode === "CONNECTOR_HOST_NOT_ALLOWED") {
      return fail(reply, 400, "CONNECTOR_HOST_NOT_ALLOWED", hasil.pesan, { konektor: connectorView(baru), hasil, pekerjaan: { id: kirim.jobId, diklaim: kirim.diklaim } });
    }
    return {
      konektor: connectorView(baru),
      hasil,
      pekerjaan: { id: kirim.jobId, diklaim: kirim.diklaim, pesan: kirim.pesan },
      // `pekerjaDalamProses` = pekerjaan dijalankan di proses web (key yang menentukan, lihat GET di atas).
      pengaturan: { pekerjaDalamProses: config.JOB_WORKER_IN_WEB && !config.WORKER_ONLY, batasMenungguHuluMs: connectorLimits().childAbortMs, batasHidupProsesAnakMs: connectorLimits().parentDeadlineMs },
    };
  });
  // ── Butir 71: daftar putih alat MCP untuk admin platform ─────────────────────────────────────────
  // Tanpa kedua rute ini, `platform_settings.mcp_allowed_tools` tidak punya penulis di produksi:
  // status katalog MCP selalu "dikembangkan" dan setiap pembuatan konektor MCP dijawab 403.
  app.get("/api/v1/admin/mcp-allowed-tools", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const alat = mcpAllowedTools();
    return {
      alat,
      terbuka: alat.length > 0,
      batas: { maksimalAlat: MAX_MCP_TOOLS, polaNama: String(MCP_TOOL_PATTERN) },
      catatan: "Daftar kosong berarti MCP tertutup: pembuatan konektor MCP dijawab 403 MCP_TOOL_NOT_ALLOWED.",
    };
  });

  app.put("/api/v1/admin/mcp-allowed-tools", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const body = (request.body ?? {}) as Body;
    const periksa = periksaDaftarAlatMcp(body.alat ?? body.tools);
    if (!periksa.ok) {
      return fail(reply, 400, "MCP_ALLOWED_TOOLS_INVALID", periksa.pesan, { ditolak: periksa.ditolak });
    }
    const alat = setMcpAllowedTools(periksa.alat);
    audit(request.user!.id, "admin.mcp_allowed_tools_updated", { jumlah: alat.length, terbuka: alat.length > 0, alat });
    return {
      alat,
      terbuka: alat.length > 0,
      katalog: catalogueFor(request.user!.id),
      pesan: alat.length
        ? `Daftar putih disimpan: ${alat.length} alat MCP diizinkan.`
        : "Daftar putih dikosongkan: MCP tertutup untuk semua pengguna.",
    };
  });
}

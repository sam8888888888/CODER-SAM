/**
 * Wave 11C (butir 71/82): lapisan penyimpanan konektor yang dipakai bersama rute dan pekerja.
 *
 * Berkas ini sengaja terpisah: `connectors.ts` (rute) memanggil pekerja, dan pekerja butuh membaca
 * konfigurasi konektor. Tanpa berkas ini keduanya harus saling mengimpor (siklus impor ESM).
 *
 * Fakta tabel (db.ts, versi skema 21): `connectors(id, user_id, kind, config_ciphertext, enabled,
 * status, last_error, created_at, updated_at)`. TIDAK ada kolom `nama` dan TIDAK ada kolom URL,
 * jadi nama konektor dan alamat tujuan ikut disegel di dalam `config_ciphertext` (JSON).
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { isSealed, maskSecret, tryOpenSecret } from "../secrets.js";
import { platformSetting, savePlatformSetting } from "../wave11a/shared.js";

export const CONNECTOR_KINDS = ["slack", "discord", "mcp"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** Kunci pengaturan platform berisi daftar putih alat MCP. Kosong = MCP belum dibuka sama sekali. */
export const MCP_ALLOWED_TOOLS_KEY = "mcp_allowed_tools";

/** Batas jumlah alat MCP yang boleh diizinkan admin platform sekaligus. */
export const MAX_MCP_TOOLS = 60;
/** Pola nama alat MCP yang sah: huruf kecil/angka, lalu boleh `.`, `_`, `:`, `-`. */
export const MCP_TOOL_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export const MAX_URL_CHARS = 500;
export const MAX_TOKEN_CHARS = 400;
export const MAX_NAME_CHARS = 60;
export const MAX_TOOLS = 20;

/** Status yang dilaporkan apa adanya ke pengguna. Tidak ada status "berhasil" yang tidak dibuktikan. */
export const CONNECTOR_STATUSES = ["aktif", "siap", "dikembangkan", "gagal"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export type ConnectorRow = {
  id: string;
  userId: string;
  kind: ConnectorKind;
  configCiphertext: string;
  enabled: number;
  status: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorConfig = { url?: string; token?: string; alat?: string[]; nama?: string };

export type ConnectorView = {
  id: string;
  kind: string;
  nama: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  tautan: {
    terpasang: boolean;
    tersegel: boolean;
    bisaDibuka: boolean;
    ekor: string | null;
    host: string | null;
    alat: string[];
  };
  createdAt: string;
  updatedAt: string;
};

export type CatalogueEntry = {
  kind: ConnectorKind;
  nama: string;
  keterangan: string;
  rahasia: string;
  contoh: string;
  dasarStatus: "platform" | "sambungan_pengguna";
  status: ConnectorStatus;
};

const ROW_COLUMNS =
  "id, user_id AS userId, kind, config_ciphertext AS configCiphertext, enabled, status, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt";

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return (CONNECTOR_KINDS as readonly string[]).includes(String(value));
}

export function listConnectorRows(userId: string): ConnectorRow[] {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM connectors WHERE user_id=? ORDER BY created_at`).all(userId) as ConnectorRow[];
}

export function connectorRow(connectorId: string): ConnectorRow | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM connectors WHERE id=?`).get(String(connectorId ?? "")) as ConnectorRow | undefined;
  return row ?? null;
}

export function connectorRowForUser(connectorId: string, userId: string): ConnectorRow | null {
  const row = db
    .prepare(`SELECT ${ROW_COLUMNS} FROM connectors WHERE id=? AND user_id=?`)
    .get(String(connectorId ?? ""), userId) as ConnectorRow | undefined;
  return row ?? null;
}

export function saveConnectorRow(input: {
  id?: string;
  userId: string;
  kind: ConnectorKind;
  configCiphertext: string;
  enabled: boolean;
  status: ConnectorStatus;
  lastError?: string;
}): ConnectorRow {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO connectors (id,user_id,kind,config_ciphertext,enabled,status,last_error,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, config_ciphertext=excluded.config_ciphertext,
       enabled=excluded.enabled, status=excluded.status, last_error=excluded.last_error, updated_at=excluded.updated_at`,
  ).run(id, input.userId, input.kind, input.configCiphertext, input.enabled ? 1 : 0, input.status, input.lastError ?? "", now, now);
  return connectorRow(id) as ConnectorRow;
}

/** Menyimpan nomor hasil kirim apa adanya. `last_error` dikosongkan saat kirim berhasil. */
export function updateConnectorState(connectorId: string, patch: { status?: ConnectorStatus; lastError?: string; enabled?: boolean }) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status=?");
    params.push(patch.status);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error=?");
    params.push(patch.lastError.slice(0, 400));
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled=?");
    params.push(patch.enabled ? 1 : 0);
  }
  if (!sets.length) return;
  sets.push("updated_at=?");
  params.push(new Date().toISOString(), String(connectorId));
  db.prepare(`UPDATE connectors SET ${sets.join(", ")} WHERE id=?`).run(...params);
}

export function deleteConnectorRow(connectorId: string, userId: string): boolean {
  const info = db.prepare("DELETE FROM connectors WHERE id=? AND user_id=?").run(String(connectorId ?? ""), userId);
  return info.changes > 0;
}

/** Membuka konfigurasi tersegel. Kunci hilang bukan galat pengguna, jadi dikembalikan sebagai kode. */
export function openConnectorConfig(row: ConnectorRow): { ok: true; config: ConnectorConfig } | { ok: false; kode: "SECRETS_KEY_MISSING" | "SECRET_CONFIG_RUSAK" } {
  if (!row.configCiphertext) return { ok: true, config: {} };
  const hasil = tryOpenSecret(row.configCiphertext);
  if (!hasil.ok) return { ok: false, kode: hasil.code === "SECRETS_KEY_MISSING" ? "SECRETS_KEY_MISSING" : "SECRET_CONFIG_RUSAK" };
  try {
    const parsed = JSON.parse(hasil.value) as ConnectorConfig;
    if (!parsed || typeof parsed !== "object") return { ok: false, kode: "SECRET_CONFIG_RUSAK" };
    return { ok: true, config: parsed };
  } catch {
    return { ok: false, kode: "SECRET_CONFIG_RUSAK" };
  }
}

/**
 * Bentuk yang boleh dilihat pengguna. Alamat webhook TIDAK PERNAH dikembalikan utuh: hanya host dan
 * empat karakter terakhir (aturan yang sama dengan daftar rahasia Wave 11A), dan token tidak sama sekali.
 *
 * Batas yang diterima apa adanya: tabel `connectors` tidak punya kolom `nama`, jadi nama hidup di dalam
 * JSON tersegel bersama alamat/token. Akibatnya katalog TIDAK bisa mencari atau mengurutkan konektor
 * berdasarkan nama (itu butuh nama sebagai teks polos, dan itu melemahkan penyegelan). Pemilik tetap
 * melihat namanya lewat `GET /api/v1/connectors`, karena permintaan itu membuka segelnya di sisi server
 * tanpa perlu kunci rahasia pihak ketiga.
 */
export function connectorView(row: ConnectorRow): ConnectorView {
  const dibuka = openConnectorConfig(row);
  const config = dibuka.ok ? dibuka.config : {};
  const rahasia = String(config.url ?? config.token ?? "");
  let host: string | null = null;
  if (config.url) {
    try {
      host = new URL(String(config.url)).hostname.toLowerCase();
    } catch {
      host = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    nama: String(config.nama ?? ""),
    enabled: row.enabled === 1,
    status: row.status,
    lastError: row.lastError ? row.lastError : null,
    tautan: {
      terpasang: row.configCiphertext !== "",
      tersegel: isSealed(row.configCiphertext),
      bisaDibuka: dibuka.ok,
      ekor: rahasia ? maskSecret(rahasia).ekor : null,
      host,
      alat: Array.isArray(config.alat) ? config.alat : [],
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Daftar putih alat MCP dari pengaturan platform. Bawaan kosong berarti MCP tertutup. */
export function mcpAllowedTools(): string[] {
  const raw = platformSetting(MCP_ALLOWED_TOOLS_KEY) ?? "";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Menulis daftar putih alat MCP ke pengaturan platform. Ini SATU-SATUNYA penulis di produksi
 * (rutenya `PUT /api/v1/admin/mcp-allowed-tools`, khusus admin platform) — sebelum ini hanya suite
 * uji yang menulis kunci ini, sehingga MCP selalu tertutup bagi pelanggan.
 * Nama dinormalkan: huruf kecil, tanpa duplikat. Kosong = MCP tertutup.
 */
export function setMcpAllowedTools(alat: string[]): string[] {
  const bersih = Array.from(new Set(alat.map((item) => String(item).trim().toLowerCase()).filter(Boolean)));
  savePlatformSetting(MCP_ALLOWED_TOOLS_KEY, bersih.join(","));
  return bersih;
}

export function mcpToolsAllowed(tools: unknown): { ok: true } | { ok: false; ditolak: string[] } {
  const daftar = (Array.isArray(tools) ? tools : []).map((item) => String(item).trim()).filter(Boolean);
  const diizinkan = mcpAllowedTools().map((item) => item.toLowerCase());
  if (!diizinkan.length) return { ok: false, ditolak: daftar.length ? daftar : ["(semua alat)"] };
  const ditolak = daftar.filter((item) => !diizinkan.includes(item.toLowerCase()));
  return ditolak.length ? { ok: false, ditolak } : { ok: true };
}

/** Status tingkat platform: apa yang mungkin di platform ini, sebelum ada sambungan pengguna. */
export function platformStatusFor(kind: ConnectorKind): ConnectorStatus {
  if (kind === "mcp") return mcpAllowedTools().length ? "siap" : "dikembangkan";
  return "siap";
}

const CATALOGUE: Array<Omit<CatalogueEntry, "dasarStatus" | "status">> = [
  {
    kind: "slack",
    nama: "Slack",
    keterangan: "Kirim pesan ke satu kanal Slack lewat Incoming Webhook. URL webhook berlaku sebagai rahasia.",
    rahasia: "URL webhook (disimpan tersegel)",
    contoh: "https://hooks.slack.com/services/T000/B000/xxxx",
  },
  {
    kind: "discord",
    nama: "Discord",
    keterangan: "Kirim pesan ke satu kanal Discord lewat webhook kanal. Server MCP dan bot Discord tidak dipakai di sini.",
    rahasia: "URL webhook (disimpan tersegel)",
    contoh: "https://discord.com/api/webhooks/000/xxxx",
  },
  {
    kind: "mcp",
    nama: "MCP (Model Context Protocol)",
    keterangan: "Panggil alat dari server MCP. Tanpa izin admin platform, konektor MCP dilaporkan 'dikembangkan' dan tidak bisa mengirim.",
    rahasia: "URL server + token (disimpan tersegel)",
    contoh: "https://mcp.contoh.id/rpc",
  },
];

/**
 * Katalog lengkap untuk satu pengguna. Status digabung dari dua tingkat dan selalu apa adanya:
 *  - `platform`      : platform sendiri belum/ sudah menyediakan jenis ini (mis. MCP menunggu izin admin).
 *  - `sambungan_pengguna`: ada sambungan milik pengguna ini; 'aktif' HANYA setelah kirim berhasil.
 */
export function catalogueFor(userId: string): CatalogueEntry[] {
  const rows = listConnectorRows(userId);
  return CATALOGUE.map((entry) => {
    const milik = rows.filter((row) => row.kind === entry.kind);
    if (!milik.length) return { ...entry, dasarStatus: "platform" as const, status: platformStatusFor(entry.kind) };
    const aktif = milik.some((row) => row.enabled === 1 && row.status === "aktif");
    const gagal = milik.some((row) => row.status === "gagal");
    return { ...entry, dasarStatus: "sambungan_pengguna" as const, status: aktif ? "aktif" : gagal ? "gagal" : "siap" };
  });
}

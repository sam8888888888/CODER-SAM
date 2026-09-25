/**
 * Wave 11A (butir 53): audit-diri kredensial + konfigurasi. HANYA MEMBACA.
 *
 * Modul ini tidak pernah mengubah data: tidak memperbaiki, tidak menghapus, dan tidak membuka segel.
 * Keluarannya dipakai halaman Status ("Kesehatan platform" + tombol "Jalankan uji mandiri").
 *
 * Aturan yang dipegang: nilai rahasia TIDAK PERNAH muncul di keluaran, termasuk di `catatan`.
 * Laporan hanya memuat jumlah baris, nama tabel/kolom, dan keadaan konfigurasi.
 *
 * Memakai `config` yang bisa diubah uji (seperti suite Wave 10) supaya laporan benar-benar mengikuti
 * konfigurasi yang sedang berlaku, bukan nilai yang dihafal saat modul dimuat.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { isSealed, sealedPrefix, secretsKeyState, tryOpenSecret } from "./secrets.js";
import { activeSecretLeases, SECRET_LEASE_STALE_MS } from "./run-secret-vault.js";

export type SelfAuditStatus = "ok" | "warn" | "fail";

/** Satu butir pemeriksaan. `catatan` tidak pernah memuat nilai rahasia. */
export type SelfAuditCheck = { id: string; judul: string; status: SelfAuditStatus; catatan: string };

export type SelfAuditReport = {
  ranAt: string;
  checks: SelfAuditCheck[];
  ringkasan: { ok: number; warn: number; fail: number };
};

/** Pindai penanda segel dibatasi supaya audit tetap cepat pada basis data besar. */
const SCAN_MAX_COLUMNS = 300;
const SCAN_MAX_ROWS = 2000;

/** Nilai yang lebih pendek dari ini tidak dipindai ke catatan audit: terlalu mudah salah tuduh. */
const MIN_SCAN_VALUE_CHARS = 8;

function escapeIdent(name: string): string {
  return String(name).replace(/"/g, '""');
}

function countRows(sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Baris rahasia yang masih tersimpan sebagai teks polos (nilai hanya dihitung, tidak dibaca keluar). */
function unsealedRows(): { total: number; belumTersegel: number } {
  const rows = db.prepare("SELECT secret_ciphertext AS stored FROM user_secrets").all() as Array<{ stored: string }>;
  const belum = rows.filter((row) => !isSealed(row.stored)).length;
  return { total: rows.length, belumTersegel: belum };
}

/** Nilai rahasia yang bisa dibuka, khusus untuk membandingkan dengan catatan audit. Tidak pernah dicetak. */
function readableSecretValues(): string[] {
  const rows = db.prepare("SELECT secret_ciphertext AS stored FROM user_secrets").all() as Array<{ stored: string }>;
  const values: string[] = [];
  for (const row of rows) {
    const opened = tryOpenSecret(row.stored);
    if (opened.ok && opened.value.length >= MIN_SCAN_VALUE_CHARS) values.push(opened.value);
  }
  return values;
}

/**
 * Memindai semua kolom teks untuk penanda segel. Penanda itu hanya boleh ada di
 * `user_secrets.secret_ciphertext`; bila muncul di kolom lain, ada rahasia yang bocor ke tempat
 * yang tidak seharusnya. Yang dilaporkan hanya nama tabel/kolom dan jumlah baris.
 */
function scanSealMarker(): { hits: Array<{ tabel: string; kolom: string; baris: number }>; dipindai: number; dipotong: boolean } {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  const hits: Array<{ tabel: string; kolom: string; baris: number }> = [];
  let dipindai = 0;
  let dipotong = false;
  for (const table of tables) {
    if (dipindai >= SCAN_MAX_COLUMNS) { dipotong = true; break; }
    let columns: Array<{ name: string }> = [];
    try { columns = db.pragma(`table_info("${escapeIdent(table.name)}")`) as Array<{ name: string }>; } catch { continue; }
    for (const column of columns) {
      if (dipindai >= SCAN_MAX_COLUMNS) { dipotong = true; break; }
      if (table.name === "user_secrets" && column.name === "secret_ciphertext") continue;
      dipindai += 1;
      try {
        const n = countRows(
          `SELECT COUNT(*) AS n FROM (SELECT "${escapeIdent(column.name)}" AS v FROM "${escapeIdent(table.name)}" LIMIT ${SCAN_MAX_ROWS}) WHERE instr(v, ?) > 0`,
          sealedPrefix,
        );
        if (n > 0) hits.push({ tabel: table.name, kolom: column.name, baris: n });
      } catch { /* kolom yang tidak bisa dipindai (mis. BLOB aneh) dilewati, bukan digagalkan */ }
    }
  }
  return { hits, dipindai, dipotong };
}

/** Menjalankan satu pemeriksaan; galat tak terduga menjadi status `fail`, bukan merobohkan laporan. */
function guard(id: string, judul: string, work: () => { status: SelfAuditStatus; catatan: string }): SelfAuditCheck {
  try {
    return { id, judul, ...work() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id, judul, status: "fail", catatan: `Pemeriksaan gagal dijalankan: ${message.slice(0, 160)}` };
  }
}

/** Menjalankan seluruh pemeriksaan. `now` bisa diisi uji untuk menguji jalur sewa yang menggantung. */
export function runSelfAudit(now: Date = new Date()): SelfAuditReport {
  const checks: SelfAuditCheck[] = [];

  checks.push(guard("secrets_key", "Kunci induk rahasia", () => {
    const state = secretsKeyState();
    if (state === "ok") return { status: "ok", catatan: "SECRETS_KEY terbaca sebagai 32 byte base64." };
    if (state === "missing") {
      return { status: "fail", catatan: "SECRETS_KEY belum diisi; fitur penyimpanan rahasia menolak dengan 503 SECRETS_KEY_MISSING." };
    }
    return { status: "fail", catatan: "SECRETS_KEY ada tetapi bukan 32 byte base64 yang sah; fitur penyimpanan rahasia menolak dengan 503 SECRETS_KEY_MISSING." };
  }));

  checks.push(guard("secrets_tersegel", "Rahasia tersimpan tersegel (bukan teks polos)", () => {
    const { total, belumTersegel } = unsealedRows();
    if (belumTersegel > 0) {
      return { status: "fail", catatan: `${belumTersegel} baris belum tersegel (teks polos) dari ${total} baris rahasia.` };
    }
    return { status: "ok", catatan: `Semua ${total} baris rahasia tersegel versi 1.` };
  }));

  checks.push(guard("audit_bebas_rahasia", "Catatan audit bebas nilai rahasia", () => {
    const total = countRows("SELECT COUNT(*) AS n FROM audit_events");
    const penanda = countRows("SELECT COUNT(*) AS n FROM audit_events WHERE instr(metadata_json, ?) > 0", sealedPrefix);
    let nilai = 0;
    for (const value of readableSecretValues()) {
      nilai += countRows("SELECT COUNT(*) AS n FROM audit_events WHERE instr(metadata_json, ?) > 0", value);
    }
    const bocor = penanda + nilai;
    if (bocor > 0) {
      return { status: "fail", catatan: `${bocor} baris audit memuat penanda segel atau nilai rahasia dari ${total} baris yang diperiksa.` };
    }
    return { status: "ok", catatan: `Tidak ada penanda segel maupun nilai rahasia pada ${total} baris audit.` };
  }));

  checks.push(guard("segel_hanya_di_tabel_rahasia", "Penanda segel hanya di kolom rahasia", () => {
    const { hits, dipindai, dipotong } = scanSealMarker();
    const ekorCatatan = dipotong ? ` (pindai dipotong setelah ${dipindai} kolom)` : ` (${dipindai} kolom dipindai)`;
    if (hits.length > 0) {
      const daftar = hits.slice(0, 5).map((hit) => `${hit.tabel}.${hit.kolom} (${hit.baris} baris)`).join(", ");
      return { status: "fail", catatan: `Penanda segel ditemukan di luar tabel rahasia: ${daftar}.` };
    }
    return { status: "ok", catatan: `Penanda segel hanya ada di kolom rahasia${ekorCatatan}.` };
  }));

  checks.push(guard("izin_folder_data", "Izin folder data", () => {
    const dir = config.DATA_DIR;
    if (!existsSync(dir)) {
      return { status: "fail", catatan: `Folder data ${dir} tidak ada.` };
    }
    const mode = statSync(dir).mode & 0o777;
    const worldWritable = (mode & 0o002) !== 0;
    if (worldWritable) {
      return { status: "warn", catatan: `Folder data ${dir} dapat ditulis siapa saja (mode ${mode.toString(8)}).` };
    }
    return { status: "ok", catatan: `Folder data ${dir} hanya dapat ditulis pemiliknya (mode ${mode.toString(8)}).` };
  }));

  checks.push(guard("retensi_aktif", "Pembersihan retensi", () => {
    if (!config.RETENTION_ENABLED) {
      return { status: "warn", catatan: "Retensi mati (RETENTION_ENABLED=false); data lama tidak dihapus otomatis." };
    }
    const mode = config.RETENTION_DRY_RUN ? "mode kering (tidak menghapus)" : "menghapus sungguhan";
    return { status: "ok", catatan: `Retensi aktif, ${mode}.` };
  }));

  checks.push(guard("csp_aktif", "Pagar CSP", () => {
    if (!config.CSP_ENABLED) {
      return { status: "warn", catatan: "CSP_ENABLED mati; peramban tidak menerima kebijakan konten." };
    }
    return { status: "ok", catatan: "CSP_ENABLED aktif; pemasangan headernya diperiksa modul CSP." };
  }));

  checks.push(guard("basis_data", "Koneksi basis data", () => {
    const path = resolve(config.DATA_DIR, "coder.db");
    const row = db.prepare("SELECT 1 AS satu").get() as { satu?: number } | undefined;
    const menjawab = Number(row?.satu ?? 0) === 1;
    const ada = existsSync(path);
    const ukuran = ada ? statSync(path).size : 0;
    if (!menjawab || !ada) {
      return { status: "fail", catatan: `Basis data tidak sehat (menjawab: ${menjawab}, berkas ada: ${ada}).` };
    }
    return { status: "ok", catatan: `Basis data menjawab; berkas ${path} ada (${ukuran} byte).` };
  }));

  checks.push(guard("sewa_rahasia", "Sewa rahasia per run", () => {
    const leases = activeSecretLeases();
    const menggantung = leases.filter((lease) => now.getTime() - Date.parse(lease.at) > SECRET_LEASE_STALE_MS).length;
    if (menggantung > 0) {
      return { status: "warn", catatan: `${menggantung} dari ${leases.length} sewa rahasia aktif lebih tua dari 1 jam.` };
    }
    return { status: "ok", catatan: leases.length ? `${leases.length} sewa rahasia aktif, tidak ada yang lebih tua dari 1 jam.` : "Tidak ada sewa rahasia yang aktif." };
  }));

  checks.push(guard("ringkasan_rahasia", "Jumlah rahasia tersimpan", () => {
    const { total, belumTersegel } = unsealedRows();
    const pengguna = countRows("SELECT COUNT(DISTINCT user_id) AS n FROM user_secrets");
    return { status: "ok", catatan: `${total} baris rahasia milik ${pengguna} pengguna; ${belumTersegel} belum tersegel.` };
  }));

  const ringkasan = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) ringkasan[check.status] += 1;
  return { ranAt: now.toISOString(), checks, ringkasan };
}

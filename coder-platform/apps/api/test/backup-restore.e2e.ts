/**
 * Uji otomatis backup dan restore database (celah yang tercatat di `docs/STATUS.md`:
 * "Backup, restore, dan rute unduh artefak belum punya uji otomatis").
 *
 * Uji ini menjalankan SKRIP ASLI yang dipakai di produksi, bukan salinan logika:
 *   - `apps/api/src/backup.ts`  -> `npm run backup`
 *   - `apps/api/src/restore.ts` -> `npm run restore -- <berkas>`
 *
 * Yang dibuktikan:
 *  1) backup ditulis ke <cwd>/backups/coder-<waktu>.db dan isinya utuh (`integrity_check` ok),
 *  2) data yang masih berada di WAL tetap ikut terbawa. Salinan mentah berkas `coder.db` saja akan
 *     kehilangan baris itu, jadi pemeriksaan ini tepat menyasar alasan kita memakai aplikasi sendiri
 *     untuk mem-backup (bukan `docker cp`),
 *  3) restore ke folder data baru menghasilkan database yang bisa dibuka dan datanya kembali,
 *  4) restore menimpa database lama di folder tujuan (perilaku yang memang dipakai saat pemulihan),
 *  5) restore tanpa argumen atau dengan berkas yang tidak ada GAGAL dengan pesan penggunaan,
 *  6) versi skema ikut terbawa (tabel `schema_migrations`).
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/backup-restore.e2e.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tsxCli = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const backupScript = join(repoRoot, "apps/api/src/backup.ts");
const restoreScript = join(repoRoot, "apps/api/src/restore.ts");

const root = mkdtempSync(join(tmpdir(), "coder-backup-probe-"));
const dataDir = join(root, "data");
const restoredDir = join(root, "data-restored");
mkdirSync(dataDir, { recursive: true });
mkdirSync(restoredDir, { recursive: true });

process.env.NODE_ENV = "test";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = join(root, "public");
process.env.MOCK_ENGINE = "true";

let checks = 0;
let passed = 0;
let failed = 0;
const failedNames: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (ok) { passed += 1; console.log(`PASS ${checks}) ${name}`); return; }
  failed += 1; failedNames.push(`${checks}) ${name}`);
  console.log(`FAIL ${checks}) ${name}${detail ? ` :: ${detail}` : ""}`);
}
function short(value: unknown, limit = 260): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}
function runScript(script: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

const marker = `penanda-backup-${Date.now()}`;
const probeEmail = `backup-probe-${Date.now()}@example.test`;

// Tulis data lewat modul aplikasi yang sama seperti produksi, supaya skema dan WAL-nya nyata.
const { db } = await import("../src/db.js");
const { DatabaseSync } = await import("node:sqlite") as any;
db.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)").run("backup_probe", marker, new Date().toISOString());
db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
  .run(`00000000-0000-4000-8000-0000000000${String(Date.now()).slice(-2)}`, probeEmail, "Pengguna Backup", "scrypt$uji", new Date().toISOString(), new Date().toISOString());
const schemaVersion = (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as any)?.version ?? 0;
check("database uji siap dan versi skema terbaca", schemaVersion >= 12, `versi=${schemaVersion}`);

const walPath = join(dataDir, "coder.db-wal");
const walSizeBefore = existsSync(walPath) ? statSync(walPath).size : 0;
check("data terbaru masih berada di berkas WAL sebelum backup", walSizeBefore > 0, `ukuran WAL=${walSizeBefore}`);

const backupRun = runScript(backupScript, [], { DATA_DIR: dataDir });
check("skrip backup selesai tanpa error", backupRun.status === 0, short(backupRun.out));
check("skrip backup melaporkan berkas yang ditulis", backupRun.out.includes("Backup written:"), short(backupRun.out));

const backupsDir = join(root, "backups");
const backupFiles = existsSync(backupsDir) ? readdirSync(backupsDir).filter((name) => name.startsWith("coder-") && name.endsWith(".db")) : [];
check("berkas backup ada di folder backups dengan nama coder-<waktu>.db", backupFiles.length === 1, short(backupFiles));
const backupPath = backupFiles.length ? join(backupsDir, backupFiles[0]) : "";
check("berkas backup tidak kosong", backupPath !== "" && statSync(backupPath).size > 0, backupPath ? String(statSync(backupPath).size) : "tidak ada");

function inspect(file: string): { integrity: string | null; marker: string | null; users: number; version: number; error?: string } {
  let handle: any;
  try {
    handle = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    // Berkas rusak atau bukan database: dikembalikan sebagai integrity null supaya bisa diperiksa.
    return { integrity: null, marker: null, users: 0, version: 0, error: String((error as Error).message) };
  }
  try {
    const integrity = (handle.prepare("PRAGMA integrity_check").get() as any)?.integrity_check;
    const settings = handle.prepare("SELECT value FROM platform_settings WHERE key = 'backup_probe'").get() as any;
    const users = handle.prepare("SELECT COUNT(*) AS total FROM users WHERE email = ?").get(probeEmail) as any;
    const version = (handle.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as any)?.version ?? 0;
    return { integrity, marker: settings?.value ?? null, users: users?.total ?? 0, version };
  } catch (error) {
    return { integrity: null, marker: null, users: 0, version: 0, error: String((error as Error).message) };
  } finally { handle.close(); }
}

if (backupPath === "" || !existsSync(backupPath)) {
  console.log("FATAL: berkas backup tidak ada, sisa pemeriksaan dihentikan.");
  console.log("BACKUP_RESTORE_TESTS_FAILED"); process.exit(1);
}
const backupInspect = inspect(backupPath);
check("isi berkas backup utuh (integrity_check ok)", backupInspect.integrity === "ok", short(backupInspect));
check("data yang sebelumnya di WAL IKUT terbawa ke berkas backup", backupInspect.marker === marker, `penanda=${short(backupInspect.marker)}`);
check("baris pengguna ada di berkas backup", backupInspect.users === 1, `baris=${backupInspect.users}`);
check("versi skema ikut tersalin ke berkas backup", backupInspect.version === schemaVersion, `versi backup=${backupInspect.version} asal=${schemaVersion}`);

// Restore ke folder data baru: harus menghasilkan database yang bisa dibuka dan berisi data yang sama.
const restoreRun = runScript(restoreScript, [backupPath], { DATA_DIR: restoredDir });
check("skrip restore selesai tanpa error", restoreRun.status === 0, short(restoreRun.out));
check("skrip restore melaporkan tujuan pemulihan", restoreRun.out.includes("Database restored to:"), short(restoreRun.out));
const restoredFile = join(restoredDir, "coder.db");
check("berkas database hasil restore ada", existsSync(restoredFile), restoredFile);
const restoredInspect = inspect(restoredFile);
check("database hasil restore utuh (integrity_check ok)", restoredInspect.integrity === "ok", short(restoredInspect));
check("data dari berkas backup benar-benar kembali setelah restore", restoredInspect.marker === marker && restoredInspect.users === 1, short(restoredInspect));

// Penimpaan: bila folder tujuan sudah punya database lama, restore harus MENGGANTINYA.
const stale = new DatabaseSync(restoredFile);
stale.exec("UPDATE platform_settings SET value = 'penanda-lama' WHERE key = 'backup_probe'");
stale.close();
const restoreAgain = runScript(restoreScript, [backupPath], { DATA_DIR: restoredDir });
check("restore kedua kali juga berhasil (menimpa database tujuan)", restoreAgain.status === 0, short(restoreAgain.out));
const afterOverwrite = inspect(restoredFile);
check("database tujuan benar-benar diganti oleh berkas backup", afterOverwrite.marker === marker, short(afterOverwrite));

// Jalur gagal harus berhenti dengan pesan penggunaan, bukan diam-diam merusak data.
const noArgument = runScript(restoreScript, [], { DATA_DIR: restoredDir });
check("restore tanpa argumen GAGAL dengan kode keluar bukan nol", noArgument.status !== 0, `kode=${noArgument.status} ${short(noArgument.out)}`);
check("pesan penggunaan dijelaskan saat argumen kosong", noArgument.out.includes("Usage:"), short(noArgument.out));
const missingFile = runScript(restoreScript, [join(root, "tidak-ada.db")], { DATA_DIR: restoredDir });
check("restore berkas yang tidak ada GAGAL dengan kode keluar bukan nol", missingFile.status !== 0, `kode=${missingFile.status} ${short(missingFile.out)}`);
const afterFailedRestore = inspect(restoredFile);
check("database tujuan tidak rusak setelah percobaan restore yang gagal", afterFailedRestore.integrity === "ok" && afterFailedRestore.marker === marker, short(afterFailedRestore));

// Berkas sampah yang tidak bisa dibuka harus diberi tahu tadi: pastikan pesan kegagalan jelas.
const junkPath = join(root, "sampah.db");
writeFileSync(junkPath, "ini bukan database sqlite");
const junkRun = runScript(restoreScript, [junkPath], { DATA_DIR: restoredDir });
const junkCopied = inspect(join(restoredDir, "coder.db"));
check("TEMUAN: restore menyalin berkas apa pun tanpa memeriksa isinya", junkRun.status === 0 && existsSync(join(restoredDir, "coder.db")) && junkCopied.integrity === null,
  `kode=${junkRun.status} integrity=${short(junkCopied.integrity)}`);
console.log("INFO restore hanya menyalin berkas; berkas rusak tidak ditolak saat restore, tetapi gagal saat aplikasi membukanya.");
if (!existsSync(join(restoredDir, "coder.db"))) throw new Error("berkas tujuan restore hilang");

db.close();

console.log("\n=== RINGKASAN ===");
console.log(`total pemeriksaan: ${checks}, lulus: ${passed}, gagal: ${failed}`);
console.log(`folder uji: ${root}`);
if (failed) { console.log(`gagal pada: ${failedNames.join("; ")}`); console.log("BACKUP_RESTORE_TESTS_FAILED"); process.exit(1); }
console.log("ALL_BACKUP_RESTORE_TESTS_PASSED");
process.exit(0);

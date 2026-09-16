/**
 * Migration check (Wave 9: the check is now automatic and complete).
 *
 * This file used to be a manual script. The real work lives in `apps/api/src/migration-rehearsal.ts`,
 * because that module is shipped inside the image and the deploy run rehearses the migration on the
 * newest production backup before the container is replaced. This wrapper keeps the old command
 * working for anyone who used it, and runs exactly the same check as the deploy gate:
 *
 *   npx tsx apps/api/test/migration-check.ts                 # bases data baru, tanpa berkas sumber
 *   npx tsx apps/api/test/migration-check.ts <backup.db>     # menyalin berkas itu lalu memeriksanya
 *
 * Hasil: `MIGRATION_REHEARSAL_OK` (kode keluar 0) atau `MIGRATION_REHEARSAL_FAILED` (kode keluar 1).
 */
import { existsSync } from "node:fs";
import { printRehearsalReport, runMigrationRehearsal } from "../src/migration-rehearsal.js";

const source = process.argv[2] ? process.argv[2] : null;
if (source && !existsSync(source)) {
  console.log("MIGRATION_REHEARSAL_FAILED 1");
  console.log(`MASALAH: berkas sumber tidak ditemukan: ${source}`);
  process.exit(1);
}
const report = await runMigrationRehearsal({ sourceDb: source, keep: Boolean(process.argv[3]) });
printRehearsalReport(report);
process.exit(report.ok ? 0 : 1);

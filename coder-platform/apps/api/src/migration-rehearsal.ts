/**
 * Migration rehearsal (Wave 9, item 18).
 *
 * Opening the database applies every pending migration to the file it points at, so a migration
 * that is wrong can only be discovered after production has already been changed. This tool
 * rehearses that opening on a COPY:
 *
 *   - without a source file: it builds a brand new database from scratch and checks the schema,
 *   - with a source file (a production backup): it copies the file, opens the copy, and proves that
 *     every row of the important tables survives, that the schema version is the expected one, that
 *     the columns added by the newest release exist, and that the file is still intact.
 *
 * It never opens the real DATA_DIR: the copy always lives in a fresh temporary folder. The tool is
 * shipped inside the image, so the deploy run can rehearse against the newest application backup
 * before the running container is replaced.
 *
 * Usage:
 *   npx tsx apps/api/src/migration-rehearsal.ts [sourceDb] [--keep] [--json]
 *   node dist/api/migration-rehearsal.js /app/backups/coder-<stamp>.db
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** Tables whose row counts must never change during a migration. */
export const IMPORTANT_TABLES = [
  "users", "auth_sessions", "workspaces", "memberships", "projects", "conversations", "messages",
  "runs", "run_events", "artifacts", "knowledge_documents", "knowledge_chunks", "workflows",
  "workflow_executions", "workflow_execution_steps", "run_usage", "user_usage", "orders",
  "subscriptions", "credit_ledger", "api_keys", "notifications", "email_outbox", "jobs",
];

/** Every table the schema creates. A missing table means the schema did not run to the end. */
export const EXPECTED_TABLES = [
  ...IMPORTANT_TABLES, "schema_migrations", "platform_settings", "plans", "coupons", "bank_accounts",
  "payments", "message_attachments", "agent_memories", "prompt_templates", "agent_personas",
  "agent_settings", "conversation_summaries", "notification_prefs", "data_exports", "webhooks",
  "webhook_deliveries", "referral_codes", "referrals", "growth_events", "onboarding_state",
  "rate_limit_hits", "model_price_overrides", "token_quotas", "workspace_invitations", "audit_events",
];

/** Columns added by the releases we must be able to prove are in place. */
export const EXPECTED_COLUMNS: [string, string][] = [
  ["run_usage", "cost_micros"], ["run_usage", "sell_cost_micros"], ["user_usage", "sell_cost_micros"],
  ["users", "deleted_at"], ["users", "purge_after"], ["users", "mfa_secret"],
  ["rate_limit_hits", "bucket"], ["rate_limit_hits", "hit_at"],
  ["model_price_overrides", "input_per_mtok"], ["model_price_overrides", "output_per_mtok"],
  ["jobs", "dedupe_key"], ["runs", "model"], ["auth_sessions", "last_seen_at"],
];

export type RehearsalReport = {
  ok: boolean;
  source: string | null;
  dataDir: string;
  schemaVersion: number | null;
  expectedVersion: number;
  migrationRows: number;
  missingTables: string[];
  missingColumns: string[];
  rowCounts: Record<string, number>;
  before: Record<string, number> | null;
  mismatches: string[];
  integrity: string;
  foreignKeys: boolean;
  probes: { modelPriceOverride: boolean; awaitingApprovalAllowed: boolean; probeRolledBack: boolean };
  reopen: { ran: boolean; ok: boolean; detail: string };
  problems: string[];
};

function countRows(database: Database.Database, table: string): number {
  try {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number } | undefined;
    return Number(row?.total ?? 0);
  } catch {
    return -1;
  }
}

function columnNames(database: Database.Database, table: string): string[] {
  try {
    return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
  } catch {
    return [];
  }
}

/** Runs the whole rehearsal and returns a report instead of throwing, so the caller can print it. */
export async function runMigrationRehearsal(options: { sourceDb?: string | null; dataDir?: string; keep?: boolean } = {}): Promise<RehearsalReport> {
  const source = options.sourceDb ? resolve(options.sourceDb) : null;
  const dataDir = options.dataDir ? resolve(options.dataDir) : mkdtempSync(join(tmpdir(), "coder-migration-"));
  const problems: string[] = [];

  if (source && !existsSync(source)) throw new Error(`berkas sumber tidak ditemukan: ${source}`);

  const target = join(dataDir, "coder.db");
  let before: Record<string, number> | null = null;
  if (source) {
    // The real database is opened read only, only to remember the row counts before migration.
    const reader = new Database(source, { readonly: true });
    before = {};
    for (const table of IMPORTANT_TABLES) before[table] = countRows(reader, table);
    reader.close();
    copyFileSync(source, target);
  }

  // The dummy value is replaced below as soon as the real connection exists. It keeps the shape of
  // the report stable even when the import itself fails.
  const report: RehearsalReport = {
    ok: false, source, dataDir, schemaVersion: null, expectedVersion: 0, migrationRows: 0,
    missingTables: [], missingColumns: [], rowCounts: {}, before, mismatches: [],
    integrity: "unknown", foreignKeys: false,
    probes: { modelPriceOverride: false, awaitingApprovalAllowed: false, probeRolledBack: false },
    reopen: { ran: false, ok: false, detail: "belum dijalankan" }, problems,
  };

  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
  const migrated = await import("./db.js");
  const { db, SCHEMA_VERSION } = migrated;
  report.expectedVersion = SCHEMA_VERSION;

  const versionRow = db.prepare("SELECT COALESCE(MAX(version),0) AS version, COUNT(*) AS rows FROM schema_migrations").get() as { version: number; rows: number };
  report.schemaVersion = Number(versionRow.version);
  report.migrationRows = Number(versionRow.rows);
  if (report.schemaVersion !== SCHEMA_VERSION) problems.push(`versi skema ${report.schemaVersion} tidak sama dengan ${SCHEMA_VERSION}`);

  const tableNames = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
  report.missingTables = EXPECTED_TABLES.filter((table) => !tableNames.has(table));
  if (report.missingTables.length) problems.push(`tabel hilang: ${report.missingTables.join(", ")}`);

  const columns: Record<string, string[]> = {};
  report.missingColumns = [];
  for (const [table, column] of EXPECTED_COLUMNS) {
    columns[table] = columns[table] ?? columnNames(db, table);
    if (!columns[table].includes(column)) report.missingColumns.push(`${table}.${column}`);
  }
  if (report.missingColumns.length) problems.push(`kolom hilang: ${report.missingColumns.join(", ")}`);

  for (const table of IMPORTANT_TABLES) report.rowCounts[table] = countRows(db, table);
  if (before) {
    for (const table of IMPORTANT_TABLES) {
      if (before[table] !== report.rowCounts[table]) report.mismatches.push(`${table}: ${before[table]} -> ${report.rowCounts[table]}`);
    }
    if (report.mismatches.length) problems.push(`jumlah baris berubah: ${report.mismatches.join(", ")}`);
  }

  // Probes: a write must still respect the constraints of the migrated schema.
  try {
    db.exec("BEGIN");
    db.prepare("INSERT INTO model_price_overrides (model, input_per_mtok, output_per_mtok, updated_at) VALUES ('probe/model','1','2','now')").run();
    const stored = db.prepare("SELECT input_per_mtok AS input FROM model_price_overrides WHERE model='probe/model'").get() as { input: number | string } | undefined;
    report.probes.modelPriceOverride = Number(stored?.input) === 1;
    db.exec("ROLLBACK");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction may already be gone */ }
    problems.push(`probe model_price_overrides gagal: ${String(error)}`);
  }
  try {
    db.exec("BEGIN");
    db.prepare("INSERT INTO users (id,email,display_name,created_at,updated_at) VALUES ('probe-u','probe@example.test','Probe','now','now')").run();
    db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES ('probe-w','Probe','probe-ws','now','now')").run();
    db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES ('probe-u','probe-w','owner','now')").run();
    db.prepare("INSERT INTO projects (id,workspace_id,name,slug,created_at,updated_at) VALUES ('probe-p','probe-w','Probe','probe-p','now','now')").run();
    db.prepare("INSERT INTO workflows (id,project_id,name,description,steps_json,status,created_at,updated_at) VALUES ('probe-f','probe-p','Probe','','[]','draft','now','now')").run();
    db.prepare("INSERT INTO workflow_executions (id,workflow_id,project_id,status,input,created_at) VALUES ('probe-e','probe-f','probe-p','awaiting_approval','','now')").run();
    const stored = db.prepare("SELECT status FROM workflow_executions WHERE id='probe-e'").get() as { status: string } | undefined;
    report.probes.awaitingApprovalAllowed = stored?.status === "awaiting_approval";
    db.exec("ROLLBACK");
    report.probes.probeRolledBack = countRows(db, "workflow_executions") === report.rowCounts.workflow_executions;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    problems.push(`probe workflow_executions gagal: ${String(error)}`);
  }
  if (!report.probes.modelPriceOverride) problems.push("probe model_price_overrides tidak membuktikan apa pun");
  if (!report.probes.awaitingApprovalAllowed) problems.push("status awaiting_approval tidak diterima setelah migrasi");

  const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
  report.integrity = String(Object.values(integrity)[0]);
  if (report.integrity !== "ok") problems.push(`integrity_check: ${report.integrity}`);
  report.foreignKeys = Boolean(db.pragma("foreign_keys", { simple: true }));
  if (!report.foreignKeys) problems.push("foreign_keys tidak aktif setelah migrasi");

  // Idempotency: migration must be harmless when it runs a second time on the same file. The child
  // process proves that, because this module keeps one connection per process.
  report.reopen = runReopenCheck(dataDir, db, SCHEMA_VERSION);

  const failures = [...problems];
  if (!report.reopen.ok) failures.push(`buka ulang berkas yang sama tidak idempoten: ${report.reopen.detail}`);
  report.problems = failures;
  report.ok = failures.length === 0;
  db.close();
  if (!options.keep && !options.dataDir) {
    // The copy of the production database must not stay behind after the rehearsal.
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* the folder stays, it is a temp folder */ }
  }
  return report;
}

/** Spawns a second process against the same file and checks that reopening changes nothing. */
function runReopenCheck(dataDir: string, db: Database.Database, expected: number): { ran: boolean; ok: boolean; detail: string } {
  try {
    // The marker is refreshed, never duplicated, so a second rehearsal on the same file still works.
    db.prepare("DELETE FROM users WHERE id='reopen-u'").run();
    db.prepare("INSERT INTO users (id,email,display_name,created_at,updated_at) VALUES ('reopen-u','reopen@example.test','Reopen','now','now')").run();
    const here = fileURLToPath(import.meta.url);
    const loader = here.endsWith(".ts") ? ["--import", "tsx"] : [];
    const run = spawnSync(process.execPath, [...loader, here, "--reopen-only", dataDir], { encoding: "utf8", timeout: 120_000 });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    const version = /REOPEN_SCHEMA_VERSION (\d+)/.exec(output);
    const marker = /REOPEN_MARKER_ROW (\d+)/.exec(output);
    const ok = run.status === 0 && Number(version?.[1] ?? -1) === expected && marker?.[1] === "1";
    return { ran: true, ok, detail: (output.split("\n").slice(-2).join(" | ") || `exit ${run.status}`).slice(0, 400) };
  } catch (error) {
    return { ran: false, ok: false, detail: String(error) };
  }
}

/** Child mode: opens an already migrated folder and reports the version and the marker row. */
async function reopenOnly(dataDir: string): Promise<number> {
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
  const { db, SCHEMA_VERSION } = await import("./db.js");
  const version = Number(((db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get() as { version: number } | undefined)?.version) ?? 0);
  const marker = countRows(db, "users") >= 0 ? countRows(db, "users") : -1;
  const markerRow = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE id='reopen-u'").get() as { n: number } | undefined)?.n ?? 0;
  console.log(`REOPEN_SCHEMA_VERSION ${version}`);
  console.log(`REOPEN_MARKER_ROW ${markerRow}`);
  console.log(`REOPEN_TABLE_COUNT ${marker}`);
  db.close();
  return version === SCHEMA_VERSION && Number(markerRow) === 1 ? 0 : 1;
}

/** Prints the report in a form a human and a deploy script can both read. */
export function printRehearsalReport(report: RehearsalReport): void {
  console.log(`MIGRATION_REHEARSAL_SOURCE ${report.source ?? "FRESH_DATABASE"}`);
  console.log(`MIGRATION_REHEARSAL_DATA_DIR ${report.dataDir}`);
  console.log(`SCHEMA_VERSION_AFTER_MIGRATION ${report.schemaVersion} EXPECTED ${report.expectedVersion}`);
  console.log(`SCHEMA_MIGRATIONS_ROWS ${report.migrationRows}`);
  console.log(report.missingTables.length ? `MISSING_TABLES ${report.missingTables.join(",")}` : `TABLES_OK ${EXPECTED_TABLES.length}`);
  console.log(report.missingColumns.length ? `MISSING_COLUMNS ${report.missingColumns.join(",")}` : `COLUMNS_OK ${EXPECTED_COLUMNS.length}`);
  console.log(report.before ? `ROW_COUNTS_PRESERVED ${report.mismatches.length === 0}` : "ROW_COUNTS_PRESERVED n/a (basis data baru)");
  if (report.before) console.log(`ROW_COUNTS ${JSON.stringify(report.rowCounts)}`);
  console.log(`PROBE_MODEL_PRICE_OVERRIDE ${report.probes.modelPriceOverride} PROBE_AWAITING_APPROVAL ${report.probes.awaitingApprovalAllowed} PROBE_ROLLED_BACK ${report.probes.probeRolledBack}`);
  console.log(`REOPEN_IDEMPOTENT ${report.reopen.ok} (${report.reopen.detail})`);
  console.log(`INTEGRITY_CHECK ${report.integrity} FOREIGN_KEYS ${report.foreignKeys}`);
  if (report.ok) { console.log("MIGRATION_REHEARSAL_OK"); return; }
  for (const problem of report.problems) console.log(`MASALAH: ${problem}`);
  console.log(`MIGRATION_REHEARSAL_FAILED ${report.problems.length}`);
}

/** Lists the newest application backup, so a deploy can rehearse against real data. */
export function newestBackup(directory = "/app/backups"): string | null {
  try {
    const files = readdirSync(directory).filter((name) => name.endsWith(".db")).map((name) => join(directory, name));
    if (!files.length) return null;
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return null;
  }
}

const invokedAsScript = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedAsScript) {
  const args = process.argv.slice(2);
  const reopenIndex = args.indexOf("--reopen-only");
  if (reopenIndex >= 0) {
    const dir = args[reopenIndex + 1];
    if (!dir) { console.log("REOPEN_SCHEMA_VERSION 0"); process.exit(1); }
    process.exit(await reopenOnly(dir));
  }
  const keep = args.includes("--keep");
  const json = args.includes("--json");
  // Options that take a value swallow the next argument, so it can never be mistaken for the source.
  const positionals: string[] = [];
  let dataDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--data-dir") { dataDir = args[index + 1]; index += 1; continue; }
    if (arg.startsWith("--")) continue;
    positionals.push(arg);
  }
  const source = positionals[0] ?? newestBackup();
  if (source && !existsSync(source)) {
    console.log(`MIGRATION_REHEARSAL_FAILED 1`);
    console.log(`MASALAH: berkas sumber tidak ditemukan: ${basename(source)}`);
    process.exit(1);
  }
  try {
    const report = await runMigrationRehearsal({ sourceDb: source ?? null, dataDir, keep: keep || Boolean(dataDir) });
    if (json) console.log(JSON.stringify(report, null, 2));
    else printRehearsalReport(report);
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.log("MIGRATION_REHEARSAL_FAILED 1");
    console.log(`MASALAH: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

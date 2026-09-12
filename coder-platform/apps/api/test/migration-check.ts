
/* Migration check on a copy of the production database. */
import Database from "better-sqlite3";
const file = process.argv[2];
const db = new Database(file, { readonly: true });
const tables = ["users", "workspaces", "memberships", "projects", "conversations", "messages", "runs", "run_events", "artifacts", "knowledge_documents", "workflows", "workflow_executions"];
const before: Record<string, number> = {};
for (const table of tables) { try { before[table] = (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as any).total; } catch { before[table] = -1; } }
db.close();
process.env.DATA_DIR = process.argv[3];
const migrated = await import("../src/db.js");
const after: Record<string, number> = {};
for (const table of tables) { try { after[table] = (migrated.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as any).total; } catch { after[table] = -1; } }
for (const table of tables) {
  if (before[table] !== after[table]) { console.log(`MISMATCH ${table}: ${before[table]} -> ${after[table]}`); process.exit(1); }
}
console.log("ROW_COUNTS_PRESERVED", JSON.stringify(after));
const schema = (migrated.db.prepare("SELECT sql FROM sqlite_master WHERE name='workflow_executions'").get() as any).sql as string;
console.log("STATUS_CHECK_ALLOWS_AWAITING_APPROVAL", schema.includes("awaiting_approval"));
try {
  migrated.db.exec("BEGIN");
  migrated.db.prepare("INSERT INTO users (id,email,display_name,created_at,updated_at) VALUES ('probe-u','probe@example.test','Probe','now','now')").run();
  migrated.db.prepare("INSERT INTO workspaces (id,name,slug,created_at,updated_at) VALUES ('probe-w','Probe','probe-ws','now','now')").run();
  migrated.db.prepare("INSERT INTO memberships (user_id,workspace_id,role,created_at) VALUES ('probe-u','probe-w','owner','now')").run();
  migrated.db.prepare("INSERT INTO projects (id,workspace_id,name,slug,created_at,updated_at) VALUES ('probe-p','probe-w','Probe','probe-p','now','now')").run();
  migrated.db.prepare("INSERT INTO workflows (id,project_id,name,description,steps_json,status,created_at,updated_at) VALUES ('probe-f','probe-p','Probe','','[]','draft','now','now')").run();
  migrated.db.prepare("INSERT INTO workflow_executions (id,workflow_id,project_id,status,input,created_at) VALUES ('probe-e','probe-f','probe-p','awaiting_approval','','now')").run();
  const stored = migrated.db.prepare("SELECT status FROM workflow_executions WHERE id='probe-e'").get() as any;
  console.log("INSERT_AWAITING_APPROVAL_ALLOWED", stored?.status === "awaiting_approval");
} catch (error) {
  console.log("INSERT_AWAITING_APPROVAL_ALLOWED false", String(error));
} finally {
  migrated.db.exec("ROLLBACK");
  const leftovers = (migrated.db.prepare("SELECT COUNT(*) AS total FROM workflow_executions").get() as any).total;
  console.log("PROBE_ROLLED_BACK", leftovers === (after.workflow_executions ?? 0));
}
const integrity = migrated.db.prepare("PRAGMA integrity_check").get() as any;
console.log("INTEGRITY_CHECK", Object.values(integrity)[0]);
console.log("FOREIGN_KEYS_AFTER_MIGRATION", migrated.db.pragma("foreign_keys", { simple: true }));
process.exit(0);

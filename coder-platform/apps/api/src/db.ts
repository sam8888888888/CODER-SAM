import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";

const dbPath = resolve(config.DATA_DIR, "coder.db");
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_recovery_codes TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 last_seen_at TEXT, user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
 created_at TEXT NOT NULL, PRIMARY KEY(user_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id, slug)
);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')), content TEXT NOT NULL, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_project_updated ON conversations(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
 prompt TEXT NOT NULL, result TEXT, error_code TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_executions (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')), input TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_execution_steps (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
 step_index INTEGER NOT NULL, step_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL,
 input TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', error TEXT,
 started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_steps_execution ON workflow_execution_steps(execution_id, step_index);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id, created_at DESC);
CREATE TABLE IF NOT EXISTS workspace_invitations (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON workspace_invitations(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS workflows (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', steps_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published')) DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_project_updated ON workflows(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS knowledge_documents (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('text','artifact')), content TEXT NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(title, content, document_id UNINDEXED);
CREATE INDEX IF NOT EXISTS idx_knowledge_project_updated ON knowledge_documents(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS run_usage (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 model TEXT, provider TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER,
 cost_micros INTEGER, estimated INTEGER NOT NULL DEFAULT 0, raw_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_usage_project ON run_usage(project_id, created_at DESC);

/* Playground and other ad-hoc engine calls have no project, so run_usage cannot hold them
   (its project_id is NOT NULL). Their tokens are recorded per user here, and quota counts both tables. */
CREATE TABLE IF NOT EXISTS user_usage (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, run_id TEXT,
 source TEXT NOT NULL DEFAULT 'playground', model TEXT, provider TEXT,
 input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER NOT NULL,
 cost_micros INTEGER, estimated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_usage_user ON user_usage(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_path TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_created ON artifacts(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
 actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_runs_project_created ON runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_created ON audit_events(workspace_id, created_at DESC);
`);

// Additive migration for workflow human approval without touching existing data.
try { db.exec("ALTER TABLE workflow_executions ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'not_required'"); } catch {}
try { db.exec("ALTER TABLE workflow_executions ADD COLUMN approved_by TEXT"); } catch {}
// Additive migration for the workflow engine (step runner, cancel, retry, schedule).
for (const statement of [
  "ALTER TABLE workflow_executions ADD COLUMN current_step INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE workflow_executions ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE workflow_executions ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE workflow_executions ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE workflows ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE workflows ADD COLUMN schedule_interval_minutes INTEGER",
  "ALTER TABLE workflows ADD COLUMN next_run_at TEXT",
  "ALTER TABLE workflows ADD COLUMN last_run_at TEXT",
]) { try { db.exec(statement); } catch { /* column already exists */ } }

/**
 * Rebuilds workflow_executions so the status CHECK also allows awaiting_approval and scheduled.
 * SQLite cannot change a CHECK constraint in place. Existing rows are copied, then verified.
 */
function migrateExecutionStatuses() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_executions'").get() as { sql: string } | undefined;
  if (!table || table.sql.includes("awaiting_approval")) return;
  const before = (db.prepare("SELECT COUNT(*) AS total FROM workflow_executions").get() as { total: number }).total;
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
BEGIN;
CREATE TABLE workflow_executions_new (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_approval','scheduled','completed','failed','cancelled')),
 input TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', error TEXT,
 started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
 approval_status TEXT NOT NULL DEFAULT 'not_required', approved_by TEXT,
 current_step INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
 context_json TEXT NOT NULL DEFAULT '{}', attempt INTEGER NOT NULL DEFAULT 1
);
INSERT INTO workflow_executions_new (id,workflow_id,project_id,status,input,output,error,started_at,finished_at,created_at,approval_status,approved_by,current_step,cancel_requested,context_json,attempt)
 SELECT id,workflow_id,project_id,status,input,output,error,started_at,finished_at,created_at,approval_status,approved_by,current_step,cancel_requested,context_json,attempt FROM workflow_executions;
DROP TABLE workflow_executions;
ALTER TABLE workflow_executions_new RENAME TO workflow_executions;
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id, created_at DESC);
COMMIT;
`);
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const after = (db.prepare("SELECT COUNT(*) AS total FROM workflow_executions").get() as { total: number }).total;
  if (after !== before) throw new Error(`WORKFLOW_EXECUTION_MIGRATION_LOST_ROWS:${before}->${after}`);
}
migrateExecutionStatuses();


/** Rebuilds knowledge_documents so extracted document kinds (pdf, docx) are allowed as source types. */
function migrateKnowledgeSourceTypes() {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_documents'").get() as { sql: string } | undefined;
  if (!table || table.sql.includes("docx")) return;
  const before = (db.prepare("SELECT COUNT(*) AS total FROM knowledge_documents").get() as { total: number }).total;
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
BEGIN;
CREATE TABLE knowledge_documents_new (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL,
 source_type TEXT NOT NULL CHECK(source_type IN ('text','artifact','pdf','docx','url')), content TEXT NOT NULL,
 checksum TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, filename TEXT, chunk_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO knowledge_documents_new (id,project_id,title,source_type,content,checksum,created_at,updated_at,filename,chunk_count)
 SELECT id,project_id,title,source_type,content,checksum,created_at,updated_at,filename,chunk_count FROM knowledge_documents;
DROP TABLE knowledge_documents;
ALTER TABLE knowledge_documents_new RENAME TO knowledge_documents;
CREATE INDEX IF NOT EXISTS idx_knowledge_project_updated ON knowledge_documents(project_id, updated_at DESC);
COMMIT;
`);
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const after = (db.prepare("SELECT COUNT(*) AS total FROM knowledge_documents").get() as { total: number }).total;
  if (after !== before) throw new Error(`KNOWLEDGE_MIGRATION_LOST_ROWS:${before}->${after}`);
}

// Knowledge chunks give search and prompt context a stable granularity.
db.exec(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(content, chunk_id UNINDEXED, document_id UNINDEXED, project_id UNINDEXED, tokenize='porter');`);
try { db.exec("ALTER TABLE knowledge_documents ADD COLUMN filename TEXT"); } catch {}
try { db.exec("ALTER TABLE knowledge_documents ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE run_usage ADD COLUMN cache_read_tokens INTEGER"); } catch {}
try { db.exec("ALTER TABLE run_usage ADD COLUMN cache_write_tokens INTEGER"); } catch {}
try { db.exec("ALTER TABLE run_usage ADD COLUMN total_tokens INTEGER"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN model TEXT"); } catch {}
try { db.exec("ALTER TABLE auth_sessions ADD COLUMN last_seen_at TEXT"); } catch {}
try { db.exec("ALTER TABLE auth_sessions ADD COLUMN user_agent TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN mfa_secret TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN mfa_recovery_codes TEXT"); } catch {}

// Account recovery, notifications, platform administration and per-workspace guards.
db.exec(`
CREATE TABLE IF NOT EXISTS auth_tokens (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('password_reset','email_verify')),
 token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, read_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY, note TEXT, applied_at TEXT NOT NULL
);
`);
try { db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN daily_cost_limit_micros INTEGER"); } catch {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN monthly_cost_limit_micros INTEGER"); } catch {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN runs_per_hour_limit INTEGER"); } catch {}

// Cron schedules live next to the interval schedules so one workflow can use either shape.
try { db.exec("ALTER TABLE workflows ADD COLUMN schedule_cron TEXT"); } catch {}

// Commerce: plans, orders, coupons, subscriptions, credit, quota, bank accounts and payment records.
// Money is stored in whole rupiah (IDR) and tokens are whole numbers, so no floating point is involved.
db.exec(`
CREATE TABLE IF NOT EXISTS platform_settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
 code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 price_idr INTEGER NOT NULL DEFAULT 0, period_days INTEGER NOT NULL DEFAULT 30, tier TEXT NOT NULL,
 daily_token_limit INTEGER NOT NULL DEFAULT 0, monthly_token_limit INTEGER NOT NULL DEFAULT 0,
 bonus_tokens INTEGER NOT NULL DEFAULT 0, features_json TEXT NOT NULL DEFAULT '[]',
 sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 plan_code TEXT NOT NULL, months INTEGER NOT NULL DEFAULT 1,
 amount_idr INTEGER NOT NULL DEFAULT 0, discount_idr INTEGER NOT NULL DEFAULT 0, total_idr INTEGER NOT NULL DEFAULT 0,
 coupon_code TEXT, method TEXT NOT NULL DEFAULT 'manual',
 status TEXT NOT NULL CHECK(status IN ('pending','paid','rejected','cancelled')) DEFAULT 'pending',
 note TEXT NOT NULL DEFAULT '', proof_artifact_id TEXT, decided_by TEXT, decided_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE TABLE IF NOT EXISTS coupons (
 code TEXT PRIMARY KEY, percent INTEGER NOT NULL DEFAULT 0, amount_idr INTEGER NOT NULL DEFAULT 0,
 max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 plan_code TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','expired','cancelled')) DEFAULT 'active',
 started_at TEXT NOT NULL, expires_at TEXT NOT NULL, order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status, expires_at DESC);
CREATE TABLE IF NOT EXISTS credit_ledger (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tokens INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS token_quotas (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 tier TEXT NOT NULL DEFAULT 'free', day_key TEXT NOT NULL DEFAULT '', day_tokens INTEGER NOT NULL DEFAULT 0,
 month_key TEXT NOT NULL DEFAULT '', month_tokens INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_accounts (
 id TEXT PRIMARY KEY, bank_name TEXT NOT NULL, account_number TEXT NOT NULL, account_holder TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id) ON DELETE SET NULL, user_id TEXT,
 provider TEXT NOT NULL, provider_ref TEXT, amount_idr INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
 raw_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, created_at DESC);
`);
try { db.exec("ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'"); } catch {}
// time stamp resets the quota counter without deleting usage history.
try { db.exec("ALTER TABLE token_quotas ADD COLUMN reset_at TEXT"); } catch {}

// Files a user attached to a chat message. The bytes live on disk under DATA_DIR/attachments.
db.exec(`
CREATE TABLE IF NOT EXISTS message_attachments (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 name TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0,
 storage_path TEXT NOT NULL, extracted_chars INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id, created_at);
`);

// Wave 3: agent workspace. The memory bank, prompt templates, personas and the
// token saver settings belong to a user; workspace_id is optional sharing.
db.exec(`
CREATE TABLE IF NOT EXISTS agent_memories (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT,
 title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
 pinned INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, use_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_user ON agent_memories(user_id, pinned DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS prompt_templates (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT,
 name TEXT NOT NULL, body TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 slash TEXT, tags TEXT NOT NULL DEFAULT '', use_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_user ON prompt_templates(user_id, name);

CREATE TABLE IF NOT EXISTS agent_personas (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT,
 name TEXT NOT NULL, system_prompt TEXT NOT NULL, tone TEXT NOT NULL DEFAULT '',
 language TEXT NOT NULL DEFAULT 'id', model TEXT, thinking_level TEXT NOT NULL DEFAULT 'medium',
 is_default INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_personas_user ON agent_personas(user_id, is_default DESC, name);

CREATE TABLE IF NOT EXISTS agent_settings (
 user_id TEXT PRIMARY KEY,
 thinking_level TEXT NOT NULL DEFAULT 'medium',
 auto_compact INTEGER NOT NULL DEFAULT 1,
 compact_after_messages INTEGER NOT NULL DEFAULT 24,
 tools_allow TEXT NOT NULL DEFAULT '',
 autonomous_default INTEGER NOT NULL DEFAULT 0,
 autonomous_max_turns INTEGER NOT NULL DEFAULT 6,
 autonomous_max_tokens INTEGER NOT NULL DEFAULT 40000,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 summary TEXT NOT NULL, messages_covered INTEGER NOT NULL DEFAULT 0,
 chars_before INTEGER NOT NULL DEFAULT 0, chars_after INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conversation ON conversation_summaries(conversation_id, created_at DESC);

/* Wave 4: open platform and compliance. API keys are stored as a hash only, never as plain text. */
CREATE TABLE IF NOT EXISTS api_keys (
 id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
 scopes TEXT NOT NULL DEFAULT 'read', created_at TEXT NOT NULL, last_used_at TEXT,
 revoked_at TEXT, request_count INTEGER NOT NULL DEFAULT 0, last_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, created_at DESC);

/* Per user switch for outgoing email. In-app notifications ignore these switches on purpose. */
CREATE TABLE IF NOT EXISTS notification_prefs (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 email_quota INTEGER NOT NULL DEFAULT 1, email_runs INTEGER NOT NULL DEFAULT 1, email_billing INTEGER NOT NULL DEFAULT 1,
 email_team INTEGER NOT NULL DEFAULT 1, email_security INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);

/* Outgoing email is queued first, so tests and operators can inspect it without sending anything. */
CREATE TABLE IF NOT EXISTS email_outbox (
 id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, to_email TEXT NOT NULL,
 kind TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, dedupe_key TEXT,
 created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedupe ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;

/* A personal data export is a file on disk plus this row. Rows expire, the file is deleted later. */
CREATE TABLE IF NOT EXISTS data_exports (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','expired','deleted')),
 size_bytes INTEGER NOT NULL DEFAULT 0, storage_path TEXT NOT NULL, sections TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_exports_user ON data_exports(user_id, created_at DESC);
`);
/** Wave 3 columns: an engine session can rotate (compaction), and a conversation can hold a persona. */
try { db.exec("ALTER TABLE conversations ADD COLUMN engine_session_id TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN persona_id TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN compacted_at TEXT"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN thinking_level TEXT"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN persona_id TEXT"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN prompt_chars INTEGER"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN append_system_chars INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN default_persona_id TEXT"); } catch {}

/** Records the applied schema version so operators can see which shape the database has. */
const SCHEMA_VERSION = 12;
export const SCHEMA_VERSION_NOTE = "API keys, email outbox and notification preferences, personal data exports, on top of the agent workspace tables";
db.prepare("INSERT OR IGNORE INTO schema_migrations (version, note, applied_at) VALUES (?,?,?)").run(SCHEMA_VERSION, SCHEMA_VERSION_NOTE, new Date().toISOString());

// Runs after the additive columns exist, because it copies them.
migrateKnowledgeSourceTypes();


export function closeDatabase() { db.close(); }

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
// Wave 9: the billed amount is stored next to the real upstream cost, so a markup can be applied
// without ever rewriting what the platform really paid.
try { db.exec("ALTER TABLE run_usage ADD COLUMN sell_cost_micros INTEGER"); } catch {}
try { db.exec("ALTER TABLE user_usage ADD COLUMN sell_cost_micros INTEGER"); } catch {}
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
/* Wave 5: durable background work. One row per job, with a lease so a dead process cannot keep it. */
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
 payload TEXT NOT NULL DEFAULT '{}', result TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
 run_after TEXT NOT NULL, lock_owner TEXT, lock_expires_at TEXT, last_error TEXT, dedupe_key TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, run_after ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs(kind, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;

/* Wave 6: outgoing webhooks. The secret is shown once at creation; deliveries keep their own row so an
   operator can see what was sent, what came back, and why a delivery is still waiting. */
CREATE TABLE IF NOT EXISTS webhooks (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT 'run.completed',
 active INTEGER NOT NULL DEFAULT 1, description TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_delivery_at TEXT, last_status TEXT, failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webhooks_workspace ON webhooks(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
 id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
 event TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','delivered','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, response_status INTEGER, last_error TEXT, duration_ms INTEGER,
 job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status, created_at DESC);
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
/** Wave 6 columns: a public write call is charged to the key that made it, and each key can have its own
    daily ceiling. 0 means "no key-specific ceiling": the account tier still applies. */
try { db.exec("ALTER TABLE runs ADD COLUMN api_key_id TEXT"); } catch {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN daily_request_limit INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN daily_token_limit INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN requests_today INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN usage_day TEXT"); } catch {}

/* Wave 7: growth. Referral codes, referral rows, and a small event log so the funnel can be measured.
   Nothing here changes existing tables; every row is additive. */
db.exec(`
CREATE TABLE IF NOT EXISTS referral_codes (
 code TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id);
CREATE TABLE IF NOT EXISTS referrals (
 id TEXT PRIMARY KEY, code TEXT NOT NULL, inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 invitee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 invitee_email TEXT, invitee_ip TEXT, inviter_ip TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','qualified','rewarded','blocked')), blocked_reason TEXT,
 inviter_tokens INTEGER NOT NULL DEFAULT 0, invitee_tokens INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, qualified_at TEXT, rewarded_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_invitee ON referrals(invitee_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals(inviter_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS growth_events (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, workspace_id TEXT,
 props TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_growth_events_name ON growth_events(name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_user ON growth_events(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS onboarding_state (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 dismissed_at TEXT, updated_at TEXT NOT NULL
);
`);

/** Wave 7 columns: the registration IP is kept so a referral can spot a self-made account. */
try { db.exec("ALTER TABLE users ADD COLUMN signup_ip TEXT"); } catch {}

/** Wave 8 columns: an account is closed in two steps, so the row stays until the purge date. */
try { db.exec("ALTER TABLE users ADD COLUMN deleted_at TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN purge_after TEXT"); } catch {}

/**
 * Wave 8: rate limit counters live in the database instead of process memory. A restart no
 * longer clears them, and several application replicas can share one counter. Each row is one
 * accepted hit, which keeps the sliding window behaviour of the previous in-memory version.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS rate_limit_hits (
 bucket TEXT NOT NULL, hit_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_bucket ON rate_limit_hits(bucket, hit_at);
`);
// Wave 9 (item 19): the owner can replace the published price of a model with the price really paid.
db.exec(`
CREATE TABLE IF NOT EXISTS model_price_overrides (
 model TEXT PRIMARY KEY,
 input_per_mtok REAL NOT NULL, output_per_mtok REAL NOT NULL,
 cache_read_per_mtok REAL NOT NULL DEFAULT 0, cache_write_per_mtok REAL NOT NULL DEFAULT 0,
 currency TEXT NOT NULL DEFAULT 'USD', updated_at TEXT NOT NULL, updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_price_overrides_updated ON model_price_overrides(updated_at DESC);
`);

/**
 * Wave 10 (items 23, 24, 25, 26, 29, 31): a strict order for webhook deliveries, a token
 * reservation for runs that are still in flight, the origin of every growth event, the devices an
 * account signs in from, a full text index over chat messages, and browser push subscriptions.
 */
try { db.exec("ALTER TABLE webhook_deliveries ADD COLUMN sequence INTEGER"); } catch {}
try { db.exec("ALTER TABLE webhook_deliveries ADD COLUMN resend_of TEXT"); } catch {}
// Wave 10 (item 23): how many times this row stepped aside for an earlier event. After the limit the
// row is sent anyway, out of order, and the reason is recorded on the row.
try { db.exec("ALTER TABLE webhook_deliveries ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN reserved_tokens INTEGER"); } catch {}
try { db.exec("ALTER TABLE growth_events ADD COLUMN source TEXT NOT NULL DEFAULT 'live'"); } catch {}
try { db.exec("ALTER TABLE auth_sessions ADD COLUMN device_id TEXT"); } catch {}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_order ON webhook_deliveries(webhook_id, sequence);
CREATE TABLE IF NOT EXISTS user_devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', platform TEXT, user_agent TEXT,
  first_ip TEXT, last_ip TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1, trusted INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, blocked_at TEXT, blocked_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_fingerprint ON user_devices(user_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_user_devices_seen ON user_devices(user_id, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_success_at TEXT, last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id, active);
`);
// Wave 10 item 29: chat messages get a full text index, so the global search can rank its hits.
// Triggers keep the index in step with the table; other writers need no change.
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(content, message_id UNINDEXED, conversation_id UNINDEXED, project_id UNINDEXED, tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_search(content, message_id, conversation_id, project_id)
  VALUES (new.content, new.id, new.conversation_id, (SELECT project_id FROM conversations WHERE id = new.conversation_id));
END;
CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_search WHERE message_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM message_search WHERE message_id = old.id;
  INSERT INTO message_search(content, message_id, conversation_id, project_id)
  VALUES (new.content, new.id, new.conversation_id, (SELECT project_id FROM conversations WHERE id = new.conversation_id));
END;
`);
// One pass over the rows that existed before the index; later rows arrive through the triggers.
const indexedMessages = Number((db.prepare("SELECT COUNT(*) AS n FROM message_search").get() as { n: number }).n);
if (indexedMessages === 0) {
  const rows = db.prepare("SELECT m.id AS id, m.content AS content, m.conversation_id AS conversationId, c.project_id AS projectId FROM messages m JOIN conversations c ON c.id = m.conversation_id").all() as { id: string; content: string; conversationId: string; projectId: string }[];
  const insertIndex = db.prepare("INSERT INTO message_search(content, message_id, conversation_id, project_id) VALUES (?,?,?,?)");
  db.transaction(() => { for (const row of rows) insertIndex.run(row.content, row.id, row.conversationId, row.projectId); })();
}

/**
 * Wave 10 (item 26): the email link that confirms a new device needs its own token kind, and SQLite
 * cannot widen a CHECK constraint in place, so the token table is rebuilt once. The rows are copied
 * over unchanged, and the rebuild happens only while the old constraint is still in the schema.
 */
const authTokenDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_tokens'").get() as { sql: string } | undefined)?.sql ?? "";
if (authTokenDdl && !authTokenDdl.includes("device_verify")) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens_new (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('password_reset','email_verify','device_verify')),
      token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO auth_tokens_new (id,user_id,kind,token_hash,expires_at,used_at,created_at)
      SELECT id,user_id,kind,token_hash,expires_at,used_at,created_at FROM auth_tokens;
    DROP TABLE auth_tokens;
    ALTER TABLE auth_tokens_new RENAME TO auth_tokens;
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);
  `);
}

/**
 * Wave 11A (butir 42-57, 79, 80): mode diskusi per percakapan, aturan keselamatan + guardrails,
 * revisi artefak, skill milik pengguna, pengetahuan platform, dan model cadangan.
 * Semua perubahan bersifat menambah: tidak ada kolom atau tabel lama yang diubah bentuknya.
 */
// Butir 42: satu percakapan boleh berada dalam mode diskusi. CHECK baru boleh ikut ALTER TABLE
// ADD COLUMN, dan SQLite tetap menegakkannya untuk baris baru maupun UPDATE.
try { db.exec("ALTER TABLE conversations ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'eksekusi' CHECK(agent_mode IN ('diskusi','eksekusi'))"); } catch {}
// Butir 57: daftar model cadangan (maks 3, berurutan) dan asal model saat perpindahan terjadi.
try { db.exec("ALTER TABLE agent_settings ADD COLUMN fallback_models TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN fallback_from TEXT"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN fallback_count INTEGER NOT NULL DEFAULT 0"); } catch {}
db.exec(`
CREATE TABLE IF NOT EXISTS guardrail_rules (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL DEFAULT 'larangan', title TEXT NOT NULL, body TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guardrail_rules_user ON guardrail_rules(user_id, enabled, sort_order, updated_at DESC);
CREATE TABLE IF NOT EXISTS safety_events (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT, rule_id TEXT, pattern TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safety_events_user ON safety_events(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS artifact_revisions (
 id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 revision_number INTEGER NOT NULL, content TEXT NOT NULL DEFAULT '', size_bytes INTEGER NOT NULL DEFAULT 0,
 checksum TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_revisions_number ON artifact_revisions(artifact_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_artifact_revisions_created ON artifact_revisions(artifact_id, created_at DESC);
CREATE TABLE IF NOT EXISTS user_skills (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, use_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_skills_name ON user_skills(user_id, name);
CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id, enabled, updated_at DESC);
CREATE TABLE IF NOT EXISTS platform_knowledge (
 id TEXT PRIMARY KEY, section TEXT NOT NULL CHECK(section IN ('umum','whitelabel')),
 title TEXT NOT NULL, content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 sort_order INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_knowledge_section ON platform_knowledge(section, enabled, sort_order);
CREATE TABLE IF NOT EXISTS user_secrets (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', secret_ciphertext TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_secrets_name ON user_secrets(user_id, name);
`);


/**
 * Wave 11B (butir 58-67, 83, plus butir 72 yang ditarik lebih awal karena 83 memprasyaratkannya):
 * dewan juri, shadow-first rollout, learnings registry, benchmark, laporan galat, dan jadwal prompt.
 * Semua perubahan bersifat menambah: tidak ada kolom atau tabel lama yang diubah bentuknya.
 */
// Butir 60: pelajaran yang dipakai ulang disimpan di tabel memori yang sudah ada, dibedakan oleh kind.
try { db.exec("ALTER TABLE agent_memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'memory' CHECK(kind IN ('memory','learning'))"); } catch {}
// Butir 63: run yang terputus ditandai supaya bisa dilanjutkan tanpa mengulang biaya dari nol.
try { db.exec("ALTER TABLE runs ADD COLUMN resume_state TEXT NOT NULL DEFAULT 'none'"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN resumed_from TEXT"); } catch {}
try { db.exec("ALTER TABLE runs ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0"); } catch {}
// Butir 72 (jadwal prompt) sebenarnya milik Wave 11C, tetapi ditarik ke sini karena butir 83 memprasyaratkannya.
db.exec(`
CREATE TABLE IF NOT EXISTS council_runs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id TEXT, conversation_id TEXT, material TEXT NOT NULL DEFAULT '',
 question TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','running','completed','failed')),
 summary TEXT NOT NULL DEFAULT '', cost_micros INTEGER NOT NULL DEFAULT 0,
 jurors TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_council_runs_user ON council_runs(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS council_verdicts (
 id TEXT PRIMARY KEY, council_run_id TEXT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
 juror TEXT NOT NULL, verdict TEXT NOT NULL DEFAULT '', score INTEGER, notes TEXT NOT NULL DEFAULT '',
 run_id TEXT, cost_micros INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_council_verdicts_juror ON council_verdicts(council_run_id, juror);
CREATE TABLE IF NOT EXISTS shadow_measurements (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT, kind TEXT NOT NULL, chars INTEGER NOT NULL DEFAULT 0, tokens_est INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_measurements_user ON shadow_measurements(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_measurements_run ON shadow_measurements(run_id);
CREATE TABLE IF NOT EXISTS benchmark_runs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 model_list TEXT NOT NULL DEFAULT '[]', question_count INTEGER NOT NULL DEFAULT 0,
 estimated_cost_micros INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_user ON benchmark_runs(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS benchmark_results (
 id TEXT PRIMARY KEY, benchmark_run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
 model TEXT NOT NULL, question_id TEXT NOT NULL DEFAULT '', question TEXT NOT NULL DEFAULT '',
 answer TEXT NOT NULL DEFAULT '', score INTEGER, latency_ms INTEGER, cost_micros INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_run ON benchmark_results(benchmark_run_id, model, question_id);
CREATE TABLE IF NOT EXISTS error_events (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'server', code TEXT NOT NULL DEFAULT '',
 message TEXT NOT NULL DEFAULT '', run_id TEXT, user_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_kind ON error_events(kind, created_at DESC);
CREATE TABLE IF NOT EXISTS prompt_schedules (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id TEXT, conversation_id TEXT, prompt TEXT NOT NULL, cron TEXT NOT NULL,
 timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta', model TEXT, thinking TEXT NOT NULL DEFAULT 'medium',
 autonomous INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
 last_run_at TEXT, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_schedules_user ON prompt_schedules(user_id, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_prompt_schedules_next ON prompt_schedules(enabled, next_run_at);
`);

/**
 * Wave 11C (butir 68-76, 78, 81, 82): integrasi & konektor, kanal bot + identitas, grup multi-agen,
 * nominal unik, kupon percobaan, avatar, dan versi mesin. Sama seperti gelombang sebelumnya, semua
 * perubahan bersifat menambah (ALTER TABLE ... ADD COLUMN atau CREATE TABLE IF NOT EXISTS).
 */
// Butir 73: grup multi-agen memakai percakapan yang sudah ada, dibedakan oleh kind.
try { db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'solo'"); } catch {}
db.exec(`
CREATE TABLE IF NOT EXISTS conversation_participants (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 persona_id TEXT, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_participants ON conversation_participants(conversation_id, created_at);
-- Butir 68: token integrasi pihak ketiga (Notion) disegel lewat secrets.ts; provider dipakai bersama.
CREATE TABLE IF NOT EXISTS user_integrations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_integrations_provider ON user_integrations(user_id, provider);
-- Butir 69/70/81: satu tabel untuk semua kanal bot; rahasia (token bot) disegel, bukan disimpan mentah.
CREATE TABLE IF NOT EXISTS bot_channels (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('telegram','whatsapp')),
 name TEXT NOT NULL DEFAULT '', config_ciphertext TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
 agent_name TEXT NOT NULL DEFAULT '', tagline TEXT NOT NULL DEFAULT '', webhook_secret TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_channels_provider ON bot_channels(provider, enabled);
-- Butir 81: satu external_id (chat_id) hanya boleh menempel pada satu akun; kode pemasangan sekali pakai.
CREATE TABLE IF NOT EXISTS bot_identities (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
 external_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 linked_at TEXT NOT NULL, code_hash TEXT NOT NULL DEFAULT '', code_expires_at TEXT, used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_identities_external ON bot_identities(channel_id, external_id);
CREATE INDEX IF NOT EXISTS idx_bot_identities_user ON bot_identities(user_id);
-- Butir 71: katalog konektor; status dilaporkan apa adanya (siap/aktif/dikembangkan/gagal).
CREATE TABLE IF NOT EXISTS connectors (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('slack','discord','mcp')), config_ciphertext TEXT NOT NULL DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'siap', last_error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connectors_user ON connectors(user_id, kind);
`);
// Butir 74: nominal unik hanya untuk transfer manual; gateway tetap memakai nominal persis.
try { db.exec("ALTER TABLE orders ADD COLUMN unique_amount_idr INTEGER"); } catch {}
// Butir 75: kupon percobaan ditandai supaya tidak diperpanjang diam-diam, dan paket sasarannya
// disimpan supaya kupon percobaan tidak bisa dipakai untuk paket lain.
try { db.exec("ALTER TABLE coupons ADD COLUMN trial INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE coupons ADD COLUMN trial_plan_code TEXT"); } catch {}
// Butir 76: berkas avatar disimpan di DATA_DIR/avatars, kolom hanya menyimpan nama berkas.
try { db.exec("ALTER TABLE users ADD COLUMN avatar_path TEXT"); } catch {}

/** Records the applied schema version so operators can see which shape the database has. */
export const SCHEMA_VERSION = 21;
export const SCHEMA_VERSION_NOTE = "Mode diskusi per percakapan, guardrails + kejadian keselamatan, revisi artefak, skill milik pengguna, pengetahuan platform, model cadangan, dewan juri, shadow measurement, benchmark, error events, jadwal prompt, penanda resume, kind memori/pelajaran, grup multi-agen, integrasi pihak ketiga, kanal bot + identitas terpaut, katalog konektor, nominal unik transfer manual, kupon percobaan + paket sasarannya, avatar pengguna";
db.prepare("INSERT OR IGNORE INTO schema_migrations (version, note, applied_at) VALUES (?,?,?)").run(SCHEMA_VERSION, SCHEMA_VERSION_NOTE, new Date().toISOString());

// Runs after the additive columns exist, because it copies them.
migrateKnowledgeSourceTypes();


export function closeDatabase() { db.close(); }

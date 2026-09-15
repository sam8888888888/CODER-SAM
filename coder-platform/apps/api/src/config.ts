import { z } from "zod";

const Env = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3400),
  DATA_DIR: z.string().default("./data"),
  PUBLIC_DIR: z.string().default("./public"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MOCK_ENGINE: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  PRIME_AGENT_BIN: z.string().optional(),
  ENGINE_ROOT_DIR: z.string().default("./data/engine-sessions"),
  // Optional model selector and provider passed to the engine CLI (documented flags --model / --provider).
  PRIME_AGENT_MODEL: z.string().optional(),
  PRIME_AGENT_PROVIDER: z.string().optional(),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(1800000),
  // Public base URL used in emails (verification and password reset links).
  PUBLIC_BASE_URL: z.string().default("https://coder.sam.university"),
  // Email delivery (SMTP). When these are missing, mail sending is reported as unavailable, never faked.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("COBLAI Coder <no-reply@coder.sam.university>"),
  SMTP_SECURE: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  // When true every state changing request must also echo the CSRF cookie in the x-csrf-token header.
  CSRF_STRICT: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  // Platform administrators may inspect every workspace. Comma separated email list, plus users with is_admin=1.
  PLATFORM_ADMIN_EMAILS: z.string().default(""),
  // Cost and speed guards. Zero means "no limit".
  DEFAULT_DAILY_COST_LIMIT_MICROS: z.coerce.number().int().min(0).default(0),
  DEFAULT_MONTHLY_COST_LIMIT_MICROS: z.coerce.number().int().min(0).default(0),
  DEFAULT_RUNS_PER_HOUR_LIMIT: z.coerce.number().int().min(0).default(0),
  // Prometheus metrics. The endpoint answers only when METRICS_TOKEN is set and matches.
  METRICS_TOKEN: z.string().optional(),
  // Payment gateways. Keys stay in the environment; the database only stores which gateway is on.
  XENDIT_SECRET_KEY: z.string().optional(),
  XENDIT_CALLBACK_TOKEN: z.string().optional(),
  MIDTRANS_SERVER_KEY: z.string().optional(),
  MIDTRANS_CLIENT_KEY: z.string().optional(),
  MIDTRANS_MERCHANT_ID: z.string().optional(),
  // Notification webhook used by the platform itself (admin alert channel). Optional.
  PLATFORM_WEBHOOK_URL: z.string().optional(),
  // Wave 4: outgoing email is queued in the database first. The worker only delivers when this flag is on,
  // so no message leaves the server until the owner asks for it.
  NOTIFY_EMAIL_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  // Public API keys (Bearer tokens). Zero disables the per-key request limit for one minute.
  API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(120),
  // Data retention. Deletion stays off until RETENTION_ENABLED is turned on, so reports can be reviewed first.
  RETENTION_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(1).default(365),
  RETENTION_NOTIFICATION_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_RUN_EVENT_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_EXPORT_DAYS: z.coerce.number().int().min(1).default(7),
  // Wave 5: background work runs from a durable queue in the database, so a restart never loses a job.
  // The lease is how long a worker may hold a job before another worker may take it over.
  JOB_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
  JOB_LEASE_MS: z.coerce.number().int().min(10000).default(1800000),
  JOB_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(10),
  // Abandoned runs and workflow executions are marked failed after this long. It must stay above the
  // engine timeout (ENGINE_TIMEOUT_MS), otherwise a healthy long run would be reported as lost.
  JOB_ORPHAN_AFTER_MS: z.coerce.number().int().min(60000).default(2700000),
  // At start-up the API owns no work yet, so a run still marked running must have been left by the
  // previous process. Single-process deployments can reap it after this grace period. Turn this off
  // if the API is ever started in more than one process at a time.
  JOB_REAP_ON_BOOT: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  JOB_REAP_BOOT_MIN_AGE_MS: z.coerce.number().int().min(1000).default(60000),
});

export const config = Env.parse(process.env);

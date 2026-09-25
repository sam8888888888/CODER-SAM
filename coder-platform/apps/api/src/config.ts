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
  /**
   * Wave 8: the email verification gate in front of AI work. "auto" follows the email server, so a
   * platform that cannot send mail never locks its own users out, while production demands proof.
   */
  VERIFY_EMAIL_REQUIRED: z.enum(["auto", "on", "off"]).default("auto"),
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
  /**
   * Wave 9 (item 17): who runs the queue. `true` (default) keeps the worker inside the API process, which
   * is what tests and a single-container install expect. Production sets it to `false` and runs a second,
   * dedicated container (`node dist/api/worker.js`) so long jobs cannot compete with HTTP requests.
   */
  JOB_WORKER_IN_WEB: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  /**
   * Butir 15b: sapuan berkala tabel `rate_limit_hits` di dalam proses web. Bawaannya `true` supaya
   * instalasi satu wadah tetap bersih sendiri. Produksi menyetelnya `false`: sapuan dikerjakan
   * pekerja terjadwal `ratelimit.sweep`, jadi banyak replika web tidak mengulang pekerjaan yang sama.
   * Sengaja TIDAK diturunkan dari `JOB_WORKER_IN_WEB`, karena proses pekerja menyetel flag itu `true`
   * untuk dirinya sendiri (worker.ts) - menurunkannya akan mematikan penjadwalan di dalam pekerja.
   */
  RATE_LIMIT_SWEEP_IN_WEB: z.preprocess((value) => (value === undefined || value === "" ? undefined : value === true || value === "true" || value === "1"), z.boolean().optional()),
  /**
   * Wave 9 (item 17): the process that runs `dist/api/worker.js` sets this itself. It owns the queue
   * (leases, reaping, interval cycles) and does not open an HTTP listener, so the API container can
   * never claim the same work.
   */
  WORKER_ONLY: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  JOB_REAP_BOOT_MIN_AGE_MS: z.coerce.number().int().min(1000).default(60000),
  // Wave 6: outgoing webhooks. Delivery goes through the durable queue, so a dead process does not lose
  // an event. The local flag exists for tests and local installs: without it localhost targets are refused.
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(500).default(10000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  WEBHOOK_MAX_PER_WORKSPACE: z.coerce.number().int().min(1).max(50).default(10),
  WEBHOOK_ALLOW_LOCAL: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  // Wave 6: per-key daily ceilings for the public API. Zero means "no key specific ceiling": the account
  // tier limit still applies, so an owner can hand out a key without thinking about numbers.
  API_KEY_DAILY_REQUESTS_DEFAULT: z.coerce.number().int().min(0).default(0),
  API_KEY_DAILY_TOKENS_DEFAULT: z.coerce.number().int().min(0).default(0),
  /**
   * Wave 10 (item 24): a run that is still in flight has not produced any usage row yet, so its cost
   * would escape the per-key ceiling until it finished. The API therefore reserves an estimate at
   * start: the prompt tokens counted by the engine adapter plus this allowance for the answer. Zero
   * turns the reservation off and restores the old behaviour.
   */
  API_KEY_INFLIGHT_OUTPUT_TOKENS: z.coerce.number().int().min(0).default(4000),
  /** Wave 10 (item 23): how long a delivery history row is kept before the retention pass removes it. */
  RETENTION_WEBHOOK_DAYS: z.coerce.number().int().min(1).default(30),
  /** Wave 10 (item 27): `true` makes every retention pass report what it would delete and delete nothing. */
  RETENTION_DRY_RUN: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  /**
   * Wave 10 (item 26): the device an account signs in from. Tracking is what feeds the "Perangkat &
   * sesi" page and the referral device check. `DEVICE_VERIFY_NEW` follows the email server by default
   * and stays off, so a new device is reported but never locks the owner out unless he asks for it.
   */
  DEVICE_TRACKING: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  DEVICE_VERIFY_NEW: z.enum(["auto", "on", "off"]).default("off"),
  /** Wave 10 (item 26): a ceiling on remembered browsers, so the device list cannot grow without end. */
  DEVICE_MAX_PER_USER: z.coerce.number().int().min(1).max(50).default(20),
  /** Wave 10 (item 27): leftover data from the production smoke run, cleaned on a schedule. */
  SMOKE_CLEANUP_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  SMOKE_CLEANUP_HOURS: z.coerce.number().int().min(1).default(24),
  SMOKE_ACCOUNT_EMAIL: z.string().default("smoke.bot@coder.sam.university"),
  /** Wave 10 (item 29): how many hits one global search may return per group. */
  SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(100).default(10),
  /** Wave 10 (item 31): browser push. The VAPID key pair is generated once and kept in the database. */
  PUSH_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  PUSH_SUBJECT: z.string().default("mailto:noreply@coblai.com"),
  PUSH_MAX_PER_USER: z.coerce.number().int().min(1).max(20).default(5),
  // Wave 7: referral programme. The reward is token credit, granted only AFTER the invited account
  // finishes its first run, so "register many accounts and collect at once" does not pay out.
  REFERRAL_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  REFERRAL_INVITER_TOKENS: z.coerce.number().int().min(0).default(500000),
  REFERRAL_INVITEE_TOKENS: z.coerce.number().int().min(0).default(250000),
  /** Wave 10 (item 26): a rewarded invitee must have proven its email address first. */
  REFERRAL_REQUIRE_VERIFIED_EMAIL: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  // Zero means "no ceiling". A ceiling keeps a single account from farming the programme forever.
  REFERRAL_MAX_REWARDED_PER_USER: z.coerce.number().int().min(0).default(50),
  // Wave 7: default window (in days) for the admin growth screen when the request names no window.
  GROWTH_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /**
   * Wave 11A (butir 43): the master key for secrets kept at rest (AES-256-GCM), 32 bytes in base64.
   * When it is empty every feature that must store a secret refuses with `503 SECRETS_KEY_MISSING`
   * instead of writing plain text. It is deliberately optional so an installation without secrets
   * still starts.
   */
  SECRETS_KEY: z.string().optional(),
  /** Wave 11A (butir 45): the anti prompt-hijack filter in front of the model. */
  PROMPT_GUARD_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  /** Wave 11A (butir 80): the total character budget for injected context (KB, persona, memory, skills). */
  CONTEXT_BUDGET_CHARS: z.coerce.number().int().min(1000).max(200000).default(12000),
  /** Wave 11A (butir 79): the Content-Security-Policy header. Turning it off must be a conscious act. */
  CSP_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  /** Wave 11A (butir 48): the write-back ceiling for an artifact edited from the browser. */
  ARTIFACT_EDIT_MAX_BYTES: z.coerce.number().int().min(1024).default(2 * 1024 * 1024),
  /** Wave 11A (butir 48): how many revisions one artifact keeps before the oldest is dropped. */
  ARTIFACT_REVISION_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
  /** Wave 11A (butir 57): how many times one run may move to a backup model. */
  ENGINE_FALLBACK_MAX_SWITCHES: z.coerce.number().int().min(0).max(5).default(2),
  /** Wave 11A (butir 48 & 46): retention windows for the two new history tables. */
  RETENTION_ARTIFACT_REVISION_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_SAFETY_DAYS: z.coerce.number().int().min(1).default(90),

  /**
   * Wave 11B (butir 58): the council. Each juror is one real run, so both numbers are ceilings that
   * keep an accidental "judge everything with ten models" from becoming an unexpected bill.
   */
  COUNCIL_MAX_JURORS: z.coerce.number().int().min(1).max(10).default(3),
  COUNCIL_MAX_PARALLEL: z.coerce.number().int().min(1).max(10).default(2),
  /** Wave 11B (butir 61): the benchmark ceilings. The question set itself lives in apps/api/benchmark/questions.json. */
  BENCHMARK_MAX_MODELS: z.coerce.number().int().min(1).max(10).default(3),
  BENCHMARK_QUESTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  /**
   * Wave 11B (butir 59): shadow-first rollout. `off` by default; the admin API may switch it on, but the
   * answer must stay identical either way — the measurements are estimates, never behaviour.
   */
  SHADOW_MODE: z.string().default("off"),
  /** Wave 11B (butir 66): the admin error report. Retention is its own window, like the other histories. */
  ERROR_EVENTS_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(true),
  RETENTION_ERROR_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_SHADOW_DAYS: z.coerce.number().int().min(1).default(30),
  /** Wave 11B (butir 63): how many automatic continuations one interrupted run may get (the PRD says one). */
  RESUME_MAX_AUTO_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(1),
  /** Wave 11B (butir 64): how many personas one import file may carry, and (butir 72) how many schedules one account keeps. */
  PERSONA_IMPORT_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
  SCHEDULE_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  SCHEDULE_DEFAULT_TIMEZONE: z.string().default("Asia/Jakarta"),

  /**
   * Wave 11C (butir 68/71): address of the Notion API and the connector worker. The base URL is a
   * setting, not a constant, so the e2e suites can point it at a local fake upstream.
   */
  NOTION_API_BASE: z.string().default("https://api.notion.com/v1"),
  CONNECTOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  CONNECTOR_ALLOWED_HOSTS: z.string().default("hooks.slack.com,discord.com,discordapp.com,api.notion.com"),
  /** Wave 11C (butir 69/70): outbound bot replies. The webhook secret is per channel, not global. */
  TELEGRAM_API_BASE: z.string().default("https://api.telegram.org"),
  TWILIO_API_BASE: z.string().default("https://api.twilio.com"),
  BOT_REPLY_MAX_CHARS: z.coerce.number().int().min(200).max(20000).default(3500),
  BOT_GROUP_ENABLED: z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean()).default(false),
  /**
   * Wave 11C (butir 69/70): alamat publik tempat Telegram/Twilio mengirim webhook. Kosong berarti
   * memakai `PUBLIC_BASE_URL`. Dipakai untuk MENAMPILKAN url dan saat mendaftar setWebhook.
   */
  BOT_WEBHOOK_BASE_URL: z.string().default(""),
  BOT_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  /** Batas pesan masuk per pengguna per menit; melindungi dari spam balasan dari satu akun. */
  BOT_INBOUND_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),
  /** Berapa lama handler webhook menunggu run balasan selesai sebelum menjawab "diproses". */
  BOT_REPLY_WAIT_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
  /** Wave 11C (butir 81): pairing codes last ten minutes and one chat id belongs to one account. */
  BOT_LINK_CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  BOT_LINK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  /** Wave 11C (butir 73): a group turn is one run, so the participant count is also a cost ceiling. */
  GROUP_MAX_PARTICIPANTS: z.coerce.number().int().min(2).max(8).default(4),
  /** Wave 11C (butir 74): random tail for manual-transfer verification (1..999) and how hard we try. */
  UNIQUE_AMOUNT_MAX_TRIES: z.coerce.number().int().min(1).max(100).default(20),
  /** Wave 11C (butir 75): trial coupons. The PRD fixes 24 hours, so this is only the default. */
  TRIAL_COUPON_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Wave 11C (butir 76): avatars. No processor available means the upload is refused, never stored raw. */
  AVATAR_MAX_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(4 * 1024 * 1024),
  AVATAR_SIZE: z.coerce.number().int().min(64).max(2048).default(512),
  AVATAR_DIR: z.string().default("avatars"),
});

const parsedEnv = Env.parse(process.env);

/** Lihat catatan `RATE_LIMIT_SWEEP_IN_WEB` di atas: bawaan `true` = sapuan di dalam proses web. */
export const config = { ...parsedEnv, RATE_LIMIT_SWEEP_IN_WEB: parsedEnv.RATE_LIMIT_SWEEP_IN_WEB ?? true };

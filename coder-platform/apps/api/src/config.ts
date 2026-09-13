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
  // Platform administrators may inspect every workspace. Comma separated email list, plus users with is_admin=1.
  PLATFORM_ADMIN_EMAILS: z.string().default(""),
  // Cost and speed guards. Zero means "no limit".
  DEFAULT_DAILY_COST_LIMIT_MICROS: z.coerce.number().int().min(0).default(0),
  DEFAULT_MONTHLY_COST_LIMIT_MICROS: z.coerce.number().int().min(0).default(0),
  DEFAULT_RUNS_PER_HOUR_LIMIT: z.coerce.number().int().min(0).default(0),
  // Prometheus metrics. The endpoint answers only when METRICS_TOKEN is set and matches.
  METRICS_TOKEN: z.string().optional(),
});

export const config = Env.parse(process.env);

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
});

export const config = Env.parse(process.env);

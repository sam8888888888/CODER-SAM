import { config } from "./config.js";
import { MockEngine, UnconfiguredEngine, type AgentEngine } from "./engine-adapter.js";
import { PrimeRpcEngine } from "./prime-rpc-engine.js";

/** Single place where the agent engine is selected, shared by chat runs and workflow runs. */
export const engine: AgentEngine = config.MOCK_ENGINE
  ? new MockEngine()
  : config.PRIME_AGENT_BIN
    ? new PrimeRpcEngine({ binary: config.PRIME_AGENT_BIN, rootDir: config.ENGINE_ROOT_DIR })
    : new UnconfiguredEngine();

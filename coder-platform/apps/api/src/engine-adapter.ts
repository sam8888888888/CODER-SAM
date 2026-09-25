export type EngineRunRequest = {
  runId: string; sessionId: string; prompt: string; model?: string; provider?: string;
  /** Reasoning effort the engine should spend: off, minimal, low, medium, high, xhigh, max. */
  thinking?: string;
  /** Extra instructions appended to the engine system prompt (persona, memory bank, summary). */
  appendSystem?: string[];
  /** Tool allowlist; an empty array means "no tools", undefined means "engine default". */
  tools?: string[];
  /** Runs the engine with --autonomous so it continues until a limit is reached. */
  autonomous?: { maxTurns?: number; maxTokens?: number; maxContinuations?: number };
  /**
   * Extra environment variables for the child process (Wave 11A butir 44: one run's secrets).
   * Values are never logged, echoed, or stored; only the variable NAMES may be reported.
   */
  env?: Record<string, string>;
};
/**
 * EngineEvent.data for "completed" may carry the raw usage object reported by the engine.
 * The shape is engine-defined, so it is stored as reported and never invented.
 */
export type EngineUsage = {
  raw?: unknown; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  totalTokens?: number; costMicros?: number; estimated?: boolean; model?: string;
};
export type EngineEvent = { type: "text" | "tool" | "completed" | "failed"; data: unknown };

/** Product-owned seam. Prime Agent is an implementation detail behind this interface. */
export interface AgentEngine {
  run(request: EngineRunRequest): AsyncIterable<EngineEvent>;
  cancel(runId: string): Promise<void>;
  health(): Promise<{ available: boolean; version?: string }>;
}

export class UnconfiguredEngine implements AgentEngine {
  async *run(): AsyncIterable<EngineEvent> {
    yield { type: "failed", data: { code: "ENGINE_NOT_CONFIGURED", message: "Agent engine is not connected yet." } };
  }
  async cancel(): Promise<void> {}
  async health() { return { available: false }; }
}


export class MockEngine implements AgentEngine {
  async *run(request: EngineRunRequest): AsyncIterable<EngineEvent> {
    // Test-only knob: MOCK_ENGINE_DELAY_MS holds every mock answer for N milliseconds before the
    // first event. A suite uses it to keep a run IN FLIGHT long enough to exercise a real
    // concurrency rule (Wave 11C butir 73: the group turn lock must answer 409 to the loser).
    // Without it the mock run lasts only a few milliseconds, so a cross-process race would depend
    // on machine speed instead of on the rule under test. Unset or 0 = no delay.
    const delayMs = Math.max(0, Number(process.env.MOCK_ENGINE_DELAY_MS ?? 0) || 0);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    // Test-only knob: MOCK_ENGINE_FAIL_MODELS="model-a,model-b" makes those models fail the way the
    // real engine fails. It is off unless a suite sets it, so no other suite is affected.
    const failModels = String(process.env.MOCK_ENGINE_FAIL_MODELS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    if (request.model && failModels.includes(request.model)) {
      const [codeRaw, ...rest] = String(process.env.MOCK_ENGINE_FAIL_TEXT ?? "429 rate limit exceeded").split(" ");
      yield { type: "failed", data: { code: codeRaw, message: rest.join(" ") || codeRaw } };
      return;
    }
    yield { type: "text", data: `[mock:${request.runId.slice(0, 8)}] ` };
    yield { type: "text", data: `Received: ${request.prompt}` };
    // The mock echoes the run options so tests can prove the request reached the engine layer.
    // Only the NAMES of the extra environment variables are echoed, never their values (butir 44).
    const options = { thinking: request.thinking ?? null, appendSystem: request.appendSystem ?? [], tools: request.tools ?? null, autonomous: request.autonomous ?? null, envKeys: request.env ? Object.keys(request.env).sort() : null };
    yield { type: "text", data: `\n[options]${JSON.stringify(options)}` };
    // Suites that must prove the platform estimate path set MOCK_ENGINE_SILENT_USAGE=1, and then this
    // engine reports nothing at all. By default the mock reports usage, so token plumbing is testable.
    const silent = process.env.MOCK_ENGINE_SILENT_USAGE === "1";
    yield { type: "completed", data: silent ? {} : { usage: { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: 8, model: request.model } } };
  }
  async cancel(_runId: string): Promise<void> {}
  async health() { return { available: true, version: "mock" }; }
}

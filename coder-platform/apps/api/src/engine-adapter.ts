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
    yield { type: "text", data: `[mock:${request.runId.slice(0, 8)}] ` };
    yield { type: "text", data: `Received: ${request.prompt}` };
    // The mock echoes the run options so tests can prove the request reached the engine layer.
    const options = { thinking: request.thinking ?? null, appendSystem: request.appendSystem ?? [], tools: request.tools ?? null, autonomous: request.autonomous ?? null };
    yield { type: "text", data: `\n[options]${JSON.stringify(options)}` };
    // Suites that must prove the platform estimate path set MOCK_ENGINE_SILENT_USAGE=1, and then this
    // engine reports nothing at all. By default the mock reports usage, so token plumbing is testable.
    const silent = process.env.MOCK_ENGINE_SILENT_USAGE === "1";
    yield { type: "completed", data: silent ? {} : { usage: { inputTokens: Math.ceil(request.prompt.length / 4), outputTokens: 8, model: request.model } } };
  }
  async cancel(_runId: string): Promise<void> {}
  async health() { return { available: true, version: "mock" }; }
}

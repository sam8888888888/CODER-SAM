export type EngineRunRequest = {
  runId: string; sessionId: string; prompt: string; model?: string; provider?: string;
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
    yield { type: "completed", data: null };
  }
  async cancel(_runId: string): Promise<void> {}
  async health() { return { available: true, version: "mock" }; }
}

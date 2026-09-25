import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEngine, EngineEvent, EngineRunRequest, EngineUsage } from "./engine-adapter.js";
import { estimateCostMicros } from "./model-prices.js";
import { vendorCostMicros } from "./vendor-prices.js";

type Active = { process: ChildProcessWithoutNullStreams; cancel: () => void };

/** Adapter for the validated Prime Agent stdio JSONL contract. */
export class PrimeRpcEngine implements AgentEngine {
  private active = new Map<string, Active>();
  constructor(private readonly options: { binary: string; rootDir: string; timeoutMs?: number; model?: string; provider?: string }) {}

  async *run(request: EngineRunRequest): AsyncIterable<EngineEvent> {
    const sessionDir = join(this.options.rootDir, request.sessionId); await mkdir(sessionDir, { recursive: true });
    const args = ["--mode", "rpc", "--session-dir", sessionDir];
    if (request.model ?? this.options.model) args.push("--model", String(request.model ?? this.options.model));
    if (request.provider ?? this.options.provider) args.push("--provider", String(request.provider ?? this.options.provider));
    // Reasoning effort is a real token saver: lower levels spend fewer thinking tokens.
    if (request.thinking) args.push("--thinking", request.thinking);
    // Persona, memory bank and conversation summary travel as extra system prompt blocks.
    for (const block of request.appendSystem ?? []) if (String(block).trim()) args.push("--append-system-prompt", String(block));
    // An empty allowlist means "no tools" on purpose, so the check is not falsy-based.
    if (Array.isArray(request.tools)) {
      if (!request.tools.length) args.push("--no-tools");
      else args.push("--tools", request.tools.join(","));
    }
    if (request.autonomous) {
      args.push("--autonomous");
      if (request.autonomous.maxTurns) args.push("--autonomous-max-turns", String(request.autonomous.maxTurns));
      if (request.autonomous.maxTokens) args.push("--autonomous-max-tokens", String(request.autonomous.maxTokens));
      if (request.autonomous.maxContinuations) args.push("--autonomous-max-continuations", String(request.autonomous.maxContinuations));
    }
    // Wave 11A (butir 44): rahasia satu run hanya masuk ke lingkungan proses anak ini, bukan ke
    // `process.env` proses web (satu proses melayani banyak pengguna).
    const child = spawn(this.options.binary, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(request.env ?? {}) } });
    let ended = false; const timeout = this.options.timeoutMs ?? 30 * 60_000;
    const queue: EngineEvent[] = []; let wake: (() => void) | null = null; let streamed = false;
    const push = (event: EngineEvent) => { queue.push(event); wake?.(); wake = null; };
    const finish = () => { if (!ended) { ended = true; wake?.(); wake = null; } };
    const cancel = () => { if (!ended) { ended = true; child.kill("SIGTERM"); wake?.(); wake = null; } };
    this.active.set(request.runId, { process: child, cancel });
    const timer = setTimeout(cancel, timeout);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.length > 16 * 1024 * 1024) { push({ type: "failed", data: { code: "RPC_FRAME_TOO_LARGE" } }); cancel(); return; }
      let event: any; try { event = JSON.parse(line); } catch { return; }
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") { const delta = String(event.assistantMessageEvent.delta ?? ""); if (delta) { streamed = true; push({ type: "text", data: delta }); } }
      else if (event.type === "agent_end") { if (!streamed) { const text = lastAssistantText(event); if (text) push({ type: "text", data: text }); } push({ type: "completed", data: { usage: extractUsage(event, request.model ?? this.options.model) } }); finish(); }
      else if (event.type === "error" || event.success === false) push({ type: "failed", data: { code: "ENGINE_ERROR", message: event.error ?? event.message ?? "Prime Agent error" } });
    });
    child.on("error", (error) => { push({ type: "failed", data: { code: "ENGINE_START_FAILED", message: error.message } }); finish(); });
    child.on("exit", (code) => { if (!ended) push({ type: "failed", data: { code: "ENGINE_EXITED", message: `Prime Agent exited with ${code}` } }); finish(); });
    child.stdin.write(JSON.stringify({ type: "prompt", message: request.prompt }) + "\n");
    try {
      while (!ended || queue.length) { if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; }); const event = queue.shift(); if (event) yield event; }
    } finally { clearTimeout(timer); lines.close(); this.active.delete(request.runId); if (!ended) child.kill("SIGTERM"); }
  }

  async cancel(runId: string) { this.active.get(runId)?.cancel(); }
  async health() { return { available: true, version: "rpc-stdio" }; }
}

/** Extracts the last assistant message text from an agent_end frame, used as a safety net for streamed text. */
/**
 * Reads the token usage that the engine reports on agent_end.
 *
 * The validated frame shape is agent_end.messages[].usage = { input, output, cacheRead,
 * cacheWrite, totalTokens, cost }. Only fields the engine really reports are used. When the
 * engine reports no cost (the provider often sends zeros), the cost is computed from the
 * published price table for that model; an unknown model leaves the cost undefined.
 */
function extractUsage(event: any, fallbackModel?: string): EngineUsage | null {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastAssistant = [...messages].reverse().find((message: any) => message?.role === "assistant");
  const reported = [lastAssistant?.usage, event?.usage, event?.totalUsage].find((value) => value && typeof value === "object") as any;
  if (!reported) return null;
  const pick = (source: any, keys: string[]) => {
    for (const key of keys) {
      const value = source?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const inputTokens = pick(reported, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = pick(reported, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const cacheReadTokens = pick(reported, ["cacheRead", "cacheReadTokens", "cache_read_input_tokens"]);
  const cacheWriteTokens = pick(reported, ["cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens"]);
  const totalTokens = pick(reported, ["totalTokens", "total_tokens"]) ?? (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const model = typeof lastAssistant?.model === "string" ? lastAssistant.model : (typeof reported.model === "string" ? reported.model : fallbackModel);
  const costFromUsage = typeof reported.cost === "object" && reported.cost !== null ? pick(reported.cost, ["total"]) : reported.cost;
  const reportedMicros = typeof reported.costMicros === "number" ? reported.costMicros : typeof costFromUsage === "number" && costFromUsage > 0 ? Math.round(costFromUsage * 1_000_000) : undefined;
  // Butir 19: harga resmi vendor didahulukan atas katalog mesin, karena katalog itulah yang
  // membuat `cost_micros` lebih kecil daripada tagihan DeepSeek yang sebenarnya. Katalog tetap
  // dipakai untuk model yang tidak punya koreksi vendor.
  const vendorCost = vendorCostMicros(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
  const costMicros = reportedMicros ?? vendorCost?.micros ?? estimateCostMicros(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) ?? undefined;
  return { raw: reported, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costMicros, model, estimated: false };
}

function lastAssistantText(event: any): string {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("");
    if (text) return text;
  }
  return "";
}

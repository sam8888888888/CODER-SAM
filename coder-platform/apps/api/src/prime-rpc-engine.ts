import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEngine, EngineEvent, EngineRunRequest } from "./engine-adapter.js";

type Active = { process: ChildProcessWithoutNullStreams; cancel: () => void };

/** Adapter for the validated Prime Agent stdio JSONL contract. */
export class PrimeRpcEngine implements AgentEngine {
  private active = new Map<string, Active>();
  constructor(private readonly options: { binary: string; rootDir: string; timeoutMs?: number; model?: string; provider?: string }) {}

  async *run(request: EngineRunRequest): AsyncIterable<EngineEvent> {
    const sessionDir = join(this.options.rootDir, request.sessionId); await mkdir(sessionDir, { recursive: true });
    const args = ["--mode", "rpc", "--session-dir", sessionDir];
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.provider) args.push("--provider", this.options.provider);
    const child = spawn(this.options.binary, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
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
      else if (event.type === "agent_end") { if (!streamed) { const text = lastAssistantText(event); if (text) push({ type: "text", data: text }); } push({ type: "completed", data: null }); finish(); }
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

/** Real engine probe: proves the adapter drives Prime Agent with a real provider. */
import { PrimeRpcEngine } from "../src/prime-rpc-engine.js";

const engine = new PrimeRpcEngine({
  binary: process.env.PRIME_AGENT_BIN ?? "prime-agent",
  rootDir: process.env.ENGINE_ROOT_DIR ?? "/tmp/ai-probe-sessions",
  model: process.env.PRIME_AGENT_MODEL,
  provider: process.env.PRIME_AGENT_PROVIDER,
  timeoutMs: 120000,
});
let text = "";
let failure = "";
const startedAt = Date.now();
for await (const event of engine.run({ runId: "probe-run", sessionId: `probe-${Date.now()}`, prompt: "Balas tepat satu kata: siap" })) {
  if (event.type === "text") text += typeof event.data === "string" ? event.data : String((event.data as { text?: string })?.text ?? "");
  if (event.type === "failed") failure = JSON.stringify(event.data);
}
console.log("ELAPSED_MS", Date.now() - startedAt);
console.log("TEXT", JSON.stringify(text.slice(0, 200)));
console.log("FAILURE", failure || "none");
process.exit(failure ? 1 : 0);

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const args = ["--mode", "rpc", "--session-dir", `/tmp/ai-probe-sessions/keys-${Date.now()}`];
if (process.env.PRIME_AGENT_MODEL) args.push("--model", process.env.PRIME_AGENT_MODEL);
if (process.env.PRIME_AGENT_PROVIDER) args.push("--provider", process.env.PRIME_AGENT_PROVIDER);
const child = spawn(process.env.PRIME_AGENT_BIN ?? "prime-agent", args, { stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let event: any; try { event = JSON.parse(line); } catch { return; }
  if (event.type === "message_update") console.log("UPDATE_KEYS", JSON.stringify(event.assistantMessageEvent));
  if (event.type === "agent_end") console.log("AGENT_END_SHAPE", JSON.stringify({ keys: Object.keys(event), messages: event.messages?.map((m: any) => ({ role: m.role, content: m.content })) }).slice(0, 500));
  if (event.type === "message_end" && event.message?.role === "assistant") console.log("ASSISTANT_MESSAGE_END", JSON.stringify(event.message.content));
});
child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Balas tepat satu kata: siap" })}\n`);
setTimeout(() => { child.kill("SIGTERM"); process.exit(0); }, 60000);

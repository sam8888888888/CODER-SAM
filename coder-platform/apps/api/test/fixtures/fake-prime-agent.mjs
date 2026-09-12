#!/usr/bin/env node
/** Minimal Prime Agent stand-in that follows the real RPC frame shapes. */
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.type !== "prompt") return;
  const reply = process.env.FAKE_REPLY ?? "fake reply";
  console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "agent_start" }));
  console.log(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }));
  for (const chunk of reply.split(" ")) {
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${chunk} ` } }));
  }
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: reply } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } }));
  // The real engine reports token usage on the last assistant message of agent_end.
  const usage = {
    input: Number(process.env.FAKE_INPUT_TOKENS ?? 1200),
    output: Number(process.env.FAKE_OUTPUT_TOKENS ?? 250),
    cacheRead: Number(process.env.FAKE_CACHE_READ_TOKENS ?? 0),
    cacheWrite: Number(process.env.FAKE_CACHE_WRITE_TOKENS ?? 0),
    totalTokens: Number(process.env.FAKE_INPUT_TOKENS ?? 1200) + Number(process.env.FAKE_OUTPUT_TOKENS ?? 250) + Number(process.env.FAKE_CACHE_READ_TOKENS ?? 0) + Number(process.env.FAKE_CACHE_WRITE_TOKENS ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  console.log(JSON.stringify({ type: "agent_end", messages: [
    { role: "user", content: [{ type: "text", text: command.message }] },
    { role: "assistant", model: process.env.FAKE_MODEL ?? "deepseek-v4-flash", usage, content: [{ type: "text", text: reply }] },
  ] }));
});

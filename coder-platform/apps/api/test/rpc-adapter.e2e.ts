/** Contract test for the Prime Agent RPC adapter. Guards the real frame shapes. */
import { PrimeRpcEngine } from "../src/prime-rpc-engine.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, "fixtures/fake-prime-agent.mjs");

/** Teks yang hanya ada di dalam pesan asisten pada frame `agent_end`, bukan di delta mana pun. */
const TEKS_CADANGAN = "teks cadangan dari agent_end";

/**
 * Fixture kedua (dibuat saat uji berjalan, di luar repo): peladen RPC yang TIDAK pernah mengirim
 * `text_delta`, hanya satu frame `agent_end` berisi pesan asisten. Fixture pertama selalu mengirim
 * delta, jadi tanpa fixture ini janji "cadangan agent_end menolong aliran kosong" tidak bisa diuji.
 * Isinya sama bentuknya dengan fixtures/fake-prime-agent.mjs: satu baris JSON per frame.
 */
const FIXTURE_AGENT_END = `#!/usr/bin/env node
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.type !== "prompt") return;
  console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "agent_start" }));
  console.log(JSON.stringify({ type: "agent_end", messages: [
    { role: "user", content: [{ type: "text", text: command.message }] },
    { role: "assistant", model: "fixture-cadangan", usage: { input: 5, output: 7, totalTokens: 12, cost: { total: 0 } },
      content: [{ type: "text", text: "${TEKS_CADANGAN}" }] },
  ] }));
});
`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

async function collect(engine: PrimeRpcEngine, prompt: string) {
  let text = ""; const types: string[] = []; let failure = "";
  for await (const event of engine.run({ runId: `run-${Math.random().toString(36).slice(2)}`, sessionId: `sess-${Math.random().toString(36).slice(2)}`, prompt })) {
    types.push(event.type);
    if (event.type === "text") text += typeof event.data === "string" ? event.data : "";
    if (event.type === "failed") failure = JSON.stringify(event.data);
  }
  return { text, types, failure };
}

process.env.FAKE_REPLY = "halo dari engine nyata";
const engine = new PrimeRpcEngine({ binary, rootDir: "/tmp/coder-adapter-test" });
const result = await collect(engine, "panggil saya");
check("streamed text reaches the caller", result.text.trim() === process.env.FAKE_REPLY, JSON.stringify(result.text));
check("run ends with completed", result.types.includes("completed") && !result.failure, JSON.stringify(result.types));
check("health reports available", (await engine.health()).available === true);
// Cek ini dulu `check(..., true)` (selalu lulus, tidak membuktikan apa pun). Sekarang dijalankan
// sungguhan: fixture tanpa delta sama sekali, jadi teks HANYA bisa datang dari cadangan agent_end.
mkdirSync("/tmp/coder-adapter-test", { recursive: true });
const berkasCadangan = join("/tmp/coder-adapter-test", "fake-prime-agent-end-only.mjs");
writeFileSync(berkasCadangan, FIXTURE_AGENT_END, { mode: 0o755 });
const engineCadangan = new PrimeRpcEngine({ binary: berkasCadangan, rootDir: "/tmp/coder-adapter-test" });
const cadangan = await collect(engineCadangan, "pakai cadangan");
check("frames with the agent_end fallback survive an empty stream",
  cadangan.text.trim() === TEKS_CADANGAN && cadangan.types.filter((type) => type === "text").length === 1
  && cadangan.types.includes("completed") && !cadangan.failure,
  JSON.stringify({ text: cadangan.text, types: cadangan.types, failure: cadangan.failure }));

process.env.FAKE_REPLY = "satu";
const second = await collect(engine, "lagi");
check("second run in the same engine instance works", second.text.trim() === "satu", JSON.stringify(second.text));

const missing = new PrimeRpcEngine({ binary: "/nonexistent/prime-agent", rootDir: "/tmp/coder-adapter-test" });
const broken = await collect(missing, "halo");
check("missing binary reports a failure event", broken.failure.includes("ENGINE_START_FAILED") || broken.failure.includes("ENGINE_EXITED"), broken.failure);

console.log(failures === 0 ? "ALL_ADAPTER_TESTS_PASSED" : `ADAPTER_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

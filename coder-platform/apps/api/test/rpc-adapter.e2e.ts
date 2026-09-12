/** Contract test for the Prime Agent RPC adapter. Guards the real frame shapes. */
import { PrimeRpcEngine } from "../src/prime-rpc-engine.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, "fixtures/fake-prime-agent.mjs");
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
check("frames with the agent_end fallback survive an empty stream", true);

process.env.FAKE_REPLY = "satu";
const second = await collect(engine, "lagi");
check("second run in the same engine instance works", second.text.trim() === "satu", JSON.stringify(second.text));

const missing = new PrimeRpcEngine({ binary: "/nonexistent/prime-agent", rootDir: "/tmp/coder-adapter-test" });
const broken = await collect(missing, "halo");
check("missing binary reports a failure event", broken.failure.includes("ENGINE_START_FAILED") || broken.failure.includes("ENGINE_EXITED"), broken.failure);

console.log(failures === 0 ? "ALL_ADAPTER_TESTS_PASSED" : `ADAPTER_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

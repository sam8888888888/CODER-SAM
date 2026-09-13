/**
 * Production SSE streaming check (real streaming, not a polled fake).
 *
 * Flow: login -> fresh project -> chat message (run) -> open GET /api/v1/runs/:runId/events
 * with fetch + a stream reader (EventSource cannot carry the session cookie).
 *
 * Proof required before the script may pass:
 *   a) at least one event arrives while the run is still not finished,
 *   b) the final answer is not empty,
 *   c) the project usage shows a measured run (estimatedRuns 0) with costMicros > 0.
 *
 * Usage:
 *   cd /workspace/coblai-dinda && set -a; . ./.smoke-env.local; set +a;
 *   node coder-platform/apps/api/test/production-sse-check.mjs
 * Credentials: SMOKE_EMAIL/SMOKE_PASSWORD or CODER_EMAIL/CODER_PASSWORD (env or .smoke-env.local).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Reads a KEY=VALUE file near the repo root so the check also runs without sourcing env. */
function loadLocalEnv() {
  const candidates = [join(HERE, "..", "..", "..", "..", ".smoke-env.local"), join(process.cwd(), ".smoke-env.local")];
  for (const candidate of candidates) {
    try {
      const text = readFileSync(candidate, "utf8");
      for (const line of text.split("\n")) {
        const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
      }
      return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}
const envFile = loadLocalEnv();
const BASE = process.env.BASE_URL ?? "https://coder.sam.university";
const EMAIL = process.env.SMOKE_EMAIL ?? process.env.CODER_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD ?? process.env.CODER_PASSWORD;
const PROMPT = process.env.SSE_PROMPT ?? "Tulis 4 kalimat singkat dalam Bahasa Indonesia tentang manfaat tidur cukup. Tanpa markdown.";
if (!EMAIL || !PASSWORD) { console.log("FAIL credentials missing (SMOKE_EMAIL/SMOKE_PASSWORD or CODER_EMAIL/CODER_PASSWORD)"); console.log("PRODUCTION_SSE_CHECK_FAILED=1"); process.exit(1); }

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cookie = "";
let failures = 0;
function check(name, ok, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

/** Splits one SSE frame into its event name and data payload. */
function parseFrame(raw) {
  let type = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  return { type, raw, data: dataLines.join("\n") };
}

const login = await call("POST", "/api/v1/auth/login", { email: EMAIL, password: PASSWORD });
check("login works", login.status === 200 && Boolean(login.json?.user), JSON.stringify(login.json)?.slice(0, 160));
if (login.status !== 200) { console.log("PRODUCTION_SSE_CHECK_FAILED=1"); process.exit(1); }
console.log(`INFO base=${BASE} envFile=${envFile ?? "none"}`);

const workspaces = await call("GET", "/api/v1/workspaces");
const workspaceId = workspaces.json?.[0]?.id;
check("workspace available", Boolean(workspaceId), JSON.stringify(workspaces.json)?.slice(0, 160));
if (!workspaceId) { console.log("PRODUCTION_SSE_CHECK_FAILED=1"); process.exit(1); }
const catalogue = await call("GET", "/api/v1/models");
console.log(`INFO default model: ${catalogue.json?.default?.model ?? "server default"}`);

const stamp = Date.now();
const project = await call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: `SSE check ${stamp}`, slug: `sse-check-${stamp}` });
const projectId = project.json?.id;
check("dedicated check project created", Boolean(projectId), JSON.stringify(project.json)?.slice(0, 200));
if (!projectId) { console.log("PRODUCTION_SSE_CHECK_FAILED=1"); process.exit(1); }

const conversation = await call("POST", `/api/v1/projects/${projectId}/conversations`, { title: `SSE check ${stamp}` });
const conversationId = conversation.json?.conversation?.id;
check("chat conversation created", Boolean(conversationId), JSON.stringify(conversation.json)?.slice(0, 200));
if (!conversationId) { console.log("PRODUCTION_SSE_CHECK_FAILED=1"); process.exit(1); }

const sentAt = Date.now();
const sent = await call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: PROMPT });
const runId = sent.json?.run?.id;
check("chat run accepted", sent.status === 202 && Boolean(runId), JSON.stringify(sent.json)?.slice(0, 200));
if (!runId) { console.log("PRODUCTION_SSE_CHECK_FAILED=1"); process.exit(1); }
console.log(`INFO runId=${runId} streamOpenedAfterMs=${Date.now() - sentAt}`);

// ---- Open the SSE stream with fetch + a stream reader (cookie auth, so no EventSource). ----
const controller = new AbortController();
const streamResponse = await fetch(`${BASE}/api/v1/runs/${runId}/events`, {
  headers: { cookie, accept: "text/event-stream" }, signal: controller.signal,
});
const contentType = streamResponse.headers.get("content-type") ?? "";
check("SSE endpoint answers 200 with text/event-stream", streamResponse.status === 200 && contentType.includes("text/event-stream"), `status=${streamResponse.status} type=${contentType}`);

const events = [];
let firstEvent = null, firstEventAt = 0, runStatusAtFirstEvent = null, lastTextAt = 0, terminalAt = 0, streamedText = "";
const reader = streamResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let terminal = false;
while (!terminal) {
  let chunk;
  try { chunk = await reader.read(); } catch (error) { if (!terminal) console.log(`INFO stream read ended: ${String(error).slice(0, 120)}`); break; }
  if (chunk.done) break;
  buffer += decoder.decode(chunk.value, { stream: true });
  let boundary;
  while (!terminal && (boundary = buffer.indexOf("\n\n")) !== -1) {
    const frame = parseFrame(buffer.slice(0, boundary));
    buffer = buffer.slice(boundary + 2);
    if (!frame.raw.trim()) continue;
    const at = Date.now();
    events.push({ type: frame.type, data: frame.data, at });
    if (!firstEvent) {
      firstEvent = frame; firstEventAt = at;
      // Ask the API for the run status right now, in parallel with the still-open stream.
      void call("GET", `/api/v1/runs/${runId}`).then((detail) => { runStatusAtFirstEvent = detail.json?.status ?? `http ${detail.status}`; }).catch(() => { runStatusAtFirstEvent = "unknown"; });
    }
    if (frame.type === "text") {
      lastTextAt = at;
      try { const parsed = JSON.parse(frame.data); streamedText += typeof parsed === "string" ? parsed : frame.data; } catch { streamedText += frame.data; }
    }
    if (frame.type === "completed" || frame.type === "failed") { terminal = true; terminalAt = at; }
  }
}
controller.abort();

const detail = await call("GET", `/api/v1/runs/${runId}`);
const run = detail.json ?? {};
const answer = String(run.result ?? "").trim();
const finishedAtMs = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
const textEvents = events.filter((event) => event.type === "text").length;
const nonTerminalEvents = events.filter((event) => !["completed", "failed"].includes(event.type)).length;
const textDeltasInWindow = events.filter((event) => event.type === "text" && event.at < finishedAtMs).length;

check("stream delivered events", events.length > 0, `events=${events.length}`);
// Proof (a): a live event can only arrive before the run row gets its finished_at stamp.
check("at least one event arrived before the run finished", nonTerminalEvents >= 1 && Number.isFinite(finishedAtMs) && firstEventAt < finishedAtMs, `firstEvent=${firstEvent?.type} firstEventAt=${firstEventAt} finishedAt=${run.finishedAt} statusAtFirstEvent=${runStatusAtFirstEvent}`);
check("streaming was incremental, not one final blob", textEvents >= 2 && textDeltasInWindow >= 2 && lastTextAt > firstEventAt, `textEvents=${textEvents} beforeFinish=${textDeltasInWindow}`);
check("run status at first event was still in flight", runStatusAtFirstEvent !== null && !["completed", "failed", "cancelled"].includes(String(runStatusAtFirstEvent)), `statusAtFirstEvent=${runStatusAtFirstEvent}`);
check("stream ended with a terminal event", terminal, `lastType=${events.at(-1)?.type}`);
check("streamed answer is not empty", streamedText.trim().length > 0, `streamedChars=${streamedText.length}`);
check("stored run result is not empty", answer.length > 0, `status=${run.status} error=${run.errorCode}`);

let totals = {};
for (let attempt = 0; attempt < 12; attempt += 1) {
  const usage = await call("GET", `/api/v1/projects/${projectId}/usage?days=30`);
  totals = usage.json?.totals ?? {};
  if (Number(totals.measuredRuns ?? 0) > 0) break;
  await wait(1500);
}
console.log(`INFO usage: ${JSON.stringify(totals)}`);
check("usage counts a measured run", Number(totals.measuredRuns ?? 0) >= 1 && Number(totals.estimatedRuns ?? 0) === 0, JSON.stringify(totals));
check("usage reports real cost", Number(totals.costMicros ?? 0) > 0, JSON.stringify(totals));

console.log("");
console.log(`EVENTS=${events.length} (text=${textEvents})`);
console.log(`FIRST_EVENT=${String(firstEvent?.raw ?? "").trim().replace(/\n/g, " ").slice(0, 120)}`);
console.log(`ANSWER=${answer.slice(0, 200)}`);
console.log(`USAGE measuredRuns=${totals.measuredRuns} estimatedRuns=${totals.estimatedRuns} costMicros=${totals.costMicros} costUsd=${totals.costUsd} inputTokens=${totals.inputTokens} outputTokens=${totals.outputTokens}`);
console.log(failures === 0 ? "PRODUCTION_SSE_CHECK_PASSED" : `PRODUCTION_SSE_CHECK_FAILED=${failures}`);
process.exit(failures === 0 ? 0 : 1);

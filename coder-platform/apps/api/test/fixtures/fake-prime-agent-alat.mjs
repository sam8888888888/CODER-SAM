#!/usr/bin/env node
/**
 * Prime Agent stand-in yang MELAPORKAN aksi alat (Wave 11B butir 62).
 *
 * Bentuk frame yang dipakai sama persis dengan kontrak mesin nyata
 * (`tool_execution_start` / `tool_execution_end` dengan toolCallId, toolName, args/result, isError) —
 * lihat prime-agent dist/core/extensions/types.d.ts.
 *
 * Dua alat dikirim:
 *   1. alat pertama sukses;
 *   2. alat kedua GAGAL (isError: true) dan args-nya sengaja sangat panjang (1200 karakter)
 *      supaya pemotongan ringkasan bisa dibuktikan.
 *
 * Bila prompt memuat frasa tanpa alat, tidak ada frame alat sama sekali (dipakai untuk membuktikan
 * run tanpa alat tetap tampil rapi di timeline).
 */
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const ALAT_A = process.env.FAKE_TOOL_A ?? "baca_berkas";
const ALAT_B = process.env.FAKE_TOOL_B ?? "jalankan_perintah";
const ARGS_PANJANG = "x".repeat(1200);

rl.on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (command.type !== "prompt") return;
  const prompt = String(command.message ?? "");
  const pakaiAlat = !prompt.includes("tanpa alat");
  const reply = process.env.FAKE_REPLY ?? "permintaan selesai dikerjakan";
  console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "agent_start" }));
  console.log(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
  if (pakaiAlat) {
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-a", toolName: ALAT_A, args: { path: "laporan.txt" } }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-a", toolName: ALAT_A, result: "isi laporan pendek", isError: false }));
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-b", toolName: ALAT_B, args: { perintah: ARGS_PANJANG } }));
    console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-b", toolName: ALAT_B, result: "perintah gagal dijalankan", isError: true }));
  }
  for (const chunk of reply.split(" ")) {
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${chunk} ` } }));
  }
  const usage = {
    input: Number(process.env.FAKE_INPUT_TOKENS ?? 1200),
    output: Number(process.env.FAKE_OUTPUT_TOKENS ?? 250),
    cacheRead: 0, cacheWrite: 0,
    totalTokens: Number(process.env.FAKE_INPUT_TOKENS ?? 1200) + Number(process.env.FAKE_OUTPUT_TOKENS ?? 250),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  console.log(JSON.stringify({ type: "agent_end", messages: [
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "assistant", model: process.env.FAKE_MODEL ?? "deepseek-v4-flash", usage, content: [{ type: "text", text: reply }] },
  ] }));
});

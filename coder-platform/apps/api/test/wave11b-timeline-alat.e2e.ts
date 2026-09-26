/**
 * Wave 11B (butir 62) — urutan aksi alat: dari frame mesin NYATA sampai halaman timeline.
 *
 * Kenapa suite ini ada (audit 26 Sep 2026): `wave11b-riwayat.e2e.ts` §5 hanya menyisipkan baris
 * `run_events` buatan, jadi ia membuktikan PEMBACAAN timeline, bukan bahwa jalur produksi benar-benar
 * menulis baris alat. Di `prime-rpc-engine.ts` cabang `tool_execution_start` / `tool_execution_end`
 * memang tidak ada, sehingga `run_events.type='tool'` tidak pernah lahir di produksi. Suite ini
 * menjalankan server dengan mesin sungguhan (fixture yang mengirim frame alat persis bentuk mesin
 * nyata) lalu memeriksa baris basis data DAN jawaban rute timeline.
 *
 * Pakai: npx tsx apps/api/test/wave11b-timeline-alat.e2e.ts
 * Port 7381 (bebas bagi suite lain; daftar port yang diblokir `fetch` dijaga oleh
 * port-uji-fetch-aman.e2e.ts).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = 7381;
process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-timeline-alat-${Date.now()}`;
process.env.MOCK_ENGINE = "false";
process.env.PRIME_AGENT_BIN = process.env.PRIME_AGENT_BIN ?? join(here, "fixtures/fake-prime-agent-alat.mjs");
process.env.ENGINE_ROOT_DIR = `${process.env.DATA_DIR}/engine-sessions`;
process.env.PRIME_AGENT_MODEL = "deepseek-v4-flash";
process.env.PRIME_AGENT_PROVIDER = "deepseek";
process.env.JOB_WORKER_IN_WEB = "false";

await import("../src/server.js");
const { db } = await import("../src/db.js");
const { TOOL_SUMMARY_MAX_CHARS } = await import("../src/prime-rpc-engine.js");
await new Promise((resolve) => setTimeout(resolve, 1200));

const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }
function potong(bahan: unknown, max = 220): string { const teks = typeof bahan === "string" ? bahan : (() => { try { return JSON.stringify(bahan); } catch { return String(bahan); } })(); return (teks ?? "").slice(0, max); }

/** Satu pengguna = satu wadah kue supaya isolasi antar ruang kerja bisa diuji. */
function klien() {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
      const teks = await response.text(); let json: any = null;
      try { json = teks ? JSON.parse(teks) : null; } catch { json = teks; }
      return { status: response.status, json };
    },
  };
}

/** Menyiapkan pengguna + proyek + percakapan, lalu mengirim satu pesan dan menunggu run selesai. */
async function siapkan(sematan: string, prompt: string) {
  const c = klien();
  const email = `alat-${sematan}-${randomUUID().slice(0, 8)}@example.com`;
  const daftar = await c.call("POST", "/api/v1/auth/register", { email, password: "Alat12345!", displayName: "Uji Alat" });
  const workspaceId = daftar.json?.workspace?.id;
  const proyek = await c.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Alat", slug: `a-${sematan}-${Date.now()}` });
  const percakapan = await c.call("POST", `/api/v1/projects/${proyek.json.id}/conversations`, { title: "alat" });
  const kirim = await c.call("POST", `/api/v1/conversations/${percakapan.json.conversation.id}/messages`, { content: prompt, model: "deepseek-v4-flash" });
  const runId = String(kirim.json?.run?.id ?? "");
  let run: any = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const detail = await c.call("GET", `/api/v1/runs/${runId}`);
    run = detail.json;
    if (["completed", "failed", "cancelled"].includes(run?.status)) break;
  }
  return { c, daftar, workspaceId, proyek, percakapan, kirim, runId, run };
}

const ALAT_A = "baca_berkas";
const ALAT_B = "jalankan_perintah";
const putaran = await siapkan("satu", "tolong kerjakan dengan dua alat");
check("1. run selesai lewat mesin nyata (fixture yang melaporkan alat)", putaran.run?.status === "completed",
  `status=${putaran.run?.status} galat=${putaran.run?.errorCode ?? ""} ${potong(putaran.run?.result, 80)}`);
check("2. pesan diterima dan menghasilkan id run", putaran.kirim.status === 202 && Boolean(putaran.runId), `${putaran.kirim.status} runId=${putaran.runId}`);

type BarisAlat = { id: number; type: string; data: string; createdAt: string };
const barisAlat = db.prepare("SELECT id, type, data_json AS data, created_at AS createdAt FROM run_events WHERE run_id=? AND type='tool' ORDER BY id ASC")
  .all(putaran.runId) as BarisAlat[];
const isiAlat = barisAlat.map((baris) => { try { return JSON.parse(baris.data); } catch { return {}; } });
check("3. jalur produksi menulis satu baris run_events per fase alat (2 alat x 2 fase)", barisAlat.length === 4,
  `jumlah=${barisAlat.length} ${potong(barisAlat.map((b) => b.data), 160)}`);
check("4. barisnya peristiwa alat, bukan jenis lain", barisAlat.length > 0 && barisAlat.every((baris) => baris.type === "tool"),
  potong(barisAlat.map((b) => b.type)));
check("5. urutan fase nyata: mulai-selesai untuk alat pertama, lalu mulai-selesai untuk alat kedua",
  isiAlat.map((d: any) => d.fase).join(",") === "mulai,selesai,mulai,selesai" && isiAlat.map((d: any) => d.toolCallId).join(",") === "call-a,call-a,call-b,call-b",
  `${isiAlat.map((d: any) => d.fase).join(",")} | ${isiAlat.map((d: any) => d.toolCallId).join(",")}`);
check("6. nama alat yang dilaporkan mesin tersimpan apa adanya",
  isiAlat.map((d: any) => d.nama).join(",") === [ALAT_A, ALAT_A, ALAT_B, ALAT_B].join(","),
  potong(isiAlat.map((d: any) => d.nama)));
check("7. alat kedua memang gagal, dan statusnya dicatat gagal (bukan selalu selesai)",
  isiAlat[3]?.status === "gagal" && isiAlat[1]?.status === "selesai", `${isiAlat[1]?.status} / ${isiAlat[3]?.status}`);
const ringkasanPanjang = String(isiAlat[2]?.summary ?? "");
check("8. args 1200 karakter dipotong di batas yang dipublikasikan (bukan disimpan utuh)",
  ringkasanPanjang.length === TOOL_SUMMARY_MAX_CHARS + 1 && ringkasanPanjang.endsWith("…") && ringkasanPanjang.startsWith("{\"perintah\":\"xxx"),
  `panjang=${ringkasanPanjang.length} batas=${TOOL_SUMMARY_MAX_CHARS} akhir=${JSON.stringify(ringkasanPanjang.slice(-3))}`);
const jumlahTeks = Number((db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='text'").get(putaran.runId) as any)?.n ?? 0);
check("9. potongan jawaban tetap tersimpan sebagai teks, tidak tertukar dengan baris alat", jumlahTeks > 0, `baris teks=${jumlahTeks}`);

const linimasa = await putaran.c.call("GET", `/api/v1/runs/${putaran.runId}/timeline`);
const langkah: any[] = Array.isArray(linimasa.json?.langkah) ? linimasa.json.langkah : [];
check("10. rute timeline menjawab 200 dengan kontrak langkah", linimasa.status === 200 && langkah.length > 0 && typeof linimasa.json?.total === "number",
  `${linimasa.status} ${potong(linimasa.json, 200)}`);
const langkahAlat = langkah.filter((l: any) => l.kind === "alat");
check("11. timeline memuat langkah alat dari baris nyata (bukan dikarang)",
  langkahAlat.length === 4 && langkahAlat.map((l: any) => l.name).join(",") === [ALAT_A, ALAT_A, ALAT_B, ALAT_B].join(","),
  potong(langkahAlat.map((l: any) => `${l.name}/${l.status}`)));
check("12. status langkah alat sama dengan yang dilaporkan mesin",
  langkahAlat[1]?.status === "selesai" && langkahAlat[3]?.status === "gagal",
  potong(langkahAlat.map((l: any) => `${l.name}=${l.status}`)));
check("13. seq berurutan mulai dari 1 tanpa lompatan",
  langkah.every((l: any, i: number) => l.seq === i + 1) && langkah[0]?.seq === 1 && langkah[0]?.kind === "run",
  potong(langkah.map((l: any) => l.seq)));
const idxSelesai = langkah.findIndex((l: any) => l.kind === "selesai");
const idxAlatTerakhir = langkah.map((l: any) => l.kind).lastIndexOf("alat");
check("14. langkah alat berada SEBELUM langkah selesai (urutan waktu dihormati)", idxAlatTerakhir >= 0 && idxSelesai > idxAlatTerakhir,
  `alat terakhir=${idxAlatTerakhir} selesai=${idxSelesai}`);
check("15. ringkasan di layar dipendekkan supaya daftar tetap terbaca",
  langkahAlat.every((l: any) => typeof l.summary === "string" && l.summary.length <= 240) && String(langkahAlat[2]?.summary ?? "").includes("xxx"),
  `maks=${Math.max(...langkahAlat.map((l: any) => String(l.summary ?? "").length))}`);
check("16. catatan timeline menyebut jumlah baris run_events yang benar-benar dibaca",
  String(linimasa.json?.catatan ?? "").includes(`${langkah.length} langkah disusun dari`) && String(linimasa.json?.catatan ?? "").includes("tidak ada langkah yang dikarang"),
  potong(linimasa.json?.catatan, 200));

const penyusup = await siapkan("dua", "permintaan ruang kerja lain");
const linimasaAsing = await penyusup.c.call("GET", `/api/v1/runs/${putaran.runId}/timeline`);
check("17. run ruang kerja lain menjawab 404 RUN_NOT_FOUND (keberadaannya tidak bocor)",
  linimasaAsing.status === 404 && linimasaAsing.json?.error === "RUN_NOT_FOUND", `${linimasaAsing.status} ${potong(linimasaAsing.json, 120)}`);

const tanpaAlat = await siapkan("tiga", "kerjakan tanpa alat");
const barisTanpaAlat = db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='tool'").get(tanpaAlat.runId) as any;
const linimasaTanpaAlat = await tanpaAlat.c.call("GET", `/api/v1/runs/${tanpaAlat.runId}/timeline`);
const langkahTanpaAlat: any[] = Array.isArray(linimasaTanpaAlat.json?.langkah) ? linimasaTanpaAlat.json.langkah : [];
check("18. run tanpa alat selesai dan tidak melahirkan baris alat palsu", tanpaAlat.run?.status === "completed" && Number(barisTanpaAlat?.n ?? -1) === 0,
  `status=${tanpaAlat.run?.status} baris alat=${barisTanpaAlat?.n}`);
check("19. run tanpa alat tetap tampil rapi: run dibuat + run selesai, tanpa langkah alat",
  linimasaTanpaAlat.status === 200 && langkahTanpaAlat.length === 2 && langkahTanpaAlat[0]?.kind === "run" && langkahTanpaAlat[1]?.kind === "selesai",
  potong(langkahTanpaAlat.map((l: any) => `${l.seq}:${l.kind}`)));

console.log(`\n===================== RINGKASAN TIMELINE ALAT (butir 62) =====================`);
console.log(`Lulus: ${failures === 0 ? 19 : 19 - failures} · Gagal: ${failures}`);
console.log(failures === 0 ? "WAVE11B_TIMELINE_ALAT_PASSED" : "WAVE11B_TIMELINE_ALAT_FAILED");
process.exit(failures === 0 ? 0 : 1);

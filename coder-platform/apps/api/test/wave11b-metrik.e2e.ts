/**
 * Uji Wave 11B (v0.22.0) — metrik: butir 59, 60, 66, 67.
 *
 * Bagian di berkas ini:
 *   §2  (59) mode bayangan: jawaban identik saat mati/nyala, catatan terisi saat nyala dan kosong saat
 *             mati, kegagalan mencatat tidak menggagalkan run, non-admin ditolak
 *   §3  (60) pelajaran: terpisah dari memori biasa, bisa dimatikan, tidak menumpuk tanpa batas,
 *             ikut pagar konteks (terbukti dari gema appendSystem mesin tiruan + laporan pagar)
 *   §9  (66) laporan galat admin: galat tercatat, rahasia disaring, ekspor CSV benar, non-admin ditolak
 *   §10 (67) akuntansi token: saldo, terpakai, proyeksi (perkiraan), peringatan, bulan kosong, non-admin
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11b-metrik.e2e.ts
 *
 * Catatan jujur: berkas ini hanya menambah berkas uji baru; tidak ada berkas lain yang diubah.
 * Dua keadaan sengaja dirusak lalu dipulihkan untuk membuktikan jalur gagal-aman butir 59 (tabel
 * shadow_measurements) dan jalur galat server butir 66 (tabel prompt_templates diganti view rusak);
 * keduanya dipulihkan dari DDL yang dibaca sebelum dirusak, dan pemulihannya ikut diperiksa.
 */
import { createServer as createTcpServer } from "node:net";

/**
 * Mencari port bebas di rentang Wave 11B (7285-7299); nomor utama dicoba lebih dulu.
 *
 * Pemeriksaan wajib: bila ada server uji lain yang masih memegang port, permintaan uji bisa nyasar ke
 * server lama yang tidak tahu variabel lingkungan proses ini, dan hasilnya gagal palsu.
 */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 30 }, () => 7285 + Math.floor(Math.random() * 15))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang Wave 11B (7285-7299): ada server uji yang belum keluar?");
}

const port = await cariPortBebas(7289, 7290, 7291);
const dataDir = `/tmp/coder-wave11b-metrik-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11b-m-admin-${stamp}@example.test`;
const ownerEmail = `w11b-m-owner-${stamp}@example.test`;
const otherEmail = `w11b-m-other-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.NOTIFY_EMAIL_ENABLED = "false";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.CSRF_STRICT = "false";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.ERROR_EVENTS_ENABLED = "true";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const shadowMod: any = await import("../src/wave11b/shadow.js");
const learningsMod: any = await import("../src/wave11b/learnings.js");
const errorsMod: any = await import("../src/wave11b/errors.js");
const tokenMod: any = await import("../src/wave11b/token-accounting.js");

const base = `http://127.0.0.1:${port}`;
let passed = 0; let failed = 0; let total = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  total += 1;
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 200) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);

/** Klien HTTP kecil: jar cookie sendiri. */
function client(label: string) {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        origin: base,
        ...(jar.size ? { cookie: cookieHeader() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of setCookies) {
      const pair = String(entry).split(";")[0]; const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim(); const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const text = await response.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, headers: response.headers };
  }
  return { label, call, jar };
}

async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const ready = await fetch(`${base}/health`); if (ready.ok) return true; } catch { /* belum siap */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Menunggu satu run mencapai keadaan akhir (selesai atau gagal), lalu mengembalikan barisnya. */
async function waitRun(runId: string): Promise<any> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const row = db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as any;
    if (row && (row.status === "completed" || row.status === "failed")) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return db.prepare("SELECT * FROM runs WHERE id=?").get(runId);
}

/** Mengirim satu pesan dan menunggu run-nya berakhir; mengembalikan baris run. */
async function kirim(akun: ReturnType<typeof client>, conversationId: string, content: string): Promise<any> {
  const balas = await akun.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content });
  const runId = String(balas.json?.run?.id ?? "");
  if (!runId) return { __gagal: true, status: balas.status, body: balas.json };
  return waitRun(runId);
}

/** Jawaban TERAKHIR asisten pada satu percakapan (isi pesan ditulis bertahap, jadi run ditunggu). */
async function jawabanTerakhir(conversationId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = db.prepare(
      "SELECT m.content AS content, m.run_id AS runId, r.status AS status FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND m.role='assistant' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1",
    ).get(conversationId) as any;
    const akhir = row?.status === "completed" || row?.status === "failed" || (!row?.runId && Boolean(row?.content));
    if (row?.content && akhir) return String(row.content);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "";
}

/** Membuang awalan run-id mesin tiruan supaya dua jawaban bisa dibandingkan isinya. */
const tanpaAwalan = (text: string) => String(text ?? "").replace(/^\[mock:[0-9a-f]{8}\]\s*/, "");

/** DDL satu tabel beserta indeksnya, supaya keadaan yang sengaja dirusak bisa dipulihkan. */
function simpanDdl(table: string) {
  const tabel = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql?: string } | undefined;
  const indeks = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table) as { sql: string }[];
  return { tabel: String(tabel?.sql ?? ""), indeks: indeks.map((row) => row.sql) };
}
function pulihkanDdl(table: string, ddl: { tabel: string; indeks: string[] }) {
  db.exec(ddl.tabel);
  for (const sql of ddl.indeks) db.exec(sql);
}

const admin = client("admin"); const owner = client("owner"); const other = client("other");
const ready = await waitReady();
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), data di ${dataDir}`);
if (!ready) { console.log("FATAL server tidak siap"); process.exit(1); }

console.log("\n--- Bagian 0: akun, proyek, percakapan ---");
const adminReg = await admin.call("POST", "/api/v1/auth/register", { email: adminEmail, password, displayName: "Admin Metrik" });
check("0a. akun admin platform terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.user?.id), `${adminReg.status} ${short(adminReg.json)}`);
const ownerReg = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Metrik" });
const ownerId = String(ownerReg.json?.user?.id ?? ""); const ownerWs = String(ownerReg.json?.workspace?.id ?? "");
check("0b. akun pemilik terdaftar", ownerReg.status === 201 && Boolean(ownerId), `${ownerReg.status} ${short(ownerReg.json)}`);
const otherReg = await other.call("POST", "/api/v1/auth/register", { email: otherEmail, password, displayName: "Pengguna Lain" });
const otherId = String(otherReg.json?.user?.id ?? ""); const otherWs = String(otherReg.json?.workspace?.id ?? "");
check("0c. akun kedua terdaftar", otherReg.status === 201 && Boolean(otherId), `${otherReg.status} ${short(otherReg.json)}`);

const ownerProject = await owner.call("POST", `/api/v1/workspaces/${ownerWs}/projects`, { name: "Proyek Metrik" });
const ownerProjectId = String(ownerProject.json?.id ?? "");
check("0d. proyek pemilik dibuat", ownerProject.status === 201 && Boolean(ownerProjectId), `${ownerProject.status} ${short(ownerProject.json)}`);
const otherProject = await other.call("POST", `/api/v1/workspaces/${otherWs}/projects`, { name: "Proyek Lain" });
const otherProjectId = String(otherProject.json?.id ?? "");
check("0e. proyek pengguna lain dibuat", otherProject.status === 201 && Boolean(otherProjectId), `${otherProject.status} ${short(otherProject.json)}`);

const buatPercakapan = async (akun: ReturnType<typeof client>, projectId: string, title: string) => {
  const balas = await akun.call("POST", `/api/v1/projects/${projectId}/conversations`, { title });
  return String(balas.json?.conversation?.id ?? balas.json?.id ?? "");
};
const convShadow = await buatPercakapan(owner, ownerProjectId, "Percakapan Shadow");
check("0f. percakapan shadow dibuat", Boolean(convShadow), convShadow);
const convPelajaran = await buatPercakapan(owner, ownerProjectId, "Percakapan Pelajaran");
check("0g. percakapan pelajaran dibuat", Boolean(convPelajaran), convPelajaran);
const convLain = await buatPercakapan(other, otherProjectId, "Percakapan Lain");
check("0h. percakapan pengguna lain dibuat", Boolean(convLain), convLain);

// =====================================================================================
// §2 (butir 59) — Shadow-First Rollout
// =====================================================================================
console.log("\n--- Bagian 2 (butir 59): mode bayangan ---");
const PROMPT_SHADOW = "Tolong ukur konteks untuk perbandingan jawaban ini.";

const awal = await admin.call("GET", "/api/v1/admin/shadow");
check("2a. GET /admin/shadow sebagai admin -> 200 dan bawaan mode 'off'",
  awal.status === 200 && awal.json?.mode === "off" && Array.isArray(awal.json?.kinds) && awal.json.kinds.join(",") === "prompt,konteks",
  `${awal.status} ${short(awal.json)}`);

const setOff = await admin.call("PUT", "/api/v1/admin/shadow", { mode: "off" });
check("2b. PUT mode 'off' -> 200 diterapkanPadaRunBerikutnya true",
  setOff.status === 200 && setOff.json?.mode === "off" && setOff.json?.diterapkanPadaRunBerikutnya === true,
  `${setOff.status} ${short(setOff.json)}`);

const runA = await kirim(owner, convShadow, PROMPT_SHADOW);
check("2c. run pertama (mode mati) selesai 'completed' dan punya jawaban",
  !runA?.__gagal && runA?.status === "completed" && String(runA?.result ?? "").length > 0,
  `${runA?.status ?? runA?.status} ${short(runA?.result ?? runA?.body)}`);

const catatanSaatMati = count("SELECT COUNT(*) AS n FROM shadow_measurements WHERE run_id=?", runA.id);
check("2d. mode mati: TIDAK ada baris catatan untuk run itu",
  catatanSaatMati === 0, `baris=${catatanSaatMati}`);

const setOn = await admin.call("PUT", "/api/v1/admin/shadow", { mode: "on" });
check("2e. PUT mode 'on' -> 200", setOn.status === 200 && setOn.json?.mode === "on", `${setOn.status} ${short(setOn.json)}`);

const cekOn = await admin.call("GET", "/api/v1/admin/shadow");
check("2f. GET /admin/shadow melaporkan mode 'on' dan updatedAt terisi",
  cekOn.status === 200 && cekOn.json?.mode === "on" && typeof cekOn.json?.updatedAt === "string" && cekOn.json.updatedAt.length > 0,
  `${cekOn.status} ${short(cekOn.json)}`);

const runB = await kirim(owner, convShadow, PROMPT_SHADOW);
check("2g. run kedua (mode nyala) selesai 'completed'",
  !runB?.__gagal && runB?.status === "completed" && String(runB?.result ?? "").length > 0,
  `${runB?.status ?? runB?.body} ${short(runB?.result ?? runB?.body)}`);

check("2h. jawaban run IDENTIK saat mode mati dan nyala (gema mesin tiruan, awalan run-id dibuang)",
  tanpaAwalan(String(runA?.result ?? "")) === tanpaAwalan(String(runB?.result ?? "")) && tanpaAwalan(String(runB?.result ?? "")).length > 0,
  `A=${short(tanpaAwalan(String(runA?.result ?? "")), 160)} B=${short(tanpaAwalan(String(runB?.result ?? "")), 160)}`);

check("2i. ukuran konteks yang dikirim tidak berubah (append_system_chars sama)",
  Number(runA?.append_system_chars) === Number(runB?.append_system_chars) && Number(runA?.prompt_chars) === Number(runB?.prompt_chars),
  `A: konteks=${runA?.append_system_chars} prompt=${runA?.prompt_chars} | B: konteks=${runB?.append_system_chars} prompt=${runB?.prompt_chars}`);

const barisCatatan = db.prepare("SELECT kind, chars, tokens_est AS tokensEst FROM shadow_measurements WHERE run_id=? ORDER BY kind").all(runB.id) as { kind: string; chars: number; tokensEst: number }[];
check("2j. mode nyala: dua baris catatan ditulis (kind prompt + konteks)",
  barisCatatan.length === 2 && barisCatatan.map((row) => row.kind).sort().join(",") === "konteks,prompt",
  short(barisCatatan));

const barisPrompt = barisCatatan.find((row) => row.kind === "prompt");
const barisKonteks = barisCatatan.find((row) => row.kind === "konteks");
check("2k. baris 'prompt' mencatat panjang prompt yang sebenarnya (cocok kolom runs.prompt_chars)",
  Boolean(barisPrompt) && barisPrompt!.chars === Number(runB.prompt_chars),
  `catatan=${barisPrompt?.chars} runs=${runB.prompt_chars}`);
check("2l. baris 'konteks' mencatat panjang sisipan yang sebenarnya (cocok kolom runs.append_system_chars)",
  Boolean(barisKonteks) && barisKonteks!.chars === Number(runB.append_system_chars),
  `catatan=${barisKonteks?.chars} runs=${runB.append_system_chars}`);
check("2m. tokens_est adalah perkiraan chars/4 dibulatkan ke atas, bukan pemakaian nyata",
  barisPrompt!.tokensEst === Math.ceil(barisPrompt!.chars / 4) && barisKonteks!.tokensEst === Math.ceil(barisKonteks!.chars / 4),
  short(barisCatatan));

const modeSalah = await admin.call("PUT", "/api/v1/admin/shadow", { mode: "kadang" });
check("2n. PUT mode tak dikenal -> 400 INVALID_SHADOW_MODE dengan pesan yang benar",
  modeSalah.status === 400 && modeSalah.json?.error === "INVALID_SHADOW_MODE" && modeSalah.json?.message === "Mode bayangan hanya 'on' atau 'off'.",
  `${modeSalah.status} ${short(modeSalah.json)}`);

const ukurNonAdmin = await owner.call("GET", "/api/v1/admin/shadow/measurements");
check("2o. GET /admin/shadow/measurements oleh non-admin -> 403 ADMIN_REQUIRED",
  ukurNonAdmin.status === 403 && ukurNonAdmin.json?.error === "ADMIN_REQUIRED", `${ukurNonAdmin.status} ${short(ukurNonAdmin.json)}`);
const ubahNonAdmin = await owner.call("PUT", "/api/v1/admin/shadow", { mode: "on" });
check("2p. PUT /admin/shadow oleh non-admin -> 403 ADMIN_REQUIRED",
  ubahNonAdmin.status === 403 && ubahNonAdmin.json?.error === "ADMIN_REQUIRED", `${ubahNonAdmin.status} ${short(ubahNonAdmin.json)}`);
const lihatNonAdmin = await owner.call("GET", "/api/v1/admin/shadow");
check("2q. GET /admin/shadow oleh non-admin -> 403 ADMIN_REQUIRED",
  lihatNonAdmin.status === 403 && lihatNonAdmin.json?.error === "ADMIN_REQUIRED", `${lihatNonAdmin.status} ${short(lihatNonAdmin.json)}`);

const ukur = await admin.call("GET", "/api/v1/admin/shadow/measurements?limit=10");
check("2r. GET /admin/shadow/measurements -> total, byKind, dan catatan 'perkiraan'",
  ukur.status === 200 && Number(ukur.json?.total) >= 2 && Number(ukur.json?.byKind?.prompt) >= 1 && Number(ukur.json?.byKind?.konteks) >= 1
  && ukur.json?.catatan === "Angka ini PERKIRAAN ukuran, bukan perilaku." && Array.isArray(ukur.json?.akhir),
  `${ukur.status} ${short(ukur.json)}`);

// Kegagalan mencatat TIDAK boleh menggagalkan run: tabel catatan sengaja dihilangkan, lalu dipulihkan.
const ddlShadow = simpanDdl("shadow_measurements");
if (!ddlShadow.tabel) { skip("2s. kegagalan mencatat tidak menggagalkan run", "DDL shadow_measurements tidak terbaca"); }
else {
  db.exec("DROP TABLE shadow_measurements");
  const runC = await kirim(owner, convShadow, PROMPT_SHADOW);
  check("2s. tabel catatan hilang -> run tetap 'completed' dan jawabannya tidak berubah",
    !runC?.__gagal && runC?.status === "completed" && tanpaAwalan(String(runC?.result ?? "")) === tanpaAwalan(String(runA?.result ?? "")),
    `status=${runC?.status ?? runC?.body} hasil=${short(runC?.result ?? runC?.body, 160)}`);
  check("2t. tabel catatan benar-benar hilang saat run itu (bukti kegagalan dicatat dilewati)",
    count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='shadow_measurements'") === 0, "tabel masih ada");
  pulihkanDdl("shadow_measurements", ddlShadow);
  check("2u. tabel catatan dipulihkan dan route pengukuran jalan lagi",
    count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='shadow_measurements'") === 1
    && (await admin.call("GET", "/api/v1/admin/shadow/measurements?limit=5")).status === 200,
    short(ddlShadow.tabel, 80));
  check("2v. kegagalan mencatat TIDAK menyisakan baris palsu untuk run itu",
    count("SELECT COUNT(*) AS n FROM shadow_measurements WHERE run_id=?", runC.id) === 0, "ada baris untuk run C");
}

const kembaliOff = await admin.call("PUT", "/api/v1/admin/shadow", { mode: "off" });
check("2w. mode dikembalikan 'off' dan pengukuran berhenti menambah baris",
  kembaliOff.status === 200 && kembaliOff.json?.mode === "off" && shadowMod.shadowModeActive() === false,
  `${kembaliOff.status} ${short(kembaliOff.json)}`);

// =====================================================================================
// §3 (butir 60) — Learnings Registry
// =====================================================================================
console.log("\n--- Bagian 3 (butir 60): pelajaran ---");
const MARKER_PELAJARAN = "PENANDA-PELAJARAN-UTAMA";
const MARKER_MEMORI = "PENANDA-MEMORI-BIASA";

const buatPelajaran = await owner.call("POST", "/api/v1/learnings", {
  title: "Selalu periksa log server dulu",
  body: `${MARKER_PELAJARAN}: sebelum mengubah kode, baca log galat terbaru supaya akarnya kelihatan.`,
  tags: "kerja",
});
const pelajaranId = String(buatPelajaran.json?.learning?.id ?? "");
check("3a. POST /learnings -> 201 dan barisnya tersimpan dengan kind='learning'",
  buatPelajaran.status === 201 && Boolean(pelajaranId)
  && count("SELECT COUNT(*) AS n FROM agent_memories WHERE id=? AND kind='learning'", pelajaranId) === 1,
  `${buatPelajaran.status} ${short(buatPelajaran.json)}`);

const daftarPelajaran = await owner.call("GET", "/api/v1/learnings");
check("3b. GET /learnings melaporkan total 1, activeCount 1, batas aktif 12, batas total 50",
  daftarPelajaran.status === 200 && daftarPelajaran.json?.total === 1 && daftarPelajaran.json?.activeCount === 1
  && daftarPelajaran.json?.activeLimit === 12 && daftarPelajaran.json?.maxTotal === 50,
  `${daftarPelajaran.status} ${short(daftarPelajaran.json)}`);

const buatMemori = await owner.call("POST", "/api/v1/memories", { title: "Catatan memori biasa", body: `${MARKER_MEMORI}: fakta yang tidak berubah.` });
check("3c. memori biasa tetap bisa dibuat dan ber-kind 'memory'",
  buatMemori.status === 201 && count("SELECT COUNT(*) AS n FROM agent_memories WHERE id=? AND kind='memory'", String(buatMemori.json?.memory?.id ?? "")) === 1,
  `${buatMemori.status} ${short(buatMemori.json)}`);

// Pelajaran dan memori biasa memang satu tabel (agent_memories), jadi pemisahannya harus terbukti
// pada dua tempat: daftar memori (kind disaring) dan rute ubah/hapus memori (kind disaring).
const daftarMemori = await owner.call("GET", "/api/v1/memories");
const judulMemori = (daftarMemori.json?.memories ?? []).map((row: any) => row.title);
check("3d. GET /memories hanya memuat satu baris ber-kind 'memory' (bank memori biasa tidak bertambah)",
  daftarMemori.status === 200 && judulMemori.length === 1 && judulMemori[0] === "Catatan memori biasa"
  && count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='memory'", ownerId) === 1,
  `${daftarMemori.status} judul=${short(judulMemori)} memori=${count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='memory'", ownerId)}`);
check("3d2. pelajaran TIDAK ikut tampil di daftar memori (walaupun tabelnya sama)",
  daftarMemori.status === 200 && !judulMemori.includes("Selalu periksa log server dulu")
  && count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='learning'", ownerId) === 1,
  `judul=${short(judulMemori)} pelajaran=${count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='learning'", ownerId)}`);

// Kontrol: rute memori memang bekerja untuk baris memori biasa. Tanpa kontrol ini, 404 di bawah
// bisa saja terjadi karena rutenya rusak, bukan karena penyaringan kind.
const kontrolUbahMemori = await owner.call("PATCH", `/api/v1/memories/${String(buatMemori.json?.memory?.id ?? "")}`, { title: "Catatan memori biasa" });
check("3d2b. kontrol: PATCH /memories/:id dengan id memori biasa -> 200 (rute memang bekerja)",
  kontrolUbahMemori.status === 200 && kontrolUbahMemori.json?.memory?.id === String(buatMemori.json?.memory?.id ?? ""),
  `${kontrolUbahMemori.status} ${short(kontrolUbahMemori.json)}`);

const ubahPelajaranLewatMemori = await owner.call("PATCH", `/api/v1/memories/${pelajaranId}`, { title: "Dibajak lewat rute memori" });
check("3d3. PATCH /memories/:id memakai id pelajaran -> 404 MEMORY_NOT_FOUND (bukan diam-diam berhasil)",
  ubahPelajaranLewatMemori.status === 404 && ubahPelajaranLewatMemori.json?.error === "MEMORY_NOT_FOUND",
  `${ubahPelajaranLewatMemori.status} ${short(ubahPelajaranLewatMemori.json)}`);
const hapusPelajaranLewatMemori = await owner.call("DELETE", `/api/v1/memories/${pelajaranId}`);
check("3d4. DELETE /memories/:id memakai id pelajaran -> 404 MEMORY_NOT_FOUND dan barisnya tetap ada",
  hapusPelajaranLewatMemori.status === 404 && hapusPelajaranLewatMemori.json?.error === "MEMORY_NOT_FOUND"
  && count("SELECT COUNT(*) AS n FROM agent_memories WHERE id=?", pelajaranId) === 1,
  `${hapusPelajaranLewatMemori.status} ${short(hapusPelajaranLewatMemori.json)}`);
const pelajaranUtuh = db.prepare("SELECT kind, title, body, enabled FROM agent_memories WHERE id=?").get(pelajaranId) as any;
check("3d5. dua percobaan di atas tidak mengubah pelajaran sama sekali (judul, isi, kind, enabled)",
  pelajaranUtuh?.kind === "learning" && pelajaranUtuh?.title === "Selalu periksa log server dulu"
  && String(pelajaranUtuh?.body ?? "").includes(MARKER_PELAJARAN) && Number(pelajaranUtuh?.enabled) === 1,
  short(pelajaranUtuh, 200));

const runPelajaran = await kirim(owner, convPelajaran, "Sebutkan pelajaran yang kamu pegang sekarang.");
const gemaPelajaran = tanpaAwalan(String(runPelajaran?.result ?? ""));
check("3e. pelajaran aktif ikut sampai ke mesin lewat appendSystem (gema mesin tiruan)",
  runPelajaran?.status === "completed" && gemaPelajaran.includes(MARKER_PELAJARAN), short(gemaPelajaran, 300));

const useCountAwal = Number((db.prepare("SELECT use_count AS n FROM agent_memories WHERE id=?").get(pelajaranId) as { n: number }).n);
check("3f. use_count pelajaran naik saat benar-benar dikirim", useCountAwal === 1, `use_count=${useCountAwal}`);

const matikan = await owner.call("PATCH", `/api/v1/learnings/${pelajaranId}`, { enabled: false });
check("3g. pelajaran bisa dimatikan lewat PATCH",
  matikan.status === 200 && Number(matikan.json?.learning?.enabled) === 0, `${matikan.status} ${short(matikan.json)}`);

const runMati = await kirim(owner, convPelajaran, "Sebutkan lagi pelajaran yang kamu pegang.");
check("3h. pelajaran yang mati TIDAK dikirim ke mesin",
  runMati?.status === "completed" && !tanpaAwalan(String(runMati?.result ?? "")).includes(MARKER_PELAJARAN), short(String(runMati?.result ?? ""), 300));

const bankMemori = db.prepare("SELECT COUNT(*) AS total, SUM(enabled) AS aktif FROM agent_memories WHERE user_id=? AND kind='memory'").get(ownerId) as { total: number; aktif: number };
const useCountSetelahMati = Number((db.prepare("SELECT use_count AS n FROM agent_memories WHERE id=?").get(pelajaranId) as { n: number }).n);
check("3i. mematikan pelajaran TIDAK mengubah bank memori biasa (jumlah dan enabled tetap)",
  Number(bankMemori.total) === 1 && Number(bankMemori.aktif) === 1,
  `memori total=${bankMemori.total} aktif=${bankMemori.aktif}`);
check("3j. pelajaran yang mati juga tidak menambah use_count", useCountSetelahMati === useCountAwal, `use_count=${useCountSetelahMati}`);

const nyalakan = await owner.call("PATCH", `/api/v1/learnings/${pelajaranId}`, { enabled: true });
check("3k. pelajaran bisa dinyalakan lagi dan isinya tidak berubah",
  nyalakan.status === 200 && Number(nyalakan.json?.learning?.enabled) === 1
  && String(nyalakan.json?.learning?.body ?? "").includes(MARKER_PELAJARAN), `${nyalakan.status} ${short(nyalakan.json)}`);

const laporanPagar = await owner.call("GET", "/api/v1/context-budget/report");
const blokPelajaran = (laporanPagar.json?.blocks ?? []).find((block: any) => block.name === "pelajaran_pengguna");
check("3l. pelajaran ikut pagar konteks butir 80 (muncul sebagai blok 'pelajaran_pengguna' yang terkirim)",
  laporanPagar.status === 200 && Boolean(blokPelajaran) && blokPelajaran?.terkirim === true && Number(blokPelajaran?.chars) > 0,
  `${laporanPagar.status} ${short(blokPelajaran ?? laporanPagar.json)}`);

const runNyalakan = await kirim(owner, convPelajaran, "Sebutkan pelajaran yang berlaku untuk sesi ini.");
const useCountNyalakan = Number((db.prepare("SELECT use_count AS n FROM agent_memories WHERE id=?").get(pelajaranId) as { n: number }).n);
check("3m. setelah dinyalakan, pelajaran dikirim lagi dan use_count naik jadi 2",
  tanpaAwalan(String(runNyalakan?.result ?? "")).includes(MARKER_PELAJARAN) && useCountNyalakan === 2, `use_count=${useCountNyalakan}`);

const patchMemoriLewatPelajaran = await owner.call("PATCH", `/api/v1/learnings/${String(buatMemori.json?.memory?.id ?? "")}`, { enabled: false });
check("3n. rute pelajaran tidak bisa menyentuh memori biasa -> 404 LEARNING_NOT_FOUND",
  patchMemoriLewatPelajaran.status === 404 && patchMemoriLewatPelajaran.json?.error === "LEARNING_NOT_FOUND",
  `${patchMemoriLewatPelajaran.status} ${short(patchMemoriLewatPelajaran.json)}`);

const pelajaranKosong = await owner.call("POST", "/api/v1/learnings", { title: "", body: "" });
check("3o. POST /learnings tanpa judul/isi -> 400 INVALID_LEARNING",
  pelajaranKosong.status === 400 && pelajaranKosong.json?.error === "INVALID_LEARNING"
  && pelajaranKosong.json?.message === "Judul dan isi pelajaran wajib diisi.",
  `${pelajaranKosong.status} ${short(pelajaranKosong.json)}`);

const hapusSementara = await owner.call("POST", "/api/v1/learnings", { title: "Pelajaran sementara", body: "Dibuat hanya untuk diuji hapus." });
const idHapus = String(hapusSementara.json?.learning?.id ?? "");
const hapusPelajaran = await owner.call("DELETE", `/api/v1/learnings/${idHapus}`);
check("3p. DELETE /learnings/:id -> 200 deleted true dan barisnya hilang dari basis data",
  hapusPelajaran.status === 200 && hapusPelajaran.json?.deleted === true
  && count("SELECT COUNT(*) AS n FROM agent_memories WHERE id=?", idHapus) === 0,
  `${hapusPelajaran.status} ${short(hapusPelajaran.json)}`);
const hapusLagi = await owner.call("DELETE", `/api/v1/learnings/${idHapus}`);
check("3q. menghapus pelajaran yang sudah tidak ada -> 404 LEARNING_NOT_FOUND",
  hapusLagi.status === 404 && hapusLagi.json?.error === "LEARNING_NOT_FOUND", `${hapusLagi.status} ${short(hapusLagi.json)}`);

// Pengguna lain tidak boleh menyentuh pelajaran pemilik.
const kurangiOrangLain = await other.call("PATCH", `/api/v1/learnings/${pelajaranId}`, { title: "Diubah orang lain" });
check("3r. pengguna lain tidak bisa mengubah pelajaran milik orang lain -> 404",
  kurangiOrangLain.status === 404 && kurangiOrangLain.json?.error === "LEARNING_NOT_FOUND", `${kurangiOrangLain.status} ${short(kurangiOrangLain.json)}`);

// Batas aktif 12: 13 pelajaran aktif, hanya 12 yang boleh sampai ke mesin.
const idPelajaranLain: string[] = [];
for (let i = 1; i <= 13; i += 1) {
  const id = `w11b-lain-${stamp}-${i}`;
  const waktu = new Date(Date.now() + i * 1000).toISOString();
  db.prepare("INSERT INTO agent_memories (id,user_id,workspace_id,title,body,tags,pinned,enabled,use_count,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,'learning',?,?)")
    .run(id, otherId, null, `Pelajaran lain ${i}`, `TANDA-${i}: isi pelajaran nomor ${i}.`, "", 0, 1, waktu, waktu);
  idPelajaranLain.push(id);
}
const daftarLain = await other.call("GET", "/api/v1/learnings");
check("3s. pengguna lain hanya melihat pelajarannya sendiri (total 13, bukan campur milik pemilik)",
  daftarLain.status === 200 && daftarLain.json?.total === 13 && daftarLain.json?.activeCount === 13,
  `${daftarLain.status} ${short(daftarLain.json)}`);
const runLain = await kirim(other, convLain, "Sebutkan pelajaran yang berlaku untukmu sekarang.");
const gemaLain = tanpaAwalan(String(runLain?.result ?? ""));
const tandaTerdapat = new Set((gemaLain.match(/TANDA-(\d+)/g) ?? []).map((item) => item));
check("3t. dari 13 pelajaran aktif, tepat 12 yang disuntikkan (batas aktif dihormati)",
  tandaTerdapat.size === 12, `terkirim=${tandaTerdapat.size} ${short([...tandaTerdapat].join(","), 200)}`);
check("3u. pelajaran terbaru yang dipakai dan yang paling lama tidak dikirim",
  gemaLain.includes("TANDA-13") && !gemaLain.includes("TANDA-1:"), short(gemaLain, 200));

// Batas total 50: pelajaran ke-51 ditolak.
for (let i = 1; i <= 49; i += 1) {
  const id = `w11b-owner-padat-${stamp}-${i}`;
  const waktu = new Date(Date.now() + i * 1000).toISOString();
  db.prepare("INSERT INTO agent_memories (id,user_id,workspace_id,title,body,tags,pinned,enabled,use_count,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,'learning',?,?)")
    .run(id, ownerId, null, `Pelajaran padat ${i}`, `Isi pelajaran padat ${i}.`, "", 0, 1, waktu, waktu);
}
const sebelumBatas = count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='learning'", ownerId);
const pelajaranKe51 = await owner.call("POST", "/api/v1/learnings", { title: "Pelajaran ke-51", body: "Tidak boleh masuk." });
check("3v. pelajaran ke-51 ditolak 400 LEARNINGS_LIMIT_REACHED dengan pesan 'Pelajaran maksimal 50 butir.'",
  sebelumBatas === 50 && pelajaranKe51.status === 400 && pelajaranKe51.json?.error === "LEARNINGS_LIMIT_REACHED"
  && pelajaranKe51.json?.message === "Pelajaran maksimal 50 butir.",
  `sebelum=${sebelumBatas} ${pelajaranKe51.status} ${short(pelajaranKe51.json)}`);
check("3w. penolakan ke-51 tidak menambah/mengurangi baris pelajaran (tetap 50)",
  count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='learning'", ownerId) === 50,
  `baris=${count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='learning'", ownerId)}`);
check("3x. seluruh pelajaran langsung (via DB) tidak menyentuh bank memori biasa",
  count("SELECT COUNT(*) AS n FROM agent_memories WHERE kind='memory'") === 1,
  `memori=${count("SELECT COUNT(*) AS n FROM agent_memories WHERE kind='memory'")}`);
check("3y. learningBlocks() hanya mengembalikan 12 id walau pelajaran aktif jauh lebih banyak",
  (learningsMod.learningBlocks(ownerId)?.learnings ?? []).length === 12 && learningBlocksPanjang(ownerId) > 12,
  `blok=${(learningsMod.learningBlocks(ownerId)?.learnings ?? []).length}`);

function learningBlocksPanjang(userId: string): number {
  return count("SELECT COUNT(*) AS n FROM agent_memories WHERE user_id=? AND kind='learning' AND enabled=1", userId);
}

// =====================================================================================
// §9 (butir 66) — Laporan galat admin + ekspor
// =====================================================================================
console.log("\n--- Bagian 9 (butir 66): laporan galat ---");
const galatSebelum = count("SELECT COUNT(*) AS n FROM error_events");

// Galat server nyata: tabel yang dipakai satu rute diganti view yang menunjuk tabel tidak ada.
// Nama tabel yang hilang memuat pola yang HARUS disaring (mirip kunci `sk-...`), jadi sekaligus
// membuktikan penyaringan rahasia pada pesan galat yang benar-benar datang dari penangan galat server.
const RAHASIA_TABEL = "sk-live-abcdefghij1234567890";
const ddlPromptTemplates = simpanDdl("prompt_templates");
let galatNyata: any = null;
if (!ddlPromptTemplates.tabel) { skip("9a. galat server nyata tercatat", "DDL prompt_templates tidak terbaca"); }
else {
  db.exec("DROP TABLE prompt_templates");
  db.exec(`CREATE VIEW prompt_templates AS SELECT * FROM "${RAHASIA_TABEL}"`);
  galatNyata = await owner.call("GET", "/api/v1/prompt-templates");
  check("9a. permintaan yang menabrak galat server dijawab 500 INTERNAL_ERROR",
    galatNyata.status === 500 && galatNyata.json?.error === "INTERNAL_ERROR", `${galatNyata.status} ${short(galatNyata.json)}`);
  db.exec("DROP VIEW prompt_templates");
  pulihkanDdl("prompt_templates", ddlPromptTemplates);
  const pulih = await owner.call("GET", "/api/v1/prompt-templates");
  check("9b. tabel yang dirusak dipulihkan dan rutenya jalan lagi (200)",
    pulih.status === 200 && count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='prompt_templates'") === 1,
    `${pulih.status} ${short(pulih.json)}`);
}

const barisGalat = db.prepare("SELECT id, kind, code, message, run_id AS runId, user_id AS userId, created_at AS createdAt FROM error_events ORDER BY created_at DESC, rowid DESC LIMIT 5").all() as any[];
check("9c. galat server tercatat di error_events (bertambah dibanding sebelum kejadian)",
  count("SELECT COUNT(*) AS n FROM error_events") > galatSebelum && barisGalat.length > 0,
  `sebelum=${galatSebelum} sesudah=${count("SELECT COUNT(*) AS n FROM error_events")}`);
const barisServer = barisGalat.find((row) => row.kind === "server");
check("9d. baris galat memuat kind 'server' dan code mesin yang tidak kosong",
  Boolean(barisServer) && barisServer!.code === "SQLITE_ERROR", short(barisServer));
check("9e. pesan galat TIDAK memuat rahasia; bagian rahasia diganti penanda [disunting]",
  Boolean(barisServer) && !String(barisServer!.message).includes(RAHASIA_TABEL) && String(barisServer!.message).includes("[disunting]"),
  short(barisServer?.message));
check("9f. baris galat menyimpan pengguna yang sedang memanggil (user_id terisi)",
  Boolean(barisServer) && barisServer!.userId === ownerId, `userId=${barisServer?.userId}`);

// Penyaringan langsung pada fungsinya: semua pola rahasia wajib hilang sebelum disimpan.
// `kunciApi` meniru kunci API platform yang sebenarnya (`apikeys.ts`: `ck_` + 20 bita heksadesimal).
// Sebelum perbaikan audit, kunci bentuk ini LEWAT utuh karena garis bawah bukan pemisah kata.
const kunciApi = `ck_${"ab12".repeat(10)}`;
const pesanKotor = `Gagal klaim untuk Bearer abcdefGHIJK1234567890xyz; password=RahasiaSangat123; SECRETS_KEY=zzz999; api_key=KEYABC123456; sk-abcdef123456; isi enc:v1:QUJDREVGRA==; kunci ${kunciApi}; tanpa label ${kunciApi}`;
errorsMod.recordErrorEvent({ kind: "uji", code: "UJI_RAHASIA", message: pesanKotor, runId: null, userId: ownerId });
const barisUji = db.prepare("SELECT id, kind, code, message, user_id AS userId FROM error_events WHERE code='UJI_RAHASIA' ORDER BY rowid DESC LIMIT 1").get() as any;
check("9g. recordErrorEvent menyaring Bearer, password=, SECRETS_KEY=, api_key=, sk-, enc:v1:, dan kunci ck_:",
  Boolean(barisUji)
  && !barisUji.message.includes("abcdefGHIJK1234567890xyz") && !barisUji.message.includes("RahasiaSangat123")
  && !barisUji.message.includes("zzz999") && !barisUji.message.includes("KEYABC123456")
  && !barisUji.message.includes("sk-abcdef123456") && !barisUji.message.includes("QUJDREVGRA==")
  && !barisUji.message.includes(kunciApi)
  && barisUji.message.includes("[disunting]"),
  short(barisUji?.message, 300));
check("9h. penyaringan tidak menghapus bagian pesan yang tidak rahasia (pesan tetap bisa dibaca)",
  Boolean(barisUji) && barisUji.message.includes("Gagal klaim untuk Bearer") && barisUji.message.includes("password="),
  short(barisUji?.message, 200));

let melempar = false;
try {
  errorsMod.recordErrorEvent({ kind: undefined, code: undefined, message: undefined as any, runId: undefined, userId: undefined });
  errorsMod.recordErrorEvent({ message: "pesan biasa tanpa rahasia" });
  errorsMod.recordErrorEvent({ message: { aneh: true } as any });
} catch { melempar = true; }
check("9i. recordErrorEvent gagal-aman: masukan aneh tidak pernah melempar", melempar === false, "fungsi melempar");

const daftarGalat = await admin.call("GET", "/api/v1/admin/errors?limit=100");
check("9j. GET /admin/errors sebagai admin -> 200 dengan total & rows",
  daftarGalat.status === 200 && Number(daftarGalat.json?.total) >= 3 && Array.isArray(daftarGalat.json?.rows)
  && daftarGalat.json.rows.length >= 3, `${daftarGalat.status} ${short(daftarGalat.json, 220)}`);
check("9k. total baris laporan sama dengan jumlah baris di tabel",
  Number(daftarGalat.json?.total) === count("SELECT COUNT(*) AS n FROM error_events"),
  `laporan=${daftarGalat.json?.total} tabel=${count("SELECT COUNT(*) AS n FROM error_events")}`);

const saringJenis = await admin.call("GET", "/api/v1/admin/errors?kind=uji");
check("9l. filter kind bekerja (kind=uji hanya mengembalikan baris uji)",
  saringJenis.status === 200 && Number(saringJenis.json?.total) >= 1
  && (saringJenis.json?.rows ?? []).every((row: any) => row.kind === "uji"),
  `${saringJenis.status} ${short(saringJenis.json, 200)}`);
const jenisKosong = await admin.call("GET", "/api/v1/admin/errors?kind=tidak-ada");
check("9m. filter kind yang tidak ada -> total 0", jenisKosong.status === 200 && Number(jenisKosong.json?.total) === 0, short(jenisKosong.json, 160));

const hariIni = new Date().toISOString().slice(0, 10);
const saringDari = await admin.call("GET", `/api/v1/admin/errors?from=${hariIni}`);
check("9n. filter from=<hari ini> mengembalikan baris hari ini",
  saringDari.status === 200 && Number(saringDari.json?.total) >= 3, `${saringDari.status} ${short(saringDari.json, 160)}`);
const saringSampai = await admin.call("GET", "/api/v1/admin/errors?to=2000-01-01");
check("9o. filter to=2000-01-01 -> total 0", saringSampai.status === 200 && Number(saringSampai.json?.total) === 0, short(saringSampai.json, 160));
const saringRusak = await admin.call("GET", "/api/v1/admin/errors?from=bukan-tanggal");
check("9p. from yang tidak bisa diuraikan -> 400 INVALID_DATE (bukan diam-diam diabaikan)",
  saringRusak.status === 400 && saringRusak.json?.error === "INVALID_DATE", `${saringRusak.status} ${short(saringRusak.json)}`);

const batasSatu = await admin.call("GET", "/api/v1/admin/errors?limit=1");
check("9q. limit=1 membatasi rows jadi 1 tetapi total tetap jumlah seluruh baris",
  Number(batasSatu.json?.rows?.length) === 1 && Number(batasSatu.json?.total) === count("SELECT COUNT(*) AS n FROM error_events"),
  `${batasSatu.status} ${short(batasSatu.json, 200)}`);

const ekspor = await admin.call("GET", "/api/v1/admin/errors/export.csv");
const tipeKonten = String(ekspor.headers.get("content-type") ?? "");
const disposisi = String(ekspor.headers.get("content-disposition") ?? "");
check("9r. ekspor CSV -> 200 text/csv dengan lampiran coder-error-events.csv",
  ekspor.status === 200 && tipeKonten.startsWith("text/csv") && disposisi.includes("attachment") && disposisi.includes("coder-error-events.csv"),
  `${ekspor.status} ${tipeKonten} ${disposisi}`);
const barisCsv = ekspor.text.trimEnd().split("\n");
check("9s. header CSV tepat 7 kolom sesuai kontrak",
  barisCsv[0] === "id,kind,code,runId,userId,message,createdAt", short(barisCsv[0], 160));
check("9t. jumlah baris CSV sama dengan jumlah baris tabel + 1 baris header",
  barisCsv.length === count("SELECT COUNT(*) AS n FROM error_events") + 1,
  `csv=${barisCsv.length} tabel=${count("SELECT COUNT(*) AS n FROM error_events")}`);
const barisTanpaRahasia = barisCsv.slice(1).every((line) => !line.includes(RAHASIA_TABEL) && !line.includes("QUJDREVGRA==") && !line.includes("RahasiaSangat123"));
check("9u. tidak satu pun baris CSV memuat rahasia", barisTanpaRahasia,
  short(barisCsv.find((line) => line.includes(RAHASIA_TABEL)) ?? "", 200));
check("9v. ekspor memuat baris galat nyata (kode SQLITE_ERROR ada di CSV)",
  barisCsv.some((line) => line.includes("SQLITE_ERROR")), short(barisCsv.slice(1, 3).join(" | "), 260));

const galatNonAdmin = await owner.call("GET", "/api/v1/admin/errors");
check("9w. GET /admin/errors oleh non-admin -> 403 ADMIN_REQUIRED",
  galatNonAdmin.status === 403 && galatNonAdmin.json?.error === "ADMIN_REQUIRED", `${galatNonAdmin.status} ${short(galatNonAdmin.json)}`);
const eksporNonAdmin = await owner.call("GET", "/api/v1/admin/errors/export.csv");
check("9x. ekspor CSV oleh non-admin -> 403 ADMIN_REQUIRED",
  eksporNonAdmin.status === 403 && eksporNonAdmin.json?.error === "ADMIN_REQUIRED", `${eksporNonAdmin.status} ${short(eksporNonAdmin.json)}`);

// =====================================================================================
// §10 (butir 67) — Akuntansi token: saldo + proyeksi
// =====================================================================================
console.log("\n--- Bagian 10 (butir 67): akuntansi token ---");
const bulanIni = tokenMod.currentMonth();
const bulanKosong = "2024-02";

// Data buatan: tiga baris run_usage milik proyek pemilik + satu baris user_usage milik pengguna lain,
// semuanya di hari pertama bulan berjalan supaya selalu berada di masa lalu.
const tokenRun = [1000, 2500, 500];
const tokenUserLain = 1200;
const hariSatu = `${bulanIni}-01T01:00:00.000Z`;
for (let i = 0; i < tokenRun.length; i += 1) {
  const runId = `w11b-usage-${stamp}-${i}`;
  db.prepare("INSERT INTO runs (id,project_id,status,prompt,created_at) VALUES (?,?,?,?,?)").run(runId, ownerProjectId, "completed", "pemakaian uji", hariSatu);
  db.prepare("INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,total_tokens,cost_micros,estimated,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)")
    .run(`w11b-usage-row-${stamp}-${i}`, runId, ownerProjectId, "@cf/openai/gpt-oss-20b", "cloudflare", tokenRun[i] - 100, 100, tokenRun[i], 0, hariSatu);
}
db.prepare("INSERT INTO user_usage (id,user_id,run_id,source,model,provider,input_tokens,output_tokens,total_tokens,cost_micros,estimated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)")
  .run(`w11b-user-usage-${stamp}`, otherId, null, "playground", "@cf/openai/gpt-oss-20b", "cloudflare", tokenUserLain - 200, 200, tokenUserLain, 0, hariSatu);

/** Hitung ulang di uji: jumlah token pemakaian bulan itu dari dua tabel yang ada. */
function hitungTerpakai(month: string): number {
  const start = `${month}-01T00:00:00.000Z`;
  const [tahun, bulan] = month.split("-").map(Number);
  const next = bulan === 12 ? `${tahun + 1}-01-01T00:00:00.000Z` : `${tahun}-${String(bulan + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  const run = Number((db.prepare("SELECT COALESCE(SUM(COALESCE(total_tokens, COALESCE(input_tokens,0)+COALESCE(output_tokens,0))),0) AS n FROM run_usage WHERE created_at>=? AND created_at<?").get(start, next) as { n: number }).n);
  const user = Number((db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS n FROM user_usage WHERE created_at>=? AND created_at<?").get(start, next) as { n: number }).n);
  return run + user;
}
const terpakaiHarapan = hitungTerpakai(bulanIni);

const setSaldo = await admin.call("POST", "/api/v1/admin/token-budget", { month: bulanIni, tokens: 1_000_000, note: "saldo uji bulan ini" });
check("10a. POST /admin/token-budget -> 201 dengan month, saldo, note, updatedAt",
  setSaldo.status === 201 && setSaldo.json?.month === bulanIni && setSaldo.json?.saldo === 1_000_000
  && setSaldo.json?.note === "saldo uji bulan ini" && String(setSaldo.json?.updatedAt ?? "").length > 0,
  `${setSaldo.status} ${short(setSaldo.json)}`);

const akun = await admin.call("GET", `/api/v1/admin/token-accounting?month=${bulanIni}`);
check("10b. GET /admin/token-accounting -> 200 dan bulan yang diminta dikembalikan apa adanya",
  akun.status === 200 && akun.json?.month === bulanIni, `${akun.status} ${short(akun.json, 240)}`);
check("10c. saldo tersimpan dilaporkan (1.000.000)",
  Number(akun.json?.saldo) === 1_000_000, `saldo=${akun.json?.saldo}`);
check("10d. terpakai cocok dengan hitungan ulang dari run_usage + user_usage",
  Number(akun.json?.terpakai) === terpakaiHarapan && terpakaiHarapan >= 5200,
  `laporan=${akun.json?.terpakai} hitung=${terpakaiHarapan}`);
check("10e. sisa = saldo - terpakai (dan tidak pernah diam-diam dibulatkan)",
  Number(akun.json?.sisa) === 1_000_000 - terpakaiHarapan, `sisa=${akun.json?.sisa}`);

const jumlahHari = new Date(Date.UTC(Number(bulanIni.slice(0, 4)), Number(bulanIni.slice(5, 7)), 0)).getUTCDate();
const hariBerjalan = new Date().getUTCDate();
check("10f. daysInMonth sesuai jumlah hari bulan itu",
  Number(akun.json?.daysInMonth) === jumlahHari, `laporan=${akun.json?.daysInMonth} hitung=${jumlahHari}`);
check("10g. hari yang sudah lewat dilaporkan (daysElapsed = tanggal UTC hari ini)",
  Number(akun.json?.daysElapsed) === hariBerjalan && Number(akun.json?.daysElapsed) >= 1,
  `laporan=${akun.json?.daysElapsed} harap=${hariBerjalan}`);
check("10h. proyeksi = rata-rata harian x jumlah hari (dihitung ulang di uji)",
  Number(akun.json?.proyeksi) === Math.round((terpakaiHarapan / hariBerjalan) * jumlahHari),
  `laporan=${akun.json?.proyeksi} harap=${Math.round((terpakaiHarapan / hariBerjalan) * jumlahHari)}`);
check("10i. angka proyeksi SELALU disajikan sebagai perkiraan (perkiraan=true + catatan)",
  akun.json?.perkiraan === true && String(akun.json?.catatan ?? "").includes("PERKIRAAN"),
  `perkiraan=${akun.json?.perkiraan} catatan=${short(akun.json?.catatan, 240)}`);

const tokenPemilik = (akun.json?.perPengguna ?? []).find((row: any) => row.userId === ownerId);
const tokenLain = (akun.json?.perPengguna ?? []).find((row: any) => row.userId === otherId);
check("10j. perPengguna memuat pemilik dengan angka yang cocok dengan baris run_usage proyeknya",
  Boolean(tokenPemilik) && Number(tokenPemilik.tokens) === tokenPengguna(ownerId, bulanIni) && Number(tokenPemilik.tokens) >= tokenRun.reduce((a, b) => a + b, 0) && tokenPemilik.email === ownerEmail,
  `laporan=${short(tokenPemilik)} harap=${tokenPengguna(ownerId, bulanIni)}`);
/** Hitung ulang token satu pengguna: run_usage proyeknya + baris user_usage miliknya (rumus sama). */
function tokenPengguna(userId: string, month: string): number {
  const start = `${month}-01T00:00:00.000Z`;
  const [tahun, bulan] = month.split("-").map(Number);
  const next = bulan === 12 ? `${tahun + 1}-01-01T00:00:00.000Z` : `${tahun}-${String(bulan + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  const dariRun = Number((db.prepare(`SELECT COALESCE(SUM(COALESCE(ru.total_tokens, COALESCE(ru.input_tokens,0)+COALESCE(ru.output_tokens,0))),0) AS n
    FROM run_usage ru JOIN projects p ON p.id=ru.project_id JOIN memberships m ON m.workspace_id=p.workspace_id AND m.role='owner'
    WHERE m.user_id=? AND ru.created_at>=? AND ru.created_at<?`).get(userId, start, next) as { n: number }).n);
  const dariUser = Number((db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS n FROM user_usage WHERE user_id=? AND created_at>=? AND created_at<?").get(userId, start, next) as { n: number }).n);
  return dariRun + dariUser;
}
check("10k. perPengguna memuat pengguna lain dengan angka yang cocok (user_usage 1.200 + pemakaian run-nya)",
  Boolean(tokenLain) && Number(tokenLain.tokens) === tokenPengguna(otherId, bulanIni) && Number(tokenLain.tokens) >= tokenUserLain && tokenLain.email === otherEmail,
  `laporan=${short(tokenLain)} harap=${tokenPengguna(otherId, bulanIni)}`);
check("10l. jumlah perPengguna sama dengan total terpakai (tidak ada token yang hilang tanpa penjelasan)",
  (akun.json?.perPengguna ?? []).reduce((total: number, row: any) => total + Number(row.tokens), 0) === Number(akun.json?.terpakai),
  `perPengguna=${(akun.json?.perPengguna ?? []).reduce((total: number, row: any) => total + Number(row.tokens), 0)} terpakai=${akun.json?.terpakai}`);

const saldoBesar = await admin.call("POST", "/api/v1/admin/token-budget", { month: bulanIni, tokens: 10_000_000_000 });
const akunAman = await admin.call("GET", `/api/v1/admin/token-accounting?month=${bulanIni}`);
check("10m. proyeksi di bawah saldo: peringatan tidak muncul (null)",
  saldoBesar.status === 201 && Number(akunAman.json?.proyeksi) <= Number(akunAman.json?.saldo) && akunAman.json?.peringatan === null,
  `proyeksi=${akunAman.json?.proyeksi} saldo=${akunAman.json?.saldo} peringatan=${short(akunAman.json?.peringatan)}`);

const saldoKecil = await admin.call("POST", "/api/v1/admin/token-budget", { month: bulanIni, tokens: 1 });
const akunWaspada = await admin.call("GET", `/api/v1/admin/token-accounting?month=${bulanIni}`);
check("10n. proyeksi melebihi saldo: peringatan berisi kalimat yang menyebut melebihi saldo",
  saldoKecil.status === 201 && Number(akunWaspada.json?.proyeksi) > Number(akunWaspada.json?.saldo)
  && typeof akunWaspada.json?.peringatan === "string" && akunWaspada.json.peringatan.includes("melebihi saldo"),
  `proyeksi=${akunWaspada.json?.proyeksi} saldo=${akunWaspada.json?.saldo} peringatan=${short(akunWaspada.json?.peringatan)}`);

const akunKosong = await admin.call("GET", `/api/v1/admin/token-accounting?month=${bulanKosong}`);
check("10o. bulan tanpa data: terpakai 0, proyeksi 0, dan tidak ada pembagian nol",
  akunKosong.status === 200 && Number(akunKosong.json?.terpakai) === 0 && Number(akunKosong.json?.proyeksi) === 0
  && Number(akunKosong.json?.daysElapsed) === 29 && Number(akunKosong.json?.daysInMonth) === 29,
  `${akunKosong.status} ${short(akunKosong.json, 240)}`);
check("10p. bulan tanpa saldo tersimpan: saldo 0 dengan catatan bahwa admin belum mengisi saldo",
  Number(akunKosong.json?.saldo) === 0 && akunKosong.json?.updatedAt === null
  && String(akunKosong.json?.catatan ?? "").includes("belum diisi admin"),
  `saldo=${akunKosong.json?.saldo} updatedAt=${short(akunKosong.json?.updatedAt)} catatan=${short(akunKosong.json?.catatan, 240)}`);
check("10q. bulan lampau tanpa data tetap melaporkan seluruh hari bulan itu sudah lewat",
  Number(akunKosong.json?.daysElapsed) === 29, `daysElapsed=${akunKosong.json?.daysElapsed}`);

const bulanSalah = await admin.call("POST", "/api/v1/admin/token-budget", { month: "2026-13", tokens: 10 });
check("10r. POST bulan '2026-13' -> 400 INVALID_MONTH",
  bulanSalah.status === 400 && bulanSalah.json?.error === "INVALID_MONTH", `${bulanSalah.status} ${short(bulanSalah.json)}`);
const bacaBulanSalah = await admin.call("GET", "/api/v1/admin/token-accounting?month=bukan-bulan");
check("10s. GET bulan 'bukan-bulan' -> 400 INVALID_MONTH",
  bacaBulanSalah.status === 400 && bacaBulanSalah.json?.error === "INVALID_MONTH", `${bacaBulanSalah.status} ${short(bacaBulanSalah.json)}`);
const tokenMinus = await admin.call("POST", "/api/v1/admin/token-budget", { month: bulanIni, tokens: -5 });
check("10t. POST token negatif -> 400 INVALID_TOKENS",
  tokenMinus.status === 400 && tokenMinus.json?.error === "INVALID_TOKENS", `${tokenMinus.status} ${short(tokenMinus.json)}`);
const tokenTeks = await admin.call("POST", "/api/v1/admin/token-budget", { month: bulanIni, tokens: "abc" });
check("10u. POST token bukan angka -> 400 INVALID_TOKENS",
  tokenTeks.status === 400 && tokenTeks.json?.error === "INVALID_TOKENS", `${tokenTeks.status} ${short(tokenTeks.json)}`);
const lihatNonAdminAkun = await owner.call("GET", `/api/v1/admin/token-accounting?month=${bulanIni}`);
check("10v. GET token-accounting oleh non-admin -> 403 ADMIN_REQUIRED",
  lihatNonAdminAkun.status === 403 && lihatNonAdminAkun.json?.error === "ADMIN_REQUIRED", `${lihatNonAdminAkun.status} ${short(lihatNonAdminAkun.json)}`);
const isiNonAdmin = await owner.call("POST", "/api/v1/admin/token-budget", { month: bulanIni, tokens: 5 });
check("10w. POST token-budget oleh non-admin -> 403 ADMIN_REQUIRED",
  isiNonAdmin.status === 403 && isiNonAdmin.json?.error === "ADMIN_REQUIRED", `${isiNonAdmin.status} ${short(isiNonAdmin.json)}`);

// Pemanggilan langsung dengan waktu buatan: bulan lampau = penuh, bulan depan = 0 (tanpa pembagian nol).
const langsungLampau = tokenMod.tokenAccountingFor("2024-02", new Date("2026-09-15T00:00:00.000Z"));
check("10x. tokenAccountingFor bulan lampau menghitung daysElapsed = daysInMonth",
  langsungLampau?.daysElapsed === 29 && langsungLampau?.daysInMonth === 29 && langsungLampau?.terpakai === 0,
  short(langsungLampau, 200));
const langsungDepan = tokenMod.tokenAccountingFor("2030-05", new Date("2026-09-15T00:00:00.000Z"));
check("10y. tokenAccountingFor bulan yang belum berjalan: daysElapsed 0 dan proyeksi 0",
  langsungDepan?.daysElapsed === 0 && langsungDepan?.proyeksi === 0
  && String(langsungDepan?.catatan ?? "").includes("tidak ada pembagian nol"),
  short(langsungDepan, 240));
check("10z. tokenAccountingFor menolak bulan yang tidak berbentuk YYYY-MM dengan null",
  tokenMod.tokenAccountingFor("2026-13") === null && tokenMod.tokenAccountingFor("bukan-bulan") === null, "hasil bukan null");

console.log(`\nRINGKASAN Wave 11B metrik: lulus=${passed} gagal=${failed} total=${total}`);
if (skipped.length) console.log(`SKIP: ${skipped.join(" | ")}`);
if (failed) console.log(`GAGAL: ${failedNames.join(" | ")}`);
process.exit(failed ? 1 : 0);

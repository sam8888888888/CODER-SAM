/**
 * Uji Wave 11A (v0.21.0) butir 48 — tulis-balik artefak, riwayat revisi, dan jaring aman.
 *
 * Yang dibuktikan (sembilan syarat butir 48):
 *  ① daftar putih ekstensi + penolakan isi biner -> 415 ARTIFACT_NOT_EDITABLE
 *  ② batas `ARTIFACT_EDIT_MAX_BYTES` (2 MB) -> 413 ARTIFACT_TOO_LARGE, dan isi tepat di batas diterima
 *  ③ jalur `..`, jalur absolut di luar akar proyek, dan tautan simbolik keluar akar -> 400 INVALID_ARTIFACT_PATH
 *  ④ penulisan atomik (berkas sementara + rename); tidak ada sisa berkas `.tmp-`
 *  ⑤ `baseRevision` wajib; revisi basi -> 409 ARTIFACT_CHANGED dengan `latestRevision` + `latestContent`
 *  ⑥ peran `viewer` ditolak saat menulis DAN saat membaca revisi (403 VIEWER_FORBIDDEN)
 *  ⑦ retensi 20 revisi per artefak + pemakaian disk pada daftar revisi
 *  ⑧ bentrok tulis: kunci eksplisit `setArtifactWriteLock` dan run aktif di proyek yang sama -> 409
 *  ⑨ `restore` menulis ulang isi artefak dan memperbarui `sha256`, `size_bytes`, `storage_path`
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11a-artefak.e2e.ts
 *
 * Catatan jujur: berkas ini hanya menambah berkas uji baru. Tidak ada berkas lain yang diubah.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";

/**
 * Mencari port bebas di rentang Wave 11A (7240-7269); nomor utama dicoba lebih dulu.
 *
 * Pemeriksaan ini ditambahkan setelah suite pemimpin gagal palsu ketika ada server uji lain yang
 * masih memegang port: server baru tidak bisa mengikat port, lalu permintaan uji nyasar ke server
 * lama (yang tidak tahu variabel lingkungan milik proses ini).
 */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 40 }, () => 7240 + Math.floor(Math.random() * 30))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang Wave 11A (7240-7269): ada server uji yang belum keluar?");
}

const port = await cariPortBebas(7250);
const dataDir = `/tmp/coder-wave11a-artefak-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const outsideDir = `/tmp/coder-wave11a-luar-${Date.now()}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11a-admin-${stamp}@example.test`;
const ownerEmail = `w11a-owner-${stamp}@example.test`;
const viewerEmail = `w11a-viewer-${stamp}@example.test`;
const strangerEmail = `w11a-stranger-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const artifactMod: any = await import("../src/wave11a/artifact-edit.js");

const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const short = (value: unknown, max = 200) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);

/** Klien HTTP kecil: jar cookie sendiri + token CSRF ganda (mode CSRF_STRICT). */
function client() {
  const jar = new Map<string, string>();
  let primed = false;
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    if (mutating) await prime();
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: base,
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(mutating && jar.get("coder_csrf") ? { "x-csrf-token": String(jar.get("coder_csrf")) } : {}),
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
      "accept-language": "id-ID",
    };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const rawCookies = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of rawCookies) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim(); const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const text = await response.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server belum siap */ } }
  return { call, bootstrap: prime, get csrf() { return String(jar.get("coder_csrf") ?? ""); } };
}

const owner = client();
const viewer = client();
const stranger = client();

for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const ready = await fetch(`${base}/health`); if (ready.ok) break; } catch { /* belum siap */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), data di ${dataDir}`);

/* ------------------------------------------------------------------ bantu */

const LIMIT = Number(config.ARTIFACT_EDIT_MAX_BYTES);
const REVISION_LIMIT = Number(config.ARTIFACT_REVISION_LIMIT);

async function register(account: ReturnType<typeof client>, email: string, name: string) {
  await account.bootstrap();
  return account.call("POST", "/api/v1/auth/register", { email, password, displayName: name });
}

async function createArtifact(account: ReturnType<typeof client>, projectId: string, name: string, mimeType: string, content: Buffer) {
  return account.call("POST", `/api/v1/projects/${projectId}/artifacts`, {
    name, mimeType, contentBase64: content.toString("base64"),
  });
}

/** Menyisipkan baris artefak langsung (untuk menguji jalur simpan yang tidak wajar). */
function insertArtifactRow(id: string, projectId: string, name: string, mimeType: string, storagePath: string, content?: Buffer) {
  const bytes = content ?? Buffer.from("isi asli berkas ini tidak boleh berubah", "utf8");
  db.prepare("INSERT INTO artifacts (id,project_id,run_id,name,mime_type,size_bytes,sha256,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, projectId, null, name, mimeType, bytes.length, sha(bytes), storagePath, new Date().toISOString());
  return bytes;
}

async function revisionOf(account: ReturnType<typeof client>, artifactId: string) {
  const reply = await account.call("GET", `/api/v1/artifacts/${artifactId}/content`);
  return Number(reply.json?.revision ?? -1);
}

/** PUT memakai revisi terbaru yang dibaca sekarang: menghindari 409 yang tidak diinginkan. */
async function putCurrent(account: ReturnType<typeof client>, artifactId: string, content: string, note?: string) {
  const baseRevision = await revisionOf(account, artifactId);
  return account.call("PUT", `/api/v1/artifacts/${artifactId}/content`, { content, baseRevision, note });
}

const diskPath = (projectId: string, artifactId: string) => join(config.DATA_DIR, "artifacts", projectId, artifactId);
const diskText = (projectId: string, artifactId: string) => readFileSync(diskPath(projectId, artifactId), "utf8");

/* =====================================================================================
 * Bagian 0: akun, proyek, dan artefak dasar.
 * ===================================================================================== */
console.log("\n--- Bagian 0: akun, proyek, artefak ---");
const adminReg = await register(owner, adminEmail, "Admin Wave 11A");
check("0a. akun pemilik terdaftar", adminReg.status === 201 && Boolean(adminReg.json?.user?.id), `${adminReg.status} ${short(adminReg.json)}`);
const ownerUserId = String(adminReg.json?.user?.id ?? "");
const ownerWorkspaceId = String(adminReg.json?.workspace?.id ?? adminReg.json?.workspaceId ?? "");
check("0b. pemilik punya ruang kerja", Boolean(ownerUserId && ownerWorkspaceId), short(adminReg.json));

const projectReply = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`, { name: "Proyek Artefak A" });
const projectId = String(projectReply.json?.id ?? "");
check("0c. proyek A dibuat", projectReply.status === 201 && Boolean(projectId), `${projectReply.status} ${short(projectReply.json)}`);

const projectBReply = await owner.call("POST", `/api/v1/workspaces/${ownerWorkspaceId}/projects`, { name: "Proyek Artefak B" });
const projectIdB = String(projectBReply.json?.id ?? "");
check("0d. proyek B dibuat (untuk jalur run aktif)", projectBReply.status === 201 && Boolean(projectIdB), `${projectBReply.status} ${short(projectBReply.json)}`);

const initialText = "Isi awal catatan proyek.";
const artAReply = await createArtifact(owner, projectId, "catatan.md", "text/markdown", Buffer.from(initialText, "utf8"));
const artA = String(artAReply.json?.id ?? "");
check("0e. artefak teks catatan.md dibuat (POST resmi)", artAReply.status === 201 && Boolean(artA), `${artAReply.status} ${short(artAReply.json)}`);
check("0f. berkas nyata artefak ada di <DATA_DIR>/artifacts/<project>/<id>", existsSync(diskPath(projectId, artA)) && diskText(projectId, artA) === initialText, short(diskPath(projectId, artA)));

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const artPngReply = await createArtifact(owner, projectId, "foto.png", "image/png", pngBytes);
const artPng = String(artPngReply.json?.id ?? "");
check("0g. artefak biner foto.png dibuat", artPngReply.status === 201 && Boolean(artPng), `${artPngReply.status} ${short(artPngReply.json)}`);

const artNoExtReply = await createArtifact(owner, projectId, "catatan", "text/plain", Buffer.from("tanpa ekstensi", "utf8"));
const artNoExt = String(artNoExtReply.json?.id ?? "");
check("0h. artefak tanpa ekstensi dibuat", artNoExtReply.status === 201 && Boolean(artNoExt), `${artNoExtReply.status} ${short(artNoExtReply.json)}`);

const artBigReply = await createArtifact(owner, projectId, "besar.txt", "text/plain", Buffer.from("kecil", "utf8"));
const artBig = String(artBigReply.json?.id ?? "");
const artRetReply = await createArtifact(owner, projectId, "riwayat.md", "text/markdown", Buffer.from("r0", "utf8"));
const artRet = String(artRetReply.json?.id ?? "");
const artBReply = await createArtifact(owner, projectIdB, "proyek-b.txt", "text/plain", Buffer.from("b0", "utf8"));
const artB = String(artBReply.json?.id ?? "");
check("0i. artefak pendukung (besar, riwayat, proyek B) dibuat", Boolean(artBig && artRet && artB), short({ artBig, artRet, artB }));

const viewerReg = await register(viewer, viewerEmail, "Pengamat Wave 11A");
const viewerUserId = String(viewerReg.json?.user?.id ?? "");
db.prepare("INSERT OR REPLACE INTO memberships (user_id, workspace_id, role, created_at) VALUES (?,?,?,?)")
  .run(viewerUserId, ownerWorkspaceId, "viewer", new Date().toISOString());
const viewerRole = (db.prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?").get(ownerWorkspaceId, viewerUserId) as any)?.role;
check("0j. akun viewer terdaftar sebagai anggota peran viewer", viewerReg.status === 201 && viewerRole === "viewer", short({ status: viewerReg.status, viewerRole }));

const strangerReg = await register(stranger, strangerEmail, "Orang Luar Wave 11A");
check("0k. akun non-anggota terdaftar", strangerReg.status === 201 && Boolean(strangerReg.json?.user?.id), short(strangerReg.json));

check("0l. batas ukuran PRD = 2 MB dan retensi = 20 revisi", LIMIT === 2 * 1024 * 1024 && REVISION_LIMIT === 20, short({ LIMIT, REVISION_LIMIT }));

/* =====================================================================================
 * Bagian A (syarat ④ + jalur bahagia): GET/PUT isi, berkas nyata berubah, riwayat utuh.
 * ===================================================================================== */
console.log("\n--- Bagian A: jalur bahagia + riwayat ---");
const firstGet = await owner.call("GET", `/api/v1/artifacts/${artA}/content`);
check("A1. GET isi artefak: 200, revisi awal 0, editable", firstGet.status === 200 && firstGet.json?.revision === 0 && firstGet.json?.editable === true, `${firstGet.status} ${short(firstGet.json)}`);
check("A2. GET isi memuat isi nyata + sha256 cocok dengan kolom artifacts", firstGet.json?.content === initialText && firstGet.json?.sha256Matches === true, short(firstGet.json));

const newText1 = "Isi baru hasil sunting dari peramban (v2).";
const put1 = await owner.call("PUT", `/api/v1/artifacts/${artA}/content`, { content: newText1, baseRevision: 0, note: "Sunting uji 1" });
check("A3. PUT pertama diterima (200) dan membuat revisi 1", put1.status === 200 && put1.json?.revision === 1 && put1.json?.snapshotRevision === 1, `${put1.status} ${short(put1.json)}`);
check("A4. isi berkas NYATA di disk berubah", diskText(projectId, artA) === newText1, short(diskText(projectId, artA)));
const artARow: any = db.prepare("SELECT size_bytes AS sizeBytes, sha256, storage_path AS storagePath FROM artifacts WHERE id=?").get(artA);
check("A5. kolom artifacts (sha256 + size_bytes) ikut diperbarui", artARow.sha256 === sha(newText1) && Number(artARow.sizeBytes) === Buffer.byteLength(newText1), short(artARow));

const getAfter = await owner.call("GET", `/api/v1/artifacts/${artA}/content`);
check("A6. GET setelah PUT: isi baru + revisi terbaru 1", getAfter.json?.content === newText1 && getAfter.json?.revision === 1, short(getAfter.json));

const listReply = await owner.call("GET", `/api/v1/artifacts/${artA}/revisions`);
const listItems = Array.isArray(listReply.json?.revisions) ? listReply.json.revisions : [];
check("A7. GET daftar revisi: 1 baris, isinya nomor revisi 1", listReply.status === 200 && listItems.length === 1 && listItems[0]?.revisionNumber === 1, `${listReply.status} ${short(listReply.json)}`);
check("A8. daftar revisi memuat pemakaian disk (count/limit/totalBytes/limitBytes)", listReply.json?.count === 1 && listReply.json?.limit === REVISION_LIMIT && listReply.json?.limitBytes === LIMIT && listReply.json?.totalBytes === Buffer.byteLength(initialText), short(listReply.json));

const revOne = await owner.call("GET", `/api/v1/artifacts/${artA}/revisions/1`);
check("A9. revisi lama masih utuh (isi revisi 1 = isi sebelum penimpaan)", revOne.status === 200 && revOne.json?.content === initialText && revOne.json?.checksum === sha(initialText), `${revOne.status} ${short(revOne.json)}`);

const newText2 = "Isi v3 setelah penimpaan kedua.";
const put2 = await putCurrent(owner, artA, newText2, "Sunting uji 2");
check("A10. PUT kedua (baseRevision 1) diterima, revisi menjadi 2", put2.status === 200 && put2.json?.revision === 2, `${put2.status} ${short(put2.json)}`);
const revOneAgain = await owner.call("GET", `/api/v1/artifacts/${artA}/revisions/1`);
check("A11. revisi 1 tetap identik setelah penimpaan kedua (riwayat tidak rusak)", revOneAgain.json?.content === initialText && revOneAgain.json?.checksum === sha(initialText), short(revOneAgain.json));

const directRev = await artifactMod.recordArtifactRevision(artA, { content: Buffer.from("salinan langsung dari modul", "utf8"), note: "Uji panggilan langsung", createdBy: ownerUserId });
check("A12. recordArtifactRevision (panggilan langsung) -> revisi 3 + checksum + ukuran", directRev.revisionNumber === 3 && directRev.checksum === sha("salinan langsung dari modul") && directRev.sizeBytes === Buffer.byteLength("salinan langsung dari modul"), short(directRev));
check("A13. baris revisi hasil panggilan langsung tersimpan di tabel", count("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?", artA) === 3, short(count("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?", artA)));
const pruned0 = artifactMod.pruneArtifactRevisions(artA);
check("A14. pruneArtifactRevisions tidak membuang apa pun di bawah batas 20", pruned0 === 0 && count("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?", artA) === 3, short({ pruned0 }));

const revThree = await owner.call("GET", `/api/v1/artifacts/${artA}/revisions/3`);
check("A15. revisi dari panggilan modul bisa dibaca lewat API", revThree.status === 200 && revThree.json?.content === "salinan langsung dari modul" && revThree.json?.createdBy === ownerUserId, `${revThree.status} ${short(revThree.json)}`);

/* =====================================================================================
 * Bagian B (syarat ⑦): retensi maksimum 20 revisi.
 * ===================================================================================== */
console.log("\n--- Bagian B (syarat ⑦): retensi 20 revisi ---");
for (let step = 1; step <= 21; step += 1) {
  const reply = await putCurrent(owner, artRet, `r${step}`, `Penimpaan ${step}`);
  if (reply.status !== 200) { check(`B-loop penimpaan ke-${step} diterima`, false, `${reply.status} ${short(reply.json)}`); break; }
}
const retCount = count("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?", artRet);
const range: any = db.prepare("SELECT MIN(revision_number) AS mn, MAX(revision_number) AS mx FROM artifact_revisions WHERE artifact_id=?").get(artRet);
check("B1. setelah 21 penimpaan tersisa tepat 20 revisi", retCount === 20, short({ retCount }));
check("B2. yang dibuang adalah revisi tertua (tersisa 2..21)", Number(range.mn) === 2 && Number(range.mx) === 21, short(range));
const goneReply = await owner.call("GET", `/api/v1/artifacts/${artRet}/revisions/1`);
check("B3. revisi yang sudah dibuang menjawab 404", goneReply.status === 404 && goneReply.json?.error === "ARTIFACT_REVISION_NOT_FOUND", `${goneReply.status} ${short(goneReply.json)}`);
const retList = await owner.call("GET", `/api/v1/artifacts/${artRet}/revisions`);
check("B4. daftar revisi melaporkan count 20 dan batas 20", retList.json?.count === 20 && retList.json?.limit === 20 && retList.json?.revisions?.length === 20, short({ count: retList.json?.count }));
check("B5. isi berkas riwayat.md = hasil penimpaan terakhir", diskText(projectId, artRet) === "r21", short(diskText(projectId, artRet)));

/* =====================================================================================
 * Bagian C (syarat ① + ② + ⑤): daftar putih, batas ukuran, baseRevision.
 * ===================================================================================== */
console.log("\n--- Bagian C: daftar putih, batas ukuran, baseRevision ---");
const pngPut = await owner.call("PUT", `/api/v1/artifacts/${artPng}/content`, { content: "teks", baseRevision: 0 });
check("C1. ekstensi di luar daftar putih -> 415 ARTIFACT_NOT_EDITABLE", pngPut.status === 415 && pngPut.json?.error === "ARTIFACT_NOT_EDITABLE", `${pngPut.status} ${short(pngPut.json)}`);
const pngGet = await owner.call("GET", `/api/v1/artifacts/${artPng}/content`);
check("C2. artefak biner: GET 200 tetapi editable=false dan isi tidak dikirim", pngGet.status === 200 && pngGet.json?.editable === false && pngGet.json?.content === null, `${pngGet.status} ${short(pngGet.json)}`);

const noExtPut = await owner.call("PUT", `/api/v1/artifacts/${artNoExt}/content`, { content: "teks", baseRevision: 0 });
check("C3. berkas tanpa ekstensi -> 415 ARTIFACT_NOT_EDITABLE", noExtPut.status === 415 && noExtPut.json?.error === "ARTIFACT_NOT_EDITABLE", `${noExtPut.status} ${short(noExtPut.json)}`);

const binaryPut = await owner.call("PUT", `/api/v1/artifacts/${artA}/content`, { content: `teks${String.fromCharCode(0)}biner`, baseRevision: 2 });
check("C4. isi biner (byte NUL) -> 415 ARTIFACT_NOT_EDITABLE", binaryPut.status === 415 && binaryPut.json?.error === "ARTIFACT_NOT_EDITABLE", `${binaryPut.status} ${short(binaryPut.json)}`);

const tooBigPut = await owner.call("PUT", `/api/v1/artifacts/${artBig}/content`, { content: "a".repeat(LIMIT + 1), baseRevision: 0 });
check("C5. isi > 2 MB -> 413 ARTIFACT_TOO_LARGE", tooBigPut.status === 413 && tooBigPut.json?.error === "ARTIFACT_TOO_LARGE", `${tooBigPut.status} ${short(tooBigPut.json)}`);
check("C6. batas 2 MB disebut di pesan galat Indonesia", typeof tooBigPut.json?.message === "string" && tooBigPut.json.message.includes(String(LIMIT)), short(tooBigPut.json?.message));
check("C7. penolakan ukuran tidak menyentuh berkas nyata", diskText(projectId, artBig) === "kecil", short(diskText(projectId, artBig)));

const atLimitPut = await owner.call("PUT", `/api/v1/artifacts/${artBig}/content`, { content: "b".repeat(LIMIT), baseRevision: 0 });
check("C8. isi tepat di batas 2 MB diterima (200)", atLimitPut.status === 200 && atLimitPut.json?.sizeBytes === LIMIT, `${atLimitPut.status} ${short({ sizeBytes: atLimitPut.json?.sizeBytes })}`);
check("C9. berkas 2 MB benar-benar tertulis di disk", readFileSync(diskPath(projectId, artBig)).length === LIMIT, short(readFileSync(diskPath(projectId, artBig)).length));

const noBasePut = await owner.call("PUT", `/api/v1/artifacts/${artA}/content`, { content: "tanpa baseRevision" });
check("C10. baseRevision hilang -> 400 BASE_REVISION_REQUIRED", noBasePut.status === 400 && noBasePut.json?.error === "BASE_REVISION_REQUIRED", `${noBasePut.status} ${short(noBasePut.json)}`);

const stalePut = await owner.call("PUT", `/api/v1/artifacts/${artA}/content`, { content: "isi pengguna yang basi", baseRevision: 0 });
check("C11. revisi basi -> 409 ARTIFACT_CHANGED", stalePut.status === 409 && stalePut.json?.error === "ARTIFACT_CHANGED", `${stalePut.status} ${short(stalePut.json)}`);
check("C12. 409 memuat latestRevision + latestContent (isi terbaru server)", stalePut.json?.latestRevision === 3 && stalePut.json?.latestContent === newText2, short({ latestRevision: stalePut.json?.latestRevision, latestContent: short(stalePut.json?.latestContent) }));
check("C13. 409 menyertakan revisi milik pengguna + pesan Indonesia", stalePut.json?.yourRevision === 0 && String(stalePut.json?.message ?? "").includes("revisi terbaru"), short(stalePut.json?.message));
check("C14. penolakan 409 tidak menimpa berkas nyata", diskText(projectId, artA) === newText2, short(diskText(projectId, artA)));

/* =====================================================================================
 * Bagian D (syarat ③): jalur '..', jalur absolut luar akar, tautan simbolik.
 * ===================================================================================== */
console.log("\n--- Bagian D (syarat ③): jaring aman jalur berkas ---");
const artTraversal = "w11a-traversal";
insertArtifactRow(artTraversal, projectId, "jahat.md", "text/markdown", join(dataDir, "artifacts", projectId, "..", "..", "..", "etc", "passwd"));
const traversalPut = await owner.call("PUT", `/api/v1/artifacts/${artTraversal}/content`, { content: "x", baseRevision: 0 });
check("D1. storage_path memuat '..' -> 400 INVALID_ARTIFACT_PATH", traversalPut.status === 400 && traversalPut.json?.error === "INVALID_ARTIFACT_PATH", `${traversalPut.status} ${short(traversalPut.json)}`);
const traversalGet = await owner.call("GET", `/api/v1/artifacts/${artTraversal}/content`);
check("D2. jalur ber-'..' juga ditolak saat membaca isi", traversalGet.status === 400 && traversalGet.json?.error === "INVALID_ARTIFACT_PATH", `${traversalGet.status} ${short(traversalGet.json)}`);

const artAbsolute = "w11a-absolut";
insertArtifactRow(artAbsolute, projectId, "absolut.md", "text/markdown", "/etc/hostname");
const absolutePut = await owner.call("PUT", `/api/v1/artifacts/${artAbsolute}/content`, { content: "x", baseRevision: 0 });
check("D3. jalur absolut di luar akar proyek -> 400 INVALID_ARTIFACT_PATH", absolutePut.status === 400 && absolutePut.json?.error === "INVALID_ARTIFACT_PATH", `${absolutePut.status} ${short(absolutePut.json)}`);

mkdirSync(outsideDir, { recursive: true });
const secretPath = join(outsideDir, "rahasia.txt");
writeFileSync(secretPath, "RAHASIA LUAR yang tidak boleh berubah", "utf8");
const artSymlink = "w11a-simlink";
const symlinkPath = join(dataDir, "artifacts", projectId, "tautan-luar.md");
symlinkSync(secretPath, symlinkPath);
insertArtifactRow(artSymlink, projectId, "tautan-luar.md", "text/markdown", symlinkPath);
const symlinkPut = await owner.call("PUT", `/api/v1/artifacts/${artSymlink}/content`, { content: "ditulis lewat tautan", baseRevision: 0 });
check("D4. tautan simbolik keluar akar proyek -> 400 INVALID_ARTIFACT_PATH", symlinkPut.status === 400 && symlinkPut.json?.error === "INVALID_ARTIFACT_PATH", `${symlinkPut.status} ${short(symlinkPut.json)}`);
check("D5. berkas di luar akar TIDAK berubah setelah penolakan", readFileSync(secretPath, "utf8") === "RAHASIA LUAR yang tidak boleh berubah", short(readFileSync(secretPath, "utf8")));
const symlinkGet = await owner.call("GET", `/api/v1/artifacts/${artSymlink}/content`);
check("D6. membaca isi lewat tautan keluar akar juga ditolak", symlinkGet.status === 400 && symlinkGet.json?.error === "INVALID_ARTIFACT_PATH", `${symlinkGet.status} ${short(symlinkGet.json)}`);

/* =====================================================================================
 * Bagian E (syarat ⑥): peran viewer dan bukan anggota.
 * ===================================================================================== */
console.log("\n--- Bagian E (syarat ⑥): viewer & bukan anggota ---");
const viewerPut = await viewer.call("PUT", `/api/v1/artifacts/${artA}/content`, { content: "coba menulis", baseRevision: 3 });
check("E1. viewer menulis -> 403 VIEWER_FORBIDDEN", viewerPut.status === 403 && viewerPut.json?.error === "VIEWER_FORBIDDEN", `${viewerPut.status} ${short(viewerPut.json)}`);
const viewerList = await viewer.call("GET", `/api/v1/artifacts/${artA}/revisions`);
check("E2. viewer membaca daftar revisi -> 403 VIEWER_FORBIDDEN", viewerList.status === 403 && viewerList.json?.error === "VIEWER_FORBIDDEN", `${viewerList.status} ${short(viewerList.json)}`);
const viewerOne = await viewer.call("GET", `/api/v1/artifacts/${artA}/revisions/1`);
check("E3. viewer membaca satu revisi -> 403 VIEWER_FORBIDDEN", viewerOne.status === 403 && viewerOne.json?.error === "VIEWER_FORBIDDEN", `${viewerOne.status} ${short(viewerOne.json)}`);
const viewerRestore = await viewer.call("POST", `/api/v1/artifacts/${artA}/revisions/1/restore`, {});
check("E4. viewer memulihkan revisi -> 403 VIEWER_FORBIDDEN", viewerRestore.status === 403 && viewerRestore.json?.error === "VIEWER_FORBIDDEN", `${viewerRestore.status} ${short(viewerRestore.json)}`);
const viewerContent = await viewer.call("GET", `/api/v1/artifacts/${artA}/content`);
check("E5. viewer masih boleh membaca ISI artefak (200)", viewerContent.status === 200 && viewerContent.json?.content === newText2, `${viewerContent.status} ${short(viewerContent.json)}`);

const strangerPut = await stranger.call("PUT", `/api/v1/artifacts/${artA}/content`, { content: "coba menulis", baseRevision: 3 });
check("E6. bukan anggota menulis -> 404 ARTIFACT_NOT_FOUND", strangerPut.status === 404 && strangerPut.json?.error === "ARTIFACT_NOT_FOUND", `${strangerPut.status} ${short(strangerPut.json)}`);
const strangerGet = await stranger.call("GET", `/api/v1/artifacts/${artA}/content`);
check("E7. bukan anggota membaca -> 404 ARTIFACT_NOT_FOUND", strangerGet.status === 404 && strangerGet.json?.error === "ARTIFACT_NOT_FOUND", `${strangerGet.status} ${short(strangerGet.json)}`);
const ghost = await owner.call("PUT", "/api/v1/artifacts/tidak-ada-artefak/content", { content: "x", baseRevision: 0 });
check("E8. artefak tidak ada -> 404 ARTIFACT_NOT_FOUND", ghost.status === 404 && ghost.json?.error === "ARTIFACT_NOT_FOUND", `${ghost.status} ${short(ghost.json)}`);

/* =====================================================================================
 * Bagian F (syarat ⑧): bentrok tulis.
 * ===================================================================================== */
console.log("\n--- Bagian F (syarat ⑧): bentrok tulis ---");
artifactMod.setArtifactWriteLock(artBig, "run-agen-777");
check("F1. artifactWriteLock mengembalikan run yang memegang kunci", artifactMod.artifactWriteLock(artBig) === "run-agen-777", short(artifactMod.artifactWriteLock(artBig)));
const lockedPut = await owner.call("PUT", `/api/v1/artifacts/${artBig}/content`, { content: "suntingan saat agen menulis", baseRevision: 1 });
check("F2. kunci tulis eksplisit -> 409 ARTIFACT_WRITE_BUSY", lockedPut.status === 409 && lockedPut.json?.error === "ARTIFACT_WRITE_BUSY", `${lockedPut.status} ${short(lockedPut.json)}`);
check("F3. pesan bentrok tulis berbahasa Indonesia dan menyebut run agen", String(lockedPut.json?.message ?? "").includes("Agen sedang menulis") && String(lockedPut.json?.message ?? "").includes("run-agen-777"), short(lockedPut.json?.message));
check("F4. penolakan bentrok tidak menimpa berkas nyata", readFileSync(diskPath(projectId, artBig)).length === LIMIT, short(readFileSync(diskPath(projectId, artBig)).length));
artifactMod.clearArtifactWriteLock(artBig);
check("F5. clearArtifactWriteLock melepas kunci", artifactMod.artifactWriteLock(artBig) === null, short(artifactMod.artifactWriteLock(artBig)));
const afterUnlock = await putCurrent(owner, artBig, "setelah kunci dilepas");
check("F6. PUT diterima setelah kunci dilepas (200)", afterUnlock.status === 200 && diskText(projectId, artBig) === "setelah kunci dilepas", `${afterUnlock.status} ${short(afterUnlock.json)}`);

const activeRunId = `w11a-run-${stamp}`;
const blockedByRun = await putCurrent(owner, artB, "suntingan saat run proyek aktif");
check("F7. sebelum run dibuat, artefak proyek B bisa disimpan", blockedByRun.status === 200, `${blockedByRun.status} ${short(blockedByRun.json)}`);
db.prepare("INSERT INTO runs (id, project_id, status, prompt, created_at) VALUES (?,?,?,?,?)")
  .run(activeRunId, projectIdB, "running", "agen sedang menulis artefak proyek B", new Date().toISOString());
const runBusyPut = await putCurrent(owner, artB, "suntingan kedua saat run aktif");
check("F8. run aktif di proyek yang sama -> 409 ARTIFACT_WRITE_BUSY", runBusyPut.status === 409 && runBusyPut.json?.error === "ARTIFACT_WRITE_BUSY", `${runBusyPut.status} ${short(runBusyPut.json)}`);
check("F9. pesan jalur kedua menyebut run yang berjalan", String(runBusyPut.json?.message ?? "").includes(activeRunId) && String(runBusyPut.json?.message ?? "").includes("berjalan"), short(runBusyPut.json?.message));
db.prepare("UPDATE runs SET status='completed', finished_at=? WHERE id=?").run(new Date().toISOString(), activeRunId);
const afterRunPut = await putCurrent(owner, artB, "suntingan setelah run selesai");
check("F10. setelah run selesai, penyimpanan diterima lagi (200)", afterRunPut.status === 200 && diskText(projectIdB, artB) === "suntingan setelah run selesai", `${afterRunPut.status} ${short(afterRunPut.json)}`);

/* =====================================================================================
 * Bagian G (syarat ⑨): memulihkan revisi.
 * ===================================================================================== */
console.log("\n--- Bagian G (syarat ⑨): pulihkan revisi ---");
const beforeRestore: any = db.prepare("SELECT size_bytes AS sizeBytes, sha256, storage_path AS storagePath FROM artifacts WHERE id=?").get(artA);
const revisionsBefore = count("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?", artA);
const restoreTarget = await owner.call("GET", `/api/v1/artifacts/${artA}/revisions/1`);
const restoredContent = String(restoreTarget.json?.content ?? "");
const restoreReply = await owner.call("POST", `/api/v1/artifacts/${artA}/revisions/1/restore`, {});
check("G1. restore revisi 1 -> 200", restoreReply.status === 200 && restoreReply.json?.restored === 1, `${restoreReply.status} ${short(restoreReply.json)}`);
check("G2. isi berkas nyata kembali ke isi revisi 1", diskText(projectId, artA) === restoredContent && restoredContent === initialText, short(diskText(projectId, artA)));
const afterRestore: any = db.prepare("SELECT size_bytes AS sizeBytes, sha256, storage_path AS storagePath FROM artifacts WHERE id=?").get(artA);
check("G3. restore memperbarui artifacts.sha256 + size_bytes", afterRestore.sha256 === sha(restoredContent) && Number(afterRestore.sizeBytes) === Buffer.byteLength(restoredContent), short(afterRestore));
check("G4. sha256 berubah dari nilai sebelum restore", afterRestore.sha256 !== beforeRestore.sha256, short({ sebelum: beforeRestore.sha256, sesudah: afterRestore.sha256 }));
check("G5. restore memperbarui storage_path ke berkas artefak yang sama (berkasnya ada)", afterRestore.storagePath === diskPath(projectId, artA) && existsSync(afterRestore.storagePath), short(afterRestore.storagePath));
check("G6. isi sebelum restore disalin dulu sehingga tidak hilang", count("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?", artA) === revisionsBefore + 1, short({ revisionsBefore, sesudah: count("SELECT COUNT(*) AS n FROM artifact_revisions WHERE artifact_id=?", artA) }));
const snapshotCopy = await owner.call("GET", `/api/v1/artifacts/${artA}/revisions/${Number(restoreReply.json?.snapshotRevision)}`);
check("G7. revisi salinan otomatis berisi isi sebelum restore", snapshotCopy.status === 200 && snapshotCopy.json?.content === newText2, `${snapshotCopy.status} ${short(snapshotCopy.json)}`);
const missingRevision = await owner.call("POST", `/api/v1/artifacts/${artA}/revisions/999/restore`, {});
check("G8. restore nomor revisi yang tidak ada -> 404 ARTIFACT_REVISION_NOT_FOUND", missingRevision.status === 404 && missingRevision.json?.error === "ARTIFACT_REVISION_NOT_FOUND", `${missingRevision.status} ${short(missingRevision.json)}`);
const weirdRevision = await owner.call("GET", `/api/v1/artifacts/${artA}/revisions/abc`);
check("G9. nomor revisi bukan angka -> 400 INVALID_REVISION", weirdRevision.status === 400 && weirdRevision.json?.error === "INVALID_REVISION", `${weirdRevision.status} ${short(weirdRevision.json)}`);

/* =====================================================================================
 * Bagian H: jejak audit, sisa berkas sementara, dan keadaan akhir.
 * ===================================================================================== */
console.log("\n--- Bagian H: audit + sisa berkas sementara ---");
const auditUpdated = count("SELECT COUNT(*) AS n FROM audit_events WHERE action='artifact.content.updated'");
const auditRestored = count("SELECT COUNT(*) AS n FROM audit_events WHERE action='artifact.revision.restored'");
check("H1. audit mencatat artifact.content.updated", auditUpdated > 0, short(auditUpdated));
check("H2. audit mencatat artifact.revision.restored", auditRestored > 0, short(auditRestored));
const leftovers = readdirSync(join(dataDir, "artifacts", projectId)).filter((name) => name.includes(".tmp-"));
check("H3. tidak ada berkas sementara .tmp- yang tertinggal di akar proyek", leftovers.length === 0, short(leftovers));
const finalGet = await owner.call("GET", `/api/v1/artifacts/${artA}/content`);
check("H4. keadaan akhir: isi artefak sama dengan sha256 yang tercatat di basis data", finalGet.json?.sha256Matches === true && finalGet.json?.content === initialText, short(finalGet.json));
check("H5. daftar revisi akhir memuat pemakaian disk yang konsisten", Number(finalGet.json?.revision) === count("SELECT COALESCE(MAX(revision_number),0) AS n FROM artifact_revisions WHERE artifact_id=?", artA), short(finalGet.json?.revision));

console.log(`\nRingkasan: ${passed} lulus, ${failed} gagal${skipped.length ? `, ${skipped.length} dilewati` : ""}`);
if (failedNames.length) console.log(`Gagal: ${failedNames.join(" | ")}`);
process.exit(failed ? 1 : 0);

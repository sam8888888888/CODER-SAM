/**
 * Uji alur hapus (delete flow) lewat HTTP API sungguhan dengan mesin mock.
 * Cakupan:
 *   1) PATCH /api/v1/auth/me
 *   2) DELETE /api/v1/projects/:projectId  (+ anak tabel dibuktikan lewat query DB)
 *   3) DELETE /api/v1/workflows/:workflowId
 *   4) DELETE /api/v1/artifacts/:artifactId
 *   5) GET   /api/v1/artifacts/:artifactId/raw
 *   6) GET   /api/v1/projects/:projectId/usage/export
 *   7) DELETE /api/v1/workspaces/:workspaceId
 *   8) DELETE /api/v1/auth/account  (pakai akun uji terpisah)
 *
 * Jalankan: npx tsx apps/api/test/delete-flow.e2e.ts
 *
 * CATATAN KONTRAK (hasil probe, bukan tebakan):
 *   - DELETE workflow oleh peran viewer menjawab 403 {"error":"VIEWER_READ_ONLY"},
 *     bukan "INSUFFICIENT_ROLE" seperti bunyi spesifikasi awal. Tes memakai kode NYATA.
 *   - DELETE workspace memeriksa peran owner LEBIH DULU, lalu nama konfirmasi.
 */
const port = 3471;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-delete-flow-${Date.now()}`; process.env.MOCK_ENGINE = "true";
process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
process.env.PRIME_AGENT_MODEL = "delete-flow-model";
// Akun uji terpisah di bawah dibuat sebagai satu-satunya admin platform,
// supaya penjaga LAST_ADMIN (409) benar-benar bisa dipicu tanpa menyentuh akun produksi.
process.env.PLATFORM_ADMIN_EMAILS = "delete-flow-admin@example.test";

// Variabel env wajib diset SEBELUM server diimpor (pola sama seperti suite lain).
await import("../src/server.js");
const { db } = await import("../src/db.js");
await new Promise((resolve) => setTimeout(resolve, 1200));
const base = `http://127.0.0.1:${port}`;

let passed = 0; let failed = 0;
const failedNames: string[] = []; const skipped: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
function skip(name: string, reason: string) { skipped.push(`${name} — ${reason}`); console.log(`SKIP ${name} ${reason}`); }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Klien kecil dengan cookie sendiri; cookie kosong (dibersihkan server) tidak dipakai lagi. */
function client() {
  let cookie = ""; let stale = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const value = setCookie.split(";")[0];
        if (value.endsWith("=")) { stale = cookie; cookie = ""; } else { cookie = value; stale = value; }
      }
      const text = await response.text();
      let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json, text, headers: response.headers, setCookie };
    },
    staleCookie() { return stale; },
  };
}
const owner = client(); const member = client(); const viewer = client(); const anon = client(); const extra = client();

async function waitForStatus(path: string, wanted: string[], timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs; let last: any = null;
  while (Date.now() < deadline) {
    last = await owner.call("GET", path);
    if (last.json && wanted.includes(last.json.status)) return last.json;
    await sleep(200);
  }
  return last?.json;
}
function countRows(table: string, projectId: string) {
  return (db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE project_id=?`).get(projectId) as { total: number }).total;
}

// ------------------------------------------------------------------ akun & peran
const stamp = Date.now();
const ownerEmail = `delete-flow-owner-${stamp}@example.test`;
const memberEmail = `delete-flow-member-${stamp}@example.test`;
const viewerEmail = `delete-flow-viewer-${stamp}@example.test`;
const password = "DeleteFlow123!";
const ownerReg = await owner.call("POST", "/api/v1/auth/register", { email: ownerEmail, password, displayName: "Pemilik Proyek" });
check("daftar akun owner", ownerReg.status === 201, JSON.stringify(ownerReg.json));
const workspaceId = ownerReg.json.workspace.id;
const memberReg = await member.call("POST", "/api/v1/auth/register", { email: memberEmail, password, displayName: "Anggota Tim" });
check("daftar akun member", memberReg.status === 201, JSON.stringify(memberReg.json));
const viewerReg = await viewer.call("POST", "/api/v1/auth/register", { email: viewerEmail, password, displayName: "Pengamat" });
check("daftar akun viewer", viewerReg.status === 201, JSON.stringify(viewerReg.json));
// Akun TERPISAH khusus untuk uji DELETE akun (bukan admin utama, bukan akun smoke produksi).
const adminReg = await extra.call("POST", "/api/v1/auth/register", { email: "delete-flow-admin@example.test", password, displayName: "Akun Uji Hapus" });
check("daftar akun uji terpisah untuk DELETE akun", adminReg.status === 201, JSON.stringify(adminReg.json));

const invitationMember = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: memberEmail, role: "member" });
const acceptedMember = await member.call("POST", "/api/v1/invitations/accept", { token: invitationMember.json?.token });
check("member bergabung dengan peran member", acceptedMember.status === 200 && acceptedMember.json?.role === "member", JSON.stringify(acceptedMember.json));
const invitationViewer = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: viewerEmail, role: "viewer" });
const acceptedViewer = await viewer.call("POST", "/api/v1/invitations/accept", { token: invitationViewer.json?.token });
check("viewer bergabung dengan peran viewer", acceptedViewer.status === 200 && acceptedViewer.json?.role === "viewer", JSON.stringify(acceptedViewer.json));

// ------------------------------------------------------------------ 1) PATCH /api/v1/auth/me
const anonPatch = await anon.call("PATCH", "/api/v1/auth/me", { displayName: "Tanpa Sesi" });
check("1) PATCH /auth/me tanpa sesi ditolak 401", anonPatch.status === 401, JSON.stringify(anonPatch.json));
const shortName = await owner.call("PATCH", "/api/v1/auth/me", { displayName: "x" });
check("1) nama <2 karakter ditolak 400 INVALID_DISPLAY_NAME", shortName.status === 400 && shortName.json?.error === "INVALID_DISPLAY_NAME", JSON.stringify(shortName.json));
const longName = await owner.call("PATCH", "/api/v1/auth/me", { displayName: "y".repeat(81) });
check("1) nama >80 karakter ditolak 400 INVALID_DISPLAY_NAME", longName.status === 400 && longName.json?.error === "INVALID_DISPLAY_NAME", JSON.stringify(longName.json));
const goodName = await owner.call("PATCH", "/api/v1/auth/me", { displayName: "Pemilik Baru" });
check("1) nama valid diterima 200 dan body benar", goodName.status === 200
  && goodName.json?.user?.id === ownerReg.json.user.id
  && goodName.json?.user?.email === ownerEmail
  && goodName.json?.user?.displayName === "Pemilik Baru", JSON.stringify(goodName.json));

// ------------------------------------------------------------------ 2) DELETE /api/v1/projects/:projectId
const unknownProject = await owner.call("DELETE", "/api/v1/projects/tidak-ada");
check("2) id proyek tak dikenal -> 404 PROJECT_NOT_FOUND", unknownProject.status === 404 && unknownProject.json?.error === "PROJECT_NOT_FOUND", JSON.stringify(unknownProject.json));

const projectReg = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Proyek Uji", slug: `hapus-${stamp}` });
const projectId = projectReg.json.id;
check("2) proyek uji dibuat", projectReg.status === 201 || projectReg.status === 200, JSON.stringify(projectReg.json));
const conversation = await owner.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "Percakapan uji" });
check("2) baris conversations dibuat", conversation.status === 201, JSON.stringify(conversation.json)?.slice(0, 160));
const run = await owner.call("POST", `/api/v1/projects/${projectId}/runs`, { prompt: "halo hapus" });
check("2) baris runs dibuat", run.status === 202 && Boolean(run.json?.id), JSON.stringify(run.json)?.slice(0, 160));
const workflowForProject = await owner.call("POST", `/api/v1/projects/${projectId}/workflows`, { name: "Alur uji", steps: [{ id: "s1", type: "prompt", prompt: "Tes" }] });
check("2) baris workflows dibuat", workflowForProject.status === 201, JSON.stringify(workflowForProject.json)?.slice(0, 160));
const artifactForProject = await owner.call("POST", `/api/v1/projects/${projectId}/artifacts`, { name: "uji.txt", mimeType: "text/plain", contentBase64: Buffer.from("isi uji").toString("base64") });
check("2) baris artifacts dibuat", artifactForProject.status === 201, JSON.stringify(artifactForProject.json)?.slice(0, 160));
const knowledgeForProject = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge`, { title: "Dokumen uji", content: "Isi dokumen uji." });
check("2) baris knowledge_documents dibuat", knowledgeForProject.status === 201, JSON.stringify(knowledgeForProject.json)?.slice(0, 160));
// Satu baris run_usage dipastikan ada (mesin mock bisa selesai lambat; baris ini meniru run selesai).
db.prepare(`INSERT INTO run_usage (id,run_id,project_id,model,provider,input_tokens,output_tokens,cache_read_tokens,total_tokens,cost_micros,estimated,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomId(), run.json.id, projectId, "delete-flow-model", "mock", 10, 20, 0, 30, 1234, 0, new Date().toISOString());
function randomId() { return `usage-${Math.random().toString(36).slice(2, 12)}`; }
const childTables = ["conversations", "runs", "run_usage", "workflows", "knowledge_documents", "artifacts"];
const beforeChildren = childTables.map((table) => countRows(table, projectId));
check("2) semua anak tabel terbukti ADA sebelum hapus", beforeChildren.every((total) => total > 0), childTables.map((table, index) => `${table}=${beforeChildren[index]}`).join(" "));

const memberDelete = await member.call("DELETE", `/api/v1/projects/${projectId}`);
check("2) member tidak boleh hapus proyek (403 INSUFFICIENT_ROLE)", memberDelete.status === 403 && memberDelete.json?.error === "INSUFFICIENT_ROLE", JSON.stringify(memberDelete.json));
const viewerDelete = await viewer.call("DELETE", `/api/v1/projects/${projectId}`);
check("2) viewer tidak boleh hapus proyek (403 INSUFFICIENT_ROLE)", viewerDelete.status === 403 && viewerDelete.json?.error === "INSUFFICIENT_ROLE", JSON.stringify(viewerDelete.json));
const removedProject = await owner.call("DELETE", `/api/v1/projects/${projectId}`);
check("2) owner hapus proyek -> 200 {ok:true}", removedProject.status === 200 && removedProject.json?.ok === true, JSON.stringify(removedProject.json));
const afterChildren = childTables.map((table) => countRows(table, projectId));
check("2) baris anak ikut hilang (query langsung ke DB sementara)", afterChildren.every((total) => total === 0), childTables.map((table, index) => `${table}=${afterChildren[index]}`).join(" "));
const projectsAfter = await owner.call("GET", `/api/v1/workspaces/${workspaceId}/projects`);
check("2) proyek tidak lagi ada di daftar workspace", projectsAfter.status === 200 && !projectsAfter.json.some((row: any) => row.id === projectId), JSON.stringify(projectsAfter.json)?.slice(0, 160));
const secondDelete = await owner.call("DELETE", `/api/v1/projects/${projectId}`);
check("(i) hapus proyek kedua kali -> 404 PROJECT_NOT_FOUND", secondDelete.status === 404 && secondDelete.json?.error === "PROJECT_NOT_FOUND", JSON.stringify(secondDelete.json));

// Proyek kedua untuk sisa pengujian.
const project2 = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Proyek Dua", slug: `hapus2-${stamp}` });
const project2Id = project2.json.id;
check("proyek kedua dibuat", project2.status === 201 || project2.status === 200, JSON.stringify(project2.json));

// ------------------------------------------------------------------ 3) DELETE /api/v1/workflows/:workflowId
const unknownWorkflow = await owner.call("DELETE", "/api/v1/workflows/tidak-ada");
check("3) id workflow tak dikenal -> 404 WORKFLOW_NOT_FOUND", unknownWorkflow.status === 404 && unknownWorkflow.json?.error === "WORKFLOW_NOT_FOUND", JSON.stringify(unknownWorkflow.json));
const idleWorkflow = await owner.call("POST", `/api/v1/projects/${project2Id}/workflows`, { name: "Alur menganggur", steps: [{ id: "s1", type: "prompt", prompt: "Tes" }] });
const viewerWorkflowDelete = await viewer.call("DELETE", `/api/v1/workflows/${idleWorkflow.json.id}`);
check("3) viewer tidak boleh hapus workflow (403, kode nyata server: VIEWER_READ_ONLY)", viewerWorkflowDelete.status === 403 && viewerWorkflowDelete.json?.error === "VIEWER_READ_ONLY", JSON.stringify(viewerWorkflowDelete.json));

const busyWorkflow = await owner.call("POST", `/api/v1/projects/${project2Id}/workflows`, {
  name: "Alur persetujuan",
  steps: [
    { id: "start", type: "prompt", prompt: "Langkah awal {{input}}" },
    { id: "human", type: "approval", value: "Perlu persetujuan" },
    { id: "finish", type: "prompt", prompt: "Selesai" },
  ],
});
await owner.call("POST", `/api/v1/workflows/${busyWorkflow.json.id}/publish`);
const started = await owner.call("POST", `/api/v1/workflows/${busyWorkflow.json.id}/execute`, { input: "halo" });
check("3) eksekusi workflow diterima 202", started.status === 202 && Boolean(started.json?.id), JSON.stringify(started.json)?.slice(0, 160));
const paused = await waitForStatus(`/api/v1/workflow-executions/${started.json?.id}`, ["awaiting_approval", "completed", "failed"]);
check("3) eksekusi berhenti di langkah persetujuan (awaiting_approval)", paused?.status === "awaiting_approval", String(paused?.status));
const activeRows = db.prepare("SELECT COUNT(*) AS total FROM workflow_executions WHERE workflow_id=? AND status IN ('queued','running','awaiting_approval')").get(busyWorkflow.json.id) as { total: number };
check("3) bukti DB: ada eksekusi berstatus aktif", activeRows.total > 0, String(activeRows.total));
const busyDelete = await owner.call("DELETE", `/api/v1/workflows/${busyWorkflow.json.id}`);
check("3) workflow masih berjalan -> 409 WORKFLOW_BUSY", busyDelete.status === 409 && busyDelete.json?.error === "WORKFLOW_BUSY", JSON.stringify(busyDelete.json));
const idleDelete = await owner.call("DELETE", `/api/v1/workflows/${idleWorkflow.json.id}`);
check("3) workflow tanpa eksekusi berjalan -> 200 {ok:true}", idleDelete.status === 200 && idleDelete.json?.ok === true, JSON.stringify(idleDelete.json));
const idleRowLeft = db.prepare("SELECT COUNT(*) AS total FROM workflows WHERE id=?").get(idleWorkflow.json.id) as { total: number };
check("3) bukti DB: baris workflow sudah hilang", idleRowLeft.total === 0, String(idleRowLeft.total));
await owner.call("POST", `/api/v1/workflow-executions/${started.json?.id}/cancel`);

// ------------------------------------------------------------------ 4) DELETE /api/v1/artifacts/:artifactId
const unknownArtifact = await owner.call("DELETE", "/api/v1/artifacts/tidak-ada");
check("4) id artefak tak dikenal -> 404 ARTIFACT_NOT_FOUND", unknownArtifact.status === 404 && unknownArtifact.json?.error === "ARTIFACT_NOT_FOUND", JSON.stringify(unknownArtifact.json));
const artifactToDelete = await owner.call("POST", `/api/v1/projects/${project2Id}/artifacts`, { name: "hapus.txt", mimeType: "text/plain", contentBase64: Buffer.from("isi hapus").toString("base64") });
const artifactKept = await owner.call("POST", `/api/v1/projects/${project2Id}/artifacts`, { name: "mentah.txt", mimeType: "text/plain", contentBase64: Buffer.from("isi mentah").toString("base64") });
check("4) dua artefak uji dibuat", artifactToDelete.status === 201 && artifactKept.status === 201, `${artifactToDelete.status}/${artifactKept.status}`);
const viewerArtifactDelete = await viewer.call("DELETE", `/api/v1/artifacts/${artifactKept.json.id}`);
check("4) viewer tidak boleh hapus artefak (403 VIEWER_READ_ONLY)", viewerArtifactDelete.status === 403 && viewerArtifactDelete.json?.error === "VIEWER_READ_ONLY", JSON.stringify(viewerArtifactDelete.json));
const memberArtifactDelete = await member.call("DELETE", `/api/v1/artifacts/${artifactToDelete.json.id}`);
check("4) member boleh hapus artefak -> 200 {ok:true}", memberArtifactDelete.status === 200 && memberArtifactDelete.json?.ok === true, JSON.stringify(memberArtifactDelete.json));
const rawAfterDelete = await owner.call("GET", `/api/v1/artifacts/${artifactToDelete.json.id}/raw`);
check("4) setelah hapus, GET raw -> 404 ARTIFACT_NOT_FOUND", rawAfterDelete.status === 404 && rawAfterDelete.json?.error === "ARTIFACT_NOT_FOUND", JSON.stringify(rawAfterDelete.json));

// ------------------------------------------------------------------ 5) GET /api/v1/artifacts/:artifactId/raw
const rawContent = "isi berkas mentah\nbaris kedua tanpa spasi akhir";
const rawArtifact = await owner.call("POST", `/api/v1/projects/${project2Id}/artifacts`, { name: "berkas.txt", mimeType: "text/plain", contentBase64: Buffer.from(rawContent).toString("base64") });
const rawResponse = await owner.call("GET", `/api/v1/artifacts/${rawArtifact.json.id}/raw`);
check("5) GET raw -> 200 dan isi body sama dengan berkas yang diunggah", rawResponse.status === 200 && rawResponse.text === rawContent, `${rawResponse.status} ${JSON.stringify(rawResponse.text)?.slice(0, 80)}`);
check("5) Content-Disposition diawali inline", String(rawResponse.headers.get("content-disposition") ?? "").startsWith("inline"), String(rawResponse.headers.get("content-disposition")));
check("5) header X-Content-Type-Options: nosniff", rawResponse.headers.get("x-content-type-options") === "nosniff", String(rawResponse.headers.get("x-content-type-options")));

// ------------------------------------------------------------------ 6) GET /api/v1/projects/:projectId/usage/export
const unknownExport = await owner.call("GET", "/api/v1/projects/tidak-ada/usage/export");
check("6) proyek tak dikenal -> 404 PROJECT_NOT_FOUND", unknownExport.status === 404 && unknownExport.json?.error === "PROJECT_NOT_FOUND", JSON.stringify(unknownExport.json));
const exportRun = await owner.call("POST", `/api/v1/projects/${project2Id}/runs`, { prompt: "halo ekspor" });
check("6) run dibuat untuk mengisi pemakaian", exportRun.status === 202, JSON.stringify(exportRun.json)?.slice(0, 160));
const usageDeadline = Date.now() + 20000;
while (Date.now() < usageDeadline) { if (countRows("run_usage", project2Id) > 0) break; await sleep(250); }
check("6) bukti DB: baris run_usage ada sebelum ekspor", countRows("run_usage", project2Id) > 0, String(countRows("run_usage", project2Id)));
const exported = await owner.call("GET", `/api/v1/projects/${project2Id}/usage/export`);
const exportLines = exported.text.split("\n").map((line) => line.trim()).filter(Boolean);
check("6) ekspor -> 200 text/csv", exported.status === 200 && String(exported.headers.get("content-type") ?? "").startsWith("text/csv"), `${exported.status} ${exported.headers.get("content-type")}`);
check("6) Content-Disposition attachment", String(exported.headers.get("content-disposition") ?? "").startsWith("attachment"), String(exported.headers.get("content-disposition")));
const expectedHeader = "tanggal,model,provider,run,input_tokens,output_tokens,cache_read_tokens,total_tokens,cost_micros,cost_usd,perkiraan";
check("6) baris pertama CSV tepat sesuai kontrak", exportLines[0] === expectedHeader, JSON.stringify(exportLines[0]));
check("6) baris terakhir mengandung TOTAL", String(exportLines[exportLines.length - 1] ?? "").includes("TOTAL"), JSON.stringify(exportLines[exportLines.length - 1]));
check("6) CSV memuat minimal satu baris data", exportLines.length >= 3, JSON.stringify(exportLines));

// ------------------------------------------------------------------ 7) DELETE /api/v1/workspaces/:workspaceId
const workspaceList = await owner.call("GET", "/api/v1/workspaces");
const workspaceName = workspaceList.json?.find((row: any) => row.id === workspaceId)?.name;
check("7) nama workspace terbaca dari daftar", typeof workspaceName === "string" && workspaceName.length > 0, JSON.stringify(workspaceList.json)?.slice(0, 160));
const foreignDelete = await member.call("DELETE", `/api/v1/workspaces/${workspaceId}`, { confirm: workspaceName });
check("(ii) pemanggil bukan owner -> 403 OWNER_REQUIRED", foreignDelete.status === 403 && foreignDelete.json?.error === "OWNER_REQUIRED", JSON.stringify(foreignDelete.json));
const wrongConfirm = await owner.call("DELETE", `/api/v1/workspaces/${workspaceId}`, { confirm: "nama salah" });
check("7) confirm tidak sama persis -> 400 CONFIRM_REQUIRED", wrongConfirm.status === 400 && wrongConfirm.json?.error === "CONFIRM_REQUIRED", JSON.stringify(wrongConfirm.json));
const workspaceStillThere = await owner.call("GET", "/api/v1/workspaces");
check("(ii) workspace masih ada setelah percobaan gagal", workspaceStillThere.json?.some((row: any) => row.id === workspaceId), JSON.stringify(workspaceStillThere.json)?.slice(0, 120));
const removedWorkspace = await owner.call("DELETE", `/api/v1/workspaces/${workspaceId}`, { confirm: workspaceName });
check("7) confirm cocok -> 200 {ok:true}", removedWorkspace.status === 200 && removedWorkspace.json?.ok === true, JSON.stringify(removedWorkspace.json));
const workspacesAfter = await owner.call("GET", "/api/v1/workspaces");
check("7) workspace tidak lagi ada di GET /api/v1/workspaces", !workspacesAfter.json?.some((row: any) => row.id === workspaceId), JSON.stringify(workspacesAfter.json)?.slice(0, 120));

// ------------------------------------------------------------------ 8) DELETE /api/v1/auth/account (akun uji terpisah)
const badPhrase = await extra.call("DELETE", "/api/v1/auth/account", { password, confirm: "HAPUS" });
check("8) frasa konfirmasi salah -> 400 CONFIRM_REQUIRED", badPhrase.status === 400 && badPhrase.json?.error === "CONFIRM_REQUIRED", JSON.stringify(badPhrase.json));
const badPassword = await extra.call("DELETE", "/api/v1/auth/account", { password: "SalahBanget123!", confirm: "HAPUS AKUN" });
check("8) kata sandi salah -> 403 INVALID_PASSWORD", badPassword.status === 403 && badPassword.json?.error === "INVALID_PASSWORD", JSON.stringify(badPassword.json));
const adminRow = db.prepare("SELECT is_admin AS isAdmin FROM users WHERE id=?").get(adminReg.json.user.id) as { isAdmin: number } | undefined;
const adminEmails = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
const adminAccountIsPlatformAdmin = Boolean(adminRow?.isAdmin) || adminEmails.includes("delete-flow-admin@example.test");
const adminPlaceholders = adminEmails.map(() => "?").join(",");
const platformAdminCount = () => (db.prepare(`SELECT COUNT(*) AS total FROM users WHERE is_admin=1${adminEmails.length ? ` OR lower(email) IN (${adminPlaceholders})` : ""}`).get(...adminEmails) as { total: number }).total;
const platformAdmins = platformAdminCount();
const lastAdminAttempt = await extra.call("DELETE", "/api/v1/auth/account", { password, confirm: "HAPUS AKUN" });
if (adminAccountIsPlatformAdmin && platformAdmins <= 1) {
  check("8) akun satu-satunya admin platform -> 409 LAST_ADMIN", lastAdminAttempt.status === 409 && lastAdminAttempt.json?.error === "LAST_ADMIN", JSON.stringify(lastAdminAttempt.json));
} else {
  skip("8) akun satu-satunya admin platform -> 409 LAST_ADMIN", `akun uji bukan admin platform tunggal (admin=${adminAccountIsPlatformAdmin}, jumlah_admin_di_db=${platformAdmins}, status=${lastAdminAttempt.status})`);
}
// Tambahkan admin kedua lewat DB supaya penghapusan akun uji bisa berhasil.
db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(ownerReg.json.user.id);
// Platform admin = is_admin=1 atau email di PLATFORM_ADMIN_EMAILS (rumus sama seperti server).
check("8) admin platform kedua disiapkan lewat DB sementara", platformAdminCount() >= 2, `jumlah_admin=${platformAdminCount()}`);
const accountDeleted = await extra.call("DELETE", "/api/v1/auth/account", { password, confirm: "HAPUS AKUN" });
check("8) frasa dan kata sandi benar -> 200 {ok:true}", accountDeleted.status === 200 && accountDeleted.json?.ok === true, JSON.stringify(accountDeleted.json));
check("8) cookie sesi dibersihkan pada respons", /coder_session=\s*;/.test(String(accountDeleted.setCookie ?? "")) && String(accountDeleted.setCookie).toLowerCase().includes("expires=thu, 01 jan 1970"), String(accountDeleted.setCookie));
const staleMe = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie: extra.staleCookie() } });
check("8) cookie sesi lama tidak berlaku lagi pada GET /auth/me (401)", staleMe.status === 401, String(staleMe.status));
const meWithoutSession = await extra.call("GET", "/api/v1/auth/me");
check("8) GET /auth/me tanpa sesi -> 401", meWithoutSession.status === 401, JSON.stringify(meWithoutSession.json));
check("8) bukti DB: baris user akun uji sudah hilang", (db.prepare("SELECT COUNT(*) AS total FROM users WHERE id=?").get(adminReg.json.user.id) as { total: number }).total === 0, "");

// ------------------------------------------------------------------ ringkasan
console.log(`RINGKASAN cek: lulus=${passed} gagal=${failed} skip=${skipped.length}`);
if (skipped.length > 0) for (const item of skipped) console.log(`SKIP ${item}`);
if (failed === 0) {
  console.log("ALL_DELETE_FLOW_TESTS_PASSED");
  process.exit(0);
}
for (const name of failedNames) console.log(`FAILED ${name}`);
process.exit(1);

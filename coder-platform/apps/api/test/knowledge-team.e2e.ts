/**
 * Knowledge base and team management end-to-end test (mock engine).
 * Covers file extraction (txt, docx, pdf), chunk indexing, search, prompt context,
 * document delete, member roles, invitations and revoke.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = 3425;
process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-kb-${Date.now()}`;
process.env.MOCK_ENGINE = "true";
process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;

await import("../src/server.js");
await new Promise((resolve) => setTimeout(resolve, 1200));

const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }

function client() {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
      const text = await response.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
      return { status: response.status, json };
    },
  };
}

const owner = client();
const registered = await owner.call("POST", "/api/v1/auth/register", { email: `owner-${Date.now()}@example.test`, password: "Knowledge123!", displayName: "Owner" });
const workspaceId = registered.json.workspace.id;
const project = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "KB", slug: `kb-${Date.now()}` });
const projectId = project.json.id;
check("owner workspace and project ready", Boolean(workspaceId && projectId));

// 1. Text upload with chunking.
const longText = `Panduan rilis COBLAI.\n\n${"Kalimat pengisi untuk pengujian chunking dokumen. ".repeat(80)}\n\nToken rahasia teks adalah KUDA-11.`;
const textUpload = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, { filename: "panduan.txt", contentBase64: Buffer.from(longText).toString("base64") });
check("text document uploaded", textUpload.status === 201 && textUpload.json.chunkCount > 1, JSON.stringify(textUpload.json)?.slice(0, 200));

const duplicate = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, { filename: "panduan.txt", contentBase64: Buffer.from(longText).toString("base64") });
check("duplicate document rejected with 409", duplicate.status === 409 && duplicate.json.error === "DOCUMENT_ALREADY_EXISTS", JSON.stringify(duplicate.json));

const unsupported = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, { filename: "virus.exe", contentBase64: Buffer.from("MZ binary").toString("base64") });
check("unsupported file type rejected", unsupported.status === 400, JSON.stringify(unsupported.json));

const badBase64 = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, { filename: "notes.txt", contentBase64: "not base64 !!" });
check("invalid base64 rejected", badBase64.status === 400 && badBase64.json.error === "INVALID_BASE64", JSON.stringify(badBase64.json));

// 2. DOCX and PDF extraction.
const docxBuffer = await readFile(join(here, "fixtures/sample.docx"));
const docxUpload = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, { filename: "kebijakan.docx", contentBase64: docxBuffer.toString("base64") });
check("docx document uploaded and extracted", docxUpload.status === 201 && docxUpload.json.sourceType === "docx", JSON.stringify(docxUpload.json)?.slice(0, 200));
const pdfBuffer = await readFile(join(here, "fixtures/sample.pdf"));
const pdfUpload = await owner.call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, { filename: "laporan.pdf", contentBase64: pdfBuffer.toString("base64") });
check("pdf document uploaded and extracted", pdfUpload.status === 201 && pdfUpload.json.sourceType === "pdf", JSON.stringify(pdfUpload.json)?.slice(0, 200));

// 3. Search and detail.
const search = await owner.call("GET", `/api/v1/projects/${projectId}/knowledge/search?q=${encodeURIComponent("token rahasia dokumen ZEBRA")}`);
check("search finds the docx chunk", Array.isArray(search.json) && search.json.some((hit: any) => hit.content.includes("ZEBRA-77")), JSON.stringify(search.json)?.slice(0, 200));
const pdfSearch = await owner.call("GET", `/api/v1/projects/${projectId}/knowledge/search?q=${encodeURIComponent("dummy pdf")}`);
check("search finds the pdf chunk", Array.isArray(pdfSearch.json) && pdfSearch.json.length > 0, JSON.stringify(pdfSearch.json)?.slice(0, 200));

const detail = await owner.call("GET", `/api/v1/projects/${projectId}/knowledge/${docxUpload.json.id}`);
check("document detail lists chunks", detail.status === 200 && Array.isArray(detail.json.chunks) && detail.json.chunks.length > 0, JSON.stringify(detail.json)?.slice(0, 200));

// 4. Knowledge reaches the prompt of a chat run.
const conversation = await owner.call("POST", `/api/v1/projects/${projectId}/conversations`, { title: "KB chat" });
const conversationId = conversation.json.conversation.id;
const sent = await owner.call("POST", `/api/v1/conversations/${conversationId}/messages`, { content: "Berapa token rahasia dokumen ZEBRA?" });
const runId = sent.json.run.id;
await new Promise((resolve) => setTimeout(resolve, 2500));
const messages = await owner.call("GET", `/api/v1/conversations/${conversationId}/messages`);
const assistant = messages.json.messages.find((message: any) => message.role === "assistant");
check("mock answer contains the injected knowledge block", Boolean(assistant?.content?.includes("ZEBRA-77")), JSON.stringify(assistant?.content)?.slice(0, 300));
check("mock answer echoes the user question", Boolean(assistant?.content?.includes("Berapa token rahasia dokumen ZEBRA?")), JSON.stringify(assistant?.content)?.slice(0, 300));

// 5. Delete a document removes its chunks.
const removed = await owner.call("DELETE", `/api/v1/projects/${projectId}/knowledge/${docxUpload.json.id}`);
check("document deleted", removed.status === 200 && removed.json.deleted === true, JSON.stringify(removed.json));
const searchAfter = await owner.call("GET", `/api/v1/projects/${projectId}/knowledge/search?q=${encodeURIComponent("ZEBRA")}`);
check("deleted document no longer searchable", Array.isArray(searchAfter.json) && !searchAfter.json.some((hit: any) => hit.content.includes("ZEBRA-77")), JSON.stringify(searchAfter.json)?.slice(0, 200));

// 6. Team management.
const members = await owner.call("GET", `/api/v1/workspaces/${workspaceId}/members`);
check("owner listed as member", members.status === 200 && members.json.length === 1 && members.json[0].role === "owner", JSON.stringify(members.json));

const invitation = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: `member-${Date.now()}@example.test`, role: "member" });
check("invitation created with token", invitation.status === 201 && Boolean(invitation.json.token), JSON.stringify(invitation.json)?.slice(0, 160));
const memberEmail = invitation.json.email;

const member = client();
const memberRegister = await member.call("POST", "/api/v1/auth/register", { email: memberEmail, password: "TeamTest123!", displayName: "Member" });
check("invited user registered", memberRegister.status === 201, JSON.stringify(memberRegister.json)?.slice(0, 160));
const accepted = await member.call("POST", "/api/v1/invitations/accept", { token: invitation.json.token });
check("invitation accepted", accepted.status === 200 && accepted.json.accepted === true, JSON.stringify(accepted.json));
const acceptedTwice = await member.call("POST", "/api/v1/invitations/accept", { token: invitation.json.token });
check("second accept rejected", acceptedTwice.status === 400, JSON.stringify(acceptedTwice.json));

const memberId = memberRegister.json.user.id;
const afterAccept = await owner.call("GET", `/api/v1/workspaces/${workspaceId}/members`);
check("member appears in list", afterAccept.json.length === 2, JSON.stringify(afterAccept.json));

const promote = await owner.call("PATCH", `/api/v1/workspaces/${workspaceId}/members/${memberId}`, { role: "admin" });
check("role updated to admin", promote.status === 200 && promote.json.role === "admin", JSON.stringify(promote.json));
const invalidRole = await owner.call("PATCH", `/api/v1/workspaces/${workspaceId}/members/${memberId}`, { role: "superuser" });
check("invalid role rejected", invalidRole.status === 400, JSON.stringify(invalidRole.json));

const ownerId = registered.json.user.id;
const demoteOwner = await owner.call("PATCH", `/api/v1/workspaces/${workspaceId}/members/${ownerId}`, { role: "member" });
check("last owner cannot be demoted", demoteOwner.status === 409 && demoteOwner.json.error === "LAST_OWNER_CANNOT_BE_DEMOTED", JSON.stringify(demoteOwner.json));
const removeOwner = await owner.call("DELETE", `/api/v1/workspaces/${workspaceId}/members/${ownerId}`);
check("last owner cannot be removed", removeOwner.status === 409, JSON.stringify(removeOwner.json));

const viewerUpload = await member.call("POST", `/api/v1/projects/${projectId}/knowledge/upload`, { filename: "x.txt", contentBase64: Buffer.from("halo").toString("base64") });
check("member can upload (admin role)", viewerUpload.status === 201, JSON.stringify(viewerUpload.json)?.slice(0, 160));

const invitations = await owner.call("GET", `/api/v1/workspaces/${workspaceId}/invitations`);
check("invitation list readable by owner", invitations.status === 200 && invitations.json.length === 1, JSON.stringify(invitations.json)?.slice(0, 160));
const newInvite = await owner.call("POST", `/api/v1/workspaces/${workspaceId}/invitations`, { email: `revoke-${Date.now()}@example.test`, role: "viewer" });
const revoked = await owner.call("DELETE", `/api/v1/invitations/${newInvite.json.id}`);
check("invitation revoked", revoked.status === 200 && revoked.json.revoked === true, JSON.stringify(revoked.json));

const removedMember = await owner.call("DELETE", `/api/v1/workspaces/${workspaceId}/members/${memberId}`);
check("member removed", removedMember.status === 200 && removedMember.json.removed === true, JSON.stringify(removedMember.json));
const membersAfter = await owner.call("GET", `/api/v1/workspaces/${workspaceId}/members`);
check("member list shrinks after removal", membersAfter.json.length === 1, JSON.stringify(membersAfter.json));

const audit = await owner.call("GET", `/api/v1/workspaces/${workspaceId}/audit`);
const actions = (audit.json ?? []).map((row: any) => row.action);
check("audit records knowledge upload", actions.includes("knowledge.document.uploaded"), JSON.stringify(actions.slice(0, 8)));
check("audit records role change", actions.includes("member.role_updated"), JSON.stringify(actions.slice(0, 8)));
check("audit records invitation revoke", actions.includes("invitation.revoked"), JSON.stringify(actions.slice(0, 8)));

console.log(failures === 0 ? "ALL_KNOWLEDGE_TEAM_TESTS_PASSED" : `KNOWLEDGE_TEAM_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);

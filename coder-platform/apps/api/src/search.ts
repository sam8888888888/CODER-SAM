import { db } from "./db.js";
import { config } from "./config.js";

/** Wave 10 (item 29): one search box for everything the caller is allowed to see.
 *
 *  The rule is simple and must stay that way: a hit is only returned when the row belongs to a
 *  workspace where the caller is a member. Chat messages and knowledge documents are searched through
 *  their full text index (FTS5), the rest through a plain LIKE, which is enough for names and titles.
 *  Every query is limited per group, so one huge project cannot bury the other groups.
 */

export type SearchKind = "project" | "conversation" | "message" | "artifact" | "knowledge" | "workflow";

export const SEARCH_KINDS: SearchKind[] = ["project", "conversation", "message", "artifact", "knowledge", "workflow"];

export type SearchHit = {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  conversationId?: string | null;
  at: string | null;
  link: string;
};

export type SearchResult = {
  query: string;
  terms: string[];
  limit: number;
  total: number;
  counts: Record<SearchKind, number>;
  groups: Array<{ kind: SearchKind; label: string; hits: SearchHit[] }>;
  tookMs: number;
  note: string;
};

const LABELS: Record<SearchKind, string> = {
  project: "Proyek",
  conversation: "Percakapan",
  message: "Pesan",
  artifact: "Artefak",
  knowledge: "Basis pengetahuan",
  workflow: "Alur kerja",
};

/** Splits what the user typed into words. A quoted phrase stays one term. */
export function searchTerms(raw: string): string[] {
  const text = String(raw ?? "").trim().slice(0, 200);
  if (!text) return [];
  const quoted = text.match(/"[^"]+"/g) ?? [];
  const rest = text.replace(/"[^"]+"/g, " ").split(/\s+/).filter(Boolean);
  const terms = [...quoted.map((item) => item.slice(1, -1)), ...rest].map((item) => item.trim()).filter(Boolean);
  // At most five words: more than that turns one search into a scan of the whole database and the
  // user cannot judge the result anyway.
  return [...new Set(terms)].slice(0, 5);
}

/** FTS5 has its own grammar; user text must never reach it raw. Each word becomes a prefix match. */
export function ftsQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, "")}"*`).join(" AND ");
}

function like(term: string): string {
  return `%${term.replace(/[%_]/g, "")}%`;
}

/**
 * Wraps the words the user asked for in `<mark>` so the reader can see them at a glance.
 * The page escapes every snippet first and only revives that one tag, so nothing else from the stored
 * text can ever become a tag. Existing marks in the source text are removed so the count stays exact.
 */
function highlight(text: string, terms: string[]): string {
  const words = terms.filter((term) => term.length >= 2).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.join("|")})`, "gi");
  return text.replace(pattern, "<mark>$1</mark>");
}

function markSnippet(text: string, terms: string[], width = 160): string {
  const flat = String(text ?? "").replace(/<\/?mark>/gi, "").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let start = 0;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0) { start = Math.max(0, found - 40); break; }
  }
  const cut = flat.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${highlight(cut, terms)}${start + width < flat.length ? "…" : ""}`;
}

/** The workspaces the caller may read. Every query below is filtered by this list. */
export function readableWorkspaces(userId: string): string[] {
  const rows = db.prepare("SELECT workspace_id AS workspaceId FROM memberships WHERE user_id=?").all(userId) as Array<{ workspaceId: string }>;
  return rows.map((row) => row.workspaceId);
}

export function globalSearch(input: { userId: string; query: string; limit?: number; kinds?: SearchKind[] }): SearchResult {
  const startedAt = Date.now();
  const terms = searchTerms(input.query);
  // SEARCH_MAX_RESULTS is the ceiling for one page: a caller may ask for a smaller page, never a
  // bigger one. The 50 below is only a backstop for a misconfigured environment value.
  const limit = Math.max(1, Math.min(50, config.SEARCH_MAX_RESULTS, Math.round(input.limit ?? config.SEARCH_MAX_RESULTS)));
  const wanted = (input.kinds?.length ? input.kinds : SEARCH_KINDS).filter((kind) => SEARCH_KINDS.includes(kind));
  const empty: Record<SearchKind, number> = { project: 0, conversation: 0, message: 0, artifact: 0, knowledge: 0, workflow: 0 };
  if (!terms.length) {
    return { query: input.query, terms, limit, total: 0, counts: empty, groups: [], tookMs: Date.now() - startedAt, note: "Kata kunci kosong." };
  }
  const workspaces = readableWorkspaces(input.userId);
  if (!workspaces.length) {
    return { query: input.query, terms, limit, total: 0, counts: empty, groups: [], tookMs: Date.now() - startedAt, note: "Akun ini belum menjadi anggota ruang kerja mana pun." };
  }
  const placeholders = workspaces.map(() => "?").join(",");
  const primary = terms[0]!;
  const groups: Array<{ kind: SearchKind; label: string; hits: SearchHit[] }> = [];

  const push = (kind: SearchKind, hits: SearchHit[]) => {
    if (!hits.length) return;
    empty[kind] = hits.length;
    groups.push({ kind, label: LABELS[kind], hits });
  };

  if (wanted.includes("project")) {
    const rows = db.prepare(`SELECT p.id, p.name, p.description, p.workspace_id AS workspaceId, p.created_at AS createdAt
      FROM projects p WHERE p.workspace_id IN (${placeholders})
      AND (p.name LIKE ? OR p.slug LIKE ? OR p.description LIKE ?)
      ORDER BY p.updated_at DESC LIMIT ?`).all(...workspaces, like(primary), like(primary), like(primary), limit) as Array<{ id: string; name: string; description: string; workspaceId: string; createdAt: string }>;
    push("project", rows.map((row) => ({ kind: "project" as const, id: row.id, title: row.name, snippet: markSnippet(row.description || "Tanpa keterangan", terms), workspaceId: row.workspaceId, projectId: row.id, projectName: row.name, at: row.createdAt, link: `/projects/${row.id}` })));
  }

  if (wanted.includes("conversation")) {
    const rows = db.prepare(`SELECT c.id, c.title, c.created_at AS createdAt, p.id AS projectId, p.name AS projectName, p.workspace_id AS workspaceId
      FROM conversations c JOIN projects p ON p.id = c.project_id
      WHERE p.workspace_id IN (${placeholders}) AND c.title LIKE ?
      ORDER BY c.updated_at DESC LIMIT ?`).all(...workspaces, like(primary), limit) as Array<{ id: string; title: string; createdAt: string; projectId: string; projectName: string; workspaceId: string }>;
    push("conversation", rows.map((row) => ({ kind: "conversation" as const, id: row.id, title: row.title, snippet: `Di proyek ${row.projectName}`, workspaceId: row.workspaceId, projectId: row.projectId, projectName: row.projectName, at: row.createdAt, link: `/projects/${row.projectId}/conversations/${row.id}` })));
  }

  if (wanted.includes("message")) {
    const fts = ftsQuery(terms);
    let rows: Array<{ id: string; content: string; conversationId: string; projectId: string; createdAt: string | null; title: string | null; projectName: string | null; workspaceId: string | null; snippet: string }> = [];
    try {
      rows = db.prepare(`SELECT m.id AS id, m.content AS content, m.conversation_id AS conversationId, c.project_id AS projectId,
          m.created_at AS createdAt, c.title AS title, p.name AS projectName, p.workspace_id AS workspaceId,
          snippet(message_search, 0, '[', ']', '…', 12) AS snippet
        FROM message_search
        JOIN messages m ON m.id = message_search.message_id
        JOIN conversations c ON c.id = m.conversation_id
        JOIN projects p ON p.id = c.project_id
        WHERE message_search MATCH ? AND p.workspace_id IN (${placeholders})
        ORDER BY rank LIMIT ?`).all(fts, ...workspaces, limit) as typeof rows;
    } catch {
      rows = [];
    }
    push("message", rows.map((row) => ({ kind: "message" as const, id: row.id, title: row.title ?? "Pesan", snippet: markSnippet(row.snippet || row.content, terms), workspaceId: row.workspaceId, projectId: row.projectId, projectName: row.projectName, conversationId: row.conversationId, at: row.createdAt, link: `/projects/${row.projectId}/conversations/${row.conversationId}` })));
  }

  if (wanted.includes("artifact")) {
    const rows = db.prepare(`SELECT a.id, a.name, a.mime_type AS mimeType, a.created_at AS createdAt, p.id AS projectId, p.name AS projectName, p.workspace_id AS workspaceId, a.run_id AS runId
      FROM artifacts a JOIN projects p ON p.id = a.project_id
      WHERE p.workspace_id IN (${placeholders}) AND a.name LIKE ?
      ORDER BY a.created_at DESC LIMIT ?`).all(...workspaces, like(primary), limit) as Array<{ id: string; name: string; mimeType: string; createdAt: string; projectId: string; projectName: string; workspaceId: string; runId: string | null }>;
    push("artifact", rows.map((row) => ({ kind: "artifact" as const, id: row.id, title: row.name, snippet: `${row.mimeType} di proyek ${row.projectName}`, workspaceId: row.workspaceId, projectId: row.projectId, projectName: row.projectName, at: row.createdAt, link: `/projects/${row.projectId}` })));
  }

  if (wanted.includes("knowledge")) {
    const fts = ftsQuery(terms);
    let rows: Array<{ docId: string; title: string; snippet: string; projectId: string; projectName: string; workspaceId: string | null; createdAt: string | null }> = [];
    try {
      rows = db.prepare(`SELECT kd.id AS docId, kd.title AS title, kd.created_at AS createdAt,
          p.id AS projectId, p.name AS projectName, p.workspace_id AS workspaceId,
          snippet(knowledge_search, 1, '[', ']', '…', 12) AS snippet
        FROM knowledge_search
        JOIN knowledge_documents kd ON kd.id = knowledge_search.document_id
        JOIN projects p ON p.id = kd.project_id
        WHERE knowledge_search MATCH ? AND p.workspace_id IN (${placeholders})
        ORDER BY rank LIMIT ?`).all(fts, ...workspaces, limit) as typeof rows;
    } catch {
      rows = [];
    }
    push("knowledge", rows.map((row) => ({ kind: "knowledge" as const, id: row.docId, title: row.title, snippet: markSnippet(row.snippet, terms), workspaceId: row.workspaceId, projectId: row.projectId, projectName: row.projectName, at: row.createdAt, link: `/projects/${row.projectId}?tab=knowledge` })));
  }

  if (wanted.includes("workflow")) {
    const rows = db.prepare(`SELECT w.id, w.name, w.description, w.created_at AS createdAt, p.id AS projectId, p.name AS projectName, p.workspace_id AS workspaceId
      FROM workflows w JOIN projects p ON p.id = w.project_id
      WHERE p.workspace_id IN (${placeholders}) AND (w.name LIKE ? OR w.description LIKE ?)
      ORDER BY w.updated_at DESC LIMIT ?`).all(...workspaces, like(primary), like(primary), limit) as Array<{ id: string; name: string; description: string; createdAt: string; projectId: string; projectName: string; workspaceId: string }>;
    push("workflow", rows.map((row) => ({ kind: "workflow" as const, id: row.id, title: row.name, snippet: markSnippet(row.description || `Di proyek ${row.projectName}`, terms), workspaceId: row.workspaceId, projectId: row.projectId, projectName: row.projectName, at: row.createdAt, link: `/projects/${row.projectId}?tab=workflows` })));
  }

  const total = Object.values(empty).reduce((sum, value) => sum + value, 0);
  return {
    query: input.query,
    terms,
    limit,
    total,
    counts: empty,
    groups,
    tookMs: Date.now() - startedAt,
    note: `Hasil dibatasi ${limit} per kelompok dan hanya dari ruang kerja tempat Anda menjadi anggota.`,
  };
}

/** Rebuilds the message index from scratch. Only needed after a restore from an old backup. */
export function rebuildMessageIndex(): { messages: number } {
  const rows = db.prepare("SELECT m.id AS id, m.content AS content, m.conversation_id AS conversationId, c.project_id AS projectId FROM messages m JOIN conversations c ON c.id = m.conversation_id").all() as Array<{ id: string; content: string; conversationId: string; projectId: string }>;
  const insert = db.prepare("INSERT INTO message_search(content, message_id, conversation_id, project_id) VALUES (?,?,?,?)");
  db.transaction(() => {
    db.prepare("DELETE FROM message_search").run();
    for (const row of rows) insert.run(row.content, row.id, row.conversationId, row.projectId);
  })();
  return { messages: rows.length };
}

export function searchStats(): { indexedMessages: number; messages: number } {
  const indexed = Number((db.prepare("SELECT COUNT(*) AS n FROM message_search").get() as { n: number }).n);
  const messages = Number((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
  return { indexedMessages: indexed, messages };
}

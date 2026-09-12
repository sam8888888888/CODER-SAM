import { createHash, randomUUID } from "node:crypto";
import { db } from "./db.js";
import { chunkText } from "./text-extract.js";

/** Rebuilds the searchable chunks of one document. Old chunks are replaced inside one transaction. */
export function indexDocument(documentId: string, projectId: string, content: string) {
  const chunks = chunkText(content);
  const now = new Date().toISOString();
  let inserted = 0;
  db.transaction(() => {
    const existing = db.prepare("SELECT rowid, id FROM knowledge_chunks WHERE document_id=?").all(documentId) as { rowid: number; id: string }[];
    const deleteFts = db.prepare("DELETE FROM knowledge_chunks_fts WHERE rowid=?");
    for (const row of existing) { deleteFts.run(row.rowid); }
    db.prepare("DELETE FROM knowledge_chunks WHERE document_id=?").run(documentId);
    const insert = db.prepare("INSERT INTO knowledge_chunks (id,document_id,project_id,chunk_index,content,created_at) VALUES (?,?,?,?,?,?)");
    const insertFts = db.prepare("INSERT INTO knowledge_chunks_fts (rowid, content, chunk_id, document_id, project_id) VALUES (?,?,?,?,?)");
    chunks.forEach((chunk, index) => {
      const id = randomUUID();
      const result = insert.run(id, documentId, projectId, index, chunk, now);
      insertFts.run(result.lastInsertRowid, chunk, id, documentId, projectId);
      inserted += 1;
    });
    db.prepare("UPDATE knowledge_documents SET chunk_count=?, updated_at=? WHERE id=?").run(inserted, now, documentId);
  })();
  return inserted;
}

/** Removes a document with its chunks and search rows. */
export function deleteDocument(documentId: string) {
  db.transaction(() => {
    const rows = db.prepare("SELECT rowid FROM knowledge_chunks WHERE document_id=?").all(documentId) as { rowid: number }[];
    const deleteFts = db.prepare("DELETE FROM knowledge_chunks_fts WHERE rowid=?");
    for (const row of rows) deleteFts.run(row.rowid);
    db.prepare("DELETE FROM knowledge_search WHERE document_id=?").run(documentId);
    db.prepare("DELETE FROM knowledge_chunks WHERE document_id=?").run(documentId);
    db.prepare("DELETE FROM knowledge_documents WHERE id=?").run(documentId);
  })();
}

/** Turns a user question into a safe FTS query. Terms are quoted so user text cannot break the syntax. */
export function toMatchQuery(input: string) {
  const terms = input.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length > 2).slice(0, 12);
  if (!terms.length) return "";
  return terms.map((term) => `"${term}"`).join(" OR ");
}

/** Finds the best matching chunks inside one project, best first. */
export function searchChunks(projectId: string, query: string, limit = 5) {
  const match = toMatchQuery(query);
  if (!match) return [] as { documentId: string; title: string; chunkIndex: number; content: string; score: number }[];
  const bounded = Math.min(Math.max(limit, 1), 20);
  return db.prepare(`SELECT c.document_id AS documentId, d.title, c.chunk_index AS chunkIndex, c.content, bm25(knowledge_chunks_fts) AS score
    FROM knowledge_chunks_fts JOIN knowledge_chunks c ON c.rowid = knowledge_chunks_fts.rowid
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE knowledge_chunks_fts MATCH ? AND c.project_id = ? ORDER BY score LIMIT ?`).all(match, projectId, bounded) as never;
}

/** Builds the knowledge block that is added in front of a chat prompt. Returns an empty string when nothing matches. */
export function buildKnowledgeContext(projectId: string, question: string, limit = 4) {
  let hits: { documentId: string; title: string; chunkIndex: number; content: string; score: number }[] = [];
  try { hits = searchChunks(projectId, question, limit) as never; } catch { return { text: "", hits: [] as typeof hits }; }
  if (!hits.length) return { text: "", hits };
  const text = hits.map((hit, index) => `[${index + 1}] ${hit.title} (bagian ${hit.chunkIndex + 1})\n${hit.content}`).join("\n\n");
  return { text, hits };
}

/** Stable content checksum used for duplicate detection. */
export function contentChecksum(content: string) { return createHash("sha256").update(content).digest("hex"); }

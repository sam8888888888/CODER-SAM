/**
 * Wave 11C (butir 68): integrasi Notion — token disegel, halaman disimpan sebagai riwayat.
 *
 * Fakta tabel (db.ts, versi skema 21): `user_integrations(id, user_id, provider, secret_ciphertext,
 * meta_json, created_at, updated_at)` dengan indeks unik `(user_id, provider)`. TIDAK ada kolom
 * untuk nama ruang kerja atau daftar halaman, jadi keduanya disimpan di `meta_json` sebagai JSON.
 *
 * Aturan yang dijaga modul ini:
 *  1. Token Notion TIDAK PERNAH dikembalikan API dan TIDAK PERNAH masuk `dataexport.ts` (yang hanya
 *     mengirim `{terpasang, metaJson}`). Yang bisa dilihat pengguna hanya `{terpasang, ekor}`.
 *  2. Token disegel LEBIH DULU, sebelum dipakai ke hulu: tanpa `SECRETS_KEY` tidak ada teks polos
 *     yang tersimpan dan jawabannya 503 SECRETS_KEY_MISSING.
 *  3. Panggilan ke hulu lewat `connector-outbound.ts`, jadi host Notion wajib ada di daftar putih
 *     konektor dan setiap permintaan punya batas waktu. Alamat dasarnya `config.NOTION_API_BASE`
 *     (bukan konstanta) supaya uji bisa menunjuk peladen tiruan lokal.
 *  4. Kesalahan hulu dibedakan apa adanya: token ditolak -> 400 NOTION_TOKEN_INVALID,
 *     hulu mati/5xx/lewat batas waktu -> 502 NOTION_UPSTREAM_ERROR.
 *  5. Pembuatan halaman dibatasi 10 per 10 menit per akun (bisa diubah lewat lingkungan).
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { createRateLimiter, type RateLimiter } from "../ratelimit.js";
import { SECRET_VALUE_MAX_CHARS, SecretsKeyError, isSealed, maskSecret, openSecret, sealSecret, secretsKeyState } from "../secrets.js";
import { audit, fail } from "../wave11a/shared.js";
import { checkOutboundUrl, outboundRequest, outboundTimeoutMs } from "./connector-outbound.js";

export const NOTION_PROVIDER = "notion";
/** Token integrasi Notion: awalan `secret_` (lama) atau `ntn_` (baru), lalu minimal 10 karakter. */
const TOKEN_PATTERN = /^(secret_|ntn_)[A-Za-z0-9_-]{10,}$/;
const MAX_TOKEN_CHARS = 400;
const MAX_PAGES_KEPT = 20;
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 8000;
const MAX_BLOCKS = 60;
const BLOCK_CHARS = 2000;
const NOTION_VERSION = "2022-06-28";

export type NotionPage = { id: string; title: string; url: string; createdAt: string };
export type NotionMeta = {
  workspace?: { id?: string; name?: string };
  pages?: NotionPage[];
  lastPageUrl?: string | null;
  connectedAt?: string;
  lastPageAt?: string;
};

export type NotionRow = { id: string; stored: string; metaJson: string; createdAt: string; updatedAt: string };

const ROW_COLUMNS = "id, secret_ciphertext AS stored, meta_json AS metaJson, created_at AS createdAt, updated_at AS updatedAt";

/** Alamat dasar API Notion. Lingkungan lebih dulu supaya uji bisa mengalihkannya tanpa memuat ulang. */
export function notionApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.NOTION_API_BASE ?? config.NOTION_API_BASE ?? "").trim().replace(/\/+$/, "");
}

export function notionRow(userId: string): NotionRow | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM user_integrations WHERE user_id=? AND provider=?`).get(userId, NOTION_PROVIDER) as NotionRow | undefined;
  return row ?? null;
}

function metaOf(row: NotionRow | null): NotionMeta {
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.metaJson || "{}") as NotionMeta;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Bentuk aman untuk pengguna: tidak ada token, tidak ada ciphertext, hanya penanda dan riwayat. */
export function notionView(userId: string) {
  const row = notionRow(userId);
  const meta = metaOf(row);
  const halaman = Array.isArray(meta.pages) ? meta.pages.slice(0, MAX_PAGES_KEPT) : [];
  let ekor: string | null = null;
  let bisaDibuka = false;
  if (row?.stored) {
    try {
      ekor = maskSecret(openSecret(row.stored)).ekor;
      bisaDibuka = true;
    } catch {
      bisaDibuka = false;
    }
  }
  return {
    provider: NOTION_PROVIDER,
    terpasang: Boolean(row?.stored),
    tersegel: isSealed(row?.stored ?? ""),
    bisaDibuka,
    ekor,
    workspace: meta.workspace ?? null,
    halaman,
    jumlahHalaman: halaman.length,
    lastPageUrl: meta.lastPageUrl ?? null,
    connectedAt: meta.connectedAt ?? null,
    lastPageAt: meta.lastPageAt ?? null,
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Aturan pembatas pembuatan halaman. Dibaca ulang dari lingkungan supaya uji bisa memendekkannya. */
export function notionPageRule(env: NodeJS.ProcessEnv = process.env): { windowMs: number; max: number; namespace: string } {
  const maxRaw = Number(env.NOTION_PAGE_MAX);
  const windowRaw = Number(env.NOTION_PAGE_WINDOW_MS);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 10;
  const windowMs = Number.isFinite(windowRaw) && windowRaw >= 1000 ? Math.floor(windowRaw) : 10 * 60 * 1000;
  return { windowMs, max, namespace: "notion_pages" };
}

let limiterCache: { key: string; limiter: RateLimiter } | null = null;

/** Pembatas yang sama untuk semua permintaan pada konfigurasi yang sama (hitungnya di tabel rate_limit_hits). */
export function notionPageLimiter(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const rule = notionPageRule(env);
  const key = `${rule.namespace}:${rule.windowMs}:${rule.max}`;
  if (!limiterCache || limiterCache.key !== key) limiterCache = { key, limiter: createRateLimiter({ windowMs: rule.windowMs, max: rule.max }, rule.namespace) };
  return limiterCache.limiter;
}

type HuluOk = { ok: true; status: number; body: any; durasiMs: number };
type HuluGagal = { ok: false; status: number; kode: string; pesan: string; durasiMs: number };

/** Memanggil hulu Notion. Selalu lewat daftar putih + batas waktu, dan tidak pernah melempar. */
async function panggilNotion(jalur: string, init: { method: string; token: string; body?: unknown }): Promise<HuluOk | HuluGagal> {
  const base = notionApiBase();
  const bersih = jalur.startsWith("/") ? jalur : `/${jalur}`;
  const cek = checkOutboundUrl(`${base}${bersih}`);
  if (!cek.ok) {
    return {
      ok: false,
      status: 502,
      kode: "NOTION_UPSTREAM_ERROR",
      pesan: `Alamat Notion tidak bisa dipakai: ${cek.message}`,
      durasiMs: 0,
    };
  }
  const jawab = await outboundRequest(cek.url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${init.token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    timeoutMs: outboundTimeoutMs(),
  });
  if (jawab.ok) return { ok: true, status: jawab.status, body: jawab.body, durasiMs: jawab.durasiMs };
  if (jawab.code === "CONNECTOR_UPSTREAM_ERROR") {
    // Token yang ditolak adalah kesalahan pengguna (400), bukan kesalahan hulu (502).
    if (jawab.status === 401 || jawab.status === 403) {
      return { ok: false, status: 400, kode: "NOTION_TOKEN_INVALID", pesan: "Notion menolak token ini. Pastikan token masih berlaku dan integrasinya diberi akses ke halaman tujuan.", durasiMs: jawab.durasiMs };
    }
    return { ok: false, status: 502, kode: "NOTION_UPSTREAM_ERROR", pesan: `Notion menjawab ${jawab.status}. Coba lagi beberapa saat lagi.`, durasiMs: jawab.durasiMs };
  }
  return { ok: false, status: 502, kode: "NOTION_UPSTREAM_ERROR", pesan: `Notion tidak bisa dihubungi: ${jawab.message}`, durasiMs: jawab.durasiMs };
}

/**
 * Menyambungkan token Notion. Dipakai rute PUT dan bisa dipanggil langsung (tanpa HTTP) untuk
 * membuktikan jalur 503 tanpa mendaftarkan sesi, karena `sealSecret` membaca kunci saat dipanggil.
 */
export async function connectNotionToken(userId: string, tokenInput: unknown): Promise<{ ok: true; view: ReturnType<typeof notionView>; workspace: { id?: string; name?: string } } | { ok: false; status: number; kode: string; pesan: string }> {
  const token = String(tokenInput ?? "").trim();
  if (!token || token.length > MAX_TOKEN_CHARS || !TOKEN_PATTERN.test(token)) {
    return { ok: false, status: 400, kode: "NOTION_TOKEN_INVALID", pesan: "Token Notion tidak berbentuk benar (awali dengan 'secret_' atau 'ntn_')." };
  }
  // Segel lebih dulu: tanpa kunci, tidak ada yang disimpan dan tidak ada teks polos yang ditulis.
  let ciphertext: string;
  try {
    ciphertext = sealSecret(token);
  } catch (error) {
    const kode = error instanceof SecretsKeyError ? error.code : "SECRET_SEAL_FAILED";
    return { ok: false, status: 503, kode, pesan: "Penyimpanan rahasia belum dikonfigurasi, jadi token tidak disimpan." };
  }
  const hulu = await panggilNotion("/users/me", { method: "GET", token });
  if (!hulu.ok) return { ok: false, status: hulu.status, kode: hulu.kode, pesan: hulu.pesan };
  const body = (hulu.body ?? {}) as any;
  const workspace = {
    id: body?.bot?.workspace_id ? String(body.bot.workspace_id) : body?.id ? String(body.id) : undefined,
    name: body?.bot?.workspace_name ? String(body.bot.workspace_name) : body?.name ? String(body.name) : undefined,
  };
  const now = new Date().toISOString();
  const lama = notionRow(userId);
  const meta = metaOf(lama);
  const metaBaru: NotionMeta = { ...meta, workspace, connectedAt: meta.connectedAt ?? now };
  if (lama) {
    db.prepare("UPDATE user_integrations SET secret_ciphertext=?, meta_json=?, updated_at=? WHERE id=?").run(ciphertext, JSON.stringify(metaBaru), now, lama.id);
  } else {
    db.prepare("INSERT INTO user_integrations (id,user_id,provider,secret_ciphertext,meta_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), userId, NOTION_PROVIDER, ciphertext, JSON.stringify(metaBaru), now, now);
  }
  audit(userId, "integration.connected", { provider: NOTION_PROVIDER, workspace: workspace.name ?? null, ekor: maskSecret(token).ekor });
  return { ok: true, view: notionView(userId), workspace };
}

/** Token yang sedang tersimpan, sudah dibuka. Dipakai rute halaman. */
function tokenTerbuka(row: NotionRow): { ok: true; token: string } | { ok: false; kode: string } {
  try {
    return { ok: true, token: openSecret(row.stored) };
  } catch (error) {
    return { ok: false, kode: error instanceof SecretsKeyError ? error.code : "SECRET_DECRYPT_FAILED" };
  }
}

/** Memecah isi halaman menjadi blok paragraf Notion (setiap blok maksimal 2000 karakter). */
function blokParagraf(isi: string) {
  const potongan = isi
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_BLOCKS);
  return potongan.map((teks) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: teks.slice(0, BLOCK_CHARS) } }] },
  }));
}

/**
 * Membuat satu halaman Notion dan menyimpan jejaknya di `meta_json`.
 * Urutan: sambungan ada? -> judul sah? -> batas laju? -> rahasia bisa dibuka? -> hulu Notion.
 */
export async function createNotionPage(userId: string, input: { title?: unknown; content?: unknown; parentPageId?: unknown }): Promise<
  { ok: true; halaman: NotionPage; view: ReturnType<typeof notionView> } | { ok: false; status: number; kode: string; pesan: string; detail?: Record<string, unknown> }
> {
  const row = notionRow(userId);
  if (!row?.stored) return { ok: false, status: 409, kode: "NOTION_NOT_CONNECTED", pesan: "Notion belum tersambung. Simpan token lebih dulu lewat PUT /api/v1/integrations/notion." };
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, status: 400, kode: "NOTION_PAGE_TITLE_REQUIRED", pesan: "Judul halaman belum diisi." };
  if (title.length > MAX_TITLE_CHARS) return { ok: false, status: 400, kode: "NOTION_PAGE_TITLE_TOO_LONG", pesan: `Judul halaman maksimal ${MAX_TITLE_CHARS} karakter.` };
  const content = String(input.content ?? "").slice(0, MAX_CONTENT_CHARS);
  const rule = notionPageRule();
  const limiter = notionPageLimiter();
  if (!limiter.allow(`user:${userId}`)) {
    return {
      ok: false,
      status: 429,
      kode: "NOTION_PAGE_RATE_LIMITED",
      pesan: `Maksimal ${rule.max} halaman per ${Math.round(rule.windowMs / 60000)} menit. Coba lagi setelah ${limiter.retryAfterSeconds(`user:${userId}`)} detik.`,
      detail: { max: rule.max, windowMs: rule.windowMs, retryAfter: limiter.retryAfterSeconds(`user:${userId}`) },
    };
  }
  const dibuka = tokenTerbuka(row);
  if (!dibuka.ok) return { ok: false, status: 503, kode: dibuka.kode, pesan: "Token tersimpan tidak bisa dibuka (kunci berubah atau data rusak)." };

  const parentPageId = String(input.parentPageId ?? "").trim();
  const badan = {
    parent: parentPageId ? { type: "page_id", page_id: parentPageId } : { type: "workspace", workspace: true },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
    children: blokParagraf(content),
  };
  const hulu = await panggilNotion("/pages", { method: "POST", token: dibuka.token, body: badan });
  if (!hulu.ok) return { ok: false, status: hulu.status, kode: hulu.kode, pesan: hulu.pesan };

  const hasil = (hulu.body ?? {}) as any;
  const halaman: NotionPage = {
    id: String(hasil.id ?? ""),
    title,
    url: String(hasil.url ?? ""),
    createdAt: String(hasil.created_time ?? new Date().toISOString()),
  };
  const meta = metaOf(row);
  const now = new Date().toISOString();
  const metaBaru: NotionMeta = {
    ...meta,
    pages: [halaman, ...(Array.isArray(meta.pages) ? meta.pages : [])].slice(0, MAX_PAGES_KEPT),
    lastPageUrl: halaman.url || (meta.lastPageUrl ?? null),
    lastPageAt: now,
  };
  db.prepare("UPDATE user_integrations SET meta_json=?, updated_at=? WHERE id=?").run(JSON.stringify(metaBaru), now, row.id);
  audit(userId, "integration.page_created", { provider: NOTION_PROVIDER, pageId: halaman.id, title, durasiMs: hulu.durasiMs, urlHost: (() => { try { return new URL(halaman.url).hostname; } catch { return null; } })() });
  return { ok: true, halaman, view: notionView(userId) };
}

export function registerNotionRoutes(app: any): void {
  app.get("/api/v1/integrations/notion", { preHandler: requireUser }, async (request: any) => {
    const rule = notionPageRule();
    return {
      integration: notionView(request.user!.id),
      kunci: secretsKeyState(),
      batas: {
        pembuatanHalaman: rule.max,
        jendelaMenit: Math.round(rule.windowMs / 60000),
        halamanDisimpan: MAX_PAGES_KEPT,
        judulMaks: MAX_TITLE_CHARS,
        isiMaks: MAX_CONTENT_CHARS,
        tokenMaks: MAX_TOKEN_CHARS,
      },
      catatan:
        "Token disimpan tersegel dan tidak pernah dikembalikan API. Alamat dasar Notion diambil dari NOTION_API_BASE dan wajib ada di daftar putih konektor.",
    };
  });

  app.put("/api/v1/integrations/notion", { preHandler: requireUser }, async (request: any, reply: any) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hasil = await connectNotionToken(request.user!.id, body.token);
    if (!hasil.ok) return fail(reply, hasil.status, hasil.kode, hasil.pesan);
    return reply.code(200).send({
      integration: hasil.view,
      workspace: hasil.workspace,
      pesan: "Token tersimpan tersegel dan sudah diverifikasi ke Notion.",
    });
  });

  app.delete("/api/v1/integrations/notion", { preHandler: requireUser }, async (request: any, reply: any) => {
    const row = notionRow(request.user!.id);
    if (!row) return fail(reply, 404, "NOTION_NOT_CONNECTED", "Notion belum tersambung.");
    db.prepare("DELETE FROM user_integrations WHERE id=? AND user_id=?").run(row.id, request.user!.id);
    audit(request.user!.id, "integration.disconnected", { provider: NOTION_PROVIDER });
    return { deleted: true, provider: NOTION_PROVIDER };
  });

  app.post("/api/v1/integrations/notion/pages", { preHandler: requireUser }, async (request: any, reply: any) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hasil = await createNotionPage(request.user!.id, { title: body.title, content: body.content, parentPageId: body.parentPageId });
    if (!hasil.ok) return fail(reply, hasil.status, hasil.kode, hasil.pesan, hasil.detail ?? {});
    return reply.code(201).send({ halaman: hasil.halaman, integration: hasil.view });
  });
}

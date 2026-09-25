/**
 * Wave 11C (butir 73) — grup chat multi-agen.
 *
 * Kontrak pemasangan rute: `registerGroupRoutes(app)` dipanggil sekali dari `wave11c/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 73.
 *
 * Aturan butir ini yang menentukan bentuk kode:
 *   • Percakapan grup memakai tabel `conversations` yang sudah ada, dibedakan oleh `kind='group'`,
 *     dan pesertanya dicatat di `conversation_participants`. Tidak ada tabel baru.
 *   • Maksimum `config.GROUP_MAX_PARTICIPANTS` peserta. Lebih dari itu ditolak
 *     (400 GROUP_PARTICIPANT_LIMIT), bukan dipotong diam-diam.
 *   • Peserta diambil dari persona yang SUDAH ADA (`agent_personas`) dan harus milik akun pemanggil.
 *     Model satu giliran mengikuti model persona peserta, jadi peserta bisa memakai model berbeda.
 *   • TIAP GILIRAN = SATU `run` NYATA. Baris `runs` ditulis oleh `createRunAndDispatch`
 *     (wave11b/dispatch.ts), yaitu jalur eksekusi yang sama dengan chat dan jadwal. Karena itu
 *     biaya tiap giliran terlihat di `run_usage` per run, bukan hasil hitungan modul ini.
 *   • Peserta yang gagal (model mati / mesin menolak) TIDAK menghentikan grup: permintaan giliran
 *     tetap dibalas 202 (diterima), kegagalannya muncul sebagai `runs.status='failed'` +
 *     `error_code`, dan giliran peserta lain tetap bisa jalan.
 *   • Isolasi ruang kerja memakai `conversationAccess` yang sama dengan percakapan biasa, jadi
 *     percakapan grup milik ruang kerja lain tidak bisa disentuh (404/403).
 *   • Giliran melewati gerbang yang sama dengan jalur chat sebelum run dibuat: penjaga pemakaian
 *     ruang kerja (`workspace-guard.ts` — batas biaya harian/bulanan dan batas jumlah run), kuota
 *     paket, prompt guard, dan aturan larangan akun. Jawaban penjaga diteruskan apa adanya.
 *   • SATU giliran berjalan per percakapan (kunci giliran). Pemeriksaan "masih ada run berjalan" dan
 *     pembuatan run terjadi di dalam SATU transaksi tulis SQLite (`db.transaction(...).immediate()`),
 *     jadi dua permintaan bersamaan tidak bisa sama-sama membuat run (balasan dobel + biaya dobel).
 *     Yang kalah dijawab 409 GROUP_TURN_BUSY tanpa menulis baris `runs`/`messages` baru. Isi
 *     transaksi seluruhnya sinkron: kunci tulis tidak pernah disandang melewati `await`.
 *
 * Catatan jujur (batas yang tidak bisa ditutup modul ini):
 *   • Sesi mesin satu percakapan dipakai bersama semua peserta, karena `executeRun` memilih sesi
 *     dari `conversationId` (jalur eksekusi milik server.ts). Konteks grup yang dipakai ulang di
 *     sini karena itu disusun dari riwayat pesan percakapan, bukan dari sesi terpisah per peserta.
 *   • Kunci giliran memakai baris `runs` yang tertaut ke percakapan lewat `messages.run_id`, karena
 *     tabel `runs` TIDAK punya kolom `conversation_id` (lihat db.ts). Status yang dianggap
 *     "berjalan" hanya `queued` dan `running` — CHECK constraint `runs` memang hanya mengenal
 *     queued/running/completed/failed/cancelled, jadi `waiting_approval` (status milik
 *     `workflow_executions`) tidak dipakai di sini.
 *   • Batas jujur kunci ini: bila proses mati saat run berstatus `running` (atau run nyangkut),
 *     kunci baru lepas setelah `reapAbandonedRuns` (jobs.ts) menandai run itu `failed` — batasnya
 *     `JOB_ORPHAN_AFTER_MS`, bawaan 45 menit. Tidak ada kunci cadangan di memori, jadi tidak ada
 *     kunci yang bisa nyangkut setelah proses hidup kembali.
 */
import { randomUUID } from "node:crypto";
import { requireUser } from "../auth.js";
import { quotaGuard } from "../billing.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { hijackMessage, scanPromptHijack } from "../prompt-guard.js";
import { guardrailViolations, recordSafetyEvent } from "../wave11a/guardrails.js";
import { audit, conversationAccess, fail, mayWrite } from "../wave11a/shared.js";
import { createRunAndDispatch, isKnownModelName, isThinkingLevelName } from "../wave11b/dispatch.js";
import { guardWorkspaceUsage } from "../workspace-guard.js";

/** Batas bentuk data grup; dipakai rute dan uji. */
export const GROUP_TITLE_MAX_CHARS = 120;
export const GROUP_LABEL_MAX_CHARS = 60;
export const GROUP_TURN_MAX_CHARS = 20_000;
/** Riwayat yang disisipkan ke prompt giliran: jumlah pesan dan panjang totalnya dibatasi. */
export const GROUP_TRANSCRIPT_MESSAGES = 40;
export const GROUP_TRANSCRIPT_CHARS = 12_000;

export type PesertaGrup = { personaId: string; label: string };

/** Label yang dipakai bila pemanggil tidak menyebut label peserta. */
function labelBawaan(nama: string | null | undefined, personaId: string): string {
  const bersih = String(nama ?? "").trim();
  return (bersih || `Agen ${personaId.slice(0, 8)}`).slice(0, GROUP_LABEL_MAX_CHARS);
}

/**
 * Memeriksa daftar peserta dari badan permintaan.
 *
 * Urutan pemeriksaan sengaja: batas jumlah lebih dulu, lalu bentuk tiap peserta, lalu duplikat, dan
 * terakhir keberadaan persona. Dengan begitu daftar yang terlalu panjang selalu dijawab
 * GROUP_PARTICIPANT_LIMIT, bukan galat lain yang menyembunyikan masalah utamanya.
 */
export function periksaPeserta(mentah: unknown, userId: string): { error?: { code: string; message: string }; peserta?: PesertaGrup[] } {
  if (!Array.isArray(mentah)) {
    return { error: { code: "GROUP_PARTICIPANTS_REQUIRED", message: "Daftar peserta grup wajib diisi." } };
  }
  if (mentah.length > config.GROUP_MAX_PARTICIPANTS) {
    return { error: { code: "GROUP_PARTICIPANT_LIMIT", message: `Percakapan grup maksimal ${config.GROUP_MAX_PARTICIPANTS} peserta.` } };
  }
  if (mentah.length < 2) {
    return { error: { code: "GROUP_PARTICIPANTS_MIN", message: "Percakapan grup butuh minimal 2 peserta." } };
  }
  const peserta: PesertaGrup[] = [];
  for (const item of mentah) {
    const personaId = String((item as { personaId?: unknown })?.personaId ?? "").trim();
    if (!personaId) return { error: { code: "GROUP_PARTICIPANT_INVALID", message: "Setiap peserta grup harus menyebut personaId." } };
    const labelMentah = String((item as { label?: unknown })?.label ?? "").trim();
    if (labelMentah.length > GROUP_LABEL_MAX_CHARS) {
      return { error: { code: "GROUP_PARTICIPANT_INVALID", message: `Label peserta maksimal ${GROUP_LABEL_MAX_CHARS} karakter.` } };
    }
    const row = db.prepare("SELECT id, name FROM agent_personas WHERE id=? AND user_id=?").get(personaId, userId) as
      { id: string; name: string } | undefined;
    if (!row) return { error: { code: "PERSONA_NOT_FOUND", message: "Persona peserta tidak ditemukan di akun ini." } };
    peserta.push({ personaId: row.id, label: labelMentah ? labelMentah.slice(0, GROUP_LABEL_MAX_CHARS) : labelBawaan(row.name, row.id) });
  }
  if (new Set(peserta.map((item) => item.personaId)).size !== peserta.length) {
    return { error: { code: "GROUP_PARTICIPANT_DUPLICATE", message: "Persona yang sama tidak boleh jadi peserta dua kali." } };
  }
  return { peserta };
}

/* ------------------------------------------------------- kunci giliran (satu run berjalan per grup) */
/**
 * Status `runs` yang berarti "giliran masih berjalan". Diambil dari CHECK constraint tabel `runs`
 * (db.ts): status yang sah hanya queued/running/completed/failed/cancelled. `waiting_approval`
 * TIDAK ada di situ — status itu milik `workflow_executions`, jadi sengaja tidak dipakai.
 */
export const RUN_BERJALAN: readonly string[] = ["queued", "running"];

/**
 * Run yang belum selesai untuk sebuah percakapan, atau null bila grup sedang senggang.
 *
 * Tautan percakapan → run lewat `messages.run_id`: tabel `runs` tidak punya kolom `conversation_id`,
 * jadi pesan (pengguna dan jawaban) yang menunjuk run itu satu-satunya jejak yang ada.
 */
export function giliranBerjalan(conversationId: string): { runId: string; status: string } | null {
  const row = db.prepare(`SELECT r.id AS runId, r.status AS status
    FROM messages m JOIN runs r ON r.id = m.run_id
    WHERE m.conversation_id=? AND r.status IN ('queued','running')
    ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`).get(conversationId) as { runId: string; status: string } | undefined;
  return row ? { runId: String(row.runId), status: String(row.status) } : null;
}

type BarisPeserta = { id: string; personaId: string | null; label: string; createdAt: string };

/** Peserta satu percakapan grup, urut waktu pendaftaran. */
export function pesertaGrup(conversationId: string): BarisPeserta[] {
  return db.prepare(`SELECT id, persona_id AS personaId, label, created_at AS createdAt
    FROM conversation_participants WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC`)
    .all(conversationId) as BarisPeserta[];
}

/** Persona milik pengguna: nama untuk label dan model untuk giliran. */
function personaMilik(userId: string, personaId: string | null): { name: string; model: string | null; thinking: string | null } | null {
  if (!personaId) return null;
  const row = db.prepare("SELECT name, model, thinking_level AS thinking FROM agent_personas WHERE id=? AND user_id=?")
    .get(personaId, userId) as { name: string; model: string | null; thinking: string | null } | undefined;
  return row ?? null;
}

type BarisRiwayat = { role: string; content: string; runId: string | null; personaId: string | null };

/**
 * Riwayat pesan percakapan grup beserta pemilik giliran.
 *
 * Pemilik giliran diambil lewat `runs.persona_id`: pesan pengguna maupun jawaban agen pada satu
 * giliran menunjuk run yang sama, dan run itu menyimpan persona pembicara. Jadi tidak perlu kolom
 * baru untuk mencatat siapa yang bicara.
 */
export function riwayatGiliran(conversationId: string, batas: number = GROUP_TRANSCRIPT_MESSAGES): BarisRiwayat[] {
  return db.prepare(`SELECT m.role AS role, m.content AS content, m.run_id AS runId, r.persona_id AS personaId
    FROM messages m LEFT JOIN runs r ON r.id = m.run_id
    WHERE m.conversation_id=? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`)
    .all(conversationId, Math.max(1, batas)).reverse() as BarisRiwayat[];
}

/** Peta personaId -> label peserta, untuk menamai pembicara di riwayat. */
function petaLabel(conversationId: string): Map<string, string> {
  const peta = new Map<string, string>();
  for (const row of pesertaGrup(conversationId)) if (row.personaId) peta.set(String(row.personaId), row.label);
  return peta;
}

/**
 * Prompt satu giliran: peserta yang bicara, daftar peserta, riwayat sebelumnya, lalu isi giliran.
 * Riwayat dipotong dari yang TERBARU, supaya konteks grup tetap dipakai tanpa melampaui batas.
 */
export function promptGiliran(input: { title: string; label: string; peserta: BarisPeserta[]; riwayat: BarisRiwayat[]; peta: Map<string, string>; konten: string }): string {
  const potongan: string[] = [];
  let total = 0;
  for (const pesan of [...input.riwayat].reverse()) {
    const nama = (pesan.personaId ? input.peta.get(String(pesan.personaId)) : null) ?? (pesan.role === "assistant" ? "Agen" : "Pengguna");
    const baris = `${nama}: ${String(pesan.content).replace(/\s+/g, " ").trim()}`;
    if (total + baris.length > GROUP_TRANSCRIPT_CHARS) break;
    total += baris.length;
    potongan.push(baris);
  }
  const kepala = [
    `Anda mewakili peserta "${input.label}" di percakapan grup "${input.title}".`,
    `Peserta grup: ${input.peserta.map((row) => row.label).join(", ")}.`,
    "Jawab hanya sebagai peserta itu, singkat dan jelas, dan jangan mengaku sebagai peserta lain.",
  ];
  const isiRiwayat = potongan.length ? ["", "Giliran sebelumnya (paling lama ke paling baru):", ...potongan.reverse()] : ["", "Belum ada giliran sebelumnya."];
  return [...kepala, ...isiRiwayat, "", `Giliran sekarang dari ${input.label}:`, input.konten].join("\n");
}

/** Bentuk jawaban percakapan grup; peserta disertakan supaya klien tidak perlu membaca dua rute. */
function tampilanGrup(conversationId: string, userId: string) {
  const row = db.prepare(`SELECT c.id, c.project_id AS projectId, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
      p.workspace_id AS workspaceId
    FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=?`).get(conversationId) as
    { id: string; projectId: string; title: string; createdAt: string; updatedAt: string; workspaceId: string } | undefined;
  if (!row) return null;
  const peserta = pesertaGrup(conversationId).map((baris) => {
    const persona = personaMilik(userId, baris.personaId);
    return { id: baris.id, personaId: baris.personaId, label: baris.label, personaName: persona?.name ?? null, model: persona?.model ?? null };
  });
  return { id: row.id, projectId: row.projectId, workspaceId: row.workspaceId, title: row.title, kind: "group", participants: peserta, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * Memasang rute grup chat multi-agen:
 *   POST /api/v1/group-conversations            -> membuat percakapan grup (201)
 *   GET  /api/v1/group-conversations/:id        -> grup + peserta + daftar giliran
 *   POST /api/v1/group-conversations/:id/turns  -> satu giliran peserta = satu run nyata (202)
 */
export function registerGroupRoutes(app: any): void {
  app.post("/api/v1/group-conversations", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const projectId = String(request.body?.projectId ?? "").trim();
    if (!projectId) return fail(reply, 400, "GROUP_PROJECT_REQUIRED", "Sebutkan proyek tempat percakapan grup dibuat.");
    const akses = db.prepare(`SELECT p.id AS projectId, p.workspace_id AS workspaceId, m.role AS role
      FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?`)
      .get(projectId, userId) as { projectId: string; workspaceId: string; role: string } | undefined;
    if (!akses) return fail(reply, 404, "PROJECT_NOT_FOUND", "Proyek itu bukan milik Anda.");
    if (!mayWrite(akses.role)) return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran viewer hanya bisa membaca, jadi tidak bisa membuat grup.");

    const hasil = periksaPeserta(request.body?.participants, userId);
    if (hasil.error) return fail(reply, 400, hasil.error.code, hasil.error.message);

    const title = String(request.body?.title ?? "").trim().slice(0, GROUP_TITLE_MAX_CHARS) || "Grup multi-agen";
    const id = randomUUID();
    const now = new Date().toISOString();
    const transaction = db.transaction(() => {
      // `kind` ditulis eksplisit; kolomnya punya bawaan 'solo' untuk percakapan biasa.
      db.prepare("INSERT INTO conversations (id,project_id,title,created_at,updated_at,kind) VALUES (?,?,?,?,?,'group')")
        .run(id, akses.projectId, title, now, now);
      for (const peserta of hasil.peserta!) {
        db.prepare("INSERT INTO conversation_participants (id,conversation_id,persona_id,label,created_at) VALUES (?,?,?,?,?)")
          .run(randomUUID(), id, peserta.personaId, peserta.label, now);
      }
    });
    transaction();
    audit(userId, "group.created", { conversationId: id, projectId: akses.projectId, peserta: hasil.peserta!.length, labels: hasil.peserta!.map((item) => item.label) });
    return reply.code(201).send({ conversation: tampilanGrup(id, userId) });
  });

  app.get("/api/v1/group-conversations/:id", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const akses = conversationAccess(request.params.id, userId);
    if (!akses || !grupMilik(akses.id)) return fail(reply, 404, "GROUP_NOT_FOUND", "Percakapan grup itu tidak ada atau bukan milik Anda.");
    const grup = tampilanGrup(akses.id, userId)!;
    // Daftar giliran: satu baris per pesan pengguna, dilengkapi status run dan biayanya.
    const giliran = db.prepare(`SELECT m.id AS messageId, m.content, m.run_id AS runId, m.created_at AS createdAt,
        r.status AS runStatus, r.error_code AS errorCode, r.persona_id AS personaId,
        COALESCE(u.cost_micros,0) AS costMicros, COALESCE(u.sell_cost_micros,0) AS billedMicros,
        (SELECT COUNT(*) FROM messages a WHERE a.run_id=m.run_id AND a.role='assistant') AS answered
      FROM messages m LEFT JOIN runs r ON r.id=m.run_id LEFT JOIN run_usage u ON u.run_id=m.run_id
      WHERE m.conversation_id=? AND m.role='user' ORDER BY m.created_at ASC, m.rowid ASC`).all(akses.id) as any[];
    const peta = petaLabel(akses.id);
    return {
      conversation: grup,
      turns: giliran.map((row) => ({
        messageId: row.messageId, content: row.content, runId: row.runId, createdAt: row.createdAt,
        speakerLabel: (row.personaId ? peta.get(String(row.personaId)) : null) ?? null,
        runStatus: row.runStatus ?? null, errorCode: row.errorCode ?? null,
        answered: Number(row.answered) > 0, costMicros: Number(row.costMicros), billedMicros: Number(row.billedMicros),
      })),
      catatan: "Setiap giliran adalah satu run nyata: biaya per giliran ada di kolom costMicros/billedMicros dari run_usage run itu.",
    };
  });

  app.post("/api/v1/group-conversations/:id/turns", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const akses = conversationAccess(request.params.id, userId);
    if (!akses || !grupMilik(akses.id)) return fail(reply, 404, "GROUP_NOT_FOUND", "Percakapan grup itu tidak ada atau bukan milik Anda.");
    if (!mayWrite(akses.role)) return fail(reply, 403, "VIEWER_FORBIDDEN", "Peran viewer hanya bisa membaca, jadi tidak bisa bicara di grup.");

    const content = String(request.body?.content ?? "").trim();
    if (!content) return fail(reply, 400, "GROUP_TURN_REQUIRED", "Isi giliran belum diisi.");
    if (content.length > GROUP_TURN_MAX_CHARS) return fail(reply, 400, "GROUP_TURN_TOO_LONG", `Isi giliran maksimal ${GROUP_TURN_MAX_CHARS} karakter.`);

    const peserta = pesertaGrup(akses.id);
    const speaker = String(request.body?.speaker ?? "").trim();
    if (!speaker) return fail(reply, 400, "GROUP_SPEAKER_REQUIRED", "Sebutkan peserta yang bicara (speaker).");
    const pembicara = peserta.find((row) => row.personaId === speaker) ?? peserta.find((row) => row.label.toLowerCase() === speaker.toLowerCase());
    if (!pembicara) return fail(reply, 400, "GROUP_SPEAKER_NOT_PARTICIPANT", "Pembicara itu bukan peserta percakapan grup ini.");

    // Penjaga biaya/kecepatan ruang kerja: modul yang SAMA dengan jalur chat (`workspace-guard.ts`), bukan
    // salinannya. Dijalankan sebelum kuota paket, sama seperti urutan di server.ts.
    const blokirRuangKerja = guardWorkspaceUsage(akses.workspaceId);
    if (blokirRuangKerja) {
      // Diteruskan apa adanya: status + error + isi `detail` disebar ke aras atas, PERSIS bentuk
      // jalur chat dan eksekusi workflow di server.ts (`{ error, ...detail }`). Tanpa pesan karangan
      // dan tanpa kunci `detail` tersendiri, supaya paritas bentuk jawaban terjaga.
      return reply.code(blokirRuangKerja.status).send({ error: blokirRuangKerja.error, ...(blokirRuangKerja.detail ?? {}) });
    }

    const blokirKuota = quotaGuard(userId, akses.workspaceId);
    if (blokirKuota) return fail(reply, blokirKuota.status, blokirKuota.error, String(blokirKuota.detail?.message ?? "Kuota token paket Anda sudah habis."), blokirKuota.detail ?? {});
    // Pengaman yang sama dengan jalur chat: penyerangan prompt dan aturan larangan akun.
    if (config.PROMPT_GUARD_ENABLED) {
      const hijack = scanPromptHijack(content);
      if (hijack.blocked) {
        audit(userId, "prompt_hijack_blocked", { conversationId: akses.id, grup: true, pola: hijack.pattern, kategori: hijack.category });
        return fail(reply, 400, "PROMPT_BLOCKED", hijackMessage(hijack.pattern), { pola: hijack.pattern, kategori: hijack.category });
      }
    }
    const pelanggaran = guardrailViolations(userId, content);
    if (pelanggaran.length) {
      for (const hit of pelanggaran) {
        recordSafetyEvent({ userId, ruleId: hit.rule.id, pattern: hit.pattern, snippet: content });
        audit(userId, "safety_violation", { conversationId: akses.id, grup: true, ruleId: hit.rule.id, judul: hit.rule.title, pola: hit.pattern });
      }
      return fail(reply, 400, "GUARDRAIL_BLOCKED", `Permintaan ini dilarang aturan "${pelanggaran[0].rule.title}". Aksi tidak dijalankan.`);
    }

    const persona = personaMilik(userId, pembicara.personaId);
    const modelDiminta = String(request.body?.model ?? "").trim();
    if (modelDiminta && !isKnownModelName(modelDiminta)) return fail(reply, 400, "UNKNOWN_MODEL", "Nama model itu tidak dikenal mesin.");
    const model = modelDiminta || persona?.model || null;
    const thinking = isThinkingLevelName(persona?.thinking) ? String(persona?.thinking) : undefined;

    const prompt = promptGiliran({
      title: akses.title, label: pembicara.label, peserta,
      riwayat: riwayatGiliran(akses.id), peta: petaLabel(akses.id), konten: content,
    });
    const messageId = randomUUID();
    const now = new Date().toISOString();

    /* ------------------------------------------ kunci giliran: periksa + klaim, SATU transaksi tulis
     * Kenapa harus transaksi: kalau pemeriksaan "masih ada run berjalan" dilakukan di luar, dua
     * permintaan bersamaan sama-sama lolos dan grup dapat dua run (balasan dobel + biaya dobel).
     * `BEGIN IMMEDIATE` (lewat `.immediate()`) mengambil kunci tulis SQLite lebih dulu, sehingga
     * pemeriksaan dan penyisipan run menjadi satu satuan yang tidak bisa disela proses lain.
     * Seluruh isi transaksi SINKRON: kunci tulis tidak pernah disandang melewati `await`, jadi tidak
     * ada peluang saling menunggu. Bila ada giliran berjalan, transaksi mengembalikan `sibuk` dan
     * TIDAK menulis apa pun.
     */
    let klaim: { jenis: "sibuk"; sibuk: { runId: string; status: string } }
      | { jenis: "klaim"; runId: string; janji: Promise<{ runId: string; jalur: "langsung" | "antrean" }> };
    try {
      klaim = db.transaction(() => {
        const sibuk = giliranBerjalan(akses.id);
        if (sibuk) return { jenis: "sibuk" as const, sibuk };

        // Pesan pengguna ditulis lebih dulu (seperti jalur chat) supaya konteks run memuatnya.
        db.prepare("INSERT INTO messages (id,conversation_id,role,content,run_id,created_at) VALUES (?,?,'user',?,NULL,?)")
          .run(messageId, akses.id, content, now);
        db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, akses.id);

        // Baris `runs` tetap dibuat oleh jalur yang sama dengan semua run lain (wave11b/dispatch.ts):
        // badan `createRunAndDispatch` berjalan sinkron sampai selesai (tidak ada `await` di dalamnya),
        // jadi penyisipan `runs` ikut masuk transaksi ini. Itu letak keatomikannya.
        const rowidSebelum = Number((db.prepare("SELECT COALESCE(MAX(rowid),0) AS rowid FROM runs").get() as { rowid: number }).rowid);
        const janji = createRunAndDispatch({
          projectId: akses.projectId, prompt, userId, conversationId: akses.id,
          model, thinking, personaId: pembicara.personaId,
        });
        // Kenali baris yang baru masuk (`runs` tidak punya kolom `conversation_id`), lalu tautkan pesan
        // ke run itu MASIH di transaksi yang sama — jadi klaim "grup sibuk" sudah utuh (pesan → run)
        // sejak commit, tanpa jendela waktu di mana run ada tetapi belum tertaut.
        const barisBaru = db.prepare("SELECT id FROM runs WHERE rowid > ? ORDER BY rowid ASC").all(rowidSebelum) as { id: string }[];
        if (barisBaru.length !== 1) throw new Error(`GROUP_TURN_CLAIM_LOST: ${barisBaru.length} baris runs baru di dalam transaksi`);
        const runIdKlaim = String(barisBaru[0].id);
        db.prepare("UPDATE messages SET run_id=? WHERE id=?").run(runIdKlaim, messageId);
        return { jenis: "klaim" as const, runId: runIdKlaim, janji };
      }).immediate();
    } catch (galat) {
      // Transaksi yang gagal sudah di-rollback, jadi tidak ada run/pesan yang menggantung.
      const pesan = String((galat as Error)?.message ?? galat);
      if (pesan.includes("SQLITE_BUSY")) {
        return fail(reply, 503, "GROUP_TURN_RETRY", "Basis data sedang sibuk menulis. Kirim ulang giliran itu sebentar lagi.");
      }
      audit(userId, "group.turn_claim_failed", { conversationId: akses.id, error: pesan.slice(0, 200) });
      return fail(reply, 500, "GROUP_TURN_CLAIM_FAILED", "Giliran gagal diklaim karena keadaan basis data tidak terduga. Tidak ada run atau pesan yang dibuat.");
    }

    if (klaim.jenis === "sibuk") {
      // Grup masih memproses giliran sebelumnya: ditolak SEBELUM ada baris `runs`/`messages` baru.
      return fail(reply, 409, "GROUP_TURN_BUSY", "Grup ini masih memproses giliran sebelumnya. Tunggu sampai balasannya selesai.",
        { runId: klaim.sibuk.runId, status: klaim.sibuk.status });
    }

    const { runId, jalur } = await klaim.janji;
    if (String(runId) !== klaim.runId) {
      // Tidak seharusnya terjadi: satu-satunya baris `runs` baru di transaksi itu milik panggilan ini.
      // Kalau toh terjadi, lebih baik gagal berisik daripada pesan menunjuk run yang salah.
      audit(userId, "group.turn_claim_mismatch", { conversationId: akses.id, klaim: klaim.runId, dikirim: String(runId) });
      return fail(reply, 500, "GROUP_TURN_CLAIM_FAILED", "Klaim giliran tidak cocok dengan run yang dikirim. Periksa catatan audit sebelum mengulang.");
    }
    audit(userId, "group.turn", { conversationId: akses.id, runId, speaker: pembicara.personaId, label: pembicara.label, model, chars: content.length, jalur });

    // Balasan 202 diterima walau mesin nanti menolak: peserta yang gagal tidak menghentikan grup.
    return reply.code(202).send({
      turn: {
        messageId, conversationId: akses.id, content, runId, status: "queued", jalur,
        speaker: { personaId: pembicara.personaId, label: pembicara.label }, model,
        participants: peserta.length, transcriptMessages: riwayatGiliran(akses.id).length,
      },
      catatan: "Giliran ini berjalan sebagai satu run nyata. Bila mesin menolak, run itu berstatus failed dan peserta lain tetap bisa bicara.",
    });
  });
}

/** True bila percakapan memang bertipe grup (percakapan biasa selalu false). */
export function grupMilik(conversationId: string): boolean {
  const row = db.prepare("SELECT kind FROM conversations WHERE id=?").get(conversationId) as { kind?: string } | undefined;
  return String(row?.kind ?? "solo") === "group";
}

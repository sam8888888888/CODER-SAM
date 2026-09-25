/**
 * Wave 11B (64) — Ekspor / Impor Agen.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 64; jangan diubah pemilik butir lain.
 *
 * Aturan inti: impor TIDAK PERNAH menimpa persona yang sudah ada. Nama yang bentrok dilewati dan
 * dilaporkan pada `skipped`, dan persona lama tidak disentuh sama sekali.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireUser } from "../auth.js";
import { audit, fail } from "../wave11a/shared.js";

/** Tingkat berpikir yang sah; sama dengan daftar di server.ts (tidak diimpor karena tidak diekspor). */
const TINGKAT_BERPIKIR = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const NAMA_MAKS = 120;
const PROMPT_MAKS = 8000;

const teks = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

/** Memasang rute GET /api/v1/personas/export dan POST /api/v1/personas/import. */
export function registerPersonaTransferRoutes(app: any): void {
  /**
   * Ekspor: berkas JSON siap unduh. Hanya persona milik pemanggil yang ikut; persona pengguna lain
   * tidak pernah masuk ke berkas ini.
   */
  app.get("/api/v1/personas/export", { preHandler: requireUser }, async (request: any, reply: any) => {
    const personas = db.prepare(`SELECT name, system_prompt AS systemPrompt, tone, language, model,
        thinking_level AS thinkingLevel FROM agent_personas WHERE user_id=? ORDER BY name LIMIT 200`).all(request.user!.id);
    const berkas = { versi: 1, dieksporPada: new Date().toISOString(), personas };
    return reply
      .header("Content-Disposition", 'attachment; filename="coder-personas.json"')
      .type("application/json; charset=utf-8")
      .send(JSON.stringify(berkas, null, 2));
  });

  /** Impor: butir baru ditambahkan, nama yang bentrok dilewati dan dilaporkan. */
  app.post("/api/v1/personas/import", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = String(request.user!.id);
    const batas = Number(config.PERSONA_IMPORT_LIMIT) || 50;
    const daftar = request.body?.personas;
    if (!Array.isArray(daftar)) {
      return fail(reply, 400, "INVALID_IMPORT", "Berkas impor tidak sah: bentuknya harus { personas: [ ... ] }.");
    }
    if (daftar.length > batas) {
      return fail(reply, 400, "IMPORT_LIMIT_REACHED", `Impor dibatasi ${batas} persona sekali jalan; berkas ini berisi ${daftar.length}.`, { limit: batas, jumlah: daftar.length });
    }
    // Setiap butir wajib punya `name` yang tidak kosong; satu butir cacat menolak seluruh berkas.
    const adaYangCacat = daftar.some((butir: unknown) => !butir || typeof butir !== "object" || Array.isArray(butir) || !teks((butir as any).name, NAMA_MAKS));
    if (adaYangCacat) {
      return fail(reply, 400, "INVALID_IMPORT", "Berkas impor tidak sah: setiap butir wajib punya name.");
    }

    // Perbandingan nama tidak memandang huruf besar/kecil supaya "Penulis" dan "penulis" tidak
    // menjadi dua persona yang tampak sama.
    const sudahAda = new Set<string>(
      (db.prepare("SELECT name FROM agent_personas WHERE user_id=?").all(userId) as { name: string }[])
        .map((row) => String(row.name).trim().toLowerCase()),
    );
    const ditambahkan: string[] = [];
    const dilewati: string[] = [];
    let tingkatDibetulkan = 0;
    let tanpaPrompt = 0;
    const sekarang = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO agent_personas (id,user_id,name,system_prompt,tone,language,model,thinking_level,is_default,use_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`);
    const jalan = db.transaction(() => {
      for (const butir of daftar as any[]) {
        const nama = teks(butir.name, NAMA_MAKS);
        const kunci = nama.toLowerCase();
        if (sudahAda.has(kunci)) { dilewati.push(nama); continue; }
        const systemPrompt = String(butir.systemPrompt ?? "").slice(0, PROMPT_MAKS);
        if (!systemPrompt.trim()) tanpaPrompt += 1;
        const tingkatMinta = teks(butir.thinkingLevel, 20);
        const tingkat = TINGKAT_BERPIKIR.includes(tingkatMinta) ? tingkatMinta : "medium";
        if (tingkatMinta && tingkat !== tingkatMinta) tingkatDibetulkan += 1;
        const model = butir.model === null || butir.model === undefined ? null : (teks(butir.model, 120) || null);
        insert.run(randomUUID(), userId, nama, systemPrompt, String(butir.tone ?? "").slice(0, 300),
          butir.language === "en" ? "en" : "id", model, tingkat, sekarang, sekarang);
        sudahAda.add(kunci); // nama yang baru ditambahkan ikut dianggap sudah ada untuk butir berikutnya
        ditambahkan.push(nama);
      }
    });
    jalan();

    // Audit mencatat angka nyata; nama yang dilewati disimpan agar laporan bisa ditelusuri.
    audit(userId, "personas_import", {
      added: ditambahkan.length, skipped: dilewati.length, total: daftar.length,
      skippedNames: dilewati.slice(0, 50),
    });

    return {
      added: ditambahkan.length,
      skipped: dilewati,
      total: daftar.length,
      catatan: [
        `${ditambahkan.length} persona ditambahkan, ${dilewati.length} dilewati karena namanya sudah ada, dari ${daftar.length} butir di berkas.`,
        "Persona lama tidak diubah: nama yang bentrok hanya dilewati.",
        "Nama dibandingkan tanpa memandang huruf besar/kecil, dan nama kembar di dalam satu berkas juga dilewati.",
        `Batas impor sekali jalan ${batas} persona (config.PERSONA_IMPORT_LIMIT).`,
        tingkatDibetulkan ? `${tingkatDibetulkan} butir memakai tingkat berpikir yang tidak dikenal, jadi disimpan sebagai "medium".` : "",
        tanpaPrompt ? `${tanpaPrompt} butir tidak mengirim systemPrompt, jadi tersimpan dengan system prompt kosong.` : "",
        "Kolom model diteruskan apa adanya dari berkas; kecocokannya diperiksa saat persona itu dipakai.",
      ].filter(Boolean).join(" "),
    };
  });
}

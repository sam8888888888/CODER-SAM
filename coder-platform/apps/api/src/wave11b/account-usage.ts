/**
 * Wave 11B (65) — Metrik jujur + pemakaian & audit pribadi.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 65; jangan diubah pemilik butir lain.
 *
 * Semua angka dihitung langsung dari baris nyata `run_usage` / `audit_events` dan tidak dibulatkan
 * demi kelihatan bagus. Definisi setiap angka ditulis apa adanya di `catatan`.
 */
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { fail } from "../wave11a/shared.js";

/** Bentuk `period` yang diterima: hanya `<angka>d` (mis. 7d, 30d, 90d). */
const POLA_PERIOD = /^(\d{1,4})d$/;
const PERIOD_MAKS_HARI = 3650;
const AUDIT_MAKS_HARI = 365;
const AUDIT_MAKS_BARIS = 500;

/**
 * Cakupan baris pemakaian milik satu pengguna.
 *
 * `run_usage` tidak menyimpan `user_id` (kolomnya project_id + run_id), jadi keanggotaannya ditentukan
 * lewat ruang kerja proyek tempat baris itu tercatat: baris dihitung bila pengguna adalah anggota
 * ruang kerja proyek tersebut. Pemakaian pengguna lain di ruang kerja lain karena itu tidak terlihat.
 */
const CAKUPAN = `FROM run_usage ru WHERE EXISTS (
    SELECT 1 FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id
    WHERE p.id=ru.project_id AND m.user_id=?) AND ru.created_at >= ?`;

/** Angka token/biaya yang sama dipakai untuk total, per hari, dan per model. */
const KOLOM_ANGKA = `COUNT(*) AS baris,
  COALESCE(SUM(ru.input_tokens),0) AS tokenInput,
  COALESCE(SUM(ru.output_tokens),0) AS tokenOutput,
  COALESCE(SUM(COALESCE(ru.total_tokens, COALESCE(ru.input_tokens,0)+COALESCE(ru.output_tokens,0))),0) AS tokenTotal,
  COALESCE(SUM(CASE WHEN ru.sell_cost_micros IS NOT NULL THEN ru.sell_cost_micros ELSE 0 END),0) AS biayaTerbillingMicros,
  COALESCE(SUM(CASE WHEN ru.sell_cost_micros IS NULL THEN COALESCE(ru.cost_micros,0) ELSE 0 END),0) AS biayaTidakTertagihMicros`;

const angka = (value: unknown) => Number(value ?? 0);

/** Angka pemakaian sendiri, termasuk yang tidak tertagih dan selisih rekonsiliasi. */
export function accountUsageSummary(userId: string, days: number, now: Date = new Date()): any {
  const diminta = Math.floor(Number(days));
  const rentang = Number.isFinite(diminta) ? Math.max(1, Math.min(PERIOD_MAKS_HARI, diminta)) : 30;
  const sejak = new Date(now.getTime() - rentang * 86_400_000).toISOString();

  const total = db.prepare(`SELECT ${KOLOM_ANGKA} ${CAKUPAN}`).get(userId, sejak) as any;
  // Selisih rekonsiliasi hanya bermakna pada baris yang PUNYA harga pokok dan harga jual sekaligus.
  const rekonsiliasi = db.prepare(`SELECT COUNT(*) AS baris, COUNT(DISTINCT ru.run_id) AS jumlahRun,
      COALESCE(SUM(ru.cost_micros),0) AS pokokMicros, COALESCE(SUM(ru.sell_cost_micros),0) AS jualMicros,
      COALESCE(SUM(ru.cost_micros - ru.sell_cost_micros),0) AS selisihMicros
    ${CAKUPAN} AND ru.cost_micros IS NOT NULL AND ru.sell_cost_micros IS NOT NULL`).get(userId, sejak) as any;

  const perHari = db.prepare(`SELECT substr(ru.created_at,1,10) AS tanggal, ${KOLOM_ANGKA} ${CAKUPAN}
    GROUP BY tanggal ORDER BY tanggal ASC`).all(userId, sejak) as any[];
  const perModel = db.prepare(`SELECT COALESCE(ru.model,'(tanpa model)') AS model, ${KOLOM_ANGKA} ${CAKUPAN}
    GROUP BY model ORDER BY tokenTotal DESC, model ASC`).all(userId, sejak) as any[];

  // Pemakaian jalur playground disimpan di tabel lain (user_usage) karena tidak punya project_id.
  // Angka ini TIDAK ikut dijumlahkan di atas, dan itu disebutkan supaya tidak menyesatkan.
  const playground = db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS token, COUNT(*) AS baris FROM user_usage WHERE user_id=? AND created_at>=?")
    .get(userId, sejak) as any;

  const biayaTerbillingMicros = angka(total?.biayaTerbillingMicros);
  const biayaTidakTertagihMicros = angka(total?.biayaTidakTertagihMicros);
  const selisihMicros = angka(rekonsiliasi?.selisihMicros);
  const jumlahRunRekonsiliasi = angka(rekonsiliasi?.jumlahRun);

  return {
    period: `${rentang}d`,
    days: rentang,
    sejak,
    tokenInput: angka(total?.tokenInput),
    tokenOutput: angka(total?.tokenOutput),
    tokenTotal: angka(total?.tokenTotal),
    biayaTerbillingMicros,
    biayaTidakTertagihMicros,
    totalMicros: biayaTerbillingMicros + biayaTidakTertagihMicros,
    rekonsiliasi: {
      selisihMicros,
      jumlahRun: jumlahRunRekonsiliasi,
      catatan: `selisihMicros = SUM(cost_micros) - SUM(sell_cost_micros) untuk ${angka(rekonsiliasi?.baris)} baris`
        + ` (${jumlahRunRekonsiliasi} run) yang kedua kolomnya terisi. Harga pokok ${angka(rekonsiliasi?.pokokMicros)} mikrodolar,`
        + ` harga jual ${angka(rekonsiliasi?.jualMicros)} mikrodolar. Angka ini ditampilkan apa adanya, termasuk bila selisihnya negatif.`,
    },
    perHari: perHari.map((row) => ({
      tanggal: String(row.tanggal ?? ""),
      tokenInput: angka(row.tokenInput),
      tokenOutput: angka(row.tokenOutput),
      tokenTotal: angka(row.tokenTotal),
      biayaTerbillingMicros: angka(row.biayaTerbillingMicros),
      biayaTidakTertagihMicros: angka(row.biayaTidakTertagihMicros),
    })),
    perModel: perModel.map((row) => ({
      model: String(row.model ?? "(tanpa model)"),
      tokenInput: angka(row.tokenInput),
      tokenOutput: angka(row.tokenOutput),
      tokenTotal: angka(row.tokenTotal),
      biayaTerbillingMicros: angka(row.biayaTerbillingMicros),
      biayaTidakTertagihMicros: angka(row.biayaTidakTertagihMicros),
    })),
    catatan: [
      `Rentang ${rentang} hari, sejak ${sejak} (kolom run_usage.created_at).`,
      "biayaTerbillingMicros = SUM(run_usage.sell_cost_micros) yang TIDAK NULL.",
      "biayaTidakTertagihMicros = SUM(run_usage.cost_micros) untuk baris yang sell_cost_micros NULL; baris seperti itu tidak punya harga jual sehingga tidak ikut ditagihkan.",
      "totalMicros = biayaTerbillingMicros + biayaTidakTertagihMicros, bukan angka lain.",
      "selisihMicros = SUM(cost_micros) - SUM(sell_cost_micros) pada baris yang keduanya terisi; lihat rekonsiliasi.catatan.",
      "tokenTotal memakai kolom total_tokens bila terisi; bila kosong dipakai input_tokens + output_tokens.",
      `Cakupan: ${angka(total?.baris)} baris run_usage pada proyek di ruang kerja tempat Anda menjadi anggota; baris pengguna lain tidak dihitung.`,
      angka(playground?.baris) > 0
        ? `Jalur playground (tabel user_usage, ${angka(playground?.baris)} baris, ${angka(playground?.token)} token) TIDAK ikut dijumlahkan di atas karena tabel itu tidak punya project_id.`
        : "Tidak ada pemakaian jalur playground pada rentang ini.",
      "Tidak ada angka yang dibulatkan demi kelihatan bagus; satuan biaya adalah mikrodolar (1.000.000 = 1 dolar).",
    ].join(" "),
  };
}

/** Memasang rute GET /api/v1/account/usage dan GET /api/v1/account/audit. */
export function registerAccountUsageRoutes(app: any): void {
  app.get("/api/v1/account/usage", { preHandler: requireUser }, async (request: any, reply: any) => {
    const mentah = request.query?.period === undefined ? "30d" : String(request.query.period).trim();
    const cocok = POLA_PERIOD.exec(mentah);
    if (!cocok) return fail(reply, 400, "INVALID_PERIOD", "Rentang harus berbentuk seperti 7d, 30d, atau 90d.");
    const hari = Number(cocok[1]);
    if (hari < 1 || hari > PERIOD_MAKS_HARI) {
      return fail(reply, 400, "INVALID_PERIOD", `Rentang hari harus antara 1 dan ${PERIOD_MAKS_HARI}.`);
    }
    return accountUsageSummary(request.user!.id, hari);
  });

  app.get("/api/v1/account/audit", { preHandler: requireUser }, async (request: any, reply: any) => {
    const mentah = request.query?.days === undefined ? 90 : Number(request.query.days);
    if (!Number.isInteger(mentah) || mentah < 1 || mentah > AUDIT_MAKS_HARI) {
      return fail(reply, 400, "INVALID_DAYS", `Rentang hari harus bilangan bulat 1 sampai ${AUDIT_MAKS_HARI}.`);
    }
    const sejak = new Date(Date.now() - mentah * 86_400_000).toISOString();
    // HANYA jejak milik sendiri: actor_user_id harus sama dengan pengguna yang meminta.
    const jumlah = db.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE actor_user_id=? AND created_at>=?").get(request.user!.id, sejak) as { total: number };
    const baris = db.prepare(`SELECT id, action, created_at AS createdAt, metadata_json AS metadataJson
      FROM audit_events WHERE actor_user_id=? AND created_at>=? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(request.user!.id, sejak, AUDIT_MAKS_BARIS) as { id: string; action: string; createdAt: string; metadataJson: string }[];
    const total = Number(jumlah?.total ?? 0);
    return {
      days: mentah,
      sejak,
      total,
      events: baris.map((row) => {
        let metadata: any = {};
        try { metadata = JSON.parse(row.metadataJson || "{}"); } catch { metadata = { rusak: String(row.metadataJson ?? "").slice(0, 200) }; }
        return { id: row.id, action: row.action, createdAt: row.createdAt, metadata };
      }),
      catatan: [
        `Jejak aksi milik Anda sendiri (audit_events.actor_user_id = pengguna ini) dalam ${mentah} hari terakhir, sejak ${sejak}.`,
        `Menampilkan ${baris.length} dari ${total} baris, terbaru lebih dulu${total > baris.length ? `; sisanya dipotong di batas ${AUDIT_MAKS_BARIS} baris` : ""}.`,
        "Baris milik pengguna lain tidak pernah ikut, termasuk bila berada di ruang kerja yang sama.",
      ].join(" "),
    };
  });
}

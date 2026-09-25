/**
 * Wave 11B (67) — Akuntansi token: saldo + proyeksi.
 *
 * Kontrak pemasangan rute: `registerXxxRoutes(app)` dipanggil sekali dari `wave11b/index.ts`
 * (konvensi A2 PRD Wave 11). Berkas ini milik butir 67; jangan diubah pemilik butir lain.
 *
 * Saldo disimpan di `platform_settings` dengan kunci `token_accounting.<YYYY-MM>` berisi JSON
 * `{ tokens, note, updated_at }`. Pemakaian TIDAK dihitung ulang dengan rumus harga baru: ia dijumlah
 * dari tabel pemakaian yang sudah ada (`run_usage` untuk run proyek, `user_usage` untuk panggilan
 * tanpa proyek seperti Playground). Pemilik pemakaian run ditentukan dari anggota pemilik ruang kerja
 * proyeknya (pola yang sama dengan billing.ts), sedangkan `user_usage` sudah memuat `user_id`.
 *
 * Proyeksi SELALU disajikan sebagai perkiraan: rata-rata harian x jumlah hari, disertai `daysElapsed`,
 * label `perkiraan: true`, dan `catatan`. Bulan tanpa pemakaian tidak pernah membagi nol.
 */
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { adminRequired, audit, fail, isPlatformAdmin, platformSetting, savePlatformSetting } from "../wave11a/shared.js";

const POLA_BULAN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** True bila teks berbentuk YYYY-MM yang sah. */
export function validMonth(month: unknown): boolean {
  return POLA_BULAN.test(String(month ?? "").trim());
}

/** Bulan berjalan menurut UTC, mengikuti cara seluruh cap waktu platform disimpan (ISO UTC). */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function batasBulan(month: string): { mulai: string; selesai: string; daysInMonth: number } {
  const [tahun, bulan] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(tahun, bulan, 0)).getUTCDate();
  const nextTahun = bulan === 12 ? tahun + 1 : tahun;
  const nextBulan = bulan === 12 ? 1 : bulan + 1;
  return {
    mulai: `${month}-01T00:00:00.000Z`,
    selesai: `${nextTahun}-${String(nextBulan).padStart(2, "0")}-01T00:00:00.000Z`,
    daysInMonth,
  };
}

/** Saldo tersimpan untuk satu bulan, atau null bila admin belum mengisinya. */
function saldoTersimpan(month: string): { tokens: number; note: string; updatedAt: string } | null {
  const raw = platformSetting(`token_accounting.${month}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { tokens?: number; note?: string; updated_at?: string };
    const tokens = Number(parsed?.tokens);
    if (!Number.isFinite(tokens) || tokens < 0) return null;
    return { tokens: Math.round(tokens), note: String(parsed?.note ?? ""), updatedAt: String(parsed?.updated_at ?? "") };
  } catch {
    // Nilai rusak diperlakukan sebagai "belum diisi", bukan angka tebakan.
    return null;
  }
}

/** Memakai rumus yang sama dengan billing.ts: total_tokens, atau jumlah masuk+keluar bila kolomnya kosong. */
const TOKEN_RUN = "COALESCE(ru.total_tokens, COALESCE(ru.input_tokens,0)+COALESCE(ru.output_tokens,0))";

/**
 * Angka saldo/proyeksi untuk satu bulan (YYYY-MM), dipakai rute dan diuji langsung.
 * `now` dapat diberikan pada uji supaya `daysElapsed` bisa diperiksa tanpa menunggu hari berganti.
 */
export function tokenAccountingFor(month: string, now: Date = new Date()): any {
  const bulan = String(month ?? "").trim();
  if (!validMonth(bulan)) return null;
  const { mulai, selesai, daysInMonth } = batasBulan(bulan);
  const sekarang = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  const terpakaiRun = Number((db.prepare(`SELECT COALESCE(SUM(${TOKEN_RUN}),0) AS tokens FROM run_usage ru WHERE ru.created_at >= ? AND ru.created_at < ?`).get(mulai, selesai) as { tokens: number }).tokens ?? 0);
  const terpakaiUser = Number((db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS tokens FROM user_usage WHERE created_at >= ? AND created_at < ?").get(mulai, selesai) as { tokens: number }).tokens ?? 0);
  const terpakai = terpakaiRun + terpakaiUser;

  // Pemilik pemakaian run: anggota berperan 'owner' pada ruang kerja proyeknya.
  const perRun = db.prepare(`SELECT m.user_id AS userId, COALESCE(u.email,'') AS email, COALESCE(SUM(${TOKEN_RUN}),0) AS tokens
    FROM run_usage ru JOIN projects p ON p.id = ru.project_id
    JOIN memberships m ON m.workspace_id = p.workspace_id AND m.role='owner'
    LEFT JOIN users u ON u.id = m.user_id
    WHERE ru.created_at >= ? AND ru.created_at < ? GROUP BY m.user_id`).all(mulai, selesai) as { userId: string; email: string; tokens: number }[];
  const perUser = db.prepare(`SELECT uu.user_id AS userId, COALESCE(u.email,'') AS email, COALESCE(SUM(uu.total_tokens),0) AS tokens
    FROM user_usage uu LEFT JOIN users u ON u.id = uu.user_id
    WHERE uu.created_at >= ? AND uu.created_at < ? GROUP BY uu.user_id`).all(mulai, selesai) as { userId: string; email: string; tokens: number }[];

  const peta = new Map<string, { userId: string; email: string; tokens: number }>();
  for (const baris of [...perRun, ...perUser]) {
    const ada = peta.get(baris.userId);
    if (ada) { ada.tokens += Number(baris.tokens ?? 0); if (!ada.email && baris.email) ada.email = baris.email; continue; }
    peta.set(baris.userId, { userId: baris.userId, email: baris.email, tokens: Number(baris.tokens ?? 0) });
  }
  const perPengguna = [...peta.values()].sort((a, b) => b.tokens - a.tokens);
  const terpakaiTerpetakan = perPengguna.reduce((total, baris) => total + baris.tokens, 0);
  const tanpaPemilik = Math.max(0, terpakai - terpakaiTerpetakan);

  // Hari yang sudah berjalan di bulan itu: bulan lampau = penuh, bulan berjalan = tanggal UTC hari ini.
  const mulaiMs = Date.parse(mulai);
  const selesaiMs = Date.parse(selesai);
  const daysElapsed = sekarang.getTime() >= selesaiMs ? daysInMonth
    : sekarang.getTime() < mulaiMs ? 0
      : Math.min(daysInMonth, sekarang.getUTCDate());

  const saldo = saldoTersimpan(bulan);
  const saldoTokens = saldo?.tokens ?? 0;
  const proyeksi = daysElapsed > 0 ? Math.round((terpakai / daysElapsed) * daysInMonth) : 0;
  const sisa = saldoTokens - terpakai;

  const catatanBagian: string[] = ["Angka `proyeksi` adalah PERKIRAAN (rata-rata harian x jumlah hari), bukan angka pasti."];
  if (!saldo) catatanBagian.push("Saldo bulan ini belum diisi admin, jadi saldo dihitung 0. Isi lewat POST /api/v1/admin/token-budget.");
  if (daysElapsed === 0) catatanBagian.push("Bulan ini belum berjalan, jadi hari yang sudah lewat 0 dan proyeksi 0 (tidak ada pembagian nol).");
  if (tanpaPemilik > 0) catatanBagian.push(`${tanpaPemilik} token pemakaian run tidak bisa dipetakan ke satu pengguna (ruang kerja tanpa anggota berperan owner), jadi tidak muncul di perPengguna.`);
  const peringatan = proyeksi > saldoTokens
    ? `Perkiraan akhir bulan (${proyeksi} token) melebihi saldo (${saldoTokens} token). Sisa saldo diperkirakan habis sebelum bulan berakhir.`
    : null;
  if (peringatan) catatanBagian.push(peringatan);

  return {
    month: bulan,
    saldo: saldoTokens,
    terpakai,
    sisa,
    proyeksi,
    daysElapsed,
    daysInMonth,
    peringatan,
    perkiraan: true,
    perPengguna,
    catatan: catatanBagian.join(" "),
    updatedAt: saldo?.updatedAt || null,
  };
}

/** Memasang rute admin: GET /api/v1/admin/token-accounting dan POST /api/v1/admin/token-budget. */
export function registerTokenAccountingRoutes(app: any): void {
  app.get("/api/v1/admin/token-accounting", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const diminta = String(request.query?.month ?? "").trim();
    const month = diminta || currentMonth();
    if (!validMonth(month)) return fail(reply, 400, "INVALID_MONTH", "Bulan harus berbentuk YYYY-MM, contoh 2026-09.");
    return tokenAccountingFor(month);
  });

  app.post("/api/v1/admin/token-budget", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const month = String(request.body?.month ?? "").trim();
    if (!validMonth(month)) return fail(reply, 400, "INVALID_MONTH", "Bulan harus berbentuk YYYY-MM, contoh 2026-09.");
    const mentah = request.body?.tokens;
    const tokens = typeof mentah === "number" ? mentah : Number(String(mentah ?? "").trim());
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isInteger(tokens)) return fail(reply, 400, "INVALID_TOKENS", "Saldo token harus bilangan bulat 0 atau lebih.");
    const note = String(request.body?.note ?? "").slice(0, 300);
    const updatedAt = new Date().toISOString();
    savePlatformSetting(`token_accounting.${month}`, JSON.stringify({ tokens, note, updated_at: updatedAt }));
    audit(request.user!.id, "admin.token_budget_set", { month, tokens, note });
    return reply.code(201).send({ month, saldo: tokens, note, updatedAt });
  });
}

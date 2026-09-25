/**
 * Wave 11C (butir 74) — nominal unik untuk transfer manual.
 *
 * Masalah yang diselesaikan: transfer manual masuk tanpa referensi, jadi dua pesanan dengan nominal
 * sama tidak bisa dipisahkan saat verifikasi. Solusinya: nominal transfer ditambah kode unik kecil
 * (1..999) supaya nominal setiap pesanan aktif berbeda, dan admin bisa mencocokkan mutasi bank.
 *
 * Kontrak pemasangan rute: `registerPaymentAmountRoutes(app)` dari `wave11c/index.ts`.
 * Berkas ini milik butir 74.
 *
 * Aturan penting yang menentukan bentuk kode:
 *   • Nominal unik HANYA untuk pesanan transfer manual (`method='manual'`). Pesanan lewat gateway
 *     (xendit/midtrans) harus dibayar dengan nominal PERSIS seperti yang diminta gateway, jadi
 *     permintaan menambahkan kode unik dijawab 409 GATEWAY_EXACT_AMOUNT dan kolomnya tetap kosong.
 *   • `amount_idr` dan `total_idr` TIDAK pernah diubah. Kode unik disimpan terpisah di
 *     `orders.unique_amount_idr`, dan nominal yang harus ditransfer = dasar + k, dengan dasar =
 *     `total_idr` (nominal yang benar-benar harus dibayar) atau `amount_idr` bila totalnya nol.
 *   • Nominal harus unik di antara pesanan AKTIF (`status='pending'`) saja. Begitu pesanan dibayar
 *     atau dibatalkan, kodenya bebas dipakai pesanan lain, sehingga kolom kode unik tidak pernah
 *     habis untuk pelanggan yang sudah lama.
 *   • Pencarian kode memakai paling banyak `config.UNIQUE_AMOUNT_MAX_TRIES` percobaan. Bila semua
 *     kandidat terpakai, jawabannya 503 UNIQUE_AMOUNT_EXHAUSTED — bukan kode kembar (diam-diam
 *     menghasilkan nominal duplikat) dan bukan kode acak raksasa yang menyulitkan pencocokan.
 *   • Tidak ada kode unik yang ditempel ulang: memanggil ulang untuk pesanan yang sudah punya kode
 *     mengembalikan kode yang sama (idempoten), jadi klik ganda admin tidak mengubah nominal.
 */
import { randomInt } from "node:crypto";
import { requireUser } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { adminRequired, audit, fail, isPlatformAdmin } from "../wave11a/shared.js";

/** Rentang kode unik: 1..999 rupiah, supaya nominal tetap mudah dibaca manusia. */
export const KODE_UNIK_MIN = 1;
export const KODE_UNIK_MAKS = 999;

export type HasilPilihNominal =
  | { ok: true; k: number; uniqueAmountIdr: number; percobaan: number }
  | { ok: false; error: "INVALID_AMOUNT" | "UNIQUE_AMOUNT_EXHAUSTED"; percobaan: number };

type BarisOrder = {
  id: string; userId: string; planCode: string; months: number; amountIdr: number; totalIdr: number;
  status: string; method: string; uniqueAmountIdr: number | null; createdAt: string; updatedAt: string;
};

/** Satu pesanan apa adanya, termasuk kolom kode unik yang tidak dibawa `getOrder()` biasa. */
export function barisOrder(orderId: string): BarisOrder | null {
  const row = db.prepare(`SELECT id, user_id AS userId, plan_code AS planCode, months, amount_idr AS amountIdr,
      total_idr AS totalIdr, status, method, unique_amount_idr AS uniqueAmountIdr,
      created_at AS createdAt, updated_at AS updatedAt
    FROM orders WHERE id=?`).get(orderId) as BarisOrder | undefined;
  return row ?? null;
}

/** Nominal yang benar-benar dibayar pembeli sebelum kode unik; dipakai sebagai dasar pencarian kode. */
export function dasarNominal(order: Pick<BarisOrder, "amountIdr" | "totalIdr">): number {
  return Math.round(order.totalIdr > 0 ? order.totalIdr : order.amountIdr);
}

/** True bila nominal (dasar + kode) sudah dipakai pesanan AKTIF lain. */
export function kodeSudahDipakai(nominalDasar: number, k: number, kecualiOrderId: string | null = null): boolean {
  const row = db.prepare("SELECT 1 AS ada FROM orders WHERE unique_amount_idr=? AND status='pending' AND id<>? LIMIT 1")
    .get(nominalDasar + k, kecualiOrderId ?? "") as { ada?: number } | undefined;
  return Boolean(row);
}

/**
 * Mencari kode unik (1..999) yang belum dipakai pesanan aktif.
 *
 * Kandidat dimulai dari kode acak supaya nominal tidak selalu berakhiran angka yang sama, lalu
 * berjalan naik satu-satu (memutar ke 1 setelah 999). Dengan begitu satu panggilan tidak pernah
 * mencoba kandidat yang sama dua kali, tetapi hasilnya tetap berbeda-beda antar pesanan.
 * `mulaiDariK` disediakan supaya aturan ini bisa diuji langsung tanpa mengubah data.
 */
export function pilihNominalUnik(nominalDasar: number, opsi: { mulaiDariK?: number; maxTries?: number } = {}): HasilPilihNominal {
  const dasar = Math.round(nominalDasar);
  if (!Number.isFinite(dasar) || dasar <= 0) return { ok: false, error: "INVALID_AMOUNT", percobaan: 0 };
  const batas = Math.max(1, Math.min(KODE_UNIK_MAKS, Math.round(opsi.maxTries ?? config.UNIQUE_AMOUNT_MAX_TRIES)));
  const mulai = Math.max(KODE_UNIK_MIN, Math.min(KODE_UNIK_MAKS, Math.round(opsi.mulaiDariK ?? randomInt(KODE_UNIK_MIN, KODE_UNIK_MAKS + 1))));
  for (let i = 0; i < batas; i += 1) {
    const k = ((mulai - 1 + i) % KODE_UNIK_MAKS) + 1;
    if (!kodeSudahDipakai(dasar, k, null)) return { ok: true, k, uniqueAmountIdr: dasar + k, percobaan: i + 1 };
  }
  return { ok: false, error: "UNIQUE_AMOUNT_EXHAUSTED", percobaan: batas };
}

export type HasilPasang =
  | { ok: true; order: BarisOrder; dasarIdr: number; k: number; percobaan: number; sudahAda: boolean }
  | { ok: false; status: number; error: string; message: string; percobaan?: number };

/**
 * Menempelkan kode unik ke satu pesanan transfer manual.
 *
 * Semua penolakan dikembalikan sebagai data (status + kode galat), bukan lemparan, supaya rute dan
 * modul lain memakai pesan yang sama. Pesanan yang sudah punya kode tidak diubah.
 */
export function pasangNominalUnik(orderId: string, opsi: { mulaiDariK?: number } = {}): HasilPasang {
  const order = barisOrder(orderId);
  if (!order) return { ok: false, status: 404, error: "ORDER_NOT_FOUND", message: "Pesanan itu tidak ada." };
  const dasar = dasarNominal(order);
  if (order.uniqueAmountIdr != null) {
    return { ok: true, order, dasarIdr: dasar, k: Math.max(0, Math.round(order.uniqueAmountIdr) - dasar), percobaan: 0, sudahAda: true };
  }
  if (order.status !== "pending") {
    return { ok: false, status: 409, error: "ORDER_NOT_PENDING", message: "Pesanan yang sudah selesai atau batal tidak perlu nominal unik." };
  }
  if (order.method !== "manual") {
    return { ok: false, status: 409, error: "GATEWAY_EXACT_AMOUNT", message: "Pesanan lewat gateway harus dibayar dengan nominal persis, jadi tidak pakai nominal unik." };
  }
  if (dasar <= 0) {
    return { ok: false, status: 409, error: "ORDER_FREE", message: "Pesanan tanpa biaya tidak butuh nominal unik." };
  }
  const pilih = pilihNominalUnik(dasar, { mulaiDariK: opsi.mulaiDariK, maxTries: config.UNIQUE_AMOUNT_MAX_TRIES });
  if (!pilih.ok) {
    return {
      ok: false, status: 503, error: pilih.error, percobaan: pilih.percobaan,
      message: `Semua kode unik 1-${KODE_UNIK_MAKS} sedang dipakai pesanan aktif. Selesaikan atau batalkan satu pesanan dulu, lalu coba lagi.`,
    };
  }
  const stamp = new Date().toISOString();
  // Syarat `unique_amount_idr IS NULL` menutup balapan dua permintaan yang datang bersamaan: yang
  // kalah tidak menimpa kode pemenang, lalu membaca ulang kode yang sudah tersimpan.
  const ubah = db.prepare("UPDATE orders SET unique_amount_idr=?, updated_at=? WHERE id=? AND unique_amount_idr IS NULL")
    .run(pilih.uniqueAmountIdr, stamp, orderId);
  const terbaru = barisOrder(orderId)!;
  if (ubah.changes === 0 && terbaru.uniqueAmountIdr == null) {
    return { ok: false, status: 409, error: "ORDER_NOT_PENDING", message: "Pesanan itu berubah saat kode unik dipasang. Muat ulang lalu coba lagi." };
  }
  return {
    ok: true, order: terbaru, dasarIdr: dasar,
    k: Math.max(0, Math.round(terbaru.uniqueAmountIdr ?? pilih.uniqueAmountIdr) - dasar),
    percobaan: pilih.percobaan, sudahAda: ubah.changes === 0,
  };
}

/** Ringkasan nominal satu pesanan untuk dipakai rute lain (mis. daftar pesanan admin). */
export function tampilanNominal(orderId: string): { orderId: string; amountIdr: number; totalIdr: number; dasarIdr: number; uniqueAmountIdr: number | null; nominalBayarIdr: number; k: number | null; method: string; status: string } | null {
  const order = barisOrder(orderId);
  if (!order) return null;
  const dasar = dasarNominal(order);
  const unik = order.uniqueAmountIdr ?? null;
  return {
    orderId: order.id, amountIdr: order.amountIdr, totalIdr: order.totalIdr, dasarIdr: dasar,
    uniqueAmountIdr: unik, nominalBayarIdr: unik ?? dasar, k: unik == null ? null : Math.max(0, unik - dasar),
    method: order.method, status: order.status,
  };
}

/**
 * Pesanan transfer manual yang masih menunggu, beserta nominal uniknya (antrean verifikasi admin).
 *
 * `hanyaKosong` dipakai pengisian borongan: pencarian dibatasi di dalam SQL, bukan setelah LIMIT,
 * supaya tumpukan pesanan lama yang sudah bernominal tidak menghalangi pesanan terbaru.
 */
function antreanManual(limit: number, hanyaKosong = false) {
  return db.prepare(`SELECT o.id, o.user_id AS userId, u.email AS email, o.plan_code AS planCode, o.months,
      o.amount_idr AS amountIdr, o.total_idr AS totalIdr, o.unique_amount_idr AS uniqueAmountIdr,
      o.status, o.created_at AS createdAt
    FROM orders o LEFT JOIN users u ON u.id=o.user_id
    WHERE o.method='manual' AND o.status='pending'${hanyaKosong ? " AND o.unique_amount_idr IS NULL" : ""}
    ORDER BY o.created_at ASC LIMIT ?`).all(Math.min(999, Math.max(1, limit))) as any[];
}

/**
 * Rute butir 74:
 *   POST /api/v1/billing/orders/:orderId/unique-amount        -> pasang kode unik (pemilik pesanan)
 *   GET  /api/v1/billing/manual-orders/queue                  -> antrean transfer manual (admin)
 *   POST /api/v1/billing/manual-orders/queue/unique-amounts   -> isi sekaligus pesanan lama (admin)
 */
export function registerPaymentAmountRoutes(app: any): void {
  app.post("/api/v1/billing/orders/:orderId/unique-amount", { preHandler: requireUser }, async (request: any, reply: any) => {
    const orderId = String(request.params.orderId ?? "");
    const pemilik = db.prepare("SELECT user_id AS userId FROM orders WHERE id=?").get(orderId) as { userId?: string } | undefined;
    // Pesanan milik akun lain dijawab 404, bukan 403: keberadaannya pun tidak perlu bocor.
    if (!pemilik || pemilik.userId !== request.user!.id) return fail(reply, 404, "ORDER_NOT_FOUND", "Pesanan itu bukan milik Anda.");
    const hasil = pasangNominalUnik(orderId);
    if (!hasil.ok) return fail(reply, hasil.status, hasil.error, hasil.message, hasil.percobaan == null ? {} : { percobaan: hasil.percobaan });
    if (!hasil.sudahAda) audit(request.user!.id, "billing.order_unique_amount", { orderId, kode: hasil.k, dasarIdr: hasil.dasarIdr, nominal: hasil.order.uniqueAmountIdr });
    return {
      order: { ...tampilanNominal(orderId) },
      uniqueAmountIdr: hasil.order.uniqueAmountIdr, k: hasil.k, baseIdr: hasil.dasarIdr,
      percobaan: hasil.percobaan, sudahAda: hasil.sudahAda, catatan: "Nominal transfer = baseIdr + k. amount_idr tidak diubah.",
    };
  });

  app.get("/api/v1/billing/manual-orders/queue", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const limit = Number(request.query?.limit ?? 50) || 50;
    const rows = antreanManual(limit).map((row) => ({
      orderId: row.id, userId: row.userId, email: row.email, planCode: row.planCode, months: Number(row.months),
      amountIdr: Number(row.amountIdr), totalIdr: Number(row.totalIdr),
      uniqueAmountIdr: row.uniqueAmountIdr == null ? null : Number(row.uniqueAmountIdr),
      nominalBayarIdr: row.uniqueAmountIdr == null ? Number(row.totalIdr) : Number(row.uniqueAmountIdr),
      punyaNominalUnik: row.uniqueAmountIdr != null, createdAt: row.createdAt,
    }));
    return { orders: rows, belumBernominalUnik: rows.filter((row) => !row.punyaNominalUnik).length };
  });

  app.post("/api/v1/billing/manual-orders/queue/unique-amounts", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    const limit = Math.min(500, Math.max(1, Math.round(Number(request.body?.limit ?? 100) || 100)));
    // Kandidat dicari langsung di SQL (`hanyaKosong`) lalu disaring biaya nol; pesanan yang tidak bisa
    // diisi (mis. semua kode sedang habis) dilaporkan di `kegagalan`, tidak dilewati diam-diam.
    const kandidat = antreanManual(limit, true).filter((row) => Number(row.totalIdr) > 0);
    const berhasil: unknown[] = [];
    const gagal: unknown[] = [];
    for (const row of kandidat) {
      const hasil = pasangNominalUnik(row.id);
      if (hasil.ok) berhasil.push({ orderId: row.id, uniqueAmountIdr: hasil.order.uniqueAmountIdr, k: hasil.k });
      else gagal.push({ orderId: row.id, error: hasil.error });
    }
    audit(request.user!.id, "billing.manual_queue_filled", { diisi: berhasil.length, gagal: gagal.length });
    return { diisi: berhasil.length, gagal: gagal.length, orders: berhasil, kegagalan: gagal };
  });
}

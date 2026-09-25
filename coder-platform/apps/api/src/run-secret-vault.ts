/**
 * Wave 11A (butir 44): sewa rahasia per run — isolasi kredensial antar-sesi.
 *
 * Rahasia milik satu pengguna hanya diberikan kepada proses anak yang menjalankan run itu, lewat
 * lingkungan (env) proses anak, dan dilepas kembali setelah run selesai. Modul ini TIDAK PERNAH
 * menulis ke `process.env` global: satu proses web melayani banyak pengguna, jadi menaruh rahasia
 * di sana sama dengan membocorkannya ke sesi lain (insiden "key enc:v1 bocor ke spawn" di platform lama).
 *
 * Sebuah "sewa" (lease) hanyalah keterangan di memori proses: run mana memakai rahasia siapa. Nilai
 * rahasia yang sudah dibuka disimpan di dalam sewa itu saja, dan `secretEnvForLease` mengembalikan
 * salinan, sehingga pemanggil tidak bisa mengubah isi sewa secara tidak sengaja.
 *
 * Pemakaian yang disarankan (dipanggil dari `finally`, supaya run yang gagal tetap bersih):
 *
 *   const env = await acquireRunSecretEnv(userId, runId);
 *   try { await jalankanMesin({ ...proses, env }); } finally { releaseRunSecrets(runId); }
 *
 * atau dengan pembungkus `withRunSecretEnv(userId, runId, async (env) => ...)`.
 */
import { db } from "./db.js";
import { openSecret } from "./secrets.js";

/** Satu sewa rahasia yang sedang aktif. Tidak memuat nilai rahasia, hanya nama-namanya. */
export type SecretLease = { runId: string; userId: string; names: string[]; at: string };

/** Sewa yang lebih tua dari satu jam dianggap menggantung dan dilaporkan audit-diri. */
export const SECRET_LEASE_STALE_MS = 60 * 60 * 1000;

type LeaseRecord = SecretLease & { env: Record<string, string> };

/** Peta sewa di memori proses. Inilah "variabel modul", bukan `process.env` global. */
const leases = new Map<string, LeaseRecord>();

/** Nama variabel lingkungan untuk satu rahasia: `CODER_SECRET_<NAMA_BESAR>`. */
export function secretEnvName(name: string): string {
  return `CODER_SECRET_${String(name).toUpperCase()}`;
}

type StoredSecretRow = { name: string; stored: string };

/** Rahasia milik satu pengguna, tanpa pernah menyentuh rahasia pengguna lain. */
function storedSecrets(userId: string): StoredSecretRow[] {
  return db.prepare("SELECT name, secret_ciphertext AS stored FROM user_secrets WHERE user_id=? ORDER BY name")
    .all(userId) as StoredSecretRow[];
}

/**
 * Menyewa rahasia milik `userId` untuk `runId` dan mengembalikan env siap pakai untuk proses anak.
 *
 * Seluruh nilai dibuka lebih dulu sebelum sewa dicatat: kalau satu nilai tidak bisa dibuka (kunci
 * hilang atau ciphertext rusak), tidak ada sewa separuh jadi yang tertinggal dan pemanggil menerima
 * galatnya. Run tanpa rahasia tetap mendapat objek kosong.
 */
export async function acquireRunSecretEnv(userId: string, runId: string): Promise<Record<string, string>> {
  const rows = storedSecrets(userId);
  const env: Record<string, string> = {};
  const names: string[] = [];
  for (const row of rows) {
    env[secretEnvName(row.name)] = openSecret(row.stored);
    names.push(row.name);
  }
  const record: LeaseRecord = { runId, userId, names, at: new Date().toISOString(), env: Object.freeze({ ...env }) };
  leases.set(runId, record);
  return { ...env };
}

/** Melepas sewa satu run. True bila memang ada sewa yang dilepas. Wajib dipanggil dari `finally`. */
export function releaseRunSecrets(runId: string): boolean {
  return leases.delete(runId);
}

/** Daftar sewa aktif tanpa nilai rahasia, untuk halaman admin dan audit-diri. */
export function activeSecretLeases(): SecretLease[] {
  return [...leases.values()].map((lease) => ({ runId: lease.runId, userId: lease.userId, names: [...lease.names], at: lease.at }));
}

/** Env siap pakai untuk satu sewa; salinan, dan objek kosong setelah sewa dilepas. */
export function secretEnvForLease(runId: string): Record<string, string> {
  const lease = leases.get(runId);
  return lease ? { ...lease.env } : {};
}

/** Pembungkus aman: sewa selalu dilepas, termasuk saat pekerjaan melempar galat. */
export async function withRunSecretEnv<T>(
  userId: string,
  runId: string,
  work: (env: Record<string, string>) => Promise<T> | T,
): Promise<T> {
  const env = await acquireRunSecretEnv(userId, runId);
  try {
    return await work(env);
  } finally {
    releaseRunSecrets(runId);
  }
}

/**
 * Melepas sewa yang menggantung (lebih tua dari batas). Dipakai pembersih berkala bila perlu;
 * mengembalikan jumlah sewa yang dilepas.
 */
export function releaseStaleRunSecrets(now: Date = new Date(), maxAgeMs: number = SECRET_LEASE_STALE_MS): number {
  let removed = 0;
  for (const [runId, lease] of leases) {
    if (now.getTime() - Date.parse(lease.at) > maxAgeMs) {
      leases.delete(runId);
      removed += 1;
    }
  }
  return removed;
}

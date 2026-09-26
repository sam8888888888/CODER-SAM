/**
 * Wave 11C (butir 71/82): pengiriman konektor lewat proses anak yang terpisah.
 *
 * Kenapa proses terpisah: webhook pihak ketiga bisa menggantung, memakan memori, atau mati mendadak.
 * Kalau itu terjadi di proses web, seluruh platform ikut lumpuh. Jadi satu pengiriman = satu proses
 * anak dengan lingkungan minimum, daftar putih alamat, batas waktu, dan penghentian paksa (SIGKILL).
 *
 * Jejak yang ditinggalkan:
 *   - pekerjaan `jobs.kind = 'connector.deliver'` (satu pekerjaan per kirim),
 *   - baris `connectors.status` = 'aktif' HANYA setelah hulu menjawab 2xx; selebihnya 'gagal' + `last_error`,
 *   - satu baris audit tanpa rahasia (`connector.delivered` / `connector.delivery_failed`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { db } from "../db.js";
import { completeJob, enqueueJob, failJob, getJob, registerJobHandler } from "../jobs.js";
import { audit } from "../wave11a/shared.js";
import { allowedOutboundHosts, checkOutboundUrl, outboundTimeoutMs } from "./connector-outbound.js";
import { connectorRow, mcpToolsAllowed, openConnectorConfig, updateConnectorState, type ConnectorConfig } from "./connector-store.js";

/** Jenis pekerjaan untuk pengiriman konektor (sudah terdaftar di `JOB_KINDS` sejak Wave 11C). */
export const CONNECTOR_JOB_KIND = "connector.deliver";

export type ChildRequest = {
  requestId: string;
  provider: string;
  url: string;
  token?: string;
  alat?: string[];
  teks: string;
  nama?: string;
};

export type ChildEnvironment = {
  kunci: string[];
  jumlahKunci: number;
  variabelPenting: Record<string, string | null>;
  dataDirDiterima: boolean;
  basisData: { dicoba: boolean; asal: string; berhasil: boolean; alasan: string };
  cwd: string;
  pid: number;
  ppid: number;
  nodeVersion: string;
};

export type ChildReply = {
  ok: boolean;
  code: string;
  status?: number | null;
  message?: string;
  provider?: string;
  durasiMs?: number;
  jawaban?: string;
  panjangTeks?: number;
  lingkungan?: ChildEnvironment;
};

export type ChildOutcome = {
  hasil: ChildReply | null;
  kodeKeluar: number | null;
  dibunuh: boolean;
  pid: number | null;
  durasiMs: number;
  keluaranMentah: string;
  galatMentah: string;
};

export type DeliveryResult = {
  dijalankan: boolean;
  status: "aktif" | "gagal" | "dilewati";
  kode: string;
  pesan: string;
  jenis: string;
  upstreamStatus: number | null;
  durasiMs: number;
  proses: { pid: number | null; kodeKeluar: number | null; dibunuh: boolean; batasWaktuMs: number } | null;
  lingkunganAnak: ChildEnvironment | null;
};

/** Berkas anak. Diuji dari sumber (`.ts` lewat tsx) dan dari hasil build (`.js`) tanpa konfigurasi tambahan. */
export function connectorChildPath(): string {
  const sini = dirname(fileURLToPath(import.meta.url));
  const sumber = join(sini, "connector-child.ts");
  return existsSync(sumber) ? sumber : join(sini, "connector-child.js");
}

/** Pemuat TypeScript untuk proses anak saat dijalankan dari sumber. Tanpa ini `tsx` dicari dari cwd. */
function pemuatTypescript(): string | null {
  const akar = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const cli = join(akar, "node_modules", "tsx", "dist", "cli.mjs");
  return existsSync(cli) ? cli : null;
}

export function connectorChildCommand(anak: string = connectorChildPath()): { perintah: string; argumen: string[] } {
  if (!anak.endsWith(".ts")) return { perintah: process.execPath, argumen: [anak] };
  // Node 22.6+ bisa menjalankan TypeScript sendiri (pencopotan tipe). Ini penting bukan hanya soal
  // kecepatan: bila berkas anak dijalankan lewat pembungkus `tsx`, proses yang benar-benar bekerja
  // menjadi CUCU proses, sehingga SIGKILL induk hanya membunuh pembungkusnya. Dengan dijalankan
  // langsung, proses anak yang kita bunuh adalah proses yang kita lacak (`pid`, `ppid`).
  if ((process.features as { typescript?: string | false } | undefined)?.typescript) return { perintah: process.execPath, argumen: [anak] };
  const cli = pemuatTypescript();
  return cli ? { perintah: process.execPath, argumen: [cli, anak] } : { perintah: process.execPath, argumen: ["--import", "tsx", anak] };
}

/**
 * Lingkungan proses anak: daftar putih kecil dan disengaja. TIDAK ada DATA_DIR, SECRETS_KEY, SMTP,
 * atau kunci platform lain, jadi proses anak tidak bisa membuka basis data atau membuka rahasia —
 * bahkan bila kode di dalamnya disusupi. Satu-satunya jalan keluar adalah alamat di daftar putih.
 */
export function connectorChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const hasil: Record<string, string> = {
    CONNECTOR_CHILD: "1",
    CONNECTOR_ALLOWED_HOSTS: allowedOutboundHosts(env).join(","),
    CONNECTOR_TIMEOUT_MS: String(outboundTimeoutMs(env)),
    NODE_ENV: "production",
  };
  for (const nama of ["PATH", "TZ", "LANG"] as const) {
    const nilai = env[nama];
    if (nilai) hasil[nama] = nilai;
  }
  return hasil;
}

/**
 * CATATAN: `CONNECTOR_CHILD_DEADLINE_MS` dan `CONNECTOR_CHILD_START_GRACE_MS` di bawah adalah KNOB UJI
 * (hanya untuk memperpendek waktu tunggu saat pengujian), bukan setelan produksi — jangan dimasukkan ke
 * skema config; bawaannya di sini sudah aman.
 *
 * Batas waktu yang berlaku pada satu pengiriman:
 *   - `childAbortMs`    : batas menunggu hulu, dipakai proses anak;
 *   - `parentDeadlineMs`: batas hidup proses anak, dipakai induk untuk SIGKILL.
 * Di luar produksi keduanya bisa dipendekkan lewat lingkungan supaya uji bisa membuktikan kedua jalur
 * tanpa menunggu lama. DI PRODUKSI (`NODE_ENV=production`) kedua knob itu DIABAIKAN, supaya satu
 * variabel lingkungan tidak bisa diam-diam memendekkan batas hidup proses anak; yang berlaku nilai
 * bawaan berkas ini. Lingkungan proses anak bisa membawa `NODE_ENV` sendiri, jadi yang diperiksa:
 * `env.NODE_ENV` lebih dulu, lalu `process.env.NODE_ENV`.
 */
function knobUjiHidup(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? process.env.NODE_ENV) !== "production";
}

export function connectorLimits(env: NodeJS.ProcessEnv = process.env): { childAbortMs: number; graceMs: number; parentDeadlineMs: number } {
  const childAbortMs = outboundTimeoutMs(env);
  // Di produksi kedua knob dibaca sebagai NaN, sehingga pemeriksaan di bawah jatuh ke nilai bawaan.
  const knobHidup = knobUjiHidup(env);
  const graceRaw = knobHidup ? Number(env.CONNECTOR_CHILD_START_GRACE_MS) : Number.NaN;
  const graceMs = Number.isFinite(graceRaw) && graceRaw >= 0 ? Math.floor(graceRaw) : 3000;
  const deadlineRaw = knobHidup ? Number(env.CONNECTOR_CHILD_DEADLINE_MS) : Number.NaN;
  const parentDeadlineMs = Number.isFinite(deadlineRaw) && deadlineRaw >= 200 ? Math.floor(deadlineRaw) : childAbortMs + graceMs;
  return { childAbortMs, graceMs, parentDeadlineMs };
}

/** Mengambil satu baris `CONNECTOR_RESULT <json>` dari keluaran anak. */
function ambilHasil(keluaran: string): ChildReply | null {
  const baris = keluaran
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("CONNECTOR_RESULT "));
  if (!baris.length) return null;
  try {
    return JSON.parse(baris[baris.length - 1].slice("CONNECTOR_RESULT ".length)) as ChildReply;
  } catch {
    return null;
  }
}

/** Menjalankan satu proses anak. Selalu mengembalikan objek, termasuk saat anak dibunuh atau gagal start. */
export async function spawnConnectorChild(
  permintaan: ChildRequest,
  // `anak` hanya dipakai uji: memaksa berkas anak tertentu (mis. hasil build `dist/**/connector-child.js`)
  // supaya jalur produksi bisa dibuktikan tanpa membangun seluruh aplikasi.
  opsi: { env?: NodeJS.ProcessEnv; anak?: string } = {},
): Promise<ChildOutcome> {
  const env = opsi.env ?? process.env;
  const batas = connectorLimits(env);
  const anak = opsi.anak ?? connectorChildPath();
  const { perintah, argumen } = connectorChildCommand(anak);
  const mulai = Date.now();
  return new Promise<ChildOutcome>((resolve) => {
    const proses = spawn(perintah, argumen, {
      // cwd di direktori sementara: anak tidak bisa menyentuh berkas repo lewat jalur relatif.
      cwd: tmpdir(),
      env: connectorChildEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let keluaran = "";
    let galat = "";
    let dibunuh = false;
    let selesai = false;
    const timer = setTimeout(() => {
      dibunuh = true;
      proses.kill("SIGKILL");
    }, batas.parentDeadlineMs);
    const beres = (kodeKeluar: number | null, galatSpawn?: string) => {
      if (selesai) return;
      selesai = true;
      clearTimeout(timer);
      resolve({
        hasil: ambilHasil(keluaran),
        kodeKeluar,
        dibunuh,
        pid: proses.pid ?? null,
        durasiMs: Date.now() - mulai,
        keluaranMentah: keluaran.slice(0, 2000),
        galatMentah: String(galatSpawn ?? galat).slice(0, 2000),
      });
    };
    proses.stdout?.on("data", (potongan) => {
      keluaran += String(potongan);
    });
    proses.stderr?.on("data", (potongan) => {
      galat += String(potongan);
    });
    proses.on("error", (error) => beres(null, String((error as Error)?.message ?? error)));
    proses.on("close", (kode) => beres(kode));
    // EPIPE bila anak sudah mati (mis. dibunuh): dilaporkan lewat hasil, bukan menjatuhkan induk.
    proses.stdin?.on("error", () => {});
    proses.stdin?.end(JSON.stringify({ ...permintaan, timeoutMs: batas.childAbortMs }));
  });
}

function hasilDilewati(kode: string, pesan: string, jenis: string): DeliveryResult {
  return { dijalankan: false, status: "dilewati", kode, pesan, jenis, upstreamStatus: null, durasiMs: 0, proses: null, lingkunganAnak: null };
}

/**
 * Inti pengiriman: dipakai rute /test dan pekerja `connector.deliver` dengan jalur yang sama.
 * Urutan pemeriksaan sengaja: aktif -> konfigurasi bisa dibuka -> izin alat MCP -> daftar putih.
 * Apa pun hasilnya, `connectors.status` dan `last_error` mengikuti bukti terakhir, tidak pernah optimistis.
 */
export async function runConnectorDelivery(payload: { connectorId?: unknown; userId?: unknown; teks?: unknown; jenis?: unknown }): Promise<DeliveryResult> {
  const connectorId = String(payload?.connectorId ?? "");
  const userId = payload?.userId ? String(payload.userId) : "";
  const jenis = String(payload?.jenis ?? "pesan");
  const teks = String(payload?.teks ?? "").slice(0, 3000);

  const row = connectorRow(connectorId);
  if (!row || (userId && row.userId !== userId)) {
    return hasilDilewati("CONNECTOR_NOT_FOUND", "Konektor tidak ditemukan untuk pengguna ini.", jenis);
  }
  if (row.enabled !== 1) {
    // Nonaktif = tidak menerima apa pun. Statusnya tidak diubah menjadi 'gagal'.
    return hasilDilewati("CONNECTOR_DISABLED", "Konektor belum diaktifkan, jadi tidak ada pesan yang dikirim.", jenis);
  }

  const dibuka = openConnectorConfig(row);
  if (!dibuka.ok) {
    updateConnectorState(row.id, { status: "gagal", lastError: dibuka.kode });
    return { dijalankan: false, status: "gagal", kode: dibuka.kode, pesan: "Konfigurasi konektor tidak bisa dibuka.", jenis, upstreamStatus: null, durasiMs: 0, proses: null, lingkunganAnak: null };
  }
  const konfigurasi: ConnectorConfig = dibuka.config;

  if (row.kind === "mcp") {
    const izin = mcpToolsAllowed(konfigurasi.alat);
    if (!izin.ok) {
      updateConnectorState(row.id, { status: "gagal", lastError: `MCP_TOOL_NOT_ALLOWED: ${izin.ditolak.join(", ")}` });
      return { dijalankan: false, status: "gagal", kode: "MCP_TOOL_NOT_ALLOWED", pesan: `Alat MCP belum diizinkan admin platform: ${izin.ditolak.join(", ")}.`, jenis, upstreamStatus: null, durasiMs: 0, proses: null, lingkunganAnak: null };
    }
  }

  const alamat = String(konfigurasi.url ?? "").trim();
  if (!alamat) {
    updateConnectorState(row.id, { status: "gagal", lastError: "CONNECTOR_URL_REQUIRED" });
    return { dijalankan: false, status: "gagal", kode: "CONNECTOR_URL_REQUIRED", pesan: "Alamat webhook belum diisi.", jenis, upstreamStatus: null, durasiMs: 0, proses: null, lingkunganAnak: null };
  }
  const cek = checkOutboundUrl(alamat);
  if (!cek.ok) {
    updateConnectorState(row.id, { status: "gagal", lastError: cek.code });
    return { dijalankan: false, status: "gagal", kode: cek.code, pesan: cek.message, jenis, upstreamStatus: null, durasiMs: 0, proses: null, lingkunganAnak: null };
  }

  const batas = connectorLimits();
  const kirim = await spawnConnectorChild({
    requestId: `deliver-${row.id.slice(0, 8)}-${Date.now()}`,
    provider: row.kind,
    url: alamat,
    token: konfigurasi.token,
    alat: konfigurasi.alat,
    teks,
    nama: konfigurasi.nama,
  });

  const hasil = kirim.hasil;
  const sukses = Boolean(hasil?.ok);
  const kode = hasil?.code ?? (kirim.dibunuh ? "CONNECTOR_TIMEOUT" : "CONNECTOR_CHILD_NO_RESULT");
  const pesan = hasil?.message ?? (kirim.dibunuh ? `Proses anak dihentikan paksa setelah ${batas.parentDeadlineMs} ms.` : `Proses anak tidak melapor (kode keluar ${kirim.kodeKeluar}).`);
  const upstreamStatus = typeof hasil?.status === "number" ? hasil.status : null;

  if (sukses) updateConnectorState(row.id, { status: "aktif", lastError: "" });
  else updateConnectorState(row.id, { status: "gagal", lastError: `${kode}: ${pesan}` });

  audit(row.userId, sukses ? "connector.delivered" : "connector.delivery_failed", {
    connectorId: row.id,
    kind: row.kind,
    kode,
    upstreamStatus,
    durasiMs: kirim.durasiMs,
    pid: kirim.pid,
    dibunuh: kirim.dibunuh,
    // Hanya host dan jumlah karakter; alamat webhook sendiri tidak pernah masuk catatan.
    host: cek.host,
    panjangTeks: teks.length,
  });

  return {
    dijalankan: true,
    status: sukses ? "aktif" : "gagal",
    kode,
    pesan,
    jenis,
    upstreamStatus,
    durasiMs: kirim.durasiMs,
    proses: { pid: kirim.pid, kodeKeluar: kirim.kodeKeluar, dibunuh: kirim.dibunuh, batasWaktuMs: batas.parentDeadlineMs },
    lingkunganAnak: hasil?.lingkungan ?? null,
  };
}

/**
 * Kirim + pekerjaan dalam satu langkah untuk rute /test: pekerjaan tetap dicatat (bukti), lalu
 * dijalankan di proses ini bila belum ada pekerja lain yang mengambilnya. Kalau pekerja web sudah
 * mengambil lebih dulu, hasilnya ditunggu dari baris pekerjaan itu.
 */
export async function deliverConnectorWithJob(input: { connectorId: string; userId: string; teks: string; jenis?: string }): Promise<{
  jobId: string | null;
  diklaim: "sebaris" | "pekerja" | "tidak_diklaim";
  hasil: DeliveryResult | null;
  pesan: string;
}> {
  const jenis = input.jenis ?? "uji";
  const masuk = enqueueJob({
    kind: CONNECTOR_JOB_KIND,
    payload: { connectorId: input.connectorId, userId: input.userId, teks: input.teks, jenis },
    maxAttempts: 1,
  });
  if (!masuk.id) return { jobId: null, diklaim: "tidak_diklaim", hasil: null, pesan: `Pekerjaan konektor tidak bisa dibuat: ${masuk.reason ?? "tidak diketahui"}.` };

  const now = new Date();
  const klaim = db
    .prepare(
      `UPDATE jobs SET status='running', lock_owner=?, lock_expires_at=?, attempts=attempts+1, updated_at=?
       WHERE id=? AND status='queued'`,
    )
    .run(`connector-sebaris:${process.pid}`, new Date(now.getTime() + config.JOB_LEASE_MS).toISOString(), now.toISOString(), masuk.id);

  if (klaim.changes === 1) {
    try {
      const hasil = await runConnectorDelivery({ connectorId: input.connectorId, userId: input.userId, teks: input.teks, jenis });
      // Kegagalan kirim bukan kegagalan pekerjaan: kirim yang tidak terkirim tetap tercatat, dan
      // pekerjaannya selesai supaya percobaan ulang otomatis tidak pernah mengirim pesan dua kali.
      completeJob(masuk.id, { kode: hasil.kode, status: hasil.status, dijalankan: hasil.dijalankan, upstreamStatus: hasil.upstreamStatus });
      return { jobId: masuk.id, diklaim: "sebaris", hasil, pesan: hasil.pesan };
    } catch (error) {
      failJob(masuk.id, String((error as Error)?.message ?? error));
      return { jobId: masuk.id, diklaim: "sebaris", hasil: null, pesan: "Pengiriman gagal di dalam proses ini." };
    }
  }

  // Pekerja web sudah mengambil pekerjaan ini; tunggu hasilnya sebentar supaya pengguna dapat jawaban nyata.
  const batasTunggu = Date.now() + 8000;
  while (Date.now() < batasTunggu) {
    const pekerjaan = getJob(masuk.id);
    if (pekerjaan && (pekerjaan.status === "done" || pekerjaan.status === "failed")) {
      let hasil: DeliveryResult | null = null;
      try {
        hasil = pekerjaan.result ? (JSON.parse(pekerjaan.result) as DeliveryResult) : null;
      } catch {
        hasil = null;
      }
      return {
        jobId: masuk.id,
        diklaim: "pekerja",
        hasil,
        pesan: pekerjaan.status === "failed" ? `Pekerja melaporkan gagal: ${pekerjaan.lastError ?? "tanpa keterangan"}` : "Pekerja web menyelesaikan pengiriman.",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { jobId: masuk.id, diklaim: "pekerja", hasil: null, pesan: "Pengiriman masih berjalan di pekerja web; hasilnya belum tersedia." };
}

/** Dipanggil sekali dari server.ts: satu-satunya tempat jenis pekerjaan konektor didaftarkan. */
export function registerConnectorJobHandlers(): void {
  registerJobHandler(CONNECTOR_JOB_KIND, async (payload: unknown) => runConnectorDelivery((payload ?? {}) as Record<string, unknown>));
}

/**
 * Wave 11C (butir 82): proses anak pengirim konektor.
 *
 * Berkas ini SENGAJA berdiri sendiri: hanya modul bawaan Node (`node:fs`, `node:path`). Ia tidak
 * mengimpor db.ts, config.ts, atau secrets.ts, jadi ia tidak bisa membaca basis data platform,
 * mengambil kunci induk, atau menulis riwayat apa pun — tugasnya hanya satu: satu permintaan HTTP
 * ke SATU alamat yang sudah lolos daftar putih, lalu melapor lewat satu baris JSON di stdout.
 *
 * Kontrak proses (dipakai `connector-job.ts`):
 *   - Masukan  : satu objek JSON di stdin (bukan argumen, supaya rahasia tidak terlihat di `ps`).
 *   - Keluaran : tepat satu baris `CONNECTOR_RESULT <json>` di stdout. Tidak pernah ada rahasia di dalamnya.
 *   - Kode keluar: 0 berhasil, 2 masukan tidak sah, 3 host di luar daftar putih, 4 hulu menolak,
 *                  5 lewat batas waktu, 6 galat jaringan.
 *   - Lingkungan yang diterima hanya daftar putih kecil dari `connectorChildEnv()`; setiap hasil
 *     membawa laporan lingkungan hidup dari dalam proses anak, jadi isolasinya bisa dibuktikan.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Permintaan = {
  requestId?: string;
  provider?: string;
  url?: string;
  token?: string;
  alat?: string[];
  teks?: string;
  nama?: string;
  timeoutMs?: number;
};

const PROVIDERS = new Set(["slack", "discord", "mcp"]);
/** Nama variabel yang penting bagi platform. Nilainya TIDAK pernah dicetak, hanya ada/tidak. */
const VARIABEL_PENTING = ["SECRETS_KEY", "DATA_DIR", "DATABASE_URL", "SMTP_URL", "ADMIN_PASSWORD", "NOTION_API_KEY", "JWT_SECRET"];

/** Menulis satu baris hasil lalu keluar. Kode keluar diatur sebagai pengaman kalau stdout penuh. */
function tulis(hasil: Record<string, unknown>, kodeKeluar: number): void {
  const baris = `CONNECTOR_RESULT ${JSON.stringify(hasil)}\n`;
  process.exitCode = kodeKeluar;
  const darurat = setTimeout(() => process.exit(kodeKeluar), 3000);
  darurat.unref();
  process.stdout.write(baris, () => {
    clearTimeout(darurat);
    process.exit(kodeKeluar);
  });
}

/**
 * Laporan lingkungan dari dalam proses anak. Dipakai uji untuk membuktikan anak TIDAK mewarisi
 * DATA_DIR, SECRETS_KEY, atau variabel platform lain, dan tidak bisa membuka basis data induk.
 */
function laporanLingkungan() {
  const kunci = Object.keys(process.env).sort();
  const ada: Record<string, string | null> = {};
  for (const nama of VARIABEL_PENTING) ada[nama] = process.env[nama] ? "ADA" : null;

  const dataDir = process.env.DATA_DIR ?? "";
  const jalur = dataDir ? join(dataDir, "coder.db") : join(process.cwd(), "coder.db");
  let basisData: Record<string, unknown>;
  try {
    readFileSync(jalur);
    basisData = { dicoba: true, asal: dataDir ? "DATA_DIR" : "cwd", berhasil: true, alasan: "TERBACA" };
  } catch (error) {
    basisData = { dicoba: true, asal: dataDir ? "DATA_DIR" : "cwd", berhasil: false, alasan: String((error as NodeJS.ErrnoException)?.code ?? "GALAT") };
  }

  return {
    kunci,
    jumlahKunci: kunci.length,
    variabelPenting: ada,
    dataDirDiterima: Boolean(process.env.DATA_DIR),
    basisData,
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
    nodeVersion: process.version,
  };
}

function batasWaktuDiminta(permintaan: Permintaan): number {
  const dariPermintaan = Number(permintaan.timeoutMs);
  if (Number.isFinite(dariPermintaan) && dariPermintaan >= 1000) return Math.floor(dariPermintaan);
  const dariLingkungan = Number(process.env.CONNECTOR_TIMEOUT_MS);
  if (Number.isFinite(dariLingkungan) && dariLingkungan >= 1000) return Math.floor(dariLingkungan);
  return 15000;
}

/** Isi permintaan per jenis konektor. Bentuknya dijaga di sini supaya induk tidak perlu tahu detailnya. */
function badanPermintaan(permintaan: Permintaan, teks: string) {
  const alat = Array.isArray(permintaan.alat) ? permintaan.alat.map((item) => String(item)) : [];
  if (permintaan.provider === "slack") return { text: teks, ...(permintaan.nama ? { username: permintaan.nama } : {}) };
  if (permintaan.provider === "discord") return { content: teks, ...(permintaan.nama ? { username: permintaan.nama } : {}) };
  // MCP: satu panggilan tools/call, alat pertama dari daftar yang sudah diizinkan admin platform.
  return {
    jsonrpc: "2.0",
    id: permintaan.requestId ?? "1",
    method: "tools/call",
    params: { name: alat[0] ?? "kirim_pesan", arguments: { teks } },
  };
}

function kepalaPermintaan(permintaan: Permintaan): Record<string, string> {
  const kepala: Record<string, string> = { "content-type": "application/json" };
  if (permintaan.provider === "mcp" && permintaan.token) kepala.authorization = `Bearer ${permintaan.token}`;
  return kepala;
}

/** Daftar putih dibaca dari lingkungan anak sendiri, bukan dari masukan, jadi tidak bisa ditipu induk. */
function hostDiizinkan(host: string): boolean {
  const daftar = String(process.env.CONNECTOR_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return daftar.includes(host.toLowerCase());
}

function bacaStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (potongan) => {
      data += potongan;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

async function utama() {
  const mentah = await bacaStdin();
  let permintaan: Permintaan;
  try {
    permintaan = JSON.parse(mentah || "{}") as Permintaan;
  } catch {
    tulis({ ok: false, code: "CHILD_INPUT_INVALID", message: "Masukan bukan JSON.", lingkungan: laporanLingkungan() }, 2);
    return;
  }
  const lingkungan = laporanLingkungan();
  const provider = String(permintaan.provider ?? "");
  if (!PROVIDERS.has(provider)) {
    tulis({ ok: false, code: "CHILD_PROVIDER_UNSUPPORTED", message: `Jenis "${provider}" tidak dikenal.`, lingkungan }, 2);
    return;
  }
  const alamat = String(permintaan.url ?? "").trim();
  if (!alamat) {
    tulis({ ok: false, code: "CONNECTOR_URL_INVALID", message: "Alamat tujuan kosong.", provider, lingkungan }, 2);
    return;
  }
  let url: URL;
  try {
    url = new URL(alamat);
  } catch {
    tulis({ ok: false, code: "CONNECTOR_URL_INVALID", message: "Alamat tujuan bukan URL.", provider, lingkungan }, 2);
    return;
  }
  if (!hostDiizinkan(url.hostname)) {
    // Alamat di luar daftar putih: berhenti sebelum satu byte pun keluar.
    tulis({ ok: false, code: "CONNECTOR_HOST_NOT_ALLOWED", message: `Host "${url.hostname}" tidak ada di daftar putih anak.`, provider, lingkungan }, 3);
    return;
  }

  const timeoutMs = batasWaktuDiminta(permintaan);
  const teks = String(permintaan.teks ?? "");
  const body = JSON.stringify(badanPermintaan(permintaan, teks));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const mulai = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: kepalaPermintaan(permintaan),
      body,
      signal: controller.signal,
      redirect: "error",
    });
    const jawaban = (await response.text().catch(() => "")).slice(0, 500);
    const durasiMs = Date.now() - mulai;
    if (!response.ok) {
      tulis({ ok: false, code: "CONNECTOR_UPSTREAM_ERROR", status: response.status, message: `Hulu menjawab ${response.status}.`, provider, durasiMs, lingkungan }, 4);
      return;
    }
    tulis({ ok: true, code: "CONNECTOR_DELIVERED", status: response.status, provider, durasiMs, jawaban, panjangTeks: teks.length, lingkungan }, 0);
  } catch (error) {
    const durasiMs = Date.now() - mulai;
    const nama = (error as Error)?.name;
    if (nama === "AbortError" || nama === "TimeoutError") {
      tulis({ ok: false, code: "CONNECTOR_TIMEOUT", message: `Anak berhenti menunggu setelah ${timeoutMs} ms.`, provider, durasiMs, lingkungan }, 5);
      return;
    }
    tulis({ ok: false, code: "CONNECTOR_NETWORK_ERROR", message: String((error as Error)?.message ?? error).slice(0, 200), provider, durasiMs, lingkungan }, 6);
  } finally {
    clearTimeout(timer);
  }
}

// Satu-satunya jalur keluar: satu baris JSON. Kegagalan tak terduga tetap dilaporkan, bukan diam.
utama().catch((error) => {
  tulis({ ok: false, code: "CHILD_CRASHED", message: String((error as Error)?.message ?? error).slice(0, 200), lingkungan: laporanLingkungan() }, 7);
});

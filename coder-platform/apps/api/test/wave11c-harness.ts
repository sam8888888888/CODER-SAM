/**
 * Perkakas bersama untuk tiga suite Wave 11C (butir 68, 71, 82).
 *
 * Berkas ini BUKAN suite (tidak berakhiran `.e2e.ts`, jadi tidak dijalankan `run-all.cjs`), hanya
 * klien HTTP + peladen tiruan + penghitung hasil yang dipakai bersama supaya ketiga suite memakai
 * aturan yang sama (cookie jar, CSRF ganda, pencarian port bebas, dan penutupan peladen tiruan).
 */
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createTcpServer } from "node:net";

/** Mencari port bebas di rentang Wave 11C (7320-7339); nomor utama dicoba lebih dulu. */
export async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 40 }, () => 7320 + Math.floor(Math.random() * 20))];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas di rentang Wave 11C (7320-7339): ada server uji yang belum keluar?");
}

export type Klien = {
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any; text: string; headers: Headers }>;
  bootstrap: () => Promise<void>;
};

/** Klien HTTP kecil: jar cookie sendiri + token CSRF ganda (dipakai bila CSRF_STRICT=true). */
export function buatKlien(base: string): Klien {
  const jar = new Map<string, string>();
  let primed = false;
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    if (mutating) await prime();
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: base,
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(mutating && jar.get("coder_csrf") ? { "x-csrf-token": String(jar.get("coder_csrf")) } : {}),
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0",
      "accept-language": "id-ID",
    };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const rawCookies = typeof (response.headers as any).getSetCookie === "function" ? ((response.headers as any).getSetCookie() as string[]) : [];
    for (const entry of rawCookies) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim();
      const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function prime() {
    if (primed) return;
    primed = true;
    try {
      await call("GET", "/health");
    } catch {
      /* server belum siap */
    }
  }
  return { call, bootstrap: prime };
}

/** Menunggu peladen uji siap menerima permintaan. */
export async function tungguSiap(base: string, percobaan = 100): Promise<boolean> {
  for (let attempt = 0; attempt < percobaan; attempt += 1) {
    try {
      const ready = await fetch(`${base}/health`);
      if (ready.ok) return true;
    } catch {
      /* belum siap */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** Penghitung hasil dengan keluaran `PASS`/`FAIL`/`SKIP` yang sama seperti suite Wave 11A/11B. */
export class Uji {
  passed = 0;
  failed = 0;
  failedNames: string[] = [];
  skipped: string[] = [];

  check(name: string, ok: boolean, detail = "") {
    if (ok) {
      this.passed += 1;
      console.log(`PASS ${name}`);
      return;
    }
    this.failed += 1;
    this.failedNames.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }

  skip(name: string, reason: string) {
    this.skipped.push(`${name} — ${reason}`);
    console.log(`SKIP ${name} ${reason}`);
  }

  ringkas(label: string) {
    console.log(`\nRINGKASAN ${label}: ${this.passed} PASS, ${this.failed} FAIL, ${this.skipped.length} SKIP`);
    if (this.failedNames.length) console.log(`GAGAL: ${this.failedNames.join(" | ")}`);
    if (this.skipped.length) console.log(`DILEWATI: ${this.skipped.join(" | ")}`);
  }
}

export type MockPermintaan = { method: string; path: string; headers: IncomingHttpHeaders; body: any; raw: string };
export type MockJawaban = { status: number; body?: unknown; tundaMs?: number };
/** `TETAP_BUKA` berarti peladen tiruan tidak pernah menjawab: dipakai membuktikan batas waktu. */
export type MockHandler = (request: MockPermintaan) => MockJawaban | "TETAP_BUKA";

export type Mock = {
  base: string;
  port: number;
  hitungan: Record<string, number>;
  /** Isi badan permintaan terakhir per jalur, untuk membuktikan apa yang benar-benar dikirim anak. */
  terakhir: Record<string, any>;
  /** Kepala permintaan terakhir per jalur (mis. header authorization), dibaca apa adanya. */
  terakhirHeader: Record<string, any>;
  tutup: () => Promise<void>;
};

/**
 * Peladen tiruan kecil untuk hulu pihak ketiga (Notion, Slack, Discord, MCP). Mencatat jumlah
 * permintaan per jalur dan badan permintaan terakhir, supaya suite bisa membuktikan bahwa hulu
 * TIDAK dipanggil (mis. saat 429 memblokir lebih dulu) atau apa yang benar-benar dikirim.
 */
export async function mulaiMock(port: number, handler: MockHandler): Promise<Mock> {
  const hitungan: Record<string, number> = {};
  const terakhir: Record<string, any> = {};
  const terakhirHeader: Record<string, any> = {};
  const sockets = new Set<any>();
  let menerima = true;
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (potongan) => {
      raw += potongan;
    });
    req.on("end", () => {
      let body: any = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const jalur = String(req.url ?? "/");
      hitungan[jalur] = (hitungan[jalur] ?? 0) + 1;
      hitungan.total = (hitungan.total ?? 0) + 1;
      terakhir[jalur] = body;
      terakhirHeader[jalur] = req.headers;
      let hasil: MockJawaban | "TETAP_BUKA";
      try {
        hasil = handler({ method: req.method ?? "GET", path: jalur, headers: req.headers, body, raw });
      } catch (error) {
        hasil = { status: 500, body: { error: "MOCK_GAGAL", message: String((error as Error)?.message ?? error) } };
      }
      if (hasil === "TETAP_BUKA") return; // soket dibiarkan terbuka tanpa jawaban: penggantung
      const kirim = () => {
        if (!menerima) return;
        res.writeHead(hasil.status, { "content-type": "application/json" });
        res.end(JSON.stringify(hasil.body ?? {}));
      };
      if (hasil.tundaMs) setTimeout(kirim, hasil.tundaMs);
      else kirim();
    });
  });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  // Port 0 = biarkan sistem memilih; port sebenarnya dibaca dari soket supaya tidak bentrok suite lain.
  const portNyata = Number((server.address() as { port?: number } | null)?.port ?? port);
  return {
    base: `http://127.0.0.1:${portNyata}`,
    port: portNyata,
    hitungan,
    terakhir,
    terakhirHeader,
    tutup: async () => {
      menerima = false;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** True bila proses dengan pid itu masih ada. Dipakai membuktikan SIGKILL benar-benar bekerja. */
export function pidHidup(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pemotong teks untuk pesan galat yang pendek. */
export const potong = (nilai: unknown, maks = 220) =>
  String(typeof nilai === "string" ? nilai : (() => { try { return JSON.stringify(nilai); } catch { return String(nilai); } })()).slice(0, maks);

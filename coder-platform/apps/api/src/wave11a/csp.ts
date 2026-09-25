/**
 * Wave 11A (butir 79): header Content-Security-Policy untuk seluruh jawaban server.
 *
 * Sebelum wave ini coder sama sekali tidak mengirim CSP (0 hasil pengukuran). Fungsi ini dipanggil
 * `server.ts` SEBELUM rute pertama didaftarkan, karena Fastify menyalin rangkaian hook ke setiap rute
 * saat rute itu didaftarkan: hook yang dipasang sesudahnya tidak ikut berjalan.
 *
 * Aturan PRD (butir 79): `default-src 'self'; script-src 'self'; object-src 'none';
 * frame-ancestors 'self'; base-uri 'self'` TANPA `unsafe-eval`/`unsafe-inline` untuk skrip.
 * Yang dilarang A6 PRD adalah EKSEKUSI skrip inline dan `eval`, jadi `script-src` tidak pernah
 * mendapat `unsafe-inline` maupun `unsafe-eval` di berkas ini.
 */
import { config } from "../config.js";

/**
 * Direktif dasar yang wajib ada (PRD butir 79), lalu penyesuaian sumber daya:
 *  - `img-src`/`media-src`/`frame-src` memuat `blob:` karena pratinjau dokumen dan gambar dibuat
 *    dari objek di memori peramban.
 *  - `font-src` memuat fonts.gstatic.com dan `style-src` memuat fonts.googleapis.com, karena
 *    `coder-dashboard/index.html` memuat Google Fonts.
 *  - `connect-src 'self'` menahan data agar tidak bisa dikirim ke host lain lewat fetch/XHR.
 */
function STYLE_ATTR_DIRECTIVES(): string[] {
  return [];
}

const BASE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' https://fonts.gstatic.com data:",
  "style-src 'self' https://fonts.googleapis.com",
  "form-action 'self'",
  // `style-src-attr 'unsafe-inline'` DIPUTUSKAN lewat pengukuran peramban, bukan selera. Lihat
  // catatan panjang di bawah daftar ini.
  ...STYLE_ATTR_DIRECTIVES(),
];

/**
 * CATATAN KEPUTUSAN `style-src-attr` (diukur dengan Chromium sungguhan, lihat wave11a-csp.e2e.ts):
 *
 *  - Dashboard punya 55 pemakaian atribut `style={{...}}` di `/workspace/coblai-dinda/coder-dashboard/src`
 *    (dihitung ulang oleh suite uji ini). React menulis gaya itu lewat CSSOM
 *    (`element.style.properti = nilai`), dan CSSOM BUKAN `style` attribute, jadi CSP tidak memblokirnya.
 *  - Karena pengukuran peramban menunjukkan 0 galat CSP pada semua halaman dashboard, direktif
 *    `style-src-attr` TIDAK ditambahkan. `script-src` tetap tanpa `unsafe-inline`/`unsafe-eval`.
 *  - Bila suatu hari pengukuran itu berubah (halaman rusak karena gaya inline diblokir), directif
 *    `style-src-attr 'unsafe-inline'` boleh ditambahkan di sini TANPA menyentuh `script-src`, karena
 *    A6 PRD melarang eksekusi skrip inline, bukan gaya.
 */
/** Kebijakan untuk dokumen dan API biasa. */
export const CSP_POLICY = BASE_DIRECTIVES.join("; ");

/**
 * Kebijakan paling ketat untuk berkas artefak yang disajikan mentah (butir 79 + butir 49).
 *
 * Artefak adalah berkas unggahan pengguna. Bila isinya HTML lalu dibuka di tab/iframe, isi itu bisa
 * menjalankan skrip dengan sesi pengguna. Karena itu jawaban `/api/v1/artifacts/:id/raw` dan
 * `/download` diberi `sandbox` (tanpa allow-scripts, tanpa allow-same-origin) plus `script-src 'none'`.
 * Gaya inline tetap diizinkan supaya dokumen HTML sederhana masih terbaca.
 */
export const CSP_POLICY_ARTIFACT = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox",
].join("; ");

/** True bila permintaan menuju berkas artefak mentah (isi tidak dipercaya). */
export function isRawArtifactPath(url: string): boolean {
  const path = String(url ?? "").split("?")[0];
  return /^\/api\/v1\/artifacts\/[^/]+\/(raw|download)$/.test(path);
}

/** Memilih kebijakan yang tepat untuk sebuah permintaan. */
export function policyFor(url: string): string {
  return isRawArtifactPath(url) ? CSP_POLICY_ARTIFACT : CSP_POLICY;
}

/**
 * Apakah tipe respons ini layak dibungkus CSP.
 *
 * PENGUKURAN/PENGAMATAN PENTING: penampil PDF bawaan Chrome menyisipkan elemen plugin di dalam
 * dokumen PDF, sehingga `object-src 'none'` (atau `default-src 'none'`) membuat pratinjau PDF jadi
 * halaman kosong — lihat laporan "Chrome does not display PDF content if Content Security Policy
 * (CSP) is in effect" (issues.chromium.org/40328564). Dashboard memuat pratinjau PDF lewat
 * `<iframe src="/api/v1/artifacts/:id/raw">`, jadi berkas plugin dan biner TIDAK diberi CSP sama
 * sekali; perilakunya persis seperti sebelum butir 79. Isi HTML/SVG/XML tetap dibungkus kebijakan,
 * karena hanya tipe itu yang bisa menjalankan markup/skrip.
 */
function layakDiberiCsp(contentType: string): boolean {
  const tipe = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!tipe) return true; // tanpa tipe: anggap dokumen (mis. HTML fallback)
  if (tipe === "text/html" || tipe === "application/xhtml+xml" || tipe === "image/svg+xml") return true;
  if (tipe === "application/xml" || tipe === "text/xml" || tipe.endsWith("+xml")) return true;
  if (tipe === "application/json" || tipe === "text/json" || tipe.endsWith("+json")) return true;
  if (tipe.startsWith("text/")) return true; // teks biasa tidak menjalankan markup
  return false; // application/pdf, image/* (selain svg), audio, video, font, zip, octet-stream
}

/**
 * Kebijakan akhir untuk satu respons: kebijakan artefak untuk berkas mentah, kebijakan biasa untuk
 * dokumen/API, atau `null` bila header CSP harus DILEPAS (berkas plugin/biner).
 */
export function policyUntukRespons(url: string, contentType: string): string | null {
  if (!layakDiberiCsp(contentType)) return null;
  return policyFor(url);
}

/** Wajib `true` di produksi; `CSP_ENABLED=false` mematikan header ini dan harus jadi tindakan sadar. */
export function cspEnabled(): boolean {
  return Boolean(config.CSP_ENABLED);
}

/**
 * Memasang header CSP pada seluruh jawaban: HTML dashboard, JSON API, dan 404.
 *
 * Header dipasang dua kali dengan cara yang aman:
 *  - `onRequest` supaya sudah ada sejak awal permintaan (termasuk jawaban HTML dari setNotFoundHandler);
 *  - `onSend` sebagai jaring pengaman untuk jawaban yang dikirim lebih awal oleh hook lain (mis. 403
 *    CSRF) atau oleh penangan galat. `onSend` hanya mengisi bila headernya belum ada, jadi kebijakan
 *    artefak yang lebih ketat tidak pernah tertimpa.
 */
export function registerCspRoutes(app: any): void {
  app.addHook("onRequest", async (request: any, reply: any) => {
    if (!cspEnabled()) return;
    reply.header("Content-Security-Policy", policyFor(request.url));
  });
  app.addHook("onSend", async (request: any, reply: any, payload: any) => {
    if (!cspEnabled()) return payload;
    const url = String(request?.url ?? request?.raw?.url ?? "");
    // Tipe isi hanya diketahui di sini, jadi keputusan akhir soal CSP diambil di hook ini.
    const kebijakan = policyUntukRespons(url, String(reply.getHeader("content-type") ?? ""));
    if (kebijakan === null) {
      reply.removeHeader("Content-Security-Policy");
      return payload;
    }
    // Kebijakan artefak selalu menang; selain itu header dari `onRequest` dibiarkan apa adanya.
    if (isRawArtifactPath(url) || !reply.getHeader("content-security-policy")) reply.header("Content-Security-Policy", kebijakan);
    return payload;
  });
}

/**
 * Wave 11A (butir 79): netralisasi HTML dari dokumen unggahan (DOCX/HTML).
 *
 * Isi dokumen unggahan adalah data TIDAK tepercaya. Modul ini membersihkan HTML dengan daftar putih
 * tag/atribut yang tegas, jadi berkas berbahaya tidak bisa menjalankan skrip di peramban pengguna.
 * Modul ini juga dipakai oleh pratinjau dokumen (butir 49).
 *
 * Tiga ekspor utama:
 *  - `sanitizeHtml(html)`     -> daftar putih tag + atribut; dipakai untuk pratinjau biasa.
 *  - `neutralizeHtml(html)`   -> versi paling ketat: tanpa atribut sama sekali, tanpa tautan/gambar.
 *  - `hasDangerousHtml(html)` -> penanda cepat untuk menandai/menolak berkas yang mencurigakan.
 *
 * Modul ini sengaja tanpa dependensi luar supaya hasilnya bisa diaudit baris per baris.
 */

/** Profil daftar putih: apa yang boleh lolos dan apa yang isinya dibuang seluruhnya. */
export interface SanitizeProfile {
  /** Tag yang boleh muncul di keluaran. Tag lain dibuang, tetapi isi teksnya dipertahankan. */
  allowedTags: Set<string>;
  /** Atribut per tag. Atribut di luar daftar ini dibuang. */
  allowedAttributes: Record<string, string[]>;
  /** Atribut yang boleh ada di tag mana pun (akhiran "-" berarti awalan, mis. "aria-"). */
  globalAttributes: string[];
  /** Tag langka yang seluruh isinya dibuang (skrip, iframe, form, dan sejenisnya). */
  dropContentTags: Set<string>;
  /** Tag tanpa isi; penutupnya tidak perlu ditulis. */
  voidTags: Set<string>;
  /** Bila true, atribut `style` diizinkan setelah nilainya disaring. */
  allowStyleAttribute: boolean;
  /** Bila true, atribut tautan (href/src/cite) diizinkan setelah skemanya diperiksa. */
  allowUrlAttributes: boolean;
}

/** Tag yang isinya dibuang seluruhnya. Isinya bukan teks, jadi tidak boleh ditampilkan. */
const DROP_CONTENT_TAGS = [
  "script", "style", "iframe", "object", "embed", "form", "applet", "frame", "frameset",
  "template", "noembed", "noframes", "noscript", "plaintext", "xmp",
];

const VOID_TAGS = ["area", "base", "br", "col", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];

/** Tag lazim untuk dokumen. Semua yang tidak ada di sini dibuang (isinya tetap ditampilkan). */
const HTML_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "col",
  "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p",
  "pre", "q", "s", "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
];

/** Atribut umum: tidak mengubah perilaku halaman, hanya tampilan/aksesibilitas. */
const GLOBAL_ATTRIBUTES = ["class", "id", "title", "dir", "lang", "role", "aria-", "data-"];

/** Atribut per tag yang benar-benar dipakai dokumen (word processor, ekspor HTML, dsb.). */
const HTML_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height", "loading"],
  ol: ["start", "reversed", "type"],
  td: ["colspan", "rowspan", "headers", "scope", "align", "valign", "width"],
  th: ["colspan", "rowspan", "headers", "scope", "align", "valign", "width"],
  table: ["border", "cellpadding", "cellspacing", "summary", "width"],
  col: ["span", "width"],
  colgroup: ["span", "width"],
  time: ["datetime"],
  blockquote: ["cite"],
  q: ["cite"],
  ins: ["cite", "datetime"],
  del: ["cite", "datetime"],
  details: ["open"],
};

/** Tag/gaya dasar untuk dokumen yang benar-benar dikosongkan dari atribut (pratinjau paling ketat). */
const PLAIN_TAGS = [
  "b", "blockquote", "br", "code", "dd", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "i", "kbd", "li", "ol", "p", "pre", "s", "samp", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "u", "ul",
];

/** Profil HTML biasa: tag lazim, tautan aman, tanpa atribut `style` dan tanpa penangan kejadian. */
export const htmlProfile: SanitizeProfile = {
  allowedTags: new Set(HTML_TAGS),
  allowedAttributes: HTML_ATTRIBUTES,
  globalAttributes: GLOBAL_ATTRIBUTES,
  dropContentTags: new Set(DROP_CONTENT_TAGS),
  voidTags: new Set(VOID_TAGS),
  allowStyleAttribute: false,
  allowUrlAttributes: true,
};

/** Profil paling ketat: hanya teks berformat, tanpa atribut dan tanpa tautan/gambar. */
export const plainProfile: SanitizeProfile = {
  allowedTags: new Set(PLAIN_TAGS),
  allowedAttributes: {},
  globalAttributes: [],
  dropContentTags: new Set(DROP_CONTENT_TAGS),
  voidTags: new Set(VOID_TAGS),
  allowStyleAttribute: false,
  allowUrlAttributes: false,
};

/**
 * Daftar putih SVG sederhana untuk berkas gambar vektor. SV(G) bisa memuat skrip lewat `<script>`
 * atau kejadian `on*`, jadi profil ini tetap membuang keduanya.
 */
export const sanitizeSvgSpec = {
  allowedTags: ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "use", "mask"],
  allowedAttributes: {
    svg: ["viewBox", "width", "height", "xmlns", "fill", "stroke", "preserveAspectRatio", "role"],
    g: ["transform", "fill", "stroke", "opacity", "clip-path", "mask"],
    path: ["d", "fill", "stroke", "stroke-width", "transform", "opacity", "fill-rule", "clip-rule"],
    rect: ["x", "y", "width", "height", "rx", "ry", "fill", "stroke", "stroke-width", "transform", "opacity"],
    circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width", "transform", "opacity"],
    ellipse: ["cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width", "transform", "opacity"],
    line: ["x1", "y1", "x2", "y2", "stroke", "stroke-width", "transform"],
    polyline: ["points", "fill", "stroke", "stroke-width", "transform"],
    polygon: ["points", "fill", "stroke", "stroke-width", "transform"],
    text: ["x", "y", "dx", "dy", "fill", "font-size", "font-family", "text-anchor", "transform"],
    tspan: ["x", "y", "dx", "dy", "fill", "font-size"],
    stop: ["offset", "stop-color", "stop-opacity"],
    use: ["href", "x", "y", "width", "height", "transform"],
    linearGradient: ["id", "x1", "y1", "x2", "y2", "gradientUnits"],
    radialGradient: ["id", "cx", "cy", "r", "fx", "fy", "gradientUnits"],
    clipPath: ["id", "clipPathUnits"],
    mask: ["id", "maskUnits"],
  } as Record<string, string[]>,
  globalAttributes: ["id", "class", "aria-"],
  dropContentTags: ["script", "foreignObject", "animate", "set", "handler"],
  voidTags: [] as string[],
  allowStyleAttribute: false,
  allowUrlAttributes: true,
};

/** Nama tag yang selalu dicurigai, walau daftar putih sudah membuangnya. */
const DANGEROUS_TAGS = ["script", "iframe", "object", "embed", "link", "form", "base", "frame", "frameset", "applet", "meta", "style"];

/** Atribut yang nilainya adalah URL, jadi skemanya wajib diperiksa. */
const URL_ATTRIBUTES = new Set(["href", "src", "cite", "action", "formaction", "poster", "background", "xlink:href", "data", "srcset"]);

/** Skema URL yang aman. `javascript:`, `vbscript:`, dan `data:text/html` tidak ada di sini. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "blob:"]);

const IMAGE_DATA_RE = /^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/i;

/** Entitas umum. Entitas tersembunyi dipakai penyerang untuk menyamarkan `javascript:` dan `<script>`. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", tab: "\t", newline: "\n",
  colon: ":", sol: "/", lpar: "(", rpar: ")", commat: "@", equals: "=", period: ".", semi: ";",
  quest: "?", hash: "#", percnt: "%", plus: "+", lowbar: "_", hyphen: "-",
};

/**
 * Mengurai entitas menjadi karakter aslinya. Dipakai SEBELUM memeriksa nilai atribut, supaya
 * `&#106;avascript:` dan `java&#x73;cript:` sama-sama terbaca sebagai `javascript:`.
 */
export function decodeEntities(input: string): string {
  return String(input ?? "").replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Membuang spasi kendali (NUL, tab, baris baru) yang dipakai menyamarkan skema URL. */
function stripControl(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
}

/** True bila nilai URL boleh dipakai: relatif, atau berskema aman. */
export function isSafeUrl(value: string): boolean {
  const raw = decodeEntities(value);
  const plain = stripControl(raw).toLowerCase();
  if (plain === "" || plain.startsWith("#")) return true;
  const colon = plain.indexOf(":");
  const slash = plain.search(/[/?#]/);
  // Tidak ada skema sama sekali (mis. "dokumen/gambar.png") => URL relatif, aman.
  if (colon < 0 || (slash >= 0 && slash < colon)) return true;
  const scheme = plain.slice(0, colon + 1);
  if (SAFE_SCHEMES.has(scheme)) return true;
  if (scheme === "data:") return IMAGE_DATA_RE.test(stripControl(raw));
  return false;
}

/** Menyaring nilai atribut `style` bila profil mengizinkannya (dipakai hanya bila perlu). */
function safeStyleValue(value: string): string {
  const text = decodeEntities(value);
  if (/url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|[<>\\]/i.test(text)) return "";
  return text.replace(/[\u0000-\u001f]/g, "").slice(0, 1000);
}

/** Teks biasa: hanya `<` yang di-escape; entitas yang sudah sah dibiarkan apa adanya. */
function escapeText(value: string): string {
  return value.replace(/&(?!#[0-9]+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, "&amp;").replace(/</g, "&lt;");
}

/** Nilai atribut keluar selalu di-escape lagi supaya tidak bisa keluar dari tanda kutip. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&(?!#[0-9]+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, "&amp;")
    .replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface ParsedTag {
  name: string;
  closing: boolean;
  /** Setiap atribut menyimpan nama asli (untuk SVG yang peka huruf besar/kecil) dan nilai mentahnya. */
  attributes: Array<{ key: string; value: string }>;
  selfClosing: boolean;
  end: number;
}

/**
 * Pengurai tag kecil. Tujuannya bukan meniru peramban sepenuhnya, melainkan membaca tag dan
 * atributnya dengan cara yang sama seperti peramban pada kasus yang berbahaya.
 * Mengembalikan null bila `<` bukan awal tag.
 */
function parseTag(input: string, start: number): ParsedTag | null {
  let i = start + 1;
  const closing = input[i] === "/";
  if (closing) i += 1;
  const nameStart = i;
  while (i < input.length && /[a-zA-Z0-9:_.-]/.test(input[i])) i += 1;
  const name = input.slice(nameStart, i).toLowerCase();
  if (!name) return null;
  const attributes: Array<{ key: string; value: string }> = [];
  let selfClosing = false;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;
    if (input[i] === ">") { i += 1; break; }
    if (input[i] === "/") { i += 1; if (input[i] === ">") { selfClosing = true; i += 1; break; } continue; }
    const attrStart = i;
    while (i < input.length && !/[\s=>/]/.test(input[i])) i += 1;
    const attrKey = input.slice(attrStart, i);
    const attrName = attrKey.toLowerCase();
    while (i < input.length && /\s/.test(input[i])) i += 1;
    let value = "";
    if (input[i] === "=") {
      i += 1;
      while (i < input.length && /\s/.test(input[i])) i += 1;
      const quote = input[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const valueStart = i;
        while (i < input.length && input[i] !== quote) i += 1;
        value = input.slice(valueStart, i);
        i += 1;
      } else {
        const valueStart = i;
        while (i < input.length && !/[\s>]/.test(input[i])) i += 1;
        value = input.slice(valueStart, i);
      }
    }
    if (attrName) attributes.push({ key: attrKey, value });
  }
  return { name, closing, attributes, selfClosing, end: i };
}

/** Menulis ulang tag pembuka dari atribut yang lolos daftar putih saja. */
function renderOpenTag(tag: ParsedTag, profile: SanitizeProfile): string {
  const perTag = profile.allowedAttributes[tag.name] ?? [];
  const pieces: string[] = [];
  for (const attribute of tag.attributes) {
    const name = attribute.key.toLowerCase();
    const rawValue = attribute.value;
    if (name.startsWith("on")) continue;                       // penangan kejadian on* selalu dibuang
    if (name === "style") {
      if (!profile.allowStyleAttribute) continue;              // atribut style mati secara bawaan
      const clean = safeStyleValue(rawValue);
      if (clean) pieces.push(`style="${escapeAttribute(clean)}"`);
      continue;
    }
    const allowed = perTag.includes(name)
      || profile.globalAttributes.some((item) => (item.endsWith("-") ? name.startsWith(item) : name === item));
    if (!allowed) continue;
    if (URL_ATTRIBUTES.has(name)) {
      if (!profile.allowUrlAttributes) continue;
      if (!isSafeUrl(rawValue)) continue;
    }
    const value = decodeEntities(rawValue);
    // Nama atribut ditulis dengan huruf aslinya: SVG peka huruf besar/kecil (mis. viewBox).
    pieces.push(`${attribute.key}="${escapeAttribute(value)}"`);
  }
  if (tag.name === "a" && pieces.some((piece) => piece.startsWith("target="))) {
    // Tautan ke tab baru tanpa noopener bisa dipakai halaman lain untuk mengendalikan tab pengguna.
    if (!pieces.some((piece) => piece.startsWith("rel="))) pieces.push('rel="noopener noreferrer"');
  }
  const body = `${pieces.length ? " " + pieces.join(" ") : ""}`;
  // Tag yang menutup diri sendiri ditulis `/>`: di dokumen HTML peramban mengabaikan garis miringnya,
  // sedangkan di dokumen XML/SVG garis miring itu wajib supaya elemennya benar-benar tertutup.
  if (tag.selfClosing || profile.voidTags.has(tag.name)) return `<${tag.name}${body}/>`;
  return `<${tag.name}${body}>`;
}

/** Indeks sesudah tag penutup `</name>`; bila tidak ada, seluruh sisa dokumen dibuang. */
function findClosing(input: string, name: string, from: number): number {
  const pattern = new RegExp(`</${name}\\s*>`, "i");
  const rest = input.slice(from);
  const found = rest.match(pattern);
  if (!found || found.index === undefined) return input.length;
  return from + found.index + found[0].length;
}

/** Inti pembersih: satu kali jalan, tanpa dependensi. */
function sanitizeWith(html: string, profile: SanitizeProfile): string {
  const input = String(html ?? "");
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt < 0) { out.push(escapeText(input.slice(i))); break; }
    if (lt > i) out.push(escapeText(input.slice(i, lt)));
    if (input.startsWith("<!--", lt)) {                          // komentar (termasuk komentar bersyarat)
      const end = input.indexOf("-->", lt + 4);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {   // doctype dan instruksi proses
      const end = input.indexOf(">", lt);
      i = end < 0 ? input.length : end + 1;
      continue;
    }
    const tag = parseTag(input, lt);
    if (!tag) { out.push("&lt;"); i = lt + 1; continue; }
    i = tag.end;
    if (profile.dropContentTags.has(tag.name)) {
      // Isi tag ini bukan teks untuk dibaca: buang seluruhnya, seperti peramban membuang skrip.
      i = tag.selfClosing ? i : findClosing(input, tag.name, i);
      continue;
    }
    if (!profile.allowedTags.has(tag.name)) continue;             // tag di luar daftar: tag hilang, teks tetap
    if (tag.closing) {
      if (!profile.voidTags.has(tag.name)) out.push(`</${tag.name}>`);
      continue;
    }
    out.push(renderOpenTag(tag, profile));
  }
  return out.join("");
}

/** Membersihkan HTML dengan daftar putih tag/atribut. Aman untuk ditampilkan di halaman pengguna. */
export function sanitizeHtml(html: string): string {
  return sanitizeWith(html, htmlProfile);
}

/**
 * Versi paling ketat, untuk pratinjau dokumen: semua atribut dibuang dan tautan/gambar dihilangkan.
 * Cocok untuk dokumen DOCX/HTML yang isinya tidak dipercaya sama sekali.
 */
export function neutralizeHtml(html: string): string {
  return sanitizeWith(html, plainProfile);
}

/** Membersihkan SVG dengan daftar putih sederhana (tanpa skrip, tanpa kejadian `on*`). */
export function sanitizeSvg(svg: string): string {
  return sanitizeWith(svg, {
    allowedTags: new Set(sanitizeSvgSpec.allowedTags.map((item) => item.toLowerCase())),
    allowedAttributes: Object.fromEntries(Object.entries(sanitizeSvgSpec.allowedAttributes)
      .map(([key, value]) => [key.toLowerCase(), value.map((item) => item.toLowerCase())])),
    globalAttributes: sanitizeSvgSpec.globalAttributes,
    dropContentTags: new Set(sanitizeSvgSpec.dropContentTags.map((item) => item.toLowerCase())),
    voidTags: new Set<string>(),
    allowStyleAttribute: false,
    allowUrlAttributes: true,
  });
}

/**
 * True bila HTML memuat pola berbahaya. Dipakai untuk menandai berkas mencurigakan sebelum
 * pembersihan, dan untuk laporan pemeriksaan. Pemeriksaannya lewat pengurai tag, bukan pola teks,
 * supaya kata biasa seperti "ongkos=" tidak dianggap penangan kejadian.
 */
export function hasDangerousHtml(html: string): boolean {
  const input = String(html ?? "");
  const probe = decodeEntities(input);
  if (/javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i.test(stripControl(probe))) return true;
  if (/<\s*(script|iframe|object|embed|link|form|base|frame|frameset|applet|meta|style)\b/i.test(probe)) {
    // `<meta charset>` dan `<style>` biasa (dokumen ekspor) tetap dihitung berbahaya untuk pratinjau
    // dokumen, karena keduanya bisa mengubah halaman. Pemanggil boleh memakai sanitizeHtml bila
    // hanya ingin membersihkan.
    return true;
  }
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt < 0) break;
    if (input.startsWith("<!--", lt)) { const end = input.indexOf("-->", lt + 4); i = end < 0 ? input.length : end + 3; continue; }
    const tag = parseTag(input, lt);
    if (!tag) { i = lt + 1; continue; }
    i = tag.end;
    if (DANGEROUS_TAGS.includes(tag.name)) return true;
    for (const attribute of tag.attributes) {
      const name = attribute.key.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")) return true;
      if (name === "srcdoc" || name === "http-equiv") return true;
      if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value)) return true;
    }
  }
  return false;
}

/** Ringkasan singkat untuk laporan/audit: jumlah pola berbahaya yang ditemukan. */
export function dangerousHtmlReason(html: string): string | null {
  if (hasDangerousHtml(html)) return "Dokumen memuat HTML berbahaya (skrip, iframe, form, atau tautan berbahaya).";
  return null;
}

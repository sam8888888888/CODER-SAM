/**
 * Wave 11C (butir 76) — pembersih gambar avatar. PEKERJAAN NYATA, bukan tafsiran.
 *
 * Di peladen ini TIDAK ADA pustaka pemroses gambar (sharp/jimp) dan tidak ada yang boleh dipasang
 * tanpa izin. Karena itu berkas ini memuat penulis-ulang PNG sendiri memakai `node:zlib`:
 *
 *  1. jenis berkas dikenali dari ISI (magic byte), bukan dari nama atau header Content-Type;
 *  2. seluruh chunk dibaca dan CRC32 tiap chunk diperiksa;
 *  3. IDAT dibuka (inflate) dan filter baris 0..4 dibalik sesuai spesifikasi PNG;
 *  4. pusat gambar dipotong persegi, lalu diskalakan ke `AVATAR_SIZE` (bawaan 512) dengan
 *     penyaring kotak (rata-rata luas);
 *  5. berkas ditulis ULANG: hanya IHDR + IDAT + IEND. SEMUA chunk tambahan (tEXt, sRGB, pHYs,
 *     eXIf, iCCP, waktu, dan lain-lain) hilang, jadi metadata kamera/aplikasi tidak ikut tersimpan.
 *
 * JPEG dan WebP DITOLAK dengan `503 IMAGE_PROCESSOR_UNAVAILABLE`: tanpa pemroses, gambar seperti itu
 * tidak bisa ditulis ulang, dan menyimpan berkas mentah dilarang. Batas ini disebutkan apa adanya.
 *
 * Perbandingan CRC32 di bawah memakai tabel standar (polinomial 0xEDB88320), sama seperti spesifikasi
 * PNG, sehingga berkas keluaran bisa dibuka pemeriksa lain.
 */
import { deflateSync, inflateSync } from "node:zlib";

/** Tanda tangan berkas PNG (8 byte). */
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Batas ukuran piksel mentah yang boleh dibuka: penjaga bom dekompresi. */
export const MAX_RAW_PIXEL_BYTES = 32 * 1024 * 1024;

/** Batas sisi gambar yang diterima sebelum dibuka. */
export const MAX_DIMENSI = 8000;

/** Batas jumlah chunk supaya berkas aneh tidak memakan waktu lama. */
const MAX_CHUNKS = 4096;

export type ImageKind = "png" | "jpeg" | "webp" | "gif" | "bmp" | "svg" | "lain";

export type ImageErrorCode = "IMAGE_EMPTY" | "IMAGE_UNSUPPORTED" | "IMAGE_PROCESSOR_UNAVAILABLE" | "IMAGE_CORRUPT" | "IMAGE_TOO_LARGE";

/** Galat gambar beserta kode mesin dan status HTTP yang pantas. */
export class ImageError extends Error {
  constructor(readonly code: ImageErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "ImageError";
  }
}

/** Jenis berkas dari magic byte. Nama berkas dan Content-Type tidak pernah dipakai. */
export function sniffImageKind(isi: Buffer): ImageKind {
  const kepala = isi.subarray(0, Math.min(isi.length, 512));
  if (kepala.length >= 8 && kepala.subarray(0, 8).equals(SIGNATURE)) return "png";
  if (kepala.length >= 3 && kepala[0] === 0xff && kepala[1] === 0xd8 && kepala[2] === 0xff) return "jpeg";
  if (kepala.length >= 12 && kepala.subarray(0, 4).toString("latin1") === "RIFF" && kepala.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  const enam = kepala.subarray(0, 6).toString("latin1");
  if (enam === "GIF87a" || enam === "GIF89a") return "gif";
  if (kepala.length >= 2 && kepala[0] === 0x42 && kepala[1] === 0x4d) return "bmp";
  const teks = kepala.toString("utf8").trim().toLowerCase();
  if (teks.startsWith("<svg") || teks.startsWith("<?xml")) return "svg";
  return "lain";
}

const TABEL_CRC = (() => {
  const tabel = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tabel[n] = c;
  }
  return tabel;
})();

/** CRC32 standar PNG. */
export function crc32(data: Buffer): number {
  let c = -1;
  for (let i = 0; i < data.length; i += 1) c = TABEL_CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export type PngChunk = { type: string; data: Buffer };

/** Satu chunk PNG lengkap (panjang + jenis + isi + CRC32). */
export function tulisChunk(type: string, data: Buffer): Buffer {
  const panjang = Buffer.alloc(4);
  panjang.writeUInt32BE(data.length, 0);
  const jenis = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([jenis, data])), 0);
  return Buffer.concat([panjang, jenis, data, crc]);
}

/** Membaca seluruh chunk PNG dan memeriksa CRC32 tiap chunk. */
export function bacaChunk(png: Buffer): PngChunk[] {
  if (png.length < 8 + 25 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new ImageError("IMAGE_CORRUPT", 400, "Berkas diawali tanda PNG tetapi isinya bukan PNG yang sah.");
  }
  const chunks: PngChunk[] = [];
  let posisi = 8;
  let selesai = false;
  while (posisi + 12 <= png.length) {
    if (chunks.length >= MAX_CHUNKS) throw new ImageError("IMAGE_CORRUPT", 400, `Jumlah chunk melebihi batas ${MAX_CHUNKS}.`);
    const panjang = png.readUInt32BE(posisi);
    const akhir = posisi + 12 + panjang;
    if (akhir > png.length) throw new ImageError("IMAGE_CORRUPT", 400, "Panjang chunk melewati akhir berkas.");
    const jenis = png.subarray(posisi + 4, posisi + 8).toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(jenis)) throw new ImageError("IMAGE_CORRUPT", 400, "Nama chunk PNG tidak sah.");
    const data = png.subarray(posisi + 8, posisi + 8 + panjang);
    const crcTertulis = png.readUInt32BE(posisi + 8 + panjang);
    const crcHitung = crc32(Buffer.concat([png.subarray(posisi + 4, posisi + 8), data]));
    if (crcTertulis !== crcHitung) throw new ImageError("IMAGE_CORRUPT", 400, `CRC32 chunk ${jenis} tidak cocok.`);
    chunks.push({ type: jenis, data: Buffer.from(data) });
    posisi = akhir;
    if (jenis === "IEND") { selesai = true; break; }
  }
  if (!selesai) throw new ImageError("IMAGE_CORRUPT", 400, "PNG tidak diakhiri chunk IEND.");
  return chunks;
}

const SALURAN: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export type InfoPng = { width: number; height: number; bitDepth: number; colorType: number; channels: number; interlace: number; chunks: string[] };

/** Membaca IHDR + daftar jenis chunk tanpa membuka IDAT (dipakai untuk memeriksa berkas tersimpan). */
export function infoPng(png: Buffer): InfoPng {
  const chunks = bacaChunk(png);
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.data.length !== 13) throw new ImageError("IMAGE_CORRUPT", 400, "Chunk pertama bukan IHDR.");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  return { width, height, bitDepth, colorType, channels: SALURAN[colorType] ?? 0, interlace: ihdr.data[12], chunks: chunks.map((chunk) => chunk.type) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Membalik filter baris PNG (jenis 0..4) menjadi piksel mentah. */
function bukaFilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const lebarBaris = width * channels;
  const keluar = Buffer.alloc(lebarBaris * height);
  for (let y = 0; y < height; y += 1) {
    const mulai = y * (lebarBaris + 1);
    const jenisFilter = raw[mulai];
    if (jenisFilter > 4) throw new ImageError("IMAGE_CORRUPT", 400, `Jenis filter PNG ${jenisFilter} tidak dikenal.`);
    const baris = raw.subarray(mulai + 1, mulai + 1 + lebarBaris);
    const kini = keluar.subarray(y * lebarBaris, (y + 1) * lebarBaris);
    const sebelum = y > 0 ? keluar.subarray((y - 1) * lebarBaris, y * lebarBaris) : null;
    for (let x = 0; x < lebarBaris; x += 1) {
      const a = x >= channels ? kini[x - channels] : 0;
      const b = sebelum ? sebelum[x] : 0;
      const c = sebelum && x >= channels ? sebelum[x - channels] : 0;
      let nilai: number;
      if (jenisFilter === 0) nilai = baris[x];
      else if (jenisFilter === 1) nilai = baris[x] + a;
      else if (jenisFilter === 2) nilai = baris[x] + b;
      else if (jenisFilter === 3) nilai = baris[x] + ((a + b) >> 1);
      else nilai = baris[x] + paeth(a, b, c);
      kini[x] = nilai & 0xff;
    }
  }
  return keluar;
}

export type DecodedPng = { width: number; height: number; colorType: number; channels: number; pixels: Buffer; chunks: string[] };

/** Membuka PNG 8-bit tanpa palet menjadi piksel mentah. Format lain ditolak dengan alasan jelas. */
export function decodePng(png: Buffer): DecodedPng {
  const info = infoPng(png);
  if (info.interlace !== 0) throw new ImageError("IMAGE_UNSUPPORTED", 400, "PNG berkelindan (interlaced) belum didukung; simpan ulang tanpa interlace.");
  const channels = SALURAN[info.colorType];
  if (!channels) throw new ImageError("IMAGE_UNSUPPORTED", 400, `Jenis warna PNG ${info.colorType} belum didukung (hanya 0, 2, 4, 6 tanpa palet).`);
  if (info.bitDepth !== 8) throw new ImageError("IMAGE_UNSUPPORTED", 400, `Kedalaman bit PNG ${info.bitDepth} belum didukung (hanya 8 bit per saluran).`);
  if (info.width < 1 || info.height < 1) throw new ImageError("IMAGE_CORRUPT", 400, "Ukuran gambar nol.");
  if (info.width > MAX_DIMENSI || info.height > MAX_DIMENSI) {
    throw new ImageError("IMAGE_TOO_LARGE", 413, `Sisi gambar ${info.width}x${info.height} melebihi batas ${MAX_DIMENSI} piksel.`);
  }
  const perlu = info.height * (1 + info.width * channels);
  if (perlu > MAX_RAW_PIXEL_BYTES) {
    throw new ImageError("IMAGE_TOO_LARGE", 413, `Piksel mentah ${perlu} byte melebihi batas ${MAX_RAW_PIXEL_BYTES} byte.`);
  }
  const potongan = bacaChunk(png);
  if (potongan[0].type !== "IHDR") throw new ImageError("IMAGE_CORRUPT", 400, "Chunk pertama bukan IHDR.");
  const idat = potongan.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
  if (!idat.length) throw new ImageError("IMAGE_CORRUPT", 400, "PNG tanpa data IDAT.");
  let raw: Buffer;
  try {
    // maxOutputLength menahan bom dekompresi: berkas kecil yang mengaku gambar raksasa ditolak di sini.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: perlu });
  } catch {
    throw new ImageError("IMAGE_CORRUPT", 400, "Data IDAT tidak bisa dibuka (rusak atau lebih besar dari yang dijanjikan header).");
  }
  if (raw.length !== perlu) throw new ImageError("IMAGE_CORRUPT", 400, `Panjang data ${raw.length} byte tidak sama dengan ${perlu} byte yang diharapkan.`);
  return { width: info.width, height: info.height, colorType: info.colorType, channels, pixels: bukaFilter(raw, info.width, info.height, channels), chunks: info.chunks };
}

/** Memotong persegi dari tengah dan menskalakan ke `sisi` x `sisi` dengan penyaring kotak. */
export function potongDanSkalakan(gambar: DecodedPng, sisi: number): { pixels: Buffer; potong: { x: number; y: number; ukuran: number } } {
  const channels = gambar.channels;
  const ukuran = Math.min(gambar.width, gambar.height);
  const x0 = Math.floor((gambar.width - ukuran) / 2);
  const y0 = Math.floor((gambar.height - ukuran) / 2);
  const keluar = Buffer.alloc(sisi * sisi * channels);
  for (let dy = 0; dy < sisi; dy += 1) {
    const ay = y0 + Math.floor((dy * ukuran) / sisi);
    const by = y0 + Math.max(Math.floor(((dy + 1) * ukuran) / sisi), Math.floor((dy * ukuran) / sisi) + 1);
    for (let dx = 0; dx < sisi; dx += 1) {
      const ax = x0 + Math.floor((dx * ukuran) / sisi);
      const bx = x0 + Math.max(Math.floor(((dx + 1) * ukuran) / sisi), Math.floor((dx * ukuran) / sisi) + 1);
      for (let ch = 0; ch < channels; ch += 1) {
        let total = 0; let jumlah = 0;
        for (let y = ay; y < by; y += 1) {
          for (let x = ax; x < bx; x += 1) { total += gambar.pixels[(y * gambar.width + x) * channels + ch]; jumlah += 1; }
        }
        keluar[(dy * sisi + dx) * channels + ch] = Math.round(total / jumlah);
      }
    }
  }
  return { pixels: keluar, potong: { x: x0, y: y0, ukuran } };
}

/** Menulis PNG baru: hanya IHDR + IDAT + IEND, filter baris 0, tanpa chunk tambahan. */
export function encodePng(width: number, height: number, colorType: number, channels: number, pixels: Buffer): Buffer {
  const lebarBaris = width * channels;
  const raw = Buffer.alloc((lebarBaris + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (lebarBaris + 1)] = 0;
    pixels.copy(raw, y * (lebarBaris + 1) + 1, y * lebarBaris, (y + 1) * lebarBaris);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIGNATURE, tulisChunk("IHDR", ihdr), tulisChunk("IDAT", deflateSync(raw, { level: 9 })), tulisChunk("IEND", Buffer.alloc(0))]);
}

export type HasilPembersihan = {
  png: Buffer; lebar: number; tinggi: number; jenis: ImageKind;
  asal: { lebar: number; tinggi: number; bitDepth: number; colorType: number };
  potong: { x: number; y: number; ukuran: number };
  chunkDibuang: string[];
};

/**
 * Membersihkan gambar avatar: hanya PNG yang diterima dan selalu ditulis ulang.
 * JPEG/WebP ditolak 503 karena tidak ada pemroses; format lain ditolak 400.
 */
export function bersihkanGambarAvatar(isi: Buffer, sisi: number): HasilPembersihan {
  if (!Buffer.isBuffer(isi) || isi.length === 0) throw new ImageError("IMAGE_EMPTY", 400, "Berkas gambar kosong.");
  const jenis = sniffImageKind(isi);
  if (jenis === "jpeg" || jenis === "webp") {
    throw new ImageError("IMAGE_PROCESSOR_UNAVAILABLE", 503, `Gambar ${jenis.toUpperCase()} belum bisa diproses di peladen ini (tidak ada pustaka pemroses), jadi berkas tidak disimpan. Unggah PNG.`);
  }
  if (jenis !== "png") {
    throw new ImageError("IMAGE_UNSUPPORTED", 400, `Isi berkas bukan PNG/JPEG/WebP yang sah (terbaca: ${jenis}). Nama berkas dan Content-Type tidak dipakai untuk menebak.`);
  }
  const gambar = decodePng(isi);
  const { pixels, potong } = potongDanSkalakan(gambar, sisi);
  const png = encodePng(sisi, sisi, gambar.colorType, gambar.channels, pixels);
  const tambahan = gambar.chunks.filter((nama) => nama !== "IHDR" && nama !== "IDAT" && nama !== "IEND");
  return {
    png, lebar: sisi, tinggi: sisi, jenis: "png",
    asal: { lebar: gambar.width, tinggi: gambar.height, bitDepth: 8, colorType: gambar.colorType },
    potong, chunkDibuang: tambahan,
  };
}

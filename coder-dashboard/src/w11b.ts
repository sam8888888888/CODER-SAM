/**
 * Perkakas bersama halaman Wave 11B (butir 58-72).
 *
 * Berkas ini sengaja tipis: hanya kelas Tailwind dasar dan pemformat angka/waktu yang dipakai
 * beberapa halaman sekaligus. Tujuannya supaya gaya halaman Wave 11B seragam dan tidak ada salinan
 * rumus mikro-dolar di banyak berkas.
 */
import { failureOf } from './api';

/** Kelas tombol dasar (gelap, sesuai tema halaman Wave 11A). */
export const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama. */
export const BTN_UTAMA = BTN.replace('bg-slate-800/60', 'bg-violet-600/80');
/** Kelas input, select, dan textarea. */
export const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas pembungkus kartu. */
export const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas label kecil di atas isian. */
export const LABEL = 'flex flex-col gap-1 text-slate-300 text-xs';
/** Kelas tabel sederhana. */
export const TABEL = 'w-full border-collapse text-left text-xs text-slate-200';
export const SEL = 'border-b border-slate-700 px-2 py-1';

/** Angka ribuan gaya Indonesia. */
export function angka(value: unknown): string {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString('id-ID') : '0';
}

/** Mikrodolar (1.000.000 = 1 dolar) ditulis sebagai USD dengan 6 desimal, sama seperti halaman lain. */
export function usd(micros: unknown): string {
  const parsed = typeof micros === 'number' ? micros : Number(micros);
  return `$${((Number.isFinite(parsed) ? parsed : 0) / 1_000_000).toFixed(6)}`;
}

/** Waktu lokal Indonesia; nilai kosong atau tidak sah ditulis sebagai tanda hubung. */
export function waktu(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleString('id-ID');
}

/** Milidetik menjadi teks singkat (mis. 1.250 md -> 1,3 dtk). */
export function durasi(ms: unknown): string {
  const parsed = Number(ms);
  if (!Number.isFinite(parsed) || parsed < 0) return '—';
  if (parsed < 1000) return `${Math.round(parsed)} md`;
  return `${(parsed / 1000).toFixed(1).replace('.', ',')} dtk`;
}

/** Pesan galat Indonesia dari server; kode mesin dipakai bila server tidak mengirim kalimat. */
export function pesanGalat(error: unknown, fallback: string): string {
  const detail = failureOf(error);
  return detail.message || detail.code || fallback;
}

/** Ubah nilai tak dikenal menjadi daftar aman. */
export function daftar<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Bulan berjalan dalam bentuk YYYY-MM (dipakai kartu pembukuan token). */
export function bulanBerjalan(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Kamus jam yang wajar dipakai pengguna Indonesia untuk pilihan zona waktu jadwal. */
export const ZONA_WAKTU = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'UTC'];

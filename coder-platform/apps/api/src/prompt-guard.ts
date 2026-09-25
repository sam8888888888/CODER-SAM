/**
 * Wave 11A (butir 45): filter anti prompt-hijack.
 *
 * Upaya membajak instruksi kunci ditolak SEBELUM model dipanggil. Daftar pola sengaja dibuat
 * sempit: setiap pola wajib menyebut tindakan membajak (abaikan/lupakan/bocorkan/ganti peran)
 * beserta sasarannya, supaya kalimat wajar seperti "baca instruksi di berkas README lalu ringkas"
 * tidak ikut terblokir. Salah blokir lebih mahal daripada lolosnya satu varian serangan.
 */

export type HijackCategory = "abaikan_instruksi" | "lupakan_aturan" | "bocorkan_sistem" | "jailbreak" | "ganti_peran" | "tersandi";

export type HijackPattern = { name: string; category: HijackCategory; pattern: RegExp };

/** Panjang kutipan yang boleh disimpan di audit. Isi penuh prompt tidak pernah disimpan. */
export const HIJACK_SNIPPET_CHARS = 200;

export const HIJACK_PATTERNS: HijackPattern[] = [
  // 1-4: menyuruh mengabaikan instruksi (Indonesia + Inggris)
  { name: "abaikan_instruksi_id", category: "abaikan_instruksi", pattern: /\babaikan\s+(semua\s+|seluruh\s+)?(instruksi|perintah|aturan|arahan)\b/i },
  { name: "lupakan_aturan_id", category: "lupakan_aturan", pattern: /\blupakan\s+(semua\s+|seluruh\s+)?(aturan|instruksi|perintah|arahan|batasan)\b/i },
  { name: "ignore_instructions_en", category: "abaikan_instruksi", pattern: /\bignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|preceding|above|earlier|initial)\s+(instruction|instructions|prompt|prompts|rule|rules)\b/i },
  { name: "ignore_rules_en", category: "abaikan_instruksi", pattern: /\bignore\s+(all\s+|any\s+)?(your\s+)?(rules|guidelines|restrictions|guardrails|constraints)\b/i },
  // 5-6: melupakan aturan (Inggris)
  { name: "forget_rules_en", category: "lupakan_aturan", pattern: /\bforget\s+(all\s+|everything\s+about\s+)?(your\s+)?(rules|instructions|guidelines|training)\b/i },
  { name: "disregard_previous_en", category: "lupakan_aturan", pattern: /\bdisregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|earlier|above|system)\b/i },
  // 7-9: meminta membocorkan system prompt
  { name: "bocorkan_system_prompt_id", category: "bocorkan_sistem", pattern: /\b(bocorkan|tampilkan|tunjukkan|kasih|beri|tuliskan|cetak|salin|sebutkan)\b[^.\n]{0,30}\b(system\s*prompt|prompt\s*sistem|instruksi\s+(awal|sistem|rahasia|dasar)|prompt\s+awal(mu)?)\b/i },
  { name: "reveal_system_prompt_en", category: "bocorkan_sistem", pattern: /\b(reveal|show|print|dump|repeat|output|expose)\b[^.\n]{0,30}\b(system\s*prompt|initial\s+instructions|hidden\s+prompt|secret\s+instructions)\b/i },
  { name: "ulangi_kata_di_atas_id", category: "bocorkan_sistem", pattern: /\b(ulangi|repeat)\b[^.\n]{0,25}\b(semua|everything|kata\s+kata)\b[^.\n]{0,20}\b(di\s+atas|above)\b/i },
  // 10-13: jailbreak & mode khusus
  { name: "jailbreak", category: "jailbreak", pattern: /\b(jailbreak|jail\s*break|d\.a\.n\.?\s*mode|do\s+anything\s+now)\b/i },
  { name: "god_mode", category: "jailbreak", pattern: /\b(god\s*mode|mode\s+(dewa|tuhan|root|admin|developer|debug)\s*(aktif|on|nyala)?)\b/i },
  { name: "tanpa_filter", category: "jailbreak", pattern: /\b(tanpa|no|without)\s+(filter|sensor|sensor\w*|etika|ethical\s+limits?|batasan\s+etika)\b/i },
  { name: "abaikan_guardrail", category: "jailbreak", pattern: /\babaikan\s+(batasan|pagar|pengaman|guardrail|safety|aturan\s+keamanan)\b/i },
  // 14-17: mengganti peran / melepas ikatan
  { name: "ganti_peran_tanpa_aturan", category: "ganti_peran", pattern: /\b(you\s+are\s+now|mulai\s+sekarang\s+kamu\s+adalah|kamu\s+sekarang\s+adalah|anggap\s+(saja\s+)?kamu\s+adalah)\b[^.\n]{0,50}\b(tanpa|no|without)\b[^.\n]{0,20}\b(aturan|rules|batasan|restriction|limit)/i },
  { name: "pura_pura_tanpa_batasan", category: "ganti_peran", pattern: /\b(pura-pura|berpura-pura|pretend|act\s+as\s+if)\b[^.\n]{0,40}\b(tidak\s+punya|cannot\s+be|no|tanpa)\b[^.\n]{0,20}\b(batasan|aturan|restriction|limit|filter)/i },
  { name: "tidak_terikat_aturan", category: "ganti_peran", pattern: /\b(kamu\s+tidak\s+(lagi\s+)?terikat|you\s+are\s+no\s+longer\s+bound|lepas\s+dari\s+semua\s+aturan)\b/i },
  { name: "jangan_patuhi", category: "ganti_peran", pattern: /\bjangan\s+(patuhi|turut|dengarkan|indahkan)\s+(aturan|instruksi|system|sistem|pengembang|developer)\b/i },
  // 18-20: instruksi tersandi
  { name: "instruksi_tersandi", category: "tersandi", pattern: /\b(base64|rot13|rot-13|hex)\b[^.\n]{0,30}\b(decode|decrypt|terjemahkan|buka|urai)\b/i },
  { name: "jalankan_setelah_dibuka", category: "tersandi", pattern: /\b(decode|decrypt|urai|buka)\b[^.\n]{0,30}\b(base64|rot13|kode\s+tersandi|pesan\s+tersandi)\b[^.\n]{0,30}\b(jalankan|lakukan|ikuti|execute|obey)\b/i },
  { name: "muatan_tersandi", category: "tersandi", pattern: /\b(base64|rot13)\b\s*[:=]\s*[A-Za-z0-9+/=]{24,}/i },
  { name: "instruksi_tersembunyi", category: "tersandi", pattern: /\b(instruksi\s+tersembunyi|hidden\s+instructions?|prompt\s+tersembunyi)\b/i },
  // 21-24: menimpa kebijakan / mencari celah
  { name: "override_kebijakan", category: "abaikan_instruksi", pattern: /\b(override|timpa)\b[^.\n]{0,25}\b(kebijakan|aturan|instruksi|system|prompt)\b/i },
  { name: "celah_aturan", category: "abaikan_instruksi", pattern: /\b(cari\s+celah|bypass|lewati)\b[^.\n]{0,25}\b(aturan|filter|pengaman|batasan|safety|guardrail)\b/i },
  { name: "mode_bebas", category: "jailbreak", pattern: /\b(mode|status)\s+(bebas|unrestricted|unfiltered|tanpa\s+batas|tanpa\s+aturan)\b/i },
  { name: "abaikan_pengembang", category: "abaikan_instruksi", pattern: /\b(abaikan|ignore)\s+(pengembang|developer|pembuat|creator|platform)\b/i },
];

/** Nama pola pertama yang cocok, atau null bila pesan wajar. */
export function detectPromptHijack(text: string): string | null {
  const value = String(text ?? "");
  if (!value.trim()) return null;
  // Kutipan panjang tanpa spasi (base64 mentah) diperiksa sebagai satu blok tanpa normalisasi apa pun.
  for (const item of HIJACK_PATTERNS) if (item.pattern.test(value)) return item.name;
  return null;
}

export type HijackScan = { blocked: boolean; pattern: string | null; category: HijackCategory | null; snippet: string };

/** Hasil lengkap satu pemeriksaan: dipakai oleh rute dan oleh uji. */
export function scanPromptHijack(text: string): HijackScan {
  const value = String(text ?? "");
  const pattern = detectPromptHijack(value);
  const meta = HIJACK_PATTERNS.find((item) => item.name === pattern) ?? null;
  return {
    blocked: Boolean(pattern),
    pattern,
    category: meta?.category ?? null,
    snippet: value.replace(/\s+/g, " ").trim().slice(0, HIJACK_SNIPPET_CHARS),
  };
}

/** Kalimat penolakan yang dikirim ke pengguna (Bahasa Indonesia, tanpa istilah teknis). */
export function hijackMessage(pattern: string | null): string {
  return `Pesan ini mengandung pola upaya mengubah instruksi dasar agen (${pattern ?? "tidak diketahui"}), jadi tidak dikirim ke model. Mohon tulis ulang permintaan Anda tanpa menyuruh mengabaikan aturan, membocorkan instruksi sistem, atau mengganti peran agen.`;
}

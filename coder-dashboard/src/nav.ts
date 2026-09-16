/** Pages of the workspace shell. Shared by the sidebar, the dashboard cards and the tool panels. */
export type PageKey = 'home' | 'chat' | 'projects' | 'knowledge' | 'workflow' | 'team' | 'artifacts' | 'usage' | 'audit' | 'runs' | 'billing' | 'admin' | 'settings' | 'memory' | 'templates' | 'personas' | 'playground' | 'skills' | 'status' | 'agents' | 'diff' | 'tokenSaver' | 'apiKeys' | 'privacy' | 'adminEmail' | 'adminJobs' | 'adminPricing' | 'apiWebhooks' | 'referrals' | 'growth';

export type NavItem = { key: PageKey; label: string; icon: string; blurb: string };

export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: 'Beranda', icon: '⌂', blurb: 'Ringkasan semua fitur dan angka terbaru' },
  { key: 'chat', label: 'Percakapan', icon: '✦', blurb: 'Chat dengan AI, streaming, hentikan run' },
  { key: 'projects', label: 'Proyek', icon: '▤', blurb: 'Buat dan pilih proyek dalam workspace' },
  { key: 'knowledge', label: 'Pengetahuan', icon: '▦', blurb: 'Unggah dokumen, cari dengan pencarian penuh' },
  { key: 'workflow', label: 'Workflow', icon: '⚙', blurb: 'Susun langkah, jalankan, setujui, jadwalkan' },
  { key: 'team', label: 'Tim', icon: '☺', blurb: 'Undang anggota, atur peran, cabut akses' },
  { key: 'artifacts', label: 'Artefak', icon: '⧉', blurb: 'Simpan dan unduh berkas hasil kerja' },
  { key: 'usage', label: 'Pemakaian', icon: '◪', blurb: 'Token, biaya, dan efisiensi tiap model' },
  { key: 'runs', label: 'Riwayat run', icon: '≡', blurb: 'Semua run AI beserta status dan biayanya' },
  { key: 'audit', label: 'Audit', icon: '⚑', blurb: 'Jejak tindakan penting di workspace' },
  { key: 'billing', label: 'Paket & langganan', icon: '⬡', blurb: 'Paket, kuota token, kredit, pesanan dan bukti transfer' },
  { key: 'admin', label: 'Admin platform', icon: '⌘', blurb: 'Pesanan, kupon, rekening, paket, branding, pengguna' },
  { key: 'settings', label: 'Pengaturan & akun', icon: '⚒', blurb: 'Keamanan, MFA, batas biaya, admin platform' },
  { key: 'playground', label: 'Playground', icon: '✧', blurb: 'Coba satu prompt dengan model, persona, dan tingkat penalaran pilihan' },
  { key: 'memory', label: 'Bank memori', icon: '❖', blurb: 'Catatan yang selalu dikirim ke agen sebagai konteks' },
  { key: 'templates', label: 'Template & slash', icon: '⌗', blurb: 'Prompt siap pakai dan perintah garis miring' },
  { key: 'personas', label: 'Persona agen', icon: '☰', blurb: 'Kepribadian agen: system prompt, gaya, model, penalaran' },
  { key: 'tokenSaver', label: 'Penghemat token', icon: '◈', blurb: 'Tingkat penalaran, allowlist alat, pemadatan otomatis' },
  { key: 'agents', label: 'Peta agen', icon: '⧗', blurb: 'Percakapan, sesi mesin, dan pohon run beserta ukurannya' },
  { key: 'diff', label: 'Pembanding', icon: '⧎', blurb: 'Bandingkan dua artefak dan lihat bedanya baris per baris' },
  { key: 'skills', label: 'Kapabilitas', icon: '❈', blurb: 'Daftar kemampuan platform beserta status nyatanya' },
  { key: 'status', label: 'Status platform', icon: '◉', blurb: 'Kesehatan mesin, basis data, surat, penyimpanan, dan laporan' },
  { key: 'apiKeys', label: 'Kunci API', icon: '⚿', blurb: 'Buat kunci Bearer untuk skrip dan integrasi, atur izin, cabut' },
  { key: 'privacy', label: 'Privasi & data', icon: '⛨', blurb: 'Unduh data akun Anda, atur email notifikasi, lihat kebijakan retensi' },
  { key: 'adminEmail', label: 'Antrean email', icon: '✉', blurb: 'Lihat pesan keluar, kirim ulang, dan jalankan pembersihan retensi' },
  { key: 'adminJobs', label: 'Antrean pekerjaan', icon: '⧖', blurb: 'Pekerjaan latar yang tahan restart: antrean, sewa, percobaan, dan perbaikan otomatis' },
  { key: 'adminPricing', label: 'Harga AI', icon: '$', blurb: 'Harga pokok tiap model dari penyedia, faktor markup, dan jumlah yang ditagihkan' },
  { key: 'apiWebhooks', label: 'Webhook', icon: '⇄', blurb: 'Kirim peristiwa run ke sistem lain dengan tanda tangan HMAC dan percobaan ulang' },
  { key: 'referrals', label: 'Undangan', icon: '❖', blurb: 'Kode undangan Anda, status tiap undangan dan hadiah tokennya' },
  { key: 'growth', label: 'Pertumbuhan', icon: '◈', blurb: 'Corong pendaftaran, aktivitas harian, retensi dan undangan (khusus admin)' },
];

export const TOOL_PAGES: PageKey[] = ['knowledge', 'workflow', 'team', 'artifacts', 'usage', 'audit'];

export type ToolPageKey = 'knowledge' | 'workflow' | 'team' | 'artifacts' | 'usage' | 'audit';

/** Type guard so the tool panels only receive the tabs they understand. */
export function isToolPage(key: PageKey): key is ToolPageKey {
  return (TOOL_PAGES as PageKey[]).includes(key);
}

export function navItem(key: PageKey): NavItem | undefined {
  return NAV_ITEMS.find(item => item.key === key);
}

/** Pages of the workspace shell. Shared by the sidebar, the dashboard cards and the tool panels. */
export type PageKey = 'notion' | 'botChannels' | 'connectors' | 'council' | 'benchmark' | 'runTimeline' | 'accountUsage' | 'accountActivity' | 'adminErrors' | 'schedules' | 'guardrails' | 'knowledgeBase' | 'userSkills' | 'toolsPolicy' | 'home' | 'chat' | 'projects' | 'knowledge' | 'workflow' | 'team' | 'artifacts' | 'usage' | 'audit' | 'runs' | 'billing' | 'admin' | 'settings' | 'memory' | 'templates' | 'personas' | 'playground' | 'skills' | 'status' | 'agents' | 'diff' | 'tokenSaver' | 'apiKeys' | 'privacy' | 'adminEmail' | 'adminJobs' | 'adminPricing' | 'apiWebhooks' | 'referrals' | 'growth' | 'search' | 'devices' | 'metrics' | 'growthBackfill' | 'webhookDeliveries';

export type NavItem = { key: PageKey; label: string; icon: string; blurb: string; adminOnly?: true };

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
  { key: 'admin', adminOnly: true, label: 'Admin platform', icon: '⌘', blurb: 'Pesanan, kupon, rekening, paket, branding, pengguna' },
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
  { key: 'adminEmail', adminOnly: true, label: 'Antrean email', icon: '✉', blurb: 'Lihat pesan keluar, kirim ulang, dan jalankan pembersihan retensi' },
  { key: 'adminJobs', adminOnly: true, label: 'Antrean pekerjaan', icon: '⧖', blurb: 'Pekerjaan latar yang tahan restart: antrean, sewa, percobaan, dan perbaikan otomatis' },
  { key: 'adminPricing', adminOnly: true, label: 'Harga AI', icon: '$', blurb: 'Harga pokok tiap model dari penyedia, faktor markup, dan jumlah yang ditagihkan' },
  { key: 'apiWebhooks', label: 'Webhook', icon: '⇄', blurb: 'Kirim peristiwa run ke sistem lain dengan tanda tangan HMAC dan percobaan ulang' },
  { key: 'referrals', label: 'Undangan', icon: '❖', blurb: 'Kode undangan Anda, status tiap undangan dan hadiah tokennya' },
  { key: 'growth', adminOnly: true, label: 'Pertumbuhan', icon: '◈', blurb: 'Corong pendaftaran, aktivitas harian, retensi dan undangan (khusus admin)' },
  // Wave 10 (butir 21-32D, v0.20.0).
  { key: 'search', label: 'Pencarian', icon: '⌕', blurb: 'Cari di seluruh proyek: percakapan, pesan, artefak, pengetahuan dan workflow' },
  { key: 'devices', label: 'Perangkat', icon: '▣', blurb: 'Peramban yang pernah masuk ke akun Anda, sesi aktif, dan notifikasi peramban' },
  { key: 'metrics', adminOnly: true, label: 'Metrik', icon: '◈', blurb: 'Angka operasional platform dan keluaran /metrics untuk pemantauan (khusus admin)' },
  { key: 'growthBackfill', adminOnly: true, label: 'Pelengkapan data', icon: '⇪', blurb: 'Lengkapi peristiwa pertumbuhan dari tabel asli, dengan pratinjau sebelum dijalankan (khusus admin)' },
  { key: 'webhookDeliveries', label: 'Riwayat webhook', icon: '⇉', blurb: 'Urutan pengiriman webhook, percobaan, dan tombol kirim ulang' },
  // Wave 11A (butir 46, 51, 52, v0.21.0).
  { key: 'guardrails', label: 'Guardrail', icon: '⛨', blurb: 'Aturan kualitas dan larangan milik akun Anda yang selalu disisipkan ke prompt agen' },
  { key: 'knowledgeBase', label: 'Basis pengetahuan', icon: '❐', blurb: 'Isi pengetahuan platform (umum & whitelabel) yang dipakai agen; hanya admin boleh mengubah' },
  { key: 'userSkills', label: 'Skill saya', icon: '✱', blurb: 'Pasang skill sendiri, aktifkan maksimal 8 sekaligus, lihat batas karakter' },
  // Wave 11A (butir 47, v0.21.0).
  { key: 'toolsPolicy', label: 'Kebijakan alat', icon: '⛭', blurb: 'Atur alat yang boleh dipakai agen: daftar pilihan, tanpa alat, atau keadaan bawaan mesin' },
  // Wave 11B (butir 58, 61, 62, 65, 66, 72, v0.22.0).
  { key: 'council', label: 'Dewan juri', icon: '⚖', blurb: 'Minta beberapa model menilai satu jawaban: verdict, skor, dan biaya tiap juri' },
  { key: 'benchmark', label: 'Benchmark model', icon: '◫', blurb: 'Uji sampai tiga model pada soal bawaan server, lengkap dengan perkiraan biaya sebelum jalan' },
  { key: 'runTimeline', label: 'Timeline run', icon: '⟲', blurb: 'Urutan kejadian satu run: kapan mulai, langkah apa saja, dan bagaimana akhirnya' },
  { key: 'schedules', label: 'Jadwal', icon: '⏱', blurb: 'Jalankan perintah yang sama secara berkala dengan cron, zona waktu, dan mode otonom' },
  { key: 'accountUsage', label: 'Pemakaian saya', icon: '∑', blurb: 'Token dan biaya akun Anda sendiri: per hari, per model, dan selisih rekonsiliasi' },
  { key: 'accountActivity', label: 'Aktivitas saya', icon: '≡', blurb: 'Jejak aksi akun Anda sendiri pada rentang hari tertentu' },
  { key: 'adminErrors', adminOnly: true, label: 'Laporan galat', icon: '⚠', blurb: 'Galat server yang tercatat, bisa disaring per jenis dan tanggal, dan diunduh sebagai CSV (khusus admin)' },
  // Wave 11C (butir 68, 69/81, 71, v0.23.0).
  { key: 'notion', label: 'Notion', icon: '❏', blurb: 'Sambungkan token Notion, lihat ruang kerja, dan kirim jawaban agen menjadi halaman baru' },
  { key: 'botChannels', label: 'Kanal bot', icon: '☏', blurb: 'Kanal Telegram/WhatsApp: webhook, token tersegel, dan kode sekali pakai untuk menautkan akun' },
  { key: 'connectors', label: 'Konektor', icon: '⇌', blurb: 'Slack, Discord, dan MCP: status sambungan, uji kirim, dan galat terakhir apa adanya' },
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

/**
 * Halaman yang hanya boleh dilihat admin platform.
 *
 * Daftar ini DITURUNKAN dari `NAV_ITEMS` (tanda `adminOnly`), bukan disalin tangan: dulu daftarnya
 * hidup di `App.tsx` dan sempat tidak lagi cocok dengan halaman yang sebenarnya butuh admin
 * (`adminPricing` hanya dirender untuk admin, tetapi menunya tampil untuk semua orang sehingga
 * pengguna biasa menekan menu yang lalu menampilkan halaman kosong). Satu sumber kebenaran
 * menghapus kelas cacat itu.
 */
export const ADMIN_PAGES: PageKey[] = NAV_ITEMS.filter(item => item.adminOnly).map(item => item.key);

/** Keterangan satu kelompok menu pada bilah samping. */
export type NavGroup = { key: string; label: string; icon: string; blurb: string; keys: PageKey[] };

/** Hasil pengelompokan untuk satu peran. */
export type NavGroupView = { key: string; label: string; icon: string; blurb: string; admin: boolean; items: NavItem[] };

/**
 * Semua menu tetap ada dan tetap bisa dijangkau; yang berubah hanya cara menampilkannya: dikelompokkan
 * supaya bilah samping tidak menjadi satu daftar 49 baris yang harus digulir setiap saat.
 *
 * Urutan kelompok mengikuti alur kerja pengguna: mulai bekerja, menyimpan hasil, mengatur agen,
 * memeriksa biaya, menyambung layanan, lalu mengurus akun. Kelompok terakhir hanya untuk admin.
 *
 * Catatan: "Basis pengetahuan" TIDAK bertanda admin, karena halaman itu sengaja menampilkan versi hanya-baca
 * untuk pengguna biasa (KnowledgeBaseAdmin memakai prop isAdmin). Karena itu kelompok "Admin platform" hanya
 * berisi halaman bertanda admin, sehingga pengguna biasa tidak melihat kelompok itu sama sekali.
 */
export const NAV_GROUPS: NavGroup[] = [
  { key: 'mulai', label: 'Mulai di sini', icon: '⌂', blurb: 'Beranda, percakapan, proyek, dan playground', keys: ['home', 'chat', 'projects', 'playground'] },
  { key: 'pengetahuan', label: 'Pengetahuan & hasil', icon: '▦', blurb: 'Dokumen, artefak, pembanding, memori, template, pencarian', keys: ['knowledge', 'knowledgeBase', 'artifacts', 'diff', 'memory', 'templates', 'search'] },
  { key: 'otomasi', label: 'Agen & otomasi', icon: '⚙', blurb: 'Workflow, persona, peta agen, skill, kebijakan alat, guardrail, jadwal', keys: ['workflow', 'personas', 'agents', 'skills', 'userSkills', 'toolsPolicy', 'tokenSaver', 'guardrails', 'schedules'] },
  { key: 'biaya', label: 'Run, uji & biaya', icon: '◪', blurb: 'Riwayat dan timeline run, pemakaian, paket, benchmark, dewan juri', keys: ['runs', 'runTimeline', 'usage', 'accountUsage', 'billing', 'benchmark', 'council'] },
  { key: 'integrasi', label: 'Integrasi & kanal', icon: '⇌', blurb: 'Konektor, Notion, kanal bot, kunci API, dan webhook', keys: ['connectors', 'notion', 'botChannels', 'apiKeys', 'apiWebhooks', 'webhookDeliveries'] },
  { key: 'akun', label: 'Akun & workspace', icon: '⚒', blurb: 'Pengaturan, tim, privasi, perangkat, undangan, status, audit', keys: ['settings', 'team', 'privacy', 'devices', 'referrals', 'accountActivity', 'status', 'audit'] },
  { key: 'admin', label: 'Admin platform', icon: '⌘', blurb: 'Hanya admin platform: pesanan, pengguna, pekerjaan latar, pertumbuhan, metrik, galat', keys: ['admin', 'adminPricing', 'adminEmail', 'adminJobs', 'growth', 'growthBackfill', 'metrics', 'adminErrors'] },
];

/** Kelompok mana yang memuat sebuah halaman (dipakai untuk membuka kelompok yang benar otomatis). */
export function grupHalaman(key: PageKey): string | undefined {
  return NAV_GROUPS.find(grup => grup.keys.indexOf(key) >= 0)?.key;
}

/**
 * Kelompok yang boleh dilihat satu peran. Halaman bertanda `adminOnly` dibuang untuk pengguna biasa,
 * dan kelompok yang jadi kosong ikut hilang supaya tidak ada judul tanpa isi.
 */
export function navGroupsFor(isAdmin: boolean): NavGroupView[] {
  return NAV_GROUPS.map(grup => {
    const items = grup.keys
      .map(key => navItem(key))
      .filter((item): item is NavItem => Boolean(item))
      .filter(item => isAdmin || !item.adminOnly);
    return { key: grup.key, label: grup.label, icon: grup.icon, blurb: grup.blurb, admin: grup.key === 'admin', items };
  }).filter(grup => grup.items.length > 0);
}

/**
 * Kotak cari menu: mencocokkan label, keterangan, kunci halaman, dan nama kelompoknya, supaya
 * pengguna bisa mengetik "biaya", "slack", atau "audit" dan langsung menemukan menunya walau
 * kelompoknya sedang terlipat.
 */
export function cariNavItem(kueri: string, isAdmin: boolean): { item: NavItem; grup: string }[] {
  const q = String(kueri ?? '').trim().toLowerCase();
  if (!q) return [];
  const hasil: { item: NavItem; grup: string }[] = [];
  for (const grup of navGroupsFor(isAdmin)) {
    for (const item of grup.items) {
      const teks = `${item.label} ${item.blurb} ${item.key} ${grup.label}`.toLowerCase();
      if (teks.includes(q)) hasil.push({ item, grup: grup.label });
    }
  }
  return hasil;
}

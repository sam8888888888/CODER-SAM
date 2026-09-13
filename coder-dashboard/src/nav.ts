/** Pages of the workspace shell. Shared by the sidebar, the dashboard cards and the tool panels. */
export type PageKey = 'home' | 'chat' | 'projects' | 'knowledge' | 'workflow' | 'team' | 'artifacts' | 'usage' | 'audit' | 'runs' | 'settings';

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
  { key: 'settings', label: 'Pengaturan & akun', icon: '⚒', blurb: 'Keamanan, MFA, batas biaya, admin platform' },
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

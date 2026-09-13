/**
 * Halaman "Beranda" (dashboard).
 * Tujuan: semua fitur platform terlihat sekilas (kartu) + angka nyata dari API.
 * Setiap panggilan API dibungkus try/catch per-bagian, jadi satu kegagalan
 * hanya membuat angka itu menjadi "-" dan tidak mematikan halaman.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { NAV_ITEMS, type PageKey } from './nav';

type Props = { workspaceId: string | null; projectId: string | null; onNavigate: (page: PageKey) => void };

/** Angka ringkasan. null = belum tersedia / gagal dimuat. */
type Summary = {
  projects: number | null;
  conversations: number | null;
  workflows: number | null;
  documents: number | null;
  members: number | null;
  artifacts: number | null;
  costUsd: number | null;
};

const EMPTY_SUMMARY: Summary = { projects: null, conversations: null, workflows: null, documents: null, members: null, artifacts: null, costUsd: null };

/** Jumlah baris -> teks; null -> "-". */
function countText(value: number | null): string {
  return typeof value === 'number' ? String(value) : '-';
}

/** Biaya USD -> teks; null -> "-". */
function costText(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

/** Hitung jumlah baris dari pemuat daftar; gagal -> null (tidak melempar). */
async function safeCount(load: (() => Promise<unknown[]>) | null): Promise<number | null> {
  if (!load) return null;
  try {
    const rows = await load();
    return Array.isArray(rows) ? rows.length : null;
  } catch {
    return null;
  }
}

/** Ambil total biaya 30 hari; gagal -> null (tidak melempar). */
async function safeCost(load: (() => Promise<{ totals: { costUsd: number } }>) | null): Promise<number | null> {
  if (!load) return null;
  try {
    const data = await load();
    return typeof data?.totals?.costUsd === 'number' ? data.totals.costUsd : null;
  } catch {
    return null;
  }
}

export function Home({ workspaceId, projectId, onNavigate }: Props) {
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Salinan tanpa null supaya pemeriksaan id aman dipakai di dalam closure.
    const ws = workspaceId ?? '';
    const pid = projectId ?? '';

    setLoading(true);
    setFailed(0);
    void (async () => {
      // Promise.all tetap aman karena setiap bagian punya try/catch sendiri.
      const [projects, conversations, workflows, documents, members, artifacts, costUsd] = await Promise.all([
        safeCount(ws ? () => api.projects(ws) : null),
        safeCount(pid ? () => api.chatSessions(pid) : null),
        safeCount(pid ? () => api.workflows(pid) : null),
        safeCount(pid ? () => api.knowledge(pid) : null),
        safeCount(ws ? () => api.members(ws) : null),
        safeCount(pid ? () => api.artifacts(pid) : null),
        safeCost(pid ? () => api.usage(pid, 30) : null),
      ]);
      if (cancelled) return; // komponen sudah dilepas, jangan set state
      const next: Summary = { projects, conversations, workflows, documents, members, artifacts, costUsd };
      setSummary(next);
      setFailed(Object.values(next).filter(value => value === null).length);
      setLoading(false);
    })().catch(() => {
      // Jaring pengaman terakhir: halaman tetap tampil walau ada error tak terduga.
      if (!cancelled) { setSummary(EMPTY_SUMMARY); setFailed(7); setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [workspaceId, projectId, reload]);

  const stats: { label: string; value: string }[] = [
    { label: 'Proyek', value: countText(summary.projects) },
    { label: 'Percakapan', value: countText(summary.conversations) },
    { label: 'Workflow', value: countText(summary.workflows) },
    { label: 'Dokumen pengetahuan', value: countText(summary.documents) },
    { label: 'Anggota tim', value: countText(summary.members) },
    { label: 'Artefak', value: countText(summary.artifacts) },
    { label: 'Biaya 30 hari (USD)', value: costText(summary.costUsd) },
  ];

  // Semua angka kosong atau gagal -> tampilkan pesan ramah, bukan spinner tanpa akhir.
  const noData = !loading && Object.values(summary).every(value => value === null || value === 0);

  return (
    <section className="tool-body" style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 40px' }}>
      <div>
        <span className="eyebrow">Beranda</span>
        <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 'clamp(24px,4vw,34px)', margin: '14px 0 6px' }}>
          Selamat datang di coblai
        </h1>
        <p className="settings-hint" style={{ margin: 0 }}>
          Berikut ringkasan angka terbaru dan semua fitur yang bisa Anda pakai.
        </p>
      </div>

      {/* 1. Baris statistik dari API */}
      <div>
        <div className="section-label" style={{ padding: '4px 0' }}>Ringkasan <span>{loading ? 'memuat…' : '30 hari terakhir'}</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
          {stats.map(stat => (
            <div className="stat" key={stat.label}>
              <b>{stat.value}</b>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{stat.label}</span>
            </div>
          ))}
        </div>
        {failed > 0 && !loading && (
          <p className="settings-hint" style={{ margin: '8px 0 0' }}>
            Tanda "-" berarti data bagian itu belum tersedia atau gagal dimuat. Ini tidak memblokir fitur lain.
          </p>
        )}
        <button type="button" className="link-button" style={{ marginTop: 8 }} onClick={() => setReload(value => value + 1)}>
          Muat ulang angka
        </button>
      </div>

      {/* 3. Catatan bila proyek belum dipilih */}
      {!projectId && (
        <div className="tool-row" style={{ background: '#111a2e', border: '1px solid #24304d', borderRadius: 12, padding: '12px 14px' }}>
          <span style={{ flex: 1, minWidth: 180, fontSize: 12, color: '#94a3b8' }}>
            Pilih atau buat proyek dulu supaya data proyek muncul.
          </span>
          <button type="button" className="primary" onClick={() => onNavigate('projects')}>Buka Proyek</button>
        </div>
      )}

      {/* 4. Pesan ramah bila belum ada data */}
      {noData && (
        <div className="empty-side">
          Belum ada data untuk ditampilkan. Mulai dari membuat proyek, lalu unggah dokumen atau kirim percakapan pertama Anda.
        </div>
      )}

      {/* 2. Grid kartu fitur: satu kartu per menu, klik untuk pindah halaman */}
      <div>
        <div className="section-label" style={{ padding: '4px 0' }}>Semua fitur <span>{NAV_ITEMS.length - 1} fitur</span></div>
        <div
          className="tool-list"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(215px,1fr))', gap: 8, maxHeight: 'none', overflow: 'visible' }}
        >
          {NAV_ITEMS.filter(item => item.key !== 'home').map(item => (
            <div
              key={item.key}
              role="button"
              tabIndex={0}
              onClick={() => onNavigate(item.key)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onNavigate(item.key); }
              }}
              style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, cursor: 'pointer' }}
            >
              <span style={{ fontSize: 16 }} aria-hidden="true">{item.icon}</span>
              <b>{item.label}</b>
              <span style={{ fontSize: 11, color: '#64748b' }}>{item.blurb}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

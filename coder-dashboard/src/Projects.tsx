import { useEffect, useState } from 'react';
import { api, type Project } from './api';

type Props = {
  workspaceId: string | null;
  projectId: string | null;
  onSelect: (projectId: string) => void;
  /** Dipanggil setelah proyek baru dibuat, supaya proyek itu langsung aktif di seluruh aplikasi. */
  onCreated?: (projectId: string) => void;
  /** Dipanggil setelah proyek dihapus, supaya aplikasi memilih proyek lain. */
  onDeleted?: (projectId: string) => void;
};

/** Ubah error apa pun menjadi pesan teks; pesan server dipakai apa adanya. */
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Halaman "Proyek": pilih proyek aktif, buat proyek baru, dan ganti nama proyek aktif.
 * Semua panggilan API dibungkus try/catch dan pesan galat server ditampilkan apa adanya.
 */
export function Projects({ workspaceId, projectId, onSelect, onCreated, onDeleted }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rename, setRename] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deleteName, setDeleteName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const active = projects.find((item) => item.id === projectId) ?? null;

  /** Muat ulang daftar proyek workspace. Galat server ditampilkan apa adanya. */
  async function loadProjects() {
    if (!workspaceId) { setProjects([]); return; }
    try {
      const data = await api.projects(workspaceId);
      setProjects(data ?? []);
    } catch (err) {
      setError(errorText(err));
    }
  }

  // Muat daftar proyek setiap kali workspace berubah.
  useEffect(() => {
    setError('');
    setNotice('');
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Isi kolom ganti nama dengan nama proyek aktif saat ini.
  useEffect(() => {
    setRename(active ? active.name : '');
  }, [active?.id, active?.name]);

  /** Buat proyek baru, lalu langsung jadikan proyek aktif. */
  async function createProject() {
    if (!workspaceId) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const created = await api.createProject(workspaceId, trimmed, description.trim() || undefined);
      setName('');
      setDescription('');
      await loadProjects();
      onCreated?.(created.id);
      onSelect(created.id);
      setNotice(`Proyek "${created.name}" sudah dibuat dan kini menjadi proyek aktif Anda.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Ganti nama proyek yang sedang aktif. */
  async function renameProject() {
    if (!projectId) return;
    const trimmed = rename.trim();
    if (!trimmed) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.updateProject(projectId, { name: trimmed });
      await loadProjects();
      setNotice(`Nama proyek berhasil diubah menjadi "${result.project.name}".`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Hapus proyek aktif beserta seluruh isinya setelah nama diketik ulang. */
  async function deleteProject() {
    if (!active) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api.deleteProject(active.id);
      setDeleteName('');
      await loadProjects();
      setNotice(`Proyek "${active.name}" sudah dihapus.`);
      onDeleted?.(active.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setDeleting(false);
    }
  }

  // Tanpa workspace tidak ada proyek yang bisa ditampilkan.
  if (!workspaceId) {
    return <div className="empty-side">Belum ada workspace</div>;
  }

  return (
    <section className="tool-card" style={{ margin: '24px auto' }}>
      <span className="section-label">DAFTAR PROYEK <span>{projects.length}</span></span>
      <div className="tool-list">
        {projects.map((project) => {
          const isActive = project.id === projectId;
          return (
            <div
              key={project.id}
              className={isActive ? 'selected' : ''}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(project.id)}
            >
              <b>{project.name}</b>
              <small>{project.slug}{isActive ? ' · sedang dipakai' : ''}</small>
              {isActive
                ? <span className="badge">Aktif</span>
                : (
                  <button
                    type="button"
                    className="link-button"
                    onClick={(event) => { event.stopPropagation(); onSelect(project.id); }}
                  >
                    Pilih
                  </button>
                )}
            </div>
          );
        })}
        {!projects.length && <small>Belum ada proyek di workspace ini. Buat proyek baru di bawah.</small>}
      </div>

      <span className="section-label">BUAT PROYEK BARU</span>
      <div className="tool-row wrap">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nama proyek (wajib diisi)"
        />
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Deskripsi (opsional)"
        />
        <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void createProject()}>
          Buat proyek
        </button>
      </div>

      <span className="section-label">GANTI NAMA PROYEK AKTIF</span>
      {active ? (
        <div className="tool-row wrap">
          <input
            value={rename}
            onChange={(event) => setRename(event.target.value)}
            placeholder="Nama proyek baru"
          />
          <button
            type="button"
            className="primary"
            disabled={busy || !rename.trim() || rename.trim() === active.name}
            onClick={() => void renameProject()}
          >
            Simpan nama
          </button>
        </div>
      ) : (
        <p className="empty-side">Pilih satu proyek dulu untuk mengganti namanya.</p>
      )}

      {active && (
        <section className="settings-card danger-zone">
          <span className="section-label">HAPUS PROYEK AKTIF</span>
          <p className="settings-hint">Menghapus proyek juga menghapus percakapan, run, artefak, knowledge, dan workflow di dalamnya. Tindakan ini tidak bisa dibatalkan.</p>
          <label>Ketik nama proyek untuk konfirmasi<input value={deleteName} onChange={(event) => setDeleteName(event.target.value)} placeholder={active.name} /></label>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || deleteName.trim() !== active.name}
            onClick={() => { setDeleting(true); void deleteProject(); }}
          >
            {deleting ? 'Menghapus…' : 'Hapus proyek'}
          </button>
        </section>
      )}

      {busy && <p className="notice">Memproses…</p>}
      {notice && <p className="notice" onClick={() => setNotice('')}>{notice}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

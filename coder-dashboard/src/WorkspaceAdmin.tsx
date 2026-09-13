import { useEffect, useState } from 'react';
import { api } from './api';

type Props = {
  isAdmin: boolean;
  activeWorkspaceId?: string;
  onSelect?: (workspaceId: string) => void;
  onCreated?: (workspaceId: string) => void;
};

/** Satu baris daftar workspace admin; angka biaya memakai satuan micros (1 USD = 1e6 micros). */
type AdminWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  members: number;
  projects: number;
  costMicros: number;
  costTodayMicros: number;
  dailyCostLimitMicros: number | null;
  monthlyCostLimitMicros: number | null;
};

const NAME_MIN = 2;
const NAME_MAX = 60;

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Terjemahkan kode galat pembuatan workspace ke pesan Indonesia. */
function createErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('WORKSPACE_NAME_REQUIRED') || code.includes('INVALID_NAME')) {
    return `Nama workspace tidak valid (${NAME_MIN}-${NAME_MAX} karakter).`;
  }
  return 'Gagal membuat workspace. Coba lagi.';
}

/** Ubah micros ke teks USD dengan 6 angka di belakang koma. */
function usd(micros: number | null): string {
  const value = typeof micros === 'number' && Number.isFinite(micros) ? micros / 1e6 : 0;
  return `$${value.toFixed(6)}`;
}

/** Tampilkan batas harian: null berarti ikut default platform, 0 berarti tanpa batas. */
function dailyLimitText(micros: number | null): string {
  if (micros === null || micros === undefined) return 'default';
  if (micros === 0) return 'tanpa batas';
  return usd(micros);
}

/** Paksa nilai apa pun menjadi angka aman supaya tabel tidak menampilkan NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Panel admin workspace: form "Buat workspace baru" untuk semua pengguna,
 * plus tabel semua workspace platform bila pengguna adalah admin platform.
 * Daftar admin hanya dimuat saat isAdmin=true, dan selalu dimuat ulang setelah aksi.
 */
export function WorkspaceAdmin({ isAdmin, activeWorkspaceId, onSelect, onCreated }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState('');
  const [formError, setFormError] = useState('');

  const [rows, setRows] = useState<AdminWorkspaceRow[]>([]);
  const [listError, setListError] = useState('');
  const [listBusy, setListBusy] = useState(false);

  /** Muat daftar seluruh workspace platform. Hanya dipanggil untuk admin. */
  async function loadWorkspaces() {
    setListBusy(true);
    setListError('');
    try {
      const data = await api.adminWorkspaces();
      const mapped: AdminWorkspaceRow[] = (data ?? []).map((item) => {
        const row = item as AdminWorkspaceRow;
        return {
          id: String(row?.id ?? ''),
          name: String(row?.name ?? ''),
          slug: String(row?.slug ?? ''),
          members: num(row?.members),
          projects: num(row?.projects),
          costMicros: num(row?.costMicros),
          costTodayMicros: num(row?.costTodayMicros),
          dailyCostLimitMicros: row?.dailyCostLimitMicros === null || row?.dailyCostLimitMicros === undefined ? null : num(row.dailyCostLimitMicros),
          monthlyCostLimitMicros: row?.monthlyCostLimitMicros === null || row?.monthlyCostLimitMicros === undefined ? null : num(row.monthlyCostLimitMicros),
        };
      });
      setRows(mapped);
    } catch {
      // Jangan tampilkan data palsu: kosongkan daftar dan tampilkan pesan galat.
      setRows([]);
      setListError('Gagal memuat daftar workspace.');
    } finally {
      setListBusy(false);
    }
  }

  // Pengguna biasa tidak boleh memanggil endpoint admin sama sekali.
  useEffect(() => {
    if (!isAdmin) {
      setRows([]);
      setListError('');
      return;
    }
    void loadWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  /** Buat workspace baru, lalu bersihkan form dan segarkan tabel admin bila perlu. */
  async function createWorkspace() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setOk('');
    setFormError('');
    try {
      const created = await api.createWorkspace(trimmed);
      setName('');
      setOk(`Workspace "${created.name}" sudah dibuat.`);
      onCreated?.(created.id);
      if (isAdmin) await loadWorkspaces();
    } catch (error) {
      setFormError(createErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card">
      <h3 className="settings-heading">Workspace</h3>
      <span className="section-label">BUAT WORKSPACE BARU</span>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void createWorkspace();
        }}
      >
        <label htmlFor="workspace-admin-name">Nama workspace</label>
        <div className="tool-row wrap">
          <input
            id="workspace-admin-name"
            name="name"
            type="text"
            value={name}
            minLength={NAME_MIN}
            maxLength={NAME_MAX}
            required
            aria-label="Nama workspace baru"
            aria-describedby="workspace-admin-name-hint"
            placeholder={`Nama workspace (${NAME_MIN}-${NAME_MAX} karakter)`}
            onChange={(event) => setName(event.target.value)}
          />
          <button className="primary" type="submit" disabled={busy || name.trim().length < NAME_MIN}>
            {busy ? 'Membuat…' : 'Buat'}
          </button>
        </div>
      </form>
      <p className="settings-hint" id="workspace-admin-name-hint">
        Nama {NAME_MIN}-{NAME_MAX} karakter. Nama ini dipakai untuk memanggil workspace Anda.
      </p>
      {ok && <p className="settings-ok">{ok}</p>}
      {formError && <p className="error">{formError}</p>}

      {isAdmin && (
        <>
          <h3 className="settings-heading">Semua workspace platform</h3>
          {listBusy && <p className="settings-hint">Memuat daftar workspace…</p>}
          {listError && <p className="error">{listError}</p>}
          {!listBusy && !listError && rows.length === 0 && <p className="settings-hint">Belum ada workspace.</p>}
          {!listError && rows.length > 0 && (
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Nama</th>
                  <th scope="col">Slug</th>
                  <th scope="col">Anggota</th>
                  <th scope="col">Proyek</th>
                  <th scope="col">Biaya hari ini</th>
                  <th scope="col">Biaya total</th>
                  <th scope="col">Batas harian</th>
                  <th scope="col">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isActive = row.id === activeWorkspaceId;
                  return (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{row.slug}</td>
                      <td>{row.members}</td>
                      <td>{row.projects}</td>
                      <td>{usd(row.costTodayMicros)}</td>
                      <td>{usd(row.costMicros)}</td>
                      <td>{dailyLimitText(row.dailyCostLimitMicros)}</td>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          disabled={isActive}
                          aria-label={isActive ? `Workspace ${row.name} sedang aktif` : `Buka workspace ${row.name}`}
                          onClick={() => onSelect?.(row.id)}
                        >
                          {isActive ? 'Aktif' : 'Buka'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

export default WorkspaceAdmin;

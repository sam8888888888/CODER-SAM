import { useEffect, useState } from 'react';
import { api } from './api';
import type { AdminUserRow, Plan } from './api';

/** Properti halaman "Pengguna (Admin)": status admin dan pelapor galat dari induk. */
type Props = {
  isAdmin: boolean;
  onError?: (message: string) => void;
};

const NO_ACCESS_MESSAGE = 'Hanya admin platform yang dapat membuka halaman ini.';
const PASSWORD_HINT =
  'Sampaikan kata sandi awal ini kepada pengguna secara pribadi; minta pengguna menggantinya setelah masuk.';
const PASSWORD_MIN = 8;
const NAME_MIN = 2;
const NAME_MAX = 80;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Kelas Tailwind dasar untuk tombol kecil di tabel dan panel edit. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';

/** Ubah nilai apa pun menjadi angka aman supaya tabel tidak menampilkan NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Terjemahkan kode galat admin ke pesan bahasa Indonesia yang jelas. */
function adminErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('EMAIL_TAKEN')) return 'Email itu sudah dipakai.';
  if (code.includes('INVALID_PASSWORD')) return `Kata sandi minimal ${PASSWORD_MIN} karakter.`;
  if (code.includes('INVALID_EMAIL')) return 'Format email tidak valid.';
  if (code.includes('LAST_ADMIN')) return 'Admin terakhir tidak boleh diturunkan menjadi pengguna biasa.';
  if (code.includes('USER_NOT_FOUND')) return 'Pengguna tidak ditemukan.';
  if (code.includes('ADMIN_REQUIRED')) return 'Hanya admin platform yang boleh melakukan ini.';
  if (code.includes('INVALID_DISPLAY_NAME')) return `Nama tampilan harus ${NAME_MIN}-${NAME_MAX} karakter.`;
  return 'Aksi gagal diproses. Periksa data yang diisi, lalu coba lagi.';
}

/** Format tanggal pendaftaran; dukung teks SQLite berbentuk "YYYY-MM-DD HH:MM:SS". */
function formatDate(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Format uang rupiah tanpa desimal. */
function rupiah(value: unknown): string {
  return 'Rp' + num(value).toLocaleString('id-ID');
}

/** Susun daftar pilihan tier dari kode paket; tier ganda diambil satu kali. */
function tierOptions(plans: Plan[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const plan of plans ?? []) {
    const value = String(plan?.tier || plan?.code || '').trim();
    if (!value || seen.has(value)) continue;
    const name = String(plan?.name || plan?.code || value);
    seen.set(value, `${name} · ${rupiah(plan?.priceIdr)}`);
  }
  return Array.from(seen, ([value, label]) => ({ value, label }));
}

/** Teks ringkas status akun pada tabel pengguna. */
function yesNo(value: unknown): string {
  return value ? 'Ya' : 'Tidak';
}

/**
 * Halaman "Pengguna (Admin)": form tambah pengguna, pencarian, dan tabel pengguna
 * dengan panel edit (nama, tier, admin, verifikasi email, reset kuota, kredit token).
 * Semua endpoint admin hanya dipanggil bila isAdmin=true.
 */
export function AdminUsers({ isAdmin, onError }: Props) {
  // Daftar pengguna + daftar paket untuk pilihan tier.
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');

  // Form "Tambah pengguna".
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [tier, setTier] = useState('');
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);

  // Pesan sukses kecil setelah aksi berhasil.
  const [notice, setNotice] = useState('');

  // Panel edit baris terpilih.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  /** Kata sandi hasil setel admin; ditampilkan sekali supaya bisa diserahkan ke pengguna. */
  const [issuedPassword, setIssuedPassword] = useState('');
  const [editTier, setEditTier] = useState('');
  const [editIsAdmin, setEditIsAdmin] = useState(false);
  const [editVerified, setEditVerified] = useState(false);
  const [editError, setEditError] = useState('');
  const [editBusy, setEditBusy] = useState('');
  const [creditTokens, setCreditTokens] = useState('');
  const [creditNote, setCreditNote] = useState('');

  /** Catat galat ke halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function fail(message: string): void {
    onError?.(message);
  }

  /** Muat ulang daftar pengguna dari server. */
  async function loadUsers(): Promise<void> {
    setLoading(true);
    setListError('');
    try {
      const data = await api.adminUserList();
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (error) {
      // Jangan tampilkan data palsu: kosongkan daftar, lalu beri pesan galat.
      setUsers([]);
      const message = adminErrorMessage(error);
      setListError(message);
      fail(message);
    } finally {
      setLoading(false);
    }
  }

  /** Muat kode paket untuk mengisi pilihan tier. */
  async function loadPlans(): Promise<void> {
    try {
      const data = await api.adminPlans();
      const list = Array.isArray(data?.plans) ? data.plans : [];
      setPlans(list);
      const options = tierOptions(list);
      // Pilih tier pertama sebagai bawaan bila pengguna belum memilih apa pun.
      setTier((current) => current || options[0]?.value || '');
    } catch {
      // Tanpa daftar paket, form tetap jalan dan memakai tier bawaan server.
      setPlans([]);
    }
  }

  // Pengguna biasa tidak boleh memanggil endpoint admin sama sekali.
  useEffect(() => {
    if (!isAdmin) {
      setUsers([]);
      setPlans([]);
      setListError('');
      setEditingId(null);
      return;
    }
    void loadUsers();
    void loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  /** Bersihkan isi panel edit dan tutup panelnya. */
  function closeEdit(): void {
    setEditingId(null);
    setEditName('');
    setEditEmail('');
    setEditPassword('');
    setEditTier('');
    setEditIsAdmin(false);
    setEditVerified(false);
    setEditError('');
    setCreditTokens('');
    setCreditNote('');
  }

  /** Buka panel edit untuk satu baris pengguna dan isi nilainya. */
  function openEdit(row: AdminUserRow): void {
    setEditingId(row.id);
    setEditName(String(row?.displayName ?? ''));
    setEditEmail(String(row?.email ?? ''));
    setEditPassword('');
    setIssuedPassword('');
    setEditTier(String(row?.tier ?? ''));
    setEditIsAdmin(Boolean(row?.isAdmin));
    setEditVerified(Boolean(row?.emailVerified));
    setEditError('');
    setEditBusy('');
    setCreditTokens('');
    setCreditNote('');
    setNotice('');
  }

  /** Buat pengguna baru, lalu muat ulang daftar dan bersihkan form. */
  async function createUser(): Promise<void> {
    if (!isAdmin) return;
    setFormError('');
    setNotice('');
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = displayName.trim();
    if (!EMAIL_PATTERN.test(cleanEmail)) {
      setFormError('Format email tidak valid.');
      return;
    }
    if (cleanName.length < NAME_MIN || cleanName.length > NAME_MAX) {
      setFormError(`Nama tampilan harus ${NAME_MIN}-${NAME_MAX} karakter.`);
      return;
    }
    if (password.length < PASSWORD_MIN) {
      setFormError(`Kata sandi minimal ${PASSWORD_MIN} karakter.`);
      return;
    }
    setCreating(true);
    try {
      const created = await api.adminCreateUser({
        email: cleanEmail,
        displayName: cleanName,
        password,
        tier: tier || undefined,
      });
      setEmail('');
      setDisplayName('');
      setPassword('');
      setShowPassword(false);
      setNotice(`Pengguna ${String(created?.user?.email ?? cleanEmail)} sudah dibuat.`);
      await loadUsers();
    } catch (error) {
      const message = adminErrorMessage(error);
      setFormError(message);
      fail(message);
    } finally {
      setCreating(false);
    }
  }

  /** Simpan perubahan nama, tier, status admin, dan verifikasi email satu pengguna. */
  async function saveEdit(userId: string): Promise<void> {
    if (!isAdmin || !userId) return;
    setEditError('');
    setNotice('');
    const cleanName = editName.trim();
    if (cleanName.length < NAME_MIN || cleanName.length > NAME_MAX) {
      setEditError(`Nama tampilan harus ${NAME_MIN}-${NAME_MAX} karakter.`);
      return;
    }
    const cleanEmail = editEmail.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(cleanEmail)) {
      setEditError('Format email tidak valid.');
      return;
    }
    setEditBusy('simpan');
    try {
      await api.adminUpdateUser(userId, {
        displayName: cleanName,
        email: cleanEmail,
        tier: editTier || undefined,
        isAdmin: editIsAdmin,
        emailVerified: editVerified,
      });
      closeEdit();
      setNotice('Perubahan data pengguna sudah disimpan.');
      await loadUsers();
    } catch (error) {
      const message = adminErrorMessage(error);
      setEditError(message);
      fail(message);
    } finally {
      setEditBusy('');
    }
  }

  /** Reset kuota pemakaian token pengguna ke nol. */
  async function resetQuota(userId: string): Promise<void> {
    if (!isAdmin || !userId) return;
    setEditError('');
    setNotice('');
    setEditBusy('kuota');
    try {
      const result = await api.adminResetQuota(userId);
      const quota = result?.quota;
      const detail = quota
        ? ` Pemakaian hari ini ${num(quota.usedToday).toLocaleString('id-ID')} token, bulan ini ${num(
            quota.usedMonth,
          ).toLocaleString('id-ID')} token.`
        : '';
      closeEdit();
      setNotice(`Kuota pengguna sudah direset.${detail}`);
      await loadUsers();
    } catch (error) {
      const message = adminErrorMessage(error);
      setEditError(message);
      fail(message);
    } finally {
      setEditBusy('');
    }
  }

  /**
   * Wave 8: setel kata sandi pengguna. Bila kolom kata sandi dibiarkan kosong, server membuat
   * kata sandi pendek yang mudah dibaca; hasilnya ditampilkan sekali di panel ini.
   */
  async function setUserPassword(userId: string): Promise<void> {
    if (!isAdmin || !userId) return;
    setEditError('');
    setNotice('');
    setIssuedPassword('');
    const asked = editPassword.trim();
    if (asked && asked.length < PASSWORD_MIN) {
      setEditError(`Kata sandi minimal ${PASSWORD_MIN} karakter.`);
      return;
    }
    setEditBusy('sandi');
    try {
      const result = await api.adminSetUserPassword(userId, asked || undefined);
      setEditPassword('');
      setIssuedPassword(String(result?.password ?? ''));
      setNotice(
        result?.generated
          ? `Kata sandi baru untuk ${String(result?.email ?? '')} sudah dibuat. Salin dan sampaikan sekarang; kata sandi tidak bisa dilihat lagi setelah panel ditutup.`
          : `Kata sandi ${String(result?.email ?? '')} sudah diganti. Semua sesi lama pengguna itu sudah diputus.`,
      );
      await loadUsers();
    } catch (error) {
      const message = adminErrorMessage(error);
      setEditError(message);
      fail(message);
    } finally {
      setEditBusy('');
    }
  }

  /** Wave 8: batalkan penutupan akun selama masa pemulihan 90 hari belum lewat. */
  async function restoreUser(userId: string): Promise<void> {
    if (!isAdmin || !userId) return;
    setEditError('');
    setNotice('');
    setEditBusy('pulihkan');
    try {
      const result = await api.adminRestoreUser(userId);
      closeEdit();
      setNotice(`Akun ${String(result?.email ?? '')} sudah dipulihkan dan bisa masuk lagi.`);
      await loadUsers();
    } catch (error) {
      const message = adminErrorMessage(error);
      setEditError(message);
      fail(message);
    } finally {
      setEditBusy('');
    }
  }

  /** Tambah kredit token pengguna; jumlah harus bilangan bulat lebih dari 0. */
  async function grantCredit(userId: string): Promise<void> {
    if (!isAdmin || !userId) return;
    setEditError('');
    setNotice('');
    const raw = creditTokens.trim();
    const tokens = Number(raw);
    if (!raw || !Number.isInteger(tokens) || tokens <= 0) {
      setEditError('Jumlah token harus bilangan bulat lebih dari 0.');
      return;
    }
    setEditBusy('kredit');
    try {
      const result = await api.adminGrantCredit(userId, tokens, creditNote.trim() || undefined);
      const saldo = num(result?.creditTokens).toLocaleString('id-ID');
      closeEdit();
      setNotice(`Kredit token sudah ditambahkan. Saldo kredit pengguna sekarang ${saldo} token.`);
      await loadUsers();
    } catch (error) {
      const message = adminErrorMessage(error);
      setEditError(message);
      fail(message);
    } finally {
      setEditBusy('');
    }
  }

  // Pencarian sederhana: saring berdasarkan email atau nama tampilan.
  const term = query.trim().toLowerCase();
  const filtered = term
    ? users.filter((row) => {
        const haystack = `${String(row?.email ?? '')} ${String(row?.displayName ?? '')}`.toLowerCase();
        return haystack.includes(term);
      })
    : users;
  const options = tierOptions(plans);
  const editingRow = editingId ? users.find((row) => row.id === editingId) : undefined;
  const editingClosed = Boolean(editingRow?.deletedAt);

  // Tanpa hak admin: cukup tampilkan kartu informasi, tanpa panggilan API admin.
  if (!isAdmin) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
        <h2 className="mb-2 text-base font-semibold text-slate-100">Pengguna (Admin)</h2>
        <p>{NO_ACCESS_MESSAGE}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <h2 className="mb-3 text-base font-semibold text-slate-100">Pengguna (Admin)</h2>
      {notice ? <p className="mb-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100">{notice}</p> : null}

      <h3 className="mb-2 text-sm font-semibold text-slate-100">Tambah pengguna</h3>
      <div className="mb-2 grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-slate-300">
          Email
          <input
            className={FIELD}
            type="email"
            value={email}
            autoComplete="off"
            placeholder="nama@contoh.com"
            aria-label="Email pengguna baru"
            onChange={(event) => {
              setEmail(event.target.value);
              setFormError('');
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-slate-300">
          Nama tampilan
          <input
            className={FIELD}
            type="text"
            value={displayName}
            maxLength={NAME_MAX}
            placeholder={`Nama ${NAME_MIN}-${NAME_MAX} karakter`}
            aria-label="Nama tampilan pengguna baru"
            onChange={(event) => {
              setDisplayName(event.target.value);
              setFormError('');
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-slate-300">
          Kata sandi awal
          <span className="flex gap-2">
            <input
              className={FIELD}
              type={showPassword ? 'text' : 'password'}
              value={password}
              autoComplete="new-password"
              placeholder={`Minimal ${PASSWORD_MIN} karakter`}
              aria-label="Kata sandi awal pengguna baru"
              onChange={(event) => {
                setPassword(event.target.value);
                setFormError('');
              }}
            />
            <button type="button" className={BTN} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? 'Sembunyikan' : 'Tampilkan'}
            </button>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-slate-300">
          Tier
          <select
            className={FIELD}
            value={tier}
            aria-label="Tier pengguna baru"
            onChange={(event) => setTier(event.target.value)}
          >
            {options.length === 0 ? <option value="">Tier bawaan</option> : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="button" className={BTN} disabled={creating} onClick={() => { void createUser(); }}>
        {creating ? 'Membuat…' : 'Buat pengguna'}
      </button>
      <p className="mt-2 text-slate-400">{PASSWORD_HINT}</p>
      {formError ? <p className="mt-2 text-slate-100">{formError}</p> : null}

      <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">Daftar pengguna</h3>
      <label className="mb-2 flex flex-col gap-1 text-slate-300">
        Cari pengguna
        <input
          className={FIELD}
          type="search"
          value={query}
          placeholder="Cari email atau nama"
          aria-label="Cari pengguna berdasarkan email atau nama"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {loading ? <p className="text-slate-400">Memuat daftar pengguna…</p> : null}
      {listError ? <p className="text-slate-100">{listError}</p> : null}
      {!loading && !listError && users.length === 0 ? <p className="text-slate-400">Belum ada pengguna.</p> : null}
      {!loading && users.length > 0 && filtered.length === 0 ? (
        <p className="text-slate-400">Tidak ada pengguna yang cocok dengan pencarian Anda.</p>
      ) : null}

      {filtered.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Email</th>
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Nama</th>
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Tier</th>
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Admin</th>
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Email terverifikasi</th>
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Workspace</th>
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Terdaftar</th>
                <th scope="col" className="border-b border-slate-700 px-2 py-2">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <TableRow
                  key={row.id}
                  row={row}
                  editing={editingId === row.id}
                  onEdit={() => openEdit(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {editingId ? (
        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <h3 className="mb-2 text-sm font-semibold text-slate-100">Ubah pengguna</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-slate-300">
              Nama tampilan
              <input
                className={FIELD}
                type="text"
                value={editName}
                maxLength={NAME_MAX}
                aria-label="Nama tampilan pengguna"
                onChange={(event) => {
                  setEditName(event.target.value);
                  setEditError('');
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Email
              <input
                className={FIELD}
                type="email"
                value={editEmail}
                aria-label="Email pengguna"
                onChange={(event) => {
                  setEditEmail(event.target.value);
                  setEditError('');
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Kata sandi baru (opsional)
              <input
                className={FIELD}
                type="password"
                value={editPassword}
                autoComplete="new-password"
                placeholder="Kosongkan agar dibuat otomatis"
                aria-label="Kata sandi baru untuk pengguna"
                onChange={(event) => {
                  setEditPassword(event.target.value);
                  setEditError('');
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Tier
              <select
                className={FIELD}
                value={editTier}
                aria-label="Tier pengguna"
                onChange={(event) => setEditTier(event.target.value)}
              >
                {editTier && !options.some((option) => option.value === editTier) ? (
                  <option value={editTier}>{editTier}</option>
                ) : null}
                {options.length === 0 ? <option value="">Tier bawaan</option> : null}
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-slate-300">
              <input
                type="checkbox"
                checked={editIsAdmin}
                onChange={(event) => {
                  setEditIsAdmin(event.target.checked);
                  setEditError('');
                }}
              />
              Admin platform
            </label>
            <label className="flex items-center gap-2 text-slate-300">
              <input
                type="checkbox"
                checked={editVerified}
                onChange={(event) => {
                  setEditVerified(event.target.checked);
                  setEditError('');
                }}
              />
              Email terverifikasi
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Jumlah token
              <input
                className={FIELD}
                type="number"
                min={1}
                step={1}
                value={creditTokens}
                aria-label="Jumlah token kredit"
                onChange={(event) => {
                  setCreditTokens(event.target.value);
                  setEditError('');
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Catatan kredit
              <input
                className={FIELD}
                type="text"
                value={creditNote}
                maxLength={200}
                placeholder="Contoh: bonus kompensasi gangguan layanan"
                aria-label="Catatan pemberian kredit token"
                onChange={(event) => {
                  setCreditNote(event.target.value);
                  setEditError('');
                }}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={() => { void saveEdit(editingId); }}>
              {editBusy === 'simpan' ? 'Menyimpan…' : 'Simpan'}
            </button>
            <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={() => { void setUserPassword(editingId); }}>
              {editBusy === 'sandi' ? 'Menyetel…' : 'Setel kata sandi'}
            </button>
            {editingClosed ? (
              <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={() => { void restoreUser(editingId); }}>
                {editBusy === 'pulihkan' ? 'Memulihkan…' : 'Pulihkan akun'}
              </button>
            ) : null}
            <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={() => { void resetQuota(editingId); }}>
              {editBusy === 'kuota' ? 'Mereset…' : 'Reset kuota'}
            </button>
            <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={() => { void grantCredit(editingId); }}>
              {editBusy === 'kredit' ? 'Menambah…' : 'Tambah kredit token'}
            </button>
            <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={closeEdit}>
              Batal
            </button>
          </div>
          {editingClosed ? (
            <p className="mt-2 text-slate-100">
              Akun ini sedang ditutup. Data dihapus permanen setelah {formatDate(editingRow?.purgeAfter)}. Pulihkan akun sebelum tanggal itu.
            </p>
          ) : null}
          {issuedPassword ? (
            <p className="mt-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100">
              Kata sandi baru: <span className="font-mono">{issuedPassword}</span>
            </p>
          ) : null}
          {editError ? <p className="mt-2 text-slate-100">{editError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Satu baris tabel pengguna; baris ini hanya menampilkan data dan tombol "Ubah". */
function TableRow({ row, editing, onEdit }: { row: AdminUserRow; editing: boolean; onEdit: () => void }) {
  return (
    <tr className={editing ? 'bg-slate-800/60' : undefined}>
      <td className="border-b border-slate-700 px-2 py-2 text-slate-100">
        {String(row?.email ?? '-')}
        {row?.deletedAt ? <span className="ml-2 rounded bg-slate-700 px-2 py-0.5 text-xs">Ditutup</span> : null}
      </td>
      <td className="border-b border-slate-700 px-2 py-2">{String(row?.displayName ?? '-')}</td>
      <td className="border-b border-slate-700 px-2 py-2">{String(row?.tier ?? '-')}</td>
      <td className="border-b border-slate-700 px-2 py-2">{yesNo(row?.isAdmin)}</td>
      <td className="border-b border-slate-700 px-2 py-2">{yesNo(row?.emailVerified)}</td>
      <td className="border-b border-slate-700 px-2 py-2">{num(row?.workspaces)}</td>
      <td className="border-b border-slate-700 px-2 py-2">{formatDate(row?.createdAt)}</td>
      <td className="border-b border-slate-700 px-2 py-2">
        <button
          type="button"
          className={BTN}
          aria-label={`Ubah pengguna ${String(row?.email ?? '')}`}
          onClick={onEdit}
        >
          {editing ? 'Sedang diubah' : 'Ubah'}
        </button>
      </td>
    </tr>
  );
}

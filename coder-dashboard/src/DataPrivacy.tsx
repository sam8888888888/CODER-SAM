import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { DataExport, EmailWorkerState, ExportSection, NotificationPrefs, PrivacySummary, RetentionPolicy } from './api';

/** Properti halaman "Privasi & data". Pesan galat diteruskan ke induk halaman. */
type Props = { onError: (message: string) => void };

/** Saklar preferensi email yang dikenal server. */
type PrefKey = 'emailQuota' | 'emailRuns' | 'emailBilling' | 'emailTeam' | 'emailSecurity';

/** Kelas Tailwind dasar untuk tombol di halaman ini. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas pembungkus kartu isi. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan (galat, pemberitahuan, peringatan). */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala dan badan tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
const TD = 'border-b border-slate-700/60 px-3 py-2';

/** Urutan saklar preferensi email sesuai kolom server. */
const PREF_KEYS: PrefKey[] = ['emailQuota', 'emailRuns', 'emailBilling', 'emailTeam', 'emailSecurity'];

/** Label cadangan bila server tidak mengirim daftar kinds. */
const PREF_LABELS: Record<PrefKey, string> = {
  emailQuota: 'Kuota token hampir atau sudah habis',
  emailRuns: 'Kegagalan menjalankan agen',
  emailBilling: 'Pesanan, pembayaran, dan langganan',
  emailTeam: 'Undangan dan perubahan anggota tim',
  emailSecurity: 'Keamanan akun: kata sandi, MFA, email',
};

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Ukuran berkas dalam satuan yang mudah dibaca (byte, KB, MB, GB). */
function bytesText(value: unknown): string {
  const bytes = num(value);
  if (bytes <= 0) return '0 byte';
  if (bytes < 1024) return bytes + ' byte';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Format tanggal dan jam; nilai kosong ditulis sebagai tanda hubung. */
function dateTimeText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Tampilkan boolean dengan kata "ya" atau "tidak". */
function yesNo(value: unknown): string {
  if (value === undefined || value === null) return 'tidak diketahui';
  return value ? 'ya' : 'tidak';
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ubah kode galat privasi dan data menjadi kalimat Indonesia yang jelas. */
function privacyErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('UNAUTHORIZED') || code.includes('UNAUTHENTICATED') || code.includes('AUTH')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  }
  if (code.includes('EXPORT_NOT_FOUND')) return 'Berkas ekspor itu tidak ada lagi di server. Muat ulang daftar ekspor.';
  if (code.includes('EXPORT_EXPIRED') || code.includes('EXPORT_FILE_MISSING')) {
    return 'Berkas ekspor itu sudah kedaluwarsa atau hilang dari penyimpanan. Buat ekspor baru.';
  }
  if (code.includes('RATE_LIMIT')) return 'Permintaan terlalu sering. Tunggu sebentar, lalu coba lagi.';
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu coba lagi.';
  }
  return fallback;
}

/** Nilai saklar (0 atau 1) dari respons server. */
function prefValues(preferences: NotificationPrefs | null): Record<PrefKey, number> {
  const values = {} as Record<PrefKey, number>;
  for (const key of PREF_KEYS) values[key] = num(preferences?.[key]) === 1 ? 1 : 0;
  return values;
}

/** Label status berkas ekspor dalam bahasa Indonesia. */
function exportStatusLabel(row: DataExport): string {
  const code = String(row?.status ?? '').trim().toLowerCase();
  const expiresAt = String(row?.expiresAt ?? '').trim();
  const expired = Boolean(expiresAt) && new Date(expiresAt).getTime() < Date.now();
  if (code === 'expired' || expired) return 'kedaluwarsa';
  if (code === 'ready') return 'siap diunduh';
  if (code === 'pending') return 'menunggu dibuat';
  if (code === 'failed') return 'gagal';
  return code || 'tidak diketahui';
}

/** Berkas ekspor masih bisa diunduh hanya bila statusnya siap dan belum kedaluwarsa. */
function exportDownloadable(row: DataExport): boolean {
  const code = String(row?.status ?? '').trim().toLowerCase();
  const expiresAt = String(row?.expiresAt ?? '').trim();
  const expired = Boolean(expiresAt) && new Date(expiresAt).getTime() < Date.now();
  return code === 'ready' && !expired;
}

/** Satu baris keterangan "label: nilai" untuk kartu ringkas. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="text-slate-400">{label}:</span>
      <span className="text-slate-100">{value}</span>
    </li>
  );
}

/** Satu angka kebijakan retensi dalam kartu kecil. */
function PolicyNumber({ label, days, hint }: { label: string; days: number; hint: string }) {
  return (
    <div className={CARD}>
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{numberText(days)} hari</p>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  );
}

/**
 * Halaman "Privasi & data".
 *
 * Menampilkan ringkasan data yang disimpan akun, pembuatan dan pengelolaan berkas
 * ekspor, saklar preferensi email notifikasi beserta keadaan kanal email, dan
 * kebijakan retensi. Semua angka diambil langsung dari api tanpa nilai karangan.
 */
export function DataPrivacy({ onError }: Props) {
  // Ringkasan data dan kebijakan retensi.
  const [summary, setSummary] = useState<PrivacySummary | null>(null);
  // Daftar berkas ekspor milik pengguna.
  const [exports, setExports] = useState<DataExport[]>([]);
  // Preferensi email dan keadaan kanal email.
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [kinds, setKinds] = useState<{ key: string; label: string }[]>([]);
  const [email, setEmail] = useState<EmailWorkerState | null>(null);
  const [emailNote, setEmailNote] = useState('');
  const [draft, setDraft] = useState<Record<PrefKey, number>>(() => prefValues(null));
  // Pesan hasil tindakan, keadaan memuat, dan galat.
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [exportMessage, setExportMessage] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk; galat tidak pernah ditelan. */
  const fail = useCallback(
    (message: string): void => {
      setError(message);
      onError(message);
    },
    [onError],
  );

  /** Ambil ringkasan privasi, daftar ekspor, dan preferensi email dari server. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    setProblem('');
    const failures: string[] = [];

    // 1. Ringkasan data: jumlah bagian, jumlah baris, kebijakan retensi, catatan.
    try {
      const result = await api.privacySummary();
      setSummary(result ?? null);
    } catch (caught) {
      setSummary(null);
      failures.push(privacyErrorMessage(caught, 'Gagal memuat ringkasan data akun. Coba muat ulang sebentar lagi.'));
    }

    // 2. Daftar berkas ekspor.
    try {
      const result = await api.listExports();
      setExports(Array.isArray(result?.exports) ? result.exports : []);
    } catch (caught) {
      setExports([]);
      failures.push(privacyErrorMessage(caught, 'Gagal memuat daftar berkas ekspor. Coba muat ulang sebentar lagi.'));
    }

    // 3. Preferensi email notifikasi.
    try {
      const result = await api.notificationPrefs();
      setPrefs(result?.preferences ?? null);
      setKinds(Array.isArray(result?.kinds) ? result.kinds : []);
      setEmail(result?.email ?? null);
      setEmailNote(String(result?.note ?? ''));
      setDraft(prefValues(result?.preferences ?? null));
    } catch (caught) {
      setPrefs(null);
      setKinds([]);
      setEmail(null);
      setEmailNote('');
      failures.push(privacyErrorMessage(caught, 'Gagal memuat preferensi email notifikasi. Coba muat ulang sebentar lagi.'));
    }

    setLoading(false);
    if (failures.length > 0) fail(failures.join(' '));
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Muat ulang ringkasan dan daftar ekspor sesudah ekspor dibuat atau dihapus. */
  async function refreshExports(): Promise<void> {
    try {
      const listed = await api.listExports();
      setExports(Array.isArray(listed?.exports) ? listed.exports : []);
    } catch (caught) {
      const message = privacyErrorMessage(caught, 'Daftar berkas ekspor tidak bisa dimuat ulang. Gunakan tombol Muat ulang.');
      setProblem(message);
      onError(message);
      return;
    }
    try {
      setSummary((await api.privacySummary()) ?? null);
    } catch {
      // Ringkasan lama masih benar untuk bagian lain; kegagalan ini tidak perlu menghentikan halaman.
    }
  }

  /** Buat berkas ekspor baru berisi data akun. */
  async function createExport(): Promise<void> {
    setBusy('export');
    setProblem('');
    setNotice('');
    setExportMessage('');
    try {
      const result = await api.createExport();
      setExportMessage(
        String(result?.message ?? '') ||
          'Berkas ekspor siap. Ukuran ' + bytesText(result?.export?.sizeBytes) + ', kedaluwarsa ' + dateTimeText(result?.export?.expiresAt) + '.',
      );
      setNotice('Ekspor baru dibuat. Tautan unduh tersedia di daftar di bawah.');
      await refreshExports();
    } catch (caught) {
      const message = privacyErrorMessage(caught, 'Gagal membuat berkas ekspor. Coba lagi sebentar lagi.');
      setProblem(message);
      onError(message);
    } finally {
      setBusy('');
    }
  }

  /** Hapus satu berkas ekspor sesudah konfirmasi pengguna. */
  async function removeExport(row: DataExport): Promise<void> {
    const confirmed = window.confirm(
      'Hapus berkas ekspor yang dibuat ' +
        dateTimeText(row.createdAt) +
        ' (kedaluwarsa ' +
        dateTimeText(row.expiresAt) +
        ')? Berkas di server ikut dihapus dan tindakan ini tidak bisa dibatalkan.',
    );
    if (!confirmed) return;
    setBusy('hapus-' + row.id);
    setProblem('');
    setNotice('');
    try {
      await api.deleteExport(row.id);
      setNotice('Berkas ekspor ' + dateTimeText(row.createdAt) + ' sudah dihapus.');
      await refreshExports();
    } catch (caught) {
      const message = privacyErrorMessage(caught, 'Gagal menghapus berkas ekspor. Coba muat ulang daftar ekspor.');
      setProblem(message);
      onError(message);
    } finally {
      setBusy('');
    }
  }

  /** Simpan preferensi email; hanya saklar yang berubah yang dikirim ke server. */
  async function savePrefs(): Promise<void> {
    if (!prefs) return;
    const patch: Partial<NotificationPrefs> = {};
    let changed = 0;
    for (const key of PREF_KEYS) {
      const next = num(draft[key]) === 1 ? 1 : 0;
      const current = num(prefs[key]) === 1 ? 1 : 0;
      if (next !== current) {
        patch[key] = next;
        changed += 1;
      }
    }
    if (changed === 0) {
      setNotice('Tidak ada perubahan pada preferensi email. Tidak ada yang dikirim ke server.');
      return;
    }
    setBusy('prefs');
    setProblem('');
    setNotice('');
    try {
      const result = await api.saveNotificationPrefs(patch);
      setPrefs(result?.preferences ?? prefs);
      setDraft(prefValues(result?.preferences ?? null));
      setNotice(
        String(result?.message ?? '') || numberText(changed) + ' saklar preferensi email disimpan.',
      );
    } catch (caught) {
      const message = privacyErrorMessage(caught, 'Preferensi email tidak bisa disimpan. Coba lagi sebentar lagi.');
      setProblem(message);
      onError(message);
      // Kembalikan saklar ke nilai yang masih tersimpan di server.
      setDraft(prefValues(prefs));
    } finally {
      setBusy('');
    }
  }

  const storedTotals = summary?.storedTotals;
  const sectionsInExport: ExportSection[] = Array.isArray(summary?.sectionsInExport) ? summary.sectionsInExport : [];
  const notes: string[] = Array.isArray(summary?.notes) ? summary.notes : [];
  const policy: RetentionPolicy | null = summary?.policy ?? null;
  const emailOn = Boolean(email?.enabled);
  const mailerReady = Boolean(email?.mailerConfigured);
  const prefRows = PREF_KEYS.map((key) => {
    const found = kinds.find((item) => String(item.key) === key);
    return { key, label: String(found?.label ?? '') || PREF_LABELS[key] };
  });
  const changedCount = prefs
    ? PREF_KEYS.filter((key) => (num(draft[key]) === 1 ? 1 : 0) !== (num(prefs[key]) === 1 ? 1 : 0)).length
    : 0;

  return (
    <section className="page-shell-inner text-sm text-slate-300">
      <header>
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">⛨</span>Privasi &amp; data
        </h2>
        <p className="settings-hint">
          Halaman ini memperlihatkan data akun yang disimpan platform, membiarkan Anda mengunduhnya sebagai satu berkas
          JSON, mengatur salinan email notifikasi, dan menampilkan kebijakan retensi yang sedang berlaku.
        </p>
        <button type="button" className={BTN} disabled={loading} onClick={() => { void load(); }}>
          {loading ? 'Memuat…' : 'Muat ulang'}
        </button>
      </header>

      {loading ? <p className={BANNER}>Memuat data privasi akun…</p> : null}
      {error ? (
        <p className={BANNER}>
          {error}
        </p>
      ) : null}
      {notice ? <p className={BANNER}>{notice}</p> : null}
      {problem ? <p className={BANNER}>{problem}</p> : null}

      {/* A. Ringkasan data yang disimpan. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Ringkasan data yang disimpan</h3>
        {summary ? (
          <>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className={LABEL}>Jumlah bagian data</p>
                <p className="text-lg font-semibold text-slate-100">{numberText(storedTotals?.sections)}</p>
              </div>
              <div>
                <p className={LABEL}>Jumlah baris data</p>
                <p className="text-lg font-semibold text-slate-100">{numberText(storedTotals?.rows)}</p>
              </div>
            </div>
            <p className="mb-2 text-slate-400">
              {sectionsInExport.length > 0
                ? 'Setiap bagian berikut ikut serta bila Anda membuat berkas ekspor.'
                : 'Server belum melaporkan bagian data untuk ekspor.'}
            </p>
            {sectionsInExport.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th scope="col" className={TH}>Bagian</th>
                      <th scope="col" className={TH}>Jumlah baris</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sectionsInExport.map((section) => (
                      <tr key={String(section.name)} className="text-slate-300">
                        <td className={TD}>{String(section.name ?? '(tanpa nama)')}</td>
                        <td className={TD}>{numberText(section.rows)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-slate-400">
            {loading ? 'Memuat ringkasan data…' : 'Ringkasan data belum tersedia. Tekan Muat ulang untuk mencoba lagi.'}
          </p>
        )}
      </div>

      {/* B. Ekspor data akun. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Ekspor data akun</h3>
        <p className="mb-2 text-slate-400">
          Berkas ekspor berisi data akun Anda dalam format JSON. Kata sandi, kode pemulihan MFA, dan kunci API mentah
          tidak pernah ikut serta.
        </p>
        <button type="button" className={BTN} disabled={busy === 'export'} onClick={() => { void createExport(); }}>
          {busy === 'export' ? 'Membuat berkas…' : 'Buat berkas ekspor'}
        </button>

        {exportMessage ? <p className="mt-2 text-slate-100">{exportMessage}</p> : null}

        <h4 className="mt-3 mb-2 text-sm font-semibold text-slate-100">Daftar berkas ekspor</h4>
        {exports.length === 0 ? (
          <p className="text-slate-400">
            {loading ? 'Memuat daftar ekspor…' : 'Belum ada berkas ekspor. Buat berkas pertama Anda dengan tombol di atas.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className={TH}>Dibuat</th>
                  <th scope="col" className={TH}>Kedaluwarsa</th>
                  <th scope="col" className={TH}>Ukuran</th>
                  <th scope="col" className={TH}>Bagian</th>
                  <th scope="col" className={TH}>Status</th>
                  <th scope="col" className={TH}>Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((row) => {
                  const downloadable = exportDownloadable(row);
                  const rowCount = Array.isArray(row?.sections) ? row.sections.length : 0;
                  return (
                    <tr key={String(row.id)} className="text-slate-300">
                      <td className={TD}>{dateTimeText(row.createdAt)}</td>
                      <td className={TD}>{dateTimeText(row.expiresAt)}</td>
                      <td className={TD}>{bytesText(row.sizeBytes)}</td>
                      <td className={TD}>{numberText(rowCount)}</td>
                      <td className={TD}>
                        <span className="badge">{exportStatusLabel(row)}</span>
                      </td>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-2">
                          {downloadable ? (
                            <a className={BTN} href={api.exportDownloadUrl(row.id)} download>
                              Unduh
                            </a>
                          ) : (
                            <button
                              type="button"
                              className={BTN}
                              disabled
                              title="Berkas ekspor ini sudah kedaluwarsa. Buat ekspor baru untuk mengunduh data terbaru."
                            >
                              Unduh
                            </button>
                          )}
                          <button
                            type="button"
                            className={BTN}
                            disabled={busy === 'hapus-' + row.id}
                            onClick={() => { void removeExport(row); }}
                          >
                            {busy === 'hapus-' + row.id ? 'Menghapus…' : 'Hapus'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* C. Preferensi email notifikasi. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Preferensi email notifikasi</h3>
        <ul className="mb-3">
          <Row label="Kanal email" value={email ? (emailOn ? 'aktif' : 'tidak aktif') : 'tidak diketahui'} />
          <Row label="Mailer siap" value={email ? yesNo(mailerReady) : 'tidak diketahui'} />
          <Row label="Pengirim" value={String(email?.from ?? '') || 'belum diatur'} />
        </ul>

        {!emailOn ? (
          <p className={BANNER}>
            Peringatan: kanal email belum aktif, jadi pesan notifikasi hanya masuk antrean dan belum dikirim. Saklar di
            bawah tetap disimpan dan akan berlaku saat kanal email dinyalakan admin.
          </p>
        ) : null}
        {emailOn && !mailerReady ? (
          <p className={BANNER}>
            Peringatan: pengaturan pengirim (SMTP) belum lengkap, jadi pesan bisa gagal terkirim meski kanal email aktif.
          </p>
        ) : null}
        {emailNote ? <p className="mt-2 text-slate-400">{emailNote}</p> : null}
        <p className="mt-2 text-slate-400">
          Pemberitahuan di dalam aplikasi selalu aktif. Saklar berikut hanya mengatur salinan lewat email.
        </p>

        {prefs ? (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {prefRows.map((item) => (
                <label key={item.key} className="flex items-center gap-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={num(draft[item.key]) === 1}
                    disabled={busy === 'prefs'}
                    aria-label={'Kirim email untuk: ' + item.label}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setDraft((previous) => ({ ...previous, [item.key]: checked ? 1 : 0 }));
                    }}
                  />
                  {item.label}
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={BTN} disabled={busy === 'prefs'} onClick={() => { void savePrefs(); }}>
                {busy === 'prefs' ? 'Menyimpan…' : 'Simpan'}
              </button>
              <span className="text-xs text-slate-400">
                {changedCount > 0
                  ? numberText(changedCount) + ' saklar berubah dan akan dikirim saat disimpan.'
                  : 'Belum ada perubahan yang perlu disimpan.'}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Hanya saklar yang berubah yang dikirim ke server. Preferensi terakhir diubah: {dateTimeText(prefs.updatedAt)}.
            </p>
          </>
        ) : (
          <p className="mt-2 text-slate-400">
            {loading ? 'Memuat preferensi email…' : 'Preferensi email belum tersedia. Tekan Muat ulang untuk mencoba lagi.'}
          </p>
        )}
      </div>

      {/* D. Kebijakan retensi data. */}
      <div className={CARD}>
        <h3 className="mb-2 font-semibold text-slate-100">Kebijakan retensi data</h3>
        {policy ? (
          <>
            <p className="mb-3 text-slate-400">
              Status pembersihan otomatis:{' '}
              <span className="badge">{policy.enabled ? 'aktif' : 'tidak aktif'}</span>
            </p>
            {!policy.enabled ? (
              <p className={BANNER}>
                Peringatan: pembersihan retensi belum aktif, jadi data lama belum dihapus otomatis. Angka di bawah tetap
                menunjukkan batas hari yang akan dipakai saat pembersihan dinyalakan.
              </p>
            ) : null}
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <PolicyNumber label="Jejak audit" days={policy.auditDays} hint="Umur baris audit yang disimpan." />
              <PolicyNumber label="Notifikasi" days={policy.notificationDays} hint="Umur pemberitahuan dalam aplikasi." />
              <PolicyNumber label="Peristiwa run" days={policy.runEventDays} hint="Umur peristiwa langkah run." />
              <PolicyNumber label="Berkas ekspor" days={policy.exportDays} hint="Masa berlaku berkas ekspor akun." />
            </div>
            <h4 className="mt-3 mb-1 text-sm font-semibold text-slate-100">Catatan kebijakan</h4>
            {notes.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-slate-300">
                {notes.map((note, index) => (
                  <li key={index + '-' + note}>{note}</li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-400">Server tidak mengirim catatan tambahan untuk kebijakan ini.</p>
            )}
          </>
        ) : (
          <p className="text-slate-400">
            {loading ? 'Memuat kebijakan retensi…' : 'Kebijakan retensi belum tersedia. Tekan Muat ulang untuk mencoba lagi.'}
          </p>
        )}
      </div>

      <p className="settings-hint">
        Penghapusan akun beserta datanya tersedia di halaman Pengaturan, bagian keamanan akun.
      </p>
    </section>
  );
}

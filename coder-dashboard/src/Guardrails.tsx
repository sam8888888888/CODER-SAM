/**
 * Halaman "Guardrails" (Wave 11A, butir 46) + audit-diri pelanggaran (butir 53).
 *
 * Isi halaman:
 * 1. Form tambah aturan. Jenis "kualitas" = instruksi yang dikirim ke agen; jenis "larangan" =
 *    daftar pola (pisah dengan koma atau baris baru) yang membuat permintaan TIDAK dijalankan.
 * 2. Daftar aturan milik akun ini: saklar aktif/mati, ubah judul & isi, lalu hapus.
 * 3. Audit-diri guardrail: ringkasan pelanggaran beberapa hari terakhir beserta kejadian terbaru.
 *
 * Catatan penting:
 * - Aturan hanya milik akun pembuatnya. Server hanya menyuntik sejumlah aturan aktif teratas
 *   (injectLimit) dan membatasi jumlah aturan per akun (maxRules). Angka itu datang dari jawaban
 *   server, bukan tebakan halaman ini.
 * - Bentuk jawaban API sudah pasti, jadi halaman ini merender bidang secara langsung dan hanya
 *   memakai nilai cadangan bila server mengirim angka nol/kosong.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, failureOf } from './api';
import type { GuardrailRule, SafetyReport } from './api';

/** Properti halaman: pelapor galat dari induk dan status admin platform. */
type Props = {
  onError?: (message: string) => void;
  isAdmin?: boolean;
};

/** Kelas Tailwind tombol sekunder, sama seperti halaman Wave 10. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama untuk aksi menonjol. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas tombol kecil di dalam satu baris aturan. */
const BTN_SMALL = 'rounded-md border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas pembungkus kartu. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan informasi. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas kotak pesan sukses. */
const OK_BOX = 'rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas kotak teks isi aturan. */
const TEXTAREA = FIELD + ' min-h-24 w-full font-mono text-xs';

/** Label jenis aturan dalam Bahasa Indonesia. */
const KIND_LABELS: Record<string, string> = {
  kualitas: 'Kualitas (dikirim ke agen)',
  larangan: 'Larangan (permintaan ditolak)',
};

/** Nilai bawaan form tambah aturan. */
const FORM_KOSONG = { kind: 'larangan', title: '', body: '', enabled: true };

/** Ubah nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Bidang `enabled` dikirim server sebagai 0/1 atau boolean; keduanya dibaca sebagai aktif/mati. */
function aktif(enabled: unknown): boolean {
  return enabled === true || num(enabled) === 1;
}

/** Format tanggal dan jam ke waktu Indonesia; nilai kosong ditulis tanda hubung. */
function dateTimeText(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '-';
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Label jenis aturan; jenis tak dikenal tetap ditampilkan apa adanya. */
function kindLabel(kind: unknown): string {
  const value = String(kind ?? '').trim();
  return KIND_LABELS[value] ?? (value || 'tidak dilaporkan');
}

/**
 * Ubah galat menjadi kalimat Indonesia.
 * Pesan dari server dipakai apa adanya; bila server hanya mengirim kode mesin, halaman ini
 * menambahkan kalimat sendiri yang jujur (mis. rute belum tersedia).
 */
function pesanGalat(error: unknown, apa: string): string {
  const gagal = failureOf(error);
  const kode = (gagal.code + ' ' + gagal.message).toUpperCase();
  if (gagal.status === 404 || gagal.status === 501 || kode.includes('NOT_FOUND') || kode.includes('NOT_IMPLEMENTED')) {
    return 'Rute API ' + apa + ' belum tersedia di server ini (menunggu API Wave 11A).';
  }
  if (gagal.status === 401 || kode.includes('UNAUTHORIZED') || kode.includes('UNAUTHENTICATED')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk lagi, lalu buka halaman ini kembali.';
  }
  if (gagal.status === 429 || kode.includes('RATE_LIMIT')) {
    return 'Terlalu banyak permintaan. Coba lagi sebentar.';
  }
  if (kode.includes('FAILED TO FETCH') || kode.includes('NETWORKERROR')) {
    return 'Server tidak bisa dihubungi. Periksa koneksi Anda, lalu tekan Segarkan.';
  }
  // Pesan Indonesia dari server ditampilkan apa adanya bila ada (bukan sekadar KODE_MESIN).
  const pesanServer = String(gagal.message ?? '').trim();
  if (pesanServer && pesanServer !== gagal.code) return pesanServer;
  return 'Permintaan ' + apa + ' gagal diproses. Coba lagi sebentar.';
}

/**
 * Halaman Guardrails: daftar aturan milik akun ini, form tambah, dan audit-diri pelanggaran.
 */
export function Guardrails({ onError, isAdmin }: Props) {
  // Daftar aturan, batas dari server, dan keadaan muat.
  const [rules, setRules] = useState<GuardrailRule[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [injectLimit, setInjectLimit] = useState(0);
  const [maxRules, setMaxRules] = useState(0);
  const [help, setHelp] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Form tambah aturan.
  const [form, setForm] = useState(FORM_KOSONG);
  const [createError, setCreateError] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  // Ubah satu aturan (judul, isi, jenis) di tempat.
  const [editId, setEditId] = useState('');
  const [edit, setEdit] = useState(FORM_KOSONG);
  const [rowError, setRowError] = useState('');
  const [rowBusy, setRowBusy] = useState('');
  const [notice, setNotice] = useState('');

  // Audit-diri guardrail (pelanggaran).
  const [safety, setSafety] = useState<SafetyReport | null>(null);
  const [safetyError, setSafetyError] = useState('');
  const [safetyLoading, setSafetyLoading] = useState(false);

  /** Catat galat ke halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function gagal(message: string): void {
    onError?.(message);
  }

  /** Muat daftar aturan dari server. */
  const muat = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.guardrails();
      setRules(Array.isArray(data?.rules) ? data.rules : []);
      setKinds(Array.isArray(data?.kinds) ? data.kinds : []);
      setInjectLimit(num(data?.injectLimit));
      setMaxRules(num(data?.maxRules));
      setHelp(String(data?.help ?? ''));
    } catch (error) {
      // Jangan tampilkan daftar lama seolah masih baru: kosongkan, lalu beri pesan galat.
      setRules([]);
      setKinds([]);
      setInjectLimit(0);
      setMaxRules(0);
      setHelp('');
      const message = pesanGalat(error, 'guardrails');
      setLoadError(message);
      gagal(message);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Muat ringkasan pelanggaran dari /v1/safety. */
  const muatSafety = useCallback(async (): Promise<void> => {
    setSafetyLoading(true);
    setSafetyError('');
    try {
      const data = await api.safetyReport();
      setSafety(data ?? null);
    } catch (error) {
      setSafety(null);
      const message = pesanGalat(error, 'laporan pelanggaran (/v1/safety)');
      setSafetyError(message);
      gagal(message);
    } finally {
      setSafetyLoading(false);
    }
  }, []);

  // Muat sekali saat halaman dibuka; tidak ada pemanggilan berulang dari useEffect.
  useEffect(() => {
    void muat();
    void muatSafety();
  }, [muat, muatSafety]);

  /** Tambah satu aturan baru, lalu muat ulang daftarnya. */
  async function tambah(): Promise<void> {
    const title = form.title.trim();
    const body = form.body.trim();
    if (!title) {
      setCreateError('Judul aturan wajib diisi.');
      gagal('Judul aturan wajib diisi.');
      return;
    }
    if (!body) {
      setCreateError('Isi aturan wajib diisi.');
      gagal('Isi aturan wajib diisi.');
      return;
    }
    setCreateBusy(true);
    setCreateError('');
    setNotice('');
    try {
      await api.createGuardrail({ kind: form.kind, title, body, enabled: form.enabled });
      setForm({ ...FORM_KOSONG, kind: form.kind });
      setNotice('Aturan baru sudah disimpan.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'guardrails');
      setCreateError(message);
      gagal(message);
    } finally {
      setCreateBusy(false);
    }
  }

  /** Nyalakan atau matikan satu aturan. */
  async function saklar(rule: GuardrailRule): Promise<void> {
    setRowBusy(rule.id);
    setRowError('');
    setNotice('');
    try {
      await api.updateGuardrail(rule.id, { enabled: !aktif(rule.enabled) });
      setNotice('Aturan "' + rule.title + '" sekarang ' + (aktif(rule.enabled) ? 'mati' : 'aktif') + '.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'guardrails');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  /** Buka editor satu aturan dengan isi yang sekarang. */
  function bukaEdit(rule: GuardrailRule): void {
    setEditId(rule.id);
    setEdit({
      kind: String(rule.kind ?? 'larangan'),
      title: String(rule.title ?? ''),
      body: String(rule.body ?? ''),
      enabled: aktif(rule.enabled),
    });
    setRowError('');
    setNotice('');
  }

  /** Simpan perubahan satu aturan. */
  async function simpanEdit(): Promise<void> {
    const title = edit.title.trim();
    const body = edit.body.trim();
    if (!title || !body) {
      setRowError('Judul dan isi aturan wajib diisi.');
      gagal('Judul dan isi aturan wajib diisi.');
      return;
    }
    setRowBusy(editId);
    setRowError('');
    try {
      await api.updateGuardrail(editId, { kind: edit.kind, title, body, enabled: edit.enabled });
      setEditId('');
      setNotice('Perubahan aturan sudah disimpan.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'guardrails');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  /** Hapus satu aturan setelah pengguna menyetujui kotak konfirmasi. */
  async function hapus(rule: GuardrailRule): Promise<void> {
    if (!window.confirm('Hapus aturan "' + rule.title + '"? Jejak audit aturan ini tetap tercatat.')) return;
    setRowBusy(rule.id);
    setRowError('');
    setNotice('');
    try {
      await api.deleteGuardrail(rule.id);
      setNotice('Aturan "' + rule.title + '" sudah dihapus.');
      await muat();
    } catch (error) {
      const message = pesanGalat(error, 'guardrails');
      setRowError(message);
      gagal(message);
    } finally {
      setRowBusy('');
    }
  }

  const daftarKinds = kinds.length > 0 ? kinds : ['kualitas', 'larangan'];

  return (
    <section className="space-y-5 text-sm text-slate-300">
      <div>
        <h2 className="text-base font-semibold text-slate-100">Guardrails</h2>
        <p className="mt-1 text-slate-400">
          Guardrails adalah aturan milik akun Anda sendiri. Aturan jenis <span className="font-mono">kualitas</span>{' '}
          ikut dikirim ke agen sebagai instruksi tambahan. Aturan jenis <span className="font-mono">larangan</span>{' '}
          berisi pola (pisahkan dengan koma atau baris baru): bila permintaan memuat salah satu pola, aksi itu tidak
          dijalankan dan pelanggarannya dicatat di bagian audit-diri di bawah.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {injectLimit > 0
            ? 'Server hanya menyuntik ' + numberText(injectLimit) + ' aturan aktif teratas ke prompt.'
            : 'Jumlah aturan aktif yang disuntik ke prompt dilaporkan server setelah data dimuat.'}{' '}
          {maxRules > 0 ? 'Batas total aturan per akun: ' + numberText(maxRules) + '.' : ''}
          {isAdmin ? ' Anda admin platform, tetapi aturan di halaman ini tetap milik akun Anda sendiri.' : ''}
        </p>
        {help ? <p className={'mt-2 ' + BANNER}>{help}</p> : null}
      </div>

      {/* Kendali muat ulang. */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN} disabled={loading} onClick={() => { void muat(); }}>
          {loading ? 'Memuat…' : 'Segarkan'}
        </button>
        <span className="text-xs text-slate-400">
          {rules.length > 0 ? numberText(rules.length) + ' aturan tersimpan.' : 'Belum ada aturan yang dimuat.'}
        </span>
      </div>

      {loadError ? <p className={ERROR_BOX}>{loadError}</p> : null}
      {rowError ? <p className={ERROR_BOX}>{rowError}</p> : null}
      {notice ? <p className={OK_BOX}>{notice}</p> : null}

      {/* Form tambah aturan. */}
      <div className={CARD}>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Tambah aturan</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Jenis aturan</span>
            <select
              className={FIELD}
              value={form.kind}
              aria-label="Jenis aturan"
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            >
              {daftarKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Judul</span>
            <input
              className={FIELD}
              value={form.title}
              maxLength={120}
              placeholder="Misalnya: Jangan hapus berkas produksi"
              aria-label="Judul aturan"
              onChange={(event) => {
                setForm({ ...form, title: event.target.value });
                setCreateError('');
              }}
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className={LABEL}>
              {form.kind === 'larangan' ? 'Pola larangan (pisah dengan koma atau baris baru)' : 'Isi instruksi'}
            </span>
            <textarea
              className={TEXTAREA}
              value={form.body}
              placeholder={form.kind === 'larangan' ? 'rm -rf, drop database, hapus semua data' : 'Selalu sebutkan sumber data pada jawaban.'}
              aria-label="Isi aturan"
              onChange={(event) => {
                setForm({ ...form, body: event.target.value });
                setCreateError('');
              }}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enabled}
              aria-label="Aktifkan aturan ini"
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            Langsung aktifkan
          </label>
          <button type="button" className={BTN_PRIMARY} disabled={createBusy} onClick={() => { void tambah(); }}>
            {createBusy ? 'Menyimpan…' : 'Tambah aturan'}
          </button>
        </div>
        {createError ? <p className={'mt-2 ' + ERROR_BOX}>{createError}</p> : null}
      </div>

      {/* Daftar aturan. */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Aturan akun ini</h3>
        {rules.length === 0 && !loading ? (
          <p className={BANNER}>
            Belum ada aturan tersimpan untuk akun ini. {loadError ? 'Daftar tidak bisa dimuat dari server.' : ''}
          </p>
        ) : null}
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className={CARD}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-100">{String(rule.title ?? '(tanpa judul)')}</div>
                  <div className="text-xs text-slate-400">
                    {kindLabel(rule.kind)} · id <span className="font-mono">{String(rule.id ?? '-')}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={aktif(rule.enabled)}
                      disabled={rowBusy === rule.id}
                      aria-label={'Aktifkan aturan ' + String(rule.title ?? '')}
                      onChange={() => { void saklar(rule); }}
                    />
                    {aktif(rule.enabled) ? 'aktif' : 'mati'}
                  </label>
                  <button
                    type="button"
                    className={BTN_SMALL}
                    disabled={rowBusy === rule.id}
                    onClick={() => (editId === rule.id ? setEditId('') : bukaEdit(rule))}
                  >
                    {editId === rule.id ? 'Batal' : 'Ubah'}
                  </button>
                  <button
                    type="button"
                    className={BTN_SMALL}
                    disabled={rowBusy === rule.id}
                    onClick={() => { void hapus(rule); }}
                  >
                    Hapus
                  </button>
                </div>
              </div>

              {editId === rule.id ? (
                <div className="mt-3 space-y-2 border-t border-slate-700 pt-3">
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>Jenis</span>
                    <select
                      className={FIELD}
                      value={edit.kind}
                      aria-label="Jenis aturan yang diubah"
                      onChange={(event) => setEdit({ ...edit, kind: event.target.value })}
                    >
                      {daftarKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kindLabel(kind)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>Judul</span>
                    <input
                      className={FIELD}
                      value={edit.title}
                      maxLength={120}
                      aria-label="Judul aturan yang diubah"
                      onChange={(event) => setEdit({ ...edit, title: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>Isi</span>
                    <textarea
                      className={TEXTAREA}
                      value={edit.body}
                      aria-label="Isi aturan yang diubah"
                      onChange={(event) => setEdit({ ...edit, body: event.target.value })}
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={edit.enabled}
                        aria-label="Aktifkan aturan setelah disimpan"
                        onChange={(event) => setEdit({ ...edit, enabled: event.target.checked })}
                      />
                      Aktif
                    </label>
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={rowBusy === rule.id}
                      onClick={() => { void simpanEdit(); }}
                    >
                      {rowBusy === rule.id ? 'Menyimpan…' : 'Simpan perubahan'}
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-200">
                  {String(rule.body ?? '')}
                </pre>
              )}

              <div className="mt-2 text-xs text-slate-400">
                Dibuat {dateTimeText(rule.createdAt)} · diperbarui {dateTimeText(rule.updatedAt)} · urutan{' '}
                {numberText(rule.sortOrder)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Audit-diri guardrail: ringkasan pelanggaran. */}
      <div className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-100">Audit-diri guardrail (pelanggaran tercatat)</h3>
          <button type="button" className={BTN} disabled={safetyLoading} onClick={() => { void muatSafety(); }}>
            {safetyLoading ? 'Memuat…' : 'Segarkan laporan'}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Pelanggaran aturan <span className="font-mono">larangan</span> dicatat server beserta pola yang cocok.
          Aksi yang melanggar tidak dijalankan.
        </p>
        {safetyError ? <p className={'mt-2 ' + ERROR_BOX}>{safetyError}</p> : null}
        {safety ? (
          <>
            <p className="mt-2 text-slate-100">
              {numberText(safety.total)} pelanggaran dalam {numberText(safety.windowDays)} hari terakhir · kejadian
              terakhir {dateTimeText(safety.terakhir)}
            </p>
            {safety.byRule.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {safety.byRule.map((baris) => (
                  <li key={String(baris.ruleId ?? baris.title ?? '')} className="flex flex-wrap gap-x-2 text-xs">
                    <span className="text-slate-100">{String(baris.title ?? '(aturan sudah dihapus)')}</span>
                    <span className="text-slate-400">
                      {numberText(baris.jumlah)} kali · terakhir {dateTimeText(baris.terakhir)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-400">Belum ada pelanggaran tercatat pada rentang ini.</p>
            )}
            {safety.events.length > 0 ? (
              <div className="mt-3 max-h-64 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="py-1 pr-3">Waktu</th>
                      <th className="py-1 pr-3">Pola</th>
                      <th className="py-1 pr-3">Kutipan</th>
                      <th className="py-1">Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {safety.events.map((event) => (
                      <tr key={event.id} className="border-t border-slate-700 align-top">
                        <td className="py-1 pr-3 whitespace-nowrap">{dateTimeText(event.createdAt)}</td>
                        <td className="py-1 pr-3 font-mono">{String(event.pattern ?? '')}</td>
                        <td className="py-1 pr-3">{String(event.snippet ?? '')}</td>
                        <td className="py-1 font-mono">{event.runId ? String(event.runId).slice(0, 8) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : safetyLoading ? null : (
          <p className="mt-2 text-xs text-slate-400">Laporan pelanggaran belum dimuat.</p>
        )}
      </div>
    </section>
  );
}

export default Guardrails;

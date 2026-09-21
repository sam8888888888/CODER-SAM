/**
 * Halaman "Harga AI (Admin)" — konsol harga untuk pemilik platform (Wave 9, butir 19).
 *
 * Tujuan halaman ini:
 * 1. Menampilkan harga pokok (yang dibayar platform ke penyedia AI) dan harga jual
 *    (yang ditagihkan ke pelanggan) untuk setiap model, beserta biaya nyata dan margin.
 * 2. Mengatur markup global: harga jual = harga pokok x markup.
 * 3. Mengisi harga sendiri per model (override) atau mengembalikannya ke daftar resmi.
 *
 * Satuan uang: USD per 1 juta token. Nilai *_micros adalah biaya nyata dalam sepersejuta USD,
 * sehingga tampilan uang selalu dihitung micros / 1_000_000.
 *
 * Semua panggilan jaringan lewat objek `api` dari './api' — tidak ada fetch langsung di sini.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { CostReconciliation, PricingModel, PricingTable } from './api';

/** Properti halaman: status admin dan pelapor galat dari induk. */
type Props = {
  isAdmin: boolean;
  onError?: (message: string) => void;
};

/** Saringan baris model: semua, hanya yang dipakai, atau hanya yang berharga sendiri. */
type PricingOnly = 'all' | 'used' | 'overridden';

/** Pesan saat pengguna bukan admin platform. */
const NO_ACCESS_MESSAGE = 'Hanya admin platform yang dapat membuka halaman ini.';

/** Batas harga per 1 juta token yang diterima server (lihat validatePrice di API). */
const MAX_PRICE_PER_MTOK = 100_000;

/** Batas markup yang diterima server. */
const MARKUP_MIN = 0.1;
const MARKUP_MAX = 100;

/** Jumlah baris yang diminta ke server pada satu permintaan. */
const SERVER_LIMIT = 500;

/** Jendela hari yang bisa dipilih untuk perhitungan biaya. */
const DAY_OPTIONS: { value: number; label: string }[] = [
  { value: 7, label: '7 hari terakhir' },
  { value: 30, label: '30 hari terakhir' },
  { value: 90, label: '90 hari terakhir' },
  { value: 365, label: '365 hari terakhir' },
];

/** Pilihan filter sumber harga. */
const ONLY_OPTIONS: { value: PricingOnly; label: string }[] = [
  { value: 'all', label: 'Semua' },
  { value: 'used', label: 'Yang dipakai' },
  { value: 'overridden', label: 'Harga sendiri' },
];

/** Kelas Tailwind dasar tombol sekunder, sama dengan halaman admin lain. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol filter yang sedang aktif. */
const BTN_ACTIVE =
  'rounded-lg border border-violet-500 bg-violet-600/30 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50';
/** Kelas Tailwind dasar input dan select gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';
/** Kelas pembungkus kartu ringkasan dan panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas pita pesan untuk pemberitahuan dan galat. */
const BANNER = 'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-100';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas sel kepala tabel. */
const TH = 'border-b border-slate-700 px-3 py-2';
/** Kelas sel badan tabel. */
const TD = 'border-b border-slate-700/60 px-3 py-2';
/** Kelas dasar lencana sumber harga. */
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs';
/** Warna lencana: harga sendiri=violet, harga resmi vendor=biru, daftar resmi mesin=abu, belum ada harga=kuning. */
const SOURCE_CHIP: Record<string, string> = {
  override: 'border-violet-500/40 bg-violet-500/15 text-violet-100',
  vendor: 'border-sky-500/40 bg-sky-500/15 text-sky-100',
  catalog: 'border-slate-500/40 bg-slate-500/15 text-slate-200',
  none: 'border-amber-500/40 bg-amber-500/15 text-amber-100',
};
/** Lencana abu-abu netral untuk nilai yang tidak dikenal. */
const CHIP_OFF = 'border-slate-600 bg-slate-700/40 text-slate-200';

/** Ubah nilai apa pun menjadi angka aman supaya tabel tidak pernah menampilkan NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ubah nilai apa pun menjadi teks yang sudah dipangkas. */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Uang dalam sepersejuta USD: micros / 1_000_000 dengan enam angka di belakang koma. */
function usdMicros(value: unknown): string {
  return (num(value) / 1_000_000).toFixed(6) + ' USD';
}

/** Harga per 1 juta token dalam USD dengan enam angka di belakang koma. */
function usdPrice(value: unknown): string {
  return num(value).toFixed(6);
}

/** Nilai awal kolom angka editor; angka polos supaya mudah disunting. */
function priceField(value: unknown): string {
  return String(num(value));
}

/** Persentase margin terhadap harga pokok; harga pokok nol tidak bisa dihitung. */
function marginPercentText(marginMicros: unknown, baseMicros: unknown): string {
  const base = num(baseMicros);
  if (base <= 0) return 'margin tidak bisa dihitung (harga pokok masih nol)';
  const percent = (num(marginMicros) / base) * 100;
  return percent.toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '% dari harga pokok';
}

/** Format tanggal dan jam; nilai kosong ditulis sebagai tanda hubung. */
function dateTimeText(value: unknown): string {
  const raw = text(value);
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

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/** Terjemahkan kode galat konsol harga menjadi kalimat Indonesia yang jelas. */
function pricingErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('ADMIN_REQUIRED')) {
    return 'Hanya admin platform yang boleh melihat atau mengubah harga AI. Masuk kembali dengan akun admin.';
  }
  if (code.includes('INVALID_MARKUP')) {
    return 'Markup harus berupa angka, misalnya 1,5 untuk satu setengah kali harga pokok.';
  }
  if (code.includes('MARKUP_OUT_OF_RANGE')) {
    return 'Markup harus antara 0,1 dan 100.';
  }
  if (code.includes('INVALID_PRICE')) {
    return 'Harga tidak sah. Isi angka yang tidak negatif, maksimum 100.000 USD per 1 juta token.';
  }
  if (code.includes('INVALID_MODEL')) {
    return 'Nama model tidak sah. Muat ulang tabel lalu pilih model yang ada di daftar.';
  }
  if (code.includes('PRICE_NOT_OVERRIDDEN')) {
    return 'Model ini belum pernah diberi harga sendiri, jadi tidak ada harga yang bisa dikembalikan ke daftar resmi.';
  }
  return 'Aksi gagal diproses. Periksa data yang diisi, lalu coba lagi.';
}

/** Sebutan sumber harga dalam Bahasa Indonesia. */
function sourceLabel(value: unknown): string {
  const code = text(value).toLowerCase();
  if (code === 'override') return 'Harga sendiri';
  if (code === 'vendor') return 'Harga resmi vendor';
  if (code === 'catalog') return 'Daftar resmi';
  if (code === 'none') return 'Belum ada harga';
  return 'Sumber tidak dikenal';
}

/** Kelas lencana sesuai sumber harga. */
function sourceChipClass(value: unknown): string {
  const code = text(value).toLowerCase();
  return CHIP + ' ' + (SOURCE_CHIP[code] ?? CHIP_OFF);
}

/** Penjelasan singkat arti sumber harga, dipakai di baris tabel sebagai tooltip. */
function sourceHint(value: unknown): string {
  const code = text(value).toLowerCase();
  if (code === 'override') return 'Harga ini Anda isi sendiri dan menimpa daftar resmi mesin.';
  if (code === 'vendor') return 'Harga diambil dari daftar harga resmi vendor (diperiksa berkala, tarif puncak dihitung dua kali).';
  if (code === 'catalog') return 'Harga diambil dari daftar resmi mesin.';
  if (code === 'none') return 'Model ini belum punya harga, sehingga biayanya tidak dihitung.';
  return 'Sumber harga tidak dikenal.';
}

/**
 * Halaman konsol harga AI: kartu ringkasan biaya, panel markup global, dan tabel harga
 * per model beserta editor harga. Semua endpoint admin hanya dipanggil bila isAdmin=true.
 */
export function AdminPricing({ isAdmin, onError }: Props) {
  // Data tabel harga dari server, keadaan muat, dan galat pemuatan.
  const [table, setTable] = useState<PricingTable | null>(null);
  const [loading, setLoading] = useState(false);
  const [tableError, setTableError] = useState('');

  // Kendali permintaan: jendela hari, saringan sumber, dan pencarian model.
  const [days, setDays] = useState(30);
  const [only, setOnly] = useState<PricingOnly>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Panel markup global.
  const [markupInput, setMarkupInput] = useState('1');
  const [markupBusy, setMarkupBusy] = useState(false);
  const [markupError, setMarkupError] = useState('');

  // Pesan sukses aksi terakhir.
  const [notice, setNotice] = useState('');

  // Butir 19: rekonsiliasi biaya tercatat vs harga yang berlaku sekarang.
  const [recon, setRecon] = useState<CostReconciliation | null>(null);
  const [reconBusy, setReconBusy] = useState(false);
  const [reconError, setReconError] = useState('');

  // Panel editor harga satu model.
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editInput, setEditInput] = useState('');
  const [editOutput, setEditOutput] = useState('');
  const [editCacheRead, setEditCacheRead] = useState('');
  const [editCacheWrite, setEditCacheWrite] = useState('');
  const [editBusy, setEditBusy] = useState('');
  const [editError, setEditError] = useState('');

  /** Catat galat di halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  const fail = useCallback(
    (message: string): void => {
      onError?.(message);
    },
    [onError],
  );

  /** Muat ulang tabel harga sesuai kendali permintaan yang sedang aktif. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setTableError('');
    try {
      const data = await api.adminPricing({
        days,
        only,
        search: search || undefined,
        limit: SERVER_LIMIT,
      });
      setTable(data);
      // Selaraskan kotak markup dengan nilai yang berlaku di server.
      setMarkupInput(String(num(data?.markup)));
    } catch (error) {
      // Jangan tampilkan angka palsu: kosongkan tabel lalu beri pesan galat.
      setTable(null);
      const message = pricingErrorMessage(error);
      setTableError(message);
      fail(message);
    } finally {
      setLoading(false);
    }
  }, [days, only, search, fail]);

  // Pengguna biasa tidak boleh memanggil endpoint admin sama sekali.
  useEffect(() => {
    if (!isAdmin) {
      setTable(null);
      setTableError('');
      setEditingModel(null);
      setMarkupError('');
      return;
    }
    void load();
  }, [isAdmin, load]);

  /**
   * Periksa selisih biaya: biaya yang tercatat dibandingkan dengan biaya yang seharusnya menurut
   * harga yang berlaku sekarang. Hanya dijalankan saat tombol ditekan, bukan saat halaman dibuka.
   */
  const periksaRekonsiliasi = useCallback(async (): Promise<void> => {
    setReconBusy(true);
    setReconError('');
    try {
      const data = await api.adminPricingReconcile({ days, limit: 10 });
      setRecon(data);
    } catch (error) {
      setRecon(null);
      const message = pricingErrorMessage(error);
      setReconError(message);
      fail(message);
    } finally {
      setReconBusy(false);
    }
  }, [days, fail]);

  /** Bersihkan dan tutup panel editor harga. */
  function closeEditor(): void {
    setEditingModel(null);
    setEditInput('');
    setEditOutput('');
    setEditCacheRead('');
    setEditCacheWrite('');
    setEditError('');
  }

  /** Buka panel editor untuk satu model dan isi harga pokok yang sedang berlaku. */
  function openEditor(row: PricingModel): void {
    setEditingModel(String(row?.model ?? ''));
    setEditInput(priceField(row?.base?.input));
    setEditOutput(priceField(row?.base?.output));
    setEditCacheRead(priceField(row?.base?.cacheRead));
    setEditCacheWrite(priceField(row?.base?.cacheWrite));
    setEditError('');
    setNotice('');
  }

  /** Simpan markup global, lalu muat ulang tabel supaya harga jual ikut diperbarui. */
  async function saveMarkup(): Promise<void> {
    if (!isAdmin) return;
    setMarkupError('');
    setNotice('');
    const raw = markupInput.trim().replace(',', '.');
    const value = Number(raw);
    if (!raw || !Number.isFinite(value)) {
      setMarkupError('Markup harus berupa angka, misalnya 1,5.');
      return;
    }
    if (value < MARKUP_MIN || value > MARKUP_MAX) {
      setMarkupError('Markup harus antara ' + String(MARKUP_MIN).replace('.', ',') + ' dan ' + numberText(MARKUP_MAX) + '.');
      return;
    }
    setMarkupBusy(true);
    try {
      const result = await api.adminPricingSetMarkup(value);
      const message = text(result?.message) || 'Markup sudah disimpan.';
      setNotice(message + ' Baris pemakaian yang dihitung ulang: ' + numberText(result?.rowsUpdated) + '.');
      await load();
    } catch (error) {
      const message = pricingErrorMessage(error);
      setMarkupError(message);
      fail(message);
    } finally {
      setMarkupBusy(false);
    }
  }

  /** Simpan harga sendiri satu model (empat kolom angka), lalu muat ulang tabel. */
  async function saveModel(model: string): Promise<void> {
    if (!isAdmin || !model) return;
    setEditError('');
    setNotice('');
    const fields: { label: string; raw: string }[] = [
      { label: 'Harga masuk', raw: editInput },
      { label: 'Harga keluar', raw: editOutput },
      { label: 'Harga cache baca', raw: editCacheRead },
      { label: 'Harga cache tulis', raw: editCacheWrite },
    ];
    const values: number[] = [];
    for (const field of fields) {
      const clean = field.raw.trim().replace(',', '.');
      const value = Number(clean);
      if (!clean || !Number.isFinite(value)) {
        setEditError(field.label + ' harus berupa angka.');
        return;
      }
      if (value < 0) {
        setEditError(field.label + ' tidak boleh negatif.');
        return;
      }
      if (value > MAX_PRICE_PER_MTOK) {
        setEditError(field.label + ' terlalu besar (maksimum ' + numberText(MAX_PRICE_PER_MTOK) + ' USD per 1 juta token).');
        return;
      }
      values.push(value);
    }
    setEditBusy('simpan');
    try {
      const result = await api.adminPricingSetModel(model, {
        input: values[0],
        output: values[1],
        cacheRead: values[2],
        cacheWrite: values[3],
      });
      setNotice(text(result?.message) || 'Harga ' + model + ' sudah disimpan.');
      closeEditor();
      await load();
    } catch (error) {
      const message = pricingErrorMessage(error);
      setEditError(message);
      fail(message);
    } finally {
      setEditBusy('');
    }
  }

  /** Kembalikan harga satu model ke daftar resmi; konfirmasi dulu karena harga sendiri dihapus. */
  async function resetModel(model: string): Promise<void> {
    if (!isAdmin || !model) return;
    setEditError('');
    setNotice('');
    const agreed = window.confirm(
      'Kembalikan harga ' + model + ' ke daftar resmi? Harga sendiri untuk model ini akan dihapus.',
    );
    if (!agreed) return;
    setEditBusy('kembalikan');
    try {
      const result = await api.adminPricingResetModel(model);
      setNotice(text(result?.message) || 'Harga ' + model + ' sudah dikembalikan ke daftar resmi.');
      closeEditor();
      await load();
    } catch (error) {
      const message = pricingErrorMessage(error);
      setEditError(message);
      fail(message);
    } finally {
      setEditBusy('');
    }
  }

  // Tanpa hak admin: cukup kartu informasi, tanpa satu pun panggilan API admin.
  if (!isAdmin) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
        <h2 className="mb-2 text-base font-semibold text-slate-100">Harga AI (Admin)</h2>
        <p>{NO_ACCESS_MESSAGE}</p>
      </section>
    );
  }

  const totals = table?.totals;
  const models = Array.isArray(table?.models) ? table!.models : [];
  const editingRow = editingModel ? models.find((row) => String(row?.model ?? '') === editingModel) : undefined;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
      <h2 className="mb-2 text-base font-semibold text-slate-100">Harga AI (Admin)</h2>
      <p className="mb-3 text-slate-400">
        Harga pokok adalah biaya yang dibayar platform ke penyedia AI. Harga jual adalah yang ditagihkan ke
        pelanggan, dihitung sebagai harga pokok x markup. Semua angka harga memakai satuan USD per 1 juta token,
        sedangkan biaya nyata ditulis dalam USD dengan enam angka di belakang koma.
      </p>

      {notice ? <p className={'mb-3 ' + BANNER}>{notice}</p> : null}

      {/* Kendali permintaan: muat ulang, jendela hari, filter sumber, dan pencarian model. */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <button type="button" className={BTN} disabled={loading} onClick={() => { void load(); }}>
          {loading ? 'Memuat…' : 'Muat ulang'}
        </button>
        <label className="flex flex-col gap-1 text-slate-300">
          Jendela hari
          <select
            className={FIELD}
            value={String(days)}
            aria-label="Jendela hari perhitungan biaya"
            onChange={(event) => setDays(num(event.target.value) || 30)}
          >
            {DAY_OPTIONS.map((option) => (
              <option key={option.value} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-slate-300">
          Sumber harga
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter sumber harga">
            {ONLY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={only === option.value}
                className={only === option.value ? BTN_ACTIVE : BTN}
                disabled={loading}
                onClick={() => setOnly(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <label className="flex flex-col gap-1 text-slate-300">
            Cari model
            <input
              className={FIELD}
              type="search"
              value={searchInput}
              placeholder="Contoh: claude atau gpt"
              aria-label="Cari model berdasarkan nama atau penyedia"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>
          <button type="submit" className={BTN} disabled={loading}>
            Cari
          </button>
          {search ? (
            <button
              type="button"
              className={BTN}
              disabled={loading}
              onClick={() => {
                setSearchInput('');
                setSearch('');
              }}
            >
              Bersihkan pencarian
            </button>
          ) : null}
        </form>
      </div>

      {loading ? <p className="mb-2 text-slate-400">Memuat daftar harga model…</p> : null}
      {tableError ? <p className={'mb-2 ' + ERROR_BOX}>{tableError}</p> : null}
      {!loading && !tableError && !table ? (
        <p className="mb-2 text-slate-400">Data harga belum dimuat. Tekan "Muat ulang" untuk memuat dari server.</p>
      ) : null}

      {/* Kartu ringkasan biaya untuk jendela hari yang dipilih. */}
      {table ? (
        <>
          <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">Ringkasan biaya</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className={CARD}>
              <div className={LABEL}>Jumlah run</div>
              <div className="text-slate-100">{numberText(totals?.runs)}</div>
              <div className="text-xs text-slate-400">
                {numberText(totals?.pricedRuns)} run berharga · {numberText(totals?.unpricedRuns)} run tanpa harga
              </div>
            </div>
            <div className={CARD}>
              <div className={LABEL}>Biaya pokok (dibayar platform)</div>
              <div className="text-slate-100">{usdMicros(totals?.baseMicros)}</div>
              <div className="text-xs text-slate-400">Nilai yang dibayar ke penyedia AI.</div>
            </div>
            <div className={CARD}>
              <div className={LABEL}>Ditagihkan ke pelanggan</div>
              <div className="text-slate-100">{usdMicros(totals?.sellMicros)}</div>
              <div className="text-xs text-slate-400">Harga pokok x markup {numberText(table.markup)}.</div>
            </div>
            <div className={CARD}>
              <div className={LABEL}>Margin</div>
              <div className="text-slate-100">{usdMicros(totals?.marginMicros)}</div>
              <div className="text-xs text-slate-400">
                {marginPercentText(totals?.marginMicros, totals?.baseMicros)}
              </div>
            </div>
            <div className={CARD}>
              <div className={LABEL}>Model dipakai</div>
              <div className="text-slate-100">{numberText(totals?.modelsUsed)}</div>
              <div className="text-xs text-slate-400">Model yang punya run pada jendela ini.</div>
            </div>
            <div className={CARD}>
              <div className={LABEL}>Model berharga sendiri</div>
              <div className="text-slate-100">{numberText(table.overrideCount)}</div>
              <div className="text-xs text-slate-400">Harga yang Anda isi sendiri (override).</div>
            </div>
            <div className={CARD}>
              <div className={LABEL}>Daftar resmi mesin</div>
              <div className="text-slate-100">{numberText(table.catalogSize)}</div>
              <div className="text-xs text-slate-400">Jumlah model pada daftar resmi.</div>
            </div>
            <div className={CARD}>
              <div className={LABEL}>Jendela perhitungan</div>
              <div className="text-slate-100">{numberText(table.days)} hari</div>
              <div className="text-xs text-slate-400">
                Markup diubah: {dateTimeText(table.updatedAt)} oleh {text(table.updatedBy) || 'belum dicatat'}
              </div>
            </div>
          </div>
          {text(table.note) ? (
            <p className="mt-2 text-xs text-slate-400">Catatan server: {text(table.note)}</p>
          ) : null}
        </>
      ) : null}

      {/* Panel markup global. */}
      <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">Markup harga jual</h3>
      <div className={CARD}>
        <p className="mb-2 text-slate-400">
          Markup 1 berarti menjual seharga harga pokok (tanpa margin). Markup 2 berarti menjual dua kali harga pokok.
          Nilai markup berlaku untuk semua model sekaligus.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-slate-300">
            Markup
            <input
              className={FIELD}
              type="number"
              min={MARKUP_MIN}
              max={MARKUP_MAX}
              step={0.05}
              value={markupInput}
              aria-label="Nilai markup harga jual"
              onChange={(event) => {
                setMarkupInput(event.target.value);
                setMarkupError('');
              }}
            />
          </label>
          <button type="button" className={BTN} disabled={markupBusy} onClick={() => { void saveMarkup(); }}>
            {markupBusy ? 'Menyimpan…' : 'Simpan markup'}
          </button>
        </div>
        <p className="mt-2 text-slate-400">
          Batas yang diterima server: {String(MARKUP_MIN).replace('.', ',')} sampai {numberText(MARKUP_MAX)}.
        </p>
        {markupError ? <p className={'mt-2 ' + ERROR_BOX}>{markupError}</p> : null}
      </div>

      {/* Tabel harga per model. */}
      <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-100">Harga per model</h3>
      {!loading && table && models.length === 0 ? (
        <p className="text-slate-400">
          Tidak ada model yang cocok dengan pencarian, jendela hari, atau filter yang Anda pilih.
        </p>
      ) : null}

      {models.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-slate-400">
                <th scope="col" className={TH}>Model</th>
                <th scope="col" className={TH}>Penyedia</th>
                <th scope="col" className={TH}>Sumber</th>
                <th scope="col" className={TH}>Harga pokok masuk (USD per 1 juta token)</th>
                <th scope="col" className={TH}>Harga pokok keluar (USD per 1 juta token)</th>
                <th scope="col" className={TH}>Harga jual masuk (USD per 1 juta token)</th>
                <th scope="col" className={TH}>Harga jual keluar (USD per 1 juta token)</th>
                <th scope="col" className={TH}>Biaya pokok nyata / ditagihkan</th>
                <th scope="col" className={TH}>Run</th>
                <th scope="col" className={TH}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {models.map((row) => {
                const model = String(row?.model ?? '');
                const overridden = text(row?.source).toLowerCase() === 'override';
                return (
                  <tr key={model || String(row?.provider ?? '')} className={editingModel === model ? 'bg-slate-800/60' : undefined}>
                    <td className={'font-mono ' + TD + ' text-slate-100'}>{model || '-'}</td>
                    <td className={TD}>{text(row?.provider) || '-'}</td>
                    <td className={TD}>
                      <span className={sourceChipClass(row?.source)} title={sourceHint(row?.source)}>
                        {sourceLabel(row?.source)}
                      </span>
                      {row?.used ? <span className="ml-2 text-xs text-slate-400">dipakai</span> : null}
                    </td>
                    <td className={TD}>{usdPrice(row?.base?.input)}</td>
                    <td className={TD}>{usdPrice(row?.base?.output)}</td>
                    <td className={TD}>{usdPrice(row?.sell?.input)}</td>
                    <td className={TD}>{usdPrice(row?.sell?.output)}</td>
                    <td className={TD}>
                      {usdMicros(row?.baseMicros)} / {usdMicros(row?.sellMicros)}
                      <span className="ml-2 text-xs text-slate-400">margin {usdMicros(row?.marginMicros)}</span>
                    </td>
                    <td className={TD}>{numberText(row?.runs)}</td>
                    <td className={TD}>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={BTN}
                          aria-label={'Atur harga model ' + model}
                          onClick={() => openEditor(row)}
                        >
                          Atur harga
                        </button>
                        <button
                          type="button"
                          className={BTN}
                          disabled={!overridden || Boolean(editBusy)}
                          title={
                            overridden
                              ? 'Hapus harga sendiri dan pakai daftar resmi mesin.'
                              : 'Hanya model berharga sendiri yang bisa dikembalikan ke daftar resmi.'
                          }
                          aria-label={'Kembalikan harga model ' + model + ' ke daftar resmi'}
                          onClick={() => { void resetModel(model); }}
                        >
                          {editBusy === 'kembalikan' && editingModel === model ? 'Mengembalikan…' : 'Kembalikan ke daftar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Editor harga satu model: empat kolom angka harga pokok. */}
      {editingModel ? (
        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <h3 className="mb-2 text-sm font-semibold text-slate-100">
            Atur harga: <span className="font-mono">{editingModel}</span>
          </h3>
          <p className="mb-2 text-slate-400">
            Isi harga yang dibayar platform ke penyedia AI (harga pokok) dalam USD per 1 juta token. Harga jual
            dihitung otomatis dari markup yang berlaku. Sumber saat ini:{' '}
            {sourceLabel(editingRow?.source)}.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-slate-300">
              Harga masuk
              <input
                className={FIELD}
                type="number"
                min={0}
                step={0.000001}
                value={editInput}
                aria-label="Harga pokok masukan per 1 juta token"
                onChange={(event) => {
                  setEditInput(event.target.value);
                  setEditError('');
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Harga keluar
              <input
                className={FIELD}
                type="number"
                min={0}
                step={0.000001}
                value={editOutput}
                aria-label="Harga pokok keluaran per 1 juta token"
                onChange={(event) => {
                  setEditOutput(event.target.value);
                  setEditError('');
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Cache baca
              <input
                className={FIELD}
                type="number"
                min={0}
                step={0.000001}
                value={editCacheRead}
                aria-label="Harga pokok cache baca per 1 juta token"
                onChange={(event) => {
                  setEditCacheRead(event.target.value);
                  setEditError('');
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-slate-300">
              Cache tulis
              <input
                className={FIELD}
                type="number"
                min={0}
                step={0.000001}
                value={editCacheWrite}
                aria-label="Harga pokok cache tulis per 1 juta token"
                onChange={(event) => {
                  setEditCacheWrite(event.target.value);
                  setEditError('');
                }}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={() => { void saveModel(editingModel); }}>
              {editBusy === 'simpan' ? 'Menyimpan…' : 'Simpan'}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={Boolean(editBusy) || text(editingRow?.source).toLowerCase() !== 'override'}
              title={
                text(editingRow?.source).toLowerCase() === 'override'
                  ? 'Hapus harga sendiri dan pakai daftar resmi mesin.'
                  : 'Model ini masih memakai daftar resmi mesin.'
              }
              onClick={() => { void resetModel(editingModel); }}
            >
              {editBusy === 'kembalikan' ? 'Mengembalikan…' : 'Kembalikan ke daftar'}
            </button>
            <button type="button" className={BTN} disabled={Boolean(editBusy)} onClick={closeEditor}>
              Batal
            </button>
          </div>
          {editingRow ? (
            <p className="mt-2 text-xs text-slate-400">
              Harga pokok sekarang {usdPrice(editingRow?.base?.input)} masuk / {usdPrice(editingRow?.base?.output)} keluar ·
              harga jual {usdPrice(editingRow?.sell?.input)} masuk / {usdPrice(editingRow?.sell?.output)} keluar ·
              harga sendiri diubah {dateTimeText(editingRow?.updatedAt)} oleh {text(editingRow?.updatedBy) || 'belum dicatat'}
            </p>
          ) : null}
          {editError ? <p className={'mt-2 ' + ERROR_BOX}>{editError}</p> : null}
        </div>
      ) : null}

      {/* Butir 19: rekonsiliasi biaya tercatat vs harga yang berlaku sekarang. */}
      <div className="mt-6 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
        <h3 className="mb-1 text-sm font-semibold text-slate-100">Rekonsiliasi biaya AI</h3>
        <p className="mb-2 text-slate-400">
          Periksa apakah biaya yang tercatat pada pemakaian sudah sesuai dengan harga yang berlaku sekarang. Selisih
          positif berarti biaya yang tercatat lebih kecil daripada seharusnya (misalnya karena harga resmi vendor naik
          setelah pemakaian terjadi).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={reconBusy || !isAdmin}
            aria-label="Periksa selisih biaya AI"
            onClick={() => { void periksaRekonsiliasi(); }}
          >
            {reconBusy ? 'Memeriksa…' : `Periksa selisih ${days} hari`}
          </button>
          {recon ? (
            <span className="text-xs text-slate-400">
              Diperiksa {dateTimeText(recon.generatedAt)} · {numberText(recon.totals.runs)} pemakaian ·{' '}
              tercatat {usdMicros(recon.totals.recordedMicros)} · seharusnya {usdMicros(recon.totals.correctedMicros)} ·
              selisih {usdMicros(recon.totals.driftMicros)} ({num(recon.totals.driftPercent).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%)
            </span>
          ) : null}
        </div>
        {reconError ? <p className={'mt-2 ' + ERROR_BOX}>{reconError}</p> : null}
        {recon && recon.rows.length > 0 ? (
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-700">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-800/80 text-slate-300">
                <tr>
                  <th className={TH}>Model</th>
                  <th className={TH}>Sumber harga</th>
                  <th className={TH}>Pemakaian</th>
                  <th className={TH}>Tercatat</th>
                  <th className={TH}>Seharusnya</th>
                  <th className={TH}>Selisih</th>
                  <th className={TH}>Jam puncak</th>
                </tr>
              </thead>
              <tbody>
                {recon.rows.map((row) => (
                  <tr key={row.model}>
                    <td className={'font-mono ' + TD + ' text-slate-100'}>{row.model}</td>
                    <td className={TD}>
                      <span className={sourceChipClass(row.source)} title={sourceHint(row.source)}>
                        {sourceLabel(row.source)}
                      </span>
                    </td>
                    <td className={TD}>{numberText(row.runs)}</td>
                    <td className={TD}>{usdMicros(row.recordedMicros)}</td>
                    <td className={TD}>{usdMicros(row.correctedMicros)}</td>
                    <td className={TD}>
                      {usdMicros(row.driftMicros)}
                      <span className="ml-2 text-xs text-slate-400">{num(row.driftPercent).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%</span>
                    </td>
                    <td className={TD}>{numberText(row.peakBuckets)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {recon && recon.rows.length === 0 ? (
          <p className="mt-3 text-xs text-slate-400">Belum ada pemakaian AI pada {recon.days} hari terakhir, jadi tidak ada yang bisa dibandingkan.</p>
        ) : null}
        {recon ? <p className="mt-2 text-xs text-slate-400">{recon.note}</p> : null}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        Sumber harga: "Harga sendiri" berarti harga yang Anda isi menimpa daftar resmi mesin. "Daftar resmi" berarti
        harga bawaan mesin. "Harga resmi vendor" berarti katalog mesin sudah tidak berlaku dan harga resmi penyedia AI
        dipakai (tarif puncak dihitung dua kali). "Belum ada harga" berarti model belum punya harga, sehingga biayanya
        tidak dihitung.
      </p>
    </section>
  );
}

export default AdminPricing;

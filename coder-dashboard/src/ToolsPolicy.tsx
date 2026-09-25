/**
 * Halaman "Kebijakan alat" (Wave 11A, butir 47).
 *
 * Isi halaman:
 * 1. Keadaan kebijakan sekarang: bawaan mesin, tanpa alat, atau daftar alat.
 * 2. Pemilih kebijakan: "Daftar alat" (pilih/ketik nama) atau "Tanpa alat".
 * 3. Dua cara memilih nama, mengikuti keadaan katalog dari server:
 *    - `catalogFilled` true  -> daftar centang dari katalog (nama di luar katalog ditolak server).
 *    - `catalogFilled` false -> isian nama bebas satu per satu (katalog belum diisi admin).
 * 4. Kartu khusus admin untuk mengisi katalog alat (PUT /v1/admin/tool-catalog).
 *
 * Catatan jujur soal "kembali ke bawaan":
 * Server menulis "none" untuk `null`, `[]`, atau 'none', dan daftar nama untuk daftar berisi. Nilai
 * kosong ("") yang berarti "bawaan mesin" TIDAK bisa ditulis lewat PUT /v1/tools-policy, jadi halaman
 * ini tidak menawarkan tombol "kembali ke bawaan" — hanya menampilkannya bila memang keadaan sekarang.
 *
 * Pemetaan berkas -> API (untuk laporan):
 * - GET  /api/v1/tools-policy            : keadaan kebijakan + katalog + help.
 * - PUT  /api/v1/tools-policy            : simpan kebijakan (daftar nama, [] , atau 'none').
 * - PUT  /api/v1/admin/tool-catalog      : isi/kosongkan katalog alat (khusus admin).
 */

import { useCallback, useEffect, useState } from 'react';
import { api, failureOf } from './api';
import type { ToolsPolicyResponse } from './api';

/** Properti halaman: pelapor galat dari induk dan status admin platform. */
type Props = {
  onError?: (message: string) => void;
  isAdmin?: boolean;
};

/** Kelas Tailwind tombol sekunder, sama seperti halaman Wave 10/11A. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas tombol utama. */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50';
/** Kelas tombol kecil. */
const BTN_SMALL =
  'rounded-md border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas kartu isi ringkas. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';
/** Kelas kotak pesan sukses. */
const OK_BOX = 'rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-100';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas input dan textarea gelap. */
const FIELD =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400';

/** Batas panjang daftar alat di server (TOOLS_ALLOW_MAX_CHARS). Dipakai hanya sebagai peringatan dini. */
const BATAS_KARAKTER = 400;

/** Sebutan Bahasa Indonesia untuk tiap keadaan kebijakan. */
const MODE_LABEL: Record<string, string> = {
  bawaan: 'Bawaan mesin (belum diatur)',
  tanpa_alat: 'Tanpa alat',
  daftar: 'Daftar alat',
};

/** Nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Label keadaan kebijakan; nilai tak dikenal ditampilkan apa adanya. */
function modeLabel(mode: unknown): string {
  const value = String(mode ?? '').trim();
  return MODE_LABEL[value] ?? (value || 'tidak dilaporkan');
}

/** Buang nama kembar dan spasi tepi, urutan tetap seperti yang dilihat pengguna. */
function rapiNama(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const name = String(item ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Ubah galat menjadi kalimat Indonesia. Pesan server dipakai apa adanya; bila server hanya mengirim
 * kode mesin, halaman menambahkan kalimat sendiri yang jujur.
 */
function pesanGalat(error: unknown, apa: string): string {
  const gagal = failureOf(error);
  const kode = (gagal.code + ' ' + gagal.message).toUpperCase();
  if (gagal.status === 404 || gagal.status === 501 || kode.includes('NOT_FOUND') || kode.includes('NOT_IMPLEMENTED')) {
    return 'Rute API ' + apa + ' belum tersedia di server ini (menunggu API Wave 11A).';
  }
  if (gagal.status === 401 || kode.includes('UNAUTHORIZED') || kode.includes('UNAUTHENTICATED')) {
    return 'Sesi Anda sudah berakhir, jadi ' + apa + ' tidak bisa dibuka. Silakan masuk ulang.';
  }
  if (gagal.status === 403 || kode.includes('ADMIN_REQUIRED')) {
    return 'Hanya admin platform yang boleh mengubah ' + apa + '.';
  }
  if (gagal.message) return gagal.message;
  return 'Gagal memuat ' + apa + ' (kode ' + gagal.code + ').';
}

/** Daftar nama alat yang ditolak katalog, bila server mengirimnya pada galat TOOL_NOT_ALLOWED. */
function namaTakDikenal(error: unknown): string[] {
  const body = failureOf(error).body;
  const unknown = body?.unknown;
  return Array.isArray(unknown) ? unknown.map((item) => String(item)) : [];
}

export function ToolsPolicy({ onError, isAdmin }: Props) {
  // Keadaan dari server.
  const [data, setData] = useState<ToolsPolicyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Pilihan pengguna (belum tentu sudah tersimpan).
  const [mode, setMode] = useState<'tanpa_alat' | 'daftar'>('daftar');
  const [chosen, setChosen] = useState<string[]>([]);
  const [kustom, setKustom] = useState('');
  const [kustomError, setKustomError] = useState('');

  // Simpan kebijakan.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveUnknown, setSaveUnknown] = useState<string[]>([]);
  const [saveMessage, setSaveMessage] = useState('');

  // Kartu admin: katalog alat.
  const [katalog, setKatalog] = useState('');
  const [katalogBusy, setKatalogBusy] = useState(false);
  const [katalogMessage, setKatalogMessage] = useState('');
  const [katalogError, setKatalogError] = useState('');

  /** Teruskan galat ke halaman induk supaya ikut tampil di sana. */
  const gagal = useCallback((message: string): void => { onError?.(message); }, [onError]);

  /** Muat keadaan kebijakan + katalog dari server. */
  const muat = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError('');
    try {
      const hasil = await api.toolsPolicy();
      setData(hasil ?? null);
      const daftar = Array.isArray(hasil?.tools) ? hasil.tools.map((item) => String(item)) : [];
      setChosen(rapiNama(daftar));
      // Keadaan "bawaan" tidak bisa disimpan ulang lewat API; pemilih mulai dari daftar kosong.
      setMode(hasil?.mode === 'tanpa_alat' ? 'tanpa_alat' : 'daftar');
      if (isAdmin) setKatalog((hasil?.catalog ?? []).join('\n'));
    } catch (error) {
      // Jangan tampilkan angka lama seolah masih baru.
      setData(null);
      setChosen([]);
      const message = pesanGalat(error, 'kebijakan alat (/v1/tools-policy)');
      setLoadError(message);
      gagal(message);
    } finally {
      setLoading(false);
    }
  }, [gagal, isAdmin]);

  useEffect(() => { void muat(); }, [muat]);

  /** Tambah satu nama dari isian bebas. Nama tetap dikirim apa adanya; server yang menilai sah/tidak. */
  function tambahNama(): void {
    const name = kustom.trim();
    if (!name) { setKustomError('Isi nama alat dulu, lalu tekan Tambah.'); return; }
    setKustomError('');
    setMode('daftar');
    setChosen((current) => rapiNama([...current, name]));
    setKustom('');
  }

  /** Buang satu nama dari daftar pilihan. */
  function buangNama(name: string): void {
    setChosen((current) => current.filter((item) => item !== name));
  }

  /** Nyalakan atau matikan satu centang katalog. */
  function ubahCentang(name: string, nyala: boolean): void {
    setMode('daftar');
    setChosen((current) => (nyala ? rapiNama([...current, name]) : current.filter((item) => item !== name)));
  }

  /** Simpan kebijakan ke server. Daftar kosong berarti "tanpa alat" menurut server. */
  async function simpan(): Promise<void> {
    setSaving(true);
    setSaveError('');
    setSaveUnknown([]);
    setSaveMessage('');
    const dikirim: string[] | 'none' = mode === 'tanpa_alat' ? 'none' : chosen;
    try {
      const hasil = await api.saveToolsPolicy(dikirim);
      // Jawaban PUT memuat keadaan terbaru; halaman memakai jawaban itu apa adanya.
      if (hasil) setData((current) => ({ ...(current ?? hasil), ...hasil }));
      setMode(hasil?.mode === 'tanpa_alat' ? 'tanpa_alat' : hasil?.mode === 'daftar' ? 'daftar' : 'daftar');
      setChosen(rapiNama(Array.isArray(hasil?.tools) ? hasil.tools.map((item) => String(item)) : []));
      setSaveMessage(
        'Kebijakan alat disimpan: ' + modeLabel(hasil?.mode) + '.' +
          (hasil?.diterapkanPadaRunBerikutnya ? ' Berlaku mulai run berikutnya.' : ''),
      );
    } catch (error) {
      const message = pesanGalat(error, 'kebijakan alat (/v1/tools-policy)');
      setSaveError(message);
      setSaveUnknown(namaTakDikenal(error));
    } finally {
      setSaving(false);
    }
  }

  /** Simpan katalog alat (khusus admin). Textarea kosong mengosongkan katalog. */
  async function simpanKatalog(): Promise<void> {
    setKatalogBusy(true);
    setKatalogMessage('');
    setKatalogError('');
    const names = rapiNama(katalog.split(/[\n,]+/));
    try {
      const hasil = await api.saveToolCatalog(names);
      const jumlah = num(hasil?.count);
      setKatalogMessage(jumlah > 0
        ? 'Katalog alat disimpan: ' + jumlah + ' nama. Nama di luar katalog sekarang ditolak.'
        : 'Katalog alat dikosongkan: setiap nama berformat sah akan diterima lagi.');
      await muat();
    } catch (error) {
      setKatalogError(pesanGalat(error, 'katalog alat (/v1/admin/tool-catalog)'));
    } finally {
      setKatalogBusy(false);
    }
  }

  const catalog = data?.catalog ?? [];
  const catalogFilled = Boolean(data?.catalogFilled);
  const help = String(data?.help ?? '');
  const panjangDaftar = chosen.join(',').length;
  const sedangTanpaAlat = mode === 'tanpa_alat';

  return (
    <section
      className="space-y-3 text-sm text-slate-300"
      data-testid="tools-policy"
      data-mode={String(data?.mode ?? 'belum')}
      data-catalog-filled={catalogFilled ? 'true' : 'false'}
      data-chosen={chosen.join(',')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-100">
          <span aria-hidden="true" className="mr-1">⛭</span>Kebijakan alat
        </h2>
        <button type="button" className={BTN} data-testid="tools-policy-reload" disabled={loading} onClick={() => { void muat(); }}>
          {loading ? 'Memuat…' : 'Muat ulang'}
        </button>
      </div>

      <p className="text-slate-400">
        Atur alat apa yang boleh dipakai agen untuk akun Anda. Perubahan berlaku mulai run berikutnya,
        bukan pada run yang sedang berjalan.
      </p>

      <div className={CARD}>
        <p className={LABEL}>Keadaan sekarang</p>
        <p className="mt-1 text-slate-100" data-testid="tools-policy-state">
          {data ? modeLabel(data.mode) : 'belum dimuat'}
        </p>
        <p className="mt-1 text-slate-400">
          {data
            ? (data.mode === 'daftar'
              ? 'Agen hanya boleh memakai ' + chosen.length + ' alat yang terdaftar di bawah.'
              : data.mode === 'tanpa_alat'
                ? 'Agen berjalan tanpa alat sama sekali.'
                : 'Belum diatur: agen memakai semua alat bawaan mesin.')
            : 'Menunggu jawaban server…'}
        </p>
        {help ? <p className="mt-2 text-slate-300" data-testid="tools-policy-help">Catatan server: {help}</p> : null}
        {data && data.mode === 'bawaan' ? (
          <p className="mt-2 text-slate-400">
            Kembali ke bawaan mesin belum didukung API: rute PUT hanya menerima daftar nama, daftar
            kosong, atau 'none' (tanpa alat). Jadi halaman ini menampilkan keadaan bawaan tanpa tombol
            pemulihannya.
          </p>
        ) : null}
      </div>

      {loadError ? <p className={ERROR_BOX} data-testid="tools-policy-load-error">{loadError}</p> : null}

      <div className={CARD}>
        <p className={LABEL}>Pilih kebijakan</p>
        <div className="mt-2 flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="tools-policy-mode"
              data-testid="tools-policy-mode-list"
              checked={!sedangTanpaAlat}
              onChange={() => setMode('daftar')}
            />
            Daftar alat
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="tools-policy-mode"
              data-testid="tools-policy-mode-none"
              checked={sedangTanpaAlat}
              onChange={() => setMode('tanpa_alat')}
            />
            Tanpa alat
          </label>
        </div>

        {catalogFilled ? (
          <div className="mt-3" data-testid="tools-policy-catalog">
            <p className="text-slate-400">
              Katalog alat sudah diisi platform. Centang yang boleh dipakai; nama di luar katalog ditolak server.
            </p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.map((name) => (
                <li key={name}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      data-testid={'tools-policy-check-' + name}
                      checked={chosen.includes(name)}
                      onChange={(event) => ubahCentang(name, event.target.checked)}
                    />
                    <span className="font-mono text-xs text-slate-100">{name}</span>
                  </label>
                </li>
              ))}
            </ul>
            {catalog.length === 0 ? <p className="mt-2 text-slate-400">Katalog kosong.</p> : null}
          </div>
        ) : null}

        {/* Isian nama dipakai di dua keadaan: katalog belum diisi (nama bebas) dan katalog sudah
            diisi (nama di luar katalog ditolak server). Validasi tetap milik server. */}
        <div className="mt-3">
          <p className="text-slate-400">
            {catalogFilled
              ? 'Isian manual: nama di luar katalog akan ditolak server dengan kode TOOL_NOT_ALLOWED.'
              : 'Katalog alat masih kosong (nama alat dimiliki mesin), jadi tulis nama satu per satu. Server menerima setiap nama berformat sah selama katalog belum diisi.'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              className={FIELD}
              data-testid="tools-policy-custom-input"
              value={kustom}
              placeholder="mis. baca_berkas"
              onChange={(event) => { setKustom(event.target.value); setKustomError(''); }}
            />
            <button type="button" className={BTN} data-testid="tools-policy-custom-add" onClick={tambahNama}>
              Tambah nama
            </button>
          </div>
          {kustomError ? <p className="mt-1 text-rose-200" data-testid="tools-policy-custom-error">{kustomError}</p> : null}
        </div>

        <div className="mt-3">
          <p className={LABEL}>Daftar yang dipilih ({chosen.length})</p>
          <div className="mt-1 flex flex-wrap gap-2" data-testid="tools-policy-chips">
            {chosen.map((name) => (
              <span key={name} className="flex items-center gap-2 rounded-md border border-slate-600 bg-slate-900/60 px-2 py-1 font-mono text-xs text-slate-100" data-testid={'tools-policy-chip-' + name}>
                {name}
                <button
                  type="button"
                  className="text-rose-200 hover:text-rose-100"
                  title={'Buang ' + name + ' dari daftar'}
                  data-testid={'tools-policy-remove-' + name}
                  onClick={() => buangNama(name)}
                >
                  ✕
                </button>
              </span>
            ))}
            {chosen.length === 0 ? <span className="text-slate-400">Belum ada nama alat yang dipilih.</span> : null}
          </div>
          <p className="mt-2 text-slate-400" data-testid="tools-policy-chars">
            {panjangDaftar} dari {BATAS_KARAKTER} karakter daftar dipakai (hitungan halaman ini; batas resmi
            ada di server).
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_PRIMARY} data-testid="tools-policy-save" disabled={saving} onClick={() => { void simpan(); }}>
            {saving ? 'Menyimpan…' : 'Simpan kebijakan alat'}
          </button>
          <button
            type="button"
            className={BTN}
            data-testid="tools-policy-clear"
            onClick={() => { setChosen([]); setKustom(''); setKustomError(''); setSaveError(''); setSaveUnknown([]); setSaveMessage(''); }}
          >
            Kosongkan daftar
          </button>
        </div>
        <p className="mt-2 text-slate-400">
          "Kosongkan daftar" hanya membersihkan pilihan di layar; server menyimpan daftar kosong sebagai
          "tanpa alat", bukan kembali ke bawaan mesin.
        </p>

        {saveError ? <p className={ERROR_BOX + ' mt-2'} data-testid="tools-policy-error">{saveError}</p> : null}
        {saveUnknown.length > 0 ? (
          <p className="mt-1 font-mono text-xs text-rose-200" data-testid="tools-policy-unknown">
            Ditolak katalog: {saveUnknown.join(', ')}
          </p>
        ) : null}
        {saveMessage ? <p className={OK_BOX + ' mt-2'} data-testid="tools-policy-message">{saveMessage}</p> : null}
      </div>

      {isAdmin ? (
        <div className={CARD} data-testid="tools-policy-admin-catalog">
          <p className={LABEL}>Katalog alat (khusus admin)</p>
          <p className="mt-1 text-slate-400" data-testid="tools-policy-admin-catalog-hint">
            Satu nama per baris (atau pisah dengan koma). Setelah katalog diisi, nama di luar katalog
            ditolak dengan kode TOOL_NOT_ALLOWED. Kosongkan kolom ini dan simpan untuk mengosongkan katalog.
          </p>
          <textarea
            className={FIELD + ' mt-2 w-full min-h-20 font-mono text-xs'}
            data-testid="tools-policy-admin-catalog-input"
            value={katalog}
            onChange={(event) => setKatalog(event.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} data-testid="tools-policy-admin-catalog-save" disabled={katalogBusy} onClick={() => { void simpanKatalog(); }}>
              {katalogBusy ? 'Menyimpan…' : 'Simpan katalog'}
            </button>
            <span className="text-slate-400">Katalog sekarang: {catalog.length} nama.</span>
          </div>
          {katalogError ? <p className={ERROR_BOX + ' mt-2'} data-testid="tools-policy-admin-catalog-error">{katalogError}</p> : null}
          {katalogMessage ? <p className={OK_BOX + ' mt-2'} data-testid="tools-policy-admin-catalog-message">{katalogMessage}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

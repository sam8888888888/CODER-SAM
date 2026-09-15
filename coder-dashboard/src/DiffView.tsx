import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Artifact, DiffLine, DiffResult } from './api';

/** Properti halaman "Pembanding": proyek aktif dan pelapor galat dari induk. */
type Props = {
  projectId?: string | null;
  onError?: (message: string) => void;
};

/** Kelas Tailwind dasar untuk tombol. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar untuk input dan select gelap. */
const FIELD =
  'w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 disabled:opacity-50';
/** Kelas Tailwind untuk kartu panel. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas Tailwind untuk label kecil di atas input. */
const LABEL = 'mb-1 block text-xs uppercase tracking-wide text-slate-400';

/** Jumlah baris konteks yang dikirim ke server: batas server 0-20. */
const CONTEXT_OPTIONS = [0, 1, 3, 5, 10, 20];
const CONTEXT_DEFAULT = 3;

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Paksa nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Format ukuran berkas dalam satuan byte, KB, atau MB. */
function byteText(value: unknown): string {
  const bytes = num(value);
  if (bytes < 1024) return `${bytes} byte`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Format tanggal artefak; nilai kosong atau tidak sah ditulis sebagai tanda hubung. */
function dateText(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '-';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Ubah kode galat pembanding menjadi kalimat Indonesia yang jelas. */
function diffErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code.includes('SAME_ARTIFACT')) return 'Pilih dua artefak yang berbeda.';
  if (code.includes('ARTIFACT_TOO_LARGE')) {
    return 'Artefak terlalu besar untuk dibandingkan. Batas server 400 KB per artefak.';
  }
  if (code.includes('ARTIFACT_FILE_MISSING')) {
    return 'Berkas artefak tidak ada di penyimpanan server, jadi isinya tidak bisa dibaca.';
  }
  if (code.includes('ARTIFACT_NOT_FOUND')) {
    return 'Artefak tidak ditemukan atau bukan milik workspace Anda. Muat ulang daftar artefak.';
  }
  if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN')) {
    return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  }
  return 'Perbandingan gagal diproses. Periksa pilihan artefak, lalu coba lagi.';
}

/** Kelas warna baris diff sesuai jenis barisnya. */
function lineClass(type: DiffLine['type']): string {
  if (type === '-') return 'bg-rose-500/10 text-rose-300';
  if (type === '+') return 'bg-emerald-500/10 text-emerald-300';
  if (type === '@@') return 'bg-slate-800 text-cyan-300';
  return 'text-slate-400';
}

/** Label singkat arti satu baris diff. */
function lineLabel(type: DiffLine['type']): string {
  if (type === '-') return 'dihapus';
  if (type === '+') return 'ditambah';
  if (type === '@@') return 'pemisah blok';
  return 'sama';
}

/**
 * Halaman "Pembanding": bandingkan dua artefak milik satu proyek baris per baris,
 * lengkap dengan ringkasan jumlah baris ditambah, dihapus, dan berubah.
 */
export function DiffView({ projectId, onError }: Props) {
  // Daftar artefak proyek.
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');

  // Pilihan pembanding.
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [context, setContext] = useState(CONTEXT_DEFAULT);

  // Hasil dan galat pembandingan.
  const [comparing, setComparing] = useState(false);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [formError, setFormError] = useState('');

  // Nomor urut permintaan daftar artefak; dipakai untuk mengabaikan respons yang sudah basi.
  const loadSeq = useRef(0);

  /** Catat galat ke halaman ini dan teruskan ke induk supaya bisa ditampilkan di sana. */
  function fail(message: string): void {
    setFormError(message);
    onError?.(message);
  }

  /** Muat ulang daftar artefak proyek dan kosongkan hasil pembandingan. */
  async function loadArtifacts(): Promise<void> {
    if (!projectId) return;
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    setLoading(true);
    setListError('');
    setDiff(null);
    setFormError('');
    try {
      const data = await api.artifacts(projectId);
      // Abaikan respons lama bila pengguna sudah memuat ulang atau berganti proyek.
      if (seq !== loadSeq.current) return;
      const list = Array.isArray(data) ? data : [];
      setArtifacts(list);
      // Pilih dua artefak pertama sebagai bawaan bila pengguna belum memilih.
      setLeftId((current) => (current && list.some((row) => row.id === current) ? current : list[0]?.id ?? ''));
      setRightId((current) => (current && list.some((row) => row.id === current) ? current : list[1]?.id ?? list[0]?.id ?? ''));
    } catch (error) {
      if (seq !== loadSeq.current) return;
      // Jangan tampilkan daftar palsu: kosongkan daftar, lalu beri pesan galat.
      setArtifacts([]);
      setLeftId('');
      setRightId('');
      setListError(diffErrorMessage(error));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  // Muat ulang daftar setiap kali proyek aktif berubah.
  useEffect(() => {
    if (!projectId) {
      setArtifacts([]);
      setLeftId('');
      setRightId('');
      setDiff(null);
      setListError('');
      setFormError('');
      return;
    }
    // Bersihkan pilihan lama supaya artefak proyek sebelumnya tidak ikut terbawa.
    setLeftId('');
    setRightId('');
    setDiff(null);
    void loadArtifacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /** Bandingkan artefak kiri dan kanan dengan jumlah baris konteks yang dipilih. */
  async function compare(): Promise<void> {
    setFormError('');
    if (!projectId) {
      fail('Pilih proyek dulu sebelum membandingkan artefak.');
      return;
    }
    if (!leftId || !rightId) {
      fail('Pilih dua artefak dulu. Daftar artefak proyek ini belum cukup untuk dibandingkan.');
      return;
    }
    if (leftId === rightId) {
      fail('Pilih dua artefak yang berbeda.');
      return;
    }
    setComparing(true);
    setDiff(null);
    try {
      const data = await api.artifactDiff(leftId, rightId, context);
      setDiff(data);
    } catch (error) {
      setDiff(null);
      fail(diffErrorMessage(error));
    } finally {
      setComparing(false);
    }
  }

  // Tanpa proyek aktif, halaman hanya menampilkan arahan singkat.
  if (!projectId) {
    return (
      <section className="space-y-5 text-sm text-slate-300">
        <header className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
          <h2 className="text-base font-semibold text-slate-100">⧎ Pembanding artefak</h2>
          <p className="text-slate-400">Bandingkan dua artefak proyek baris per baris.</p>
        </header>
        <p className={CARD}>Pilih proyek dulu di halaman Proyek, lalu buka Pembanding lagi.</p>
      </section>
    );
  }

  const left = artifacts.find((row) => row.id === leftId) ?? null;
  const right = artifacts.find((row) => row.id === rightId) ?? null;
  const hunks: DiffLine[] = diff && Array.isArray(diff.hunks) ? diff.hunks : [];

  return (
    <section className="space-y-5 text-sm text-slate-300">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
        <div>
          <h2 className="text-base font-semibold text-slate-100">⧎ Pembanding artefak</h2>
          <p className="text-slate-400">
            Bandingkan dua artefak proyek baris per baris. Perbandingan paling akurat untuk artefak teks.
          </p>
        </div>
        <button type="button" className={BTN} onClick={() => void loadArtifacts()} disabled={loading}>
          {loading ? 'Memuat...' : 'Muat ulang artefak'}
        </button>
      </header>

      {listError ? (
        <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300">{listError}</p>
      ) : null}
      {formError ? (
        <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300">{formError}</p>
      ) : null}

      <div className={CARD}>
        {loading ? <p className="text-slate-400">Memuat daftar artefak proyek ini...</p> : null}
        {!loading && artifacts.length === 0 ? (
          <p className="text-slate-400">Belum ada artefak di proyek ini.</p>
        ) : null}

        {!loading && artifacts.length > 0 ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className={LABEL} htmlFor="diff-left">
                  Artefak kiri (lama)
                </label>
                <select
                  id="diff-left"
                  className={FIELD}
                  value={leftId}
                  onChange={(event) => setLeftId(event.target.value)}
                  disabled={comparing}
                >
                  <option value="">Pilih artefak</option>
                  {artifacts.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} · {byteText(row.sizeBytes)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="diff-right">
                  Artefak kanan (baru)
                </label>
                <select
                  id="diff-right"
                  className={FIELD}
                  value={rightId}
                  onChange={(event) => setRightId(event.target.value)}
                  disabled={comparing}
                >
                  <option value="">Pilih artefak</option>
                  {artifacts.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} · {byteText(row.sizeBytes)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="diff-context">
                  Baris konteks
                </label>
                <select
                  id="diff-context"
                  className={FIELD}
                  value={String(context)}
                  onChange={(event) => setContext(num(event.target.value))}
                  disabled={comparing}
                >
                  {CONTEXT_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value} baris
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded-lg border border-violet-500/60 bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                onClick={() => void compare()}
                disabled={comparing || artifacts.length < 2}
              >
                {comparing ? 'Membandingkan...' : 'Bandingkan'}
              </button>
              {artifacts.length < 2 ? (
                <span className="text-slate-400">Perlu minimal dua artefak di proyek ini untuk dibandingkan.</span>
              ) : null}
            </div>

            {left || right ? (
              <p className="text-xs text-slate-500">
                {left ? `Kiri: ${left.name} (${byteText(left.sizeBytes)}, ${dateText(left.createdAt)})` : 'Kiri: belum dipilih'} ·{' '}
                {right ? `Kanan: ${right.name} (${byteText(right.sizeBytes)}, ${dateText(right.createdAt)})` : 'Kanan: belum dipilih'}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={CARD}>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Hasil perbandingan</h3>
        {comparing ? <p className="text-slate-400">Menunggu hasil perbandingan dari server...</p> : null}
        {!comparing && !diff ? (
          <p className="text-slate-400">Belum ada hasil perbandingan. Pilih dua artefak lalu tekan Bandingkan.</p>
        ) : null}

        {diff ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                <p className="text-xs text-emerald-200">Baris ditambah</p>
                <p className="text-emerald-200">{num(diff.added)}</p>
              </div>
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
                <p className="text-xs text-rose-200">Baris dihapus</p>
                <p className="text-rose-200">{num(diff.removed)}</p>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <p className="text-xs text-slate-400">Blok berubah</p>
                <p className="text-slate-100">{num(diff.changes)}</p>
              </div>
            </div>

            <p className="text-xs text-slate-400">
              Kiri: {diff.left?.name ?? '-'} ({num(diff.left?.lines)} baris) · Kanan: {diff.right?.name ?? '-'} (
              {num(diff.right?.lines)} baris) · Konteks {num(context)} baris
            </p>

            {hunks.length === 0 ? (
              <p className="text-slate-400">Tidak ada baris pembeda: isi kedua artefak sama.</p>
            ) : (
              <div className="max-h-[520px] overflow-auto rounded-lg border border-slate-700 bg-slate-900">
                <table className="w-full border-collapse font-mono text-xs">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th className="w-16 px-2 py-1">Kiri</th>
                      <th className="w-16 px-2 py-1">Kanan</th>
                      <th className="w-8 px-2 py-1">Tanda</th>
                      <th className="px-2 py-1">Isi baris</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hunks.map((line, index) => (
                      <tr key={`${index}-${line.type}-${line.left ?? ''}-${line.right ?? ''}`} className={lineClass(line.type)}>
                        <td className="px-2 py-0.5 align-top text-right text-slate-500">
                          {line.type === '+' ? '' : line.left ?? ''}
                        </td>
                        <td className="px-2 py-0.5 align-top text-right text-slate-500">
                          {line.type === '-' ? '' : line.right ?? ''}
                        </td>
                        <td className="px-2 py-0.5 align-top">{line.type === '@@' ? '@@' : line.type}</td>
                        <td className="whitespace-pre-wrap break-words px-2 py-0.5">
                          {line.type === '@@' ? `Pemisah blok: ${line.text}` : line.text || ' '}
                          <span className="sr-only"> ({lineLabel(line.type)})</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

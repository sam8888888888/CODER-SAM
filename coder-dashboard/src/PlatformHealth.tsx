/**
 * Kartu "Kesehatan platform" + tombol "Jalankan uji mandiri" (Wave 11A, butir 53).
 *
 * Sumber data: GET /api/v1/admin/self-audit (khusus admin platform). Jawabannya:
 *   { ranAt, checks: [{ id, judul, status: 'ok'|'warn'|'fail', catatan }], ringkasan: { ok, warn, fail } }
 *
 * Aturan yang dipegang:
 * - Kartu ini TIDAK menambah kolom nilai: hanya id/judul/status/catatan dari server, seperti aslinya.
 *   Server sudah menjamin tidak ada nilai rahasia di `catatan`.
 * - Pengguna bukan admin menerima 403 ADMIN_REQUIRED. Kartu menampilkan kalimat Indonesia dari server
 *   dan tetap melukis seluruh isi halaman (tidak ada layar kosong).
 * - Uji mandiri TIDAK dijalankan otomatis saat halaman dibuka; tombol yang memulainya, karena
 *   pemeriksaan ini membaca basis data.
 *
 * Pemetaan berkas -> API (untuk laporan): PlatformHealth -> GET /api/v1/admin/self-audit.
 */

import { useState } from 'react';
import { api, failureOf } from './api';
import type { SelfAuditCheck, SelfAuditReport } from './api';

/** Properti kartu: pelapor galat dari halaman induk dan status admin pengguna. */
type Props = {
  onError?: (message: string) => void;
  isAdmin?: boolean;
};

/** Kelas tombol sekunder, sama seperti halaman Wave 10/11A. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas kartu isi ringkas. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas kotak galat. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200';

/** Warna dan sebutan tiap status pemeriksaan. */
const STATUS_STYLE: Record<string, { label: string; box: string }> = {
  ok: { label: 'ok', box: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' },
  warn: { label: 'warn', box: 'border-amber-500/40 bg-amber-500/10 text-amber-100' },
  fail: { label: 'fail', box: 'border-rose-500/40 bg-rose-500/10 text-rose-200' },
};

/** Nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

/** Status terburuk dari ringkasan: inilah keadaan yang ditampilkan di kartu. */
function statusTerburuk(ringkasan: { ok: number; warn: number; fail: number } | undefined): 'ok' | 'warn' | 'fail' {
  if (!ringkasan || num(ringkasan.fail) > 0) return 'fail';
  if (num(ringkasan.warn) > 0) return 'warn';
  return 'ok';
}

/** Daftar pemeriksaan yang dikirim server; baris tanpa bentuk yang dikenal tetap ditampilkan. */
function daftarPeriksa(report: SelfAuditReport | null): SelfAuditCheck[] {
  return Array.isArray(report?.checks) ? report!.checks : [];
}

/** Nama status yang aman dipakai sebagai penanda data-status. */
function statusAman(value: unknown): string {
  const code = String(value ?? '').trim();
  return code === 'ok' || code === 'warn' || code === 'fail' ? code : 'tidak-diketahui';
}

export function PlatformHealth({ onError, isAdmin }: Props) {
  const [report, setReport] = useState<SelfAuditReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  /**
   * Jalankan uji mandiri di server.
   * Galat 403 dijawab dengan kalimat Indonesia dari server; sisanya memakai kalimat cadangan yang jujur.
   */
  async function jalankan(): Promise<void> {
    setRunning(true);
    setError('');
    try {
      const hasil = await api.selfAudit();
      setReport(hasil ?? null);
    } catch (caught) {
      setReport(null);
      const gagal = failureOf(caught);
      const kode = (gagal.code + ' ' + gagal.message).toUpperCase();
      let message: string;
      if (gagal.status === 403 || kode.includes('ADMIN_REQUIRED')) {
        message = gagal.message || 'Hanya admin platform yang boleh menjalankan uji mandiri.';
      } else if (gagal.status === 404 || gagal.status === 501 || kode.includes('NOT_IMPLEMENTED')) {
        message = 'Rute audit-diri platform belum tersedia di server ini (menunggu API Wave 11A).';
      } else if (gagal.status === 401 || kode.includes('UNAUTHORIZED') || kode.includes('UNAUTHENTICATED')) {
        message = 'Sesi Anda sudah berakhir, jadi uji mandiri tidak bisa dijalankan. Silakan masuk ulang.';
      } else {
        message = gagal.message || 'Uji mandiri gagal dijalankan (kode ' + gagal.code + ').';
      }
      setError(message);
      onError?.(message);
    } finally {
      setRunning(false);
    }
  }

  const checks = daftarPeriksa(report);
  const ringkasan = report?.ringkasan ?? { ok: 0, warn: 0, fail: 0 };
  const terburuk = statusTerburuk(report?.ringkasan);

  return (
    <div
      className={CARD}
      data-testid="platform-health"
      data-status={report ? terburuk : 'belum'}
      data-checks={checks.length}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={LABEL}>Kesehatan platform (uji mandiri)</p>
        <button type="button" className={BTN} data-testid="health-run" disabled={running} onClick={() => { void jalankan(); }}>
          {running ? 'Menjalankan…' : 'Jalankan uji mandiri'}
        </button>
      </div>

      <p className="mt-1 text-slate-400">
        Memeriksa kredensial, konfigurasi, dan basis data dari sisi server. Laporan hanya memuat jumlah,
        nama pemeriksaan, dan keadaan konfigurasi — nilai rahasia tidak pernah dikirim ke halaman ini.
        {isAdmin === false ? ' Akun Anda bukan admin platform, jadi tombol ini akan dijawab 403 oleh server.' : ''}
      </p>

      {error ? <p className={ERROR_BOX + ' mt-2'} data-testid="platform-health-message">{error}</p> : null}

      {report ? (
        <div className="mt-2 space-y-2">
          <p className="text-slate-300" data-testid="platform-health-ran-at">
            Uji dijalankan {dateTimeText(report.ranAt)} · ringkasan:
            <span data-testid="health-count-ok" className="ml-1"> ok {num(ringkasan.ok)}</span>,
            <span data-testid="health-count-warn" className="ml-1"> warn {num(ringkasan.warn)}</span>,
            <span data-testid="health-count-fail" className="ml-1"> fail {num(ringkasan.fail)}</span>
          </p>
          <ul className="space-y-1">
            {checks.map((item, index) => {
              const status = statusAman(item.status);
              const gaya = STATUS_STYLE[status] ?? { label: status, box: 'border-slate-600 bg-slate-900/60 text-slate-200' };
              return (
                <li
                  key={String(item.id ?? index)}
                  className={'rounded-md border px-2 py-1 ' + gaya.box}
                  data-testid={'health-check-' + String(item.id ?? index)}
                  data-status={status}
                >
                  <span className="font-semibold">{String(item.judul ?? item.id ?? 'pemeriksaan')}</span>
                  <span className="ml-2 font-mono text-xs">{gaya.label}</span>
                  <span className="ml-2 text-slate-100">{String(item.catatan ?? '')}</span>
                </li>
              );
            })}
          </ul>
          {checks.length === 0 ? <p className="text-slate-400">Server mengirim laporan tanpa butir pemeriksaan.</p> : null}
        </div>
      ) : (!error ? <p className="mt-2 text-slate-400">Belum dijalankan. Tekan "Jalankan uji mandiri" untuk meminta laporan.</p> : null)}
    </div>
  );
}

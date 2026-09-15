import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { PublicPackage, PublicPricing as PublicPricingData } from './api';

/** Kelas Tailwind dasar tombol sekunder, sama dengan halaman lain. */
const BTN =
  'rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50';
/** Kelas Tailwind dasar tombol utama (aksi masuk atau daftar). */
const BTN_PRIMARY =
  'rounded-lg border border-violet-500 bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-500';
/** Kelas pembungkus kartu paket dan panel ringkas. */
const CARD = 'rounded-lg border border-slate-700 bg-slate-800/60 p-3';
/** Kelas label kecil di atas nilai. */
const LABEL = 'text-xs uppercase tracking-wide text-slate-400';
/** Kelas kotak galat, sama dengan kotak galat halaman Billing. */
const ERROR_BOX = 'rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300';

/** Pemformat rupiah tanpa desimal. */
const RUPIAH = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });

/** Paksa nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ubah nilai apa pun menjadi teks yang sudah dipangkas. */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

/** Harga dalam rupiah, contoh "Rp 99.000". */
function rupiahText(value: unknown): string {
  return RUPIAH.format(num(value));
}

/** Angka dengan pemisah ribuan Indonesia. */
function numberText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Teks batas token; batas 0 berarti tanpa batas menurut aturan server. */
function limitText(value: unknown): string {
  const limit = num(value);
  return limit <= 0 ? 'tanpa batas' : numberText(limit) + ' token';
}

/** Teks masa berlaku paket. */
function periodText(value: unknown): string {
  const days = num(value);
  return days > 0 ? numberText(days) + ' hari' : 'periode tidak dicantumkan';
}

/** Baca satu butir fitur yang boleh berupa teks atau objek ringkas. */
function featureText(item: unknown): string {
  const plain = text(item);
  if (plain && plain !== '[object Object]') return plain;
  if (item && typeof item === 'object') {
    const row = item as Record<string, unknown>;
    return text(row.label) || text(row.name) || text(row.title) || JSON.stringify(row);
  }
  return '';
}

/**
 * Daftar fitur paket. Server dapat mengirim array teks, teks JSON
 * (contoh '["A","B"]'), atau teks biasa berpemisah baris/semicolon.
 * Semua bentuk itu ditangani supaya halaman tidak pernah gagal render.
 */
function featureList(features: unknown): string[] {
  if (Array.isArray(features)) {
    return features.map(featureText).filter((item) => item.length > 0);
  }
  // Selain array, hanya teks yang bisa dipecah; bentuk lain (angka, objek) diabaikan.
  if (typeof features !== 'string') return [];
  const raw = text(features);
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(featureText).filter((item) => item.length > 0);
    } catch {
      // Teks bukan JSON yang sah; di bawah nanti dipecah sebagai teks biasa.
    }
  }
  const pieces = raw
    .split(/[\r\n;|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (pieces.length === 1 && pieces[0].includes(', ')) {
    return pieces[0]
      .split(', ')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return pieces;
}

/** Ubah kode galat server menjadi kalimat Indonesia yang jelas. */
function pricingErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
    return 'Tidak dapat menghubungi server. Periksa koneksi Anda, lalu muat ulang halaman ini.';
  }
  if (code.includes('NOT_FOUND') || code.includes('404')) {
    return 'Daftar paket belum tersedia di server ini. Hubungi admin platform untuk informasi harga.';
  }
  if (code.includes('500') || code.includes('INTERNAL')) {
    return 'Server sedang bermasalah saat membaca daftar paket. Coba lagi beberapa saat lagi.';
  }
  return 'Gagal memuat daftar paket. Coba muat ulang beberapa saat lagi.';
}

/**
 * Halaman harga publik.
 *
 * Halaman ini dibuka sebelum pengguna punya sesi, jadi hanya memanggil
 * api.publicPlans() dan tidak menyentuh data akun. Isinya: nama merek dari
 * branding, kartu paket (harga, periode, batas token, bonus, fitur), kurs
 * USD ke IDR, status gateway pembayaran, dan tombol masuk atau kembali.
 */
export function PublicPricing({ onRequireLogin, onClose }: { onRequireLogin?: () => void; onClose?: () => void }) {
  const [data, setData] = useState<PublicPricingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Catat pesan galat di halaman ini.
   *
   * Tanda tangan komponen ini hanya menerima onRequireLogin dan onClose, jadi
   * galat ditampilkan sebagai kotak galat di dalam halaman ini, bukan diteruskan
   * ke induk halaman. Galat tidak pernah ditelan: semuanya masuk ke state error.
   */
  const fail = useCallback((message: string): void => {
    setError(message);
  }, []);

  /** Ambil daftar paket publik dari server. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await api.publicPlans();
      setData(result ?? null);
    } catch (caught) {
      // Hapus data lama supaya harga tidak tampak masih baru saat pemuatan gagal.
      setData(null);
      fail(pricingErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const branding = data?.branding;
  const brandName = text(branding?.name) || text(branding?.appName) || 'COBLAI Coder';
  const tagline = text(branding?.tagline);
  const supportEmail = text(branding?.supportEmail);
  const gateways = data?.gateways;
  const currency = text(data?.currency) || 'IDR';
  const rate = num(data?.usdToIdrRate);
  const plans: PublicPackage[] = Array.isArray(data?.plans) ? data.plans : [];
  const plansLoading = loading && !data;

  // Penanda paket dihitung dari data server, bukan dari klaim tambahan.
  const prices = plans.map((plan) => num(plan.priceIdr));
  const quotas = plans.map((plan) => num(plan.monthlyTokenLimit));
  const cheapestPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const biggestQuota = quotas.length > 0 ? Math.max(...quotas) : 0;
  const priceVaries = prices.length > 1 && Math.max(...prices) !== cheapestPrice;
  const quotaVaries = quotas.length > 1 && biggestQuota > 0 && Math.min(...quotas) !== biggestQuota;

  return (
    <div className="page-shell-inner">
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-slate-300">
        <div>
          <p className="eyebrow text-slate-400">HARGA PAKET</p>
          <h2 className="text-base font-semibold text-slate-100">{brandName}</h2>
          <p className="text-slate-400">{tagline || 'Daftar paket dan cara pembayaran platform.'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={loading} onClick={() => { void load(); }}>
            {loading ? 'Memuat…' : 'Muat ulang'}
          </button>
          {onRequireLogin ? (
            <button type="button" className={BTN_PRIMARY} onClick={() => onRequireLogin()}>
              Masuk / Daftar
            </button>
          ) : null}
          {onClose ? (
            <button type="button" className={BTN} onClick={() => onClose()}>
              Kembali
            </button>
          ) : null}
        </div>
      </header>

      <p className="settings-hint">
        Halaman ini dapat dibuka tanpa akun. Harga dan kuota di bawah diambil langsung dari server platform.
      </p>

      {error ? <p role="alert" className={ERROR_BOX}>{error}</p> : null}
      {plansLoading ? <p className="settings-hint">Memuat daftar paket…</p> : null}

      {!plansLoading && !error && plans.length === 0 ? (
        <p className="settings-hint">Belum ada paket yang ditampilkan server. Hubungi admin platform untuk informasi harga.</p>
      ) : null}

      {plans.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-100">Daftar paket</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {plans.map((plan, index) => {
              const features = featureList(plan.features);
              const code = text(plan.code) || 'paket-' + String(index + 1);
              const marks: string[] = [];
              if (priceVaries && num(plan.priceIdr) === cheapestPrice) marks.push('Harga termurah');
              if (quotaVaries && num(plan.monthlyTokenLimit) === biggestQuota) marks.push('Kuota bulanan terbesar');
              return (
                <article key={code} className={CARD + ' flex flex-col'}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold text-slate-100">{text(plan.name) || code}</h4>
                    {marks.map((mark) => (
                      <span key={mark} className="badge">{mark}</span>
                    ))}
                  </div>
                  {text(plan.description) ? <p className="mt-1 text-slate-400">{text(plan.description)}</p> : null}
                  {text(plan.tier) ? <p className="mt-1 text-slate-400">Kelas paket: {text(plan.tier)}</p> : null}
                  <p className="mt-2 text-lg font-semibold text-slate-100">{rupiahText(plan.priceIdr)}</p>
                  <p className="text-slate-400">Berlaku {periodText(plan.periodDays)}</p>
                  <ul className="mt-2 space-y-1 text-slate-300">
                    <li>Batas token harian: {limitText(plan.dailyTokenLimit)}</li>
                    <li>Batas token bulanan: {limitText(plan.monthlyTokenLimit)}</li>
                    <li>
                      Bonus token: {num(plan.bonusTokens) > 0 ? numberText(plan.bonusTokens) + ' token' : 'tidak ada bonus token'}
                    </li>
                  </ul>
                  <p className="mt-3 text-slate-400">Fitur paket:</p>
                  {features.length > 0 ? (
                    <ul className="mt-1 list-inside list-disc space-y-1 text-slate-300">
                      {features.map((feature, featureIndex) => (
                        <li key={code + '-fitur-' + String(featureIndex)}>{feature}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-slate-400">Server belum mencantumkan rincian fitur untuk paket ini.</p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className={CARD}>
        <h3 className="mb-2 text-sm font-semibold text-slate-100">Status pembayaran</h3>
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge">
            {gateways ? 'Xendit: ' + (gateways.xendit ? 'aktif' : 'nonaktif') : 'Xendit: tidak diketahui'}
          </span>
          <span className="badge">
            {gateways ? 'Midtrans: ' + (gateways.midtrans ? 'aktif' : 'nonaktif') : 'Midtrans: tidak diketahui'}
          </span>
          <span className="badge">
            {gateways ? 'Transfer manual: ' + (gateways.manualTransfer ? 'tersedia' : 'tidak tersedia') : 'Transfer manual: tidak diketahui'}
          </span>
        </div>
        {gateways ? (
          <p className="mt-2 text-slate-300">
            {gateways.xendit || gateways.midtrans
              ? 'Pembayaran daring dapat dipakai untuk paket berbayar. Transfer manual juga masih dilayani.'
              : 'Pembayaran daring belum aktif saat ini, jadi pembayaran lewat transfer manual menunggu verifikasi admin.'}
            {gateways.xendit || gateways.midtrans || gateways.manualTransfer
              ? ''
              : ' Belum ada cara pembayaran yang aktif; hubungi admin platform sebelum memesan paket.'}
          </p>
        ) : (
          <p className="mt-2 text-slate-400">Status gateway pembayaran belum dapat dibaca dari server.</p>
        )}
        {supportEmail ? <p className="settings-hint">Bantuan pembayaran: {supportEmail}</p> : null}
      </section>

      <p className="settings-hint">
        Kurs acuan server: 1 USD = {rate > 0 ? numberText(rate) + ' IDR' : 'belum tersedia'}.
        {data ? ' Mata uang tagihan: ' + currency + '.' : ''}
      </p>
    </div>
  );
}

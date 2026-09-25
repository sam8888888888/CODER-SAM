import { useEffect, useState } from 'react';
import { api, failureOf } from './api';
import type { Plan, BillingOrder, ManualQueueResponse, UniqueAmountResponse } from './api';

type Props = {
  onError?: (message: string) => void;
  // Butir 74: antrean nominal unik hanya boleh dibaca admin platform (server menjawab 403 selain admin),
  // jadi permintaannya pun hanya dikirim kalau penanda ini benar.
  isAdmin?: boolean;
};

/** Batas ukuran berkas bukti transfer yang boleh diunggah pengguna. */
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

/** Pilihan masa berlangganan yang disediakan halaman ini (dalam bulan). */
const MONTH_OPTIONS = [1, 3, 6, 12];

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Paksa nilai apa pun menjadi angka aman supaya tampilan tidak pernah memuat NaN. */
function num(v: unknown): number {
  const parsed = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Format rupiah dengan pemisah ribuan Indonesia. */
function rupiah(value: unknown): string {
  return 'Rp' + num(value).toLocaleString('id-ID');
}

/** Format tanggal Indonesia; nilai kosong ditulis sebagai tanda hubung. */
function dateText(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('id-ID');
}

/** Format jumlah token dengan pemisah ribuan Indonesia. */
function tokenText(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Teks kuota: batas 0 berarti kuota tanpa batas. */
function quotaText(used: unknown, limit: unknown): string {
  const lim = num(limit);
  if (lim === 0) return `${tokenText(used)} token (tanpa batas)`;
  return `${tokenText(used)} dari ${tokenText(lim)} token`;
}

/** Persentase bilah kuota, dibatasi 0-100 dan tidak pernah NaN. */
function quotaPercent(used: unknown, limit: unknown): number {
  const lim = num(limit);
  if (lim <= 0) return 0;
  const percent = (num(used) / lim) * 100;
  return Math.min(100, Math.max(0, percent));
}

/** Ubah kode galat server menjadi kalimat Indonesia yang jelas. */
function actionErrorMessage(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code.includes('INVALID_COUPON') || code.includes('COUPON_NOT_FOUND')) return 'Kode kupon tidak dikenal atau sudah kedaluwarsa.';
  if (code.includes('COUPON_USED_UP') || code.includes('COUPON_LIMIT')) return 'Kode kupon sudah mencapai batas pemakaian.';
  if (code.includes('INVALID_PLAN')) return 'Paket yang Anda pilih tidak tersedia. Silakan muat ulang halaman ini.';
  if (code.includes('INVALID_MONTHS')) return 'Masa berlangganan tidak valid. Pilih 1, 3, 6, atau 12 bulan.';
  if (code.includes('INVALID_FILE') || code.includes('FILE_TOO_LARGE')) return 'Berkas bukti transfer ditolak server. Gunakan gambar atau PDF di bawah 5 MB.';
  if (code.includes('NOT_FOUND') || code.includes('ORDER_NOT_FOUND')) return 'Pesanan tidak ditemukan. Muat ulang halaman ini.';
  if (code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN')) return 'Sesi Anda sudah berakhir. Silakan masuk kembali.';
  return fallback;
}

/** Warna badge status pesanan pada tabel. */
function statusClass(status: BillingOrder['status']): string {
  if (status === 'paid') return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
  if (status === 'pending') return 'bg-amber-500/15 text-amber-300 border border-amber-500/30';
  if (status === 'rejected') return 'bg-rose-500/15 text-rose-300 border border-rose-500/30';
  return 'bg-slate-500/15 text-slate-300 border border-slate-500/30';
}

/** Label status pesanan dalam Bahasa Indonesia. */
function statusLabel(status: string): string {
  if (status === 'paid') return 'Dibayar';
  if (status === 'pending') return 'Menunggu pembayaran';
  if (status === 'rejected') return 'Ditolak';
  if (status === 'cancelled') return 'Dibatalkan';
  return 'Status tidak dikenal';
}

/** Harga paket: paket harga 0 ditulis "Gratis". */
function priceText(value: unknown): string {
  const price = num(value);
  return price === 0 ? 'Gratis' : `${rupiah(price)}/bulan`;
}

/** Baca berkas pilihan pengguna menjadi base64 tanpa awalan data URL. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const base64 = comma >= 0 ? result.slice(comma + 1) : '';
      if (!base64) {
        reject(new Error('FILE_READ_FAILED'));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Halaman "Paket & Billing" untuk pengguna biasa.
 * Menampilkan kuota token, daftar paket, cara pembayaran, pesanan pengguna,
 * serta riwayat kredit token. Semua aksi server dibungkus try/catch dan
 * pesan galat ditampilkan di dalam halaman ini.
 */
export function Billing({ onError, isAdmin = false }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [tier, setTier] = useState('');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ usedToday: number; usedMonth: number; dailyLimit: number; monthlyLimit: number; creditTokens: number } | null>(null);
  const [banks, setBanks] = useState<{ id: string; bankName: string; accountNumber: string; accountHolder: string; note: string }[]>([]);
  const [instructions, setInstructions] = useState('');
  const [creditHistory, setCreditHistory] = useState<{ id: string; tokens: number; reason: string; note: string; createdAt: string }[]>([]);

  const [loadBusy, setLoadBusy] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const [selectedCode, setSelectedCode] = useState('');
  const [months, setMonths] = useState(1);
  const [couponCode, setCouponCode] = useState('');
  const [couponInfo, setCouponInfo] = useState<{ code: string; discountIdr: number; percent: number } | null>(null);
  const [couponNote, setCouponNote] = useState('');
  const [proofFiles, setProofFiles] = useState<Record<string, File | null>>({});

  // Butir 74: nominal unik. Server TIDAK mengirim kolom ini di daftar pesanan, jadi nilai per pesanan
  // hanya dipegang di sini setelah tombol "Pasang nominal unik" dijawab server (atau dari antrean admin).
  const [nominal, setNominal] = useState<Record<string, UniqueAmountResponse>>({});
  const [antrean, setAntrean] = useState<ManualQueueResponse | null>(null);
  const [antreanBusy, setAntreanBusy] = useState(false);
  const [antreanHasil, setAntreanHasil] = useState<{ diisi: number; gagal: number } | null>(null);
  const [unikBusy, setUnikBusy] = useState<string>('');

  /** Butir 74: minta nominal unik untuk satu pesanan transfer manual. */
  async function pasangNominalUnik(orderId: string) {
    setUnikBusy(orderId);
    setError('');
    setOk('');
    try {
      const jawaban = await api.billingUniqueAmount(orderId);
      setNominal((lama) => ({ ...lama, [orderId]: jawaban }));
      setOk(`Nominal unik dipasang: transfer ${rupiah(jawaban.order.nominalBayarIdr)} (tagihan tidak berubah: ${rupiah(jawaban.order.totalIdr)}).`);
    } catch (e) {
      const detail = failureOf(e);
      reportError(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setUnikBusy('');
    }
  }

  /** Butir 74 (admin): baca antrean pesanan transfer manual beserta nominal uniknya. */
  async function muatAntrean() {
    setAntreanBusy(true);
    setError('');
    try {
      const jawaban = await api.billingManualQueue();
      setAntrean(jawaban);
    } catch (e) {
      const detail = failureOf(e);
      reportError(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setAntreanBusy(false);
    }
  }

  /** Butir 74 (admin): isi nominal unik untuk seluruh pesanan yang belum punya. */
  async function isiAntrean() {
    setAntreanBusy(true);
    setError('');
    setOk('');
    try {
      const jawaban = await api.billingFillManualQueue();
      setAntreanHasil({ diisi: num(jawaban.diisi), gagal: num(jawaban.gagal) });
      setOk(`Antrean diproses: ${num(jawaban.diisi)} nominal diisi, ${num(jawaban.gagal)} gagal.`);
      await muatAntrean();
    } catch (e) {
      const detail = failureOf(e);
      reportError(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setAntreanBusy(false);
    }
  }

  /** Tampilkan galat di dalam halaman sekaligus laporkan ke induk. */
  function reportError(message: string) {
    setError(message);
    setOk('');
    onError?.(message);
  }

  /** Muat seluruh data billing pengguna (paket, kuota, pesanan, riwayat kredit). */
  async function loadAll(initial: boolean) {
    if (initial) setLoadBusy(true);
    try {
      const me = await api.billingMe();
      setTier(String(me?.tier ?? ''));
      setExpiresAt(me?.subscription?.expiresAt ?? null);
      const q = me?.quota;
      setQuota(q ? {
        usedToday: num(q.usedToday),
        usedMonth: num(q.usedMonth),
        dailyLimit: num(q.dailyLimit),
        monthlyLimit: num(q.monthlyLimit),
        creditTokens: num(q.creditTokens),
      } : null);
      setOrders(Array.isArray(me?.orders) ? me.orders : []);
      setBanks((Array.isArray(me?.banks) ? me.banks : []).map((bank) => ({
        id: String(bank?.id ?? ''),
        bankName: String(bank?.bankName ?? ''),
        accountNumber: String(bank?.accountNumber ?? ''),
        accountHolder: String(bank?.accountHolder ?? ''),
        note: String(bank?.note ?? ''),
      })));
      setInstructions(String(me?.payment?.instructions ?? ''));
      setCreditHistory((Array.isArray(me?.creditHistory) ? me.creditHistory : []).map((row) => ({
        id: String(row?.id ?? ''),
        tokens: num(row?.tokens),
        reason: String(row?.reason ?? ''),
        note: String(row?.note ?? ''),
        createdAt: String(row?.createdAt ?? ''),
      })));
      setError('');
    } catch (e) {
      reportError(actionErrorMessage(e, 'Gagal memuat data paket dan tagihan. Periksa koneksi Anda lalu coba lagi.'));
    } finally {
      if (initial) setLoadBusy(false);
    }
  }

  // Muat data pertama kali halaman dibuka.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await api.plans();
        if (!active) return;
        setPlans(Array.isArray(data?.plans) ? data.plans : []);
      } catch (e) {
        if (active) reportError(actionErrorMessage(e, 'Gagal memuat daftar paket. Coba lagi sebentar lagi.'));
      }
      if (!active) return;
      await loadAll(true);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Buka atau tutup form pemesanan untuk satu paket. */
  function togglePlan(plan: Plan) {
    setError('');
    setOk('');
    setCouponInfo(null);
    setCouponNote('');
    setCouponCode('');
    setSelectedCode((current) => (current === plan.code ? '' : plan.code));
    setMonths(1);
  }

  /** Validasi kode kupon untuk paket dan masa berlangganan yang sedang dipilih. */
  async function applyCoupon(plan: Plan) {
    const code = couponCode.trim();
    if (!code) {
      setCouponNote('Masukkan kode kupon terlebih dahulu.');
      setCouponInfo(null);
      return;
    }
    setBusy(`coupon-${plan.code}`);
    setCouponNote('');
    setError('');
    try {
      const result = await api.validateCoupon(code, num(plan.priceIdr) * months);
      const discountIdr = num(result?.discountIdr);
      setCouponInfo({ code: String(result?.code ?? code), discountIdr, percent: num(result?.percent) });
      setCouponNote(`Kupon ${String(result?.code ?? code)} memberi potongan ${rupiah(discountIdr)}.`);
    } catch (e) {
      setCouponInfo(null);
      reportError(actionErrorMessage(e, 'Kode kupon tidak dapat dipakai. Periksa kembali kode Anda.'));
    } finally {
      setBusy(null);
    }
  }

  /** Buat pesanan langganan, lalu muat ulang data agar instruksi pembayaran tampil. */
  async function createOrder(plan: Plan) {
    setBusy(`order-${plan.code}`);
    setError('');
    setOk('');
    try {
      const created = await api.createOrder(plan.code, months, couponCode.trim() || undefined);
      const order = created?.order;
      const total = rupiah(order?.totalIdr);
      setOk(`Pesanan ${String(order?.planCode ?? plan.code)} untuk ${num(order?.months) || months} bulan berhasil dibuat. Total yang harus dibayar ${total}. Silakan selesaikan pembayaran sesuai instruksi di bawah.`);
      setCouponInfo(null);
      setCouponCode('');
      setCouponNote('');
      setSelectedCode('');
      await loadAll(false);
    } catch (e) {
      reportError(actionErrorMessage(e, 'Pesanan gagal dibuat. Silakan coba lagi.'));
    } finally {
      setBusy(null);
    }
  }

  /** Unggah bukti transfer untuk satu pesanan yang masih menunggu pembayaran. */
  async function uploadProof(order: BillingOrder) {
    const file = proofFiles[order.id] ?? null;
    if (!file) {
      reportError('Pilih berkas bukti transfer terlebih dahulu.');
      return;
    }
    if (file.size > MAX_PROOF_BYTES) {
      reportError('Ukuran berkas maksimal 5 MB.');
      return;
    }
    setBusy(`proof-${order.id}`);
    setError('');
    setOk('');
    try {
      const base64 = await readFileAsBase64(file);
      await api.uploadOrderProof(order.id, file.name, base64);
      setProofFiles((current) => ({ ...current, [order.id]: null }));
      setOk('Bukti transfer terkirim. Menunggu pemeriksaan admin.');
      await loadAll(false);
    } catch (e) {
      reportError(actionErrorMessage(e, 'Gagal mengunggah bukti transfer. Coba lagi.'));
    } finally {
      setBusy(null);
    }
  }

  /** Salin nomor rekening ke papan klip pengguna. */
  async function copyAccount(accountNumber: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        reportError('Peramban Anda tidak mendukung penyalinan otomatis. Silakan salin nomor rekening secara manual.');
        return;
      }
      await navigator.clipboard.writeText(accountNumber);
      setError('');
      setOk('Nomor rekening sudah disalin ke papan klip.');
    } catch {
      reportError('Nomor rekening gagal disalin. Silakan salin secara manual.');
    }
  }

  const disabledAll = busy !== null;
  const selectedPlan = plans.find((plan) => plan.code === selectedCode) ?? null;
  const previewAmount = selectedPlan ? num(selectedPlan.priceIdr) * months : 0;
  const previewTotal = selectedPlan ? Math.max(0, previewAmount - num(couponInfo?.discountIdr)) : 0;
  // Butir 74: hanya pesanan pending yang relevan untuk nominal unik.
  const pesananPending = orders.filter((order) => order.status === 'pending');

  return (
    <section className="space-y-5 text-sm text-slate-300">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Paket &amp; Billing</h2>
          <p className="text-slate-400">Kelola paket langganan, kuota token, dan pembayaran Anda.</p>
        </div>
        <button
          type="button"
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 disabled:opacity-50"
          disabled={loadBusy || disabledAll}
          onClick={() => { void loadAll(true); }}
        >
          {loadBusy ? 'Memuat…' : 'Muat ulang data'}
        </button>
      </header>

      {error ? <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300">{error}</p> : null}
      {ok ? <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-300">{ok}</p> : null}

      {/* 1. Ringkasan kuota token pengguna. */}
      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
        <h3 className="mb-2 font-semibold text-slate-100">Ringkasan kuota</h3>
        {loadBusy ? (
          <p className="text-slate-400">Memuat ringkasan kuota…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-slate-400">Paket aktif</p>
              <p className="text-slate-100">{tier || 'Paket belum ditentukan'}</p>
            </div>
            <div>
              <p className="text-slate-400">Masa berlaku sampai</p>
              <p className="text-slate-100">{dateText(expiresAt)}</p>
            </div>
            <div>
              <p className="text-slate-400">Saldo kredit token</p>
              <p className="text-slate-100">{tokenText(quota?.creditTokens)} token</p>
            </div>
            <div>
              <p className="text-slate-400">Status akses</p>
              <p className="text-slate-100">{quota && quota.dailyLimit === 0 && quota.monthlyLimit === 0 ? 'Tanpa batas' : 'Sesuai kuota paket'}</p>
            </div>

            <div className="sm:col-span-2">
              <p className="text-slate-400">Kuota hari ini</p>
              <p className="text-slate-100">{quotaText(quota?.usedToday, quota?.dailyLimit)}</p>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-lg bg-slate-900">
                <div className="h-2 rounded-lg bg-violet-500" style={{ width: `${quotaPercent(quota?.usedToday, quota?.dailyLimit)}%` }} />
              </div>
            </div>

            <div className="sm:col-span-2">
              <p className="text-slate-400">Kuota bulan ini</p>
              <p className="text-slate-100">{quotaText(quota?.usedMonth, quota?.monthlyLimit)}</p>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-lg bg-slate-900">
                <div className="h-2 rounded-lg bg-cyan-500" style={{ width: `${quotaPercent(quota?.usedMonth, quota?.monthlyLimit)}%` }} />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 2. Tiga kartu paket beserta form pemesanan. */}
      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
        <h3 className="mb-2 font-semibold text-slate-100">Pilihan paket</h3>
        {plans.length === 0 && !loadBusy ? <p className="text-slate-400">Belum ada paket yang tersedia.</p> : null}
        <div className="grid gap-3 md:grid-cols-3">
          {plans.map((plan) => {
            const isSelected = plan.code === selectedCode;
            return (
              <article key={plan.code} className={`rounded-lg border bg-slate-900 p-3 ${isSelected ? 'border-violet-500' : 'border-slate-700'}`}>
                <h4 className="font-semibold text-slate-100">{String(plan.name ?? plan.code)}</h4>
                <p className="mt-1 text-slate-400">{String(plan.description ?? '')}</p>
                <p className="mt-2 font-semibold text-slate-100">{priceText(plan.priceIdr)}</p>
                <ul className="mt-2 list-inside list-disc space-y-1 text-slate-400">
                  {(Array.isArray(plan.features) ? plan.features : []).map((feature, index) => (
                    <li key={`${plan.code}-${index}`}>{String(feature)}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="mt-3 w-full rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 font-semibold text-white disabled:opacity-50"
                  disabled={disabledAll}
                  onClick={() => togglePlan(plan)}
                >
                  {isSelected ? 'Tutup form pesanan' : 'Pilih paket'}
                </button>
                {isSelected ? (
                  <div className="mt-3 space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
                    <label className="block text-slate-300" htmlFor={`months-${plan.code}`}>
                      Masa berlangganan
                    </label>
                    <select
                      id={`months-${plan.code}`}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
                      value={months}
                      disabled={disabledAll}
                      onChange={(event) => {
                        setMonths(num(event.target.value) || 1);
                        setCouponInfo(null);
                        setCouponNote('');
                      }}
                    >
                      {MONTH_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option} bulan</option>
                      ))}
                    </select>

                    <label className="block text-slate-300" htmlFor={`coupon-${plan.code}`}>
                      Kode kupon (opsional)
                    </label>
                    <input
                      id={`coupon-${plan.code}`}
                      type="text"
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
                      placeholder="Contoh: HEMAT10"
                      value={couponCode}
                      disabled={disabledAll}
                      onChange={(event) => {
                        setCouponCode(event.target.value);
                        setCouponInfo(null);
                        setCouponNote('');
                      }}
                    />
                    <button
                      type="button"
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 disabled:opacity-50"
                      disabled={disabledAll}
                      onClick={() => { void applyCoupon(plan); }}
                    >
                      {busy === `coupon-${plan.code}` ? 'Memeriksa kupon…' : 'Pakai kupon'}
                    </button>
                    {couponNote ? <p className="text-slate-400">{couponNote}</p> : null}

                    <p className="text-slate-400">
                      Harga {rupiah(previewAmount)} − potongan {rupiah(couponInfo?.discountIdr)} = perkiraan total {rupiah(previewTotal)}
                    </p>
                    <button
                      type="button"
                      className="w-full rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 font-semibold text-white disabled:opacity-50"
                      disabled={disabledAll}
                      onClick={() => { void createOrder(plan); }}
                    >
                      {busy === `order-${plan.code}` ? 'Membuat pesanan…' : 'Buat pesanan'}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      {/* 3. Instruksi pembayaran dan daftar rekening bank. */}
      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
        <h3 className="mb-2 font-semibold text-slate-100">Cara bayar</h3>
        <p className="text-slate-300">{instructions || 'Instruksi pembayaran belum diatur admin. Hubungi admin platform untuk cara pembayaran.'}</p>
        {banks.length === 0 ? (
          <p className="mt-2 text-slate-400">Belum ada rekening bank yang terdaftar.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Bank</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Nomor rekening</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Atas nama</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Catatan</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((bank) => (
                  <tr key={bank.id || bank.accountNumber} className="text-slate-300">
                    <td className="border-b border-slate-700/60 px-3 py-2">{bank.bankName || '—'}</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">{bank.accountNumber || '—'}</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">{bank.accountHolder || '—'}</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">{bank.note || '—'}</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">
                      <button
                        type="button"
                        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 disabled:opacity-50"
                        disabled={disabledAll || !bank.accountNumber}
                        onClick={() => { void copyAccount(bank.accountNumber); }}
                      >
                        Salin nomor rekening
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. Tabel pesanan pengguna beserta unggah bukti transfer. */}
      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
        <h3 className="mb-2 font-semibold text-slate-100">Pesanan saya</h3>
        {orders.length === 0 ? (
          <p className="text-slate-400">Belum ada pesanan.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Tanggal</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Paket</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Masa</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Total</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Status</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Bukti transfer</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="text-slate-300">
                    <td className="border-b border-slate-700/60 px-3 py-2">{dateText(order.createdAt)}</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">{order.planCode}</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">{num(order.months)} bulan</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">{rupiah(order.totalIdr)}</td>
                    <td className="border-b border-slate-700/60 px-3 py-2">
                      <span className={`rounded-lg px-2 py-1 text-xs ${statusClass(order.status)}`}>{statusLabel(order.status)}</span>
                    </td>
                    <td className="border-b border-slate-700/60 px-3 py-2">
                      {order.status === 'pending' ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="file"
                            aria-label={`Pilih berkas bukti transfer untuk pesanan ${order.planCode}`}
                            accept="image/*,.pdf"
                            className="text-slate-300"
                            disabled={disabledAll}
                            onChange={(event) => {
                              const file = event.target.files && event.target.files.length > 0 ? event.target.files[0] : null;
                              setProofFiles((current) => ({ ...current, [order.id]: file }));
                              setError('');
                              setOk('');
                              if (file && file.size > MAX_PROOF_BYTES) setError('Ukuran berkas maksimal 5 MB.');
                            }}
                          />
                          <button
                            type="button"
                            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 disabled:opacity-50"
                            disabled={disabledAll}
                            onClick={() => { void uploadProof(order); }}
                          >
                            {busy === `proof-${order.id}` ? 'Mengunggah…' : 'Unggah bukti'}
                          </button>
                        </div>
                      ) : (
                        <span className="text-slate-400">{order.decidedAt ? `Diputuskan ${dateText(order.decidedAt)}` : '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4b. Butir 74: nominal unik untuk pembayaran transfer manual. */}
      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-3"
        data-testid="billing-unik"
        data-jumlah-manual={pesananPending.filter((order) => order.method === 'manual').length}>
        <h3 className="mb-2 font-semibold text-slate-100">Nominal unik (verifikasi transfer manual)</h3>
        <p className="mb-2 text-sm text-slate-400" data-testid="billing-unik-catatan">
          Nominal unik menambahkan kode angka di belakang jumlah tagihan supaya transfer Anda bisa
          dicocokkan otomatis. Server <b>tidak</b> mengubah kolom <code>amount_idr</code> maupun
          <code> total_idr</code> pesanan: kode itu hanya penanda verifikasi. Daftar pesanan dari server juga
          tidak memuat kolom nominal unik, jadi nominal hanya muncul di sini setelah tombol di bawah dijawab
          server (atau dari antrean admin). Bagian ini hanya menampilkan pesanan yang masih menunggu
          pembayaran: pesanan yang sudah lunas (mis. paket gratis yang langsung aktif) tidak muncul di sini.
          Pesanan non-transfer yang masih menunggu pembayaran harus dibayar persis — server menolaknya
          dengan 409 GATEWAY_EXACT_AMOUNT dan halaman ini tidak menawarkan tombolnya.
        </p>
        {pesananPending.length === 0 ? (
          <p className="text-slate-400" data-testid="billing-unik-kosong">Tidak ada pesanan yang menunggu pembayaran.</p>
        ) : (
          <div className="space-y-2">
            {pesananPending.map((order) => {
              const jawaban = nominal[order.id];
              const manual = order.method === 'manual';
              return (
                <div key={order.id} className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
                  data-testid={`unik-${order.id}`}
                  data-method={order.method}
                  data-nominal={jawaban ? String(jawaban.order.nominalBayarIdr) : ''}>
                  <p className="text-slate-300">
                    {order.planCode} · {num(order.months)} bulan · tagihan {rupiah(order.totalIdr)} ·
                    jalur <b>{order.method}</b> · status {statusLabel(order.status)}
                  </p>
                  {manual ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 disabled:opacity-50"
                        data-testid={`unik-pasang-${order.id}`}
                        disabled={disabledAll || unikBusy === order.id}
                        onClick={() => { void pasangNominalUnik(order.id); }}
                      >
                        {unikBusy === order.id ? 'Memasang…' : jawaban ? 'Pasang nominal unik baru' : 'Pasang nominal unik'}
                      </button>
                      {jawaban ? (
                        <span className="text-emerald-300" data-testid={`unik-nilai-${order.id}`}>
                          Transfer {rupiah(jawaban.order.nominalBayarIdr)} = {rupiah(jawaban.baseIdr)} + kode {num(jawaban.k)}
                          {jawaban.sudahAda ? ' (nominal ini sudah ada sebelumnya)' : ''}
                        </span>
                      ) : (
                        <span className="text-slate-400" data-testid={`unik-nilai-${order.id}`}>Belum dipasang.</span>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1 text-amber-300" data-testid={`unik-lewat-${order.id}`}>
                      Jalur '{order.method}' bukan transfer manual: jumlahnya harus dibayar persis, jadi tidak
                      ada nominal unik. Server menolak permintaan nominal unik untuk pesanan seperti ini
                      (GATEWAY_EXACT_AMOUNT untuk pesanan gateway; pesanan yang sudah lunas lebih dulu
                      dijawab ORDER_NOT_PENDING).
                    </p>
                  )}
                  {jawaban ? <p className="mt-1 text-xs text-slate-400">{jawaban.catatan}</p> : null}
                </div>
              );
            })}
          </div>
        )}

        {isAdmin ? (
          <div className="mt-3 space-y-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3"
            data-testid="billing-antrean"
            data-belum={antrean ? String(antrean.belumBernominalUnik) : ''}>
            <b className="text-slate-100">Antrean admin: pesanan transfer manual</b>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 disabled:opacity-50"
                data-testid="antrean-muat" disabled={antreanBusy} onClick={() => { void muatAntrean(); }}>
                {antreanBusy ? 'Memuat…' : 'Muat antrean'}
              </button>
              <button type="button" className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 disabled:opacity-50"
                data-testid="antrean-isi" disabled={antreanBusy} onClick={() => { void isiAntrean(); }}>
                Isi nominal unik sekaligus
              </button>
              <span className="text-slate-300" data-testid="antrean-hitung">
                {antrean ? `${num(antrean.belumBernominalUnik)} pesanan belum bernominal unik (dari ${antrean.orders.length} baris).` : 'Antrean belum dimuat.'}
              </span>
            </div>
            {antreanHasil ? (
              <p className="text-slate-300" data-testid="antrean-hasil" data-diisi={antreanHasil.diisi} data-gagal={antreanHasil.gagal}>
                Selesai: {antreanHasil.diisi} nominal diisi, {antreanHasil.gagal} gagal.
              </p>
            ) : null}
            {antrean && antrean.orders.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th scope="col" className="border-b border-slate-700 px-3 py-2">Pembeli</th>
                      <th scope="col" className="border-b border-slate-700 px-3 py-2">Paket</th>
                      <th scope="col" className="border-b border-slate-700 px-3 py-2">Tagihan</th>
                      <th scope="col" className="border-b border-slate-700 px-3 py-2">Nominal unik</th>
                    </tr>
                  </thead>
                  <tbody>
                    {antrean.orders.map((baris) => (
                      <tr key={baris.orderId} className="text-slate-300" data-testid={`antrean-${baris.orderId}`}
                        data-nominal={String(baris.nominalBayarIdr)}>
                        <td className="border-b border-slate-700/60 px-3 py-2">{baris.email || baris.userId}</td>
                        <td className="border-b border-slate-700/60 px-3 py-2">{baris.planCode} · {num(baris.months)} bulan</td>
                        <td className="border-b border-slate-700/60 px-3 py-2">{rupiah(baris.totalIdr)}</td>
                        <td className="border-b border-slate-700/60 px-3 py-2">
                          {baris.punyaNominalUnik ? rupiah(baris.nominalBayarIdr) : 'belum bernominal unik'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 5. Riwayat kredit token pengguna. */}
      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
        <h3 className="mb-2 font-semibold text-slate-100">Riwayat kredit token</h3>
        {creditHistory.length === 0 ? (
          <p className="text-slate-400">Belum ada riwayat kredit token.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-slate-400">
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Tanggal</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Jumlah token</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Alasan</th>
                  <th scope="col" className="border-b border-slate-700 px-3 py-2">Catatan</th>
                </tr>
              </thead>
              <tbody>
                {creditHistory.map((row) => {
                  const tokens = num(row.tokens);
                  const sign = tokens >= 0 ? '+' : '−';
                  return (
                    <tr key={row.id} className="text-slate-300">
                      <td className="border-b border-slate-700/60 px-3 py-2">{dateText(row.createdAt)}</td>
                      <td className="border-b border-slate-700/60 px-3 py-2">{`${sign}${tokenText(Math.abs(tokens))}`}</td>
                      <td className="border-b border-slate-700/60 px-3 py-2">{row.reason || '—'}</td>
                      <td className="border-b border-slate-700/60 px-3 py-2">{row.note || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

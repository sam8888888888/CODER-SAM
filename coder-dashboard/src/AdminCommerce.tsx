import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { BankAccount, BillingOrder, Branding, Coupon, PaymentConfig, Plan, RevenueSummary } from './api';

type Props = {
  isAdmin: boolean;
  onError?: (message: string) => void;
};

type TabId = 'ringkasan' | 'pesanan' | 'kupon' | 'rekening' | 'paket' | 'pembayaran' | 'branding';

/** Daftar tab halaman Komersial (Admin). Urutan tampil sesuai daftar ini. */
const TABS: { id: TabId; label: string }[] = [
  { id: 'ringkasan', label: 'Ringkasan' },
  { id: 'pesanan', label: 'Pesanan' },
  { id: 'kupon', label: 'Kupon' },
  { id: 'rekening', label: 'Rekening' },
  { id: 'paket', label: 'Paket' },
  { id: 'pembayaran', label: 'Pembayaran' },
  { id: 'branding', label: 'Branding' },
];

/** Label status pesanan dalam Bahasa Indonesia. */
const STATUS_LABEL: Record<string, string> = {
  pending: 'Menunggu',
  paid: 'Lunas',
  rejected: 'Ditolak',
  cancelled: 'Dibatalkan',
};

/** Pilihan gateway pembayaran yang didukung platform. */
const GATEWAYS: { value: string; label: string }[] = [
  { value: 'manual', label: 'Manual (transfer bank)' },
  { value: 'xendit', label: 'Xendit' },
  { value: 'midtrans', label: 'Midtrans' },
];

/** Rentang hari untuk laporan ringkasan. */
const RANGES: number[] = [7, 30, 90];

const INPUT_CLASS = 'rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-50';
const LABEL_CLASS = 'flex flex-col gap-1 text-xs text-slate-400';

/** Nilai form paket yang sedang diedit; disimpan sebagai teks agar nyaman saat diketik. */
type PlanDraft = { priceIdr: string; dailyTokenLimit: string; monthlyTokenLimit: string; bonusTokens: string };

/** Paksa nilai apa pun menjadi angka aman supaya tabel tidak menampilkan NaN. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ambil kode galat dari pesan server; api.ts melempar kode mentah sebagai message. */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Format uang rupiah tanpa desimal. */
function rupiah(value: unknown): string {
  return 'Rp' + num(value).toLocaleString('id-ID');
}

/** Format angka biasa (tanpa mata uang) dengan pemisah ribuan Indonesia. */
function angka(value: unknown): string {
  return num(value).toLocaleString('id-ID');
}

/** Ubah waktu ISO menjadi tanggal ringkas Indonesia; "-" bila kosong atau tidak valid. */
function tanggal(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Ubah galat dari server menjadi kalimat Indonesia yang jelas.
 * Kode mentah tidak ditampilkan sendirian: selalu ada penjelasan singkat untuk pengguna.
 */
function friendlyMessage(error: unknown, fallback: string): string {
  const code = errorCode(error).toUpperCase();
  if (code.includes('FORBIDDEN') || code.includes('UNAUTHORIZED') || code.includes('ADMIN_REQUIRED')) {
    return 'Akses ditolak. Hanya admin platform yang dapat melakukan tindakan ini.';
  }
  if (code.includes('COUPON_NOT_FOUND')) return 'Kode kupon tidak ditemukan.';
  if (code.includes('COUPON_REQUIRED')) return 'Kode kupon wajib diisi.';
  if (code.includes('ORDER_NOT_FOUND')) return 'Pesanan tidak ditemukan. Muat ulang daftar pesanan.';
  if (code.includes('PLAN_NOT_FOUND')) return 'Paket tidak ditemukan. Muat ulang daftar paket.';
  if (code.includes('NOT_FOUND')) return 'Data yang diminta tidak ditemukan. Muat ulang daftar.';
  if (code.includes('EXISTS') || code.includes('DUPLICATE') || code.includes('CONFLICT')) {
    return 'Data sudah ada. Periksa kembali kode atau nama yang Anda isi.';
  }
  if (code.includes('INVALID') || code.includes('REQUIRED')) {
    return `Data yang Anda masukkan belum lengkap atau belum sesuai. ${fallback}`;
  }
  return fallback;
}

/** Susun nilai awal form paket dari data server. */
function buildPlanDrafts(list: Plan[]): Record<string, PlanDraft> {
  const drafts: Record<string, PlanDraft> = {};
  for (const plan of list) {
    drafts[plan.code] = {
      priceIdr: String(num(plan.priceIdr)),
      dailyTokenLimit: String(num(plan.dailyTokenLimit)),
      monthlyTokenLimit: String(num(plan.monthlyTokenLimit)),
      bonusTokens: String(num(plan.bonusTokens)),
    };
  }
  return drafts;
}

/** Ubah teks form menjadi angka bulat >= 0; null berarti teks tidak valid. Titik dianggap pemisah ribuan. */
function parseNonNegativeInt(value: string): number | null {
  const cleaned = value.trim().replace(/\./g, '').replace(/\s/g, '');
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

/** Kartu angka ringkas untuk tab Ringkasan. */
function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-base font-semibold text-slate-100">{value}</p>
      {hint ? <p className="text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

/** Kartu berjudul berisi satu kelompok form atau tabel. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Halaman Komersial (Admin): laporan pendapatan, pengelolaan pesanan, kupon,
 * rekening bank, paket langganan, konfigurasi pembayaran, dan branding.
 * Data hanya dimuat untuk tab yang sedang aktif. Bila isAdmin=false, komponen
 * ini tidak memanggil endpoint admin sama sekali.
 */
export function AdminCommerce({ isAdmin, onError }: Props) {
  const [tab, setTab] = useState<TabId>('ringkasan');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Tab Ringkasan.
  const [days, setDays] = useState<number>(30);
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null);
  const [revenueBusy, setRevenueBusy] = useState(false);
  const [rateInput, setRateInput] = useState('');
  const [rateBusy, setRateBusy] = useState(false);

  // Tab Pesanan.
  const [orderStatus, setOrderStatus] = useState('semua');
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [ordersBusy, setOrdersBusy] = useState(false);
  const [orderNotes, setOrderNotes] = useState<Record<string, string>>({});
  const [decidingId, setDecidingId] = useState('');

  // Tab Kupon.
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [couponsBusy, setCouponsBusy] = useState(false);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [couponPercent, setCouponPercent] = useState('');
  const [couponAmount, setCouponAmount] = useState('');
  const [couponMaxUses, setCouponMaxUses] = useState('');
  const [couponExpires, setCouponExpires] = useState('');

  // Tab Rekening.
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [banksBusy, setBanksBusy] = useState(false);
  const [bankBusy, setBankBusy] = useState(false);
  const [bankName, setBankName] = useState('');
  const [bankNumber, setBankNumber] = useState('');
  const [bankHolder, setBankHolder] = useState('');
  const [bankNote, setBankNote] = useState('');

  // Tab Paket.
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansBusy, setPlansBusy] = useState(false);
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanDraft>>({});
  const [savingPlan, setSavingPlan] = useState('');

  // Tab Pembayaran.
  const [payment, setPayment] = useState<PaymentConfig | null>(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [gateway, setGateway] = useState('manual');
  const [xenditEnabled, setXenditEnabled] = useState(false);
  const [midtransEnabled, setMidtransEnabled] = useState(false);
  const [instructions, setInstructions] = useState('');

  // Tab Branding.
  const [brandingBusy, setBrandingBusy] = useState(false);
  const [brandingForm, setBrandingForm] = useState<Branding>({
    appName: '',
    tagline: '',
    primaryColor: '#8b5cf6',
    logoUrl: '',
    faviconUrl: '',
    supportEmail: '',
  });

  /** Tampilkan galat ke pengguna dan teruskan ke induk supaya bisa dilaporkan seragam. */
  function report(message: string): void {
    setError(message);
    onError?.(message);
  }

  /** Muat laporan pendapatan untuk rentang hari terpilih. */
  async function loadRevenue(): Promise<boolean> {
    setRevenueBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api.adminRevenue(days);
      setRevenue(data);
      setRateInput(String(num(data?.usdIdrRate)));
      return true;
    } catch (e) {
      setRevenue(null);
      setRateInput('');
      report(friendlyMessage(e, 'Gagal memuat ringkasan komersial.'));
      return false;
    } finally {
      setRevenueBusy(false);
    }
  }

  /** Muat daftar pesanan sesuai filter status terpilih. */
  async function loadOrders(): Promise<boolean> {
    setOrdersBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api.adminOrders(orderStatus === 'semua' ? undefined : orderStatus);
      setOrders(data?.orders ?? []);
      return true;
    } catch (e) {
      setOrders([]);
      report(friendlyMessage(e, 'Gagal memuat daftar pesanan.'));
      return false;
    } finally {
      setOrdersBusy(false);
    }
  }

  /** Muat daftar kupon. */
  async function loadCoupons(): Promise<boolean> {
    setCouponsBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api.adminCoupons();
      setCoupons(data?.coupons ?? []);
      return true;
    } catch (e) {
      setCoupons([]);
      report(friendlyMessage(e, 'Gagal memuat daftar kupon.'));
      return false;
    } finally {
      setCouponsBusy(false);
    }
  }

  /** Muat daftar rekening bank platform. */
  async function loadBanks(): Promise<boolean> {
    setBanksBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api.adminBanks();
      setBanks(data?.banks ?? []);
      return true;
    } catch (e) {
      setBanks([]);
      report(friendlyMessage(e, 'Gagal memuat daftar rekening.'));
      return false;
    } finally {
      setBanksBusy(false);
    }
  }

  /** Muat daftar paket langganan dan siapkan nilai form editnya. */
  async function loadPlans(): Promise<boolean> {
    setPlansBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api.adminPlans();
      const list = data?.plans ?? [];
      setPlans(list);
      setPlanDrafts(buildPlanDrafts(list));
      return true;
    } catch (e) {
      setPlans([]);
      setPlanDrafts({});
      report(friendlyMessage(e, 'Gagal memuat daftar paket.'));
      return false;
    } finally {
      setPlansBusy(false);
    }
  }

  /** Muat konfigurasi pembayaran dan isi formnya. */
  async function loadPaymentConfig(): Promise<boolean> {
    setPaymentBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api.adminPaymentConfig();
      setPayment(data);
      setGateway(data?.gateway ?? 'manual');
      setXenditEnabled(Boolean(data?.xenditEnabled));
      setMidtransEnabled(Boolean(data?.midtransEnabled));
      setInstructions(data?.instructions ?? '');
      return true;
    } catch (e) {
      setPayment(null);
      report(friendlyMessage(e, 'Gagal memuat konfigurasi pembayaran.'));
      return false;
    } finally {
      setPaymentBusy(false);
    }
  }

  /** Muat pengaturan branding dan isi formnya. */
  async function loadBranding(): Promise<boolean> {
    setBrandingBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await api.branding();
      setBrandingForm({
        appName: data?.appName ?? '',
        tagline: data?.tagline ?? '',
        primaryColor: data?.primaryColor ?? '#8b5cf6',
        logoUrl: data?.logoUrl ?? '',
        faviconUrl: data?.faviconUrl ?? '',
        supportEmail: data?.supportEmail ?? '',
      });
      return true;
    } catch (e) {
      report(friendlyMessage(e, 'Gagal memuat pengaturan branding.'));
      return false;
    } finally {
      setBrandingBusy(false);
    }
  }

  // Muat hanya data tab yang sedang aktif. Pengguna bukan admin tidak memanggil apa pun.
  useEffect(() => {
    if (!isAdmin) return;
    if (tab === 'ringkasan') void loadRevenue();
    else if (tab === 'pesanan') void loadOrders();
    else if (tab === 'kupon') void loadCoupons();
    else if (tab === 'rekening') void loadBanks();
    else if (tab === 'paket') void loadPlans();
    else if (tab === 'pembayaran') void loadPaymentConfig();
    else if (tab === 'branding') void loadBranding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isAdmin, days, orderStatus]);

  /** Simpan kurs USD ke IDR, lalu muat ulang ringkasan. */
  async function saveUsdRate(): Promise<void> {
    const parsed = parseNonNegativeInt(rateInput);
    if (parsed === null || parsed <= 0) {
      report('Kurs USD ke IDR harus berupa angka lebih dari nol.');
      return;
    }
    setRateBusy(true);
    try {
      const result = await api.setUsdRate(parsed);
      const ok = await loadRevenue();
      if (ok) setInfo(`Kurs tersimpan: ${rupiah(result?.usdIdrRate)} per USD.`);
    } catch (e) {
      report(friendlyMessage(e, 'Gagal menyimpan kurs USD ke IDR.'));
    } finally {
      setRateBusy(false);
    }
  }

  /** Setujui atau tolak satu pesanan; catatan admin diambil dari input pada baris tersebut. */
  async function decideOrder(orderId: string, decision: 'paid' | 'rejected'): Promise<void> {
    const note = (orderNotes[orderId] ?? '').trim();
    setDecidingId(orderId);
    try {
      await api.decideOrder(orderId, decision, note || undefined);
      setOrderNotes((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
      const ok = await loadOrders();
      if (ok) setInfo(decision === 'paid' ? 'Pesanan ditandai lunas.' : 'Pesanan ditolak.');
    } catch (e) {
      report(friendlyMessage(e, decision === 'paid' ? 'Gagal menandai pesanan lunas.' : 'Gagal menolak pesanan.'));
    } finally {
      setDecidingId('');
    }
  }

  /** Buat kupon baru dari form kupon. */
  async function createCoupon(): Promise<void> {
    const code = couponCode.trim().toUpperCase();
    if (!code) {
      report('Kode kupon wajib diisi.');
      return;
    }
    const percent = parseNonNegativeInt(couponPercent);
    const amountIdr = parseNonNegativeInt(couponAmount);
    const maxUses = parseNonNegativeInt(couponMaxUses);
    if (percent === null || amountIdr === null || maxUses === null) {
      report('Potongan dan batas pemakaian harus berupa angka nol atau lebih.');
      return;
    }
    if (percent <= 0 && amountIdr <= 0) {
      report('Isi minimal satu potongan: persen (%) atau nominal (Rp).');
      return;
    }
    if (percent > 100) {
      report('Potongan persen tidak boleh lebih dari 100%.');
      return;
    }
    setCouponBusy(true);
    try {
      await api.createCoupon({
        code,
        percent,
        amountIdr,
        maxUses,
        expiresAt: couponExpires ? new Date(`${couponExpires}T23:59:59.000Z`).toISOString() : null,
      });
      setCouponCode('');
      setCouponPercent('');
      setCouponAmount('');
      setCouponMaxUses('');
      setCouponExpires('');
      const ok = await loadCoupons();
      if (ok) setInfo(`Kupon ${code} sudah dibuat.`);
    } catch (e) {
      report(friendlyMessage(e, 'Gagal membuat kupon.'));
    } finally {
      setCouponBusy(false);
    }
  }

  /** Aktifkan atau nonaktifkan satu kupon. */
  async function toggleCoupon(coupon: Coupon): Promise<void> {
    setError('');
    try {
      await api.setCouponActive(coupon.code, !coupon.active);
      const ok = await loadCoupons();
      if (ok) setInfo(`Kupon ${coupon.code} ${coupon.active ? 'dinonaktifkan' : 'diaktifkan'}.`);
    } catch (e) {
      report(friendlyMessage(e, 'Gagal mengubah status kupon.'));
    }
  }

  /** Tambah rekening bank tujuan transfer. */
  async function createBank(): Promise<void> {
    if (!bankName.trim() || !bankNumber.trim() || !bankHolder.trim()) {
      report('Nama bank, nomor rekening, dan atas nama wajib diisi.');
      return;
    }
    setBankBusy(true);
    try {
      await api.createBank({
        bankName: bankName.trim(),
        accountNumber: bankNumber.trim(),
        accountHolder: bankHolder.trim(),
        note: bankNote.trim() || undefined,
      });
      setBankName('');
      setBankNumber('');
      setBankHolder('');
      setBankNote('');
      const ok = await loadBanks();
      if (ok) setInfo('Rekening baru sudah ditambahkan.');
    } catch (e) {
      report(friendlyMessage(e, 'Gagal menambah rekening.'));
    } finally {
      setBankBusy(false);
    }
  }

  /** Hapus rekening setelah konfirmasi pengguna. */
  async function deleteBank(bank: BankAccount): Promise<void> {
    const label = `${bank.bankName} ${bank.accountNumber}`;
    if (!window.confirm(`Hapus rekening ${label}? Tindakan ini tidak bisa dibatalkan.`)) return;
    setError('');
    try {
      await api.deleteBank(bank.id);
      const ok = await loadBanks();
      if (ok) setInfo('Rekening sudah dihapus.');
    } catch (e) {
      report(friendlyMessage(e, 'Gagal menghapus rekening.'));
    }
  }

  /** Simpan perubahan harga dan kuota satu paket. */
  async function savePlan(plan: Plan): Promise<void> {
    const draft = planDrafts[plan.code];
    if (!draft) return;
    const priceIdr = parseNonNegativeInt(draft.priceIdr);
    const dailyTokenLimit = parseNonNegativeInt(draft.dailyTokenLimit);
    const monthlyTokenLimit = parseNonNegativeInt(draft.monthlyTokenLimit);
    const bonusTokens = parseNonNegativeInt(draft.bonusTokens);
    if (priceIdr === null || dailyTokenLimit === null || monthlyTokenLimit === null || bonusTokens === null) {
      report('Harga dan kuota paket harus berupa angka nol atau lebih.');
      return;
    }
    setSavingPlan(plan.code);
    try {
      await api.updatePlan(plan.code, { priceIdr, dailyTokenLimit, monthlyTokenLimit, bonusTokens });
      const ok = await loadPlans();
      if (ok) setInfo(`Paket ${plan.name} sudah diperbarui.`);
    } catch (e) {
      report(friendlyMessage(e, 'Gagal menyimpan paket.'));
    } finally {
      setSavingPlan('');
    }
  }

  /** Simpan konfigurasi pembayaran: gateway, sakelar otomatis, dan instruksi transfer. */
  async function savePaymentConfig(): Promise<void> {
    setPaymentBusy(true);
    try {
      const data = await api.savePaymentConfig({ gateway, xenditEnabled, midtransEnabled, instructions });
      setPayment(data);
      setGateway(data?.gateway ?? gateway);
      setXenditEnabled(Boolean(data?.xenditEnabled));
      setMidtransEnabled(Boolean(data?.midtransEnabled));
      setInstructions(data?.instructions ?? instructions);
      setError('');
      setInfo('Konfigurasi pembayaran sudah disimpan.');
    } catch (e) {
      report(friendlyMessage(e, 'Gagal menyimpan konfigurasi pembayaran.'));
    } finally {
      setPaymentBusy(false);
    }
  }

  /** Simpan pengaturan branding aplikasi. */
  async function saveBranding(): Promise<void> {
    if (!brandingForm.appName.trim()) {
      report('Nama aplikasi wajib diisi.');
      return;
    }
    setBrandingBusy(true);
    try {
      const data = await api.saveBranding({
        appName: brandingForm.appName.trim(),
        tagline: brandingForm.tagline.trim(),
        primaryColor: brandingForm.primaryColor,
        logoUrl: brandingForm.logoUrl.trim(),
        faviconUrl: brandingForm.faviconUrl.trim(),
        supportEmail: brandingForm.supportEmail.trim(),
      });
      setBrandingForm({
        appName: data?.appName ?? '',
        tagline: data?.tagline ?? '',
        primaryColor: data?.primaryColor ?? '#8b5cf6',
        logoUrl: data?.logoUrl ?? '',
        faviconUrl: data?.faviconUrl ?? '',
        supportEmail: data?.supportEmail ?? '',
      });
      setError('');
      setInfo('Branding sudah disimpan.');
    } catch (e) {
      report(friendlyMessage(e, 'Gagal menyimpan branding.'));
    } finally {
      setBrandingBusy(false);
    }
  }

  // Bukan admin: tidak ada permintaan ke endpoint admin, hanya satu kartu informasi.
  if (!isAdmin) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
        Hanya admin platform yang dapat membuka halaman ini.
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-slate-100">Komersial (Admin)</h2>
        <p className="text-sm text-slate-400">
          Kelola pendapatan, pesanan, kupon, rekening, paket, pembayaran, dan branding platform.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setTab(item.id);
              setError('');
              setInfo('');
            }}
            className={
              'rounded-lg border px-3 py-2 text-sm ' +
              (tab === item.id
                ? 'border-slate-700 bg-violet-600 text-slate-100'
                : 'border-slate-700 bg-slate-800/60 text-slate-300')
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}
      {info ? <p className="text-sm text-emerald-400">{info}</p> : null}

      {tab === 'ringkasan' ? (
        <Panel title="Ringkasan komersial">
          <div className="flex flex-wrap items-end gap-3">
            <label className={LABEL_CLASS}>
              Rentang laporan
              <select
                className={INPUT_CLASS}
                value={String(days)}
                onChange={(event) => setDays(num(event.target.value))}
              >
                {RANGES.map((value) => (
                  <option key={value} value={String(value)}>
                    {value} hari terakhir
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100"
              disabled={revenueBusy}
              onClick={() => { void loadRevenue(); }}
            >
              {revenueBusy ? 'Memuat…' : 'Muat ulang'}
            </button>
          </div>

          {revenue ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Pendapatan" value={rupiah(revenue.revenueIdr)} hint={`Sejak ${tanggal(revenue.since)}`} />
                <MetricCard
                  label="Biaya"
                  value={rupiah(revenue.costIdr)}
                  hint={`${angka(revenue.tokens)} token terpakai`}
                />
                <MetricCard
                  label="Margin"
                  value={rupiah(revenue.marginIdr)}
                  hint={revenue.marginPercent === null ? 'Persen margin belum tersedia' : `Margin ${num(revenue.marginPercent)}%`}
                />
                <MetricCard label="Pesanan lunas" value={angka(revenue.paidOrders)} hint={`${angka(revenue.pendingOrders)} pesanan menunggu`} />
                <MetricCard label="Pelanggan aktif" value={angka(revenue.activeSubscriptions)} hint={`${angka(revenue.newSubscriptions)} langganan baru`} />
                <MetricCard label="Token terpakai" value={angka(revenue.tokens)} />
                <MetricCard label="Bonus token diberikan" value={angka(revenue.creditGrantedTokens)} />
                <MetricCard
                  label="Biaya (USD)"
                  value={`$${num(revenue.costUsd).toFixed(4)}`}
                  hint={`Kurs Rp${angka(revenue.usdIdrRate)} per USD`}
                />
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <label className={LABEL_CLASS}>
                  Kurs USD ke IDR
                  <input
                    className={INPUT_CLASS}
                    type="number"
                    min="1"
                    step="1"
                    value={rateInput}
                    disabled={rateBusy}
                    onChange={(event) => setRateInput(event.target.value)}
                    placeholder="Contoh: 16000"
                  />
                </label>
                <button
                  type="button"
                  className="rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 text-sm text-slate-100"
                  disabled={rateBusy}
                  onClick={() => { void saveUsdRate(); }}
                >
                  {rateBusy ? 'Menyimpan…' : 'Simpan kurs'}
                </button>
              </div>

              <p className="text-xs text-slate-400">
                Catatan: biaya dihitung dari pemakaian nyata yang tercatat, bukan perkiraan.
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-400">{revenueBusy ? 'Memuat ringkasan…' : 'Belum ada data ringkasan untuk ditampilkan.'}</p>
          )}
        </Panel>
      ) : null}

      {tab === 'pesanan' ? (
        <Panel title="Pesanan">
          <div className="flex flex-wrap items-end gap-3">
            <label className={LABEL_CLASS}>
              Filter status
              <select
                className={INPUT_CLASS}
                value={orderStatus}
                onChange={(event) => setOrderStatus(event.target.value)}
              >
                <option value="semua">Semua</option>
                <option value="pending">Menunggu</option>
                <option value="paid">Lunas</option>
                <option value="rejected">Ditolak</option>
              </select>
            </label>
            <button
              type="button"
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-100"
              disabled={ordersBusy}
              onClick={() => { void loadOrders(); }}
            >
              {ordersBusy ? 'Memuat…' : 'Muat ulang'}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm text-slate-300">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="px-2 py-1">Tanggal</th>
                  <th className="px-2 py-1">Pengguna</th>
                  <th className="px-2 py-1">Paket</th>
                  <th className="px-2 py-1">Masa</th>
                  <th className="px-2 py-1">Total</th>
                  <th className="px-2 py-1">Metode</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-t border-slate-700">
                    <td className="px-2 py-2">{tanggal(order.createdAt)}</td>
                    <td className="px-2 py-2">{order.userEmail || order.userId || '-'}</td>
                    <td className="px-2 py-2">{order.planCode}</td>
                    <td className="px-2 py-2">{angka(order.months)} bulan</td>
                    <td className="px-2 py-2">{rupiah(order.totalIdr)}</td>
                    <td className="px-2 py-2">{order.method || '-'}</td>
                    <td className="px-2 py-2">{STATUS_LABEL[order.status] ?? order.status}</td>
                    <td className="px-2 py-2">
                      {order.status === 'pending' ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className="w-40 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                            type="text"
                            value={orderNotes[order.id] ?? ''}
                            disabled={decidingId === order.id}
                            placeholder="Catatan admin (opsional)"
                            aria-label={`Catatan admin untuk pesanan ${order.id}`}
                            onChange={(event) =>
                              setOrderNotes((prev) => ({ ...prev, [order.id]: event.target.value }))
                            }
                          />
                          <button
                            type="button"
                            className="rounded-lg border border-slate-700 bg-emerald-600 px-3 py-2 text-xs text-slate-100"
                            disabled={decidingId === order.id}
                            onClick={() => { void decideOrder(order.id, 'paid'); }}
                          >
                            Tandai lunas
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-slate-700 bg-rose-600 px-3 py-2 text-xs text-slate-100"
                            disabled={decidingId === order.id}
                            onClick={() => { void decideOrder(order.id, 'rejected'); }}
                          >
                            Tolak
                          </button>
                        </div>
                      ) : (
                        <span className="text-slate-400">Tidak ada tindakan</span>
                      )}
                    </td>
                  </tr>
                ))}
                {orders.length === 0 ? (
                  <tr className="border-t border-slate-700">
                    <td className="px-2 py-2 text-slate-400" colSpan={8}>
                      {ordersBusy ? 'Memuat pesanan…' : 'Tidak ada pesanan pada filter ini.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {tab === 'kupon' ? (
        <Panel title="Kupon">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className={LABEL_CLASS}>
              Kode kupon
              <input
                className={INPUT_CLASS}
                type="text"
                value={couponCode}
                disabled={couponBusy}
                onChange={(event) => setCouponCode(event.target.value)}
                placeholder="Contoh: DISKON10"
              />
            </label>
            <label className={LABEL_CLASS}>
              Potongan (%)
              <input
                className={INPUT_CLASS}
                type="number"
                min="0"
                max="100"
                value={couponPercent}
                disabled={couponBusy}
                onChange={(event) => setCouponPercent(event.target.value)}
                placeholder="Contoh: 10"
              />
            </label>
            <label className={LABEL_CLASS}>
              Potongan nominal (Rp)
              <input
                className={INPUT_CLASS}
                type="number"
                min="0"
                value={couponAmount}
                disabled={couponBusy}
                onChange={(event) => setCouponAmount(event.target.value)}
                placeholder="Contoh: 50000"
              />
            </label>
            <label className={LABEL_CLASS}>
              Maksimum pemakaian
              <input
                className={INPUT_CLASS}
                type="number"
                min="0"
                value={couponMaxUses}
                disabled={couponBusy}
                onChange={(event) => setCouponMaxUses(event.target.value)}
                placeholder="0 berarti tanpa batas"
              />
            </label>
            <label className={LABEL_CLASS}>
              Kedaluwarsa
              <input
                className={INPUT_CLASS}
                type="date"
                value={couponExpires}
                disabled={couponBusy}
                onChange={(event) => setCouponExpires(event.target.value)}
              />
            </label>
          </div>
          <div>
            <button
              type="button"
              className="rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 text-sm text-slate-100"
              disabled={couponBusy}
              onClick={() => { void createCoupon(); }}
            >
              {couponBusy ? 'Membuat…' : 'Buat kupon'}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm text-slate-300">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="px-2 py-1">Kode</th>
                  <th className="px-2 py-1">Potongan</th>
                  <th className="px-2 py-1">Terpakai / maks</th>
                  <th className="px-2 py-1">Kedaluwarsa</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((coupon) => (
                  <tr key={coupon.code} className="border-t border-slate-700">
                    <td className="px-2 py-2">{coupon.code}</td>
                    <td className="px-2 py-2">
                      {[
                        num(coupon.percent) > 0 ? `${angka(coupon.percent)}%` : '',
                        num(coupon.amountIdr) > 0 ? rupiah(coupon.amountIdr) : '',
                      ]
                        .filter(Boolean)
                        .join(' + ') || '-'}
                    </td>
                    <td className="px-2 py-2">
                      {angka(coupon.uses)} / {num(coupon.maxUses) > 0 ? angka(coupon.maxUses) : 'tanpa batas'}
                    </td>
                    <td className="px-2 py-2">{tanggal(coupon.expiresAt)}</td>
                    <td className="px-2 py-2">{coupon.active ? 'Aktif' : 'Nonaktif'}</td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-100"
                        onClick={() => { void toggleCoupon(coupon); }}
                      >
                        {coupon.active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                    </td>
                  </tr>
                ))}
                {coupons.length === 0 ? (
                  <tr className="border-t border-slate-700">
                    <td className="px-2 py-2 text-slate-400" colSpan={6}>
                      {couponsBusy ? 'Memuat kupon…' : 'Belum ada kupon.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {tab === 'rekening' ? (
        <Panel title="Rekening bank">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className={LABEL_CLASS}>
              Nama bank
              <input
                className={INPUT_CLASS}
                type="text"
                value={bankName}
                disabled={bankBusy}
                onChange={(event) => setBankName(event.target.value)}
                placeholder="Contoh: BCA"
              />
            </label>
            <label className={LABEL_CLASS}>
              Nomor rekening
              <input
                className={INPUT_CLASS}
                type="text"
                value={bankNumber}
                disabled={bankBusy}
                onChange={(event) => setBankNumber(event.target.value)}
              />
            </label>
            <label className={LABEL_CLASS}>
              Atas nama
              <input
                className={INPUT_CLASS}
                type="text"
                value={bankHolder}
                disabled={bankBusy}
                onChange={(event) => setBankHolder(event.target.value)}
              />
            </label>
            <label className={LABEL_CLASS}>
              Catatan
              <input
                className={INPUT_CLASS}
                type="text"
                value={bankNote}
                disabled={bankBusy}
                onChange={(event) => setBankNote(event.target.value)}
                placeholder="Opsional"
              />
            </label>
          </div>
          <div>
            <button
              type="button"
              className="rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 text-sm text-slate-100"
              disabled={bankBusy}
              onClick={() => { void createBank(); }}
            >
              {bankBusy ? 'Menyimpan…' : 'Tambah rekening'}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm text-slate-300">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="px-2 py-1">Bank</th>
                  <th className="px-2 py-1">Nomor</th>
                  <th className="px-2 py-1">Atas nama</th>
                  <th className="px-2 py-1">Catatan</th>
                  <th className="px-2 py-1">Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((bank) => (
                  <tr key={bank.id} className="border-t border-slate-700">
                    <td className="px-2 py-2">{bank.bankName}</td>
                    <td className="px-2 py-2">{bank.accountNumber}</td>
                    <td className="px-2 py-2">{bank.accountHolder}</td>
                    <td className="px-2 py-2">{bank.note || '-'}</td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        className="rounded-lg border border-slate-700 bg-rose-600 px-3 py-2 text-xs text-slate-100"
                        onClick={() => { void deleteBank(bank); }}
                      >
                        Hapus
                      </button>
                    </td>
                  </tr>
                ))}
                {banks.length === 0 ? (
                  <tr className="border-t border-slate-700">
                    <td className="px-2 py-2 text-slate-400" colSpan={5}>
                      {banksBusy ? 'Memuat rekening…' : 'Belum ada rekening.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {tab === 'paket' ? (
        <Panel title="Paket langganan">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm text-slate-300">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="px-2 py-1">Paket</th>
                  <th className="px-2 py-1">Harga (Rp)</th>
                  <th className="px-2 py-1">Kuota harian</th>
                  <th className="px-2 py-1">Kuota bulanan</th>
                  <th className="px-2 py-1">Bonus token</th>
                  <th className="px-2 py-1">Tindakan</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => {
                  const draft = planDrafts[plan.code] ?? {
                    priceIdr: '',
                    dailyTokenLimit: '',
                    monthlyTokenLimit: '',
                    bonusTokens: '',
                  };
                  const busyRow = savingPlan === plan.code;
                  const update = (patch: Partial<PlanDraft>) =>
                    setPlanDrafts((prev) => ({ ...prev, [plan.code]: { ...draft, ...patch } }));
                  return (
                    <tr key={plan.code} className="border-t border-slate-700">
                      <td className="px-2 py-2">
                        <span className="text-slate-100">{plan.name}</span>
                        <span className="block text-xs text-slate-400">{plan.code}</span>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          className="w-32 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                          type="number"
                          min="0"
                          value={draft.priceIdr}
                          disabled={busyRow}
                          aria-label={`Harga paket ${plan.name}`}
                          onChange={(event) => update({ priceIdr: event.target.value })}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          className="w-32 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                          type="number"
                          min="0"
                          value={draft.dailyTokenLimit}
                          disabled={busyRow}
                          aria-label={`Kuota harian paket ${plan.name}`}
                          onChange={(event) => update({ dailyTokenLimit: event.target.value })}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          className="w-32 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                          type="number"
                          min="0"
                          value={draft.monthlyTokenLimit}
                          disabled={busyRow}
                          aria-label={`Kuota bulanan paket ${plan.name}`}
                          onChange={(event) => update({ monthlyTokenLimit: event.target.value })}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          className="w-32 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                          type="number"
                          min="0"
                          value={draft.bonusTokens}
                          disabled={busyRow}
                          aria-label={`Bonus token paket ${plan.name}`}
                          onChange={(event) => update({ bonusTokens: event.target.value })}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 text-xs text-slate-100"
                          disabled={busyRow}
                          onClick={() => { void savePlan(plan); }}
                        >
                          {busyRow ? 'Menyimpan…' : 'Simpan'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {plans.length === 0 ? (
                  <tr className="border-t border-slate-700">
                    <td className="px-2 py-2 text-slate-400" colSpan={6}>
                      {plansBusy ? 'Memuat paket…' : 'Belum ada paket.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">
            Perubahan berlaku untuk pesanan baru. Pesanan yang sudah lunas tidak berubah.
          </p>
        </Panel>
      ) : null}

      {tab === 'pembayaran' ? (
        <Panel title="Pembayaran">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              Gateway aktif
              <select
                className={INPUT_CLASS}
                value={gateway}
                disabled={paymentBusy}
                onChange={(event) => setGateway(event.target.value)}
              >
                {GATEWAYS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-2 text-xs text-slate-400">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={xenditEnabled}
                  disabled={paymentBusy}
                  onChange={(event) => setXenditEnabled(event.target.checked)}
                />
                Aktifkan Xendit
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={midtransEnabled}
                  disabled={paymentBusy}
                  onChange={(event) => setMidtransEnabled(event.target.checked)}
                />
                Aktifkan Midtrans
              </label>
            </div>
          </div>

          <label className={LABEL_CLASS}>
            Instruksi pembayaran
            <textarea
              className="min-h-24 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              value={instructions}
              disabled={paymentBusy}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Contoh: Transfer ke rekening berikut, lalu unggah bukti transfer."
            />
          </label>

          <p className="text-xs text-slate-400">
            Kunci API Xendit: {payment?.xenditConfigured ? 'terpasang' : 'belum'} di server.
          </p>
          <p className="text-xs text-slate-400">
            Kunci API Midtrans: {payment?.midtransConfigured ? 'terpasang' : 'belum'} di server.
          </p>
          <p className="text-xs text-amber-400">
            Peringatan: gateway otomatis hanya bisa diaktifkan bila kunci API sudah dipasang di server.
          </p>

          <div>
            <button
              type="button"
              className="rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 text-sm text-slate-100"
              disabled={paymentBusy}
              onClick={() => { void savePaymentConfig(); }}
            >
              {paymentBusy ? 'Menyimpan…' : 'Simpan'}
            </button>
          </div>
        </Panel>
      ) : null}

      {tab === 'branding' ? (
        <Panel title="Branding">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              Nama aplikasi
              <input
                className={INPUT_CLASS}
                type="text"
                value={brandingForm.appName}
                disabled={brandingBusy}
                onChange={(event) => setBrandingForm((prev) => ({ ...prev, appName: event.target.value }))}
              />
            </label>
            <label className={LABEL_CLASS}>
              Tagline
              <input
                className={INPUT_CLASS}
                type="text"
                value={brandingForm.tagline}
                disabled={brandingBusy}
                onChange={(event) => setBrandingForm((prev) => ({ ...prev, tagline: event.target.value }))}
              />
            </label>
            <label className={LABEL_CLASS}>
              Warna utama
              <input
                className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                type="color"
                value={brandingForm.primaryColor || '#8b5cf6'}
                disabled={brandingBusy}
                onChange={(event) => setBrandingForm((prev) => ({ ...prev, primaryColor: event.target.value }))}
              />
            </label>
            <label className={LABEL_CLASS}>
              Email dukungan
              <input
                className={INPUT_CLASS}
                type="email"
                value={brandingForm.supportEmail}
                disabled={brandingBusy}
                onChange={(event) => setBrandingForm((prev) => ({ ...prev, supportEmail: event.target.value }))}
              />
            </label>
            <label className={LABEL_CLASS}>
              URL logo
              <input
                className={INPUT_CLASS}
                type="text"
                value={brandingForm.logoUrl}
                disabled={brandingBusy}
                onChange={(event) => setBrandingForm((prev) => ({ ...prev, logoUrl: event.target.value }))}
                placeholder="https://contoh.com/logo.png"
              />
            </label>
            <label className={LABEL_CLASS}>
              URL favicon
              <input
                className={INPUT_CLASS}
                type="text"
                value={brandingForm.faviconUrl}
                disabled={brandingBusy}
                onChange={(event) => setBrandingForm((prev) => ({ ...prev, faviconUrl: event.target.value }))}
                placeholder="https://contoh.com/favicon.ico"
              />
            </label>
          </div>

          <div>
            <button
              type="button"
              className="rounded-lg border border-slate-700 bg-violet-600 px-3 py-2 text-sm text-slate-100"
              disabled={brandingBusy}
              onClick={() => { void saveBranding(); }}
            >
              {brandingBusy ? 'Menyimpan…' : 'Simpan branding'}
            </button>
          </div>
        </Panel>
      ) : null}
    </section>
  );
}

/**
 * Uji Wave 11C butir 74 — nominal unik untuk transfer manual.
 *
 * Yang dibuktikan suite ini (semua lewat HTTP ke peladen nyata `../src/server.js`, kecuali dua
 * pemeriksaan unit yang memang memanggil fungsi modul seperti suite council Wave 11B):
 *  ① 200 pesanan transfer manual berturut-turut mendapat nominal unik yang BERBEDA semua.
 *  ② `amount_idr` dan `total_idr` tidak pernah diubah; kode unik disimpan di `orders.unique_amount_idr`.
 *  ③ Kode unik selalu 1..999 dan nominalnya = dasar + kode (dasar = `total_idr`, atau `amount_idr` bila
 *    totalnya nol, dibuktikan lewat pesanan berkupon yang totalnya lebih kecil dari harga paket).
 *  ④ Kode unik hanya untuk pesanan transfer manual: pesanan gateway ditolak 409 GATEWAY_EXACT_AMOUNT
 *    dan kolomnya tetap kosong.
 *  ⑤ Pemasangan bersifat idempoten (klik ganda tidak mengubah nominal) dan tidak bocor ke akun lain
 *    (pesanan orang lain dijawab 404).
 *  ⑥ Pesanan yang sudah lunas dibebaskan kodenya, sehingga pesanannya yang lama tetap bisa diverifikasi
 *    dan tidak pernah kehabisan kode. Bila semua kode 1..999 sedang dipakai, jawabannya 503
 *    UNIQUE_AMOUNT_EXHAUSTED setelah tepat `config.UNIQUE_AMOUNT_MAX_TRIES` percobaan.
 *  ⑦ Antrean admin melihat nominal bayar yang benar, dan bisa mengisi kode unik untuk pesanan lama
 *    sekaligus (admin saja).
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11c-bayar.e2e.ts
 */
import { createServer as createTcpServer } from "node:net";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Mencari port bebas (7324 utama, cadangan 7306-7326). */
async function cariPortBebas(...utama: number[]): Promise<number> {
  const kandidat = [...utama, ...Array.from({ length: 21 }, (_, i) => 7306 + i)];
  for (const angka of kandidat) {
    const bebas = await new Promise<boolean>((resolve) => {
      const probe = createTcpServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(angka, "127.0.0.1");
    });
    if (bebas) return angka;
  }
  throw new Error("Tidak ada port bebas untuk suite bayar (7306-7326).");
}

const port = await cariPortBebas(7324);
const dataDir = `/tmp/coder-wave11c-bayar-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11c-bayar-admin-${stamp}@example.test`;
const ownerEmail = `w11c-bayar-owner-${stamp}@example.test`;
const luarEmail = `w11c-bayar-luar-${stamp}@example.test`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "80";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "80";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { getPlan } = await import("../src/billing.js");
const bayarMod: any = await import("../src/wave11c/bayar.js");

const base = `http://127.0.0.1:${port}`;
let passed = 0; let failed = 0;
const failedNames: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed += 1; console.log(`PASS ${name}`); return; }
  failed += 1; failedNames.push(name); console.log(`FAIL ${name} ${detail}`);
}
const short = (value: unknown, max = 260) => String(typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).slice(0, max);
const hitung = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number }).n ?? 0);
const semua = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params as any[]) as any[];
const satu = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as any[]) as any;

function client() {
  const jar = new Map<string, string>();
  let primed = false;
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  async function call(method: string, path: string, body?: unknown) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    if (mutating) await prime();
    const headers: Record<string, string> = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: base,
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(mutating && jar.get("coder_csrf") ? { "x-csrf-token": String(jar.get("coder_csrf")) } : {}),
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
      "accept-language": "id-ID",
    };
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const rawCookies = typeof (response.headers as any).getSetCookie === "function" ? (response.headers as any).getSetCookie() as string[] : [];
    for (const entry of rawCookies) {
      const pair = String(entry).split(";")[0];
      const cut = pair.indexOf("=");
      if (cut < 0) continue;
      const name = pair.slice(0, cut).trim(); const value = pair.slice(cut + 1);
      if (value === "") jar.delete(name); else jar.set(name, value);
    }
    const text = await response.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, json, text };
  }
  async function prime() { if (primed) return; primed = true; try { await call("GET", "/health"); } catch { /* server belum siap */ } }
  return { call, bootstrap: prime };
}

const admin = client(); const owner = client(); const luar = client();
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { const ready = await fetch(`${base}/health`); if (ready.ok) break; } catch { /* belum siap */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
console.log(`INFO server uji siap di ${base} (skema ${SCHEMA_VERSION}), data di ${dataDir}`);

async function register(account: ReturnType<typeof client>, email: string, name: string) {
  await account.bootstrap();
  return account.call("POST", "/api/v1/auth/register", { email, password, displayName: name });
}
async function buatPesanan(account: ReturnType<typeof client>, planCode: string, couponCode?: string) {
  return account.call("POST", "/api/v1/billing/orders", couponCode ? { planCode, couponCode } : { planCode });
}

/* =====================================================================================
 * Bagian 0: akun, paket, dan batas config.
 * ===================================================================================== */
console.log("\n--- Bagian 0: akun, paket, batas ---");
const adminReg = await register(admin, adminEmail, "Admin Bayar 11C");
const ownerReg = await register(owner, ownerEmail, "Pemilik Bayar 11C");
const luarReg = await register(luar, luarEmail, "Orang Luar Bayar 11C");
const ownerUserId = String(ownerReg.json?.user?.id ?? "");
const premium = getPlan("premium");
check("B0. akun admin + pemilik + orang luar siap, paket premium punya harga rupiah", adminReg.status === 201 && ownerReg.status === 201 && luarReg.status === 201
  && Boolean(ownerUserId) && Number(premium?.priceIdr ?? 0) > 0, short({ admin: adminReg.status, owner: ownerReg.status, luar: luarReg.status, harga: premium?.priceIdr }));
check("B1. jalur lama (POST /api/v1/billing/orders) tetap membuat pesanan manual dengan status pending", (await buatPesanan(owner, "premium")).status === 200, "");
check("B2. batas percobaan kode = config.UNIQUE_AMOUNT_MAX_TRIES (20) dan rentang kode 1..999", config.UNIQUE_AMOUNT_MAX_TRIES === 20
  && bayarMod.KODE_UNIK_MIN === 1 && bayarMod.KODE_UNIK_MAKS === 999, short({ tries: config.UNIQUE_AMOUNT_MAX_TRIES, min: bayarMod.KODE_UNIK_MIN, maks: bayarMod.KODE_UNIK_MAKS }));

const hargaPremium = Number(premium!.priceIdr);

/* =====================================================================================
 * Bagian 1: 200 pesanan manual berturut-turut.
 * ===================================================================================== */
console.log("\n--- Bagian 1: 200 pesanan manual ---");
const JUMLAH = 200;
const idPesanan: string[] = [];
const gagalBuat: string[] = [];
for (let i = 0; i < JUMLAH; i += 1) {
  const reply = await buatPesanan(owner, "premium");
  const id = String(reply.json?.order?.id ?? "");
  if (reply.status === 200 && id) idPesanan.push(id); else gagalBuat.push(`${reply.status}:${short(reply.json, 60)}`);
}
check(`B3. ${JUMLAH} pesanan manual dibuat lewat rute lama tanpa galat`, idPesanan.length === JUMLAH, short(gagalBuat.slice(0, 3)));
const contohOrder = satu("SELECT method, status, amount_idr AS amountIdr, total_idr AS totalIdr FROM orders WHERE id=?", idPesanan[0]);
check("B4. pesanan itu method='manual', status='pending', dan nominalnya = harga paket", String(contohOrder?.method) === "manual" && String(contohOrder?.status) === "pending"
  && Number(contohOrder?.amountIdr) === hargaPremium && Number(contohOrder?.totalIdr) === hargaPremium, short(contohOrder));

const nominal: number[] = [];
const gagalPasang: string[] = [];
let responsPertama: any = null;
for (let i = 0; i < idPesanan.length; i += 1) {
  const reply = await owner.call("POST", `/api/v1/billing/orders/${idPesanan[i]}/unique-amount`);
  if (reply.status === 200 && Number(reply.json?.uniqueAmountIdr ?? 0) > 0) { nominal.push(Number(reply.json.uniqueAmountIdr)); if (i === 0) responsPertama = reply.json; }
  else gagalPasang.push(`${reply.status}:${short(reply.json, 60)}`);
}
check(`B5. ${JUMLAH} pesanan mendapat kode unik tanpa galat`, nominal.length === JUMLAH, short(gagalPasang.slice(0, 3)));
check(`B6. tidak ada satu pun nominal kembar di antara ${JUMLAH} pesanan aktif`, new Set(nominal).size === JUMLAH, short({ unik: new Set(nominal).size, total: nominal.length }));
const selisih = nominal.map((nilai) => nilai - hargaPremium);
check("B7. setiap kode unik berada di rentang 1..999 di atas dasar nominal", selisih.every((k) => k >= 1 && k <= 999), short({ min: Math.min(...selisih), maks: Math.max(...selisih) }));
check("B8. kode unik tidak selalu sama (bervariasi, bukan angka tetap)", new Set(selisih).size > 1, short({ kodeBerbeda: new Set(selisih).size }));
// Diperbaiki 26 Sep 2026 (audit cek vakum): `.every()` pada daftar kosong selalu lulus, jadi query
// yang mengembalikan 0 baris dulu "lulus" tanpa memeriksa apa pun. Barisnya kini dibatasi ke pesanan
// yang benar-benar sudah dipasangi kode unik, dan jumlahnya diperiksa lebih dulu (B9a) supaya B9
// tidak bisa lulus vakum.
const taksaNominal = semua("SELECT amount_idr AS amountIdr, total_idr AS totalIdr, unique_amount_idr AS uniqueAmountIdr FROM orders WHERE method='manual' AND unique_amount_idr IS NOT NULL LIMIT 500");
check(`B9a. baris yang diperiksa B9 tidak kosong (${JUMLAH} pesanan berkode unik terbaca)`, taksaNominal.length === JUMLAH,
  short({ terbaca: taksaNominal.length, harap: JUMLAH }));
check("B9. amount_idr dan total_idr TIDAK diubah pemasangan kode unik (tetap harga paket)", taksaNominal.every((row) => Number(row.amountIdr) === hargaPremium && Number(row.totalIdr) === hargaPremium), short(taksaNominal.slice(0, 2)));
check("B10. nominal unik tersimpan di kolom terpisah orders.unique_amount_idr (bukan di total)", hitung("SELECT COUNT(*) AS n FROM orders WHERE unique_amount_idr IS NOT NULL") === JUMLAH
  && hitung("SELECT COUNT(*) AS n FROM orders WHERE unique_amount_idr = total_idr") === 0, short({ berkolom: hitung("SELECT COUNT(*) AS n FROM orders WHERE unique_amount_idr IS NOT NULL") }));
check("B11. balasan rute memuat uniqueAmountIdr, k, baseIdr, dan catatan yang bisa dibaca klien", Number(responsPertama?.uniqueAmountIdr) === hargaPremium + Number(responsPertama?.k)
  && Number(responsPertama?.baseIdr) === hargaPremium && Number(responsPertama?.k) >= 1 && typeof responsPertama?.catatan === "string" && responsPertama?.sudahAda === false, short(responsPertama));
check("B12. kolom order, kolom nominal, dan percobaan tercatat di audit", hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.order_unique_amount'") === JUMLAH, short(hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.order_unique_amount'")));

const ulang = await owner.call("POST", `/api/v1/billing/orders/${idPesanan[0]}/unique-amount`);
check("B13. pemasangan ulang idempoten: kode sama, sudahAda true, tidak ada audit ganda", ulang.status === 200
  && Number(ulang.json?.uniqueAmountIdr) === nominal[0] && ulang.json?.sudahAda === true
  && hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.order_unique_amount'") === JUMLAH, short(ulang.json));

const milikOrangLain = await luar.call("POST", `/api/v1/billing/orders/${idPesanan[1]}/unique-amount`);
check("B14. pesanan milik akun lain dijawab 404 ORDER_NOT_FOUND (keberadaannya tidak dibocorkan)", milikOrangLain.status === 404 && milikOrangLain.json?.error === "ORDER_NOT_FOUND", `${milikOrangLain.status} ${short(milikOrangLain.json)}`);
const pesananHantu = await owner.call("POST", `/api/v1/billing/orders/${randomUUID()}/unique-amount`);
check("B15. pesanan yang tidak ada dijawab 404 ORDER_NOT_FOUND", pesananHantu.status === 404 && pesananHantu.json?.error === "ORDER_NOT_FOUND", `${pesananHantu.status} ${short(pesananHantu.json)}`);

/* =====================================================================================
 * Bagian 2: pesanan lunas membebaskan kodenya (verifikasi lama tetap jalan).
 * ===================================================================================== */
console.log("\n--- Bagian 2: pesanan lunas & verifikasi lama ---");
const target = idPesanan[1];
const kodeTarget = nominal[1] - hargaPremium;
const putusan = await admin.call("POST", `/api/v1/admin/orders/${target}/decision`, { decision: "paid", note: "uji verifikasi manual" });
const pesananLunas = satu("SELECT status, unique_amount_idr AS uniqueAmountIdr FROM orders WHERE id=?", target);
check("B16. admin masih bisa memverifikasi pesanan manual sebagai lunas (status paid, kode unik tetap tercatat)", putusan.status === 200
  && String(pesananLunas?.status) === "paid" && Number(pesananLunas?.uniqueAmountIdr) === nominal[1], `${putusan.status} ${short(pesananLunas)}`);
check("B17. pelunasan membuat langganan aktif untuk paket yang dibayar", hitung("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=? AND plan_code='premium' AND status='active' AND expires_at > ?", ownerUserId, new Date().toISOString()) >= 1,
  short(semua("SELECT plan_code AS planCode, status, expires_at AS expiresAt FROM subscriptions WHERE user_id=?", ownerUserId)));
const pasangLagi = await owner.call("POST", `/api/v1/billing/orders/${target}/unique-amount`);
// Perilaku modul: pesanan yang SUDAH punya kode dikembalikan apa adanya (idempoten), termasuk setelah
// lunas, supaya kode lama tetap bisa dipakai mencocokkan mutasi bank. Yang penting: TIDAK ada kode baru.
check("B18. pesanan yang sudah lunas tidak mendapat kode BARU (kode lama dipertahankan untuk verifikasi)", pasangLagi.status === 200
  && Number(pasangLagi.json?.uniqueAmountIdr) === nominal[1] && pasangLagi.json?.sudahAda === true
  && Number(satu("SELECT unique_amount_idr AS uniqueAmountIdr FROM orders WHERE id=?", target)?.uniqueAmountIdr) === nominal[1], `${pasangLagi.status} ${short(pasangLagi.json)}`);
const kodeBebas = bayarMod.pilihNominalUnik(hargaPremium, { mulaiDariK: kodeTarget });
check("B19. kode unik pesanan lunas bebas dipakai lagi (nomor tidak pernah habis)", kodeBebas.ok === true && kodeBebas.k === kodeTarget
  && hitung("SELECT COUNT(*) AS n FROM orders WHERE unique_amount_idr=? AND status='pending'", hargaPremium + kodeTarget) === 0, short(kodeBebas));
const urutanBaru = await owner.call("POST", `/api/v1/billing/orders/${idPesanan[2]}/unique-amount`);
const kodeTetap = bayarMod.barisOrder(idPesanan[2]).uniqueAmountIdr;
check("B20. kode unik pesanan aktif tidak pernah diubah ulang oleh pemanggilan berikutnya", urutanBaru.status === 200 && Number(kodeTetap) === nominal[2], short({ kodeTetap, nominalAwal: nominal[2] }));

/* =====================================================================================
 * Bagian 3: dasar nominal (total setelah potongan) dan pesanan gateway.
 * ===================================================================================== */
console.log("\n--- Bagian 3: dasar nominal & gateway ---");
const kupon = await admin.call("POST", "/api/v1/admin/coupons", { code: `DISKON11C${String(stamp).slice(-5)}`, percent: 10 });
const kodeKupon = String(kupon.json?.coupon?.code ?? "");
const pesananDiskon = await buatPesanan(owner, "premium", kodeKupon);
const idDiskon = String(pesananDiskon.json?.order?.id ?? "");
const potongDiskon = await owner.call("POST", `/api/v1/billing/orders/${idDiskon}/unique-amount`);
const totalDiskon = Number(satu("SELECT total_idr AS totalIdr, amount_idr AS amountIdr FROM orders WHERE id=?", idDiskon)?.totalIdr);
check("B21. pesanan berkupon: dasar kode unik = total SETELAH potongan, amount_idr tetap harga penuh", [200, 201].includes(kupon.status) && potongDiskon.status === 200
  && Number(potongDiskon.json?.baseIdr) === totalDiskon && totalDiskon === hargaPremium - Math.round(hargaPremium * 10 / 100)
  && Number(satu("SELECT amount_idr AS amountIdr FROM orders WHERE id=?", idDiskon)?.amountIdr) === hargaPremium
  && Number(potongDiskon.json?.uniqueAmountIdr) === totalDiskon + Number(potongDiskon.json?.k), short({ kupon: kodeKupon, totalDiskon, balasan: potongDiskon.json }));

const { createOrder } = await import("../src/billing.js");
const gateway = createOrder({ userId: ownerUserId, planCode: "premium", method: "xendit" });
const idGateway = gateway.ok ? gateway.order.id : "";
const pasangGateway = await owner.call("POST", `/api/v1/billing/orders/${idGateway}/unique-amount`);
check("B22. pesanan gateway menolak kode unik -> 409 GATEWAY_EXACT_AMOUNT", gateway.ok && gateway.order.method === "xendit"
  && pasangGateway.status === 409 && pasangGateway.json?.error === "GATEWAY_EXACT_AMOUNT", `${pasangGateway.status} ${short(pasangGateway.json)}`);
check("B23. kolom unique_amount_idr pesanan gateway tetap kosong (nominal persis untuk gateway)", satu("SELECT unique_amount_idr AS uniqueAmountIdr FROM orders WHERE id=?", idGateway)?.uniqueAmountIdr === null, short(satu("SELECT unique_amount_idr AS uniqueAmountIdr, method FROM orders WHERE id=?", idGateway)));

const pesananNolTotal = { id: randomUUID() };
db.prepare(`INSERT INTO orders (id,user_id,plan_code,months,amount_idr,total_idr,status,method,created_at,updated_at)
  VALUES (?,?,'enterprise',1,50000,0,'pending','manual',?,?)`).run(pesananNolTotal.id, ownerUserId, new Date().toISOString(), new Date().toISOString());
const hasilNol = bayarMod.pasangNominalUnik(pesananNolTotal.id);
check("B24. bila total nol, dasar kode unik memakai amount_idr (50000) — bukan nol", hasilNol.ok === true && hasilNol.dasarIdr === 50000
  && hasilNol.order.uniqueAmountIdr >= 50001 && hasilNol.order.uniqueAmountIdr <= 50999, short(hasilNol));
const tampilan = bayarMod.tampilanNominal(pesananNolTotal.id);
check("B25. tampilanNominal melaporkan nominal bayar = kode unik dan k yang cocok", tampilan?.nominalBayarIdr === (hasilNol.ok ? hasilNol.order.uniqueAmountIdr : -1)
  && tampilan?.k === (hasilNol.ok ? hasilNol.k : -1) && tampilan?.dasarIdr === 50000, short(tampilan));

/* =====================================================================================
 * Bagian 4: kode habis (503) dan antrean admin.
 * ===================================================================================== */
console.log("\n--- Bagian 4: kode habis & antrean admin ---");
const dasarLangka = 777_000;
const sisip = db.prepare(`INSERT INTO orders (id,user_id,plan_code,months,amount_idr,total_idr,status,method,unique_amount_idr,created_at,updated_at)
  VALUES (?,?,'premium',1,?,?,'pending','manual',?,?,?)`);
const sekarang = new Date().toISOString();
db.transaction(() => {
  for (let k = 1; k <= 999; k += 1) sisip.run(`langka-${stamp}-${k}`, ownerUserId, dasarLangka, dasarLangka, dasarLangka + k, sekarang, sekarang);
  sisip.run(`langka-target-${stamp}`, ownerUserId, dasarLangka, dasarLangka, null, sekarang, sekarang);
})();
const habis = await owner.call("POST", `/api/v1/billing/orders/langka-target-${stamp}/unique-amount`);
check("B26. semua kode 1..999 terpakai -> 503 UNIQUE_AMOUNT_EXHAUSTED (bukan kode kembar)", habis.status === 503 && habis.json?.error === "UNIQUE_AMOUNT_EXHAUSTED", `${habis.status} ${short(habis.json)}`);
check("B27. penolakan menyebut tepat config.UNIQUE_AMOUNT_MAX_TRIES (20) percobaan dan kolom tetap kosong", Number(habis.json?.percobaan) === config.UNIQUE_AMOUNT_MAX_TRIES
  && satu("SELECT unique_amount_idr AS uniqueAmountIdr FROM orders WHERE id=?", `langka-target-${stamp}`)?.uniqueAmountIdr === null, short(habis.json));
const fungsional = bayarMod.pilihNominalUnik(dasarLangka);
check("B28. fungsi pencarian kode juga melaporkan habis (dasar berbeda tetap dapat kode)", fungsional.ok === false && fungsional.error === "UNIQUE_AMOUNT_EXHAUSTED"
  && fungsional.percobaan === config.UNIQUE_AMOUNT_MAX_TRIES && bayarMod.pilihNominalUnik(123_456).ok === true, short({ fungsional, lain: bayarMod.pilihNominalUnik(123_456) }));
const tetapUnik = semua("SELECT unique_amount_idr AS uniqueAmountIdr FROM orders WHERE status='pending' AND method='manual' AND unique_amount_idr IS NOT NULL");
check("B29. setelah ribuan pesanan, tidak ada nominal unik kembar di seluruh pesanan aktif", tetapUnik.length === new Set(tetapUnik.map((row) => Number(row.uniqueAmountIdr))).size, short({ baris: tetapUnik.length, unik: new Set(tetapUnik.map((row) => Number(row.uniqueAmountIdr))).size }));

const antrean = await admin.call("GET", "/api/v1/billing/manual-orders/queue?limit=500");
const antreanLuar = await owner.call("GET", "/api/v1/billing/manual-orders/queue");
check("B30. admin bisa membuka antrean transfer manual (nominal bayar terlihat)", antrean.status === 200 && Array.isArray(antrean.json?.orders) && antrean.json.orders.length >= JUMLAH
  && antrean.json.orders.every((row: any) => Number(row.nominalBayarIdr) === Number(row.uniqueAmountIdr ?? row.totalIdr)), `${antrean.status} ${short(antrean.json?.orders?.[0])}`);
check("B31. bukan admin tidak boleh membuka antrean -> 403 ADMIN_REQUIRED", antreanLuar.status === 403 && antreanLuar.json?.error === "ADMIN_REQUIRED", `${antreanLuar.status} ${short(antreanLuar.json)}`);

const lama: string[] = [];
for (let i = 0; i < 3; i += 1) { const reply = await buatPesanan(owner, "enterprise"); lama.push(String(reply.json?.order?.id ?? "")); }
check("B32. tiga pesanan lama tanpa kode unik disiapkan untuk pengisian borongan", lama.every((id) => Boolean(id))
  && hitung("SELECT COUNT(*) AS n FROM orders WHERE id IN (?,?,?) AND unique_amount_idr IS NULL", ...lama) === 3, short(lama));
const isiBoronganLuar = await owner.call("POST", "/api/v1/billing/manual-orders/queue/unique-amounts", { limit: 100 });
const isiBorongan = await admin.call("POST", "/api/v1/billing/manual-orders/queue/unique-amounts", { limit: 100 });
check("B33. pengisian borongan hanya untuk admin -> 403 ADMIN_REQUIRED", isiBoronganLuar.status === 403 && isiBoronganLuar.json?.error === "ADMIN_REQUIRED", `${isiBoronganLuar.status} ${short(isiBoronganLuar.json)}`);
// Pesanan `langka-target` sengaja dibiarkan tanpa kode di antara kandidat: pengisian borongan harus
// MELAPORKAN kegagalannya (kode habis), bukan melewatinya diam-diam.
check("B34. admin mengisi kode unik pesanan lama sekaligus, kegagalan dilaporkan apa adanya", isiBorongan.status === 200
  && Number(isiBorongan.json?.diisi) >= 3
  // Penjaga anti-lulus-vakum (audit 26 Sep 2026): `?? []` membuat `.every()` selalu lulus saat
  // daftar kegagalan kosong, padahal satu pesanan sengaja dibiarkan tanpa kode di antara kandidat.
  && (isiBorongan.json?.kegagalan ?? []).length >= 1
  && (isiBorongan.json?.kegagalan ?? []).every((row: any) => row.error === "UNIQUE_AMOUNT_EXHAUSTED")
  && hitung("SELECT COUNT(*) AS n FROM orders WHERE id IN (?,?,?) AND unique_amount_idr IS NOT NULL", ...lama) === 3
  && hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.manual_queue_filled'") === 1, short(isiBorongan.json));
const nominalLama = semua("SELECT total_idr AS totalIdr, unique_amount_idr AS uniqueAmountIdr FROM orders WHERE id IN (?,?,?)", ...lama);
check("B35. kode unik hasil pengisian borongan juga 1..999 di atas dasar dan berbeda satu sama lain", nominalLama.length === 3
  // Penjaga panjang (audit 26 Sep 2026): tanpa ini, daftar kosong membuat `.every()` dan
  // `Set().size === length` sama-sama lulus tanpa membuktikan satu baris pun.
  && nominalLama.every((row) => Number(row.uniqueAmountIdr) - Number(row.totalIdr) >= 1 && Number(row.uniqueAmountIdr) - Number(row.totalIdr) <= 999)
  && new Set(nominalLama.map((row) => Number(row.uniqueAmountIdr))).size === nominalLama.length, short(nominalLama));

/* =====================================================================================
 * Bagian 5: jalur lama tetap utuh.
 * ===================================================================================== */
console.log("\n--- Bagian 5: jalur lama ---");
const daftarPesanan = await owner.call("GET", "/api/v1/billing/orders");
const kuponLama = await owner.call("POST", "/api/v1/billing/coupons/validate", { code: kodeKupon, amountIdr: hargaPremium });
check("B36. daftar pesanan pemilik tetap bisa dibaca (rute lama tidak rusak)", daftarPesanan.status === 200 && Array.isArray(daftarPesanan.json?.orders) && daftarPesanan.json.orders.length >= 50, `${daftarPesanan.status}`);
check("B37. pemeriksaan kupon lama tetap jalan (diskon 10% dari harga penuh)", kuponLama.status === 200 && Number(kuponLama.json?.discountIdr) === Math.round(hargaPremium * 10 / 100), `${kuponLama.status} ${short(kuponLama.json)}`);
const bukti = await owner.call("POST", `/api/v1/billing/orders/${lama[0]}/proof`, { filename: "bukti.png", contentBase64: Buffer.from("kuitansi-uji").toString("base64") });
check("B38. bukti transfer tetap bisa diunggah untuk pesanan bernominal unik (nominal bayar tidak mengganggu unggahan)", bukti.status === 200
  && Number(satu("SELECT total_idr AS totalIdr FROM orders WHERE id=?", lama[0])?.totalIdr) === Number(getPlan("enterprise")!.priceIdr), `${bukti.status} ${short(bukti.json)}`);
check("B39. pesanan dengan kode unik tetap bisa diverifikasi admin setelah bukti masuk", (await admin.call("POST", `/api/v1/admin/orders/${lama[0]}/decision`, { decision: "paid" })).status === 200
  && String(satu("SELECT status FROM orders WHERE id=?", lama[0])?.status) === "paid", short(satu("SELECT status, unique_amount_idr AS uniqueAmountIdr FROM orders WHERE id=?", lama[0])));

console.log(`\nRingkasan: ${passed} lulus, ${failed} gagal`);
if (failedNames.length) console.log(`Gagal: ${failedNames.join(" | ")}`);
if (!failed) { rmSync(dataDir, { recursive: true, force: true }); console.log("INFO data uji dihapus karena semua lulus."); }
else console.log(`INFO data uji disimpan di ${dataDir} untuk pemeriksaan.`);
process.exit(failed ? 1 : 0);

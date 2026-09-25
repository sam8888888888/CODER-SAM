/**
 * Uji Wave 11C butir 75 — kupon percobaan (TRIAL).
 *
 * Yang dibuktikan suite ini (lewat HTTP ke peladen nyata `../src/server.js`, plus dua pemeriksaan unit
 * fungsi modul seperti suite Wave 11B):
 *  ① Hanya admin platform yang boleh membuat kupon percobaan; kuponnya 100% potongan, `max_uses`
 *    sesuai permintaan, masa berlaku = sekarang + `hours`, dan ditandai `trial=1` + `trial_plan_code`.
 *  ② Kode dibuat server: delapan karakter, tanpa huruf/angka yang mudah tertukar (tanpa I, O, 0, 1),
 *    dan tidak pernah kembar.
 *  ③ Kupon percobaan HANYA sah untuk paket yang ditentukan. Paket lain dijawab TRIAL_PLAN_ONLY dengan
 *    kalimat yang sudah ditetapkan PRD — dan sekarang juga ditegakkan di rute lama `POST /orders`.
 *  ④ Sekali pakai: pemakaian kedua ditolak COUPON_EXHAUSTED, tanpa pesanan atau langganan tambahan.
 *  ⑤ Kupon kedaluwarsa ditolak COUPON_EXPIRED dan TIDAK pernah diperpanjang diam-diam (kolom
 *    `expires_at` tidak berubah, masa langganan tidak bertambah).
 *  ⑥ Masa langganan percobaan mengikuti aturan paket (`plans.period_days` x bulan), sedangkan `hours`
 *    hanya membatasi kupon. Perbedaan ini dinyatakan apa adanya di suite ini.
 *  ⑦ Percobaan yang tidak benar-benar gratis ditolak (TRIAL_NOT_FREE) dan pesanannya dibatalkan,
 *    supaya tidak ada tagihan tak terduga.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11c-kupon.e2e.ts
 */
import { createServer as createTcpServer } from "node:net";
import { rmSync } from "node:fs";

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
  throw new Error("Tidak ada port bebas untuk suite kupon (7306-7326).");
}

const port = await cariPortBebas(7325);
const dataDir = `/tmp/coder-wave11c-kupon-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const stamp = Date.now();
const password = "SandiUji2026!aman";
const adminEmail = `w11c-kupon-admin-${stamp}@example.test`;
const ownerEmail = `w11c-kupon-owner-${stamp}@example.test`;
const luarEmail = `w11c-kupon-luar-${stamp}@example.test`;

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
const kuponMod: any = await import("../src/wave11c/kupon.js");

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
const buatTrial = (account: ReturnType<typeof client>, body: unknown) => account.call("POST", "/api/v1/admin/coupons/trial", body);
const validasiTrial = (account: ReturnType<typeof client>, body: unknown) => account.call("POST", "/api/v1/billing/trial-coupons/validate", body);
const buatPesananTrial = (account: ReturnType<typeof client>, body: unknown) => account.call("POST", "/api/v1/billing/trial-orders", body);

/* =====================================================================================
 * Bagian 0: akun, paket, dan tetapan modul.
 * ===================================================================================== */
console.log("\n--- Bagian 0: akun, paket, tetapan ---");
const adminReg = await register(admin, adminEmail, "Admin Kupon 11C");
const ownerReg = await register(owner, ownerEmail, "Pemilik Kupon 11C");
const luarReg = await register(luar, luarEmail, "Orang Luar Kupon 11C");
const ownerUserId = String(ownerReg.json?.user?.id ?? "");
const premium = getPlan("premium");
const enterprise = getPlan("enterprise");
const hargaPremium = Number(premium!.priceIdr);
const periodePremium = Number(premium!.periodDays);
check("K0. akun admin + pemilik + orang luar siap dan paket premium/enterprise ada", adminReg.status === 201 && ownerReg.status === 201 && luarReg.status === 201
  && hargaPremium > 0 && Number(enterprise?.priceIdr ?? 0) > 0, short({ admin: adminReg.status, owner: ownerReg.status, luar: luarReg.status, hargaPremium }));
check(`K1. tetapan percobaan: config.TRIAL_COUPON_HOURS=${config.TRIAL_COUPON_HOURS} (24), kode ${kuponMod.PANJANG_KODE_TRIAL} karakter tanpa I/O/0/1`, config.TRIAL_COUPON_HOURS === 24
  && kuponMod.PANJANG_KODE_TRIAL === 8 && kuponMod.ALFABET_KODE_TRIAL === "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  && !/[IO01]/.test(kuponMod.ALFABET_KODE_TRIAL), short({ jam: config.TRIAL_COUPON_HOURS, alfabet: kuponMod.ALFABET_KODE_TRIAL }));
check("K2. pesan paket salah sama persis dengan kalimat yang diminta PRD", kuponMod.TRIAL_PESAN_PAKET_SALAH === "Kupon percobaan hanya berlaku untuk paket yang ditentukan.", short(kuponMod.TRIAL_PESAN_PAKET_SALAH));

/* =====================================================================================
 * Bagian 1: pembuatan kupon percobaan (admin).
 * ===================================================================================== */
console.log("\n--- Bagian 1: pembuatan kupon ---");
const bukanAdmin = await buatTrial(owner, { planCode: "premium" });
check("K3. bukan admin tidak boleh membuat kupon percobaan -> 403 ADMIN_REQUIRED", bukanAdmin.status === 403 && bukanAdmin.json?.error === "ADMIN_REQUIRED", `${bukanAdmin.status} ${short(bukanAdmin.json)}`);
const planSalah = await buatTrial(admin, { planCode: "paket-karangan" });
check("K4. paket yang tidak ada -> 404 PLAN_NOT_FOUND", planSalah.status === 404 && planSalah.json?.error === "PLAN_NOT_FOUND", `${planSalah.status} ${short(planSalah.json)}`);
const jamNol = await buatTrial(admin, { planCode: "premium", hours: 0 });
const jamTerlalu = await buatTrial(admin, { planCode: "premium", hours: 721 });
check("K5. hours di luar 1..720 ditolak -> 400 INVALID_TRIAL_HOURS", jamNol.status === 400 && jamNol.json?.error === "INVALID_TRIAL_HOURS"
  && jamTerlalu.status === 400 && jamTerlalu.json?.error === "INVALID_TRIAL_HOURS", `${jamNol.status}/${jamTerlalu.status} ${short(jamNol.json)}`);
const pakaiNol = await buatTrial(admin, { planCode: "premium", maxUses: 0 });
const pakaiBanyak = await buatTrial(admin, { planCode: "premium", maxUses: 101 });
check("K6. maxUses di luar 1..100 ditolak -> 400 INVALID_TRIAL_MAX_USES", pakaiNol.status === 400 && pakaiNol.json?.error === "INVALID_TRIAL_MAX_USES"
  && pakaiBanyak.status === 400 && pakaiBanyak.json?.error === "INVALID_TRIAL_MAX_USES", `${pakaiNol.status}/${pakaiBanyak.status} ${short(pakaiNol.json)}`);

const sebelum = Date.now();
const buatUtama = await buatTrial(admin, { planCode: "premium" });
const kodeUtama = String(buatUtama.json?.coupon?.code ?? "");
const barisUtama = satu("SELECT * FROM coupons WHERE code=?", kodeUtama);
const sisaJam = (Date.parse(String(barisUtama?.expires_at)) - sebelum) / 3600_000;
check("K7. admin membuat kupon percobaan -> 201 dengan kode 8 karakter dari alfabet yang aman", buatUtama.status === 201
  && /^[A-Z0-9]{8}$/.test(kodeUtama) && !/[IO01]/.test(kodeUtama), `${buatUtama.status} ${short(buatUtama.json)}`);
check("K8. baris coupons: percent=100, max_uses=1, uses=0, active=1, trial=1, trial_plan_code='premium'", Number(barisUtama?.percent) === 100
  && Number(barisUtama?.max_uses) === 1 && Number(barisUtama?.uses) === 0 && Number(barisUtama?.active) === 1
  && Number(barisUtama?.trial) === 1 && String(barisUtama?.trial_plan_code) === "premium", short(barisUtama));
check("K9. masa berlaku bawaan = sekarang + 24 jam (toleransi 2 menit)", sisaJam > 23.96 && sisaJam < 24.04, short({ sisaJam }));
const buatDuaJam = await buatTrial(admin, { planCode: "premium", hours: 2, maxUses: 3 });
const sisaDuaJam = (Date.parse(String(satu("SELECT expires_at FROM coupons WHERE code=?", String(buatDuaJam.json?.coupon?.code))?.expires_at)) - Date.now()) / 3600_000;
check("K10. hours bisa diatur (2 jam) dan maxUses mengikuti permintaan (3)", buatDuaJam.status === 201 && Number(buatDuaJam.json?.coupon?.maxUses) === 3
  && sisaDuaJam > 1.9 && sisaDuaJam < 2.1, short({ sisaDuaJam, coupon: buatDuaJam.json?.coupon }));

const banyak: string[] = [];
for (let i = 0; i < 30; i += 1) banyak.push(String((await buatTrial(admin, { planCode: "premium", hours: 12 })).json?.coupon?.code ?? ""));
check("K11. 30 kupon berturut-turut: kode tidak pernah kembar, panjang 8, alfabet bersih", new Set(banyak).size === 30
  && banyak.every((kode) => /^[A-Z0-9]{8}$/.test(kode) && !/[IO01]/.test(kode)), short({ jumlah: new Set(banyak).size, contoh: banyak.slice(0, 3) }));
check("K12. setiap pembuatan kupon tercatat di audit (32 pembuatan berhasil)", hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.trial_coupon_created'") === 32, short(hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.trial_coupon_created'")));

const daftarAdmin = await admin.call("GET", "/api/v1/admin/coupons/trial?limit=100");
const daftarLuar = await owner.call("GET", "/api/v1/admin/coupons/trial");
check("K13. admin melihat daftar kupon percobaan (hanya kupon trial)", daftarAdmin.status === 200 && Array.isArray(daftarAdmin.json?.coupons)
  && daftarAdmin.json.coupons.length >= 32 && daftarAdmin.json.coupons.every((row: any) => row.trial === true && row.percent === 100)
  && daftarAdmin.json.coupons.some((row: any) => row.code === kodeUtama), `${daftarAdmin.status} ${short(daftarAdmin.json?.coupons?.length)}`);
check("K14. bukan admin tidak boleh melihat daftar kupon percobaan -> 403 ADMIN_REQUIRED", daftarLuar.status === 403 && daftarLuar.json?.error === "ADMIN_REQUIRED", `${daftarLuar.status} ${short(daftarLuar.json)}`);

/* =====================================================================================
 * Bagian 2: pemeriksaan kupon (paket, aktif, kedaluwarsa).
 * ===================================================================================== */
console.log("\n--- Bagian 2: pemeriksaan kupon ---");
const sah = await validasiTrial(owner, { code: kodeUtama, planCode: "premium" });
check("K15. kupon sah untuk paketnya: potongan penuh dan total jadi nol", sah.status === 200 && sah.json?.ok === true
  && Number(sah.json?.discountIdr) === hargaPremium && Number(sah.json?.totalIdr) === 0 && sah.json?.trialPlanCode === "premium"
  && sah.json?.uses === 0 && sah.json?.maxUses === 1, `${sah.status} ${short(sah.json)}`);

const paketSalah = await validasiTrial(owner, { code: kodeUtama, planCode: "enterprise" });
check("K16. paket lain ditolak dengan TRIAL_PLAN_ONLY dan kalimat PRD", paketSalah.status === 400 && paketSalah.json?.error === "TRIAL_PLAN_ONLY"
  && paketSalah.json?.message === kuponMod.TRIAL_PESAN_PAKET_SALAH, `${paketSalah.status} ${short(paketSalah.json)}`);
const paketSalahPesanan = await buatPesananTrial(owner, { planCode: "enterprise", couponCode: kodeUtama });
check("K17. pesanan percobaan untuk paket yang salah juga ditolak TRIAL_PLAN_ONLY (tanpa pesanan dibuat)", paketSalahPesanan.status === 400
  && paketSalahPesanan.json?.error === "TRIAL_PLAN_ONLY" && hitung("SELECT COUNT(*) AS n FROM orders WHERE coupon_code=?", kodeUtama) === 0, `${paketSalahPesanan.status} ${short(paketSalahPesanan.json)}`);

const kodeHantu = await validasiTrial(owner, { code: "ZZZZZZZZ", planCode: "premium" });
check("K18. kode karangan ditolak COUPON_NOT_FOUND", kodeHantu.status === 400 && kodeHantu.json?.error === "COUPON_NOT_FOUND", `${kodeHantu.status} ${short(kodeHantu.json)}`);

const kuponBiasa = await admin.call("POST", "/api/v1/admin/coupons", { code: `BIASA${String(stamp).slice(-4)}`, percent: 10 });
const kodeBiasa = String(kuponBiasa.json?.coupon?.code ?? "");
const biasaLewatTrial = await validasiTrial(owner, { code: kodeBiasa, planCode: "premium" });
const biasaLewatLama = await owner.call("POST", "/api/v1/billing/coupons/validate", { code: kodeBiasa, amountIdr: hargaPremium });
check("K19. kupon biasa bukan kupon percobaan (ditolak di rute trial, tetap jalan di rute lama)", [200, 201].includes(kuponBiasa.status)
  && biasaLewatTrial.status === 400 && biasaLewatTrial.json?.error === "NOT_TRIAL_COUPON"
  && biasaLewatLama.status === 200 && Number(biasaLewatLama.json?.discountIdr) === Math.round(hargaPremium * 10 / 100), short({ trial: biasaLewatTrial.json, lama: biasaLewatLama.json }));

const dinonaktifkan = await admin.call("PATCH", `/api/v1/admin/coupons/${kodeUtama}`, { active: false });
const setelahNonaktif = await validasiTrial(owner, { code: kodeUtama, planCode: "premium" });
check("K20. kupon yang dinonaktifkan ditolak COUPON_INACTIVE", dinonaktifkan.status === 200 && setelahNonaktif.status === 400
  && setelahNonaktif.json?.error === "COUPON_INACTIVE", `${setelahNonaktif.status} ${short(setelahNonaktif.json)}`);
await admin.call("PATCH", `/api/v1/admin/coupons/${kodeUtama}`, { active: true });

const buatKedaluwarsa = await buatTrial(admin, { planCode: "premium", hours: 1 });
const kodeKedaluwarsa = String(buatKedaluwarsa.json?.coupon?.code ?? "");
const waktuLampau = new Date(Date.now() - 3600_000).toISOString();
db.prepare("UPDATE coupons SET expires_at=? WHERE code=?").run(waktuLampau, kodeKedaluwarsa);
const kedaluwarsa = await validasiTrial(owner, { code: kodeKedaluwarsa, planCode: "premium" });
const barisSetelah = satu("SELECT expires_at AS expiresAt, uses, active, trial FROM coupons WHERE code=?", kodeKedaluwarsa);
const kedaluwarsaLagi = await validasiTrial(owner, { code: kodeKedaluwarsa, planCode: "premium" });
const barisSetelah2 = satu("SELECT expires_at AS expiresAt, uses, active FROM coupons WHERE code=?", kodeKedaluwarsa);
check("K21. kupon kedaluwarsa ditolak COUPON_EXPIRED", kedaluwarsa.status === 400 && kedaluwarsa.json?.error === "COUPON_EXPIRED", `${kedaluwarsa.status} ${short(kedaluwarsa.json)}`);
check("K22. tidak ada perpanjangan diam-diam: expires_at, uses, dan active tidak berubah setelah ditolak", String(barisSetelah?.expiresAt) === waktuLampau
  && String(barisSetelah2?.expiresAt) === waktuLampau && Number(barisSetelah2?.uses) === 0 && Number(barisSetelah2?.active) === 1
  && kedaluwarsaLagi.json?.error === "COUPON_EXPIRED", short({ sebelum: barisSetelah, sesudah: barisSetelah2 }));

/* =====================================================================================
 * Bagian 3: pemakaian satu kali dan masa langganan.
 * ===================================================================================== */
console.log("\n--- Bagian 3: pemakaian dan masa langganan ---");
const pesananSebelum = hitung("SELECT COUNT(*) AS n FROM orders");
const pesananTrial = await buatPesananTrial(owner, { planCode: "premium", couponCode: kodeUtama, months: 12 });
const idPesananTrial = String(pesananTrial.json?.order?.id ?? "");
const barisPesanan = satu("SELECT status, months, amount_idr AS amountIdr, discount_idr AS discountIdr, total_idr AS totalIdr, coupon_code AS couponCode FROM orders WHERE id=?", idPesananTrial);
check("K23. pesanan percobaan sah: total nol, langsung lunas, dan hanya satu bulan walau badan meminta 12", pesananTrial.status === 201
  && Boolean(idPesananTrial) && Number(barisPesanan?.totalIdr) === 0 && Number(barisPesanan?.months) === 1
  && Number(barisPesanan?.discountIdr) === hargaPremium && String(barisPesanan?.status) === "paid" && String(barisPesanan?.couponCode) === kodeUtama, `${pesananTrial.status} ${short({ barisPesanan, catatan: pesananTrial.json?.catatan })}`);
const langganan = satu("SELECT id, plan_code AS planCode, status, expires_at AS expiresAt FROM subscriptions WHERE order_id=?", idPesananTrial);
const hariLangganan = (Date.parse(String(langganan?.expiresAt)) - Date.now()) / 86_400_000;
check("K24. langganan percobaan aktif untuk paket yang ditentukan", langganan && String(langganan?.planCode) === "premium" && String(langganan?.status) === "active", short(langganan));
check(`K25. masa langganan mengikuti aturan paket (${periodePremium} hari), BUKAN 24 jam kupon — dinyatakan apa adanya`, hariLangganan > periodePremium - 1 && hariLangganan < periodePremium + 1
  && Number(pesananTrial.json?.trial?.uses) === 1 && Number(pesananTrial.json?.trial?.maxUses) === 1, short({ hariLangganan, trial: pesananTrial.json?.trial }));

const pakaiLagi = await buatPesananTrial(owner, { planCode: "premium", couponCode: kodeUtama });
check("K26. pemakaian kedua ditolak COUPON_EXHAUSTED", pakaiLagi.status === 400 && pakaiLagi.json?.error === "COUPON_EXHAUSTED", `${pakaiLagi.status} ${short(pakaiLagi.json)}`);
check("K27. penolakan tidak menambah pesanan maupun langganan", hitung("SELECT COUNT(*) AS n FROM orders") === pesananSebelum + 1
  && hitung("SELECT COUNT(*) AS n FROM subscriptions") === 1 && Number(satu("SELECT uses FROM coupons WHERE code=?", kodeUtama)?.uses) === 1, short({ pesanan: hitung("SELECT COUNT(*) AS n FROM orders"), langganan: hitung("SELECT COUNT(*) AS n FROM subscriptions") }));
check("K28. langganan tidak diperpanjang diam-diam oleh percobaan pemakaian kedua", String(satu("SELECT expires_at AS expiresAt FROM subscriptions WHERE order_id=?", idPesananTrial)?.expiresAt) === String(langganan?.expiresAt)
  && Number(pesananTrial.json?.trial?.uses) === 1, short(satu("SELECT expires_at AS expiresAt FROM subscriptions WHERE order_id=?", idPesananTrial)));
const validasiHabis = await validasiTrial(owner, { code: kodeUtama, planCode: "premium" });
check("K29. pemeriksaan kupon setelah dipakai menjawab COUPON_EXHAUSTED", validasiHabis.status === 400 && validasiHabis.json?.error === "COUPON_EXHAUSTED", `${validasiHabis.status} ${short(validasiHabis.json)}`);
const masaKupon = (Date.parse(String(satu("SELECT expires_at FROM coupons WHERE code=?", kodeUtama)?.expires_at)) - Date.now()) / 3600_000;
check("K30. hours hanya membatasi kupon: masa kupon tetap sekitar 24 jam, terpisah dari masa langganan paket", masaKupon > 23 && masaKupon < 25, short({ masaKupon }));
check("K31. pemakaian kupon percobaan tercatat di audit dengan jumlah pakai", hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.trial_order_created'") === 1, short(hitung("SELECT COUNT(*) AS n FROM audit_events WHERE action='billing.trial_order_created'")));

/* =====================================================================================
 * Bagian 4: gerbang di jalur lama dan jaring pengaman biaya.
 * ===================================================================================== */
console.log("\n--- Bagian 4: jalur lama & jaring pengaman ---");
const buatKedua = await buatTrial(admin, { planCode: "premium" });
const kodeKedua = String(buatKedua.json?.coupon?.code ?? "");
const lamaSalahPaket = await owner.call("POST", "/api/v1/billing/orders", { planCode: "enterprise", couponCode: kodeKedua });
const lamaPaketBenar = await owner.call("POST", "/api/v1/billing/orders", { planCode: "premium", couponCode: kodeKedua });
check("K32. gerbang paket juga berlaku di rute lama POST /api/v1/billing/orders (TRIAL_PLAN_ONLY)", lamaSalahPaket.status === 400
  && lamaSalahPaket.json?.error === "TRIAL_PLAN_ONLY" && hitung("SELECT COUNT(*) AS n FROM orders WHERE coupon_code=? AND plan_code='enterprise'", kodeKedua) === 0, `${lamaSalahPaket.status} ${short(lamaSalahPaket.json)}`);
check("K33. kupon percobaan tetap sah di jalur lama untuk paket yang benar (total nol, langsung lunas)", lamaPaketBenar.status === 200
  && Number(lamaPaketBenar.json?.order?.totalIdr) === 0 && String(lamaPaketBenar.json?.order?.status) === "paid", `${lamaPaketBenar.status} ${short(lamaPaketBenar.json)}`);

const kodeSetengah = "TRIALHALF";
db.prepare(`INSERT INTO coupons (code, percent, amount_idr, max_uses, uses, expires_at, active, created_at, trial, trial_plan_code)
  VALUES (?,50,0,3,0,?,1,?,1,'premium')`).run(kodeSetengah, new Date(Date.now() + 86_400_000).toISOString(), new Date().toISOString());
const setengahJalan = await buatPesananTrial(owner, { planCode: "premium", couponCode: kodeSetengah });
const pesananSetengah = semua("SELECT id, status, total_idr AS totalIdr FROM orders WHERE coupon_code=?", kodeSetengah);
check("K34. kupon percobaan yang tidak menutup seluruh biaya ditolak TRIAL_NOT_FREE", setengahJalan.status === 400
  && setengahJalan.json?.error === "TRIAL_NOT_FREE", `${setengahJalan.status} ${short(setengahJalan.json)}`);
check("K35. pesanan setengah jalan itu dibatalkan (bukan tagihan tak terduga)", pesananSetengah.length === 1
  && String(pesananSetengah[0]?.status) === "cancelled" && Number(pesananSetengah[0]?.totalIdr) > 0, short(pesananSetengah));

/* =====================================================================================
 * Bagian 5: pemeriksaan unit helper (urutan aturan).
 * ===================================================================================== */
console.log("\n--- Bagian 5: helper modul ---");
const seratus: string[] = Array.from({ length: 100 }, () => kuponMod.buatKodeTrial());
check("U1. buatKodeTrial: 100 kode unik, panjang 8, hanya alfabet aman", new Set(seratus).size === 100
  && seratus.every((kode) => kode.length === 8 && /^[A-Z0-9]+$/.test(kode) && !/[IO01]/.test(kode)), short(seratus.slice(0, 3)));
check("U2. urutan aturan: paket diperiksa sebelum sisa pakai, jadi paket salah SELALU TRIAL_PLAN_ONLY", (() => {
  const hasil = kuponMod.periksaKuponTrial(kodeKedua, "enterprise", hargaPremium);
  return hasil.ok === false && hasil.error === "TRIAL_PLAN_ONLY";
})(), short(kuponMod.periksaKuponTrial(kodeKedua, "enterprise", hargaPremium)));
check("U3. tanpa planCode gerbang paket dilewati (rute lama tanpa plan tetap jalan)", kuponMod.periksaKuponTrial(kodeUtama, "", hargaPremium).ok === false
  && kuponMod.periksaKuponTrial(kodeUtama, "", hargaPremium).error === "COUPON_EXHAUSTED"
  && kuponMod.periksaKuponTrial(banyak[0], "", hargaPremium).ok === true, short(kuponMod.periksaKuponTrial(banyak[0], "", hargaPremium)));
const buatSalah = [kuponMod.buatKuponTrial({ planCode: "tidak-ada" }), kuponMod.buatKuponTrial({ planCode: "premium", hours: 0 }), kuponMod.buatKuponTrial({ planCode: "premium", maxUses: 0 }), kuponMod.buatKuponTrial({ planCode: "" })];
check("U4. buatKuponTrial menolak paket salah, jam salah, batas pakai salah, dan paket kosong", buatSalah[0].error === "PLAN_NOT_FOUND"
  && buatSalah[1].error === "INVALID_TRIAL_HOURS" && buatSalah[2].error === "INVALID_TRIAL_MAX_USES" && buatSalah[3].error === "TRIAL_PLAN_REQUIRED", short(buatSalah));
check("U5. kuponTrial hanya mengenali kupon percobaan dan membaca kolom penandanya", kuponMod.kuponTrial(banyak[0])?.trial === true
  && kuponMod.kuponTrial(banyak[0])?.trialPlanCode === "premium" && kuponMod.kuponTrial(kodeBiasa)?.trial === false && kuponMod.kuponTrial("ZZZZZZZZ") === null,
  short({ trial: kuponMod.kuponTrial(banyak[0])?.trial, biasa: kuponMod.kuponTrial(kodeBiasa)?.trial }));

console.log(`\nRingkasan: ${passed} lulus, ${failed} gagal`);
if (failedNames.length) console.log(`Gagal: ${failedNames.join(" | ")}`);
if (!failed) { rmSync(dataDir, { recursive: true, force: true }); console.log("INFO data uji dihapus karena semua lulus."); }
else console.log(`INFO data uji disimpan di ${dataDir} untuk pemeriksaan.`);
process.exit(failed ? 1 : 0);

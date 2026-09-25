/**
 * Uji Wave 11C (v0.23.0) butir 82 — pengiriman konektor di proses terpisah (target minimal 12).
 *
 * Yang dibuktikan di sini, bukan diasumsikan:
 *   1. Pengiriman berjalan di PROSES LAIN (`pid` berbeda), dengan lingkungan daftar putih kecil:
 *      tanpa `DATA_DIR`, tanpa `SECRETS_KEY`, dan proses anak TIDAK bisa membuka basis data platform.
 *   2. Proses anak memeriksa daftar putih dari lingkungannya SENDIRI; alamat di luar daftar putih
 *      dihentikan sebelum satu byte pun keluar (kode keluar 3), bukan hanya di induk.
 *   3. Ada DUA batas waktu yang berbeda dan keduanya diuji: induk membunuh paksa (SIGKILL) proses
 *      yang menggantung, dan proses anak berhenti sendiri saat hulu melewati batasnya. Bedanya
 *      dibuktikan lewat `dibunuh`, `kodeKeluar`, dan pid yang benar-benar hilang.
 *   4. Jalur rute `/test` dan jalur pekerja `connector.deliver` memakai pengiriman yang sama, dan
 *      API tetap sehat sesudah proses anak dibunuh.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11c-konektor-proses.e2e.ts
 *
 * Catatan jujur:
 * - Hulu diganti peladen tiruan lokal yang memang menggantung di `/menggantung` (soket dibiarkan
 *   terbuka tanpa jawaban), jadi pembunuhan paksa diuji sungguhan tanpa menunggu menit-menitan.
 * - Proses anak dijalankan LANGSUNG oleh `node` (Node 22.23 mencopot tipe sendiri; lihat §1b), BUKAN
 *   lewat pembungkus `tsx`. Ini bukan soal kecepatan: lewat pembungkus, pekerja yang sebenarnya menjadi
 *   CUCU proses, sehingga SIGKILL induk hanya membunuh pembungkusnya (terukur ~31 detik, bukan 3,5 detik).
 * - Batas waktu PRODUKSI (`CONNECTOR_TIMEOUT_MS` bawaan 15000) sengaja TIDAK diuji: menunggu 15 detik
 *   per kasus akan memperlambat gerbang. Yang diuji adalah batas 2-3 detik yang disetel lewat env (§3),
 *   dan perilakunya sama karena batas dibaca dari lingkungan anak.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Uji, buatKlien, cariPortBebas, mulaiMock, pidHidup, potong, tungguSiap } from "./wave11c-harness.js";

const u = new Uji();
const port = await cariPortBebas(7327);
const dataDir = `/tmp/coder-wave11c-proses-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const email = `w11c-proses-${Date.now()}@example.test`;
const password = "SandiUji2026!aman";
const kunciSecrets = randomBytes(32).toString("base64");

const mock = await mulaiMock(0, (req) => {
  if (req.path.startsWith("/ok")) return { status: 200, body: { ok: true } };
  if (req.path.startsWith("/menggantung")) return "TETAP_BUKA";
  if (req.path.startsWith("/tolak")) return { status: 500, body: { ok: false } };
  return { status: 404, body: { error: "NOT_FOUND" } };
});

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_DIR = `${dataDir}/public`;
process.env.MOCK_ENGINE = "true";
process.env.CSRF_STRICT = "true";
process.env.RATE_LIMIT_REGISTER_PER_HOUR = "60";
process.env.RATE_LIMIT_LOGIN_PER_15MIN = "60";
process.env.RETENTION_ENABLED = "false";
process.env.JOB_WORKER_IN_WEB = "false";
process.env.JOB_REAP_ON_BOOT = "false";
process.env.JOB_WORKER_INTERVAL_MS = "3600000";
process.env.SECRETS_KEY = kunciSecrets;
process.env.CONNECTOR_ALLOWED_HOSTS = "127.0.0.1";
process.env.CONNECTOR_TIMEOUT_MS = "8000";
delete process.env.CONNECTOR_CHILD_DEADLINE_MS;

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const jobMod: any = await import("../src/wave11c/connector-job.js");
const { jobHandlerKinds, enqueueJob, getJob, runJobCycleOnce } = await import("../src/jobs.js");

const base = `http://127.0.0.1:${port}`;
const akun = buatKlien(base);
const jalur = "/api/v1/connectors";
/** Lingkungan induk untuk pengujian langsung, dengan tambahan yang dibutuhkan tiap kasus. */
const envAnak = (tambahan: Record<string, string> = {}) => ({ ...process.env, ...tambahan });
const rahasia = "proses-uji-4321";
const urlOk = `${mock.base}/ok/${rahasia}`;
const urlGantung = `${mock.base}/menggantung/${rahasia}`;

let keluar = 1;
try {
  if (!(await tungguSiap(base))) throw new Error(`peladen uji tidak siap di ${base}`);
  console.log(`INFO peladen uji siap di ${base} (skema ${SCHEMA_VERSION}), hulu tiruan di ${mock.base}, data di ${dataDir}`);

  // §1 Lingkungan proses anak: daftar putih kecil dan disengaja (fungsi murni, tanpa proses).
  const envTerkirim = jobMod.connectorChildEnv({
    ...process.env,
    DATA_DIR: "/tmp/rahasia-platform",
    SECRETS_KEY: "kunci-platform",
    SMTP_URL: "smtp://rahasia",
    NOTION_API_KEY: "notion-rahasia",
  } as any);
  const kunciTerkirim = Object.keys(envTerkirim).sort();
  u.check("lingkungan anak dibatasi daftar putih kecil", !kunciTerkirim.includes("DATA_DIR") && !kunciTerkirim.includes("SECRETS_KEY") && !kunciTerkirim.includes("SMTP_URL") && !kunciTerkirim.includes("NOTION_API_KEY") && kunciTerkirim.length <= 8, `kunci=${kunciTerkirim.join(",")}`);
  u.check("lingkungan anak tetap membawa daftar putih dan batas waktu", envTerkirim.CONNECTOR_ALLOWED_HOSTS === "127.0.0.1" && envTerkirim.CONNECTOR_CHILD === "1" && Number(envTerkirim.CONNECTOR_TIMEOUT_MS) === 8000, potong(envTerkirim));

  // §1b Jalur PRODUKSI: di image, berkas anak adalah hasil build `dist/api/wave11c/connector-child.js`
  // dan TIDAK ada pencopotan tipe. Perintahnya harus `node` langsung, satu argumen, tanpa pembungkus.
  const perintahJs = jobMod.connectorChildCommand("/apa/saja/dist/api/wave11c/connector-child.js");
  u.check("berkas .js hasil build dijalankan langsung (tanpa pembungkus/pencopot tipe)", perintahJs.perintah === process.execPath && perintahJs.argumen.length === 1 && perintahJs.argumen[0].endsWith("connector-child.js"), potong(perintahJs));
  // Dibuktikan sungguhan: sumber dicopot tipenya persis seperti proses build, lalu berkas .js itu
  // dijalankan langsung oleh node untuk satu permintaan nyata.
  const dirJs = `${dataDir}/dist/api/wave11c`;
  mkdirSync(dirJs, { recursive: true });
  writeFileSync(`${dataDir}/package.json`, JSON.stringify({ type: "module" }));
  const tsMod: any = await import("typescript");
  const sumberAnak = readFileSync(fileURLToPath(new URL("../src/wave11c/connector-child.ts", import.meta.url)), "utf8");
  writeFileSync(`${dirJs}/connector-child.js`, tsMod.transpileModule(sumberAnak, { compilerOptions: { module: tsMod.ModuleKind.ESNext, target: tsMod.ScriptTarget.ES2022 } }).outputText);
  const lewatBuild = await jobMod.spawnConnectorChild({ requestId: "uji-build-1", provider: "discord", url: urlOk, teks: "Halo dari hasil build" }, { env: envAnak(), anak: `${dirJs}/connector-child.js` });
  u.check("hasil build .js jalan tanpa pembungkus: keluar 0 dan pid yang dilaporkannya memang proses yang kami spawn", lewatBuild.hasil?.ok === true && lewatBuild.kodeKeluar === 0 && Number(lewatBuild.hasil?.lingkungan?.pid) === Number(lewatBuild.pid) && Number(lewatBuild.hasil?.lingkungan?.jumlahKunci ?? 99) <= 8, potong({ kode: lewatBuild.hasil?.code, keluar: lewatBuild.kodeKeluar, pid: lewatBuild.pid, lingkungan: lewatBuild.hasil?.lingkungan?.jumlahKunci }));
  u.check("hasil build .js tetap memakai badan pesan per jenis (discord: field 'content')", mock.terakhir["/ok/" + rahasia]?.content === "Halo dari hasil build" && mock.terakhir["/ok/" + rahasia]?.text === undefined, potong(mock.terakhir["/ok/" + rahasia]));

  await akun.bootstrap();
  const daftar = await akun.call("POST", "/api/v1/auth/register", { email, password, displayName: "Pemilik Proses" });
  u.check("akun uji terdaftar", daftar.status === 201 && Boolean(daftar.json?.user?.id), `status=${daftar.status} ${potong(daftar.json)}`);

  // §2 Pengiriman langsung ke hulu sehat: proses lain, hasil rapi.
  const langsung = await jobMod.spawnConnectorChild({ requestId: "uji-langsung-1", provider: "slack", url: urlOk, teks: "Halo dari uji proses" }, { env: envAnak() });
  u.check("pengiriman langsung: berhasil di proses anak lain", langsung.hasil?.ok === true && langsung.hasil?.code === "CONNECTOR_DELIVERED" && langsung.kodeKeluar === 0 && Number(langsung.pid) !== process.pid && Number(langsung.pid) > 0, potong({ pid: langsung.pid, kode: langsung.hasil?.code, keluar: langsung.kodeKeluar }));
  u.check("anak benar-benar mengirim isi pesannya sendiri", mock.terakhir["/ok/" + rahasia]?.text === "Halo dari uji proses", potong(mock.terakhir));
  const ling = langsung.hasil?.lingkungan;
  u.check("anak TIDAK menerima DATA_DIR dan SECRETS_KEY", ling?.dataDirDiterima === false && ling?.variabelPenting?.SECRETS_KEY === null && ling?.variabelPenting?.DATA_DIR === null && ling?.variabelPenting?.SMTP_URL === null, potong(ling?.variabelPenting));
  u.check("jumlah variabel lingkungan anak jauh lebih sedikit dari induk", Number(ling?.jumlahKunci ?? 99) <= 8 && Object.keys(process.env).length > Number(ling?.jumlahKunci ?? 0) + 5, `anak=${ling?.jumlahKunci} induk=${Object.keys(process.env).length}`);
  u.check("anak tidak bisa membuka basis data platform", ling?.basisData?.berhasil === false && ling?.basisData?.alasan === "ENOENT", potong(ling?.basisData));
  u.check("anak berjalan di direktori sementara, dan pidnya memang proses yang kami spawn", ling?.cwd === tmpdir() && Number(ling?.pid) === Number(langsung.pid) && ling?.ppid === process.pid, `cwd=${ling?.cwd} pid=${ling?.pid} spawn=${langsung.pid} ppid=${ling?.ppid} induk=${process.pid}`);

  // §3 Daftar putih ditegakkan DI DALAM proses anak, dari lingkungan anak sendiri.
  const sebelumDaftarPutih = mock.hitungan.total ?? 0;
  const luarDaftar = await jobMod.spawnConnectorChild({ requestId: "uji-luar-1", provider: "slack", url: urlOk, teks: "coba" }, { env: envAnak({ CONNECTOR_ALLOWED_HOSTS: "" }) });
  u.check("daftar putih anak kosong: pengiriman dihentikan sebelum keluar (kode keluar 3)", luarDaftar.hasil?.code === "CONNECTOR_HOST_NOT_ALLOWED" && luarDaftar.kodeKeluar === 3 && (mock.hitungan.total ?? 0) === sebelumDaftarPutih, potong({ kode: luarDaftar.hasil?.code, keluar: luarDaftar.kodeKeluar }));

  // §4 Batas waktu A: induk membunuh paksa proses yang menggantung.
  const sebelumGantung = mock.hitungan["/menggantung/" + rahasia] ?? 0;
  const bunuh = await jobMod.spawnConnectorChild({ requestId: "uji-gantung-1", provider: "slack", url: urlGantung, teks: "menggantung" }, { env: envAnak({ CONNECTOR_CHILD_DEADLINE_MS: "3500", CONNECTOR_TIMEOUT_MS: "30000" }) });
  u.check("hulu menggantung: induk membunuh paksa proses anak", bunuh.dibunuh === true && bunuh.hasil === null && bunuh.durasiMs < 15000 && bunuh.kodeKeluar === null, potong({ dibunuh: bunuh.dibunuh, durasi: bunuh.durasiMs, keluar: bunuh.kodeKeluar }));
  u.check("proses yang dibunuh benar-benar hilang (pid tidak hidup lagi)", pidHidup(bunuh.pid) === false, `pid=${bunuh.pid}`);
  u.check("permintaan menggantung memang sampai ke hulu sebelum dibunuh", (mock.hitungan["/menggantung/" + rahasia] ?? 0) === sebelumGantung + 1, `hitungan=${mock.hitungan["/menggantung/" + rahasia]}`);

  // §5 Batas waktu B: anak berhenti sendiri saat hulu melewati batas menunggunya.
  const sendiri = await jobMod.spawnConnectorChild({ requestId: "uji-gantung-2", provider: "slack", url: urlGantung, teks: "menggantung" }, { env: envAnak({ CONNECTOR_CHILD_DEADLINE_MS: "", CONNECTOR_TIMEOUT_MS: "2000" }) });
  u.check("hulu melewati batas anak: anak berhenti sendiri (bukan dibunuh induk)", sendiri.hasil?.code === "CONNECTOR_TIMEOUT" && sendiri.kodeKeluar === 5 && sendiri.dibunuh === false && sendiri.durasiMs >= 1500 && sendiri.durasiMs < 9000, potong({ kode: sendiri.hasil?.code, keluar: sendiri.kodeKeluar, dibunuh: sendiri.dibunuh, durasi: sendiri.durasiMs }));

  // §6 Aturan batas waktu dihitung apa adanya.
  const batasBawaan = jobMod.connectorLimits({ CONNECTOR_TIMEOUT_MS: "5000", CONNECTOR_ALLOWED_HOSTS: "127.0.0.1" } as any);
  const batasTetap = jobMod.connectorLimits({ CONNECTOR_TIMEOUT_MS: "5000", CONNECTOR_CHILD_START_GRACE_MS: "1000", CONNECTOR_CHILD_DEADLINE_MS: "7000" } as any);
  u.check("batas bawaan = batas hulu + kelonggaran mulai, batas tetap dihormati", batasBawaan.childAbortMs === 5000 && batasBawaan.parentDeadlineMs === 8000 && batasTetap.parentDeadlineMs === 7000, potong({ bawaan: batasBawaan, tetap: batasTetap }));

  // §7 Jalur rute: konektor Slack aktif, kirim uji memakai proses anak yang sama.
  const buat = await akun.call("POST", jalur, { kind: "slack", url: urlOk, nama: "Kanal Proses" });
  const idKonektor = String(buat.json?.konektor?.id ?? "");
  u.check("konektor slack dibuat dengan status 'siap'", buat.status === 201 && buat.json?.konektor?.status === "siap", `status=${buat.status} ${potong(buat.json?.konektor)}`);
  const ujiRute = await akun.call("POST", `${jalur}/${idKonektor}/test`, { teks: "Uji lewat rute" });
  u.check("rute /test memakai proses anak dan lingkungannya terbatas", ujiRute.status === 200 && ujiRute.json?.hasil?.status === "aktif" && ujiRute.json?.hasil?.lingkunganAnak?.dataDirDiterima === false && Number(ujiRute.json?.hasil?.proses?.pid) !== process.pid, potong(ujiRute.json?.hasil?.proses));

  // §8 Jalur pekerja: pekerja 'connector.deliver' dijalankan penangan yang terdaftar.
  u.check("penangan pekerja 'connector.deliver' terdaftar oleh server", jobHandlerKinds().includes("connector.deliver"), `terdaftar=${jobHandlerKinds().join(",")}`);
  db.prepare("UPDATE connectors SET status='siap', last_error='' WHERE id=?").run(idKonektor);
  const sebelumSiklus = mock.hitungan.total ?? 0;
  const antre = enqueueJob({ kind: "connector.deliver", payload: { connectorId: idKonektor, userId: String(daftar.json?.user?.id ?? ""), teks: "Lewat pekerja", jenis: "jadwal" }, maxAttempts: 1 });
  const siklus = await runJobCycleOnce({ owner: "uji-wave11c" });
  const barisPekerjaan = antre.id ? getJob(antre.id) : null;
  const sesudahSiklus = db.prepare("SELECT status, last_error AS lastError FROM connectors WHERE id=?").get(idKonektor) as any;
  u.check("pekerja dijalankan sampai selesai dan kirimnya berhasil", barisPekerjaan?.status === "done" && siklus.claimed >= 1 && siklus.succeeded >= 1 && sesudahSiklus?.status === "aktif" && (mock.hitungan.total ?? 0) > sebelumSiklus, potong({ pekerjaan: barisPekerjaan?.status, konektor: sesudahSiklus, siklus }));

  // §9 Rute /test saat hulu menggantung: induk membunuh anak, status jujur 'gagal', API tetap sehat.
  process.env.CONNECTOR_CHILD_DEADLINE_MS = "3500";
  await akun.call("PATCH", `${jalur}/${idKonektor}`, { url: urlGantung });
  const ujiGantung = await akun.call("POST", `${jalur}/${idKonektor}/test`, { teks: "menggantung lewat rute" });
  const pidBunuh = Number(ujiGantung.json?.hasil?.proses?.pid ?? 0);
  u.check("rute /test saat hulu menggantung: 'gagal' dengan kode batas waktu dan proses dibunuh", ujiGantung.status === 200 && ujiGantung.json?.hasil?.kode === "CONNECTOR_TIMEOUT" && ujiGantung.json?.hasil?.proses?.dibunuh === true, potong(ujiGantung.json?.hasil));
  u.check("status konektor menjadi 'gagal' dengan sebabnya", ujiGantung.json?.konektor?.status === "gagal" && String(ujiGantung.json?.konektor?.lastError ?? "").includes("CONNECTOR_TIMEOUT"), potong(ujiGantung.json?.konektor?.lastError));
  u.check("proses anak yang dibunuh rute ini tidak hidup lagi", pidHidup(pidBunuh) === false, `pid=${pidBunuh}`);
  const pekerjaGantung = db.prepare("SELECT status, result FROM jobs WHERE kind='connector.deliver' ORDER BY rowid DESC LIMIT 1").get() as any;
  u.check("pekerja kirim yang gagal tetap dicatat selesai dengan hasilnya", pekerjaGantung?.status === "done" && String(pekerjaGantung?.result ?? "").includes("CONNECTOR_TIMEOUT"), potong(pekerjaGantung));
  const sehat = await fetch(`${base}/health`);
  const masihBaca = await akun.call("GET", jalur);
  u.check("API tetap sehat sesudah proses anak dibunuh", sehat.status === 200 && masihBaca.status === 200 && masihBaca.json?.pengaturan?.batasHidupProsesAnakMs === 3500, `health=${sehat.status} baca=${masihBaca.status} batas=${masihBaca.json?.pengaturan?.batasHidupProsesAnakMs}`);
  delete process.env.CONNECTOR_CHILD_DEADLINE_MS;

  // §10 Kirim sehat lagi sesudah semua itu: pembunuhan tidak merusak jalur.
  await akun.call("PATCH", `${jalur}/${idKonektor}`, { url: urlOk });
  const pulih = await akun.call("POST", `${jalur}/${idKonektor}/test`, { teks: "sehat lagi" });
  u.check("kirim sehat lagi setelah pembunuhan: 'aktif'", pulih.json?.hasil?.status === "aktif" && pulih.json?.konektor?.status === "aktif" && pulih.json?.konektor?.lastError === null, potong(pulih.json?.konektor));

  keluar = u.failed === 0 ? 0 : 1;
} catch (error) {
  console.log(`FATAL ${String((error as Error)?.stack ?? error).slice(0, 600)}`);
  u.failed += 1;
  keluar = 1;
} finally {
  u.ringkas("Wave 11C butir 82 (proses terpisah konektor)");
  try {
    await mock.tutup();
  } catch {
    /* peladen tiruan sudah mati */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* direktori sementara sudah hilang */
  }
  process.exit(keluar);
}

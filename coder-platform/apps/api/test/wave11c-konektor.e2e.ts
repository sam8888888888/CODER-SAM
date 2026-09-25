/**
 * Uji Wave 11C (v0.23.0) butir 71 — katalog konektor + kirim uji yang jujur (target minimal 16).
 *
 * Yang dibuktikan di sini, bukan diasumsikan:
 *   1. KATALOG melaporkan status apa adanya: 'dikembangkan' untuk MCP yang belum dibuka admin,
 *      'siap' sebelum ada kirim yang berhasil, 'aktif' HANYA setelah hulu menjawab 2xx, 'gagal'
 *      beserta `last_error` setelah kirim gagal — dan API tetap sehat sesudahnya.
 *   2. Rahasia tidak pernah keluar: alamat webhook hanya host + ekor, token MCP tidak sama sekali,
 *      `collectUserData()` juga tidak membawa ciphertext.
 *   3. Alamat di luar daftar putih ditolak saat disimpan (400) DAN saat dikirim (400), jadi baris
 *      lama di basis data tidak bisa dipakai menembus daftar putih.
 *   4. Alat MCP dibatasi daftar putih admin platform: kosong = tertutup (403), diisi = hanya alat itu.
 *   5. Konektor nonaktif tidak menerima apa pun; kirim selalu lewat pekerja `connector.deliver`.
 *
 * Jalankan: cd /workspace/coblai-dinda/coder-platform && npx tsx apps/api/test/wave11c-konektor.e2e.ts
 *
 * Catatan jujur:
 * - Hulu Slack/Discord/MCP diganti peladen tiruan lokal; yang diuji perilaku COBLAI, bukan layanan asli.
 * - Baris konektor dengan alamat di luar daftar putih disiapkan langsung lewat SQL (dan disegel dengan
 *   `sealSecret`) karena rute POST memang menolaknya; itu pembuktian lapis kedua, bukan jalan pintas.
 * - DATA_DIR sementara dihapus lagi di blok `finally`.
 * - Batas waktu PRODUKSI (`CONNECTOR_TIMEOUT_MS` bawaan 15000) sengaja TIDAK diuji di sini (akan
 *   memperlambat gerbang); yang diuji batas 3 detik yang disetel lewat env, lihat suite butir 82.
 * - Nama konektor hidup di dalam JSON tersegel (tabel `connectors` tidak punya kolom `nama`), jadi
 *   katalog tidak bisa mencari/mengurutkan berdasarkan nama; pemilik tetap melihat namanya di GET.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { Uji, buatKlien, cariPortBebas, mulaiMock, potong, tungguSiap } from "./wave11c-harness.js";

const u = new Uji();
const port = await cariPortBebas(7321);
const dataDir = `/tmp/coder-wave11c-konektor-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const email = `w11c-konektor-${Date.now()}@example.test`;
const emailLain = `w11c-konektor-lain-${Date.now()}@example.test`;
const password = "SandiUji2026!aman";
const kunciSecrets = randomBytes(32).toString("base64");

const mock = await mulaiMock(0, (req) => {
  if (req.path.startsWith("/slack")) return { status: 200, body: { ok: true, jalur: "slack" } };
  if (req.path.startsWith("/discord")) return { status: 200, body: { jalur: "discord" } };
  if (req.path.startsWith("/mcp")) return { status: 200, body: { jsonrpc: "2.0", id: "1", result: { content: [] } } };
  if (req.path.startsWith("/tolak")) return { status: 500, body: { ok: false, pesan: "hulu sedang rusak" } };
  if (req.path.startsWith("/menggantung")) return "TETAP_BUKA";
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
process.env.CONNECTOR_TIMEOUT_MS = "3000";

await import("../src/server.js");
const { db, SCHEMA_VERSION } = await import("../src/db.js");
const { collectUserData } = await import("../src/dataexport.js");
const { sealSecret } = await import("../src/secrets.js");
const { savePlatformSetting } = await import("../src/wave11a/shared.js");

const base = `http://127.0.0.1:${port}`;
const akunA = buatKlien(base);
const akunB = buatKlien(base);
const jalur = "/api/v1/connectors";
const jumlah = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params as any[]) as { n: number })?.n ?? 0);
const rahasiaSlack = "rahasia-uji-1234";
const rahasiaMcp = "token-mcp-uji-5678";
const urlSlack = () => `${mock.base}/slack/${rahasiaSlack}`;
const urlTolak = () => `${mock.base}/tolak/${rahasiaSlack}`;
const urlMcp = () => `${mock.base}/mcp/${rahasiaMcp}`;

let keluar = 1;
try {
  if (!(await tungguSiap(base))) throw new Error(`peladen uji tidak siap di ${base}`);
  console.log(`INFO peladen uji siap di ${base} (skema ${SCHEMA_VERSION}), hulu tiruan di ${mock.base}, data di ${dataDir}`);

  await akunA.bootstrap();
  const daftar = await akunA.call("POST", "/api/v1/auth/register", { email, password, displayName: "Pemilik Konektor" });
  const userId = String(daftar.json?.user?.id ?? "");
  u.check("akun uji terdaftar", daftar.status === 201 && Boolean(userId), `status=${daftar.status} ${potong(daftar.json)}`);
  await akunB.bootstrap();
  await akunB.call("POST", "/api/v1/auth/register", { email: emailLain, password, displayName: "Akun Lain" });

  // §1 Katalog jujur apa adanya.
  const katalog = await akunA.call("GET", jalur);
  const jenis = Array.isArray(katalog.json?.katalog) ? katalog.json.katalog : [];
  u.check("GET katalog: 200 dan tiga jenis konektor", katalog.status === 200 && jenis.length === 3 && jenis.map((item: any) => item.kind).sort().join(",") === "discord,mcp,slack", `status=${katalog.status} ${potong(jenis.map((item: any) => item.kind))}`);
  u.check("katalog: slack 'siap' (platform) dan MCP 'dikembangkan' sebelum admin membukanya", jenis.find((item: any) => item.kind === "slack")?.status === "siap" && jenis.find((item: any) => item.kind === "slack")?.dasarStatus === "platform" && jenis.find((item: any) => item.kind === "mcp")?.status === "dikembangkan", potong(jenis));
  // `pekerjaDalamProses` = pekerjaan dijalankan di proses web (JOB_WORKER_IN_WEB && !WORKER_ONLY).
  // Suite menyetel JOB_WORKER_IN_WEB=false, jadi nilainya harus false — bukan lagi key khusus konektor.
  u.check("pengaturan melaporkan proses penjalanan pekerjaan dari key yang menentukan", katalog.json?.pengaturan?.pekerjaDalamProses === false, potong(katalog.json?.pengaturan?.pekerjaDalamProses));
  u.check("pengaturan: kunci 'ok', daftar putih berisi 127.0.0.1, MCP tertutup", katalog.json?.pengaturan?.kunci === "ok" && (katalog.json?.pengaturan?.daftarPutihHost ?? []).includes("127.0.0.1") && katalog.json?.pengaturan?.mcpTerbuka === false, potong(katalog.json?.pengaturan));

  // §2 Bentuk masukan yang ditolak sebelum apa pun disimpan.
  const jenisSalah = await akunA.call("POST", jalur, { kind: "teams", url: urlSlack() });
  u.check("POST jenis tidak dikenal: 400 CONNECTOR_KIND_INVALID", jenisSalah.status === 400 && jenisSalah.json?.error === "CONNECTOR_KIND_INVALID", `status=${jenisSalah.status} ${potong(jenisSalah.json)}`);
  const tanpaUrl = await akunA.call("POST", jalur, { kind: "slack" });
  u.check("POST tanpa alamat: 400 CONNECTOR_URL_REQUIRED", tanpaUrl.status === 400 && tanpaUrl.json?.error === "CONNECTOR_URL_REQUIRED", `status=${tanpaUrl.status} ${potong(tanpaUrl.json)}`);
  const luarDaftar = await akunA.call("POST", jalur, { kind: "slack", url: "https://example.com/hook" });
  u.check("POST alamat di luar daftar putih: 400 CONNECTOR_HOST_NOT_ALLOWED", luarDaftar.status === 400 && luarDaftar.json?.error === "CONNECTOR_HOST_NOT_ALLOWED", `status=${luarDaftar.status} ${potong(luarDaftar.json)}`);
  u.check("alasan penolakan menyebut daftar putih yang berlaku", Array.isArray(luarDaftar.json?.daftarPutihHost) && luarDaftar.json.daftarPutihHost.includes("127.0.0.1"), potong(luarDaftar.json?.daftarPutihHost ?? luarDaftar.json));

  // §3 MCP tertutup selama admin belum menulis daftar putihnya.
  const mcpTertutup = await akunA.call("POST", jalur, { kind: "mcp", url: urlMcp(), alat: ["kirim_pesan"], token: rahasiaMcp });
  u.check("POST MCP tanpa izin admin: 403 MCP_TOOL_NOT_ALLOWED", mcpTertutup.status === 403 && mcpTertutup.json?.error === "MCP_TOOL_NOT_ALLOWED", `status=${mcpTertutup.status} ${potong(mcpTertutup.json)}`);
  u.check("POST MCP yang ditolak tidak menyimpan baris", jumlah("SELECT COUNT(*) AS n FROM connectors WHERE user_id=? AND kind='mcp'", userId) === 0, "ada baris MCP yang tersimpan");

  // §4 Konektor Slack yang sah.
  const buatSlack = await akunA.call("POST", jalur, { kind: "slack", url: urlSlack(), nama: "Kanal Uji" });
  const slackId = String(buatSlack.json?.konektor?.id ?? "");
  u.check("POST slack sah: 201, status 'siap', host dan ekor dilaporkan", buatSlack.status === 201 && buatSlack.json?.konektor?.status === "siap" && buatSlack.json?.konektor?.tautan?.host === "127.0.0.1" && buatSlack.json?.konektor?.tautan?.ekor === `…${rahasiaSlack.slice(-4)}`, `status=${buatSlack.status} ${potong(buatSlack.json?.konektor)}`);
  u.check("jawaban POST tidak memuat alamat webhook utuh", !buatSlack.text.includes(rahasiaSlack) && !buatSlack.text.includes("enc:v1:"), "alamat/ciphertext bocor di jawaban POST");
  u.check("config_ciphertext tersegel dan tidak memuat alamat asli", (() => {
    const row = db.prepare("SELECT config_ciphertext AS stored FROM connectors WHERE id=?").get(slackId) as any;
    return Boolean(row) && String(row.stored).startsWith("enc:v1:") && !String(row.stored).includes(rahasiaSlack);
  })(), "ciphertext tidak sesuai dugaan");
  const ekspor = collectUserData(userId);
  const barisKonektor = ((ekspor.data as any).connectors ?? []) as any[];
  u.check("collectUserData: ciphertext tidak dikirim, hanya penanda terpasang", barisKonektor.length === 1 && barisKonektor[0].terpasang === 1 && !JSON.stringify(ekspor).includes(rahasiaSlack) && !Object.keys(barisKonektor[0]).some((nama) => /cipher|secret|config/i.test(nama)), `kunci=${Object.keys(barisKonektor[0] ?? {}).join(",")}`);

  // §5 Kirim uji pertama: berhasil, lewat proses anak.
  const sebelumKirim = mock.hitungan.total ?? 0;
  const kirim1 = await akunA.call("POST", `${jalur}/${slackId}/test`, { teks: "Halo dari uji" });
  u.check("POST test: 200 dan status 'aktif' HANYA setelah hulu menjawab 2xx", kirim1.status === 200 && kirim1.json?.hasil?.status === "aktif" && kirim1.json?.hasil?.kode === "CONNECTOR_DELIVERED", `status=${kirim1.status} ${potong(kirim1.json?.hasil)}`);
  u.check("kirim lewat proses anak yang berbeda dari proses web", Number(kirim1.json?.hasil?.proses?.pid ?? 0) > 0 && Number(kirim1.json?.hasil?.proses?.pid) !== process.pid && Boolean(kirim1.json?.hasil?.lingkunganAnak), potong(kirim1.json?.hasil?.proses));
  u.check("permintaan sampai ke hulu dengan isi yang benar", (mock.hitungan.total ?? 0) === sebelumKirim + 1 && mock.terakhir["/slack/" + rahasiaSlack]?.text === "Halo dari uji", potong(mock.terakhir));
  const setelahKirim = await akunA.call("GET", jalur);
  const viewSlack = (setelahKirim.json?.konektor ?? []).find((item: any) => item.id === slackId);
  u.check("GET: status 'aktif', tanpa last_error, katalog jenis itu ikut 'aktif'", viewSlack?.status === "aktif" && viewSlack?.lastError === null && (setelahKirim.json?.katalog ?? []).find((item: any) => item.kind === "slack")?.status === "aktif", potong(viewSlack));
  u.check("katalog pemilik menampilkan nama konektornya (nama ada di JSON tersegel, dibuka di sisi server)", viewSlack?.nama === "Kanal Uji" && viewSlack?.enabled === true, potong({ nama: viewSlack?.nama, enabled: viewSlack?.enabled }));
  u.check("kirim tercatat sebagai pekerja 'connector.deliver'", jumlah("SELECT COUNT(*) AS n FROM jobs WHERE kind='connector.deliver' AND status='done'") >= 1, "tidak ada pekerja konektor yang selesai");

  // §6 Kirim gagal: hulu 500 -> status 'gagal' + last_error, API tetap sehat.
  const ubahTolak = await akunA.call("PATCH", `${jalur}/${slackId}`, { url: urlTolak() });
  u.check("PATCH alamat: 200 dan status kembali 'siap' (bukti kirim lama dibatalkan)", ubahTolak.status === 200 && ubahTolak.json?.konektor?.status === "siap", `status=${ubahTolak.status} ${potong(ubahTolak.json?.konektor)}`);
  const kirimGagal = await akunA.call("POST", `${jalur}/${slackId}/test`, { teks: "Halo gagal" });
  u.check("hulu 500: hasil 'gagal' dengan kode dan status hulu apa adanya", kirimGagal.status === 200 && kirimGagal.json?.hasil?.status === "gagal" && kirimGagal.json?.hasil?.kode === "CONNECTOR_UPSTREAM_ERROR" && kirimGagal.json?.hasil?.upstreamStatus === 500, `status=${kirimGagal.status} ${potong(kirimGagal.json?.hasil)}`);
  u.check("status baris menjadi 'gagal' dan last_error menyebut sebabnya", kirimGagal.json?.konektor?.status === "gagal" && String(kirimGagal.json?.konektor?.lastError ?? "").includes("CONNECTOR_UPSTREAM_ERROR"), potong(kirimGagal.json?.konektor?.lastError));
  const sehat = await fetch(`${base}/health`);
  const tetapBisaDibaca = await akunA.call("GET", jalur);
  u.check("API tetap sehat setelah kirim gagal", sehat.status === 200 && tetapBisaDibaca.status === 200, `health=${sehat.status} katalog=${tetapBisaDibaca.status}`);

  // §7 Daftar putih juga ditegakkan saat mengubah dan saat mengirim.
  const patchLuar = await akunA.call("PATCH", `${jalur}/${slackId}`, { url: "https://example.com/hook" });
  const sesudahPatchLuar = await akunA.call("GET", jalur);
  const hostSesudah = (sesudahPatchLuar.json?.konektor ?? []).find((item: any) => item.id === slackId)?.tautan?.host;
  u.check("PATCH ke alamat di luar daftar putih: 400 dan alamat lama tidak berubah", patchLuar.status === 400 && patchLuar.json?.error === "CONNECTOR_HOST_NOT_ALLOWED" && hostSesudah === "127.0.0.1", `status=${patchLuar.status} host=${hostSesudah}`);

  const idTembus = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO connectors (id,user_id,kind,config_ciphertext,enabled,status,last_error,created_at,updated_at)
    VALUES (?,?,?,?,1,'siap','',?,?)`)
    .run(idTembus, userId, "discord", sealSecret(JSON.stringify({ url: `${mock.base}/discord/${rahasiaSlack}`, nama: "Baris lama" })), now, now);
  // Alamat di basis data diubah menjadi host di luar daftar putih: lapis kedua harus menolaknya.
  db.prepare("UPDATE connectors SET config_ciphertext=? WHERE id=?").run(sealSecret(JSON.stringify({ url: "http://example.test/discord/x", nama: "Baris lama" })), idTembus);
  const sebelumTembus = mock.hitungan.total ?? 0;
  const kirimTembus = await akunA.call("POST", `${jalur}/${idTembus}/test`, { teks: "coba tembus" });
  u.check("baris lama dengan host luar daftar putih ditolak saat kirim (400) dan hulu tidak dipanggil", kirimTembus.status === 400 && kirimTembus.json?.error === "CONNECTOR_HOST_NOT_ALLOWED" && (mock.hitungan.total ?? 0) === sebelumTembus, `status=${kirimTembus.status} ${potong(kirimTembus.json)}`);

  // §8 Konektor nonaktif tidak menerima apa pun.
  const matikan = await akunA.call("PATCH", `${jalur}/${slackId}`, { enabled: false, url: urlSlack() });
  const sebelumSenyap = mock.hitungan.total ?? 0;
  const kirimSenyap = await akunA.call("POST", `${jalur}/${slackId}/test`, { teks: "jangan dikirim" });
  u.check("nonaktif: hasil 'dilewati' dengan kode CONNECTOR_DISABLED", matikan.json?.konektor?.enabled === false && kirimSenyap.status === 200 && kirimSenyap.json?.hasil?.dijalankan === false && kirimSenyap.json?.hasil?.kode === "CONNECTOR_DISABLED", `enabled=${matikan.json?.konektor?.enabled} ${potong(kirimSenyap.json?.hasil)}`);
  u.check("nonaktif: hulu sama sekali tidak dipanggil", (mock.hitungan.total ?? 0) === sebelumSenyap, `total=${mock.hitungan.total} awal=${sebelumSenyap}`);

  // §9 Kirim berhasil lagi setelah diaktifkan.
  const aktifkan = await akunA.call("PATCH", `${jalur}/${slackId}`, { enabled: true });
  const kirim2 = await akunA.call("POST", `${jalur}/${slackId}/test`, { teks: "Halo lagi" });
  u.check("aktif kembali: kirim berikutnya 'aktif' dan status baris 'aktif'", aktifkan.json?.konektor?.enabled === true && kirim2.json?.hasil?.status === "aktif" && kirim2.json?.konektor?.status === "aktif" && kirim2.json?.konektor?.lastError === null, potong(kirim2.json?.konektor));

  // §10 Daftar putih alat MCP dari admin platform.
  savePlatformSetting("mcp_allowed_tools", "kirim_pesan");
  const mcpTerbuka = await akunA.call("GET", jalur);
  u.check("katalog MCP 'siap' setelah admin menulis daftar putih", (mcpTerbuka.json?.katalog ?? []).find((item: any) => item.kind === "mcp")?.status === "siap" && mcpTerbuka.json?.pengaturan?.mcpTerbuka === true, potong(mcpTerbuka.json?.pengaturan));
  const buatMcp = await akunA.call("POST", jalur, { kind: "mcp", url: urlMcp(), alat: ["kirim_pesan"], token: rahasiaMcp, nama: "Alat Uji" });
  const mcpId = String(buatMcp.json?.konektor?.id ?? "");
  u.check("POST MCP dengan alat yang diizinkan: 201 dan token tidak dikembalikan", buatMcp.status === 201 && !buatMcp.text.includes(rahasiaMcp) && buatMcp.json?.konektor?.tautan?.alat?.join(",") === "kirim_pesan", `status=${buatMcp.status} ${potong(buatMcp.json?.konektor)}`);
  const mcpDitolak = await akunA.call("POST", jalur, { kind: "mcp", url: urlMcp(), alat: ["hapus_basis_data"], token: rahasiaMcp });
  u.check("alat di luar daftar putih tetap 403 dengan daftar penolakan", mcpDitolak.status === 403 && mcpDitolak.json?.error === "MCP_TOOL_NOT_ALLOWED" && (mcpDitolak.json?.ditolak ?? []).includes("hapus_basis_data"), `status=${mcpDitolak.status} ${potong(mcpDitolak.json)}`);

  // §11 Kirim MCP: bentuk JSON-RPC dan token dari segel.
  const kirimMcp = await akunA.call("POST", `${jalur}/${mcpId}/test`, { teks: "panggil alat" });
  const badanMcp = mock.terakhir["/mcp/" + rahasiaMcp];
  u.check("kirim MCP berhasil dan memakai bentuk tools/call", kirimMcp.json?.hasil?.status === "aktif" && badanMcp?.jsonrpc === "2.0" && badanMcp?.method === "tools/call" && badanMcp?.params?.name === "kirim_pesan", potong(badanMcp));
  u.check("token MCP dikirim sebagai Bearer hanya ke hulu", String(mock.terakhirHeader["/mcp/" + rahasiaMcp]?.authorization ?? "") === `Bearer ${rahasiaMcp}` && !kirimMcp.text.includes(rahasiaMcp), potong(mock.terakhirHeader["/mcp/" + rahasiaMcp]?.authorization));

  // §12 Daftar putih dicabut: kirim berikutnya ditolak tanpa memanggil hulu.
  savePlatformSetting("mcp_allowed_tools", "");
  const sebelumCabut = mock.hitungan.total ?? 0;
  const kirimCabut = await akunA.call("POST", `${jalur}/${mcpId}/test`, { teks: "sesudah dicabut" });
  const viewMcl = (await akunA.call("GET", jalur)).json?.konektor?.find((item: any) => item.id === mcpId);
  u.check("daftar putih dicabut: 403 MCP_TOOL_NOT_ALLOWED dan hulu tidak dipanggil", kirimCabut.status === 403 && kirimCabut.json?.error === "MCP_TOOL_NOT_ALLOWED" && (mock.hitungan.total ?? 0) === sebelumCabut, `status=${kirimCabut.status} total=${mock.hitungan.total}`);
  u.check("konektor MCP yang dicabut berstatus 'gagal' dengan sebabnya", viewMcl?.status === "gagal" && String(viewMcl?.lastError ?? "").includes("MCP_TOOL_NOT_ALLOWED"), potong(viewMcl?.lastError));

  // §13 Isolasi antar akun.
  const bacaB = await akunB.call("GET", jalur);
  const patchB = await akunB.call("PATCH", `${jalur}/${slackId}`, { nama: "Punya orang lain" });
  const hapusB = await akunB.call("DELETE", `${jalur}/${slackId}`);
  u.check("akun lain tidak melihat konektor ini", bacaB.status === 200 && (bacaB.json?.konektor ?? []).length === 0, potong(bacaB.json?.konektor));
  u.check("akun lain tidak bisa mengubah atau menghapus konektor ini", patchB.status === 404 && hapusB.status === 404 && patchB.json?.error === "CONNECTOR_NOT_FOUND", `patch=${patchB.status} hapus=${hapusB.status}`);

  // §14 Hapus konektor.
  const hapus = await akunA.call("DELETE", `${jalur}/${slackId}`);
  const hapusLagi = await akunA.call("DELETE", `${jalur}/${slackId}`);
  u.check("DELETE: konektor hilang dan pengulangan menjawab 404", hapus.status === 200 && hapus.json?.deleted === true && hapusLagi.status === 404 && jumlah("SELECT COUNT(*) AS n FROM connectors WHERE id=?", slackId) === 0, `hapus=${hapus.status} ulang=${hapusLagi.status}`);

  // §15 Tanpa SECRETS_KEY: 503 dan tidak ada teks polos.
  // Kunci dikosongkan (bukan dihapus) supaya tidak jatuh ke nilai config yang sudah dibaca saat mulai.
  process.env.SECRETS_KEY = "";
  const tanpaKunci = await akunA.call("POST", jalur, { kind: "discord", url: `${mock.base}/discord/${rahasiaSlack}` });
  const ujiTanpaKunci = await akunA.call("POST", `${jalur}/${mcpId}/test`, { teks: "tanpa kunci" });
  const bacaTanpaKunci = await akunA.call("GET", jalur);
  u.check("tanpa SECRETS_KEY: POST 503 SECRETS_KEY_MISSING", tanpaKunci.status === 503 && tanpaKunci.json?.error === "SECRETS_KEY_MISSING", `status=${tanpaKunci.status} ${potong(tanpaKunci.json)}`);
  u.check("tanpa SECRETS_KEY: kirim uji 503 dan katalog melaporkan kunci 'missing'", ujiTanpaKunci.status === 503 && bacaTanpaKunci.json?.pengaturan?.kunci === "missing", `status=${ujiTanpaKunci.status} kunci=${bacaTanpaKunci.json?.pengaturan?.kunci}`);
  u.check("tidak ada konfigurasi konektor yang tersimpan tanpa segel", jumlah("SELECT COUNT(*) AS n FROM connectors WHERE config_ciphertext <> '' AND config_ciphertext NOT LIKE 'enc:v1:%'") === 0, "ada baris tanpa segel");
  process.env.SECRETS_KEY = kunciSecrets;

  // §16 Setelah kunci pulih, baris lama masih bisa dibuka dan dipakai.
  const sesudahPulih = await akunA.call("GET", jalur);
  const viewMcpPulih = (sesudahPulih.json?.konektor ?? []).find((item: any) => item.id === mcpId);
  u.check("kunci pulih: konfigurasi MCP bisa dibuka lagi", viewMcpPulih?.tautan?.bisaDibuka === true && viewMcpPulih?.tautan?.host === "127.0.0.1", potong(viewMcpPulih?.tautan));

  keluar = u.failed === 0 ? 0 : 1;
} catch (error) {
  console.log(`FATAL ${String((error as Error)?.stack ?? error).slice(0, 600)}`);
  u.failed += 1;
  keluar = 1;
} finally {
  u.ringkas("Wave 11C butir 71 (katalog konektor)");
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

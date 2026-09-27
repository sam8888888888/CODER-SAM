#!/usr/bin/env node
/**
 * Mesin tiruan untuk suite `wave11a-katalog.e2e.ts`.
 *
 * `model list` menjawab daftar PANJANG bila berkas penanda pendek (KATALOG_FIXTURE_MARKER) belum ada,
 * dan daftar PENDEK bila penanda sudah ada — meniru penyedia yang lambat/gagal sehingga jawaban katalog
 * tidak lengkap. Baris `glm-5.0-flash-uji` hanya muncul bila berkas penanda TAMBAHAN
 * (KATALOG_FIXTURE_TAMBAHAN) ada, sehingga suite bisa membuktikan sebuah nama model benar-benar BELUM
 * PERNAH terbaca (dipakai bagian 2 untuk meniru kejadian gerbang 27 Sep 2026).
 * Sengaja tidak butuh jaringan dan tidak mengirim keluaran acak: hasilnya sama di mesin apa pun.
 */
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const penandaPendek = process.env.KATALOG_FIXTURE_MARKER ?? "";
const penandaTambahan = process.env.KATALOG_FIXTURE_TAMBAHAN ?? "";
const sebagian = Boolean(penandaPendek) && existsSync(penandaPendek);
const tambahan = Boolean(penandaTambahan) && existsSync(penandaTambahan);

if (args[0] === "model" && args[1] === "list") {
  const baris = [
    "deepseek  deepseek-v4-flash  128K  16.4K  yes  no",
    ...(sebagian ? [] : [
      "zai  glm-4.7-flash  202.8K  16.4K  yes  no",
      ...(tambahan ? ["zai  glm-5.0-flash-uji  202.8K  16.4K  yes  no"] : []),
    ]),
  ];
  // Tabel ditulis ke stderr, sama seperti CLI sungguhan.
  process.stderr.write(["provider  model  context  max-out  thinking  images", ...baris].join("\n") + "\n");
  process.exit(0);
}
if (args[0] === "--version") { process.stdout.write("0.0.0-katalog-fixture\n"); process.exit(0); }
if (args[0] === "model" && args[1] === "show") { process.stdout.write("deepseek-v4-flash\n"); process.exit(0); }
process.stderr.write(`fake-prime-agent-katalog: argumen tidak dikenal: ${args.join(" ")}\n`);
process.exit(2);

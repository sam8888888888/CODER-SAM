/* Pemeriksaan render Wave 8: memastikan panel yang berubah (profil/penutupan akun dua langkah dan
   panel pengguna admin dengan ubah email, setel sandi, serta pemulihan akun) bisa dirender tanpa galat.
   Uji ini statis: tidak memakai peramban, hanya memastikan tidak ada galat render. */
import React from "react";
import { renderToString } from "react-dom/server";
import { ProfilePanel } from "./src/ProfilePanel";
import { AdminUsers } from "./src/AdminUsers";

const noop = () => undefined;
const pages: [string, () => unknown][] = [
  ["ProfilePanel", () => renderToString(<ProfilePanel email="uji@example.test" displayName="Pengguna Uji" onChanged={noop} onDeleted={noop} />)],
  ["AdminUsers", () => renderToString(<AdminUsers isAdmin onError={noop} />)],
];
let failed = 0;
const rendered: Record<string, string> = {};
for (const [name, render] of pages) {
  try {
    const html = String(render());
    rendered[name] = html;
    console.log(`RENDER_OK ${name} ${html.length}`);
  } catch (error) {
    failed += 1;
    console.log(`RENDER_FAIL ${name} ${(error as Error).message}`);
  }
}
// Bukti bahwa langkah ekspor lebih dulu ada di panel, sesuai aturan penutupan akun.
if (!failed) {
  const profil = rendered.ProfilePanel ?? "";
  const checks: [string, boolean][] = [
    ["teks langkah 1 unduh salinan data", profil.includes("Langkah 1")],
    ["teks langkah 2 tutup akun", profil.includes("Langkah 2")],
    ["tombol langkah 1 membuat salinan data", profil.includes("Langkah 1: unduh salinan data")],
    ["keterangan masa pemulihan", profil.includes("90") || profil.includes("pemulihan")],
  ];
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "RENDER_OK" : "RENDER_FAIL"} teks profil: ${label}`);
  }
}
console.log(failed === 0 ? "ALL_WAVE8_PAGES_RENDERED" : "WAVE8_RENDER_FAILED");
process.exit(failed === 0 ? 0 : 1);

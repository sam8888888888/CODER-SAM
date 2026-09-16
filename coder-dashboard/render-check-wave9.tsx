/* Pemeriksaan render Wave 9: memastikan konsol harga AI (butir 19) bisa dirender tanpa galat, untuk
   admin maupun pengguna biasa. Uji ini statis: tanpa peramban, hanya memastikan tidak ada galat render
   dan bahwa teks penting benar-benar ada di keluaran HTML. */
import React from "react";
import { renderToString } from "react-dom/server";
import { AdminPricing } from "./src/AdminPricing";

const noop = () => undefined;
const pages: [string, () => unknown][] = [
  ["AdminPricing (admin)", () => renderToString(<AdminPricing isAdmin onError={noop} />)],
  ["AdminPricing (bukan admin)", () => renderToString(<AdminPricing isAdmin={false} onError={noop} />)],
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
if (!failed) {
  const admin = rendered["AdminPricing (admin)"] ?? "";
  const biasa = rendered["AdminPricing (bukan admin)"] ?? "";
  const checks: [string, boolean][] = [
    ["judul halaman harga AI", admin.includes("Harga AI")],
    ["panel markup", admin.includes("Markup") || admin.includes("markup")],
    ["kolom harga pokok", admin.includes("Harga pokok")],
    ["satuan uang USD per 1 juta token", admin.includes("USD")],
    ["tombol muat ulang", admin.includes("Muat ulang")],
    ["pengguna biasa melihat pesan tanpa akses", biasa.includes("Hanya admin platform")],
  ];
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "RENDER_OK" : "RENDER_FAIL"} teks harga: ${label}`);
  }
}
console.log(failed === 0 ? "ALL_WAVE9_PAGES_RENDERED" : "WAVE9_RENDER_FAILED");
process.exit(failed === 0 ? 0 : 1);

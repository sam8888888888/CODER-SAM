/* Pemeriksaan render Wave 7: memastikan halaman undangan, pertumbuhan, langkah awal, dan dokumentasi
   publik bisa dirender tanpa galat (render statis, tanpa peramban). */
import React from "react";
import { renderToString } from "react-dom/server";
import { Referrals } from "./src/Referrals";
import { Growth } from "./src/Growth";
import { Onboarding } from "./src/Onboarding";
import { PublicDocs } from "./src/PublicDocs";

const noop = () => undefined;
const nav = () => undefined;
const pages: [string, () => unknown][] = [
  ["Referrals", () => renderToString(<Referrals onError={noop} />)],
  ["Growth", () => renderToString(<Growth onError={noop} />)],
  ["Onboarding", () => renderToString(<Onboarding onError={noop} onNavigate={nav} />)],
  ["PublicDocs", () => renderToString(<PublicDocs onError={noop} />)],
];
let failed = 0;
for (const [name, render] of pages) {
  try {
    const html = String(render());
    console.log(`RENDER_OK ${name} ${html.length}`);
  } catch (error) {
    failed += 1;
    console.log(`RENDER_FAIL ${name} ${(error as Error).message}`);
  }
}
console.log(failed === 0 ? "ALL_WAVE7_PAGES_RENDERED" : "WAVE7_RENDER_FAILED");
process.exit(failed === 0 ? 0 : 1);

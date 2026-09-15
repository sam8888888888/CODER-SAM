/* Pemeriksaan render Wave 4: memastikan 4 halaman baru bisa dirender tanpa galat. */
import React from "react";
import { renderToString } from "react-dom/server";
import { ApiKeys } from "./src/ApiKeys";
import { DataPrivacy } from "./src/DataPrivacy";
import { AdminEmailOutbox } from "./src/AdminEmailOutbox";
import { PublicPricing } from "./src/PublicPricing";

const noop = () => undefined;
const pages: [string, () => unknown][] = [
  ["ApiKeys", () => renderToString(<ApiKeys onError={noop} />)],
  ["DataPrivacy", () => renderToString(<DataPrivacy onError={noop} />)],
  ["AdminEmailOutbox", () => renderToString(<AdminEmailOutbox onError={noop} />)],
  ["PublicPricing", () => renderToString(<PublicPricing onRequireLogin={noop} onClose={noop} />)],
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
console.log(failed === 0 ? "ALL_WAVE4_PAGES_RENDERED" : "WAVE4_RENDER_FAILED");
process.exit(failed === 0 ? 0 : 1);

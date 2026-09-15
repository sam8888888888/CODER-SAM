/* Pemeriksaan render Wave 6: memastikan halaman webhook dan halaman kunci API bisa dirender tanpa galat. */
import React from "react";
import { renderToString } from "react-dom/server";
import { ApiWebhooks } from "./src/ApiWebhooks";
import { ApiKeys } from "./src/ApiKeys";

const noop = () => undefined;
const pages: [string, () => unknown][] = [
  ["ApiWebhooks", () => renderToString(<ApiWebhooks onError={noop} />)],
  ["ApiKeys", () => renderToString(<ApiKeys onError={noop} />)],
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
console.log(failed === 0 ? "ALL_WAVE6_PAGES_RENDERED" : "WAVE6_RENDER_FAILED");
process.exit(failed === 0 ? 0 : 1);

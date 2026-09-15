/* Pemeriksaan render Wave 5: memastikan halaman antrean pekerjaan bisa dirender tanpa galat. */
import React from "react";
import { renderToString } from "react-dom/server";
import { AdminJobs } from "./src/AdminJobs";

const noop = () => undefined;
const pages: [string, () => unknown][] = [
  ["AdminJobs", () => renderToString(<AdminJobs onError={noop} />)],
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
console.log(failed === 0 ? "ALL_WAVE5_PAGES_RENDERED" : "WAVE5_RENDER_FAILED");
process.exit(failed === 0 ? 0 : 1);

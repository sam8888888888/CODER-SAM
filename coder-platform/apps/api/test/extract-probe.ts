
const port = 3426;
process.env.NODE_ENV = "test"; process.env.PORT = String(port); process.env.HOST = "127.0.0.1";
process.env.DATA_DIR = `/tmp/coder-err-probe-${Date.now()}`; process.env.MOCK_ENGINE = "true"; process.env.PUBLIC_DIR = `${process.env.DATA_DIR}/public`;
await import("../src/server.js");
await new Promise((r) => setTimeout(r, 1000));
// call extractText the same way the route does
const { extractText } = await import("../src/text-extract.js");
const { readFile } = await import("node:fs/promises");
for (const name of ["sample.docx", "sample.pdf"]) {
  try {
    const buffer = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    const result = await extractText(buffer, name);
    console.log("OK", name, result.kind, result.text.slice(0, 60));
  } catch (error) { console.log("ERR", name, String(error), (error as any)?.stack?.split("\n").slice(0,4).join(" | ")); }
}
process.exit(0);

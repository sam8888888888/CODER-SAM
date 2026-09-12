import { spawnSync } from "node:child_process";
const r = spawnSync("prime-agent", ["model", "list"], { encoding: "utf8", timeout: 20_000 });
console.log("STATUS", r.status, "ERR", r.error?.message, "STDERR", JSON.stringify(String(r.stderr).slice(0, 200)));
console.log("STDOUT_LINES", String(r.stdout).split("\n").length, JSON.stringify(String(r.stdout).slice(0, 160)));
const r2 = spawnSync("/usr/local/bin/prime-agent", ["model", "list"], { encoding: "utf8", timeout: 20_000 });
console.log("ABS_STATUS", r2.status, "ABS_LINES", String(r2.stdout).split("\n").length);

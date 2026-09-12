import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
const targetDir = resolve("backups"); mkdirSync(targetDir, { recursive: true });
const target = resolve(targetDir, `coder-${new Date().toISOString().replaceAll(":", "-")}.db`);
db.pragma("wal_checkpoint(TRUNCATE)"); await db.backup(target);
copyFileSync(resolve(config.DATA_DIR, "coder.db"), target);
console.log(`Backup written: ${target}`); db.close();

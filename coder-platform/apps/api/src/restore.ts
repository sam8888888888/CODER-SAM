import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
const source = process.argv[2];
if (!source || !existsSync(source)) { console.error("Usage: npm run restore -- backups/file.db"); process.exit(1); }
const target = resolve(config.DATA_DIR, "coder.db"); copyFileSync(resolve(source), target); console.log(`Database restored to: ${target}`);

/**
 * Wave 11B (v0.22.0): satu titik sambung untuk seluruh rute baru.
 *
 * `server.ts` hanya memanggil `registerWave11bRoutes(app)`, sehingga rincian fitur tetap berada
 * di modulnya masing-masing (konvensi A2 PRD Wave 11).
 */
import { registerCouncilRoutes } from "./council.js";
import { registerShadowRoutes } from "./shadow.js";
import { registerLearningsRoutes } from "./learnings.js";
import { registerBenchmarkRoutes } from "./benchmark.js";
import { registerTimelineRoutes } from "./timeline.js";
import { registerResumeRoutes } from "./resume.js";
import { registerPersonaTransferRoutes } from "./persona-transfer.js";
import { registerAccountUsageRoutes } from "./account-usage.js";
import { registerErrorRoutes } from "./errors.js";
import { registerTokenAccountingRoutes } from "./token-accounting.js";
import { registerScheduleRoutes } from "./schedules.js";

/** Mendaftarkan rute Wave 11B. Pemanggilannya dilakukan sekali dari `server.ts`. */
export function registerWave11bRoutes(app: any): void {
  registerCouncilRoutes(app);
  registerShadowRoutes(app);
  registerLearningsRoutes(app);
  registerBenchmarkRoutes(app);
  registerTimelineRoutes(app);
  registerResumeRoutes(app);
  registerPersonaTransferRoutes(app);
  registerAccountUsageRoutes(app);
  registerErrorRoutes(app);
  registerTokenAccountingRoutes(app);
  registerScheduleRoutes(app);
}

/**
 * Wave 11A (v0.21.0): satu titik sambung untuk seluruh rute baru.
 *
 * `server.ts` hanya memanggil `registerWave11aRoutes(app)`, sehingga rincian fitur tetap berada
 * di modulnya masing-masing (konvensi A2 PRD Wave 11).
 */
import { registerModeRoutes } from "./mode.js";
import { registerGuardrailRoutes } from "./guardrails.js";
import { registerToolsPolicyRoutes } from "./tools-policy.js";
import { registerUserSkillRoutes } from "./skills.js";
import { registerKnowledgeBaseRoutes } from "./knowledge-base.js";
import { registerHistoryRoutes } from "./history.js";
import { registerEstimateRoutes } from "./estimate.js";
import { registerArtifactEditRoutes } from "./artifact-edit.js";
import { registerCredentialRoutes } from "./secrets-routes.js";
import { registerFallbackRoutes } from "./fallback.js";

/** Mendaftarkan rute Wave 11A. Pemanggilannya dilakukan sekali dari `server.ts`. */
export function registerWave11aRoutes(app: any): void {
  registerModeRoutes(app);
  registerGuardrailRoutes(app);
  registerToolsPolicyRoutes(app);
  registerUserSkillRoutes(app);
  registerKnowledgeBaseRoutes(app);
  registerHistoryRoutes(app);
  registerEstimateRoutes(app);
  registerArtifactEditRoutes(app);
  registerCredentialRoutes(app);
  registerFallbackRoutes(app);
}

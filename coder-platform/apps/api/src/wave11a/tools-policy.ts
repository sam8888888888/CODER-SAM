/**
 * Wave 11A (butir 47): kebijakan alat berhalaman.
 *
 * Daftar alat memakai ulang kolom `agent_settings.tools_allow` yang sudah ada (tidak ada tabel baru):
 * kosong = bawaan mesin, `none` = tanpa alat, atau daftar nama dipisah koma.
 *
 * Catatan penting: NAMA ALAT DIMILIKI MESIN (lihat komentar asli di server.ts). Platform tidak boleh
 * menebak nama alat. Karena itu ada katalog yang bisa diisi admin (`platform_settings.tools_catalog`).
 * Selama katalog kosong, setiap nama berformat sah diterima; setelah katalog diisi, nama di luar
 * katalog ditolak dengan 400 TOOL_NOT_ALLOWED.
 */
import { db } from "../db.js";
import { requireUser } from "../auth.js";
import { adminRequired, audit, fail, isPlatformAdmin, platformSetting, savePlatformSetting } from "./shared.js";

export const TOOL_NAME_RE = /^[a-z0-9][a-z0-9_.:/-]{0,63}$/i;
export const TOOLS_ALLOW_MAX_CHARS = 400;
const CATALOG_KEY = "tools_catalog";

/** Katalog nama alat yang dikenal platform (diisi admin). Kosong = belum diisi. */
export function toolCatalog(): string[] {
  const raw = platformSetting(CATALOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean).slice(0, 200) : [];
  } catch { return []; }
}

export function setToolCatalog(tools: string[], actorId: string): string[] {
  const clean = [...new Set(tools.map((item) => String(item).trim()).filter((item) => TOOL_NAME_RE.test(item)))].slice(0, 200);
  savePlatformSetting(CATALOG_KEY, JSON.stringify(clean));
  audit(actorId, "admin.tool_catalog_updated", { count: clean.length });
  return clean;
}

/** Terjemahan isi kolom menjadi bentuk yang bisa dipakai UI dan mesin. */
export function toolsAllowState(raw: string | null | undefined): { mode: "bawaan" | "tanpa_alat" | "daftar"; tools: string[] | null; raw: string } {
  const value = String(raw ?? "").trim();
  if (!value) return { mode: "bawaan", tools: null, raw: "" };
  if (value.toLowerCase() === "none") return { mode: "tanpa_alat", tools: [], raw: "none" };
  return { mode: "daftar", tools: value.split(",").map((item) => item.trim()).filter(Boolean), raw: value };
}

/** Menyimpan pilihan alat ke `agent_settings` tanpa menyentuh kolom lain. */
export function saveToolsAllow(userId: string, raw: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agent_settings (user_id, tools_allow, updated_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET tools_allow=excluded.tools_allow, updated_at=excluded.updated_at`).run(userId, raw, now);
}

/** Nama alat yang tidak dikenal katalog (kosong bila katalog belum diisi). */
export function unknownTools(tools: string[]): string[] {
  const catalog = toolCatalog();
  if (!catalog.length) return [];
  return tools.filter((tool) => !catalog.includes(tool));
}

export function registerToolsPolicyRoutes(app: any): void {
  app.get("/api/v1/tools-policy", { preHandler: requireUser }, async (request: any) => {
    const row = db.prepare("SELECT tools_allow AS toolsAllow FROM agent_settings WHERE user_id=?").get(request.user!.id) as { toolsAllow?: string } | undefined;
    const state = toolsAllowState(row?.toolsAllow ?? "");
    const catalog = toolCatalog();
    return {
      ...state,
      catalog,
      catalogFilled: catalog.length > 0,
      maxToolNameChars: 64,
      help: catalog.length
        ? "Pilih alat yang boleh dipakai agen. Nama di luar katalog ditolak."
        : "Nama alat dimiliki mesin, jadi katalog masih kosong: setiap nama berformat sah diterima. Admin dapat mengisi katalog lebih dulu.",
    };
  });

  app.put("/api/v1/tools-policy", { preHandler: requireUser }, async (request: any, reply: any) => {
    const userId = request.user!.id;
    const input = request.body?.tools;
    let raw: string;
    if (input === undefined) return fail(reply, 400, "INVALID_TOOLS_POLICY", "Kirim 'tools' sebagai daftar nama alat, daftar kosong, atau 'none'.");
    if (input === null || (typeof input === "string" && input.trim().toLowerCase() === "none") || (Array.isArray(input) && input.length === 0)) {
      raw = "none";
    } else if (Array.isArray(input)) {
      const names = [...new Set(input.map((item) => String(item).trim()).filter(Boolean))];
      const invalid = names.filter((name) => !TOOL_NAME_RE.test(name));
      if (invalid.length) return fail(reply, 400, "INVALID_TOOL_NAME", `Nama alat tidak sah: ${invalid.join(", ")}. Nama alat hanya boleh huruf, angka, titik, garis bawah, dan tanda hubung.`);
      const unknown = unknownTools(names);
      if (unknown.length) return fail(reply, 400, "TOOL_NOT_ALLOWED", `Alat tidak dikenal: ${unknown.join(", ")}.`, { unknown });
      raw = names.join(",");
    } else {
      return fail(reply, 400, "INVALID_TOOLS_POLICY", "Kirim 'tools' sebagai daftar nama alat, daftar kosong, atau 'none'.");
    }
    if (raw.length > TOOLS_ALLOW_MAX_CHARS) return fail(reply, 400, "TOOLS_POLICY_TOO_LONG", `Daftar alat maksimal ${TOOLS_ALLOW_MAX_CHARS} karakter.`);
    saveToolsAllow(userId, raw);
    const state = toolsAllowState(raw);
    audit(userId, "tool_policy.updated", { mode: state.mode, count: state.tools?.length ?? 0 });
    return { ...state, diterapkanPadaRunBerikutnya: true };
  });

  app.put("/api/v1/admin/tool-catalog", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    if (!Array.isArray(request.body?.tools)) return fail(reply, 400, "INVALID_TOOL_CATALOG", "Kirim 'tools' sebagai daftar nama alat.");
    const catalog = setToolCatalog(request.body.tools as string[], request.user!.id);
    return { catalog, count: catalog.length };
  });
}

/**
 * Wave 11A: rute rahasia pengguna (butir 43) + audit-diri admin (butir 53).
 *
 * Penyimpanan: tabel `user_secrets` (satu-satunya tempat rahasia pengguna disimpan). Nilai disimpan
 * TERENKRIPSI lewat `secrets.ts`; rute ini tidak pernah mengembalikan nilai, tidak menaruhnya di log,
 * dan tidak menaruhnya di `audit_events` (audit hanya memuat nama, label, dan panjang nilai).
 */
import { randomUUID } from "node:crypto";
import { requireUser } from "../auth.js";
import { db } from "../db.js";
import {
  isSealed, maskSecret, SECRET_VALUE_MAX_CHARS, SecretsKeyError, sealSecret, secretsKeyState, tryOpenSecret,
} from "../secrets.js";
import { runSelfAudit } from "../selfaudit.js";
import { adminRequired, audit, fail, isPlatformAdmin } from "./shared.js";

/** Nama rahasia: huruf kecil, angka, garis bawah, maksimum 40 karakter. */
const NAME_PATTERN = /^[a-z0-9_]+$/;
const NAME_MAX_CHARS = 40;
const LABEL_MAX_CHARS = 60;

type SecretRow = { name: string; label: string; stored: string; updatedAt: string };

const LIST_FIELDS = "name, label, secret_ciphertext AS stored, updated_at AS updatedAt";

/** Satu baris daftar: nama + label + petunjuk, tanpa nilai. */
function secretView(row: SecretRow) {
  const opened = tryOpenSecret(row.stored);
  return {
    name: row.name,
    label: row.label,
    terpasang: true,
    ekor: opened.ok ? maskSecret(opened.value).ekor : "",
    bisaDibuka: opened.ok,
    tersegel: isSealed(row.stored),
    updatedAt: row.updatedAt,
  };
}

export function registerCredentialRoutes(app: any): void {
  // ---------------------------------------------------------------- rahasia pengguna (butir 43)

  /** Daftar rahasia milik pengguna: nama, label, dan ekor saja. Nilainya tidak pernah dikirim. */
  app.get("/api/v1/account/secrets", { preHandler: requireUser }, async (request: any) => {
    const rows = db.prepare(`SELECT ${LIST_FIELDS} FROM user_secrets WHERE user_id=? ORDER BY name`)
      .all(request.user!.id) as SecretRow[];
    return {
      secrets: rows.map(secretView),
      kunci: secretsKeyState(),
      batasKarakter: SECRET_VALUE_MAX_CHARS,
      catatan: "Nilai rahasia tidak pernah dikirim lewat API; hanya nama, label, dan ekor.",
    };
  });

  /** Menyimpan (atau mengganti) satu rahasia. Nilai disegel sebelum menyentuh basis data. */
  app.put(
    "/api/v1/account/secrets/:name",
    { preHandler: requireUser },
    async (request: any, reply: any) => {
      const name = String(request.params?.name ?? "").trim();
      if (!NAME_PATTERN.test(name) || name.length > NAME_MAX_CHARS) {
        return fail(reply, 400, "INVALID_SECRET_NAME", `Nama rahasia hanya boleh huruf kecil, angka, dan garis bawah (maksimum ${NAME_MAX_CHARS} karakter).`);
      }
      const body = (request.body ?? {}) as { value?: unknown; label?: unknown };
      const value = body.value;
      if (typeof value !== "string" || value.trim() === "") {
        return fail(reply, 400, "INVALID_SECRET_VALUE", "Nilai rahasia wajib diisi dan tidak boleh hanya berisi spasi.");
      }
      if (value.length > SECRET_VALUE_MAX_CHARS) {
        return fail(reply, 400, "SECRET_TOO_LONG", `Nilai rahasia terlalu panjang (maksimum ${SECRET_VALUE_MAX_CHARS} karakter).`);
      }

      const userId = String(request.user!.id);
      const previous = db.prepare("SELECT id, label FROM user_secrets WHERE user_id=? AND name=?")
        .get(userId, name) as { id: string; label: string } | undefined;
      const label = typeof body.label === "string"
        ? body.label.trim().slice(0, LABEL_MAX_CHARS)
        : (previous?.label ?? "");

      let sealed: string;
      try {
        sealed = sealSecret(value);
      } catch (error) {
        if (error instanceof SecretsKeyError && error.code === "SECRETS_KEY_MISSING") {
          return fail(reply, 503, "SECRETS_KEY_MISSING", "Penyimpanan rahasia belum dikonfigurasi.");
        }
        throw error;
      }

      const now = new Date().toISOString();
      if (previous) {
        db.prepare("UPDATE user_secrets SET label=?, secret_ciphertext=?, updated_at=? WHERE id=?")
          .run(label, sealed, now, previous.id);
      } else {
        db.prepare("INSERT INTO user_secrets (id,user_id,name,label,secret_ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
          .run(randomUUID(), userId, name, label, sealed, now, now);
      }
      // Audit memuat nama + panjang nilai saja; nilainya tidak pernah masuk catatan.
      audit(userId, previous ? "account.secret.updated" : "account.secret.created", { name, label, panjang: value.length, tersegel: true });

      return reply.code(previous ? 200 : 201).send({
        secret: { name, label, terpasang: true, ekor: maskSecret(value).ekor, bisaDibuka: true, tersegel: true, updatedAt: now },
        message: "Rahasia tersimpan terenkripsi.",
      });
    },
  );

  /** Menghapus satu rahasia milik pengguna. Tidak memerlukan kunci induk. */
  app.delete(
    "/api/v1/account/secrets/:name",
    { preHandler: requireUser },
    async (request: any, reply: any) => {
      const userId = String(request.user!.id);
      const name = String(request.params?.name ?? "");
      const removed = db.prepare("DELETE FROM user_secrets WHERE user_id=? AND name=?").run(userId, name);
      if (Number(removed.changes ?? 0) === 0) return fail(reply, 404, "SECRET_NOT_FOUND", "Rahasia itu tidak ada.");
      audit(userId, "account.secret.deleted", { name });
      return { deleted: true, name };
    },
  );

  // ---------------------------------------------------------------- audit-diri admin (butir 53)

  /** Laporan audit-diri: hanya membaca, tanpa nilai rahasia, hanya untuk admin platform. */
  app.get("/api/v1/admin/self-audit", { preHandler: requireUser }, async (request: any, reply: any) => {
    if (!isPlatformAdmin(request.user!)) return adminRequired(reply);
    try {
      return runSelfAudit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(reply, 500, "SELF_AUDIT_FAILED", `Audit-diri gagal dijalankan: ${message.slice(0, 160)}`);
    }
  });
}

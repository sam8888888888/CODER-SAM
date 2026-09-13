// Ops helper: sets a password for one account using the application's own hashing.
// Usage inside the container: node ops-set-password.js <email> <new password>
const Database = require("better-sqlite3");
const { hashPassword } = require("./dist/api/auth.js");

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) { console.error("usage: node ops-set-password.js <email> <new password>"); process.exit(2); }
  if (password.length < 10) { console.error("PASSWORD_TOO_SHORT (minimum 10 characters)"); process.exit(2); }
  const db = new Database("/app/data/coder.db");
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
  if (!user) { console.error("USER_NOT_FOUND", email); process.exit(1); }
  const hash = await hashPassword(password);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, user.id);
  const revoked = db.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(user.id).changes;
  db.prepare("UPDATE auth_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL").run(new Date().toISOString(), user.id);
  console.log(`PASSWORD_SET email=${email} sessionsRevoked=${revoked}`);
  db.close();
}
main();

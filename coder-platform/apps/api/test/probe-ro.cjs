
// Membuktikan sebab kegagalan: membuka basis data mode WAL secara hanya-baca dari direktori
// yang hanya-baca (seperti mount :ro pada gerbang deploy) tidak bisa membaca jumlah baris.
const Database = require("better-sqlite3");
const path = process.argv[2];
try {
  const db = new Database(path, { readonly: true });
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  console.log("READ_OK users=" + row.n);
  db.close();
} catch (error) {
  console.log("READ_FAILED " + String(error.message).slice(0, 120));
}

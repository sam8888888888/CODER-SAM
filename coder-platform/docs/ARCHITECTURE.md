# COBLAI Coder Platform

Platform baru ini berdiri sendiri. `chat.coblai.com` hanya menjadi referensi kemampuan, bukan struktur internal. Prime Agent diperlakukan sebagai engine di belakang `AgentEngine` adapter.

## Runtime awal

- Satu container aplikasi untuk API + static web + SQLite.
- Engine Prime Agent tetap service terisolasi.
- SQLite memakai WAL dan backup file database.
- Semua data aplikasi berada di `data/coder.db`; backup berada di `backups/`.

## Backup dan restore

```bash
npm run backup
npm run restore -- backups/coder-YYYY-MM-DDTHH-MM-SS.sssZ.db
```

Restore wajib dilakukan saat API berhenti dan setelah backup current database dibuat.

## Batas keamanan

- Jangan commit `.env`, database, atau backup.
- Jangan mount volume instance `chat.coblai.com`.
- Jangan expose SQLite atau engine port ke internet.
- Auth dan authorization harus selesai sebelum endpoint data dibuka ke publik.


## Local engine mode

Set `MOCK_ENGINE=true` only for local functional tests. It never calls a model provider. Production must use a validated Prime Agent adapter configuration; the application does not guess the RPC wire format.

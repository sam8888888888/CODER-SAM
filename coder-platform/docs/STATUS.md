# Status implementasi

## Selesai
- Monorepo platform baru dibuat.
- API Fastify minimal berjalan.
- SQLite schema workspace/project/run/audit dibuat.
- Engine adapter seam dibuat tanpa mengikat route pada implementasi lama.
- Backup dan restore command dibuat.
- Dependency audit production: 0 vulnerabilities setelah `@fastify/static` dihapus.

## Belum selesai
- Auth, session, RBAC, CSRF, rate limiting.
- Prime Agent RPC adapter nyata.
- Frontend baru dipindahkan ke apps/web.
- Queue/run orchestration.
- Knowledge, artifacts, workflow, billing.
- Dockerfile dan deployment VPS.

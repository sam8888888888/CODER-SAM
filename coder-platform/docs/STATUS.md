# Status implementasi

## Selesai
- Registration, login, logout, `/me`, hashed password (scrypt), and httpOnly session cookie.
- Workspace listing and project routes are scoped to authenticated membership.
- Monorepo platform baru dibuat.
- API Fastify minimal berjalan.
- SQLite schema workspace/project/run/audit dibuat.
- Engine adapter seam dibuat tanpa mengikat route pada implementasi lama.
- Backup dan restore command dibuat.
- Dependency audit production: 0 vulnerabilities setelah `@fastify/static` dihapus.

## Belum selesai
- RBAC per route, CSRF strategy, rate limiting, MFA.
- Prime Agent RPC adapter nyata.
- Frontend baru dipindahkan ke apps/web.
- Queue/run orchestration.
- Knowledge, artifacts, workflow, billing.
- Dockerfile dan deployment VPS.

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
- Project run lifecycle (`queued`, `running`, `completed`, `failed`, `cancelled`) dan cancel endpoint.
- Prime Agent RPC adapter nyata (interface + mock mode selesai; wire protocol nyata belum divalidasi).
- Frontend baru dipindahkan ke apps/web (frontend build saat ini masih di coder-dashboard; container dapat menyalin dist itu).
- Queue/run orchestration (lifecycle dasar sudah ada; worker persisten belum).
- Mock engine untuk functional test lokal dan static web fallback pada API container.
- Knowledge, artifacts, workflow, billing.
- Dockerfile dan deployment VPS (Dockerfile/compose sudah dibuat; Docker binary lokal tidak tersedia, belum dijalankan di VPS).

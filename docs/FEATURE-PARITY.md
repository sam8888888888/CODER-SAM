# COBLAI Coder feature parity matrix

Status awal untuk dashboard baru. Fitur lama tidak dihapus; setiap baris menjadi kriteria penerimaan sebelum live.

| Area | Fitur | API rujukan | Status |
|---|---|---|---|
| Auth | Login/register/logout/me | `/api/login`, `/api/register`, `/api/logout`, `/api/me` | Fondasi terhubung |
| Auth | Google OAuth | `/api/auth/google*` | Belum dimigrasikan |
| Auth | MFA TOTP + backup code | `/api/mfa/*` | Belum dimigrasikan |
| Chat | Streaming chat | `/api/chat`, `/api/events` | Fondasi terhubung |
| Sessions | Buat, switch, history | `/api/sessions*` | Fondasi terhubung |
| Sessions | Rename, pin, branch, import/export | `/api/sessions*`, `/api/import-session`, `/api/export-session` | Belum dimigrasikan |
| Files | Upload, artifacts, editor, diff | `/api/upload`, `/api/artifact*`, `/api/artifacts`, `/api/diff` | Belum dimigrasikan |
| AI | Models, mode, thinking, abort | `/api/models`, `/api/model`, `/api/mode`, `/api/thinking`, `/api/abort` | Belum dimigrasikan |
| Agents | Agents, skills, subagents, autonomous | `/api/agents*`, `/api/skills*`, `/api/subagent*`, `/api/autonomous*` | Belum dimigrasikan |
| Memory | Memory, learnings, prompts, guardrails | `/api/memory*`, `/api/learnings*`, `/api/prompts*`, `/api/guardrails` | Belum dimigrasikan |
| Billing | Tier, quota, orders, payments, coupon | `/api/orders*`, `/api/payments*`, `/api/coupons*`, `/api/usage` | Belum dimigrasikan |
| Admin | Users, branding, errors, reports | `/api/users*`, `/api/admin/*` | Belum dimigrasikan |
| Integrations | Notion, Telegram, WhatsApp, push | `/api/notion/*`, `/api/telegram/*`, `/api/whatsapp/*`, `/api/push/*` | Belum dimigrasikan |
| Premium | Workspace, project, knowledge base, workflows, teams | Fitur baru | Belum dibuat |

## Aturan kelulusan

- Fitur hanya berstatus selesai setelah UI, API, error state, mobile, dan alur autentikasinya diuji.
- Endpoint backend lama tetap menjadi kontrak awal.
- Tidak ada endpoint atau fitur lama yang dihapus selama migrasi.
- Perubahan backend dilakukan terpisah dari frontend dan diuji dengan data lokal.

# Deployment shape

`docker-compose.yml` defines one application container and two named volumes. The Prime Agent engine remains isolated. Nginx should proxy `coder.sam.university` to `127.0.0.1:3400`.

Before deployment:

1. Copy `.env.example` to `.env` and set production values.
2. Confirm the external `coder-net` exists.
3. Build the image.
4. Run database backup before upgrades.
5. Use `nginx -t` before reloading Nginx.
6. Check `/health` and `/ready`.
7. Do not run `docker compose down` in another stack.

The compose file is not executed against the VPS in this phase.

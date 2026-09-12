# Recipe build paket

Di host/server yang memiliki Docker dan image base Prime Agent:

```bash
cd <paket>
cd coder-dashboard && npm ci && npm run build
cd ../coder-platform && npm ci && npm run build:api
mkdir -p public
cp -a ../coder-dashboard/dist/. public/
cp .env.austria.example .env
# isi .env hanya dengan keputusan/credential yang sudah disetujui
docker compose -f docker-compose.austria.yml build
docker compose -f docker-compose.austria.yml up -d coder-platform-app
```

Sebelum `up`, lakukan backup konfigurasi dan cek `docker compose ps`.

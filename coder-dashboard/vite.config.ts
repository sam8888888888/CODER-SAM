import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', includeAssets: ['favicon.png'], manifest: { name: 'COBLAI Coder', short_name: 'COBLAI', description: 'AI workspace untuk bekerja lebih cepat', theme_color: '#090b16', background_color: '#090b16', display: 'standalone', start_url: '/', icons: [] } })],
  server: { port: 4173, proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } } },
});

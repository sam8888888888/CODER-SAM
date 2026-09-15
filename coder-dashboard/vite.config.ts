import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Installable app: the manifest and the service worker are generated into dist/ and copied
    // into the API public folder by the deploy script, so /manifest.webmanifest and /sw.js are live.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'COBLAI Coder',
        short_name: 'COBLAI',
        description: 'AI workspace untuk bekerja lebih cepat',
        lang: 'id',
        theme_color: '#090b16',
        background_color: '#090b16',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['productivity', 'developer'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Percakapan baru', short_name: 'Chat', url: '/?page=chat' },
          { name: 'Paket & langganan', short_name: 'Paket', url: '/?page=billing' },
        ],
      },
    }),
  ],
  server: { port: 4173, proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } } },
});

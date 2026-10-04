import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), VitePWA({
    registerType: 'prompt', injectRegister: null,
    includeAssets: ['icon.svg', 'highs.wasm'],
    manifest: { name: 'MOST · Ciągłość usług', short_name: 'MOST', description: 'Lokalna koordynacja ciągłości usług', lang: 'pl', start_url: '/', scope: '/', display: 'standalone', background_color: '#f4f5ee', theme_color: '#172d32', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,woff2,wasm}'], maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//, ...(process.env.MOST_PUBLIC_DEMO_BUILD === 'true' ? [/^\/demo(?:$|\/|\?)/, /^\/materialy(?:$|\/|\?)/] : [])],
      cleanupOutdatedCaches: false, skipWaiting: false, clientsClaim: false,
      runtimeCaching: []
    }, devOptions: { enabled: false }
  })],
  resolve: { alias: { '@most/contracts': resolve(__dirname, '../../packages/contracts/src/index.ts'), '@most/engine': resolve(__dirname, '../../packages/engine/src/index.ts'), '@most/scenarios': resolve(__dirname, '../../packages/scenarios/src/index.ts') } },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } } },
  build: { outDir: process.env.MOST_PUBLIC_DEMO_BUILD === 'true' ? '../../artifacts/private/public-demo/web-release' : 'dist', emptyOutDir: true, sourcemap: true },
  worker: { format: 'es' }
});

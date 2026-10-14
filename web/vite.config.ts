import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The API (src/api/server.ts) serves this build in production; in dev, /api is proxied to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { proxy: { '/api': { target: process.env.SYNAPSER_API ?? 'http://127.0.0.1:4173', changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
})

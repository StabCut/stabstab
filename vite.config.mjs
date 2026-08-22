import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base 必须为相对路径，打包后 Electron 通过 file:// 加载 dist/index.html
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    target: 'chrome120'
  }
})

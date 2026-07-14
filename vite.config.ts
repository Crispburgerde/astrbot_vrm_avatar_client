import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import Inspector from 'unplugin-vue-dev-locator/vite'

// https://vite.dev/config/
export default defineConfig({
  // wlipsync-single.js 使用顶层 await（加载 WASM），
  // 默认目标 es2020 不支持，需提升到 esnext（顶层 await 需 Chrome89+/FF89+/Safari15+）
  build: {
    sourcemap: 'hidden',
    target: 'esnext',
    // three.js + VRM 本身体积大（约 700kB），无法再拆，故调高阈值
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          // three.js + VRM 相关库体积大，单独分包，长期缓存
          three: ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation'],
          // Vue 生态单独分包
          vue: ['vue', 'vue-router'],
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  plugins: [
    vue(),
    Inspector(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'), // ✅ 定义 @ = src
    },
  },
})


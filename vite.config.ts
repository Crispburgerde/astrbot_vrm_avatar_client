import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import fs from 'fs'
import Inspector from 'unplugin-vue-dev-locator/vite'

// Windows 下系统 %TEMP% 中的 esbuild 临时文件会被杀软/策略锁定，
// 导致构建报 "remove ...esbuild...: Access is denied"（本机已复现），
// 将临时目录重定向到项目本地目录规避（node_modules 已被 git 忽略）
if (process.platform === 'win32') {
  const localTmp = path.resolve(__dirname, './node_modules/.tmp')
  fs.mkdirSync(localTmp, { recursive: true })
  process.env.TMP = localTmp
  process.env.TEMP = localTmp
}

// https://vite.dev/config/
export default defineConfig({
  // 嵌入 AstrBot WebUI iframe 时挂在任意子路径下，资源需用相对路径引用
  base: './',
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


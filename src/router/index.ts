import { createMemoryHistory, createRouter, createWebHistory } from 'vue-router'
import HomePage from '@/pages/HomePage.vue'

// 单页应用：仅一个舞台页
const routes = [
  {
    path: '/',
    name: 'home',
    component: HomePage,
  },
]

// 嵌入 AstrBot WebUI 时（bridge 全局存在）：iframe 沙箱为 opaque origin，
// History API 抛 SecurityError 且入口路径不匹配路由，改用内存路由
const embedded =
  typeof (window as { AstrBotPluginView?: unknown }).AstrBotPluginView !==
  'undefined'

const router = createRouter({
  history: embedded ? createMemoryHistory() : createWebHistory(),
  routes,
})

export default router

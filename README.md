# VRM 虚拟形象舞台

基于 Vue 3 + Three.js 的 VRM 虚拟形象前端客户端，通过 WebSocket 连接 [AstrBot](https://github.com/Soulter/AstrBot) 后端，实现实时驱动的虚拟主播体验。

## 功能特性

- **VRM 模型渲染** — 基于 `@pixiv/three-vrm` 加载 VRM 模型，自动取景为半身像，支持视线跟踪摄像机
- **VRMA 动画** — 支持后端推送多个命名动画（`.vrma`），`idle` 作为待机循环动画，其余可由表演段的 `action` 字段按名引用，切换时带交叉淡入淡出
- **实时口型同步** — 基于 [wLipSync](https://github.com/w-lipsync/wLipSync)（AudioWorklet + WASM），从 TTS 音频实时分析音素并驱动五元音口型
- **自然生命感动画** — 程序化呼吸（胸腔俯仰 + 肩部上下）、自然眨眼、说话时身体/头部摆动（音量驱动）
- **情绪表情过渡** — 支持平滑切换模型内嵌表情（happy / angry / sad / relaxed / surprised / neutral 等）
- **WebSocket 通信** — 自动重连（指数退避），JSON 消息分发，连接状态实时显示
- **控制面板** — 可调节 WebSocket 地址、音量、三盏灯光强度、呼吸幅度、说话摆动幅度，所有参数自动持久化到 `localStorage`
- **轨道摄像机** — 左键拖拽旋转、滚轮缩放、中键/右键平移
- **字幕与状态栏** — 实时显示对话字幕、当前表情、连接状态

## 技术栈

| 分类 | 技术 |
|------|------|
| 框架 | Vue 3 (`<script setup>`) + TypeScript |
| 构建 | Vite 5 |
| 3D 渲染 | Three.js + @pixiv/three-vrm + @pixiv/three-vrm-animation |
| 口型同步 | wLipSync（AudioWorklet + WASM） |
| 样式 | TailwindCSS + 自定义 CSS 变量 |
| 图标 | lucide-vue-next |
| 路由 | vue-router |

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装与运行

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 类型检查
npm run check

# 构建生产版本
npm run build

# 预览生产构建
npm run preview
```

开发服务器启动后，浏览器打开页面即可。页面加载后会**自动连接**默认的 WebSocket 地址 `ws://localhost:8765`。

### 连接 AstrBot 后端

1. 在 AstrBot 中安装 [astrbot_plugin_vrm_avatar](https://github.com/Crispburgerde/astrbot_plugin_vrm_avatar) 插件（服务端消息实现参考 [server_reference/messages.py](server_reference/messages.py)）
2. 确认 AstrBot 的 WebSocket 服务端口（默认 `8765`）
3. 如需修改地址，点击页面右上角齿轮按钮打开控制面板，在 **连接** 区域填写 WebSocket 地址后点击 **连接**

> 连接成功后，后端会自动推送 VRM 模型、背景图、动画及表演消息。

## WebSocket 协议

客户端接收后端推送的 JSON 消息，共 4 种类型（详见 [src/types/messages.ts](src/types/messages.ts)）：

### `update_character` — 更新 VRM 模型

```jsonc
{
  "type": "update_character",
  "vrm": { "filename": "model.vrm", "data": "<base64>" }
}
```

### `update_background` — 更新背景图

```jsonc
{
  "type": "update_background",
  "background": { "filename": "bg.png", "data": "<base64>" }
}
```

### `update_animations` — 更新动画列表

```jsonc
{
  "type": "update_animations",
  "animations": [
    { "name": "idle", "file": { "filename": "idle.vrma", "data": "<base64>" }, "loop": true },
    { "name": "wave", "file": { "filename": "wave.vrma", "data": "<base64>" }, "loop": false }
  ]
}
```

> `idle` 为待机动画（强制循环），其余动画可由表演段的 `action` 字段按名引用。

### `performance` — 表演消息（对话 + 表情 + 动作 + 语音）

```jsonc
{
  "type": "performance",
  "segments": [
    {
      "dialogue": "你好呀！",
      "expression": "happy",
      "action": "wave",           // 可选，缺省时保持 idle
      "audio": {                   // 可选，缺省时按文本长度静音展示
        "filename": "tts_001.mp3",
        "data": "<base64>"
      }
    }
  ]
}
```

表演段按顺序入队播放：切换表情 → 延迟 600ms 等待表情过渡 → 播放音频（同时驱动口型同步和说话摆动）→ 音频结束后播放下一段。无音频时按文本长度估算展示时长（每字约 180ms，1.2s~8s）。

## 项目结构

```
src/
├── components/
│   ├── StageCanvas.vue        # Canvas 容器与加载提示
│   ├── SubtitleBar.vue        # 字幕栏（对话文本 + 表情标签）
│   ├── StatusBar.vue          # 连接状态指示
│   └── ControlPanel.vue       # 控制面板抽屉（连接/音量/灯光/动画参数）
├── composables/
│   ├── useVRMScene.ts         # Three.js 场景层：渲染循环/模型加载/灯光/背景
│   ├── usePerformance.ts      # 表演层：队列管理/音频播放/口型同步驱动
│   ├── useWebSocket.ts        # WebSocket 通信层：连接/自动重连/消息分发
│   ├── useEmotion.ts          # 情绪表情平滑过渡
│   ├── useBlink.ts            # 自然眨眼
│   ├── useBreath.ts           # 程序化呼吸（胸腔 + 肩部）
│   ├── useBodySway.ts         # 说话摆动（音量驱动）
│   ├── usePersistentRef.ts    # localStorage 持久化 ref
│   ├── loadVRM.ts             # VRM 文件解析与优化
│   └── loadVRMA.ts            # VRMA 动画文件解析
├── types/
│   ├── messages.ts            # WebSocket 协议消息类型定义
│   └── lipsync.ts             # 口型权重类型
├── pages/
│   └── HomePage.vue           # 主页面：组合各层并分发消息
└── lib/
    └── utils.ts               # 工具函数

server_reference/
└── messages.py                # AstrBot 插件消息构建器（服务端参考实现）

public/
├── audio-processor.js         # wLipSync AudioWorklet 处理器
├── profile.bin                # wLipSync 预计算 profile
└── logo.png
```

## 浏览器操作指南

| 操作 | 效果 |
|------|------|
| 左键拖拽 | 旋转视角 |
| 滚轮 | 缩放 |
| 中键 / 右键拖拽 | 平移 |
| 齿轮按钮 | 打开/关闭控制面板 |
| 控制面板 → 连接 | 修改 WebSocket 地址、手动连接/断开 |
| 控制面板 → 音频 | 调节音量、静音、跳过当前表演 |
| 控制面板 → 灯光 | 调节环境光 / 主光 / 边缘光强度 |
| 控制面板 → 角色 | 调节呼吸幅度（胸腔/肩部）、说话摆动幅度（身体/头部） |

> 所有控制面板参数自动保存到浏览器 `localStorage`，下次打开时自动恢复。

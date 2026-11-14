# VRM 虚拟形象客户端

基于 Vue 3 + Three.js 的 VRM 虚拟形象前端客户端，通过 WebSocket 连接 [AstrBot](https://github.com/Soulter/AstrBot) 后端，实现实时驱动的虚拟主播体验。

## 功能特性

- **VRM 模型渲染** — 基于 `@pixiv/three-vrm` 加载 VRM 模型，自动取景为半身像，支持视线跟踪摄像机
- **VRMA 动画** — 支持后端推送多个命名动画（`.vrma`），`idle` 层作为待机循环动画（可经 `set_idle` 消息在线切换变体，交叉淡入淡出）
- **实时口型同步** — 基于 [wLipSync](https://github.com/w-lipsync/wLipSync)（AudioWorklet + WASM），从 TTS 音频实时分析音素并驱动五元音口型
- **自然生命感动画** — 程序化呼吸（胸腔俯仰 + 肩部上下）、说话时身体/头部摆动（音量驱动），表情引擎自带自然眨眼与头部微动
- **情绪表情引擎** — 移植 [SoullinkEmotion3D](https://github.com/nanlingyin/soullink-emotion-sdk)：24 词情绪词表 + VAD 状态机 + FACS AU 求解 + morph 直写；模型不适配时自动回退 VRM 预设表情
- **WebSocket 通信** — 自动重连（指数退避），JSON 消息分发，连接状态实时显示；大文件（模型/背景/动画）经 HTTP 下载并持久缓存
- **控制面板** — 可调节服务器主机 / WS 端口 / 文件下载端口、音量、三盏灯光强度、呼吸幅度、说话摆动幅度，所有参数自动持久化到 `localStorage`
- **轨道摄像机** — 左键拖拽旋转、滚轮缩放、中键/右键平移
- **字幕与状态栏** — 实时显示对话字幕、当前情绪、连接状态

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

开发服务器启动后，浏览器打开页面即可。页面加载后会**自动连接**默认后端 `ws://localhost:8765`。服务器主机、WebSocket 端口与文件下载端口均可在页面右上角控制台自行填写，并持久化保存在浏览器 localStorage 中。

### 连接 AstrBot 后端

1. 在 AstrBot 中安装 [astrbot_plugin_vrm_avatar](https://github.com/Crispburgerde/astrbot_plugin_vrm_avatar) 插件（服务端协议参考实现在 [server_reference/](server_reference)：`messages.py` / `performance.py` / `wire_types.py`）
2. 确认 AstrBot 的 WebSocket 服务端口（默认 `8765`）
3. 如需修改地址，点击页面右上角齿轮按钮打开控制面板，在 **连接** 区域填写服务器主机与端口后点击 **连接**

> 连接成功后，后端会自动推送 VRM 模型、背景图、动画及表演消息。

## WebSocket 协议

客户端只接收不发送，后端推送 JSON 消息，共 5 种类型（详见 [src/types/messages.ts](src/types/messages.ts)）。

所有文件负载均为 `FilePayload = { filename, url? | data? }`，且 `url` / `data` **恰好设置其一**：大文件（VRM / 背景 / VRMA）用 `url`（文件下载服务的相对路径 `/files/<name>`，客户端拼 `http://{host}:{filePort}` 经 HTTP 下载，享受浏览器缓存，页面刷新不重推 WS）；小负载（TTS 音频）内嵌 `data` base64。

### `update_character` — 更新 VRM 模型

```jsonc
{
  "type": "update_character",
  "vrm": { "filename": "avatar.vrm", "url": "/files/avatar.vrm" }
}
```

### `update_background` — 更新背景图

```jsonc
{
  "type": "update_background",
  "background": { "filename": "bg.png", "url": "/files/bg.png" }
}
```

### `update_animations` — 更新动画列表

```jsonc
{
  "type": "update_animations",
  "animations": [
    { "name": "idle",       "layer": "idle",    "file": { "filename": "standby_a.vrma", "url": "/files/standby_a.vrma" } },
    { "name": "wave_right", "layer": "gesture", "file": { "filename": "wave.vrma",      "url": "/files/wave.vrma" } }
  ]
}
```

> `layer` 取值 `idle` / `gesture` / `action`（缺省）：`idle` 为 Base 层待机变体（供 `set_idle` 消息切换）；`gesture` / `action` 暂无触发路径，注册保留。

### `set_idle` — 切换待机动画（带外消息）

```jsonc
{ "type": "set_idle", "name": "idle_cheerful" }
```

> 不属于表演队列，客户端收到即生效（Base 层交叉淡化），不影响正在进行的表演；`name` 应为注册表中 `layer=idle` 的条目名。

### `performance` — 表演消息（对话 + 情绪 + 语音）

```jsonc
{
  "type": "performance",
  "performances": [
    { "text": "你好呀！",        "emotion": "happy",      "intensity": 0.85, "start": 0.0, "end": 1.8 },
    { "text": "哼，我才不在意呢", "emotion": "frustrated", "intensity": 0.85, "start": 1.8, "end": 4.2 }
  ],
  "audio": { "filename": "tts_reply.mp3", "data": "<base64>" }  // 消息级共享音频，可缺省
}
```

- 一次 LLM 回复 = 有序表演段数组 + **一条共享 TTS 音频**（数组的兄弟字段 `audio`，各段文本拼接后一次合成，整条只播一次）
- 每段 = 台词 + `emotion`（固定 24 词情绪词表：`neutral/happy/excited/…/surprised`，与前端表情引擎逐词同步，词表外降级 `neutral`）+ `intensity`（0~1，服务端固定默认 0.85）+ `start` / `end` 时间窗（本段在共享音频内的秒数，由服务端词级对齐回填）
- 播放：单一 rAF 时间轴按音频 `currentTime` 推进，段边界处同时切换情绪与字幕（表情引擎自带平滑过渡），音频播完复位 neutral；`start/end` 缺失时按文本长度比例回退估算
- 无音频时回退逐段静音展示：每字约 180ms（1.2s~8s）

## 项目结构

```
src/
├── components/
│   ├── StageCanvas.vue        # Canvas 容器与加载提示
│   ├── SubtitleBar.vue        # 字幕栏（对话文本 + 情绪标签）
│   ├── StatusBar.vue          # 连接状态指示
│   └── ControlPanel.vue       # 控制面板抽屉（连接/音量/灯光/动画参数）
├── composables/
│   ├── useVRMScene.ts         # Three.js 场景层：渲染循环/模型加载/灯光/背景
│   ├── usePerformance.ts      # 表演层：队列管理/共享音频时间轴/口型同步驱动
│   ├── useWebSocket.ts        # WebSocket 通信层：连接/自动重连/消息分发/文件 URL 拼接
│   ├── useBreath.ts           # 程序化呼吸（Offset 节点叠加）
│   ├── useBodySway.ts         # 说话摆动（音量驱动，Offset 节点叠加）
│   ├── usePersistentRef.ts    # localStorage 持久化 ref
│   ├── fileCache.ts           # 大文件 HTTP 下载缓存（Cache Storage + 304 再验证）
│   ├── loadVRM.ts             # VRM 文件解析与优化
│   └── loadVRMA.ts            # VRMA 动画文件解析
├── emotion/                   # 表情驱动层（移植 SoullinkEmotion3D）
│   ├── faceDriver.ts          # 粘合层：morph 直写/头部姿态叠加/视线/口型闸门
│   ├── engine.ts              # FaceEngine：情绪 VAD 状态机 + 120Hz 临界阻尼输出
│   ├── emotions.ts            # 24 词情绪目录（VAD 预设 + AU 锚点）
│   ├── morphProfile.ts        # AU → 模型 morph 绑定（多方言词典竞标 + 预设回退）
│   ├── arkit.ts               # FACS AU ↔ ARKit 52 通道映射
│   └── detailed-vad.ts / directions.ts / motion.ts   # 引擎内部依赖
├── animation/                 # 四层动画系统
│   ├── AnimationController.ts # Base / Additive / Gesture / Action 层编排
│   ├── MixerLayer.ts          # 单动画层（独立 AnimationMixer，后更新者覆写）
│   └── avatarMask.ts          # Gesture 层上半身遮罩（轨道裁剪）
├── types/
│   ├── messages.ts            # WebSocket 协议消息类型定义
│   └── lipsync.ts             # 口型权重类型
├── pages/
│   └── HomePage.vue           # 主页面：组合各层并分发消息
└── lib/
    └── utils.ts               # 工具函数

vendor/soullink/               # soullink-emotion-sdk 原始文件（Apache-2.0，只读）

server_reference/              # AstrBot 插件协议参考实现
├── wire_types.py              # 线上类型（FilePayload：url/data 二选一）
├── performance.py             # Performance 模型 + [emotion] 标签文本解析
└── messages.py                # 消息构建器（TTS 合成/词级对齐/文件 URL）

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
| 控制面板 → 连接 | 填写服务器主机 / WS 端口 / 文件下载端口，手动连接/断开 |
| 控制面板 → 音频 | 调节音量、静音、跳过当前表演 |
| 控制面板 → 灯光 | 调节环境光 / 主光 / 边缘光强度 |
| 控制面板 → 角色 | 调节呼吸幅度（胸腔/肩部）、说话摆动幅度（身体/头部）、口型隔离开关（调试） |

> 所有控制面板参数自动保存到浏览器 `localStorage`，下次打开时自动恢复。

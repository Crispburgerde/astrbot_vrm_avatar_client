# astrbot_vrm_avatar_client 技术规格（Spec）

> 版本 1.7 · 更新于 2026-11-09 · 协议或核心机制变更时须同步更新本文档

VRM 虚拟形象的浏览器端驱动客户端。通过 WebSocket 接收 AstrBot 后端推送的模型、动画与"表演"数组，在 Three.js 场景中实时渲染虚拟形象：说话（TTS 音频 + 口型同步）、情绪表情（借用 SoullinkEmotion3D 的表情控制引擎：24 词情绪词表 + VAD 状态机 + FACS AU 求解 + morph 直写）、动作与生命感动画。

- 技术栈：Vue 3 (`<script setup>`) + TypeScript + Vite 5 + Three.js / @pixiv/three-vrm(-animation) + wLipSync（AudioWorklet + WASM）+ TailwindCSS
- 运行形态：纯前端 SPA，无自有后端；服务端为 AstrBot 插件（本仓库仅提供协议参考实现 `server_reference/`）
- 表情引擎来源：`vendor/soullink/`（[soullink-emotion-sdk](https://github.com/nanlingyin/soullink-emotion-sdk)，Apache-2.0，见 `vendor/soullink/SOURCE.json`）

---

## 1. 总体架构

### 1.1 分层

```
WebSocket (JSON)
   │
   ▼
HomePage.vue ──── 消息路由（组合根）
   │
   ├── useWebSocket      通信层：连接 / 指数退避重连 / JSON 分发
   │
   ├── usePerformance    表演层：表演段队列、音频播放、口型/音量驱动
   │       │  (setEmotion(emotion,intensity) / setLipWeights / setAudioLevel /
   │       │   returnToIdle)
   │       ▼
   └── useVRMScene       场景层：渲染循环、模型/背景加载、灯光、面部驱动编排
           │
           ├── faceDriver (src/emotion/)  表情驱动层：FaceEngine（情绪 VAD
           │       状态机 + FACS AU 求解 + 眨眼/头部姿态/视线）+ morph 直写
           │       （AU→模型 morph 绑定，未命中回退 VRM 预设表情）+ 口型闸门
           │
           └── AnimationController   动画系统：四层
                ├── Base      基础层（常驻待机循环，可切换变体）
                ├── Additive  程序化叠加钩子（呼吸 useBreath、说话摆动 useBodySway）
                ├── Gesture   上半身遮罩手势层（注册保留，暂无触发路径）
                └── Action    全身覆盖一次性动作层（注册保留，暂无触发路径）
```

### 1.2 渲染循环每帧顺序（useVRMScene.loop）

```
OrbitControls 阻尼 → face.update(dt)（FaceEngine 120Hz 定步长：情绪 AU /
  眨眼 / 头部姿态 / 视线偏移）→ face.prepareHead（还原上一帧头部姿态偏移）
→ animator.update（Additive 钩子 → Base → Gesture/Action，后更新者覆写共享骨骼）
→ face.applyHead（VRMA 关键帧之上乘法叠加情绪头部偏移 + 写入 lookAt 角度）
→ vrm.update(dt)（骨骼 normalized→raw 同步、视线、表情）
→ face.applyFace（morph 直写：覆盖 expressionManager 输出，含口型合成与闸门）
→ render
```

顺序是正确性的关键：程序化偏移先就位，关键帧层按优先级依次覆写，表情引擎的
头部偏移在关键帧之后乘法叠加，面部 morph 在 VRM 收尾后直写取得最终覆盖权。

---

## 2. WebSocket 协议（src/types/messages.ts）

客户端只接收不发送。消息均为 JSON，`type` 字段区分五种：

| type | 负载 | 作用 |
|------|------|------|
| `update_character` | `vrm: FilePayload` | VRM 模型，连接时或配置变更后推送；`url` 引用（HTTP 下载） |
| `update_background` | `background: FilePayload` | 背景图；`url` 引用 |
| `update_animations` | `animations: AnimationEntry[]` | 命名 VRMA 动画集；`layer: idle/gesture/action(default)`，idle 层条目供 `set_idle` 工具白名单校验（v1.5 起 gesture/action 条目仅注册保留，performance 不再引用）；`url` 引用 |
| `set_idle` | `name: string` | 切换 Base 层待机变体（v1.4 起独立消息，脱离 performance 数组） |
| `performance` | `performances: Performance[]`, `audio?: FilePayload` | 一次 LLM 回复解析出的**有序表演段数组** + **一条共享 TTS 音频**（数组的兄弟字段，v1.7 起不再逐段内嵌）；音频整条只播一次，客户端按每段 `start/end` 时间窗切换情绪与字幕 |

`FilePayload = { filename, url? | data? }`——**恰好设置其一**（v1.6 起）：大文件（VRM/背景/VRMA）用 `url`（文件下载服务的相对路径 `/files/<name>`，客户端拼 `http://{host}:{filePort}` 后经 fetch/TextureLoader 下载，走浏览器原生 HTTP 缓存，页面刷新不重推 WS）；小负载（TTS 音频）仍内嵌 `data` base64。

### 2.1 消息示例

五种消息的线上格式示例：

```json
{
  "type": "update_character",
  "vrm": { "filename": "avatar.vrm", "url": "/files/avatar.vrm" }
}
```

```json
{
  "type": "update_background",
  "background": { "filename": "bg.png", "url": "/files/bg.png" }
}
```

```json
{
  "type": "update_animations",
  "animations": [
    { "name": "idle",       "layer": "idle",  "file": { "filename": "standby_a.vrma", "url": "/files/standby_a.vrma" } },
    { "name": "wave_right", "layer": "gesture", "file": { "filename": "wave.vrma",    "url": "/files/wave.vrma" } }
  ]
}
```

```json
{ "type": "set_idle", "name": "idle_cheerful" }
```

```json
{
  "type": "performance",
  "performances": [
    { "text": "你好呀！", "emotion": "happy", "intensity": 0.85,
      "start": 0.0, "end": 1.8 },
    { "text": "哼，我才不在意呢", "emotion": "frustrated", "intensity": 0.85,
      "start": 1.8, "end": 4.2 }
  ],
  "audio": { "filename": "tts_reply.mp3", "data": "<base64>" }
}
```

字段语义以 [src/types/messages.ts](src/types/messages.ts) 与 `server_reference/` 的 pydantic 模型为准；`AnimationEntry.layer` 缺省为 `"action"`，共享 `audio` 由服务端 TTS 步骤填充、可缺省。

### 2.2 performance 消息（v1.7）

一次 LLM 回复 = 一个表演段数组 + 一条共享音频，每个元素（`Performance`）= 一段台词 + 情绪及其在共享音频内的时间窗：

- `text: string` — 本段台词；恒非空（服务端跳过空台词段）
- `emotion?: string` — 本段台词期间的情绪，属**固定 24 词情绪词表**（`neutral/happy/excited/amused/proud/confident/calm/relieved/affectionate/shy/embarrassed/curious/concerned/confused/tired/sad/lonely/disappointed/anxiety/fear/anger/frustrated/disgust/surprised`），与前端表情引擎 `src/emotion/emotions.ts` 的 `emotionCatalog` 逐词同步；词表外值在服务端降级为 `neutral`（客户端 faceDriver 二次兜底）。**段作用域**：时间窗内生效，音频播完复位 neutral
- `intensity?: number` — 情绪强度 `0~1`；LLM 不再生成，服务端固定下发默认 `0.85`
- `start? / end?: number` — 本段在共享音频内的时间窗（秒），由服务端词级对齐（forced alignment）步骤回填；对齐失败或无音频时为 `null`，客户端回退按文本长度比例把段均分到音频时长
- 消息级 `audio?: FilePayload` — **整次回复合成的单条 TTS 音频**（各段文本带 `[emotion]` 前缀拼接后一次合成，情绪前缀同时驱动 TTS 情感韵律），base64 内嵌于消息（数组的兄弟字段），可缺省

v1.7 起 LLM 输出不再是无标记的 JSON 数组，而是**在原始回复文本中内联插入 `[emotion]` 标签**（每个标签作用于其后至下一标签的文本），服务端 `parse_tagged_text` 解析回表演段（见 §3.12）；非词表方括号 token 保留为字面文本。v1.5 移除了 `expression` 与 `action` 字段的决策不变；待机切换仍由服务端 `set_idle` LLM 工具直接下发独立消息。

### 2.3 set_idle 消息（v1.4）

待机变体切换不属于 performance 数组，改为独立的带外（out-of-band）消息：

- **持久状态而非定时表演**：变体选择与对话时序无关，无需在表演队列中占位排队。客户端收到即生效——HomePage 直接调 `scene.setIdle(name)`（Base 层交叉淡化 0.25s），**不经过**表演层队列，也不影响正在进行的表演。
- **命名约束**：`name` 应为注册表中 `layer=idle` 的条目（服务端 `set_idle` 工具负责白名单校验）；客户端防御式兜底——未注册名经 `resolveIdleClip` 解析链回落默认待机。
- **协议无 null 复位**：恢复默认待机由服务端显式下发默认条目名；客户端的 `setIdle(null)` 仅保留给动画集重载时的失效清理等内部路径。
- **`skip()` 不复位待机覆盖**：跳过一场表演不应撤销独立的持久待机状态。

---

## 3. 模块规格

约定：每个模块给出「目的 / 功能 / 实现」。路径省略 `src/` 前缀。

### 3.1 pages/HomePage.vue — 组合根与消息路由

- **目的**：把通信层、表演层、场景层装配起来，并作为唯一的消息分发点。
- **功能**：持有 canvas 引用；`onMounted` 初始化场景并自动连接；收到消息按 type 分发——FilePayload 统一在此解析（`url` → `http://{host}:{filePort}` 经 fetch/TextureLoader 下载，`data` → data URL 兜底）：模型/动画 fetch 成 ArrayBuffer 进场景层，背景把 URL 直接交给场景层；`set_idle` 直接调场景层 `setIdle`（带外即时生效，不排队），performance 入表演层队列；音量持久化并 watch 同步到表演层；待机提示文案；连接按钮内先 `unlockAudio()` 再 connect。
- **实现**：三个 composable 实例互为依赖（scene 注入 performance，ws 回调闭包引用两者）；UI 组件只做展示与事件透传。

### 3.2 composables/useWebSocket.ts — 通信层

- **目的**：稳定的 WS 连接与消息入口。
- **功能**：connect/disconnect/setHost/setWsPort/setFilePort；断线自动重连；状态机 `disconnected/connecting/connected` 暴露给 UI。
- **实现要点**：
  - 连接参数为「主机 + WebSocket 端口 + 文件下载端口」三字段，各自持久化到 localStorage（键 `vrm.avatar.host` / `vrm.avatar.wsPort` / `vrm.avatar.filePort`，默认 `localhost` / `8765` / `8766`）；WS 地址由 host+port 拼出；旧版单地址键 `vrm.avatar.wsUrl` 首次启动时迁移。`resolveFileUrl(path)` 把 FilePayload 的 `/files/...` 相对路径拼成 `http://{host}:{filePort}{path}`，供大文件 HTTP 下载；
  - 重连指数退避 `min(1000·2ⁿ, 8s)`，手动断开置 `manualClose` 不再重连；
  - 非 JSON 或无 `type` 的消息直接忽略；ws 实例用 `shallowRef` 避免被代理。

### 3.3 composables/usePerformance.ts — 表演层（核心调度）

- **目的**：把 performance 消息变成一场"演出"：单条共享音频、字幕、口型、情绪的时序编排。
- **功能**：`enqueue(message)` 入队（一场 = 表演段数组 + 共享音频）；`skip()` 跳过全部；暴露 `subtitle / currentEmotion / isPlaying` 给 UI；`setVolume / unlockAudio`。
- **实现要点**：
  - **队列语义（v1.7）**：逐场处理。带音频的演出：**音频从头到尾只播一次**，单一 rAF 循环（口型 + 时间轴 + watchdog 合一）按 `el.currentTime` 推进——**情绪与字幕共用同一索引，在同一段边界同时切换**（FaceEngine 临界阻尼自带平滑过渡，不人为提前；首段在起播前就位），段间停顿保留上一段情绪/字幕，音频 `ended` 后复位 neutral。时间轴构建：全部段带有效 `start/end`（服务端词级对齐回填，重叠窗口钳到递增）才直接采用，否则等元数据拿到时长后按文本长度比例估算。无音频的演出回退逐段静音展示（每字 180ms，下限 1.2s 上限 8s，情绪变化时延迟 600ms 过渡）。队列耗尽时复位表情/口型并 `returnToIdle()`。`skip()` 递增代数（skipGeneration），等待中的演出在任何 await 之后检测到代数变化即终止链路。v1.5 起 performance 段不再携带 `action`，无动画等待；待机变体切换自 v1.4 起移出队列，`skip()` 亦不复位待机覆盖。
  - **音频链路**：`Audio(dataURL) → createMediaElementSource` 扇出到两支：`lipsyncNode`（分析支路，终端节点）+ `gainNode → destination`（播放支路，音量实际由 gain 控制）。AudioContext 必须解锁：首次 pointerdown/keydown 或点击连接时提前 resume 并预建图（wlipsync 内联 worklet 是 data: URL，Chrome 不支持，需先从 `/audio-processor.js` 加载注册 processor，再 fetch `/profile.bin` 解析 profile 创建节点）。
  - **口型驱动**（rAF 内）：wLipSync 输出音素权重 × 归一化音量，映射 A/I/U/E/O → aa/ih/ou/ee/oh 写入场景层（faceDriver 统一写入面部 morph）；音量同步喂给 bodySway。咝音 S 无对应口型，忽略。
  - **健壮性**：watchdog 监测 `currentTime` 卡死 3s 强制结束演出；`el.src=''` 前先摘 onerror 避免伪 error；`ensureAudioGraph` 合并并发调用防 AbortError；等待元数据超时 3s 兜底。

### 3.4 composables/useVRMScene.ts — 场景层

- **目的**：拥有 three.js 场景的一切（渲染、相机、灯光、资源），并编排各驱动层的每帧写入顺序。
- **功能**：init/loadVrm(ArrayBuffer)/loadBackground(URL)/loadAnimations(已解码字节列表)/setIdle/returnToIdle/setEmotion(emotion,intensity)/setLipWeights/resetLipWeights/setAudioLevel（playAction/waitActionDone 保留导出，暂无调用方）；响应式可调参数（三盏灯强度、呼吸/摆动幅度）均经 `usePersistentRef` 持久化并 watch 同步到 three 对象。
- **实现要点**：
  - 渲染器 ACES tone mapping + sRGB；粉紫半球光 + 主光 + 紫色边缘光（含默认隐藏的光源调试球）。
  - **模型加载**（委托 loadVRM）后依次：`fixEyeRenderOrder`（Koikatu 类模型瞳孔/眼白近平面网格透明排序修复）；提取内嵌表情名（仅 UI 展示，情绪驱动不再依赖）；`face.configure(vrm, gazeTarget)` 绑定表情驱动层（morph 收集、AU 绑定解析、lookAt 接管，注视目标为视线测试球或摄像机）；配置 breath/bodySway；包围盒自动取景半身像；重新绑定动画集。
  - 面部写入顺序见 §1.2：faceDriver 在 vrm.update 之后直写 morph，对 expressionManager 的输出拥有最终覆盖权（VRMA 动画的表情轨道若与 faceDriver 写入的 morph 同名会被覆盖，属预期）。
  - 卸载时 `animator.unbind → deepDispose → face.reset → 生命感层 reset`，完整释放 GPU 资源。

### 3.5 emotion/ — 表情驱动层（v1.5 新增，借用 SoullinkEmotion3D 引擎）

| 模块 | 目的 |
|------|------|
| faceDriver.ts | 粘合层：拥有 FaceEngine；面部 morph 直写（口型合成 + 口型闸门）；头部姿态乘法叠加；视线角度计算；模型绑定/回退判定 |
| engine.ts | FaceEngine（headless，移植自 Soullink）：`triggerEmotion(emotion, intensity)` → VAD 状态机（EmotionStateController：半衰期衰减/保持/逼近）→ DetailedVADMapper（VAD 径向插值出 FACS AU）→ 120Hz 定步长临界阻尼平滑输出 FrameState（AU / 眨眼 / gaze / pose / ARKit blendshapes）；自带 autoBlink（MotionTimeline 波形）与 idle 头部微动 |
| emotions.ts | 24 词情绪目录 `emotionCatalog`（与后端 EMOTION_WORDS 逐词同步）：每词含 VAD 预设 + 作者化 AU 锚点（风格残差） |
| morphProfile.ts | AU → 模型 morph 绑定：`vroidProfile`（ARKit 直接命名 + VRoid Fcl_* 风格化代理），`resolveProfile`（含双侧对称展开），`computeMorphWeights`（组内竞争归一 + 对比度锐化 + 眨眼压制） |
| arkit.ts | FACS AU ↔ ARKit 52 通道映射、`directShapeChannel` 命名匹配 |
| detailed-vad.ts / directions.ts / motion.ts | VAD→AU 映射器、头部/眼睛角度限位、点头/摇头/眨眼波形时间线（引擎内部依赖） |
| ../vendor/soullink/ | soullink-emotion-sdk 原始文件（Apache-2.0），只读不改 |

- **写入策略（morph 直写 + 预设回退）**：模型加载时遍历 morph 字典解析绑定；支持 AU 数 < 4 或元音口型全部未命中 → 回退模式，改写 VRM 预设表情（happy/angry/sad/surprised/relaxed/blink + 预设元音口型），与 Soullink viewer 行为一致。直写模式下每帧先还原上一帧写过但本帧不再写的 morph，再写入本帧权重。
- **口型闸门（沿用旧设计）**：口型 morph 与情绪嘴部 AU 叠加会穿模；按最大元音权重计算闸门 `max(0.3, 1 − maxLip×0.7)`（指数平滑，速率 12），作用于嘴部 AU（`MOUTH_AU_RE`）后再求 morph 权重；口型 morph 与情绪嘴部 morph 同名时取 max。
- **头部姿态叠加**：情绪头部角度（含 idle 微动）以 `bone.quaternion = mixer输出 × (faceBasis·R·faceBasis⁻¹)` 乘法偏移叠加，与 VRMA 关键帧正交；每帧 `prepareHead` 先还原上一帧偏移再叠加，无 VRMA 头部轨道时不累积。
- **视线**：`lookAt.autoUpdate=false`，每帧计算「注视目标方向（faceBasis 逆变换到面部局部系）+ 情绪视线偏移」的 yaw/pitch（钳位 eyeLimits 30°/25°）写入 `lookAt.yaw/pitch`；bone applier 的 rangeMap 归一为恒等（请求 15° 即真实 15°）。

### 3.6 animation/AnimationController.ts — 四层动画系统

- **目的**：多层 mixer 覆盖结构：Base 常驻待机循环（可切换变体），Gesture 上半身遮罩叠加，Action 全身一次性覆盖。
- **层级与优先级**（帧内从低到高 update，后更新者覆写共享骨骼）：

| 层 | 职责 | 关键机制 |
|----|------|----------|
| Base | 全身基础层 | 常驻循环播放当前待机动画；`set_idle` 消息切换变体（sticky，交叉淡化 0.25s）；解析顺序：覆盖 → layer=idle 声明 → 命名约定 'idle' → 首个动画 |
| Additive | 数学叠加的程序化动态 | 只提供 `registerAdditive(fn)` 逐帧钩子通道，具体实现（Offset 节点法）由场景层注入，永远在线 |
| Gesture | 上半身遮罩手势（躯干上部/颈/头/肩/臂/手/指 + 表情） | 遮罩裁剪 clip；Action 期间静音忽略；占用时长保证释放——clip 播完释放，单帧姿势 clip 给 1.5s 可见保持。v1.5 起无触发路径，仅注册保留 |
| Action | 全身覆盖的一次性动作 | 触发瞬间 `setMuted(true)` 冻结 Base/Gesture 时间推进（timeScale=0，防下肢滑行），播完自动解除；watchdog 兜底 'finished' 事件丢失。v1.5 起无触发路径，仅注册保留 |

- **粘滞问题的构造性复位（r4/r6）**：Gesture 层独占属性（手指骨骼/表情轨道）在释放后无低层覆写，若 mixer 还原语义失效会永久定格在手势姿势。对策：播放前对将被动驱动的骨骼/表情拍快照，释放淡出完成后写回。**r6 修正：写回只作用于 Base 未驱动的独占属性**。
- **平台期骨骼的 Base 强制写入（r7）**：上层占用/释放期间每帧对 Base 无差别 `refreshOriginalStates()`，打断自反馈。
- 动画集管理：`setAnimations(map, layers, defaultIdle)` 整体替换，defaultIdle 取自注册表 layer=idle 声明（缺省命名约定 'idle'），失效的 idle 覆盖自动丢弃。

### 3.7 animation/MixerLayer.ts — 单动画层

- **目的**：一层 = 一个独立 AnimationMixer。多 mixer 按优先级依次 update 即得"后更新者胜"的覆盖效果。
- **实现要点**：
  - mixer 惰性创建；clip 缓存（同一 VRMA 经 buildClip 构建，Gesture 层构建的是遮罩版）。
  - `play` 同动作重复触发保持连续不跳帧；旧动作 fadeOut 后延迟 stop（+60ms）。**每个淡出动作持有自己独立的 stop 定时器（Map：action → timer）**。
  - `refreshOriginalStates(sharedKeys)` 平滑技巧：上层每帧 update 前，对低层也在驱动的属性刷新混合基准为低层实时姿势；上层独占属性绝不刷新。属性跨 mixer 标识用 `rootUuid|trackName`，访问的是非公开 `_bindings`（防御式）。
  - 刷新窗口覆盖释放淡出期（`hasActive || isReleasing`，r5 修复）。
  - 释放淡出时长刻意取长（Action 0.6s / Gesture 0.35s，淡入维持 0.2s/0.15s）：末帧常与待机相差 60~120°，长淡出把回位角速度压到视觉可接受范围。

### 3.8 animation/avatarMask.ts — 遮罩

- **目的**：Unity 式层遮罩：VRMA 骨骼轨道天然以人形骨骼名为键，遮罩即构建 clip 时按骨骼集合裁剪轨道。
- **实现**：`GESTURE_BONES` = 躯干上部 + 颈/头 + 双肩/双臂/双手/全部手指；`createMaskedVRMAnimationClip` 支持取舍 hips 平移/表情/视线轨道。空轨道返回 null 让调用方跳过。

### 3.9 生命感动画（composables/）

| 模块 | 目的 | 核心实现 |
|------|------|----------|
| useBreath | 程序化呼吸 | **Offset 节点隔离法**：在 chest 父级插入 identity 节点，世界矩阵 = 父×子 与关键帧自然相乘叠加；单向半波呼吸曲线；肩部上抬 + 头部反向旋转补偿 |
| useBodySway | 说话摆动 | 同 Offset 法（spine 回退 chest + head）；audioLevel 经非对称包络跟随得 intensity；身体/头部各自多频正弦合成 |

（v1.5 起 useEmotion/useBlink 删除：情绪过渡与眨眼由 faceDriver/FaceEngine 接管。）

Offset 节点法与 faceDriver 的头部乘法偏移同源：不改写被动画控制的骨骼变换，只在变换之上做正交叠加。

### 3.10 资源加载器

- **loadVRM.ts**：`loadVRM(buffer)` 解析 GLB 字节 → GLTFLoader + VRMLoaderPlugin 解析 → 优化 → VRM 0.x 朝向修正。纯函数无场景依赖；字节来源不限（HTTP 下载或 base64 解码）。
- **loadVRMA.ts**：`loadVRMA(buffer)` 同上；前置校验 GLB magic（'glTF'）；解析出与模型无关的 VRMAnimation 列表。

### 3.11 UI 组件（components/）

| 组件 | 职责 |
|------|------|
| StageCanvas.vue | canvas 容器 + 加载提示胶囊（expose canvas 元素供场景初始化） |
| SubtitleBar.vue | 字幕栏：当前文本 + 情绪标签，Transition 淡入淡出 |
| StatusBar.vue | 连接状态指示灯（绿/黄闪/红）+ 错误摘要 |
| ControlPanel.vue | 右侧抽屉面板：服务器主机、WS 端口、文件下载端口、连接/断开、音量/静音、跳过表演、三盏灯强度、呼吸与摆动幅度滑块；全部 v-model 透传给页面的持久化 ref |

### 3.12 基础设施

- **usePersistentRef.ts**：localStorage 持久化 ref，读写自动同步，可自定义序列化。
- **fileCache.ts**：大文件下载缓存（v1.6）：`fetchBinaryWithCache(url)` 用 Cache Storage 持久缓存 + 手动条件请求（If-None-Match / If-Modified-Since）再验证——超大文件（如 150MB VRM）常被浏览器 HTTP 缓存拒绝/逐出而享受不到 304，此路径保证「服务端未变 → 304 + 本地字节」；配额写入失败或再验证异常时回退旧缓存/普通 fetch。
- **lib/utils.ts**：cn（clsx+tailwind-merge）、formatToMime、base64ToUint8Array。
- **types/lipsync.ts**：五元音权重类型（VowelPreset / LipSyncWeights），表演层产出、faceDriver 消费的契约。
- **public/**：`audio-processor.js`（wLipSync AudioWorklet processor）、`profile.bin`（wLipSync 预计算二进制 profile）。

### 3.13 server_reference/ — 服务端参考实现（非本仓库构建产物）

AstrBot 插件的文件，定义了客户端必须对齐的协议语义（v1.7 契约）：

- **wire_types.py**：FilePayload（`filename` + `url`/`data` 二选一：大文件 url 引用，TTS 音频 base64 内嵌）。
- **performance.py**：`Performance`（text / emotion / intensity 固定默认 / `start`/`end` 时间窗，由词级对齐步骤回填）与 `parse_tagged_text`——抽取 LLM 不再输出句子数组，而是**在原始回复文本中内联插入 `[emotion]` 标签**，本模块把标签文本解析回表演段列表：每个标签作用于其后至下一标签的文本，首标签前的文本默认 `neutral`；方括号 token 按词表大小写不敏感校验，非词表 token（如残留的动作描述）保留为字面文本；容忍 Markdown 代码围栏；无可表演文本时返回 None（上游把全文当一句台词降级）。idle 变体不属于列表，由 `set_idle` 工具带外下发。
- **messages.py**：消息构建器。`build_performance_message` 把**整段回复合成一条共享 TTS 片段**（各段文本带 `[emotion]` 前缀拼接一次送入 TTS，前缀同时驱动情感韵律），再经 forced-alignment 服务对齐标签剥离后的纯文本，把词级时间匹配回各段填充 `start`/`end`；音频作为列表的兄弟字段挂在消息上（`audio: FilePayload | None`），**绝不逐段拆分**。VRM/背景/VRMA 不再读文件编码 base64，改为 `_file_url` 生成插件数据目录的 `/files/<relpath>` 相对 URL（路径穿越校验保留），由插件自身的 HTTP 文件下载服务供客户端 fetch + 浏览器缓存；AnimationEntry 的 `layer`（idle/gesture/action，缺省 action）保留（gesture/action 条目暂无触发方，为未来预留）；`SetIdleMessage` 为 `set_idle` LLM 工具的带外下发通道。

---

## 4. 关键设计决策速查

1. **共享音频 + 段时间窗结构（v1.7，取代逐段音频）**：一次回复合成一条 TTS 音频（情绪以 `[emotion]` 前缀内联驱动韵律），表演段只携带文本 + 情绪 + `start/end` 时间窗；客户端音频只播一次，按时间窗切换情绪/字幕，段间无需重开销播。时间窗缺失时按文本长度比例回退估算，能力降级但不断链。待机切换为独立 `set_idle` 消息。
2. **固定 24 词情绪词表取代模型表情名（v1.5）**：协议与模型解耦——同一份 LLM 提示词/后端配置可驱动任意 VRM；情绪表现力由前端引擎（VAD 状态机 + FACS AU + morph 绑定）保证，`intensity` 直接进入引擎的 triggerEmotion 强度参数。模型不适配时回退 VRM 预设表情，能力降级但不断链。
3. **表情引擎 headless 移植**：FaceEngine 不含渲染/网络依赖，`triggerEmotion(emotion, intensity)` 输入、FrameState 输出；面部应用（morph 直写/回退）、头部姿态叠加、视线融合全部收敛在 faceDriver，场景层只编排调用顺序。
4. **多 mixer 层覆盖**：用多个 AnimationMixer 的更新顺序模拟 Unity 层覆盖与遮罩（r4~r7 的原始状态管理技巧保留）。
5. **Offset 节点 / 乘法偏移叠加**：程序化动画（呼吸/摆动/情绪头部姿态）不与关键帧争抢骨骼，插节点或后乘四元数，数学上保证正交叠加。
6. **浏览器约束防御**：AudioContext 手势解锁、data: URL worklet 兼容、currentTime watchdog、GLB magic 校验、fetch data: 解码 base64、透明排序修复。
7. **所有 UI 参数持久化**：localStorage 键统一 `vrm.*` 前缀。

## 5. 明确不在本文档范围

- AstrBot 插件与 TTS 服务端的完整实现（仅协议参考）；
- 各组件的具体样式细节；
- 调试用代码细节（光源辅助球、GAZE_TEST 视线测试球，默认关闭）；
- Soullink 引擎内部数学细节（VAD/AU 求解算法见 vendor 源码与上游仓库）。

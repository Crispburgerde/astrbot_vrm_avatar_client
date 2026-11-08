// 后端 WebSocket 协议消息类型定义
// 与 server_reference/messages.py 的输出结构一一对应

/** 后端推送的顶层消息（客户端接收） */
export type ServerMessage =
  | UpdateCharacterMessage
  | UpdateBackgroundMessage
  | UpdateAnimationsMessage
  | SetIdleMessage
  | PerformanceMessage;

/**
 * 通用文件负载：大文件（VRM/背景/VRMA）用 url 引用（由文件下载服务经 HTTP 提供，
 * 浏览器可原生缓存，刷新页面不重推 WS），小负载（TTS 音频）仍内嵌 base64。
 * url / data 恰好设置其一（与 server_reference/wire_types.py 对齐）
 */
export interface FilePayload {
  filename: string;
  /** 文件下载服务上的相对路径（如 /files/xxx.vrm） */
  url?: string;
  /** base64 编码的文件字节 */
  data?: string;
}

/** VRM 模型更新（连接时或配置变更后推送） */
export interface UpdateCharacterMessage {
  type: 'update_character';
  vrm: FilePayload;
}

/** 背景图更新（连接时或配置变更后推送） */
export interface UpdateBackgroundMessage {
  type: 'update_background';
  background: FilePayload;
}

/** 动画类别：决定客户端将其路由到哪个动画层 */
export type AnimationLayer = 'idle' | 'gesture' | 'action';

/** 单个命名动画条目（与 server_reference/messages.py 的 AnimationEntry 对应） */
export interface AnimationEntry {
  /** 动画名（layer=idle 为默认待机，由 set_idle 消息切换） */
  name: string;
  /**
   * 动画类别：加载时保存。
   * - 'idle'：Base 层待机变体（set_idle 消息切换）
   * - 'gesture' / 'action'（缺省）：一次性动画注册；performance 的 action
   *   字段已移除，暂无触发路径，保留供未来使用
   */
  layer?: AnimationLayer;
  file: FilePayload;
}

/** 动画更新（连接时或配置变更后推送，可携带多个命名动画） */
export interface UpdateAnimationsMessage {
  type: 'update_animations';
  animations: AnimationEntry[];
}

/**
 * 待机变体切换（v1.4）：不属于 performance 数组的带外消息，
 * 由服务端 set_idle LLM 工具下发；客户端即时生效，不进表演层队列
 */
export interface SetIdleMessage {
  type: 'set_idle';
  name: string;
}

/** 表演消息：一次 LLM 回复解析出的有序表演段数组 */
export interface PerformanceMessage {
  type: 'performance';
  performances: Performance[];
}

/**
 * 单个表演段（与 server_reference/performance.py 的 Performance 对应）：
 * 一句台词 + 说这句台词时的情绪及其强度。
 * - emotion 属固定 24 词情绪词表（与前端表情引擎 emotionCatalog 同步），
 *   词表外的值在服务端已降级为 neutral；仅在本段台词播放期间生效，段末复位
 * - intensity 为情绪强度 0~1，缺省 0.85
 * - text 恒非空（服务端跳过空台词段）；audio 由 TTS 步骤填充（可能缺省）
 */
export interface Performance {
  /** 台词 */
  text: string;
  /** 本段台词期间的情绪（24 词表内） */
  emotion?: string;
  /** 情绪强度 0~1（缺省 0.85） */
  intensity?: number;
  /** 台词对应的 TTS 音频（base64） */
  audio?: FilePayload;
}

// ---- 消息类型守卫 ----
export function isUpdateCharacter(m: unknown): m is UpdateCharacterMessage {
  return (m as { type?: string })?.type === 'update_character';
}
export function isUpdateBackground(m: unknown): m is UpdateBackgroundMessage {
  return (m as { type?: string })?.type === 'update_background';
}
export function isUpdateAnimations(m: unknown): m is UpdateAnimationsMessage {
  return (m as { type?: string })?.type === 'update_animations';
}
export function isSetIdle(m: unknown): m is SetIdleMessage {
  return (m as { type?: string })?.type === 'set_idle';
}
export function isPerformance(m: unknown): m is PerformanceMessage {
  return (m as { type?: string })?.type === 'performance';
}

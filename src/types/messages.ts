// 后端 WebSocket 协议消息类型定义
// 与 python/messages.py 的输出结构一一对应

/** 后端推送的顶层消息（客户端接收） */
export type ServerMessage =
  | UpdateCharacterMessage
  | UpdateBackgroundMessage
  | UpdateAnimationsMessage
  | PerformanceMessage;

/** 通用文件负载：base64 编码的字节数据 */
export interface FilePayload {
  filename: string;
  /** base64 编码的文件字节 */
  data: string;
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

/** 单个命名动画条目（与 server_reference/messages.py 的 AnimationEntry 对应） */
export interface AnimationEntry {
  /** 动画名（idle 为待机动画，其余可由 performance 段的 action 引用） */
  name: string;
  file: FilePayload;
}

/** 动画更新（连接时或配置变更后推送，可携带多个命名动画） */
export interface UpdateAnimationsMessage {
  type: 'update_animations';
  animations: AnimationEntry[];
}

/** 表演消息：一次 LLM 回复解析后的事件流容器 */
export interface PerformanceMessage {
  type: 'performance';
  performance: Performance;
}

/** 事件流容器（与 server_reference/performance.py 的 Performance 对应） */
export interface Performance {
  events: PerformanceEvent[];
}

/**
 * 表演事件：按源文本中出现顺序排列；
 * 消费方需自行维护 sticky 状态（如当前表情）。
 */
export type PerformanceEvent =
  | TextChunkEvent
  | ExpressionTagEvent
  | ActionTagEvent;

/** 对话文本段；audio 由 TTS 步骤填充（可能缺省） */
export interface TextChunkEvent {
  kind: 'text';
  content: string;
  audio?: FilePayload;
}

/** sticky 表情标签：设置当前表情，持续到下一个表情标签 */
export interface ExpressionTagEvent {
  kind: 'expression';
  name: string;
}

/** 动作标签：按名引用一个已注册的动画，播放一次后回归待机（一次性动作）。 */
export interface ActionTagEvent {
  kind: 'action';
  name: string;
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
export function isPerformance(m: unknown): m is PerformanceMessage {
  return (m as { type?: string })?.type === 'performance';
}

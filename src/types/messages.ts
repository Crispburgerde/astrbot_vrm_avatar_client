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

/** 单个命名动画条目 */
export interface AnimationEntry {
  /** 动画名（idle 为待机动画，其余可由 performance 段的 action 引用） */
  name: string;
  file: FilePayload;
  loop: boolean;
}

/** 动画更新（连接时或配置变更后推送，可携带多个命名动画） */
export interface UpdateAnimationsMessage {
  type: 'update_animations';
  animations: AnimationEntry[];
}

/** 表演数据：按顺序播放的对话段 */
export interface PerformanceMessage {
  type: 'performance';
  segments: PerformanceSegment[];
}

export interface PerformanceSegment {
  /** 对话文本（同时作为字幕） */
  dialogue: string;
  /** 表情名（happy/angry/sad/relaxed/surprised/neutral 等可配置值） */
  expression: string;
  /** 动作动画别名（对应 update_animations 推送的动画 name，如 wave/nod）；
   *  缺省时仅保持 idle 循环动画。 */
  action?: string;
  /** TTS 音频（可能缺省），结构与 FilePayload 一致 */
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
export function isPerformance(m: unknown): m is PerformanceMessage {
  return (m as { type?: string })?.type === 'performance';
}

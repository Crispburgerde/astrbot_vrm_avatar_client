import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import type { ServerMessage } from '@/types/messages';
import { usePersistentRef } from '@/composables/usePersistentRef';

/** 连接状态 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export interface UseWebSocketOptions {
  /** 收到合法 ServerMessage 时调用 */
  onMessage: (msg: ServerMessage) => void;
}

const DEFAULT_HOST = 'localhost';
const DEFAULT_WS_PORT = '8765';
const DEFAULT_FILE_PORT = '8766';
const HOST_KEY = 'vrm.avatar.host';
const WS_PORT_KEY = 'vrm.avatar.wsPort';
const FILE_PORT_KEY = 'vrm.avatar.filePort';
/** 旧版单地址键，用于一次性迁移到 host/port */
const LEGACY_URL_KEY = 'vrm.avatar.wsUrl';

/** 字符串原样持久化（不加 JSON 引号） */
function persistentString(key: string, def: string) {
  return usePersistentRef<string>(key, def, {
    serialize: (v) => v,
    deserialize: (raw) => raw,
  });
}

/** 从旧版 wsUrl 迁移出 host / ws 端口 */
function legacyDefaults(): { host: string; wsPort: string } {
  const legacy = localStorage.getItem(LEGACY_URL_KEY);
  if (!legacy) return { host: DEFAULT_HOST, wsPort: DEFAULT_WS_PORT };
  try {
    const u = new URL(legacy);
    return {
      host: u.hostname || DEFAULT_HOST,
      wsPort: u.port || DEFAULT_WS_PORT,
    };
  } catch {
    return { host: DEFAULT_HOST, wsPort: DEFAULT_WS_PORT };
  }
}

/**
 * WebSocket 通信层：连接 / 自动重连 / JSON 消息分发。
 * 后端协议见 SPEC.md §2 与 server_reference/ 参考实现。
 */
export function useWebSocket(options: UseWebSocketOptions) {
  const status = ref<ConnectionStatus>('disconnected');
  // 首次使用时从旧版单地址键迁移
  const legacy = legacyDefaults();
  const host = persistentString(HOST_KEY, legacy.host);
  const wsPort = persistentString(WS_PORT_KEY, legacy.wsPort);
  // 文件下载服务（HTTP 大文件）端口，当前仅存储，加载链路后续切换
  const filePort = persistentString(FILE_PORT_KEY, DEFAULT_FILE_PORT);
  const url = computed(() => `ws://${host.value.trim()}:${wsPort.value.trim()}`);
  const error = ref<string>('');

  // ws 实例与重连控制不放进响应式系统，避免无谓的代理
  const ws = shallowRef<WebSocket | null>(null);
  let reconnectTimer: number | null = null;
  let manualClose = false;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 8000;

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (manualClose) return;
    clearReconnect();
    reconnectAttempts += 1;
    // 指数退避，上限 8s
    const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
    reconnectTimer = window.setTimeout(() => connect(), delay);
  }

  function connect(): void {
    if (status.value === 'connecting' || status.value === 'connected') return;

    manualClose = false;
    status.value = 'connecting';
    error.value = '';

    let socket: WebSocket;
    try {
      socket = new WebSocket(url.value);
    } catch (e) {
      status.value = 'disconnected';
      error.value = e instanceof Error ? e.message : String(e);
      scheduleReconnect();
      return;
    }
    ws.value = socket;

    socket.onopen = () => {
      reconnectAttempts = 0;
      status.value = 'connected';
      error.value = '';
    };

    socket.onmessage = (ev: MessageEvent) => {
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data as string);
      } catch {
        return; // 非 JSON 直接忽略
      }
      if (payload && typeof payload === 'object' && 'type' in payload) {
        options.onMessage(payload as ServerMessage);
      }
    };

    socket.onerror = () => {
      // 错误细节会在 onclose 里触发重连，这里只记录
      error.value = 'WebSocket 连接发生错误';
    };

    socket.onclose = () => {
      status.value = 'disconnected';
      ws.value = null;
      if (!manualClose) scheduleReconnect();
    };
  }

  function disconnect(): void {
    manualClose = true;
    clearReconnect();
    reconnectAttempts = 0;
    const socket = ws.value;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
    ws.value = null;
    status.value = 'disconnected';
  }

  function setHost(value: string): void {
    host.value = value.trim();
  }

  function setWsPort(value: string): void {
    wsPort.value = value.trim();
  }

  function setFilePort(value: string): void {
    filePort.value = value.trim();
  }

  /**
   * 将服务端 FilePayload.url 的相对路径（如 /files/xxx.vrm）拼成
   * 文件下载服务的绝对 URL：http://{host}:{filePort}{path}
   */
  function resolveFileUrl(path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    return `http://${host.value.trim()}:${filePort.value.trim()}${p}`;
  }

  // 作用域销毁（组件卸载 / Vite HMR 重挂载）时断开连接并停止重连定时器。
  // 否则旧实例的 WebSocket 会成为僵尸连接：它仍接收 broadcast 消息并驱动
  // 已 dispose 的旧表演层，且后端重启后会各自重连 —— 服务端出现多条客户端
  // 连接，一条 performance 广播被播放多份（声音多重播放）。
  onScopeDispose(disconnect);

  return {
    status,
    url,
    host,
    wsPort,
    filePort,
    error,
    connect,
    disconnect,
    setHost,
    setWsPort,
    setFilePort,
    resolveFileUrl,
  };
}

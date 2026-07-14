import { ref, shallowRef } from 'vue';
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

const DEFAULT_URL = 'ws://localhost:8765';
const STORAGE_KEY = 'vrm.avatar.wsUrl';

/**
 * WebSocket 通信层：连接 / 自动重连 / JSON 消息分发。
 * 后端协议见 python/websocket_server.py。
 */
export function useWebSocket(options: UseWebSocketOptions) {
  const status = ref<ConnectionStatus>('disconnected');
  // 字符串原样存储（不加 JSON 引号），兼容历史值
  const url = usePersistentRef<string>(STORAGE_KEY, DEFAULT_URL, {
    serialize: (v) => v,
    deserialize: (raw) => raw,
  });
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

  function setUrl(newUrl: string): void {
    url.value = newUrl.trim();
  }

  return {
    status,
    url,
    error,
    connect,
    disconnect,
    setUrl,
  };
}

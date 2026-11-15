import { ref, watch, type Ref } from 'vue';

/**
 * 持久化 ref：读写时自动同步到 localStorage。
 *
 * @param key 存储键
 * @param defaultValue 默认值（localStorage 无值或反序列化失败时使用）
 * @param options.serialize 序列化函数，默认 JSON.stringify
 * @param options.deserialize 反序列化函数，默认 JSON.parse
 */
export function usePersistentRef<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (v: T) => string;
    deserialize?: (raw: string) => T;
  },
): Ref<T> {
  const serialize = options?.serialize ?? ((v: T) => JSON.stringify(v));
  const deserialize =
    options?.deserialize ?? ((raw: string) => JSON.parse(raw) as T);

  // 嵌入态（AstrBot WebView 等）下 localStorage 可能被禁用或抛错：
  // 读写均容错，失败时仅失去跨会话持久化，会话内仍以 ref 值为准
  function read(): T {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return defaultValue;
    }
    if (raw === null) return defaultValue;
    try {
      return deserialize(raw);
    } catch {
      return defaultValue;
    }
  }

  const state = ref(read()) as Ref<T>;
  watch(state, (v) => {
    try {
      localStorage.setItem(key, serialize(v));
    } catch {
      // 写入失败（嵌入态等）：忽略，不影响会话内使用
    }
  });

  return state;
}

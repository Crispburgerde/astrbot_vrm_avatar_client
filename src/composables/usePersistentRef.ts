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

  function read(): T {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    try {
      return deserialize(raw);
    } catch {
      return defaultValue;
    }
  }

  const state = ref(read()) as Ref<T>;
  watch(state, (v) => {
    localStorage.setItem(key, serialize(v));
  });

  return state;
}

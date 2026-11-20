import { nextTick, ref, watch, type Ref } from 'vue';

/**
 * 设置持久化：按「键类别 × 部署模式」选择存储。
 *
 * - 连接参数（host / wsPort / filePort）：
 *   - 嵌入 AstrBot WebUI（存在 AstrBotPluginView 桥）：host 取页面自身
 *     hostname，端口经插件 API 桥读取后端配置（见 bootstrapClientSettings），
 *     仅存内存——每次打开都由后端告知，天然与插件配置一致；
 *   - 独立部署：localStorage 持久化（默认值冷启动，改一次记住一次）。
 * - 舞台参数（其余 `vrm.*` 键：音量/灯光/幅度等）：一律存插件后端的
 *   `client_settings.json`（经 HTTP 文件服务 `/client-settings` 读写）——
 *   沙箱 iframe 的 opaque origin 禁用 localStorage，服务端存储让两种模式
 *   行为一致，且跨浏览器生效。
 *
 * 舞台设置启动时拉取一次（失败退避重试）；ref 写入防抖 500ms 整体 POST
 * 回后端；成功拉取并合并服务端设置前不写回（防默认值整库覆盖服务端
 * 数据），已被本地修改的键不被拉取结果覆盖。
 */

/** 连接参数存储键与默认值（默认 host 取页面自身 hostname） */
export const HOST_KEY = 'vrm.avatar.host';
export const WS_PORT_KEY = 'vrm.avatar.wsPort';
export const FILE_PORT_KEY = 'vrm.avatar.filePort';
export const DEFAULT_HOST = window.location.hostname || 'localhost';
export const DEFAULT_WS_PORT = '8765';
export const DEFAULT_FILE_PORT = '8766';

/** AstrBot 插件页桥（嵌入态由 dashboard 注入，见 plugin_page_bridge.js） */
interface PluginViewBridge {
  apiGet(endpoint: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** 嵌入态判定：与 router/index.ts 一致，桥全局存在即嵌入 */
const embedded =
  typeof (window as { AstrBotPluginView?: unknown }).AstrBotPluginView !==
  'undefined';

const CONNECTION_KEYS = new Set([HOST_KEY, WS_PORT_KEY, FILE_PORT_KEY]);

/** 舞台参数防抖写回间隔 */
const FLUSH_DELAY_MS = 500;
/** 拉取失败后的重试退避上限（页面可能先于后端就绪） */
const MAX_RETRY_DELAY_MS = 8000;

// ---- 连接参数：共享 ref（同键多次调用复用同一实例） ------------------------

const connectionRefs = new Map<string, Ref<unknown>>();

function connectionRef<T>(key: string, defaultValue: T): Ref<T> {
  const existing = connectionRefs.get(key);
  if (existing) return existing as Ref<T>;

  let initial: unknown = defaultValue;
  if (!embedded) {
    // 独立部署：从 localStorage 读初始值（存储不可用或值损坏时用默认值；
    // 兼容旧版本不加 JSON 引号的原样字符串）
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          initial = typeof parsed === 'string' ? parsed : raw;
        } catch {
          initial = raw;
        }
      }
    } catch {
      /* localStorage 抛错（如嵌入残留）：用默认值 */
    }
  }

  const state = ref(initial) as Ref<T>;
  if (!embedded) {
    watch(state, (v) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* 写失败不影响会话内使用 */
      }
    });
  }
  connectionRefs.set(key, state as Ref<unknown>);
  return state;
}

function setConnectionValue(key: string, value: string): void {
  const state = connectionRefs.get(key);
  if (state) (state as Ref<string>).value = value;
}

// ---- 舞台参数：后端 client_settings 存储 -----------------------------------

/** 键值存储（typed JSON 值，仅舞台参数） */
const stageStore = new Map<string, unknown>();
/** 已被本地写入修改的键：hydration 不覆盖 */
const dirtyKeys = new Set<string>();
/** 各键注册的 ref，hydration 时同步回写 */
const refsByKey = new Map<string, Set<Ref<unknown>>>();
/** hydration 应用中标记：此期间触发的 watch 不计脏、不触发写回 */
let applying = false;
/** 首次拉取已落定（成功或失败）：仅用于放行 bootstrap 等待者，设置服务未就绪不阻塞连接 */
let settled = false;
/** 已成功拉取并合并服务端设置：此后才允许写回，防止整库 POST 用默认值冲掉服务端已存值 */
let hydrated = false;
const settleWaiters: Array<() => void> = [];
let hydrationStarted = false;
let flushTimer: number | null = null;
let flushing = false;
let storeChangedDuringFlush = false;

/** 设置服务地址：由当前连接参数拼出（未初始化时用推导默认值） */
function settingsUrl(): string {
  const host =
    String(connectionRefs.get(HOST_KEY)?.value ?? DEFAULT_HOST).trim() ||
    DEFAULT_HOST;
  const filePort =
    String(connectionRefs.get(FILE_PORT_KEY)?.value ?? DEFAULT_FILE_PORT).trim() ||
    DEFAULT_FILE_PORT;
  return `http://${host}:${filePort}/client-settings`;
}

/** 标记首次拉取落定，唤醒所有等待者 */
function settle(): void {
  if (settled) return;
  settled = true;
  const waiters = settleWaiters.splice(0);
  waiters.forEach((resolve) => resolve());
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  // 成功拉取前不写回：整库 POST 会把「默认值 + 局部修改」覆盖到服务端
  if (!hydrated) return;
  if (flushing) {
    storeChangedDuringFlush = true;
    return;
  }
  flushing = true;
  try {
    await fetch(settingsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(stageStore)),
    });
  } catch {
    // 后端暂不可达：值保留在内存中，下次变更时再写
    console.warn('[Settings] 写回后端失败，将在下次变更时重试');
  } finally {
    flushing = false;
    if (storeChangedDuringFlush) {
      storeChangedDuringFlush = false;
      scheduleFlush();
    }
  }
}

/** 把拉取到的键值同步进 store 与已注册的 ref（跳过本地已修改的键） */
async function applyBlob(blob: Record<string, unknown>): Promise<void> {
  applying = true;
  try {
    for (const [key, value] of Object.entries(blob)) {
      // 连接参数不属于舞台存储；旧版本 blob 可能残留，直接忽略
      if (CONNECTION_KEYS.has(key)) continue;
      if (dirtyKeys.has(key)) continue;
      stageStore.set(key, value);
      for (const r of refsByKey.get(key) ?? []) {
        (r as Ref<unknown>).value = value;
      }
    }
    // watch 回调是异步批处理的：标记必须保持到本轮触发的回调跑完
    // （回调里检查 applying 跳过计脏）之后才能复位，否则守卫形同虚设
    await nextTick();
  } finally {
    applying = false;
  }
}

/** 拉取一次舞台设置并应用；网络错误或非 2xx 时抛出 */
async function fetchOnce(): Promise<void> {
  const resp = await fetch(settingsUrl());
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = (await resp.json()) as unknown;
  if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
    await applyBlob(blob as Record<string, unknown>);
  }
  // 服务端基线已合并进内存，此后整库写回是安全的
  hydrated = true;
}

/** 后台退避重试，直至拉取成功（页面可能先于后端就绪） */
async function retryLoop(): Promise<void> {
  let attempt = 0;
  for (;;) {
    const delay = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
    await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      await fetchOnce();
      scheduleFlush();
      return;
    } catch {
      attempt += 1;
    }
  }
}

async function runHydration(): Promise<void> {
  try {
    await fetchOnce();
  } catch (e) {
    console.warn(`[Settings] 拉取失败（${String(e)}），将在后台重试`);
    void retryLoop();
    return;
  } finally {
    settle();
  }
  // 成功后补一次写回，覆盖「拉取期间已有本地修改」的窗口
  scheduleFlush();
}

/**
 * 拉取舞台设置（幂等）。返回的 Promise 在**首次**拉取落定（成功或失败）
 * 时 resolve——连接流程不被设置服务阻塞；写回门槛见 hydrated 标记。
 */
function hydrateStageSettings(): Promise<void> {
  if (!hydrationStarted) {
    hydrationStarted = true;
    void runHydration();
  }
  if (settled) return Promise.resolve();
  return new Promise<void>((resolve) => settleWaiters.push(resolve));
}

// ---- 引导入口 --------------------------------------------------------------

/** 把任意输入规范成合法端口字符串，非法则回退默认值 */
function normalizePort(value: unknown, fallback: string): string {
  const s =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  return /^\d+$/.test(s) ? s : fallback;
}

/**
 * 连接引导 + 舞台设置拉取（幂等）。
 *
 * 嵌入态先经 AstrBot 插件 API 桥读取后端配置的 WS / HTTP 端口（host 已
 * 由页面 hostname 推导），独立态连接参数已在 ref 初始化时从 localStorage
 * 读出；随后拉取舞台设置。Promise 在首次舞台设置拉取落定（成功或失败）
 * 时 resolve，调用方据此建立连接。
 */
export async function bootstrapClientSettings(): Promise<void> {
  if (embedded) {
    try {
      const bridge = (window as { AstrBotPluginView?: PluginViewBridge })
        .AstrBotPluginView;
      const info = (await bridge.apiGet('client_info')) as
        | { ws_port?: unknown; http_port?: unknown }
        | null
        | undefined;
      setConnectionValue(
        WS_PORT_KEY,
        normalizePort(info?.ws_port, DEFAULT_WS_PORT),
      );
      setConnectionValue(
        FILE_PORT_KEY,
        normalizePort(info?.http_port, DEFAULT_FILE_PORT),
      );
    } catch {
      // 桥不可用（如后端未注册该端点）：保持默认端口
      console.warn('[Settings] 经插件桥读取端口失败，使用默认端口');
    }
  }
  await hydrateStageSettings();
}

/**
 * 持久化 ref：连接参数按模式分流（嵌入=内存、独立=localStorage），舞台
 * 参数防抖写回后端 client_settings、启动拉取到的值同步进 ref（未被本地
 * 修改过的键）。
 *
 * @param key 存储键（`vrm.*`）
 * @param defaultValue 默认值（存储无值或尚未拉取到时使用）
 */
export function usePersistentRef<T>(key: string, defaultValue: T): Ref<T> {
  if (CONNECTION_KEYS.has(key)) {
    return connectionRef(key, defaultValue);
  }

  if (!stageStore.has(key)) stageStore.set(key, defaultValue);

  const state = ref(stageStore.get(key)) as Ref<T>;
  let registered = refsByKey.get(key);
  if (!registered) {
    registered = new Set();
    refsByKey.set(key, registered);
  }
  registered.add(state as Ref<unknown>);

  watch(state, (v) => {
    stageStore.set(key, v);
    if (applying) return; // hydration 回写不计脏、不触发写回
    dirtyKeys.add(key);
    // 成功拉取前不写回（settled 只放行连接流程，见其声明处注释）
    if (hydrated) scheduleFlush();
  });

  return state;
}

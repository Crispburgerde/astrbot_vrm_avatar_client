/**
 * 大文件下载 + 持久缓存（带条件请求再验证）。
 *
 * 为什么不用浏览器 HTTP 缓存：超大文件（如 150MB 的 VRM）往往不会被写入
 * HTTP 缓存或很快被逐出，导致下次请求不带 If-None-Match 校验器，
 * 服务端只能 200 全量重传（小文件则可享受 304）。
 *
 * 缓存后端（v1.6.1 双保险）：
 * - Cache Storage（安全上下文，如 localhost / https）；
 * - IndexedDB 回退（http://IP 访问等非安全上下文没有 caches，但有 IDB），
 *   存 ArrayBuffer + 校验器，同样跨刷新持久。
 *
 * 再验证：带 ETag / Last-Modified 发条件请求，304 → 用本地字节，200 → 更新缓存。
 * 注意跨域下 ETag 需要 `Access-Control-Expose-Headers: ETag` 才能读到
 * （Last-Modified 属 CORS 安全列表头，默认可读）。
 */

const CACHE_NAME = 'vrm.assets.v1';
const DB_NAME = 'vrm-file-cache';
const DB_STORE = 'files';

interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  buffer: ArrayBuffer;
}

/** 诊断日志统一前缀，便于在控制台过滤 [FileCache] */
function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[FileCache]', ...args);
}
function warn(...args: unknown[]): void {
  console.warn('[FileCache]', ...args);
}

async function plainFetchBinary(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`文件下载失败 HTTP ${resp.status}: ${url}`);
  return resp.arrayBuffer();
}

// ---- IndexedDB 后端（非安全上下文回退） ------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(url: string): Promise<CacheEntry | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(url);
      req.onsuccess = () => resolve((req.result as CacheEntry) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    warn('IndexedDB 读取失败:', e);
    return null;
  }
}

async function idbPut(url: string, entry: CacheEntry): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put({ url, ...entry });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn('IndexedDB 写入失败:', e); // 不阻断加载
  }
}

// ---- 统一缓存接口 ----------------------------------------------------------

const hasCaches = typeof caches !== 'undefined';

async function cacheRead(url: string): Promise<CacheEntry | null> {
  if (hasCaches) {
    try {
      const cached = await (await caches.open(CACHE_NAME)).match(url);
      if (!cached) return null;
      return {
        etag: cached.headers.get('etag'),
        lastModified: cached.headers.get('last-modified'),
        buffer: await cached.arrayBuffer(),
      };
    } catch (e) {
      warn('Cache Storage 读取失败:', e);
      return null;
    }
  }
  return idbGet(url);
}

async function cacheWrite(
  url: string,
  resp: Response,
  buffer: ArrayBuffer,
): Promise<void> {
  if (hasCaches) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(url, new Response(buffer, { headers: resp.headers }));
      return;
    } catch (e) {
      warn('Cache Storage 写入失败（配额？）:', e);
    }
  }
  await idbPut(url, {
    etag: resp.headers.get('etag'),
    lastModified: resp.headers.get('last-modified'),
    buffer,
  });
}

// ---- 主入口 ----------------------------------------------------------------

/**
 * 下载二进制文件，优先命中持久缓存：
 * 1. 缓存无条目 → 普通 GET，200 后写回缓存；
 * 2. 缓存有条目 → 带其 ETag / Last-Modified 发条件请求：
 *    304 → 直接使用缓存字节（零重传）；200 → 更新缓存。
 * 缓存后端均不可用时退化为普通 fetch。
 */
export async function fetchBinaryWithCache(url: string): Promise<ArrayBuffer> {
  if (!hasCaches && typeof indexedDB === 'undefined') {
    warn('无可用缓存后端（caches / indexedDB 均缺失），普通下载');
    return plainFetchBinary(url);
  }

  const cached = await cacheRead(url);
  log(
    `后端=${hasCaches ? 'CacheStorage' : 'IndexedDB'} 缓存条目=${cached ? '有' : '无'}`,
    `etag=${cached?.etag ?? '-'} lastModified=${cached?.lastModified ?? '-'}`,
  );

  // 用缓存条目的校验器发条件请求
  const headers: Record<string, string> = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  if (cached && !cached.etag && !cached.lastModified) {
    // 服务端未返回（或跨域未暴露）校验器：无法再验证，直接使用本地缓存，
    // 避免每次刷新全量重下载。代价是后端文件更新后需手动清除缓存。
    warn('缓存条目不含校验器，直接使用本地缓存（后端文件更新后请清除缓存）');
    return cached.buffer;
  }

  const started = performance.now();
  const resp = await fetch(url, { headers });

  if (resp.status === 304 && cached) {
    log(`304 命中缓存: ${url} ${Math.round(performance.now() - started)}ms`);
    return cached.buffer;
  }

  if (!resp.ok) {
    // 校验器失效等异常场景下回退：缓存仍可用就不至于断链
    if (cached) {
      warn(`再验证失败 HTTP ${resp.status}，使用旧缓存: ${url}`);
      return cached.buffer;
    }
    throw new Error(`文件下载失败 HTTP ${resp.status}: ${url}`);
  }

  const buffer = await resp.arrayBuffer();
  log(
    `200 下载完成: ${url} (${buffer.byteLength} bytes, ` +
      `${Math.round(performance.now() - started)}ms)，写缓存`,
  );
  await cacheWrite(url, resp, buffer);
  return buffer;
}

/** 清空全部文件缓存（Cache Storage + IndexedDB），供后端文件更新后手动刷新 */
export async function clearFileCache(): Promise<void> {
  if (hasCaches) {
    try {
      await caches.delete(CACHE_NAME);
    } catch (e) {
      warn('清除 Cache Storage 失败:', e);
    }
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    warn('清除 IndexedDB 失败:', e);
  }
  log('文件缓存已清空');
}

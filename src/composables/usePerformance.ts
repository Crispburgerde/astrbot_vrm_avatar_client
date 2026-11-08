import { onBeforeUnmount, ref } from 'vue';
import {
  createWLipSyncNode,
  parseBinaryProfile,
  type WLipSyncAudioNode,
} from 'wlipsync';
import type {
  Performance,
  PerformanceMessage,
} from '@/types/messages';
import type { LipSyncWeights, VowelPreset } from '@/types/lipsync';

/**
 * wLipSync 依赖的静态资源路径（位于 public/）。
 * - AUDIO_WORKLET_URL：AudioWorklet 处理器脚本
 * - LIPSYNC_PROFILE_URL：wLipSync 预计算 profile（二进制）
 */
const AUDIO_WORKLET_URL = '/audio-processor.js';
const LIPSYNC_PROFILE_URL = '/profile.bin';

export interface PerformanceSceneApi {
  /** 触发情绪表情（24 词表 + 强度 0~1） */
  setEmotion: (emotion: string, intensity?: number) => void;
  /** 设置五元音口型权重（0~1），由 wLipSync 驱动 */
  setLipWeights: (weights: Partial<LipSyncWeights>) => void;
  /** 复位所有口型权重为 0 */
  resetLipWeights: () => void;
  /** 设置当前说话音量（0~1），驱动身体/头部摆动幅度 */
  setAudioLevel: (level: number) => void;
  /** 释放覆盖层回归待机：让进行中的 Action/Gesture 动画停下来 */
  returnToIdle: () => void;
}

export interface UsePerformanceOptions {
  /** VRM 场景驱动接口 */
  scene: PerformanceSceneApi;
  /** 主音量 0~1 */
  getVolume: () => number;
}

/**
 * 表演层：按顺序消费 performance 数组（每项 = 一句台词 + 情绪及其强度）——
 * 每段先切换情绪（仅作用于本段台词，播完自动复位 neutral），再播放媒体
 * （字幕 + 音频驱动唇形同步）。一次性动画触发（action 字段）已在 v1.5 移除。
 */
export function usePerformance(options: UsePerformanceOptions) {
  const subtitle = ref('');
  const currentEmotion = ref('neutral');
  const isPlaying = ref(false);

  const queue: Performance[] = [];
  let playing = false;
  /** skip/dispose 代数：等待中的段（媒体/延迟等待）据此检测自己已被跳过 */
  let skipGeneration = 0;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let gainNode: GainNode | null = null;
  let currentAudioEl: HTMLAudioElement | null = null;
  let currentSource: MediaElementAudioSourceNode | null = null;
  let lipsyncNode: WLipSyncAudioNode | null = null;
  let lipRafId = 0;
  let silentTimer: number | null = null;
  /** 切换表情后、播放音频前的缓冲（让表情先过渡到位） */
  let expressionDelayTimer: number | null = null;
  /** delay 的 reject 句柄，用于 skip 时取消挂起的延迟 */
  let expressionDelayReject: ((e: Error) => void) | null = null;
  /** 表情切换到音频播放的延迟（毫秒） */
  const EXPRESSION_AUDIO_DELAY = 600;
  // 首次手势 unlock 句柄（dispose 时移除）
  let unlockOnce: (() => void) | null = null;

  /**
   * wLipSync 音素（大写）→ VRM 元音表情名 映射。
   * profile.bin 默认含 A/I/U/E/O/S 六个音素，
   * 其中 S（咝音）VRM 无对应表情，忽略（即闭嘴）。
   */
  const PHONEME_TO_VOWEL: Partial<Record<string, VowelPreset>> = {
    A: 'aa',
    I: 'ih',
    U: 'ou',
    E: 'ee',
    O: 'oh',
  };

  /** 入队一段表演消息：把 performances 压入队列，按顺序处理 */
  function enqueue(message: PerformanceMessage): void {
    const performances = message.performances;
    console.log('[perf] enqueue 收到消息', {
      count: performances.length,
      playing,
      queueLenBefore: queue.length,
    });
    for (const item of performances) {
      queue.push(item);
    }
    console.log('[perf] enqueue 入队后', {
      queueLenAfter: queue.length,
      willStartPlayNext: !playing,
    });
    if (!playing) playNext();
  }

  async function playNext(): Promise<void> {
    const item = queue.shift();
    if (!item) {
      console.log('[perf] playNext 队列为空，停止播放');
      playing = false;
      isPlaying.value = false;
      subtitle.value = '';
      currentEmotion.value = 'neutral';
      resetLip();
      options.scene.setEmotion('neutral');
      options.scene.returnToIdle();
      return;
    }

    playing = true;
    isPlaying.value = true;
    // 段落开始时的 skip 代数：任何 await 之后若代数已变，说明本段被
    // skip/dispose 打断，立即终止链路（skip 已完成全部清理）
    const generation = skipGeneration;

    // 情绪：仅在本段台词期间生效（词表外的值由 faceDriver 回退 neutral）
    const prevEmotion = currentEmotion.value;
    const emotion = item.emotion || 'neutral';
    const intensity = item.intensity ?? 0.85;
    currentEmotion.value = emotion;
    options.scene.setEmotion(emotion, intensity);
    console.log('[perf] 情绪', { name: emotion, intensity, prev: prevEmotion });

    // 情绪切换后缓冲一下，让表情过渡到位再播放台词音频
    if (emotion !== prevEmotion) {
      try {
        await delay(EXPRESSION_AUDIO_DELAY);
      } catch {
        // skip 在延迟期间取消：结束本段，不再处理后续
        return;
      }
    }

    // 台词：播放媒体（字幕 + 音频/静音），阻塞到完成
    subtitle.value = item.text;
    console.log('[perf] text 段', {
      content: item.text,
      hasAudio: !!item.audio,
      audioFilename: item.audio?.filename,
      audioDataLen: item.audio?.data?.length,
    });
    await playSegmentMedia(item);
    if (generation !== skipGeneration) return; // skip 已接管清理，终止链路
    // 本段结束：情绪作用域结束，复位 neutral
    currentEmotion.value = 'neutral';
    options.scene.setEmotion('neutral');
    console.log('[perf] text 段完成，情绪复位 neutral，进入下一段', {
      queueLenRemaining: queue.length,
    });
    playNext();
  }

  /** 播放段的媒体部分（音频或静音）。 */
  function playSegmentMedia(item: Performance): Promise<void> {
    if (item.audio) return playAudioSegment(item);
    return playSilentSegment(item);
  }

  function playAudioSegment(item: Performance): Promise<void> {
    return new Promise(async (resolve) => {
      cleanupAudio();

      const audio = item.audio;
      if (!audio) {
        console.log('[perf] playAudioSegment 无 audio，直接 resolve');
        resolve();
        return;
      }
      const fmt = audio.filename.split('.').pop() || 'mp3';
      const mime = audioFormatToMime(fmt);
      const dataUrl = `data:${mime};base64,${audio.data}`;

      const el = new Audio(dataUrl);
      el.volume = clamp(options.getVolume(), 0, 1);
      currentAudioEl = el;

      // 建立 Web Audio 图（持久的 gain→destination 连接只在首次建立）
      await ensureAudioGraph();
      let connected = false;
      try {
        const source = audioCtx!.createMediaElementSource(el);
        // 扇出（fan-out）：分析支路 + 播放支路
        //   lipsyncNode 只消费输入不输出（终端节点）
        //   gainNode 用于实际播放并控制音量
        if (lipsyncNode) source.connect(lipsyncNode);
        if (gainNode) source.connect(gainNode);
        currentSource = source;
        connected = true;
      } catch (e) {
        console.warn('[perf] createMediaElementSource 失败，直接走 audio 元素播放', e);
      }

      let settled = false;
      const finish = (reason: string): void => {
        if (settled) return;
        settled = true;
        console.log(`[perf] 段结束（${reason}）`);
        clearWatchdog();
        stopLipLoop();
        resetLip();
        // 音频结束 → 音量归零，让身体/头部摆动随惯性自然停止
        options.scene.setAudioLevel(0);
        cleanupAudio();
        resolve();
      };

      el.addEventListener('ended', () => finish('ended'), { once: true });
      // 使用 onerror 属性形式，便于 cleanupAudio 在置空 src 前移除，
      // 避免 src='' 触发的伪 error 事件污染控制台
      el.onerror = (e) => {
        console.error('[perf] audio error 事件', e);
        finish('error');
      };

      // watchdog：监测 currentTime 是否推进；卡住超过 3s 强制结束。
      let lastT = -1;
      let stuckMs = 0;
      let lastTs = performance.now();
      let watchdogId = 0;
      const clearWatchdog = (): void => {
        if (watchdogId) {
          cancelAnimationFrame(watchdogId);
          watchdogId = 0;
        }
      };
      const startWatchdog = (): void => {
        const check = (): void => {
          watchdogId = requestAnimationFrame(check);
          const now = performance.now();
          const dt = now - lastTs;
          lastTs = now;
          const t = el.currentTime;

          if (t === lastT) {
            stuckMs += dt;
            if (stuckMs >= 3000) {
              console.warn('[perf] watchdog: currentTime 卡住 3s，强制结束', {
                currentTime: t,
                readyState: el.readyState,
                networkState: el.networkState,
              });
              finish('watchdog-stuck');
            }
          } else {
            stuckMs = 0;
          }
          lastT = t;
        };
        watchdogId = requestAnimationFrame(check);
      };

      console.log('[perf] 准备 audioCtx.resume + el.play()', {
        audioCtxState: audioCtx?.state,
        connected,
        readyState: el.readyState,
        networkState: el.networkState,
      });
      audioCtx?.resume().finally(() => {
        el.play()
          .then(() => {
            console.log('[perf] el.play() 成功，开始唇形循环', {
              duration: el.duration,
              connected,
            });
            if (connected) startLipLoop();
            startWatchdog();
          })
          .catch((err) => {
            console.error('[perf] el.play() 失败，按静音段处理', err);
            finish('play-rejected');
          });
      });
    });
  }

  function playSilentSegment(item: Performance): Promise<void> {
    return new Promise((resolve) => {
      // 无音频：按文本长度估算展示时长（约每字 180ms，至少 1.2s）
      const duration = Math.max(
        1200,
        Math.min(8000, charCount(item.text) * 180),
      );
      silentTimer = window.setTimeout(() => {
        silentTimer = null;
        resolve();
      }, duration);
    });
  }

  /** 表情切换后延迟指定毫秒，让表情过渡到位再播放音频；
   *  被 skip 取消时会 reject，调用方据此中止后续音频播放。 */
  function delay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      expressionDelayReject = reject;
      expressionDelayTimer = window.setTimeout(() => {
        expressionDelayTimer = null;
        expressionDelayReject = null;
        resolve();
      }, ms);
    });
  }

  // 进行中的 ensureAudioGraph promise：unlockAudio 与 playAudioSegment
  // 可能并发触发，重复 createWLipSyncNode / audioWorklet.addModule 会
  // 互相中止并抛 AbortError，这里合并为同一次调用。
  let ensureAudioGraphPromise: Promise<void> | null = null;

  function ensureAudioGraph(): Promise<void> {
    if (!ensureAudioGraphPromise) {
      ensureAudioGraphPromise = doEnsureAudioGraph().finally(() => {
        ensureAudioGraphPromise = null;
      });
    }
    return ensureAudioGraphPromise;
  }

  async function doEnsureAudioGraph(): Promise<void> {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      audioCtx = new Ctor();
    }
    if (!gainNode) {
      gainNode = audioCtx.createGain();
      gainNode.gain.value = options.getVolume();
      // 播放支路：gainNode → destination
      gainNode.connect(audioCtx.destination);
    }
    if (!lipsyncNode) {
      try {
        // AudioWorklet 模块加载需在 context 运行态下进行
        if (audioCtx.state !== 'running') {
          await audioCtx.resume();
        }
        // 关键：wlipsync-single 内联的 worklet 是 data: URL，
        // Chrome 的 AudioWorklet 模块加载器不支持 data: URL，
        // 会抛 AbortError。这里先从真实文件加载 processor 并注册，
        // 之后 createWLipSyncNode 内部 new AudioWorkletNode 即可直接成功。
        await audioCtx.audioWorklet.addModule(AUDIO_WORKLET_URL);
        // 加载 wLipSync profile（二进制格式，体积小且含预计算值）
        const buf = await fetch(LIPSYNC_PROFILE_URL).then((r) => r.arrayBuffer());
        const profile = parseBinaryProfile(buf);
        lipsyncNode = await createWLipSyncNode(audioCtx, profile);
        // log10 域音量归一化区间；TTS 输出偏小时可适当下调
        lipsyncNode.minVolume = -3;
        lipsyncNode.maxVolume = -1.5;
      } catch (e) {
        console.warn('[perf] wLipSync 节点创建失败，唇形同步将不可用', e);
        lipsyncNode = null;
      }
    }
  }

  /**
   * 在用户手势内调用：提前创建并 resume AudioContext，
   * 否则浏览器自动播放策略会让 context 一直 suspended，
   * 导致 createMediaElementSource 路由的音频既无声、又不触发 ended，
   * 队列因此永久卡死。
   */
  function unlockAudio(): void {
    // 触发 profile 预加载与节点创建（异步，不阻塞手势）
    ensureAudioGraph().catch((e) => {
      console.warn('[perf] unlockAudio: ensureAudioGraph 失败', e);
    });
    if (audioCtx && audioCtx.state !== 'running') {
      audioCtx
        .resume()
        .then(() => {
          console.log('[perf] unlockAudio: AudioContext resumed', {
            state: audioCtx?.state,
          });
        })
        .catch((e) => {
          console.warn('[perf] unlockAudio: resume 失败', e);
        });
    }
  }

  // 监听首次用户手势，自动 unlock（应对 onMounted 里自动连接、
  // 用户没机会点 Connect 的情况）
  unlockOnce = (): void => {
    unlockAudio();
    if (unlockOnce) {
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
      unlockOnce = null;
    }
  };
  window.addEventListener('pointerdown', unlockOnce);
  window.addEventListener('keydown', unlockOnce);

  function startLipLoop(): void {
    stopLipLoop();
    const tick = (): void => {
      lipRafId = requestAnimationFrame(tick);

      // 由 wLipSync 驱动五元音口型：weights[phoneme] × volume
      // weights 是平滑后的独立值（命中音素趋近 1，其余趋近 0）
      if (lipsyncNode) {
        const weights = lipsyncNode.weights;
        const vol = lipsyncNode.volume;
        const out: Partial<LipSyncWeights> = {};
        for (const phoneme in weights) {
          const vowel = PHONEME_TO_VOWEL[phoneme];
          if (vowel) out[vowel] = weights[phoneme] * vol;
        }
        options.scene.setLipWeights(out);
        // 同步音量到场景层，驱动身体/头部说话摆动
        options.scene.setAudioLevel(vol);
      }

      // 同步音量（用户实时调节）
      if (gainNode) gainNode.gain.value = options.getVolume();
      if (currentAudioEl) currentAudioEl.volume = 1; // 实际音量由 gain 控制
    };
    lipRafId = requestAnimationFrame(tick);
  }

  /** 关闭所有口型（段间复位） */
  function resetLip(): void {
    options.scene.resetLipWeights();
  }

  function stopLipLoop(): void {
    if (lipRafId) {
      cancelAnimationFrame(lipRafId);
      lipRafId = 0;
    }
  }

  function cleanupAudio(): void {
    if (currentAudioEl) {
      // 必须先移除 onerror：el.src='' 会让浏览器异步派发 error 事件
      // （MEDIA_ERR_ABORTED, isTrusted=true），污染控制台并误走 finish('error')
      currentAudioEl.onerror = null;
      currentAudioEl.pause();
      currentAudioEl.src = '';
      currentAudioEl = null;
    }
    if (currentSource) {
      try {
        currentSource.disconnect();
      } catch {
        /* noop */
      }
      currentSource = null;
    }
  }

  function setVolume(v: number): void {
    if (gainNode) gainNode.gain.value = clamp(v, 0, 1);
    if (currentAudioEl) currentAudioEl.volume = clamp(v, 0, 1);
  }

  /** 跳过当前表演（清空队列） */
  function skip(): void {
    skipGeneration++;
    queue.length = 0;
    if (silentTimer !== null) {
      window.clearTimeout(silentTimer);
      silentTimer = null;
    }
    if (expressionDelayTimer !== null) {
      window.clearTimeout(expressionDelayTimer);
      expressionDelayTimer = null;
    }
    if (expressionDelayReject) {
      const reject = expressionDelayReject;
      expressionDelayReject = null;
      reject(new Error('delay-cancelled'));
    }
    cleanupAudio();
    stopLipLoop();
    playing = false;
    isPlaying.value = false;
    subtitle.value = '';
    resetLip();
    options.scene.setAudioLevel(0);
    options.scene.setEmotion('neutral');
    // 跳过时让进行中的动作淡出回归待机。
    // 待机变体是 set_idle 带外下发的持久状态，跳过表演不复位它
    options.scene.returnToIdle();
  }

  function dispose(): void {
    if (unlockOnce) {
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
      unlockOnce = null;
    }
    queue.length = 0;
    skip();
    if (audioCtx) {
      audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
    if (lipsyncNode) {
      try {
        lipsyncNode.disconnect();
      } catch {
        /* noop */
      }
      lipsyncNode = null;
    }
    gainNode = null;
  }

  onBeforeUnmount(dispose);

  return {
    subtitle,
    currentEmotion,
    isPlaying,
    enqueue,
    skip,
    setVolume,
    unlockAudio,
  };
}

// ---- 工具函数 ----
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function charCount(s: string): number {
  // 统计字符数（中日韩字符按 1，避免过长）
  return Array.from(s).length;
}

export function audioFormatToMime(format: string): string {
  const f = (format || '').toLowerCase().replace(/^\./, '');
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    weba: 'audio/webm',
  };
  return map[f] || 'audio/mpeg';
}

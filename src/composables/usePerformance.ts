import { onBeforeUnmount, ref } from 'vue';
import {
  createWLipSyncNode,
  parseBinaryProfile,
  type WLipSyncAudioNode,
} from 'wlipsync';
import type {
  PerformanceMessage,
  PerformanceSegment,
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
  /** 设置情绪表情 */
  setEmotion: (emotion: string) => void;
  /** 设置五元音口型权重（0~1），由 wLipSync 驱动 */
  setLipWeights: (weights: Partial<LipSyncWeights>) => void;
  /** 复位所有口型权重为 0 */
  resetLipWeights: () => void;
  /** 设置当前说话音量（0~1），驱动身体/头部摆动幅度 */
  setAudioLevel: (level: number) => void;
  /** 按名播放一个动作动画（对应 update_animations 推送的动画 name） */
  playAction: (name: string) => void;
  /** 淡出到待机（idle）动作：让循环动作停下来回归待机 */
  returnToIdle: () => void;
}

export interface UsePerformanceOptions {
  /** VRM 场景驱动接口 */
  scene: PerformanceSceneApi;
  /** 主音量 0~1 */
  getVolume: () => number;
}

/**
 * 表演层：维护表演队列，按段顺序播放——切换表情、播放音频、
 * Web Audio 分析音量驱动唇形同步、更新字幕；音频结束后播下一段。
 */
export function usePerformance(options: UsePerformanceOptions) {
  const subtitle = ref('');
  const currentExpression = ref('neutral');
  const isPlaying = ref(false);

  const queue: PerformanceSegment[] = [];
  let playing = false;
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

  /** 入队一段表演消息 */
  function enqueue(message: PerformanceMessage): void {
    console.log('[perf] enqueue 收到消息', {
      segCount: message.segments.length,
      playing,
      queueLenBefore: queue.length,
      dialogues: message.segments.map((s) => s.dialogue),
      hasAudios: message.segments.map((s) => !!s.audio),
    });
    for (const seg of message.segments) {
      queue.push(seg);
    }
    console.log('[perf] enqueue 入队后', {
      queueLenAfter: queue.length,
      willStartPlayNext: !playing,
    });
    if (!playing) playNext();
  }

  async function playNext(): Promise<void> {
    const seg = queue.shift();
    if (!seg) {
      console.log('[perf] playNext 队列为空，停止播放');
      playing = false;
      isPlaying.value = false;
      subtitle.value = '';
      currentExpression.value = 'neutral';
      resetLip();
      options.scene.setEmotion('neutral');
      // 队列结束：让正在循环的动作（如 dance）淡出回归待机
      options.scene.returnToIdle();
      return;
    }

    playing = true;
    isPlaying.value = true;
    const prevExpression = currentExpression.value;
    currentExpression.value = seg.expression;
    subtitle.value = seg.dialogue;
    options.scene.setEmotion(seg.expression);

    // 段指定的动作动画（如 wave/nod）；缺省 action 时回归待机，
    // 确保上一个循环动作能停下来而不是一直循环
    if (seg.action) {
      options.scene.playAction(seg.action);
    } else {
      options.scene.returnToIdle();
    }

    console.log('[perf] playNext 开始播放段', {
      queueLenAfterShift: queue.length,
      expression: seg.expression,
      action: seg.action,
      hasAudio: !!seg.audio,
      audioFilename: seg.audio?.filename,
      audioDataLen: seg.audio?.data?.length,
      dialogue: seg.dialogue,
    });

    if (seg.expression !== prevExpression) {
      try {
        await delay(EXPRESSION_AUDIO_DELAY);
      } catch {
        // skip 在延迟期间取消：结束本段，不再播放音频
        return;
      }
    }

    // 段播放：播放语音或静音
    await playSegmentMedia(seg);

    console.log('[perf] playNext 段播放完成，进入下一段', {
      queueLenRemaining: queue.length,
    });

    playNext();
  }

  /** 播放段的媒体部分（音频或静音）。 */
  function playSegmentMedia(seg: PerformanceSegment): Promise<void> {
    if (seg.audio) return playAudioSegment(seg);
    return playSilentSegment(seg);
  }

  function playAudioSegment(seg: PerformanceSegment): Promise<void> {
    return new Promise(async (resolve) => {
      cleanupAudio();

      const audio = seg.audio;
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

  function playSilentSegment(seg: PerformanceSegment): Promise<void> {
    return new Promise((resolve) => {
      // 无音频：按文本长度估算展示时长（约每字 180ms，至少 1.2s）
      const duration = Math.max(
        1200,
        Math.min(8000, charCount(seg.dialogue) * 180),
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
    // 跳过时让正在循环的动作淡出回归待机
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
    currentExpression,
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

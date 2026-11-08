/**
 * MixerLayer：单个动画层 = 单个 AnimationMixer。
 *
 * 分层原理（仿 Unity Animator Layers）：
 * three.js 的 AnimationMixer 在一次 update 内对同一属性做「归一化加权平均」，
 * 无法表达层间覆盖（Override）语义。因此每个动画层持有独立 mixer，
 * 由 AnimationController 按优先级从低到高依次 update：
 *   Base → Gesture → Action
 * 每层 update 时 PropertyMixer.apply() 会整体覆写它所绑定的属性，
 * 「后更新者胜」——高优先级层只覆写其 clip（经遮罩裁剪）包含的骨骼，
 * 其余骨骼保留低层的姿势，即得到 Unity 式的层覆盖 + 遮罩效果。
 *
 * 平滑技巧（refreshOriginalStates）：
 * PropertyMixer 在层权重 <1 时会向「保存的原始状态」混合（见
 * PropertyMixer.apply 的 weight<1 分支）。该原始状态默认是动作激活瞬间的
 * 快照，对上层动画来说是陈旧姿势。因此上层在每次 update 前对「低层也
 * 驱动的属性」调用 refreshOriginalStates()，把「低层本帧刚施加的实时姿势」
 * 存为混合基准，使上层淡入/淡出始终朝低层的实时姿势过渡（例如手势淡出
 * 时平滑交还给正在摆臂的走路动画，而不是交还给激活那一刻的姿势快照）。
 *
 * 关键限制（sharedKeys）：只能刷新低层驱动的属性。上层独占的属性（如
 * Base 层 clip 不含的表情轨道、手指骨骼）一旦也照刷，快照就会变成上层
 * 自己上一帧的输出——释放时 AnimationMixer._deactivateAction() 会调用
 * restoreOriginalState() 把该快照写回属性，写回的正是上层姿势本身，
 * 且没有任何低层会再覆写这些属性 → 手势/表情永久粘滞。
 */

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { VRMAnimation } from '@pixiv/three-vrm-animation';

export interface MixerLayerOptions {
  /** 调试用层名 */
  name: string;
  /** 由模型无关的 VRMAnimation 构建绑定到当前模型的 clip（可做遮罩裁剪） */
  buildClip: (vrma: VRMAnimation, vrm: VRM) => THREE.AnimationClip | null;
  /** 默认交叉淡化时长（秒） */
  fade?: number;
}

export interface LayerPlayOptions {
  /** true=循环（如待机/走路），false=单次播放（如一次性动作） */
  loop?: boolean;
  /** 本次切换的交叉淡化时长（秒），缺省用层默认值 */
  fade?: number;
}

/** mixer 'finished' 事件的载荷（three 类型定义为通用 Event，这里补充字段） */
type MixerFinishedEvent = THREE.Event & { action: THREE.AnimationAction };

/** AnimationMixer 内部绑定数组的最小结构（_bindings 为非公开 API，防御式访问） */
interface MixerBindingInternals {
  saveOriginalState?: () => void;
  /** 底层 PropertyBinding（用于跨 mixer 识别同一属性） */
  binding?: {
    path?: unknown;
    rootNode?: { uuid?: unknown } | null;
  } | null;
}

interface MixerInternals {
  _bindings?: Array<MixerBindingInternals | null> | null;
  _nActiveBindings?: number;
}

/** 跨 mixer 稳定标识同一属性：rootUuid|trackName（结构不可识别返回 null） */
function bindingKey(entry: MixerBindingInternals | null | undefined): string | null {
  const { binding } = entry ?? {};
  if (!binding || typeof binding.path !== 'string') return null;
  const uuid =
    binding.rootNode && typeof binding.rootNode.uuid === 'string'
      ? binding.rootNode.uuid
      : '?';
  return `${uuid}|${binding.path}`;
}

export class MixerLayer {
  readonly name: string;

  private vrm: VRM | null = null;
  private root: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private animations = new Map<string, VRMAnimation>();
  private readonly clipCache = new Map<string, THREE.AnimationClip>();
  private activeAction: THREE.AnimationAction | null = null;
  private activeClipName: string | null = null;
  /**
   * 正在淡出、尚未真正 stop 的动作（释放窗口）。stopActive(fade) 只是把
   * activeAction 置空，动作本身还要继续淡出 fade 秒——期间 PropertyMixer
   * 仍会每帧向属性写入「原始状态 × 动作姿势」的混合值。控制器必须在整个
   * 窗口内继续刷新混合基准（isReleasing），否则淡出会朝释放瞬间的过时
   * 姿势收敛、真正 stop 时再跳到低层实时姿势（回归待机时抽搐的根因）。
   */
  private readonly fadingActions = new Set<THREE.AnimationAction>();
  /**
   * 每个淡出动作各自的延迟 stop 定时器（Map：action → timer id）。
   * 旧实现全层共用一个 timer 字段，连环触发时会误清上一个动作的定时器，
   * 导致它永不 stop、绑定泄漏并冻结共享骨骼。
   */
  private readonly stopTimers = new Map<THREE.AnimationAction, number>();
  private muted = false;
  private readonly defaultFade: number;
  private readonly buildClip: (vrma: VRMAnimation, vrm: VRM) => THREE.AnimationClip | null;

  /** 单次动作自然播完（LoopOnce + clamp）时回调 */
  onFinished: ((clipName: string) => void) | null = null;

  private readonly finishListener = (event: MixerFinishedEvent): void => {
    if (this.activeAction && event.action === this.activeAction) {
      this.onFinished?.(this.activeClipName ?? '');
    }
  };

  constructor(options: MixerLayerOptions) {
    this.name = options.name;
    this.buildClip = options.buildClip;
    this.defaultFade = options.fade ?? 0.25;
  }

  /** 是否已绑定模型（可播放） */
  get isBound(): boolean {
    return this.vrm !== null && this.root !== null;
  }

  /** 当前是否有动作占据本层 */
  get hasActive(): boolean {
    return this.activeAction !== null;
  }

  /** 本层是否有动作仍在淡出释放（stopActive 之后、真正 stop 之前）。
   *  此期间该动作仍会向属性写入混合值，上层混合基准的刷新必须覆盖此窗口。 */
  get isReleasing(): boolean {
    return this.fadingActions.size > 0;
  }

  /** 当前占用本层的动画名 */
  get currentClipName(): string | null {
    return this.activeClipName;
  }

  /** 本层是否处于静音状态（被更高优先级层接管） */
  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * 更新动画集合并重置播放状态（动画集整体替换时调用）。
   * 清空 clip 缓存，当前动作立即停止。
   */
  setAnimations(animations: Map<string, VRMAnimation>): void {
    this.animations = animations;
    this.clipCache.clear();
    this.stopActive(0);
  }

  has(name: string): boolean {
    return this.animations.has(name);
  }

  /** 绑定模型（模型加载/切换时调用）。会丢弃旧 mixer 与播放状态。 */
  bind(vrm: VRM, root: THREE.Object3D): void {
    this.unbind();
    this.vrm = vrm;
    this.root = root;
  }

  /** 解绑模型：停掉并释放 mixer（模型即将被卸载/替换） */
  unbind(): void {
    this.disposeMixer();
    this.vrm = null;
    this.root = null;
  }

  /**
   * 播放指定动画，与当前动作交叉淡化。
   * 同一动作重复触发时保持连续播放不跳帧（如 Base 层同状态反复求值）。
   *
   * @returns 是否成功开始播放（未绑定/动画不存在/clip 构建失败返回 false）
   */
  play(name: string, options: LayerPlayOptions = {}): boolean {
    if (!this.vrm || !this.root || !this.mixerReady()) return false;
    const vrma = this.animations.get(name);
    if (!vrma) return false;

    const clip = this.ensureClip(name, vrma);
    if (!clip) return false;

    const loop = options.loop ?? true;
    const fade = options.fade ?? this.defaultFade;
    const action = this.mixer!.clipAction(clip);
    action.loop = loop ? THREE.LoopRepeat : THREE.LoopOnce;
    action.clampWhenFinished = !loop;

    // 同一动作且正在播放：保持连续（仅校正循环语义），避免重复 reset 跳帧
    if (this.activeAction === action && action.isRunning()) return true;

    // 旧动作交叉淡出，淡出完成后停止释放
    this.fadeOutActive(fade, action);

    action.reset();
    if (fade > 0) {
      action.fadeIn(fade);
    } else {
      action.setEffectiveWeight(1);
    }
    action.play();
    this.activeAction = action;
    this.activeClipName = name;
    // eslint-disable-next-line no-console
    console.log(
      `[Animator:${this.name}] 播放 "${name}" (loop=${loop}, fade=${fade}s)`,
    );
    return true;
  }

  /**
   * 淡出并停止当前动作，释放本层控制权。
   * @param fade 淡出时长（秒）；0 = 立即停止
   */
  stopActive(fade: number = this.defaultFade): void {
    this.fadeOutActive(fade, null);
    this.activeAction = null;
    this.activeClipName = null;
  }

  /**
   * 一键静音/解除静音：冻结本层时间推进（保持当前姿势、不释放绑定）。
   * 供更高优先级层（Action）接管时压制本层，防止低层动画（如走路摆腿）
   * 在覆盖动画之下继续滑步；解除后从冻结处继续。
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.mixer) this.mixer.timeScale = muted ? 0 : 1;
  }

  /** 推进本层动画。必须在所有更低优先级层 update 之后调用。 */
  update(deltaTime: number): void {
    if (this.mixer) this.mixer.update(deltaTime);
  }

  /**
   * 本层当前活动绑定覆盖的属性键集合（见 bindingKey）。
   * 供上层判断「哪些属性由本层驱动」：上层只对这些属性刷新混合基准；
   * 其余（上层独占的，如本层 clip 不含的表情轨道）保留激活瞬间的快照，
   * 释放时 restoreOriginalState() 才能还原到上层接管前的值。
   */
  activeBindingKeys(): Set<string> {
    const keys = new Set<string>();
    if (!this.mixer) return keys;
    const internals = this.mixer as unknown as MixerInternals;
    const bindings = internals._bindings;
    if (!Array.isArray(bindings)) return keys;
    const count = typeof internals._nActiveBindings === 'number'
      ? internals._nActiveBindings
      : bindings.length;
    for (let i = 0; i < count; i++) {
      const key = bindingKey(bindings[i]);
      if (key !== null) keys.add(key);
    }
    return keys;
  }

  /**
   * 刷新本层活动绑定的「原始状态」基准。
   * 必须在更低优先级层 update 之后、本层 update 之前调用（见文件头说明）。
   * @param sharedKeys 低层当前驱动的属性键集合（通常传 base.activeBindingKeys()）：
   *   - 键在集合内（低层每帧覆写该属性）：刷新为低层本帧实时值，
   *     使淡入/淡出朝低层实时姿势过渡
   *   - 键不在集合内（本层独占属性）：**不刷新**，保留激活瞬间快照。
   *     否则快照会变成本层自己上一帧的输出，释放时 restoreOriginalState()
   *     写回的正是本层姿势 → 永久粘滞（手势表情残留的根因）
   * 访问的是 AnimationMixer 的非公开 _bindings（防御式：不可用则静默跳过）。
   */
  refreshOriginalStates(sharedKeys?: Set<string> | null): void {
    if (!this.mixer) return;
    const internals = this.mixer as unknown as MixerInternals;
    const bindings = internals._bindings;
    if (!Array.isArray(bindings)) return;
    const count = typeof internals._nActiveBindings === 'number'
      ? internals._nActiveBindings
      : bindings.length;
    for (let i = 0; i < count; i++) {
      const entry = bindings[i];
      if (!entry) continue;
      const key = bindingKey(entry);
      if (sharedKeys && key !== null && !sharedKeys.has(key)) continue;
      try {
        entry.saveOriginalState?.();
      } catch {
        /* 单个绑定刷新失败不影响其余 */
      }
    }
  }

  dispose(): void {
    this.unbind();
    this.animations.clear();
    this.clipCache.clear();
    this.onFinished = null;
  }

  // ---- 内部实现 ----

  /** mixer 惰性创建：首次真正要播放时才建立（无动画时保持 null） */
  private mixerReady(): boolean {
    if (this.mixer) return true;
    if (!this.vrm || !this.root) return false;
    this.mixer = new THREE.AnimationMixer(this.root);
    this.mixer.timeScale = this.muted ? 0 : 1;
    this.mixer.addEventListener('finished', this.finishListener);
    return true;
  }

  private ensureClip(name: string, vrma: VRMAnimation): THREE.AnimationClip | null {
    const cached = this.clipCache.get(name);
    if (cached) return cached;
    const vrm = this.vrm;
    if (!vrm) return null;
    const clip = this.buildClip(vrma, vrm);
    if (clip) this.clipCache.set(name, clip);
    return clip;
  }

  /**
   * 当前动作淡出并在淡出完成后停止。
   * @param skip 命中该 action 时不处理（重复触发同一动作时避免把刚重置的动作停掉）
   */
  private fadeOutActive(fade: number, skip: THREE.AnimationAction | null): void {
    const prev = this.activeAction;
    // 注意：先判 prev。stopActive 已把 activeAction 置 null，此时直接返回，
    // 保留上一个淡出动作自己的 stop 定时器（Map 中各自独立，互不干扰），
    // 它到点后自行 stop，不会泄漏绑定。
    if (!prev || prev === skip) return;
    this.clearStopTimerFor(prev);
    const clipName = this.activeClipName ?? '?';
    if (fade <= 0) {
      // eslint-disable-next-line no-console
      console.log(`[Animator:${this.name}] 立即停止 "${clipName}"`);
      prev.stop();
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[Animator:${this.name}] 淡出 "${clipName}" fade=${fade}s`);
    prev.fadeOut(fade);
    this.fadingActions.add(prev);
    // 淡出完成后停止旧动作，释放 mixer 内的 action（weight 已为 0 不影响渲染）
    this.stopTimers.set(
      prev,
      window.setTimeout(() => {
        this.stopTimers.delete(prev);
        this.fadingActions.delete(prev);
        // eslint-disable-next-line no-console
        console.log(
          `[Animator:${this.name}] 停止 "${clipName}" ` +
            `(w=${prev.getEffectiveWeight().toFixed(2)}, ` +
            `run=${prev.isRunning()}, paused=${prev.paused})`,
        );
        prev.stop();
      }, fade * 1000 + 60),
    );
  }

  /** 清掉指定动作的延迟 stop 定时器（它即将被重新处理） */
  private clearStopTimerFor(action: THREE.AnimationAction): void {
    const timer = this.stopTimers.get(action);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.stopTimers.delete(action);
    }
  }

  /** 清掉全部延迟 stop 定时器与淡出记账（丢弃 mixer 前调用） */
  private clearAllStopTimers(): void {
    for (const timer of this.stopTimers.values()) window.clearTimeout(timer);
    this.stopTimers.clear();
    this.fadingActions.clear();
  }

  private disposeMixer(): void {
    this.clearAllStopTimers();
    const mixer = this.mixer;
    this.mixer = null;
    this.activeAction = null;
    this.activeClipName = null;
    if (mixer) {
      mixer.removeEventListener('finished', this.finishListener);
      mixer.stopAllAction();
      if (this.root) mixer.uncacheRoot(this.root);
    }
  }
}

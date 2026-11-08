/**
 * AnimationController：分层动画控制器（Base / Additive / Gesture / Action 四层）。
 *
 * 四层架构（优先级从低到高）：
 *
 * 1. Base（基础层）——最底层，驱动全身骨骼与整体位移。
 *    常驻循环播放当前待机动画，可通过 setIdle 切换待机变体
 *    （[idle:x] 事件），切换时交叉淡化。不含运动状态机。
 *
 * 2. Additive（叠加层）——数学相加的次级动态（呼吸起伏、身体微晃等），
 *    不覆盖任何层、永远在线。本控制器只提供逐帧钩子通道
 *    （registerAdditive），具体程序化实现（Offset 节点法）由场景层注入，
 *    如 useBreath / useBodySway：在骨骼父级插入偏移节点，
 *    世界矩阵 = 父 × 子，与任何关键帧层自然相加。
 *
 * 3. Gesture（手势层）——Avatar Mask 只接管上半身骨骼（躯干上部/颈/头/
 *    肩/臂/手/指）+ 表情，放弃 hips 与下肢控制权。播放手势时覆盖 Base 层
 *    的上半身动作，但双腿继续走 Base 层动画（边走边挥手不会滑步）。
 *    [action:x] 事件按动画注册的 layer 路由到本层或 Action 层。
 *
 * 4. Action（动作层）——最高优先级的全身覆盖层，播放短促演艺动作
 *    （跳舞/后空翻/倒地等）。触发瞬间「一键静音」：冻结 Base 与 Gesture
 *    的时间推进（权重语义上的压制），防止覆盖动画之下下肢滑行；
 *    播完自动释放控制权，Base 从冻结处继续。
 *
 * 帧内更新顺序（决定优先级，后更新者覆写共享骨骼）：
 *   Additive 钩子 → Base mixer → Gesture mixer（先刷新混合基准）
 *   → Action mixer（先刷新混合基准）
 */

import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation';
import type { AnimationLayer } from '@/types/messages';
import { createMaskedVRMAnimationClip, GESTURE_BONES } from './avatarMask';
import { MixerLayer } from './MixerLayer';

/** Base 层切换待机变体的交叉淡化时长（秒） */
const BASE_TRANSITION_FADE = 0.25;
/** Action 层接管淡入时长（秒）：动作首帧通常接近待机姿势，短淡入即可 */
const ACTION_FADE_IN = 0.2;
/**
 * Action 层释放淡出时长（秒）。刻意取长：动作末帧常与待机姿势相差
 * 60~120°，释放淡出是朝 Base 实时姿势的逐骨骼插值，时长直接决定回位
 * 角速度——0.25s 时最陡骨骼可达 ~500°/s（约百倍于待机自身速度，视觉上
 * 是猛甩/不连续）；0.6s 压到 ~200°/s，低于多数动作自身的峰值角速度，
 * 观感为自然回落。对末帧本就接近待机的动作无副作用（姿势相近时长淡出
 * 视觉不可见）。
 */
const ACTION_FADE_OUT = 0.6;
/** Gesture 层淡入时长（秒） */
const GESTURE_FADE_IN = 0.15;
/** Gesture 层释放淡出时长（秒）：取长理由同 ACTION_FADE_OUT */
const GESTURE_FADE_OUT = 0.35;
/** 视为「单帧姿势」clip 的时长阈值（秒）：低于它的 clip 播完即止看不见 */
const POSE_CLIP_THRESHOLD = 0.05;
/** 单帧姿势手势的默认可见保持时长（秒） */
const GESTURE_POSE_HOLD = 1.5;

export class AnimationController {
  /** Base 层：常驻循环的基础层（待机动画切换） */
  readonly base = new MixerLayer({
    name: 'Base',
    fade: BASE_TRANSITION_FADE,
    buildClip: (vrma, vrm) => createVRMAnimationClip(vrma, vrm),
  });

  /** Gesture 层：上半身（肩/臂/手/指 + 表情）遮罩 */
  readonly gesture = new MixerLayer({
    name: 'Gesture',
    fade: GESTURE_FADE_OUT,
    buildClip: (vrma, vrm) =>
      createMaskedVRMAnimationClip(vrma, vrm, {
        bones: GESTURE_BONES,
        hipsTranslation: false,
        expressions: true,
        lookAt: false,
      }),
  });

  /** Action 层：全身覆盖（最高优先级） */
  readonly action = new MixerLayer({
    name: 'Action',
    fade: ACTION_FADE_IN,
    buildClip: (vrma, vrm) => createVRMAnimationClip(vrma, vrm),
  });

  /** Base 层待机覆盖名（[idle:x] sticky）：null = 用默认 idle 解析 */
  private idleOverrideName: string | null = null;
  /** 默认待机动画名（来自注册表 layer=idle 声明，缺省按命名约定 'idle'） */
  private defaultIdleName: string = 'idle';
  /**
   * 每个动画注册的类别（layer=idle/gesture/action，来自 update_animations 推送）。
   * [action:x] 即时播放时据此路由：gesture → Gesture 层（上半身遮罩），
   * 其余 → Action 层（全身覆盖）。
   */
  private readonly animationLayers = new Map<string, AnimationLayer>();
  /** Action 层是否正接管全身（由 playAction/releaseAction 维护） */
  private actionActive = false;
  /** Action 播完兜底计时（'finished' 事件丢失时强制释放） */
  private actionWatchdog: number | null = null;
  /** Gesture 最长占用计时 */
  private gestureWatchdog: number | null = null;
  /**
   * 手势激活前的姿势快照（构造性复位，r4）。
   * 背景：释放链路（淡出→stop→restoreOriginalState）在日志层面全部确认执行，
   * 但独占属性（手指骨骼/表情轨道）实际仍定格在手势姿势。不再修补 mixer
   * 的还原语义，改为：播放前自己拍快照，释放后强制写回——正确性由构造保证。
   */
  private readonly gestureBoneSnapshot = new Map<VRMHumanBoneName, THREE.Quaternion>();
  /** 手势动画驱动的表情轨道激活前 weight 快照（表情名 → weight） */
  private readonly gestureExpressionSnapshot = new Map<string, number>();
  /** 快照强制写回定时器（在层内 stop 定时器之后执行，使写回最终生效） */
  private gestureRestoreTimer: number | null = null;
  private readonly animations = new Map<string, VRMAnimation>();
  private vrm: VRM | null = null;
  private root: THREE.Object3D | null = null;
  /** Additive 层程序化钩子（呼吸/身体微晃等） */
  private readonly additiveChannels: Array<(dt: number) => void> = [];

  constructor() {
    // Action 单次播完 → 自动释放控制权，Base/Gesture 恢复
    this.action.onFinished = () => this.releaseAction();
    // Gesture 单次播完（clamp 保持在末帧）→ 淡出交还手臂给 Base 层
    this.gesture.onFinished = () => this.releaseGesture();
  }

  /** 是否已绑定模型 */
  get isBound(): boolean {
    return this.vrm !== null && this.root !== null;
  }

  /** Action 层是否正接管全身 */
  get isActionActive(): boolean {
    return this.actionActive;
  }

  /**
   * 一次性覆盖层（Gesture/Action）是否有动画正在播放或淡出释放中。
   * 表演层据此同步段落时序：带 action 的段必须等覆盖层完全空闲
   * （动画播完并结束释放淡出）后才进入下一段。
   */
  get isOverlayBusy(): boolean {
    return (
      this.action.hasActive ||
      this.action.isReleasing ||
      this.gesture.hasActive ||
      this.gesture.isReleasing
    );
  }

  // ------------------------------------------------------------------
  // Additive 层（叠加层）
  // ------------------------------------------------------------------

  /**
   * 注册 Additive 层程序化动画钩子（每帧最先应用，数学叠加、不覆盖任何层）。
   * 典型注入：呼吸（useBreath）、说话身体微晃（useBodySway）。
   * @returns 注销函数
   */
  registerAdditive(channel: (dt: number) => void): () => void {
    this.additiveChannels.push(channel);
    return () => {
      const i = this.additiveChannels.indexOf(channel);
      if (i >= 0) this.additiveChannels.splice(i, 1);
    };
  }

  // ------------------------------------------------------------------
  // 绑定与动画集管理
  // ------------------------------------------------------------------

  /** 绑定模型（模型加载/切换时调用），随后自动进入待机 */
  bind(vrm: VRM, root: THREE.Object3D): void {
    this.unbind();
    this.vrm = vrm;
    this.root = root;
    this.base.bind(vrm, root);
    this.gesture.bind(vrm, root);
    this.action.bind(vrm, root);
    const idle = this.resolveIdleClip();
    if (idle) this.base.play(idle, { loop: true, fade: 0 });
  }

  /** 解绑模型（模型卸载/切换前调用），停掉全部层 */
  unbind(): void {
    this.clearWatchdogs();
    this.clearGestureRestoreTimer();
    this.gestureBoneSnapshot.clear();
    this.gestureExpressionSnapshot.clear();
    this.actionActive = false;
    this.base.unbind();
    this.gesture.unbind();
    this.action.unbind();
    this.vrm = null;
    this.root = null;
  }

  /**
   * 整体替换动画集（后端 update_animations 推送时调用）。
   * 会重置各层播放状态并重新进入待机。
   * @param animations 动画名 → 模型无关 VRMAnimation
   * @param layers 动画名 → 类别（idle/gesture/action），即时播放时据此路由
   * @param defaultIdle 默认待机动画名（取自注册表 layer=idle 声明）；
   *   不传则按命名约定用注册表里名为 'idle' 的动画。
   */
  setAnimations(
    animations: Map<string, VRMAnimation>,
    layers?: ReadonlyMap<string, AnimationLayer>,
    defaultIdle?: string,
  ): void {
    this.releaseAction(0);
    this.releaseGesture(0);
    this.animations.clear();
    this.animationLayers.clear();
    for (const [name, vrma] of animations) this.animations.set(name, vrma);
    if (layers) for (const [name, layer] of layers) this.animationLayers.set(name, layer);
    this.base.setAnimations(animations);
    this.gesture.setAnimations(animations);
    this.action.setAnimations(animations);
    this.defaultIdleName =
      defaultIdle !== undefined && this.animations.has(defaultIdle) ? defaultIdle : 'idle';
    // 新注册表可能不含原覆盖动画：失效则丢弃（保持 sticky 到下一次推送）
    if (this.idleOverrideName && !this.animations.has(this.idleOverrideName)) {
      this.idleOverrideName = null;
    }
    if (this.isBound) {
      const idle = this.resolveIdleClip();
      if (idle) this.base.play(idle, { loop: true, fade: 0 });
    }
    // r3 诊断：默认待机解析结果（若落在手势动画上即为粘滞根因）
    // eslint-disable-next-line no-console
    console.log(
      `[Animator r3] 动画集 ${this.animations.size} 个，` +
        `默认待机 "${this.defaultIdleName}" → 实际播放 "${this.base.currentClipName ?? '-'}"` +
        `${this.idleOverrideName ? `（覆盖: "${this.idleOverrideName}"）` : ''}`,
    );
  }

  /** 是否存在指定名称的动画 */
  hasAnimation(name: string): boolean {
    return this.animations.has(name);
  }

  // ------------------------------------------------------------------
  // 帧更新（优先级：Additive → Base → Gesture → Action）
  // ------------------------------------------------------------------

  update(deltaTime: number): void {
    // 1) Additive 层：程序化叠加（呼吸/微晃），永远在线
    for (const channel of this.additiveChannels) channel(deltaTime);

    const gestureBusy = this.gesture.hasActive || this.gesture.isReleasing;
    const actionBusy = this.action.hasActive || this.action.isReleasing;

    // 2) Base 层：上层占用/释放期间先无差别刷新混合基准（r7）。
    //    背景：PropertyMixer.apply 有帧间变化检测（accu0==accu1 则不写），
    //    idle 中处于「平台期」的骨骼（如几乎静止的手臂）值不变 → Base 停止
    //    写入 → 骨骼上残留的是上层输出 → 上层 refreshOriginalStates 读骨骼
    //    时读到自己的姿势（自反馈）→ 释放淡出收敛到手势末帧而非 idle
    //    → 手臂粘滞定格（r4 用写回快照掩盖、r6 去掉写回后暴露的根因）。
    //    saveOriginalState 会把 orig 拷入两个 accu 槽，使 Base 本帧 apply
    //    必然通过变化检测、把真实 idle 姿势写到骨骼上——打断自反馈。
    if (gestureBusy || actionBusy) this.base.refreshOriginalStates();
    this.base.update(deltaTime);

    // 3) Gesture / Action 层：先刷新混合基准，再推进。
    //    只刷新 Base 层本帧驱动的属性（键集合 = base.activeBindingKeys()），
    //    使淡入/淡出朝 Base 实时姿势（走路摆臂等）过渡；
    //    本层独占的属性（Base clip 不含的表情轨道/手指骨骼等）不刷新，
    //    保留激活瞬间快照——否则释放时 restoreOriginalState() 会写回
    //    手势自身姿势且无低层覆写，表现为手势/表情永久粘滞。
    //    刷新必须覆盖「释放淡出窗口」（hasActive || isReleasing）：
    //    stopActive(fade) 置空 activeAction 后动作仍要淡出 fade 秒，期间
    //    PropertyMixer 继续向保存的原始状态混合；若停止刷新，淡出会朝
    //    释放瞬间的过时姿势收敛、真正 stop 时再跳到 Base 实时姿势——
    //    即一次性动作播完回归待机时的卡顿抽搐。
    if (gestureBusy || actionBusy) {
      const baseOwned = this.base.activeBindingKeys();
      if (gestureBusy) this.gesture.refreshOriginalStates(baseOwned);
      if (actionBusy) this.action.refreshOriginalStates(baseOwned);
    }
    this.gesture.update(deltaTime);

    // 4) Action 层：最高优先级，最后应用以覆写全身
    this.action.update(deltaTime);
  }

  // ------------------------------------------------------------------
  // Action 层（全身覆盖，最高优先级）
  // ------------------------------------------------------------------

  /**
   * 播放一个一次性动画（[action:x] 事件）：按注册表里该动画的 layer 路由。
   * - layer='gesture' → Gesture 层：上半身遮罩，只接管上半身骨骼+表情，
   *   下半身继续走 Base 层
   * - 其余（'action'/缺省）→ Action 层：全身覆盖一次性播放
   */
  playOneShot(name: string): boolean {
    return this.animationLayers.get(name) === 'gesture'
      ? this.playGesture(name)
      : this.playAction(name);
  }

  /**
   * 播放一个一次性全身动作（跳舞/后空翻/倒地等，如 performance 段的
   * action 事件）。触发瞬间一键静音 Base 与 Gesture；播完自动释放。
   */
  playAction(name: string): boolean {
    if (!this.action.isBound) return false;
    const vrma = this.animations.get(name);
    if (!vrma) {
      // eslint-disable-next-line no-console
      console.warn(`[Animator] 未找到动作动画: ${name}`);
      return false;
    }

    // 一键静音：冻结低层时间推进，防止覆盖动画之下下肢滑行/手势残留。
    // 手势释放统一走 releaseGesture（0），让姿势快照写回同样生效
    this.base.setMuted(true);
    this.gesture.setMuted(true);
    this.releaseGesture(0);

    this.clearActionWatchdog();
    const ok = this.action.play(name, { loop: false, fade: ACTION_FADE_IN });
    if (ok) {
      this.actionActive = true;
      // 'finished' 事件可能丢失（异常循环配置/零时长）：按动画时长兜底释放
      this.actionWatchdog = window.setTimeout(
        () => this.releaseAction(),
        (vrma.duration + 1) * 1000,
      );
    } else {
      this.unmuteLowerLayers();
    }
    return ok;
  }

  /**
   * 释放 Action 层控制权：动作淡出，Base/Gesture 解除静音并继续。
   * @param fade 淡出时长（秒）；0 = 立即
   */
  releaseAction(fade: number = ACTION_FADE_OUT): void {
    if (!this.actionActive) return;
    this.clearActionWatchdog();
    this.actionActive = false;
    this.action.stopActive(fade);
    this.unmuteLowerLayers();
  }

  // ------------------------------------------------------------------
  // Gesture 层（上半身遮罩）
  // ------------------------------------------------------------------

  /**
   * 播放一个手势/手部动作（握拳、剪刀手、点赞、挥手等）。
   * 只接管上半身（躯干上部/颈/头/肩/臂/手/指 + 表情），下半身继续走 Base 层。
   * Action 层接管期间手势被静音，本次调用直接忽略。
   *
   * 占用时长保证释放（不会永久粘滞）：以 clip 时长为兜底（播完即释放）；
   * 单帧姿势 clip（时长≈0，播完即止看不见）给默认可见保持 GESTURE_POSE_HOLD 秒
   */
  playGesture(name: string): boolean {
    if (this.actionActive) {
      // Action 层全身接管中：手势层被静音，忽略触发
      return false;
    }
    if (!this.gesture.isBound) return false;
    const vrma = this.animations.get(name);
    if (!vrma) {
      // eslint-disable-next-line no-console
      console.warn(`[Animator] 未找到手势动画: ${name}`);
      return false;
    }

    this.clearGestureWatchdog();
    // 新手势接管：取消上一手势未决的写回；并补拍本手势新增轨道的快照
    // （已有快照保留——它指向更早的 Base 姿势，连续手势释放时才能回到 Base
    //   而不是上一个手势的姿势）
    this.clearGestureRestoreTimer();
    this.captureGesturePose(vrma);
    const ok = this.gesture.play(name, { loop: false, fade: GESTURE_FADE_IN });
    if (ok) {
      // 兜底计时：'finished' 事件丢失/clip 时长异常长时也按时释放
      const hold =
        vrma.duration <= POSE_CLIP_THRESHOLD
          ? GESTURE_POSE_HOLD
          : vrma.duration + GESTURE_FADE_OUT + 0.1;
      this.gestureWatchdog = window.setTimeout(() => this.releaseGesture(), hold * 1000);
      // eslint-disable-next-line no-console
      console.log(
        `[Animator r3] 手势 "${name}" (clip ${vrma.duration.toFixed(2)}s, ` +
          `保持 ${hold.toFixed(2)}s)` +
          ` [Base 当前: "${this.base.currentClipName ?? '-'}"]`,
      );
    }
    return ok;
  }

  /** 释放 Gesture 层：手势淡出，上半身交还 Base 层与程序化表情层 */
  releaseGesture(fade: number = GESTURE_FADE_OUT): void {
    this.clearGestureWatchdog();
    if (this.gesture.hasActive) {
      // r3 标记：确认本版代码在运行（排除 HMR/缓存的旧版本）
      // eslint-disable-next-line no-console
      console.log(
        `[Animator r3] 手势释放 "${this.gesture.currentClipName ?? '?'}"` +
          ` [Base 当前: "${this.base.currentClipName ?? '-'}"]`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log('[Animator r3] 手势释放请求：手势层已无活动动作（此前已释放）');
    }
    this.gesture.stopActive(fade);
    // 构造性复位（r4）：淡出与层内 stop 完成后，强制把激活前快照写回
    // normalized 骨骼与表情 weight——不依赖 PropertyMixer 的还原路径。
    // 共享骨骼随后会被 Base 层逐帧覆写，写回值只对独占属性（手指/表情）
    // 起最终定格作用。
    this.scheduleGestureRestore(fade);
  }

  // ------------------------------------------------------------------
  // Base 层待机覆盖（[idle:x] sticky）
  // ------------------------------------------------------------------

  /**
   * 切换 Base 层动画变体（sticky，直到下一次 setIdle）。
   * 已绑定模型且名称变化时立即交叉淡化到目标动画；传 null 恢复默认待机。
   */
  setIdle(name: string | null): boolean {
    if (name !== null && !this.animations.has(name)) {
      // eslint-disable-next-line no-console
      console.warn(`[Animator] 未找到待机动画: ${name}`);
      return false;
    }
    const changed = this.idleOverrideName !== name;
    this.idleOverrideName = name;
    if (changed && this.base.isBound) {
      const clip = this.resolveIdleClip();
      if (clip) this.base.play(clip, { loop: true });
    }
    return true;
  }

  // ------------------------------------------------------------------
  // 兼容入口（供表演调度层调用）
  // ------------------------------------------------------------------

  /**
   * 回归待机：释放 Action 与 Gesture 覆盖。
   * Base 层常驻播放待机动画，覆盖释放后自然显形。
   */
  returnToIdle(): void {
    this.releaseAction(ACTION_FADE_OUT);
    this.releaseGesture(GESTURE_FADE_OUT);
  }

  dispose(): void {
    this.clearWatchdogs();
    this.clearGestureRestoreTimer();
    this.gestureBoneSnapshot.clear();
    this.gestureExpressionSnapshot.clear();
    this.additiveChannels.length = 0;
    this.base.dispose();
    this.gesture.dispose();
    this.action.dispose();
    this.animations.clear();
    this.vrm = null;
    this.root = null;
  }

  // ------------------------------------------------------------------
  // Base 层待机解析
  // ------------------------------------------------------------------

  /**
   * 解析当前应播放的 Base 动画名：[idle:x] 覆盖 → layer=idle 声明的默认待机
   * → 命名约定 'idle' → 首个动画。解析不到返回 null。
   */
  private resolveIdleClip(): string | null {
    if (this.idleOverrideName && this.animations.has(this.idleOverrideName)) {
      return this.idleOverrideName;
    }
    if (this.animations.has(this.defaultIdleName)) return this.defaultIdleName;
    if (this.animations.has('idle')) return 'idle';
    return this.animations.keys().next().value ?? null;
  }

  // ------------------------------------------------------------------
  // 内部工具
  // ------------------------------------------------------------------

  private unmuteLowerLayers(): void {
    this.base.setMuted(false);
    this.gesture.setMuted(false);
  }

  private clearActionWatchdog(): void {
    if (this.actionWatchdog !== null) {
      window.clearTimeout(this.actionWatchdog);
      this.actionWatchdog = null;
    }
  }

  private clearGestureWatchdog(): void {
    if (this.gestureWatchdog !== null) {
      window.clearTimeout(this.gestureWatchdog);
      this.gestureWatchdog = null;
    }
  }

  // ------------------------------------------------------------------
  // 手势姿势快照（构造性复位，r4）
  // ------------------------------------------------------------------

  /**
   * 拍手势激活前的姿势快照。只快照该手势 clip 实际驱动、且属于 Gesture
   * 遮罩的骨骼，以及它驱动的表情轨道。
   * 已有同名快照时保留旧值（见 playGesture 调用处的说明）。
   */
  private captureGesturePose(vrma: VRMAnimation): void {
    const humanoid = this.vrm?.humanoid;
    if (humanoid) {
      for (const bone of vrma.humanoidTracks.rotation.keys()) {
        if (!GESTURE_BONES.has(bone) || this.gestureBoneSnapshot.has(bone)) continue;
        const node = humanoid.getNormalizedBoneNode(bone);
        if (node) this.gestureBoneSnapshot.set(bone, node.quaternion.clone());
      }
    }
    const manager = this.vrm?.expressionManager;
    if (manager) {
      for (const name of vrma.expressionTracks.preset.keys()) {
        this.snapshotExpression(manager.getExpression(name), name);
      }
      for (const name of vrma.expressionTracks.custom.keys()) {
        this.snapshotExpression(manager.getExpression(name), name);
      }
    }
  }

  private snapshotExpression(
    expression: { weight: number } | null | undefined,
    name: string,
  ): void {
    if (!expression || this.gestureExpressionSnapshot.has(name)) return;
    this.gestureExpressionSnapshot.set(name, expression.weight);
  }

  /**
   * 安排快照写回：fade>0 时略晚于 MixerLayer 的停止定时器
   * （fade*1000+60ms），确保本层内部还原（无论写了什么）之后，
   * 由写回值最终定格；fade=0 时同步执行。
   */
  private scheduleGestureRestore(fade: number): void {
    this.clearGestureRestoreTimer();
    if (this.gestureBoneSnapshot.size === 0 && this.gestureExpressionSnapshot.size === 0) {
      return;
    }
    const apply = (): void => {
      this.gestureRestoreTimer = null;
      this.restoreGesturePose();
    };
    if (fade > 0) {
      this.gestureRestoreTimer = window.setTimeout(apply, fade * 1000 + 120);
    } else {
      apply();
    }
  }

  /** 把激活前快照强制写回（写 normalized 骨骼，VRMHumanoid.update 会拷回原骨骼）。
   *  r6：只写回「无低层驱动」的独占骨骼与表情。被 Base（idle）驱动的骨骼
   *  在释放淡出中已收敛到 Base 实时姿势（refreshOriginalStates），且随后会被
   *  Base 逐帧覆写——写回数秒前的快照只会在覆写生效前的间隙闪出过期姿势
   *  （实测整套手部+颈部 ~14° 的偶发抽搐，正是动作结束回归待机时跳变的根因）。 */
  private restoreGesturePose(): void {
    const humanoid = this.vrm?.humanoid;
    const baseOwned = this.base.activeBindingKeys();
    const rootUuid = this.root?.uuid ?? '?';
    let skippedOwned = 0;
    if (humanoid) {
      for (const [bone, quaternion] of this.gestureBoneSnapshot) {
        const node = humanoid.getNormalizedBoneNode(bone);
        if (!node) continue;
        if (baseOwned.has(`${rootUuid}|${node.name}.quaternion`)) {
          skippedOwned++;
          continue; // Base 驱动的骨骼：保持淡出收敛到的实时姿势，不写回过期快照
        }
        node.quaternion.copy(quaternion);
      }
    }
    const manager = this.vrm?.expressionManager;
    if (manager) {
      for (const [name, weight] of this.gestureExpressionSnapshot) {
        const expression = manager.getExpression(name);
        if (expression) expression.weight = weight;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[Animator r6] 姿势快照写回：独占骨骼 ` +
        `${this.gestureBoneSnapshot.size - skippedOwned}、` +
        `跳过（Base 驱动）${skippedOwned}、` +
        `表情 ${this.gestureExpressionSnapshot.size}`,
    );
    this.gestureBoneSnapshot.clear();
    this.gestureExpressionSnapshot.clear();
  }

  private clearGestureRestoreTimer(): void {
    if (this.gestureRestoreTimer !== null) {
      window.clearTimeout(this.gestureRestoreTimer);
      this.gestureRestoreTimer = null;
    }
  }

  private clearWatchdogs(): void {
    this.clearActionWatchdog();
    this.clearGestureWatchdog();
  }
}

/**
 * 表情驱动层（粘合 Soullink FaceEngine 与本项目场景）。
 *
 * 职责：
 * - 拥有 FaceEngine（headless 情绪引擎）：triggerEmotion(emotion, intensity)
 *   → 每帧输出 AU / 头部姿态 / 视线偏移 / 眨眼（120Hz 定步长积分）
 * - 面部写入：按 morphProfile 把 AU 解析为模型 morph 直写（post vrm.update，
 *   覆盖优先级最高）；模型不支持时回退 VRM 预设表情（happy/angry/sad/...）
 * - 口型：接收五元音权重，解析为嘴部 morph 直写；说话时按口型开合度下调
 *   「口型闸门」，压低情绪嘴部 AU，避免与口型 morph 叠加穿模（沿用旧设计）
 * - 头部姿态：情绪/idle 微动的头部角度以**乘法偏移**叠加在 VRMA 关键帧
 *   之上（bone.quaternion = mixer 输出 × 情绪偏移），与四层动画正交；
 *   每帧先还原上一帧偏移再重新叠加，无 VRMA 头部轨道时也不会累积
 * - 视线：lookAt 关闭 autoUpdate，每帧手算「注视目标（摄像机）方向角 +
 *   情绪视线偏移」写入 yaw/pitch（bone applier 的 rangeMap 归一为恒等，
 *   角度即真实角度）
 *
 * 帧内调用顺序（由 useVRMScene 编排）：
 *   prepareHead() → animator.update(dt) → applyHead() → vrm.update(dt) → applyFace()
 */

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { LipSyncWeights, VowelPreset } from '@/types/lipsync';
import { FaceEngine, actionUnitDefinitions, type FrameState, type FACSActionUnitState } from './engine';
import { emotionByName } from './emotions';
import { computeMorphWeights, resolveProfile, bindingProfiles, MOUTH_AU_RE, type ResolvedBinding } from './morphProfile';
import { type EyeAngles } from './directions';

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/** 口型对情绪嘴部的抑制系数：maxLip=1 时闸门降到下限 */
const LIP_EMOTION_SUPPRESS = 0.7;
/** 情绪嘴部权重下限（说话最开口时保留的比例） */
const EMOTION_GATE_MIN = 0.3;

/** 五元音 → 模型嘴部 morph 候选名（按命中优先级排列：
 *  VRM 预设名 → VRoid Fcl 命名 → VRChat viseme → romaji 自定义 → MMD 日文） */
const VOWEL_MORPH_CANDIDATES: Record<VowelPreset, string[]> = {
  aa: ['aa', 'Fcl_MTH_A', 'Face.M_F00_000_Fcl_MTH_A', 'vrc.v_aa', 'mouth_a', 'あ', 'jawOpen', 'mouthOpen'],
  ih: ['ih', 'Fcl_MTH_I', 'Face.M_F00_000_Fcl_MTH_I', 'vrc.v_ih', 'mouth_i', 'い'],
  ou: ['ou', 'Fcl_MTH_U', 'Face.M_F00_000_Fcl_MTH_U', 'vrc.v_ou', 'mouth_u', 'う', 'mouthPucker'],
  ee: ['ee', 'Fcl_MTH_E', 'Face.M_F00_000_Fcl_MTH_E', 'vrc.v_e', 'mouth_e', 'え'],
  oh: ['oh', 'Fcl_MTH_O', 'Face.M_F00_000_Fcl_MTH_O', 'vrc.v_oh', 'mouth_o', 'お'],
};

/** faceDriver 依赖的最小表情管理器接口 */
interface FaceExpressionManager {
  setValue(name: string, weight: number): void;
  expressionMap?: Record<string, unknown>;
}

/** 情绪状态快照（供 UI 展示：主导情绪 + 当前/目标 VAD） */
export interface FaceEmotionState {
  /** 引擎判定的主导情绪名（中性时为 'neutral'） */
  dominant: string;
  /** 当前 VAD（平滑过渡中的实际值，-1~1） */
  current: { valence: number; arousal: number; dominance: number };
  /** 目标 VAD（情绪触发后收敛目标） */
  target: { valence: number; arousal: number; dominance: number };
}

export interface FaceDriver {
  /** 绑定模型：收集 morph 网格、解析绑定、接管 lookAt。模型切换时可重复调用 */
  configure(vrm: VRM | null, gazeTarget?: THREE.Object3D | null): void;
  /** 触发情绪（24 词表外的名字回退 neutral）；intensity 0~1 */
  setEmotion(emotion: string, intensity?: number): void;
  /** 设置五元音口型权重（wLipSync 驱动） */
  setLipWeights(weights: Partial<LipSyncWeights>): void;
  /** 复位口型权重（闸门回升） */
  resetLipWeights(): void;
  /** 推进引擎（每帧调用；内部 120Hz 定步长） */
  update(dt: number): void;
  /** animator.update 之前调用：还原上一帧的头部姿态偏移 */
  prepareHead(): void;
  /** animator.update 之后、vrm.update 之前调用：叠加本帧头部姿态偏移并写入视线 */
  applyHead(): void;
  /** vrm.update 之后调用：写入面部 morph（直写优先，预设回退） */
  applyFace(): void;
  /** 读取情绪状态快照（VAD 实时值，供 UI 展示）；未绑定模型时为 null */
  readState(): FaceEmotionState | null;
  /** 清空全部状态（模型卸载） */
  reset(): void;
}

export function useFaceDriver(): FaceDriver {
  // ambient: VAD 环境微幅随机漂移 → 传导为视线/表情的自然起伏
  const engine = new FaceEngine({ ambient: true });

  // ---- 模型绑定状态 ----
  let vrm: VRM | null = null;
  /** 含 morph target 的网格列表 */
  let morphMeshes: THREE.Mesh[] = [];
  /** 模型全部 morph 名集合 */
  let morphNames = new Set<string>();
  /** 解析后的 AU 绑定 */
  let bindings: ResolvedBinding[] = [];
  /** 绑定命中数过低 → 走 VRM 预设表情回退 */
  let fallback = true;
  /** 直写前需先还原的 morph 名 → 上一帧值 */
  let lastWeights: Record<string, number> = {};
  /** 各元音解析到的 morph 名 */
  const vowelMorphs = new Map<VowelPreset, string>();
  /** gaze 注视目标（摄像机或测试球），由场景层注入 */
  let gazeTarget: THREE.Object3D | null = null;

  // ---- 头部姿态偏移 ----
  /** 上一帧叠加偏移前的 head 骨骼四元数（还原基准） */
  const headBaseQuat = new THREE.Quaternion();
  let headBaseSaved = false;

  // ---- 视线基准 ----
  /** +Z 到模型正面方向的基变换（VRM1 +Z / VRM0 -Z） */
  const faceBasis = new THREE.Quaternion();
  const faceBasisInverse = new THREE.Quaternion();

  // ---- 口型 ----
  const lipWeights: LipSyncWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  /** 口型闸门（平滑值与目标值） */
  let mouthGate = 1;
  let mouthGateTarget = 1;
  const GATE_SMOOTH_RATE = 12;

  let frame: FrameState | null = null;

  // 复用向量（避免每帧分配）
  const tmpVec = new THREE.Vector3();
  const tmpVec2 = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpQuat2 = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  function setEmotion(emotion: string, intensity = 0.85): void {
    // 24 词表外回退 neutral（与后端 parse 行为一致）
    const name = emotionByName.has(emotion) ? emotion : 'neutral';
    try {
      engine.triggerEmotion(name, clamp01(intensity));
    } catch {
      engine.triggerEmotion('neutral', clamp01(intensity));
    }
  }

  function setLipWeights(weights: Partial<LipSyncWeights>): void {
    let maxLip = 0;
    (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
      const v = weights[key];
      if (v === undefined) return;
      lipWeights[key] = clamp01(v);
      if (lipWeights[key] > maxLip) maxLip = lipWeights[key];
    });
    // 口型开合度越大 → 情绪嘴部闸门越低（抑制穿模）
    mouthGateTarget = Math.max(EMOTION_GATE_MIN, 1 - maxLip * LIP_EMOTION_SUPPRESS);
  }

  function resetLipWeights(): void {
    (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
      lipWeights[key] = 0;
    });
    mouthGateTarget = 1;
  }

  function update(dt: number): void {
    // 闸门指数平滑（约 0.1s 收敛）
    mouthGate += (mouthGateTarget - mouthGate) * Math.min(1, dt * GATE_SMOOTH_RATE);
    frame = engine.update(dt);
  }

  function headNode(): THREE.Object3D | null {
    return vrm?.humanoid.getNormalizedBoneNode('head') ?? null;
  }

  function prepareHead(): void {
    const node = headNode();
    if (node && headBaseSaved) {
      // 还原上一帧偏移：animator/mixer 本帧将重新写入骨骼（有关键帧轨道时），
      // 无轨道时骨骼保持还原值，偏移不会逐帧累积
      node.quaternion.copy(headBaseQuat);
    }
  }

  function applyHead(): void {
    const node = headNode();
    if (!node || !frame) return;
    // 保存 mixer 输出（叠加前基准）
    headBaseQuat.copy(node.quaternion);
    headBaseSaved = true;
    // 情绪头部角度（+yaw 左 / +pitch 上 / +roll 左倾，度）
    const head = frame.angles.head;
    if (head.yaw !== 0 || head.pitch !== 0 || head.roll !== 0) {
      tmpEuler.set(
        -THREE.MathUtils.degToRad(head.pitch),
        THREE.MathUtils.degToRad(head.yaw),
        -THREE.MathUtils.degToRad(head.roll),
        'YXZ',
      );
      tmpQuat.setFromEuler(tmpEuler);
      // 基变换到模型面朝向（VRM0 -Z / VRM1 +Z），再以乘法偏移叠加在关键帧之上
      tmpQuat2.copy(faceBasis).multiply(tmpQuat).multiply(faceBasisInverse);
      node.quaternion.multiply(tmpQuat2);
    }
    applyGaze();
  }

  /** 计算视线角度并写入 lookAt（度）。
   *
   * 基础角度完全复用官方 `VRMLookAt.lookAt(worldPos)`：它在静息头部坐标系
   * 中按 faceFront 计算 yaw/pitch，并尊重模型作者调好的 rangeMap 响应曲线
   * （这决定了「眼球实际转多少」，手算 + 恒等 rangeMap 会导致幅度失控）。
   * 官方算完后读回角度，仅叠加情绪视线偏移（gazeX/gazeY AU）：
   * three-vrm 约定 yaw 正=向左、pitch 正=向下；本项目引擎约定两者正=左/上，
   * 故 yaw 直接相加、pitch 取负相加。
   */
  function applyGaze(): void {
    const lookAt = vrm?.lookAt;
    if (!lookAt || !frame) return;
    // 官方计算：注视目标方向 → 静息头坐标系角度（含 rangeMap 前的原值）
    lookAt.lookAt(gazeTarget ? gazeTarget.getWorldPosition(tmpVec) : tmpVec.set(0, 0, 0));
    const eyes: EyeAngles = frame.angles.eyes;
    lookAt.yaw = lookAt.yaw + eyes.yaw;
    lookAt.pitch = lookAt.pitch - eyes.pitch;
  }

  /** 口型闸门作用后的 AU（嘴部 AU × gate，其余不变） */
  function gatedAus(): FACSActionUnitState {
    const aus = { ...frame!.aus } as FACSActionUnitState;
    if (mouthGate >= 0.999) return aus;
    for (const definition of actionUnitDefinitions) {
      if (MOUTH_AU_RE.test(definition.key)) {
        aus[definition.key] = (aus[definition.key] ?? 0) * mouthGate;
      }
    }
    return aus;
  }

  /** 面部写入：直写 morph 优先；绑定命中不足时回退 VRM 预设表情 */
  function applyFace(): void {
    if (!vrm || !frame) return;
    const manager = (vrm.expressionManager ?? null) as (FaceExpressionManager | null);

    // 口型闸门作用后的 AU
    const aus = gatedAus();

    // 口型权重 → morph（与情绪嘴部 morph 冲突时取 max：闸门已压低情绪侧）
    const lipMorphWeights: Record<string, number> = {};
    if (!fallback) {
      for (const [vowel, morph] of vowelMorphs) {
        const w = lipWeights[vowel];
        if (w > 0) lipMorphWeights[morph] = Math.max(lipMorphWeights[morph] ?? 0, w);
      }
    }

    if (fallback && manager) {
      // 回退：VRM 预设表情（先清零，避免与上一帧残留叠加）
      for (const key of Object.keys(manager.expressionMap ?? {})) manager.setValue(key, 0);
      manager.setValue('happy', clamp01(aus.au12LipCornerPuller * 1.2));
      manager.setValue('angry', clamp01(aus.au04BrowLowerer));
      manager.setValue('sad', clamp01(Math.max(aus.au01InnerBrowRaiser, aus.au15LipCornerDepressor)));
      manager.setValue('surprised', clamp01(aus.au05UpperLidRaiser));
      manager.setValue('relaxed', clamp01(frame.details.eyelidRelaxation * 2));
      manager.setValue('blink', clamp01(aus.au45Blink));
      // 口型走预设元音表情
      (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
        manager.setValue(key, lipWeights[key]);
      });
      return;
    }

    // 直写：情绪 morph（对比度增强，与 Soullink viewer.render 一致）
    const contrast = Math.max(0, (frame.settings.gain - 1) / 3) * 1.5;
    const weights = computeMorphWeights(aus, bindings, {}, { contrast });
    // 合成口型（取 max）
    for (const [name, w] of Object.entries(lipMorphWeights)) {
      weights[name] = Math.max(weights[name] ?? 0, w);
    }

    // 还原上一帧写过、本帧不再写的 morph；写入本帧权重（覆盖 expressionManager 输出）
    for (const name of Object.keys(lastWeights)) {
      if (!(name in weights)) setMorphInfluence(name, 0);
    }
    for (const [name, value] of Object.entries(weights)) {
      setMorphInfluence(name, value);
    }
    lastWeights = weights;
  }

  function setMorphInfluence(name: string, value: number): void {
    for (const mesh of morphMeshes) {
      const dict = mesh.morphTargetDictionary as Record<string, number> | undefined;
      const index = dict?.[name];
      if (index === undefined) continue;
      const influences = mesh.morphTargetInfluences;
      if (influences) influences[index] = value;
    }
  }

  function configure(next: VRM | null, target: THREE.Object3D | null = null): void {
    reset();
    vrm = next;
    gazeTarget = target;
    if (!next) return;

    // faceBasis：+Z → 模型正前方
    const front = next.lookAt?.faceFront ?? new THREE.Vector3(0, 0, next.meta.metaVersion === '0' ? -1 : 1);
    faceBasis.setFromUnitVectors(new THREE.Vector3(0, 0, 1), front.clone().normalize());
    faceBasisInverse.copy(faceBasis).invert();

    // 接管 lookAt：关闭 autoUpdate / 清空 target，每帧手动驱动（applyGaze）。
    // 注意：不修改 rangeMap——它是模型作者调好的视线响应曲线（大角度输入 →
    // 适度眼球转动）；改成恒等映射会导致眼球转动幅度远超模型设计（过大）
    const lookAt = next.lookAt;
    if (lookAt) {
      lookAt.autoUpdate = false;
      lookAt.target = null;
    }

    // 收集 morph 网格与名称
    morphMeshes = [];
    morphNames = new Set();
    next.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const dict = mesh.morphTargetDictionary as Record<string, number> | undefined;
      if (!dict) return;
      morphMeshes.push(mesh);
      for (const name of Object.keys(dict)) morphNames.add(name);
    });

    // 解析 AU 绑定：多本命名方言词典竞标——各完整 resolve 一遍，取命中数
    // （supported 绑定数）最多者；谁解释该模型更好就信谁，保证每个模型由
    // 一套自洽的命名方言驱动。最好的一本命中仍 <4 → 预设表情回退
    let boundProfileName = '';
    let bestCount = -1;
    for (const profile of bindingProfiles) {
      const resolved = resolveProfile(profile, morphNames);
      const count = resolved.filter((b) => b.supported).length;
      if (count > bestCount) {
        bestCount = count;
        bindings = resolved;
        boundProfileName = profile.name;
      }
    }
    fallback = bestCount < 4;

    // 解析元音口型 morph
    vowelMorphs.clear();
    if (!fallback) {
      for (const [vowel, candidates] of Object.entries(VOWEL_MORPH_CANDIDATES) as [VowelPreset, string[]][]) {
        const found = candidates.find((n) => morphNames.has(n));
        if (found) vowelMorphs.set(vowel, found);
      }
      // 全部元音都未命中时也回退（口型走预设表情）
      if (vowelMorphs.size === 0) fallback = true;
    }

    // eslint-disable-next-line no-console
    console.log('[FaceDriver] 模型绑定完成', {
      profile: boundProfileName,
      morphs: morphNames.size,
      supportedBindings: bestCount,
      fallback,
      vowels: [...vowelMorphs.keys()],
    });
  }

  function readState(): FaceEmotionState | null {
    if (!frame) return null;
    return {
      dominant: frame.vad.dominantEmotion ?? 'neutral',
      current: { ...frame.vad.current },
      target: { ...frame.vad.target },
    };
  }

  function reset(): void {
    // 还原直写过的 morph
    for (const name of Object.keys(lastWeights)) setMorphInfluence(name, 0);
    lastWeights = {};
    engine.reset();
    frame = null;
    vrm = null;
    gazeTarget = null;
    morphMeshes = [];
    morphNames = new Set();
    bindings = [];
    fallback = true;
    vowelMorphs.clear();
    headBaseSaved = false;
    mouthGate = 1;
    mouthGateTarget = 1;
    (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
      lipWeights[key] = 0;
    });
  }

  return {
    configure,
    setEmotion,
    setLipWeights,
    resetLipWeights,
    update,
    prepareHead,
    applyHead,
    applyFace,
    readState,
    reset,
  };
}

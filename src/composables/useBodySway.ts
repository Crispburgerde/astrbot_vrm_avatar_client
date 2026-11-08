/**
 * 说话摆动动画层（身体 + 头部）。
 *
 * 作为自主的生命感动画层，独立于 VRMA / 表情 / 口型 / 眨眼 / 呼吸驱动，互不干扰。
 * 仅在角色说话（音量 > 0）时生效，安静时自动归零，不影响 idle / 呼吸等基础动画。
 *
 * 实现原理（Offset 节点隔离法，与 useBreath 一致）：
 * 1. 在 spine（或 chest 回退）/ head 骨骼的各自父级，强行插入一个 identity 偏移节点。
 *    插入后各原骨骼的世界变换完全不变。
 * 2. VRMA 动画继续控制各原骨骼（每帧由 vrm.update() 写入局部变换）。
 * 3. 摆动代码只改写偏移节点：身体做轻微偏航/俯仰、头部做点头/摇头/侧倾。
 *
 * 由于 3D 引擎最终世界矩阵 = 父矩阵 × 子矩阵，VRMA / 呼吸 / 摆动经父子相乘自然叠加。
 *
 * 生动摆动设计（音量驱动 + 惯性衰减 + 多频正弦合成）：
 * - 入参 audioLevel（0~1）：由表演层每帧从 wLipSync 归一化音量传入。
 * - intensity：对 audioLevel 做"非对称包络跟随"（起音快、释放慢，均按 dt 归一化），
 *   实现"说话即动、停语渐止"的惯性；较长的释放时间常数同时滤除音节级（2~8Hz）
 *   的音量抖动，避免摆动幅度随每个字泵动造成的碎感。
 * - 多频正弦合成：每个轴向叠加 2 条不同频率/相位的正弦波（主频 + 谐波）。
 *   身体主项权重 0.7、谐波 0.3；头部刻意降频（主频 0.28~0.45 Hz）并减弱谐波
 *   （主项 0.85、谐波 0.15），高频小幅正弦叠加在视觉上是"碎抖"的主要来源。
 * - 身体 spine：缓慢左右偏航（Y）+ 轻微俯仰（X），幅度由 bodyAmplitude × intensity 驱动。
 * - 头部 head：舒缓的点头（X）+ 摇头（Y）+ 侧倾（Z，幅度减半避免夸张）。
 *
 * 与呼吸的叠加：useBreath 在 chest / head 上各插入了一个偏移节点；本层配置时，
 * spine 的父级仍是原始父级（无冲突），head 的父级已是 Head_Breath_Offset，本层在其下再插入
 * Head_BodySway_Offset，形成 Head_Breath_Offset → Head_BodySway_Offset → head，
 * 两个偏移节点各自的旋转经矩阵相乘自然叠加，互不覆盖。
 *
 * 参考：s3lab「音量連動アニメーションの実装」（Speaking Decay + 多層サイン波合成 + ボーン連動）
 */

import * as THREE from 'three';

/** useBodySway 依赖的最小人形骨骼接口（解耦 three-vrm 具体类型） */
export interface BodySwayHumanoid {
  getRawBoneNode(name: string): THREE.Object3D | null;
}

/** 摆动参数 */
export interface BodySwayOptions {
  /**
   * 身体摆动幅度（弧度），默认 0.03（≈ 1.7°）。
   * 控制身体 spine/chest 的偏航（Y）与俯仰（X）峰值。
   * 实际生效幅度 = 该值 × intensity（音量驱动 0~1）。
   */
  bodyAmplitude?: number;
  /**
   * 头部摆动幅度（弧度），默认 0.05（≈ 2.9°）。
   * 控制头部点头（X）/ 摇头（Y）/ 侧倾（Z）峰值，相对身体更活泼。
   * 实际生效幅度 = 该值 × intensity（音量驱动 0~1）。
   */
  headAmplitude?: number;
  /**
   * 起音时间常数（秒），默认 0.15。
   * audioLevel 高于当前强度时（开始说话），intensity 以该时间常数快速上冲，
   * 保证"开口即动"的响应感。
   */
  attackTime?: number;
  /**
   * 释放时间常数（秒），默认 0.6。
   * audioLevel 低于当前强度时（停语或音量回落），intensity 以该时间常数缓慢回落，
   * 形成惯性余韵；较长的时间常数同时滤除音节级（2~8Hz）音量抖动，
   * 避免摆动幅度随每个字泵动。两个时间常数均按 dt 归一化，与帧率无关。
   */
  releaseTime?: number;
}

export interface BodySwayController {
  /** 每帧驱动摆动：推进相位并写入各偏移节点的旋转 */
  update(dt: number): void;
  /**
   * 绑定到 VRM 人形骨骼：定位 spine（或 chest 回退）+ head，
   * 在各自父级插入偏移节点。返回是否至少成功绑定身体或头部之一。
   */
  configure(
    humanoid: BodySwayHumanoid | null | undefined,
    options?: BodySwayOptions,
  ): boolean;
  /** 运行时调整参数（仅覆盖显式传入的字段），用于控制面板滑块实时调节 */
  setOptions(options: BodySwayOptions): void;
  /** 设置当前音量（0~1），由表演层每帧从 wLipSync 归一化音量传入 */
  setAudioLevel(level: number): void;
  /** 清空引用（模型卸载 / 切换时调用，整体模型会被外部释放，无需还原层级） */
  reset(): void;
}

/** 偏移节点名，便于调试与识别 */
const BODY_NODE_NAME = 'Spine_BodySway_Offset';
const HEAD_NODE_NAME = 'Head_BodySway_Offset';

// ---- 角频率（rad/s）= 频率(Hz) × 2π ----
// 身体：缓慢、沉稳，周期 1.5~2.5s
const BODY_YAW_W1 = 0.6 * Math.PI * 2; // 0.6 Hz 主频
const BODY_YAW_W2 = 1.1 * Math.PI * 2; // 1.1 Hz 谐波（打破单一节拍）
const BODY_PITCH_W = 0.45 * Math.PI * 2; // 0.45 Hz 俯仰（更慢的起伏）
// 头部：舒缓、克制（周期 2.2~3.6s）。高频小幅正弦叠加在视觉上呈现为"碎抖"，
// 故刻意把主频降到 0.45Hz 以下，并减弱谐波权重。
const HEAD_NOD_W1 = 0.45 * Math.PI * 2; // 0.45 Hz 点头主频（周期 ≈ 2.2s）
const HEAD_NOD_W2 = 0.9 * Math.PI * 2; // 谐波
const HEAD_TURN_W = 0.35 * Math.PI * 2; // 0.35 Hz 摇头
const HEAD_TILT_W = 0.28 * Math.PI * 2; // 0.28 Hz 侧倾（最慢）

/**
 * 在 child 的父级与 child 之间插入一个 identity 偏移节点。
 * 插入后 parent → offset → child，且 child 的世界变换保持不变。
 */
function insertOffsetNode(
  parent: THREE.Object3D,
  child: THREE.Object3D,
  name: string,
): THREE.Object3D {
  const offset = new THREE.Object3D();
  offset.name = name;
  parent.remove(child);
  parent.add(offset);
  offset.add(child);
  // 立即刷新世界矩阵，避免模型加载后首帧出现一帧抖动
  offset.updateWorldMatrix(true, true);
  return offset;
}

export function useBodySway(initial?: BodySwayOptions): BodySwayController {
  let bodyOffset: THREE.Object3D | null = null;
  let headOffset: THREE.Object3D | null = null;

  let bodyAmp = initial?.bodyAmplitude ?? 0.03;
  let headAmp = initial?.headAmplitude ?? 0.05;
  let attackTime = initial?.attackTime ?? 0.15;
  let releaseTime = initial?.releaseTime ?? 0.6;

  // 当前音量（0~1，由 setAudioLevel 写入）
  let audioLevel = 0;
  // 平滑后的强度（惯性衰减），实际驱动摆动幅度
  let intensity = 0;
  // 时间累加（秒），赋予随机初始相位避免每次加载都从同一刻起
  let t = Math.random() * 10;

  /** 合并参数（仅覆盖显式传入的字段）。configure 与 setOptions 共用 */
  function applyOptions(opts: BodySwayOptions): void {
    if (opts.bodyAmplitude !== undefined) bodyAmp = opts.bodyAmplitude;
    if (opts.headAmplitude !== undefined) headAmp = opts.headAmplitude;
    if (opts.attackTime !== undefined) attackTime = opts.attackTime;
    if (opts.releaseTime !== undefined) releaseTime = opts.releaseTime;
  }

  function configure(
    humanoid: BodySwayHumanoid | null | undefined,
    opts?: BodySwayOptions,
  ): boolean {
    // 先丢弃上一次的引用（模型切换场景）
    bodyOffset = null;
    headOffset = null;
    intensity = 0;

    if (opts) applyOptions(opts);
    if (!humanoid) return false;

    // 身体：优先 spine（整段躯干摆动，效果更自然），缺失则回退 chest
    const spine = humanoid.getRawBoneNode('spine');
    const chest = humanoid.getRawBoneNode('chest');
    const bodyBone = spine ?? chest;
    if (bodyBone && bodyBone.parent) {
      bodyOffset = insertOffsetNode(bodyBone.parent, bodyBone, BODY_NODE_NAME);
    }

    // 头部（用于点头/摇头/侧倾）
    const head = humanoid.getRawBoneNode('head');
    if (head && head.parent) {
      headOffset = insertOffsetNode(head.parent, head, HEAD_NODE_NAME);
    }

    const ok = bodyOffset !== null || headOffset !== null;
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn(
        '[BodySway] 该模型不含 spine/chest/head 骨骼，说话摆动未启用',
      );
    }
    return ok;
  }

  function setOptions(opts: BodySwayOptions): void {
    applyOptions(opts);
  }

  function setAudioLevel(level: number): void {
    const v = level < 0 ? 0 : level > 1 ? 1 : level;
    audioLevel = v;
  }

  function update(dt: number): void {
    if (!bodyOffset && !headOffset) return;

    // 非对称包络跟随（dt 归一化，帧率无关）：起音快、释放慢。
    // - audioLevel 高于 intensity（开始说话）时以 attackTime 快速上冲，"开口即动"；
    // - 低于时以 releaseTime 缓慢回落，既形成停语余韵，又滤除音节级（2~8Hz）
    //   音量抖动，避免摆动幅度随每个字泵动造成碎感。
    const tau =
      audioLevel > intensity
        ? Math.max(attackTime, 1e-4)
        : Math.max(releaseTime, 1e-4);
    intensity += (audioLevel - intensity) * (1 - Math.exp(-dt / tau));
    if (intensity < 0.001) {
      intensity = 0;
      // 静止时直接清零偏移，避免残留微小旋转
      if (bodyOffset) {
        bodyOffset.rotation.x = 0;
        bodyOffset.rotation.y = 0;
      }
      if (headOffset) {
        headOffset.rotation.x = 0;
        headOffset.rotation.y = 0;
        headOffset.rotation.z = 0;
      }
      return;
    }

    t += dt;

    // ---- 身体：缓慢左右偏航（Y）+ 轻微俯仰（X），多频正弦合成 ----
    if (bodyOffset) {
      // Y 偏航：主频 0.6Hz + 谐波 1.1Hz（相位错开）
      const yaw =
        Math.sin(t * BODY_YAW_W1) * 0.7 +
        Math.sin(t * BODY_YAW_W2 + 0.6) * 0.3;
      // X 俯仰：更慢的呼吸般起伏，幅度约为偏航的一半
      const pitch =
        (Math.sin(t * BODY_PITCH_W + 0.3) +
          0.3 * Math.sin(t * BODY_YAW_W2 * 0.9)) *
        0.5;
      bodyOffset.rotation.y = yaw * bodyAmp * intensity;
      bodyOffset.rotation.x = pitch * bodyAmp * 0.5 * intensity;
    }

    // ---- 头部：舒缓的点头（X）/ 摇头（Y）/ 侧倾（Z），主项 0.85 + 弱谐波 0.15 ----
    if (headOffset) {
      // X 点头：主频 0.45Hz（周期 ≈ 2.2s）+ 弱谐波
      const nod =
        Math.sin(t * HEAD_NOD_W1) * 0.85 +
        Math.sin(t * HEAD_NOD_W2 + 1.0) * 0.15;
      // Y 摇头：略慢于点头，相位错开
      const turn =
        Math.sin(t * HEAD_TURN_W + 0.8) * 0.85 +
        Math.sin(t * HEAD_NOD_W2 * 0.9 + 0.4) * 0.15;
      // Z 侧倾：最慢，赋予慵懒感
      const tilt =
        Math.sin(t * HEAD_TILT_W + 0.5) * 0.85 +
        Math.sin(t * HEAD_NOD_W1 * 1.4) * 0.15;
      headOffset.rotation.x = nod * headAmp * intensity;
      headOffset.rotation.y = turn * headAmp * intensity;
      // 侧倾幅度减半，避免夸张的歪头
      headOffset.rotation.z = tilt * headAmp * 0.6 * intensity;
    }
    // matrixAutoUpdate 默认为 true，渲染循环会自动重算矩阵
  }

  function reset(): void {
    // 模型即将被整体释放（deepDispose），偏移节点会随之销毁，这里只需清空引用
    bodyOffset = null;
    headOffset = null;
    audioLevel = 0;
    intensity = 0;
    t = Math.random() * 10;
  }

  return { update, configure, setOptions, setAudioLevel, reset };
}

/**
 * 程序化呼吸动画（三骨骼协同）。
 *
 * 作为自主的生命感动画层，独立于 VRMA / 表情 / 口型 / 眨眼驱动，互不干扰。
 *
 * 实现原理（Offset 节点隔离法）：
 * 1. 在 chest / leftShoulder / rightShoulder / head 骨骼的各自父级，强行插入一个
 *    identity 偏移节点。插入后各原骨骼的世界变换完全不变。
 * 2. VRMA 动画继续控制各原骨骼（关键帧经 normalized → raw 自动同步，每帧由
 *    vrm.update() 写入各骨骼的局部变换）。
 * 3. 呼吸代码只改写偏移节点：胸腔做后仰旋转、肩部做上抬+后摆、头部做反向补偿旋转。
 *
 * 由于 3D 引擎最终世界矩阵 = 父矩阵 × 子矩阵，VRMA 与呼吸经父子相乘自然叠加。
 *
 * 生动呼吸设计（单向半波 (1−cos)/2，吸气到位、呼气回落、不在负方向超伸）：
 * - 胸腔 chest：吸气时绕局部 X 轴后仰（向后上方轻微旋转），呼气回到静止位。
 * - 肩膀 shoulders：吸气顶点时上抬（局部 Y 平移）+ 后摆（局部 X 旋转），呼气回落。
 *   肩部相位略滞后于胸腔，模拟呼吸由胸向肩的传导感。
 * - 头部 head：与胸腔同相位、反方向旋转，抵消胸腔后仰带来的头部倾斜，使视线保持水平。
 *
 * 头部补偿说明：head 偏移节点是 head 骨骼的新父级。当 VRMLookAt 启用时，
 * lookAt 会读取头部世界朝向并重设 head.local 以面向目标，能自然消化掉父级的轻微
 * 旋转；当 lookAt 未启用时，head 偏移节点的反向旋转直接抵消胸腔的 +X 仰角，
 * 让头部在世界空间保持水平。两种情形都安全。
 */

import * as THREE from 'three';

/** useBreath 依赖的最小人形骨骼接口（解耦 three-vrm 具体类型） */
export interface BreathHumanoid {
  getRawBoneNode(name: string): THREE.Object3D | null;
}

/** 呼吸参数 */
export interface BreathOptions {
  /** 呼吸频率（次/秒），默认 0.22（约 13 次/分钟，周期 ≈ 4.5s） */
  frequency?: number;
  /**
   * 胸腔后仰峰值（弧度），默认 0.02（≈ 1.15°）。
   * 吸气时胸廓绕局部 X 轴向后上方旋转到此角度，呼气回落到 0。
   * 单向波形 (1−cos)/2：胸腔始终在静止位或后仰位，不会前倾。
   * 同时驱动头部反向补偿（自动，无需另设参数）。
   */
  amplitudeX?: number;
  /** 绕局部 Y 轴偏航幅度（弧度），默认 0（一般保持 0） */
  amplitudeY?: number;
  /** 绕局部 Z 轴翻滚幅度（弧度），默认 0（一般保持 0） */
  amplitudeZ?: number;

  // ---- 肩部：上抬（Y 平移）+ 后摆（X 旋转），均在吸气顶点达到峰值 ----

  /**
   * 肩膀上抬峰值（局部空间单位，≈ 米），默认 0.01（≈ 1cm）。
   * 吸气顶点时肩膀沿局部 Y 轴上抬到此高度，呼气回落到静止位。
   * 单向波形 (1−cos)/2：肩膀不会沉到静止位以下。
   * 后摆旋转幅度由此值乘以 SHOULDER_BACK_RATIO 派生，无需单独控制。
   */
  shoulderAmplitude?: number;
  /**
   * 肩部相对胸腔的相位偏移（弧度），默认 0.4。
   * 呼吸从胸腔起始、向肩部略微传导滞后，让起伏更接近真人。
   * 设为 0 即与胸腔完全同步。
   */
  shoulderPhaseOffset?: number;
}

export interface BreathController {
  /** 每帧驱动呼吸：推进相位并写入各偏移节点的旋转/位移 */
  update(dt: number): void;
  /**
   * 绑定到 VRM 人形骨骼：定位 chest（必需）与 shoulders/head（可选），
   * 在各自父级插入偏移节点。返回是否启用胸腔呼吸成功。
   * 缺失 chest 返回 false；shoulder/head 缺失则自动跳过，不影响胸腔。
   */
  configure(
    humanoid: BreathHumanoid | null | undefined,
    options?: BreathOptions,
  ): boolean;
  /**
   * 运行时调整参数（仅覆盖显式传入的字段）。无需重新绑定模型，
   * 用于控制面板滑块实时调节幅度。
   */
  setOptions(options: BreathOptions): void;
  /** 清空引用（模型卸载 / 切换时调用，整体模型会被外部释放，无需还原层级） */
  reset(): void;
}

/** 偏移节点名，便于调试与识别 */
const CHEST_NODE_NAME = 'Chest_Breath_Offset';
const LEFT_SHOULDER_NODE_NAME = 'Left_Shoulder_Breath_Offset';
const RIGHT_SHOULDER_NODE_NAME = 'Right_Shoulder_Breath_Offset';
const HEAD_NODE_NAME = 'Head_Breath_Offset';

/**
 * 肩部后摆旋转 / 上抬平移 的换算系数。
 * 含义：每上抬 1 米，同时后摆多少弧度。0.01m（1cm）上抬 → 0.02rad（≈1.15°）后摆。
 * 让"向后、向上耸动"两个分量按自然比例联动，无需额外滑块。
 */
const SHOULDER_BACK_RATIO = 2;

/** 单个肩部偏移节点 */
interface ShoulderOffset {
  node: THREE.Object3D;
}

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

export function useBreath(initial?: BreathOptions): BreathController {
  // 偏移节点：胸腔、双肩、头部
  let chestOffset: THREE.Object3D | null = null;
  const shoulderOffsets: ShoulderOffset[] = [];
  let headOffset: THREE.Object3D | null = null;

  // 当前参数（configure 时可被覆盖）
  let frequency = initial?.frequency ?? 0.22;
  let ampX = initial?.amplitudeX ?? 0.02;
  let ampY = initial?.amplitudeY ?? 0;
  let ampZ = initial?.amplitudeZ ?? 0;
  // 肩部上抬平移幅度（局部空间单位，≈ 米）；后摆旋转由此派生
  let shoulderAmp = initial?.shoulderAmplitude ?? 0.01;
  let shoulderPhaseOffset = initial?.shoulderPhaseOffset ?? 0.4;

  // 正弦相位（秒）。赋予随机初始相位，避免每次加载都从同一刻起
  let phase = Math.random() * Math.PI * 2;

  /** 合并参数（仅覆盖显式传入的字段）。configure 与 setOptions 共用 */
  function applyOptions(opts: BreathOptions): void {
    if (opts.frequency !== undefined) frequency = opts.frequency;
    if (opts.amplitudeX !== undefined) ampX = opts.amplitudeX;
    if (opts.amplitudeY !== undefined) ampY = opts.amplitudeY;
    if (opts.amplitudeZ !== undefined) ampZ = opts.amplitudeZ;
    if (opts.shoulderAmplitude !== undefined)
      shoulderAmp = opts.shoulderAmplitude;
    if (opts.shoulderPhaseOffset !== undefined)
      shoulderPhaseOffset = opts.shoulderPhaseOffset;
  }

  function configure(
    humanoid: BreathHumanoid | null | undefined,
    opts?: BreathOptions,
  ): boolean {
    // 先丢弃上一次的引用（模型切换场景）
    chestOffset = null;
    shoulderOffsets.length = 0;
    headOffset = null;

    // 合并新参数（仅覆盖显式传入的字段）
    if (opts) applyOptions(opts);

    if (!humanoid) return false;

    // ---- 胸腔（主，必需）----
    const chest = humanoid.getRawBoneNode('chest');
    if (!chest) {
      // eslint-disable-next-line no-console
      console.warn('[Breath] 该模型不含 chest 骨骼，呼吸动画未启用');
      return false;
    }
    if (!chest.parent) return false;
    chestOffset = insertOffsetNode(chest.parent, chest, CHEST_NODE_NAME);

    // ---- 肩膀（可选：缺失 shoulder 骨骼则跳过）----
    const leftShoulder = humanoid.getRawBoneNode('leftShoulder');
    if (leftShoulder && leftShoulder.parent) {
      shoulderOffsets.push({
        node: insertOffsetNode(
          leftShoulder.parent,
          leftShoulder,
          LEFT_SHOULDER_NODE_NAME,
        ),
      });
    }
    const rightShoulder = humanoid.getRawBoneNode('rightShoulder');
    if (rightShoulder && rightShoulder.parent) {
      shoulderOffsets.push({
        node: insertOffsetNode(
          rightShoulder.parent,
          rightShoulder,
          RIGHT_SHOULDER_NODE_NAME,
        ),
      });
    }

    // ---- 头部（可选：用于反向补偿胸腔后仰，保持视线水平）----
    const head = humanoid.getRawBoneNode('head');
    if (head && head.parent) {
      headOffset = insertOffsetNode(head.parent, head, HEAD_NODE_NAME);
    }

    return true;
  }

  function setOptions(opts: BreathOptions): void {
    applyOptions(opts);
  }

  function update(dt: number): void {
    if (!chestOffset) return;

    phase += dt * frequency * Math.PI * 2;

    // ---- 胸腔：单向半波 (1−cos)/2，吸气后仰、呼气回落 ----
    // chestWave ∈ [0,1]，相位 π 时为 1（吸气顶点）
    const chestWave = (1 - Math.cos(phase)) * 0.5;
    chestOffset.rotation.x = chestWave * ampX;
    chestOffset.rotation.y = chestWave * ampY;
    chestOffset.rotation.z = chestWave * ampZ;

    // ---- 头部：与胸腔同相位、反方向 X 旋转，抵消胸腔后仰带来的头部倾斜 ----
    // 头部偏移节点的 -X 旋转在层级中近似抵消 chestOffset 的 +X 旋转，
    // 使头部世界朝向不随呼吸倾斜、视线保持水平。
    if (headOffset) {
      headOffset.rotation.x = -chestWave * ampX;
    }

    // ---- 肩部：相位略滞后于胸腔，吸气顶点上抬 + 后摆 ----
    const shoulderWave = (1 - Math.cos(phase + shoulderPhaseOffset)) * 0.5;
    // 后摆旋转由上抬幅度按固定比例派生（联动）
    const backRot = shoulderAmp * SHOULDER_BACK_RATIO;
    for (const sh of shoulderOffsets) {
      // 上抬：局部 Y 平移
      sh.node.position.y = shoulderWave * shoulderAmp;
      // 后摆：局部 X 旋转（肩膀向后上方耸动）
      sh.node.rotation.x = shoulderWave * backRot;
    }
    // matrixAutoUpdate 默认为 true，渲染循环会自动重算矩阵
  }

  function reset(): void {
    // 模型即将被整体释放（deepDispose），偏移节点会随之销毁，这里只需清空引用
    chestOffset = null;
    shoulderOffsets.length = 0;
    headOffset = null;
    // 重置相位，下次配置后从新的随机相位开始
    phase = Math.random() * Math.PI * 2;
  }

  return { update, configure, setOptions, reset };
}

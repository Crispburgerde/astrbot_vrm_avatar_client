/**
 * Avatar Mask（动画遮罩）：仿 Unity Avatar 3.0 的层遮罩机制。
 *
 * three.js 的 AnimationMixer 没有内建的「每层骨骼遮罩」，但 VRMAnimation
 * 的骨骼轨道天然以人形骨骼名（VRMHumanBoneName）为键（见
 * @pixiv/three-vrm-animation 的 VRMAnimation.humanoidTracks.rotation）。
 * 因此遮罩 = 构建 clip 时按骨骼集合裁剪轨道：不在此层遮罩内的骨骼轨道
 * 直接不放入该层的 clip，该层 mixer 便不会创建对应绑定，自然「放弃」
 * 对这些骨骼的控制权。
 */

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import {
  createVRMAnimationExpressionTracks,
  createVRMAnimationHumanoidTracks,
  createVRMAnimationLookAtTrack,
  VRMLookAtQuaternionProxy,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';

/**
 * Gesture 层（手势层）遮罩：只接管上半身骨骼——躯干上部、颈、头、
 * 肩、臂、手与手指。主动放弃对 hips 与下肢（腿/脚）的控制权——
 * 这些骨骼继续由 Base 层驱动，实现「边走边挥手」而下肢不滑步。
 * 面部表情经表情轨道（expressions）纳入本层。
 */
export const GESTURE_BONES: ReadonlySet<string> = new Set([
  // 躯干上部与颈/头（hips 除外： hips 归 Base/Action 层管整体位移）
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  // 肩
  'leftShoulder',
  'rightShoulder',
  // 臂
  'leftUpperArm',
  'leftLowerArm',
  'rightUpperArm',
  'rightLowerArm',
  // 手
  'leftHand',
  'rightHand',
  // 左手手指
  'leftThumbMetacarpal',
  'leftThumbProximal',
  'leftThumbDistal',
  'leftIndexProximal',
  'leftIndexIntermediate',
  'leftIndexDistal',
  'leftMiddleProximal',
  'leftMiddleIntermediate',
  'leftMiddleDistal',
  'leftRingProximal',
  'leftRingIntermediate',
  'leftRingDistal',
  'leftLittleProximal',
  'leftLittleIntermediate',
  'leftLittleDistal',
  // 右手手指
  'rightThumbMetacarpal',
  'rightThumbProximal',
  'rightThumbDistal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightIndexDistal',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightMiddleDistal',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightRingDistal',
  'rightLittleProximal',
  'rightLittleIntermediate',
  'rightLittleDistal',
]);

/** clip 构建遮罩选项 */
export interface ClipMask {
  /** 允许动画的骨骼集合；null/undefined = 全身（不裁剪旋转轨道） */
  bones?: ReadonlySet<string> | null;
  /** 是否包含 hips 平移轨道（全身位移）。默认 true */
  hipsTranslation?: boolean;
  /** 是否包含表情轨道。默认 true */
  expressions?: boolean;
  /** 是否包含视线（lookAt）轨道。默认 false（保留用户视线控制） */
  lookAt?: boolean;
}

/**
 * 将模型无关的 VRMAnimation 构建为带遮罩的 AnimationClip。
 *
 * 与官方 createVRMAnimationClip 的区别：可按骨骼集合裁剪人形旋转轨道、
 * 按(flag)取舍 hips 平移/表情/视线轨道。轨道的模型绑定细节
 * （normalized 骨骼节点名解析、VRM0 朝向翻转、 hips 缩放）复用官方导出的
 * createVRMAnimationHumanoidTracks / createVRMAnimationExpressionTracks。
 *
 * @returns 不含任何轨道时返回 null（调用方据此跳过播放）
 */
export function createMaskedVRMAnimationClip(
  vrma: VRMAnimation,
  vrm: VRM,
  mask: ClipMask = {},
): THREE.AnimationClip | null {
  const tracks: THREE.KeyframeTrack[] = [];

  // ---- 人形骨骼轨道（按遮罩裁剪） ----
  const humanoidTracks = createVRMAnimationHumanoidTracks(
    vrma,
    vrm.humanoid,
    vrm.meta.metaVersion,
  );
  if (mask.hipsTranslation !== false) {
    tracks.push(...humanoidTracks.translation.values());
  }
  const bones = mask.bones ?? null;
  for (const [bone, track] of humanoidTracks.rotation) {
    if (!bones || bones.has(bone)) tracks.push(track);
  }

  // ---- 表情轨道 ----
  if (mask.expressions !== false && vrm.expressionManager) {
    const expressionTracks = createVRMAnimationExpressionTracks(
      vrma,
      vrm.expressionManager,
    );
    tracks.push(...expressionTracks.preset.values());
    tracks.push(...expressionTracks.custom.values());
  }

  // ---- 视线轨道（默认不含：让手势层不劫持视线） ----
  if (mask.lookAt && vrm.lookAt) {
    let proxy: VRMLookAtQuaternionProxy | undefined = vrm.scene.children.find(
      (obj): obj is VRMLookAtQuaternionProxy =>
        obj instanceof VRMLookAtQuaternionProxy,
    );
    if (!proxy) {
      proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    } else if (proxy.name === '') {
      proxy.name = 'VRMLookAtQuaternionProxy';
    }
    const track = createVRMAnimationLookAtTrack(vrma, `${proxy.name}.quaternion`);
    if (track) tracks.push(track);
  }

  if (tracks.length === 0) return null;
  return new THREE.AnimationClip('MaskedClip', vrma.duration, tracks);
}

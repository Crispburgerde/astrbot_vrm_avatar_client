/**
 * AU → 模型 morph 绑定（自 SoullinkEmotion3D 的 profile.ts 移植）。
 *
 * vroidProfile：VRoid 系风格化代理绑定（Fcl_* 命名），未命中时代码仍会
 * 尝试 ARKit / ICT 直接命名（directShapeChannel），全都不支持时由
 * faceDriver 回退到 VRM 预设表情。
 */

import { clamp, type FACSActionUnitKey, type FACSActionUnitState } from './engine';
import { directShapeChannel } from './arkit';

export type BindingKind = 'proxy' | 'direct' | 'unsupported';
export interface Binding { au: FACSActionUnitKey; targets: { names: string[]; weight: number }[]; kind: BindingKind; label: string }
export interface ModelProfile { schema: 1; name: string; bindings: Binding[] }
const vr = (suffix: string) => [`Fcl_${suffix}`, `Face.M_F00_000_Fcl_${suffix}`];
const b = (au: FACSActionUnitKey, label: string, targets: {names: string[];weight: number}[], kind: BindingKind = 'proxy'): Binding => ({au, label, targets, kind});

/** AU names follow Soullink. VRoid targets are stylized proxies, not anatomical FACS. */
export const vroidProfile: ModelProfile = { schema: 1, name: 'VRoid · Anime AU Profile', bindings: [
  b('au01InnerBrowRaiser', '内眉上提', [{names: ['browInnerUp', ...vr('BRW_Sorrow')], weight: 1}]),
  b('au02OuterBrowRaiser', '外眉上提', [{names: ['browOuterUpLeft', ...vr('BRW_Surprised')], weight: 1}]),
  b('au04BrowLowerer', '眉毛下压', [{names: ['browDownLeft', ...vr('BRW_Angry')], weight: 1}]),
  b('au05UpperLidRaiser', '睁大眼睛', [{names: ['eyeWideLeft', ...vr('EYE_Surprised')], weight: 1}]),
  b('au06CheekRaiser', '笑眼 / 脸颊上提', [{names: ['cheekSquintLeft', ...vr('EYE_Joy')], weight: 1}]),
  b('au07LidTightener', '眼睑收紧', [{names: ['eyeSquintLeft', ...vr('EYE_Angry')], weight: 1}]),
  b('au09NoseWrinkler', '鼻部皱缩', [{names: ['noseSneerLeft'], weight: 1}], 'direct'),
  b('au10UpperLipRaiser', '上唇上提', [{names: ['mouthShrugUpper'], weight: 1}], 'direct'),
  b('au12LipCornerPuller', '嘴角上扬', [{names: ['mouthSmileLeft', ...vr('MTH_Fun')], weight: 1}]),
  b('au14Dimpler', '酒窝 / 嘴角收紧', [{names: ['mouthDimpleLeft', ...vr('MTH_Joy')], weight: 0.28}]),
  b('au15LipCornerDepressor', '嘴角下垂', [{names: ['mouthFrownLeft', ...vr('MTH_Sorrow')], weight: 1}]),
  b('au17ChinRaiser', '下巴上提', [{names: ['mouthShrugLower'], weight: 1}], 'direct'),
  b('au18LipPucker', '嘟嘴', [{names: ['mouthPucker', ...vr('MTH_U')], weight: 0.8}]),
  b('au20LipStretcher', '嘴唇横向拉伸', [{names: ['mouthStretchLeft', ...vr('MTH_I')], weight: 0.65}]),
  b('au23LipTightener', '嘴唇绷紧', [{names: ['mouthPressLeft', ...vr('MTH_Angry')], weight: 1}]),
  b('au24LipPressor', '嘴唇压紧', [{names: ['mouthPressLeft', ...vr('MTH_Close')], weight: 0.8}]),
  b('au25LipsPart', '嘴唇分开', [{names: ['mouthOpen', ...vr('MTH_A')], weight: 0.45}]),
  b('au26JawDrop', '下颌张开', [{names: ['jawOpen', ...vr('MTH_A')], weight: 0.9}]),
  b('au27MouthStretch', '嘴巴大张', [{names: ['mouthOpen', ...vr('MTH_Surprised')], weight: 0.8}]),
  b('au45Blink', '双眼眨眼', [{names: ['eyeBlinkLeft', ...vr('EYE_Close')], weight: 1}], 'direct'),
] };

/** Anime / VRChat 系命名方言：VRChat viseme（vrc.v_*）、模型作者 romaji 自定义名
 *  （mouth_a / eye_close / brow_joy …）与 MMD 日文名的三层候选。
 *  适配 VRChat 社区模型转 VRM 的常见命名体系（如 Manuka）。
 *  散形状多为局部微调、单形状表现力弱，故情绪 AU 采用多目标组带权并联：
 *  主形状 + 风格化整脸代理（怒り / びっくり / なごみ 等 MMD 全脸形状），
 *  与 vroidProfile 的 Fcl 整脸代理哲学一致。 */
export const animeProfile: ModelProfile = { schema: 1, name: 'Anime/VRC · Romaji & MMD Profile', bindings: [
  b('au01InnerBrowRaiser', '内眉上提·悲眉', [
    {names: ['brow_sad'], weight: 1},
    {names: ['困る', 'eye_sad'], weight: 0.7},
  ]),
  b('au02OuterBrowRaiser', '外眉上提·惊眉', [
    {names: ['brow_up', 'brow_surprised'], weight: 1},
    {names: ['びっくり'], weight: 0.7},
  ]),
  b('au04BrowLowerer', '眉毛下压·怒', [
    {names: ['brow_anger'], weight: 1},
    {names: ['brow_anger 2'], weight: 0.6},
    {names: ['eye_angry'], weight: 0.8},
    {names: ['怒り'], weight: 0.5},
  ]),
  b('au05UpperLidRaiser', '睁大眼', [
    {names: ['eye_morph_wide'], weight: 1},
    {names: ['びっくり'], weight: 0.8},
  ]),
  b('au06CheekRaiser', '笑眼', [
    {names: ['eye_joy', '笑い'], weight: 1},
    {names: ['eye_happy', 'brow_joy'], weight: 0.8},
    {names: ['なごみ'], weight: 0.5},
  ]),
  b('au07LidTightener', '眯眼·怒目', [
    {names: ['eye_jito', 'ｷﾘｯ'], weight: 1},
    {names: ['eye_angry'], weight: 0.6},
  ]),
  b('au12LipCornerPuller', '嘴角上扬·笑', [
    {names: ['mouth_smile', 'にやり'], weight: 1},
    {names: ['mouth_grin_L'], weight: 0.6},
    {names: ['口角上げ'], weight: 0.5},
  ]),
  b('au15LipCornerDepressor', '嘴角下垂·悲', [
    {names: ['mouth_sad'], weight: 1},
    {names: ['口角下げ'], weight: 0.7},
    {names: ['eye_sad'], weight: 0.6},
  ]),
  b('au18LipPucker', '嘟嘴', [{names: ['mouth_ω'], weight: 0.8}]),
  b('au20LipStretcher', '嘴唇横向拉伸', [{names: ['mouth_wide', '口横広げ'], weight: 0.65}]),
  b('au25LipsPart', '嘴唇分开', [{names: ['mouth_a', 'あ'], weight: 0.45}]),
  b('au26JawDrop', '下颌张开', [{names: ['mouth_a', 'あ'], weight: 0.9}]),
  b('au27MouthStretch', '嘴巴大张', [{names: ['ワ'], weight: 0.8}]),
  b('au45Blink', '双眼眨眼', [{names: ['eye_close', 'まばたき'], weight: 1}], 'direct'),
] };

/** 全部命名方言词典；faceDriver 按各词典 resolve 命中数最多者择优绑定 */
export const bindingProfiles: ModelProfile[] = [vroidProfile, animeProfile];

/** Fcl_ 区域名大小写归一化（部分 VRM 0.x 导出器大小写不稳定） */
export function canonicalMorphName(name: string): string {
  const match = name.match(/Fcl_(.+)$/i);
  if (!match) return name;
  const [region, ...rest] = match[1].split('_');
  return `Fcl_${region.toUpperCase()}_${rest.join('_')}`;
}

export interface ResolvedBinding extends Binding { resolved: {name: string;weight: number}[]; supported: boolean }
export function resolveProfile(profile: ModelProfile, available: Iterable<string>): ResolvedBinding[] {
  const names = new Set(available);
  const canonical = new Map([...names].map(name=>[canonicalMorphName(name),name]));
  return profile.bindings.map(binding => {
    const resolved: {name: string;weight: number}[] = [];
    for (const t of binding.targets) {
      const found = t.names.map(n=>names.has(n)?n:canonical.get(canonicalMorphName(n))??[...names].find(a=>directShapeChannel(n)!==null&&directShapeChannel(a)===directShapeChannel(n))).find((n):n is string=>!!n);
      if (found) {
        resolved.push({name: found, weight: t.weight});
        // ARKit asymmetric channels should be driven bilaterally for a symmetric AU.
        const right = found.endsWith('Left') ? found.replace(/Left$/, 'Right') : found.endsWith('_L')?found.replace(/_L$/,'_R'):null;
        if (right && names.has(right)) resolved.push({name: right, weight: t.weight});
      }
    }
    return { ...binding, resolved, supported: resolved.length > 0 };
  });
}

/** 嘴部 AU（口型闸门作用范围，与 computeMorphWeights 的嘴部分组保持一致） */
export const MOUTH_AU_RE = /au(09|10|12|14|15|17|18|20|23|24|25|26|27)/;

export interface ProxyOptions { contrast?: number; pinned?: ReadonlySet<FACSActionUnitKey> }
export function computeMorphWeights(aus: FACSActionUnitState, bindings: ResolvedBinding[], gains: Partial<Record<FACSActionUnitKey, number>> = {}, options: ProxyOptions = {}): Record<string, number> {
  const result: Record<string, number> = {};
  for (const binding of bindings) for (const target of binding.resolved) {
    result[target.name] = (result[target.name] ?? 0) + clamp(aus[binding.au]) * target.weight * clamp(gains[binding.au] ?? 1, 0, 3);
  }
  // VRoid proxies are whole expression shapes, so small competing shapes can cancel the main one.
  const contrast = clamp(options.contrast ?? 0, 0, 2);
  const pinned = options.pinned ?? new Set<FACSActionUnitKey>();
  const sharpen = (predicate: (name: string) => boolean, protectedAUs: FACSActionUnitKey[]) => {
    if (!contrast || protectedAUs.some(key => pinned.has(key))) return;
    const group = Object.keys(result).filter(predicate), peak = Math.max(0, ...group.map(key => result[key]));
    if (peak > 0) for (const key of group) result[key] *= (result[key] / peak) ** contrast;
  };
  sharpen(n => /Fcl_BRW_/.test(n), ['au01InnerBrowRaiser', 'au02OuterBrowRaiser', 'au04BrowLowerer']);
  sharpen(n => /Fcl_EYE_/.test(n) && !/Close/.test(n), ['au05UpperLidRaiser', 'au06CheekRaiser', 'au07LidTightener']);
  const mouthAUs = bindings.filter(b => MOUTH_AU_RE.test(b.au)).map(b => b.au);
  if (contrast && !mouthAUs.some(key => pinned.has(key))) {
    const expression = Math.max(aus.au12LipCornerPuller, aus.au15LipCornerDepressor, aus.au18LipPucker, aus.au20LipStretcher, aus.au23LipTightener, aus.au26JawDrop, aus.au27MouthStretch);
    for (const key of Object.keys(result)) if (/Fcl_MTH_Close(?:$|[_.])/.test(key)) result[key] *= 1 - clamp(expression) * clamp(contrast / 1.5);
    sharpen(n => /Fcl_MTH_/.test(n) && !/Close/.test(n), mouthAUs);
  }
  // Competing facial channels cannot reach full intensity together.
  const normalize = (predicate: (name: string) => boolean, budget: number) => {
    const group = Object.keys(result).filter(predicate); const sum = group.reduce((s, key) => s + result[key], 0);
    if (sum > budget) for (const key of group) result[key] *= budget / sum;
  };
  normalize(n => /Fcl_BRW_/.test(n), 1);
  normalize(n => /Fcl_EYE_/.test(n) && !/Close/.test(n), 1);
  normalize(n => /Fcl_MTH_/.test(n), 1.1);
  const blink = Math.max(aus.au45Blink, 0);
  for (const key of Object.keys(result)) {
    if (/Fcl_EYE_/.test(key) && !/Close/.test(key)) result[key] *= 1 - clamp(blink);
    result[key] = clamp(result[key]);
  }
  return result;
}

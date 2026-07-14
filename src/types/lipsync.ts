// 唇形同步相关类型定义
// 由表演层（usePerformance）驱动，由场景层（useVRMScene）消费

/** 口型元音名（对应 VRM 标准表情预设） */
export type VowelPreset = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';

/** 口型五元音权重（由 wLipSync 驱动，范围 0~1） */
export type LipSyncWeights = Record<VowelPreset, number>;

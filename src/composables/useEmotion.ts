/**
 * 情绪表情过渡层。
 *
 * 作为自主动画层独立于场景/口型驱动：维护当前/目标情绪与过渡权重，
 * 每帧把权重写入表情管理器。眨眼与口型同步由其它层负责，互不干扰。
 *
 * 情绪名不预设：由 configure() 时传入从 VRM 模型解析得到的表情列表，
 * 只接受该列表内的情绪名。
 *
 * idle 默认情绪：若模型含 neutral 表情则用 neutral，否则「无情绪」（权重全 0）。
 * 初始化、非法值回退、表演结束归位都使用该默认情绪。
 */

/** useEmotion 依赖的最小表情管理器接口（解耦 three-vrm 具体类型） */
export interface EmotionExpressionManager {
  setValue(name: string, weight: number): void;
}

export interface EmotionController {
  /** 每帧推进情绪过渡，把权重写入 manager */
  update(dt: number): void;
  /** 设置目标情绪（带平滑过渡）；非法值回退到无情绪 */
  setEmotion(emotion: string): void;
  /** 注入表情管理器与可用情绪名列表，并重置为无情绪 */
  configure(
    manager: EmotionExpressionManager | null | undefined,
    emotions: readonly string[],
  ): void;
  /** 清空状态（模型卸载 / 切换时调用） */
  reset(): void;
}

export function useEmotion(): EmotionController {
  let manager: EmotionExpressionManager | null = null;
  /** 当前可用的情绪名集合；null 表示未配置 */
  let validNames: Set<string> | null = null;
  /** idle 默认情绪：模型含 neutral 则为 'neutral'，否则为 null（无情绪） */
  let idle: string | null = null;
  /** 当前情绪；null 表示无情绪（所有情绪权重为 0） */
  let current: string | null = null;
  /** 目标情绪；null 表示无情绪 */
  let target: string | null = null;
  /** 当前情绪的插值权重 0->1 */
  let blend = 1;

  function setValue(name: string, weight: number): void {
    manager?.setValue(name, weight);
  }

  function update(dt: number): void {
    if (!manager) return;

    // 无过渡：维持/完成当前情绪的淡入
    if (target === current) {
      if (current !== null && blend < 1) {
        blend = Math.min(1, blend + dt * 5);
        setValue(current, blend);
      }
      return;
    }

    // 有过渡：先淡出当前情绪
    if (current !== null) {
      blend -= dt * 5;
      if (blend > 0) {
        setValue(current, blend);
        return;
      }
      setValue(current, 0);
    }

    // 切换到目标情绪，开始淡入（目标为 null 时即停留在无情绪）
    current = target;
    blend = 0;
    if (current !== null) {
      setValue(current, 0);
    }
  }

  function setEmotion(emotion: string): void {
    // 未配置或不在有效集合内 → 目标回退到 idle（neutral 或无情绪）
    if (validNames === null || !validNames.has(emotion)) {
      target = idle;
      return;
    }
    target = emotion;
  }

  function configure(
    mgr: EmotionExpressionManager | null | undefined,
    emotions: readonly string[],
  ): void {
    manager = mgr ?? null;
    validNames = emotions.length > 0 ? new Set(emotions) : null;
    idle = validNames?.has('neutral') ? 'neutral' : null;

    // 清零所有已知情绪权重
    if (mgr) {
      emotions.forEach((n) => mgr.setValue(n, 0));
    }

    // 初始即处于 idle 情绪（无过渡，直接拉满权重）
    current = idle;
    target = idle;
    blend = 1;
    if (idle !== null) {
      setValue(idle, 1);
    }
  }

  function reset(): void {
    manager = null;
    validNames = null;
    idle = null;
    current = null;
    target = null;
    blend = 1;
  }

  return { update, setEmotion, configure, reset };
}

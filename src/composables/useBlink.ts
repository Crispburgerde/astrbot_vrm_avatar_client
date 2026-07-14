/**
 * 自然眨眼动画。
 *
 * 作为自主的生命感动画层独立于场景/表情/口型驱动：
 * 随机间隔（1.8~6s）+ 非对称曲线（快闭慢睁）+ 偶发连眨，
 * 让角色更显生动。情绪表情与口型同步由其它层负责，互不干扰。
 */

/** useBlink 依赖的最小表情管理器接口（解耦 three-vrm 具体类型） */
export interface BlinkExpressionManager {
  setValue(name: string, weight: number): void;
  expressionMap: Record<string, unknown>;
}

export interface BlinkController {
  /** 每帧驱动眨眼动画 */
  update(dt: number): void;
  /**
   * 配置眨眼目标。检测 manager 是否含眨眼表情：
   * 优先 blink，否则回退 blinkLeft / blinkRight。
   * 返回是否支持眨眼。
   */
  configure(manager: BlinkExpressionManager | null | undefined): boolean;
  /** 重置到空闲状态（模型卸载 / 切换时调用） */
  reset(): void;
}

export function useBlink(): BlinkController {
  let manager: BlinkExpressionManager | null = null;
  let blinkExprName: string | null = null;
  let useSplitBlink = false;

  // 倒计时与进度状态
  let timer = 2 + Math.random() * 2; // 距下次眨眼的倒计时（秒）
  let progress = -1; // 眨眼进度：-1=空闲，[0,1]=眨眼中
  let duration = 0.15; // 当前眨眼总时长（秒）
  let remaining = 0; // 连眨剩余次数（偶发连眨）

  function configure(mgr: BlinkExpressionManager | null | undefined): boolean {
    manager = mgr ?? null;
    if (!mgr) {
      blinkExprName = null;
      useSplitBlink = false;
      return false;
    }
    const map = mgr.expressionMap ?? {};
    if ('blink' in map) {
      blinkExprName = 'blink';
      useSplitBlink = false;
    } else if ('blinkLeft' in map || 'blinkRight' in map) {
      blinkExprName = null;
      useSplitBlink = true;
    } else {
      blinkExprName = null;
      useSplitBlink = false;
    }
    return blinkExprName !== null || useSplitBlink;
  }

  /** 设置眨眼闭合权重（0=睁眼，1=闭眼） */
  function setWeight(w: number): void {
    if (!manager) return;
    if (blinkExprName) {
      manager.setValue(blinkExprName, w);
    } else if (useSplitBlink) {
      manager.setValue('blinkLeft', w);
      manager.setValue('blinkRight', w);
    }
  }

  /**
   * 自然眨眼：随机间隔（1.8~6s）+ 非对称曲线（快闭慢睁）+ 偶发连眨。
   * 仿照真人眨眼节律，让角色更显生动。
   */
  function update(dt: number): void {
    // 模型无眨眼表情则跳过
    if (!blinkExprName && !useSplitBlink) return;

    if (progress < 0) {
      // 空闲：倒计时到下次眨眼
      timer -= dt;
      if (timer <= 0) {
        progress = 0;
        // 眨眼总时长 0.12~0.22s（接近人类平均）
        duration = 0.12 + Math.random() * 0.1;
        // ~10% 概率触发一次连眨
        remaining = Math.random() < 0.1 ? 1 : 0;
      }
      return;
    }

    // 眨眼中：推进进度
    progress += dt / duration;
    if (progress >= 1) {
      setWeight(0);
      progress = -1;
      if (remaining > 0) {
        remaining -= 1;
        // 连眨间隔较短
        timer = 0.08 + Math.random() * 0.12;
      } else {
        // 下次眨眼：1.8~6s
        timer = 1.8 + Math.random() * 4.2;
      }
      return;
    }

    setWeight(blinkCurve(progress));
  }

  function reset(): void {
    manager = null;
    blinkExprName = null;
    useSplitBlink = false;
    progress = -1;
    remaining = 0;
    // 重置后首次眨眼在 2~4s 后
    timer = 2 + Math.random() * 2;
  }

  return { update, configure, reset };
}

/**
 * 眨眼曲线：progress [0,1] → 闭合权重 0→1→0。
 * 闭眼占 40%（较快），睁眼占 60%（略慢），过渡平滑且导数连续。
 */
function blinkCurve(progress: number): number {
  const closeRatio = 0.4;
  if (progress < closeRatio) {
    const t = progress / closeRatio;
    return Math.sin((t * Math.PI) / 2); // 0 → 1 平滑闭合
  }
  const t = (progress - closeRatio) / (1 - closeRatio);
  return Math.cos((t * Math.PI) / 2); // 1 → 0 平滑睁开
}

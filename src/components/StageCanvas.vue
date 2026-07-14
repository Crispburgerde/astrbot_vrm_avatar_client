<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  /** 待机/加载状态提示文案 */
  hint?: string;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);

defineExpose({ canvas });
</script>

<template>
  <div class="stage">
    <canvas ref="canvas" class="stage__canvas" />
    <div v-if="hint" class="stage__hint">
      <span class="stage__hint-dot" />
      {{ hint }}
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.stage__canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* 柔和的聚光灯光晕，营造剧场氛围 */
.stage::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(
      60% 50% at 50% 38%,
      rgba(232, 184, 109, 0.08) 0%,
      rgba(232, 184, 109, 0) 60%
    ),
    radial-gradient(
      120% 80% at 50% 120%,
      rgba(0, 0, 0, 0.55) 0%,
      rgba(0, 0, 0, 0) 70%
    );
  transition: opacity 0.6s ease;
}

.stage__hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  font-size: 14px;
  letter-spacing: 0.04em;
  color: var(--text-soft);
  background: var(--glass);
  border: 1px solid var(--glass-border);
  border-radius: 999px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.stage__hint-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-amber);
  box-shadow: 0 0 12px var(--accent-amber);
  animation: pulse 1.8s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.15); }
}
</style>

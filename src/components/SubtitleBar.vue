<script setup lang="ts">
defineProps<{
  /** 当前字幕文本 */
  text: string;
  /** 是否显示（控制淡入淡出） */
  visible: boolean;
  /** 当前表情名 */
  expression?: string;
}>();
</script>

<template>
  <Transition name="subtitle">
    <div v-if="visible && text" class="subtitle">
      <span v-if="expression" class="subtitle__tag">{{ expression }}</span>
      <span class="subtitle__text">{{ text }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.subtitle {
  position: absolute;
  left: 50%;
  bottom: 7%;
  transform: translateX(-50%);
  max-width: min(860px, 86vw);
  display: inline-flex;
  align-items: center;
  gap: 14px;
  padding: 14px 26px;
  background: var(--glass);
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
}

.subtitle__tag {
  flex-shrink: 0;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-amber);
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid rgba(232, 184, 109, 0.4);
  background: rgba(232, 184, 109, 0.08);
}

.subtitle__text {
  font-size: clamp(17px, 2.2vw, 22px);
  line-height: 1.5;
  font-weight: 500;
  color: var(--text-strong);
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
}

/* 淡入淡出 + 轻微位移 */
.subtitle-enter-active,
.subtitle-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.subtitle-enter-from,
.subtitle-leave-to {
  opacity: 0;
  transform: translate(-50%, 14px);
}
</style>

<script setup lang="ts">
import type { ConnectionStatus } from '@/composables/useWebSocket';

defineProps<{
  status: ConnectionStatus;
  error?: string;
}>();

const LABELS: Record<ConnectionStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
};
</script>

<template>
  <div class="status" :data-status="status">
    <span class="status__dot" />
    <span class="status__label">{{ LABELS[status] }}</span>
    <span v-if="error && status === 'disconnected'" class="status__error">
      · {{ error }}
    </span>
  </div>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 8px 16px;
  font-size: 13px;
  letter-spacing: 0.03em;
  color: var(--text-soft);
  background: var(--glass);
  border: 1px solid var(--glass-border);
  border-radius: 999px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  user-select: none;
}

.status__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-color);
  box-shadow: 0 0 10px var(--status-color);
  transition: background 0.3s ease, box-shadow 0.3s ease;
}

.status[data-status='connected'] { --status-color: #5bd69a; }
.status[data-status='connecting'] {
  --status-color: var(--accent-amber);
}
.status[data-status='connecting'] .status__dot {
  animation: blink 1s ease-in-out infinite;
}
.status[data-status='disconnected'] { --status-color: #ff7a59; }

.status__error {
  color: #ff9a82;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
</style>

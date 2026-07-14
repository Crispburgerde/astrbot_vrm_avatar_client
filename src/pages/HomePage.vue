<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import StageCanvas from '@/components/StageCanvas.vue';
import SubtitleBar from '@/components/SubtitleBar.vue';
import StatusBar from '@/components/StatusBar.vue';
import ControlPanel from '@/components/ControlPanel.vue';
import { useWebSocket } from '@/composables/useWebSocket';
import { useVRMScene } from '@/composables/useVRMScene';
import { usePerformance } from '@/composables/usePerformance';
import { usePersistentRef } from '@/composables/usePersistentRef';
import {
  isPerformance,
  isUpdateAnimations,
  isUpdateBackground,
  isUpdateCharacter,
  type ServerMessage,
} from '@/types/messages';

const VOLUME_KEY = 'vrm.avatar.volume';
const MUTED_KEY = 'vrm.avatar.muted';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const stageRef = ref<InstanceType<typeof StageCanvas> | null>(null);

// 控制面板开关
const panelOpen = ref(false);

// 音量（持久化）
const volume = usePersistentRef<number>(VOLUME_KEY, 0.8);
const muted = usePersistentRef<boolean>(MUTED_KEY, false);

const effectiveVolume = computed(() => (muted.value ? 0 : volume.value));

// VRM 场景层
const scene = useVRMScene(canvasRef);

// 表演层
const performance = usePerformance({
  scene,
  getVolume: () => effectiveVolume.value,
});

// WebSocket 通信层：分发后端消息
const ws = useWebSocket({
  onMessage: (msg: ServerMessage) => {
    if (isUpdateCharacter(msg)) {
      scene.loadVrmFromBase64(msg.vrm.data, msg.vrm.filename).catch((e) => {
        console.error('[VRM] 模型加载失败:', e);
      });
    } else if (isUpdateBackground(msg)) {
      scene.loadBackgroundFromBase64(
        msg.background.data,
        // 文件名后缀作为格式
        msg.background.filename.split('.').pop() || 'png',
        msg.background.filename,
      );
    } else if (isUpdateAnimations(msg)) {
      scene.loadAnimationsFromBase64(msg.animations).catch((e) => {
        console.error('[VRMA] 动画加载失败:', e);
      });
    } else if (isPerformance(msg)) {
      performance.enqueue(msg);
    }
  },
});

// 音量变化同步到表演层（持久化由 usePersistentRef 自动处理）
watch(effectiveVolume, (v) => {
  performance.setVolume(v);
});

// 待机提示文案
const hint = computed(() => {
  if (ws.status.value === 'disconnected') return '正在连接后端…';
  if (!scene.state.value.loaded) return '等待 VRM 模型推送…';
  return '';
});

onMounted(() => {
  // 从子组件拿到真实 canvas 元素后初始化场景
  canvasRef.value = stageRef.value?.canvas ?? null;
  scene.init();
  // 自动连接后端
  ws.connect();
});

// 组件实例类型推断占位（确保 stageRef 类型正确）
void stageRef;

// 控制面板事件处理
function onConnect(): void {
  // 用户手势内解锁 AudioContext，避免浏览器自动播放策略卡住音频队列
  performance.unlockAudio();
  ws.connect();
}
function onDisconnect(): void {
  ws.disconnect();
}
</script>

<template>
  <main class="home">
    <StageCanvas ref="stageRef" :hint="hint" />

    <StatusBar
      :status="ws.status.value"
      :error="ws.error.value"
      class="home__status"
    />

    <SubtitleBar
      :text="performance.subtitle.value"
      :visible="performance.isPlaying.value"
      :expression="performance.currentExpression.value"
    />

    <ControlPanel
      v-model:open="panelOpen"
      :url="ws.url.value"
      v-model:volume="volume"
      v-model:muted="muted"
      v-model:ambient-intensity="scene.ambientIntensity.value"
      v-model:key-light-intensity="scene.keyLightIntensity.value"
      v-model:rim-light-intensity="scene.rimLightIntensity.value"
      v-model:chest-breath-amplitude="scene.chestBreathAmplitude.value"
      v-model:shoulder-breath-amplitude="scene.shoulderBreathAmplitude.value"
      v-model:body-sway-body-amplitude="scene.bodySwayBodyAmplitude.value"
      v-model:body-sway-head-amplitude="scene.bodySwayHeadAmplitude.value"
      :status="ws.status.value"
      :scene-state="scene.state.value"
      :is-playing="performance.isPlaying.value"
      :active-expression="performance.currentExpression.value"
      @update:url="(v: string) => ws.setUrl(v)"
      @connect="onConnect"
      @disconnect="onDisconnect"
      @skip="performance.skip"
    />
  </main>
</template>

<style scoped>
.home {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: var(--bg);
}

.home__status {
  position: absolute;
  left: 24px;
  top: 24px;
  z-index: 30;
}
@media (max-width: 640px) {
  .home__status { left: 16px; top: 16px; }
}
</style>

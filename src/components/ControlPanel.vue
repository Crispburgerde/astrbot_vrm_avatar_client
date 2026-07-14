<script setup lang="ts">
import { ref } from 'vue';
import { Settings, Power, Volume2, VolumeX, SkipForward } from 'lucide-vue-next';
import type { ConnectionStatus } from '@/composables/useWebSocket';
import type { VRMSceneState } from '@/composables/useVRMScene';

const props = defineProps<{
  open: boolean;
  status: ConnectionStatus;
  url: string;
  volume: number;
  muted: boolean;
  sceneState: VRMSceneState;
  isPlaying: boolean;
  /** 当前激活的表情名（用于高亮） */
  activeExpression: string;
  /** 三盏灯的强度 */
  ambientIntensity: number;
  keyLightIntensity: number;
  rimLightIntensity: number;
  /** 呼吸幅度（弧度）：胸腔俯仰、肩部俯仰 */
  chestBreathAmplitude: number;
  shoulderBreathAmplitude: number;
  /** 说话摆动幅度（弧度）：身体偏航/俯仰、头部点头/摇头 */
  bodySwayBodyAmplitude: number;
  bodySwayHeadAmplitude: number;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  'update:url': [value: string];
  'update:volume': [value: number];
  'update:muted': [value: boolean];
  connect: [];
  disconnect: [];
  skip: [];
  'update:ambientIntensity': [value: number];
  'update:keyLightIntensity': [value: number];
  'update:rimLightIntensity': [value: number];
  'update:chestBreathAmplitude': [value: number];
  'update:shoulderBreathAmplitude': [value: number];
  'update:bodySwayBodyAmplitude': [value: number];
  'update:bodySwayHeadAmplitude': [value: number];
}>();

const localUrl = ref(props.url);

function togglePanel(): void {
  emit('update:open', !props.open);
}

function onConnect(): void {
  emit('update:url', localUrl.value.trim());
  emit('connect');
}

function onDisconnect(): void {
  emit('disconnect');
}

function onVolume(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  emit('update:volume', v);
  if (props.muted && v > 0) emit('update:muted', false);
}

function toggleMute(): void {
  emit('update:muted', !props.muted);
}

function onSkip(): void {
  emit('skip');
}

function onAmbient(e: Event): void {
  emit('update:ambientIntensity', Number((e.target as HTMLInputElement).value));
}
function onKeyLight(e: Event): void {
  emit('update:keyLightIntensity', Number((e.target as HTMLInputElement).value));
}
function onRimLight(e: Event): void {
  emit('update:rimLightIntensity', Number((e.target as HTMLInputElement).value));
}

// 呼吸幅度滑块
// 胸腔：滑块值为弧度，显示为度数
const BREATH_CHEST_MAX = 0.1; // 弧度上限（≈ 5.7°）
// 肩膀：滑块值为位移（≈ 米），显示为厘米
const BREATH_SHOULDER_MAX = 0.05; // 上限 5cm
function onChestBreath(e: Event): void {
  emit(
    'update:chestBreathAmplitude',
    Number((e.target as HTMLInputElement).value),
  );
}
function onShoulderBreath(e: Event): void {
  emit(
    'update:shoulderBreathAmplitude',
    Number((e.target as HTMLInputElement).value),
  );
}

// 说话摆动幅度滑块（弧度，显示为度数）
const BODYSWAY_BODY_MAX = 0.1; // 弧度上限（≈ 5.7°）
const BODYSWAY_HEAD_MAX = 0.15; // 弧度上限（≈ 8.6°）
function onBodySwayBody(e: Event): void {
  emit(
    'update:bodySwayBodyAmplitude',
    Number((e.target as HTMLInputElement).value),
  );
}
function onBodySwayHead(e: Event): void {
  emit(
    'update:bodySwayHeadAmplitude',
    Number((e.target as HTMLInputElement).value),
  );
}

function close(): void {
  emit('update:open', false);
}
</script>

<template>
  <button
    class="fab"
    :class="{ 'fab--active': open }"
    :aria-label="open ? '关闭控制面板' : '打开控制面板'"
    @click="togglePanel"
  >
    <Settings :size="20" :stroke-width="1.8" />
  </button>

  <Transition name="drawer">
    <aside v-if="open" class="panel">
      <header class="panel__head">
        <h2 class="panel__title">控制台</h2>
        <button class="panel__close" aria-label="关闭" @click="close">×</button>
      </header>

      <!-- 连接配置 -->
      <section class="block">
        <h3 class="block__title">连接</h3>
        <label class="field">
          <span class="field__label">WebSocket 地址</span>
          <input
            v-model="localUrl"
            class="field__input"
            type="text"
            placeholder="ws://localhost:8765"
            spellcheck="false"
            :disabled="status === 'connected' || status === 'connecting'"
          />
        </label>
        <div class="actions">
          <button
            v-if="status === 'disconnected'"
            class="btn btn--primary"
            @click="onConnect"
          >
            <Power :size="16" :stroke-width="2" /> 连接
          </button>
          <button v-else class="btn btn--ghost" @click="onDisconnect">
            <Power :size="16" :stroke-width="2" /> 断开
          </button>
        </div>
      </section>

      <!-- 音量 -->
      <section class="block">
        <h3 class="block__title">音频</h3>
        <div class="vol">
          <button
            class="vol__mute"
            :aria-label="muted ? '取消静音' : '静音'"
            @click="toggleMute"
          >
            <VolumeX v-if="muted || volume === 0" :size="18" :stroke-width="2" />
            <Volume2 v-else :size="18" :stroke-width="2" />
          </button>
          <input
            class="vol__slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="muted ? 0 : volume"
            :style="{ '--vol': (muted ? 0 : volume) * 100 + '%' }"
            @input="onVolume"
          />
        </div>
        <button
          v-if="isPlaying"
          class="btn btn--ghost btn--full"
          @click="onSkip"
        >
          <SkipForward :size="15" :stroke-width="2" /> 跳过当前表演
        </button>
      </section>

      <!-- 灯光 -->
      <section class="block">
        <h3 class="block__title">灯光</h3>
        <label class="light">
          <span class="light__label">环境光</span>
          <span class="light__value">{{ ambientIntensity.toFixed(2) }}</span>
          <input
            class="light__slider"
            type="range"
            min="0"
            max="3"
            step="0.05"
            :value="ambientIntensity"
            :style="{ '--p': (ambientIntensity / 3) * 100 + '%' }"
            @input="onAmbient"
          />
        </label>
        <label class="light">
          <span class="light__label">主光</span>
          <span class="light__value">{{ keyLightIntensity.toFixed(2) }}</span>
          <input
            class="light__slider"
            type="range"
            min="0"
            max="4"
            step="0.05"
            :value="keyLightIntensity"
            :style="{ '--p': (keyLightIntensity / 4) * 100 + '%' }"
            @input="onKeyLight"
          />
        </label>
        <label class="light">
          <span class="light__label">边缘光</span>
          <span class="light__value">{{ rimLightIntensity.toFixed(2) }}</span>
          <input
            class="light__slider"
            type="range"
            min="0"
            max="3"
            step="0.05"
            :value="rimLightIntensity"
            :style="{ '--p': (rimLightIntensity / 3) * 100 + '%' }"
            @input="onRimLight"
          />
        </label>
      </section>

      <!-- 角色 -->
      <section class="block">
        <h3 class="block__title">角色</h3>
        <p class="sub__hint">呼吸</p>
        <label class="light">
          <span class="light__label">胸腔</span>
          <span class="light__value">
            {{ (chestBreathAmplitude * 180 / Math.PI).toFixed(2) }}°
          </span>
          <input
            class="light__slider"
            type="range"
            min="0"
            :max="BREATH_CHEST_MAX"
            step="0.002"
            :value="chestBreathAmplitude"
            :style="{ '--p': (chestBreathAmplitude / BREATH_CHEST_MAX) * 100 + '%' }"
            @input="onChestBreath"
          />
        </label>
        <label class="light">
          <span class="light__label">肩膀</span>
          <span class="light__value">
            {{ (shoulderBreathAmplitude * 100).toFixed(2) }}cm
          </span>
          <input
            class="light__slider"
            type="range"
            min="0"
            :max="BREATH_SHOULDER_MAX"
            step="0.001"
            :value="shoulderBreathAmplitude"
            :style="{ '--p': (shoulderBreathAmplitude / BREATH_SHOULDER_MAX) * 100 + '%' }"
            @input="onShoulderBreath"
          />
        </label>
        <p class="sub__hint">说话摆动（随音量）</p>
        <label class="light">
          <span class="light__label">身体</span>
          <span class="light__value">
            {{ (bodySwayBodyAmplitude * 180 / Math.PI).toFixed(2) }}°
          </span>
          <input
            class="light__slider"
            type="range"
            min="0"
            :max="BODYSWAY_BODY_MAX"
            step="0.002"
            :value="bodySwayBodyAmplitude"
            :style="{ '--p': (bodySwayBodyAmplitude / BODYSWAY_BODY_MAX) * 100 + '%' }"
            @input="onBodySwayBody"
          />
        </label>
        <label class="light">
          <span class="light__label">头部</span>
          <span class="light__value">
            {{ (bodySwayHeadAmplitude * 180 / Math.PI).toFixed(2) }}°
          </span>
          <input
            class="light__slider"
            type="range"
            min="0"
            :max="BODYSWAY_HEAD_MAX"
            step="0.002"
            :value="bodySwayHeadAmplitude"
            :style="{ '--p': (bodySwayHeadAmplitude / BODYSWAY_HEAD_MAX) * 100 + '%' }"
            @input="onBodySwayHead"
          />
        </label>
      </section>

      <!-- 信息 -->
      <section class="block">
        <h3 class="block__title">舞台状态</h3>
        <dl class="info">
          <div class="info__row">
            <dt>模型</dt>
            <dd>{{ sceneState.loaded ? sceneState.filename : '—' }}</dd>
          </div>
          <div class="info__row">
            <dt>背景</dt>
            <dd>{{ sceneState.hasBackground ? sceneState.backgroundFilename : '—' }}</dd>
          </div>
        </dl>
        <div class="exprs">
          <span
            v-for="e in sceneState.expressions"
            :key="e"
            class="exprs__chip"
            :class="{ 'exprs__chip--active': e === activeExpression }"
          >{{ e }}</span>
          <span v-if="sceneState.expressions.length === 0" class="exprs__empty">
            加载模型后显示表情
          </span>
        </div>
      </section>
    </aside>
  </Transition>

  <!-- 遮罩：移动端点击关闭 -->
  <Transition name="fade">
    <div v-if="open" class="scrim" @click="close" />
  </Transition>
</template>

<style scoped>
/* 浮动按钮 */
.fab {
  position: absolute;
  right: 24px;
  top: 24px;
  z-index: 40;
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--text-strong);
  background: var(--glass);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  cursor: pointer;
  transition: transform 0.25s ease, color 0.25s ease, box-shadow 0.25s ease;
}
.fab:hover {
  transform: rotate(45deg);
  color: var(--accent-amber);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.4);
}
.fab--active {
  color: var(--accent-amber);
}

/* 抽屉面板 */
.panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 50;
  width: min(380px, 90vw);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 26px 24px;
  overflow-y: auto;
  color: var(--text-strong);
  background: linear-gradient(
    180deg,
    rgba(20, 18, 26, 0.82) 0%,
    rgba(12, 11, 16, 0.92) 100%
  );
  border-left: 1px solid var(--glass-border);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: -20px 0 60px rgba(0, 0, 0, 0.5);
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.panel__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.panel__close {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 22px;
  line-height: 1;
  color: var(--text-soft);
  background: transparent;
  border: 1px solid var(--glass-border);
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.panel__close:hover {
  color: var(--accent-coral);
  border-color: rgba(255, 122, 89, 0.5);
}

.block {
  padding: 18px 0;
  border-top: 1px solid var(--hairline);
}
.block:first-of-type { border-top: none; padding-top: 4px; }
.block__title {
  margin: 0 0 14px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent-amber);
}

/* 子分组小标题（如「呼吸」「说话摆动」） */
.sub__hint {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--text-soft);
  opacity: 0.7;
}
.sub__hint:not(:first-child) {
  margin-top: 16px;
}

.field {
  display: block;
  margin-bottom: 14px;
}
.field__label {
  display: block;
  margin-bottom: 7px;
  font-size: 13px;
  color: var(--text-soft);
}
.field__input {
  width: 100%;
  padding: 10px 14px;
  font-size: 14px;
  font-family: var(--font-mono);
  color: var(--text-strong);
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.field__input:focus {
  border-color: var(--accent-amber);
  box-shadow: 0 0 0 3px rgba(232, 184, 109, 0.15);
}
.field__input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.actions { display: flex; gap: 10px; }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
  border-radius: 10px;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.2s ease,
    background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}
.btn:active { transform: translateY(1px); }
.btn--full { width: 100%; margin-top: 12px; }
.btn--primary {
  color: #1a1208;
  background: linear-gradient(135deg, #f0c378, #e8b86d);
  border: 1px solid rgba(255, 255, 255, 0.15);
  box-shadow: 0 6px 18px rgba(232, 184, 109, 0.3);
}
.btn--primary:hover {
  box-shadow: 0 8px 24px rgba(232, 184, 109, 0.45);
}
.btn--ghost {
  color: var(--text-strong);
  background: var(--glass);
  border: 1px solid var(--glass-border);
}
.btn--ghost:hover {
  color: var(--accent-coral);
  border-color: rgba(255, 122, 89, 0.5);
}

.vol {
  display: flex;
  align-items: center;
  gap: 12px;
}
.vol__mute {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%;
  color: var(--text-strong);
  background: var(--glass);
  border: 1px solid var(--glass-border);
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.vol__mute:hover {
  color: var(--accent-amber);
  border-color: rgba(232, 184, 109, 0.5);
}
.vol__slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    var(--accent-amber) 0%,
    var(--accent-amber) var(--vol, 80%),
    rgba(255, 255, 255, 0.12) var(--vol, 80%)
  );
  cursor: pointer;
}
.vol__slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.vol__slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: #fff;
}

/* 灯光滑块 */
.light {
  display: grid;
  grid-template-columns: 56px 44px 1fr;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.light:last-child { margin-bottom: 0; }
.light__label {
  font-size: 13px;
  color: var(--text-soft);
}
.light__value {
  font-family: var(--font-mono);
  font-size: 11px;
  text-align: right;
  color: var(--text-soft);
}
.light__slider {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    var(--accent-amber) 0%,
    var(--accent-amber) var(--p, 50%),
    rgba(255, 255, 255, 0.12) var(--p, 50%)
  );
  cursor: pointer;
}
.light__slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.light__slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: #fff;
}

.info {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.info__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.info__row dt {
  color: var(--text-soft);
  flex-shrink: 0;
}
.info__row dd {
  margin: 0;
  text-align: right;
  color: var(--text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
}

.exprs {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 16px;
}
.exprs__chip {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-soft);
  padding: 4px 11px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--hairline);
  transition: color 0.2s ease, border-color 0.2s ease,
    background 0.2s ease, box-shadow 0.2s ease;
}
.exprs__chip--active {
  color: #1a1208;
  font-weight: 600;
  background: var(--accent-amber);
  border-color: transparent;
  box-shadow: 0 0 14px rgba(232, 184, 109, 0.5);
}
.exprs__empty {
  font-size: 11px;
  color: var(--text-soft);
  opacity: 0.6;
}

/* 遮罩（仅窄屏可见） */
.scrim {
  position: absolute;
  inset: 0;
  z-index: 45;
  background: rgba(0, 0, 0, 0.4);
  display: none;
}
@media (max-width: 640px) {
  .scrim { display: block; }
  .fab { right: 16px; top: 16px; }
}

/* 过渡动画 */
.drawer-enter-active,
.drawer-leave-active { transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1); }
.drawer-enter-from,
.drawer-leave-to { transform: translateX(100%); }

.fade-enter-active,
.fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }
</style>

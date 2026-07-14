import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMUtils, type VRM } from '@pixiv/three-vrm';
import { createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation';
import type { LipSyncWeights, VowelPreset } from '@/types/lipsync';
import { formatToMime } from '@/lib/utils';
import { useBlink } from './useBlink';
import { useEmotion } from './useEmotion';
import { useBreath } from './useBreath';
import { useBodySway } from './useBodySway';
import { loadVRMFromBase64 } from './loadVRM';
import { loadVRMAFromBase64 } from './loadVRMA';
import { usePersistentRef } from './usePersistentRef';
import type { AnimationEntry } from '@/types/messages';

/** 灯光强度持久化存储键 */
const LIGHT_AMBIENT_KEY = 'vrm.light.ambient';
const LIGHT_KEY_KEY = 'vrm.light.key';
const LIGHT_RIM_KEY = 'vrm.light.rim';

/** 呼吸幅度持久化存储键（弧度） */
const BREATH_CHEST_KEY = 'vrm.breath.chest';
const BREATH_SHOULDER_KEY = 'vrm.breath.shoulder';

/** 说话摆动幅度持久化存储键（弧度） */
const BODYSWAY_BODY_KEY = 'vrm.bodysway.body';
const BODYSWAY_HEAD_KEY = 'vrm.bodysway.head';

/** 模型当前信息 */
export interface VRMSceneState {
  /** 是否已加载模型 */
  loaded: boolean;
  /** 当前 VRM 文件名 */
  filename: string;
  /** 是否已设置背景 */
  hasBackground: boolean;
  /** 背景文件名 */
  backgroundFilename: string;
  /** 模型内嵌的表情名列表（已过滤口型/眨眼/视线等功能性表情） */
  expressions: string[];
}

/**
 * three.js 场景层：负责场景/相机/灯光/渲染循环，以及 VRM 模型加载、
 * 背景切换、表情与口型驱动。
 */
export function useVRMScene(canvasRef: Ref<HTMLCanvasElement | null>) {
  const state = ref<VRMSceneState>({
    loaded: false,
                   filename: '',
    hasBackground: false,
    backgroundFilename: '',
    expressions: [],
  });

  // 灯光强度（响应式 + 持久化）：watch 在 init 之后建立
  const ambientIntensity = usePersistentRef<number>(LIGHT_AMBIENT_KEY, 1.6);
  const keyLightIntensity = usePersistentRef<number>(LIGHT_KEY_KEY, 2.2);
  const rimLightIntensity = usePersistentRef<number>(LIGHT_RIM_KEY, 1.0);

  // 呼吸幅度（响应式 + 持久化）：胸腔俯仰（弧度）+ 肩部上下平移（≈ 米）
  const chestBreathAmplitude = usePersistentRef<number>(BREATH_CHEST_KEY, 0.02);
  const shoulderBreathAmplitude = usePersistentRef<number>(
    BREATH_SHOULDER_KEY,
    0.01,
  );

  // 说话摆动幅度（响应式 + 持久化）：身体偏航/俯仰 + 头部点头/摇头（弧度）
  const bodySwayBodyAmplitude = usePersistentRef<number>(BODYSWAY_BODY_KEY, 0.03);
  const bodySwayHeadAmplitude = usePersistentRef<number>(BODYSWAY_HEAD_KEY, 0.05);

  // ---- three.js 核心对象 ----
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let ambient: THREE.HemisphereLight;
  let keyLight: THREE.DirectionalLight;
  let rimLight: THREE.DirectionalLight;

  // 光源位置辅助球体（调试用）
  const lightHelpers: THREE.Mesh[] = [];
  let helperGeom: THREE.SphereGeometry | null = null;

  let currentVrm: VRM | null = null;
  let currentVrmRoot: THREE.Object3D | null = null;
  let bgTexture: THREE.Texture | null = null;

  // VRMA 动画：以 name 为键的多个模型无关动画，由后端推送。
  // idle 为待机动画，其余可由 performance 段的 action 字段按名引用。
  const animationsMap = new Map<string, { vrma: VRMAnimation; loop: boolean }>();
  let mixer: THREE.AnimationMixer | null = null;
  // 当前播放中的动画 action（循环或单次）
  let currentAction: THREE.AnimationAction | null = null;
  // 当前播放中的动画名（'idle'/待机名，或 performance 段的 action 名）。
  // 用于判断“同一动作”以保持连续播放，避免重复触发导致跳帧。
  let currentActionName: string | null = null;
  // 动作切换 / 回归待机时的交叉淡入淡出时长（秒）
  const FADE_DURATION = 0.3;

  /** 解析待机动画名：优先 'idle'，否则回退到 Map 中的首个条目 */
  function resolveIdleName(): string | undefined {
    if (animationsMap.has('idle')) return 'idle';
    return animationsMap.keys().next().value;
  }

  // 轨道摄像机控制器
  let controls: OrbitControls | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rafId = 0;
  let lastTime = performance.now();

  // 情绪过渡（独立的生命感动画层）
  const emotion = useEmotion();

  // 自然眨眼（独立的生命感动画层）
  const blink = useBlink();

  // 程序化呼吸（独立的生命感动画层：在 chest 父级插入 Offset 节点叠加正弦波）
  const breath = useBreath();

  // 说话摆动（独立的生命感动画层：音量驱动身体/头部摆动，仅在说话时生效）
  const bodySway = useBodySway();

  // 唇形：由 usePerformance 在每帧更新（五元音权重）
  const lipWeights: LipSyncWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

  function init(): void {
    const canvas = canvasRef.value;
    if (!canvas) return;

    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);

    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.35, 2.2);

    // 灯光：樱花粉/淡紫半球补光 + 清透柔白主光 + 梦幻紫边缘光（二次元直播间风格）
    ambient = new THREE.HemisphereLight(0xffd6ec, 0xe0d6ff, ambientIntensity.value);
    scene.add(ambient);

    keyLight = new THREE.DirectionalLight(0xfff8f2, keyLightIntensity.value);
    keyLight.position.set(0.6, 2.2, 2.0);
    scene.add(keyLight);

    rimLight = new THREE.DirectionalLight(0xd4a5ff, rimLightIntensity.value);
    rimLight.position.set(-1.2, 1.4, -1.0);
    scene.add(rimLight);

    // 光源位置辅助球体（调试用，颜色对应色温，与各光源一致）
    helperGeom = new THREE.SphereGeometry(0.08, 16, 16);

    const ambientHelper = new THREE.Mesh(
      helperGeom,
      new THREE.MeshBasicMaterial({ color: 0xffd6ec }),
    );
    // HemisphereLight 无方向性位置，放在角色头顶上方作视觉占位
    ambientHelper.position.set(0, 2.6, 0);
    scene.add(ambientHelper);
    lightHelpers.push(ambientHelper);

    const keyHelper = new THREE.Mesh(
      helperGeom,
      new THREE.MeshBasicMaterial({ color: 0xfff8f2 }),
    );
    keyHelper.position.copy(keyLight.position);
    scene.add(keyHelper);
    lightHelpers.push(keyHelper);

    const rimHelper = new THREE.Mesh(
      helperGeom,
      new THREE.MeshBasicMaterial({ color: 0xd4a5ff }),
    );
    rimHelper.position.copy(rimLight.position);
    scene.add(rimHelper);
    lightHelpers.push(rimHelper);

    // 默认隐藏光源辅助球体（仅调试时手动置 visible=true）
    lightHelpers.forEach((m) => (m.visible = false));

    // 响应式 → three.js 灯光对象同步
    watch(ambientIntensity, (v) => {
      if (ambient) ambient.intensity = v;
    });
    watch(keyLightIntensity, (v) => {
      if (keyLight) keyLight.intensity = v;
    });
    watch(rimLightIntensity, (v) => {
      if (rimLight) rimLight.intensity = v;
    });

    // 响应式 → 呼吸幅度实时同步（滑块调节即时生效，无需重新绑定模型）
    watch(chestBreathAmplitude, (v) => {
      breath.setOptions({ amplitudeX: v });
    });
    watch(shoulderBreathAmplitude, (v) => {
      breath.setOptions({ shoulderAmplitude: v });
    });

    // 响应式 → 说话摆动幅度实时同步
    watch(bodySwayBodyAmplitude, (v) => {
      bodySway.setOptions({ bodyAmplitude: v });
    });
    watch(bodySwayHeadAmplitude, (v) => {
      bodySway.setOptions({ headAmplitude: v });
    });

    resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(canvas);
    handleResize();

    // 轨道摄像机：左键拖拽改变角度、滚轮改变距离、中键拖拽平移
    controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 1.35, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // 默认中键为 DOLLY（缩放），改为 PAN（平移），缩放交给滚轮
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.update();

    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function handleResize(): void {
    if (!renderer || !canvasRef.value) return;
    const w = canvasRef.value.clientWidth || window.innerWidth;
    const h = canvasRef.value.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function loop(): void {
    rafId = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    // 轨道摄像机阻尼更新
    controls?.update();

    // 表情平滑过渡
    emotion.update(dt);
    // 自然眨眼
    blink.update(dt);
    // 程序化呼吸
    breath.update(dt);
    // 说话摆动（音量驱动）
    bodySway.update(dt);

    // 动画混合器：驱动 VRMA 关键帧（先于 vrm.update，使骨骼变换先就位）
    if (mixer) mixer.update(dt);

    if (currentVrm) {
      // VRM 必须每帧调用 update（驱动 spring bone / lookAt 等）
      currentVrm.update(dt);
    }

    renderer?.render(scene, camera);
  }

  /** 加载 base64 编码的 VRM 文件 */
  async function loadVrmFromBase64(b64: string, filename: string): Promise<void> {
    // 解析 + 优化（无状态，已抽离到 loadVRM.ts）
    const { vrm, root: vrmRoot } = await loadVRMFromBase64(b64);

    // 清理旧模型
    disposeCurrentVrm();

    scene.add(vrmRoot);
    currentVrm = vrm;
    currentVrmRoot = vrmRoot;

    // 视线跟踪：让角色注视摄像机
    const la = vrm.lookAt;
    if (la) {
      la.target = camera;
      la.autoUpdate = true;

      // 诊断：静态属性需通过 constructor 读取
      const applier = la.applier as { constructor?: { type?: string } } | null;
      const applierType = applier?.constructor?.type ?? 'none';
      // eslint-disable-next-line no-console
      console.log(
        `[VRM] lookAt: 已启用（跟踪摄像机）, ` +
          `applier=${applierType}, autoUpdate=${la.autoUpdate}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn('[VRM] lookAt: 该模型不含视线跟踪数据，无法启用视线跟随');
    }

    // 提取模型内嵌表情名（过滤口型/眨眼/视线等功能性表情）
    const exprMap = vrm.expressionManager?.expressionMap ?? {};
    const exprNames = Object.keys(exprMap).filter((n) => !UTIL_EXPRESSIONS.has(n));

    // 配置眨眼：检测 manager 是否含眨眼表情（blink / blinkLeft+Right）
    blink.configure(vrm.expressionManager);
    // 配置情绪：注入 manager 与模型内嵌的情绪表情名，重置为无情绪
    emotion.configure(vrm.expressionManager, exprNames);
    // 配置呼吸：在 chest 父级插入 Offset 节点（模型无 chest 骨骼时自动跳过）。
    // 传入当前持久化的胸腔/肩部幅度。
    breath.configure(vrm.humanoid, {
      amplitudeX: chestBreathAmplitude.value,
      shoulderAmplitude: shoulderBreathAmplitude.value,
    });
    // 配置说话摆动：在 spine（或 chest 回退）/ head 父级插入 Offset 节点。
    // 传入当前持久化的身体/头部幅度。
    bodySway.configure(vrm.humanoid, {
      bodyAmplitude: bodySwayBodyAmplitude.value,
      headAmplitude: bodySwayHeadAmplitude.value,
    });

    frameUpperBody(vrmRoot);

    state.value = {
      ...state.value,
      loaded: true,
      filename,
      expressions: exprNames,
    };

    // 模型切换后重新绑定已保存的 VRMA 动画（恢复 idle 默认循环）
    setupAnimations();
  }

  /** 基于模型包围盒自动取景为半身像 */
  function frameUpperBody(root: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    if (!isFinite(size.y) || size.y === 0) return;

    // 用模型最长轴作为取景基准，兼容非标准坐标系（如横躺/非原点居中模型）。
    // 旧实现假设模型站立且 y 轴为主轴，对异常坐标系会算出错误相机位置，
    // 导致整个模型落在视野之外。
    const maxDim = Math.max(size.x, size.y, size.z);
    const halfExtent = maxDim * 0.6; // 留出适量边距

    const vFov = (camera.fov * Math.PI) / 180;
    // 镜头到焦点的距离，使模型最长轴刚好填满竖直视场
    const dist = halfExtent / Math.tan(vFov / 2);
    camera.position.set(center.x, center.y, center.z + dist);
    camera.lookAt(center.x, center.y, center.z);
    camera.near = Math.max(0.05, dist * 0.1);
    camera.far = dist * 10;
    camera.updateProjectionMatrix();

    // 同步轨道摄像机目标到取景焦点
    if (controls) {
      controls.target.set(center.x, center.y, center.z);
      controls.update();
    }
  }

  /** 加载 base64 编码的背景图 */
  function loadBackgroundFromBase64(b64: string, format: string, filename: string): void {
    const mime = formatToMime(format);
    const dataUrl = `data:${mime};base64,${b64}`;
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      if (bgTexture) {
        bgTexture.dispose();
      }
      bgTexture = tex;
      scene.background = tex;
      state.value = {
        ...state.value,
        hasBackground: true,
        backgroundFilename: filename,
      };
    });
  }

  /**
   * 将待机动画（idle，无 idle 时取首个）绑定到当前 VRM 模型。
   * 模型缺失时只清理旧 mixer，等模型加载后再绑定。
   */
  function setupAnimations(): void {
    disposeMixer();
    if (!currentVrm || !currentVrmRoot) {
      return;
    }

    const idleName = resolveIdleName();
    const standby = idleName ? animationsMap.get(idleName) : undefined;
    if (!standby) {
      return;
    }

    mixer = new THREE.AnimationMixer(currentVrmRoot);
    const clip = createVRMAnimationClip(standby.vrma, currentVrm);
    if (clip) {
      currentAction = mixer.clipAction(clip);
      // 待机动画必须持续循环：忽略来源 loop 配置，
      // 否则 LoopOnce 播完会松开骨骼权重，模型回到 T-pose。
      currentAction.loop = THREE.LoopRepeat;
      currentAction.play();
      currentActionName = idleName ?? null;
    }

    console.log(`[VRMA] 已绑定待机动画 (强制 loop=true)`);
  }

  /** 解析后端推送的多个命名 VRMA 动画并缓存，随后绑定待机动画。 */
  async function loadAnimationsFromBase64(
    entries: AnimationEntry[],
  ): Promise<void> {
    animationsMap.clear();
    for (const entry of entries) {
      try {
        const vrmas = await loadVRMAFromBase64(entry.file.data);
        if (vrmas[0]) {
          animationsMap.set(entry.name, { vrma: vrmas[0], loop: entry.loop });
          // eslint-disable-next-line no-console
          console.log(`[VRMA] 已加载动画: ${entry.name} (loop=${entry.loop})`);
        }
      } catch (e) {
        console.error(`[VRMA] 动画 "${entry.name}" 加载失败:`, e);
      }
    }
    setupAnimations();
  }

  /**
   * 按名播放一个动作动画（由 performance 段的 action 触发）。
   * - 若与当前正在播放的动作同名且为循环动作，则保持连续播放，不重新触发；
   * - 否则以交叉淡入淡出切换到新动作；
   * - 非循环动作播放完毕后自动回归待机动画。
   */
  function playAction(name: string): void {
    if (!mixer || !currentVrm) return;
    const entry = animationsMap.get(name);
    if (!entry) {
      // eslint-disable-next-line no-console
      console.warn(`[VRMA] 未找到动作动画: ${name}`);
      return;
    }

    // 同一个循环动作正在播放：保持连续，不重新触发，避免跳帧/打断
    if (name === currentActionName && entry.loop && currentAction) {
      return;
    }

    const clip = createVRMAnimationClip(entry.vrma, currentVrm);
    if (!clip) return;

    const action = mixer.clipAction(clip);
    action.loop = entry.loop ? THREE.LoopRepeat : THREE.LoopOnce;
    action.clampWhenFinished = !entry.loop;
    // 当前动作淡出，新动作淡入（交叉过渡）
    fadeOutPrev(currentAction, action);
    action.reset().fadeIn(FADE_DURATION).play();
    currentAction = action;
    currentActionName = name;

    // 非循环动作结束后回归待机
    if (!entry.loop) {
      const onFinished = (): void => {
        mixer?.removeEventListener('finished', onFinished);
        returnToIdle();
      };
      mixer.addEventListener('finished', onFinished);
    }
  }

  /**
   * 将上一个动作交叉淡出，并在淡出时长后停止它，避免在 mixer 中累积。
   * next 为即将淡入的新动作，仅用于避免停止自身。
   */
  function fadeOutPrev(
    prev: THREE.AnimationAction | null,
    next: THREE.AnimationAction,
  ): void {
    if (!prev || prev === next) return;
    prev.fadeOut(FADE_DURATION);
    // 淡出完成后停止旧动作，释放 mixer 内的 action（weight 已为 0 不影响渲染）
    window.setTimeout(() => {
      try {
        prev.stop();
      } catch {
        /* mixer 可能已销毁，忽略 */
      }
    }, FADE_DURATION * 1000 + 60);
  }

  /**
   * 淡出到待机（idle）动作。供动作结束、队列结束、skip 调用，
   * 确保循环动作（如 dance）能够停下来回归待机。
   */
  function returnToIdle(): void {
    if (!mixer || !currentVrm) return;
    const idleName = resolveIdleName();
    const idle = idleName ? animationsMap.get(idleName) : undefined;
    if (!idle) return;

    // 已在待机：无需切换
    if (currentActionName === idleName && currentAction) return;

    const idleClip = createVRMAnimationClip(idle.vrma, currentVrm);
    if (!idleClip) return;

    const idleAction = mixer.clipAction(idleClip);
    // 待机动画强制循环
    idleAction.loop = THREE.LoopRepeat;
    fadeOutPrev(currentAction, idleAction);
    idleAction.reset().fadeIn(FADE_DURATION).play();
    currentAction = idleAction;
    currentActionName = idleName ?? null;
  }

  /** 停止并释放当前动画混合器 */
  function disposeMixer(): void {
    if (mixer) {
      mixer.stopAllAction();
      mixer = null;
    }
    currentAction = null;
    currentActionName = null;
  }

  /** 设置情绪表情（带平滑过渡） */
  function setEmotion(name: string): void {
    emotion.setEmotion(name);
  }

  /** 设置五元音口型权重（0~1），由 wLipSync 驱动 */
  function setLipWeights(weights: Partial<LipSyncWeights>): void {
    const manager = currentVrm?.expressionManager;
    if (!manager) return;
    (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
      const v = weights[key];
      if (v === undefined) return;
      const clamped = Math.max(0, Math.min(1, v));
      lipWeights[key] = clamped;
      manager.setValue(key, clamped);
    });
  }

  /** 复位所有口型权重为 0 */
  function resetLipWeights(): void {
    const manager = currentVrm?.expressionManager;
    (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
      lipWeights[key] = 0;
      manager?.setValue(key, 0);
    });
  }

  function getLipWeights(): LipSyncWeights {
    return lipWeights;
  }

  /**
   * 设置当前说话音量（0~1），由表演层每帧从 wLipSync 归一化音量传入，
   * 驱动身体/头部摆动幅度。值越大摆动越明显，安静时自动归零。
   */
  function setAudioLevel(level: number): void {
    bodySway.setAudioLevel(level);
  }

  function disposeCurrentVrm(): void {
    // 先停止动画混合器，避免释放模型骨骼后 mixer 仍引用失效对象
    disposeMixer();
    if (currentVrmRoot) {
      scene.remove(currentVrmRoot);
      VRMUtils.deepDispose(currentVrmRoot);
      currentVrmRoot = null;
    }
    currentVrm = null;
    // 重置情绪、眨眼、呼吸、说话摆动状态
    emotion.reset();
    blink.reset();
    breath.reset();
    bodySway.reset();
    if (state.value.loaded) {
      state.value = { ...state.value, loaded: false, filename: '', expressions: [] };
    }
  }

  function dispose(): void {
    cancelAnimationFrame(rafId);
    controls?.dispose();
    controls = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    disposeCurrentVrm();
    // 清理光源辅助球体
    lightHelpers.forEach((m) => {
      scene.remove(m);
      (m.material as THREE.Material).dispose();
    });
    lightHelpers.length = 0;
    helperGeom?.dispose();
    helperGeom = null;
    if (bgTexture) {
      bgTexture.dispose();
      bgTexture = null;
    }
    renderer?.dispose();
    renderer = null;
  }

  onBeforeUnmount(dispose);

  return {
    state,
    ambientIntensity,
    keyLightIntensity,
    rimLightIntensity,
    chestBreathAmplitude,
    shoulderBreathAmplitude,
    bodySwayBodyAmplitude,
    bodySwayHeadAmplitude,
    init,
    loadVrmFromBase64,
    loadBackgroundFromBase64,
    loadAnimationsFromBase64,
    playAction,
    returnToIdle,
    setEmotion,
    setLipWeights,
    resetLipWeights,
    getLipWeights,
    setAudioLevel,
  };
}

/** VRM 内嵌的功能性表情（口型/眨眼/视线），展示时过滤掉 */
export const UTIL_EXPRESSIONS = new Set([
  // 口型元音
  'aa', 'ih', 'ou', 'ee', 'oh',
  // 眨眼
  'blink', 'blinkLeft', 'blinkRight',
  // 视线
  'lookUp', 'lookDown', 'lookLeft', 'lookRight',
]);

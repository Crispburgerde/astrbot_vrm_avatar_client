import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { VRMAnimation } from '@pixiv/three-vrm-animation';
import type { LipSyncWeights, VowelPreset } from '@/types/lipsync';
import { useFaceDriver, type FaceEmotionState } from '@/emotion/faceDriver';
import { useBreath } from './useBreath';
import { useBodySway } from './useBodySway';
import { loadVRM } from './loadVRM';
import { loadVRMA } from './loadVRMA';
import { usePersistentRef } from './usePersistentRef';
import { AnimationController } from '@/animation/AnimationController';
import type { AnimationLayer } from '@/types/messages';

/** loadAnimations 的输入条目：命名动画 + 类别 + 已取得的 VRMA 字节 */
export interface AnimationFileInput {
  name: string;
  layer?: AnimationLayer;
  buffer: ArrayBuffer;
}

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

  // 视线跟随测试球（调试用，当前已停用）：在人物眼前左右往返飞行的微小球体，
  // 代替摄像机作为 lookAt 注视目标，用于检验视线跟随效果。
  // 置 true 可重新启用（创建球体并接管视线目标）
  const GAZE_TEST_ENABLED = false;
  let gazeTestTarget: THREE.Mesh | null = null;
  let gazeTestTime = 0;
  // 球体运动参数：脸部正前方（模型朝 +Z），眼部高度附近
  const GAZE_TEST_Y = 1.28;
  const GAZE_TEST_Z = 0.3;
  const GAZE_TEST_AMP = 0.6; // 左右振幅（米）
  const GAZE_TEST_SPEED = 2.2; // 角频率（rad/s），周期约 2.9 秒

  let currentVrm: VRM | null = null;
  let currentVrmRoot: THREE.Object3D | null = null;
  let bgTexture: THREE.Texture | null = null;

  // ---- 分层动画系统 ----
  // 四层：Base（可切换的基础层）/ Additive（程序化叠加）/ Gesture（上半身遮罩）/
  //       Action（全身覆盖）。VRMA 动画集由后端推送，name 为键（模型无关）。
  const animator = new AnimationController();

  // 轨道摄像机控制器
  let controls: OrbitControls | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rafId = 0;
  let lastTime = performance.now();

  // 表情驱动层（Soullink FaceEngine：情绪/眨眼/头部姿态/视线 + 口型闸门）
  const face = useFaceDriver();

  // 情绪状态（VAD 快照，供 UI 展示；渲染循环内 ~10Hz 节流更新）
  const emotionState = ref<FaceEmotionState | null>(null);
  let lastEmotionSync = 0;

  // 程序化呼吸（Additive 层组件：在 chest 父级插入 Offset 节点叠加正弦波）
  const breath = useBreath();

  // 说话摆动（Additive 层组件：音量驱动身体/头部摆动，仅在说话时生效）
  const bodySway = useBodySway();

  // Additive 层注册：呼吸与说话摆动经控制器统一编排——每帧最先应用、
  // 数学叠加（Offset 节点父子相乘），不覆盖任何关键帧层，Action 期间也保持
  animator.registerAdditive((dt) => breath.update(dt));
  animator.registerAdditive((dt) => bodySway.update(dt));

  // 唇形：由 usePerformance 每帧更新，faceDriver 统一写入面部 morph
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

    // 视线跟随测试球：自发光微小球体（不受灯光影响，始终清晰可见）。
    // GAZE_TEST_ENABLED = false 时不创建，视线目标自动回退为摄像机
    if (GAZE_TEST_ENABLED) {
      gazeTestTarget = new THREE.Mesh(
        new THREE.SphereGeometry(0.02, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x40ffff }),
      );
      gazeTestTarget.position.set(0, GAZE_TEST_Y, GAZE_TEST_Z);
      scene.add(gazeTestTarget);
    }

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

    // 视线跟随测试球：在人物眼前左右往返飞行
    if (gazeTestTarget) {
      gazeTestTime += dt;
      gazeTestTarget.position.x = Math.sin(gazeTestTime * GAZE_TEST_SPEED) * GAZE_TEST_AMP;
    }

    // 表情引擎推进（情绪 AU / 眨眼 / 头部姿态 / 视线偏移，内部 120Hz 定步长）
    face.update(dt);
    // VAD 快照节流同步到 UI（避免 60Hz 触发响应式更新）
    if (now - lastEmotionSync > 100) {
      lastEmotionSync = now;
      emotionState.value = face.readState();
    }

    // 还原上一帧的头部姿态偏移（保证无 VRMA 头部轨道时偏移不累积）
    face.prepareHead();

    // 分层动画控制器：Additive（呼吸/摆动）→ Base → Gesture → Action
    // （先于 vrm.update，使骨骼变换先就位）
    animator.update(dt);

    // VRMA 关键帧就位后叠加情绪头部姿态偏移 + 写入视线角度
    face.applyHead();

    if (currentVrm) {
      currentVrm.update(dt);
    }

    // 面部写入放在 vrm.update 之后：直写 morph 覆盖 expressionManager 输出
    face.applyFace();

    renderer?.render(scene, camera);
  }

  /** 加载 VRM 模型（GLB 字节，来源为 HTTP 下载或 base64 解码） */
  async function loadVrm(buffer: ArrayBuffer, filename: string): Promise<void> {
    // 解析 + 优化（无状态，已抽离到 loadVRM.ts）
    const { vrm, root: vrmRoot } = await loadVRM(buffer);

    // 清理旧模型
    disposeCurrentVrm();

    scene.add(vrmRoot);
    currentVrm = vrm;
    currentVrmRoot = vrmRoot;

    // 视线由 faceDriver 接管（注视摄像机或视线测试球 + 情绪视线偏移）：
    // lookAt.autoUpdate 关闭，每帧手算方向角写入 yaw/pitch
    if (vrm.lookAt) {
      vrm.lookAt.autoUpdate = false;
    }

    // 修复：Koikatu 等模型的眼部由多层近平面网格叠成（眼白 sirome + 瞳孔 hitomi），
    // 全是 BLEND + transparentWithZWrite=false，three.js 透明排序只按质心距离，
    // 这些近平面网格距离相近 → 排序不稳定 → 摄像机侧转时白色眼白错误画到瞳孔前，
    // 视觉上瞳孔被眼白覆盖（"变白"）。Unity 无此问题因其渲染器对透明队列处理不同。
    // 修复策略：按材质名识别瞳孔(hitomi/iris)层，提高其 renderOrder，强制后于眼白绘制，
    // 使其稳定地画在眼白之上。对不含此类分层的模型无副作用。
    // 同时为 hitomi 启用 depthWrite，从根本上消除与眼白的排序竞争。
    fixEyeRenderOrder(vrmRoot);

    // 提取模型内嵌表情名（过滤口型/眨眼/视线等功能性表情；仅作 UI 展示，
    // 情绪驱动已由 faceDriver 按 morph 绑定接管，不再依赖模型表情名）
    const exprMap = vrm.expressionManager?.expressionMap ?? {};
    const exprNames = Object.keys(exprMap).filter((n) => !UTIL_EXPRESSIONS.has(n));

    // 绑定表情驱动层：morph 收集 / AU 绑定解析 / lookAt 接管（含测试球目标）
    face.configure(vrm, gazeTestTarget ?? camera);

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

  /**
   * 修复 Koikatu 等模型瞳孔被眼白覆盖的透明排序问题。
   *
   * 这些模型的眼部由近平面网格叠成：眼白(sirome) + 瞳孔/虹膜(hitomi)，
   * 材质全为 BLEND + transparentWithZWrite=false，three.js 透明排序只按质心距离，
   * 近平面网格间距离相近 → 排序不稳定 → 摄像机侧转时眼白错误画到瞳孔前。
   *
   * 做法：按材质名识别瞳孔层（hitomi/iris/pupil），为其所在 Mesh 提高 renderOrder，
   * 强制后于眼白绘制；并开启 depthWrite，用深度缓冲稳定遮挡关系。
   * 仅作用于瞳孔相关材质，对其他模型/网格无副作用。
   */
  function fixEyeRenderOrder(root: THREE.Object3D): void {
    // 瞳孔/虹膜材质名特征（Koikatu 用 hitomi，通用模型常用 iris/pupil/eye）
    const PUPIL_RE = /hitomi|iris|pupil/i;
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material;
      const match = (Array.isArray(mat) ? mat : [mat]).some((m) =>
        PUPIL_RE.test(m.name),
      );
      if (!match) return;
      // 提高瞳孔层渲染顺序（透明队列内数值越大越后绘制 → 画在更上层）
      obj.renderOrder = (obj.renderOrder || 0) + 1;
      // 启用深度写入，使瞳孔能被正确遮挡测试，消除与眼白的排序竞争
      const materials = Array.isArray(mat) ? mat : [mat];
      materials.forEach((m) => {
        m.depthWrite = true;
        m.needsUpdate = true;
      });
    });
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

  /** 加载背景图（sourceUrl 为文件下载服务 URL 或 base64 data URL） */
  function loadBackground(sourceUrl: string, filename: string): void {
    const loader = new THREE.TextureLoader();
    loader.load(sourceUrl, (tex) => {
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
   * 将分层动画控制器绑定到当前 VRM 模型（Base 层自动进入待机循环）。
   * 模型缺失时只清理旧层，等模型加载后再绑定。
   */
  function setupAnimations(): void {
    if (currentVrm && currentVrmRoot) {
      animator.bind(currentVrm, currentVrmRoot);
      // eslint-disable-next-line no-console
      console.log('[Animator] 已绑定分层动画（Base/Gesture/Additive/Action）');
    } else {
      animator.unbind();
    }
  }

  /** 解析后端推送的多个命名 VRMA 动画并注入动画控制器，随后绑定待机动画。
   *  每个动画的类别（layer）一并保存，[action:x] 即时播放时据此区分路由：
   *  gesture → Gesture 层上半身遮罩，action → Action 层全身覆盖。 */
  async function loadAnimations(items: AnimationFileInput[]): Promise<void> {
    const animationsMap = new Map<string, VRMAnimation>();
    const layersMap = new Map<string, AnimationLayer>();
    // layer=idle 的动画即默认待机（服务端声明，客户端不靠命名猜）；没有则用命名约定
    let idleName: string | undefined;
    for (const item of items) {
      try {
        const vrmas = await loadVRMA(item.buffer);
        if (vrmas[0]) {
          const layer = item.layer ?? 'action';
          animationsMap.set(item.name, vrmas[0]);
          layersMap.set(item.name, layer);
          if (layer === 'idle' && idleName === undefined) idleName = item.name;
          // eslint-disable-next-line no-console
          console.log(`[VRMA] 已加载动画: ${item.name} (layer=${layer})`);
        }
      } catch (e) {
        console.error(`[VRMA] 动画 "${item.name}" 加载失败:`, e);
      }
    }
    if (idleName === undefined && animationsMap.has('idle')) idleName = 'idle';
    animator.setAnimations(animationsMap, layersMap, idleName);
    setupAnimations();
  }

  /**
   * 按名播放一个一次性动画（[action:x] 事件触发），按该动画注册的 layer 路由：
   * - gesture → Gesture 层：上半身遮罩（躯干上部/颈/头/肩/臂/手/指 + 表情），
   *   下半身继续走 Base 层，播完自动交还
   * - action → Action 层：全身覆盖，触发瞬间静音 Base/Gesture，播完自动释放
   */
  function playAction(name: string): void {
    animator.playOneShot(name);
  }

  /**
   * 等待一次性覆盖层（Gesture/Action）完全空闲：动画播完并结束释放淡出。
   * 表演层用于段落时序同步——带 action 的段要等动画与台词都结束才进下一段。
   * 兜底：覆盖层异常忙碌超过 60s 时强制 resolve，避免表演队列卡死
   * （正常路径有 onFinished / watchdog 保证必然释放）。
   */
  function waitActionDone(): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = (): void => {
        if (!animator.isOverlayBusy || performance.now() - start > 60_000) {
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  /**
   * 切换 Base 层动画（[idle:x] 事件触发，sticky）。
   * 立即交叉淡化到目标动画；null 恢复默认待机。
   */
  function setIdle(name: string | null): void {
    animator.setIdle(name);
  }

  /**
   * 释放覆盖层回归待机：让进行中的 Action/Gesture 停下来，
   * 显形为常驻的 Base 待机动画。
   */
  function returnToIdle(): void {
    animator.returnToIdle();
  }

  /** 触发情绪表情（24 词表 + 强度 0~1，词表外由 faceDriver 回退 neutral） */
  function setEmotion(name: string, intensity?: number): void {
    face.setEmotion(name, intensity);
  }

  /** 设置五元音口型权重（0~1），由 wLipSync 驱动 */
  function setLipWeights(weights: Partial<LipSyncWeights>): void {
    (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
      const v = weights[key];
      if (v !== undefined) lipWeights[key] = Math.max(0, Math.min(1, v));
    });
    face.setLipWeights(weights);
  }

  /** 复位所有口型权重为 0 */
  function resetLipWeights(): void {
    (Object.keys(lipWeights) as VowelPreset[]).forEach((key) => {
      lipWeights[key] = 0;
    });
    face.resetLipWeights();
  }

  function getLipWeights(): LipSyncWeights {
    return lipWeights;
  }

  /**
   * 设置当前说话音量（0~1），由表演层每帧从 wLipSync 归一化音量传入，
   * 驱动身体/头部摆动幅度。值越大效果越明显，安静时自动归零。
   */
  function setAudioLevel(level: number): void {
    bodySway.setAudioLevel(level);
  }

  function disposeCurrentVrm(): void {
    // 先解绑动画层，避免释放模型骨骼后 mixer 仍引用失效对象
    animator.unbind();
    if (currentVrmRoot) {
      scene.remove(currentVrmRoot);
      VRMUtils.deepDispose(currentVrmRoot);
      currentVrmRoot = null;
    }
    currentVrm = null;
    // 重置表情驱动、呼吸、说话摆动状态
    face.reset();
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
    animator.dispose();
    // 清理光源辅助球体
    lightHelpers.forEach((m) => {
      scene.remove(m);
      (m.material as THREE.Material).dispose();
    });
    lightHelpers.length = 0;
    helperGeom?.dispose();
    helperGeom = null;
    // 清理视线跟随测试球
    if (gazeTestTarget) {
      scene.remove(gazeTestTarget);
      gazeTestTarget.geometry.dispose();
      (gazeTestTarget.material as THREE.Material).dispose();
      gazeTestTarget = null;
    }
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
    emotionState,
    ambientIntensity,
    keyLightIntensity,
    rimLightIntensity,
    chestBreathAmplitude,
    shoulderBreathAmplitude,
    bodySwayBodyAmplitude,
    bodySwayHeadAmplitude,
    init,
    loadVrm,
    loadBackground,
    loadAnimations,
    playAction,
    waitActionDone,
    setIdle,
    returnToIdle,
    setEmotion,
    setLipWeights,
    resetLipWeights,
    getLipWeights,
    setAudioLevel,
    animator,
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

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';

/**
 * 加载 base64 编码的 VRMA 文件，返回解析出的 VRMAnimation 列表。
 * VRMAnimation 与具体模型无关，可缓存后用 createVRMAnimationClip 绑定到任意 VRM。
 * 纯异步变换，无场景状态依赖，可独立测试。
 */
export async function loadVRMAFromBase64(b64: string): Promise<VRMAnimation[]> {
  // 用浏览器原生 fetch 异步解码 base64，避免 atob + 逐字节循环阻塞主线程
  const resp = await fetch(`data:application/octet-stream;base64,${b64}`);
  const buffer = await resp.arrayBuffer();

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const gltf = await loader.parseAsync(buffer, '');

  const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
  if (!animations || animations.length === 0) {
    throw new Error('未在 VRMA 文件中找到动画数据');
  }
  return animations;
}

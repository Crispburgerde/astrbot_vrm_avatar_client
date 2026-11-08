import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';

/**
 * 加载 VRMA（GLB 字节），返回解析出的 VRMAnimation 列表。
 * VRMAnimation 与具体模型无关，可缓存后用 createVRMAnimationClip 绑定到任意 VRM。
 * 纯异步变换，无场景状态依赖；字节来源不限（HTTP 下载或 base64 解码）。
 */
export async function loadVRMA(buffer: ArrayBuffer): Promise<VRMAnimation[]> {
  // VRMA 必须是 glTF 2.0 二进制容器（GLB）：前置校验 magic，坏文件直接给出可读错误
  const head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
  const magic = String.fromCharCode(...head.subarray(0, 4));
  if (buffer.byteLength < 20 || magic !== 'glTF') {
    const preview = [...head].map((b) => String.fromCharCode(b)).join('').replace(/[^\x20-\x7e]/g, '.');
    throw new Error(
      `不是有效的 VRMA 文件：期望 GLB 二进制格式，实际 ${buffer.byteLength} 字节，开头="${preview}"。` +
        `常见原因：文件不是 VRMA/glTF 2.0 格式，或下载/传输被截断`,
    );
  }

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  const gltf = await loader.parseAsync(buffer, '');

  const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
  if (!animations || animations.length === 0) {
    throw new Error('未在 VRMA 文件中找到动画数据');
  }
  return animations;
}

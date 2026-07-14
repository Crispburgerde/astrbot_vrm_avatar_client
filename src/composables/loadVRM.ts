import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type * as THREE from 'three';

export interface LoadedVRM {
  vrm: VRM;
  root: THREE.Object3D;
}

/**
 * 加载 base64 编码的 VRM：解析 GLTF → 提取 VRM → 去除冗余顶点/关节 →
 * VRM 0.x 朝向修正。纯异步变换，无场景状态依赖，可独立测试。
 */
export async function loadVRMFromBase64(b64: string): Promise<LoadedVRM> {
  // 用浏览器原生 fetch 异步解码 base64，避免 atob + 逐字节 for 循环
  // 阻塞主线程（60MB 文件经 atob+循环会卡死主线程数十秒）
  const resp = await fetch(`data:application/octet-stream;base64,${b64}`);
  const buffer = await resp.arrayBuffer();

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.parseAsync(buffer, '');

  const vrm = gltf.userData.vrm as VRM | undefined;
  const root = gltf.scene;
  if (!vrm) {
    throw new Error('未在 GLTF 中找到 VRM 数据');
  }

  // 优化：去除冗余顶点 / 合并骨架
  VRMUtils.removeUnnecessaryVertices(root);
  VRMUtils.combineSkeletons(root);
  // VRM 0.x 朝向修正
  if (vrm.meta.metaVersion === '0') {
    VRMUtils.rotateVRM0(vrm);
  }

  return { vrm, root };
}

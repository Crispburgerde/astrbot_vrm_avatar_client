import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type * as THREE from 'three';

export interface LoadedVRM {
  vrm: VRM;
  root: THREE.Object3D;
}

/**
 * 加载 VRM（GLB 字节）：解析 GLTF → 提取 VRM → 去除冗余顶点/关节 →
 * VRM 0.x 朝向修正。纯异步变换，无场景状态依赖，可独立测试。
 * 字节来源不限：HTTP 下载（文件下载服务）或 base64 解码均可。
 */
export async function loadVRM(buffer: ArrayBuffer): Promise<LoadedVRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.parseAsync(buffer, '');

  const vrm = gltf.userData.vrm as VRM | undefined;
  const root = gltf.scene;
  if (!vrm) {
    throw new Error('未在 GLTF 中找到 VRM 数据');
  }

  // 优化：去除冗余顶点
  VRMUtils.removeUnnecessaryVertices(root);
  VRMUtils.combineSkeletons(root);
  // VRM 0.x 朝向修正
  if (vrm.meta.metaVersion === '0') {
    VRMUtils.rotateVRM0(vrm);
  }

  return { vrm, root };
}

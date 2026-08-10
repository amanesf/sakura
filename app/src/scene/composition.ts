import * as THREE from 'three';
import { createSky, type SkyHandle } from './sky';
import { createMountains, type MountainsHandle } from './mountains';
import { createLake, type LakeHandle } from './lake';
import { createGround, type GroundHandle } from './ground';
import { createTree, type TreeHandle } from './tree';
import { createVegetation, type VegetationHandle } from './vegetation';
import { createSheddingParticles, type SheddingHandle } from './sheddingParticles';
import { createFlowers, type FlowerHandle } from './flowers';

export interface Lights {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
}

export interface Composition {
  scene: THREE.Scene;
  sky: SkyHandle;
  mountains: MountainsHandle;
  lake: LakeHandle;
  ground: GroundHandle;
  tree: TreeHandle;
  vegetation: VegetationHandle;
  flowers: FlowerHandle;
  shedding: SheddingHandle;
  lights: Lights;
}

/**
 * Assembles the fixed single-shot composition described in
 * season-transition-animation.md §2/§6: a lone tree at the near shore of a lake,
 * a far shore band, two mountain ridgelines, and a gradient sky — all sharing one
 * THREE.Scene so later subsystems (依頼A' season state, 依頼B time field, ...) only
 * need the handles returned here, never re-derive scene layout.
 */
export async function createComposition(): Promise<Composition> {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#cfe0dd', 25, 90);

  const sky = createSky();
  scene.add(sky.mesh);

  const mountains = createMountains();
  scene.add(mountains.group);

  const lake = createLake();
  scene.add(lake.mesh);

  const ground = createGround();
  scene.add(ground.nearShore, ground.farShore);

  const tree = await createTree();
  scene.add(tree.group);

  const vegetation = createVegetation();
  scene.add(vegetation.mesh);

  const flowers = createFlowers();
  scene.add(flowers.group);

  const shedding = createSheddingParticles();
  scene.add(shedding.mesh);

  // No shadow casting here — see core/renderer.ts on why shadowMap is disabled.
  const sun = new THREE.DirectionalLight('#fff3e0', 2.4);
  sun.position.set(-8, 14, 6);
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight('#bfe2ff', '#5b6d55', 0.85);
  scene.add(hemi);

  return {
    scene,
    sky,
    mountains,
    lake,
    ground,
    tree,
    vegetation,
    flowers,
    shedding,
    lights: { sun, hemi },
  };
}

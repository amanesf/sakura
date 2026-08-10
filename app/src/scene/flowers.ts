import * as THREE from 'three';
import { mulberry32, rngRange } from '../core/prng';
import { CAMERA_POSITION, CAMERA_LOOK_AT } from '../core/camera';

export interface FlowerInstanceBase {
  x: number;
  z: number;
  densityKey: number;
  baseScale: number;
  swayPhase: number;
  materialIndex: number;
}

export interface FlowerSeasonState {
  density: number;
}

export interface FlowerHandle {
  /** One InstancedMesh per sprite texture (see createFlowers) grouped together —
   *  callers only ever need to add/animate the whole set, never a specific mesh. */
  group: THREE.Group;
  meshes: THREE.InstancedMesh[];
  instances: FlowerInstanceBase[];
  seasonState: FlowerSeasonState;
}

const INSTANCE_COUNT = 420;
const PATCH_CENTER = new THREE.Vector2(0, -1.4);
const PATCH_RADIUS = 3.2;
const TRUNK_EXCLUSION_RADIUS = 0.55;
const FLOWER_HEIGHT = 0.22;

// Two Gemini-generated wildflower sprites (art-source/flowers/, chroma-key
// extracted from a blue-background generation — see art-source/flowers/prompts/),
// replacing the earlier flat-colored Icosahedron "confetti" dots per
// agent-workflow-policy.md §1.5. Flowers only ever appear in spring (§5 "花畑"), so
// unlike ground/mountains/vegetation there's no per-season swap here — just two
// fixed sprites for visual variety, matching the old FLOWER_COLORS array's spirit.
const FLOWER_TEXTURE_FILES = ['dandelion.png', 'whiteflower.png'];

function loadFlowerTextures(): THREE.Texture[] {
  const loader = new THREE.TextureLoader();
  return FLOWER_TEXTURE_FILES.map((file) => {
    const texture = loader.load(`${import.meta.env.BASE_URL}textures/flowers/${file}`);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  });
}

export function createFlowers(seed = 512): FlowerHandle {
  const rng = mulberry32(seed);

  // Billboard plane rather than a 3D head shape — see vegetation.ts's identical
  // camera-facing-quaternion approach for why this is computed once, not per-frame.
  const headGeometry = new THREE.PlaneGeometry(0.32, 0.32);
  const textures = loadFlowerTextures();
  const materials = textures.map(
    (map) =>
      new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );

  // InstancedMesh only supports one material array slot per submesh group, so with
  // two distinct sprite textures this is two InstancedMeshes (one per texture)
  // sharing one instance list, rather than one mesh with per-instance textures
  // (three.js has no per-instance texture indexing without a custom shader).
  const meshes = materials.map((material) => new THREE.InstancedMesh(headGeometry, material, INSTANCE_COUNT));
  const group = new THREE.Group();
  group.add(...meshes);

  const instances: FlowerInstanceBase[] = [];
  let built = 0;
  let attempts = 0;
  while (built < INSTANCE_COUNT && attempts < INSTANCE_COUNT * 20) {
    attempts++;
    const angle = rngRange(rng, 0, Math.PI * 2);
    const r = Math.sqrt(rng()) * PATCH_RADIUS;
    const x = PATCH_CENTER.x + Math.cos(angle) * r;
    const z = PATCH_CENTER.y + Math.sin(angle) * r;
    if (Math.hypot(x, z) < TRUNK_EXCLUSION_RADIUS) continue;

    instances.push({
      x,
      z,
      densityKey: rng(),
      baseScale: rngRange(rng, 0.7, 1.4),
      swayPhase: rngRange(rng, 0, Math.PI * 2),
      materialIndex: Math.floor(rng() * materials.length),
    });
    built++;
  }

  const seasonState: FlowerSeasonState = { density: 0 };
  updateFlowerInstances(meshes, instances, seasonState, 0, 0);

  return { group, meshes, instances, seasonState };
}

const dummy = new THREE.Object3D();
const FLOWER_BILLBOARD_ALIGN = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  CAMERA_POSITION.clone().sub(CAMERA_LOOK_AT).normalize(),
);

export function updateFlowerInstances(
  meshes: THREE.InstancedMesh[],
  instances: FlowerInstanceBase[],
  seasonState: FlowerSeasonState,
  time: number,
  fieldStrength: number,
): void {
  const { density } = seasonState;
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const visible = inst.densityKey < density;
    const bob = Math.sin(time * 2.2 + inst.swayPhase) * 0.015 * fieldStrength;
    dummy.position.set(inst.x, FLOWER_HEIGHT + bob, inst.z);
    dummy.quaternion.copy(FLOWER_BILLBOARD_ALIGN);
    dummy.rotateZ(inst.swayPhase);
    dummy.scale.setScalar(visible ? inst.baseScale : 0);
    dummy.updateMatrix();
    for (let m = 0; m < meshes.length; m++) {
      // Every non-matching mesh gets a zeroed matrix for this instance slot so it
      // doesn't draw a stray sprite at this position.
      meshes[m].setMatrixAt(i, m === inst.materialIndex ? dummy.matrix : ZERO_MATRIX);
    }
  }
  for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
}

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

export function setFlowerSeasonState(flowers: FlowerHandle, density: number): void {
  flowers.seasonState.density = density;
}

export function updateFlowerAnimation(
  flowers: FlowerHandle,
  time: number,
  fieldStrength: number,
): void {
  updateFlowerInstances(flowers.meshes, flowers.instances, flowers.seasonState, time, fieldStrength);
}

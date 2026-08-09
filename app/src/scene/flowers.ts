import * as THREE from 'three';
import { mulberry32, rngRange } from '../core/prng';

export interface FlowerInstanceBase {
  x: number;
  z: number;
  densityKey: number;
  baseScale: number;
  swayPhase: number;
}

export interface FlowerSeasonState {
  density: number;
}

export interface FlowerHandle {
  mesh: THREE.InstancedMesh;
  instances: FlowerInstanceBase[];
  seasonState: FlowerSeasonState;
}

const INSTANCE_COUNT = 420;
const PATCH_CENTER = new THREE.Vector2(0, -1.4);
const PATCH_RADIUS = 3.2;
const TRUNK_EXCLUSION_RADIUS = 0.55;
const FLOWER_HEIGHT = 0.22;

/** Nanohana/dandelion/renge-style wildflower dots scattered through the spring
 * grass (season-transition-animation.md §5 "花畑"), matching the reference
 * photo's colorful meadow — a separate layer from vegetation.ts's plain blades so
 * grass color stays uniform while flower color reads as scattered confetti. */
const FLOWER_COLORS = ['#f4d94a', '#ffffff', '#f6a8c4', '#e6e04a'];

export function createFlowers(seed = 512): FlowerHandle {
  const rng = mulberry32(seed);

  const headGeometry = new THREE.IcosahedronGeometry(0.05, 0);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const mesh = new THREE.InstancedMesh(headGeometry, material, INSTANCE_COUNT);
  mesh.castShadow = false;

  const instances: FlowerInstanceBase[] = [];
  const color = new THREE.Color();
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
    });
    color.set(FLOWER_COLORS[Math.floor(rng() * FLOWER_COLORS.length)]);
    mesh.setColorAt(built, color);
    built++;
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const seasonState: FlowerSeasonState = { density: 0 };
  updateFlowerInstances(mesh, instances, seasonState, 0, 0);

  return { mesh, instances, seasonState };
}

const dummy = new THREE.Object3D();

export function updateFlowerInstances(
  mesh: THREE.InstancedMesh,
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
    dummy.rotation.set(0, inst.swayPhase, 0);
    dummy.scale.setScalar(visible ? inst.baseScale : 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export function setFlowerSeasonState(flowers: FlowerHandle, density: number): void {
  flowers.seasonState.density = density;
}

export function updateFlowerAnimation(
  flowers: FlowerHandle,
  time: number,
  fieldStrength: number,
): void {
  updateFlowerInstances(flowers.mesh, flowers.instances, flowers.seasonState, time, fieldStrength);
}

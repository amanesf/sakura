import * as THREE from 'three';
import { mulberry32, rngRange } from '../core/prng';

export interface VegetationInstanceBase {
  x: number;
  z: number;
  headingY: number;
  baseScale: number;
  densityKey: number;
  swayPhase: number;
  swayAmplitude: number;
}

export interface VegetationSeasonState {
  density: number;
  height: number;
}

export interface VegetationHandle {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  instances: VegetationInstanceBase[];
  seasonState: VegetationSeasonState;
}

const INSTANCE_COUNT = 900;
const PATCH_CENTER = new THREE.Vector2(0, -1.4);
const PATCH_RADIUS = 3.3;
const TRUNK_EXCLUSION_RADIUS = 0.55;

/**
 * Foreground shore vegetation (season-transition-animation.md §5): one generic blade
 * silhouette whose color/height/density crossfades per season (依頼A') rather than
 * swapping in botanically distinct flower/pampas-grass geometry — the same
 * placeholder-detail tradeoff as the canopy's icosahedron clusters, left for a later
 * polish pass. Each blade's geometry is translated so its base sits at the local
 * origin, so per-instance *rotation* (not position) reads as "rooted at the base,
 * swaying at the tip" (§4 table, row "手前の草花").
 */
export function createVegetation(seed = 71): VegetationHandle {
  const rng = mulberry32(seed);

  const bladeGeometry = new THREE.PlaneGeometry(0.07, 1, 1, 3);
  bladeGeometry.translate(0, 0.5, 0);

  const material = new THREE.MeshStandardMaterial({
    color: '#4f9b3d',
    roughness: 0.9,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(bladeGeometry, material, INSTANCE_COUNT);

  const instances: VegetationInstanceBase[] = [];
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
      headingY: rngRange(rng, 0, Math.PI * 2),
      baseScale: rngRange(rng, 0.7, 1.3),
      densityKey: rng(),
      swayPhase: rngRange(rng, 0, Math.PI * 2),
      swayAmplitude: rngRange(rng, 0.7, 1.3),
    });
    built++;
  }

  const seasonState: VegetationSeasonState = { density: 1, height: 1 };
  updateVegetationInstances(mesh, instances, seasonState, 0, 0);

  return { mesh, material, instances, seasonState };
}

const vegDummy = new THREE.Object3D();

/**
 * Rebuilds every blade's matrix from its baked base placement plus the current
 * season density/height (依頼A') and time-field sway (依頼B) — kept in lockstep
 * with the tree's own sway (see tree.ts's `updateTreeAnimation`) so both layers
 * visibly nod to the same field.
 */
export function updateVegetationInstances(
  mesh: THREE.InstancedMesh,
  instances: VegetationInstanceBase[],
  seasonState: VegetationSeasonState,
  time: number,
  fieldStrength: number,
): void {
  const { density, height } = seasonState;
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const visible = inst.densityKey < density;

    vegDummy.position.set(inst.x, 0.04, inst.z);
    vegDummy.rotation.set(0, inst.headingY, 0);
    // Root-pivoted sway: rotating (not translating) the instance bends the blade
    // around its base, which sits at the local origin after the geometry translate.
    const sway =
      Math.sin(time * 1.9 + inst.swayPhase) * 0.22 * inst.swayAmplitude * fieldStrength;
    vegDummy.rotateZ(sway);
    vegDummy.rotateX(
      Math.cos(time * 1.5 + inst.swayPhase * 1.4) * 0.12 * inst.swayAmplitude * fieldStrength,
    );
    vegDummy.scale.set(
      visible ? inst.baseScale : 0,
      visible ? inst.baseScale * height : 0,
      visible ? inst.baseScale : 0,
    );
    vegDummy.updateMatrix();
    mesh.setMatrixAt(i, vegDummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export function setVegetationSeasonState(
  vegetation: VegetationHandle,
  density: number,
  height: number,
): void {
  vegetation.seasonState.density = density;
  vegetation.seasonState.height = height;
}

export function updateVegetationAnimation(
  vegetation: VegetationHandle,
  time: number,
  fieldStrength: number,
): void {
  updateVegetationInstances(
    vegetation.mesh,
    vegetation.instances,
    vegetation.seasonState,
    time,
    fieldStrength,
  );
}

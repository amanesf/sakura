import * as THREE from 'three';
import { mulberry32, rngRange } from '../core/prng';
import { CAMERA_POSITION, CAMERA_LOOK_AT } from '../core/camera';
import type { SeasonId } from '../seasons/seasonState';

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
  material: THREE.MeshBasicMaterial;
  instances: VegetationInstanceBase[];
  seasonState: VegetationSeasonState;
}

const INSTANCE_COUNT = 260;
const PATCH_CENTER = new THREE.Vector2(0, -1.4);
const PATCH_RADIUS = 3.3;
const TRUNK_EXCLUSION_RADIUS = 0.55;

// One Gemini-generated grass/flower tuft per season (art-source/vegetation/,
// chroma-key extracted from a blue-background generation — see
// art-source/vegetation/prompts/), replacing the earlier flat-colored procedural
// blade plane per agent-workflow-policy.md §1.5. Each instance is a camera-facing
// billboard showing this tuft rather than a single tinted rectangle — fewer
// instances than the old per-blade approach (INSTANCE_COUNT above), since one tuft
// image already reads as several blades.
const VEGETATION_TEXTURE_FILES: Record<SeasonId, string> = {
  winter: 'winter.png',
  spring: 'spring.png',
  summer: 'summer.png',
  autumn: 'autumn.png',
};

const vegetationTextureCache = new Map<SeasonId, THREE.Texture>();
const vegetationTextureLoader = new THREE.TextureLoader();

function loadVegetationTexture(season: SeasonId): THREE.Texture {
  const cached = vegetationTextureCache.get(season);
  if (cached) return cached;
  const url = `${import.meta.env.BASE_URL}textures/vegetation/${VEGETATION_TEXTURE_FILES[season]}`;
  const texture = vegetationTextureLoader.load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  vegetationTextureCache.set(season, texture);
  return texture;
}

/**
 * Foreground shore vegetation (season-transition-animation.md §5): instanced
 * camera-facing tuft billboards whose *texture* crossfades per season (依頼A',
 * setVegetationSeasonState below) rather than a flat material color — the same
 * generated-image technique tree.ts's canopy clusters use. Each tuft's geometry is
 * anchored so its root sits at the local origin, so per-instance *rotation* (not
 * position) still reads as "rooted at the base, swaying at the tip" (§4 table, row
 * "手前の草花").
 */
export function createVegetation(seed = 71): VegetationHandle {
  const rng = mulberry32(seed);

  // Root-anchored plane: translate so the bottom edge (where the tuft's blades meet
  // the ground in the generated image) sits at y=0, matching the old geometry's
  // "rotate around the base" pivot.
  const tuftGeometry = new THREE.PlaneGeometry(0.9, 0.9);
  tuftGeometry.translate(0, 0.45, 0);

  const material = new THREE.MeshBasicMaterial({
    map: loadVegetationTexture('winter'),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.InstancedMesh(tuftGeometry, material, INSTANCE_COUNT);

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
// Tuft billboards face the fixed camera (core/camera.ts) directly rather than
// tracking it every frame — the camera never moves (season-transition-animation.md
// §1's "定点観測"), so this quaternion, computed once from the same camera
// constants tree.ts's canopy clusters use, stays correct for the whole session.
const VEGETATION_BILLBOARD_ALIGN = new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, 1),
  CAMERA_POSITION.clone().sub(CAMERA_LOOK_AT).normalize(),
);

/**
 * Rebuilds every tuft's matrix from its baked base placement plus the current
 * season density/height (依頼A') and time-field sway (依頼B) — kept in lockstep
 * with the tree's own sway (see tree.ts's `updateTreeAnimation`) so both layers
 * visibly nod to the same field. `headingY` now only jitters each tuft's roll
 * around the camera-facing normal (a billboard has no "facing" left to vary).
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
    vegDummy.quaternion.copy(VEGETATION_BILLBOARD_ALIGN);
    vegDummy.rotateZ(inst.headingY);
    // Root-pivoted sway: rotating (not translating) the instance bends the tuft
    // around its base, which sits at the local origin after the geometry translate.
    const sway =
      Math.sin(time * 1.9 + inst.swayPhase) * 0.22 * inst.swayAmplitude * fieldStrength;
    vegDummy.rotateZ(sway);
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
  seasonId: SeasonId,
  density: number,
  height: number,
): void {
  vegetation.seasonState.density = density;
  vegetation.seasonState.height = height;
  vegetation.material.map = loadVegetationTexture(seasonId);
  vegetation.material.needsUpdate = true;
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

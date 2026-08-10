import * as THREE from 'three';
import { mulberry32, rngRange } from '../core/prng';
import { LEAF_DETACH_THRESHOLD, resolveLeafMotionState } from '../core/timeField';
import type { SeasonId } from '../seasons/seasonState';

export interface SheddingInstanceBase {
  originX: number;
  originZ: number;
  originY: number;
  fallDuration: number;
  cycleOffset: number;
  driftPhase: number;
  driftAmplitude: number;
  spinPhase: number;
  spinSpeed: number;
  baseScale: number;
  /** Stable per-instance bias consumed by core/timeField.ts's shared
   *  detach-threshold API — this module never defines its own threshold. */
  detachBias: number;
}

export interface SheddingSeasonState {
  /**
   * Per-scene multiplier on the ambient time field before comparing it to
   * LEAF_DETACH_THRESHOLD (season-transition-animation.md §4: "1つのフィールド、
   * 複数の感度"). 0 outside 桜吹雪/落葉 — every other scene's canopy is either not
   * shedding yet or already bare, so nothing here should be falling.
   */
  sensitivity: number;
}

export interface SheddingHandle {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshBasicMaterial;
  instances: SheddingInstanceBase[];
  seasonState: SheddingSeasonState;
}

const INSTANCE_COUNT = 260;
const CANOPY_CENTER_Y = 5.6;
const CANOPY_RADIUS = 1.9;
const CANOPY_VERTICAL_SPREAD = 0.9;
const GROUND_Y = 0.05;

// Gemini-generated petal (spring) / leaf (autumn) sprites (art-source/shedding/,
// chroma-key extracted from a blue-background generation — see
// art-source/shedding/prompts/), replacing the earlier flat-colored square plane
// per agent-workflow-policy.md §1.5. Winter/summer never shed (sheddingSensitivity
// is 0 in both, see seasonState.ts), so they don't need their own sprite — the
// texture just stays whatever it last was, invisible either way.
const SHEDDING_TEXTURE_FILES: Partial<Record<SeasonId, string>> = {
  spring: 'spring_petal.png',
  autumn: 'autumn_leaf.png',
};

const sheddingTextureCache = new Map<string, THREE.Texture>();
const sheddingTextureLoader = new THREE.TextureLoader();

function loadSheddingTexture(file: string): THREE.Texture {
  const cached = sheddingTextureCache.get(file);
  if (cached) return cached;
  const texture = sheddingTextureLoader.load(`${import.meta.env.BASE_URL}textures/shedding/${file}`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  sheddingTextureCache.set(file, texture);
  return texture;
}

/**
 * The falling-petal/falling-leaf layer for 桜吹雪 and 落葉 (season-transition-
 * animation.md §8, §11 "採用の優先順位"). Deliberately a separate InstancedMesh
 * from the canopy's own instances (tree.ts) rather than repurposing them in place —
 * keeps 依頼E's addition isolated from 依頼A'/B's already-working canopy code, while
 * still consuming (not redefining) the shared detach-threshold contract from
 * core/timeField.ts per agent-workflow-policy.md §5's "オーナーを一本化する".
 */
export function createSheddingParticles(seed = 4021): SheddingHandle {
  const rng = mulberry32(seed);

  const petalGeometry = new THREE.PlaneGeometry(0.16, 0.16);
  const material = new THREE.MeshBasicMaterial({
    map: loadSheddingTexture('spring_petal.png'),
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.InstancedMesh(petalGeometry, material, INSTANCE_COUNT);

  const instances: SheddingInstanceBase[] = [];
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const angle = rngRange(rng, 0, Math.PI * 2);
    const r = Math.sqrt(rng()) * CANOPY_RADIUS;
    const fallDuration = rngRange(rng, 2.6, 5.4);
    instances.push({
      originX: Math.cos(angle) * r,
      originZ: Math.sin(angle) * r,
      originY: CANOPY_CENTER_Y + rngRange(rng, -CANOPY_VERTICAL_SPREAD, CANOPY_VERTICAL_SPREAD),
      fallDuration,
      cycleOffset: rngRange(rng, 0, fallDuration),
      driftPhase: rngRange(rng, 0, Math.PI * 2),
      driftAmplitude: rngRange(rng, 0.25, 0.7),
      spinPhase: rngRange(rng, 0, Math.PI * 2),
      spinSpeed: rngRange(rng, 1.5, 4.0),
      baseScale: rngRange(rng, 0.7, 1.4),
      // Centered so a symmetric field-strength swing crosses LEAF_DETACH_THRESHOLD
      // for roughly half the pool — see sheddingSensitivity in seasonState.ts.
      detachBias: rngRange(rng, -0.4, 0.4),
    });
  }

  const seasonState: SheddingSeasonState = { sensitivity: 0 };
  updateSheddingParticles(mesh, instances, seasonState, 0, 0);

  return { mesh, material, instances, seasonState };
}

const dummy = new THREE.Object3D();

export function updateSheddingParticles(
  mesh: THREE.InstancedMesh,
  instances: SheddingInstanceBase[],
  seasonState: SheddingSeasonState,
  time: number,
  fieldStrength: number,
): void {
  const effectiveField = fieldStrength * seasonState.sensitivity;

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const falling = resolveLeafMotionState(effectiveField, inst.detachBias) === 'falling';

    if (!falling) {
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      continue;
    }

    const cycle = ((time + inst.cycleOffset) % inst.fallDuration) / inst.fallDuration;
    const settle = 1 - cycle * 0.3;
    const x = inst.originX + Math.sin(cycle * Math.PI * 3 + inst.driftPhase) * inst.driftAmplitude * settle;
    const z =
      inst.originZ + Math.cos(cycle * Math.PI * 3 + inst.driftPhase * 1.3) * inst.driftAmplitude * settle;
    const y = THREE.MathUtils.lerp(inst.originY, GROUND_Y, cycle);

    const envelope = THREE.MathUtils.smoothstep(cycle, 0, 0.05) * (1 - THREE.MathUtils.smoothstep(cycle, 0.92, 1));

    dummy.position.set(x, y, z);
    dummy.rotation.set(
      Math.sin(time * 2 + inst.spinPhase) * 0.6,
      inst.spinPhase + time * inst.spinSpeed,
      Math.cos(time * 1.6 + inst.spinPhase) * 0.6,
    );
    dummy.scale.setScalar(inst.baseScale * envelope);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export function setSheddingSeasonState(
  shedding: SheddingHandle,
  seasonId: SeasonId,
  sensitivity: number,
): void {
  shedding.seasonState.sensitivity = sensitivity;
  const file = SHEDDING_TEXTURE_FILES[seasonId];
  if (file) {
    shedding.material.map = loadSheddingTexture(file);
    shedding.material.needsUpdate = true;
  }
}

export function updateSheddingAnimation(
  shedding: SheddingHandle,
  time: number,
  fieldStrength: number,
): void {
  updateSheddingParticles(shedding.mesh, shedding.instances, shedding.seasonState, time, fieldStrength);
}

// Re-exported so callers configuring per-scene sensitivity can see the threshold
// they're gearing against without importing core/timeField.ts separately.
export { LEAF_DETACH_THRESHOLD };

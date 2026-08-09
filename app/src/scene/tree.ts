import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, rngRange, type Rng } from '../core/prng';

export interface TreeTip {
  position: THREE.Vector3;
  direction: THREE.Vector3;
}

export interface CanopyInstanceBase {
  position: THREE.Vector3;
  rotationX: number;
  rotationY: number;
  baseScale: number;
  /** Stable random 0..1 used to decide, at a given season density, whether this
   *  instance is one of the "kept" ones — see `updateCanopyInstances` below. */
  densityKey: number;
  /** Random phase so canopy clusters don't all flutter in lockstep. */
  swayPhase: number;
}

export interface TreeSeasonState {
  density: number;
  scale: number;
}

export interface TreeHandle {
  group: THREE.Group;
  trunkMesh: THREE.Mesh;
  trunkMaterial: THREE.MeshStandardMaterial;
  trunkSwayUniforms: { uTime: { value: number }; uFieldStrength: { value: number } };
  canopyMesh: THREE.InstancedMesh;
  canopyMaterial: THREE.MeshStandardMaterial;
  canopyFillMesh: THREE.Mesh;
  canopyInstances: CanopyInstanceBase[];
  tips: TreeTip[];
  /** Latest season target for the canopy; mutated by `setCanopySeasonState`, read
   *  every frame by `updateTreeAnimation`. Keeps "what season" (依頼A') separate
   *  from "how it moves right now" (依頼B). */
  seasonState: TreeSeasonState;
}

interface BranchSegment {
  start: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  radiusStart: number;
  radiusEnd: number;
  depth: number;
}

// One recursive branch factor per depth level: trunk splits into a few main scaffold
// limbs, then each of those forks repeatedly into a bushier fan for the canopy.
const BRANCH_COUNTS = [1, 3, 2, 2, 2, 2, 2];
const MAX_DEPTH = BRANCH_COUNTS.length - 1;
const LEAVES_PER_TIP = 16;

const UP = new THREE.Vector3(0, 1, 0);

function perpendicular(dir: THREE.Vector3): THREE.Vector3 {
  const reference = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP;
  return new THREE.Vector3().crossVectors(dir, reference).normalize();
}

/** Rotates `dir` by a random angle (0..maxAngle) within a cone around itself. */
function randomConeDirection(rng: Rng, dir: THREE.Vector3, maxAngleDeg: number): THREE.Vector3 {
  const angle = THREE.MathUtils.degToRad(rngRange(rng, maxAngleDeg * 0.35, maxAngleDeg));
  const azimuth = rngRange(rng, 0, Math.PI * 2);
  const u = perpendicular(dir);
  const v = new THREE.Vector3().crossVectors(dir, u).normalize();
  const spread = u.multiplyScalar(Math.cos(azimuth)).addScaledVector(v, Math.sin(azimuth));
  return dir
    .clone()
    .multiplyScalar(Math.cos(angle))
    .addScaledVector(spread, Math.sin(angle))
    .normalize();
}

function buildBranchSegments(rng: Rng): { segments: BranchSegment[]; tips: TreeTip[] } {
  const segments: BranchSegment[] = [];
  const tips: TreeTip[] = [];

  const recurse = (
    start: THREE.Vector3,
    direction: THREE.Vector3,
    length: number,
    radiusStart: number,
    depth: number,
  ) => {
    const radiusEnd = radiusStart * rngRange(rng, 0.68, 0.78);
    const end = start.clone().addScaledVector(direction, length);
    segments.push({ start, direction, length, radiusStart, radiusEnd, depth });

    const isTip = depth >= MAX_DEPTH || radiusEnd < 0.018;
    if (isTip) {
      tips.push({ position: end, direction });
      return;
    }

    const childCount = BRANCH_COUNTS[depth + 1] ?? 2;
    for (let i = 0; i < childCount; i++) {
      // Wider cone + more upward/outward bias deeper in the tree, so the silhouette
      // rounds out into a canopy dome instead of staying a narrow scaffold.
      const coneAngle = 22 + depth * 6;
      let childDir = randomConeDirection(rng, direction, coneAngle);

      const outward = new THREE.Vector3(end.x, 0, end.z);
      if (outward.lengthSq() > 1e-6) {
        outward.normalize();
        childDir.lerp(outward, 0.08 + depth * 0.02).normalize();
      }
      childDir.lerp(UP, 0.05 + depth * 0.015).normalize();
      if (childDir.y < -0.05) childDir.y = -0.05;
      childDir.normalize();

      const childLength = length * rngRange(rng, 0.68, 0.82);
      recurse(end.clone(), childDir, childLength, radiusEnd, depth + 1);
    }
  };

  recurse(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 1.7, 0.34, 0);
  return { segments, tips };
}

function segmentToGeometry(segment: BranchSegment): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    segment.radiusEnd,
    segment.radiusStart,
    segment.length,
    5,
    1,
  );
  geometry.translate(0, segment.length / 2, 0);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, segment.direction);
  geometry.applyQuaternion(quaternion);
  geometry.translate(segment.start.x, segment.start.y, segment.start.z);

  // Baked per-vertex sway susceptibility for the time-field shader (依頼B, §4):
  // 0 at the trunk root, ramping toward 1 at the outermost twigs, so thick scaffold
  // branches barely move while thin tips flutter — see the vertex shader patch in
  // createTree() for how this is consumed.
  const swayWeight = segment.depth / MAX_DEPTH;
  const vertexCount = geometry.attributes.position.count;
  geometry.setAttribute(
    'swayWeight',
    new THREE.Float32BufferAttribute(new Float32Array(vertexCount).fill(swayWeight), 1),
  );

  return geometry;
}

/**
 * Procedural single-tree generator. Blender's Sapling Tree Gen (see
 * agent-workflow-policy.md §10-A) was considered but the environment has no Blender
 * pilot verified yet, so branch geometry is authored directly here.
 */
export function createTree(seed = 20260809): TreeHandle {
  const rng = mulberry32(seed);
  const { segments, tips } = buildBranchSegments(rng);

  const trunkGeometry = mergeGeometries(
    segments.map((segment) => segmentToGeometry(segment)),
    false,
  );
  if (!trunkGeometry) throw new Error('failed to merge tree branch geometry');
  trunkGeometry.computeVertexNormals();

  const trunkSwayUniforms = {
    uTime: { value: 0 },
    uFieldStrength: { value: 0 },
  };
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: '#4b3a2f',
    roughness: 0.95,
    metalness: 0,
  });
  // Hierarchical branch sway (season-transition-animation.md §4 table, row 1): a
  // slow wide sweep scaled by swayWeight, plus a faster small flutter scaled by
  // swayWeight² so it only really shows up at the thin tips — an approximation of
  // "太い枝はゆっくり大きく、細い枝先は小刻みに揺れる" without a full hierarchical
  // bone/lever simulation (agent-workflow-policy.md §2 flags this class of work as
  // Opus-tier; this is the first-pass shape, exact damping curves are later polish).
  trunkMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, trunkSwayUniforms);
    shader.vertexShader =
      `attribute float swayWeight;\nuniform float uTime;\nuniform float uFieldStrength;\n` +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        float sw = swayWeight;
        float slow = sin(uTime * 1.1 + sw * 2.3) * sw * 0.22;
        float fast = sin(uTime * 4.3 + sw * 6.1) * sw * sw * 0.06;
        transformed.x += (slow + fast) * uFieldStrength;
        transformed.z += cos(uTime * 0.9 + sw * 2.6) * sw * 0.16 * uFieldStrength;
      }`,
    );
  };
  const trunkMesh = new THREE.Mesh(trunkGeometry, trunkMaterial);
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;

  const canopyGeometry = new THREE.IcosahedronGeometry(0.185, 2);
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: '#7abf56',
    roughness: 0.7,
    metalness: 0,
  });
  // Fake SSS rim light (proposal.md §4.2 "疑似SSS"): blossom/leaf clusters glow a
  // little at grazing angles regardless of the key light direction, like light
  // scattering through thin petals — an additive, not multiplicative, brightening,
  // so it still reads in shadowed parts of the canopy.
  canopyMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uRimStrength = { value: 1.1 };
    shader.fragmentShader = `uniform float uRimStrength;\n${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float rimFresnel = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.2);
        totalEmissiveRadiance += diffuseColor.rgb * rimFresnel * uRimStrength;
      }`,
    );
  };
  const canopyMesh = new THREE.InstancedMesh(
    canopyGeometry,
    canopyMaterial,
    tips.length * LEAVES_PER_TIP,
  );
  canopyMesh.castShadow = true;

  // A single solid "fill" blob behind the instanced clusters, same material (so it
  // always matches the current season color automatically). The hard instance
  // spheres alone leave visible gaps between clusters; this fills them so the
  // canopy reads as one continuous mass with the instances as surface texture on
  // top of it, rather than a loose pile of balls.
  const canopyCenter = new THREE.Vector3();
  for (const tip of tips) canopyCenter.add(tip.position);
  canopyCenter.divideScalar(tips.length);
  let canopyRadius = 0;
  for (const tip of tips) {
    canopyRadius = Math.max(canopyRadius, tip.position.distanceTo(canopyCenter));
  }
  const canopyFillMesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(canopyRadius * 0.48, 2),
    canopyMaterial,
  );
  canopyFillMesh.position.copy(canopyCenter);
  canopyFillMesh.castShadow = true;

  const shadeColor = new THREE.Color();
  const canopyInstances: CanopyInstanceBase[] = [];
  let instanceIndex = 0;
  for (const tip of tips) {
    for (let i = 0; i < LEAVES_PER_TIP; i++) {
      const jitterRadius = rngRange(rng, 0.05, 0.34);
      const jitterDir = new THREE.Vector3(
        rngRange(rng, -1, 1),
        rngRange(rng, -1, 1),
        rngRange(rng, -1, 1),
      ).normalize();
      const position = tip.position.clone().addScaledVector(jitterDir, jitterRadius);
      const baseScale = rngRange(rng, 0.55, 1.1);
      const rotationX = rngRange(rng, 0, Math.PI);
      const rotationY = rngRange(rng, 0, Math.PI);
      const densityKey = rng();
      const swayPhase = rngRange(rng, 0, Math.PI * 2);
      canopyInstances.push({
        position,
        rotationX,
        rotationY,
        baseScale,
        densityKey,
        swayPhase,
      });

      // Wide brightness spread (some clusters near-white, some deeper-toned) reads
      // as varied petal clumps instead of one flat color repeated everywhere.
      const shade = rngRange(rng, 0.7, 1.55);
      shadeColor.setScalar(shade);
      canopyMesh.setColorAt(instanceIndex, shadeColor);
      instanceIndex++;
    }
  }
  if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;

  const group = new THREE.Group();
  group.add(trunkMesh, canopyFillMesh, canopyMesh);

  const seasonState: TreeSeasonState = { density: 1, scale: 1 };
  updateCanopyInstances(canopyMesh, canopyInstances, seasonState, 0, 0);
  applyCanopyFillScale(canopyFillMesh, seasonState);

  return {
    group,
    trunkMesh,
    trunkMaterial,
    trunkSwayUniforms,
    canopyMesh,
    canopyMaterial,
    canopyFillMesh,
    canopyInstances,
    tips,
    seasonState,
  };
}

/**
 * The fill blob (see createTree above) has to shrink with the season's canopy
 * density too, or a bare-winter tree ends up with an ugly solid gray ball where
 * only a few stray instances should show — it's not itself gated by densityKey the
 * way individual instances are, so it needs this explicit hookup.
 */
function applyCanopyFillScale(canopyFillMesh: THREE.Mesh, seasonState: TreeSeasonState): void {
  canopyFillMesh.scale.setScalar(seasonState.density * seasonState.scale);
}

const canopyDummy = new THREE.Object3D();

/**
 * Rebuilds every canopy instance matrix from its baked base transform plus the
 * current season density/scale (依頼A') and a time-field-driven flutter (依頼B).
 * Called every frame; ~a few hundred to ~1000 instances is cheap on the Pixel 10 Pro
 * target (season-transition-animation.md §13 — no lower-end fallback needed).
 */
export function updateCanopyInstances(
  canopyMesh: THREE.InstancedMesh,
  instances: CanopyInstanceBase[],
  seasonState: TreeSeasonState,
  time: number,
  fieldStrength: number,
): void {
  const { density, scale } = seasonState;
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const visible = inst.densityKey < density;

    const swayX = Math.sin(time * 1.6 + inst.swayPhase) * 0.055 * fieldStrength;
    const swayY = Math.sin(time * 2.1 + inst.swayPhase * 1.3) * 0.02 * fieldStrength;
    const swayZ = Math.cos(time * 1.4 + inst.swayPhase * 0.7) * 0.055 * fieldStrength;

    canopyDummy.position.set(
      inst.position.x + swayX,
      inst.position.y + swayY,
      inst.position.z + swayZ,
    );
    canopyDummy.rotation.set(inst.rotationX, inst.rotationY, 0);
    canopyDummy.scale.setScalar(visible ? inst.baseScale * scale : 0);
    canopyDummy.updateMatrix();
    canopyMesh.setMatrixAt(i, canopyDummy.matrix);
  }
  canopyMesh.instanceMatrix.needsUpdate = true;
}

/** Called by the season system (依頼A') whenever the dial moves to a new blend. */
export function setCanopySeasonState(tree: TreeHandle, density: number, scale: number): void {
  tree.seasonState.density = density;
  tree.seasonState.scale = scale;
  applyCanopyFillScale(tree.canopyFillMesh, tree.seasonState);
}

/** Called every frame by the render loop (依頼B) to animate trunk + canopy sway. */
export function updateTreeAnimation(tree: TreeHandle, time: number, fieldStrength: number): void {
  tree.trunkSwayUniforms.uTime.value = time;
  tree.trunkSwayUniforms.uFieldStrength.value = fieldStrength;
  updateCanopyInstances(tree.canopyMesh, tree.canopyInstances, tree.seasonState, time, fieldStrength);
}

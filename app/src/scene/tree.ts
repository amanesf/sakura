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
   *  instance is one of the "kept" ones — see `applyCanopyState` below. */
  densityKey: number;
}

export interface TreeHandle {
  group: THREE.Group;
  trunkMesh: THREE.Mesh;
  trunkMaterial: THREE.MeshStandardMaterial;
  canopyMesh: THREE.InstancedMesh;
  canopyMaterial: THREE.MeshStandardMaterial;
  canopyInstances: CanopyInstanceBase[];
  tips: TreeTip[];
}

interface BranchSegment {
  start: THREE.Vector3;
  direction: THREE.Vector3;
  length: number;
  radiusStart: number;
  radiusEnd: number;
}

// One recursive branch factor per depth level: trunk splits into a few main scaffold
// limbs, then each of those forks repeatedly into a bushier fan for the canopy.
const BRANCH_COUNTS = [1, 3, 2, 2, 2, 2, 2];
const MAX_DEPTH = BRANCH_COUNTS.length - 1;
const LEAVES_PER_TIP = 10;

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
    segments.push({ start, direction, length, radiusStart, radiusEnd });

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
  return geometry;
}

/**
 * Procedural single-tree generator. Blender's Sapling Tree Gen (see
 * agent-workflow-policy.md §10-A) was considered but the environment has no Blender
 * pilot verified yet, so branch geometry is authored directly here; the trunk/canopy
 * split below is what a future VAT-driven sway pass (依頼B) would swap in a wind
 * texture for.
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

  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: '#4b3a2f',
    roughness: 0.95,
    metalness: 0,
  });
  const trunkMesh = new THREE.Mesh(trunkGeometry, trunkMaterial);
  trunkMesh.castShadow = true;
  trunkMesh.receiveShadow = true;

  const canopyGeometry = new THREE.IcosahedronGeometry(0.26, 1);
  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: '#7abf56',
    roughness: 0.75,
    metalness: 0,
  });
  const canopyMesh = new THREE.InstancedMesh(
    canopyGeometry,
    canopyMaterial,
    tips.length * LEAVES_PER_TIP,
  );
  canopyMesh.castShadow = true;

  const shadeColor = new THREE.Color();
  const canopyInstances: CanopyInstanceBase[] = [];
  let instanceIndex = 0;
  for (const tip of tips) {
    for (let i = 0; i < LEAVES_PER_TIP; i++) {
      const jitterRadius = rngRange(rng, 0.08, 0.5);
      const jitterDir = new THREE.Vector3(
        rngRange(rng, -1, 1),
        rngRange(rng, -1, 1),
        rngRange(rng, -1, 1),
      ).normalize();
      const position = tip.position.clone().addScaledVector(jitterDir, jitterRadius);
      const baseScale = rngRange(rng, 0.6, 1.15);
      const rotationX = rngRange(rng, 0, Math.PI);
      const rotationY = rngRange(rng, 0, Math.PI);
      const densityKey = rng();
      canopyInstances.push({ position, rotationX, rotationY, baseScale, densityKey });

      const shade = rngRange(rng, 0.82, 1.15);
      shadeColor.setScalar(shade);
      canopyMesh.setColorAt(instanceIndex, shadeColor);
      instanceIndex++;
    }
  }
  if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;

  const group = new THREE.Group();
  group.add(trunkMesh, canopyMesh);

  applyCanopyState(canopyMesh, canopyInstances, 1, 1);

  return {
    group,
    trunkMesh,
    trunkMaterial,
    canopyMesh,
    canopyMaterial,
    canopyInstances,
    tips,
  };
}

const canopyDummy = new THREE.Object3D();

/**
 * Owned here (alongside the instance data it rebuilds) but driven by the season
 * system (依頼A'): `density` is the fraction of instances kept visible and `scale`
 * is a uniform size multiplier on top of each instance's own baked variance. Using
 * each instance's stable `densityKey` instead of re-rolling randomness means the
 * canopy fills in/thins out smoothly as density changes instead of flickering.
 */
export function applyCanopyState(
  canopyMesh: THREE.InstancedMesh,
  instances: CanopyInstanceBase[],
  density: number,
  scale: number,
): void {
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    const visible = inst.densityKey < density;
    canopyDummy.position.copy(inst.position);
    canopyDummy.rotation.set(inst.rotationX, inst.rotationY, 0);
    canopyDummy.scale.setScalar(visible ? inst.baseScale * scale : 0);
    canopyDummy.updateMatrix();
    canopyMesh.setMatrixAt(i, canopyDummy.matrix);
  }
  canopyMesh.instanceMatrix.needsUpdate = true;
}

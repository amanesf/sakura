import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, rngRange, type Rng } from '../core/prng';
import { CAMERA_POSITION } from '../core/camera';

export interface TreeTip {
  position: THREE.Vector3;
  direction: THREE.Vector3;
}

export interface TreeSeasonState {
  density: number;
  scale: number;
}

export interface CanopyTextureVariant {
  density: number;
  texture: THREE.CanvasTexture;
}

export interface TreeHandle {
  group: THREE.Group;
  trunkMesh: THREE.Mesh;
  trunkMaterial: THREE.MeshStandardMaterial;
  trunkSwayUniforms: { uTime: { value: number }; uFieldStrength: { value: number } };
  /** A single camera-facing plane carrying a baked canopy texture — see createTree's
   *  doc comment for why this replaced a cloud of live 3D instances. */
  canopyMesh: THREE.Mesh;
  canopyMaterial: THREE.MeshBasicMaterial;
  /** Pivots the canopy for whole-mass sway (依頼B) — positioned at the branch
   *  attachment point, not the canopy's own center, so a small rotation swings the
   *  top further than the bottom like a real hanging mass would. */
  canopyPivot: THREE.Group;
  /** One pre-baked texture per distinct season canopy density — swapped by
   *  `setCanopySeasonState`, never blended live (season transitions are hard-cut
   *  under cover of 依頼D's wave, so no runtime interpolation is needed here). */
  canopyTextures: CanopyTextureVariant[];
  tips: TreeTip[];
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

// One recursive branch factor per depth level. depth0→1 is the low double-trunk
// "V" split the reference photo's winter (bare) panel shows clearly; depth1→2 fans
// each main limb out to build canopy width before finer twigging takes over.
const BRANCH_COUNTS = [1, 2, 3, 2, 2, 2, 2];
const MAX_DEPTH = BRANCH_COUNTS.length - 1;
// Overall size multiplier — the V-split proportions below are tuned relative to
// each other first, then scaled up as a whole so the tree fills the frame the way
// the original single-trunk generator did (that one grew ~5.9 units tall through
// pure multiplicative decay; this explicit-length version is shorter before scaling
// since two half-length main limbs replace one long trunk run).
const TREE_SCALE = 1.45;

// Explicit per-depth segment length, rather than pure multiplicative decay from the
// trunk — lets the silhouette proportions (short thick trunk, long wide-spreading
// main limbs, tapering twigs) be authored directly instead of emerging indirectly
// from a single decay-rate constant.
const DEPTH_LENGTH = [0.85, 1.55, 1.05, 0.8, 0.62, 0.48, 0.38].map((l) => l * TREE_SCALE);

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

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

    const isTip = depth >= MAX_DEPTH || radiusEnd < 0.02;
    if (isTip) {
      tips.push({ position: end, direction });
      return;
    }

    const childCount = BRANCH_COUNTS[depth + 1] ?? 2;
    const childBaseLength = DEPTH_LENGTH[depth + 1] ?? DEPTH_LENGTH[DEPTH_LENGTH.length - 1];

    if (depth === 0) {
      // The low "V": two main limbs at exactly opposite azimuths and the same lean
      // angle. Letting each limb's *deeper* branching recurse independently (as an
      // earlier version did) left the two halves of the canopy badly unbalanced —
      // one side's random spread happening to run wide, the other staying thin —
      // which read as lopsided even though the founding split angle was symmetric.
      // So only ONE limb is actually randomly generated; the other is produced by
      // rotating that whole subtree 180° about the vertical line through the fork
      // point. From this project's fixed, near-frontal camera (core/camera.ts), a
      // 180°-about-Y rotation of a point projects to an exact horizontal mirror in
      // camera space (u,v)→(-u,v), so the two limbs read as true left-right mirror
      // images despite being a rotation in actual 3D — sufficient here since the
      // camera never moves to reveal the difference.
      const azimuth0 = rngRange(rng, 0, Math.PI * 2);
      const leanRad = THREE.MathUtils.degToRad(rngRange(rng, 26, 34));
      const dir0 = new THREE.Vector3(
        Math.sin(leanRad) * Math.cos(azimuth0),
        Math.cos(leanRad),
        Math.sin(leanRad) * Math.sin(azimuth0),
      ).normalize();
      const length0 = childBaseLength * rngRange(rng, 0.95, 1.05);

      const segmentsBefore = segments.length;
      const tipsBefore = tips.length;
      recurse(end.clone(), dir0, length0, radiusEnd, depth + 1);

      const forkPoint = end;
      const mirrorPos = (v: THREE.Vector3) =>
        new THREE.Vector3(2 * forkPoint.x - v.x, v.y, 2 * forkPoint.z - v.z);
      const mirrorDir = (d: THREE.Vector3) => new THREE.Vector3(-d.x, d.y, -d.z);

      for (const seg of segments.slice(segmentsBefore)) {
        segments.push({
          ...seg,
          start: mirrorPos(seg.start),
          direction: mirrorDir(seg.direction),
        });
      }
      for (const tip of tips.slice(tipsBefore)) {
        tips.push({ position: mirrorPos(tip.position), direction: mirrorDir(tip.direction) });
      }
      return;
    }

    for (let i = 0; i < childCount; i++) {
      // Wider cone + more upward/outward bias deeper in the tree, so the silhouette
      // rounds out into a broad canopy dome instead of staying a narrow scaffold.
      const coneAngle = 20 + depth * 7;
      const childDir = randomConeDirection(rng, direction, coneAngle);

      const outward = new THREE.Vector3(end.x, 0, end.z);
      if (outward.lengthSq() > 1e-6) {
        outward.normalize();
        childDir.lerp(outward, 0.06 + depth * 0.02).normalize();
      }
      childDir.lerp(UP, 0.06 + depth * 0.02).normalize();
      if (childDir.y < -0.05) childDir.y = -0.05;
      childDir.normalize();

      const childLength = childBaseLength * rngRange(rng, 0.85, 1.15);
      recurse(end.clone(), childDir, childLength, radiusEnd, depth + 1);
    }
  };

  const trunkDir = new THREE.Vector3(0, 1, 0);
  recurse(new THREE.Vector3(0, 0, 0), trunkDir, DEPTH_LENGTH[0], 0.34 * TREE_SCALE, 0);
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

// ---------------------------------------------------------------------------
// Canopy texture baking.
//
// An earlier version built the canopy from ~1000-3000 live camera-facing sprite
// instances. Rendered live, that reads as a pile of discrete circles no matter how
// many are added, because WebGL has to alpha-blend and depth-sort each one in real
// time — three.js does not sort instances *within* a single InstancedMesh, so it
// composites in creation order rather than true visibility order, and matching
// the reference photo's continuous, hand-painted-looking blossom mass just isn't
// achievable that way at a sane instance count.
//
// The fix follows from a constraint already baked into this whole project: the
// camera never moves (season-transition-animation.md §1, "定点観測のタイムマシン").
// A canopy that only ever needs to be seen from one fixed angle doesn't need to
// exist in 3D at all — it can be *painted*, once, onto a single flat texture using
// Canvas2D (which composites hundreds of soft dabs with proper anti-aliased alpha
// blending, no sorting concerns), and mapped onto one camera-facing plane. This is
// the same reasoning already used for scene/ground.ts's radial fade alpha map,
// taken further: the whole canopy becomes one "painting" instead of a cloud of 3D
// geometry.
// ---------------------------------------------------------------------------

interface CanopyDab {
  u: number;
  v: number;
  radius: number;
  densityKey: number;
  tierIndex: number;
}

const BRIGHTNESS_TIERS = [0.55, 0.68, 0.8, 0.9, 1.0];
const PIXELS_PER_WORLD_UNIT = 140;

function createTierSprite(brightness: number, size = 48): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const v = Math.round(THREE.MathUtils.clamp(brightness, 0, 1) * 255);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(${v},${v},${v},1)`);
  gradient.addColorStop(0.65, `rgba(${v},${v},${v},0.9)`);
  gradient.addColorStop(1, `rgba(${v},${v},${v},0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Builds the dab list in the canopy's local 2D (u,v) plane — u/v are world-unit
 * offsets along the `right`/`up` billboard axes from `canopyCenter`.
 *
 * The literal branch-tip cloud is *not* painted directly: an earlier version put
 * dabs only near each tip, and because the procedural branching leaves tips
 * clustered in a few clumps with real gaps between them, that read as several
 * separate detached blobs — not the one continuous rounded mass the reference
 * photo shows. Real cherry canopies (and the reference art) read as a cumulus-
 * cloud silhouette: many overlapping rounded lobes fused into one shape with a
 * bumpy but unbroken edge. So instead this scatters ~24 organic "lobe" centers
 * across an oval footprint (sized from the tip cloud, tapered at the bottom
 * toward the trunk fork so it doesn't look like it floats free of the tree), then
 * fills each lobe with one soft macro dab plus many small fine dabs. The tip
 * cloud only decides the footprint's size and position, not the paint pattern.
 */
function buildCanopyDabs(
  rng: Rng,
  tips: TreeTip[],
  canopyCenter: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
): CanopyDab[] {
  const relative = new THREE.Vector3();
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const tip of tips) {
    relative.subVectors(tip.position, canopyCenter);
    const u = relative.dot(right);
    const v = relative.dot(up);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }

  const halfW = ((uMax - uMin) / 2) * 1.06;
  const halfHUp = ((vMax - vMin) / 2) * 1.12;
  const maskCenterV = (vMin + vMax) / 2 + halfHUp * 0.06;
  const bottomTaperV = vMin - halfHUp * 0.22;

  // Inside-test for the footprint: an oval that narrows toward a waist in its
  // bottom quarter (where the canopy gathers back down onto the trunk fork)
  // instead of a plain ellipse that would look like it hovers over the tree.
  const insideMask = (u: number, v: number): number => {
    const t = THREE.MathUtils.clamp((v - bottomTaperV) / (halfHUp * 0.9), 0, 1);
    const waist = THREE.MathUtils.lerp(0.4, 1, t);
    const nu = u / (halfW * waist || 1);
    const nv = (v - maskCenterV) / (halfHUp || 1);
    return 1 - (nu * nu + nv * nv);
  };

  const heightBrightness = (v: number): number => {
    const t = THREE.MathUtils.clamp((v - (maskCenterV - halfHUp)) / (halfHUp * 2 || 1), 0, 1);
    return THREE.MathUtils.lerp(0.58, 1.0, t);
  };

  const tierForBrightness = (b: number): number => {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < BRIGHTNESS_TIERS.length; i++) {
      const diff = Math.abs(BRIGHTNESS_TIERS[i] - b);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  };

  // Jittered-grid scatter rather than pure rejection sampling: a min-spacing
  // rejection loop can burn its whole attempt budget seeding one region first (this
  // exact seed did — it filled the left half before the cap hit, leaving the right
  // half of the canopy bare), which reads as lopsided for reasons that have nothing
  // to do with the tree's actual (now-mirrored, genuinely symmetric) shape. A grid
  // guarantees one lobe attempt per cell across the whole mask, so coverage cannot
  // silently run out partway across the canopy.
  // Separate column/row spacing rather than one square cell size: the footprint is
  // typically wide and comparatively short (branches spread laterally more than
  // vertically), so a cell size derived only from width left far too few *rows* to
  // sample the mask's narrower vertical extent — whole columns near the tapering
  // top/bottom edges failed the mask test entirely, producing real gaps in the
  // canopy rather than just thinner texture there.
  const cols = 10;
  const rows = 6;
  const cellW = (halfW * 2 * 1.08) / cols;
  const cellH = (halfHUp * 2 * 1.08) / rows;
  const lobeRadiusBase = Math.max(cellW, cellH);
  const lobeCenters: { u: number; v: number; radius: number }[] = [];
  for (let row = 0; row <= rows; row++) {
    const gv = -halfHUp * 1.08 + row * cellH;
    for (let col = 0; col <= cols; col++) {
      const gu = -halfW * 1.08 + col * cellW;
      const u = gu + rngRange(rng, -cellW * 0.4, cellW * 0.4);
      const v = maskCenterV + gv + rngRange(rng, -cellH * 0.4, cellH * 0.4);
      if (insideMask(u, v) < -0.08) continue;
      lobeCenters.push({ u, v, radius: lobeRadiusBase * rngRange(rng, 0.62, 0.88) });
    }
  }

  const dabs: CanopyDab[] = [];
  for (const lobe of lobeCenters) {
    // Macro dab: the lobe's own soft rounded base. Kept in a low densityKey band
    // (0..0.55) so the overall silhouette survives even at spring/autumn's reduced
    // density — only the fine surface texture thins out, not the shape itself.
    dabs.push({
      u: lobe.u,
      v: lobe.v,
      radius: lobe.radius,
      densityKey: rng() * 0.55,
      tierIndex: tierForBrightness(heightBrightness(lobe.v) * rngRange(rng, 0.95, 1.05)),
    });

    const fineCount = 42;
    for (let i = 0; i < fineCount; i++) {
      const angle = rngRange(rng, 0, Math.PI * 2);
      const dist = Math.sqrt(rng()) * lobe.radius * 1.08;
      const du = Math.cos(angle) * dist;
      const dv = Math.sin(angle) * dist;
      const brightness = heightBrightness(lobe.v + dv) * rngRange(rng, 0.82, 1.18);
      dabs.push({
        u: lobe.u + du,
        v: lobe.v + dv,
        radius: rngRange(rng, 0.14, 0.34) * lobe.radius,
        densityKey: rng(),
        tierIndex: tierForBrightness(brightness),
      });
    }
  }
  return dabs;
}

interface CanopyBounds {
  uMid: number;
  vMid: number;
  planeWidth: number;
  planeHeight: number;
}

function computeCanopyBounds(dabs: CanopyDab[]): CanopyBounds {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const dab of dabs) {
    uMin = Math.min(uMin, dab.u - dab.radius);
    uMax = Math.max(uMax, dab.u + dab.radius);
    vMin = Math.min(vMin, dab.v - dab.radius);
    vMax = Math.max(vMax, dab.v + dab.radius);
  }
  return {
    uMid: (uMin + uMax) / 2,
    vMid: (vMin + vMax) / 2,
    planeWidth: uMax - uMin,
    planeHeight: vMax - vMin,
  };
}

function bakeCanopyTexture(
  dabs: CanopyDab[],
  density: number,
  tierSprites: HTMLCanvasElement[],
  bounds: CanopyBounds,
): THREE.CanvasTexture {
  const canvasWidth = Math.max(32, Math.round(bounds.planeWidth * PIXELS_PER_WORLD_UNIT));
  const canvasHeight = Math.max(32, Math.round(bounds.planeHeight * PIXELS_PER_WORLD_UNIT));
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;

  for (const dab of dabs) {
    if (dab.densityKey >= density) continue;
    const px = (dab.u - bounds.uMid + bounds.planeWidth / 2) * PIXELS_PER_WORLD_UNIT;
    const py = (bounds.planeHeight / 2 - (dab.v - bounds.vMid)) * PIXELS_PER_WORLD_UNIT;
    const pr = dab.radius * PIXELS_PER_WORLD_UNIT;
    ctx.drawImage(tierSprites[dab.tierIndex], px - pr, py - pr, pr * 2, pr * 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Procedural single-tree generator, shaped to match the reference photo's silhouette
 * (season-transition-animation.md's base composition reference,
 * `1786259704552.png`): a short, thick trunk splitting low into two spreading main
 * limbs, opening into a canopy noticeably wider than the trunk is tall.
 *
 * `densityLevels` are the distinct canopy densities the season system will ever ask
 * for (season-transition-animation.md's per-scene canopyDensity values) — one
 * texture is pre-baked per distinct value so `setCanopySeasonState` only ever swaps
 * a texture reference, never re-bakes at runtime.
 */
export function createTree(seed = 20260809, densityLevels: number[] = [1]): TreeHandle {
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

  const canopyCenter = new THREE.Vector3();
  for (const tip of tips) canopyCenter.add(tip.position);
  canopyCenter.divideScalar(tips.length);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const tip of tips) {
    minY = Math.min(minY, tip.position.y);
    maxY = Math.max(maxY, tip.position.y);
  }

  // The canopy plane always faces the camera; since the camera never moves
  // (season-transition-animation.md §1 "定点観測のタイムマシン"), that facing
  // quaternion — and the right/up axes derived from it — can be computed once here.
  const towardCamera = CAMERA_POSITION.clone().sub(canopyCenter).normalize();
  const billboardAlign = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, towardCamera);
  const right = X_AXIS.clone().applyQuaternion(billboardAlign);
  const up = Y_AXIS.clone().applyQuaternion(billboardAlign);

  const dabs = buildCanopyDabs(rng, tips, canopyCenter, right, up);
  const bounds = computeCanopyBounds(dabs);
  const tierSprites = BRIGHTNESS_TIERS.map((b) => createTierSprite(b));

  const distinctDensities = [...new Set(densityLevels)];
  const canopyTextures: CanopyTextureVariant[] = distinctDensities.map((density) => ({
    density,
    texture: bakeCanopyTexture(dabs, density, tierSprites, bounds),
  }));

  // Unlit on purpose: a physically-lit material darkens toward whichever season's
  // sun angle happens to graze this billboard plane least, which read as a muddy
  // near-maroon canopy regardless of the pastel color set on it. Since the camera
  // never moves there's no lighting cue to preserve anyway — the height-based
  // brightness gradient is already baked into the texture itself (heightBrightness
  // above), so the true season color shows through undimmed.
  const canopyMaterial = new THREE.MeshBasicMaterial({
    map: canopyTextures[0].texture,
    color: '#7abf56',
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const canopyMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds.planeWidth, bounds.planeHeight),
    canopyMaterial,
  );
  canopyMesh.quaternion.copy(billboardAlign);

  // The pivot sits at the branch attachment point (canopy's horizontal center, but
  // at the *bottom* of its vertical extent) rather than the canopy's own center, so
  // rotating it for sway swings the top of the mass further than the bottom — like
  // something actually hanging off the tree, not spinning in place.
  const attachPoint = new THREE.Vector3(canopyCenter.x, minY, canopyCenter.z);
  const canopyPivot = new THREE.Group();
  canopyPivot.position.copy(attachPoint);
  canopyMesh.position
    .copy(canopyCenter)
    .addScaledVector(right, bounds.uMid)
    .addScaledVector(up, bounds.vMid)
    .sub(attachPoint);
  canopyPivot.add(canopyMesh);

  const group = new THREE.Group();
  group.add(trunkMesh, canopyPivot);
  // The V-split (depth0→1) picks a random azimuth, which can leave the canopy
  // centroid noticeably off to one side of the trunk's ground point — re-center the
  // whole tree horizontally on its canopy so it doesn't drift toward a frame edge.
  group.position.x = -canopyCenter.x;

  const seasonState: TreeSeasonState = { density: canopyTextures[0].density, scale: 1 };

  return {
    group,
    trunkMesh,
    trunkMaterial,
    trunkSwayUniforms,
    canopyMesh,
    canopyMaterial,
    canopyPivot,
    canopyTextures,
    tips,
    seasonState,
  };
}

/** Called by the season system (依頼A') whenever the dial moves to a new blend.
 *  Picks the nearest pre-baked texture rather than baking on demand. */
export function setCanopySeasonState(tree: TreeHandle, density: number, scale: number): void {
  tree.seasonState.density = density;
  tree.seasonState.scale = scale;

  let closest = tree.canopyTextures[0];
  let bestDiff = Infinity;
  for (const variant of tree.canopyTextures) {
    const diff = Math.abs(variant.density - density);
    if (diff < bestDiff) {
      bestDiff = diff;
      closest = variant;
    }
  }
  tree.canopyMaterial.map = closest.texture;
  tree.canopyMesh.scale.setScalar(scale);
}

/** Sets the canopy tint — the baked texture stores relative shading only (near-
 *  grayscale brightness), so the season's actual hue comes entirely from this
 *  material color multiplying it. */
export function setCanopyColor(tree: TreeHandle, color: THREE.Color): void {
  tree.canopyMaterial.color.copy(color);
}

/** Called every frame by the render loop (依頼B) to animate trunk sway and the
 *  whole-canopy sway (see canopyPivot's doc comment on createTree). */
export function updateTreeAnimation(tree: TreeHandle, time: number, fieldStrength: number): void {
  tree.trunkSwayUniforms.uTime.value = time;
  tree.trunkSwayUniforms.uFieldStrength.value = fieldStrength;

  tree.canopyPivot.rotation.z = Math.sin(time * 1.1) * 0.045 * fieldStrength;
  tree.canopyPivot.rotation.x = Math.sin(time * 0.85 + 1.7) * 0.03 * fieldStrength;
}

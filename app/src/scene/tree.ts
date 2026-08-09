import * as THREE from 'three';
import { mulberry32, rngRange, type Rng } from '../core/prng';
import { CAMERA_POSITION, CAMERA_LOOK_AT } from '../core/camera';

export interface TreeSeasonState {
  seasonKey: CanopySeasonKey;
  density: number;
  scale: number;
}

/** The three seasons that actually show a canopy — winter stays bare. */
export type CanopySeasonKey = 'winter' | 'spring' | 'summer' | 'autumn';

/** One camera-facing blossom/leaf cluster, independently swaying — see this
 *  module's "Canopy: generated clusters" section for why this replaced both the
 *  original live-instance approach and the later single-baked-plane approach. */
interface CanopyCluster {
  mesh: THREE.Mesh;
  pivot: THREE.Group;
  densityKey: number;
  swayPhase: number;
  swayFreq: number;
  swayAmp: number;
}

interface SeasonClusterSet {
  group: THREE.Group;
  clusters: CanopyCluster[];
}

export interface TreeHandle {
  group: THREE.Group;
  /** The trunk/branch painting — a single camera-facing plane, baked once. Real
   *  cherry trunks barely move in wind (only the crown does), so unlike the
   *  canopy this has no pivot of its own; sway lives entirely in the canopy. */
  trunkMesh: THREE.Mesh;
  /** Whole-canopy sway pivot, positioned at the branch fork — shared by every
   *  season's cluster set so switching seasons doesn't reset the correlated sway. */
  canopyPivot: THREE.Group;
  /** One cluster set per season that has a canopy at all — all built from the
   *  same placement layout (see buildClusterPlacements) so the silhouette doesn't
   *  jump around across a season change, only the texture set and per-cluster
   *  visibility (density) does. */
  seasonClusters: Record<Exclude<CanopySeasonKey, 'winter'>, SeasonClusterSet>;
  seasonState: TreeSeasonState;
}

// ---------------------------------------------------------------------------
// Trunk/branch skeleton — drawn, not simulated.
//
// An earlier version built the trunk as real 3D geometry: recursive cylinder
// segments glued together at hard angle joints, then literally rotated 180°
// about the fork point to fake a symmetric second limb. Both choices read as
// mechanical rather than hand-drawn — visible elbow kinks at every joint, and a
// perfect mirror no real tree (or illustrator) would actually draw.
//
// Since the camera never moves (core/camera.ts), the trunk doesn't need to be
// real 3D geometry any more than the canopy does (see the canopy section's own
// doc comment below) — it can be *drawn*: a skeleton of tapered bezier curves in
// one flat (u,v) plane, filled once into a texture. Bezier curves keep each
// branch's start tangent matched to its parent's end tangent, so joints sweep
// smoothly instead of kinking. And because it's a drawing, the left/right limb
// balance can be handled the way an illustrator would balance a composition —
// generate the left limb freely, measure how far it reached, then generate the
// right limb independently (genuinely different random branching) but scaled to
// reach a comparable distance — rather than mirroring one limb onto the other.
// ---------------------------------------------------------------------------

interface Branch2D {
  p0: THREE.Vector2;
  p1: THREE.Vector2;
  p2: THREE.Vector2;
  p3: THREE.Vector2;
  radiusStart: number;
  radiusEnd: number;
  depth: number;
}

interface Tip2D {
  u: number;
  v: number;
}

// One child-branch count per depth level. depth0→1 is the low double-trunk "V"
// split the reference photo's winter (bare) panel shows clearly; depth1→2 fans
// each main limb out to build canopy width; the three finest levels add the fine,
// dense twig lace visible at the reference's silhouette edge.
const BRANCH_COUNTS = [1, 2, 3, 2, 2, 2, 2, 2, 2];
const MAX_DEPTH = BRANCH_COUNTS.length - 1;
const TREE_SCALE = 1.45;
const DEPTH_LENGTH = [0.85, 1.55, 1.05, 0.8, 0.62, 0.48, 0.38, 0.3, 0.24].map(
  (l) => l * TREE_SCALE,
);
const PIXELS_PER_WORLD_UNIT = 140;

function angleDir(angleRad: number): THREE.Vector2 {
  return new THREE.Vector2(Math.sin(angleRad), Math.cos(angleRad));
}

/** A cubic bezier whose start/end tangents match `startAngle`/`endAngle` exactly
 *  (angle measured from vertical, 0 = straight up) — this is what keeps a child
 *  branch's curve flowing smoothly out of its parent's instead of kinking. */
function branchCurve(
  p0: THREE.Vector2,
  startAngle: number,
  endAngle: number,
  length: number,
): { p0: THREE.Vector2; p1: THREE.Vector2; p2: THREE.Vector2; p3: THREE.Vector2 } {
  const d0 = angleDir(startAngle);
  const d1 = angleDir(endAngle);
  const dAvg = new THREE.Vector2().addVectors(d0, d1);
  if (dAvg.lengthSq() < 1e-6) dAvg.copy(d0);
  dAvg.normalize();
  const p3 = p0.clone().addScaledVector(dAvg, length);
  const p1 = p0.clone().addScaledVector(d0, length * 0.36);
  const p2 = p3.clone().addScaledVector(d1, -length * 0.36);
  return { p0, p1, p2, p3 };
}

function bezierPoint(
  p0: THREE.Vector2,
  p1: THREE.Vector2,
  p2: THREE.Vector2,
  p3: THREE.Vector2,
  t: number,
): THREE.Vector2 {
  const it = 1 - t;
  const a = it * it * it;
  const b = 3 * it * it * t;
  const c = 3 * it * t * t;
  const d = t * t * t;
  return new THREE.Vector2(
    p0.x * a + p1.x * b + p2.x * c + p3.x * d,
    p0.y * a + p1.y * b + p2.y * c + p3.y * d,
  );
}

interface Skeleton2D {
  branches: Branch2D[];
  tips: Tip2D[];
  forkPoint: THREE.Vector2;
}

/** Picks a child's own end-angle: fans children evenly across an arc around the
 *  parent's end direction, jitters it, then pulls it gently back toward vertical
 *  so branches curve up and outward rather than drifting sideways forever —
 *  deeper levels pull harder, rounding the silhouette into a canopy dome. */
function pickChildAngle(
  rng: Rng,
  parentAngle: number,
  depth: number,
  childIndex: number,
  childCount: number,
): number {
  const spreadDeg = 15 + depth * 6;
  const arc = THREE.MathUtils.degToRad(spreadDeg);
  const t = childCount > 1 ? childIndex / (childCount - 1) - 0.5 : 0;
  let angle = parentAngle + t * arc * 2 + THREE.MathUtils.degToRad(rngRange(rng, -7, 7));
  const uprightPull = 0.05 + depth * 0.03;
  angle *= 1 - uprightPull;
  return angle;
}

function recurseBranch(
  rng: Rng,
  start: THREE.Vector2,
  tangentInAngle: number,
  targetAngle: number,
  length: number,
  radiusStart: number,
  depth: number,
  lengthScale: number,
  branches: Branch2D[],
  tips: Tip2D[],
): void {
  const radiusEnd = radiusStart * rngRange(rng, 0.68, 0.8);
  const curve = branchCurve(start, tangentInAngle, targetAngle, length);
  branches.push({ ...curve, radiusStart, radiusEnd, depth });

  const isTip = depth >= MAX_DEPTH || radiusEnd < 0.016;
  if (isTip) {
    tips.push({ u: curve.p3.x, v: curve.p3.y });
    return;
  }

  const childCount = BRANCH_COUNTS[depth + 1] ?? 2;
  const childBaseLength = DEPTH_LENGTH[depth + 1] ?? DEPTH_LENGTH[DEPTH_LENGTH.length - 1];
  for (let i = 0; i < childCount; i++) {
    const childAngle = pickChildAngle(rng, targetAngle, depth, i, childCount);
    const childLength = childBaseLength * rngRange(rng, 0.85, 1.15) * lengthScale;
    recurseBranch(
      rng,
      curve.p3.clone(),
      targetAngle,
      childAngle,
      childLength,
      radiusEnd,
      depth + 1,
      lengthScale,
      branches,
      tips,
    );
  }
}

/**
 * Builds the whole tree skeleton in flat (u,v) "canvas" space, u=0 at the trunk's
 * ground point, v up. The V-split's two main limbs are each other's independent
 * random subtree, not mirror copies — see this module's doc comment — balanced by
 * measuring the left limb's horizontal reach and scaling the right limb's branch
 * lengths to approximately match it (with its own independent jitter so the match
 * isn't suspiciously exact either).
 */
function buildSkeleton2D(rng: Rng): Skeleton2D {
  const branches: Branch2D[] = [];
  const tips: Tip2D[] = [];

  const trunkBase = new THREE.Vector2(0, 0);
  const trunkRadius = 0.34 * TREE_SCALE;
  const trunkBendDeg = rngRange(rng, -4, 4);
  const trunkCurve = branchCurve(
    trunkBase,
    0,
    THREE.MathUtils.degToRad(trunkBendDeg),
    DEPTH_LENGTH[0],
  );
  const forkRadius = trunkRadius * rngRange(rng, 0.72, 0.8);
  branches.push({ ...trunkCurve, radiusStart: trunkRadius, radiusEnd: forkRadius, depth: 0 });
  const forkPoint = trunkCurve.p3;
  const trunkEndAngle = THREE.MathUtils.degToRad(trunkBendDeg);

  // A few short root flanges splaying down and out from the base, purely for
  // grounding — without them the trunk's base ribbon just ends in a flat cut where
  // it meets the ground, which reads as a post stuck in the dirt rather than
  // something rooted. bakeTrunkTexture also widens the trunk's own base radius.
  const rootCount = 3;
  for (let i = 0; i < rootCount; i++) {
    const rootAngle =
      Math.PI + (i / (rootCount - 1) - 0.5) * THREE.MathUtils.degToRad(70) +
      THREE.MathUtils.degToRad(rngRange(rng, -8, 8));
    const rootLength = rngRange(rng, 0.16, 0.24) * TREE_SCALE;
    const rootCurve = branchCurve(trunkBase.clone(), Math.PI, rootAngle, rootLength);
    branches.push({
      ...rootCurve,
      radiusStart: trunkRadius * rngRange(rng, 0.42, 0.55),
      radiusEnd: trunkRadius * 0.06,
      depth: MAX_DEPTH,
    });
  }

  const limbLength = DEPTH_LENGTH[1];

  const leftLeanDeg = rngRange(rng, 27, 35);
  const leftAngle = THREE.MathUtils.degToRad(-leftLeanDeg + rngRange(rng, -4, 4));
  const leftTipsBefore = tips.length;
  recurseBranch(
    rng,
    forkPoint.clone(),
    trunkEndAngle,
    leftAngle,
    limbLength * rngRange(rng, 0.95, 1.05),
    forkRadius,
    1,
    1,
    branches,
    tips,
  );
  let leftExtent = 0;
  for (const tip of tips.slice(leftTipsBefore)) {
    leftExtent = Math.max(leftExtent, Math.abs(tip.u - forkPoint.x));
  }

  // A natural, un-scaled limb tends to reach roughly this far horizontally —
  // used only as a fallback if the left limb came out unusually narrow, so the
  // balance scale never explodes.
  const naturalExtent = limbLength * 1.7;
  const rightLeanDeg = rngRange(rng, 27, 35);
  const rightAngle = THREE.MathUtils.degToRad(rightLeanDeg + rngRange(rng, -4, 4));
  const balanceScale = THREE.MathUtils.clamp(
    naturalExtent / Math.max(leftExtent, naturalExtent * 0.5),
    0.78,
    1.32,
  );
  recurseBranch(
    rng,
    forkPoint.clone(),
    trunkEndAngle,
    rightAngle,
    limbLength * rngRange(rng, 0.95, 1.05) * balanceScale,
    forkRadius,
    1,
    balanceScale,
    branches,
    tips,
  );

  return { branches, tips, forkPoint };
}

interface SkeletonBounds {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

function computeSkeletonBounds(branches: Branch2D[]): SkeletonBounds {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  const samples = 10;
  for (const b of branches) {
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = bezierPoint(b.p0, b.p1, b.p2, b.p3, t);
      const r = THREE.MathUtils.lerp(b.radiusStart, b.radiusEnd, t);
      uMin = Math.min(uMin, p.x - r);
      uMax = Math.max(uMax, p.x + r);
      vMin = Math.min(vMin, p.y - r);
      vMax = Math.max(vMax, p.y + r);
    }
  }
  return { uMin, uMax, vMin, vMax };
}

/** Bakes the trunk/branch skeleton into a texture: each branch becomes a tapered
 *  ribbon (ribbon width = 2×radius, radius eased along the curve so branches thin
 *  quickly near their tips like real wood does), filled solid. A single low-alpha
 *  diagonal gradient is then stamped back onto only the already-opaque bark pixels
 *  (`source-atop`) to fake one consistent light direction across the whole tree —
 *  cheap, but it reads as dimensional instead of flat silhouette-filled. */
function bakeTrunkTexture(
  branches: Branch2D[],
  bounds: SkeletonBounds,
  rng: Rng,
  pixelsPerUnit: number,
): { texture: THREE.CanvasTexture; width: number; height: number } {
  const width = Math.max(32, Math.round((bounds.uMax - bounds.uMin) * pixelsPerUnit));
  const height = Math.max(32, Math.round((bounds.vMax - bounds.vMin) * pixelsPerUnit));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const toPx = (u: number, v: number): [number, number] => [
    (u - bounds.uMin) * pixelsPerUnit,
    height - (v - bounds.vMin) * pixelsPerUnit,
  ];

  const baseColor = new THREE.Color('#4a3a2e');
  const samples = 20;
  for (const b of branches) {
    const shadeJitter = rngRange(rng, -0.06, 0.06);
    const col = baseColor.clone().offsetHSL(0, 0, shadeJitter);
    ctx.fillStyle = `rgb(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)})`;

    const left: THREE.Vector2[] = [];
    const right: THREE.Vector2[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = bezierPoint(b.p0, b.p1, b.p2, b.p3, t);
      const tNext = bezierPoint(b.p0, b.p1, b.p2, b.p3, Math.min(1, t + 0.02));
      const tangent = new THREE.Vector2().subVectors(tNext, p);
      if (tangent.lengthSq() < 1e-8) tangent.set(0, 1);
      tangent.normalize();
      const normal = new THREE.Vector2(-tangent.y, tangent.x);
      // Eased taper (t^0.6) so radius drops off faster near the tip than a
      // linear lerp would, matching how real branches thin.
      const eased = Math.pow(t, 0.6);
      let r = THREE.MathUtils.lerp(b.radiusStart, b.radiusEnd, eased);
      if (b.depth === 0) {
        // Root flare: the trunk widens sharply right at the ground instead of
        // meeting it as a uniform post.
        r *= 1 + 0.5 * Math.max(0, 1 - t / 0.14);
      }
      left.push(p.clone().addScaledVector(normal, r));
      right.push(p.clone().addScaledVector(normal, -r));
    }

    ctx.beginPath();
    let [sx, sy] = toPx(left[0].x, left[0].y);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < left.length; i++) {
      const [x, y] = toPx(left[i].x, left[i].y);
      ctx.lineTo(x, y);
    }
    for (let i = right.length - 1; i >= 0; i--) {
      const [x, y] = toPx(right[i].x, right[i].y);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // A child branch's flat start-cap doesn't reach all the way to its parent's
    // flat end-cap on the outer side of a bend, leaving a thin sliver of empty
    // canvas at almost every joint. A filled circle at the join plugs it — the
    // same trick round line-joins use.
    const [jx, jy] = toPx(b.p0.x, b.p0.y);
    ctx.beginPath();
    ctx.arc(jx, jy, b.radiusStart * pixelsPerUnit, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bark ridge/crack texture: a handful of thin, slightly darker strokes running
  // roughly lengthwise along the thicker branches — flat silhouette fill alone
  // reads as painted rubber, not wood. Confined to source-atop so it only marks
  // already-opaque bark, never spills onto the transparent background.
  ctx.globalCompositeOperation = 'source-atop';
  for (const b of branches) {
    if (b.depth > 2) continue;
    const crackCount = b.depth === 0 ? 5 : 3;
    for (let c = 0; c < crackCount; c++) {
      const tStart = rngRange(rng, 0, 0.5);
      const tEnd = Math.min(1, tStart + rngRange(rng, 0.3, 0.6));
      const sideOffset = rngRange(rng, -0.6, 0.6);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= 8; i++) {
        const t = THREE.MathUtils.lerp(tStart, tEnd, i / 8);
        const p = bezierPoint(b.p0, b.p1, b.p2, b.p3, t);
        const tNext = bezierPoint(b.p0, b.p1, b.p2, b.p3, Math.min(1, t + 0.02));
        const tangent = new THREE.Vector2().subVectors(tNext, p);
        if (tangent.lengthSq() < 1e-8) tangent.set(0, 1);
        tangent.normalize();
        const normal = new THREE.Vector2(-tangent.y, tangent.x);
        const eased = Math.pow(t, 0.6);
        const r = THREE.MathUtils.lerp(b.radiusStart, b.radiusEnd, eased);
        const wobble = Math.sin(t * 11 + c * 3.1) * r * 0.12;
        const off = p.clone().addScaledVector(normal, sideOffset * r * 0.7 + wobble);
        const [x, y] = toPx(off.x, off.y);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = `rgba(20,14,10,${rngRange(rng, 0.12, 0.22)})`;
      ctx.lineWidth = Math.max(1, (b.radiusStart * pixelsPerUnit) * 0.06);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  const grad = ctx.createLinearGradient(width * 0.15, 0, width * 0.75, height);
  grad.addColorStop(0, 'rgba(255,241,222,0.22)');
  grad.addColorStop(0.55, 'rgba(255,241,222,0)');
  grad.addColorStop(1, 'rgba(20,12,8,0.28)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, width, height };
}

// ---------------------------------------------------------------------------
// Canopy: generated clusters, independently swaying.
//
// Three different techniques were tried here, in order:
//  1. Live camera-facing sprite instances (~1000-3000 of them). Reads as a pile
//     of discrete circles no matter how many are added — three.js does not sort
//     instances *within* a single InstancedMesh, so overlapping alpha-blended
//     sprites composite in creation order rather than true visibility order.
//  2. A single Canvas2D-painted plane for the whole canopy, baked once from many
//     small procedural "dabs". This fixed the sorting problem (nothing to sort —
//     one plane) and, after a lot of tuning, looked reasonably painterly. But it
//     is one rigid billboard: the *whole* canopy can only sway as one piece, and
//     procedural dab-painting has a real ceiling on how close it reads to actual
//     illustrated linework (individual petals, per-cluster color variety) no
//     matter how many dabs are layered.
//  3. This: a moderate number (see buildClusterPlacements) of individual small
//     Mesh objects, each showing one of a handful of Gemini-generated blossom/
//     leaf cluster images (art-source/canopy-clusters/ — generated in the
//     reference image's own painterly style, chroma-key extracted to real alpha,
//     used under the user's explicit direction and budget). Because each cluster
//     is its own Object3D, three.js's ordinary transparent-object depth sort
//     handles occlusion between them correctly (unlike approach 1), while each
//     one can still have its own sway pivot (unlike approach 2) — solving both
//     prior failure modes at once, plus getting genuine illustrated texture
//     instead of a procedural approximation of it.
// ---------------------------------------------------------------------------

const CANOPY_CLUSTER_URLS: Record<Exclude<CanopySeasonKey, 'winter'>, string[]> = {
  spring: ['spring_1.png', 'spring_2.png', 'spring_3.png'],
  summer: ['summer_1.png', 'summer_2.png', 'summer_3.png'],
  autumn: ['autumn_1.png', 'autumn_2.png', 'autumn_3.png'],
};

const textureCache = new Map<string, THREE.Texture>();
const textureLoader = new THREE.TextureLoader();

function loadClusterTexture(fileName: string): THREE.Texture {
  const url = `${import.meta.env.BASE_URL}textures/canopy/${fileName}`;
  const cached = textureCache.get(url);
  if (cached) return cached;
  const texture = textureLoader.load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(url, texture);
  return texture;
}

interface ClusterPlacement {
  u: number;
  v: number;
  radius: number;
  densityKey: number;
}

/**
 * Scatters cluster placements across the canopy footprint (sized from the branch
 * tip cloud, same tapered-waist oval mask as the old dab system used) on a
 * jittered grid — coarser than the old per-dab grid since each placement is now
 * a whole illustrated cluster, not a paint dab. Shared by all three seasons
 * (buildSeasonClusterSet is called once per season with this same list) so the
 * canopy's silhouette doesn't jump around across a season change — only which
 * images are shown, and how many of them, does.
 */
function buildClusterPlacements(rng: Rng, tips: Tip2D[]): ClusterPlacement[] {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const tip of tips) {
    uMin = Math.min(uMin, tip.u);
    uMax = Math.max(uMax, tip.u);
    vMin = Math.min(vMin, tip.v);
    vMax = Math.max(vMax, tip.v);
  }

  const halfW = ((uMax - uMin) / 2) * 1.06;
  const halfHUp = ((vMax - vMin) / 2) * 1.12;
  const uCenter = (uMin + uMax) / 2;
  const maskCenterV = (vMin + vMax) / 2 + halfHUp * 0.06;
  const bottomTaperV = vMin - halfHUp * 0.22;

  const insideMask = (u: number, v: number): number => {
    const t = THREE.MathUtils.clamp((v - bottomTaperV) / (halfHUp * 0.9), 0, 1);
    const waist = THREE.MathUtils.lerp(0.4, 1, t);
    const nu = (u - uCenter) / (halfW * waist || 1);
    const nv = (v - maskCenterV) / (halfHUp || 1);
    return 1 - (nu * nu + nv * nv);
  };

  const cols = 12;
  const rows = 8;
  const cellW = (halfW * 2 * 1.08) / cols;
  const cellH = (halfHUp * 2 * 1.08) / rows;
  const radiusBase = Math.max(cellW, cellH) * 0.72;

  const placements: ClusterPlacement[] = [];
  for (let row = 0; row <= rows; row++) {
    const gv = -halfHUp * 1.08 + row * cellH;
    for (let col = 0; col <= cols; col++) {
      const gu = uCenter - halfW * 1.08 + col * cellW;
      const u = gu + rngRange(rng, -cellW * 0.42, cellW * 0.42);
      const v = maskCenterV + gv + rngRange(rng, -cellH * 0.42, cellH * 0.42);
      if (insideMask(u, v) < -0.08) continue;
      placements.push({ u, v, radius: radiusBase * rngRange(rng, 0.8, 1.35), densityKey: rng() });
    }
  }
  return placements;
}

// How much larger than a placement's nominal radius the plane needs to be: each
// generated image has the cluster filling most of its square frame but not all
// of it (padding was part of the generation prompt so soft edges don't get cut
// off), so the plane has to be sized up from the "content radius" to show that
// padding without the content itself reading smaller than intended.
const CLUSTER_PLANE_SCALE = 2.6;

function buildSeasonClusterSet(
  seasonKey: Exclude<CanopySeasonKey, 'winter'>,
  placements: ClusterPlacement[],
  rng: Rng,
  worldOf: (u: number, v: number) => THREE.Vector3,
  billboardAlign: THREE.Quaternion,
): SeasonClusterSet {
  const urls = CANOPY_CLUSTER_URLS[seasonKey];
  const textures = urls.map((f) => loadClusterTexture(f));
  const geometry = new THREE.PlaneGeometry(1, 1);
  const group = new THREE.Group();
  const clusters: CanopyCluster[] = [];

  for (const placement of placements) {
    const material = new THREE.MeshBasicMaterial({
      map: textures[Math.floor(rng() * textures.length)],
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    const side = placement.radius * CLUSTER_PLANE_SCALE;
    mesh.scale.set(side * (rng() < 0.5 ? -1 : 1), side, 1);
    mesh.quaternion.copy(billboardAlign);
    mesh.rotation.z = rngRange(rng, 0, Math.PI * 2);

    const pivot = new THREE.Group();
    pivot.position.copy(worldOf(placement.u, placement.v));
    // A tiny per-cluster depth jitter (along the camera-facing normal) breaks the
    // otherwise-exact coplanarity of every cluster. Without it, three.js's
    // transparent-object sort has near-ties to resolve between clusters at
    // (almost) equal camera distance, which can flicker as they sway; with it,
    // overlap order is stable and — for free — reads as the layered depth a real
    // bushy canopy has instead of one flat card.
    const depthJitter = rngRange(rng, -0.12, 0.12);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(billboardAlign);
    pivot.position.addScaledVector(normal, depthJitter);
    pivot.add(mesh);
    group.add(pivot);

    clusters.push({
      mesh,
      pivot,
      densityKey: placement.densityKey,
      swayPhase: rngRange(rng, 0, Math.PI * 2),
      swayFreq: rngRange(rng, 1.6, 3.2),
      swayAmp: rngRange(rng, 0.06, 0.16),
    });
  }

  return { group, clusters };
}

/**
 * Procedural single-tree generator: the trunk/branches are drawn as a 2D bezier
 * painting (see this module's earlier doc comment), the canopy is populated with
 * generated cluster images (see the doc comment just above). Both are built once
 * around the reference photo's silhouette (season-transition-animation.md's base
 * composition reference, `1786259704552.png`): a short, thick trunk splitting low
 * into two spreading main limbs, opening into a canopy noticeably wider than the
 * trunk is tall.
 */
export function createTree(seed = 20260809): TreeHandle {
  const rng = mulberry32(seed);
  const skeleton = buildSkeleton2D(rng);
  const skeletonBounds = computeSkeletonBounds(skeleton.branches);

  // The plane orientation/anchor is derived once from the fixed camera itself
  // (core/camera.ts) rather than from any generated geometry — anchoring at the
  // camera's own look-at height keeps the plane close to perpendicular to the
  // actual view ray regardless of how tall a given seed's tree comes out.
  const facingAnchor = new THREE.Vector3(0, CAMERA_LOOK_AT.y, 0);
  const towardCamera = CAMERA_POSITION.clone().sub(facingAnchor).normalize();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const billboardAlign = new THREE.Quaternion().setFromUnitVectors(zAxis, towardCamera);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(billboardAlign);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(billboardAlign);
  const worldOf = (u: number, v: number): THREE.Vector3 =>
    new THREE.Vector3().addScaledVector(right, u).addScaledVector(up, v);

  const trunkBake = bakeTrunkTexture(skeleton.branches, skeletonBounds, rng, PIXELS_PER_WORLD_UNIT);
  const trunkMaterial = new THREE.MeshBasicMaterial({
    map: trunkBake.texture,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const trunkWidth = skeletonBounds.uMax - skeletonBounds.uMin;
  const trunkHeight = skeletonBounds.vMax - skeletonBounds.vMin;
  const trunkMesh = new THREE.Mesh(new THREE.PlaneGeometry(trunkWidth, trunkHeight), trunkMaterial);
  trunkMesh.quaternion.copy(billboardAlign);
  trunkMesh.position.copy(
    worldOf((skeletonBounds.uMin + skeletonBounds.uMax) / 2, (skeletonBounds.vMin + skeletonBounds.vMax) / 2),
  );

  const placements = buildClusterPlacements(rng, skeleton.tips);
  const seasonClusters = {
    spring: buildSeasonClusterSet('spring', placements, rng, worldOf, billboardAlign),
    summer: buildSeasonClusterSet('summer', placements, rng, worldOf, billboardAlign),
    autumn: buildSeasonClusterSet('autumn', placements, rng, worldOf, billboardAlign),
  };

  // The pivot sits at the branch fork point (u,v) rather than the canopy's own
  // center, so rotating it for sway swings the top of the mass further than the
  // bottom — like something actually hanging off the tree, not spinning in place.
  const canopyPivot = new THREE.Group();
  canopyPivot.position.copy(worldOf(skeleton.forkPoint.x, skeleton.forkPoint.y));
  for (const season of Object.values(seasonClusters)) {
    for (const cluster of season.clusters) {
      cluster.pivot.position.sub(canopyPivot.position);
    }
    canopyPivot.add(season.group);
    season.group.visible = false;
  }

  const group = new THREE.Group();
  group.add(trunkMesh, canopyPivot);

  const seasonState: TreeSeasonState = { seasonKey: 'winter', density: 0, scale: 1 };

  return {
    group,
    trunkMesh,
    canopyPivot,
    seasonClusters,
    seasonState,
  };
}

/** Called by the season system (依頼A') whenever the dial moves to a new blend.
 *  `seasonId` picks which season's pre-built cluster set is shown (winter shows
 *  none — the bare tree); within that set, `density` toggles individual clusters
 *  on/off by their baked densityKey, same pattern as vegetation.ts/flowers.ts. */
export function setCanopySeasonState(
  tree: TreeHandle,
  seasonKey: CanopySeasonKey,
  density: number,
  scale: number,
): void {
  tree.seasonState.seasonKey = seasonKey;
  tree.seasonState.density = density;
  tree.seasonState.scale = scale;
  tree.canopyPivot.scale.setScalar(scale);

  for (const [key, season] of Object.entries(tree.seasonClusters)) {
    const isActive = key === seasonKey;
    season.group.visible = isActive;
    if (!isActive) continue;
    for (const cluster of season.clusters) {
      cluster.mesh.visible = cluster.densityKey < density;
    }
  }
}

/** Called every frame by the render loop (依頼B) to animate the canopy: a shared
 *  whole-mass sway (canopyPivot, correlated across every cluster) plus each
 *  visible cluster's own higher-frequency independent flutter on top — the same
 *  "thick branches sway slow and wide, thin twigs flutter small and fast"
 *  hierarchy the trunk's old sway shader used, now expressed as two nested
 *  pivots instead of a vertex shader. The trunk plane itself has no sway of its
 *  own; real trunks barely move, only the crown does. */
export function updateTreeAnimation(tree: TreeHandle, time: number, fieldStrength: number): void {
  tree.canopyPivot.rotation.z = Math.sin(time * 1.1) * 0.045 * fieldStrength;
  tree.canopyPivot.rotation.x = Math.sin(time * 0.85 + 1.7) * 0.03 * fieldStrength;

  const seasonKey = tree.seasonState.seasonKey;
  if (seasonKey === 'winter') return;
  const season = tree.seasonClusters[seasonKey];
  for (const cluster of season.clusters) {
    if (!cluster.mesh.visible) continue;
    cluster.pivot.rotation.z =
      Math.sin(time * cluster.swayFreq + cluster.swayPhase) * cluster.swayAmp * fieldStrength;
    cluster.pivot.rotation.x =
      Math.cos(time * cluster.swayFreq * 0.7 + cluster.swayPhase * 1.3) *
      cluster.swayAmp *
      0.6 *
      fieldStrength;
  }
}

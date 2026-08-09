import * as THREE from 'three';
import { mulberry32, rngRange, type Rng } from '../core/prng';
import { CAMERA_POSITION, CAMERA_LOOK_AT } from '../core/camera';

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
  /** The trunk/branch painting — a single camera-facing plane, baked once. Real
   *  cherry trunks barely move in wind (only the crown does), so unlike the
   *  canopy this has no pivot of its own; sway lives entirely in canopyPivot. */
  trunkMesh: THREE.Mesh;
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
// blending, no sorting concerns), and mapped onto one camera-facing plane.
// ---------------------------------------------------------------------------

interface CanopyDab {
  u: number;
  v: number;
  radius: number;
  densityKey: number;
  tierIndex: number;
  rotation: number;
  /** Solid opaque base-fill dabs, drawn first and at full alpha (see
   *  bakeCanopyTexture) — without them, gaps between the semi-transparent
   *  textured dabs let the black trunk show through, and alpha-blending a light
   *  color over black darkens/muddies it. A textured dab only ever refines what's
   *  already solid; it never has to be the only thing standing between "canopy"
   *  and bare canvas. */
  isBase: boolean;
}

// Brightness levels drive which pre-baked sprite a dab uses; BRIGHTNESS_TIERS is
// only the numeric ladder `tierForBrightness` snaps to. COLOR_TIERS is the actual
// paint at each level — not pure grayscale. A cool, slightly purple-tinted shadow
// through to a warm near-white highlight, so once a season's canopyColor multiplies
// this texture (setCanopyColor), the shadow side comes out desaturated/cooler and
// the lit side warmer, instead of every tier just being the same hue at a different
// brightness. The same "one consistent light direction" idea as the trunk's
// source-atop gradient, expressed as paint instead of a lighting shader.
// A wide, dark shadow tier reintroduced the exact "muddy dark maroon" problem
// that going unlit was supposed to fix: multiplying a texture value against a
// moderately saturated season color crushes whichever channel is weakest in that
// color (pink's green, autumn's blue, ...) much harder than the others, so a
// "shadow" tier at 0.55-0.6 comes out desaturated and muddy rather than a
// believably darker version of the same hue. Working backward from pink (the
// worst case — its green channel is the most unbalanced) to a result that still
// reads as pink rather than mauve put the floor around 0.78, not the ~0.55 a
// real light/shadow contrast would suggest — so the tier ladder here is narrow
// and bright on purpose, prioritizing "still looks like the season's color" over
// dramatic shading range.
const BRIGHTNESS_TIERS = [0.78, 0.85, 0.91, 0.96, 1.0];
const COLOR_TIERS = ['#c0bac8', '#d4d0ce', '#e6e3d9', '#f3eede', '#fff8ec'];
const PIXELS_PER_WORLD_UNIT = 140;

/** A dab sprite is a small cluster of 3-4 overlapping soft lobes rather than one
 *  perfect circle — stamped (with a random rotation per dab, see bakeCanopyTexture)
 *  it reads as an irregular petal/blossom cluster instead of a uniform dot, which is
 *  what actually sells "painted flowers" over "pile of circles" at this scale. */
function createTierSprite(colorHex: string, seed: number, size = 56): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(seed);
  const color = new THREE.Color(colorHex);
  const rgb = `${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)}`;
  const cx = size / 2;
  const cy = size / 2;

  const lobeCount = 3;
  for (let i = 0; i < lobeCount; i++) {
    const angle = (i / lobeCount) * Math.PI * 2 + rngRange(rng, -0.4, 0.4);
    const dist = rngRange(rng, size * 0.03, size * 0.09);
    const lx = cx + Math.cos(angle) * dist;
    const ly = cy + Math.sin(angle) * dist;
    const r = size * rngRange(rng, 0.26, 0.32);
    const gradient = ctx.createRadialGradient(lx, ly, 0, lx, ly, r);
    gradient.addColorStop(0, `rgba(${rgb},1)`);
    gradient.addColorStop(0.68, `rgba(${rgb},0.82)`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  // A brighter core ties the lobes together into one cohesive shape rather than
  // reading as separate dots.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.3);
  core.addColorStop(0, `rgba(${rgb},0.6)`);
  core.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Builds the dab list in the same flat (u,v) plane the trunk skeleton lives in.
 *
 * The literal branch-tip cloud is *not* painted directly: dabs placed only near
 * each tip read as several separate detached blobs, because the procedural
 * branching leaves tips clustered with real gaps between them — not the one
 * continuous rounded mass the reference photo shows. Real cherry canopies (and
 * the reference art) read as a cumulus-cloud silhouette: many overlapping
 * rounded lobes fused into one shape with a bumpy but unbroken edge. So instead
 * this scatters lobe centers on an evenly-spaced jittered grid across an oval
 * footprint (sized from the tip cloud, tapered at the bottom toward the trunk
 * fork), then fills each lobe with one soft macro dab plus many small fine dabs.
 * The tip cloud only decides the footprint's size and position.
 */
function buildCanopyDabs(rng: Rng, tips: Tip2D[]): CanopyDab[] {
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

  // Inside-test for the footprint: an oval that narrows toward a waist in its
  // bottom quarter (where the canopy gathers back down onto the trunk fork)
  // instead of a plain ellipse that would look like it hovers over the tree.
  const insideMask = (u: number, v: number): number => {
    const t = THREE.MathUtils.clamp((v - bottomTaperV) / (halfHUp * 0.9), 0, 1);
    const waist = THREE.MathUtils.lerp(0.4, 1, t);
    const nu = (u - uCenter) / (halfW * waist || 1);
    const nv = (v - maskCenterV) / (halfHUp || 1);
    return 1 - (nu * nu + nv * nv);
  };

  const heightBrightness = (v: number): number => {
    const t = THREE.MathUtils.clamp((v - (maskCenterV - halfHUp)) / (halfHUp * 2 || 1), 0, 1);
    // Matches BRIGHTNESS_TIERS' floor — see that constant's comment on why this
    // stays close to 1.0 instead of a wider "real" shadow range.
    return THREE.MathUtils.lerp(0.8, 1.0, t);
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

  // Separate column/row spacing rather than one square cell size: the footprint
  // is wide and comparatively short (branches spread laterally more than
  // vertically), so a cell size derived only from width leaves far too few rows
  // to sample the mask's narrower vertical extent, producing real gaps.
  //
  // The grid resolution here is deliberately far denser than looks like it should
  // be necessary — a first pass at "enough" lobes (~60) left visible gaps between
  // dabs wide enough for the black trunk to show through, and semi-transparent
  // dabs blending against that black background is what actually caused the
  // muddy/purple look, not the color choices. Overshooting density first and
  // trimming individual knobs afterward (sparkle count, hue spread, ...) finds the
  // real "enough" far more reliably than creeping up from a conservative guess.
  const cols = 30;
  const rows = 18;
  const cellW = (halfW * 2 * 1.08) / cols;
  const cellH = (halfHUp * 2 * 1.08) / rows;
  const lobeRadiusBase = Math.max(cellW, cellH);
  const lobeCenters: { u: number; v: number; radius: number; edge: number }[] = [];
  for (let row = 0; row <= rows; row++) {
    const gv = -halfHUp * 1.08 + row * cellH;
    for (let col = 0; col <= cols; col++) {
      const gu = uCenter - halfW * 1.08 + col * cellW;
      const u = gu + rngRange(rng, -cellW * 0.4, cellW * 0.4);
      const v = maskCenterV + gv + rngRange(rng, -cellH * 0.4, cellH * 0.4);
      const edge = insideMask(u, v);
      if (edge < -0.08) continue;
      lobeCenters.push({ u, v, radius: lobeRadiusBase * rngRange(rng, 0.95, 1.3), edge });
    }
  }

  const dabs: CanopyDab[] = [];
  for (const lobe of lobeCenters) {
    // Lobes near the silhouette boundary (low `edge`) are sized up and drawn as
    // visually distinct rounded bumps rather than blending flatly into their
    // neighbors — the cumulus/cauliflower edge the reference photo's canopy shows,
    // instead of a smoothly-tapered ellipse outline. Interior lobes stay as dense
    // continuous fill.
    const isEdgeLobe = lobe.edge < 0.32;
    const radius = lobe.radius * (isEdgeLobe ? rngRange(rng, 1.05, 1.18) : 1);

    // Opaque base fill: guarantees full coverage under the textured dabs below,
    // so nothing but this lobe's own soft edge ever shows the trunk through —
    // see CanopyDab.isBase's doc comment. Oversized (1.4x) so neighboring lobes'
    // base fills overlap generously even at this grid's spacing.
    dabs.push({
      u: lobe.u,
      v: lobe.v,
      radius: radius * 1.4,
      densityKey: rng() * 0.55,
      tierIndex: tierForBrightness(heightBrightness(lobe.v) * rngRange(rng, 0.97, 1.03)),
      rotation: 0,
      isBase: true,
    });

    // Macro dab: the lobe's own soft rounded texture on top of the base fill.
    // Kept in the same low densityKey band as the base so the overall silhouette
    // survives even at spring/autumn's reduced density — only the fine surface
    // texture thins out, not the shape itself.
    dabs.push({
      u: lobe.u,
      v: lobe.v,
      radius,
      densityKey: rng() * 0.55,
      tierIndex: tierForBrightness(heightBrightness(lobe.v) * rngRange(rng, 0.95, 1.05)),
      rotation: rngRange(rng, 0, Math.PI * 2),
      isBase: false,
    });

    const fineCount = 30;
    const spread = isEdgeLobe ? 0.92 : 1.08;
    for (let i = 0; i < fineCount; i++) {
      const angle = rngRange(rng, 0, Math.PI * 2);
      const dist = Math.sqrt(rng()) * radius * spread;
      const du = Math.cos(angle) * dist;
      const dv = Math.sin(angle) * dist;
      const brightness = heightBrightness(lobe.v + dv) * rngRange(rng, 0.82, 1.18);
      dabs.push({
        u: lobe.u + du,
        v: lobe.v + dv,
        radius: rngRange(rng, 0.16, 0.36) * radius,
        densityKey: rng(),
        tierIndex: tierForBrightness(brightness),
        rotation: rngRange(rng, 0, Math.PI * 2),
        isBase: false,
      });
    }
  }

  // Sparkle highlights: a handful of very small, very bright dabs scattered near
  // the top/outer edge of the canopy — individual blossom clusters catching light,
  // rather than the smooth brightness gradient alone. A pure brightness gradient
  // reads as an airbrushed sphere; distinct sparkle points read as sunlight caught
  // on real texture.
  const topTier = BRIGHTNESS_TIERS.length - 1;
  const sparkleCount = Math.round(lobeCenters.length * 0.35);
  for (let i = 0; i < sparkleCount; i++) {
    const lobe = lobeCenters[Math.floor(rng() * lobeCenters.length)];
    if (!lobe) continue;
    // Bias toward the upper half of the lobe (away from straight down), so
    // sparkles read as sunlit rather than scattered uniformly. angle=0 is +u
    // (right), angle=π/2 is +v (up), so [0, π] sweeps right→up→left.
    const angle = rngRange(rng, 0, Math.PI);
    const dist = rngRange(rng, 0.5, 1.05) * lobe.radius;
    dabs.push({
      u: lobe.u + Math.cos(angle) * dist,
      v: lobe.v + Math.sin(angle) * dist,
      radius: rngRange(rng, 0.05, 0.1) * lobe.radius,
      densityKey: rng() * 0.85,
      tierIndex: topTier,
      rotation: rngRange(rng, 0, Math.PI * 2),
      isBase: false,
    });
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
  tierRgb: string[],
  bounds: CanopyBounds,
): THREE.CanvasTexture {
  const canvasWidth = Math.max(32, Math.round(bounds.planeWidth * PIXELS_PER_WORLD_UNIT));
  const canvasHeight = Math.max(32, Math.round(bounds.planeHeight * PIXELS_PER_WORLD_UNIT));
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;

  const toPx = (dab: CanopyDab): [number, number, number] => [
    (dab.u - bounds.uMid + bounds.planeWidth / 2) * PIXELS_PER_WORLD_UNIT,
    (bounds.planeHeight / 2 - (dab.v - bounds.vMid)) * PIXELS_PER_WORLD_UNIT,
    dab.radius * PIXELS_PER_WORLD_UNIT,
  ];

  // Base pass first, entirely separate from the textured pass below: every base
  // dab must be solid before anything else is drawn, or a later base dab could
  // still paint over — and partially reveal through alpha blending — an earlier
  // textured dab's soft edge. See CanopyDab.isBase's doc comment.
  for (const dab of dabs) {
    if (!dab.isBase || dab.densityKey >= density) continue;
    const [px, py, pr] = toPx(dab);
    const gradient = ctx.createRadialGradient(px, py, 0, px, py, pr);
    const rgb = tierRgb[dab.tierIndex];
    gradient.addColorStop(0, `rgba(${rgb},1)`);
    gradient.addColorStop(0.72, `rgba(${rgb},1)`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const dab of dabs) {
    if (dab.isBase || dab.densityKey >= density) continue;
    const [px, py, pr] = toPx(dab);
    // Rotating each stamp independently turns the handful of base sprites (each
    // itself an asymmetric multi-lobe cluster, not a circle) into effectively
    // unlimited apparent variety instead of visibly repeating a stamp pattern.
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(dab.rotation);
    ctx.drawImage(tierSprites[dab.tierIndex], -pr, -pr, pr * 2, pr * 2);
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Procedural single-tree generator, drawn (not simulated) to match the reference
 * photo's silhouette (season-transition-animation.md's base composition reference,
 * `1786259704552.png`): a short, thick trunk splitting low into two spreading main
 * limbs, opening into a canopy noticeably wider than the trunk is tall. Both the
 * trunk/branches and the canopy are flat camera-facing planes baked once from
 * Canvas2D painting — see this module's two doc comments for why a fixed camera
 * makes that the right technique instead of live 3D geometry.
 *
 * `densityLevels` are the distinct canopy densities the season system will ever ask
 * for (season-transition-animation.md's per-scene canopyDensity values) — one
 * texture is pre-baked per distinct value so `setCanopySeasonState` only ever swaps
 * a texture reference, never re-bakes at runtime.
 */
export function createTree(seed = 20260809, densityLevels: number[] = [1]): TreeHandle {
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

  const dabs = buildCanopyDabs(rng, skeleton.tips);
  const bounds = computeCanopyBounds(dabs);
  const tierSprites = COLOR_TIERS.map((hex, i) => createTierSprite(hex, seed + i + 1));
  const tierRgb = COLOR_TIERS.map((hex) => {
    const c = new THREE.Color(hex);
    return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  });

  const distinctDensities = [...new Set(densityLevels)];
  const canopyTextures: CanopyTextureVariant[] = distinctDensities.map((density) => ({
    density,
    texture: bakeCanopyTexture(dabs, density, tierSprites, tierRgb, bounds),
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

  // The pivot sits at the branch fork point (u,v) rather than the canopy's own
  // center, so rotating it for sway swings the top of the mass further than the
  // bottom — like something actually hanging off the tree, not spinning in place.
  const canopyPivot = new THREE.Group();
  canopyPivot.position.copy(worldOf(skeleton.forkPoint.x, skeleton.forkPoint.y));
  canopyMesh.position
    .copy(worldOf(bounds.uMid, bounds.vMid))
    .sub(canopyPivot.position);
  canopyPivot.add(canopyMesh);

  const group = new THREE.Group();
  group.add(trunkMesh, canopyPivot);

  const seasonState: TreeSeasonState = { density: canopyTextures[0].density, scale: 1 };

  return {
    group,
    trunkMesh,
    canopyMesh,
    canopyMaterial,
    canopyPivot,
    canopyTextures,
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

/** Called every frame by the render loop (依頼B) to animate the canopy's whole-
 *  mass sway (see canopyPivot's doc comment on createTree). The trunk plane has
 *  no sway of its own — real trunks barely move; only the crown does. */
export function updateTreeAnimation(tree: TreeHandle, time: number, fieldStrength: number): void {
  tree.canopyPivot.rotation.z = Math.sin(time * 1.1) * 0.045 * fieldStrength;
  tree.canopyPivot.rotation.x = Math.sin(time * 0.85 + 1.7) * 0.03 * fieldStrength;
}

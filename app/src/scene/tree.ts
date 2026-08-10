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
  /** The trunk/branch painting — a single camera-facing plane showing a
   *  Gemini-generated image (art-source/trunk/), not procedural geometry. Real
   *  cherry trunks barely move in wind (only the crown does), so unlike the
   *  canopy this has no sway pivot of its own. */
  trunkMesh: THREE.Mesh;
  /** Whole-canopy sway pivot, positioned at the crown's own start height on the
   *  trunk — shared by every season's cluster set so switching seasons doesn't
   *  reset the correlated sway. */
  canopyPivot: THREE.Group;
  /** One cluster set per season that has a canopy at all — all built from the
   *  same placement layout (see buildClusterPlacements) so the silhouette doesn't
   *  jump around across a season change, only the texture set and per-cluster
   *  visibility (density) does. */
  seasonClusters: Record<Exclude<CanopySeasonKey, 'winter'>, SeasonClusterSet>;
  seasonState: TreeSeasonState;
}

// ---------------------------------------------------------------------------
// Trunk: a generated image, not a procedural simulation.
//
// Three approaches were tried, in order:
//  1. Live 3D cylinder geometry, recursively branched and rotated. Read as
//     mechanical — visible elbow kinks at every joint, and (in one revision) a
//     literal 180°-rotated mirror copy for the second limb, which no real tree
//     draws.
//  2. A hand-authored 2D bezier skeleton (tapered ribbons, tangent-continuous
//     joints), with every angle/length/branch-count hand-tuned by eye against
//     screenshots. This produced smooth joints, but no amount of parameter
//     nudging converges on a *specific* illustrated tree's actual gesture —
//     procedural recursion and an artist's (or a generative model's) drawing are
//     different processes with different shape distributions. Comparing
//     screenshots to the reference kept finding new mismatches (a low
//     ground-level "V" split that the reference doesn't have at all; a
//     symmetric dome where the reference leans hard to one side) because the
//     tuning was never actually anchored to the reference image, just to a
//     general impression of it.
//  3. This: the same technique already proven for the canopy (see that section's
//     doc comment) — generate the trunk directly from the reference's own
//     cropped winter panel via Gemini, chroma-key extract it to real alpha, and
//     use the image as-is. Whatever gesture, lean, and branch structure the
//     reference tree actually has, this trunk has too, because it's the same
//     drawing style applied to the same source — not a hand-tuned approximation
//     of it. See art-source/trunk/ for the prompt/generation/extraction record.
// ---------------------------------------------------------------------------

const PIXELS_PER_WORLD_UNIT = 140;
const TRUNK_URL = `${import.meta.env.BASE_URL}textures/trunk/winter.png`;

interface TrunkAsset {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  width: number;
  height: number;
  /** Pixel position of the trunk's ground contact point — world (u,v) = (0,0)
   *  maps here. Found automatically (centroid-x of the lowest opaque row)
   *  rather than assumed centered, since the generated tree isn't symmetric. */
  anchorPx: number;
  anchorPy: number;
  /** Topmost opaque row — used to size the canopy placement zone as a fraction
   *  of the tree's actual pixel height instead of a hardcoded world distance. */
  contentTopPy: number;
}

async function loadTrunkAsset(url: string): Promise<TrunkAsset> {
  const res = await fetch(url);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let anchorPy = canvas.height - 1;
  let anchorPx = canvas.width / 2;
  let contentTopPy = 0;
  let foundTop = false;
  for (let y = 0; y < canvas.height; y++) {
    let sumX = 0;
    let count = 0;
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] > 40) {
        sumX += x;
        count++;
      }
    }
    if (count > 0) {
      if (!foundTop) {
        contentTopPy = y;
        foundTop = true;
      }
      anchorPy = y;
      anchorPx = sumX / count;
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Default RepeatWrapping samples across the wrap boundary at lower mip levels
  // whenever content doesn't fill the whole square — exactly this image's case
  // (the tree occupies part of the frame, the rest is fully transparent) — which
  // shows up as a faint rectangular seam against a differently-colored
  // background. Clamping stops the sampler from ever wrapping around.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return { canvas, texture, width: canvas.width, height: canvas.height, anchorPx, anchorPy, contentTopPy };
}

/** A box-blurred alpha lookup over the trunk image, via a summed-area table (one
 *  pass to build, O(1) per query regardless of blur radius) — this is the
 *  "is there branch material near here" field the canopy cluster placement
 *  samples, replacing the old hand-authored elliptical footprint mask with the
 *  actual generated silhouette. Blurring is what turns "sits exactly on a twig
 *  pixel" into "sits somewhere a twig is nearby", bridging the gaps between fine
 *  branches into one continuous placement zone the way real foliage would. */
function buildAlphaCoverage(trunk: TrunkAsset): (px: number, py: number, radiusPx: number) => number {
  const w = trunk.width;
  const h = trunk.height;
  const ctx = trunk.canvas.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, w, h);
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowBase = (y + 1) * (w + 1);
    const prevRowBase = y * (w + 1);
    for (let x = 0; x < w; x++) {
      rowSum += data[(y * w + x) * 4 + 3] / 255;
      integral[rowBase + x + 1] = integral[prevRowBase + x + 1] + rowSum;
    }
  }
  return (px: number, py: number, radiusPx: number): number => {
    const x0 = Math.max(0, Math.round(px - radiusPx));
    const x1 = Math.min(w, Math.round(px + radiusPx));
    const y0 = Math.max(0, Math.round(py - radiusPx));
    const y1 = Math.min(h, Math.round(py + radiusPx));
    if (x1 <= x0 || y1 <= y0) return 0;
    const sum =
      integral[y1 * (w + 1) + x1] -
      integral[y0 * (w + 1) + x1] -
      integral[y1 * (w + 1) + x0] +
      integral[y0 * (w + 1) + x0];
    return sum / ((x1 - x0) * (y1 - y0));
  };
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
  // See loadTrunkAsset's identical comment — same wrap-boundary mip bleeding risk
  // whenever a cluster's content doesn't fill its whole square.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
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
 * Scatters cluster placements using the trunk image's own alpha coverage field
 * (see buildAlphaCoverage) instead of a hand-authored elliptical footprint —
 * wherever the generated tree actually has branch material nearby, clusters can
 * go; nowhere else. This ties the canopy's shape directly to the same generated
 * drawing the trunk uses, rather than an independent guess about where a canopy
 * "should" be. Restricted to the upper `canopyStartFraction` of the tree's own
 * height so clusters don't scatter across the bare lower trunk.
 */
function buildClusterPlacements(
  rng: Rng,
  trunk: TrunkAsset,
  pxToWorld: (px: number, py: number) => [number, number],
): ClusterPlacement[] {
  const coverage = buildAlphaCoverage(trunk);
  const blurRadiusPx = 46;

  const canopyStartFraction = 0.58;
  const canopyStartPy = trunk.anchorPy - (trunk.anchorPy - trunk.contentTopPy) * canopyStartFraction;

  // Scan the trunk image's own bounding box (with a small margin so clusters can
  // hang slightly past the drawn twig tips) in *pixel* space directly — no need
  // to separately track a world-space footprint, the image bounds already are
  // the footprint.
  const marginPx = 40;
  const pxMin = -marginPx;
  const pxMax = trunk.width + marginPx;
  const pyMin = trunk.contentTopPy - marginPx;
  const pyMax = canopyStartPy;

  const cellPx = 44;
  const cols = Math.max(1, Math.round((pxMax - pxMin) / cellPx));
  const rows = Math.max(1, Math.round((pyMax - pyMin) / cellPx));
  const cellW = (pxMax - pxMin) / cols;
  const cellH = (pyMax - pyMin) / rows;

  const placements: ClusterPlacement[] = [];
  for (let row = 0; row <= rows; row++) {
    const gpy = pyMin + row * cellH;
    for (let col = 0; col <= cols; col++) {
      const gpx = pxMin + col * cellW;
      const px = gpx + rngRange(rng, -cellW * 0.4, cellW * 0.4);
      const py = gpy + rngRange(rng, -cellH * 0.4, cellH * 0.4);
      if (py > canopyStartPy) continue;
      const c = coverage(px, py, blurRadiusPx);
      if (c < 0.045) continue;
      const [u, v] = pxToWorld(px, py);
      const radiusWorld = (cellPx / PIXELS_PER_WORLD_UNIT) * rngRange(rng, 0.55, 0.85);
      placements.push({ u, v, radius: radiusWorld, densityKey: rng() });
    }
  }
  return placements;
}

// How much larger than a placement's nominal radius the plane needs to be: each
// generated image has the cluster filling most of its square frame but not all
// of it (padding was part of the generation prompt so soft edges don't get cut
// off), so the plane has to be sized up from the "content radius" to show that
// padding without the content itself reading smaller than intended.
const CLUSTER_PLANE_SCALE = 2.4;

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
 * Assembles the tree from generated assets: the trunk/branches are a single
 * Gemini-generated image (see this module's trunk doc comment), the canopy is
 * populated with generated cluster images at placements sampled from that same
 * trunk image's alpha coverage (see the canopy doc comment). Async because the
 * trunk image has to be decoded to a canvas (for pixel analysis, not just GPU
 * upload) before cluster placement can be computed from it.
 */
export async function createTree(seed = 20260809): Promise<TreeHandle> {
  const rng = mulberry32(seed);
  const trunk = await loadTrunkAsset(TRUNK_URL);

  const trunkMaterial = new THREE.MeshBasicMaterial({
    map: trunk.texture,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const trunkWidthWorld = trunk.width / PIXELS_PER_WORLD_UNIT;
  const trunkHeightWorld = trunk.height / PIXELS_PER_WORLD_UNIT;
  const trunkMesh = new THREE.Mesh(new THREE.PlaneGeometry(trunkWidthWorld, trunkHeightWorld), trunkMaterial);

  const pxToWorld = (px: number, py: number): [number, number] => [
    (px - trunk.anchorPx) / PIXELS_PER_WORLD_UNIT,
    (trunk.anchorPy - py) / PIXELS_PER_WORLD_UNIT,
  ];

  // The plane orientation/anchor is derived once from the fixed camera itself
  // (core/camera.ts) rather than from any generated geometry — anchoring at the
  // camera's own look-at height keeps the plane close to perpendicular to the
  // actual view ray. worldOf places (u,v) — world (0,0) is the trunk's own
  // ground anchor pixel — in that camera-facing plane.
  const facingAnchor = new THREE.Vector3(0, CAMERA_LOOK_AT.y, 0);
  const towardCamera = CAMERA_POSITION.clone().sub(facingAnchor).normalize();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const billboardAlign = new THREE.Quaternion().setFromUnitVectors(zAxis, towardCamera);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(billboardAlign);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(billboardAlign);
  const worldOf = (u: number, v: number): THREE.Vector3 =>
    new THREE.Vector3().addScaledVector(right, u).addScaledVector(up, v);

  trunkMesh.quaternion.copy(billboardAlign);
  const [trunkCenterU, trunkCenterV] = pxToWorld(trunk.width / 2, trunk.height / 2);
  trunkMesh.position.copy(worldOf(trunkCenterU, trunkCenterV));

  const placements = buildClusterPlacements(rng, trunk, pxToWorld);
  const seasonClusters = {
    spring: buildSeasonClusterSet('spring', placements, rng, worldOf, billboardAlign),
    summer: buildSeasonClusterSet('summer', placements, rng, worldOf, billboardAlign),
    autumn: buildSeasonClusterSet('autumn', placements, rng, worldOf, billboardAlign),
  };

  // The pivot sits at the crown's own start height (see canopyStartFraction in
  // buildClusterPlacements) rather than the canopy's own center, so rotating it
  // for sway swings the top of the mass further than the bottom — like
  // something actually hanging off the tree, not spinning in place.
  const canopyStartFraction = 0.58;
  const canopyStartPy = trunk.anchorPy - (trunk.anchorPy - trunk.contentTopPy) * canopyStartFraction;
  const [, canopyPivotV] = pxToWorld(trunk.anchorPx, canopyStartPy);
  const canopyPivot = new THREE.Group();
  canopyPivot.position.copy(worldOf(0, canopyPivotV));
  for (const season of Object.values(seasonClusters)) {
    for (const cluster of season.clusters) {
      cluster.pivot.position.sub(canopyPivot.position);
    }
    canopyPivot.add(season.group);
    season.group.visible = false;
  }

  // No recentering needed: pxToWorld's origin *is* the trunk's own ground
  // anchor pixel (found automatically in loadTrunkAsset), so world (0,0) already
  // sits exactly where the trunk meets the ground, matching the ground/lake
  // composition's own coordinate origin (scene/composition.ts).
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
 *  pivots. The trunk plane itself has no sway of its own; real trunks barely
 *  move, only the crown does. */
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

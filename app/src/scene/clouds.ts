import * as THREE from 'three';
import { mulberry32 } from '../core/buildNoise';
import { buildNoduleGeometry, buildHaloGeometry } from './cloudNodule';
import { createCloudMaterials, type CloudMaterials } from './cloudShader';

export { createCloudMaterials };
export type { CloudMaterials };

/**
 * Mesh-instanced clouds — replaces the earlier fullscreen volumetric raymarch
 * for the clouds themselves (the atmosphere/sky in sky.ts is unchanged) after
 * examining amanesf/planet-canvas2's src/clouds.ts, a prior project's cloud
 * system explicitly tuned for "新海誠的な" quality. See cloudNodule.ts for the
 * core technique (baked vertical shading gradient instead of computed
 * self-shadow) and this file's onBeforeCompile hook for the rim/dusk terms
 * ported from that project's coreMaterial.
 */

interface PuffSpec {
  position: THREE.Vector3; // base (pre-wind) position, km
  scale: number;
  stretch: THREE.Vector3; // per-axis scale multiplier — non-uniform puffs, not just uniform balls
  rotationY: number;
  levelFrac: number; // 0 (base) .. 1 (top) — used to fade in with growth
  burial: number; // 0 (fully exposed) .. 1 (tucked in a crevice) — filled in after placement
}

interface Nodule {
  base: THREE.Vector3;
  scale: number;
  stretch: THREE.Vector3;
  rotationY: number;
  levelFrac: number;
  burial: number;
}

export interface CloudClusterHandle {
  group: THREE.Group;
  update: (elapsed: number, growth: number, windOffset: THREE.Vector2) => void;
}

/**
 * Scatters puffs across `levels` height bands from baseAlt to topAlt, each
 * band an inward-biased disc scatter (closer to the band's own centre = bigger
 * puff) — the vertical extension of buildCloudCluster's 2D disc scatter in
 * planet-canvas2. `radiusProfile(t)` (t=0 base..1 top) sets how wide each
 * band's scatter disc is, so a single call can build either a squat cumulus
 * (few levels, roughly constant radius) or a towering cumulonimbus (many
 * levels, bulging in the upper-middle per real cumulonimbus proportions).
 */
// Non-uniform per-axis scale — a puff that's stretched on x/z or squashed on
// y reads as an irregular lump rather than a perfect ball, cheaply (no extra
// geometry, just an anisotropic instance-matrix scale).
function randomStretch(rand: () => number): THREE.Vector3 {
  // y range tightened (was 0.7-1.3). Combined with the nodule mesh's own
  // vertical squash, the wider range made puffs read as separate flat
  // lozenges stacked in a pile rather than lobes of one mass.
  return new THREE.Vector3(0.72 + rand() * 0.7, 0.85 + rand() * 0.4, 0.72 + rand() * 0.7);
}

function buildPuffCluster(
  seed: number,
  centerXZ: THREE.Vector2,
  baseAlt: number,
  topAlt: number,
  levels: number,
  radiusProfile: (t: number) => number,
  puffsPerLevel: number,
  lightDir: THREE.Vector3,
): PuffSpec[] {
  const rand = mulberry32(seed >>> 0);
  const puffs: PuffSpec[] = [];
  const heightSpan = Math.max(topAlt - baseAlt, 0.001);
  // Fixed vertical step between levels, independent of radiusProfile — where
  // the profile pinches in (near the base and top), puffs shrink with it, and
  // a shrunk puff no longer reaches far enough to overlap its neighbouring
  // level, opening a visible gap band. This was reading as a tiered "wedding
  // cake" instead of one continuous tower. minPuffScale (below) and a bigger
  // vertical jitter fix it directly rather than fighting the profile shape.
  const levelSpacing = levels > 1 ? heightSpan / (levels - 1) : heightSpan;

  for (let l = 0; l < levels; l++) {
    const t = levels === 1 ? 0.35 : l / (levels - 1);
    const levelAlt = baseAlt + t * heightSpan;
    const radius = radiusProfile(t);

    const count = puffsPerLevel + Math.floor(rand() * 2);
    const centers: { x: number; z: number }[] = [];
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.pow(rand(), 0.6) * radius;
      centers.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    centers[0].x *= 0.2;
    centers[0].z *= 0.2;
    centers.sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z));

    centers.forEach((c, i) => {
      const dist = Math.sqrt(c.x * c.x + c.z * c.z) / Math.max(radius, 1e-4);
      const rankSize = Math.pow(0.78, i);
      const bulk = 1 - dist * 0.55;
      // Wide size variety ("サイズもバラバラに") instead of the previous
      // narrow 0.8-2.2 band: mostly small/medium grains with occasional
      // larger ones. Capped at 2.0 (was an unbounded pow(rand,2.2)*3.2 tail
      // that could spike a single puff to ~3.6x — one puff that large
      // swallows an entire level's worth of neighbours into one smooth
      // sphere, which is the opposite of "小さく複雑な塊".
      const grain = 0.45 + Math.pow(rand(), 2.2) * 1.55;
      // 0.62→0.82: the reference has essentially no sky visible between
      // lobes within the body of the cloud — puffs need to overlap generously,
      // not just touch, or gaps show through as translucent halo instead of
      // solid mass.
      const puffScaleRaw = radius * 0.82 * rankSize * bulk * grain * (0.6 + rand() * 0.7);
      // Hard cap relative to the level radius: no single puff should be able
      // to outgrow the band it's scattered in, whatever grain rolled.
      // Cap tightened 0.95 -> 0.5 of the level radius. Comparing crops of the
      // render and the reference side by side showed the detail gap is
      // geometric, not textural: the reference's cloud is built from many
      // small lobes whose lit rims read as hard edges against the lobes
      // behind, while the render was a handful of large lobes with soft
      // gradients between them. No amount of shading noise produces edges —
      // only more, smaller silhouettes do.
      const puffScale = Math.min(puffScaleRaw, radius * 0.3);
      // Guarantee vertical reach across at least ~70% of a level step, and
      // scatter within a wider vertical band (was radius*0.18, tiny compared
      // to levelSpacing once profile-shrunk) — puffs from adjacent levels now
      // interleave instead of sitting in strict horizontal bands.
      const scale = Math.max(puffScale, radius * 0.08, levelSpacing * 0.36);
      const yJitter = (rand() - 0.5) * levelSpacing * 1.1;
      const position = new THREE.Vector3(centerXZ.x + c.x, levelAlt + yJitter, centerXZ.y + c.z);
      const stretch = randomStretch(rand);
      puffs.push({ position, scale, stretch, rotationY: rand() * Math.PI * 2, levelFrac: t, burial: 0 });

      // A tier of small satellite puffs riding on each main puff — "小さく
      //複雑な塊" (reference-image analysis: the silhouette is a hierarchy of
      // round scallops at 2-3 size scales, large lobes rimmed with medium
      // ones), not texture or a single size of ball. At least one guaranteed
      // (was 0-2, i.e. often none at all — undercounted against a reference
      // that has zero "plain, unscalloped" puffs).
      const satelliteCount = 2 + Math.floor(rand() * 4.2);
      for (let s = 0; s < satelliteCount; s++) {
        const sa = rand() * Math.PI * 2;
        const sr = puffs[puffs.length - 1].scale * (0.35 + rand() * 0.4);
        const satPos = position.clone().add(
          new THREE.Vector3(Math.cos(sa) * sr, (rand() - 0.5) * sr * 0.6, Math.sin(sa) * sr),
        );
        puffs.push({
          position: satPos,
          scale: puffs[puffs.length - 1].scale * (0.3 + rand() * 0.42),
          stretch: randomStretch(rand),
          rotationY: rand() * Math.PI * 2,
          levelFrac: t,
          burial: 0,
        });
      }
    });
  }

  // Self-shadowing, baked per-instance rather than computed from real-time
  // per-pixel neighbour lookups (this is mesh instancing, not a raymarched
  // field — no shading-time access to "what's nearby"). For each puff, sum
  // how much its neighbours' spheres overlap into its own, *weighted by
  // whether that neighbour sits up-light of it*.
  //
  // The directional weighting is the point. An undirected overlap sum only
  // says "this puff is in a dense part of the cloud", which darkens crevices
  // symmetrically and reads as dirt. What the reference actually shows is
  // lobes casting onto the lobes behind and below them: the shadow edges
  // inside the silhouette are scalloped, tracing the outline of whatever is
  // in front of them toward the sun. Weighting each neighbour's contribution
  // by how far it lies along the light direction reproduces that
  // lobe-casts-onto-lobe structure at build time. O(n^2) over a few hundred
  // puffs, once.
  const L = lightDir.clone().normalize();
  const toOther = new THREE.Vector3();
  for (const puff of puffs) {
    let lit = 0;
    let total = 0;
    for (const other of puffs) {
      if (other === puff) continue;
      const d = puff.position.distanceTo(other.position);
      const combined = puff.scale + other.scale;
      if (d >= combined || d < 1e-6) continue;
      toOther.copy(other.position).sub(puff.position).divideScalar(d);
      const overlap = (combined - d) / puff.scale;
      total += overlap;
      // 1 when the neighbour is directly up-light (it shadows us), 0 when
      // directly down-light (we shadow it).
      lit += overlap * Math.max(0, toOther.dot(L));
    }
    // Two separately-bounded signals, because the raw overlap *sum* is not a
    // usable quantity: in a cluster packed as densely as the reference
    // demands, each puff overlaps 10-20 neighbours and the sum lands around
    // 5-20, so any fixed scale factor saturates essentially every puff at
    // maximum shadow. (It did — the first render of this system came out
    // almost uniformly deep blue.) Both terms below are scale-free by
    // construction and cannot saturate with cluster density.
    //
    //  shadowed: what fraction of the surrounding mass lies up-light. This is
    //            the directional term, and it is what produces lobes casting
    //            onto the lobes behind them rather than symmetric grime.
    //  packed:   how enclosed the puff is at all, a mild ambient-occlusion
    //            term, saturating gently.
    const shadowed = total > 1e-6 ? lit / total : 0;
    const packed = 1 - Math.exp(-total * 0.09);
    puff.burial = THREE.MathUtils.clamp(shadowed * 0.72 + packed * 0.28, 0, 1);
  }

  return puffs;
}

const coreGeometryCache = new Map<number, THREE.BufferGeometry>();
function coreGeometryFor(variant: number): THREE.BufferGeometry {
  let g = coreGeometryCache.get(variant);
  if (!g) {
    g = buildNoduleGeometry(variant * 97.3 + 11, 1);
    coreGeometryCache.set(variant, g);
  }
  return g;
}

let sharedHaloGeometry: THREE.BufferGeometry | null = null;
function haloGeometryFor(): THREE.BufferGeometry {
  if (!sharedHaloGeometry) sharedHaloGeometry = buildHaloGeometry(7.0, 1);
  return sharedHaloGeometry;
}

const HALO_SCALE = 1.15;

export function createCloudCluster(
  seed: number,
  centerXZ: THREE.Vector2,
  baseAlt: number,
  topAlt: number,
  levels: number,
  radiusProfile: (t: number) => number,
  puffsPerLevel: number,
  materials: CloudMaterials,
  lightDir: THREE.Vector3,
): CloudClusterHandle {
  const specs = buildPuffCluster(seed, centerXZ, baseAlt, topAlt, levels, radiusProfile, puffsPerLevel, lightDir);
  const nodules: Nodule[] = specs.map((s) => ({
    base: s.position,
    scale: s.scale,
    stretch: s.stretch,
    rotationY: s.rotationY,
    levelFrac: s.levelFrac,
    burial: s.burial,
  }));

  const group = new THREE.Group();
  // Cloned per cluster because the per-instance attributes below live on the
  // geometry: the displaced base mesh is cached and shared (it is the
  // expensive part), but each cluster needs its own attribute buffers or
  // clusters would overwrite each other's occlusion values.
  const coreGeom = coreGeometryFor(Math.floor(seed) % 5).clone();
  const haloGeom = haloGeometryFor();

  const coreMesh = new THREE.InstancedMesh(coreGeom, materials.core, nodules.length);
  const haloMesh = new THREE.InstancedMesh(haloGeom, materials.halo, nodules.length);
  haloMesh.renderOrder = 1;
  group.add(coreMesh, haloMesh);

  // Per-instance inputs to the shading term (see cloudShader.ts): how deeply
  // this puff sits in another puff's shadow, and a stable random offset so
  // neighbouring puffs don't sample identical noise and reveal that they are
  // all the same five base meshes.
  const occlusions = new Float32Array(nodules.length);
  const seeds = new Float32Array(nodules.length);
  for (let i = 0; i < nodules.length; i++) {
    occlusions[i] = nodules[i].burial;
    seeds[i] = (nodules[i].base.x * 12.9898 + nodules[i].base.z * 78.233 + nodules[i].base.y * 37.719) % 17.0;
  }
  coreGeom.setAttribute('aOcclusion', new THREE.InstancedBufferAttribute(occlusions, 1));
  coreGeom.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function update(_elapsed: number, growth: number, windOffset: THREE.Vector2): void {
    for (let i = 0; i < nodules.length; i++) {
      const n = nodules[i];
      // Growth fades a level in (and slightly up) rather than popping —
      // levels above the current growth fraction shrink toward zero.
      const growthVisibility = THREE.MathUtils.smoothstep(growth, n.levelFrac - 0.12, n.levelFrac + 0.02);
      p.set(n.base.x + windOffset.x, n.base.y, n.base.z + windOffset.y);
      q.setFromAxisAngle(up, n.rotationY);

      const coreScale = n.scale * Math.max(growthVisibility, 0.0001);
      s.set(coreScale * n.stretch.x, coreScale * n.stretch.y, coreScale * n.stretch.z);
      m.compose(p, q, s);
      coreMesh.setMatrixAt(i, m);

      const haloScale = coreScale * HALO_SCALE;
      s.set(haloScale * n.stretch.x, haloScale * n.stretch.y, haloScale * n.stretch.z);
      m.compose(p, q, s);
      haloMesh.setMatrixAt(i, m);
    }
    coreMesh.instanceMatrix.needsUpdate = true;
    haloMesh.instanceMatrix.needsUpdate = true;
  }

  update(0, 1, new THREE.Vector2(0, 0));

  return { group, update };
}

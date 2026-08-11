import * as THREE from 'three';
import { mulberry32 } from '../core/buildNoise';
import { buildNoduleGeometry } from './cloudNodule';
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
    // Hierarchical clumping, not a uniform disc scatter. A uniform scatter
    // spreads puffs evenly, and evenly-spread same-ish spheres read as
    // broccoli — a regular bobbly crust with sky showing between the bobbles.
    // Real cumulus (and the reference) is lumpy at two scales: a handful of
    // big structural masses per level, each carrying its own crowd of smaller
    // lobes. Scattering around a few clump centres instead reproduces that,
    // and the irregular gaps between clumps are what stop the outline reading
    // as a circle of beads.
    const clumpCount = 2 + Math.floor(rand() * 3);
    const clumps: { x: number; z: number; spread: number; weight: number }[] = [];
    for (let k = 0; k < clumpCount; k++) {
      const ca = rand() * Math.PI * 2;
      // Reach out to nearly the full band radius (was 0.75). Clump centres
      // clustered near the axis left the outer part of every band thinly
      // populated, so the mass came out narrower than its own radius profile
      // and the tower read as a column whatever that profile said.
      const cr = Math.pow(rand(), 0.5) * radius * 0.95;
      clumps.push({
        x: Math.cos(ca) * cr,
        z: Math.sin(ca) * cr,
        spread: radius * (0.22 + rand() * 0.3),
        // Uneven weights so one clump dominates the level rather than all
        // clumps coming out the same size — the "big lobe with satellites"
        // hierarchy rather than several equal blobs.
        weight: 0.35 + rand() * 1.3,
      });
    }
    const totalWeight = clumps.reduce((acc, c) => acc + c.weight, 0);

    const centers: { x: number; z: number; clumpWeight: number }[] = [];
    for (let i = 0; i < count; i++) {
      // Pick a clump proportionally to its weight, then scatter tightly
      // around it.
      let pick = rand() * totalWeight;
      let clump = clumps[clumps.length - 1];
      for (const c of clumps) {
        pick -= c.weight;
        if (pick <= 0) { clump = c; break; }
      }
      const a = rand() * Math.PI * 2;
      const r = Math.pow(rand(), 0.5) * clump.spread;
      centers.push({ x: clump.x + Math.cos(a) * r, z: clump.z + Math.sin(a) * r, clumpWeight: clump.weight });
    }
    centers[0].x *= 0.25;
    centers[0].z *= 0.25;
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
      const grain = (0.45 + Math.pow(rand(), 2.2) * 1.55) * (0.6 + c.clumpWeight * 0.5);
      // 0.62→0.82: the reference has essentially no sky visible between
      // lobes within the body of the cloud — puffs need to overlap generously,
      // not just touch, or gaps show through as translucent halo instead of
      // solid mass.
      const puffScaleRaw = radius * 0.98 * rankSize * bulk * grain * (0.6 + rand() * 0.7);
      // Hard cap relative to the level radius: no single puff should be able
      // to outgrow the band it's scattered in, whatever grain rolled.
      // Cap tightened 0.95 -> 0.5 of the level radius. Comparing crops of the
      // render and the reference side by side showed the detail gap is
      // geometric, not textural: the reference's cloud is built from many
      // small lobes whose lit rims read as hard edges against the lobes
      // behind, while the render was a handful of large lobes with soft
      // gradients between them. No amount of shading noise produces edges —
      // only more, smaller silhouettes do.
      // 0.31 -> 0.25 of the level radius. Same measurement as the nodule
      // displacement above: the silhouette's bumps come out at 41px mean
      // radius against the reference's 35px, and a bump on the outline *is* a
      // puff seen edge-on, so the only way to shrink one is to shrink the
      // other.
      const puffScale = Math.min(puffScaleRaw, radius * 0.25);
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
      // Fewer, and held close. Blurring both images at sigma 80 showed the
      // reference carries five times more contrast at that scale than this
      // render did, and a large part of that gap is compositional rather than
      // tonal: the reference's cloud masses and its areas of sky are each
      // large and unbroken, while this cloud was fringed with a spray of
      // detached specks that punched sky through the mass and cloud through
      // the sky, so both averaged out to the same mid value at large scale.
      const satelliteCount = 1 + Math.floor(rand() * 2.6);
      for (let s = 0; s < satelliteCount; s++) {
        const sa = rand() * Math.PI * 2;
        const sr = puffs[puffs.length - 1].scale * (0.2 + rand() * 0.3);
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
  // field — no shading-time access to "what's nearby").
  //
  // The main term is a genuine optical depth toward the light: from each
  // puff's centre, shoot a ray along the light direction and accumulate the
  // chord it cuts through every other puff's sphere, then convert to a
  // transmittance by Beer-Lambert. This replaces an earlier heuristic that
  // only scored *local* neighbour overlap, which could not produce what the
  // measurement said was missing — the reference's deepest shadows reach
  // luminance 148 and a blue/red separation of 149, where the heuristic
  // version bottomed out at 173/100. Local overlap is bounded by how many
  // neighbours touch one puff, so it cannot distinguish "on the shaded side
  // of the cloud" from "buried one lobe deep"; only integrating along the
  // light ray gives the large contiguous dark regions that produce the deep
  // end of the reference's tonal range.
  const L = lightDir.clone().normalize();
  const oc = new THREE.Vector3();
  for (const puff of puffs) {
    let tau = 0;
    let localOverlap = 0;
    for (const other of puffs) {
      if (other === puff) continue;
      oc.copy(other.position).sub(puff.position);
      const along = oc.dot(L);
      const distSq = oc.lengthSq();

      if (along > 0) {
        // Ray-sphere: perpendicular miss distance from the light ray to this
        // occluder's centre.
        const perpSq = distSq - along * along;
        const rSq = other.scale * other.scale;
        if (perpSq < rSq) {
          // Chord length normalised by the occluder's own radius, so a big
          // and a small puff contribute in proportion to how much of the ray
          // they actually fill rather than to their absolute size. The
          // exponential falloff with distance softens shadows cast from far
          // up-light, standing in for the penumbra of an extended source.
          const chord = 2 * Math.sqrt(rSq - perpSq);
          tau += (chord / other.scale) * Math.exp(-along * 0.12);
        }
      }

      // Secondary, undirected term: plain crevice ambient occlusion, kept
      // because a puff wedged among neighbours is darker even on its lit side.
      const d = Math.sqrt(distSq);
      const combined = puff.scale + other.scale;
      if (d < combined && d > 1e-6) localOverlap += (combined - d) / puff.scale;
    }

    const cast = 1 - Math.exp(-tau * 0.105);
    const packed = 1 - Math.exp(-localOverlap * 0.09);
    puff.burial = THREE.MathUtils.clamp(cast * 0.74 + packed * 0.26, 0, 1);
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

  const coreMesh = new THREE.InstancedMesh(coreGeom, materials.core, nodules.length);
  group.add(coreMesh);

  // Per-instance inputs to the shading term (see cloudShader.ts): how deeply
  // this puff sits in another puff's shadow, and a stable random offset so
  // neighbouring puffs don't sample identical noise and reveal that they are
  // all the same five base meshes.
  const occlusions = new Float32Array(nodules.length);
  const seeds = new Float32Array(nodules.length);
  const tints = new Float32Array(nodules.length);
  // Position relative to the cluster centre, fixed at build time. This is the
  // coordinate the cloud-scale shading field is evaluated in: using the live
  // world position instead would leave the macro pattern standing still in
  // space while the cloud drifts through it on the wind.
  const clusterPos = new Float32Array(nodules.length * 3);
  for (let i = 0; i < nodules.length; i++) {
    occlusions[i] = nodules[i].burial;
    const h = (nodules[i].base.x * 12.9898 + nodules[i].base.z * 78.233 + nodules[i].base.y * 37.719) % 17.0;
    seeds[i] = h;
    // A per-lobe tonal offset. Every lobe is one of the same handful of base
    // meshes lit by the same light, so each small one ends up with an
    // identically bright cap and a crowd of them reads as popcorn — a texture
    // of repeated identical highlights rather than a cloud. Nudging each
    // lobe's whole shading term up or down a little breaks the repetition
    // without disturbing the measured tonal distribution, since the offsets
    // are symmetric about zero.
    tints[i] = ((((h * 7.13) % 1.0) + 1.0) % 1.0) - 0.5;
    clusterPos[i * 3 + 0] = nodules[i].base.x - centerXZ.x;
    clusterPos[i * 3 + 1] = nodules[i].base.y - (baseAlt + topAlt) * 0.5;
    clusterPos[i * 3 + 2] = nodules[i].base.z - centerXZ.y;
  }
  coreGeom.setAttribute('aOcclusion', new THREE.InstancedBufferAttribute(occlusions, 1));
  coreGeom.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  coreGeom.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 1));
  coreGeom.setAttribute('aClusterPos', new THREE.InstancedBufferAttribute(clusterPos, 3));

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
    }
    coreMesh.instanceMatrix.needsUpdate = true;
  }

  update(0, 1, new THREE.Vector2(0, 0));

  return { group, update };
}

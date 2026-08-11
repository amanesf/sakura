import * as THREE from 'three';
import { mulberry32 } from '../core/buildNoise';
import { buildNoduleGeometry, buildFlatWhiteGeometry } from './cloudNodule';

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
  rotationY: number;
  levelFrac: number; // 0 (base) .. 1 (top) — used to fade in with growth
}

interface Nodule {
  base: THREE.Vector3;
  scale: number;
  rotationY: number;
  levelFrac: number;
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
function buildPuffCluster(
  seed: number,
  centerXZ: THREE.Vector2,
  baseAlt: number,
  topAlt: number,
  levels: number,
  radiusProfile: (t: number) => number,
  puffsPerLevel: number,
): PuffSpec[] {
  const rand = mulberry32(seed >>> 0);
  const puffs: PuffSpec[] = [];
  const heightSpan = Math.max(topAlt - baseAlt, 0.001);

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
      const grain = 0.8 + rand() * rand() * 1.4;
      const puffScale = radius * 0.62 * rankSize * bulk * grain * (0.7 + rand() * 0.5);
      puffs.push({
        position: new THREE.Vector3(centerXZ.x + c.x, levelAlt + (rand() - 0.5) * radius * 0.18, centerXZ.y + c.z),
        scale: Math.max(puffScale, radius * 0.08),
        rotationY: rand() * Math.PI * 2,
        levelFrac: t,
      });
    });
  }

  return puffs;
}

const coreGeometryCache = new Map<number, THREE.BufferGeometry>();
function coreGeometryFor(variant: number): THREE.BufferGeometry {
  let g = coreGeometryCache.get(variant);
  if (!g) {
    g = buildNoduleGeometry(variant * 97.3 + 11, 1, 0.64);
    coreGeometryCache.set(variant, g);
  }
  return g;
}

let sharedHaloGeometry: THREE.BufferGeometry | null = null;
function haloGeometryFor(): THREE.BufferGeometry {
  if (!sharedHaloGeometry) sharedHaloGeometry = buildFlatWhiteGeometry(coreGeometryFor(0));
  return sharedHaloGeometry;
}

export interface CloudMaterials {
  core: THREE.MeshStandardMaterial;
  halo: THREE.MeshStandardMaterial;
}

export function createCloudMaterials(sunDirection: THREE.Vector3): CloudMaterials {
  const core = new THREE.MeshStandardMaterial({
    color: '#f2f0ee',
    vertexColors: true,
    roughness: 0.96,
    emissive: '#ffffff',
    emissiveIntensity: 0.06,
  });

  // Fresnel rim (headroom-gated so it can't blow out an already-bright sunlit
  // crown) + a warm underside bounce restricted to this nodule's own local
  // dusk/dawn — the two terms planet-canvas2 added "on request (新海誠的な)"
  // on top of the baked gradient + standard PBR lighting.
  core.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = { value: sunDirection };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float underside = 1.0 - clamp(dot(diffuseColor.rgb, vec3(0.333)), 0.0, 1.0);
          float cloudRim = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.0);
          totalEmissiveRadiance += vec3(1.0, 0.97, 0.9) * cloudRim * 0.22 * underside;

          float duskBand = smoothstep(0.35, -0.05, uSunDir.y);
          totalEmissiveRadiance += vec3(1.0, 0.55, 0.22) * duskBand * underside * 0.3;
        }`,
      );
  };

  const halo = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    vertexColors: true,
    emissive: '#ffffff',
    emissiveIntensity: 0.12,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
  });

  return { core, halo };
}

const HALO_SCALE = 1.3;

export function createCloudCluster(
  seed: number,
  centerXZ: THREE.Vector2,
  baseAlt: number,
  topAlt: number,
  levels: number,
  radiusProfile: (t: number) => number,
  puffsPerLevel: number,
  materials: CloudMaterials,
): CloudClusterHandle {
  const specs = buildPuffCluster(seed, centerXZ, baseAlt, topAlt, levels, radiusProfile, puffsPerLevel);
  const nodules: Nodule[] = specs.map((s) => ({
    base: s.position,
    scale: s.scale,
    rotationY: s.rotationY,
    levelFrac: s.levelFrac,
  }));

  const group = new THREE.Group();
  const coreGeom = coreGeometryFor(Math.floor(seed) % 5);
  const haloGeom = haloGeometryFor();

  const coreMesh = new THREE.InstancedMesh(coreGeom, materials.core, nodules.length);
  const haloMesh = new THREE.InstancedMesh(haloGeom, materials.halo, nodules.length);
  haloMesh.renderOrder = 1;
  group.add(coreMesh, haloMesh);

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
      s.set(coreScale, coreScale, coreScale);
      m.compose(p, q, s);
      coreMesh.setMatrixAt(i, m);

      const haloScale = coreScale * HALO_SCALE;
      s.set(haloScale, haloScale, haloScale);
      m.compose(p, q, s);
      haloMesh.setMatrixAt(i, m);
    }
    coreMesh.instanceMatrix.needsUpdate = true;
    haloMesh.instanceMatrix.needsUpdate = true;
  }

  update(0, 1, new THREE.Vector2(0, 0));

  return { group, update };
}

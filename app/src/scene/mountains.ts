import * as THREE from 'three';
import { mulberry32, rngRange, type Rng } from '../core/prng';

export interface MountainLayer {
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
}

export interface MountainsHandle {
  group: THREE.Group;
  layers: MountainLayer[];
}

/**
 * Builds one ridge silhouette as a flat skyline strip: a smooth-noise top edge and a
 * flat bottom edge well below the horizon, so it always reads as a solid mountain mass
 * regardless of camera framing.
 */
function buildRidgeGeometry(
  rng: Rng,
  width: number,
  segments: number,
  baseHeight: number,
  jitter: number,
  bottomY: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const heights: number[] = [];

  // Smooth ridge line via a few summed sine waves with random phase/frequency,
  // cheaper than real noise and plenty convincing at this silhouette scale.
  const waveCount = 4;
  const waves = Array.from({ length: waveCount }, () => ({
    freq: rngRange(rng, 0.6, 3.2),
    phase: rngRange(rng, 0, Math.PI * 2),
    amp: rngRange(rng, 0.25, 1) / waveCount,
  }));

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const x = -width / 2 + width * u;
    let n = 0;
    for (const w of waves) {
      n += Math.sin(u * Math.PI * w.freq + w.phase) * w.amp;
    }
    const topY = baseHeight + n * jitter;
    heights.push(topY);
    positions.push(x, topY, 0, x, bottomY, 0);
    uvs.push(u, 1, u, 0);
  }

  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = a + 2;
    const d = b + 2;
    indices.push(a, b, c, b, d, c);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Two layered ridgelines behind the lake (season-transition-animation.md §6: rear-most
 * "遠景" layer). Kept flat-colored and fog-blended rather than lit realistically —
 * at this distance atmospheric perspective reads more convincingly than shading detail.
 */
export function createMountains(seed = 20260809): MountainsHandle {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  const layers: MountainLayer[] = [];

  const configs = [
    // Near layer's base sits close to the far layer's so it occludes most of the
    // far ridge's flat body, leaving only its jagged peaks poking above — otherwise
    // the exposed far "wall" reads as a flat pale band instead of a mountain shape.
    { z: -30, width: 140, base: 15, jitter: 4.5, color: '#7f9a8e', bottomY: -4 },
    { z: -48, width: 200, base: 17.5, jitter: 6, color: '#a3b9c0', bottomY: -4 },
  ];

  for (const cfg of configs) {
    const geometry = buildRidgeGeometry(rng, cfg.width, 48, cfg.base, cfg.jitter, cfg.bottomY);
    const material = new THREE.MeshLambertMaterial({
      color: cfg.color,
      fog: true,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = cfg.z;
    group.add(mesh);
    layers.push({ mesh, material });
  }

  return { group, layers };
}

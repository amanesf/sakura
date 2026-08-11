import * as THREE from 'three';
import { fbm3 } from '../core/buildNoise';

/**
 * One "puff" of cloud: a noise-displaced low-poly sphere with a baked
 * top-bright/underside-dark-and-cool vertex-color gradient — the technique
 * proven out in amanesf/planet-canvas2's src/clouds.ts (see that file's own
 * commentary, including an explicit "新海誠的な" note on the rim-light/
 * underside-bounce additions layered on top in scene/clouds.ts here).
 *
 * The gradient is baked, not computed per-frame: lighting every nodule as an
 * isolated ball (pure PBR against a directional light) makes a cluster of them
 * read as "a heap of separately-lit spheres with nothing darker where they
 * meet" — flat, however lumpy the outline is. A fixed vertical gradient does
 * the job a real shadow map can't at this scale, for free.
 */
export function buildNoduleGeometry(seed: number, flatten: number, undersideFloor: number): THREE.BufferGeometry {
  // Higher-poly than planet-canvas2's 12x5: that project viewed nodules from
  // orbital distance where a coarse silhouette was invisible; our camera sits
  // much closer (plan.md's fixed "bench" framing), so the same low-poly count
  // read as faceted rock rather than soft cauliflower. Two displacement
  // octaves — a coarse one for a few big lobes, a fine one riding on top for
  // the actual cauliflower bumpiness — instead of one octave at a single
  // frequency, which is what was producing a uniformly "rocky" surface.
  const geometry = new THREE.SphereGeometry(1, 32, 18);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const len = v.length();
    if (len < 1e-6) continue;
    // A high-amplitude *low*-frequency octave is what reads as faceted rock —
    // at low frequency there just aren't enough vertices per bump for the
    // smoothing to hide the facets, no matter how high-poly the base sphere
    // is. Softened (lower amplitude, one more octave so the remaining bumps
    // are smaller/rounder) and leaned on the higher-resolution base mesh
    // instead to carry the silhouette detail.
    const coarse = fbm3(v.x * 1.7, v.y * 1.7, v.z * 1.7, seed, 3);
    const fine = fbm3(v.x * 4.6, v.y * 4.6, v.z * 4.6, seed + 91.0, 3);
    v.multiplyScalar(1 + coarse * 0.26 + fine * 0.11);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.scale(1, 0.72 * flatten, 1);
  geometry.computeVertexNormals();

  const colors = new Float32Array(position.count * 3);
  const span = 1 - undersideFloor;
  const halfHeight = 0.72 * flatten;
  for (let i = 0; i < position.count; i++) {
    const t = THREE.MathUtils.clamp(position.getY(i) / halfHeight, -1, 1);
    const shade = undersideFloor + (t * 0.5 + 0.5) * span;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = Math.min(1, shade * 1.04); // shaded underside goes cool, not just dark
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * The halo used to be the *same* jagged silhouette as the core, just scaled
 * up — which doesn't read as a soft translucent fringe, it reads as a second,
 * slightly-offset copy of the same faceted outline (a visible double edge).
 * A soft fringe needs its own much-smoother, low-displacement shape so its
 * boundary blurs rather than echoes the core's.
 */
export function buildHaloGeometry(seed: number, flatten: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 16, 10);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const len = v.length();
    if (len < 1e-6) continue;
    const n = fbm3(v.x * 1.2, v.y * 1.2, v.z * 1.2, seed + 331.0, 2);
    v.multiplyScalar(1 + n * 0.12);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.scale(1, 0.72 * flatten, 1);
  geometry.computeVertexNormals();
  const colors = new Float32Array(position.count * 3).fill(0.97);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

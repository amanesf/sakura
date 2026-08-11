import * as THREE from 'three';
import { fbm3 } from '../core/buildNoise';

/**
 * One "puff" of cloud: a noise-displaced sphere carrying a normalised local
 * height attribute. The technique is from amanesf/planet-canvas2's
 * src/clouds.ts (a prior project explicitly tuned for "新海誠的な" quality),
 * but the *shading* has since diverged from it: that project baked a
 * top-bright/underside-dark vertex-colour gradient and multiplied it by
 * standard PBR lighting, and measuring the result against the reference image
 * showed why that can't reach the target — see cloudRamp.ts. Multiplying an
 * albedo by a neutral N.L term slides toward grey, whereas the reference's
 * shadows get *bluer* as they get darker.
 *
 * So the gradient is no longer baked as colour. It is baked as a scalar
 * (aHeight, -1 at the underside to +1 at the crown) and becomes one input to
 * the shading term that indexes the measured colour ramp in clouds.ts. The
 * reason for baking it at all is unchanged: lighting every nodule as an
 * isolated ball makes a cluster read as "a heap of separately-lit spheres
 * with nothing darker where they meet", however lumpy the outline is.
 */
export function buildNoduleGeometry(seed: number, flatten: number): THREE.BufferGeometry {
  // Higher-poly than planet-canvas2's 12x5: that project viewed nodules from
  // orbital distance where a coarse silhouette was invisible; our camera sits
  // much closer (plan.md's fixed "bench" framing), so the same low-poly count
  // read as faceted rock rather than soft cauliflower. Three displacement
  // octaves — a coarse one for a few big lobes, and two finer ones riding on
  // top for the actual cauliflower bumpiness.
  const geometry = new THREE.SphereGeometry(1, 32, 18);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    if (v.length() < 1e-6) continue;
    // A high-amplitude *low*-frequency octave is what reads as faceted rock —
    // at low frequency there just aren't enough vertices per bump for the
    // smoothing to hide the facets, no matter how high-poly the base sphere
    // is. Kept low-amplitude and leaned on the extra octaves instead.
    const coarse = fbm3(v.x * 1.7, v.y * 1.7, v.z * 1.7, seed, 3);
    const fine = fbm3(v.x * 4.6, v.y * 4.6, v.z * 4.6, seed + 91.0, 3);
    const micro = fbm3(v.x * 9.1, v.y * 9.1, v.z * 9.1, seed + 613.0, 2);
    v.multiplyScalar(1 + coarse * 0.26 + fine * 0.11 + micro * 0.045);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.scale(1, 0.88 * flatten, 1);
  geometry.computeVertexNormals();

  const halfHeight = 0.88 * flatten;
  const heights = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    heights[i] = THREE.MathUtils.clamp(position.getY(i) / halfHeight, -1, 1);
  }
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
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
    if (v.length() < 1e-6) continue;
    const n = fbm3(v.x * 1.2, v.y * 1.2, v.z * 1.2, seed + 331.0, 2);
    v.multiplyScalar(1 + n * 0.12);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.scale(1, 0.88 * flatten, 1);
  geometry.computeVertexNormals();
  return geometry;
}

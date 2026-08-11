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
  const geometry = new THREE.SphereGeometry(1, 40, 22);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    if (v.length() < 1e-6) continue;
    // Signed, high-amplitude coarse displacement. The previous amplitudes
    // (0.26/0.11/0.045 on an unsigned FBM) left every nodule a very slightly
    // dented sphere, and a heap of slightly dented spheres reads as exactly
    // that — cauliflower balls. What breaks the read is *concavity*: the coarse
    // octave is now centred on zero and strong enough to pull parts of the
    // surface well inside the unit radius, so a nodule's own outline develops
    // dents and cusps rather than staying convex everywhere.
    const coarse = fbm3(v.x * 1.15, v.y * 1.15, v.z * 1.15, seed, 3) - 0.5;
    const mid = fbm3(v.x * 2.6, v.y * 2.6, v.z * 2.6, seed + 91.0, 3) - 0.5;
    const fine = fbm3(v.x * 5.3, v.y * 5.3, v.z * 5.3, seed + 613.0, 3) - 0.5;
    const micro = fbm3(v.x * 11.0, v.y * 11.0, v.z * 11.0, seed + 1277.0, 2) - 0.5;
    // Ridged on the mid octave: abs() folds the noise so its zero crossings
    // become creases instead of smooth passes, which is what puts the sharp
    // cusps between bumps that a plain FBM cannot produce.
    const ridge = 0.5 - Math.abs(mid) * 2.0;
    const r = 1 + coarse * 0.3 + ridge * 0.09 + fine * 0.12 + micro * 0.05;
    v.multiplyScalar(Math.max(r, 0.55));
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

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
  const geometry = new THREE.SphereGeometry(1, 12, 5);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const len = v.length();
    if (len < 1e-6) continue;
    const n = fbm3(v.x * 2.6, v.y * 2.6, v.z * 2.6, seed, 3);
    v.multiplyScalar(1 + n * 0.5);
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

export function buildFlatWhiteGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone();
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3).fill(0.97);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

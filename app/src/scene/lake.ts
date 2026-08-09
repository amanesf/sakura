import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

export interface LakeHandle {
  mesh: Reflector;
}

/**
 * The lake is a real planar reflector (three/examples Reflector), not a faked
 * envmap — season-transition-animation.md §4.4/§10 call for the water mirroring the
 * sky, the tree, and (at night, unused here) the moon, and a flat reflective surface
 * is the cheapest way to get that convincingly on a single fixed shot.
 */
export function createLake(radius = 40): LakeHandle {
  const geometry = new THREE.CircleGeometry(radius, 64);
  const mesh = new Reflector(geometry, {
    color: new THREE.Color('#9fb9c2'),
    textureWidth: 1024,
    textureHeight: 1024,
    clipBias: 0.003,
  });
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0, 3.5);
  return { mesh };
}

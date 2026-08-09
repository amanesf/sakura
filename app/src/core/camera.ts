import * as THREE from 'three';

/**
 * The camera is a fixed "time machine window" (season-transition-animation.md §1, §6):
 * it never pans, orbits, or zooms. Only the season changes what's in frame.
 * These constants are the single source of truth for the shot — every scene module
 * (tree/lake/mountains placement) is composed around this framing.
 */
export const CAMERA_POSITION = new THREE.Vector3(0, 5.2, 15.5);
export const CAMERA_LOOK_AT = new THREE.Vector3(0, 3.4, -4);

export function createCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 300);
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(CAMERA_LOOK_AT);
  return camera;
}

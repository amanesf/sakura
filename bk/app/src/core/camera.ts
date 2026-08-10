import * as THREE from 'three';

/**
 * The camera is a fixed "time machine window" (season-transition-animation.md §1, §6):
 * it never pans, orbits, or zooms. Only the season changes what's in frame.
 * These constants are the single source of truth for the shot — every scene module
 * (tree/lake/mountains placement) is composed around this framing.
 */
export const CAMERA_POSITION = new THREE.Vector3(0, 5.2, 15.5);
// lookAt.x is panned off-center (rather than 0) and fov narrowed from an earlier 50°
// so the tree lands where art-source/COMPOSITION-REFERENCE.md §2 measured it in the
// reference art: trunk at screen x≈83-92%, treetop at y≈3% — not centered. Values
// solved by projecting the actual tree anchor/treetop through this camera (see that
// doc's §2 for the target percentages); this is a pure yaw pan (camera position
// unchanged) so it reframes the whole scene without introducing parallax between
// the tree and the lake/mountains behind it.
export const CAMERA_LOOK_AT = new THREE.Vector3(-2.01, 3.4, -4);
const CAMERA_FOV_DEG = 31.2;

export function createCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, 0.1, 300);
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(CAMERA_LOOK_AT);
  return camera;
}

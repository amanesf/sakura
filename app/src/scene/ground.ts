import * as THREE from 'three';

export interface GroundHandle {
  nearShore: THREE.Mesh;
  nearShoreMaterial: THREE.MeshStandardMaterial;
  farShore: THREE.Mesh;
  farShoreMaterial: THREE.MeshStandardMaterial;
}

/**
 * Two ground pieces bracket the lake (see scene/lake.ts for the water plane the tree
 * sits at the edge of): the near shore/peninsula the tree roots into, and a thin far
 * shore band before the mountains — the strip §6.1 (season-transition-animation.md)
 * later places the distant girl silhouette on.
 */
export function createGround(): GroundHandle {
  const nearShoreGeometry = new THREE.CircleGeometry(3.6, 40);
  const nearShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#6f8f5a',
    roughness: 1,
  });
  const nearShore = new THREE.Mesh(nearShoreGeometry, nearShoreMaterial);
  nearShore.rotation.x = -Math.PI / 2;
  nearShore.position.set(0, 0.03, -2);
  nearShore.receiveShadow = true;

  const farShoreGeometry = new THREE.PlaneGeometry(60, 6);
  const farShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#5f7d55',
    roughness: 1,
  });
  const farShore = new THREE.Mesh(farShoreGeometry, farShoreMaterial);
  farShore.rotation.x = -Math.PI / 2;
  farShore.position.set(0, 0.02, -19);
  farShore.receiveShadow = true;

  return { nearShore, nearShoreMaterial, farShore, farShoreMaterial };
}

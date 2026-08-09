import * as THREE from 'three';

export interface GroundHandle {
  nearShore: THREE.Mesh;
  nearShoreMaterial: THREE.MeshStandardMaterial;
  farShore: THREE.Mesh;
  farShoreMaterial: THREE.MeshStandardMaterial;
}

/**
 * A soft radial falloff (opaque center, transparent rim) so the near shore blends
 * into the lake instead of reading as a hard-edged coin — generated at runtime via
 * Canvas2D rather than an imported asset (agent-workflow-policy.md §10-A: no
 * external art files).
 */
function createRadialFadeTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.32,
    size / 2,
    size / 2,
    size * 0.5,
  );
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.75, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Two ground pieces bracket the lake (see scene/lake.ts for the water plane the tree
 * sits at the edge of): the near shore/peninsula the tree roots into, and a thin far
 * shore band before the mountains — the strip §6.1 (season-transition-animation.md)
 * later places the distant girl silhouette on.
 */
export function createGround(): GroundHandle {
  const fadeTexture = createRadialFadeTexture();

  const nearShoreGeometry = new THREE.CircleGeometry(4.4, 48);
  const nearShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#6f8f5a',
    roughness: 1,
    alphaMap: fadeTexture,
    transparent: true,
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

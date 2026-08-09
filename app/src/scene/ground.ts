import * as THREE from 'three';
import { mulberry32, rngRange } from '../core/prng';

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
 * A flat single `color` reads as painted plastic once anything textured (the tree,
 * the canopy) sits next to it. This bakes brightness-only mottling — never above
 * white, since MeshStandardMaterial can only darken a flat color through `map`, not
 * lighten past it — as overlapping soft blotches of varying size, so the ground
 * multiplies out to patches of slightly different tone instead of one flat wash.
 * Grayscale on purpose (like tree.ts's old canopy tiers): the season's actual hue
 * still comes entirely from `material.color`, this only breaks up its flatness.
 */
function createMottledTexture(seed: number, size: number, blotchCount: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const rng = mulberry32(seed);
  for (let i = 0; i < blotchCount; i++) {
    const x = rngRange(rng, 0, size);
    const y = rngRange(rng, 0, size);
    const r = rngRange(rng, size * 0.02, size * 0.09);
    const v = Math.round(rngRange(rng, 148, 255));
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
    gradient.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }

  // A few short streak-like darker strokes on top for a hint of grass-blade/soil
  // texture at close range, not just round blotches.
  for (let i = 0; i < blotchCount * 0.25; i++) {
    const x = rngRange(rng, 0, size);
    const y = rngRange(rng, 0, size);
    const len = rngRange(rng, size * 0.015, size * 0.045);
    const angle = rngRange(rng, 0, Math.PI * 2);
    const v = Math.round(rngRange(rng, 150, 210));
    ctx.strokeStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.lineWidth = rngRange(rng, 1, 2.2);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
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
  const nearMottle = createMottledTexture(9001, 512, 260);

  const nearShoreGeometry = new THREE.CircleGeometry(4.4, 48);
  const nearShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#6f8f5a',
    roughness: 1,
    map: nearMottle,
    alphaMap: fadeTexture,
    transparent: true,
  });
  const nearShore = new THREE.Mesh(nearShoreGeometry, nearShoreMaterial);
  nearShore.rotation.x = -Math.PI / 2;
  nearShore.position.set(0, 0.03, -2);

  const farMottle = createMottledTexture(9002, 512, 200);
  farMottle.repeat.set(6, 1);

  const farShoreGeometry = new THREE.PlaneGeometry(60, 6);
  const farShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#5f7d55',
    roughness: 1,
    map: farMottle,
  });
  const farShore = new THREE.Mesh(farShoreGeometry, farShoreMaterial);
  farShore.rotation.x = -Math.PI / 2;
  farShore.position.set(0, 0.02, -19);

  return { nearShore, nearShoreMaterial, farShore, farShoreMaterial };
}

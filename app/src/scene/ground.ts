import * as THREE from 'three';
import type { SeasonId } from '../seasons/seasonState';

export interface GroundHandle {
  nearShore: THREE.Mesh;
  nearShoreMaterial: THREE.MeshStandardMaterial;
  farShore: THREE.Mesh;
  farShoreMaterial: THREE.MeshStandardMaterial;
}

/**
 * A soft radial falloff (opaque center, transparent rim) so the near shore blends
 * into the lake instead of reading as a hard-edged coin. This is a blend mask, not a
 * visual asset in its own right (agent-workflow-policy.md §1.5 bans procedural
 * *imagery* — invented colors/textures standing in for the reference art — not
 * utility gradients like this one), so it's still generated at runtime via Canvas2D.
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

// One Gemini-generated ground texture per season (art-source/ground/, cropped from
// each reference panel's own ground area — see art-source/ground/prompts/) —
// replacing the earlier Canvas2D mottled-blotch approach per
// agent-workflow-policy.md §1.5 (no procedurally-invented ground texture/color).
const GROUND_TEXTURE_FILES: Record<SeasonId, string> = {
  winter: 'winter.jpg',
  spring: 'spring.jpg',
  summer: 'summer.jpg',
  autumn: 'autumn.jpg',
};

// Near and far shore need independently-tiled copies of the same season's texture
// (far shore repeats 6x horizontally, near shore doesn't) — two caches so each gets
// its own THREE.Texture instance rather than fighting over one shared `.repeat`.
const nearTextureCache = new Map<SeasonId, THREE.Texture>();
const farTextureCache = new Map<SeasonId, THREE.Texture>();
const groundTextureLoader = new THREE.TextureLoader();

function loadGroundTexture(season: SeasonId, cache: Map<SeasonId, THREE.Texture>): THREE.Texture {
  const cached = cache.get(season);
  if (cached) return cached;
  const url = `${import.meta.env.BASE_URL}textures/ground/${GROUND_TEXTURE_FILES[season]}`;
  const texture = groundTextureLoader.load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  cache.set(season, texture);
  return texture;
}

/**
 * Two ground pieces bracket the lake (see scene/lake.ts for the water plane the tree
 * sits at the edge of): the near shore/peninsula the tree roots into, and a thin far
 * shore band before the mountains — the strip §6.1 (season-transition-animation.md)
 * later places the distant girl silhouette on. Both start on the winter texture;
 * setGroundSeasonState swaps the `map` on season change (依頼A').
 */
export function createGround(): GroundHandle {
  const fadeTexture = createRadialFadeTexture();
  const initialTexture = loadGroundTexture('winter', nearTextureCache);

  const nearShoreGeometry = new THREE.CircleGeometry(4.4, 48);
  const nearShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    map: initialTexture,
    alphaMap: fadeTexture,
    transparent: true,
  });
  const nearShore = new THREE.Mesh(nearShoreGeometry, nearShoreMaterial);
  nearShore.rotation.x = -Math.PI / 2;
  nearShore.position.set(0, 0.03, -2);

  const farTexture = loadGroundTexture('winter', farTextureCache);
  farTexture.repeat.set(6, 1);

  const farShoreGeometry = new THREE.PlaneGeometry(60, 6);
  const farShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    map: farTexture,
  });
  const farShore = new THREE.Mesh(farShoreGeometry, farShoreMaterial);
  farShore.rotation.x = -Math.PI / 2;
  farShore.position.set(0, 0.02, -19);

  return { nearShore, nearShoreMaterial, farShore, farShoreMaterial };
}

/** Called by the season system (依頼A') whenever the dial settles on a new season —
 *  swaps the ground photo rather than tinting a flat procedural texture. The far
 *  shore's own loaded copy keeps its independent repeat.set(6,1) tiling. */
export function setGroundSeasonState(ground: GroundHandle, seasonId: SeasonId): void {
  ground.nearShoreMaterial.map = loadGroundTexture(seasonId, nearTextureCache);
  ground.nearShoreMaterial.needsUpdate = true;

  const farTexture = loadGroundTexture(seasonId, farTextureCache);
  farTexture.repeat.set(6, 1);
  ground.farShoreMaterial.map = farTexture;
  ground.farShoreMaterial.needsUpdate = true;
}

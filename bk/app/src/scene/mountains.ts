import * as THREE from 'three';
import type { SeasonId } from '../seasons/seasonState';

export interface MountainLayer {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

export interface MountainsHandle {
  group: THREE.Group;
  layers: MountainLayer[];
}

// One Gemini-generated ridge silhouette per season (art-source/mountains/, chroma-key
// extracted from a blue-background generation — see art-source/mountains/prompts/),
// replacing the earlier procedural sine-noise ridge + Canvas2D blotch texture per
// agent-workflow-policy.md §1.5. The source image is a 1376x768 (~16:9) frame with
// the ridge occupying roughly its lower 55-60% and a transparent (chroma-keyed) band
// above — IMAGE_ASPECT/RIDGE_TOP_FRACTION below describe that layout so the plane
// geometry can size and position itself without a hardcoded per-season guess.
const IMAGE_ASPECT = 1376 / 768;

const MOUNTAIN_TEXTURE_FILES: Record<SeasonId, string> = {
  winter: 'winter.png',
  spring: 'spring.png',
  summer: 'summer.png',
  autumn: 'autumn.png',
};

const mountainTextureCache = new Map<SeasonId, THREE.Texture>();
const mountainTextureLoader = new THREE.TextureLoader();

function loadMountainTexture(season: SeasonId): THREE.Texture {
  const cached = mountainTextureCache.get(season);
  if (cached) return cached;
  const url = `${import.meta.env.BASE_URL}textures/mountains/${MOUNTAIN_TEXTURE_FILES[season]}`;
  const texture = mountainTextureLoader.load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  mountainTextureCache.set(season, texture);
  return texture;
}

/**
 * Two ridgeline image-planes behind the lake (season-transition-animation.md §6:
 * rear-most "遠景" layer) — same two-layer parallax the procedural version had (a
 * closer, larger-scale ridge occluding most of a further, larger one, leaving only
 * its peaks poking above), now both textured with the actual generated art instead
 * of a noise ridge. `bottomY` anchors each plane's bottom edge (the image's own flat
 * crop edge) at the same world height the procedural version's flat bottom used.
 */
export function createMountains(): MountainsHandle {
  const group = new THREE.Group();
  const layers: MountainLayer[] = [];

  // width/bottomY solved per layer by ray-casting the actual fixed camera
  // (core/camera.ts) through screen-space targets — full screen width (plus
  // margin) at that depth, ridge band anchored to COMPOSITION-REFERENCE.md §1's
  // measured winter mountain band (y≈40-58%) — rather than reused from the old
  // procedural ridge's config, which was sized for a since-changed, much wider fov.
  // x offsets shift each plane to fully cover the frustum at its depth — the fixed
  // camera (core/camera.ts) is panned off world-x=0, so a plane centered on x=0
  // doesn't sit centered in view; solved the same way as width/bottomY, by
  // projecting each plane's edges through the actual camera and checking coverage.
  const configs = [
    { z: -30, width: 16.8, bottomY: -1.6, x: -3.35 },
    { z: -48, width: 20.4, bottomY: -3.3, x: -4.6 },
  ];

  const initialTexture = loadMountainTexture('winter');

  for (const cfg of configs) {
    const height = cfg.width / IMAGE_ASPECT;
    const geometry = new THREE.PlaneGeometry(cfg.width, height);
    const material = new THREE.MeshBasicMaterial({
      map: initialTexture,
      transparent: true,
      depthWrite: false,
      // The generated art already bakes in its own atmospheric haze (see the
      // prompts in art-source/mountains/prompts/) — scene fog on top of that
      // doubled up and washed the ridge out to near-nothing at this distance.
      fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cfg.x, cfg.bottomY + height / 2, cfg.z);
    group.add(mesh);
    layers.push({ mesh, material });
  }

  return { group, layers };
}

/** Called by the season system (依頼A') on season change — swaps each layer's ridge
 *  photo. Both layers currently share the same single generated image per season
 *  (COMPOSITION-REFERENCE.md only measured one combined near/far mountain color; see
 *  seasonState.ts's mountainNear/mountainFar comments) — the two-plane parallax
 *  still holds since they're independently scaled/positioned. */
export function setMountainsSeasonState(mountains: MountainsHandle, seasonId: SeasonId): void {
  const texture = loadMountainTexture(seasonId);
  for (const layer of mountains.layers) {
    layer.material.map = texture;
    layer.material.needsUpdate = true;
  }
}

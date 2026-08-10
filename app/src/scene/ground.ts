import * as THREE from 'three';
import type { SeasonId } from '../seasons/seasonState';

export interface GroundHandle {
  nearShore: THREE.Mesh;
  nearShoreMaterial: THREE.MeshStandardMaterial;
  farShore: THREE.Mesh;
  farShoreMaterial: THREE.MeshStandardMaterial;
  /** Covers the whole near-shore↔mountains gap for non-winter seasons, hidden for
   *  winter — see its doc comment below for why. */
  lakeCover: THREE.Mesh;
  lakeCoverMaterial: THREE.MeshStandardMaterial;
}

/**
 * A soft one-edge falloff (opaque everywhere except the far/lake-facing edge,
 * which fades to transparent) so the near shore blends into the lake there instead
 * of reading as a hard-edged rectangle — the other three edges are pushed well past
 * the visible frustum (see createGround) so they never need a fade at all. This is
 * a blend mask, not a visual asset in its own right (agent-workflow-policy.md §1.5
 * bans procedural *imagery* — invented colors/textures standing in for the
 * reference art — not utility gradients like this one), so it's still generated at
 * runtime via Canvas2D.
 */
function createEdgeFadeTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  // v=0 (PlaneGeometry's local -Y, the far/lake-facing edge after this mesh's
  // rotation — see createGround) fades out; v=1 (near, camera-facing edge) and
  // everywhere else stays fully opaque.
  // Kept narrow (was 0→0.55→0.8, i.e. most of the plane's depth) — a wide fade
  // left most of the *visible* ground semi-transparent, letting the lake
  // reflection bleed through under grass/flowers there and read as a bizarre
  // floating double-exposure (visual bug found via the elliptical-patch fix below
  // + a real screenshot, not just the Gemini review). Only the far few world units
  // need to blend into the lake at all.
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.1, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.18, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,1)');
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
// (different repeat counts) — two caches so each gets its own THREE.Texture
// instance rather than fighting over one shared `.repeat`.
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
  // Ground is a large tiled plane seen at a steep grazing angle (see
  // NEAR_SHORE_WIDTH/DEPTH) — without anisotropic filtering, mipmapping picks a
  // near-flat average-color mip for most of it well before the tiles are actually
  // that small on screen, reading as a featureless wash instead of visible texture.
  texture.anisotropy = 16;
  cache.set(season, texture);
  return texture;
}

// The lake's own reference art (art-source/COMPOSITION-REFERENCE.md §5.2) is
// winter-only — spring/summer/autumn panels show no open water at all between the
// mountains and the near meadow, just more field stretching back (spring: a
// distinct dense yellow nanohana band; summer/autumn: the same field continuing).
// lakeCover (below) hides scene/lake.ts's Reflector for those three seasons rather
// than leaving it as a jarring "mystery blue band" a Gemini composition review
// flagged as the single biggest resemblance-breaking issue. Spring gets its own
// generated band texture (art-source/midfield/); summer/autumn just reuse their
// own ground photo, tiled further back, since the reference doesn't show anything
// visually distinct there.
const MIDFIELD_TEXTURE_FILES: Partial<Record<SeasonId, string>> = {
  spring: 'spring.jpg',
};
const midfieldTextureCache = new Map<SeasonId, THREE.Texture>();

function loadLakeCoverTexture(season: SeasonId): THREE.Texture {
  const midfieldFile = MIDFIELD_TEXTURE_FILES[season];
  if (!midfieldFile) return loadGroundTexture(season, farTextureCache);
  const cached = midfieldTextureCache.get(season);
  if (cached) return cached;
  const url = `${import.meta.env.BASE_URL}textures/midfield/${midfieldFile}`;
  const texture = groundTextureLoader.load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 16;
  midfieldTextureCache.set(season, texture);
  return texture;
}

const NEAR_SHORE_WIDTH = 46;
const NEAR_SHORE_DEPTH = 24;
// Far edge (toward the lake) sits here; the plane extends *toward* the camera from
// this line, well past the bottom of frame — see createGround's sizing comment.
// Pulled in from -6.2 (Gemini composition review, art-source/STATUS.md: reference
// art — especially non-winter panels, which don't show open water at all — has
// far less exposed lake between the shore and the far bank than a -6.2 edge left).
// Exported: vegetation.ts/flowers.ts clamp their placement patch to stay within
// this line — past it there's no ground mesh at all (open lake), so anything
// placed there floats directly over the Reflector with no ground beneath it.
export const NEAR_SHORE_FAR_EDGE_Z = -3.6;
// World-unit size of one texture tile. The generated ground photos aren't seamless
// (no tiling-aware generation step), so every repeat is a visible seam — this
// stays large (few, big tiles) rather than matching the old ~4.4-unit circle's
// scale 1:1, trading a bit of texture crispness for far fewer seams across the
// much larger plane.
const NEAR_SHORE_TILE_SIZE = 14;

/**
 * Two ground pieces bracket the lake (see scene/lake.ts for the water plane the tree
 * sits at the edge of): the near shore/peninsula the tree roots into, and a thin far
 * shore band before the mountains — the strip §6.1 (season-transition-animation.md)
 * later places the distant girl silhouette on. Both start on the winter texture;
 * setGroundSeasonState swaps the `map` on season change (依頼A').
 */
export function createGround(): GroundHandle {
  const fadeTexture = createEdgeFadeTexture();
  const initialTexture = loadGroundTexture('winter', nearTextureCache);
  // Repeat so the photo tiles at roughly the same visual scale the old ~4.4-radius
  // circle showed it at, rather than one image stretched across the whole
  // now-much-larger plane (see NEAR_SHORE_WIDTH/DEPTH below).
  initialTexture.repeat.set(NEAR_SHORE_WIDTH / NEAR_SHORE_TILE_SIZE, NEAR_SHORE_DEPTH / NEAR_SHORE_TILE_SIZE);

  // A wide plane extending from the lakeshore all the way past the camera (was a
  // small radius-4.4 circle centered right at the tree, which read as a floating
  // island) — the reference art's near shore fills the whole foreground edge to
  // edge with no visible boundary. Only the far (lake-facing) edge is ever in
  // frame; the near/left/right edges are pushed well past the visible frustum.
  const nearShoreGeometry = new THREE.PlaneGeometry(NEAR_SHORE_WIDTH, NEAR_SHORE_DEPTH);
  const nearShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    map: initialTexture,
    alphaMap: fadeTexture,
    transparent: true,
  });
  const nearShore = new THREE.Mesh(nearShoreGeometry, nearShoreMaterial);
  nearShore.rotation.x = -Math.PI / 2;
  nearShore.position.set(0, 0.03, NEAR_SHORE_FAR_EDGE_Z + NEAR_SHORE_DEPTH / 2);

  const farTexture = loadGroundTexture('winter', farTextureCache);
  farTexture.repeat.set(3, 1);

  const farShoreGeometry = new THREE.PlaneGeometry(60, 6);
  const farShoreMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    map: farTexture,
  });
  const farShore = new THREE.Mesh(farShoreGeometry, farShoreMaterial);
  farShore.rotation.x = -Math.PI / 2;
  // Pulled closer (was z=-19) for the same reason as NEAR_SHORE_FAR_EDGE_Z above —
  // shrinks the open-water gap between the two shores to match the reference art.
  farShore.position.set(0, 0.02, -13);

  // Sits just above farShore (y=0.025 > 0.02) so when visible it fully occludes
  // both farShore and the lake beneath — see MIDFIELD_TEXTURE_FILES's doc comment
  // above for why this exists at all. Hidden by default (winter); setGroundSeasonState
  // shows it for spring/summer/autumn.
  const lakeCoverTexture = loadLakeCoverTexture('winter');
  lakeCoverTexture.repeat.set(6, 3);
  const lakeCoverMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 1,
    map: lakeCoverTexture,
  });
  const lakeCover = new THREE.Mesh(new THREE.PlaneGeometry(60, 28), lakeCoverMaterial);
  lakeCover.rotation.x = -Math.PI / 2;
  lakeCover.position.set(0, 0.025, -14);
  lakeCover.visible = false;

  return { nearShore, nearShoreMaterial, farShore, farShoreMaterial, lakeCover, lakeCoverMaterial };
}

/** Called by the season system (依頼A') whenever the dial settles on a new season —
 *  swaps the ground photo rather than tinting a flat procedural texture. */
export function setGroundSeasonState(ground: GroundHandle, seasonId: SeasonId): void {
  const nearTexture = loadGroundTexture(seasonId, nearTextureCache);
  nearTexture.repeat.set(NEAR_SHORE_WIDTH / NEAR_SHORE_TILE_SIZE, NEAR_SHORE_DEPTH / NEAR_SHORE_TILE_SIZE);
  ground.nearShoreMaterial.map = nearTexture;
  ground.nearShoreMaterial.needsUpdate = true;

  const farTexture = loadGroundTexture(seasonId, farTextureCache);
  farTexture.repeat.set(3, 1);
  ground.farShoreMaterial.map = farTexture;
  ground.farShoreMaterial.needsUpdate = true;

  ground.lakeCover.visible = seasonId !== 'winter';
  if (ground.lakeCover.visible) {
    const lakeCoverTexture = loadLakeCoverTexture(seasonId);
    lakeCoverTexture.repeat.set(6, 3);
    ground.lakeCoverMaterial.map = lakeCoverTexture;
    ground.lakeCoverMaterial.needsUpdate = true;
  }
}

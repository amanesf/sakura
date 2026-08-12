import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera } from './core/camera';
import { createSky, updateSky } from './scene/sky';
import { createCloudMaterials, createCloudCluster, type CloudClusterHandle } from './scene/clouds';
import { sunDirection } from './core/solarPosition';
import { createPostFx } from './core/postFx';
import { createCloudShadow } from './scene/cloudShadow';

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
const camera = createCamera(window.innerWidth / window.innerHeight);

const scene = new THREE.Scene();

const sky = createSky();
scene.add(sky.mesh);

const postFx = createPostFx(renderer, scene, camera);
watchResize(renderer, camera, (w, h) => postFx.setSize(w, h));

// plan.md: 「まず日中だけでいい」— time-of-day t is fixed at 0 (day) for now.
const TIME_OF_DAY_T = 0;
const sunDir = sunDirection(TIME_OF_DAY_T);

// Art-directed key light for the clouds — deliberately *not* the true sun
// direction above. Per the Guilty Gear Xrd cel-shading research, professional
// stylized 3D lighting is chosen for how the form reads, not physical
// accuracy. The requested travel is "左手前から右奥方向へ": down and to the
// right, away from the viewer.
//
// The previous value (-0.55, 0.7, 0.55) took "手前" literally and put a third
// of the light vector straight down the camera axis, pointing the lit pole of
// every puff at the lens. That is the flat-light case: the whole visible
// hemisphere sits near the top of the shading curve and no terminator appears
// anywhere on screen. Measured, the reference tower's luminance falls 7.8 per
// 100px from left to right across the mass and its left half is 10.7 brighter
// than its right; this scene managed +0.3 and -1.2 — no lateral modelling at
// all. Nothing downstream could fix that, which is why the rim and the large
// shadow masses never appeared however hard they were pushed: there was no
// shadow side for them to live on.
//
// So the depth component is reversed and the vector swung to the side. Travel
// is still left→right and still downward — the read the direction was chosen
// for — but the source now sits beyond the cloud rather than beside the
// camera, so the near face is the shadow face. Values resolved by sweeping
// candidates through scripts/capture.js + scripts/measure.js and taking the
// one that lands on the reference's gradient, not by eye.
const LIGHT_QUERY = new URLSearchParams(window.location.search).get('light');
const CLOUD_LIGHT_DIR = LIGHT_QUERY
  ? new THREE.Vector3(...(LIGHT_QUERY.split(',').map(Number) as [number, number, number])).normalize()
  : new THREE.Vector3(-0.78, 0.45, -0.44).normalize();

// No THREE.Light in the scene any more: the cloud material is unlit and
// indexes a colour ramp measured out of the reference image (cloudRamp.ts),
// and sky.ts is its own atmospheric-scattering shader. Adding a
// DirectionalLight/HemisphereLight here would do nothing but cost uniforms.

const materials = createCloudMaterials(CLOUD_LIGHT_DIR);

// Light-space depth map for cloud self-shadowing.
//
// Deliberately tiny — 256 across a ~156km field, so one texel is about 0.6km
// and a single puff is under two texels. At 1024 it worked, but it resolved
// individual lobes: measured band energy rose in the 2-16px range and did not
// move at 40-80px at all, which is the opposite of what this term is for. A
// map too coarse to see one puff can only record where whole masses of cloud
// are, and that is exactly the scale of shadow that groups lobes into a light
// side and a shadow side.
const CLOUD_FIELD_CENTER = new THREE.Vector3(0, 5, -34);
const cloudShadow = createCloudShadow(CLOUD_LIGHT_DIR, CLOUD_FIELD_CENTER, 78, 256);
materials.core.uniforms.uShadowMap.value = cloudShadow.texture;
materials.core.uniforms.uShadowMatrix.value = cloudShadow.matrix;

/** Simplified thermal-rise growth curve — ported from the shader version this
 * replaces (see plan.md §3.3): height ~ sqrt(t) while rising, then a hold,
 * then decay. */
function towerGrowth(tau: number): number {
  const riseEnd = 0.35;
  const holdEnd = 0.75;
  if (tau < riseEnd) return Math.sqrt(tau / riseEnd);
  if (tau < holdEnd) return 1.0;
  const d = (tau - holdEnd) / (1.0 - holdEnd);
  return 1.0 - THREE.MathUtils.smoothstep(d, 0.0, 1.0);
}

const CLOUD_BASE_ALT = 1.4;

// Hero cumulonimbus tower — composition-matched position (see plan.md /
// core/camera.ts for how TOWER_CENTER was solved from the reference image's
// measured screen position).
const TOWER_CENTER = new THREE.Vector2(5.5, -16.0);
const TOWER_TOP_ALT = 10.8;
const TOWER_RADIUS = 4.3;
const TOWER_CYCLE_SECONDS = 260;
function towerRadiusProfile(t: number): number {
  // An explicit three-part silhouette rather than a single symmetric bump.
  // A symmetric profile makes the tower an ellipsoid — widest in the middle
  // and equally tapered at both ends — which rendered as a boulder, not as
  // 入道雲. A cumulonimbus is not symmetric about its waist: it flares
  // quickly off a fairly narrow base, holds a broad shoulder through most of
  // its body, then draws in toward a cauliflower crown.
  const flare = THREE.MathUtils.smoothstep(t, 0.0, 0.24);
  const crown = 1 - THREE.MathUtils.smoothstep(t, 0.52, 1.0) * 0.58;
  return TOWER_RADIUS * (0.58 + 0.62 * flare) * crown;
}

interface AnimatedCluster {
  handle: CloudClusterHandle;
  cycleSeconds: number;
  phaseOffset: number;
  baseAlt: number;
  topAltFull: number;
  windSpeed: THREE.Vector2;
  windScale: number;
}

const clusters: AnimatedCluster[] = [];

// The sky is a fullscreen quad that ignores the camera, so it would otherwise
// fill the light-space depth map entirely.
const hiddenDuringShadowPass: THREE.Object3D[] = [sky.mesh];

function addCluster(
  seed: number,
  center: THREE.Vector2,
  topAltFull: number,
  radiusProfile: (t: number) => number,
  levels: number,
  puffsPerLevel: number,
  cycleSeconds: number,
  windScale = 1,
  baseAlt = CLOUD_BASE_ALT,
): void {
  const handle = createCloudCluster(seed, center, baseAlt, topAltFull, levels, radiusProfile, puffsPerLevel, materials, CLOUD_LIGHT_DIR);
  scene.add(handle.group);
  clusters.push({
    handle,
    cycleSeconds,
    phaseOffset: seed * 37.0,
    baseAlt,
    windScale,
    topAltFull,
    windSpeed: new THREE.Vector2(0.16, 0.05),
  });
}

// Density/complexity numbers below were re-derived by actually counting the
// reference image (1786418841252.png): the visible tower crop shows 15-20+
// distinct lobes with essentially *no* gaps of sky between them — packed
// solid, not a sparse arrangement of a dozen separated balls. levels=7/
// puffsPerLevel=3 (plus 0-2 satellites) was off by close to an order of
// magnitude from that.
// windScale 0.2: the hero tower's position is composition-anchored (solved
// against the reference image's measured screen coordinates, see camera.ts) —
// letting it drift on the same wind budget as decorative background cumulus
// carried it out of frame within seconds. It still sways, just gently.
addCluster(TOWER_CENTER.x + TOWER_CENTER.y, TOWER_CENTER, TOWER_TOP_ALT, towerRadiusProfile, 22, 15, TOWER_CYCLE_SECONDS, 0.05);

// A handful of smaller cumulus scattered around the tower
// (plan.md: 「雲は入道雲だけじゃないしさ」) — deterministic seeded positions,
// not yet the full infinite procedural field the shader version had.
const SMALL_CUMULUS = [
  { seed: 11.3, x: -6.0, z: -10.0, top: 2.6, radius: 1.1 },
  { seed: 22.7, x: -2.5, z: -8.0, top: 2.2, radius: 0.85 },
  { seed: 33.1, x: 10.5, z: -12.0, top: 2.8, radius: 1.2 },
  { seed: 44.9, x: 2.0, z: -6.5, top: 2.0, radius: 0.7 },
  { seed: 55.2, x: -9.0, z: -14.0, top: 2.4, radius: 0.95 },
  { seed: 66.6, x: 14.0, z: -18.0, top: 2.5, radius: 1.05 },
];
for (const c of SMALL_CUMULUS) {
  const radiusProfile = (t: number) => c.radius * THREE.MathUtils.lerp(0.7, 1.0, Math.sin(t * Math.PI));
  addCluster(c.seed, new THREE.Vector2(c.x, c.z), c.top, radiusProfile, 4, 6, TOWER_CYCLE_SECONDS * 1.4);
}

// The distant cloud bank — 裾野.
//
// Counting cloud coverage row by row in the reference shows the scene is not
// one tower in empty sky: coverage runs about 3% at the top of the frame,
// peaks near 46% across the tower's own band, and then rises again to 50-77%
// across the whole bottom half, where a continuous low bank spans the full
// width and thins toward the horizon. This scene had nothing of the sort —
// a hero tower and six small isolated puffs, with the entire lower sky empty,
// which is why the composition read as a single object floating rather than
// as weather.
//
// These sit far enough back that the aerial-perspective term in the cloud
// shader does most of the work on them: they arrive already low-contrast and
// tending toward the sky colour, which is the "下部が薄く空に溶け込む" read.
// They are wide and squat rather than towering (a low cumulus field seen
// nearly edge-on from a fixed low camera presents as horizontal banding), and
// they drift on the full wind budget since nothing anchors them
// compositionally.
// Two depth tiers, because one is not enough to read as depth. The
// reference's lower sky is not a single row of cloud but layers at
// visibly different distances, each flatter and bluer than the one in
// front — that stacking is what makes the bottom of the frame recede
// instead of sitting on the horizon like a wall.
//
// Distances matter more than sizes here: a cluster placed close and made
// small still renders at close-range contrast, so it reads as a small
// nearby cloud rather than a big far one. Pushing these genuinely far back
// lets the shader's aerial-perspective term do the work, and also keeps
// them above the horizon line by geometry alone (at 45km out, a 1.6km base
// still sits about 2 degrees up).
// Tiers are specified by the elevation band each one is supposed to occupy,
// not by "near/far" feel. Counting cloud pixels per elevation band on the
// reference (scripts/skyprofile.js, 13 bands over the window interior) gives
// the target: coverage peaks at 75-79% across 6-9°, is still 65-67% at
// 12-15°, and falls back to 42% at the horizon band (0.8°). The previous two
// tiers put every bank between 1.5° and 7.4° of elevation — tier0's top was
// atan(4.4/34)=7.4°, tier1's atan(8.0/65)=7.0° — so they piled up in the
// 0-4° bands (measured 86%/63% against the reference's 70%/42%) and left a
// hole at 6-9° (43% against 75%).
//
// Geometry fixes the altitudes: a deck whose top is to read at elevation e
// from distance d needs altitude d·tan(e). Reaching the reference's 14.6°
// from 34km would need 8.9km, which is not a low cumulus bank any more; from
// 22km it needs only 5.7km, an ordinary mid-level (高積雲) deck. So the near
// tier is pulled in to 17-27km and lifted, rather than the old tier being
// stretched upward at its original distance.
//
// Resulting elevation span of each tier (base → top, at its mid distance):
//   0  near deck   22km   2.3km → 6.2km   =  6.0° → 15.7°
//   1  middle      38km   2.2km → 8.2km   =  3.3° → 12.2°
//   2  far bank    70km   1.6km → 5.4km   =  1.3° →  4.4°
// The far tier keeps the horizon band populated but is the only tier that
// reaches it, which is what brings 0-4° back down toward the reference.
const BANK_TIERS = [
  { count: 18, zNear: 17, zSpan: 7, baseAlt: 2.3, topLo: 4.6, topHi: 6.2, radLo: 3.0, radHi: 5.5, xStep: 5.0, wind: 0.55 },
  { count: 16, zNear: 30, zSpan: 11, baseAlt: 2.2, topLo: 5.0, topHi: 8.2, radLo: 4.0, radHi: 7.5, xStep: 6.0, wind: 0.4 },
  { count: 14, zNear: 55, zSpan: 21, baseAlt: 1.6, topLo: 3.2, topHi: 5.4, radLo: 5.0, radHi: 9.0, xStep: 8.0, wind: 0.25 },
];
BANK_TIERS.forEach((tier, t) => {
  for (let i = 0; i < tier.count; i++) {
    const seed = 130.7 + t * 313.1 + i * 41.3;
    // Irregular spacing, not a grid — an evenly spaced row of similar banks
    // reads as wallpaper.
    const x = -tier.xStep * tier.count * 0.5 + i * tier.xStep + Math.sin(i * 2.7 + t) * tier.xStep * 0.8;
    const z = -(tier.zNear + ((i * 7.3) % tier.zSpan) + Math.abs(Math.cos(i * 1.9 + t)) * tier.zSpan * 0.4);
    const radius = tier.radLo + ((i * 3.7) % (tier.radHi - tier.radLo));
    const top = tier.topLo + ((i * 2.3) % (tier.topHi - tier.topLo));
    // Squat profile: widest near the base and tapering fast, so the
    // silhouette is a long low mound rather than a ball. A low cumulus field
    // seen nearly edge-on from a fixed low camera presents as horizontal
    // banding, not as towers.
    const radiusProfile = (u: number) => radius * THREE.MathUtils.lerp(1.0, 0.4, u * u);
    addCluster(seed, new THREE.Vector2(x, z), top, radiusProfile, 3, 8, TOWER_CYCLE_SECONDS * 2.1, tier.wind, tier.baseAlt);
  }
});

const clock = new THREE.Clock();
const frozenElapsed = new URLSearchParams(window.location.search).has('t')
  ? Number(new URLSearchParams(window.location.search).get('t'))
  : null;

// JS `%` keeps the sign of its left operand, so a negative dividend (any of
// this file's per-cluster phase offsets can be negative, since they derive
// from world-space coordinates that are themselves negative) yields a
// negative result instead of wrapping into [0, modulus) — which fed a
// negative phase into towerGrowth()'s sqrt() (NaN, silently dropping the
// whole cluster) and a wildly out-of-range wind offset (blowing it off
// screen). Both bugs were this same JS footgun in two different formulas.
function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const elapsed = frozenElapsed ?? clock.getElapsedTime();

  updateSky(sky, camera, sunDir);

  for (const c of clusters) {
    const phase = positiveMod(elapsed + c.phaseOffset, c.cycleSeconds) / c.cycleSeconds;
    const growth = towerGrowth(phase);
    // Real wind: drift is genuinely unbounded (a cloud that has blown away is
    // gone, a new one takes its place — not something to prevent), but the
    // *direction and speed* aren't constant either. Wrapping the travelled
    // distance with modulo re-seeds each cluster at the upwind edge once it
    // would have drifted out of the scene, standing in for "this one dissolved,
    // a new one formed" without actually regenerating instances.
    const WRAP_DISTANCE = 26;
    const angle = 0.35 + 0.25 * Math.sin(elapsed * 0.01 + c.phaseOffset * 0.7);
    const gust = 0.8 + 0.3 * Math.sin(elapsed * 0.04 + c.phaseOffset);
    const dist = (positiveMod(elapsed * 0.11 * gust + c.phaseOffset * 3.1, WRAP_DISTANCE) - WRAP_DISTANCE / 2) * c.windScale;
    const wind = new THREE.Vector2(Math.cos(angle) * dist, Math.sin(angle) * dist);
    c.handle.update(elapsed, growth, wind);
  }

  // After the clusters have moved, before anything is shaded with it.
  cloudShadow.update(renderer, scene, hiddenDuringShadowPass);

  postFx.render();
}

renderLoop();

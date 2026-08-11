import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera } from './core/camera';
import { createSky, updateSky } from './scene/sky';
import { createCloudMaterials, createCloudCluster, type CloudClusterHandle } from './scene/clouds';
import { sunDirection } from './core/solarPosition';
import { createPostFx } from './core/postFx';

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
// accuracy: requested here is a raking cross-light with the source up, to the
// left, and near the camera, light travelling down toward the right and into
// the distance ("左手前から右奥方向へ") rather than straight down from above.
const CLOUD_LIGHT_DIR = new THREE.Vector3(-0.55, 0.7, 0.55).normalize();

// The color a shaded cloud crevice should read as — actual sky color, not a
// hand-picked blue or a neutral darkening toward black/grey (「影は黒っぽく
// するんじゃなくて空の色を混ぜて」). Matches sky.ts's zenith tone.
const SKY_TINT = new THREE.Color(0.4, 0.62, 0.95);

const sun = new THREE.DirectionalLight('#fff6e8', 3.2);
sun.position.copy(CLOUD_LIGHT_DIR).multiplyScalar(50);
scene.add(sun);
const hemi = new THREE.HemisphereLight(SKY_TINT, '#3a4a3f', 0.9);
scene.add(hemi);

const materials = createCloudMaterials(CLOUD_LIGHT_DIR);

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
const TOWER_TOP_ALT = 11.0;
const TOWER_RADIUS = 2.4;
const TOWER_CYCLE_SECONDS = 260;
function towerRadiusProfile(t: number): number {
  const bump = Math.max(0, 1 - Math.abs(t * 2 - 0.7) ** 1.3);
  // Floor raised 0.5→0.68: the reference tower stays visually chunky right up
  // to its crown — no thin "neck" anywhere — so the taper toward top/base
  // needs to be gentler than the profile that made the neck gap visible.
  return TOWER_RADIUS * THREE.MathUtils.lerp(0.68, 1.15, bump);
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

function addCluster(
  seed: number,
  center: THREE.Vector2,
  topAltFull: number,
  radiusProfile: (t: number) => number,
  levels: number,
  puffsPerLevel: number,
  cycleSeconds: number,
  windScale = 1,
): void {
  const handle = createCloudCluster(seed, center, CLOUD_BASE_ALT, topAltFull, levels, radiusProfile, puffsPerLevel, materials, SKY_TINT);
  scene.add(handle.group);
  clusters.push({
    handle,
    cycleSeconds,
    phaseOffset: seed * 37.0,
    baseAlt: CLOUD_BASE_ALT,
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
addCluster(TOWER_CENTER.x + TOWER_CENTER.y, TOWER_CENTER, TOWER_TOP_ALT, towerRadiusProfile, 12, 6, TOWER_CYCLE_SECONDS, 0.05);

// A handful of smaller cumulus scattered around the tower for variety
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
  addCluster(c.seed, new THREE.Vector2(c.x, c.z), c.top, radiusProfile, 2, 3, TOWER_CYCLE_SECONDS * 1.4);
}

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

  postFx.render();
}

renderLoop();

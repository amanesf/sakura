import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera } from './core/camera';
import { createSky, updateSky } from './scene/sky';
import { createCloudMaterials, createCloudCluster, type CloudClusterHandle } from './scene/clouds';
import { sunDirection } from './core/solarPosition';

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
const camera = createCamera(window.innerWidth / window.innerHeight);
watchResize(renderer, camera);

const scene = new THREE.Scene();

const sky = createSky();
scene.add(sky.mesh);

// plan.md: 「まず日中だけでいい」— time-of-day t is fixed at 0 (day) for now.
const TIME_OF_DAY_T = 0;
const sunDir = sunDirection(TIME_OF_DAY_T);

const sun = new THREE.DirectionalLight('#fff6e8', 3.2);
sun.position.copy(sunDir).multiplyScalar(50);
scene.add(sun);
const hemi = new THREE.HemisphereLight('#bcd4ff', '#3a4a3f', 0.9);
scene.add(hemi);

const materials = createCloudMaterials(sunDir);

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
  return TOWER_RADIUS * THREE.MathUtils.lerp(0.5, 1.15, bump);
}

interface AnimatedCluster {
  handle: CloudClusterHandle;
  cycleSeconds: number;
  phaseOffset: number;
  baseAlt: number;
  topAltFull: number;
  windSpeed: THREE.Vector2;
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
): void {
  const handle = createCloudCluster(seed, center, CLOUD_BASE_ALT, topAltFull, levels, radiusProfile, puffsPerLevel, materials);
  scene.add(handle.group);
  clusters.push({
    handle,
    cycleSeconds,
    phaseOffset: seed * 37.0,
    baseAlt: CLOUD_BASE_ALT,
    topAltFull,
    windSpeed: new THREE.Vector2(0.16, 0.05),
  });
}

addCluster(TOWER_CENTER.x + TOWER_CENTER.y, TOWER_CENTER, TOWER_TOP_ALT, towerRadiusProfile, 7, 3, TOWER_CYCLE_SECONDS);

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
    const dist = positiveMod(elapsed * 0.11 * gust + c.phaseOffset * 3.1, WRAP_DISTANCE) - WRAP_DISTANCE / 2;
    const wind = new THREE.Vector2(Math.cos(angle) * dist, Math.sin(angle) * dist);
    c.handle.update(elapsed, growth, wind);
  }

  renderer.render(scene, camera);
}

renderLoop();

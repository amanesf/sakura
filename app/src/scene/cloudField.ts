import * as THREE from 'three';
import { mulberry32 } from '../core/buildNoise';
import { createCloudCluster, type CloudClusterHandle, type CloudMaterials } from './clouds';
import { CAMERA_VERTICAL_FOV_DEG } from '../core/camera';
import { FRAME_WIDTH, FRAME_HEIGHT } from '../core/frame';

/**
 * A sky that keeps happening, rather than a fixed arrangement of clouds that
 * sways in place.
 *
 * Clusters are born at the upwind edge of the scene, drift across on the real
 * wind, grow and decay on a thermal's life cycle, and are rebuilt with a new
 * seed once they leave — so the shapes never repeat, and the weather they are
 * born into decides what kind of cloud they are. Everything here is a pure
 * function of `simTime`: the same simulated second always produces the same
 * sky, whatever frame rate or playback speed got us there, which is what
 * scripts/capture.js's `?t=` depends on.
 */

/** Mid-latitude summer synoptic flow, low to mid levels. Every on-screen speed
 * in this file follows from this one number and the geometry — nothing is a
 * "looks about right" pixels-per-second. */
const WIND_SPEED_KM_S = 0.007; // 7 m/s

/** Half-width of the visible sky at distance d, in km: the frame is
 * 2·atan(704/f) = 81.0° wide with f = (768/2)/tan(25°) = 823.5 px/rad. */
const HALF_FOV_TAN = Math.tan(
  Math.atan((FRAME_WIDTH / 2) / ((FRAME_HEIGHT / 2) / Math.tan(THREE.MathUtils.degToRad(CAMERA_VERTICAL_FOV_DEG / 2)))),
);

interface TierSpec {
  name: string;
  /** How many cluster slots this tier keeps alive at once. */
  count: number;
  zNear: number;
  zSpan: number;
  baseAlt: number;
  topLo: number;
  topHi: number;
  radLo: number;
  radHi: number;
  levels: number;
  puffsPerLevel: number;
  /** Cluster radius, roughly, in km — how far past the frame edge a cluster has
   * to travel before it is fully gone. */
  margin: number;
  /** Coverage this tier contributes at a given weather value (see weatherAt).
   * A clear day has scattered fair-weather cumulus and no towers at all; a
   * pre-rain sky is solid low deck. */
  coverageAt: (weather: number) => number;
}

/**
 * Distances and sizes carried over from the fitted static arrangement: they were
 * solved band by band against the reference's per-elevation cloud coverage
 * (see handoff.md §1), so the summer-sky state of this field starts from a
 * distribution that is already measured rather than from a fresh guess.
 */
const TIERS: TierSpec[] = [
  {
    name: 'tower',
    count: 4,
    zNear: 15,
    zSpan: 6,
    baseAlt: 1.4,
    topLo: 8.4,
    topHi: 10.4,
    radLo: 2.0,
    radHi: 2.7,
    levels: 22,
    puffsPerLevel: 15,
    margin: 6,
    // No cumulonimbus on a clear day, and by the time it is about to rain the
    // towers have spread into a deck rather than standing separately.
    coverageAt: (w) => THREE.MathUtils.smoothstep(w, 0.3, 0.55) * (1 - 0.5 * THREE.MathUtils.smoothstep(w, 0.75, 1)),
  },
  {
    name: 'cumulus',
    count: 10,
    zNear: 6,
    zSpan: 10,
    baseAlt: 1.4,
    topLo: 2.0,
    topHi: 2.9,
    radLo: 0.7,
    radHi: 1.25,
    levels: 4,
    puffsPerLevel: 6,
    margin: 2,
    // Fair-weather cumulus are the *clear* day's cloud; as the sky closes over
    // they are absorbed into the deck rather than surviving under it.
    coverageAt: (w) => 0.95 - 0.35 * w,
  },
  {
    name: 'deck-near',
    count: 26,
    zNear: 17,
    zSpan: 7,
    baseAlt: 2.3,
    topLo: 5.6,
    topHi: 7.9,
    radLo: 3.0,
    radHi: 5.5,
    levels: 3,
    puffsPerLevel: 8,
    margin: 6,
    // Solid from the summer sky upward. A cumulonimbus does not stand in clear
    // air: it grows out of a low deck, and in the reference the bands below the
    // tower measure 65-79% covered while the tower's own bands measure 25-31%.
    // Anything less than full coverage here left the lower sky too open, which
    // is the one place the eye reads "this is not the reference".
    coverageAt: (w) => THREE.MathUtils.smoothstep(w, 0.02, 0.42),
  },
  {
    name: 'deck-mid',
    count: 22,
    zNear: 30,
    zSpan: 11,
    baseAlt: 2.2,
    topLo: 5.0,
    topHi: 8.2,
    radLo: 4.0,
    radHi: 7.5,
    levels: 3,
    puffsPerLevel: 8,
    margin: 8,
    coverageAt: (w) => THREE.MathUtils.smoothstep(w, 0.0, 0.45),
  },
  {
    name: 'bank-far',
    count: 15,
    zNear: 55,
    zSpan: 21,
    baseAlt: 1.6,
    topLo: 2.6,
    topHi: 4.4,
    radLo: 5.0,
    radHi: 9.0,
    levels: 3,
    puffsPerLevel: 8,
    margin: 10,
    // The horizon band is never empty — even a clear day has haze and distant
    // cumulus stacked along it.
    coverageAt: (w) => 0.62 + 0.38 * THREE.MathUtils.smoothstep(w, 0.0, 0.4),
  },
];

/**
 * The weather, as a single number: 0 is a clear day, 0.5 the reference image's
 * summer sky, 1 an about-to-rain sky. Three sine terms with periods that share
 * no common multiple (≈3.2h, ≈7.5h, ≈1.6h), so the sequence never repeats and
 * yet is a pure function of the clock — no accumulated state to desynchronise a
 * capture. At 30x those periods are 6.4, 15 and 3.2 minutes, which is roughly
 * how fast a real afternoon changes its mind.
 */
export function weatherAt(simTime: number): number {
  const h =
    0.55 * Math.sin(simTime / 1830) +
    0.30 * Math.sin(simTime / 4270 + 1.7) +
    0.15 * Math.sin(simTime / 930 + 4.1);
  return THREE.MathUtils.clamp(0.5 + 0.5 * h, 0, 1);
}

/** Simplified thermal-rise growth curve (plan.md §3.3): height ~ sqrt(t) while
 * rising, a hold at maturity, then decay. */
function towerGrowth(tau: number): number {
  const riseEnd = 0.35;
  const holdEnd = 0.75;
  if (tau < riseEnd) return Math.sqrt(tau / riseEnd);
  if (tau < holdEnd) return 1.0;
  return 1.0 - THREE.MathUtils.smoothstep((tau - holdEnd) / (1.0 - holdEnd), 0.0, 1.0);
}

/** Deterministic [0,1) from a slot and a generation index. */
function hash01(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** How far a cluster of this tier travels between being born off one edge and
 * being retired past the other. Fixed per tier rather than per cluster: it has
 * to be known *before* the slot is built, since it is what decides which
 * generation the clock is in, and a per-cluster span would make that circular. */
function tierSpan(tier: TierSpec): number {
  return 2 * (tier.zNear + tier.zSpan / 2) * HALF_FOV_TAN + 2 * tier.margin;
}

interface Slot {
  tier: TierSpec;
  id: number;
  /** Index within the tier, for the stratified coverage draw below. */
  index: number;
  /** Where in its crossing this slot starts, so the tier's clusters are spread
   * out along the wind rather than arriving in a line. */
  phase: number;
  generation: number;
  handle: CloudClusterHandle | null;
  z: number;
  active: boolean;
}

export interface CloudField {
  update: (simTime: number) => void;
  /** Live counts, for the perf overlay. */
  stats: () => { clusters: number; rebuilds: number };
}

export function createCloudField(
  scene: THREE.Scene,
  materials: CloudMaterials,
  lightDir: THREE.Vector3,
): CloudField {
  const slots: Slot[] = [];
  let id = 0;
  for (const tier of TIERS) {
    for (let i = 0; i < tier.count; i++) {
      slots.push({
        tier,
        id: id++,
        index: i,
        phase: hash01(i * 13.7 + tier.zNear, 7.3),
        generation: Number.NaN,
        handle: null,
        z: 0,
        active: false,
      });
    }
  }

  let rebuilds = 0;

  function buildSlot(slot: Slot, generation: number, birthTime: number): void {
    slot.handle?.dispose();
    slot.handle = null;
    rebuilds++;

    const rand = mulberry32(((slot.id * 7919 + generation * 104729) >>> 0) || 1);
    const tier = slot.tier;
    const weather = weatherAt(birthTime);

    // Whether this generation exists at all is how cloud cover changes: a slot
    // that fails the coverage test simply stays empty until its next crossing.
    // Cover therefore changes at the pace clouds actually arrive and leave,
    // instead of clouds fading out where they float.
    //
    // Stratified rather than an independent coin flip per slot. With only four
    // tower slots, independent draws left the sky with no cumulonimbus at all
    // for whole crossings — measured, the first 40 minutes of simulated time had
    // none despite coverage standing at 1.0 — because each slot rolled its own
    // luck. Spreading the draws over the unit interval makes the count of active
    // slots track the coverage exactly instead of on average.
    const stratum = (slot.index + hash01(slot.id * 3.1, generation)) / tier.count;
    slot.active = stratum < tier.coverageAt(weather);
    slot.z = -(tier.zNear + rand() * tier.zSpan);
    slot.generation = generation;
    if (!slot.active) return;

    const radius = tier.radLo + rand() * (tier.radHi - tier.radLo);
    // A pre-rain sky is lower and flatter; a clear one is shallow fair-weather
    // cumulus. Both come out of the same tier by moving base and top, not by
    // swapping in different-looking clouds.
    const baseAlt = tier.baseAlt * THREE.MathUtils.lerp(1.15, 0.55, weather);
    const top = baseAlt + (tier.topLo + rand() * (tier.topHi - tier.topLo) - tier.baseAlt) *
      THREE.MathUtils.lerp(0.8, 1.15, weather);

    const profile =
      tier.name === 'tower'
        ? (t: number) =>
            // Fitted band by band against the reference (see handoff.md §1):
            // widest at the shoulder, columnar above it, drawing in only over
            // the top ~12%.
            radius * (0.6 + 0.4 * THREE.MathUtils.smoothstep(t, 0.45, 0.72)) *
            (1 - 0.78 * THREE.MathUtils.smoothstep(t, 0.88, 1.0))
        : tier.name === 'cumulus'
          ? (t: number) => radius * THREE.MathUtils.lerp(0.7, 1.0, Math.sin(t * Math.PI))
          : (t: number) => radius * THREE.MathUtils.lerp(1.0, 0.4, t * t);

    const handle = createCloudCluster(
      slot.id * 31.7 + generation * 5.9,
      new THREE.Vector2(0, slot.z),
      baseAlt,
      top,
      tier.levels,
      profile,
      tier.puffsPerLevel,
      materials,
      lightDir,
    );
    scene.add(handle.group);
    slot.handle = handle;
  }

  const wind = new THREE.Vector2();

  function update(simTime: number): void {
    for (const slot of slots) {
      const span = tierSpan(slot.tier);
      const travel = WIND_SPEED_KM_S * simTime + slot.phase * span;
      const generation = Math.floor(travel / span);
      if (generation !== slot.generation) {
        const birthTime = (generation * span - slot.phase * span) / WIND_SPEED_KM_S;
        buildSlot(slot, generation, birthTime);
      }
      if (!slot.active || !slot.handle) continue;

      const local = travel - generation * span;
      const tau = THREE.MathUtils.clamp(local / span, 0, 1);
      // Life cycle and crossing are the same clock. A crossing takes 69 minutes
      // at the tower's distance on a 7 m/s wind, and a cumulonimbus lives 30-60
      // minutes, so a cloud that is born as it enters has genuinely finished by
      // the time it leaves — it does not need a separate lifetime to look right.
      wind.set(local - span / 2, 0);
      slot.handle.update(simTime, towerGrowth(tau), wind);
    }
  }

  return {
    update,
    stats: () => ({ clusters: slots.filter((s) => s.active).length, rebuilds }),
  };
}

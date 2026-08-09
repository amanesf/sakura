import * as THREE from 'three';

/**
 * The 4 scenes from season-transition-animation.md §2 (in loop order, §2
 * "ループ順"), with both spring's and autumn's "peak" and "shedding" stages each
 * consolidated into one scene per user direction, rather than the doc's original
 * 6-scene split. `spring` and `autumn` each show a colored canopy *and* active
 * petal/leaf shedding at once (see sheddingSensitivity below), rather than picking
 * "just bloomed/colored" vs. "already falling" as separate dial notches.
 */
export type SeasonId = 'winter' | 'spring' | 'summer' | 'autumn';

export const SEASON_ORDER: readonly SeasonId[] = ['winter', 'spring', 'summer', 'autumn'];

export interface SeasonVisualParams {
  id: SeasonId;
  label: string;

  /** Canopy (tree instanced-leaf cluster). */
  canopyColor: THREE.Color;
  /** Fraction (0..1) of canopy instances kept visible — see tree.ts `applyCanopyState`. */
  canopyDensity: number;
  /** Uniform size multiplier applied on top of each instance's own baked variance. */
  canopyScale: number;

  /** Ground / shore. */
  groundColor: THREE.Color;
  farShoreColor: THREE.Color;

  /** Foreground shore vegetation (scene/vegetation.ts). */
  vegetationColor: THREE.Color;
  vegetationDensity: number;
  vegetationHeight: number;
  /** Scattered wildflower dots (scene/flowers.ts) — spring's "花畑" (§5), 0 elsewhere. */
  flowerDensity: number;

  /** Falling petal/leaf particles (scene/sheddingParticles.ts), §8 桜吹雪・落葉.
   *  0 outside the two shedding scenes — see that module's LEAF_DETACH_THRESHOLD
   *  gearing for why this is a multiplier rather than a plain on/off flag. */
  sheddingColor: THREE.Color;
  sheddingSensitivity: number;

  /** Lake (Reflector tint, multiplies the mirrored scene). */
  lakeTint: THREE.Color;

  /** Sky gradient (scene/sky.ts uniforms). */
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  skyBottom: THREE.Color;

  /** Mountain ridgelines, near then far layer. */
  mountainNear: THREE.Color;
  mountainFar: THREE.Color;

  /** Scene fog. */
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;

  /** Sun (key light). Elevation/azimuth in degrees; §10's "光源角度" (autumn = low,
   *  long shadows) is expressed here rather than as a fixed light position. */
  sunColor: THREE.Color;
  sunIntensity: number;
  sunElevationDeg: number;
  sunAzimuthDeg: number;

  /** Hemisphere fill light. */
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;

  toneMappingExposure: number;
}

type SeasonKeyframeInput = Omit<
  SeasonVisualParams,
  | 'canopyColor'
  | 'groundColor'
  | 'farShoreColor'
  | 'vegetationColor'
  | 'sheddingColor'
  | 'lakeTint'
  | 'skyTop'
  | 'skyHorizon'
  | 'skyBottom'
  | 'mountainNear'
  | 'mountainFar'
  | 'fogColor'
  | 'sunColor'
  | 'hemiSky'
  | 'hemiGround'
> & {
  canopyColor: string;
  groundColor: string;
  farShoreColor: string;
  vegetationColor: string;
  sheddingColor: string;
  lakeTint: string;
  skyTop: string;
  skyHorizon: string;
  skyBottom: string;
  mountainNear: string;
  mountainFar: string;
  fogColor: string;
  sunColor: string;
  hemiSky: string;
  hemiGround: string;
};

/**
 * Hand-tuned first pass at §10's color-temperature/contrast direction per season
 * (cool high-contrast winter / pastel spring / saturated summer / warm low-angle
 * autumn). Exact hex values are the kind of "反復判断が必要な微調整" that
 * agent-workflow-policy.md §2 routes to Opus for final polish — this is the Sonnet
 * first pass the later pass will refine, not the final grade.
 */
const SEASON_KEYFRAME_INPUT: Record<SeasonId, SeasonKeyframeInput> = {
  winter: {
    id: 'winter',
    label: '冬（ベース）',
    canopyDensity: 0,
    canopyScale: 0.55,
    canopyColor: '#8a8378',
    groundColor: '#dfe8ee',
    farShoreColor: '#c7d3da',
    vegetationColor: '#e5eef2',
    vegetationDensity: 0.6,
    vegetationHeight: 0.5,
    flowerDensity: 0,
    sheddingColor: '#e8ecf0',
    sheddingSensitivity: 0,
    lakeTint: '#9fb9c9',
    skyTop: '#9fc3e8',
    skyHorizon: '#e8f1f7',
    skyBottom: '#c7d6da',
    mountainNear: '#8b9aa0',
    mountainFar: '#c3d0d6',
    fogColor: '#c9d8de',
    fogNear: 20,
    fogFar: 75,
    sunColor: '#eaf2ff',
    sunIntensity: 1.6,
    sunElevationDeg: 22,
    sunAzimuthDeg: -45,
    hemiSky: '#9fc3e8',
    hemiGround: '#7c8a8f',
    hemiIntensity: 0.7,
    toneMappingExposure: 1.0,
  },
  spring: {
    // Consolidates the former springBloom/springFall pair into one scene, the same
    // way autumn below does: a mostly-full pink canopy with petals actively
    // shedding at the same time, rather than a separate "just bloomed" notch.
    id: 'spring',
    label: '春',
    // Was 0.78 back when the canopy was thousands of tiny painted dabs (thinning
    // just softened the fine texture). With ~60 discrete generated clusters
    // (tree.ts's cluster system) that same fraction leaves visible gaps showing
    // bare branch through the canopy — most clusters need to stay lit for a full
    // bloom, with summer's 1.0 still reading fuller/denser by comparison.
    canopyDensity: 0.93,
    canopyScale: 0.92,
    canopyColor: '#f1aec4',
    groundColor: '#a6b17a',
    farShoreColor: '#82aa5f',
    vegetationColor: '#d9b67c',
    vegetationDensity: 0.92,
    vegetationHeight: 0.35,
    flowerDensity: 0.85,
    sheddingColor: '#f5b3cd',
    sheddingSensitivity: 4.6,
    lakeTint: '#bfd7df',
    skyTop: '#77b8ee',
    skyHorizon: '#e0eaef',
    skyBottom: '#d9e8d1',
    mountainNear: '#7e9a7d',
    mountainFar: '#a4bcbb',
    fogColor: '#eef1ea',
    fogNear: 27,
    fogFar: 98,
    sunColor: '#fff1df',
    sunIntensity: 2.1,
    sunElevationDeg: 44,
    sunAzimuthDeg: -39,
    hemiSky: '#bfe2ff',
    hemiGround: '#6f8f5a',
    hemiIntensity: 0.89,
    toneMappingExposure: 1.07,
  },
  summer: {
    id: 'summer',
    label: '夏',
    canopyDensity: 1.0,
    canopyScale: 1.05,
    canopyColor: '#3f9a4a',
    groundColor: '#4f9b3d',
    farShoreColor: '#3f8a38',
    vegetationColor: '#3f8a35',
    vegetationDensity: 1.0,
    vegetationHeight: 0.9,
    flowerDensity: 0,
    sheddingColor: '#ffffff',
    sheddingSensitivity: 0,
    lakeTint: '#2f7fa0',
    skyTop: '#3f8fe0',
    skyHorizon: '#bfe3f7',
    skyBottom: '#dff2e0',
    mountainNear: '#4d7a52',
    mountainFar: '#7fa39a',
    fogColor: '#cfe9e0',
    fogNear: 30,
    fogFar: 95,
    sunColor: '#fffced',
    sunIntensity: 2.9,
    sunElevationDeg: 62,
    sunAzimuthDeg: -20,
    hemiSky: '#8fd0ff',
    hemiGround: '#3f6b34',
    hemiIntensity: 1.0,
    toneMappingExposure: 1.1,
  },
  autumn: {
    // Consolidates the former autumnColor/autumnFall pair into one scene: a still
    // mostly-colorful canopy (§10's warm low-angle light) with leaves actively
    // shedding at the same time (sheddingSensitivity below), rather than picking
    // "just turned" vs. "already bare" as separate dial notches.
    id: 'autumn',
    label: '秋',
    // See spring's canopyDensity comment — same reasoning.
    canopyDensity: 0.9,
    canopyScale: 0.95,
    canopyColor: '#d0651f',
    groundColor: '#ad7936',
    farShoreColor: '#98722f',
    vegetationColor: '#bea87c',
    vegetationDensity: 0.75,
    vegetationHeight: 0.8,
    flowerDensity: 0,
    sheddingColor: '#cf7a30',
    sheddingSensitivity: 4.6,
    lakeTint: '#c08059',
    skyTop: '#e08f56',
    skyHorizon: '#f7d2a0',
    skyBottom: '#e9bc84',
    mountainNear: '#836654',
    mountainFar: '#bb9c81',
    fogColor: '#ecc9a2',
    fogNear: 21,
    fogFar: 75,
    sunColor: '#ffa860',
    sunIntensity: 1.75,
    sunElevationDeg: 16,
    sunAzimuthDeg: -56,
    hemiSky: '#e9bc84',
    hemiGround: '#725036',
    hemiIntensity: 0.76,
    toneMappingExposure: 1.0,
  },
};

function toParams(input: SeasonKeyframeInput): SeasonVisualParams {
  return {
    ...input,
    canopyColor: new THREE.Color(input.canopyColor),
    groundColor: new THREE.Color(input.groundColor),
    farShoreColor: new THREE.Color(input.farShoreColor),
    vegetationColor: new THREE.Color(input.vegetationColor),
    sheddingColor: new THREE.Color(input.sheddingColor),
    lakeTint: new THREE.Color(input.lakeTint),
    skyTop: new THREE.Color(input.skyTop),
    skyHorizon: new THREE.Color(input.skyHorizon),
    skyBottom: new THREE.Color(input.skyBottom),
    mountainNear: new THREE.Color(input.mountainNear),
    mountainFar: new THREE.Color(input.mountainFar),
    fogColor: new THREE.Color(input.fogColor),
    sunColor: new THREE.Color(input.sunColor),
    hemiSky: new THREE.Color(input.hemiSky),
    hemiGround: new THREE.Color(input.hemiGround),
  };
}

export const SEASON_KEYFRAMES: Record<SeasonId, SeasonVisualParams> = Object.fromEntries(
  SEASON_ORDER.map((id) => [id, toParams(SEASON_KEYFRAME_INPUT[id])]),
) as Record<SeasonId, SeasonVisualParams>;

export interface SeasonPhase {
  indexA: number;
  indexB: number;
  /** 0..1 blend factor from keyframe A toward keyframe B. */
  t: number;
}

/**
 * `dialPosition` is the continuous 0..6 coordinate around the 6-notch dial
 * (season-transition-animation.md §7.1) — integer part selects the keyframe,
 * fractional part is how far toward the next one. Wraps cyclically both directions.
 */
export function resolveSeasonPhase(dialPosition: number): SeasonPhase {
  const count = SEASON_ORDER.length;
  const wrapped = ((dialPosition % count) + count) % count;
  const indexA = Math.floor(wrapped);
  const t = wrapped - indexA;
  const indexB = (indexA + 1) % count;
  return { indexA, indexB, t };
}

function isColor(value: unknown): value is THREE.Color {
  return value instanceof THREE.Color;
}

/**
 * Continuously interpolated params for a given dial position. This is the smooth
 * "scrubbing" behavior; the discrete light-wave transition between adjacent notches
 * (依頼D) can choose to snap params at its own pacing instead of using this blend —
 * both read from the same SEASON_KEYFRAMES.
 */
export function sampleSeasonState(dialPosition: number): SeasonVisualParams {
  const { indexA, indexB, t } = resolveSeasonPhase(dialPosition);
  const a = SEASON_KEYFRAMES[SEASON_ORDER[indexA]];
  const b = SEASON_KEYFRAMES[SEASON_ORDER[indexB]];

  const result = { id: t < 0.5 ? a.id : b.id, label: t < 0.5 ? a.label : b.label } as Record<
    string,
    unknown
  >;

  for (const key of Object.keys(a) as (keyof SeasonVisualParams)[]) {
    if (key === 'id' || key === 'label') continue;
    const va = a[key];
    const vb = b[key];
    result[key] = isColor(va)
      ? new THREE.Color().copy(va).lerp(vb as THREE.Color, t)
      : (va as number) + ((vb as number) - (va as number)) * t;
  }

  return result as unknown as SeasonVisualParams;
}

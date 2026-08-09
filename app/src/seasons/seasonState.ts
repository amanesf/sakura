import * as THREE from 'three';

/**
 * The 6 scenes from season-transition-animation.md §2, in loop order (§2 "ループ順").
 * springFall/autumnFall are the mid-shedding "散り際" scenes, not just alternate
 * palettes — their canopyDensity below is deliberately lower than their paired
 * bloom/color scene.
 */
export type SeasonId =
  | 'winter'
  | 'springBloom'
  | 'springFall'
  | 'summer'
  | 'autumnColor'
  | 'autumnFall';

export const SEASON_ORDER: readonly SeasonId[] = [
  'winter',
  'springBloom',
  'springFall',
  'summer',
  'autumnColor',
  'autumnFall',
];

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
    canopyDensity: 0.04,
    canopyScale: 0.55,
    canopyColor: '#8a8378',
    groundColor: '#dfe8ee',
    farShoreColor: '#c7d3da',
    vegetationColor: '#e5eef2',
    vegetationDensity: 0.6,
    vegetationHeight: 0.5,
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
  springBloom: {
    id: 'springBloom',
    label: '春・満開',
    canopyDensity: 0.9,
    canopyScale: 0.95,
    canopyColor: '#f3b6c9',
    groundColor: '#8fbf6a',
    farShoreColor: '#7fae5c',
    vegetationColor: '#d9c25a',
    vegetationDensity: 0.95,
    vegetationHeight: 0.35,
    sheddingColor: '#f6c3d6',
    sheddingSensitivity: 0,
    lakeTint: '#bcd6e0',
    skyTop: '#8fc7f2',
    skyHorizon: '#fdf1f2',
    skyBottom: '#dcead2',
    mountainNear: '#7f9a72',
    mountainFar: '#a9c0be',
    fogColor: '#eef3ea',
    fogNear: 26,
    fogFar: 85,
    sunColor: '#fff2df',
    sunIntensity: 2.2,
    sunElevationDeg: 45,
    sunAzimuthDeg: -40,
    hemiSky: '#bfe2ff',
    hemiGround: '#6f8f5a',
    hemiIntensity: 0.9,
    toneMappingExposure: 1.08,
  },
  springFall: {
    id: 'springFall',
    label: '春・桜吹雪',
    canopyDensity: 0.5,
    canopyScale: 0.85,
    canopyColor: '#f0a8c0',
    groundColor: '#c8a2ac',
    farShoreColor: '#84a563',
    vegetationColor: '#d9a9ab',
    vegetationDensity: 0.9,
    vegetationHeight: 0.35,
    sheddingColor: '#f4a3c4',
    sheddingSensitivity: 4.6,
    lakeTint: '#c3d8df',
    skyTop: '#8fc7f2',
    skyHorizon: '#fbeef0',
    skyBottom: '#d7e6d0',
    mountainNear: '#7f9a72',
    mountainFar: '#a9c0be',
    fogColor: '#eef0ea',
    fogNear: 24,
    fogFar: 80,
    sunColor: '#fff0e0',
    sunIntensity: 2.0,
    sunElevationDeg: 42,
    sunAzimuthDeg: -38,
    hemiSky: '#bfe2ff',
    hemiGround: '#6f8f5a',
    hemiIntensity: 0.88,
    toneMappingExposure: 1.06,
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
  autumnColor: {
    id: 'autumnColor',
    label: '秋・紅葉',
    canopyDensity: 0.95,
    canopyScale: 1.0,
    canopyColor: '#d9622a',
    groundColor: '#b98a3f',
    farShoreColor: '#a97a35',
    vegetationColor: '#c9b98a',
    vegetationDensity: 0.8,
    vegetationHeight: 0.85,
    sheddingColor: '#e8a15c',
    sheddingSensitivity: 0,
    lakeTint: '#c98a5c',
    skyTop: '#e8a15c',
    skyHorizon: '#ffd9a0',
    skyBottom: '#f2c48a',
    mountainNear: '#8a6a4f',
    mountainFar: '#c1a488',
    fogColor: '#f0d3ad',
    fogNear: 22,
    fogFar: 78,
    sunColor: '#ffb066',
    sunIntensity: 1.9,
    sunElevationDeg: 18,
    sunAzimuthDeg: -55,
    hemiSky: '#f2c48a',
    hemiGround: '#7a5a3a',
    hemiIntensity: 0.8,
    toneMappingExposure: 1.03,
  },
  autumnFall: {
    id: 'autumnFall',
    label: '秋・落葉',
    canopyDensity: 0.32,
    canopyScale: 0.8,
    canopyColor: '#b8551f',
    groundColor: '#9c6a2f',
    farShoreColor: '#8a5f2c',
    vegetationColor: '#b09a6a',
    vegetationDensity: 0.7,
    vegetationHeight: 0.75,
    sheddingColor: '#c9702f',
    sheddingSensitivity: 4.6,
    lakeTint: '#b57a52',
    skyTop: '#d98f52',
    skyHorizon: '#f2c48a',
    skyBottom: '#e0ac72',
    mountainNear: '#7d604a',
    mountainFar: '#b39678',
    fogColor: '#e6c298',
    fogNear: 20,
    fogFar: 72,
    sunColor: '#ff9d55',
    sunIntensity: 1.6,
    sunElevationDeg: 14,
    sunAzimuthDeg: -58,
    hemiSky: '#e0ac72',
    hemiGround: '#6a4e30',
    hemiIntensity: 0.72,
    toneMappingExposure: 0.98,
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

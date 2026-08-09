import { SEASON_ORDER, type SeasonId } from './seasonState';

/**
 * Relative dwell weight per scene (proposal.md §3 "非線形な時間軸"): the beautiful
 * spring scenes get more of the dial's 360° and more auto-advance time; winter's
 * bare-tree scene passes quickly. This single weight table drives both the physical
 * notch spacing on the dial (§7.1) and the auto-advance pacing (§7) — they're the
 * same underlying "gearing," not two separate systems to keep in sync.
 */
const SEASON_WEIGHTS: Record<SeasonId, number> = {
  winter: 0.7,
  springBloom: 1.5,
  springFall: 1.3,
  summer: 0.9,
  autumnColor: 1.1,
  autumnFall: 0.9,
};

const TOTAL_WEIGHT = SEASON_ORDER.reduce((sum, id) => sum + SEASON_WEIGHTS[id], 0);

/** Cumulative fraction (0..1) of the dial's circumference where each notch sits. */
const NOTCH_FRACTIONS: number[] = (() => {
  const fractions: number[] = [0];
  let acc = 0;
  for (const id of SEASON_ORDER) {
    acc += SEASON_WEIGHTS[id] / TOTAL_WEIGHT;
    fractions.push(acc);
  }
  return fractions;
})();

function wrap01(x: number): number {
  return ((x % 1) + 1) % 1;
}

/** Angle-fraction (0..1 around the physical dial) for each of the 6 notches, in
 *  loop order — for drawing tick marks at their true (non-uniform) positions. */
export function getNotchAngleFractions(): readonly number[] {
  return NOTCH_FRACTIONS.slice(0, SEASON_ORDER.length);
}

/**
 * Converts a physical dial angle (0..1 fraction of one full turn) into the
 * continuous `dialPosition` (0..6) that seasonState.ts's sampleSeasonState expects.
 */
export function dialPositionFromAngleFraction(angleFraction: number): number {
  const f = wrap01(angleFraction);
  let i = 0;
  while (i < SEASON_ORDER.length - 1 && f >= NOTCH_FRACTIONS[i + 1]) i++;
  const segStart = NOTCH_FRACTIONS[i];
  const segEnd = NOTCH_FRACTIONS[i + 1];
  const t = segEnd > segStart ? (f - segStart) / (segEnd - segStart) : 0;
  return i + t;
}

/** Inverse of `dialPositionFromAngleFraction` — used to place the knob/ticks. */
export function angleFractionFromDialPosition(dialPosition: number): number {
  const count = SEASON_ORDER.length;
  const wrapped = ((dialPosition % count) + count) % count;
  const i = Math.floor(wrapped);
  const t = wrapped - i;
  const segStart = NOTCH_FRACTIONS[i];
  const segEnd = NOTCH_FRACTIONS[i + 1];
  return wrap01(segStart + t * (segEnd - segStart));
}

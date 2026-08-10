import * as THREE from 'three';
import { SEASON_KEYFRAMES, SEASON_ORDER } from './seasonState';

const SEASON_COUNT = SEASON_ORDER.length;

/** Total wave duration (season-transition-animation.md §3.1: "ごく短時間（1〜2秒程度）"). */
const TRANSITION_DURATION = 1.6;
/**
 * Fraction of the transition at which the actual season params hard-swap
 * (season-transition-animation.md §3: "波が通り過ぎたらもう次の季節になっていた").
 * This sits inside the "暗転の縁" stage where the wave shader's coverage/vignette is
 * near its peak, so the swap is hidden rather than seen.
 */
const SNAP_AT_PROGRESS = 0.62;

export interface ActiveWave {
  fromIndex: number;
  toIndex: number;
  /** 0..1 across the whole transition, stages per §3.1: 発生→浸食 (0-0.35),
   *  浸食→暗転の縁 (0.35-0.62), 収束 (0.62-1). */
  progress: number;
}

export interface TransitionRenderState {
  /** The only index whose keyframe should currently be rendered (always a pure
   *  keyframe, never blended — season-transition-animation.md never shows an
   *  in-between state, only the wave overlay implies motion between them). */
  committedSeasonIndex: number;
  wave: ActiveWave | null;
}

function shortestStep(fromIndex: number, toIndex: number): 1 | -1 {
  const forward = (toIndex - fromIndex + SEASON_COUNT) % SEASON_COUNT;
  const backward = SEASON_COUNT - forward;
  return forward <= backward ? 1 : -1;
}

/** Warm, glowing version of the destination season's canopy hue — the doc's "粒子の
 *  色は遷移先の季節によって変える" (§3.1), reusing SEASON_KEYFRAMES instead of
 *  inventing a parallel palette. */
export function getWaveColor(seasonIndex: number): THREE.Color {
  const id = SEASON_ORDER[((seasonIndex % SEASON_COUNT) + SEASON_COUNT) % SEASON_COUNT];
  return SEASON_KEYFRAMES[id].canopyColor.clone().lerp(new THREE.Color('#ffffff'), 0.4);
}

interface InternalActiveWave {
  fromIndex: number;
  toIndex: number;
  elapsed: number;
  snapped: boolean;
}

/**
 * Owns the "which scene is actually committed right now" state (依頼D). The dial
 * (依頼C) can move continuously/freely; this controller only ever steps the
 * rendered scene one adjacent notch at a time, each step wrapped in a light-wave
 * transition (season-transition-animation.md §3.1), chaining further steps
 * automatically if the dial has moved further than one notch away.
 */
export class SceneTransitionController {
  committedIndex = 0;
  private active: InternalActiveWave | null = null;

  update(dt: number, desiredContinuousPosition: number): TransitionRenderState {
    const desiredIndex = Math.floor(
      ((desiredContinuousPosition % SEASON_COUNT) + SEASON_COUNT) % SEASON_COUNT,
    );

    if (!this.active && desiredIndex !== this.committedIndex) {
      const step = shortestStep(this.committedIndex, desiredIndex);
      const toIndex = (this.committedIndex + step + SEASON_COUNT) % SEASON_COUNT;
      this.active = { fromIndex: this.committedIndex, toIndex, elapsed: 0, snapped: false };
    }

    if (!this.active) {
      return { committedSeasonIndex: this.committedIndex, wave: null };
    }

    this.active.elapsed += dt;
    const progress = Math.min(1, this.active.elapsed / TRANSITION_DURATION);

    if (!this.active.snapped && progress >= SNAP_AT_PROGRESS) {
      this.committedIndex = this.active.toIndex;
      this.active.snapped = true;
    }

    const wave: ActiveWave = {
      fromIndex: this.active.fromIndex,
      toIndex: this.active.toIndex,
      progress,
    };

    if (progress >= 1) {
      this.active = null;
    }

    return { committedSeasonIndex: this.committedIndex, wave };
  }
}

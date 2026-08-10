/**
 * Shared contract for the "time field" that drives all ambient sway and the
 * petal/leaf detach-and-fall transition (season-transition-animation.md §4). Fixed
 * early per agent-workflow-policy.md §5 so downstream subsystems can code against a
 * stable API.
 *
 * `sampleTimeField` (依頼B) is the ambient idle component: always-on, low-level
 * wobble (§4 "フィールド強度は常に低いレベルで有効"). 依頼D's transition wave and
 * 依頼E's shedding climax both layer temporary spikes on top of this baseline by
 * summing into the same `strength` value — they are not implemented yet, so today
 * the field never exceeds its idle range.
 */
export interface TimeFieldState {
  /** Ambient sway strength, roughly 0..1 (can briefly exceed 1 during transition-wave
   *  or shedding-climax spikes, §3.1 / §9 "転"). ~0.12 at rest. */
  strength: number;
}

export const TIME_FIELD_BASELINE = 0.12;

/** Field strength above which an attached petal/leaf instance detaches and starts
 *  falling instead of swaying in place (§4 table, row "花びら・葉（散る要素）"). */
export const LEAF_DETACH_THRESHOLD = 0.55;

export type LeafMotionState = 'attached' | 'falling';

/**
 * Per-instance threshold jitter keeps every petal/leaf from detaching in perfect
 * unison. Callers pass each instance's own stable random offset, baked once at
 * spawn time (see tree.ts's `densityKey` for the equivalent pattern used by 依頼A').
 */
export function resolveLeafMotionState(
  fieldStrength: number,
  instanceDetachBias: number,
): LeafMotionState {
  return fieldStrength + instanceDetachBias > LEAF_DETACH_THRESHOLD ? 'falling' : 'attached';
}

/**
 * Ambient idle field: a slow drift plus a slightly faster secondary ripple so the
 * baseline itself breathes instead of sitting at a dead-flat constant. Spatial
 * variation (the wave actually sweeping across the screen) is 依頼D's job — this is
 * the temporal-only component every layer reads at rest.
 */
export function sampleTimeField(elapsedSeconds: number): TimeFieldState {
  const drift = Math.sin(elapsedSeconds * 0.17) * 0.05 + Math.sin(elapsedSeconds * 0.053 + 1.3) * 0.03;
  return { strength: Math.max(0, TIME_FIELD_BASELINE + drift) };
}

/**
 * Shared contract for the "time field" that drives all ambient sway and the
 * petal/leaf detach-and-fall transition (season-transition-animation.md §4). This is
 * fixed early per agent-workflow-policy.md §5 so downstream subsystems can code
 * against the final shape of the API before it has a real implementation.
 *
 * 依頼B owns the real time-varying field (ambient idle sway + transition-wave spikes).
 * Until then, `sampleBaselineTimeField` returns a stable low value so 依頼C/D/E can
 * already consume this module.
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

/** Placeholder source until 依頼B implements the real spatial/temporal field. */
export function sampleBaselineTimeField(): TimeFieldState {
  return { strength: TIME_FIELD_BASELINE };
}

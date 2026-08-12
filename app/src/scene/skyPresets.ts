import * as THREE from 'three';

/**
 * The sky patterns the console can switch between.
 *
 * scene/cloudField.ts already has one number that decides what kind of sky it
 * is — `weatherAt(simTime)`, 0 for a clear day and 1 for about to rain — and
 * every tier's cloud amount is a function of it. A preset is therefore not a
 * separate cloud system: it is a *window* onto that one axis, plus a per-tier
 * nudge for the things the axis alone does not separate.
 *
 * That is deliberate. The alternative — a hand-built arrangement per preset —
 * would need its own coverage figures, and those figures are the ones that were
 * solved band by band against the reference image (handoff.md §1). Reusing the
 * axis keeps every preset standing on that fit.
 *
 * Both presets still *move*: the weather keeps oscillating inside the window,
 * so a cumulonimbus sky builds and relaxes rather than sitting at one cloud
 * amount forever.
 */
export interface SkyPreset {
  label: string;
  /** Where in the weather axis this sky lives. `osc` is the raw oscillator in
   * [0,1] (scene/cloudField.ts weatherOscillation), so a preset picks a range
   * rather than a value and the sky still changes its mind inside it. */
  weatherLo: number;
  weatherHi: number;
  /** Multiplier on a tier's own coverage, by tier name. The weather axis moves
   * every layer together, which is right for a front coming through but cannot
   * express "clear overhead, but the high cloud is busy" — the classic fair
   * summer day, and exactly the sky asked for here. */
  coverageScale?: Record<string, number>;
}

export const SKY_PRESETS = {
  /**
   * The reference image's own sky, and the app's default: a summer afternoon
   * with cumulonimbus standing in a low deck.
   *
   * The window is 0.42-0.70 rather than the raw oscillator's full 0.19-0.94.
   * The tower tier only starts appearing at 0.30 and begins spreading back into
   * a deck above 0.75, so the untrimmed range spent part of its time with no
   * towers at all — a "cumulonimbus" button that sometimes shows none is a
   * broken button. Inside this window the tower coverage runs 0.47 to 1.0, so
   * there are always towers and still a visible difference between a quiet hour
   * and an active one.
   */
  cumulonimbus: {
    label: '積乱雲',
    weatherLo: 0.42,
    weatherHi: 0.70,
  },
  /**
   * A fair day: no towers, little low cloud, and the sky's activity moved
   * upstairs — a distant bank along the horizon, patches of altocumulus, and
   * cirrus drawing across the top at four times the surface wind.
   *
   * Held at 0.06-0.16, which zeroes the towers and all but empties the two deck
   * tiers on the weather axis alone. Two scales do the rest:
   *
   *  - cumulus 0.30. The fair-weather cumulus tier is at its *most* covered on
   *    a clear day (0.95 - 0.35w by design — they are the clear day's cloud),
   *    and left alone it fills the lower sky with popcorn, which is not what
   *    "快晴" looks like. Thinned to scattered.
   *  - altocumulus 2.4 and cirrus 1.8. These sit at their floor when the
   *    weather axis is this low, because the axis reads them as "nothing is
   *    coming". But a blue sky with high cirrus is the classic fair summer sky,
   *    and high cloud is the one thing that should be *busy* here — it is what
   *    is left to watch once the low sky is empty.
   */
  clear: {
    label: '快晴',
    weatherLo: 0.06,
    weatherHi: 0.16,
    coverageScale: { cumulus: 0.30, altocumulus: 2.4, cirrus: 1.8 },
  },
} satisfies Record<string, SkyPreset>;

export type SkyPresetName = keyof typeof SKY_PRESETS;

export const DEFAULT_PRESET: SkyPresetName = 'cumulonimbus';

export function isPresetName(value: string | null): value is SkyPresetName {
  return value !== null && Object.prototype.hasOwnProperty.call(SKY_PRESETS, value);
}

/** Coverage multiplier for a tier under a preset. */
export function coverageScaleFor(preset: SkyPreset, tierName: string): number {
  return preset.coverageScale?.[tierName] ?? 1;
}

/** Map the raw oscillator into a preset's window. */
export function weatherFor(preset: SkyPreset, oscillation: number): number {
  return THREE.MathUtils.lerp(preset.weatherLo, preset.weatherHi, oscillation);
}

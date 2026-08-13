/**
 * The scenes: which painted plate is in front of the sky, and where its horizon
 * is.
 *
 * Everything in this project is anchored to one 1408x768 frame (core/frame.ts),
 * and at first that frame was also one *picture*. A further illustration does
 * not change the frame — all of them are 1408x768 and all are keyed by
 * scripts/plate.js — but it does change three things that were constants:
 *
 *  - which plate texture is composited (effects/plateShader.ts),
 *  - where the painted horizon sits, which is what the horizon haze band is
 *    hung from (effects/horizonHaze.ts),
 *  - and how far up the camera is looking, because a picture painted from under
 *    an open shelter puts its horizon much lower in frame than one painted from
 *    inside a classroom, and the rendered sky has to agree with the painting it
 *    is seen through.
 *
 * Scene 1 keeps every number it has always had, exactly. It is the frame every
 * statistic in this project was fitted and measured against (scripts/README.md),
 * and it is the default, so adding scenes beside it changes no measurement.
 */
export interface SceneDef {
  /** URL value (`?scene=`) and localStorage key. */
  key: string;
  /** What the console button says. */
  label: string;
  /** Plate asset, relative to app/public. */
  plate: string;
  /**
   * The painted horizon's row in the 1408x768 frame, and the top of the haze
   * band above it. Measured off the keyed image: the lowest keyed row per
   * column, which is exactly where the artist's sky stops.
   */
  horizonRow: number;
  hazeTopRow: number;
  /**
   * Where the *rendered* horizon is put, as a fraction of frame height, from
   * which core/camera.ts solves the pitch by exact pinhole projection.
   *
   * Deliberately not the painted horizon row. Scene 1 was fitted at 0.72
   * against a painted horizon at 593/768 = 0.772 — the rendered horizon sits a
   * little above the painted one, so the haze band and the distant cloud banks
   * have somewhere to be, rather than being cut off exactly at the hills.
   * Scene 2 keeps the same relationship: its painted horizon is at 681/768 =
   * 0.887, so this is 0.887 - 0.052.
   */
  cameraHorizonFraction: number;
  /**
   * How much rain falls *in front of* the illustration, 0-1
   * (effects/nearRain.ts).
   *
   * The main rain pass runs before the plate, which confines it to the pixels
   * the painting leaves transparent. For scene 1 that is exactly right: there
   * is a window between the viewer and the weather, so rain has no business
   * being on this side of it.
   *
   * For scenes 2 and 3 it is a structural falsehood. 軒下 and バス停 are both
   * *outdoors* — the viewer is standing under a roof with no glass anywhere,
   * and the near rain that should be crossing in front of the eaves, the
   * guardrail and the bench is missing entirely. What that produced was a hard
   * silhouette edge where every streak stopped dead at the painted geometry:
   * the picture read as a sheet of rain slipped in behind a paper cut-out.
   *
   * Not 1.0 even outdoors, because the viewer is under cover: what crosses the
   * foreground is what blows in past the roofline, not the full column. Scene 3
   * is the more open of the two — a bus shelter's side is nearly all air, where
   * the eaves of 軒下 reach further out.
   */
  foregroundRain: number;
}

export const SCENES: SceneDef[] = [
  {
    key: '1',
    label: '窓辺',
    plate: 'plate.webp',
    // The painted sea horizon at y=593 of the 1408x768 frame, with the haze
    // band reaching about 100px above it. Both measured.
    horizonRow: 593,
    hazeTopRow: 470,
    cameraHorizonFraction: 0.72,
    // Behind glass. The one scene where "no rain in front of the plate" is the
    // truth rather than a limitation.
    foregroundRain: 0,
  },
  {
    key: '2',
    label: '軒下',
    plate: 'plate2.webp',
    // Measured the same way off 1786575481846.png: the sea horizon runs at
    // y=681 across the open span, rising to ~641 where the hills come in on the
    // left. The haze band keeps scene 1's 123-row depth.
    horizonRow: 681,
    hazeTopRow: 558,
    cameraHorizonFraction: 0.835,
    foregroundRain: 0.7,
  },
  {
    key: '3',
    label: 'バス停',
    plate: 'plate3.webp',
    // Measured the same way off scene3-keyed.png. This frame keys 54.6% of
    // itself — the widest opening of the three — and 365 of its 1408 columns
    // are keyed all the way to the frame's bottom edge, because under the
    // shelter's guardrail the artist's sky runs off the bottom of the picture
    // rather than meeting anything. So the painted horizon is taken from the
    // 411 columns that *do* end on sea or hill: their lowest keyed row has a
    // median of 748 and a spread of 734-766. The haze band keeps scene 1's
    // 123-row depth, and the rendered horizon keeps the same 0.052 lift above
    // the painted one: 748/768 = 0.974, less 0.052.
    horizonRow: 748,
    hazeTopRow: 625,
    cameraHorizonFraction: 0.922,
    foregroundRain: 0.9,
  },
];

export const DEFAULT_SCENE = 0;

/** Index for a `?scene=` value, or the default when it names nothing. */
export function sceneIndexFor(key: string | null | undefined): number {
  const found = SCENES.findIndex((s) => s.key === key);
  return found < 0 ? DEFAULT_SCENE : found;
}

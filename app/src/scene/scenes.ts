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
  },
];

export const DEFAULT_SCENE = 0;

/** Index for a `?scene=` value, or the default when it names nothing. */
export function sceneIndexFor(key: string | null | undefined): number {
  const found = SCENES.findIndex((s) => s.key === key);
  return found < 0 ? DEFAULT_SCENE : found;
}

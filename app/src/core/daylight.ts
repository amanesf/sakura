import * as THREE from 'three';
import { SUN_AZIMUTH_DEG } from './solarPosition';

/**
 * The time of day, as everything the rest of the scene needs to know about it:
 * where the sun is, and what colour its light and the sky's light have become.
 *
 * The sky itself does not need the colours — scene/sky.ts integrates real
 * atmospheric scattering, so pointing its sun at the horizon turns it orange on
 * its own. What does need them is everything that is *not* solved from physics:
 * the cloud ramp (measured off a midday reference image, cloudRamp.ts) and the
 * painted illustration (a midday painting). Both are fixed midday artefacts, so
 * a sunset has to be applied to them as an illuminant.
 *
 * Everything here is identity at noon by construction — `CLOCK_START_HOUR`
 * returns exactly white tints and the fitted 55° sun. That is not a convenience:
 * it is what keeps every measured statistic in this project valid, since the
 * measure loop captures at noon.
 */

/** The slider's ends: midday to just after the sun has gone. */
export const CLOCK_START_HOUR = 12;
export const CLOCK_END_HOUR = 19;

/**
 * Solar elevation against the clock.
 *
 * Not a straight line. The sun loses altitude slowly through the afternoon and
 * then falls off a cliff in the last hour, and a linear ramp gets that visibly
 * wrong — it would put the sky into sunset colours by mid-afternoon. The
 * keyframes are shaped so the interesting hour is the last one, which is also
 * where the slider should feel like it is doing the most.
 *
 * 12:00 is pinned at 55°, the elevation the reference image's key light was
 * measured at (core/solarPosition.ts). It must stay there.
 */
const CLOCK_KEYFRAMES: { hour: number; elevationDeg: number }[] = [
  { hour: 12, elevationDeg: 55 },
  { hour: 15, elevationDeg: 42 },
  { hour: 17, elevationDeg: 25 },
  { hour: 18, elevationDeg: 12 },
  { hour: 18.75, elevationDeg: 1 },
  { hour: 19, elevationDeg: -2.5 },
];

export function sunElevationAtHour(hour: number): number {
  const h = THREE.MathUtils.clamp(hour, CLOCK_START_HOUR, CLOCK_END_HOUR);
  for (let i = 0; i < CLOCK_KEYFRAMES.length - 1; i++) {
    const a = CLOCK_KEYFRAMES[i];
    const b = CLOCK_KEYFRAMES[i + 1];
    if (h >= a.hour && h <= b.hour) {
      return THREE.MathUtils.lerp(
        a.elevationDeg,
        b.elevationDeg,
        THREE.MathUtils.smoothstep(h, a.hour, b.hour),
      );
    }
  }
  return CLOCK_KEYFRAMES[CLOCK_KEYFRAMES.length - 1].elevationDeg;
}

/** Unit vector toward the sun for a given elevation. Azimuth is fixed: the
 * camera never yaws, so the sun only rises and sets in this scene. */
export function sunDirectionAtElevation(elevationDeg: number): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const azimuth = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  const cosEl = Math.cos(elevation);
  return new THREE.Vector3(
    Math.sin(azimuth) * cosEl,
    Math.sin(elevation),
    -Math.cos(azimuth) * cosEl,
  ).normalize();
}

/**
 * Rayleigh optical depth of the whole atmosphere at the zenith, per RGB — the
 * standard sea-level values (β ≈ 5.8/13.5/33.1 ×10⁻⁶ per metre over an 8km
 * scale height). Blue is scattered out of the direct beam nearly six times as
 * hard as red, which is the entire reason a low sun is orange.
 */
const ZENITH_TAU = new THREE.Vector3(0.0464, 0.108, 0.2648);

/** Kasten-Young air mass: how many zenith atmospheres the direct beam crosses
 * at a given elevation. 1.22 at the fitted midday sun, 26 at the horizon. */
function airMass(elevationDeg: number): number {
  const h = Math.max(elevationDeg, -1.5);
  return 1 / (Math.sin(THREE.MathUtils.degToRad(h)) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}

const NOON_AIR_MASS = airMass(sunElevationAtHour(CLOCK_START_HOUR));

export interface Daylight {
  elevationDeg: number;
  sunDir: THREE.Vector3;
  /** Colour of the light falling on the *lit* side of a cloud. Luminance-
   * normalised and then scaled by how much light is left, so it carries hue and
   * brightness but not the ramp's own colour. */
  sunTint: THREE.Color;
  /** The same for the *shadow* side, which is lit by the sky dome rather than
   * the sun. Separating the two is what makes an evening cloud read as an
   * evening cloud instead of a cloud with an orange filter over it. */
  skyTint: THREE.Color;
  /** How far to move the clouds from their measured midday colours toward
   * those illuminants. 0 at noon. See cloudShader.ts for why this is a blend
   * toward a relit colour rather than a multiply. */
  blend: number;
  /** Multiplier for the painted plate, which is a midday painting. */
  plateTint: THREE.Color;
}

const white = () => new THREE.Color(1, 1, 1);

const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);
const luminance = (c: THREE.Color) => c.r * LUMA.x + c.g * LUMA.y + c.b * LUMA.z;

/** Scale a colour so its luminance is exactly 1, leaving only its hue. How
 * bright the light is then becomes a separate, deliberate decision instead of
 * falling out of the extinction maths — the raw transmittance at the horizon is
 * near zero and would simply render everything black. */
function normaliseLuminance(c: THREE.Color): void {
  c.multiplyScalar(1 / Math.max(luminance(c), 1e-6));
}

/** Move a colour toward its own grey. */
function desaturate(c: THREE.Color, keep: number): void {
  const g = luminance(c);
  c.setRGB(
    THREE.MathUtils.lerp(g, c.r, keep),
    THREE.MathUtils.lerp(g, c.g, keep),
    THREE.MathUtils.lerp(g, c.b, keep),
  );
}

export function daylightAtHour(hour: number): Daylight {
  const elevationDeg = sunElevationAtHour(hour);
  const sunDir = sunDirectionAtElevation(elevationDeg);

  // Hue of the direct beam: extra Rayleigh extinction relative to noon. Divided
  // through by its own brightest channel so this carries *colour only* — the
  // raw transmittance at the horizon is about 0.001 in blue and would render
  // the clouds black. How dark it gets is a separate decision below, because
  // the eye (and this renderer's fixed exposure) adapts and a real sunset cloud
  // is bright orange, not nearly black.
  const extraMass = Math.max(airMass(elevationDeg) - NOON_AIR_MASS, 0);
  const beam = new THREE.Color(
    Math.exp(-ZENITH_TAU.x * extraMass),
    Math.exp(-ZENITH_TAU.y * extraMass),
    Math.exp(-ZENITH_TAU.z * extraMass),
  );
  // Pulled back off the pure physical result. At 2 degrees of elevation the
  // beam's blue channel is genuinely down at 2% of its red, and a light that
  // saturated turns cloud crowns into flat yellow: the direct beam is not the
  // only thing lighting them, and multiple scattering inside a cloud fills the
  // short end back in. 0.7 keeps the hue firmly orange with the blue channel
  // still alive.
  desaturate(beam, 0.7);
  normaliseLuminance(beam);

  // How much light is left. Held flat through the afternoon and dropped over
  // the last few degrees, which is where the change actually happens.
  const sunUp = THREE.MathUtils.smoothstep(elevationDeg, -2.5, 9);
  const lit = THREE.MathUtils.lerp(0.2, 1, sunUp);

  const sunTint = beam.multiplyScalar(lit);

  const dusk = 1 - THREE.MathUtils.smoothstep(elevationDeg, 2, 30);

  // The shadow side is lit by the sky dome, so it cools as the dome loses its
  // warm end — and it darkens further than the lit side does. A *grey*-violet,
  // not a saturated blue: the cloud ramp's own shadow end is already a strong
  // cerulean, and a vivid blue illuminant on top of it produced clouds the
  // colour of ink.
  const skyTint = white().lerp(new THREE.Color(0.62, 0.66, 0.82), dusk);
  normaliseLuminance(skyTint);
  skyTint.multiplyScalar(THREE.MathUtils.lerp(1, 0.34, dusk));

  // Nothing happens at all until the sun is low enough for it to. Above 30
  // degrees the measured midday ramp is simply correct.
  const blend = 0.88 * dusk;

  // The illustration is one painting made at midday, so it cannot relight
  // itself. Tinting it is the only way the room can belong to the same evening
  // as the sky behind it — without this, the window turns orange and the girl
  // stays lit for noon, which reads as a compositing error rather than a time
  // of day. Kept weaker than the cloud tint: an interior loses the sun earlier
  // and more evenly than a cloud top does, and pushing a painted midday scene
  // too far just looks like a colour cast.
  const plateTint = white()
    .lerp(new THREE.Color(1.0, 0.82, 0.72), dusk * 0.75)
    .multiplyScalar(THREE.MathUtils.lerp(1, 0.42, dusk));

  return { elevationDeg, sunDir, sunTint, skyTint, blend, plateTint };
}

/**
 * The cloud key light for a given sun elevation.
 *
 * The base vector is art-directed rather than astronomical (see main.ts) and it
 * is fitted, so it may not simply be replaced by the sun direction. What
 * changes with the hour is its *height*: the horizontal bearing is held exactly
 * so the lateral modelling the fit produced is preserved, and only the
 * elevation is driven down as the sun sets, which is what turns overhead light
 * into raking light across the cloud tops.
 *
 * Swinging the bearing toward the true sun instead was the obvious alternative
 * and is wrong here: the art-directed light comes from the left and the scene's
 * sun sits to the right, so interpolating between them drags the key light
 * across the camera axis — through exactly the flat-light configuration that
 * main.ts documents having already fixed once.
 */
export function cloudLightForElevation(base: THREE.Vector3, elevationDeg: number): THREE.Vector3 {
  const horizontal = Math.hypot(base.x, base.z);
  if (horizontal < 1e-6) return base.clone();
  const baseElevation = Math.atan2(base.y, horizontal);
  const noonElevation = THREE.MathUtils.degToRad(sunElevationAtHour(CLOCK_START_HOUR));
  const sunElevation = THREE.MathUtils.degToRad(elevationDeg);
  // Proportional, so the key light is exactly `base` at noon and flattens onto
  // the horizon as the sun does.
  const elevation = baseElevation * (sunElevation / noonElevation);
  const cos = Math.cos(elevation);
  return new THREE.Vector3(
    (base.x / horizontal) * cos,
    Math.sin(elevation),
    (base.z / horizontal) * cos,
  ).normalize();
}

export function formatClock(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

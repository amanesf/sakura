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

/**
 * Where the sun is in bearing, as the afternoon goes on.
 *
 * It used to be fixed at 55 degrees, and that one number was quietly costing
 * the entire sunset. The frame is 81 degrees wide, so only +-40.5 degrees off
 * the view axis is ever on screen: at 55 the sun is off the right edge at every
 * hour, sky.ts's sun disc has never once been visible, and everything a sunset
 * is actually made of — the disc, the glare around it, cloud edges lit from
 * behind — was structurally unavailable. What was left was colour, which is why
 * it came out as "the midday picture, tinted".
 *
 * So the bearing swings toward the window as the sun drops, reaching 22 degrees
 * by seven o'clock — inside the frame, low and to the right. It stays exactly at
 * 55 at noon, which is the reference image's own measured key light, so nothing
 * fitted moves.
 *
 * Physically a real sun's azimuth does swing through the afternoon; it just
 * swings the other way in this hemisphere. This is the one place in the file
 * where the composition wins over the almanac, and it wins because the whole
 * scene is a fixed shot out of one window: the sun has to come to the window,
 * because the window cannot turn to the sun.
 */
export function sunAzimuthAtHour(hour: number): number {
  const t = THREE.MathUtils.smoothstep(
    THREE.MathUtils.clamp(hour, CLOCK_START_HOUR, CLOCK_END_HOUR),
    14,
    CLOCK_END_HOUR,
  );
  return THREE.MathUtils.lerp(SUN_AZIMUTH_DEG, 22, t);
}

/** Unit vector toward the sun. */
export function sunDirectionAtElevation(elevationDeg: number, azimuthDeg = SUN_AZIMUTH_DEG): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
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
  /** 0 in full day, 1 once the sun is on the horizon. The single "how late is
   * it" number the rest of the scene keys off. */
  dusk: number;
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
  const sunDir = sunDirectionAtElevation(elevationDeg, sunAzimuthAtHour(hour));

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

  return { elevationDeg, sunDir, sunTint, skyTint, blend, dusk, plateTint };
}

/**
 * The cloud key light for an hour.
 *
 * Two things happen to it, in this order.
 *
 * First the elevation is driven down in proportion to the sun's, keeping the
 * fitted bearing: that alone turns overhead light into raking light across the
 * cloud tops, and it is exactly the art-directed vector at noon.
 *
 * Then, as dusk comes on, it is swung toward the sun itself. This was
 * deliberately *not* done while the sun was off-frame — a key light that
 * disagrees with an invisible sun costs nothing, and the fitted bearing was
 * worth more. Now that the sun comes into frame in the evening
 * (sunAzimuthAtHour), a cloud lit from the left with the sun visible on the
 * right is simply wrong, and the disagreement is the first thing the eye finds.
 *
 * The interpolation is safe here even though main.ts documents a flat-light
 * disaster from pointing the key light down the camera axis: both vectors point
 * *away* from the camera (the fitted one has z = -0.44, the evening sun about
 * -0.93), so the path between them stays beyond the cloud. It passes through
 * "directly behind", which is backlight — the thing an evening sky is for.
 */
export function cloudLightForDay(base: THREE.Vector3, day: Daylight): THREE.Vector3 {
  const horizontal = Math.hypot(base.x, base.z);
  if (horizontal < 1e-6) return base.clone();
  const baseElevation = Math.atan2(base.y, horizontal);
  const noonElevation = THREE.MathUtils.degToRad(sunElevationAtHour(CLOCK_START_HOUR));
  const sunElevation = THREE.MathUtils.degToRad(day.elevationDeg);
  const elevation = baseElevation * (sunElevation / noonElevation);
  const cos = Math.cos(elevation);
  const flattened = new THREE.Vector3(
    (base.x / horizontal) * cos,
    Math.sin(elevation),
    (base.z / horizontal) * cos,
  ).normalize();
  return flattened.lerp(day.sunDir, day.dusk).normalize();
}

/**
 * Relight a colour that was chosen for midday.
 *
 * The same operation the cloud shader performs per fragment — keep how bright
 * the thing is, take the hour's colour — but on the CPU, for the handful of
 * fixed constants that live outside the cloud material. `lit` picks where
 * between the shadow and the lit illuminant the surface sits.
 *
 * At noon `blend` is 0 and this returns the colour unchanged.
 */
export function relightForDay(base: THREE.Color, day: Daylight, lit: number): THREE.Color {
  const illum = day.skyTint.clone().lerp(day.sunTint, lit);
  const lum = luminance(base);
  return base.clone().lerp(new THREE.Color(lum * illum.r, lum * illum.g, lum * illum.b), day.blend);
}

export function formatClock(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

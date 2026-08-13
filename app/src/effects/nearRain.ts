import * as THREE from 'three';

/**
 * The rain on *this* side of the picture — the drops that cross in front of the
 * eaves, the guardrail and the bench, rather than falling in the sky behind
 * them.
 *
 * This is the one pass in the chain that runs after effects/plateShader.ts, and
 * that ordering is the entire reason it exists as a separate pass rather than as
 * a few more lines in effects/rainShader.ts.
 *
 * The main rain pass is masked structurally: it runs immediately before the
 * plate, so the illustration is composited over it and rain survives only where
 * the painting is transparent. For scene 1 (窓辺) that is exactly right — there
 * is glass between the viewer and the weather. For scenes 2 and 3 it is a
 * structural falsehood, because 軒下 and バス停 are outdoors. Standing under a
 * shelter you are *inside* the rain: it crosses the foreground, in front of
 * everything, and the fact that it did not was visible as a hard silhouette
 * edge where every streak in the sky stopped dead against the painted geometry.
 * The picture read as a sheet of rain slipped in behind a paper cut-out, and no
 * tuning of the pass behind the plate could have fixed it, because the missing
 * rain was on the other side.
 *
 * The plate shader's docstring says nothing may run after it, and this does not
 * break that rule so much as fall outside it. What that rule protects the plate
 * from is the *filters* — Kuwahara, macro contrast, the grade — which exist to
 * push a 3D render toward illustration and would soften the girl's linework if
 * they were let near it. This pass filters nothing: it draws objects in front of
 * the painting, which is what an object in front of the painting looks like.
 *
 * Deliberately very sparse and very soft. Near rain in a photograph is not more
 * streaks, it is *fewer and much bigger* ones: a drop two metres from the lens
 * is far outside the depth of field, so it arrives as a pale, wide, barely-there
 * smear crossing the whole frame in a fraction of a second. Drawing near rain as
 * a lot of crisp lines is how a foreground rain layer turns into a scratched
 * print — the same failure the sky pass had, at ten times the size.
 *
 * Identity when uNearRain * uRain is zero, and core/postFx.ts disables it
 * outright there, so scene 1 and every dry frame are untouched.
 */
export const NearRainShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0-1, the same slider the sky rain is on. */
    uRain: { value: 0 },
    /** Real seconds — the drops' own clock, shared with effects/rainShader.ts's
     * uRainTime for the reason documented there. */
    uRainTime: { value: 0 },
    uAspect: { value: 1 },
    /**
     * How open this scene's foreground is (scene/scenes.ts's foregroundRain).
     * Zero indoors, which is what keeps 窓辺 dry on the near side of its glass.
     */
    uNearRain: { value: 0 },
    /**
     * The ambient sky, in display-space sRGB as it appears *after* the rain
     * pass has darkened the frame — core/postFx.ts feeds this the same relit
     * horizon-band colour the haze uses, scaled by the rain's own exposure cut.
     *
     * A foreground drop needs it because a foreground drop is not a lens onto
     * what is behind it, which is what the sky pass's streaks are. It is two
     * metres from the eye and images most of the hemisphere, so what it carries
     * is the ambient light of the sky, and that is why a near drop is bright
     * against a dark eave and invisible against the sky itself.
     *
     * Sampling upward the way the sky pass does gives the opposite answer here,
     * and gives it silently: a drop crossing the shelter roof samples more
     * shelter roof, comes out exactly as dark as the roof, and disappears.
     * Measured over scene 3's roof strip, the first version changed 0.5% of the
     * pixels by at most 4 levels — the foreground rain was, in the only place it
     * exists to be seen, not there.
     */
    uSkyColor: { value: new THREE.Vector3(0.66, 0.78, 0.86) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uRain;
    uniform float uRainTime;
    uniform float uAspect;
    uniform float uNearRain;
    uniform vec3 uSkyColor;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float vnoise2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
        mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x),
        f.y);
    }

    // The same gust field the sky is on — see effects/rainShader.ts's gustAt.
    // Duplicated rather than shared because the two passes are separate
    // programs; the constants must be kept in step, and the reason they must is
    // that a squall crossing the sky while the foreground rain holds steady
    // would say plainly that the two are different weather.
    float gustAt(float x) {
      float swell = vnoise2(vec2(uRainTime * 0.055, 3.7));
      float front = vnoise2(vec2(x * 0.85 - uRainTime * 0.031, 11.0));
      return mix(0.60, 1.30, 0.42 * swell + 0.58 * front);
    }

    /**
     * One sheet of very near, very defocused streaks.
     *
     * Same cell scheme as the sky sheets, with three differences that are all
     * consequences of the drops being metres away instead of hundreds:
     *
     *  - Almost none of them. A handful of cells across the whole frame.
     *  - Enormously long: streakLen here puts under two rows in a frame
     *    height, i.e. a streak is most of the picture tall.
     *  - No sharp edge in any direction. across is a wide gaussian and the
     *    ends fade over a third of the length each, because a drop this close is
     *    both motion-blurred and outside the focal plane.
     */
    float nearSheet(vec2 uv, float columns, float speed, float streakLen,
                    float density, float width, float seed) {
      vec2 cell = vec2(columns, columns / (streakLen * uAspect));
      vec2 grid = uv * cell;
      float column0 = floor(uv.x * columns);
      // Leans harder than the sky rain: this is the rain that is blowing in
      // under the roof, which is by definition the part with the wind in it.
      grid.x += grid.y * (0.16 + hash12(vec2(column0, seed + 3.0)) * 0.14);
      float column = floor(grid.x);
      float jitter = hash12(vec2(column, seed));
      grid.y += uRainTime * speed * (0.75 + jitter * 0.5);
      float row = floor(grid.y);
      float id = hash12(vec2(column, row + seed * 37.0));
      if (id > density) return 0.0;

      float r1 = fract(id * 17.0);
      float r2 = fract(id * 91.7);
      float r3 = fract(id * 233.1);
      float w = width * (0.5 + r2 * 0.8);
      float len = 0.35 + r3 * 0.6;

      vec2 f = fract(grid);
      float x = abs(f.x - (0.15 + 0.7 * r1));
      float across = exp(-(x * x) / (w * w + 1e-6));
      // Fades in and out over a third of its length at each end: a defocused
      // streak has no head and no tail, only a middle.
      float along = smoothstep(0.0, len * 0.34, f.y) * smoothstep(len, len * 0.55, f.y);
      return across * along * (0.35 + r1 * 0.9);
    }

    void main() {
      vec3 src = texture2D(tDiffuse, vUv).rgb;
      float amount = clamp(uRain, 0.0, 1.0) * clamp(uNearRain, 0.0, 1.0);
      if (amount < 0.002) {
        gl_FragColor = vec4(src, 1.0);
        return;
      }
      float rain = clamp(clamp(uRain, 0.0, 1.0) * gustAt(vUv.x), 0.0, 1.0);
      // Near rain is the last thing to arrive and the first to go: in a drizzle
      // nothing is blowing in past the roofline at all, and what you see in
      // front of you is only the sky's rain in the distance. So this ramps in
      // over the upper half of the slider rather than tracking it linearly.
      float heavy = smoothstep(0.28, 0.95, rain) * clamp(uNearRain, 0.0, 1.0);
      if (heavy < 0.002) {
        gl_FragColor = vec4(src, 1.0);
        return;
      }

      // Two sheets, both very sparse. The first is the "near" band — long, fast,
      // still legible as individual streaks. The second is right on the lens:
      // three or four smears a frame, so wide and so faint they register as a
      // shimmer rather than as marks.
      // Counts, not densities, are what these numbers mean at this scale: nine
      // columns and under two rows in a frame height is about 25 cells in the
      // whole picture, so 0.46 of them occupied is a dozen streaks on screen.
      // The first values (0.32 and 0.18, at 0.34 and 0.16 opacity) put six or
      // seven of them there at an opacity that lost them against the plate
      // entirely — measured over the bench, the brightest streak lifted the
      // painting by four levels, which is below the noise of the illustration's
      // own texture.
      float near = nearSheet(vUv, 9.0, 4.6, 1.7, mix(0.0, 0.46, heavy), 0.030, 5.0);
      float veryNear = nearSheet(vUv, 4.0, 6.4, 1.1, mix(0.0, 0.24, heavy), 0.075, 61.0);

      // A drop is a lens, and at this range it is a lens onto the whole sky
      // rather than onto whatever it is passing in front of — see uSkyColor.
      // Mostly ambient, with a little of the local picture left in it so that a
      // streak crossing a bright patch still picks some of it up.
      vec3 gathered = texture2D(tDiffuse, vec2(vUv.x, min(vUv.y + 0.09, 1.0))).rgb;
      vec3 dropColor = mix(gathered * 1.10, uSkyColor, 0.68) + 0.02;

      vec3 color = src;
      color = mix(color, dropColor, clamp(near * 0.52 * heavy, 0.0, 1.0));
      // The lens-side smears are fainter still, and flatter: they are so far out
      // of focus that they carry almost no image, only a lift.
      color = mix(color, mix(dropColor, vec3(1.0), 0.25),
                  clamp(veryNear * 0.22 * heavy, 0.0, 1.0));

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

import * as THREE from 'three';

/**
 * Rain, drawn over the rendered sky only.
 *
 * The masking is structural rather than written: this pass runs *immediately
 * before* effects/plateShader.ts, so the painted illustration — the room, the
 * window frames, the town, the girl — is composited on top of it afterwards.
 * The only pixels that survive are the ones the plate leaves transparent, which
 * are exactly the pixels where you are looking through the glass at the sky.
 * Rain therefore falls outside the window and nowhere else, with no mask to
 * keep in sync and no way for it to end up indoors.
 *
 * (The painted town along the bottom of the glass stays dry, which is the one
 * place this cheats. It is a narrow, busy strip and the alternative — keying
 * rain onto painted geometry — would mean inventing depth for an illustration.)
 *
 * Two things happen here, and the darkening matters more than the streaks:
 *
 *  - The sky is dimmed and desaturated toward a flat grey-blue. Rain does not
 *    read as rain because you can see the drops; it reads as rain because the
 *    light goes out of everything. A frame full of streaks over a bright summer
 *    sky looks like a scratched film print.
 *  - Streaks. Deliberately sparse, fast and low-contrast: individually almost
 *    invisible, collectively a texture. Two layers at different depths, the
 *    near one faster, longer and more transparent, which is what gives the
 *    impression of falling *through* a volume rather than of a pattern sliding
 *    down the glass.
 *
 * Everything is a function of uTime, which is fed simTime — so, like the rest
 * of the scene, a given simulated second always produces the same frame and
 * scripts/capture.js's `?t=` stays reproducible.
 */
export const RainShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0 = dry (the pass is skipped entirely at 0, see core/postFx.ts). */
    uRain: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    /** What a rained-out sky washes toward, in display-space sRGB — this pass
     * runs after OutputPass, on tonemapped pixels. */
    uRainColor: { value: new THREE.Vector3(0.42, 0.47, 0.52) },
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
    uniform float uTime;
    uniform float uAspect;
    uniform vec3 uRainColor;
    varying vec2 vUv;

    // Smooth 2D value noise, for the curtains below.
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

    /**
     * Rain seen from a distance: 雨脚, the pale curtains that hang out of a
     * cloud base and drift with it.
     *
     * Individual streaks are the wrong model for anything more than a few
     * hundred metres away. Past that you cannot resolve a drop, and what you
     * actually see is a translucent grey-white veil — the aggregate of a great
     * many of them scattering light back at you. Drawing only streaks is why
     * the first version read as rain on the glass with a clear view behind it,
     * rather than as weather filling the distance.
     *
     * Built from noise stretched hard along y so it forms vertical shafts, at
     * two scales, drifting downward slowly (a curtain falls far more slowly
     * than a drop does, because it is a shape rather than an object).
     */
    float curtain(vec2 uv) {
      vec2 p = vec2(uv.x * 3.2, uv.y * 0.55 - uTime * 0.02);
      float v = vnoise2(p) * 0.55 + vnoise2(p * 2.4 + 11.0) * 0.3 + vnoise2(p * 5.1 + 31.0) * 0.15;
      // Fine vertical striation riding on top, so a shaft has fall lines in it.
      v += (vnoise2(vec2(uv.x * 46.0, uv.y * 2.2 - uTime * 0.05)) - 0.5) * 0.16;
      return v;
    }

    // One sheet of falling streaks.
    //
    // The frame is cut into tall thin cells; each cell holds at most one drop,
    // its column offset and fall phase hashed from the cell so the pattern
    // never tiles visibly. density is the fraction of cells that hold a drop
    // at all — sparseness is what stops this reading as hatching.
    float sheet(vec2 uv, float columns, float speed, float streakLen, float density,
                float width, float seed) {
      vec2 cell = vec2(columns, columns / (streakLen * uAspect));
      vec2 grid = uv * cell;
      // Slant. Rain in any wind is not vertical, and matching the scene's
      // left-to-right flow ties it to the clouds above it.
      grid.x += grid.y * 0.12;
      float column = floor(grid.x);
      float jitter = hash12(vec2(column, seed));
      grid.y += uTime * speed * (0.75 + jitter * 0.5);
      float row = floor(grid.y);
      float id = hash12(vec2(column, row + seed * 37.0));
      if (id > density) return 0.0;
      vec2 f = fract(grid);
      // Across the streak: a soft line, offset within its column.
      float x = abs(f.x - (0.25 + 0.5 * fract(id * 17.0)));
      float across = smoothstep(width, 0.0, x);
      // Along it: bright at the head, tapering to nothing at the tail.
      float along = smoothstep(0.0, 0.35, f.y) * smoothstep(1.0, 0.45, f.y);
      return across * along;
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float rain = clamp(uRain, 0.0, 1.0);
      // Everything about heavy rain — how fat the drops are, how many, how hard
      // the light goes — is driven off this rather than off rain directly, so
      // the bottom of the slider stays a drizzle and the top is a different
      // kind of weather rather than the same one turned up.
      float heavy = smoothstep(0.3, 1.0, rain);

      // The light going out. A downpour is genuinely dark: the deck overhead is
      // thick enough to be its own night, and the rain between you and anything
      // else scatters what little is left.
      float wash = rain * (0.42 + 0.40 * heavy);
      vec3 color = mix(src.rgb, uRainColor * mix(1.0, 0.72, heavy), wash);
      // And a little contrast out with it — rain flattens a scene as well as
      // dimming it.
      float grey = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(color, vec3(grey), wash * 0.4);

      // The curtains go in first, behind the streaks: they are the far rain,
      // and the streaks are the near rain in front of them. Strongest low in
      // the frame, where the long sight lines are — a shaft two kilometres out
      // is seen against the sky near the horizon, not overhead.
      float depth = smoothstep(0.85, 0.15, vUv.y);
      float veil = smoothstep(0.42, 0.86, curtain(vUv)) * mix(0.25, 1.0, depth);
      color = mix(color, uRainColor + vec3(0.30, 0.32, 0.33), veil * heavy * 0.62);

      // Three sheets at three depths. The far one is a fine mist that only
      // reads as texture; the mid one carries the body of the rain; the near
      // one is the fat, fast, close drops that arrive only in a downpour and
      // are most of what makes heavy rain look heavy.
      // The proportions matter more than anything else here, and the first
      // version had them badly wrong: cells about 40px tall and 9px wide gave
      // short fat dashes, which the eye reads as snow, not rain. A raindrop
      // seen at any shutter speed is a *line* — on this 1408px frame roughly
      // 25px long and 1px wide in the distance, up to 130px long and 2-3px wide
      // for the near ones. streakLen sets how many rows the frame is cut into,
      // so it is the number that makes them long; the width argument is a
      // fraction of a column, so it is the one that makes them thin.
      float mist = sheet(vUv, 88.0, 0.25, 2.8, mix(0.22, 0.46, heavy), 0.055, 1.0);
      float mid = sheet(vUv, 35.0, 0.40, 2.7, mix(0.14, 0.34, heavy), mix(0.030, 0.042, heavy), 7.0);
      float near = sheet(vUv, 16.0, 0.55, 2.6, mix(0.0, 0.30, heavy), mix(0.022, 0.034, heavy), 23.0);

      float streaks = mist * 0.28 + mid * mix(0.45, 0.75, heavy) + near * heavy;
      streaks *= smoothstep(0.03, 0.35, rain);

      // Added as light, not painted as grey lines: a raindrop in front of the
      // sky is a lens, and what it does is scatter a little of the sky's own
      // brightness toward the eye.
      color += streaks * mix(0.18, 0.50, heavy) * mix(vec3(1.0), uRainColor + 0.4, 0.5);

      gl_FragColor = vec4(color, src.a);
    }
  `,
};

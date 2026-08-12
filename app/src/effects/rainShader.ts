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
    /**
     * What a rained-out sky washes toward, in display-space sRGB — this pass
     * runs after OutputPass, on tonemapped pixels.
     *
     * Was (0.42, 0.47, 0.52): lead grey, and wrong. Measured across a rain-sky
     * reference (Screenshot_20260813-053823.png, scripts/duskref.js) the sky
     * runs #11315b at the top through #2c6e89 in the middle to #233a62 low
     * down — luminance 45-98 and **saturation 0.64-0.86**. A rained-out sky is
     * not desaturated, it is dark and deeply blue. Grey is what you get by
     * assuming "no sun" means "no colour", and it is the difference between
     * weather and a dead monitor.
     *
     * This is the middle band, which is where most of the frame's sky sits.
     */
    uRainColor: { value: new THREE.Vector3(0.173, 0.431, 0.537) },
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

    /**
     * One sheet of falling streaks.
     *
     * The frame is cut into tall thin cells; each cell holds at most one drop,
     * its column offset and fall phase hashed from the cell so the pattern
     * never tiles visibly. density is the fraction of cells that hold a drop at
     * all — sparseness is what stops this reading as hatching.
     *
     * Everything about an individual streak is varied per drop, and that is the
     * fix for the first version, which read as scratches on the lens rather
     * than as rain. Scratches are what you get from marks that are all the same
     * width, all the same brightness, all the same length, all at the same
     * angle, with a hard edge: that is a description of damage, because damage
     * is made by one process acting once. Rain is thousands of independent
     * objects at different distances, so no two of its streaks agree about
     * anything.
     *
     * The edge is soft over about twice the streak's width as well. A raindrop
     * crossing the frame during one exposure is motion blur — it has no sharp
     * boundary anywhere.
     */
    float sheet(vec2 uv, float columns, float speed, float streakLen, float density,
                float width, float seed) {
      vec2 cell = vec2(columns, columns / (streakLen * uAspect));
      vec2 grid = uv * cell;
      // Slant. Rain in any wind is not vertical, and matching the scene's
      // left-to-right flow ties it to the clouds above it. Per-column, so the
      // sheet is not one rigidly parallel comb.
      float column0 = floor(uv.x * columns);
      grid.x += grid.y * (0.08 + hash12(vec2(column0, seed + 3.0)) * 0.09);
      float column = floor(grid.x);
      float jitter = hash12(vec2(column, seed));
      grid.y += uTime * speed * (0.75 + jitter * 0.5);
      float row = floor(grid.y);
      float id = hash12(vec2(column, row + seed * 37.0));
      if (id > density) return 0.0;

      // Per-drop character.
      float r1 = fract(id * 17.0);
      float r2 = fract(id * 91.7);
      float r3 = fract(id * 233.1);
      // Width varies *downward only*: the widths were already at the top of
      // what reads as rain rather than as a smear, so the range runs from
      // four tenths of the sheet's width up to exactly it, never past.
      float w = width * (0.4 + r2 * 0.6);
      // Length varies far more than it did (was 0.35-0.80 of a cell). Drops
      // are at every distance and falling at every angle to the view, so their
      // streaks are at every length; a narrow range of lengths is one of the
      // things that made the first version read as ruled hatching.
      float len = 0.22 + r3 * 0.63;

      vec2 f = fract(grid);
      float x = abs(f.x - (0.2 + 0.6 * r1));
      // Soft across its whole width — no hard edge anywhere on a streak.
      float across = exp(-(x * x) / (w * w + 1e-6));
      // Along it: brightest at the head, fading out along the tail.
      float along = smoothstep(0.0, len * 0.35, f.y) * smoothstep(len, len * 0.4, f.y);
      // And drops are not all equally visible: some catch the light, most
      // barely register. Squared, so the bright ones are the rare ones.
      return across * along * (0.22 + r1 * r1 * 1.5);
    }

    // What the rain does to any colour in the scene: pulls it toward a flat
    // rain-grey and takes some of its contrast out with it.
    vec3 weather(vec3 c, float wash, float heavy) {
      vec3 washed = mix(c, uRainColor * mix(1.0, 0.82, heavy), wash);
      // Only a little contrast comes out with the light. This used to pull 40%
      // of the way to grey, which undid most of the colour the wash had just
      // put in — the reference sky holds saturation 0.64-0.86 through the
      // heaviest part of the storm.
      float grey = dot(washed, vec3(0.299, 0.587, 0.114));
      return mix(washed, vec3(grey), wash * 0.12);
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
      vec3 color = weather(src.rgb, wash, heavy);

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
      float mist = sheet(vUv, 88.0, 0.25, 2.8, mix(0.38, 0.70, heavy), 0.055, 1.0);
      float mid = sheet(vUv, 35.0, 0.40, 2.7, mix(0.26, 0.55, heavy), mix(0.030, 0.042, heavy), 7.0);
      float near = sheet(vUv, 16.0, 0.55, 2.6, mix(0.0, 0.45, heavy), mix(0.022, 0.034, heavy), 23.0);

      // The bottom of the slider is a drizzle you can barely see: the streaks
      // fade in over the first third of it rather than appearing at full
      // strength the moment the slider leaves zero. Applied to the three sheets
      // together, below, so they stay in proportion to each other as it ramps.
      float visible = smoothstep(0.03, 0.35, rain);

      // A raindrop is a lens, not a mark.
      //
      // The first version added white light, and that is most of why the
      // streaks read as scratches: a scratch is bright because its material is
      // damaged, so it has its own colour and ignores the scene. A drop has no
      // colour of its own at all — it is a tiny lens that gathers the sky from
      // above and behind it and squeezes it toward the eye, so a streak is
      // always a compressed, slightly brightened image of what is *around* it.
      // That is why rain nearly vanishes against a bright sky and stands out
      // against a dark hillside, and why it can never look pasted on.
      //
      // Sampling upward is the cheap version of that: the sky above any point
      // in this frame is the brightest thing a drop at that point could be
      // gathering.
      // Weathered exactly like everything else before it is used. Reading
      // tDiffuse gives the sky as it was *before* the downpour darkened it, and
      // using that raw was the second thing wrong with these streaks: every
      // drop showed a bright clear-weather sky against a scene that had just
      // been taken down two stops, so they came out as luminous blue-white
      // shards. A drop can only gather the light that is actually there.
      vec3 gathered = weather(
        texture2D(tDiffuse, vec2(vUv.x, min(vUv.y + 0.05, 1.0))).rgb, wash, heavy);

      // Grey through white, by depth rather than at random.
      //
      // A distant drop is seen through kilometres of the same rain that is
      // dimming everything else, so it arrives grey; a near one has almost
      // nothing in front of it and shows the sky's own brightness. Tying the
      // spread to the three sheets rather than rolling it per drop therefore
      // gets it for free *and* gets it right — the pale streaks sit behind the
      // bright ones, which is the depth cue, instead of being scattered
      // through each other.
      float grey = dot(gathered, vec3(0.299, 0.587, 0.114));
      vec3 farColor = mix(vec3(grey), gathered, 0.35) * 0.92;
      vec3 midColor = mix(vec3(grey), gathered, 0.7) * 1.08;
      // The near drops are the pale ones in the reference — near white against
      // the blue — so they get a push toward white on top of the gather.
      vec3 nearColor = mix(gathered * 1.30, vec3(1.0), 0.25) + 0.04;

      float strength = mix(0.55, 1.0, heavy) * visible;
      color = mix(color, farColor, clamp(mist * 0.30 * strength, 0.0, 1.0));
      color = mix(color, midColor, clamp(mid * mix(0.45, 0.78, heavy) * strength, 0.0, 1.0));
      color = mix(color, nearColor, clamp(near * heavy * strength, 0.0, 1.0));

      gl_FragColor = vec4(color, src.a);
    }
  `,
};

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
 *  - The light goes out of everything. Rain does not read as rain because you
 *    can see the drops; it reads as rain because the light goes. A frame full
 *    of streaks over a bright summer sky looks like a scratched film print.
 *  - Streaks. Deliberately sparse, fast and low-contrast: individually almost
 *    invisible, collectively a texture. Three layers at three depths, the near
 *    one faster, longer and more transparent, which is what gives the
 *    impression of falling *through* a volume rather than of a pattern sliding
 *    down the glass.
 *
 * **How the light is taken out is the whole picture, and the first version got
 * it wrong in a way no amount of streak-tuning could repair.** It mixed every
 * pixel 82% of the way to one constant colour, which is a description of fog on
 * the *lens*, not weather in the scene. Measured over the sky (plate.webp's
 * alpha as the mask, cloud=100%, 12:00) that collapsed the frame:
 *
 *     rain=0   luminance sd 48.2   p1-p99 169   local |grad| 6.87
 *     rain=1   luminance sd 11.8   p1-p99  47   local |grad| 1.60
 *
 * 48.2 x 0.18 = 8.7, so essentially the entire loss was the mix — and the three
 * streak sheets and the curtains together were adding back only about 3 levels
 * of spread. Everything expensive in this project (the measured colour ramp,
 * the self-shadowing, Kuwahara, the macro-contrast pass) was being averaged
 * away, and what was left was neither dark nor bright: one mid-value field.
 *
 * So the darkening is now an **exposure cut**, not a blend. Multiplying in
 * linear light scales the scene instead of replacing it, so every ratio in the
 * cloud modelling survives intact and the picture gets *darker* rather than
 * flatter. Only a small aerial-perspective term actually replaces colour, and
 * it varies with height because a rain sky does: the reference runs #11315b at
 * the top through #2c6e89 to #233a62 low down, and spending that on a single
 * constant threw away the strongest depth cue a sky has.
 *
 * Streak time is uRainTime, which is *not* the scene's simTime: see the uniform
 * below. `?t=` still fixes it, so scripts/capture.js stays reproducible.
 */
export const RainShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0 = dry (the pass is skipped entirely at 0, see core/postFx.ts). */
    uRain: { value: 0 },
    /**
     * The clock the *drops* fall on, in seconds — deliberately not simTime.
     *
     * Everything else in this scene is a pure function of simTime, which the
     * speed slider runs at 1-30x so that a tower's ten-minute life can be
     * watched in under a minute. Rain cannot share that clock. What the slider
     * is speeding up is the weather *changing*, and a raindrop is not weather
     * changing — it is an object falling at its own terminal velocity, which
     * does not care how fast you are watching the sky evolve. Driven off
     * simTime the drops ran at 10x by default and 30x at the top, which is not
     * "fast rain", it is a different phenomenon.
     *
     * core/main.ts advances this in real seconds and pins it to `?t=` when the
     * scene is frozen, so scripts/capture.js still gets the same frame twice.
     */
    uRainTime: { value: 0 },
    uAspect: { value: 1 },
    /**
     * What the rain's aerial perspective washes toward, in display-space sRGB —
     * this pass runs after OutputPass, on tonemapped pixels.
     *
     * Measured across a rain-sky reference (Screenshot_20260813-053823.png,
     * scripts/duskref.js) the sky runs #11315b at the top through #2c6e89 in
     * the middle to #233a62 low down — luminance 45-98 and **saturation
     * 0.64-0.86**. A rained-out sky is not desaturated, it is dark and deeply
     * blue. Grey is what you get by assuming "no sun" means "no colour", and it
     * is the difference between weather and a dead monitor.
     *
     * All three bands are here now. The first version measured all three and
     * then used only the middle one, which pinned the whole sky to one value
     * and cost it the top-to-bottom gradient — measured, the twelve elevation
     * bands over the window went from 163/147/163/149/129/134/134/124/164/189
     * dry to 96/94/96/94/91/94/96/98/108/108 in the rain. That is not a sky in
     * bad weather, that is a wall.
     */
    uRainColor: { value: new THREE.Vector3(0.173, 0.431, 0.537) },
    /** #11315b, the top band — the deck's own base, seen nearly overhead. */
    uRainHigh: { value: new THREE.Vector3(0.067, 0.192, 0.357) },
    /** #233a62, low down, where the long sight lines run out into the murk. */
    uRainLow: { value: new THREE.Vector3(0.137, 0.227, 0.384) },
    /**
     * Linear-light exposure at full rain. 0.32 is about a stop and a half down,
     * which lands the sky's mean luminance near 86 against the reference's
     * 45-98 band — where the old constant-mix left it at 96.7 *and* flat.
     */
    uExposure: { value: 0.32 },
    /**
     * A little contrast back on top of the exposure cut, about the darkened
     * mid. A storm sky is not a low-contrast subject: the base of the deck and
     * the breaks in it are further apart than a fair-weather sky's cloud and
     * blue, not closer. Small, because the exposure cut has already done the
     * work the old blend was destroying.
     */
    uContrast: { value: 1.15 },
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
    uniform vec3 uRainColor;
    uniform vec3 uRainHigh;
    uniform vec3 uRainLow;
    uniform float uExposure;
    uniform float uContrast;
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
      vec2 p = vec2(uv.x * 3.2, uv.y * 0.55 - uRainTime * 0.02);
      float v = vnoise2(p) * 0.55 + vnoise2(p * 2.4 + 11.0) * 0.3 + vnoise2(p * 5.1 + 31.0) * 0.15;
      // Fine vertical striation riding on top, so a shaft has fall lines in it.
      v += (vnoise2(vec2(uv.x * 46.0, uv.y * 2.2 - uRainTime * 0.05)) - 0.5) * 0.16;
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
      grid.y += uRainTime * speed * (0.75 + jitter * 0.5);
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

    // The rain sky's own colour at this height. v is screen v, so 1 is the top
    // of the frame. Three measured bands rather than one, piecewise about the
    // middle — see uRainColor.
    vec3 rainSky(float v) {
      return v < 0.5
        ? mix(uRainLow, uRainColor, smoothstep(0.0, 0.5, v))
        : mix(uRainColor, uRainHigh, smoothstep(0.5, 1.0, v));
    }

    // sRGB <-> linear, closely enough. The buffer is display-space by this
    // point (OutputPass ran several passes ago), and an exposure applied to
    // display-space numbers is not an exposure — it is a contrast curve that
    // happens to darken. The gamma round trip is two pow()s and it is the
    // difference between "the sun went behind the deck" and "someone turned the
    // brightness down".
    vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
    vec3 toDisplay(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

    /**
     * What the rain does to any colour in the scene.
     *
     * Two separate things, and keeping them separate is the entire fix:
     *
     *  - **Less light.** An exposure cut in linear light. This is a *scale*, so
     *    it preserves every ratio in the picture: the cloud's crown stays the
     *    same amount brighter than its shadow, the modelling survives, and the
     *    frame gets darker instead of flatter. The old version had no term of
     *    this kind at all.
     *  - **Rain in the way.** Aerial perspective — the water between you and
     *    the subject, which genuinely does replace the subject's colour with
     *    its own. This is the only term allowed to blend, and it is small:
     *    0.30 at the top of the slider against the old 0.82.
     *
     * Then a little contrast about the darkened mid, because the exposure cut
     * compresses the display-space spread along with everything else.
     */
    vec3 weather(vec3 c, float rain, float heavy, float v) {
      vec3 lit = toDisplay(toLinear(c) * mix(1.0, uExposure, rain));
      float veil = rain * (0.16 + 0.14 * heavy);
      vec3 washed = mix(lit, rainSky(v) * mix(1.0, 0.88, heavy), veil);
      // Pivot is the exposed mid rather than 0.5: expanding a dark image about
      // mid-grey would just crush it back toward black.
      float pivot = pow(uExposure, 1.0 / 2.2) * 0.55;
      return pivot + (washed - pivot) * mix(1.0, uContrast, rain);
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
      vec3 color = weather(src.rgb, rain, heavy, vUv.y);

      // The curtains go in first, behind the streaks: they are the far rain,
      // and the streaks are the near rain in front of them. Strongest low in
      // the frame, where the long sight lines are — a shaft two kilometres out
      // is seen against the sky near the horizon, not overhead.
      //
      // The colour is relative to the sky at that height rather than a constant
      // that happened to be brighter than everything else. A curtain is lit by
      // the same light as the deck it hangs from, so it is *slightly* brighter
      // than the sky behind it and no more; the old absolute value came out
      // well above the washed frame everywhere and read as smears on the glass
      // rather than as rain in the distance. Weight halved to match.
      float depth = smoothstep(0.85, 0.15, vUv.y);
      float veil = smoothstep(0.42, 0.86, curtain(vUv)) * mix(0.25, 1.0, depth);
      vec3 curtainColor = rainSky(vUv.y) * 1.5 + 0.04;
      color = mix(color, curtainColor, veil * heavy * 0.34);

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
      //
      // **Speed is what was actually wrong with these, and it is worth being
      // exact about it.** speed is in cell-rows per second, so the time a
      // streak takes to cross the frame is (rows per frame height) / speed —
      // and the rows per frame height is columns / (streakLen * uAspect).
      // The old values worked out at 69s, 17.7s and 6.1s per crossing. At 60fps
      // the near streak was therefore moving about 2px a frame while being
      // 50-190px long, i.e. between 1% and 4% of its own length. A mark that
      // moves a fortieth of its length per frame is not falling, it is sitting
      // there — which is exactly the "引っかき線" complaint, and no amount of
      // per-drop variation could have fixed it, because the problem was that
      // nothing was happening.
      //
      // A streak has to move at least its own length per frame to read as
      // motion blur rather than as a mark on the lens. These are set to cross
      // in 1.0s (near), 2.5s (mid) and 6.0s (far) instead, which is also about
      // right physically: a near drop crosses a window's worth of view in
      // around a second, and a distant one genuinely does creep.
      //
      // Which is the other half of it — a distant drop creeps *and cannot be
      // resolved as a drop at all* at that range. Drawing it as a streak is the
      // wrong model however fast it moves, so the far sheet's contribution is
      // cut below (0.30 -> 0.16) and the curtains carry the far rain, which is
      // what they are for.
      float mist = sheet(vUv, 88.0, 2.87, 2.8, mix(0.38, 0.70, heavy), 0.055, 1.0);
      float mid = sheet(vUv, 35.0, 2.83, 2.7, mix(0.26, 0.55, heavy), mix(0.030, 0.042, heavy), 7.0);
      float near = sheet(vUv, 16.0, 3.36, 2.6, mix(0.0, 0.45, heavy), mix(0.022, 0.034, heavy), 23.0);

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
        texture2D(tDiffuse, vec2(vUv.x, min(vUv.y + 0.05, 1.0))).rgb, rain, heavy, vUv.y);

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
      color = mix(color, farColor, clamp(mist * 0.16 * strength, 0.0, 1.0));
      color = mix(color, midColor, clamp(mid * mix(0.45, 0.78, heavy) * strength, 0.0, 1.0));
      color = mix(color, nearColor, clamp(near * heavy * strength, 0.0, 1.0));

      gl_FragColor = vec4(color, src.a);
    }
  `,
};

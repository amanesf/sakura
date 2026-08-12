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

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // One sheet of falling streaks.
    //
    // The frame is cut into tall thin cells; each cell holds at most one drop,
    // its column offset and fall phase hashed from the cell so the pattern
    // never tiles visibly. density is the fraction of cells that hold a drop
    // at all — sparseness is what stops this reading as hatching.
    float sheet(vec2 uv, float columns, float speed, float streakLen, float density, float seed) {
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
      // Across the streak: a narrow soft line, offset within its column.
      float x = abs(f.x - (0.25 + 0.5 * fract(id * 17.0)));
      float across = smoothstep(0.06, 0.0, x);
      // Along it: bright at the head, tapering to nothing at the tail.
      float along = smoothstep(0.0, 0.35, f.y) * smoothstep(1.0, 0.45, f.y);
      return across * along;
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      float rain = clamp(uRain, 0.0, 1.0);

      // The light going out. Squared so the first part of the slider is a sky
      // merely turning heavy, and the flat grey only arrives at the top.
      float wash = rain * rain * 0.72;
      vec3 color = mix(src.rgb, uRainColor, wash);
      // And a little contrast out with it — rain flattens a scene as well as
      // dimming it.
      float grey = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(color, vec3(grey), wash * 0.35);

      // Streaks only once there is enough rain to see any, and never at full
      // strength: these are meant to be felt more than seen.
      float far = sheet(vUv, 150.0, 0.55, 0.22, 0.26, 1.0);
      float near = sheet(vUv, 62.0, 1.35, 0.42, 0.15, 7.0);
      float streaks = far * 0.35 + near * 0.55;
      streaks *= smoothstep(0.04, 0.5, rain);

      // Added as light, not painted as grey lines: a raindrop in front of the
      // sky is a lens, and what it does is scatter a little of the sky's own
      // brightness toward the eye.
      color += streaks * 0.20 * mix(vec3(1.0), uRainColor + 0.35, 0.5);

      gl_FragColor = vec4(color, src.a);
    }
  `,
};

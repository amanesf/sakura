import * as THREE from 'three';

/**
 * Composites the foreground plate — the reference illustration with its sky
 * punched out — over the rendered sky.
 *
 * This runs dead last in the post chain, after OutputPass, Kuwahara and the
 * macro-contrast pass. That ordering is the whole point: those filters exist to
 * push a 3D render toward illustration, and the plate *is* an illustration
 * already. Running them over it would soften the girl's linework and flatten
 * the room. Because the plate covers everything except the glass, "post-process
 * only what is seen through the window" needs no mask — the plate is the mask.
 *
 * Blending happens in display space (the buffer is post-OutputPass sRGB, and
 * the plate texture is sampled raw for the same reason), which is also how the
 * reference was painted.
 */
export const PlateShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tPlate: { value: null as THREE.Texture | null },
    /** xy = uv origin, zw = uv size, of the visible sub-rect (core/frame.ts). */
    uPlateRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    /** Illuminant for the painted plate — white at noon. See the fragment
     * shader below and core/daylight.ts. */
    uDayTint: { value: new THREE.Vector3(1, 1, 1) },
    /**
     * Linear-light exposure for the painted plate, 1 when it is dry.
     *
     * The plate is 60.5% of the frame — the room, the girl, the window frames,
     * and the hills, town and sea seen through the glass — and until now not
     * one pixel of it changed when it rained. Measured at cloud=100%, rain=100%
     * that put the painted town strip at luminance 142.5 against a storm sky at
     * 96.7: **the sunlit town was 47% brighter than the downpour above it**, so
     * it became the brightest, most saturated thing in the picture and took the
     * eye straight off the sky and the girl. A warm noon sunbeam also stayed
     * lying across the classroom floor throughout.
     *
     * Darkening the whole plate is not a cheat to hide that, it is the physics:
     * this room has no light of its own, every photon in it came through those
     * windows, and when the sky goes down a stop and a half the room goes with
     * it. So this tracks the sky's own exposure (effects/rainShader.ts's
     * uExposure) rather than being dialled by eye.
     *
     * What this deliberately does *not* do is aerial perspective. The distant
     * town should also fade into the murk, and that is a function of its depth,
     * which a flat painting does not carry — it needs the "outside the window"
     * matte improvements.md §1.2 asks for, and a hand key to separate the town
     * from the girl standing in front of it (a geometric derivation from the
     * sky matte puts rain on her back). Darkening is the part that is honestly
     * available without that asset, and it is the part that fixes the tonal
     * hierarchy.
     */
    uRainExposure: { value: 1 },
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
    uniform sampler2D tPlate;
    uniform vec4 uPlateRect;
    // Time of day. The plate is one painting made at midday and cannot relight
    // itself, so without this the sky turns to evening behind a room that is
    // still lit for noon — which reads as a compositing error rather than as a
    // time of day. White at noon (core/daylight.ts), so the measure loop is
    // unaffected. Only the plate is multiplied: the rendered sky and clouds
    // have already had the hour applied by their own shaders.
    uniform vec3 uDayTint;
    uniform float uRainExposure;
    varying vec2 vUv;

    void main() {
      vec4 sky = texture2D(tDiffuse, vUv);
      vec4 plate = texture2D(tPlate, uPlateRect.xy + vUv * uPlateRect.zw);
      vec3 painted = plate.rgb * uDayTint;
      // In linear light, for the same reason the sky's exposure is: a scale
      // applied to display-space numbers is a contrast curve, not a change of
      // light, and it would flatten the painting exactly the way the old rain
      // wash flattened the sky. Exactly identity at uRainExposure = 1, so the
      // dry frame stays byte-for-byte what every statistic was measured on.
      if (uRainExposure < 1.0) {
        painted = pow(max(pow(max(painted, 0.0), vec3(2.2)) * uRainExposure, 0.0), vec3(1.0 / 2.2));
      }
      gl_FragColor = vec4(mix(sky.rgb, painted, plate.a), 1.0);
    }
  `,
};

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
    varying vec2 vUv;

    void main() {
      vec4 sky = texture2D(tDiffuse, vUv);
      vec4 plate = texture2D(tPlate, uPlateRect.xy + vUv * uPlateRect.zw);
      gl_FragColor = vec4(mix(sky.rgb, plate.rgb, plate.a), 1.0);
    }
  `,
};

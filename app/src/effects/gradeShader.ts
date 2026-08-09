/**
 * Always-on finishing pass: gentle vignette + a small saturation/contrast lift so
 * flat-shaded procedural geometry reads more like graded illustration and less like
 * raw 3D output (proposal.md §4.2/§9 catalog of post effects — this is the cheap
 * always-on slice of that list; bloom is the other, in postFx.ts).
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 1 },
    uVignetteStrength: { value: 0.28 },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.05 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAspect;
    uniform float uVignetteStrength;
    uniform float uSaturation;
    uniform float uContrast;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;

      float gray = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(vec3(gray), color, uSaturation);
      color = (color - 0.5) * uContrast + 0.5;

      float edgeDist = length((vUv - 0.5) * vec2(uAspect, 1.0));
      float vignette = smoothstep(0.35, 0.95, edgeDist) * uVignetteStrength;
      color *= (1.0 - vignette);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
    }`,
};

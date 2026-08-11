/**
 * Always-on finishing pass: saturation/contrast lift + a teal-shadow/warm-
 * highlight split tone (the "ティール&オレンジ" grading plan.md calls for) +
 * a gentle vignette, so the raster output reads as graded illustration rather
 * than raw untouched render.
 */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 1 },
    uVignetteStrength: { value: 0.14 },
    uSaturation: { value: 1.1 },
    uContrast: { value: 1.0 },
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

      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      vec3 shadowTint = vec3(0.9, 0.98, 1.06);
      vec3 highlightTint = vec3(1.07, 1.0, 0.9);
      color *= mix(shadowTint, highlightTint, smoothstep(0.15, 0.85, luma));

      float gray = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(vec3(gray), color, uSaturation);
      color = (color - 0.5) * uContrast + 0.5;

      float edgeDist = length((vUv - 0.5) * vec2(uAspect, 1.0));
      float vignette = smoothstep(0.35, 0.95, edgeDist) * uVignetteStrength;
      color *= (1.0 - vignette);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
    }`,
};

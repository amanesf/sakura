import * as THREE from 'three';

/**
 * Full-screen wave overlay for季節遷移 (season-transition-animation.md §3.1). One
 * shader covers all 4 stages by driving everything off a single `uProgress`:
 *
 * - 発生/浸食 (0.0–0.62): a ring expands outward from the time-machine device
 *   (bottom-left HUD, §7.1) across the screen; area already inside the ring
 *   desaturates, and the ring itself distorts + sparkles.
 * - 暗転の縁 (peaks ~0.35–0.62): a vignette darkens the corners as the ring nears
 *   full coverage — this is also where SceneTransitionController hard-swaps the
 *   season params (hidden behind the peak darkness/sparkle density).
 * - 収束 (0.62–1.0): everything (desaturation, distortion, vignette, sparkle) fades
 *   back to nothing, revealing the already-swapped new season cleanly.
 */
export const TransitionWaveShader = {
  name: 'TransitionWaveShader',
  uniforms: {
    tDiffuse: { value: null },
    uOrigin: { value: new THREE.Vector2(0.12, 0.16) },
    uProgress: { value: 0 },
    uColor: { value: new THREE.Color('#ffffff') },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uOrigin;
    uniform float uProgress;
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uAspect;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      vec2 d = uv - uOrigin;
      d.x *= uAspect;
      float dist = length(d);

      // Ring expands to cover the full diagonal by progress ~0.62, then holds
      // while the rest of the effect fades out underneath it (収束).
      float maxDist = 1.9;
      float coverageProgress = min(uProgress / 0.62, 1.0);
      float frontRadius = coverageProgress * maxDist;

      float ringWidth = 0.16;
      float insideMask = 1.0 - smoothstep(frontRadius - ringWidth, frontRadius, dist);
      float fadeOut = 1.0 - smoothstep(0.62, 1.0, uProgress);
      float intensity = insideMask * fadeOut;

      float ringProximity =
        (1.0 - smoothstep(0.0, ringWidth * 1.6, abs(dist - frontRadius))) * fadeOut;

      vec2 distortedUv = uv + vec2(
        sin(uv.y * 40.0 + uTime * 6.0),
        cos(uv.x * 40.0 + uTime * 6.0)
      ) * 0.006 * ringProximity;

      vec4 base = texture2D(tDiffuse, mix(uv, distortedUv, ringProximity));

      float gray = dot(base.rgb, vec3(0.299, 0.587, 0.114));
      vec3 color = mix(base.rgb, vec3(gray), 0.75 * intensity);

      float vignetteStrength = smoothstep(0.3, 0.62, uProgress) * fadeOut;
      float edgeDist = length((uv - 0.5) * vec2(uAspect, 1.0));
      float vignette = smoothstep(0.35, 0.9, edgeDist) * vignetteStrength * 0.55;
      color *= (1.0 - vignette);

      float sparkleField = hash(floor(uv * 220.0) + floor(uTime * 14.0));
      float sparkle = step(0.986, sparkleField) * ringProximity;
      color += uColor * sparkle * 1.4;

      color = mix(color, uColor, 0.12 * intensity);

      gl_FragColor = vec4(color, base.a);
    }`,
};

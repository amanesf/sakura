/**
 * Kuwahara filter — an edge-preserving region-averaging filter (Kuwahara et
 * al. 1976): the neighborhood around each pixel is split into four
 * overlapping quadrants, the mean and variance of each is computed, and the
 * output is the mean of whichever quadrant has the lowest variance. Because
 * it always averages a *locally uniform* region rather than blending across
 * an edge, the result keeps hard silhouette edges crisp while turning flat/
 * noisy interior regions into smooth flat-ish patches with visible brush-
 * stroke-like boundaries between them — the standard NPR trick for an "oil
 * painting" look, requested here as the alternative to cel-shading (chosen
 * over cel-shading because the cloud shading is already a soft baked
 * gradient + Fresnel rim, not discrete bands, so hard-quantizing it would
 * fight the existing look rather than build on it).
 */
export const KuwaharaShader = {
  name: 'KuwaharaShader',
  uniforms: {
    tDiffuse: { value: null },
    uTexelSize: { value: [0, 0] },
    // Radius 2, not 3. Measured: at radius 3 this pass drove the render's
    // local gradient energy down to 0.66 against the reference image's 2.60 —
    // it was averaging away more surface detail than the cloud shader was
    // putting in, which is the opposite of the painterly tooth it is here for.
    uRadius: { value: 2 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexelSize;
    uniform int uRadius;
    varying vec2 vUv;

    void main() {
      int r = uRadius;
      vec3 mean[4];
      vec3 meanSq[4];
      float count[4];
      for (int i = 0; i < 4; i++) { mean[i] = vec3(0.0); meanSq[i] = vec3(0.0); count[i] = 0.0; }

      for (int dy = -4; dy <= 4; dy++) {
        if (dy < -r || dy > r) continue;
        for (int dx = -4; dx <= 4; dx++) {
          if (dx < -r || dx > r) continue;
          vec3 c = texture2D(tDiffuse, vUv + vec2(float(dx), float(dy)) * uTexelSize).rgb;
          // Quadrants share the current pixel's row/column (overlapping at
          // the center) — the standard Kuwahara formulation, not a strict
          // four-way partition, which is what keeps the result from
          // developing a visible cross-hair seam through flat regions.
          if (dx <= 0 && dy <= 0) { mean[0] += c; meanSq[0] += c * c; count[0] += 1.0; }
          if (dx >= 0 && dy <= 0) { mean[1] += c; meanSq[1] += c * c; count[1] += 1.0; }
          if (dx <= 0 && dy >= 0) { mean[2] += c; meanSq[2] += c * c; count[2] += 1.0; }
          if (dx >= 0 && dy >= 0) { mean[3] += c; meanSq[3] += c * c; count[3] += 1.0; }
        }
      }

      float bestVariance = 1e9;
      vec3 bestMean = texture2D(tDiffuse, vUv).rgb;
      for (int i = 0; i < 4; i++) {
        vec3 m = mean[i] / count[i];
        vec3 v = meanSq[i] / count[i] - m * m;
        float variance = v.r + v.g + v.b;
        if (variance < bestVariance) {
          bestVariance = variance;
          bestMean = m;
        }
      }

      gl_FragColor = vec4(bestMean, texture2D(tDiffuse, vUv).a);
    }`,
};

import * as THREE from 'three';
import { createCloudRampTexture, sampleCloudRampHDR } from './cloudRamp';

/**
 * Unlit, ramp-indexed cloud shading.
 *
 * This deliberately bypasses PBR. Measuring the reference image against the
 * previous MeshStandardMaterial render showed three things that a lit
 * material structurally cannot fix by retuning:
 *
 *  - Hue is a function of value. The reference's blue/red separation climbs
 *    from 2 at the white crown to 150 in the deepest crevice; the lit render
 *    sat at ~25 across its entire range, because N.L darkening is achromatic.
 *  - The tonal histogram was bimodal (one bright plateau, one dead-grey blob
 *    at luminance ~100) where the reference is a broad continuum spanning
 *    130-255 with nothing below 130.
 *  - The render never reached white at all (peak luminance 227 against the
 *    reference's 4% of area at 250+).
 *
 * So brightness is not computed and then coloured. A scalar shading term s is
 * computed from form, and s *indexes the measured ramp* (cloudRamp.ts). The
 * ramp supplies both value and hue together, which is the only way to get
 * "darker therefore bluer" to hold everywhere by construction.
 */

/** Shared GLSL: cheap 3D value-noise FBM, used to break up the shading term.
 * This is the fix for the measured flatness — local gradient energy in the
 * render was 1.09 against the reference's 2.60, i.e. less than half the
 * surface detail, which reads as plastic smoothness. */
const NOISE_GLSL = /* glsl */ `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
          mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
          mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0, norm = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); norm += a; p *= 2.03; a *= 0.5; }
    return s / norm;
  }
  // Brush tooth needs a *different* spectrum from fbm, not just a higher
  // frequency. At the standard gain of 0.5 an fbm's finest octave carries
  // about 3% of the total weight, so its output is dominated by its smoothest
  // component however high its base frequency is set — which is why using
  // fbm for surface detail measurably failed to raise the render's local
  // gradient energy at all. Two octaves at near-equal weight keeps the energy
  // where the eye reads texture.
  float tooth(vec3 p) {
    return vnoise(p) * 0.62 + vnoise(p * 2.17 + 11.3) * 0.38;
  }
`;

export interface CloudMaterials {
  core: THREE.ShaderMaterial;
  halo: THREE.ShaderMaterial;
}

/**
 * lightDirection is a deliberately *art-directed* key light, not the true
 * astronomical sun direction — per the Guilty Gear Xrd research (plan.md
 * discussion): professional cel-look 3D doesn't trust physically-correct
 * lighting for its shading reads either, artists bend it toward whatever
 * direction makes the form and rim read best.
 */
export function createCloudMaterials(lightDirection: THREE.Vector3): CloudMaterials {
  const ramp = createCloudRampTexture();

  const core = new THREE.ShaderMaterial({
    uniforms: {
      uRamp: { value: ramp },
      uLightDir: { value: lightDirection.clone().normalize() },
      // Weights sum to 1 so s stays in [0,1] before the modifier terms.
      // Light-facing dominates; the baked vertical gradient is the secondary
      // read that keeps undersides reading as underside even where they face
      // the key light.
      uWeightLight: { value: 0.6 },
      uWeightHeight: { value: 0.4 },
      // How far a puff nestled among neighbours is pushed down the ramp.
      // Measured target: ~48% of the reference's cloud interior sits below
      // luminance 205, so this has to be assertive, not a subtle tint.
      uOcclusion: { value: 0.6 },
      // にじみ: multi-scale noise on the shading term itself, so shadow
      // regions mottle and bleed into the lit areas instead of being clean
      // geometric bands.
      uNoiseAmount: { value: 0.34 },
      uNoiseScale: { value: 2.1 },
      uDetailAmount: { value: 0.14 },
      uDetailScale: { value: 6.5 },
      // 多段階: soft posterisation. Plateaus at uTiers levels with smoothstep
      // transitions between them — the painted look of discrete shadow
      // regions with blended-but-defined boundaries, rather than either a
      // continuous ramp (too smooth) or hard cel bands (too graphic).
      uTiers: { value: 5.0 },
      uTierMix: { value: 0.7 },
      uTerminator: { value: 0.75 },
      // Cut hard from 0.45. With the lobe count raised to reference density,
      // nearly every pixel of the silhouette is near some lobe's grazing
      // angle, so a strong rim term stops being an edge accent and becomes a
      // flat brightness added to the whole cloud — the render went to 20% of
      // area at luminance 245+ against the reference's 11%, with only 5% left
      // below 205 against its 48%.
      uRimStrength: { value: 0.16 },
      // Contrast expansion applied to s before it indexes the ramp. Without
      // it the term is a sum of several roughly-uniform quantities, so it
      // piles up around 0.5 by the central limit theorem and the render comes
      // out of the ramp's midtones only — measured against the reference the
      // first version of this shader spanned luminance 174-235 where the
      // reference spans 148-252, and never produced a single white pixel
      // against the reference's 11% of area at 245+. Expanding around the
      // midpoint restores the tails at both ends.
      uContrast: { value: 2.05 },
      // Downward shift after the contrast expansion. Expanding around 0.5 is
      // symmetric, but the term's own mean sits above 0.5 (the rim and the
      // light-facing weight both push up), so without this the whole render
      // rides high: measured median luminance 217 against the reference's 207,
      // and only 33% of area below luminance 205 where the reference has 48%.
      uBias: { value: -0.055 },
    },
    vertexShader: /* glsl */ `
      attribute float aHeight;
      attribute float aOcclusion;
      attribute float aSeed;
      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      varying float vHeight;
      varying float vOcc;
      varying vec3 vNoisePos;

      void main() {
        vHeight = aHeight;
        vOcc = aOcclusion;
        // Noise is sampled in the nodule's own object space plus a per-
        // instance offset, NOT in world space: a world-space field would make
        // the surface texture stand still while the cloud drifts through it
        // on the wind, which reads as the cloud shimmering rather than moving.
        vNoisePos = position + vec3(aSeed, aSeed * 1.7, aSeed * 2.3);

        vec4 instanced = instanceMatrix * vec4(position, 1.0);
        vec4 worldPos = modelMatrix * instanced;
        // Normal must go through the instance matrix too — the per-axis
        // stretch in the instance scale is non-uniform, so a normal that
        // skipped it would be wrong on every stretched puff.
        mat3 instNormal = mat3(instanceMatrix);
        vec3 n = normalize(instNormal * normal);
        vNormalW = normalize(mat3(modelMatrix) * n);
        vViewDirW = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uRamp;
      uniform vec3 uLightDir;
      uniform float uWeightLight;
      uniform float uWeightHeight;
      uniform float uOcclusion;
      uniform float uNoiseAmount;
      uniform float uNoiseScale;
      uniform float uDetailAmount;
      uniform float uDetailScale;
      uniform float uTiers;
      uniform float uTierMix;
      uniform float uTerminator;
      uniform float uRimStrength;
      uniform float uContrast;
      uniform float uBias;

      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      varying float vHeight;
      varying float vOcc;
      varying vec3 vNoisePos;

      ${NOISE_GLSL}

      void main() {
        vec3 n = normalize(vNormalW);

        // Wrapped diffuse rather than clamped N.L: a cloud is a dense
        // scattering medium, so its terminator wraps well past 90 degrees
        // instead of falling to zero there. Clamped N.L is what put a hard
        // grey edge on every puff.
        float ndl = dot(n, normalize(uLightDir));
        float wrapped = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
        // Sharpened terminator. A soft wrapped-diffuse falloff shades a lobe
        // like a balloon, and when hundreds of lobes overlap the result is one
        // undifferentiated lump — which is exactly what the render was doing.
        // In the reference every lobe carries a bright cap that ends fairly
        // abruptly, and it is those many small hard light/shadow boundaries,
        // not any surface texture, that give the reference its detail. Mixing
        // in a smoothstep tightens each lobe's terminator so its outline reads
        // against whatever sits behind it.
        float lightTerm = mix(wrapped, smoothstep(0.32, 0.78, wrapped), uTerminator);

        float heightTerm = vHeight * 0.5 + 0.5;

        float s = lightTerm * uWeightLight + heightTerm * uWeightHeight;

        // Broad noise only at this stage: this is the term that makes whole
        // shadow regions grow and bleed irregularly instead of following
        // clean geometric bands ("にじむ").
        s += (fbm(vNoisePos * uNoiseScale) - 0.5) * uNoiseAmount;

        s -= vOcc * uOcclusion;

        // Rim: grazing angles on the lit side go bright, the classic sunlit
        // cumulus edge. Gated to the lit hemisphere so it can't halo the
        // shadow side.
        float fres = pow(1.0 - clamp(dot(n, normalize(vViewDirW)), 0.0, 1.0), 3.0);
        s += fres * uRimStrength * smoothstep(-0.2, 0.5, ndl);

        s = clamp((s - 0.5) * uContrast + 0.5 - uBias, 0.0, 1.0);

        // 多段階, applied to the low-frequency shading only.
        float scaled = s * uTiers;
        float tiered = (floor(scaled) + smoothstep(0.3, 0.7, fract(scaled))) / uTiers;
        s = mix(s, tiered, uTierMix);

        // Brush tooth goes on *after* the posterisation, not before. Measured
        // the other way round: inside a plateau the smoothstep is flat at both
        // ends, so it erased most of the fine variation and the render's local
        // gradient energy fell to 0.59 against the reference's 2.60 — flatter
        // than the un-posterised version had been. Blocking in flat shapes
        // first and texturing over them is also the order a painter works in.
        s += (tooth(vNoisePos * uDetailScale) - 0.5) * uDetailAmount;
        s = clamp(s, 0.0, 1.0);

        gl_FragColor = vec4(texture2D(uRamp, vec2(s, 0.5)).rgb, 1.0);
      }`,
  });

  // The translucent fringe. Its colour is taken from the same measured ramp
  // (upper-middle, where the reference's soft cloud edges actually sit)
  // rather than being white — a white fringe over blue sky greys out the
  // silhouette edge, which is what was veiling the whole cloud before.
  const haloColor = sampleCloudRampHDR(0.72);
  const halo = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(haloColor.r, haloColor.g, haloColor.b) },
      uOpacity: { value: 0.08 },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      void main() {
        vec4 instanced = instanceMatrix * vec4(position, 1.0);
        vec4 worldPos = modelMatrix * instanced;
        vNormalW = normalize(mat3(modelMatrix) * normalize(mat3(instanceMatrix) * normal));
        vViewDirW = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      void main() {
        // Fade out face-on and keep only the grazing shell, so the fringe
        // reads as wispy edge rather than a uniform fog dome over the puff.
        float edge = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0), 2.0);
        gl_FragColor = vec4(uColor, edge * uOpacity);
      }`,
  });

  return { core, halo };
}

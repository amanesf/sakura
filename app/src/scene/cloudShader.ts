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
      uOcclusion: { value: 0.34 },
      // にじみ: multi-scale noise on the shading term itself, so shadow
      // regions mottle and bleed into the lit areas instead of being clean
      // geometric bands.
      uNoiseAmount: { value: 0.34 },
      uNoiseScale: { value: 2.1 },
      uDetailAmount: { value: 0.2 },
      uDetailScale: { value: 6.5 },
      // 多段階: soft posterisation. Plateaus at uTiers levels with smoothstep
      // transitions between them — the painted look of discrete shadow
      // regions with blended-but-defined boundaries, rather than either a
      // continuous ramp (too smooth) or hard cel bands (too graphic).
      uTiers: { value: 5.0 },
      uTierMix: { value: 0.7 },
      uTerminator: { value: 0.68 },
      uPerLobeTint: { value: 0.13 },
      uDetailFocus: { value: 0.76 },
      uHighlightKnee: { value: 0.865 },
      uHighlightGain: { value: 0.9 },
      // Bright enough to clip to 255 through ACES at exposure 1.2 (anything
      // past ~10 saturates), but not so far past it that the bloom threshold
      // turns every white into a flare.
      uWhiteHDR: { value: new THREE.Vector3(12.0, 12.0, 12.0) },
      // Sky colour to fade toward, in the same inverse-tonemapped linear HDR
      // space the ramp lives in — the value that sky.ts renders at mid
      // height, sRGB(81,159,199), pushed back through the analytic inverse of
      // three.js's ACES fit at exposure 1.2.
      uHazeColor: { value: new THREE.Vector3(0.0523, 0.2322, 0.4532) },
      uHazeStart: { value: 12.0 },
      uHazeDensity: { value: 0.032 },
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
      uContrast: { value: 1.35 },
      // Downward shift after the contrast expansion. Expanding around 0.5 is
      // symmetric, but the term's own mean sits above 0.5 (the rim and the
      // light-facing weight both push up), so without this the whole render
      // rides high: measured median luminance 217 against the reference's 207,
      // and only 33% of area below luminance 205 where the reference has 48%.
      uBias: { value: -0.06 },
    },
    vertexShader: /* glsl */ `
      attribute float aHeight;
      attribute float aOcclusion;
      attribute float aSeed;
      attribute float aTint;
      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      varying float vHeight;
      varying float vOcc;
      varying float vTint;
      varying vec3 vNoisePos;
      varying float vDist;

      void main() {
        vHeight = aHeight;
        vOcc = aOcclusion;
        vTint = aTint;
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
        vec3 toCam = cameraPosition - worldPos.xyz;
        vDist = length(toCam);
        vViewDirW = normalize(toCam);
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
      uniform float uPerLobeTint;
      uniform float uDetailFocus;
      uniform float uHighlightKnee;
      uniform float uHighlightGain;
      uniform vec3 uWhiteHDR;
      uniform vec3 uHazeColor;
      uniform float uHazeStart;
      uniform float uHazeDensity;
      uniform float uRimStrength;
      uniform float uContrast;
      uniform float uBias;

      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      varying float vHeight;
      varying float vOcc;
      varying float vTint;
      varying vec3 vNoisePos;
      varying float vDist;

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

        // Detail budget. Measuring where contrast actually sits, the
        // reference spends 48% of its cloud area on *calm* surface (local
        // std below 6 in an 11x11 window) and only 17% on busy surface; this
        // render was the other way round at 27%/42%, and its 99th-percentile
        // gradient was 51 against the reference's 25 — i.e. busier AND
        // harder-edged everywhere at once. That is what reads as "not
        // painted": a painter blocks in large quiet masses and spends marks
        // only where the form turns. Detail is therefore concentrated into
        // the terminator band, peaking where the surface is half-lit and
        // falling away in both the fully-lit crown and the settled shadow.
        // This is also why the post-process filter could not fix the look —
        // a filter sees only the finished image and has no way to know which
        // regions deserved the marks.
        float detailGate = mix(1.0, 4.0 * lightTerm * (1.0 - lightTerm), uDetailFocus);

        // Broad noise: makes whole shadow regions grow and bleed irregularly
        // instead of following clean geometric bands ("にじむ").
        s += (fbm(vNoisePos * uNoiseScale) - 0.5) * uNoiseAmount * detailGate;

        s -= vOcc * uOcclusion;
        s += vTint * uPerLobeTint;

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
        // gradient energy fell below the un-posterised version. Blocking in
        // flat shapes first and texturing over them is also the order a
        // painter works in.
        s += (tooth(vNoisePos * uDetailScale) - 0.5) * uDetailAmount * detailGate;
        s = clamp(s, 0.0, 1.0);

        vec3 color = texture2D(uRamp, vec2(s, 0.5)).rgb;

        // Aerial perspective. In the reference the cloud's tonal range
        // collapses with height in frame — the spread between its 5th and
        // 95th luminance percentiles falls from 88 near the top to 38 in the
        // lower-middle bands, a 2.3x compression — because cloud that is
        // further away has more atmosphere in front of it, losing its shadows
        // and drifting toward the sky's own colour. This render applied none
        // of it: every cluster came out at full contrast whatever its
        // distance, which is why nothing settled into the background and the
        // lower cloud never dissolved into the sky.
        float haze = clamp(1.0 - exp(-max(vDist - uHazeStart, 0.0) * uHazeDensity), 0.0, 1.0);

        // Highlight concentration, and a real white.
        //
        // Measured, the reference puts only 5.5% of its cloud area above
        // luminance 248 but takes it all the way to a true 255, with 79% of
        // that white massed into a handful of large blobs. This render had
        // twice the white area (11.1%) and never got past 253 — a sprinkle of
        // identical bright caps instead of a few decisive sunlit faces.
        //
        // 253 was not a tuning failure but a ceiling: the ramp is sampled from
        // the reference with the top 2% of pixels trimmed off (they are sky
        // bleeding through gaps), so its brightest entry is sRGB(251,254,254)
        // and nothing indexing it can ever be whiter than that. So the top of
        // the range is taken *past* the ramp, toward a value high enough to
        // clip white through the tonemapper.
        //
        // Gated by (1 - haze) as well as by a late smoothstep. Without the
        // haze gate the boost simply outranks the aerial perspective below —
        // a distant lobe pushed to 12.0 is still near-white after being mixed
        // 72% toward the sky colour, which is why the far bank kept coming out
        // as bright as the hero tower.
        float hot = smoothstep(uHighlightKnee, 1.0, s);
        color = mix(color, uWhiteHDR, hot * uHighlightGain * (1.0 - haze));

        color = mix(color, uHazeColor, haze);

        gl_FragColor = vec4(color, 1.0);
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
      uOpacity: { value: 0.5 },
      uFringePower: { value: 0.9 },
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
        vec3 toCam = cameraPosition - worldPos.xyz;
        vDist = length(toCam);
        vViewDirW = normalize(toCam);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uFringePower;
      varying vec3 vNormalW;
      varying vec3 vViewDirW;
      void main() {
        // Fade out face-on and keep only the grazing shell, so the fringe
        // reads as wispy edge rather than a uniform fog dome over the puff.
        // Falloff exponent well below 1 (was 2.0). At 2.0 the fringe was
        // confined to a hairline right at the grazing angle and, at the 0.08
        // opacity it was carrying, contributed nothing — every cloud met the
        // sky at a hard polygon boundary, which is most of why the lobes read
        // as solid plastic balls rather than as condensed water. A broad, weak
        // shell reads as the thinning optical depth at a cloud's edge.
        float edge = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0), uFringePower);
        gl_FragColor = vec4(uColor, edge * uOpacity);
      }`,
  });

  return { core, halo };
}

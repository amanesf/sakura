import * as THREE from 'three';

export interface SkyCloudsHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

/**
 * Single fullscreen raymarch pass: physically-based atmosphere (Rayleigh + Mie
 * single scattering) behind a volumetric cloud shell (curl-noise flow, thermal-rise
 * growth curve, Henyey-Greenstein lighting). See plan.md §2/§3 for why this is all
 * derived from equations rather than hand-picked colors.
 *
 * The vertex shader bypasses the camera entirely (clip-space quad) — the fragment
 * shader reconstructs world-space view rays from the *real* camera's inverse
 * projection/world matrices, so this stays compatible with a perspective camera a
 * later foreground layer can share (plan.md §4 Phase 7).
 *
 * Hero-tower placement (TOWER_CENTER_KM, CLOUD_BASE_KM, TOWER_TOP_MAX_KM below) was
 * solved, not eyeballed: given the fixed camera's pitch/FOV (core/camera.ts) and the
 * apex/base screen positions measured from the reference image
 * (1786418841252.png — apex ≈(0.72,0.09), base ≈(0.75,0.57) as fractions of frame),
 * inverting the pinhole projection equations for a world point at a chosen distance
 * gives the world (x,z) offset and altitude range that lands there. Only a single
 * apex point and a single base point were matched this way (not the full outline),
 * so treat it as "in the right place at the right scale", not a pixel-exact trace.
 */

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform mat4 uCameraInverseProjection;
  uniform mat4 uCameraWorldMatrix;
  uniform vec3 uSunDirection;
  uniform float uTime;

  const float PI = 3.14159265359;

  // ---- Physical atmosphere constants (real order-of-magnitude values, km units) ----
  const float PLANET_RADIUS = 6371.0;
  const float ATMOS_RADIUS = 6471.0;
  const vec3 PLANET_CENTER = vec3(0.0, -PLANET_RADIUS, 0.0);
  const vec3 RAYLEIGH_COEFF = vec3(5.8e-3, 13.5e-3, 33.1e-3); // per km, wavelength^-4 falloff (RGB @ ~680/550/440nm)
  const float RAYLEIGH_SCALE_HEIGHT = 8.0; // km
  const float MIE_COEFF = 21.0e-3; // per km, grey (aerosol scattering)
  const float MIE_EXT = MIE_COEFF * 1.11; // extinction includes ~10% absorption
  const float MIE_SCALE_HEIGHT = 1.2; // km
  const float MIE_G = 0.76;
  const float SUN_INTENSITY = 5.0;
  const float CAMERA_ALTITUDE_KM = 0.0017;

  // ---- Cloud shell (see file header for how these were derived) ----
  const float CLOUD_BASE_KM = 1.4;
  const float TOWER_TOP_MAX_KM = 11.0;
  const float STRATO_TOP_KM = 2.3; // background layer stays low/flat, unlike the hero tower
  const vec3 TOWER_CENTER_KM = vec3(5.5, 0.0, -16.0);
  const float TOWER_RADIUS_KM = 2.2;
  const float TOWER_CYCLE_SECONDS = 260.0; // pacing choice, not a physical constant
  const float TOWER_SEED = 4.271;

  float hash13(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  float valueNoise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  float fbm3D(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      sum += amp * valueNoise3D(p);
      p *= 2.02;
      amp *= 0.5;
    }
    return sum;
  }

  float worley3D(vec3 p) {
    vec3 cell = floor(p);
    float minDist = 1.0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        for (int z = -1; z <= 1; z++) {
          vec3 neighbor = vec3(float(x), float(y), float(z));
          vec3 point = neighbor + vec3(
            hash13(cell + neighbor + vec3(11.1, 0.0, 0.0)),
            hash13(cell + neighbor + vec3(0.0, 17.3, 0.0)),
            hash13(cell + neighbor + vec3(0.0, 0.0, 23.7))
          );
          float d = length(point - fract(p) + floor(p) - cell);
          minDist = min(minDist, d);
        }
      }
    }
    return minDist;
  }

  float fbm2D(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += amp * valueNoise3D(vec3(p, 0.0));
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  // Divergence-free (incompressible-flow-like) vector field: the curl of a scalar
  // noise potential. Standard procedural-flow trick (Bridson) — deterministic
  // function of (p,time), not a solved fluid sim, but gives the same swirling,
  // non-repeating advection character. Used to drift/warp cloud density.
  vec2 curl2D(vec2 p) {
    float eps = 0.08;
    float n1 = fbm2D(p + vec2(0.0, eps));
    float n2 = fbm2D(p - vec2(0.0, eps));
    float n3 = fbm2D(p + vec2(eps, 0.0));
    float n4 = fbm2D(p - vec2(eps, 0.0));
    float dx = (n1 - n2) / (2.0 * eps);
    float dy = (n3 - n4) / (2.0 * eps);
    return vec2(dy, -dx);
  }

  vec2 raySphere(vec3 ro, vec3 rd, vec3 center, float radius) {
    vec3 oc = ro - center;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - radius * radius;
    float h = b * b - c;
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  vec2 atmosphereDensityAt(float height) {
    height = max(height, 0.0);
    return vec2(exp(-height / RAYLEIGH_SCALE_HEIGHT), exp(-height / MIE_SCALE_HEIGHT));
  }

  float phaseRayleigh(float mu) {
    return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  }

  float phaseHG(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
  }

  const int PRIMARY_STEPS = 16;
  const int LIGHT_STEPS = 4;

  // Single-scattering atmosphere integral along the view ray (0..rayLength), plus
  // the total transmittance through that same path (used to fade the cloud layer's
  // backdrop correctly, and to attenuate the sun disc itself when low).
  vec3 integrateAtmosphere(vec3 ro, vec3 rd, vec3 sunDir, float rayLength, out vec3 transmittance) {
    float mu = dot(rd, sunDir);
    float phaseR = phaseRayleigh(mu);
    float phaseM = phaseHG(mu, MIE_G);

    float stepSize = rayLength / float(PRIMARY_STEPS);
    vec3 totalRayleigh = vec3(0.0);
    vec3 totalMie = vec3(0.0);
    vec2 opticalDepth = vec2(0.0);

    for (int i = 0; i < PRIMARY_STEPS; i++) {
      vec3 samplePos = ro + rd * (stepSize * (float(i) + 0.5));
      float height = length(samplePos - PLANET_CENTER) - PLANET_RADIUS;
      vec2 density = atmosphereDensityAt(height) * stepSize;
      opticalDepth += density;

      vec2 lightHit = raySphere(samplePos, sunDir, PLANET_CENTER, ATMOS_RADIUS);
      float lightStepSize = max(lightHit.y, 0.0) / float(LIGHT_STEPS);
      vec2 lightOpticalDepth = vec2(0.0);
      bool blocked = false;
      for (int j = 0; j < LIGHT_STEPS; j++) {
        vec3 lightPos = samplePos + sunDir * (lightStepSize * (float(j) + 0.5));
        float lightHeight = length(lightPos - PLANET_CENTER) - PLANET_RADIUS;
        if (lightHeight < 0.0) { blocked = true; break; }
        lightOpticalDepth += atmosphereDensityAt(lightHeight) * lightStepSize;
      }

      if (!blocked) {
        vec3 tau = RAYLEIGH_COEFF * (opticalDepth.x + lightOpticalDepth.x)
                 + vec3(MIE_EXT) * (opticalDepth.y + lightOpticalDepth.y);
        vec3 attn = exp(-tau);
        totalRayleigh += density.x * attn;
        totalMie += density.y * attn;
      }
    }

    transmittance = exp(-(RAYLEIGH_COEFF * opticalDepth.x + vec3(MIE_EXT) * opticalDepth.y));
    vec3 singleScatter = SUN_INTENSITY * (totalRayleigh * RAYLEIGH_COEFF * phaseR + totalMie * MIE_COEFF * phaseM);

    // Cheap multiple-scattering fudge: a single-scattering-only integral goes
    // implausibly dark/saturated at the high optical depths near the horizon
    // (real haze there looks pale/white because extincted light doesn't just
    // vanish — most of it reappears as multiply-scattered skylight). Standard
    // real-time-atmosphere correction: feed back a fraction of the extincted
    // energy as flat ambient skylight instead of solving the full multi-bounce
    // integral.
    vec3 lostEnergy = vec3(1.0) - transmittance;
    vec3 multiScatterFudge = lostEnergy * SUN_INTENSITY * 0.012 * clamp(sunDir.y * 1.5 + 0.4, 0.05, 1.0);

    return singleScatter + multiScatterFudge;
  }

  // Simplified thermal-rise growth curve (loosely modeled on Morton-Taylor-Turner
  // buoyant-plume scaling, height ~ t^0.5 during the rising phase) rather than an
  // exact solved plume-rise equation — see plan.md §3.3. tau is this tower's phase
  // within its own lifecycle, in [0,1).
  float towerGrowth(float tau) {
    float riseEnd = 0.35;
    float holdEnd = 0.75;
    if (tau < riseEnd) {
      return sqrt(tau / riseEnd);
    } else if (tau < holdEnd) {
      return 1.0;
    }
    float d = (tau - holdEnd) / (1.0 - holdEnd);
    return 1.0 - smoothstep(0.0, 1.0, d);
  }

  const float CELL_SIZE_KM = 3.0;

  // One procedural cumulus field cell, evaluated at a fixed grid coordinate
  // (Worley-style: sample position looks up its own cell plus all 8 neighbors so a
  // jittered cloud center near a cell edge still reaches across it). Every visual
  // trait — occupied or empty sky, small/medium cumulus vs. a rare secondary
  // cumulonimbus, size, growth phase — is a deterministic hash of the integer cell
  // id, so re-running with the same cellId always yields the same cloud; variety
  // comes from there being hundreds of cells across the visible sky, not from
  // per-frame randomness. Addresses "雲は入道雲だけじゃないしさ" — most cells are
  // small/medium cumulus, only ~10% of occupied cells grow into a tower.
  float scatteredCumulusField(vec2 warped, float altitude, float time, float lobeNoise, float fineNoise) {
    vec2 baseCell = floor(warped / CELL_SIZE_KM);
    float total = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 cellId = baseCell + vec2(float(ox), float(oy));
        vec3 h = vec3(hash13(vec3(cellId, 11.0)), hash13(vec3(cellId, 23.0)), hash13(vec3(cellId, 47.0)));
        if (h.z < 0.42) continue; // ~58% of cells are open sky — real cumulus fields have gaps

        vec2 jitter = (hash22(cellId * 3.71) - 0.5) * CELL_SIZE_KM * 0.75;
        vec2 center = (cellId + 0.5) * CELL_SIZE_KM + jitter;

        float isTower = step(0.9, h.z); // ~10% of occupied cells: a secondary cumulonimbus
        float sizeRoll = h.x;
        float seed = h.y;

        float base = CLOUD_BASE_KM + hash13(vec3(cellId, 101.0)) * 0.35;
        float radius = mix(0.45, 1.4, sizeRoll) * mix(1.0, 1.5, isTower);
        float topSmall = base + mix(0.4, 1.6, sizeRoll);
        float towerPhase = fract((time + seed * 53.0) / (TOWER_CYCLE_SECONDS * 0.75));
        float topTower = base + towerGrowth(towerPhase) * (TOWER_TOP_MAX_KM * 0.6 - base);
        float top = mix(topSmall, topTower, isTower);
        float breathe = 0.9 + 0.1 * sin(time * 0.12 + seed * 25.0);
        top *= mix(breathe, 1.0, isTower);

        float distToCenter = length(warped - center);
        float heightFrac = clamp((altitude - base) / max(top - base, 0.001), 0.0, 1.0);
        // A single smooth bump (no flat plateau) — two independent smoothsteps
        // with overlapping ranges hold the *same* max radius across a wide middle
        // band, which reads as a flat-sided disc/mushroom stack once many cells
        // line up, not a rounded puff. heightJitter also shifts *where* that bump
        // sits per angle/position, so the widest point isn't a perfectly level
        // ring around every cloud (see the hero tower's identical fix above).
        float heightJitter = (fbm2D((warped - center) * 0.7) - 0.5) * 0.5;
        float jitteredHeightFrac = clamp(heightFrac + heightJitter, 0.0, 1.0);
        float bump = clamp(1.0 - pow(abs(jitteredHeightFrac * 2.0 - 0.85), 1.6), 0.0, 1.0);
        float radiusProfile = mix(0.4, 1.0, bump);
        float radiusAtHeight = radius * radiusProfile;

        // Revolving any smooth radius(height) profile around a vertical axis is,
        // by construction, a lens/saucer — real clouds break that symmetry with
        // lumpy, angle-dependent noise. The previous ±25%-of-radius perturbation
        // with a narrow falloff band was too weak/crisp to read as anything but a
        // slightly bumpy disc; both the noise amplitude and the falloff width need
        // to be a large fraction of the radius itself to actually hide the
        // rotational symmetry.
        float d = distToCenter - (lobeNoise * 0.95 + fineNoise * 0.45) * radiusAtHeight;
        float radial = 1.0 - smoothstep(radiusAtHeight * 0.25, radiusAtHeight * 1.15, max(d, 0.0));
        float topFall = 1.0 - smoothstep(top - 0.55, top + 0.1 + fineNoise * 0.5, altitude);
        float baseFall = smoothstep(base - 0.1, base + 0.05, altitude);

        total = max(total, radial * topFall * baseFall);
      }
    }
    return total;
  }

  float cloudDensity(vec3 p, float time, out float outIsTower) {
    float altitude = length(p - PLANET_CENTER) - PLANET_RADIUS;
    outIsTower = 0.0;
    if (altitude < CLOUD_BASE_KM) return 0.0;

    // Wind speed/curl strength tuned to be clearly visible frame-to-frame (not
    // just a subtle drift) — see plan.md §3.3 "流れ". Kept moderate here because
    // this warped coordinate also drives *which cell* a point falls in — too
    // strong a curl smears whole cloud cells into unrecognizable ribbons instead
    // of just drifting/billowing them. Extra turbulence for the boiling surface
    // detail is layered on separately below, where it can't distort cell layout.
    vec2 windDrift = vec2(0.16, 0.05) * time;
    vec2 flow = curl2D(p.xz * 0.10 + time * 0.025) * 0.35;
    vec2 warped = p.xz + windDrift + flow;

    vec2 detailFlow = curl2D(p.xz * 0.32 + time * 0.06) * 0.55;
    vec3 detailPos = vec3(warped + detailFlow, altitude - time * 0.05);
    float fieldLobeNoise = fbm3D(detailPos * 0.45, 4) - 0.5;
    float fieldFineNoise = fbm3D(detailPos * 1.7, 5) - 0.5;
    float backgroundDensity = scatteredCumulusField(warped, altitude, time, fieldLobeNoise, fieldFineNoise);

    // Hero tower: fixed horizontal position (composition-matched), growth animated.
    float towerPhase = fract((time + TOWER_SEED * 37.0) / TOWER_CYCLE_SECONDS);
    float growth = towerGrowth(towerPhase);
    float towerTop = CLOUD_BASE_KM + growth * (TOWER_TOP_MAX_KM - CLOUD_BASE_KM);

    vec2 toCenter = warped - TOWER_CENTER_KM.xz;
    float heightFrac = clamp((altitude - CLOUD_BASE_KM) / max(towerTop - CLOUD_BASE_KM, 0.001), 0.0, 1.0);
    // Cumulonimbus silhouette bulges in the upper-middle and tapers at both the
    // (flat) base and the top — a single smooth bump, not two independently-timed
    // smoothsteps, which would hold the same max radius across a wide band and
    // read as a flat-sided drum/disc instead of a rounded, continuously-swelling
    // thunderhead. Critically, the *height* of that bulge's equator is also
    // jittered by angle/position (heightJitter) — otherwise, even with a heavily
    // noise-perturbed radius, the widest point sits at exactly the same altitude
    // all the way around the tower, which reads as a perfectly level ring (a
    // flying-saucer silhouette) no matter how ragged its edge is.
    float heightJitter = (fbm2D(toCenter * 0.55) - 0.5) * 0.45;
    float jitteredHeightFrac = clamp(heightFrac + heightJitter, 0.0, 1.0);
    float towerBump = clamp(1.0 - pow(abs(jitteredHeightFrac * 2.0 - 0.75), 1.3), 0.0, 1.0);
    float radiusProfile = mix(0.55, 1.15, towerBump);
    float baseRadiusAtHeight = TOWER_RADIUS_KM * radiusProfile;

    // Vertical noise scroll biased upward, scaled by how actively the tower is
    // rising — sells the "welling up" motion on the boiling edges while growing.
    float boilSpeed = 0.4 * smoothstep(0.0, 0.35, growth) * (1.0 - smoothstep(0.7, 1.0, towerPhase));
    vec3 boilPos = vec3(warped, altitude - time * boilSpeed);

    // Cauliflower silhouette: perturb the *radius itself* (angle-dependent, via
    // large lumpy lobes + fine bumps) rather than only softening a fixed edge —
    // a plain radial smoothstep reads as a smooth spire/vase, not a billowing
    // cumulonimbus. Two noise octaves at very different frequencies give large
    // lobes (individual "cauliflower heads") with smaller bumps riding on them.
    float lobeNoise = fbm3D(boilPos * 0.42, 4) - 0.5;
    float fineNoise = fbm3D(boilPos * 1.6, 5) - 0.5;
    float radiusPerturb = 1.0 + lobeNoise * 0.9 + fineNoise * 0.35;
    float radiusAtHeight = baseRadiusAtHeight * max(radiusPerturb, 0.15);
    float distToCenter = length(toCenter) - (lobeNoise * baseRadiusAtHeight * 0.5);

    float erosion = worley3D(vec3(warped * 0.35, altitude * 0.35));

    float radialFalloff = 1.0 - smoothstep(radiusAtHeight * 0.35, radiusAtHeight * 1.15, max(distToCenter, 0.0));
    float topFalloff = 1.0 - smoothstep(towerTop - 0.9, towerTop + 0.25 + fineNoise * 0.6, altitude);
    float towerDensity = radialFalloff * topFalloff;
    towerDensity *= clamp(1.3 - erosion * 1.4, 0.0, 1.0);
    towerDensity *= step(altitude, towerTop + 1.2);

    outIsTower = step(backgroundDensity, towerDensity);
    return clamp(max(backgroundDensity, towerDensity), 0.0, 1.0);
  }

  const int CLOUD_STEPS = 80;
  const int SHADOW_STEPS = 6;
  const float CLOUD_EXTINCTION = 2.2;

  float lightMarch(vec3 p, vec3 sunDir, float time) {
    float shell = raySphere(p, sunDir, PLANET_CENTER, PLANET_RADIUS + TOWER_TOP_MAX_KM + 1.0).y;
    float stepSize = min(shell, 4.5) / float(SHADOW_STEPS);
    float accum = 0.0;
    vec3 pos = p;
    for (int i = 0; i < SHADOW_STEPS; i++) {
      pos += sunDir * stepSize;
      float dummy;
      accum += cloudDensity(pos, time, dummy) * stepSize;
    }
    return exp(-accum * CLOUD_EXTINCTION);
  }

  // Quantizes x into N=steps mostly-flat bands with a narrow ramp between them —
  // real-time volumetric raymarching integrates a smooth, continuous gradient,
  // which reads as photographic/hazy. Japanese anime background art instead uses
  // 2-3 *discrete* tonal zones per cloud (hard-edged shadow shape on a multiply
  // layer, flat lit surface, one hard highlight stripe) — see the cloud-painting
  // research this responds to. This is that quantization applied to the physical
  // shadow term, not a hand-picked look: the band edges are still a function of
  // the same computed self-shadow value, just discretized.
  float posterizeSoft(float x, float steps) {
    float scaled = x * steps;
    float base = floor(scaled);
    float frac = scaled - base;
    float edge = smoothstep(0.15, 0.85, frac);
    return clamp((base + edge) / steps, 0.0, 1.0);
  }

  // Energy-conserving multi-scatter approximation: sum attenuated single-scatter
  // contributions at decreasing "octaves" of phase sharpness/extinction (Schneider,
  // SIGGRAPH 2015/2017) instead of solving the full radiative-transfer equation.
  vec3 marchClouds(vec3 ro, vec3 rd, vec3 sunDir, vec3 ambientColor, float sunVisibility, float time, out float transmittanceOut) {
    float shellNear = raySphere(ro, rd, PLANET_CENTER, PLANET_RADIUS + CLOUD_BASE_KM).x;
    vec2 shellOuter = raySphere(ro, rd, PLANET_CENTER, PLANET_RADIUS + TOWER_TOP_MAX_KM + 1.0);
    float tStart = max(shellOuter.x, 0.0);
    float tEnd = shellOuter.y;
    if (shellNear > 0.0) tEnd = min(tEnd, shellNear);
    transmittanceOut = 1.0;
    if (tEnd <= tStart || rd.y <= 0.0) return vec3(0.0);
    tEnd = min(tEnd, tStart + 60.0);

    float stepSize = (tEnd - tStart) / float(CLOUD_STEPS);
    // Per-pixel dither on the march start: without it, every screen pixel samples
    // the density field at the exact same phase offset, so any sharp edge in
    // cloudDensity() (the base/top/radius smoothsteps) aliases into visible
    // stair-step bands instead of a soft boundary. This turns that aliasing into
    // much less objectionable high-frequency noise (standard raymarching fix).
    float jitter = hash13(vec3(gl_FragCoord.xy, 0.0));
    float tOffset = tStart + jitter * stepSize;
    float mu = dot(rd, sunDir);
    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;

    for (int i = 0; i < CLOUD_STEPS; i++) {
      if (transmittance < 0.008) break;
      vec3 samplePos = ro + rd * (tOffset + stepSize * (float(i) + 0.5));
      float isTower;
      float density = cloudDensity(samplePos, time, isTower);
      if (density <= 0.001) continue;

      float rawShadow = lightMarch(samplePos, sunDir, time);
      // Posterize the self-shadow term itself (not just the final color) so the
      // discretization happens *before* it drives the phase/powder math below —
      // otherwise those would still respond to the original continuous gradient
      // and the quantization would only be skin-deep. Only 2 bands (not 3): the
      // self-shadow value is itself noisy (it's a march through the same noisy
      // density field), and 3+ narrow bands turn that noise into speckled salt-
      // and-pepper flicker between adjacent bands instead of one coherent shadow
      // shape. A wide, soft transition further keeps small noise from crossing
      // the single boundary.
      float shadow = posterizeSoft(rawShadow, 2.0);

      float a = 1.0, b = 1.0, c = 1.0;
      float lightEnergy = 0.0;
      for (int o = 0; o < 4; o++) {
        float phase = mix(phaseHG(mu, MIE_G * b), phaseHG(-mu, 0.25 * b), 0.25);
        lightEnergy += a * phase * pow(shadow, c);
        a *= 0.5; b *= 0.5; c *= 0.75;
      }
      float powder = 1.0 - exp(-density * 3.0 * CLOUD_EXTINCTION);
      lightEnergy *= mix(1.0, powder, clamp(phaseHG(mu, MIE_G), 0.0, 1.0) * 2.0);

      // Split-tone: shadow zones pick up cool skylight (blue), lit zones pick up
      // warm direct sunlight (yellow/orange) — anime cloud painting separates
      // light and shadow by hue, not just brightness, rather than one neutral
      // white shaded darker. Driven by the same posterized shadow value, so it
      // steps in hard-edged bands together with the brightness.
      vec3 shadowTint = vec3(0.4, 0.55, 0.92);
      vec3 highlightTint = vec3(1.15, 1.02, 0.78);
      vec3 sunColor = mix(shadowTint, highlightTint, shadow);

      // Silver lining: a thin, still-mostly-transparent (high running
      // transmittance) patch of cloud seen close to the sun direction lets a lot
      // of forward-scattered light through and reads as a bright rim — the classic
      // backlit-cloud-edge glow. Approximated from quantities already at hand
      // (local density, view/sun alignment, how little cloud the ray has passed
      // through so far) rather than a separate edge-detection pass.
      float edgeThinness = 1.0 - smoothstep(0.0, 0.4, density);
      float silverLining = edgeThinness * pow(clamp(mu, 0.0, 1.0), 10.0) * transmittance;

      // Direct term must be on the same radiometric scale as the atmosphere
      // (SUN_INTENSITY) — without it, clouds render orders of magnitude dimmer
      // than the sky behind them regardless of how correct the phase/shadow math
      // is.
      // Direct sunlight reaching the cloud has already lost some intensity to
      // atmospheric extinction on the way there — the primary-ray integral above
      // accounts for this along the *view* ray but not along the sun->cloud path
      // beyond what lightMarch's self-shadow term covers. CLOUD_DIRECT_SCALE
      // stands in for that missing transmittance term (full radiative-transfer
      // coupling between the two passes is a later refinement, not a color pick).
      float CLOUD_DIRECT_SCALE = 1.35;
      vec3 sampleLuminance = sunVisibility * lightEnergy * SUN_INTENSITY * CLOUD_DIRECT_SCALE * sunColor
        + ambientColor
        + silverLining * SUN_INTENSITY * 0.6 * highlightTint;
      float sampleExtinction = density * CLOUD_EXTINCTION;
      vec3 sampleTransmittance = vec3(exp(-sampleExtinction * stepSize));
      vec3 integScatter = (sampleLuminance - sampleLuminance * sampleTransmittance) / max(sampleExtinction, 1e-5);

      scattered += transmittance * integScatter;
      transmittance *= sampleTransmittance.x;
    }

    transmittanceOut = transmittance;
    return scattered;
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 clip = vec4(ndc, -1.0, 1.0);
    vec4 viewSpace = uCameraInverseProjection * clip;
    viewSpace = vec4(viewSpace.xy, -1.0, 0.0);
    vec3 rd = normalize((uCameraWorldMatrix * viewSpace).xyz);
    vec3 ro = vec3(0.0, CAMERA_ALTITUDE_KM, 0.0);

    vec3 sunDir = normalize(uSunDirection);

    vec2 atmosHit = raySphere(ro, rd, PLANET_CENTER, ATMOS_RADIUS);
    vec2 groundHit = raySphere(ro, rd, PLANET_CENTER, PLANET_RADIUS);
    float rayLength = atmosHit.y;
    bool hitsGround = groundHit.x > 0.0;
    if (hitsGround) rayLength = min(rayLength, groundHit.x);

    vec3 skyTransmittance;
    vec3 skyColor = integrateAtmosphere(ro, rd, sunDir, max(rayLength, 0.001), skyTransmittance);

    // Sun disc + halo: falls straight out of the Mie phase function evaluated at
    // the true sun direction — no separate hand-tuned pow(sunDot,N) hack needed.
    float sunMu = dot(rd, sunDir);
    float sunDisc = smoothstep(0.9998, 0.99995, sunMu);
    skyColor += skyTransmittance * SUN_INTENSITY * sunDisc * 80.0;

    if (hitsGround) {
      // Ground is out of scope here (composited foreground layer covers it later,
      // plan.md §5) — a flat placeholder tint keeps the horizon from looking broken.
      skyColor = mix(skyColor, vec3(0.05, 0.07, 0.06), 0.9);
    }

    vec3 ambientSky = vec3(0.55, 0.7, 1.0) * clamp(sunDir.y + 0.15, 0.05, 1.0) * SUN_INTENSITY * 0.015;
    float sunVisibility = clamp(sunDir.y * 4.0 + 0.2, 0.0, 1.0);

    float cloudTransmittance = 1.0;
    vec3 cloudColor = vec3(0.0);
    if (!hitsGround) {
      cloudColor = marchClouds(ro, rd, sunDir, ambientSky, sunVisibility, uTime, cloudTransmittance);
    }

    vec3 color = skyColor * cloudTransmittance + cloudColor;

    // A custom ShaderMaterial bypasses three.js's automatic tonemapping/colorspace
    // shader chunks entirely (those only get woven in for built-in materials) — so
    // without this, every linear radiance value above 1.0 (routine here; the whole
    // point of physical units is an unbounded HDR range) just hard-clips to solid
    // white instead of rolling off, and the framebuffer receives un-gamma-encoded
    // linear values on top of that. Both steps are mandatory display-mapping, not
    // a look choice: ACES (Narkowicz's fit, the same curve three.js's
    // ACESFilmicToneMapping approximates) compresses HDR into displayable range,
    // then the sRGB OETF (~pow 1/2.2) encodes it for the framebuffer.
    vec3 a = color * (2.51 * color + 0.03);
    vec3 b = color * (2.43 * color + 0.59) + 0.14;
    vec3 mapped = clamp(a / b, 0.0, 1.0);
    mapped = pow(mapped, vec3(1.0 / 2.2));

    gl_FragColor = vec4(mapped, 1.0);
  }
`;

export function createSkyClouds(): SkyCloudsHandle {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCameraInverseProjection: { value: new THREE.Matrix4() },
      uCameraWorldMatrix: { value: new THREE.Matrix4() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uTime: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, material };
}

export function updateSkyClouds(
  handle: SkyCloudsHandle,
  camera: THREE.PerspectiveCamera,
  sunDir: THREE.Vector3,
  time: number,
): void {
  handle.material.uniforms.uCameraInverseProjection.value.copy(camera.projectionMatrixInverse);
  handle.material.uniforms.uCameraWorldMatrix.value.copy(camera.matrixWorld);
  handle.material.uniforms.uSunDirection.value.copy(sunDir);
  handle.material.uniforms.uTime.value = time;
}

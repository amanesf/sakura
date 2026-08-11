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

  // Polynomial smooth-min (Inigo Quilez's standard form) — the core operator for
  // fusing multiple sphere SDFs into one "collection of spheres" shape instead of
  // one blob-with-noise. k controls how much the spheres bulge into each other at
  // their seams versus reading as separate balls stuck together.
  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float sdSphere(vec3 p, vec3 center, float radius) {
    return length(p - center) - radius;
  }

  // Research finding (アニメ雲の描き方): "積乱雲は球体の集まりとしてとらえることが
  // でき、それぞれの球体の光が集まる一番明るくなるところと、暗く影になるところの
  // 組み合わせでもくもくとした形を作る" — a cumulonimbus reads as a *cluster of
  // spheres*, each with its own highlight/shadow, not one smoothly-varying blob.
  // This builds that cluster as an SDF: a few big lobes (the "2-3 connected
  // mountains" the research describes) fused with several smaller bumps riding on
  // them, via smin. Because it's a real union of sphere distance fields,
  // cloudNormal()'s gradient naturally curves around *each lobe's own center*
  // near that lobe — which is exactly what makes per-lobe shading fall out for
  // free, the same way it does for raymarched metaballs.
  float sphereClusterSDF(vec3 p, vec2 centerXZ, float baseAlt, float topAlt, float radius, float seed) {
    float heightSpan = max(topAlt - baseAlt, 0.001);
    float d = 1.0e5;

    // Independently-random offsets per sphere risked scattering big spheres far
    // enough apart to look like separate floating blobs (or, worse, a ring/arch
    // where a viewer's line of sight grazes between two disjoint lobes) instead
    // of one connected mass — exactly the "doesn't read as a cumulonimbus" bug.
    // Chaining each big sphere's XZ offset from the *previous* one, by a step
    // small relative to their radii, guarantees consecutive (height-ordered)
    // spheres always overlap enough to fuse solidly, like a stacked string of
    // pearls rather than independently-thrown dice.
    const int BIG_COUNT = 4;
    vec3 bigCenters[BIG_COUNT];
    float bigRadii[BIG_COUNT];
    vec2 chainOffset = vec2(0.0);
    for (int i = 0; i < BIG_COUNT; i++) {
      float fi = float(i);
      vec3 hs = vec3(
        hash13(vec3(seed, fi, 1.0)),
        hash13(vec3(seed, fi, 2.0)),
        hash13(vec3(seed, fi, 3.0))
      );
      float heightFrac = clamp((fi + 0.5) / float(BIG_COUNT) + (hs.z - 0.5) * 0.2, 0.05, 0.95);
      chainOffset += (hs.xy - 0.5) * radius * 0.3;
      vec3 sphereCenter = vec3(
        centerXZ.x + chainOffset.x,
        baseAlt + heightFrac * heightSpan,
        centerXZ.y + chainOffset.y
      );
      // Narrower toward the top — a tower's upper lobes are smaller than its base.
      float sphereRadius = radius * mix(0.9, 0.55, heightFrac) * mix(0.85, 1.15, hs.z);
      bigCenters[i] = sphereCenter;
      bigRadii[i] = sphereRadius;
      d = smin(d, sdSphere(p, sphereCenter, sphereRadius), radius * 0.4);
    }

    // Medium bumps are anchored to a *parent* big sphere's surface (picked by
    // hash) rather than placed independently within the whole cluster radius —
    // same reasoning: an independent placement could easily land far enough from
    // every big sphere to read as a disconnected fleck. Anchoring guarantees
    // every bump overlaps its parent lobe.
    const int MED_COUNT = 6;
    for (int i = 0; i < MED_COUNT; i++) {
      float fi = float(i);
      vec3 hs = vec3(
        hash13(vec3(seed, fi, 11.0)),
        hash13(vec3(seed, fi, 12.0)),
        hash13(vec3(seed, fi, 13.0))
      );
      int parentIdx = int(hs.z * float(BIG_COUNT) - 0.001);
      parentIdx = clamp(parentIdx, 0, BIG_COUNT - 1);
      vec3 parentCenter = bigCenters[parentIdx];
      float parentRadius = bigRadii[parentIdx];
      float upBias = hash13(vec3(seed, fi, 15.0)) - 0.35;
      vec3 dir = normalize(vec3(hs.x - 0.5, upBias, hs.y - 0.5) + 1e-4);
      vec3 sphereCenter = parentCenter + dir * parentRadius * 0.75;
      float sphereRadius = parentRadius * mix(0.35, 0.55, hash13(vec3(seed, fi, 14.0)));
      d = smin(d, sdSphere(p, sphereCenter, sphereRadius), radius * 0.25);
    }

    return d;
  }

  float sdfToDensity(float d, float thickness) {
    return 1.0 - smoothstep(0.0, thickness, d);
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
  float scatteredCumulusField(vec2 warped, float altitude, float time) {
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

        // Cluster-of-spheres shape (see sphereClusterSDF's header) instead of a
        // single radius(height) profile — this is what actually gives each cloud
        // its own several distinct lit/shadowed lobes rather than one bumpy disc.
        vec3 comovingP = vec3(warped.x, altitude, warped.y);
        float clusterSeed = seed * 91.7 + cellId.x * 13.1 + cellId.y * 7.7;
        float sdf = sphereClusterSDF(comovingP, center, base, top, radius, clusterSeed);
        float density = sdfToDensity(sdf, radius * 0.18);

        total = max(total, density);
      }
    }
    return total;
  }

  // The *shape* only — density before the fine worley erosion carving. Kept as its
  // own function because cloudNormal() below needs to take finite differences of
  // it: differencing the fully-eroded cloudDensity would pick up the erosion
  // noise itself and produce a noisy, speckled normal (see marchClouds' header
  // comment on why that broke the toon shading). This is the smooth "implicit
  // solid" that anime cloud painting effectively shades.
  float cloudShape(vec3 p, float time, out float outIsTower) {
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

    float backgroundDensity = scatteredCumulusField(warped, altitude, time);

    // Hero tower: fixed horizontal position (composition-matched), growth animated.
    float towerPhase = fract((time + TOWER_SEED * 37.0) / TOWER_CYCLE_SECONDS);
    float growth = towerGrowth(towerPhase);
    float towerTop = CLOUD_BASE_KM + growth * (TOWER_TOP_MAX_KM - CLOUD_BASE_KM);

    // Sphere-cluster shape (see sphereClusterSDF) — same "collection of spheres"
    // construction as the scattered field, just with a bigger radius so the tall
    // tower's individual lobes read at a scale proportionate to its height.
    vec3 towerComovingP = vec3(warped.x, altitude, warped.y);
    float towerSDF = sphereClusterSDF(towerComovingP, TOWER_CENTER_KM.xz, CLOUD_BASE_KM, towerTop, TOWER_RADIUS_KM * 1.3, TOWER_SEED);
    float towerDensity = sdfToDensity(towerSDF, TOWER_RADIUS_KM * 0.16);
    towerDensity *= step(altitude, towerTop + 1.2);

    outIsTower = step(backgroundDensity, towerDensity);
    return clamp(max(backgroundDensity, towerDensity), 0.0, 1.0);
  }

  // Fine worley erosion carved on top of the smooth shape — this is what should
  // drive extinction/opacity (it's fine for the cloud's *alpha* to be a bit
  // textured), just not the shading normal.
  float cloudDensity(vec3 p, float time, out float outIsTower) {
    float shape = cloudShape(p, time, outIsTower);
    if (shape <= 0.0) return 0.0;
    float altitude = length(p - PLANET_CENTER) - PLANET_RADIUS;
    vec2 windDrift = vec2(0.16, 0.05) * time;
    vec2 flow = curl2D(p.xz * 0.10 + time * 0.025) * 0.35;
    vec2 warped = p.xz + windDrift + flow;
    float erosion = worley3D(vec3(warped * 0.35, altitude * 0.35));
    return clamp(shape * clamp(1.3 - erosion * 1.4, 0.0, 1.0), 0.0, 1.0);
  }

  // Smooth surface normal from the *shape* field's gradient (not the eroded
  // density) — the mathematical core of the fix: anime cloud shading is
  // effectively toon-shading an implicit smooth solid via N·L, not accumulating
  // noisy volumetric self-shadow. A large-ish epsilon (0.35km) also helps average
  // out what small-scale noise remains in cloudShape (the lobe/fine noise terms),
  // keeping the normal — and therefore the light/shadow boundary — coherent
  // instead of salt-and-pepper.
  vec3 cloudNormal(vec3 p, float time) {
    float eps = 0.35;
    float dummy;
    float c = cloudShape(p, time, dummy);
    float dx = c - cloudShape(p + vec3(eps, 0.0, 0.0), time, dummy);
    float dy = c - cloudShape(p + vec3(0.0, eps, 0.0), time, dummy);
    float dz = c - cloudShape(p + vec3(0.0, 0.0, eps), time, dummy);
    vec3 n = vec3(dx, dy, dz);
    float len = length(n);
    return len < 1e-5 ? vec3(0.0, 1.0, 0.0) : n / len;
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

      // Primary shading driver: N·L against a *smooth* surface normal (the
      // gradient of the un-eroded shape field), toon-quantized — this is the
      // actual fix for the speckling. The previous version posterized the
      // volumetric self-shadow value directly, but that value is inherently
      // noisy (a march through the same fractal density field the shape is made
      // of), so quantizing it just turned continuous noise into discrete salt-
      // and-pepper. A density-gradient normal is coherent by construction, the
      // same way a toon-shaded 3D model's surface normal is — anime cloud
      // painting shades an implicit smooth solid, not a participating medium.
      vec3 normal = cloudNormal(samplePos, time);
      float NdotL = dot(normal, sunDir);
      float shadow = posterizeSoft(clamp(NdotL * 0.5 + 0.5, 0.0, 1.0), 3.0);

      // Cast shadow from other cloud mass (e.g. a tower's own overhang darkening
      // what's beneath it) stays as a *continuous* secondary multiplier — folding
      // it back in post-quantization, rather than quantizing it itself, keeps the
      // coherent N·L boundary as the dominant visual read while still letting
      // genuinely-occluded pockets go darker.
      float castShadow = lightMarch(samplePos, sunDir, time);
      float shadeFactor = shadow * mix(0.6, 1.0, castShadow);

      float a = 1.0, b = 1.0, c = 1.0;
      float lightEnergy = 0.0;
      for (int o = 0; o < 4; o++) {
        float phase = mix(phaseHG(mu, MIE_G * b), phaseHG(-mu, 0.25 * b), 0.25);
        lightEnergy += a * phase * pow(shadeFactor, c);
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

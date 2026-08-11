import * as THREE from 'three';

export interface SkyHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

/**
 * Atmosphere backdrop only — physically-based Rayleigh + Mie single scattering
 * (plan.md §3.1), fullscreen raymarch. Clouds used to be raymarched in this same
 * pass (see git history / scene/skyClouds.ts) but moved to real mesh instances in
 * scene/clouds.ts after reviewing amanesf/planet-canvas2's cloud system — this
 * file keeps only the sky.
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

  const float PI = 3.14159265359;

  const float PLANET_RADIUS = 6371.0;
  const float ATMOS_RADIUS = 6471.0;
  const vec3 PLANET_CENTER = vec3(0.0, -PLANET_RADIUS, 0.0);
  const vec3 RAYLEIGH_COEFF = vec3(5.8e-3, 13.5e-3, 33.1e-3);
  const float RAYLEIGH_SCALE_HEIGHT = 8.0;
  const float MIE_COEFF = 9.0e-3;
  const float MIE_EXT = MIE_COEFF * 1.11;
  const float MIE_SCALE_HEIGHT = 1.2;
  const float MIE_G = 0.76;
  const float SUN_INTENSITY = 11.0;
  const float SKY_SATURATION = 1.7;
  const float CAMERA_ALTITUDE_KM = 0.0017;

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

    vec3 lostEnergy = vec3(1.0) - transmittance;
    vec3 multiScatterFudge = lostEnergy * SUN_INTENSITY * 0.004 * clamp(sunDir.y * 1.5 + 0.4, 0.05, 1.0);

    return singleScatter + multiScatterFudge;
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
    // Deliberately *not* shortened to the ground hit. Stopping the integral
    // at the planet surface is the physically correct thing to do, but just
    // below the horizon the ground distance collapses very fast, so the
    // atmospheric path — and with it the radiance — falls off a cliff over a
    // few pixels. That produced a black band hugging the horizon, darker than
    // the ground beneath it. Since the ground here is only a placeholder for a
    // foreground layer that will cover it (plan.md §5), the integral is left
    // at full atmospheric length so the value stays continuous across the
    // horizon, and the ground is applied purely as a tint below.

    vec3 skyTransmittance;
    vec3 skyColor = integrateAtmosphere(ro, rd, sunDir, max(rayLength, 0.001), skyTransmittance);

    float sunMu = dot(rd, sunDir);
    float sunDisc = smoothstep(0.9998, 0.99995, sunMu);
    skyColor += skyTransmittance * SUN_INTENSITY * sunDisc * 80.0;

    if (hitsGround) {
      // Ground is out of scope here (a composited foreground layer covers it
      // later, plan.md §5), but a flat tint applied at full strength right up
      // to the horizon put a hard dark line across the frame that dominated
      // every test render. Fading it in with the downward view angle lets the
      // ground emerge out of the horizon haze instead, which is both what
      // aerial perspective actually does at that distance and far less
      // distracting while the sky is what is being judged.
      // NB smoothstep's edges must be given in increasing order — passing
      // them reversed is undefined in GLSL.
      float below = 1.0 - smoothstep(-0.07, 0.0, rd.y);
      vec3 land = mix(skyColor, vec3(0.05, 0.07, 0.06), 0.92);
      skyColor = mix(skyColor, land, below);
    }

    // Left in linear HDR, no manual tonemapping/gamma here — now that main.ts
    // runs an EffectComposer (core/postFx.ts), its OutputPass does both for
    // every pass's output uniformly (this shader's and the cloud materials'
    // alike). Doing it here too, on top of that, was fine back when this was
    // the only pass writing straight to the screen, but stacked with
    // OutputPass it would double-apply the sRGB curve and wash out shadows.
    // Art-directed saturation lift, applied at constant luminance.
    //
    // Measured against the reference image, the physical simulation above is
    // *correct* and still does not match it. Rayleigh scattering fixes the
    // zenith's red/blue ratio at coeff_R/coeff_B = 5.8/33.1 = 0.175 in linear
    // light, which after sRGB encoding lands at 0.47 — and that is precisely
    // what this shader renders. The reference's sky sits at 0.19 in sRGB,
    // i.e. about 0.03 in linear: roughly six times bluer than single-scattering
    // Rayleigh permits under any sun elevation or turbidity. Comparing the two
    // at matched screen heights, their luminances agree to within 2/255 while
    // their saturations differ by a factor of ~2, so the gap is purely a
    // saturation choice by the illustrator, not a physical parameter this
    // shader got wrong.
    //
    // Rather than distort the scattering constants (which would then be lying
    // about what they are, and would break the sunset arc the same constants
    // have to serve), the physics is left intact and the stylisation is a
    // separate, explicit, luminance-preserving step — the same stance taken
    // for the clouds, whose palette is likewise measured from the reference
    // rather than derived.
    // Faded out toward the horizon. Applied uniformly, the lift also
    // amplifies the warm low-altitude haze band into a hard yellow stripe,
    // which the reference does not have — there the haze desaturates to a
    // pale blue-white. That is the physically right behaviour too (the long
    // horizon path is aerosol-dominated, and aerosol scattering is
    // wavelength-neutral), so the stylisation has no business strengthening
    // it: the lift belongs to the clean Rayleigh zenith only.
    float horizonFade = smoothstep(-0.02, 0.28, rd.y);
    float skyLuma = dot(skyColor, vec3(0.2126, 0.7152, 0.0722));
    skyColor = mix(vec3(skyLuma), skyColor, mix(1.0, SKY_SATURATION, horizonFade));

    gl_FragColor = vec4(max(skyColor, 0.0), 1.0);
  }
`;

export function createSky(): SkyHandle {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCameraInverseProjection: { value: new THREE.Matrix4() },
      uCameraWorldMatrix: { value: new THREE.Matrix4() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
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

export function updateSky(handle: SkyHandle, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3): void {
  handle.material.uniforms.uCameraInverseProjection.value.copy(camera.projectionMatrixInverse);
  handle.material.uniforms.uCameraWorldMatrix.value.copy(camera.matrixWorld);
  handle.material.uniforms.uSunDirection.value.copy(sunDir);
}

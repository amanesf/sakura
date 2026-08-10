import * as THREE from 'three';

export interface SkyHandle {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  uniform vec3 uTopColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uBottomColor;
  uniform float uHorizonHeight;
  uniform float uExponent;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uCloudDensity;
  uniform float uTime;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += amp * valueNoise(p);
      p *= 2.02;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec3 dir = normalize(vWorldPosition);
    float h = dir.y;
    float t = clamp((h - uHorizonHeight) / (1.0 - uHorizonHeight), 0.0, 1.0);
    vec3 upperMix = mix(uHorizonColor, uTopColor, pow(t, uExponent));
    float b = clamp((uHorizonHeight - h) / (uHorizonHeight + 1.0), 0.0, 1.0);
    vec3 color = mix(upperMix, uBottomColor, pow(b, uExponent * 0.6));

    // Soft drifting cloud layer, kept high in the sky so it reads as scattered
    // clouds against blue rather than a haze across the whole dome.
    if (h > 0.12) {
      vec2 cloudUv = dir.xz / max(h, 0.15) * 0.6 + vec2(uTime * 0.004, uTime * 0.0015);
      float clouds = fbm(cloudUv);
      clouds = smoothstep(0.6, 0.88, clouds) * uCloudDensity;
      clouds *= smoothstep(0.12, 0.32, h) * (1.0 - smoothstep(0.7, 1.0, h));
      color = mix(color, vec3(1.0), clouds * 0.6);
    }

    // Sun glow: a soft bright halo around the actual light direction, cheap enough
    // without a lens-flare texture and reads well once bloom picks it up.
    float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);
    float glow = pow(sunDot, 340.0) * 3.0 + pow(sunDot, 24.0) * 0.35;
    color += uSunColor * glow;

    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * A large inward-facing sphere with a vertical gradient, soft drifting clouds, and a
 * glowing sun disc toward the current key-light direction. Season crossfades
 * (season-transition-animation.md §10) still just push a handful of color/vector
 * uniforms — see seasons/applySeasonState.ts.
 */
export function createSky(): SkyHandle {
  const geometry = new THREE.SphereGeometry(220, 48, 24);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTopColor: { value: new THREE.Color('#bfe2ff') },
      uHorizonColor: { value: new THREE.Color('#eaf4ff') },
      uBottomColor: { value: new THREE.Color('#cfe0dd') },
      uHorizonHeight: { value: 0.02 },
      uExponent: { value: 0.32 },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color('#fff3e0') },
      uCloudDensity: { value: 0.55 },
      uTime: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -10;
  return { mesh, material };
}

export function updateSky(sky: SkyHandle, time: number): void {
  sky.material.uniforms.uTime.value = time;
}

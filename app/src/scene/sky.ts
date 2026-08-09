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

  void main() {
    float h = normalize(vWorldPosition).y;
    float t = clamp((h - uHorizonHeight) / (1.0 - uHorizonHeight), 0.0, 1.0);
    vec3 upperMix = mix(uHorizonColor, uTopColor, pow(t, uExponent));
    float b = clamp((uHorizonHeight - h) / (uHorizonHeight + 1.0), 0.0, 1.0);
    vec3 color = mix(upperMix, uBottomColor, pow(b, uExponent * 0.6));
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * A large inward-facing sphere with a vertical gradient. Cheap, and lets the season
 * system (season-transition-animation.md §10) crossfade sky tone the same way it
 * crossfades everything else: as a handful of color uniforms.
 */
export function createSky(): SkyHandle {
  const geometry = new THREE.SphereGeometry(220, 32, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTopColor: { value: new THREE.Color('#bfe2ff') },
      uHorizonColor: { value: new THREE.Color('#eaf4ff') },
      uBottomColor: { value: new THREE.Color('#cfe0dd') },
      uHorizonHeight: { value: 0.02 },
      uExponent: { value: 0.55 },
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

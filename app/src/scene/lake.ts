import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

export interface LakeHandle {
  mesh: Reflector;
  uniforms: { uTime: { value: number }; uFieldStrength: { value: number } };
}

/**
 * Ripple shader layered on top of three/examples' Reflector: rather than a real
 * wave-normal texture (no offline asset pipeline for one — see
 * agent-workflow-policy.md §10-A on avoiding third-party assets), the reflected UV
 * is perturbed by a couple of summed sine waves before sampling, which reads as
 * gentle water motion without needing a normal map. Ripple energy tracks the time
 * field (依頼B, §4 table row "湖面"): a barely-there idle shimmer, stronger during
 * transition/shedding spikes once 依頼D/E exist.
 */
const RIPPLE_SHADER = {
  name: 'RippleReflectorShader',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0 },
    uFieldStrength: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec2 vWorldXZ;

    #include <common>
    #include <logdepthbuf_pars_vertex>

    void main() {
      vUv = textureMatrix * vec4( position, 1.0 );
      vWorldXZ = ( modelMatrix * vec4( position, 1.0 ) ).xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFieldStrength;
    varying vec4 vUv;
    varying vec2 vWorldXZ;

    #include <logdepthbuf_pars_fragment>

    float blendOverlay( float base, float blend ) {
      return( base < 0.5 ? ( 2.0 * base * blend ) : ( 1.0 - 2.0 * ( 1.0 - base ) * ( 1.0 - blend ) ) );
    }

    vec3 blendOverlay( vec3 base, vec3 blend ) {
      return vec3( blendOverlay( base.r, blend.r ), blendOverlay( base.g, blend.g ), blendOverlay( base.b, blend.b ) );
    }

    void main() {
      #include <logdepthbuf_fragment>

      float rippleEnergy = 0.0015 + uFieldStrength * 0.004;
      float ripple =
        sin( vWorldXZ.x * 1.3 + vWorldXZ.y * 0.7 + uTime * 0.9 ) +
        sin( vWorldXZ.x * -0.6 + vWorldXZ.y * 1.6 + uTime * 1.3 ) * 0.6;
      vec4 distortedUv = vUv;
      distortedUv.xy += ripple * rippleEnergy * vUv.w;

      vec4 base = texture2DProj( tDiffuse, distortedUv );
      gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );
    }`,
};

export function createLake(radius = 40): LakeHandle {
  const geometry = new THREE.CircleGeometry(radius, 64);
  const mesh = new Reflector(geometry, {
    color: new THREE.Color('#9fb9c2'),
    textureWidth: 1024,
    textureHeight: 1024,
    clipBias: 0.003,
    shader: RIPPLE_SHADER,
  });
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0, 3.5);

  const material = mesh.material as THREE.ShaderMaterial;
  const uniforms = {
    uTime: material.uniforms.uTime as { value: number },
    uFieldStrength: material.uniforms.uFieldStrength as { value: number },
  };

  return { mesh, uniforms };
}

export function updateLake(lake: LakeHandle, time: number, fieldStrength: number): void {
  lake.uniforms.uTime.value = time;
  lake.uniforms.uFieldStrength.value = fieldStrength;
}

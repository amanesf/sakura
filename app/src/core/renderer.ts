import * as THREE from 'three';

const MAX_PIXEL_RATIO = 2;

export function createRenderer(canvasHost: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the sky is one fullscreen raymarch shader; MSAA on a single triangle buys nothing
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Tonemapping/gamma are done manually inside skyClouds.ts's fragment shader
  // instead — a custom ShaderMaterial doesn't get three.js's automatic
  // tonemapping/colorspace shader chunks, so leaving these at their defaults here
  // would silently do nothing rather than double-apply.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  canvasHost.appendChild(renderer.domElement);
  return renderer;
}

export function watchResize(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  onResize?: (width: number, height: number) => void,
): () => void {
  const handler = () => {
    const { innerWidth, innerHeight } = window;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    onResize?.(innerWidth, innerHeight);
  };
  window.addEventListener('resize', handler);
  handler();
  return () => window.removeEventListener('resize', handler);
}

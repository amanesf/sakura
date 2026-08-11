import * as THREE from 'three';

const MAX_PIXEL_RATIO = 2;

export function createRenderer(canvasHost: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the sky is one fullscreen raymarch shader; MSAA on a single triangle buys nothing
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Clouds are now real MeshStandardMaterial instances (scene/clouds.ts) that
  // *do* go through three.js's automatic tonemapping/colorspace shader chunks,
  // so this needs to be on for them — unlike sky.ts's raw ShaderMaterial, which
  // still does its own tonemapping manually and is unaffected by this setting.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
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

import * as THREE from 'three';

/**
 * Pixel 10 Pro is the only target device (see season-transition-animation.md §13),
 * so we lean on its GPU headroom instead of scaling quality down for weaker hardware.
 */
const MAX_PIXEL_RATIO = 2;

export function createRenderer(canvasHost: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasHost.appendChild(renderer.domElement);
  return renderer;
}

export function watchResize(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
): () => void {
  const onResize = () => {
    const { innerWidth, innerHeight } = window;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();
  return () => window.removeEventListener('resize', onResize);
}

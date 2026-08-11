import * as THREE from 'three';

const MAX_PIXEL_RATIO = 2;

export function createRenderer(canvasHost: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the sky is one fullscreen raymarch shader; MSAA on a single triangle buys nothing
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // core/postFx.ts's OutputPass is what actually applies tonemapping/colorspace
  // now (both sky.ts and the cloud MeshStandardMaterials output linear HDR) —
  // these renderer-level settings matter only in that they're what OutputPass
  // reads.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
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

import * as THREE from 'three';

const MAX_PIXEL_RATIO = 2;

export function createRenderer(canvasHost: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false, // the sky is one fullscreen raymarch shader; MSAA on a single triangle buys nothing
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(canvasHost.clientWidth || 1, canvasHost.clientHeight || 1);
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

/**
 * The canvas no longer fills the window. In the portrait layout it is one band
 * of a page that also carries a title and the console (style.css), so its size
 * is the *host element's* size — which the CSS derives from the viewport width
 * plus the deliberate left/right bleed, not from window.innerHeight. Watching
 * `resize` alone would miss the cases that actually move this box (safe-area
 * changes, the console growing as controls are added to it), so a
 * ResizeObserver on the host is the signal.
 */
export function watchResize(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  onResize?: (width: number, height: number) => void,
): () => void {
  const host = renderer.domElement.parentElement ?? document.body;
  let lastW = -1;
  let lastH = -1;
  const handler = () => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    if (width === lastW && height === lastH) return;
    lastW = width;
    lastH = height;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    onResize?.(width, height);
  };
  const observer = new ResizeObserver(handler);
  observer.observe(host);
  window.addEventListener('resize', handler);
  handler();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', handler);
  };
}

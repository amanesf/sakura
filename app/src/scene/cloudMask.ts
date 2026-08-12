import * as THREE from 'three';

/**
 * A small binary picture of where the clouds are, read back to the CPU.
 *
 * This exists for the outline panel (ui/outlinePanel.ts), and the reason it is
 * a *mask* rather than anything cleverer is the whole trick behind that panel:
 * once every cloud is drawn flat white into one buffer, overlapping clouds have
 * merged into a single figure. Nothing downstream has to work out which lobe
 * belongs to which cluster, or which contour is inside another, because the
 * buffer no longer knows. Tracing its boundary gives exactly the outer
 * silhouette of the union — the hard-sounding half of "只 the outside when they
 * overlap" is the half that comes free.
 *
 * Rendered with the *view* camera, so the panel frames the sky the same way the
 * picture does. It does not, however, know about the plate: the painted window
 * frames hide parts of the sky in the picture and do not hide anything here.
 * That is deliberate — the panel is a reading of the sky, not a tracing of the
 * photograph, and stopping the lines at the mullions would make it look broken
 * rather than intentional.
 */
export interface CloudMask {
  width: number;
  height: number;
  /** Re-renders and reads back. Returns RGBA bytes, `width * height * 4`. */
  update: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    hidden: THREE.Object3D[],
  ) => Uint8Array;
  dispose: () => void;
}

export function createCloudMask(width: number, height: number): CloudMask {
  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  target.texture.generateMipmaps = false;

  // Unlit and untextured on purpose: this buffer is asked one question only,
  // "is there cloud here", so any shading would just be noise to threshold away.
  const flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const pixels = new Uint8Array(width * height * 4);

  const update = (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    hidden: THREE.Object3D[],
  ) => {
    const restore = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();

    scene.overrideMaterial = flat;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    hidden.forEach((o, i) => { o.visible = restore[i]; });
    return pixels;
  };

  return {
    width,
    height,
    update,
    dispose: () => { target.dispose(); flat.dispose(); },
  };
}

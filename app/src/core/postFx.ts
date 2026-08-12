import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GradeShader } from '../effects/gradeShader';
import { AnisotropicKuwaharaPass } from '../effects/anisotropicKuwahara';
import { MacroContrastPass } from '../effects/macroContrast';
import { PlateShader } from '../effects/plateShader';

export interface PostFx {
  setSize: (width: number, height: number) => void;
  setPlateRect: (rect: THREE.Vector4) => void;
  render: () => void;
}

/** Soft bloom (the cloud rim-light/highlights bleeding into the sky, the
 * "glowing" quality reference-image cumulus has) + a light finishing grade.
 *
 * The grade is deliberately near-identity for the clouds now: its old
 * saturation/contrast/split-tone lift existed to push an untinted PBR render
 * toward illustration, but the reference image is *already* a graded frame
 * and its grade is baked into the measured colour ramp the clouds sample.
 * Running the old grade on top of that double-grades them. */
export function createPostFx(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): PostFx {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Threshold raised 0.86 -> 7.0 and strength cut 0.45 -> 0.07. The cloud
  // material now emits the reference's measured colours *inverse-tonemapped*
  // into linear HDR (cloudRamp.ts), which puts its white crown at ~8.2 and
  // even its deepest shadow at ~0.02-0.5 — against the old 0.86 threshold the
  // entire cloud, shadows included, would have been treated as a bloom
  // source and the measured tonal separation immediately washed back out.
  // 7.0 sits just under the ramp's top entry (8.16), so only the genuinely
  // sunlit crown blooms rather than every lit lobe cap.
  // Strength 0.045 -> 0.12, radius 0.65 -> 0.80.
  //
  // This is now also what supplies the silhouette's soft edge, which the
  // deleted fringe shell used to fake. Removing that shell took the render from
  // far too soft to far too crisp — 87.5% of contour crossings 6px or wider,
  // then 33.2%, against the reference's 56.6%, at a median of 16px then 2px
  // against its 9px. Veiling glare around a bright cloud is a real optical
  // effect and, unlike a geometric shell, it is depth-correct by construction
  // and applies only where the cloud is actually bright — which matches the
  // reference, whose soft edges are about half its contour rather than all of
  // it. The threshold stays at 8.2 so only the genuinely sunlit crown blooms.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.12, 0.80, 8.2);
  composer.addPass(bloomPass);

  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  composer.addPass(new OutputPass());

  // Kuwahara runs *after* OutputPass, i.e. on tonemapped display-space sRGB
  // rather than on the linear HDR buffer. Its quadrant variance test is a
  // perceptual judgement ("which side of this pixel is the flatter region"),
  // and in linear HDR that test is dominated entirely by the few brightest
  // pixels — the cloud crown sits near 8.0 while its shadows sit below 0.5,
  // so almost every window would pick the same quadrant and the filter would
  // smear rather than form painterly regions.
  const kuwaharaPass = new AnisotropicKuwaharaPass(window.innerWidth, window.innerHeight);
  composer.addPass(kuwaharaPass);

  // Last, after the painterly filter: this widens the separation between the
  // large light and shadow masses, and running it before Kuwahara would just
  // hand that filter a wider range to average back down.
  const macroPass = new MacroContrastPass(window.innerWidth, window.innerHeight);
  composer.addPass(macroPass);

  // The foreground plate goes on last — see effects/plateShader.ts for why
  // nothing may run after it.
  const plateTexture = new THREE.TextureLoader().load('plate.webp');
  // The buffer at this point is already display-space sRGB (OutputPass ran
  // several passes ago), so the plate must be sampled raw. Tagging it
  // SRGBColorSpace would have the sampler linearise it into a buffer that is
  // not linear, washing the illustration out.
  plateTexture.colorSpace = THREE.NoColorSpace;
  plateTexture.minFilter = THREE.LinearFilter;
  plateTexture.magFilter = THREE.LinearFilter;
  plateTexture.generateMipmaps = false;
  const platePass = new ShaderPass(PlateShader);
  platePass.uniforms.tPlate.value = plateTexture;
  composer.addPass(platePass);

  const setSize = (width: number, height: number) => {
    composer.setSize(width, height);
    kuwaharaPass.setSize(width, height);
    macroPass.setSize(width, height);
    bloomPass.setSize(width, height);
    gradePass.uniforms.uAspect.value = width / height;
  };

  const setPlateRect = (rect: THREE.Vector4) => {
    platePass.uniforms.uPlateRect.value.copy(rect);
  };

  return { setSize, setPlateRect, render: () => composer.render() };
}

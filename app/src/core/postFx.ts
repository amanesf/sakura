import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GradeShader } from '../effects/gradeShader';
import { KuwaharaShader } from '../effects/kuwaharaShader';

export interface PostFx {
  setSize: (width: number, height: number) => void;
  render: () => void;
}

/** Kuwahara (oil-painting NPR filter, run before bloom so it flattens the
 * raw render rather than fighting bloom's already-soft highlight bleed) +
 * soft bloom (the cloud rim-light/highlights bleeding into the sky, the
 * "glowing" quality reference-image cumulus has) + a teal/orange grade pass. */
export function createPostFx(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): PostFx {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const kuwaharaPass = new ShaderPass(KuwaharaShader);
  composer.addPass(kuwaharaPass);

  const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.45, 0.55, 0.86);
  composer.addPass(bloomPass);

  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  composer.addPass(new OutputPass());

  const setSize = (width: number, height: number) => {
    composer.setSize(width, height);
    kuwaharaPass.uniforms.uTexelSize.value = [1 / width, 1 / height];
    bloomPass.setSize(width, height);
    gradePass.uniforms.uAspect.value = width / height;
  };

  return { setSize, render: () => composer.render() };
}

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { TransitionWaveShader } from '../effects/transitionWaveShader';
import type { ActiveWave } from '../seasons/sceneTransition';
import { getWaveColor } from '../seasons/sceneTransition';

export interface PostFx {
  composer: EffectComposer;
  setSize: (width: number, height: number) => void;
  updateWave: (wave: ActiveWave | null, time: number) => void;
  render: () => void;
}

/**
 * Thin wrapper around three's bundled EffectComposer (three/examples/jsm —
 * no extra dependency) carrying just the one pass this app needs so far: the
 * season-transition light wave (依頼D). Other post effects mentioned in
 * proposal.md §4.2/§9 (bloom, DOF, chromatic aberration, ...) are later polish and
 * would slot in here as additional passes.
 */
export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFx {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const wavePass = new ShaderPass(TransitionWaveShader);
  wavePass.enabled = false;
  composer.addPass(wavePass);

  const setSize = (width: number, height: number) => {
    composer.setSize(width, height);
    wavePass.uniforms.uAspect.value = width / height;
  };

  const updateWave = (wave: ActiveWave | null, time: number) => {
    wavePass.enabled = wave !== null;
    if (!wave) return;
    wavePass.uniforms.uProgress.value = wave.progress;
    wavePass.uniforms.uColor.value.copy(getWaveColor(wave.toIndex));
    wavePass.uniforms.uTime.value = time;
  };

  return { composer, setSize, updateWave, render: () => composer.render() };
}

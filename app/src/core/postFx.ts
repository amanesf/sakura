import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { TransitionWaveShader } from '../effects/transitionWaveShader';
import { GradeShader } from '../effects/gradeShader';
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
 * no extra dependency): a soft bloom for the painterly glow the reference art has
 * (proposal.md §4.2/§9), the season-transition light wave (依頼D), then an
 * OutputPass to restore correct tone mapping/color space on the final blit.
 */
export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFx {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.55,
    0.6,
    0.82,
  );
  composer.addPass(bloomPass);

  // Always enabled, parked at uProgress=1 (a verified no-op — see
  // transitionWaveShader.ts's fadeOut term) rather than toggling `.enabled`. Three.js
  // compiles a ShaderPass's program lazily on first render; toggling it on only at
  // the first real transition meant that compile happened mid-scene, at the same
  // moment canopy density/instance count jumps for the new season — suspected cause
  // of a mobile GPU context loss the first time a transition ever fired. Keeping it
  // warm from frame one avoids stacking a first-time shader compile on top of that.
  const wavePass = new ShaderPass(TransitionWaveShader);
  wavePass.uniforms.uProgress.value = 1;
  composer.addPass(wavePass);

  const gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);

  composer.addPass(new OutputPass());

  const setSize = (width: number, height: number) => {
    composer.setSize(width, height);
    bloomPass.setSize(width, height);
    wavePass.uniforms.uAspect.value = width / height;
    gradePass.uniforms.uAspect.value = width / height;
  };

  const updateWave = (wave: ActiveWave | null, time: number) => {
    if (!wave) {
      wavePass.uniforms.uProgress.value = 1;
      return;
    }
    wavePass.uniforms.uProgress.value = wave.progress;
    wavePass.uniforms.uColor.value.copy(getWaveColor(wave.toIndex));
    wavePass.uniforms.uTime.value = time;
  };

  return { composer, setSize, updateWave, render: () => composer.render() };
}

import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera } from './core/camera';
import { createComposition } from './scene/composition';
import { sampleSeasonState } from './seasons/seasonState';
import { applySeasonState } from './seasons/applySeasonState';
import { sampleTimeField } from './core/timeField';
import { updateTreeAnimation } from './scene/tree';
import { updateVegetationAnimation } from './scene/vegetation';
import { updateFlowerAnimation } from './scene/flowers';
import { updateSheddingAnimation } from './scene/sheddingParticles';
import { updateLake } from './scene/lake';
import { updateSky } from './scene/sky';
import { TimeMachineDial } from './ui/dial';
import { SceneTransitionController } from './seasons/sceneTransition';
import { createPostFx } from './core/postFx';

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
const camera = createCamera(window.innerWidth / window.innerHeight);
const composition = await createComposition();
const postFx = createPostFx(renderer, composition.scene, camera);

watchResize(renderer, camera);
const onResize = () => postFx.setSize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', onResize);
onResize();

/**
 * `?dial=<0..6>` freezes on one keyframe, hides the interactive dial, and skips the
 * transition wave — for deterministic review screenshots (agent-workflow-policy.md
 * §6) instead of racing the wall clock, a pointer, or a 1.6s wave animation.
 */
const searchParams = new URLSearchParams(window.location.search);
const frozenDial = searchParams.get('dial');
const frozenDialValue = frozenDial !== null ? Number(frozenDial) : null;

/**
 * `?wave=<0..1>&waveTo=<0..5>` (only with `?dial=`) freezes the transition-wave
 * overlay at an exact progress instead of playing it in real time — screenshot
 * round-trips in this environment take longer than the 1.6s transition itself, so
 * racing the wall clock can't reliably capture a mid-wave frame.
 */
const frozenWaveProgress = searchParams.has('wave') ? Number(searchParams.get('wave')) : null;
const frozenWaveTo = searchParams.has('waveTo') ? Number(searchParams.get('waveTo')) : null;

const dial = frozenDialValue === null ? new TimeMachineDial() : null;
if (dial) appHost.appendChild(dial.element);
const transitions = frozenDialValue === null ? new SceneTransitionController() : null;

const clock = new THREE.Clock();
let elapsed = 0;

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = clock.getDelta();
  elapsed += dt;

  dial?.advance(dt);

  // 依頼D: the dial's continuous position only decides *where the wave is heading*;
  // the actually-rendered scene is always a pure keyframe, swapped mid-wave.
  const transitionState = transitions?.update(dt, dial!.dialPosition) ?? null;
  const seasonIndex = frozenDialValue ?? transitionState!.committedSeasonIndex;
  const wave =
    frozenWaveProgress !== null && frozenWaveTo !== null
      ? { fromIndex: seasonIndex, toIndex: frozenWaveTo, progress: frozenWaveProgress }
      : (transitionState?.wave ?? null);

  const params = sampleSeasonState(seasonIndex);
  applySeasonState(composition, params);
  renderer.toneMappingExposure = params.toneMappingExposure;

  // Time field (依頼B, §4): one ambient strength value driving every layer's sway.
  const { strength: fieldStrength } = sampleTimeField(elapsed);
  updateTreeAnimation(composition.tree, elapsed, fieldStrength);
  updateVegetationAnimation(composition.vegetation, elapsed, fieldStrength);
  updateFlowerAnimation(composition.flowers, elapsed, fieldStrength);
  updateSheddingAnimation(composition.shedding, elapsed, fieldStrength);
  updateLake(composition.lake, elapsed, fieldStrength);
  updateSky(composition.sky, elapsed);

  postFx.updateWave(wave, elapsed);
  postFx.render();
}

renderLoop();

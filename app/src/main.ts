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
import { updateLake } from './scene/lake';
import { TimeMachineDial } from './ui/dial';

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
const camera = createCamera(window.innerWidth / window.innerHeight);
const composition = createComposition();

watchResize(renderer, camera);

/**
 * `?dial=<0..6>` freezes on one keyframe and hides the interactive dial, for
 * deterministic review screenshots (agent-workflow-policy.md §6) instead of racing
 * the wall clock or a pointer.
 */
const frozenDial = new URLSearchParams(window.location.search).get('dial');
const frozenDialValue = frozenDial !== null ? Number(frozenDial) : null;

const dial = frozenDialValue === null ? new TimeMachineDial() : null;
if (dial) appHost.appendChild(dial.element);

const clock = new THREE.Clock();
let elapsed = 0;

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = clock.getDelta();
  elapsed += dt;

  dial?.advance(dt);
  const dialPosition = frozenDialValue ?? dial!.dialPosition;

  const params = sampleSeasonState(dialPosition);
  applySeasonState(composition, params);
  renderer.toneMappingExposure = params.toneMappingExposure;
  dial?.setLabel(params.label);

  // Time field (依頼B, §4): one ambient strength value driving every layer's sway.
  const { strength: fieldStrength } = sampleTimeField(elapsed);
  updateTreeAnimation(composition.tree, elapsed, fieldStrength);
  updateVegetationAnimation(composition.vegetation, elapsed, fieldStrength);
  updateLake(composition.lake, elapsed, fieldStrength);

  renderer.render(composition.scene, camera);
}

renderLoop();

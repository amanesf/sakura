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

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
const camera = createCamera(window.innerWidth / window.innerHeight);
const composition = createComposition();

watchResize(renderer, camera);

/**
 * Temporary linear auto-cycle so the season system (依頼A') is visible without a
 * UI. 依頼C replaces this with the real time-machine dial: manual scrub, non-linear
 * per-scene pacing (proposal.md §3 "非線形な時間軸"), and idle auto-advance driven by
 * the light-wave transition (依頼D) instead of a plain crossfade.
 *
 * `?dial=<0..6>` freezes on one keyframe for deterministic review screenshots
 * (agent-workflow-policy.md §6) instead of racing the wall clock.
 */
const SECONDS_PER_SCENE = 8;
const clock = new THREE.Clock();
const frozenDial = new URLSearchParams(window.location.search).get('dial');
const frozenDialValue = frozenDial !== null ? Number(frozenDial) : null;

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const elapsed = clock.getElapsedTime();
  const dialPosition = frozenDialValue ?? elapsed / SECONDS_PER_SCENE;

  const params = sampleSeasonState(dialPosition);
  applySeasonState(composition, params);
  renderer.toneMappingExposure = params.toneMappingExposure;

  // Time field (依頼B, §4): one ambient strength value driving every layer's sway.
  const { strength: fieldStrength } = sampleTimeField(elapsed);
  updateTreeAnimation(composition.tree, elapsed, fieldStrength);
  updateVegetationAnimation(composition.vegetation, elapsed, fieldStrength);
  updateLake(composition.lake, elapsed, fieldStrength);

  renderer.render(composition.scene, camera);
}

renderLoop();

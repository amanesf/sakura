import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera } from './core/camera';
import { createSkyClouds, updateSkyClouds } from './scene/skyClouds';
import { sunDirection } from './core/solarPosition';

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
const camera = createCamera(window.innerWidth / window.innerHeight);
watchResize(renderer, camera);

const scene = new THREE.Scene();
const skyClouds = createSkyClouds();
scene.add(skyClouds.mesh);

// plan.md: 「まず日中だけでいい」— time-of-day t is fixed at 0 (day) for now. The
// full 日中→夕焼け→日没 arc (autoplay + manual slider, both per the earlier
// agreement) hooks in here once the sunset/dusk keyframes are validated too.
const TIME_OF_DAY_T = 0;
const sunDir = sunDirection(TIME_OF_DAY_T);

const clock = new THREE.Clock();

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const elapsed = clock.getElapsedTime();
  updateSkyClouds(skyClouds, camera, sunDir, elapsed);
  renderer.render(scene, camera);
}

renderLoop();

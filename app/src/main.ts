import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera } from './core/camera';
import { createComposition } from './scene/composition';

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
const camera = createCamera(window.innerWidth / window.innerHeight);
const composition = createComposition();

watchResize(renderer, camera);

const clock = new THREE.Clock();

function renderLoop() {
  requestAnimationFrame(renderLoop);
  clock.getDelta();
  renderer.render(composition.scene, camera);
}

renderLoop();

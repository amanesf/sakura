import './style.css';
import * as THREE from 'three';
import { createRenderer, watchResize } from './core/renderer';
import { createCamera } from './core/camera';
import { visibleRect, applyToCamera } from './core/frame';
import { createSky, updateSky } from './scene/sky';
import { createCloudMaterials } from './scene/clouds';
import { createCloudField, NO_SHADOW_CAST_LAYER } from './scene/cloudField';
import { createControls } from './ui/controls';
import { DEFAULT_PRESET, isPresetName } from './scene/skyPresets';
import { sunDirection } from './core/solarPosition';
import { createPostFx } from './core/postFx';
import { createCloudShadow } from './scene/cloudShadow';

// `?fit=frame` gives the whole viewport to the picture and hides the title and
// console — the shape scripts/capture.js measures in (style.css). Applied
// before the renderer is created so the first size is already the right one.
if (new URLSearchParams(window.location.search).get('fit') === 'frame') {
  document.documentElement.classList.add('fit-frame');
}

const appHost = document.querySelector<HTMLDivElement>('#app')!;

const renderer = createRenderer(appHost);
// The canvas is a band inside the page now, not the whole window — its aspect
// comes from the stage element (style.css). watchResize below corrects this
// immediately anyway; the value here only has to be non-degenerate.
const camera = createCamera(Math.max(appHost.clientWidth, 1) / Math.max(appHost.clientHeight, 1));

const scene = new THREE.Scene();

const sky = createSky();
scene.add(sky.mesh);

const postFx = createPostFx(renderer, scene, camera);

// The render resolution is fixed to the reference frame's own pixels, and the
// canvas is then scaled to whatever size the CSS gave it.
//
// This is not a performance choice, it is a correctness one. Every constant in
// core/postFx.ts and the passes it drives — the bloom radius, the Kuwahara
// kernel, the macro-contrast scale, the horizon haze texel — is expressed in
// *buffer pixels*, and every one of them was fitted against the reference at
// 1408x768. Sizing the buffer to the element instead meant those radii covered
// a different fraction of the picture on every screen: the phone's band is
// 515 CSS px wide, so at DPR 2 the same bloom radius spread over 2.7x more of
// the frame than it did when it was tuned, and the picture came out visibly
// softer than the measured one. Two screens showing the same simTime would not
// agree on the image.
//
// Pinning the buffer to the frame makes the app's output identical everywhere
// and identical to what scripts/capture.js measures, which is the only version
// of the picture that has ever been fitted to anything. On the target device it
// is also close to 1:1 in device pixels (448 CSS x DPR 3 = 1344 against 1408),
// so the downscale costs nothing visible.
watchResize(renderer, (cssWidth, cssHeight) => {
  // The plate and the 3D camera get the same sub-rect of the reference's
  // 1408x768 frame, so the painted window frames stay registered to the sky
  // whatever shape the viewport is (core/frame.ts). The buffer is that
  // sub-rect at 1:1, so the CSS size only decides *which* sub-rect, never how
  // many pixels it is drawn with.
  const rect = visibleRect(cssWidth / cssHeight);
  const bufferWidth = Math.max(Math.round(rect.width), 1);
  const bufferHeight = Math.max(Math.round(rect.height), 1);
  // updateStyle: false — the canvas keeps its 100%/100% CSS size from
  // style.css, which is what performs the scale to the element.
  renderer.setSize(bufferWidth, bufferHeight, false);
  postFx.setSize(bufferWidth, bufferHeight);
  applyToCamera(camera, rect);
  postFx.setFrameRect(rect);
});

// plan.md: 「まず日中だけでいい」— time-of-day t is fixed at 0 (day) for now.
const TIME_OF_DAY_T = 0;
const sunDir = sunDirection(TIME_OF_DAY_T);

// Art-directed key light for the clouds — deliberately *not* the true sun
// direction above. Per the Guilty Gear Xrd cel-shading research, professional
// stylized 3D lighting is chosen for how the form reads, not physical
// accuracy. The requested travel is "左手前から右奥方向へ": down and to the
// right, away from the viewer.
//
// The previous value (-0.55, 0.7, 0.55) took "手前" literally and put a third
// of the light vector straight down the camera axis, pointing the lit pole of
// every puff at the lens. That is the flat-light case: the whole visible
// hemisphere sits near the top of the shading curve and no terminator appears
// anywhere on screen. Measured, the reference tower's luminance falls 7.8 per
// 100px from left to right across the mass and its left half is 10.7 brighter
// than its right; this scene managed +0.3 and -1.2 — no lateral modelling at
// all. Nothing downstream could fix that, which is why the rim and the large
// shadow masses never appeared however hard they were pushed: there was no
// shadow side for them to live on.
//
// So the depth component is reversed and the vector swung to the side. Travel
// is still left→right and still downward — the read the direction was chosen
// for — but the source now sits beyond the cloud rather than beside the
// camera, so the near face is the shadow face. Values resolved by sweeping
// candidates through scripts/capture.js + scripts/measure.js and taking the
// one that lands on the reference's gradient, not by eye.
const LIGHT_QUERY = new URLSearchParams(window.location.search).get('light');
const CLOUD_LIGHT_DIR = LIGHT_QUERY
  ? new THREE.Vector3(...(LIGHT_QUERY.split(',').map(Number) as [number, number, number])).normalize()
  : new THREE.Vector3(-0.78, 0.45, -0.44).normalize();

// No THREE.Light in the scene any more: the cloud material is unlit and
// indexes a colour ramp measured out of the reference image (cloudRamp.ts),
// and sky.ts is its own atmospheric-scattering shader. Adding a
// DirectionalLight/HemisphereLight here would do nothing but cost uniforms.

const materials = createCloudMaterials(CLOUD_LIGHT_DIR);

// Light-space depth map for cloud self-shadowing.
//
// Deliberately tiny — 256 across a ~156km field, so one texel is about 0.6km
// and a single puff is under two texels. At 1024 it worked, but it resolved
// individual lobes: measured band energy rose in the 2-16px range and did not
// move at 40-80px at all, which is the opposite of what this term is for. A
// map too coarse to see one puff can only record where whole masses of cloud
// are, and that is exactly the scale of shadow that groups lobes into a light
// side and a shadow side.
const CLOUD_FIELD_CENTER = new THREE.Vector3(0, 5, -34);
const cloudShadow = createCloudShadow(CLOUD_LIGHT_DIR, CLOUD_FIELD_CENTER, 78, 256);
materials.core.uniforms.uShadowMap.value = cloudShadow.texture;
materials.core.uniforms.uShadowMatrix.value = cloudShadow.matrix;

// Which sky. The URL wins over the default so scripts/capture.js can measure a
// named preset (`?preset=clear`) rather than whatever the console was last left
// on — the same reason `?t=` exists.
const query = new URLSearchParams(window.location.search);
const presetParam = query.get('preset');
const initialPreset = isPresetName(presetParam) ? presetParam : DEFAULT_PRESET;

const cloudField = createCloudField(scene, materials, CLOUD_LIGHT_DIR, initialPreset);

// The high tiers (cirrus, altocumulus) live on their own layer so the shadow
// camera — which stays on layer 0 — never sees them. The view camera has to be
// told to see both. See cloudField.ts's `castsShadow` for why they are excluded
// from the depth pass rather than simply given a weak shadow.
camera.layers.enable(NO_SHADOW_CAST_LAYER);

// The sky is a fullscreen quad that ignores the camera, so it would otherwise
// fill the light-space depth map entirely.
const hiddenDuringShadowPass: THREE.Object3D[] = [sky.mesh];

// Playback speed. Real clouds are slow — the hero tower crosses the frame in 69
// minutes on a 7 m/s wind — so the app is watchable at 1x but only really shows
// its weather when run up. The slider goes to 30x, where a crossing takes 2.3
// minutes and a cumulonimbus lives about two.
const controls = createControls(initialPreset);
controls.onPreset((name) => cloudField.setPreset(name));

// Simulated seconds. Every cluster's position, age and weather is a pure
// function of this one number (scene/cloudField.ts), which is what lets
// scripts/capture.js freeze the scene with ?t= and get the same frame every
// time no matter what speed the slider was left at.
const frozen = new URLSearchParams(window.location.search).get('t');
let simTime = frozen !== null ? Number(frozen) : 0;
const clock = new THREE.Clock();

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = clock.getDelta();
  if (frozen === null) simTime += dt * controls.timeScale();

  updateSky(sky, camera, sunDir);
  cloudField.update(simTime);

  // After the clusters have moved, before anything is shaded with it.
  cloudShadow.update(renderer, scene, hiddenDuringShadowPass);

  postFx.render();
}

renderLoop();

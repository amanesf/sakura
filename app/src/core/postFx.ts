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
import { RainShader } from '../effects/rainShader';
import { relightForDay, type Daylight } from './daylight';
import { HorizonHazeShader } from '../effects/horizonHaze';
import { FRAME_WIDTH, FRAME_HEIGHT, type FrameRect } from './frame';
import { SCENES, type SceneDef } from '../scene/scenes';

export interface PostFx {
  /** The finished picture. Nothing draws to the canvas any more — this goes to
   * core/compose.ts, which puts it where the layout says the picture is. */
  outputTexture: () => THREE.Texture;
  /**
   * Measurement mode renders straight to the canvas instead, skipping
   * core/compose.ts entirely.
   *
   * Not an optimisation — an exactness guarantee. Going through the compose
   * blit costs a texture sample, and sampling a texture at what should be
   * exactly its own texel centres still moved 0.03% of the frame's channels by
   * one level. That is invisible and it is also the end of "the noon frame is
   * byte-identical", which is the check that has caught three real regressions
   * in this project. The measure loop keeps the original path.
   */
  setRenderToScreen: (enabled: boolean) => void;
  setSize: (width: number, height: number) => void;
  /** Apply the hour to everything in the post chain that was authored for
   * midday: the painted plate, and the horizon haze band. */
  setDaylight: (day: Daylight) => void;
  /**
   * Rain, 0-1, and the clock the drops fall on.
   *
   * That clock is *not* simTime — see effects/rainShader.ts's uRainTime. It is
   * real seconds, pinned to `?t=` when the scene is frozen so captures still
   * reproduce.
   */
  setRain: (amount: number, rainTime: number) => void;
  /** The visible sub-rect of the reference's frame — drives both the plate's UVs
   * and where the horizon haze band sits (core/frame.ts). */
  setFrameRect: (rect: FrameRect) => void;
  /** Which illustration is in front of the sky (scene/scenes.ts). */
  setScene: (scene: SceneDef) => void;
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
  // The last pass leaves its result in the composer's own buffer instead of on
  // the canvas: the canvas is the whole page now and the picture is only one
  // band of it (core/compose.ts).
  composer.renderToScreen = false;
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
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(FRAME_WIDTH, FRAME_HEIGHT), 0.12, 0.80, 8.2);
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
  const kuwaharaPass = new AnisotropicKuwaharaPass(FRAME_WIDTH, FRAME_HEIGHT);
  composer.addPass(kuwaharaPass);

  // Last, after the painterly filter: this widens the separation between the
  // large light and shadow masses, and running it before Kuwahara would just
  // hand that filter a wider range to average back down.
  const macroPass = new MacroContrastPass(FRAME_WIDTH, FRAME_HEIGHT);
  composer.addPass(macroPass);

  // Before the plate, so it works on the rendered sky only.
  const horizonPass = new ShaderPass(HorizonHazeShader);
  composer.addPass(horizonPass);

  // Rain goes immediately before the plate, which is what confines it to the
  // sky: the plate is composited over it, so the only pixels it survives on are
  // the ones the illustration leaves transparent. See effects/rainShader.ts.
  const rainPass = new ShaderPass(RainShader);
  rainPass.enabled = false; // nothing to do while it is dry
  composer.addPass(rainPass);

  // The foreground plate goes on last — see effects/plateShader.ts for why
  // nothing may run after it.
  //
  // One texture per scene, loaded on first use and kept: switching scenes is a
  // button press and should not show a frame of missing illustration, and there
  // are two of these at about 100 KB each.
  const loader = new THREE.TextureLoader();
  const plateTextures = new Map<string, THREE.Texture>();
  const plateFor = (scene: SceneDef): THREE.Texture => {
    const cached = plateTextures.get(scene.plate);
    if (cached) return cached;
    const texture = loader.load(scene.plate);
    // The buffer at this point is already display-space sRGB (OutputPass ran
    // several passes ago), so the plate must be sampled raw. Tagging it
    // SRGBColorSpace would have the sampler linearise it into a buffer that is
    // not linear, washing the illustration out.
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    plateTextures.set(scene.plate, texture);
    return texture;
  };
  const platePass = new ShaderPass(PlateShader);
  composer.addPass(platePass);

  const setSize = (width: number, height: number) => {
    composer.setSize(width, height);
    kuwaharaPass.setSize(width, height);
    macroPass.setSize(width, height);
    bloomPass.setSize(width, height);
    gradePass.uniforms.uAspect.value = width / height;
    horizonPass.uniforms.uTexel.value.set(1 / width, 1 / height);
    rainPass.uniforms.uAspect.value = width / height;
  };

  // The haze band's midday colour, kept so the hour can be applied to it
  // without accumulating.
  const baseHazeColor = new THREE.Color().fromArray(
    horizonPass.uniforms.uHazeColor.value.toArray(),
  );

  const setDaylight = (day: Daylight) => {
    const plate = day.plateTint;
    platePass.uniforms.uDayTint.value.set(plate.r, plate.g, plate.b);

    // The band that fills the bottom of the sky was a fixed pale midday blue
    // applied at 0.72 strength, so it pinned the lower sky bright and blue at
    // every hour — measured, the 18:36 sky was still at luminance 173 near the
    // horizon against midday's 181, i.e. it had barely dimmed at all while the
    // sun was setting. It is horizon haze: aerosol lit by whatever light is
    // around, so it has to take the hour like everything else. Weighted toward
    // the lit illuminant because the low sky along a long horizon path is lit
    // mostly by the direct beam.
    const haze = relightForDay(baseHazeColor, day, 0.65);
    horizonPass.uniforms.uHazeColor.value.set(haze.r, haze.g, haze.b);
  };

  const setRain = (amount: number, rainTime: number) => {
    rainPass.enabled = amount > 0.001;
    rainPass.uniforms.uRain.value = amount;
    rainPass.uniforms.uRainTime.value = rainTime;
    // The room and the town lose the light along with the sky, and by the same
    // amount, because they are lit *by* it — see effects/plateShader.ts. Read
    // off the rain pass's own uniform rather than repeating the number here:
    // the two being equal is the physical claim, so they should not be able to
    // drift apart.
    const skyExposure = rainPass.uniforms.uExposure.value as number;
    platePass.uniforms.uRainExposure.value = 1 + (skyExposure - 1) * Math.min(Math.max(amount, 0), 1);
  };

  // Where the painted horizon is, per scene (scene/scenes.ts). Both of these
  // were constants when there was one illustration.
  let plateScene = SCENES[0];
  // The last rect, so a scene change can re-derive the haze band from it
  // without waiting for a resize.
  let frameRect: FrameRect = { x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT };

  const applyFrame = () => {
    platePass.uniforms.tPlate.value = plateFor(plateScene);
    platePass.uniforms.uPlateRect.value.set(
      frameRect.x / FRAME_WIDTH,
      1 - (frameRect.y + frameRect.height) / FRAME_HEIGHT,
      frameRect.width / FRAME_WIDTH,
      frameRect.height / FRAME_HEIGHT,
    );
    // Frame rows -> screen v, remembering v runs bottom-up.
    horizonPass.uniforms.uHazeV.value.set(
      1 - (plateScene.horizonRow - frameRect.y) / frameRect.height,
      1 - (plateScene.hazeTopRow - frameRect.y) / frameRect.height,
    );
  };

  const setFrameRect = (rect: FrameRect) => {
    frameRect = rect;
    applyFrame();
  };

  const setScene = (next: SceneDef) => {
    plateScene = next;
    applyFrame();
  };

  applyFrame();

  return {
    outputTexture: () => composer.readBuffer.texture,
    setRenderToScreen: (enabled: boolean) => { composer.renderToScreen = enabled; },
    setSize,
    setFrameRect,
    setScene,
    setDaylight,
    setRain,
    render: () => composer.render(),
  };
}

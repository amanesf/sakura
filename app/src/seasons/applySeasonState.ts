import * as THREE from 'three';
import type { Composition } from '../scene/composition';
import { setCanopySeasonState } from '../scene/tree';
import { setGroundSeasonState } from '../scene/ground';
import { setMountainsSeasonState } from '../scene/mountains';
import { setVegetationSeasonState } from '../scene/vegetation';
import { setFlowerSeasonState } from '../scene/flowers';
import { setSheddingSeasonState } from '../scene/sheddingParticles';
import type { SeasonId, SeasonVisualParams } from './seasonState';

const SUN_DISTANCE = 22;
const SUN_TARGET = new THREE.Vector3(0, 3, -2);
const sunOffset = new THREE.Vector3();

/** Sky cloud coverage per scene — clear and crisp in winter, fluffiest in spring
 *  bloom (matching the reference art's soft high-key sky), thinning out by autumn. */
const CLOUD_DENSITY: Record<SeasonId, number> = {
  winter: 0.25,
  spring: 0.55,
  summer: 0.7,
  autumn: 0.35,
};

/**
 * Pushes a sampled SeasonVisualParams (season-transition-animation.md §10) into every
 * material/light in the composition built by scene/composition.ts. This is the single
 * place that "owns" turning season state into visuals — 依頼B/C/D only ever change
 * *which* dial position/blend to sample, never touch these materials directly.
 */
export function applySeasonState(composition: Composition, params: SeasonVisualParams): void {
  const { tree, vegetation, flowers, shedding, lake, ground, mountains, sky, lights, scene } =
    composition;

  setCanopySeasonState(tree, params.id, params.canopyDensity, params.canopyScale);

  setVegetationSeasonState(vegetation, params.id, params.vegetationDensity, params.vegetationHeight);

  setFlowerSeasonState(flowers, params.flowerDensity);

  shedding.material.color.copy(params.sheddingColor);
  setSheddingSeasonState(shedding, params.sheddingSensitivity);

  setGroundSeasonState(ground, params.id);

  (lake.mesh.material as THREE.ShaderMaterial).uniforms.color.value.copy(params.lakeTint);

  sky.material.uniforms.uTopColor.value.copy(params.skyTop);
  sky.material.uniforms.uHorizonColor.value.copy(params.skyHorizon);
  sky.material.uniforms.uBottomColor.value.copy(params.skyBottom);
  sky.material.uniforms.uSunColor.value.copy(params.sunColor);
  sky.material.uniforms.uCloudDensity.value = CLOUD_DENSITY[params.id];

  setMountainsSeasonState(mountains, params.id);

  if (scene.fog instanceof THREE.Fog) {
    scene.fog.color.copy(params.fogColor);
    scene.fog.near = params.fogNear;
    scene.fog.far = params.fogFar;
  }

  const elevation = THREE.MathUtils.degToRad(params.sunElevationDeg);
  const azimuth = THREE.MathUtils.degToRad(params.sunAzimuthDeg);
  sunOffset.set(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );
  lights.sun.position.copy(SUN_TARGET).addScaledVector(sunOffset, SUN_DISTANCE);
  lights.sun.target.position.copy(SUN_TARGET);
  lights.sun.target.updateMatrixWorld();
  lights.sun.color.copy(params.sunColor);
  lights.sun.intensity = params.sunIntensity;
  sky.material.uniforms.uSunDirection.value.copy(sunOffset);

  lights.hemi.color.copy(params.hemiSky);
  lights.hemi.groundColor.copy(params.hemiGround);
  lights.hemi.intensity = params.hemiIntensity;
}

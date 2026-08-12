/**
 * The one control the app has so far: how fast time runs.
 *
 * Built for a phone held upright. The controls are no longer floated over the
 * picture — in the portrait layout the picture is a band across the upper part
 * of the page and the bottom strip (`.console`) belongs to the controls, so
 * this mounts into that strip. It still dims when untouched, but only to 0.45
 * rather than near-invisible: it is not covering the sky any more, so hiding it
 * hard just makes the app look like it has no controls.
 */
export interface Controls {
  timeScale: () => number;
}

const MAX_SPEED = 30;

export function createControls(): Controls {
  const root = document.createElement('div');
  root.className = 'controls';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = String(MAX_SPEED);
  slider.step = '0.5';
  slider.value = '1';
  slider.setAttribute('aria-label', '再生速度');

  const label = document.createElement('span');
  label.className = 'controls__label';

  let scale = 1;
  const sync = () => {
    scale = Number(slider.value);
    label.textContent = `${scale % 1 === 0 ? scale : scale.toFixed(1)}x`;
    root.classList.add('controls--awake');
    window.clearTimeout(sleepTimer);
    sleepTimer = window.setTimeout(() => root.classList.remove('controls--awake'), 2600);
  };
  let sleepTimer = 0;

  slider.addEventListener('input', sync);
  root.append(slider, label);
  (document.querySelector('.console') ?? document.body).appendChild(root);
  sync();

  return { timeScale: () => scale };
}

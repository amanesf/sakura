/**
 * The one control the app has: how fast time runs.
 *
 * Built for a phone held sideways, so the slider is a full-width strip along the
 * bottom with a large touch target, and it fades out of the way when it has not
 * been touched — the point of the app is the sky, not the UI.
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
  document.body.appendChild(root);
  sync();

  return { timeScale: () => scale };
}

import { SKY_PRESETS, type SkyPresetName } from '../scene/skyPresets';

/**
 * The console: which sky, and how fast time runs.
 *
 * Built for a phone held upright. The controls are not floated over the picture
 * — in the portrait layout the picture is a band across the upper part of the
 * page and the strip directly beneath it (`.console`) belongs to the controls.
 * They also no longer fade when untouched: they are not covering the sky, so
 * hiding them only made the app look like it had none.
 */
export interface Controls {
  timeScale: () => number;
  /** Called when the user picks a different sky. */
  onPreset: (fn: (name: SkyPresetName) => void) => void;
  preset: () => SkyPresetName;
}

const MAX_SPEED = 30;

/**
 * 10x, not 1x.
 *
 * At 1x a tower takes 102 minutes to cross the frame and the weather's shortest
 * term is 15 minutes, so the first minute of the app is indistinguishable from
 * a still image — which is the wrong first impression for something whose whole
 * point is that the sky keeps happening. At 10x a crossing is ten minutes and
 * the clouds visibly boil and drift while you watch. The slider still goes down
 * to 1 for anyone who wants real time.
 */
const DEFAULT_SPEED = 10;

export function createControls(initialPreset: SkyPresetName): Controls {
  const host = document.querySelector('.console') ?? document.body;

  // --- Sky preset ---
  const modes = document.createElement('div');
  modes.className = 'modes';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '空のパターン');

  let preset = initialPreset;
  const listeners: ((name: SkyPresetName) => void)[] = [];
  const buttons = new Map<SkyPresetName, HTMLButtonElement>();

  for (const [name, spec] of Object.entries(SKY_PRESETS) as [SkyPresetName, { label: string }][]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mode';
    button.textContent = spec.label;
    // aria-pressed doubles as the styling hook, so the active state cannot get
    // out of step with what assistive tech is told.
    button.setAttribute('aria-pressed', String(name === preset));
    button.addEventListener('click', () => {
      if (preset === name) return;
      preset = name;
      for (const [n, b] of buttons) b.setAttribute('aria-pressed', String(n === preset));
      for (const fn of listeners) fn(preset);
    });
    buttons.set(name, button);
    modes.appendChild(button);
  }

  // --- Speed ---
  const speed = document.createElement('div');
  speed.className = 'speed';

  const speedLabel = document.createElement('span');
  speedLabel.className = 'speed__label';
  speedLabel.textContent = 'SPEED';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'speed__slider';
  slider.min = '1';
  slider.max = String(MAX_SPEED);
  slider.step = '0.5';
  slider.value = String(DEFAULT_SPEED);
  slider.setAttribute('aria-label', '再生速度');

  const value = document.createElement('span');
  value.className = 'speed__value';

  let scale = DEFAULT_SPEED;
  const sync = () => {
    scale = Number(slider.value);
    value.textContent = '';
    value.append(
      document.createTextNode(scale % 1 === 0 ? String(scale) : scale.toFixed(1)),
      Object.assign(document.createElement('i'), { textContent: '×' }),
    );
    // The filled part of the track. A range input has no CSS-only way to say
    // "colour the track up to the thumb" that works in both engines, so the
    // percentage is handed to the stylesheet as a custom property.
    const frac = (scale - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
    slider.style.setProperty('--fill', `${frac * 100}%`);
  };

  slider.addEventListener('input', sync);
  speed.append(speedLabel, slider, value);

  host.append(modes, speed);
  sync();

  return {
    timeScale: () => scale,
    onPreset: (fn) => listeners.push(fn),
    preset: () => preset,
  };
}

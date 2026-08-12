import { CLOCK_END_HOUR, CLOCK_START_HOUR, formatClock } from '../core/daylight';

/**
 * The console: four sliders, in the order the sky is built up.
 *
 * Built for a phone held upright. The controls are not floated over the picture
 * — in the portrait layout the picture is a band across the upper part of the
 * page and the strip directly beneath it (`.console`) belongs to the controls.
 * They do not fade when untouched either: they are not covering the sky, so
 * hiding them only made the app look like it had none.
 *
 * These replaced a pair of preset buttons (積乱雲 / 快晴). Two named skies could
 * only ever be two points on an axis that is continuous anyway, and naming them
 * hid the interesting part — that the sky between the presets is also a sky.
 */
export interface Controls {
  /** Playback rate, 1-30x. */
  timeScale: () => number;
  /** 0 (empty) .. 1 (raining), the weather axis itself. */
  cloudAmount: () => number;
  /** 0 (dry) .. 1 (downpour). */
  rainAmount: () => number;
  /** Clock hour, 12.0 .. 19.0. */
  hour: () => number;
  /** Move a slider from code, as if the user had. Used by the capture harness
   * (scripts/shoot.js) to retarget the scene without reloading the page. */
  setValue: (key: string, value: number) => void;
}

interface SliderSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** How the number reads out on the right. */
  format: (value: number) => { text: string; unit: string };
  ariaLabel: string;
}

/**
 * 10x, not 1x.
 *
 * At 1x a tower takes 102 minutes to cross the frame, so the first minute of
 * the app is indistinguishable from a still image — the wrong first impression
 * for something whose whole point is that the sky keeps happening. At 10x a
 * crossing is ten minutes and the clouds visibly boil and drift while you
 * watch. The slider still goes down to 1 for anyone who wants real time.
 */
const DEFAULT_SPEED = 10;

/**
 * 0.62, not 0.5 or 1.
 *
 * The app should open on the picture it was built to reproduce, and the
 * reference image is a summer afternoon with cumulonimbus standing in a low
 * deck. On the cloud axis that is a little under the tower tier's peak — high
 * enough that towers are always present, low enough that there is still open
 * blue between them (see scene/cloudField.ts's coverage curves).
 */
const DEFAULT_CLOUD = 0.62;

const percent = (v: number) => ({ text: String(Math.round(v * 100)), unit: '%' });

const SLIDERS: SliderSpec[] = [
  {
    key: 'cloud',
    label: 'CLOUD',
    min: 0,
    max: 1,
    step: 0.01,
    value: DEFAULT_CLOUD,
    format: percent,
    ariaLabel: '雲の量',
  },
  {
    key: 'rain',
    label: 'RAIN',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0,
    format: percent,
    ariaLabel: '雨の量',
  },
  {
    key: 'hour',
    label: 'TIME',
    min: CLOCK_START_HOUR,
    max: CLOCK_END_HOUR,
    step: 0.05,
    value: CLOCK_START_HOUR,
    format: (v) => ({ text: formatClock(v), unit: '' }),
    ariaLabel: '時刻',
  },
  {
    key: 'speed',
    label: 'SPEED',
    min: 1,
    max: 30,
    step: 0.5,
    value: DEFAULT_SPEED,
    format: (v) => ({ text: v % 1 === 0 ? String(v) : v.toFixed(1), unit: '×' }),
    ariaLabel: '再生速度',
  },
];

export function createControls(initial: Partial<Record<string, number>> = {}): Controls {
  const host = document.querySelector('.console') ?? document.body;
  const values = new Map<string, number>();
  const setters = new Map<string, (value: number) => void>();

  for (const spec of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider';

    const label = document.createElement('span');
    label.className = 'slider__label';
    label.textContent = spec.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'slider__input';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(initial[spec.key] ?? spec.value);
    input.setAttribute('aria-label', spec.ariaLabel);

    const readout = document.createElement('span');
    readout.className = 'slider__value';

    const sync = () => {
      const value = Number(input.value);
      values.set(spec.key, value);
      const { text, unit } = spec.format(value);
      readout.textContent = '';
      readout.append(document.createTextNode(text));
      if (unit) readout.append(Object.assign(document.createElement('i'), { textContent: unit }));
      // The filled part of the track. A range input has no CSS-only way to say
      // "colour the track up to the thumb" that works in both engines, so the
      // percentage is handed to the stylesheet as a custom property.
      const frac = (value - spec.min) / (spec.max - spec.min);
      input.style.setProperty('--fill', `${frac * 100}%`);
    };

    input.addEventListener('input', sync);
    setters.set(spec.key, (value) => {
      input.value = String(value);
      sync();
    });
    row.append(label, input, readout);
    host.appendChild(row);
    sync();
  }

  const read = (key: string) => values.get(key) ?? 0;
  return {
    setValue: (key, value) => setters.get(key)?.(value),
    timeScale: () => read('speed'),
    cloudAmount: () => read('cloud'),
    rainAmount: () => read('rain'),
    hour: () => read('hour'),
  };
}

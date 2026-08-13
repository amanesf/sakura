import { CLOCK_END_HOUR, CLOCK_START_HOUR, formatClock } from '../core/daylight';
import { DEFAULT_SCENE, SCENES, sceneIndexFor } from '../scene/scenes';

/**
 * The console: four sliders in the order the sky is built up, then the frame
 * rate pair.
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
  /** Frames per second the render loop is allowed to draw at, 30 or 60. */
  frameRate: () => number;
  /** Index into scene/scenes.ts's SCENES. */
  sceneIndex: () => number;
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

/**
 * The frame rate cap, as a pair of buttons rather than a fifth slider.
 *
 * 60 by default, which is what the loop did before this existed. 30 is there
 * because the picture is not cheap and cannot be made cheaper without changing
 * what it looks like: the render buffer is pinned to the reference frame's
 * 1408x768 on every device (core/main.ts explains why that is a correctness
 * requirement, not a performance choice) and the post chain behind it runs
 * bloom, an anisotropic Kuwahara and a macro-contrast pass over all of it. On a
 * phone that can be more than 16ms of work, and a loop that asks for 60 and
 * misses lands on an uneven 40-50 with visible hitching. Asking for 30 gives
 * every frame twice the budget, which for a scene of drifting cloud reads as
 * *smoother* than a dropped 60 even though it is half the frames.
 *
 * Not a quality setting: both give exactly the same picture, so a capture is
 * unaffected either way and the measure loop does not care which is selected.
 *
 * See addSegment in createControls for the shape it is drawn in.
 */
const FRAME_RATES = [30, 60] as const;
const DEFAULT_FRAME_RATE = 60;
/** Where the frame rate is remembered. A preference someone sets because their
 * phone struggles is not one they should have to set again every visit. */
const FRAME_RATE_KEY = 'sakura.fps';
/**
 * The scene used to be remembered here too, and is not any more: the app opens
 * on scene 1 every time unless `?scene=` says otherwise.
 *
 * Which picture you are looking at is not a preference like the frame rate —
 * it is where the app starts, and the front door should be the same door every
 * time. Remembering it meant that whichever scene you happened to leave the app
 * on became your new default, silently and for good.
 *
 * The key is still read once, only to delete it, so anyone who used a build
 * between the two behaviours does not keep a remembered scene forever. */
const SCENE_KEY = 'sakura.scene';

/** localStorage, with the failure mode that matters: private mode throws, and
 * the app has no business refusing to start over a remembered preference. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // See stored().
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // See stored(). Not being able to remember a choice is not a reason to
    // refuse to apply it.
  }
}

/**
 * The first candidate that names one of `values`, in precedence order.
 *
 * Used for both segments, and the order is the point: the URL wins over what
 * was remembered, which wins over the default. That is the same precedence the
 * sliders give `?cloud=` and friends, so a shared link always shows what its
 * author saw rather than what the recipient last looked at.
 */
function pick<T extends string | number>(
  values: readonly T[],
  ...candidates: (T | string | number | null | undefined)[]
): T {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const match = values.find((v) => String(v) === String(candidate));
    if (match !== undefined) return match;
  }
  return values[0];
}

export function createControls(
  initial: Partial<Record<string, number>> = {},
  /** `?scene=`, which is a key rather than a number so it stays readable. */
  initialScene?: string | null,
  /** Called when the scene buttons are pressed. The scene is not a value the
   * render loop can simply read every frame like the sliders are — swapping it
   * re-aims the camera and reloads a plate — so it is delivered as an event. */
  onSceneChange?: (index: number) => void,
): Controls {
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

  /**
   * A row of mutually exclusive buttons, in the same three-column shape as a
   * slider so the console still reads as one instrument: label on the left, the
   * buttons sitting where the sliders' readouts sit.
   *
   * Two of these now (frame rate, scene). A discrete choice with a handful of
   * values wants buttons — putting either on a slider would imply the values
   * between them mean something, and 43fps does not, nor does half a scene.
   */
  function addSegment<T extends string | number>(options: {
    label: string;
    ariaLabel: string;
    values: readonly T[];
    text: (value: T) => string;
    initial: T;
    /** localStorage key, when the choice should outlive the visit. */
    storeAs?: string;
    onChange?: (value: T) => void;
  }): { get: () => T; set: (value: T) => void } {
    const row = document.createElement('div');
    row.className = 'slider';

    const label = document.createElement('span');
    label.className = 'slider__label';
    label.textContent = options.label;

    const group = document.createElement('div');
    group.className = 'segment';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', options.ariaLabel);

    let current = options.initial;

    const buttons = options.values.map((value) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'segment__button';
      button.textContent = options.text(value);
      button.addEventListener('click', () => set(value));
      group.appendChild(button);
      return { value, button };
    });

    function set(value: T): void {
      current = value;
      for (const entry of buttons) {
        entry.button.setAttribute('aria-pressed', String(entry.value === value));
      }
      if (options.storeAs) remember(options.storeAs, String(value));
      options.onChange?.(value);
    }

    set(current);
    row.append(label, group);
    host.appendChild(row);
    return { get: () => current, set };
  }

  // The URL wins over what was remembered, which wins over the default — the
  // same precedence the sliders give `?cloud=` and friends, so `?fps=30` names a
  // frame rate the way `?rain=1` names a downpour.
  const storedFps = Number(stored(FRAME_RATE_KEY));
  const fps = addSegment({
    label: 'FPS',
    ariaLabel: 'フレームレート上限',
    values: FRAME_RATES,
    text: String,
    initial: pick(FRAME_RATES, initial.fps, storedFps, DEFAULT_FRAME_RATE),
    storeAs: FRAME_RATE_KEY,
  });

  forget(SCENE_KEY);
  const sceneKeys = SCENES.map((s) => s.key);
  const scene = addSegment({
    label: 'SCENE',
    ariaLabel: '場面',
    values: sceneKeys,
    text: (key) => SCENES[sceneIndexFor(key)].label,
    initial: pick(sceneKeys, initialScene, null, SCENES[DEFAULT_SCENE].key),
    onChange: (key) => onSceneChange?.(sceneIndexFor(key)),
  });

  const read = (key: string) => values.get(key) ?? 0;
  return {
    setValue: (key, value) => setters.get(key)?.(value),
    timeScale: () => read('speed'),
    cloudAmount: () => read('cloud'),
    rainAmount: () => read('rain'),
    hour: () => read('hour'),
    frameRate: () => fps.get(),
    sceneIndex: () => sceneIndexFor(scene.get()),
  };
}

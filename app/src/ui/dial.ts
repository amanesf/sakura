import './dial.css';
import {
  angleFractionFromDialPosition,
  dialPositionFromAngleFraction,
  getNotchAngleFractions,
} from '../seasons/dialTiming';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CENTER = 50;
const FACE_RADIUS = 40;
const TICK_INNER = 31;
const TICK_OUTER = 38;
const KNOB_RADIUS = 34;

/** Time of no pointer interaction before the device resumes auto-cycling. */
const AUTO_RESUME_DELAY = 4.5;
/** One full 6-scene loop takes this long in auto mode (seconds). */
const AUTO_LOOP_SECONDS = 72;

function angleFractionToXY(fraction: number, radius: number): { x: number; y: number } {
  const theta = fraction * Math.PI * 2 - Math.PI / 2;
  return { x: CENTER + Math.cos(theta) * radius, y: CENTER + Math.sin(theta) * radius };
}

/**
 * The "タイムマシン" dial (season-transition-animation.md §7.1): a small always-on
 * HUD widget, scrub-only (§7 — no other interaction), that owns the single
 * `dialPosition` value the rest of the app renders from. Auto-advance and manual
 * drag share the same non-linear angle↔dialPosition gearing from dialTiming.ts, so
 * the physical knob position is always the truth, whichever is currently moving it.
 */
export class TimeMachineDial {
  readonly element: HTMLDivElement;
  dialPosition = 0;

  private angleFraction = 0;
  private autoMode = true;
  private idleTimer = 0;
  private dragging = false;

  private readonly svg: SVGSVGElement;
  private readonly knob: SVGCircleElement;
  private readonly hand: SVGLineElement;
  private readonly label: HTMLDivElement;
  private readonly modeLabel: HTMLDivElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'tm-dial-panel';

    this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.svg.setAttribute('viewBox', '0 0 100 100');
    this.svg.setAttribute('width', '96');
    this.svg.setAttribute('height', '96');
    this.svg.classList.add('tm-dial-face');

    const face = document.createElementNS(SVG_NS, 'circle');
    face.setAttribute('cx', String(CENTER));
    face.setAttribute('cy', String(CENTER));
    face.setAttribute('r', String(FACE_RADIUS));
    face.setAttribute('fill', '#1c1c1f');
    face.setAttribute('stroke', 'rgba(255,255,255,0.15)');
    this.svg.appendChild(face);

    for (const fraction of getNotchAngleFractions()) {
      const inner = angleFractionToXY(fraction, TICK_INNER);
      const outer = angleFractionToXY(fraction, TICK_OUTER);
      const tick = document.createElementNS(SVG_NS, 'line');
      tick.setAttribute('x1', String(inner.x));
      tick.setAttribute('y1', String(inner.y));
      tick.setAttribute('x2', String(outer.x));
      tick.setAttribute('y2', String(outer.y));
      tick.classList.add('tm-dial-tick');
      this.svg.appendChild(tick);
    }

    this.hand = document.createElementNS(SVG_NS, 'line') as SVGLineElement;
    this.hand.setAttribute('x1', String(CENTER));
    this.hand.setAttribute('y1', String(CENTER));
    this.hand.setAttribute('stroke', '#d9b970');
    this.hand.setAttribute('stroke-width', '1.6');
    this.svg.appendChild(this.hand);

    this.knob = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement;
    this.knob.setAttribute('r', '4.2');
    this.knob.classList.add('tm-dial-knob');
    this.svg.appendChild(this.knob);

    this.label = document.createElement('div');
    this.label.className = 'tm-dial-readout';
    this.modeLabel = document.createElement('div');
    this.modeLabel.className = 'tm-dial-mode';

    this.element.append(this.svg, this.label, this.modeLabel);

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);

    this.setAngleFraction(angleFractionFromDialPosition(0));
  }

  private setAngleFraction(fraction: number): void {
    this.angleFraction = ((fraction % 1) + 1) % 1;
    this.dialPosition = dialPositionFromAngleFraction(this.angleFraction);
    const tip = angleFractionToXY(this.angleFraction, KNOB_RADIUS);
    this.hand.setAttribute('x2', String(tip.x));
    this.hand.setAttribute('y2', String(tip.y));
    this.knob.setAttribute('cx', String(tip.x));
    this.knob.setAttribute('cy', String(tip.y));
  }

  private angleFractionFromPointer(event: PointerEvent): number {
    const rect = this.svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const theta = Math.atan2(dy, dx);
    return (theta + Math.PI / 2) / (Math.PI * 2);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.dragging = true;
    this.autoMode = false;
    this.idleTimer = 0;
    this.svg.setPointerCapture(event.pointerId);
    this.setAngleFraction(this.angleFractionFromPointer(event));
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.dragging) return;
    this.setAngleFraction(this.angleFractionFromPointer(event));
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.dragging = false;
    if (this.svg.hasPointerCapture(event.pointerId)) {
      this.svg.releasePointerCapture(event.pointerId);
    }
  };

  /**
   * Advances auto mode (season-transition-animation.md §7 "放置すると、装置が
   * 自らダイヤルを回し続ける") when idle. Call once per frame *before* sampling
   * season state from `dialPosition`.
   */
  advance(dt: number): void {
    if (!this.dragging) {
      this.idleTimer += dt;
      if (!this.autoMode && this.idleTimer >= AUTO_RESUME_DELAY) {
        this.autoMode = true;
      }
    }
    if (this.autoMode) {
      this.setAngleFraction(this.angleFraction + dt / AUTO_LOOP_SECONDS);
    }
    this.modeLabel.textContent = this.autoMode ? 'auto' : 'manual';
  }

  /** Call once per frame *after* sampling season state, with its label. */
  setLabel(text: string): void {
    this.label.textContent = text;
  }
}

import './dial.css';
import {
  angleFractionFromDialPosition,
  dialPositionFromAngleFraction,
  getDialWedgeRanges,
  getNotchAngleFractions,
} from '../seasons/dialTiming';
import type { SeasonId } from '../seasons/seasonState';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CENTER = 50;
const CASE_RADIUS = 44;
const BEZEL_RADIUS = 39;
const GLASS_RADIUS = 36;
const HAND_LENGTH = 32;
const HAND_TAIL = 9;

/** Time of no pointer interaction before the device resumes auto-cycling. */
const AUTO_RESUME_DELAY = 4.5;
/** One full loop of all scenes takes this long in auto mode (seconds). */
const AUTO_LOOP_SECONDS = 72;

/**
 * Flat UI colors for each wedge (reference image `1786296871919.png`: a glass-
 * covered ring of small painted season vignettes). Deliberately a separate palette
 * from seasonState.ts's 3D lighting colors — this is print-like iconography, not a
 * lit material.
 */
const WEDGE_COLORS: Record<SeasonId, string> = {
  winter: '#a9c9e0',
  springBloom: '#f2b8cf',
  springFall: '#e893b3',
  summer: '#8fd16a',
  autumn: '#e2963f',
};

function angleFractionToXY(fraction: number, radius: number): { x: number; y: number } {
  const theta = fraction * Math.PI * 2 - Math.PI / 2;
  return { x: CENTER + Math.cos(theta) * radius, y: CENTER + Math.sin(theta) * radius };
}

function arcPoint(fraction: number, radius: number): string {
  const { x, y } = angleFractionToXY(fraction, radius);
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}

function wedgePath(startFraction: number, endFraction: number, radius: number): string {
  const largeArc = endFraction - startFraction > 0.5 ? 1 : 0;
  return [
    `M ${CENTER},${CENTER}`,
    `L ${arcPoint(startFraction, radius)}`,
    `A ${radius},${radius} 0 ${largeArc} 1 ${arcPoint(endFraction, radius)}`,
    'Z',
  ].join(' ');
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

/**
 * The "タイムマシン" dial (season-transition-animation.md §7.1): a small always-on
 * HUD widget, scrub-only (§7 — no other interaction), styled after the brass
 * observation-device reference. It owns the single `dialPosition` value the rest of
 * the app renders from. Auto-advance and manual drag share the same non-linear
 * angle↔dialPosition gearing from dialTiming.ts, so the physical knob position is
 * always the truth, whichever is currently moving it.
 */
export class TimeMachineDial {
  readonly element: HTMLDivElement;
  dialPosition = 0;

  private angleFraction = 0;
  private autoMode = true;
  private idleTimer = 0;
  private dragging = false;

  private readonly svg: SVGSVGElement;
  private readonly hand: SVGPolygonElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'tm-dial-panel';

    this.svg = svgEl('svg');
    this.svg.setAttribute('viewBox', '0 0 100 100');
    this.svg.setAttribute('width', '104');
    this.svg.setAttribute('height', '104');
    this.svg.classList.add('tm-dial-face');
    this.svg.appendChild(this.buildDefs());

    const brassCase = svgEl('circle');
    brassCase.setAttribute('cx', String(CENTER));
    brassCase.setAttribute('cy', String(CENTER));
    brassCase.setAttribute('r', String(CASE_RADIUS));
    brassCase.setAttribute('fill', 'url(#tm-brass)');
    this.svg.appendChild(brassCase);

    for (const { x, y } of this.rivetPositions()) {
      const rivet = svgEl('circle');
      rivet.setAttribute('cx', String(x));
      rivet.setAttribute('cy', String(y));
      rivet.setAttribute('r', '1.6');
      rivet.setAttribute('fill', 'url(#tm-rivet)');
      this.svg.appendChild(rivet);
    }

    const wedgeGroup = svgEl('g');
    for (const { seasonId, startFraction, endFraction } of getDialWedgeRanges()) {
      const wedge = svgEl('path');
      wedge.setAttribute('d', wedgePath(startFraction, endFraction, GLASS_RADIUS));
      wedge.setAttribute('fill', WEDGE_COLORS[seasonId]);
      wedgeGroup.appendChild(wedge);
    }
    this.svg.appendChild(wedgeGroup);

    for (const fraction of getNotchAngleFractions()) {
      const divider = svgEl('line');
      const outer = angleFractionToXY(fraction, GLASS_RADIUS);
      divider.setAttribute('x1', String(CENTER));
      divider.setAttribute('y1', String(CENTER));
      divider.setAttribute('x2', String(outer.x));
      divider.setAttribute('y2', String(outer.y));
      divider.classList.add('tm-dial-divider');
      this.svg.appendChild(divider);
    }

    const bezel = svgEl('circle');
    bezel.setAttribute('cx', String(CENTER));
    bezel.setAttribute('cy', String(CENTER));
    bezel.setAttribute('r', String(BEZEL_RADIUS));
    bezel.setAttribute('fill', 'none');
    bezel.setAttribute('stroke', 'url(#tm-steel)');
    bezel.setAttribute('stroke-width', '3.4');
    this.svg.appendChild(bezel);

    const glassShine = svgEl('ellipse');
    glassShine.setAttribute('cx', String(CENTER - 10));
    glassShine.setAttribute('cy', String(CENTER - 12));
    glassShine.setAttribute('rx', '16');
    glassShine.setAttribute('ry', '10');
    glassShine.setAttribute('fill', 'url(#tm-glass-shine)');
    this.svg.appendChild(glassShine);

    this.hand = svgEl('polygon');
    this.hand.classList.add('tm-dial-hand');
    this.svg.appendChild(this.hand);

    const hub = svgEl('circle');
    hub.setAttribute('cx', String(CENTER));
    hub.setAttribute('cy', String(CENTER));
    hub.setAttribute('r', '4.4');
    hub.setAttribute('fill', 'url(#tm-brass)');
    hub.setAttribute('stroke', '#4a3416');
    hub.setAttribute('stroke-width', '0.6');
    this.svg.appendChild(hub);

    this.element.append(this.svg);

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);

    this.setAngleFraction(angleFractionFromDialPosition(0));
  }

  private rivetPositions(): { x: number; y: number }[] {
    // Four corner-ish bolts on the case, skipping the lower-left where the CSS
    // leather strap tab attaches (season-transition-animation.md §7.1 reference).
    return [0.05, 0.22, 0.78, 0.95].map((f) => angleFractionToXY(f, CASE_RADIUS - 3));
  }

  private buildDefs(): SVGDefsElement {
    const defs = svgEl('defs');
    defs.innerHTML = `
      <linearGradient id="tm-brass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#e3c37a" />
        <stop offset="45%" stop-color="#a9812f" />
        <stop offset="100%" stop-color="#7a5a1f" />
      </linearGradient>
      <linearGradient id="tm-steel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#eef2f4" />
        <stop offset="50%" stop-color="#9aa5ac" />
        <stop offset="100%" stop-color="#5c6469" />
      </linearGradient>
      <radialGradient id="tm-rivet" cx="35%" cy="30%" r="70%">
        <stop offset="0%" stop-color="#f5e6bd" />
        <stop offset="100%" stop-color="#8a6a2f" />
      </radialGradient>
      <radialGradient id="tm-glass-shine" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="rgba(255,255,255,0.55)" />
        <stop offset="100%" stop-color="rgba(255,255,255,0)" />
      </radialGradient>
    `;
    return defs;
  }

  private setAngleFraction(fraction: number): void {
    this.angleFraction = ((fraction % 1) + 1) % 1;
    this.dialPosition = dialPositionFromAngleFraction(this.angleFraction);

    const tip = angleFractionToXY(this.angleFraction, HAND_LENGTH);
    const tail = angleFractionToXY(this.angleFraction + 0.5, HAND_TAIL);
    const perpFraction = this.angleFraction + 0.25;
    const widthAt = (radius: number, w: number) => {
      const base = angleFractionToXY(this.angleFraction, radius);
      const side = angleFractionToXY(perpFraction, w);
      return { x: base.x + (side.x - CENTER), y: base.y + (side.y - CENTER) };
    };
    const shoulder = widthAt(HAND_LENGTH * 0.22, 1.3);
    const shoulderOpp = widthAt(HAND_LENGTH * 0.22, -1.3);
    this.hand.setAttribute(
      'points',
      [
        `${tip.x.toFixed(2)},${tip.y.toFixed(2)}`,
        `${shoulder.x.toFixed(2)},${shoulder.y.toFixed(2)}`,
        `${tail.x.toFixed(2)},${tail.y.toFixed(2)}`,
        `${shoulderOpp.x.toFixed(2)},${shoulderOpp.y.toFixed(2)}`,
      ].join(' '),
    );
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
  }
}

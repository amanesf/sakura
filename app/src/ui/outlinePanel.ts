/**
 * The lower half of the page: the same sky, as a flat white line drawing.
 *
 * The picture at the top is the sky as it looks. This is the sky as a *shape* —
 * the outer contour of the clouds, stroked in one weight, with nothing inside
 * it. Two readings of one thing, one atmospheric and one diagrammatic, which is
 * what makes the empty lower half of the page worth having rather than
 * something to fill.
 *
 * It is drawn with a 2D canvas rather than more WebGL. The contour comes from a
 * 352x192 mask (scene/cloudMask.ts) — under seventy thousand cells — so tracing
 * it in JavaScript is nothing, and a canvas path can be stroked at any weight
 * with round joins, which a shader edge-detect cannot do. The result is a real
 * line, not a row of lit pixels.
 */
export interface OutlinePanel {
  /** Feed it a fresh mask (RGBA bytes from scene/cloudMask.ts). */
  draw: (pixels: Uint8Array, maskWidth: number, maskHeight: number) => void;
  dispose: () => void;
}

/**
 * Marching squares.
 *
 * For each 2x2 group of cells the four corners are inside or outside, which is
 * sixteen cases, and each case says which edge midpoints of that cell the
 * boundary passes between. Emitting those little segments and stroking them all
 * as one path traces every contour in the field at once — including holes, and
 * including the fact that two overlapping clouds have exactly one outline.
 *
 * The two ambiguous cases (5 and 10, where the inside corners are diagonal) are
 * resolved the same way every time. Resolving them consistently matters more
 * than resolving them correctly: an inconsistent choice makes the contour
 * flicker between frames as a lobe drifts by, and this panel updates slowly
 * enough that flicker would be the only thing anyone noticed.
 */
const CASES: number[][] = [
  [], // 0000
  [3, 2], // 0001  bl
  [2, 1], // 0010  br
  [3, 1], // 0011  bl br
  [0, 1], // 0100  tr
  [3, 0, 2, 1], // 0101  tr bl (saddle)
  [0, 2], // 0110  tr br
  [3, 0], // 0111
  [3, 0], // 1000  tl
  [0, 2], // 1001  tl bl
  [3, 2, 0, 1], // 1010  tl br (saddle)
  [0, 1], // 1011
  [3, 1], // 1100  tl tr
  [2, 1], // 1101
  [3, 2], // 1110
  [], // 1111
];

export function createOutlinePanel(host: HTMLElement): OutlinePanel {
  const canvas = document.createElement('canvas');
  canvas.className = 'outline__canvas';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const draw = (pixels: Uint8Array, mw: number, mh: number) => {
    const cssWidth = host.clientWidth;
    const cssHeight = host.clientHeight;
    if (cssWidth < 2 || cssHeight < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cssWidth * dpr);
    const h = Math.round(cssHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    // The mask keeps the picture's aspect, so it covers the panel's width and
    // sits centred in whatever height is left. Centred rather than top-aligned:
    // the drawing is shorter than the panel on a tall phone, and hanging it
    // from the top left a band of dead space under it that read as the panel
    // having failed to fill rather than as margin.
    const scale = w / mw;
    const drawH = mh * scale;
    const offsetY = (h - drawH) * 0.5;

    // readRenderTargetPixels returns rows bottom-up.
    const raw = (cx: number, cy: number) => {
      if (cx < 0 || cy < 0 || cx >= mw || cy >= mh) return false;
      return pixels[((mh - 1 - cy) * mw + cx) * 4] > 110;
    };

    // Majority filter over the eight neighbours before tracing.
    //
    // A satellite lobe can land on a single cell of a 352x192 mask, and a
    // single cell traces to a four-segment diamond — a speck of dirt on the
    // drawing rather than a cloud. Requiring four of the nine cells in a
    // neighbourhood removes anything that small while leaving every real shape
    // where it was, and it smooths the staircase off the contours as a bonus.
    // Cheaper and steadier than finding connected components and dropping the
    // small ones, which would make specks pop in and out as they cross the
    // threshold.
    const inside = (cx: number, cy: number) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (raw(cx + dx, cy + dy)) n++;
      }
      return n >= 4;
    };

    ctx.beginPath();
    const px = (cx: number, edge: number) => {
      // 0 top, 1 right, 2 bottom, 3 left — midpoints of the cell's edges.
      const dx = edge === 1 ? 1 : edge === 3 ? 0 : 0.5;
      return (cx + dx) * scale;
    };
    const py = (cy: number, edge: number) => {
      const dy = edge === 2 ? 1 : edge === 0 ? 0 : 0.5;
      return (cy + dy) * scale + offsetY;
    };

    for (let cy = -1; cy < mh; cy++) {
      for (let cx = -1; cx < mw; cx++) {
        const code =
          (inside(cx, cy) ? 8 : 0) |
          (inside(cx + 1, cy) ? 4 : 0) |
          (inside(cx + 1, cy + 1) ? 2 : 0) |
          (inside(cx, cy + 1) ? 1 : 0);
        const segs = CASES[code];
        for (let i = 0; i < segs.length; i += 2) {
          ctx.moveTo(px(cx, segs[i]), py(cy, segs[i]));
          ctx.lineTo(px(cx, segs[i + 1]), py(cy, segs[i + 1]));
        }
      }
    }

    ctx.lineWidth = Math.max(1, 1.15 * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A faint wide stroke under a crisp thin one: the glow ties the drawing to
    // the lit page around it, and without it a hairline on a dark ground reads
    // as an artefact rather than as ink.
    ctx.strokeStyle = 'rgba(150, 205, 240, 0.22)';
    ctx.lineWidth = Math.max(2, 3.2 * dpr);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(233, 246, 255, 0.82)';
    ctx.lineWidth = Math.max(1, 1.15 * dpr);
    ctx.stroke();
  };

  return {
    draw,
    dispose: () => canvas.remove(),
  };
}

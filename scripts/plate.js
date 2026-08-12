#!/usr/bin/env node
/**
 * Builds the foreground plate: the reference illustration with the *sky*
 * punched out, so the live cloud scene can be rendered behind it.
 *
 * image-sky-plan.md §1. Everything that is not sky — the girl, the room, the
 * window frames and mullions, the hills, the town, the sea — stays as painted
 * pixels at full alpha. Only the region seen through the glass and above the
 * terrain becomes transparent.
 *
 * The sky region is found by flood fill from seeds placed inside each glass
 * opening, not by a hand-drawn polygon: the window frames and mullions are far
 * darker than any sky pixel, so they bound the fill by themselves, and a fill
 * reproduces the frames' exact painted edges instead of approximating them with
 * straight lines. The fill is additionally clipped to the terrain silhouette,
 * which *is* traced (--trace) because the sea/sky boundary is a soft painted
 * gradient that no threshold finds reliably.
 *
 * Usage:
 *   node scripts/plate.js --trace     # terrain silhouette preview (red line)
 *   node scripts/plate.js --preview   # sky mask preview (magenta = punched out)
 *   node scripts/plate.js             # writes app/public/plate.png
 */
const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, '..', '1786443741198.png');
// WebP, not PNG: 127 KB against 2.29 MB for the same 1408x768 RGBA, which
// matters because this loads before the first frame can be composited. Quality
// 92 with lossless alpha — the alpha channel is a hard-edged matte and any
// lossy compression of it shows as fringing along the window frames.
const OUT = path.join(__dirname, '..', 'app', 'public', 'plate.webp');

// Seeds inside each glass opening. Every one of these must land on open sky in
// the reference; the fill spreads from there to the frame edges.
const SEEDS = [
  [1000, 150], // main pane, left of the hero tower
  [1150, 60],  // main pane, above the tower (in case the tower splits the fill)
  [700, 200],  // main pane, left end
  [1380, 300], // the sliver right of the mullion
];

// The sea horizon is a hard near-horizontal edge; hills rise above it. Anything
// below this is land or sea and stays in the plate. Measured off the reference
// (zoomed crops at x=1120 and x=640): the ocean line sits at y≈593 across the
// whole frame, the tallest hill tops out at y≈565.
const SEA_HORIZON_Y = 593;
const TERRAIN_SEARCH_TOP = 530;

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Sky or cloud, in two clauses, because one threshold cannot hold both ends.
 *
 * Luminance alone fails: the darkest open sky (27,118,188 at the top of frame)
 * sits at L=104 while the painted window frame above it (66,100,125) sits at
 * L=95 — nine points apart, which no threshold survives. What actually
 * separates them is chroma: the sky is 70 points more blue than green, the
 * frame only 25. So blue sky is keyed on B-G, and clouds — which are neutral
 * white and have no B-G at all — are keyed on brightness instead. */
function isSky(r, g, b) {
  const L = lum(r, g, b);
  if (b - g > 40 && L > 60) return true;          // open sky, any depth
  if (L > 150 && b - g > 20) return true;         // the dark low cloud band:
                                                  // 102,165,208 at (1100,560),
                                                  // too grey for the clause
                                                  // above, too dark for the one
                                                  // below, and the frames it
                                                  // has to be told apart from
                                                  // are all under L=95
  return L > 200 && b >= r - 6;                   // white cloud, pale haze
}

/** The hills are not green enough to key on hue alone — measured, a hilltop at
 * (670,580) is 79,127,141, i.e. still blue-dominant. What separates it from the
 * dark cloud band directly above it is *how* blue: the cloud shadow at
 * (900,545) is 90,158,203 with B-G = 45, the hill is B-G = 14. And what
 * separates it from the pale haze band just below (171,219,231, B-G = 12) is
 * luminance: 210 against 118. Neither test alone works; together they do.
 * Vegetation and roofs that do read warm are caught by the hue tests. */
function isTerrain(r, g, b) {
  return (lum(r, g, b) < 160 && b - g < 25) || g > b + 4 || r > b + 8;
}

async function load() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height, C: info.channels };
}

/** Topmost terrain row per column: the hill silhouette where there is one, the
 * sea horizon everywhere else. */
function traceTerrain({ data, W, C }) {
  const top = new Int32Array(W).fill(SEA_HORIZON_Y);
  for (let x = 0; x < W; x++) {
    for (let y = TERRAIN_SEARCH_TOP; y < SEA_HORIZON_Y; y++) {
      const i = (y * W + x) * C;
      if (!isTerrain(data[i], data[i + 1], data[i + 2])) continue;
      // Require the hill to actually continue downward — a single green-ish
      // pixel inside a cloud edge is noise, a hilltop is not.
      let run = 0;
      for (let k = 0; k < 8 && y + k < SEA_HORIZON_Y; k++) {
        const j = ((y + k) * W + x) * C;
        if (isTerrain(data[j], data[j + 1], data[j + 2])) run++;
      }
      if (run >= 6) { top[x] = y; break; }
    }
  }
  // Median filter: the town's white roofs and the rock faces punch holes in the
  // vegetation test, and a hill silhouette does not jump 30px between columns.
  const smoothed = new Int32Array(W);
  const R = 5;
  for (let x = 0; x < W; x++) {
    const win = [];
    for (let d = -R; d <= R; d++) win.push(top[Math.min(W - 1, Math.max(0, x + d))]);
    win.sort((a, b) => a - b);
    smoothed[x] = win[R];
  }
  return smoothed;
}

/** Flood fill the sky from the seeds, bounded by the frames (dark), the warm
 * interior, and the terrain line. */
function fillSky(img, terrain) {
  const { data, W, H, C } = img;
  const mask = new Uint8Array(W * H);
  const stack = [];
  for (const [sx, sy] of SEEDS) {
    const i = (sy * W + sx) * C;
    if (!isSky(data[i], data[i + 1], data[i + 2])) {
      throw new Error(`seed ${sx},${sy} is not sky: ${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    stack.push(sy * W + sx);
  }
  while (stack.length) {
    const p = stack.pop();
    if (mask[p]) continue;
    const x = p % W, y = (p / W) | 0;
    if (y >= terrain[x]) continue;
    const i = p * C;
    if (!isSky(data[i], data[i + 1], data[i + 2])) continue;
    mask[p] = 1;
    if (x > 0) stack.push(p - 1);
    if (x < W - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - W);
    if (y < H - 1) stack.push(p + W);
  }
  return mask;
}

/** Close pinholes: the painted highlights on the glass and the darkest cloud
 * cores drop below the sky test and leave speckle inside an otherwise solid
 * region. Anything enclosed by sky *is* sky. */
function closeHoles(mask, W, H) {
  const outside = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => { const p = y * W + x; if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p / W) | 0;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  let filled = 0;
  for (let p = 0; p < mask.length; p++) if (!mask[p] && !outside[p]) { mask[p] = 1; filled++; }
  return filled;
}

async function main() {
  const mode = process.argv[2] || '';
  const img = await load();
  const { data, W, H, C } = img;
  const terrain = traceTerrain(img);

  if (mode === '--trace') {
    const out = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const i = p * C;
      out[p * 3] = data[i]; out[p * 3 + 1] = data[i + 1]; out[p * 3 + 2] = data[i + 2];
    }
    for (let x = 0; x < W; x++) {
      const y = terrain[x];
      const o = (y * W + x) * 3;
      out[o] = 255; out[o + 1] = 0; out[o + 2] = 0;
    }
    const dst = '/tmp/plate_trace.png';
    await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dst);
    console.log(`${dst}  terrain: min y=${Math.min(...terrain)} max y=${Math.max(...terrain)}`);
    return;
  }

  const mask = fillSky(img, terrain);
  const filled = closeHoles(mask, W, H);
  let n = 0;
  for (let p = 0; p < mask.length; p++) n += mask[p];
  console.log(`sky: ${n} px (${(100 * n / (W * H)).toFixed(1)}% of frame), holes closed: ${filled}`);

  if (mode === '--preview') {
    const out = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const i = p * C;
      if (mask[p]) { out[p * 3] = 255; out[p * 3 + 1] = 0; out[p * 3 + 2] = 255; }
      else { out[p * 3] = data[i]; out[p * 3 + 1] = data[i + 1]; out[p * 3 + 2] = data[i + 2]; }
    }
    const dst = '/tmp/plate_preview.png';
    await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dst);
    console.log(dst);
    return;
  }

  // 1px feather so the punched edge does not alias against the frames.
  const alpha = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) alpha[p] = mask[p] ? 0 : 1;
  const soft = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        s += alpha[yy * W + xx]; c++;
      }
      soft[y * W + x] = s / c;
    }
  }

  const out = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const i = p * C;
    out[p * 4] = data[i]; out[p * 4 + 1] = data[i + 1]; out[p * 4 + 2] = data[i + 2];
    out[p * 4 + 3] = Math.round(soft[p] * 255);
  }
  const info = await sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(OUT);
  console.log(`${OUT} (${W}x${H}, ${(info.size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

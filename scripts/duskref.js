#!/usr/bin/env node
/**
 * Measure an evening-sky reference: what colour is the sky at each height, and
 * what colour are the lit and shaded faces of the clouds.
 *
 * The project's own reference (1786443741198.png) is a midday picture, and
 * everything about dusk in this codebase was until now either derived from
 * physics that stops being fitted the moment the sun drops, or read off a
 * screenshot by eye. This does for an evening reference what
 * scripts/skyprofile.js does for the midday one, so the sunset can be aimed at
 * numbers like everything else.
 *
 * Usage: node scripts/duskref.js <image> [x0 y0 x1 y1]
 *   The crop is the artwork inside the screenshot — pass it, because a phone
 *   screenshot is mostly browser chrome and the chrome is what a naive
 *   histogram will describe.
 *
 * Sky and cloud are separated by saturation and luminance rather than by hand:
 * at dusk the sky is the *darker, more saturated* thing and the clouds are the
 * brighter, and that ordering holds all the way down the frame even as both
 * change colour completely.
 */
const sharp = require('sharp');

const FILE = process.argv[2];
if (!FILE) {
  console.error('usage: node scripts/duskref.js <image> [x0 y0 x1 y1]');
  process.exit(1);
}
const BOX = process.argv.slice(3, 7).map(Number);

const LUMA = [0.2126, 0.7152, 0.0722];
const lum = (r, g, b) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
const sat = (r, g, b) => { const mx = Math.max(r, g, b); return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx; };
const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

(async () => {
  let img = sharp(FILE);
  const meta = await img.metadata();
  let x0 = 0, y0 = 0, x1 = meta.width, y1 = meta.height;
  if (BOX.length === 4 && BOX.every(Number.isFinite)) [x0, y0, x1, y1] = BOX;
  const W = x1 - x0, H = y1 - y0;
  const { data } = await sharp(FILE)
    .extract({ left: x0, top: y0, width: W, height: H })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });

  const px = (x, y) => {
    const i = (y * W + x) * 3;
    return [data[i], data[i + 1], data[i + 2]];
  };

  // --- Sky by height ---------------------------------------------------
  //
  // The sky is what is left after the clouds and the roofs are removed. Taking
  // a low percentile of luminance within each band finds it without a mask:
  // clouds are the bright things and the silhouetted foreground is far darker
  // than either, so the sky sits in between — which is why this takes a
  // *median of the middle*, not a minimum.
  const BANDS = 12;
  console.log(`${FILE}  crop ${x0},${y0} ${W}x${H}`);
  console.log('\nsky by height (top to bottom)');
  console.log('band            rgb              hex      lum   sat   R/B');
  for (let b = 0; b < BANDS; b++) {
    const ya = y0 + Math.floor((b * H) / BANDS) - y0;
    const yb = y0 + Math.floor(((b + 1) * H) / BANDS) - y0;
    const rows = [];
    for (let y = ya; y < yb; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const [r, g, bl] = px(x, y);
        const l = lum(r, g, bl);
        if (l < 25) continue; // silhouetted roofs, wires, poles
        rows.push([l, r, g, bl]);
      }
    }
    if (rows.length < 40) { console.log(`${String(ya).padStart(4)}-${String(yb).padStart(4)}  (too few)`); continue; }
    rows.sort((p, q) => p[0] - q[0]);
    // The 35th percentile: below the clouds, above the foreground.
    const s = rows[Math.floor(rows.length * 0.35)];
    const [, r, g, bl] = s;
    console.log(
      `${String(ya).padStart(4)}-${String(yb).padStart(4)}  ` +
      `${String(r).padStart(3)},${String(g).padStart(3)},${String(bl).padStart(3)}   ${hex(r, g, bl)}  ` +
      `${lum(r, g, bl).toFixed(0).padStart(4)}  ${sat(r, g, bl).toFixed(2)}  ${(r / Math.max(bl, 1)).toFixed(2)}`,
    );
  }

  // --- Cloud, by how lit it is ----------------------------------------
  //
  // Ranked by luminance over the cloud pixels only, then reported at
  // percentiles. That is the same shape of measurement scene/cloudRamp.ts is
  // built from — a ramp indexed by population — so these numbers can be
  // compared with it directly.
  const cloud = [];
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const [r, g, bl] = px(x, y);
      const l = lum(r, g, bl);
      // Cloud: brighter than the sky behind it and warmer than it. The r>b test
      // is what separates a lit cloud from the sky at this hour; the luminance
      // floor drops the foreground.
      if (l > 70 && r > bl) cloud.push([l, r, g, bl]);
    }
  }
  cloud.sort((p, q) => p[0] - q[0]);
  console.log(`\ncloud, ${cloud.length} px, by luminance percentile`);
  console.log('pct    rgb              hex      lum   sat   R/B');
  for (const q of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98]) {
    const [, r, g, bl] = cloud[Math.floor(cloud.length * q)];
    console.log(
      `${String(Math.round(q * 100)).padStart(3)}%   ` +
      `${String(r).padStart(3)},${String(g).padStart(3)},${String(bl).padStart(3)}   ${hex(r, g, bl)}  ` +
      `${lum(r, g, bl).toFixed(0).padStart(4)}  ${sat(r, g, bl).toFixed(2)}  ${(r / Math.max(bl, 1)).toFixed(2)}`,
    );
  }
})();

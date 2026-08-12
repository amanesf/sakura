#!/usr/bin/env node
/**
 * Where the render's darkest sky pixels are, and what colour they are.
 *
 * "Which pixels are the rendered sky" is not a guess here: app/public/plate.webp
 * is the reference illustration with the sky punched out, so its alpha channel
 * is exactly the mask. Alpha 0 = the app is showing its own render there;
 * anything else is painted illustration (window frames, the girl, the town),
 * which is dark for reasons that have nothing to do with the clouds and would
 * otherwise dominate any "find the dark pixels" search.
 *
 * Within that mask, "dark" cannot mean low luminance: the zenith is the
 * darkest thing in the frame (luminance ~99 against a cloud median of ~200),
 * so a plain "find the dark pixels" search returns nothing but clear sky.
 *
 * The test is instead *darker than the clear sky at that spot*. Nothing in
 * this scene should be: the sky is the darkest surface here and cloud only
 * ever adds light in front of it. That definition also catches the artifact
 * cloudShader.ts documents, where a fragment whose shading term is pinned at 0
 * samples the ramp's bottom entry and comes out a vivid dark blue — which a
 * cloud/sky split by saturation would file under "sky" and never report.
 *
 * The clear-sky reference is a coarse grid (see below), not a per-row median:
 * the sky varies with azimuth as well as elevation, and a per-row reference
 * flagged a whole corner of ordinary blue sky, 3% of the frame.
 *
 * Usage: node scripts/darkspots.js /tmp/shot.png [topCells]
 */
const sharp = require('sharp');
const path = require('path');

const SHOT = process.argv[2] || '/tmp/shot.png';
const TOP = Number(process.argv[3] || 12);
const CELL = 32;

(async () => {
  const plate = await sharp(path.join(__dirname, '..', 'app', 'public', 'plate.webp'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const shot = await sharp(SHOT).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = plate.info;
  if (shot.info.width !== W || shot.info.height !== H) {
    console.error(`size mismatch: plate ${W}x${H}, shot ${shot.info.width}x${shot.info.height}`);
    process.exit(1);
  }

  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = (r, g, b) => { const mx = Math.max(r, g, b); return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx; };
  const CLOUD_SAT = 0.55; // between the cloud ramp's ~0.35 top and the sky's ~0.75
  // How far below the local clear sky a pixel has to sit to be called a hole.
  const DARK_MARGIN = 12;
  // Cell size of the clear-sky reference grid.
  const GRID = 48;

  // A 2D reference for what the clear sky looks like behind the clouds, built
  // from the clear-sky pixels that are visible and diffused into the parts of
  // the frame where cloud hides it.
  //
  // A per-row reference is not enough, and the failure is not subtle: the sky
  // shader varies with azimuth as well as elevation, so on a row that spans
  // the frame the left side sits ~20 luminance below the right. Comparing
  // against the row's median therefore flagged an entire corner of perfectly
  // ordinary blue sky — 3% of the frame — as "darker than the sky".
  //
  // So the reference is a coarse grid of cell medians, and cells with too few
  // clear-sky pixels are filled by repeatedly averaging their filled
  // neighbours. That is a crude diffusion, which is exactly right here: the
  // quantity being reconstructed is a smooth gradient, and the alternative
  // (assuming it is locally flat) is what produced the false positives.
  const GW = Math.ceil(W / GRID), GH = Math.ceil(H / GRID);
  let grid = new Float64Array(GW * GH).fill(NaN);
  const bucket = Array.from({ length: GW * GH }, () => []);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (plate.data[(y * W + x) * 4 + 3] > 8) continue;
      const si = (y * W + x) * 3;
      const r = shot.data[si], g = shot.data[si + 1], b = shot.data[si + 2];
      if (sat(r, g, b) > 0.65) bucket[((y / GRID) | 0) * GW + ((x / GRID) | 0)].push(lum(r, g, b));
    }
  }
  for (let i = 0; i < grid.length; i++) {
    const s = bucket[i];
    if (s.length >= 24) { s.sort((a, b) => a - b); grid[i] = s[s.length >> 1]; }
  }
  for (let pass = 0; pass < GW + GH; pass++) {
    let holes = 0;
    const next = grid.slice();
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const i = gy * GW + gx;
        if (!Number.isNaN(grid[i])) continue;
        let sum = 0, cnt = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const v = grid[ny * GW + nx];
          if (!Number.isNaN(v)) { sum += v; cnt++; }
        }
        if (cnt) next[i] = sum / cnt; else holes++;
      }
    }
    grid = next;
    if (!holes) break;
  }
  /** Bilinearly sampled sky reference at a pixel. */
  const skyAt = (x, y) => {
    const fx = Math.min(Math.max(x / GRID - 0.5, 0), GW - 1);
    const fy = Math.min(Math.max(y / GRID - 0.5, 0), GH - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, GW - 1), y1 = Math.min(y0 + 1, GH - 1);
    const tx = fx - x0, ty = fy - y0;
    const g = (gx, gy) => grid[gy * GW + gx];
    return (g(x0, y0) * (1 - tx) + g(x1, y0) * tx) * (1 - ty) +
           (g(x0, y1) * (1 - tx) + g(x1, y1) * tx) * ty;
  };

  const hist = new Array(256).fill(0);
  let n = 0, cloudN = 0, darker = 0;
  const cells = new Map();

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (plate.data[(y * W + x) * 4 + 3] > 8) continue; // painted illustration
      const si = (y * W + x) * 3;
      const r = shot.data[si], g = shot.data[si + 1], b = shot.data[si + 2];
      const l = lum(r, g, b);
      n++;
      if (sat(r, g, b) <= CLOUD_SAT) { cloudN++; hist[Math.round(l)]++; }
      // Deliberately NOT gated on saturation. The failure mode this is looking
      // for is the one cloudShader.ts documents: a fragment whose shading term
      // is pinned at 0 samples the ramp's bottom entry, which is a vivid blue,
      // so the artifact is both dark *and* saturated and a cloud/sky split by
      // saturation would file it under "sky" and never report it. Being darker
      // than the row's own clear sky is the property that no correct pixel in
      // this scene has, whatever its hue: the sky is the darkest thing here
      // and cloud only ever adds light on top of it.
      const ref = skyAt(x, y);
      if (!(l < ref - DARK_MARGIN)) continue;
      darker++;
      const key = `${(x / CELL) | 0},${(y / CELL) | 0}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { min: 255, mx: 0, my: 0, r: 0, g: 0, b: 0, ref: 0, count: 0 }));
      c.count++;
      if (l < c.min) { c.min = l; c.mx = x; c.my = y; c.r = r; c.g = g; c.b = b; c.ref = ref; }
    }
  }

  const pct = (q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc / cloudN >= q) return i; } return 255; };
  console.log(`rendered sky: ${n} px (${(100 * n / (W * H)).toFixed(1)}% of frame)`);
  console.log(`  of which cloud (sat<=${CLOUD_SAT}): ${cloudN} px (${(100 * cloudN / n).toFixed(1)}%)`);
  console.log(`cloud luminance p0.1=${pct(0.001)} p1=${pct(0.01)} p5=${pct(0.05)} p50=${pct(0.5)} p95=${pct(0.95)}`);
  console.log(`px darker than the local clear sky by >${DARK_MARGIN}: ${darker} (${(100 * darker / n).toFixed(3)}% of rendered sky)`);

  const worst = [...cells.values()].sort((a, b) => b.count - a.count).slice(0, TOP);
  console.log(`\nworst ${CELL}px cells (ranked by count of such pixels):`);
  for (const c of worst) {
    console.log(
      `  (${c.mx},${c.my}) lum=${c.min.toFixed(0)} vs sky ${c.ref.toFixed(0)} ` +
      `rgb=(${c.r},${c.g},${c.b}) sat=${sat(c.r, c.g, c.b).toFixed(2)} px=${c.count}`,
    );
  }

  // --- Lobes that read as black *against their own cloud* ---
  //
  // The test above is absolute, and on this scene it finds nothing: no cloud
  // pixel is darker than the sky. But "異常に黒い雲" is a relative complaint —
  // a lobe at luminance 165 sitting among neighbours at 250 reads as a hole
  // punched in the cloud even though 165 is a perfectly legal shadow value.
  // So this pass compares each cloud pixel against the local cloud level
  // (a box mean over cloud pixels only, radius R) and reports the deep
  // outliers, which is what the eye is actually objecting to.
  const R = 30;
  const cloudMask = new Uint8Array(W * H);
  const cloudVal = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (plate.data[i * 4 + 3] > 8) continue;
      const si = i * 3;
      const r = shot.data[si], g = shot.data[si + 1], b = shot.data[si + 2];
      if (sat(r, g, b) > CLOUD_SAT) continue;
      cloudMask[i] = 1;
      cloudVal[i] = lum(r, g, b);
    }
  }
  // Integral images, so the box mean is O(1) per pixel regardless of R.
  const iw = W + 1;
  const sumI = new Float64Array(iw * (H + 1));
  const cntI = new Float64Array(iw * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowS = 0, rowC = 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      rowS += cloudVal[i]; rowC += cloudMask[i];
      sumI[(y + 1) * iw + x + 1] = sumI[y * iw + x + 1] + rowS;
      cntI[(y + 1) * iw + x + 1] = cntI[y * iw + x + 1] + rowC;
    }
  }
  const boxed = (I, x0, y0, x1, y1) =>
    I[y1 * iw + x1] - I[y0 * iw + x1] - I[y1 * iw + x0] + I[y0 * iw + x0];

  const DEEP = 55; // luminance below the local cloud level to count as a hole
  let holes = 0;
  const holeCells = new Map();
  let worstDelta = 0, wx = 0, wy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!cloudMask[i]) continue;
      const x0 = Math.max(x - R, 0), y0 = Math.max(y - R, 0);
      const x1 = Math.min(x + R + 1, W), y1 = Math.min(y + R + 1, H);
      const c = boxed(cntI, x0, y0, x1, y1);
      if (c < 200) continue; // too little cloud around to judge against
      const mean = boxed(sumI, x0, y0, x1, y1) / c;
      const delta = mean - cloudVal[i];
      if (delta < DEEP) continue;
      holes++;
      if (delta > worstDelta) { worstDelta = delta; wx = x; wy = y; }
      const key = `${(x / CELL) | 0},${(y / CELL) | 0}`;
      let hc = holeCells.get(key);
      if (!hc) holeCells.set(key, (hc = { x, y, count: 0, maxDelta: 0, lum: 255 }));
      hc.count++;
      if (delta > hc.maxDelta) { hc.maxDelta = delta; hc.x = x; hc.y = y; hc.lum = cloudVal[i]; }
    }
  }
  console.log(`\ncloud px more than ${DEEP} below the local cloud level (r=${R}): ` +
    `${holes} (${(100 * holes / cloudN).toFixed(3)}% of cloud)`);
  if (holes) console.log(`  worst single px: (${wx},${wy}) is ${worstDelta.toFixed(0)} below local`);
  const hw = [...holeCells.values()].sort((a, b) => b.count - a.count).slice(0, TOP);
  for (const c of hw) {
    console.log(`  (${c.x},${c.y}) lum=${c.lum.toFixed(0)} delta=-${c.maxDelta.toFixed(0)} px=${c.count}`);
  }
})();

#!/usr/bin/env node
/**
 * A CPU port of scene/sky.ts's fragment shader (plus the renderer's ACES +
 * sRGB output), so the atmosphere's parameters can be *solved* against the
 * reference image's measured per-elevation profile instead of guessed and then
 * verified by a four-minute SwiftShader capture each time.
 *
 * This is the plan.md §2 stance applied to the sky: the scattering integral is
 * a closed piece of physics, so the right way to pick SUN_INTENSITY / MIE_COEFF
 * / the haze target is to evaluate the integral over the elevations the
 * reference gives us numbers for and minimise the residual — not to nudge a
 * constant and re-render.
 *
 * The post chain (bloom / grade / Kuwahara / macro-contrast) is NOT modelled.
 * It does not have to be: parameters are compared through the *ratio* to the
 * modelled baseline, and the measured baseline supplies the rest. See
 * `--calibrate`, which prints model-vs-measured for the committed parameters so
 * that assumption stays honest and visible.
 *
 * Usage:
 *   node scripts/skymodel.js --profile [--set K=V ...]
 *   node scripts/skymodel.js --solve            # fit against the reference
 *   node scripts/skymodel.js --calibrate <measured-render.png>
 */

const P = {
  PLANET_RADIUS: 6371.0,
  ATMOS_RADIUS: 6471.0,
  RAYLEIGH_R: 5.8e-3,
  RAYLEIGH_G: 13.5e-3,
  RAYLEIGH_B: 33.1e-3,
  RAYLEIGH_SCALE_HEIGHT: 8.0,
  MIE_COEFF: 9.0e-3,
  MIE_EXT_FACTOR: 1.11,
  MIE_SCALE_HEIGHT: 1.2,
  MIE_G: 0.76,
  SUN_INTENSITY: 11.0,
  SKY_SATURATION: 1.7,
  HAZE_R: 0.0859,
  HAZE_G: 0.3001,
  HAZE_B: 0.6167,
  HAZE_STRENGTH: 0.95,
  // Second, darker haze colour reached at the horizon itself. A single flat
  // haze constant cannot reproduce the reference's low sky, which *rises* to a
  // peak around 15 degrees and then falls again toward the horizon (178.5 at
  // 14.6 deg, 159.8 at 0.8 deg); a constant necessarily plateaus.
  HAZE_LO_R: 0.12,
  HAZE_LO_G: 0.31,
  HAZE_LO_B: 0.66,
  HAZE_FLOOR_HI: 0.23,
  HAZE_LO: 0.23,
  HAZE_HI: 0.36,
  SAT_FADE_LO: -0.02,
  SAT_FADE_HI: 0.28,
  MULTI_SCATTER: 0.004,
  EXPOSURE: 1.2,
  CAMERA_ALTITUDE_KM: 0.0017,
  CIRRUS_R: 0.4836,
  CIRRUS_G: 1.3152,
  CIRRUS_B: 2.81,
  CIRRUS_STRENGTH: 0.15,
};

const FOV_V_DEG = 50;
const ASPECT = 1408 / 768;
const HORIZON_FRAC = 0.72;
const W = 1408;
const H = 768;

const PRIMARY_STEPS = 16;
const LIGHT_STEPS = 4;

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function raySphere(ro, rd, cy, radius) {
  const ocx = ro[0];
  const ocy = ro[1] - cy;
  const ocz = ro[2];
  const b = ocx * rd[0] + ocy * rd[1] + ocz * rd[2];
  const c = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;
  const h = b * b - c;
  if (h < 0) return [-1, -1];
  const s = Math.sqrt(h);
  return [-b - s, -b + s];
}

function integrateAtmosphere(p, ro, rd, sunDir, rayLength) {
  const mu = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2];
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g2 = p.MIE_G * p.MIE_G;
  const phaseM =
    (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * p.MIE_G * mu, 1e-4), 1.5));

  const cy = -p.PLANET_RADIUS;
  const stepSize = rayLength / PRIMARY_STEPS;
  const mieExt = p.MIE_COEFF * p.MIE_EXT_FACTOR;
  const RC = [p.RAYLEIGH_R, p.RAYLEIGH_G, p.RAYLEIGH_B];

  let totR = 0;
  let totM = 0;
  let odR = 0;
  let odM = 0;
  const accR = [0, 0, 0];
  const accM = [0, 0, 0];

  for (let i = 0; i < PRIMARY_STEPS; i++) {
    const d = stepSize * (i + 0.5);
    const sx = ro[0] + rd[0] * d;
    const sy = ro[1] + rd[1] * d;
    const sz = ro[2] + rd[2] * d;
    const height = Math.hypot(sx, sy - cy, sz) - p.PLANET_RADIUS;
    const hh = Math.max(height, 0);
    const dR = Math.exp(-hh / p.RAYLEIGH_SCALE_HEIGHT) * stepSize;
    const dM = Math.exp(-hh / p.MIE_SCALE_HEIGHT) * stepSize;
    odR += dR;
    odM += dM;

    const lightHit = raySphere([sx, sy, sz], sunDir, cy, p.ATMOS_RADIUS);
    const lightStep = Math.max(lightHit[1], 0) / LIGHT_STEPS;
    let lodR = 0;
    let lodM = 0;
    let blocked = false;
    for (let j = 0; j < LIGHT_STEPS; j++) {
      const ld = lightStep * (j + 0.5);
      const lx = sx + sunDir[0] * ld;
      const ly = sy + sunDir[1] * ld;
      const lz = sz + sunDir[2] * ld;
      const lh = Math.hypot(lx, ly - cy, lz) - p.PLANET_RADIUS;
      if (lh < 0) {
        blocked = true;
        break;
      }
      const lhh = Math.max(lh, 0);
      lodR += Math.exp(-lhh / p.RAYLEIGH_SCALE_HEIGHT) * lightStep;
      lodM += Math.exp(-lhh / p.MIE_SCALE_HEIGHT) * lightStep;
    }

    if (!blocked) {
      for (let k = 0; k < 3; k++) {
        const tau = RC[k] * (odR + lodR) + mieExt * (odM + lodM);
        const attn = Math.exp(-tau);
        accR[k] += dR * attn;
        accM[k] += dM * attn;
      }
    }
    totR += dR;
    totM += dM;
  }

  const transmittance = [0, 0, 0];
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    transmittance[k] = Math.exp(-(RC[k] * odR + mieExt * odM));
    const single = p.SUN_INTENSITY * (accR[k] * RC[k] * phaseR + accM[k] * p.MIE_COEFF * phaseM);
    const lost = 1 - transmittance[k];
    const multi =
      lost * p.SUN_INTENSITY * p.MULTI_SCATTER * Math.min(1, Math.max(0.05, sunDir[1] * 1.5 + 0.4));
    out[k] = single + multi;
  }
  return out;
}

// three.js ACESFilmicToneMapping, then sRGB encode — what OutputPass applies.
function acesSrgb(c, exposure) {
  const inM = [
    [0.59719, 0.35458, 0.04823],
    [0.076, 0.90834, 0.01566],
    [0.0284, 0.13383, 0.83777],
  ];
  const outM = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
  ];
  const v = c.map((x) => (x * exposure) / 0.6);
  const a = inM.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const fit = a.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  const b = outM.map((r) => r[0] * fit[0] + r[1] * fit[1] + r[2] * fit[2]);
  return b.map((x) => {
    const y = Math.min(1, Math.max(0, x));
    const s = y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055;
    return s * 255;
  });
}

function rayDir(x, y) {
  const halfFov = ((FOV_V_DEG / 2) * Math.PI) / 180;
  const pitch = Math.atan((HORIZON_FRAC - 0.5) * 2 * Math.tan(halfFov));
  const ndcX = (2 * (x + 0.5)) / W - 1;
  const ndcY = 1 - (2 * (y + 0.5)) / H;
  const cx = ndcX * ASPECT * Math.tan(halfFov);
  const cy = ndcY * Math.tan(halfFov);
  const cz = -1;
  const wy = cy * Math.cos(pitch) - cz * Math.sin(pitch);
  const wz = cy * Math.sin(pitch) + cz * Math.cos(pitch);
  const len = Math.hypot(cx, wy, wz);
  return [cx / len, wy / len, wz / len];
}

const SUN_ELEV_DEG = 55;
const SUN_AZ_DEG = 55;
function sunVec() {
  const e = (SUN_ELEV_DEG * Math.PI) / 180;
  const a = (SUN_AZ_DEG * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** One pixel of sky, in display sRGB 0-255. Cirrus is omitted (it is noise). */
function skyPixel(p, x, y, cover = 0) {
  const rd = rayDir(x, y);
  const ro = [0, p.CAMERA_ALTITUDE_KM, 0];
  const sun = sunVec();
  const atmos = raySphere(ro, rd, -p.PLANET_RADIUS, p.ATMOS_RADIUS);
  let col = integrateAtmosphere(p, ro, rd, sun, Math.max(atmos[1], 0.001));

  // Thin high cloud, blended into the raw scattering exactly where sky.ts does
  // it — before the horizon haze and before the saturation lift. `cover` is the
  // noise mask's value, passed in rather than evaluated: what matters for
  // sizing the constant is the lift at full cover, which is the statistic the
  // reference was measured for.
  if (cover > 0) {
    const cir = [p.CIRRUS_R, p.CIRRUS_G, p.CIRRUS_B];
    const m = cover * p.CIRRUS_STRENGTH;
    col = col.map((c, k) => c + (cir[k] - c) * m);
  }

  const lowSky = 1 - smoothstep(p.HAZE_LO, p.HAZE_HI, rd[1]);
  const toHorizon = smoothstep(0, p.HAZE_FLOOR_HI, rd[1]);
  const haze = [
    p.HAZE_LO_R + (p.HAZE_R - p.HAZE_LO_R) * toHorizon,
    p.HAZE_LO_G + (p.HAZE_G - p.HAZE_LO_G) * toHorizon,
    p.HAZE_LO_B + (p.HAZE_B - p.HAZE_LO_B) * toHorizon,
  ];
  col = col.map((c, k) => c + (haze[k] - c) * lowSky * p.HAZE_STRENGTH);

  const horizonFade = smoothstep(p.SAT_FADE_LO, p.SAT_FADE_HI, rd[1]);
  const luma = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
  const satAmt = 1 + (p.SKY_SATURATION - 1) * horizonFade;
  col = col.map((c) => luma + (c - luma) * satAmt);

  return acesSrgb(col.map((c) => Math.max(c, 0)), p.EXPOSURE);
}

const X0 = 700;
const X1 = 1290;
const Y0 = 40;
const Y1 = 560;
const BANDS = 13;

/** Band-averaged sky, over the same window the measurements use. */
function profile(p) {
  const rows = [];
  const step = (Y1 - Y0) / BANDS;
  for (let b = 0; b < BANDS; b++) {
    const ya = Math.round(Y0 + b * step);
    const yb = Math.round(Y0 + (b + 1) * step);
    const acc = [0, 0, 0];
    let n = 0;
    for (let y = ya; y < yb; y += 4) {
      for (let x = X0; x < X1; x += 16) {
        const c = skyPixel(p, x, y);
        acc[0] += c[0];
        acc[1] += c[1];
        acc[2] += c[2];
        n++;
      }
    }
    rows.push({ ya, yb, rgb: acc.map((v) => v / n) });
  }
  return rows;
}

// Reference sky, measured by scripts/skyprofile.js over the same window
// (1786443741198.png, x[700,1290) y[40,560), 13 bands, sky-classified pixels).
const REF = [
  [31, 122, 190],
  [34, 126, 192],
  [44, 135, 199],
  [60, 147, 206],
  [75, 160, 213],
  [88, 169, 218],
  [105, 180, 223],
  [123, 190, 229],
  [125, 187, 225],
  [122, 185, 223],
  [123, 182, 219],
  [117, 176, 214],
  [109, 170, 209],
];

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function residual(p) {
  const rows = profile(p);
  let s = 0;
  for (let i = 0; i < REF.length; i++) {
    for (let k = 0; k < 3; k++) s += Math.pow(rows[i].rgb[k] - REF[i][k], 2);
  }
  return Math.sqrt(s / (REF.length * 3));
}

function printProfile(p, label) {
  const rows = profile(p);
  console.log(`\n${label}`);
  console.log(['band'.padEnd(12), 'model RGB'.padEnd(16), 'lum'.padStart(6), '|', 'ref RGB'.padEnd(16), 'lum'.padStart(6), 'dLum'].join('  '));
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].rgb;
    const r = REF[i];
    console.log(
      [
        `y${rows[i].ya}-${rows[i].yb}`.padEnd(12),
        `${m[0].toFixed(0)},${m[1].toFixed(0)},${m[2].toFixed(0)}`.padEnd(16),
        lum(m).toFixed(1).padStart(6),
        '|',
        `${r[0]},${r[1]},${r[2]}`.padEnd(16),
        lum(r).toFixed(1).padStart(6),
        (lum(m) - lum(r)).toFixed(1).padStart(6),
      ].join('  '),
    );
  }
  console.log(`RMSE vs reference: ${residual(p).toFixed(2)}`);
}

// --- CLI ---
const args = process.argv.slice(2);
const overrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') {
    const [k, v] = args[i + 1].split('=');
    overrides[k] = Number(v);
    i++;
  }
}
const p = { ...P, ...overrides };

if (args.includes('--cirrus')) {
  // Luminance lift at full cover, for the elevations the cirrus plane actually
  // covers. Reference: the streaks over its clear sky peak at +53 luminance and
  // occupy ~12% of it; this render measured +36 over 28%.
  const lumOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  console.log('CIRRUS_STRENGTH -> luminance lift at full cover');
  for (const st of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
    const q = { ...p, CIRRUS_STRENGTH: st };
    const out = [];
    for (const y of [60, 140, 220]) {
      const base = lumOf(skyPixel(q, 995, y, 0));
      const lit = lumOf(skyPixel(q, 995, y, 1));
      out.push(`y${y}: ${base.toFixed(0)}->${lit.toFixed(0)} (+${(lit - base).toFixed(1)})`);
    }
    console.log(`  ${st.toFixed(2)}  ${out.join('   ')}`);
  }
} else if (args.includes('--solve')) {
  // Coordinate descent over the parameters that shape the elevation profile.
  // SUN_INTENSITY sets overall level; MIE_COEFF lifts and neutralises the
  // horizon (it is the turbidity term, concentrated in the low 1.2km);
  // SKY_SATURATION is the explicit stylisation sky.ts already carries; the
  // haze triple is the pale low-sky target.
  const knobs = [
    ['SUN_INTENSITY', 3, 30, 0.25],
    ['MIE_COEFF', 0.001, 0.09, 0.0005],
    ['SKY_SATURATION', 1.0, 4.0, 0.05],
    ['HAZE_STRENGTH', 0.0, 1.0, 0.02],
    ['HAZE_LO', -0.1, 0.4, 0.01],
    ['HAZE_HI', 0.05, 0.9, 0.01],
    ['HAZE_R', 0.0, 3.0, 0.01],
    ['HAZE_G', 0.0, 4.0, 0.01],
    ['HAZE_B', 0.0, 6.0, 0.02],
    ['HAZE_LO_R', 0.0, 1.0, 0.005],
    ['HAZE_LO_G', 0.0, 1.5, 0.005],
    ['HAZE_LO_B', 0.0, 2.0, 0.01],
    ['HAZE_FLOOR_HI', 0.02, 0.5, 0.01],
    ['SAT_FADE_HI', 0.02, 0.9, 0.01],
    ['MULTI_SCATTER', 0.0, 0.03, 0.0005],
  ];
  let cur = { ...p };
  let best = residual(cur);
  console.log(`start RMSE ${best.toFixed(3)}`);
  for (let pass = 0; pass < 6; pass++) {
    for (const [name, lo, hi, step] of knobs) {
      let bestV = cur[name];
      for (let v = lo; v <= hi + 1e-9; v += step) {
        const trial = { ...cur, [name]: v };
        const r = residual(trial);
        if (r < best - 1e-6) {
          best = r;
          bestV = v;
        }
      }
      cur[name] = bestV;
    }
    console.log(`pass ${pass}: RMSE ${best.toFixed(3)}`);
  }
  console.log('\nsolved parameters:');
  for (const [name] of knobs) console.log(`  ${name} = ${cur[name]}`);
  printProfile(cur, 'solved profile');
} else {
  printProfile(p, 'profile');
}

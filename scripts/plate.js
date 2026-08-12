#!/usr/bin/env node
/**
 * Builds the foreground plate: the reference illustration with the *sky* punched
 * out, so the live cloud scene can be rendered behind it.
 *
 * image-sky-plan.md §1. Everything that is not sky — the girl, the room, the
 * window frames and mullions, the hills, the town, the sea — stays as painted
 * pixels at full alpha.
 *
 * Two inputs. `1786443741198.png` is the reference as painted;
 * `1786511966180.png` is the same frame with every pane of sky flooded to a flat
 * magenta by hand. The matte comes from the keyed one, which makes this an
 * ordinary chroma key rather than the colour-classifier this script used to be:
 * the hand key knows the girl's white shirt from a white cloud, and it knows
 * that the pane behind her is sky, neither of which any threshold on the
 * original could tell reliably.
 *
 * The reflections *on* the glass — the girl's ghost, the frame's diagonal —
 * survive the hand key as pale tints over the magenta, but they are dropped
 * here: a reflection is a static image of the room, and leaving it painted over
 * a sky that moves reads as a smudge on the screen rather than as glass. They
 * are islands surrounded by key, so absorbing them costs one flood fill.
 *
 * Usage:
 *   node scripts/plate.js --preview   # matte over a flat colour, to eyeball
 *   node scripts/plate.js             # writes app/public/plate.webp
 */
const sharp = require('sharp');
const path = require('path');

const REF = path.join(__dirname, '..', '1786443741198.png');
const KEYED = path.join(__dirname, '..', '1786511966180.png');
// WebP, not PNG: 127 KB against 2.29 MB for the same 1408x768 RGBA, and this
// has to load before the first frame can be composited.
const OUT = path.join(__dirname, '..', 'app', 'public', 'plate.webp');

/** The flooded colour, taken as the modal pixel of the keyed image (7.2% of the
 * frame on its own; the next five modes are the same colour ±2 from PNG
 * re-encoding, together another 16%). */
const KEY = [207.5, 4, 248];

/** Everything within this distance of the key is sky. It is deliberately huge —
 * nearly half the way from the key to the darkest window frame (210 away) —
 * because every pixel that is *mostly* magenta has to go: a narrow tolerance
 * left a violet rim wherever an antialiased frame edge met the flood, and left
 * the girl's reflection standing as a purple ghost. The matte is binary rather
 * than a ramp for the same reason. Nothing partially-keyed survives to be
 * un-mixed, so no magenta can reach the output at all. */
const KEY_TOLERANCE = 105;

const dist = (r, g, b) => Math.hypot(r - KEY[0], g - KEY[1], b - KEY[2]);

async function raw(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height, C: info.channels };
}

/** Marks every pixel enclosed by the mask as part of it. Implemented as a fill
 * from the frame's border through the *un*masked pixels: whatever the border
 * cannot reach is surrounded. */
function fillEnclosed(mask, W, H) {
  const outside = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    const p = y * W + x;
    if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
  };
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
  const ref = await raw(REF);
  const keyed = await raw(KEYED);
  const { W, H } = ref;
  if (keyed.W !== W || keyed.H !== H) throw new Error('the keyed image must match the reference frame');

  const isKey = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const j = p * keyed.C;
    if (dist(keyed.data[j], keyed.data[j + 1], keyed.data[j + 2]) < KEY_TOLERANCE) isKey[p] = 1;
  }

  // The reflections on the glass — the girl's ghost, the frame's diagonal — are
  // islands of not-quite-key surrounded by key. They are reflections of the room
  // *and* they let the sky through, so keeping them would freeze a static ghost
  // over a moving sky; they are dropped and the sky shows in full. Anything
  // enclosed by sky is sky.
  const filled = fillEnclosed(isKey, W, H);

  const out = Buffer.alloc(W * H * 4);
  let sky = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * ref.C;
    // RGB always comes from the original reference, never from the keyed file:
    // it is the untouched artwork, and no magenta can leak in even where
    // bilinear filtering samples across the matte edge.
    out[p * 4] = ref.data[i];
    out[p * 4 + 1] = ref.data[i + 1];
    out[p * 4 + 2] = ref.data[i + 2];
    if (isKey[p]) sky++;
  }

  // One-pixel feather, so the punched edge does not alias against the painted
  // window frames. This is the only place alpha is anything but 0 or 255.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          s += isKey[yy * W + xx] ? 0 : 1;
          c++;
        }
      }
      out[(y * W + x) * 4 + 3] = Math.round((s / c) * 255);
    }
  }

  console.log(
    `sky: ${sky} px (${(100 * sky / (W * H)).toFixed(1)}% of frame), ` +
    `reflections/islands absorbed: ${filled} px`,
  );

  if (process.argv[2] === '--preview') {
    // Composite over a flat mid-grey so the matte and the recovered reflections
    // can both be judged: purple fringing would mean the un-mix is wrong,
    // missing reflections would mean the feather is too wide.
    const pv = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const a = out[p * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) pv[p * 3 + c] = Math.round(out[p * 4 + c] * a + 90 * (1 - a));
    }
    const dst = '/tmp/plate_preview.png';
    await sharp(pv, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dst);
    console.log(dst);
    return;
  }

  const info = await sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(OUT);
  console.log(`${OUT} (${W}x${H}, ${(info.size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

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
 *   node scripts/plate.js --preview             # matte over a flat colour, to eyeball
 *   node scripts/plate.js                       # writes app/public/plate.webp
 *   node scripts/plate.js --scene 2 [--preview] # the second scene
 */
const sharp = require('sharp');
const path = require('path');

const repo = (...p) => path.join(__dirname, '..', ...p);

/**
 * The scenes, and what each one was given to build a plate from.
 *
 * Scene 1 arrived as a pair — the artwork, and a copy with the sky flooded by
 * hand — which is the ideal input: the matte comes from the keyed copy and every
 * output pixel comes from the untouched artwork, so no magenta can reach the
 * result even where bilinear filtering samples across the matte's edge.
 *
 * Scene 2 arrived already keyed, with no un-keyed original. That is workable —
 * the flood only replaced sky, so every pixel the plate keeps is still the
 * artwork — but it removes the guarantee above, and `bleed` below is what pays
 * for it. Worth knowing when the next scene is prepared: **two files are better
 * than one**, and the second one costs nothing but a flood fill.
 */
const SCENES = {
  1: {
    art: repo('1786443741198.png'),
    keyed: repo('1786511966180.png'),
    // WebP, not PNG: 127 KB against 2.29 MB for the same 1408x768 RGBA, and
    // this has to load before the first frame can be composited.
    out: repo('app', 'public', 'plate.webp'),
  },
  2: {
    art: null, // keyed only — see bleed()
    keyed: repo('1786575481846.png'),
    out: repo('app', 'public', 'plate2.webp'),
  },
  // Scene 3 arrived keyed-only *and* already re-encoded as lossy WebP, which is
  // the worst of the three inputs: the encode spreads the flood's chroma into
  // the paint before this script ever sees it, so the rim repair below is doing
  // more work here than it does for scene 2. It still lands clean, because the
  // repair keys on magenta *cast* rather than on distance to one colour, and
  // the encode's bleed is exactly a cast. Its flood is a third magenta again,
  // (204, 0, 205), 43 from KEY and comfortably inside the tolerance.
  3: {
    art: null,
    keyed: repo('scene3-keyed.png'),
    out: repo('app', 'public', 'plate3.webp'),
    // ...and it needs a different contamination test, `bleed` — see CASTS.
    cast: 'bleed',
    castThreshold: 12,
  },
};

/** The flooded colour, taken as the modal pixel of scene 1's keyed image (7.2%
 * of the frame on its own; the next five modes are the same colour ±2 from PNG
 * re-encoding, together another 16%).
 *
 * Scene 2's flood is a slightly different magenta — its mode is (181, 2, 254),
 * 27 away — which the tolerance below swallows without needing a second
 * constant. Anything much further off would deserve its own entry rather than a
 * widened tolerance: the tolerance's job is antialiased edges, not a new key. */
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

/**
 * Repair every pixel the flood contaminated, in place.
 *
 * Only needed when the artwork *is* the keyed file (scene 2). Scene 1 is handed
 * a separate un-keyed original and takes all of its RGB from that, which makes
 * the whole problem below impossible; this earns the same property the hard way.
 *
 * There are two contaminated populations and the first attempt only fixed one
 * of them, which is worth recording because the preview looked wrong in exactly
 * the way that identifies it — a violet thread along every roof edge, pillar and
 * strand of hair:
 *
 *  - **Under the matte.** Flood magenta, alpha 0. Never drawn on its own, but
 *    the plate is a WebP scaled to the band and filtered bilinearly, so a sample
 *    landing near the edge mixes it into a visible pixel.
 *  - **The antialiased rim, just outside the matte.** In the artwork these
 *    pixels are already part paint and part sky, and in the keyed file the sky
 *    they are part of *is the flood* — so they are genuinely violet, they carry
 *    full or near-full alpha, and they are drawn as-is. This is the population
 *    that showed. `KEY_TOLERANCE` cannot take them: widening it far enough to
 *    swallow them eats real paint, which is why the matte and this repair are
 *    two separate decisions rather than one threshold.
 *
 * So the repair region is the matte *plus* the pixels within REPAIR_REACH of it
 * that are still close enough to the key to be contaminated — a colour test, not
 * just a geometric one, so that a genuinely violet piece of artwork away from
 * the edge is left alone. Their colour is then dilated in from clean neighbours.
 * The matte itself is not touched: alpha still comes from `isKey` alone, so the
 * silhouette is exactly what was keyed.
 */
/**
 * How far from the matte a mildly-cast pixel is still assumed to be flood.
 *
 * 10, which sounds generous and is not: it is anchored to the matte, and the
 * only thing it can reach that far in is the inside of the girl's ponytail,
 * where the sky comes through in wedges several pixels deep. Nothing else in
 * the frame is both within ten pixels of sky and cool enough to trip the cast
 * test — the artwork's coolest colour, her navy collar, sits at about -20.
 */
const REPAIR_REACH = 10;
/**
 * How much magenta a pixel has to be carrying to count as contaminated.
 *
 * **Not** distance to the key colour, which was the first attempt and left
 * visible violet behind. The flood is a bright magenta and the rim pixels are
 * mixtures of it with whatever they border — and most of what they border here
 * is a *dark* roof soffit, so a half-and-half mixture lands 150+ away from the
 * key and a threshold on that distance either misses it or, raised far enough
 * to catch it, starts eating paint. Distance to a single bright colour cannot
 * separate "dark thing mixed with magenta" from "dark thing".
 *
 * The cast can. Magenta is the one hue with both ends of the spectrum up and
 * the middle down, so `min(r, b) - g` is large for any mixture containing it and
 * negative for essentially all of this artwork — grey concrete, green hills,
 * blue sea, skin, brown leather, navy uniform. It also scales with the mixture
 * rather than with the brightness, so one threshold covers the rim from 10%
 * magenta upward whatever it is mixed into.
 *
 * 4, not 12. A cast of 8 over dark concrete is invisible in a histogram and
 * perfectly visible as a violet thread on a soffit, which is precisely where
 * this artwork puts its longest matte edges.
 */
const MAGENTA_CAST = 4;
/**
 * The two ways a pixel can be caught carrying the flood, and which input needs
 * which.
 *
 * `mix` is the one described above: `min(r, b) - g`, the signature of paint
 * *mixed* with a bright magenta, which is what an antialiased edge in a
 * losslessly-stored key is made of. It is right for scene 2 and it is what
 * MAGENTA_CAST is calibrated against.
 *
 * `bleed` is for scene 3, whose keyed file reached this repo as a lossy WebP.
 * A WebP encode does not mix colours, it *subsamples chroma* — so the flood's
 * two chroma components spread into the neighbouring paint independently, and
 * measured across the roof soffit the blue one spreads further than the red:
 * six rows in from the matte the soffit reads (61, 67, 88) against (56, 71, 80)
 * a few rows deeper, which is plainly violet on screen and yet scores -6 on
 * `mix`, because r never rose. Any test built on both ends of the spectrum
 * being up together misses it by construction.
 *
 * `r + b - 2g` catches it: it asks only that the middle of the spectrum is down
 * relative to the ends, which is true of a partial magenta bleed whichever
 * chroma arrived first. It is a looser question, so it does also fire on
 * genuinely violet-leaning paint — but a false positive here costs nothing.
 * The repair replaces a suspect pixel with the mean of its *clean neighbours*,
 * which for a run of blue sign or red neckerchief is more of the same blue or
 * red; only the enclosed interior, which is never drawn, is replaced by a flat
 * colour. The test's job is to be sure it has caught everything, not to be
 * sparing.
 */
const CASTS = {
  mix: (r, g, b) => Math.min(r, b) - g,
  bleed: (r, g, b) => r + b - 2 * g,
};
/**
 * A cast this strong is the flood wherever it is, so it is repaired without the
 * distance test. It catches what leaked *through* the girl's ponytail: gaps
 * between hair strands are open to the sky but too narrow and too blended with
 * dark hair for either KEY_TOLERANCE or fillEnclosed to claim them, and they
 * came out as bright magenta wedges in her hair.
 *
 * 20, not 40. Blended into dark hair the wedges only reach a cast in the
 * twenties, and against a grey soffit that is still plainly purple. Nothing in
 * this artwork carries a cast that strong for a legitimate reason — the coolest
 * thing in it is a navy collar, which sits at about -20.
 */
const STRONG_CAST = 20;
/**
 * The same idea for the `bleed` test, which needs its own number because it is
 * a much looser question: 20 on `r + b - 2g` is the girl's red neckerchief, not
 * the flood. Undiluted flood scores 409 there and a half-and-half mixture with
 * dark hair still scores about 210, while the warmest real paint in scene 3 —
 * that neckerchief — tops out near 120. 150 sits between them.
 */
const STRONG_BLEED = 150;
function repairFlood(data, isKey, W, H, C, opts = {}) {
  const cast = CASTS[opts.cast || 'mix'];
  const castThreshold = opts.castThreshold ?? MAGENTA_CAST;
  const passes = opts.passes ?? 4;
  const strong = opts.cast === 'bleed' ? STRONG_BLEED : STRONG_CAST;
  // The rim: near the matte, and still carrying the flood's colour.
  const damaged = new Uint8Array(isKey);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (isKey[p]) continue;
      const c = cast(data[p * C], data[p * C + 1], data[p * C + 2]);
      if (c <= castThreshold) continue;
      if (c > strong) { damaged[p] = 1; continue; }
      let near = false;
      for (let dy = -REPAIR_REACH; dy <= REPAIR_REACH && !near; dy++) {
        for (let dx = -REPAIR_REACH; dx <= REPAIR_REACH; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (isKey[yy * W + xx]) { near = true; break; }
        }
      }
      if (near) damaged[p] = 1;
    }
  }

  let rim = 0;
  for (let p = 0; p < W * H; p++) if (damaged[p] && !isKey[p]) rim++;

  // What the dilation is allowed to overwrite.
  //
  // Everything, when the damage is a *mixture* with the flood: a pixel that is
  // half magenta has lost its brightness as surely as its hue, and there is
  // nothing in it worth keeping.
  //
  // Only the colour, when the damage is a lossy encode's chroma bleed. A WebP
  // encode keeps luma per pixel and subsamples chroma, so in scene 3 every
  // contaminated pixel still carries its original brightness exactly — and in
  // this artwork brightness *is* the drawing. Dilating full RGB across a band
  // ten pixels deep around a matte that runs along her jaw, her nose and the
  // edge of her hair wiped those lines out: the first attempt at scene 3
  // returned a face with no outline, which is both wrong and specifically
  // forbidden (plan.md — line art is not to be touched). Replacing Cb/Cr and
  // keeping Y takes the violet off and leaves every stroke where the artist
  // put it.
  const keepLuma = opts.cast === 'bleed';
  const luma = keepLuma ? new Float32Array(W * H) : null;
  if (luma) {
    for (let p = 0; p < W * H; p++) {
      if (!damaged[p]) continue;
      luma[p] = 0.299 * data[p * C] + 0.587 * data[p * C + 1] + 0.114 * data[p * C + 2];
    }
  }

  // Dilate clean colour inward, one ring per pass.
  let frontier = damaged;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(frontier);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!frontier[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const q = yy * W + xx;
            if (frontier[q]) continue; // still contaminated, nothing to take
            r += data[q * C]; g += data[q * C + 1]; b += data[q * C + 2]; n++;
          }
        }
        if (!n) continue;
        data[p * C] = Math.round(r / n);
        data[p * C + 1] = Math.round(g / n);
        data[p * C + 2] = Math.round(b / n);
        next[p] = 0; // clean now, so the next pass can take from it
      }
    }
    frontier = next;
  }

  // Put the original brightness back over the borrowed colour, for the pixels
  // that only lost their chroma. Done as a scale on the whole triplet rather
  // than a proper YCbCr round trip: the ratio moves Y to where it was while
  // holding Cb/Cr's *direction*, which is all this needs, and it cannot
  // manufacture a hue the dilation did not hand it.
  if (luma) {
    for (let p = 0; p < W * H; p++) {
      if (!damaged[p] || isKey[p]) continue; // under the matte, nothing is drawn
      const y = 0.299 * data[p * C] + 0.587 * data[p * C + 1] + 0.114 * data[p * C + 2];
      if (y < 1) continue;
      const k = luma[p] / y;
      for (let c = 0; c < 3; c++) {
        data[p * C + c] = Math.max(0, Math.min(255, Math.round(data[p * C + c] * k)));
      }
    }
  }

  // Whatever the dilation could not reach — the deep interior of the sky, which
  // is most of this frame — is still pure flood, and that matters even though
  // its alpha is 0. The plate ships as lossy WebP, which subsamples chroma to
  // 2x2 blocks and codes them in 4x4 transforms, so a large saturated magenta
  // field pushes colour back across the matte edge into pixels that *are*
  // drawn: measured, the encode tripled the count of strongly-cast visible
  // pixels (938 -> 3100) on a plate whose stored RGB was already repaired at
  // the edge.
  //
  // Flooding the remainder with one neutral colour removes the source of it
  // entirely, and costs nothing: nothing is drawn there, the dilated rings
  // above are what any filtering actually reaches, and a flat field is cheaper
  // to encode than a magenta one. The colour is the painted mean, so it also
  // has no chroma to give away.
  let r = 0, g = 0, b = 0, n = 0;
  for (let p = 0; p < W * H; p++) {
    if (isKey[p]) continue;
    r += data[p * C]; g += data[p * C + 1]; b += data[p * C + 2]; n++;
  }
  const mean = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [128, 128, 128];
  let flooded = 0;
  for (let p = 0; p < W * H; p++) {
    if (!frontier[p]) continue; // reached by the dilation, already paint
    data[p * C] = mean[0]; data[p * C + 1] = mean[1]; data[p * C + 2] = mean[2];
    flooded++;
  }

  return { rim, flooded, mean };
}

async function main() {
  const args = process.argv.slice(2);
  const sceneArg = args.includes('--scene') ? args[args.indexOf('--scene') + 1] : '1';
  const scene = SCENES[sceneArg];
  if (!scene) {
    console.error(`unknown scene "${sceneArg}" — known: ${Object.keys(SCENES).join(', ')}`);
    process.exit(1);
  }

  const keyed = await raw(scene.keyed);
  // With no separate artwork the keyed file is both, and bleed() below covers
  // the difference.
  const ref = scene.art ? await raw(scene.art) : keyed;
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

  // Scene 1 draws its RGB from the untouched artwork, so no magenta can reach
  // the output however the texture is later filtered. Scene 2 has no such file
  // and has to earn the same property.
  const repair = scene.art
    ? null
    : repairFlood(ref.data, isKey, W, H, ref.C, {
        cast: scene.cast,
        castThreshold: scene.castThreshold,
      });

  const out = Buffer.alloc(W * H * 4);
  let sky = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * ref.C;
    // RGB always comes from the artwork, never from the flood.
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
    `reflections/islands absorbed: ${filled} px` +
    (repair
      ? `, rim repaired: ${repair.rim} px, interior flooded with rgb(${repair.mean}): ${repair.flooded} px`
      : ''),
  );

  if (args.includes('--preview')) {
    // Composite over a flat mid-grey so the matte and the recovered reflections
    // can both be judged: purple fringing would mean the un-mix is wrong,
    // missing reflections would mean the feather is too wide.
    const pv = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const a = out[p * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) pv[p * 3 + c] = Math.round(out[p * 4 + c] * a + 90 * (1 - a));
    }
    const dst = `/tmp/plate_preview_${sceneArg}.png`;
    await sharp(pv, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dst);
    console.log(dst);

    // The stored RGB on its own, alpha ignored, lossless. The composite above
    // answers "does the matte look right"; this answers "is the colour under
    // and around the matte clean", which is a different question and the one
    // that catches flood contamination — including the part of it that only
    // becomes visible after the lossy WebP encode spreads chroma across 2x2
    // blocks.
    const rgb = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = out[p * 4 + c];
    const rgbDst = `/tmp/plate_rgb_${sceneArg}.png`;
    await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(rgbDst);
    console.log(rgbDst);
    return;
  }

  const info = await sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(scene.out);
  console.log(`${scene.out} (${W}x${H}, ${(info.size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

#!/usr/bin/env node
// Node port of super2d/js/matting.js's computeChromaKeyAlpha — same algorithm,
// via sharp instead of browser Canvas ImageData.
const sharp = require('sharp');

async function chromaKeyExtract(inPath, outPath, keyRGB, tolerance, feather) {
  const img = sharp(inPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = Buffer.alloc(width * height * 4);

  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    const o = p * 4;
    const dr = data[i] - keyRGB[0];
    const dg = data[i + 1] - keyRGB[1];
    const db = data[i + 2] - keyRGB[2];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    let alpha;
    if (dist <= tolerance) alpha = 0;
    else if (dist >= tolerance + feather) alpha = 1;
    else alpha = (dist - tolerance) / feather;

    // Spill suppression: lossy JPEG blends key-color into edge pixels even where
    // alpha > 0 (a thin blue rim around every petal). Clamp the key channel (blue)
    // down to the neutral level of the other two channels wherever it pokes above
    // them — this removes the tint without touching pixels that were never
    // contaminated (where blue isn't already the odd one out).
    const neutral = Math.max(data[i], data[i + 1]);
    const b = Math.min(data[i + 2], neutral);
    out[o] = data[i];
    out[o + 1] = data[i + 1];
    out[o + 2] = b;
    out[o + 3] = Math.round(alpha * 255);
  }

  await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile(outPath);
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: node chromakey.js <in> <out.png>');
    process.exit(1);
  }
  await chromaKeyExtract(inPath, outPath, [0, 0, 255], 140, 60);
  console.log('wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
// Minimal CLI wrapper around the Gemini image generation API (generateContent,
// image-to-image). This project's own generated assets (art-source/trunk/,
// art-source/canopy-clusters/) were produced with a tool of this same name and
// interface (see art-source/*/README.md and art-source/STATUS.md), previously
// only available outside this repo. Re-created here so the pipeline documented
// there ("GEMINI_KEY=<key> node scripts/gemini_call.js --prompt ... --image ...
// --out ... --label ... --model gemini-3.1-flash-image --imageSize 1K
// --aspectRatio 1:1") works from a checkout of this repo alone.
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { image: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (key === 'image') {
      args.image.push(value);
    } else {
      args[key] = value;
    }
    i++;
  }
  return args;
}

function readPrompt(promptArg) {
  if (fs.existsSync(promptArg) && fs.statSync(promptArg).isFile()) {
    return fs.readFileSync(promptArg, 'utf8');
  }
  return promptArg;
}

function mimeTypeForFile(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      throw new Error(`unsupported reference image extension: ${filePath}`);
  }
}

function extForMimeType(mimeType) {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_KEY;

  if (!apiKey) {
    console.error('GEMINI_KEY environment variable is required (never pass the key as a CLI flag).');
    process.exit(1);
  }
  for (const required of ['prompt', 'out', 'label']) {
    if (!args[required]) {
      console.error(`--${required} is required`);
      process.exit(1);
    }
  }

  const model = args.model || 'gemini-3.1-flash-image';
  const imageSize = args.imageSize || '1K';
  const aspectRatio = args.aspectRatio || '1:1';
  const promptText = readPrompt(args.prompt);

  const parts = [{ text: promptText }];
  for (const imagePath of args.image) {
    parts.push({
      inlineData: {
        mimeType: mimeTypeForFile(imagePath),
        data: fs.readFileSync(imagePath).toString('base64'),
      },
    });
  }

  const requestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio, imageSize },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(requestBody),
  });
  const responseJson = await response.json();

  if (!response.ok) {
    console.error(`Gemini API error ${response.status}:`, JSON.stringify(responseJson, null, 2));
    process.exit(1);
  }

  const rawDir = path.join(args.out, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  // Same "<ISO-timestamp-with-dashes>_<label>_..." naming already used by every
  // existing raw/ file in this repo (art-source/trunk/raw,
  // art-source/canopy-clusters/raw) — keep new generations consistent with them.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const jsonPath = path.join(rawDir, `${timestamp}_${args.label}_response_raw.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(responseJson, null, 2));
  console.log('wrote', jsonPath);

  const candidateParts = responseJson.candidates?.[0]?.content?.parts ?? [];
  let imageIndex = 0;
  for (const part of candidateParts) {
    if (!part.inlineData) continue;
    const ext = extForMimeType(part.inlineData.mimeType);
    const imagePath = path.join(rawDir, `${timestamp}_${args.label}_raw_${imageIndex}.${ext}`);
    fs.writeFileSync(imagePath, Buffer.from(part.inlineData.data, 'base64'));
    console.log('wrote', imagePath);
    imageIndex++;
  }

  if (imageIndex === 0) {
    console.error('No image data in response — check the raw JSON for a text refusal/error.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

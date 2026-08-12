#!/usr/bin/env node
/**
 * Several captures from one page load.
 *
 * Use this instead of running scripts/capture.js in a loop. Under SwiftShader
 * almost all of a capture's wall-clock cost is fixed overhead — starting vite,
 * starting Chromium, and compiling this scene's shaders, which are large — and
 * none of it depends on how many frames you want. capture.js pays that once per
 * image; this pays it once per sweep, then retargets the scene in place through
 * the hook main.ts exposes and reads the canvas again.
 *
 * Everything it can set is something the URL can already set, so this is a
 * speed-up rather than a new capability.
 *
 * Usage:
 *   node scripts/shoot.js out=/tmp/a.png,t=5580,cloud=0.62 out=/tmp/b.png,cloud=1
 *
 * Each argument is one frame: a comma-separated list of key=value pairs.
 * Recognised keys: out (required), t, cloud, rain, hour.
 * Anything not given is carried over from the previous frame, so a sweep only
 * has to state what changes.
 *
 * CAPTURE_W / CAPTURE_H override the viewport (default: the 1408x768
 * measurement frame; see scripts/README.md). Halving both is the cheapest way
 * to make a design check fast — cost is per pixel, so it is roughly four times
 * quicker — but never measure from a frame that size.
 *
 * WARMUP is how many frames are rendered before each read (default 3). Almost
 * all the wall-clock cost of a sweep is this number times the frame count:
 * under SwiftShader one 1408x768 frame through the full post chain is about
 * twenty seconds. Three is enough because the cloud shadow map is rebuilt from
 * scratch every frame, so it is correct on the first frame after a change; the
 * eight capture.js waits are for a cold page, where materials and textures are
 * still arriving.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const WIDTH = Number(process.env.CAPTURE_W || 1408);
const HEIGHT = Number(process.env.CAPTURE_H || 768);
const PORT = 5195;

const specs = process.argv.slice(2).map((arg) => {
  const spec = {};
  for (const pair of arg.split(',')) {
    const [key, value] = pair.split('=');
    spec[key] = key === 'out' ? value : Number(value);
  }
  if (!spec.out) throw new Error(`no out= in "${arg}"`);
  return spec;
});
if (!specs.length) {
  console.error('usage: node scripts/shoot.js out=/tmp/a.png,t=5580,cloud=0.62 [out=...]');
  process.exit(1);
}

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 60s')), 60000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Local:')) {
        clearTimeout(timer);
        setTimeout(resolve, 500);
      }
    });
    proc.stderr.on('data', (c) => process.stderr.write(c));
  });
}

(async () => {
  const appDir = path.join(__dirname, '..', 'app');
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  try {
    await waitForServer(vite);
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
      ],
    });
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // fit=frame is what every crop box and statistic assumes; t on the URL so
    // the very first frame is already frozen rather than starting from a random
    // clock (main.ts).
    const first = specs[0];
    await page.goto(
      `http://localhost:${PORT}/?fit=frame&t=${first.t ?? 0}`,
      { waitUntil: 'networkidle' },
    );

    for (const spec of specs) {
      const dataUrl = await page.evaluate(
        async ({ params, warmup }) => {
          window.__sakura.set(params);
          // Several frames before reading: the cloud shadow map is filled
          // during the render loop, so an immediate read is shaded against a
          // depth map belonging to the previous settings. Same reason
          // capture.js waits, and the reason the read happens *inside* the
          // frame callback is that preserveDrawingBuffer is false.
          return await new Promise((resolve) => {
            let n = 0;
            const tick = () => {
              if (++n < warmup) return requestAnimationFrame(tick);
              resolve(document.querySelector('canvas').toDataURL('image/png'));
            };
            requestAnimationFrame(tick);
          });
        },
        {
          params: {
            t: spec.t,
            cloud: spec.cloud,
            rain: spec.rain,
            hour: spec.hour,
          },
          warmup: Number(process.env.WARMUP || 3),
        },
        { timeout: 300000 },
      );
      fs.writeFileSync(spec.out, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`captured ${spec.out}`);
    }

    await browser.close();
    if (errors.length) {
      console.error('page errors:\n' + errors.join('\n'));
      process.exitCode = 1;
    }
  } finally {
    try {
      process.kill(-vite.pid, 'SIGKILL');
    } catch {
      vite.kill('SIGKILL');
    }
  }
})();

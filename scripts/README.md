# scripts/capture.js + scripts/measure.js

The render/measure loop the sky work is tuned with. plan.md §2 rules out
adjusting colour and form by eye, so every claim about the render has to come
out of a statistic computed the same way on the render and on the reference
image. Both sessions so far have rebuilt this ad hoc and lost it; it lives here
now.

```sh
# deterministic 1408x768 capture (the scene freezes at ?t=<seconds>)
node scripts/capture.js /tmp/shot.png 0

# override the cloud key light without editing source, for sweeps
node scripts/capture.js /tmp/shot.png 0 "light=-0.78,0.45,-0.44"

# compare crops — reference first, render second
node scripts/measure.js ref_tower.png render_tower.png
```

Notes:

- Crop both images to the hero tower before measuring. `measure.js` works on
  the largest connected cloud mass, and in a full frame that mass merges with
  the low bank, which dilutes every statistic.
- The reference is an illustration with a girl and window frames in it, so only
  the area inside the glass is sky — crop from there.
- Under SwiftShader one capture takes several minutes. `capture.js` reads the
  canvas from inside a frame callback rather than using `page.screenshot()`,
  which times out at that speed.
- Reported: `lateral`/`gradX`/`gradY` (does a key light read across the mass at
  all), `sd` (tonal spread), `softFrac`/`medEdge` (fringe), `rimFrac` (rim
  light), `bumpR`/`bumpDepth` (silhouette scalloping).

# scripts/gemini_call.js

CLI wrapper around the Gemini image generation API, used for every generated
asset under `art-source/` (see `art-source/trunk/README.md` and
`art-source/canopy-clusters/README.md` for the assets it already produced).

## Usage

```sh
GEMINI_KEY=<your key> node scripts/gemini_call.js \
  --prompt path/to/prompt.txt \
  --image path/to/reference_crop.png \
  --out art-source/<asset-dir> \
  --label <name> \
  --model gemini-3.1-flash-image \
  --imageSize 1K \
  --aspectRatio 1:1
```

- `--prompt` accepts either a path to a text file or a literal prompt string.
- `--image` may be repeated for multiple reference images; omit it entirely for
  a text-only generation.
- Output: the full raw API response as JSON, and each generated image, both
  under `<out>/raw/`, timestamped and labeled — never overwritten, never
  pre-processed (matches the existing `art-source/*/raw/` convention).

Never commit `GEMINI_KEY`, or a prompt/config file containing it — pass it as
an environment variable on the command line only.

## Reproducing existing assets

The existing `art-source/trunk/` and `art-source/canopy-clusters/` assets each
document their own prompt file and reference crop; rerun the command above
with those to regenerate them (see agent-workflow-policy.md §1.5 and
art-source/STATUS.md for the full pipeline: crop reference → generate on a
pure-blue background → `art-source/canopy-clusters/chromakey.js` to matte →
resize into `app/public/textures/`).

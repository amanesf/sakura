# The measure loop

plan.md §2 rules out adjusting colour and form by eye, so every claim about the
render has to come out of a statistic computed the same way on the render and
on the reference image (`1786443741198.png` — the older `1786418841252.png` was
deleted on main, and several shader constants were still fitted to *its*
numbers long after it went away; if a comment quotes a statistic, check which
image it came from). Sessions kept rebuilding this ad hoc and losing it; it
lives here now.

```sh
# deterministic 1408x768 capture (the scene freezes at ?t=<seconds>)
# implies ?fit=frame — the whole viewport is the picture, which is the frame
# every crop box and statistic below assumes
node scripts/capture.js /tmp/shot.png 0

# the real app layout instead (portrait page: title, picture band, console).
# the canvas is then 115% of the viewport width at the plate's aspect, so this
# is what to use for checking the layout, never for measuring the sky
CAPTURE_W=448 CAPTURE_H=998 node scripts/capture.js /tmp/phone.png 0 fit=page

# override the cloud key light without editing source, for sweeps
node scripts/capture.js /tmp/shot.png 0 "light=-0.78,0.45,-0.44"

# crop to a region — reference and render need different boxes for the tower
node scripts/crop.js 1786443741198.png ref_tower.png   860 90 340 250
node scripts/crop.js /tmp/shot.png     render_tower.png 760  0 480 340

# silhouette + shading statistics — reference first, render second
node scripts/measure.js ref_tower.png render_tower.png

# where the cloud's tone actually sits (measure.js gives spread, not position)
node scripts/tonedist.js ref_tower.png render_tower.png

# sky and cloud colour per elevation band, over the window area
node scripts/skyprofile.js 1786443741198.png 700 1290 40 560 --bands 13
node scripts/skyprofile.js /tmp/shot.png     700 1290 40 560 --bands 13
```

Notes:

- Crop both images to the hero tower before running `measure.js` or
  `tonedist.js`. They work on the largest connected cloud mass, and in a full
  frame that mass merges with the low bank, which dilutes every statistic.
- The reference is an illustration with a girl and window frames in it, so only
  the area inside the glass is sky — crop from there. `skyprofile.js` also drops
  pixels below luminance 90, which removes the frame, hills and town.
- Under SwiftShader one capture takes several minutes. Run it in the background
  and wait with `while pgrep -f "capture.js /tmp" >/dev/null; do sleep 25; done`.
  **Do not edit `app/src` while a capture is running** — it goes through the
  vite dev server, so an edit mid-capture gets hot-reloaded into the result.
  `capture.js` reads the canvas from inside a frame callback rather than using
  `page.screenshot()`, which times out at that speed.
- `measure.js` reports: `lateral`/`gradX`/`gradY` (does a key light read across
  the mass at all), `sd` (tonal spread), `softFrac`/`medEdge` (fringe),
  `rimFrac` (rim light), `bumpR`/`bumpDepth` (silhouette scalloping). Note that
  `bumpR` is in absolute pixels, so it is only comparable between two masses of
  similar screen size — check `area` before reading it.

# scripts/skymodel.js + scripts/hdr.js

`skymodel.js` is a CPU port of `scene/sky.ts`'s fragment shader plus the
renderer's ACES + sRGB output. The scattering integral is closed physics, so
its constants can be *solved* against the reference's measured per-elevation
profile rather than nudged and re-rendered — which matters when one capture
costs four minutes.

```sh
node scripts/skymodel.js --profile [--set SUN_INTENSITY=7 ...]
node scripts/skymodel.js --solve            # coordinate descent vs the reference
node scripts/skymodel.js --cirrus           # lift at full cover, per strength
```

It took the sky's fit from RMSE 22.4 to 3.1. Two cautions: the post chain
(bloom / grade / Kuwahara / macro-contrast) is not modelled, so check a solved
parameter set against a real capture before trusting it; and the solver will
happily pin a parameter against a bound for a fraction of a point of RMSE —
`MIE_COEFF` did exactly that, and was set back to a physically sensible clear-sky
value at a cost of 0.2.

`hdr.js` converts between display sRGB and the pre-tonemap linear HDR that every
colour constant in `sky.ts` and `cloudShader.ts` is authored in. Targets taken
off the reference are in sRGB, and converting them by hand is where several of
those constants went wrong.

```sh
node scripts/hdr.js --to-hdr 162,203,227
node scripts/hdr.js --to-srgb 0.1733,0.4668,0.8792
```

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

# scripts/darkspots.js

Finds sky showing through the *inside* of a cloud mass — the "異常に黒い雲"
complaint. It uses `app/public/plate.webp`'s alpha as the mask for "this pixel
is rendered sky", so the window frames, the girl and the town cannot be
mistaken for dark cloud.

It reports two things, and only the second one has ever fired on this scene:

- **darker than the local clear sky.** Nothing here should be — the sky is the
  darkest surface in the frame and cloud only adds light in front of it. This
  also catches the ramp-bottom-blue artifact cloudShader.ts documents, which a
  cloud/sky split by saturation would file under "sky".
- **more than 55 below the local cloud level.** The relative test, and the one
  that matters: a lobe at luminance 165 among neighbours at 250 reads as a hole
  even though 165 is a legal shadow value.

The clear-sky reference is a coarse grid with holes diffused in, not a per-row
median — the sky varies with azimuth as well as elevation, and a per-row
reference flagged a whole corner of ordinary blue sky (3% of the frame).

# scripts/pageshot.js

A screenshot of the whole *page* — title, ambience gradient, console — rather
than just the canvas.

```sh
node scripts/pageshot.js /tmp/page.png 5580            # portrait phone, 448x998
CAPTURE_W=448 CAPTURE_H=998 node scripts/pageshot.js /tmp/p.png 5580 preset=clear
```

`capture.js` reads the canvas out with `toDataURL` and cannot see any of the
page design; this takes a real screenshot instead. It is slower and it is not
what any statistic should be computed from — use `capture.js` for numbers and
this for looking.

**If you write your own playwright check that reads the canvas, do the
`toDataURL` inside the same requestAnimationFrame callback that waits for the
frame.** `preserveDrawingBuffer` is false, so a read issued from a separate
task gets a cleared buffer and returns the same blank image every time. A test
written the other way reported "the sky preset button does nothing" for a
button that was working perfectly.

# scripts/shoot.js — several captures from one page load

**Use this instead of running `capture.js` in a loop.**

```sh
node scripts/shoot.js \
  out=/tmp/noon.png,t=5580,cloud=0.62,rain=0,hour=12 \
  out=/tmp/overcast.png,cloud=1 \
  out=/tmp/rain.png,rain=1
```

Each argument is one frame; unstated keys carry over from the previous frame,
so a sweep only states what changes. It implies `?fit=frame`, and it retargets
the scene through `window.__sakura.set()` (main.ts) rather than reloading, so
the shader compile and browser start are paid once for the whole sweep instead
of once per image. Measured: four frames in 11.6 min against roughly 16 min as
four separate `capture.js` runs.

The remaining cost is the rendering itself — about 20s per 1408x768 frame
through the post chain under SwiftShader — so the two levers that matter are:

- `WARMUP` (default 3): frames rendered before each read. This multiplies the
  whole run.
- `CAPTURE_W`/`CAPTURE_H`: cost is per pixel, so halving both is about four
  times quicker. Fine for looking at a design, never for measuring.

`capture.js` is still the right tool for a single frame or for anything that
needs the cold-start path.

# scripts/glslcheck.js — do the shaders actually compile?

```sh
node scripts/glslcheck.js                    # everything under app/src
node scripts/glslcheck.js effects/rainShader.ts
```

Shaders live in template literals, so **`tsc` and `vite build` both pass on a
fragment shader that cannot compile at all**, and a post pass whose program
fails to link does not fail quietly — it fills the frame with garbage. That is
how "雨にすると真っ白になる" happened: a rewrite split the rain's three sheets
into separate mixes and left behind one reference to a variable that no longer
existed, so the rain pass never compiled; because `core/postFx.ts` only enables
that pass above rain 0, the frame was perfect until the slider left zero.

Ten seconds, against twenty minutes for the capture that would otherwise be the
first thing to notice. Run it after touching any shader, and before pushing.

Two kinds of entry are not a real failure:

- Shaders assembled with `${...}` interpolation are skipped — they are not
  valid GLSL as written. The standalone post passes, which is where this bug
  class bites, have none.
- Anything three.js injects (`projectionMatrix`, `uv`, `instanceMatrix`, …) is
  declared by the script's prelude. If a shader fails on an undeclared built-in
  the prelude is missing one — add it there rather than to the shader.

# scripts/duskref.js — measuring an evening or rain reference

```sh
node scripts/duskref.js Screenshot_20260813-045658.png 16 225 848 1400
```

What `skyprofile.js` does for the midday reference, for the images that describe
the hours the midday fit says nothing about. Pass the crop: a phone screenshot
is mostly browser chrome, and chrome is what a naive histogram will describe.

It reports the sky's colour in twelve bands top to bottom, and the cloud colours
at luminance percentiles — the same *indexed by population* shape that
`scene/cloudRamp.ts` is built from, so the two can be compared directly.

Sky and cloud are separated without a mask: at dusk the sky is the darker and
more saturated of the two and the clouds are the brighter, and that ordering
holds down the whole frame even as both change colour completely.

Convert anything you take from it with `scripts/hdr.js --to-hdr` before putting
it in a shader — every colour constant in `sky.ts` and `cloudShader.ts` lives in
pre-tonemap linear HDR, and sRGB numbers dropped in raw are a recurring bug in
this project.

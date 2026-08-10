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

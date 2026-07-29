# Creative Expansion

A web utility that takes finished image and video ad creative and expands it into every format
a media plan needs — without the output looking resized.

Resizing an ad is not resizing a photograph. An ad is a composite of a subject, a logo, a
headline, a legal line and a CTA, each with its own rules about how small it may get, how close
to an edge it may sit, and whether it may be cropped at all. This tool treats those rules as
hard constraints: **an output that would be unreadable is flagged and blocked, never shipped.**

## Status

Phase 1 works end to end for still images: upload a master, mark its elements (by hand, or let
auto-detect propose them), fan it out across up to 74 image placements, and export a ZIP with a
manifest. Video needs `ffmpeg` and is Phase 3.

```bash
npm install
npm run sample          # synthesise three test masters into samples/
npm start               # http://localhost:3000
```

Or deploy it — the repo has a Render blueprint, and a hosted instance can load the bundled
sample masters with one click so you don't need files to hand. See
[`docs/DEPLOY.md`](docs/DEPLOY.md); copy `.env.example` to `.env` and use `npm run dev` for
local config.

Or headless:

```bash
node scripts/run-batch.mjs samples/master-flat-1x1.png \
  --logo samples/logo-reference.png \
  --preset meta-fanout --preset gdn-iab-core --zip
```

`npm test` runs 52 tests, including the invariants that an identity transform can never block on
type size, that aspect ratio is never distorted, and that a blocked output cannot reach an
archive.

## What it does

1. **Analyses** the master — per-edge background statistics, ground classification, palette,
   saliency and a source quality gate. All measurement, no interpretation.
2. **You mark the elements.** Drag on the master to mark a headline, subhead, body, CTA, price,
   legal line, logo or product; drag to move, corners to resize. **Auto-detect is a button, not
   the default** — the detector is heuristic, so it proposes regions for you to correct rather
   than deciding what the ad is made of, and it never overwrites anything you marked by hand.
   Either way the server derives cap height, contrast and plate membership from the pixels, so a
   hand-drawn region is measured identically to a detected one.
3. **Solves** geometry per placement, preferring the track that damages the composition least:
   - **Protected crop** — the master's own composition, untouched. Never cuts through type, a
     logo or a product.
   - **Element re-layout** — when no crop fits, each detected element is lifted as its own sprite
     and re-placed for the new canvas at a scale that clears the legibility floors. This is what
     stops most aspect changes becoming a shrunken master on a colour field. Requires a flat or
     near-flat ground (a lifted element leaves a hole that has to be filled honestly) and
     elements that do not overlap (rectangular sprites cannot separate overlapping ones).
   - **Fit with background extension** — last resort. Preserves everything, at a scale that often
     kills the type; usually ends up blocked, correctly.
4. **Measures** legibility against the floors for that placement's viewing context, and contrast
   against the pixels actually rendered.
5. **Blocks** anything that fails, with a plain-language reason and a suggested fix.
6. **Exports** the rest with a manifest recording exactly how each asset was made.

The distinction that makes it usable: **blocked means the output is defective as produced**;
a defect faithfully inherited from the master — contrast, or type that is already below the
floor at 100% scale — warns instead and is reported once against the source. Otherwise one
brand-colour decision blocks an entire fan-out.

## Layout

| Path | What it is |
| --- | --- |
| [`docs/SPEC.md`](docs/SPEC.md) | The product specification — engine design, legibility standards, features, phasing |
| [`docs/FORMAT-CATALOG.md`](docs/FORMAT-CATALOG.md) | Every supported placement. **Generated — do not edit.** |
| [`data/formats.json`](data/formats.json) | Format registry. Single source of truth. |
| [`data/legibility.json`](data/legibility.json) | The numeric floors from SPEC §7, machine-readable |
| [`data/presets.json`](data/presets.json) | Named placement bundles |
| `src/analysis/` | Saliency, background classification, palette, opt-in text/logo detection, pixel measurement of drawn regions |
| `src/solver/` | Crop search, background extension, legibility enforcement |
| `src/render/` | Resampling, encoding, byte-ceiling targeting, contrast sampling |
| `src/validate/` | Preflight rules |
| `src/pipeline.js` | Orchestration: source + recipe → outputs |
| `src/export.js` | ZIP + manifest. The chokepoint that excludes blocked outputs. |
| `src/server.js` | HTTP layer |
| `web/` | Review UI |

Currently **100 placements across 16 platforms** (74 accept still images): Meta, Google Display
(all 27 IAB sizes), Google responsive asset sets, YouTube, TikTok, Snapchat, Pinterest,
LinkedIn, X, Reddit, Amazon, CTV/OTT, digital audio, Microsoft, DOOH and email.

## Input formats

JPEG, PNG, WebP, TIFF, GIF, AVIF and SVG all work, in any aspect ratio, with or without an
alpha channel, and EXIF orientation is honoured. There is no format restriction beyond the
`MAX_UPLOAD_MB` file-size limit, which returns a clear 413 when exceeded.

## Working with the registry

Edit `data/formats.json`, then regenerate the catalog:

```bash
node scripts/gen-catalog.mjs           # rewrite docs/FORMAT-CATALOG.md
node scripts/gen-catalog.mjs --check   # CI: fail if the markdown is stale
```

Every placement carries `verifiedOn` and a `docs` link. Platform specs change without notice,
so entries are treated as stale after 90 days.

## Known limits of this first stab

These are honest gaps, not oversights — see SPEC §17 for the open questions behind them.

- **No face detection.** Photographic sources carry a warning telling you to check crops
  manually. Saliency stands in, which is not the same thing.
- **No OCR, so type is moved but never re-set.** Re-layout lifts an element's real pixels and
  re-places them, which needs no text recognition — but it cannot re-flow a line to a new
  measure. A wide legal line stays wide, and that is what blocks most small banners. Reading the
  words is what would fix it, and it is the single biggest quality lever still on the table.
- **Text detection is heuristic**, which is why it is opt-in rather than the default: it misses
  outline and script faces and finds type in busy photography. Marking regions by hand is the
  primary path and is fully supported (draw, move, resize, retype, remove). Low-confidence
  detections warn rather than block, and never constrain the layout.
- **Logo protection needs a reference image.** Without one there is no reliable way to tell a
  brand mark from any other graphic, so the output says `logo_not_verified` rather than
  implying a guarantee it cannot make.
- **Transparency is flattened, not preserved,** on any placement that requires JPEG — which is
  most of them. It flattens onto white by default (`policy.flattenColour`) and says so in the
  findings. If your master's design assumes a different ground, set that colour.
- **No persistence.** Sources and batches live in process memory; SPEC §13 specifies Postgres
  and object storage.
- **The legibility floors are defensible defaults, not measured findings.** They are the spine
  of the whole system and deserve validating against real comprehension testing.

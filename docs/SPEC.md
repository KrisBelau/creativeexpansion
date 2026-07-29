# Creative Expansion — Product Specification

**Status:** Draft for review · **Version:** 0.1 · **Date:** 2026-07-29

> **Implementation note.** Phase 1 is built and running for still images — see the README for
> what works and what does not. Where the implementation had to choose, two rules emerged that
> are worth promoting into this spec: (a) *blocked* means an output is defective as produced,
> while a defect inherited from the master warns and is reported once against the source
> (§11 now reflects this); and (b) whole-canvas extension strategies must be judged against the
> largest pad, never per-edge (§6.4). Face detection, OCR and therefore the whole de-flattening
> track (§6.3) remain unbuilt.

A web utility that takes finished image and video ad creative and expands it into every
format a media plan needs — without the output looking resized.

---

## 1. Problem

Resizing an ad is not resizing a photograph. A photograph has one subject and no hard
constraints; an ad is a composite of a subject, a logo, a headline, a legal line, and a CTA,
each of which has its own rules about how small it may get, how close to an edge it may sit,
and whether it may be cropped at all.

Every existing option fails on that distinction:

| Approach | Failure mode |
| --- | --- |
| Centre-crop / "smart crop" in a DAM | Decapitates subjects, slices headlines mid-word, crops the logo |
| Non-uniform scale to fit | Stretched faces and type — instantly reads as cheap |
| Letterbox everything | Grey bars, dead space, tiny content, poor performance |
| Naive downscale | Type falls below legibility; 11pt legal at 1080 becomes 3px mush at 320×50 |
| Manual rebuild in Photoshop/AE | Correct, but 40 formats × 6 concepts × 4 markets is a week of designer time per flight |
| Generative "make it 9:16" tools | Hallucinate new content into brand-owned frames; unusable for regulated categories |

The result across the industry is a long tail of technically-valid, visually-broken ads:
they pass the platform uploader and fail the eye.

**The thesis of this product:** the pipeline should refuse to produce an unreadable ad.
A flagged output that a human fixes in 30 seconds is worth more than a silently bad one that
ships. Everything below follows from that.

---

## 2. Goals and non-goals

### Goals

1. **Legibility is a hard constraint, not a best effort.** Every piece of type in every output
   meets a defined minimum rendered size and contrast ratio, or the output is flagged and
   blocked from export.
2. **Nothing important gets cropped or covered.** Text, logos, faces and designated product
   regions are protected geometry. Safe zones for platform UI chrome are enforced per placement.
3. **Outputs look designed, not derived.** Consistent optical margins, snapped alignment,
   proper type hierarchy, no stretching, no visible seams in extended backgrounds.
4. **One source → whole plan, in minutes.** Batch a set of masters against a preset and get a
   reviewable grid of every format with per-output pass/warn/fail state.
5. **Human-in-the-loop by design.** Reviewers nudge and override; overrides survive re-runs.
6. **Reproducible.** Same source + same recipe = byte-identical output. Every export carries a
   manifest recording exactly how it was made.

### Non-goals (v1)

- Not a design tool for creating ads from scratch.
- Not a copywriter — it re-lays out existing copy, it does not rewrite it (headline
  *shortening* is a suggestion surfaced to a human, never applied silently).
- Not an animation tool. It reframes, trims and re-encodes video; it does not author motion.
- Not a media buyer. Direct-to-platform publishing is Phase 4, and it uploads assets only.
- Not a generative image tool by default. Outpainting exists but is opt-in, per-project, and
  never applied inside a protected region. Off entirely for regulated verticals.

---

## 3. Users

| Persona | Need | Success looks like |
| --- | --- | --- |
| **Agency designer** (primary) | Stop hand-building 40 sizes | Reviews and approves rather than builds; keeps control of the exceptions |
| **Creative lead** | Brand consistency at volume | Sees every output in one grid, catches drift before the client does |
| **Media/ad ops** | Assets that pass the uploader first time | Zero rejected uploads; correct naming; a manifest that maps asset → placement |
| **In-house brand team** | Self-serve resizing without a designer | Presets encode the brand rules; the tool won't let them ship something off-brand |

---

## 4. Concepts

| Term | Definition |
| --- | --- |
| **Source** | An uploaded master: flat image, layered file, or video. |
| **Analysis** | The machine-read understanding of a source: regions, text, logos, saliency, shots. |
| **Region** | A typed rectangle or mask in a source — `subject`, `face`, `text`, `logo`, `product`, `cta`, `legal`, `background`. Carries a protection level. |
| **Placement** | One entry in the format registry (`data/formats.json`) — canvas, safe zone, file ceilings. |
| **Recipe** | The declarative instruction set for producing outputs: which placements, which strategy, brand kit, overrides. Versioned and diffable. |
| **Render** | One (source × placement × recipe) execution producing one Output. |
| **Output** | A produced asset plus its findings and its provenance. |
| **Finding** | A pass/warn/fail assertion about an output, e.g. `legal_below_min_size`, `logo_in_safe_zone`. |

---

## 5. Inputs

### 5.1 Accepted sources

**Images:** JPEG, PNG, WebP, AVIF, TIFF, GIF (incl. animated), SVG, PDF (single page).
**Layered:** PSD, PSB, AI, Figma (via API), Sketch, Canva export, InDesign IDML.
**Video:** MP4/H.264, MP4/H.265, MOV (incl. ProRes 422/4444), WebM/VP9, AV1, MXF, animated GIF.
**With alpha:** PNG, WebP, ProRes 4444, QuickTime with alpha, WebM/VP9 alpha.
**Sidecars:** SRT/VTT captions, ICC profiles, brand-kit fonts (OTF/TTF/WOFF2), audio stems (WAV/AIFF).

Hard limits: 500 MB per image, 10 GB per video, 20 min duration, 8K resolution.

### 5.2 Source quality gate

Run before anything else, because a bad source guarantees a bad output. Each check is a
finding, not a silent adjustment:

- **Resolution headroom.** Compares the source's shortest side against the largest requested
  canvas. Flags any placement requiring >100% upscale; blocks >200% unless ML upscale is enabled.
- **Compression damage.** Blockiness and ringing estimate; warns when the source is a re-save
  of a re-save (common when creative arrives pasted out of a deck).
- **Colour profile.** Detects the embedded profile; converts to sRGB for web placements and
  Rec.709 for CTV. Warns on untagged CMYK (the classic washed-out-ad cause).
- **Interlacing, variable frame rate, rotation metadata,** non-square pixel aspect ratio.
- **Audio presence and peak/loudness** measurement for video.
- **Text sharpness.** If existing baked-in type is already soft in the source, downstream
  outputs cannot be rescued; flag early.

---

## 6. The resize engine

Three tracks, chosen per source. The engine always prefers the highest track available,
because quality is bounded by how much structure it can recover.

```
                ┌─────────────────────────────────────────────┐
   Source ──▶   │  Analysis: regions · text · logos · saliency │
                └──────────────────┬──────────────────────────┘
                                   ▼
          ┌────────────────────────────────────────────────┐
          │ Track A — Layered        (best)                 │
          │ Track B — De-flattened   (most sources)         │
          │ Track C — Protected crop (safe fallback)        │
          └────────────────────────┬───────────────────────┘
                                   ▼
              Layout solver → Render → Validate → Review
```

### 6.1 Analysis

Runs once per source, cached and versioned by model revision so results are reproducible.

| Stage | Output | Purpose |
| --- | --- | --- |
| **Saliency** | Per-pixel importance map | Where the eye goes; drives crop scoring |
| **Face & person detection** | Boxes + landmarks | Faces are never cut; eye-line drives vertical anchoring |
| **Text detection + OCR** | Word and line boxes, confidence, colour, estimated font size, script direction | Protection, re-typesetting, legibility measurement |
| **Text role classification** | `headline` / `subhead` / `body` / `legal` / `cta` / `price` | Different roles get different minimum sizes and different drop priority |
| **Logo detection** | Boxes, matched against the brand kit's reference marks | Logos are never cropped, scaled below their minimum, or placed inside a safe zone |
| **Product / hero segmentation** | Mask | Keeps the actual thing being sold intact and unobscured |
| **Background classification** | Flat / gradient / texture / photographic / complex | Decides which extension strategy is admissible |
| **Edge & seam analysis** | Continuity map at each border | Predicts whether mirror/clone extension will be visible |
| **Palette extraction** | Dominant + accent colours with coverage | Matte colours, scrim colours, contrast checks |
| **Video: shot detection** | Cut list with confidence | Reframing is per-shot; a crop path must never pan across a cut |
| **Video: subject tracking** | Per-shot trajectories | Drives the keyframed crop path |
| **Video: motion & text-onscreen timeline** | Per-frame flags | Finds where burned-in type appears and for how long |
| **Video: audio analysis** | Loudness, speech/music segments, beat grid | Loudness normalisation and beat-aware trimming |

Every detection is editable. The analysis view lets a human add, delete, retype or resize any
region before rendering — this is the highest-leverage correction point in the product, and it
must be fast (keyboard-driven, no modal dialogs).

### 6.2 Track A — Layered re-layout

When the source has real layers (PSD/AI/Figma/IDML), the tool does what a designer does:
it re-lays out the composition for the new canvas rather than transforming pixels.

- Layers are imported as typed elements; text stays live text, vectors stay vector.
- Elements are bound to a **constraint model**: anchor edge, margin, min/max size, aspect
  behaviour (`fixed` / `scale` / `fill`), stacking priority, and `droppable` flag.
- The layout solver (§6.5) places elements on the new canvas against those constraints.
- Type is re-set at the correct size for the target — never scaled, so hinting and stem
  weights stay correct at small sizes.
- Vector logos render crisp at any size, including 125×125.

This track produces genuinely native-quality output. The product should push users toward it:
the upload flow detects flat files and offers "do you have the layered original?" before
falling through to Track B.

### 6.3 Track B — De-flattening

The realistic default: a flat JPEG or an MP4 with everything baked in. The engine recovers
structure instead of accepting the flattening.

1. **Separate.** Text and logo masks come from analysis. The background plate is produced by
   inpainting those regions away — content-aware fill constrained to the *local* background
   class, with a hard rule that inpainting may not invent structure inside a protected region.
2. **Re-typeset.** OCR'd copy is matched to a font (brand-kit fonts first, then a metric-
   compatible match, then flagged `font_unmatched` for human confirmation), with the detected
   colour, weight, tracking and alignment. The reviewer sees a source/re-set overlay diff.
3. **Recompose.** The background plate is resized and extended (§6.4) for the target canvas;
   the re-set text and logo are re-laid-out by the solver (§6.5) at correct sizes.
4. **Verify.** Outputs are compared back against the source: colour delta on the plate, type
   fidelity, and a perceptual check that the recomposition didn't shift brand elements.

De-flattening degrades gracefully. If text extraction confidence is low, or inpainting leaves
a visible scar, the engine falls back to Track C for that source and says why. It never ships
a half-recovered composite.

### 6.4 Background extension

Changing aspect ratio means the background must reach edges it never reached. Strategies,
in preference order, gated by the background class from analysis:

| Strategy | Admissible when | Notes |
| --- | --- | --- |
| **Extend flat/gradient** | Background is flat or a linear/radial gradient | Mathematically exact — no artefacts. Solves most designed creative. |
| **Mirror / reflect** | Edge continuity is high and content is non-textual, non-directional | Cheap and clean; disabled where mirroring would duplicate a recognisable object |
| **Clone / texture synthesis** | Background is texture without global structure | Patch-based synthesis; seam score gated |
| **Blur-extend** | Photographic background, ratio change ≤ 33% | Scaled, blurred, darkened copy behind the sharp centre. Must not read as a bar. |
| **Brand matte** | Any | Solid or gradient fill from the brand kit. Always available, always safe. |
| **Generative outpaint** | Opt-in per project; background is photographic; region is unprotected | Human review mandatory. Disabled for regulated verticals and any project flagged `no_synthetic`. |
| **Letterbox / pillarbox** | Explicit last resort | Only with a brand matte and a deliberate composition; never bare grey bars. |

Every extension carries a **seam score**; above threshold, the engine steps down the list.
Extension is never permitted to cross into a protected region, and never permitted to alter a
detected product.

Two rules the implementation forced out into the open:

- **Flat and gradient are per-edge; mirror and blur are whole-canvas.** Each edge may pick its
  own exact fill, but a whole-canvas strategy governs the entire composite and must therefore be
  judged against the *largest* pad. Judging it per-edge lets a 60px side strip choose blur and
  hijack a 700px band.
- **Blur-extend is disqualified by baked-in type.** It reproduces the whole master behind the
  sharp copy, so any type returns as a smeared but recognisable ghost — unmistakably an artefact.
  Type-bearing creative steps down to a matte.
- **Past ~50% pad, stop extending.** Inventing more than half the frame is not extension. A
  deliberate letterbox on a brand matte drawn from the master's own palette is the honest answer,
  and it looks composed rather than stretched.

### 6.5 The layout solver

Given a canvas, a safe zone, a set of elements with constraints, and a background, produce a
placement. Implemented as a constrained optimisation with hard and soft terms.

**Hard constraints (violation = infeasible, never traded away):**

- No element intersects the placement safe zone.
- No element is clipped by the canvas.
- Every text element meets its minimum rendered size (§7.1) and contrast ratio (§7.2).
- The logo meets its minimum size and clear-space rules from the brand kit.
- No element overlaps another element's opaque bounds.
- Faces are not covered by type.
- Legally-required elements (`legal`, `disclaimer`, mandatory logos) are present.
- Uniform scale only — non-uniform scaling of any element is forbidden, everywhere, always.

**Soft objectives (weighted; the score shown in review):**

- Maximise retained saliency from the source composition.
- Preserve the source's reading order and relative hierarchy.
- Preserve the source's *character*: relative positions and the visual weight of the
  background/subject/type relationship.
- Snap to an 8pt grid; equalise optical margins; align to the strongest existing axis.
- Keep line counts low (headline ≤ 3 lines, subhead ≤ 2, body ≤ 4).
- Respect the anchor intent (e.g. "logo always bottom-left").

**Escalation ladder when infeasible.** Applied in order, each step logged as a finding so the
reviewer sees exactly what was given up:

1. Reduce padding toward the minimum.
2. Re-break lines; tighten tracking (to −2%) and leading (to 1.05×).
3. Reduce type size — but never below the §7.1 floor.
4. Re-anchor the element to a different edge.
5. Switch to the placement's alternate layout template (e.g. side-by-side → stacked).
6. Drop the lowest-priority `droppable` element (typically body copy, then subhead).
7. **Stop.** Mark the output `blocked` with the reason. Do not ship a violation.

Step 7 is the point of the whole system. For a 320×50 with a four-line headline and a legal
line, the honest answer is "this cannot be a 320×50 as briefed" — and the tool says so, with
a suggested fix, rather than rendering 4px type.

### 6.6 Track C — Protected crop

The fallback when structure can't be recovered. Still far better than centre-crop:

- **Crop solver** searches translation and scale to maximise saliency coverage subject to hard
  constraints: all text boxes fully inside, faces whole, logo whole, product mask ≥ 95% inside,
  protected content outside the safe zone.
- If no crop satisfies the constraints, it fits-with-extension instead of cropping — the
  content is preserved at a smaller scale and the background does the work.
- **Never** non-uniform scale. **Never** crop through type.
- Anchor bias configurable per placement (faces pull the crop toward the upper third).
- Legibility is still measured on the baked-in type: if the crop's scale factor pushes existing
  type below the floor, that's a finding, and for banner sizes it usually means Track C simply
  can't serve that placement — which is the correct thing to report.

### 6.7 Video reframing

Everything above, plus time.

- **Per-shot, not per-video.** Shot detection segments the timeline; each shot gets its own
  reframing solution. A crop path never animates across a cut.
- **Crop path.** Subject tracks produce a target trajectory, which is smoothed (critically
  damped, no overshoot) and quantised to avoid sub-pixel shimmer. Motion is capped so reframing
  reads as a deliberate slow push, never a nervous auto-pan. Static is preferred: if a fixed
  crop holds the subject for the whole shot within tolerance, use it.
- **Baked-in type in video.** Type must be inside the safe zone *for every frame it is visible*.
  Where the source has lower-third type and the target is Reels, the options are: re-typeset and
  reposition above the chrome (Track B), reframe so the type clears the band, or flag. The
  timeline view shows exactly which frames violate.
- **Duration adaptation.** 30s → 15s → 6s using shot boundaries and the audio beat grid as cut
  candidates. Rules: never cut mid-word in speech; always retain the end-card; hold the logo
  ≥ 1s; retain any legally-required frame. Proposed cut lists are always human-reviewable.
- **End-cards and captions** are rendered as elements through the same layout solver, so they
  obey the same legibility floors as static type.
- **Captions.** Ingest SRT/VTT or auto-transcribe. Burned-in per placement, positioned above
  the chrome band, styled from the brand kit, max 2 lines × 32 characters, with a scrim when
  local contrast fails. Sidecar caption files also exported where the platform accepts them.
- **Audio.** Loudness normalised to the placement target (−14 LUFS social, −24 LKFS CTV,
  −19 Amazon), true peak −1 dBTP web / −2 dBTP broadcast. Mono-safety check. Silent variants
  generated for DOOH.
- **Poster frames.** Auto-selected: sharpest, most salient, face-forward frame outside the
  first 0.5s, with type fully visible. Exported at every image ratio the platform needs.

### 6.8 Resampling and encoding quality

The unglamorous half of "looks professional".

- **Downscale:** Lanczos-3 in linear light (gamma-correct — this alone fixes the muddy
  midtones most tools produce), followed by a mild, radius-aware unsharp mask tuned by scale
  factor. Type-heavy regions get a separate, gentler sharpening pass to avoid halos.
- **Upscale:** bicubic to 110%; beyond that, ML upscale if enabled, otherwise a finding.
- **Alpha:** premultiply-aware compositing throughout; no dark fringes.
- **Colour:** all work in a linear working space, output-converted per placement (sRGB, Rec.709,
  Display P3 where supported). Explicit rendering intent.
- **Chroma:** 4:4:4 for type-heavy video where the platform allows it; otherwise text edges get
  extra bitrate via region-of-interest encoding.
- **File-size targeting:** binary search on quality to land just under the ceiling (target 90%).
  For the 150 KB display sizes: palette optimisation, selective quantisation that protects type
  regions, and PNG-vs-JPEG-vs-GIF selection by measured result rather than by rule. If the
  ceiling can't be met without visible damage, that's a finding — not a silently mushy ad.
- **Video ladder:** per-placement CRF/bitrate targets, two-pass where size-constrained,
  keyframe at 0, no B-frame-only openings (some previewers show frame 0 as the thumbnail).

---

## 7. Legibility and polish standards

These are the numeric rules the hard constraints reference. They are the product's opinion,
configurable per workspace but with sane defaults.

### 7.1 Minimum type size

Legibility depends on rendered angular size, so the floors are defined per viewing context and
expressed both in absolute pixels at the reference canvas and as a percentage of the canvas's
shorter side (so they scale to any canvas).

**Mobile in-hand (feed, stories, reels, shorts) — reference canvas 1080 short side:**

| Role | Min px | Min % of short side | Max lines |
| --- | --- | --- | --- |
| Headline | 44 | 4.0% | 3 |
| Subhead | 32 | 3.0% | 2 |
| Body | 28 | 2.6% | 4 |
| CTA label | 30 | 2.8% | 1 |
| Price / offer | 34 | 3.1% | 1 |
| Legal / disclaimer | 20 | 1.85% | 3 |

**Desktop display banners — measured in 1x CSS pixels at served size:**

| Role | Min px | Notes |
| --- | --- | --- |
| Headline | 14 | Below this, drop the headline rather than shrink it |
| Body | 12 | Prohibited entirely on canvases under 60px tall |
| CTA label | 12 | Button height ≥ 24px |
| Legal | 9 | Absolute floor; below it the legal must move to the landing page and the output is flagged for legal review |

**CTV (living room, ~2.5m):** minimum type 2.0% of frame height (22px at 1080p), all type
inside the 5% title-safe inset.

**DOOH (2–5m):** minimum 3.0% of frame height, ≤ 7 words on screen at once.
**Billboard (30m+):** minimum 6.0% of frame height, headline only.

Additional rules: no more than three type sizes per output; hierarchy ratio ≥ 1.25× between
adjacent levels; all-caps tracked ≥ +2%; no type set in a weight lighter than the brand kit's
`minWeightSmall` below 24px (hairline weights disappear when compressed).

### 7.2 Contrast and separation

- Text under the "large" threshold: contrast ratio ≥ 4.5:1 against its **local** background,
  sampled per glyph area rather than as an average (an average passes while the word sitting on
  a highlight is invisible).
- Large text (≥ 1.5× the role minimum): ≥ 3:1.
- Text over imagery: if local contrast fails anywhere in the text's bounds, apply the brand
  kit's scrim treatment (gradient, plate, or blur-behind) — chosen per project, never invented
  per output.
- Text over busy backgrounds: a high-frequency-energy check catches type that technically
  passes contrast but is unreadable against detail. Warn and offer a scrim.
- Logo: minimum contrast 3:1 against its background; if the primary lockup fails, switch to the
  brand kit's reversed/mono variant automatically.

### 7.3 Composition and polish

- **Edge padding:** minimum 4% of the shorter side, or 12px absolute for canvases under 300px.
- **Safe zones:** hard, from the registry. Additionally, a `soft` band of +25% where the
  solver is penalised but not blocked, so content doesn't sit right on the boundary.
- **Optical margins:** left/right margins equalised to within 1px after accounting for glyph
  sidebearings; text-block bounds measured on ink, not on em boxes.
- **Grid:** all elements snap to an 8pt grid scaled to the canvas.
- **Logo clear space:** enforced from the brand kit, expressed in multiples of a logo metric.
- **No stretching, ever.** Non-uniform scale is rejected at the renderer level, not just the
  solver level, so no future code path can introduce it.
- **Text-in-image coverage:** warn above 20% of canvas area. Not a platform rule any more, but
  it still correlates with poor delivery and with cluttered design.
- **Rhythm across a set:** when one source fans out to many placements, the solver shares a
  layout seed so the family reads as one campaign rather than 40 unrelated compositions.

---

## 8. Brand kit

The mechanism that makes automated output on-brand rather than merely valid. One per
workspace, versioned; recipes pin a version.

- **Logos:** primary, reversed, mono, stacked, horizontal, icon-only — each as SVG plus raster
  fallback, with minimum size, clear space, and the rules for when each variant is used.
- **Colours:** named palette with roles (primary, accent, surface, on-surface), plus which
  pairings are pre-approved for text (so contrast checks resolve to a fix, not just a warning).
- **Type:** licensed font files, role → family/weight/size-scale/tracking mapping, minimum
  weights at small sizes, case rules.
- **CTA component:** button geometry, radius, fill/stroke, label padding, states.
- **Scrim treatments:** the approved ways to make type legible over imagery.
- **Legal library:** market-specific disclaimers with the placements each is required on, so
  the validator can assert presence rather than trust the operator.
- **Layout templates:** per aspect-ratio family (square, portrait, vertical, landscape, banner
  horizontal, banner vertical, banner tiny), giving the solver a designed starting point.
- **Guardrails:** `no_synthetic`, `no_crop_regions`, forbidden colour pairings, prohibited
  imagery treatments.

---

## 9. Presets and recipes

**Presets** are named placement bundles: `Meta Full Fan-out`, `Google Display — IAB Core`,
`Programmatic Everything`, `Retail Media`, `CTV + Social 15s`. Users compose their own.

**Recipes** are the full declarative spec of a job — placements, track preference, extension
policy, brand kit version, per-placement overrides, naming pattern. Stored as JSON, diffable,
and shareable across a team.

```jsonc
{
  "recipe": "q4-launch-full",
  "brandKit": "acme@4",
  "sources": ["hero-a.psd", "hero-b.jpg", "film-30s.mov"],
  "presets": ["meta-fanout", "gdn-iab-core", "youtube-core"],
  "policy": {
    "track": "prefer-layered",
    "extension": ["flat", "mirror", "brand-matte"],   // generative excluded
    "upscaleLimit": 1.1,
    "onBlocked": "flag"                                // never "force"
  },
  "overrides": {
    "gdn_320x50":  { "drop": ["body", "subhead"], "layout": "logo-left-headline-right" },
    "meta_reels":  { "anchor": "logo:top-left", "captions": true },
    "ctv_1080p":   { "duration": 15, "endcardHold": 2.0 }
  },
  "naming": "{brand}_{concept}_{platform}_{w}x{h}_{ratio}_{duration}_{version}"
}
```

Because outputs are a pure function of (source hash, recipe, brand kit version, engine
version), re-running is cheap and cached, and a client asking "what changed since Tuesday?"
gets a real answer.

---

## 10. Review and correction

The review surface is the product's centre of gravity — automation buys nothing if verifying it
takes as long as doing it manually.

- **Grid view.** Every output as a thumbnail, grouped by platform, colour-coded pass / warn /
  blocked, sorted worst-first so attention goes where it's needed.
- **In-context preview.** Outputs shown inside real placement chrome — Reels UI, TikTok UI,
  a feed card, a GDN slot on a sample page, a TV frame — with safe zones toggleable. This is
  what catches "technically fine, actually covered by the CTA sticker".
- **Side-by-side.** Source and output, with region overlays and a saliency-retention score.
- **Findings list.** Per output, plain-language findings with a one-click fix where one exists
  ("apply scrim", "drop body copy", "switch to reversed logo", "re-anchor logo top-left").
- **Direct manipulation.** Drag the crop, nudge a text block, resize the logo — with live
  constraint feedback (an element turns red the moment it enters a safe zone or drops below its
  floor). Keyboard-first.
- **Overrides as deltas.** Manual edits are stored against (source, placement, recipe), not
  baked into the pixels. Re-running the batch after a copy change preserves every manual fix
  that is still valid, and tells you which ones it had to discard and why.
- **Approvals.** Per-output and per-batch state, with comments and an audit trail.
- **Bulk actions.** Approve all passing; apply an override across a whole ratio family; re-run
  only the blocked outputs.

---

## 11. Validation and preflight

Runs on every output. Findings are `pass` / `warn` / `blocked`. **Blocked outputs cannot be
exported** — the single most important rule in the product.

**Blocked vs. warn.** *Blocked* means this output is defective **as produced**: the pipeline's
own geometry, scaling or encoding created the problem. *Warn* means the output faithfully
reproduces a defect that was already in the master. The test is whether the transform could have
caused it — contrast is invariant under uniform scaling, and type size is unchanged at 100%
scale, so failures of either at those settings are upstream problems. They are reported once
against the source, where the fix belongs, rather than as a blocker on all forty placements.
Without this distinction a single off-spec brand colour blocks an entire fan-out, and the tool
becomes something users route around rather than trust.

**Platform conformance** — dimensions exact, aspect ratio within tolerance, file size under
ceiling, codec/container/profile allowed, duration in range, frame rate allowed, audio codec
and loudness in range, colour space correct, alpha where required, animation length and loop
count within limits.

**Content integrity** — all source text present in the output (OCR round-trip against the
source's word list; catches silently dropped copy), logo present and unclipped, required legal
present, faces unclipped, product mask retained above threshold, no element in a safe zone.

**Legibility** — every text element against §7.1 floors and §7.2 contrast, per-glyph local
contrast, busy-background check, minimum weight at size.

**Craft** — seam score on extended background, upscale factor, sharpening halo detection,
banding detection on gradients, compression-artefact score in type regions, non-uniform-scale
assertion (must be exactly 1.0 ratio), edge-padding and grid conformance, text coverage ratio.

**Video-specific** — safe-zone compliance across all frames, crop-path smoothness, no pan
across a cut, first-frame quality (it is often the thumbnail), last-frame end-card legibility,
audio true-peak and loudness, caption timing and reading rate (≤ 20 characters/second), black-
frame and freeze detection.

**Set-level** — carousel cards share ratio and canvas; a required asset family is complete
(e.g. Google needs landscape + square + both logos); naming collisions; duplicate outputs.

Findings are machine-readable and exported with the manifest, so ad ops can see why an asset
carries a warning without opening the tool.

---

## 12. Export and delivery

- **Naming** from a token pattern (`{brand}_{concept}_{platform}_{placement}_{w}x{h}_{ratio}_{duration}_{lang}_{version}`), with per-platform overrides and collision detection.
- **Structure:** ZIP, organised by platform → placement, or flat, or mirroring a client's
  required folder tree.
- **Manifest** (CSV + JSON) per export: every output with source, placement, dimensions, file
  size, duration, recipe, brand kit version, engine version, findings, approval state, and
  checksum. This is what makes trafficking auditable.
- **Alt text** generated per image output and included in the manifest.
- **Destinations:** direct download, Google Drive, Dropbox, S3/GCS, Box, SFTP, Frame.io.
- **Platform upload (Phase 4):** push to Meta Ad Library, Google Ads asset library, TikTok
  Creative Center, LinkedIn, Pinterest, DV360 — assets only, never campaign structure, and
  always as drafts.
- **Contact sheet PDF** for client approval, with each output shown in context.

---

## 13. Architecture

```
Browser (Next.js + React)
  ├─ Upload, analysis editor, review grid, in-context previews
  └─ WASM preview engine (libvips + a WebGL compositor)
        → instant, approximate crop/layout feedback while dragging
              ▼  recipe + overrides
API (Node/TypeScript, tRPC)
  ├─ Postgres  — projects, sources, analyses, recipes, outputs, findings, approvals
  ├─ S3/R2     — sources, renders, cached analysis artefacts
  └─ Redis     — job queue, render cache keyed by content hash
              ▼
Workers
  ├─ Image worker   — sharp/libvips, linear-light pipeline, custom text renderer (HarfBuzz)
  ├─ Video worker   — ffmpeg (filter graphs generated from the recipe), per-shot parallel
  ├─ Analysis worker— ONNX Runtime: saliency, detection, segmentation, OCR, tracking
  └─ Layered worker — PSD/AI/Figma import → element graph
```

**Two engines, one truth.** The WASM preview must be *approximate but never contradictory* —
it may look slightly softer than the final render, but it must never show a layout that the
server render would place differently. Layout solving therefore compiles to a single
TypeScript implementation shared by both, with the renderers differing only in resampling and
encoding quality. Divergence here would destroy trust in the preview, so a golden-file test
suite asserts layout parity between preview and render on every commit.

**Determinism.** Fixed model revisions, fixed seeds, pinned ffmpeg/libvips versions, no
wall-clock or randomness in layout. Output paths include the engine version so upgrades are
visible rather than silent.

**Scale.** Renders are independent and horizontally parallel. A 6-source × 40-placement batch
is 240 independent jobs; target p95 under 4 minutes for images, under 12 minutes with video.
Analysis is the expensive step and is cached per source.

---

## 14. Data model (abridged)

```ts
Workspace { id, name, brandKits[], presets[], members[] }
BrandKit   { id, version, logos[], palette, typeRoles, ctaSpec, scrims[], legal[], templates[], guardrails }
Project    { id, workspaceId, name, sources[], recipes[], batches[] }
Source     { id, projectId, kind: 'image'|'video'|'layered', uri, hash, meta, qualityFindings[] }
Analysis   { id, sourceId, engineVersion, regions[], shots[], tracks[], audio, palette, editedBy? }
Region     { id, type, mask|box, protection: 'immutable'|'protected'|'droppable', role?, confidence, source: 'auto'|'human' }
Recipe     { id, projectId, brandKitVersion, placements[], policy, overrides{}, naming }
Batch      { id, recipeId, sourceIds[], state, startedAt, finishedAt }
Output     { id, batchId, sourceId, placementId, uri, bytes, dims, duration?, layout, findings[], state, overrideId? }
Override   { id, sourceId, placementId, recipeId, delta, authorId, createdAt, stillValid }
Finding    { code, severity, message, elementRef?, frameRange?, suggestedFix? }
```

---

## 15. Phasing

**Phase 1 — Static core (weeks 1–8).** Format registry (done). Image upload + quality gate.
Analysis: saliency, faces, text/OCR, logo matching. Track C protected crop + Track A layered
re-layout. Layout solver with hard constraints and the legibility standard. Flat/gradient,
mirror and brand-matte extension. Validation. Grid review with crop nudging. ZIP + manifest
export. Meta, Google Display, Google asset sets, LinkedIn, Pinterest, X, Reddit, Microsoft.

*Ships when:* a flat 1080×1080 hero fans out to 30 static placements with zero unreadable
outputs and no clipped logos.

**Phase 2 — De-flattening (weeks 9–16).** Text/logo separation, inpainted background plates,
font matching, re-typesetting, source/output diff. Blur-extend and clone extension. Brand kit
v1. In-context previews. Overrides-as-deltas.

*Ships when:* a flat banner with baked-in type produces a clean 320×50 and a clean 300×600 —
the case that breaks every competitor.

**Phase 3 — Video (weeks 17–28).** Shot detection, tracking, per-shot crop paths, safe-zone
timeline, duration adaptation, captions, loudness, encoding ladders, poster frames. TikTok,
Snapchat, Reels, Shorts, YouTube, CTV, DOOH.

*Ships when:* a 30s 16:9 film becomes a compliant 15s 9:16 Reels cut with legible repositioned
type and correct loudness, reviewed in one pass.

**Phase 4 — Scale and integration (weeks 29+).** Figma/Canva/Drive/Frame.io connectors,
platform asset upload, localisation fan-out (copy swaps × markets, with per-script type
metrics), approval workflows, generative outpaint behind an opt-in flag, API and webhooks.

---

## 16. Success criteria

| Metric | Target |
| --- | --- |
| Outputs auto-approved with no human edit | ≥ 70% (Phase 2), ≥ 80% (Phase 4) |
| Exported outputs violating a platform spec | 0 — enforced, not measured |
| Exported outputs below the legibility floor | 0 — enforced, not measured |
| Time for 1 source → 30 static placements, reviewed | ≤ 10 minutes |
| p95 render time, 40-placement static batch | ≤ 4 minutes |
| Blind designer preference vs. hand-built, on passing outputs | ≥ 45% (indistinguishable) |
| Rejected platform uploads | < 0.5% of exported assets |

The second and third rows are the ones that matter. They are not aspirations to be measured
after the fact — they are properties the export path guarantees by construction.

---

## 17. Open questions

1. **Generative extension policy.** Off by default is right for regulated clients, but many
   users will want it as the default. Per-workspace toggle, or per-project only? Recommend
   per-workspace default with a per-project override and a permanent watermark in the manifest.
2. **Font licensing.** Re-typesetting requires embedding the brand's fonts server-side. Needs a
   licence attestation step at brand-kit upload, plus a metric-compatible fallback library for
   when the real font can't be supplied.
3. **Registry drift.** Platform specs change silently. Options: a paid spec-feed vendor, a
   scheduled scrape with human verification, or community-sourced corrections. Recommend
   scheduled scrape + a staleness badge in the UI (the `verifiedOn` field already supports it).
4. **OCR on stylised type.** Display faces, script faces and heavy tracking degrade OCR badly.
   Where confidence is low, Track B should not be attempted — needs a calibrated threshold from
   real client creative before Phase 2 locks.
5. **Legibility floors are opinions.** The §7.1 numbers are defensible defaults, not measured
   findings. They should be validated against a small eye-tracking or comprehension study, and
   the outcome may differ by market and script.
6. **Non-Latin scripts.** CJK, Arabic and Devanagari have different minimum-size and
   line-breaking requirements. Phase 1 should ship Latin-only floors and refuse to silently
   apply them to other scripts.

---

## 18. Related documents

- [`docs/FORMAT-CATALOG.md`](./FORMAT-CATALOG.md) — every supported placement, generated.
- [`data/formats.json`](../data/formats.json) — the registry; source of truth.
- `scripts/gen-catalog.mjs` — regenerates the catalog; run with `--check` in CI.

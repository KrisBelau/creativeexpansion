# Creative Expansion

A web utility that takes finished image and video ad creative and expands it into every format
a media plan needs — without the output looking resized.

Resizing an ad is not resizing a photograph. An ad is a composite of a subject, a logo, a
headline, a legal line and a CTA, each with its own rules about how small it may get, how close
to an edge it may sit, and whether it may be cropped at all. This tool treats those rules as
hard constraints: **an output that would be unreadable is flagged and blocked, never shipped.**

## Status

Specification phase. No implementation yet.

## Documents

| Path | What it is |
| --- | --- |
| [`docs/SPEC.md`](docs/SPEC.md) | The product specification — resize engine, legibility standards, features, architecture, phasing |
| [`docs/FORMAT-CATALOG.md`](docs/FORMAT-CATALOG.md) | Every supported placement: canvas, safe zone, file ceiling, duration, codec, loudness. **Generated — do not edit.** |
| [`data/formats.json`](data/formats.json) | The format registry. Single source of truth. |

Currently **100 placements across 16 platforms**: Meta, Google Display (IAB), Google responsive
asset sets, YouTube, TikTok, Snapchat, Pinterest, LinkedIn, X, Reddit, Amazon, CTV/OTT, digital
audio, Microsoft, DOOH and email.

## Working with the registry

Edit `data/formats.json`, then regenerate the catalog:

```bash
node scripts/gen-catalog.mjs           # rewrite docs/FORMAT-CATALOG.md
node scripts/gen-catalog.mjs --check   # CI: fail if the markdown is stale
```

Every placement carries `verifiedOn` and a `docs` link. Platform specs change without notice,
so entries are treated as stale after 90 days.

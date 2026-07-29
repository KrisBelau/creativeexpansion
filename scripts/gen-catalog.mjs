#!/usr/bin/env node
// Renders docs/FORMAT-CATALOG.md from data/formats.json.
// The JSON is the source of truth; run `node scripts/gen-catalog.mjs` after editing it.
// CI runs this with --check to fail the build when the markdown is out of date.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(readFileSync(join(root, 'data/formats.json'), 'utf8'))
const outPath = join(root, 'docs/FORMAT-CATALOG.md')

const bytes = (n) => {
  if (n == null) return '—'
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(n % 1024 ** 3 ? 1 : 0)} GB`
  if (n >= 1024 ** 2) return `${+(n / 1024 ** 2).toFixed(n % 1024 ** 2 ? 1 : 0)} MB`
  return `${Math.round(n / 1024)} KB`
}

const canvas = (c) => (c ? `${c.w}×${c.h}` : '—')

const safeZone = (s) => {
  if (!s) return '—'
  const { top = 0, right = 0, bottom = 0, left = 0 } = s
  if (!top && !right && !bottom && !left) return 'none'
  return `${top} / ${right} / ${bottom} / ${left}`
}

const duration = (v) => {
  if (!v) return '—'
  const range = v.minSec != null && v.maxSec != null ? `${v.minSec}–${v.maxSec}s` : '—'
  const rec = v.recommendedSec ? ` (rec ${v.recommendedSec[0]}–${v.recommendedSec[1]}s)` : ''
  return range + rec
}

const rows = []
rows.push(`<!-- GENERATED FILE — do not edit. Source: data/formats.json. Regenerate: node scripts/gen-catalog.mjs -->`)
rows.push(``)
rows.push(`# Format Catalog`)
rows.push(``)
rows.push(`Catalog version \`${catalog.catalogVersion}\` · updated ${catalog.updatedOn}`)
rows.push(``)
rows.push(catalog.note)
rows.push(``)
rows.push(`**Column meanings**`)
rows.push(``)
rows.push(`| Column | Meaning |`)
rows.push(`| --- | --- |`)
rows.push(`| Canvas | Render target at 1x. |`)
rows.push(`| Min | Smallest source resolution accepted without an upscale warning. |`)
rows.push(`| Safe zone | Inset in px from top / right / bottom / left of the canvas. No text, logo or CTA may enter this band. |`)
rows.push(`| Max size | Hard platform ceiling. The encoder targets 90% of it. |`)
rows.push(`| Duration | Accepted range, with the recommended window in brackets. |`)
rows.push(``)

let placementCount = 0

const toc = catalog.platforms.map(
  (p) => `- [${p.name}](#${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')})`
)
rows.push(`## Platforms`)
rows.push(``)
rows.push(...toc)
rows.push(``)

for (const p of catalog.platforms) {
  rows.push(`---`)
  rows.push(``)
  rows.push(`## ${p.name}`)
  rows.push(``)
  rows.push(`Spec source: ${p.docs === 'internal' ? '_internal convention_' : `<${p.docs}>`} · verified ${p.verifiedOn}`)
  rows.push(``)

  if (p.sharedConstraints) {
    const sc = p.sharedConstraints
    rows.push(`**Applies to every size below:**`)
    rows.push(``)
    if (sc.image) rows.push(`- Image: max ${bytes(sc.image.maxBytes)}, encodings ${sc.image.encodings.join(' / ')}`)
    if (sc.animation)
      rows.push(
        `- Animation: max ${sc.animation.maxSec}s, ${sc.animation.maxLoops} loops, ${sc.animation.maxFps} fps ceiling`
      )
    for (const n of sc.notes ?? []) rows.push(`- ${n}`)
    rows.push(``)
  }

  const hasVideo = p.placements.some((pl) => pl.video)
  const header = hasVideo
    ? `| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size | Duration |`
    : `| Placement | Media | Ratio | Canvas | Min | Safe zone | Max size |`
  const divider = hasVideo ? `| --- | --- | --- | --- | --- | --- | --- | --- |` : `| --- | --- | --- | --- | --- | --- | --- |`
  rows.push(header)
  rows.push(divider)

  const noted = []
  for (const pl of p.placements) {
    placementCount++
    const max = pl.video?.maxBytes ?? pl.image?.maxBytes ?? p.sharedConstraints?.image?.maxBytes
    const cells = [
      `\`${pl.id}\`<br>${pl.name}`,
      pl.media.join(', '),
      pl.aspect ?? '—',
      canvas(pl.canvas),
      canvas(pl.minCanvas),
      safeZone(pl.safeZone),
      bytes(max),
    ]
    if (hasVideo) cells.push(duration(pl.video))
    rows.push(`| ${cells.join(' | ')} |`)
    if (pl.notes?.length) noted.push(pl)
  }
  rows.push(``)

  if (noted.length) {
    rows.push(`**Notes**`)
    rows.push(``)
    for (const pl of noted) {
      rows.push(`- **${pl.name}**`)
      for (const n of pl.notes) rows.push(`  - ${n}`)
    }
    rows.push(``)
  }

  if (p.placements.some((pl) => pl.video?.audio)) {
    rows.push(`**Audio targets**`)
    rows.push(``)
    rows.push(`| Placement | Codec | Min bitrate | Loudness |`)
    rows.push(`| --- | --- | --- | --- |`)
    for (const pl of p.placements.filter((x) => x.video?.audio)) {
      const a = pl.video.audio
      rows.push(`| ${pl.name} | ${a.codec} | ${a.minBitrateKbps} kbps | ${a.loudnessLufs} LUFS |`)
    }
    rows.push(``)
  }
}

rows.push(`---`)
rows.push(``)
rows.push(
  `**Total: ${placementCount} placements across ${catalog.platforms.length} platforms.**`
)
rows.push(``)

const output = rows.join('\n')

if (process.argv.includes('--check')) {
  const existing = readFileSync(outPath, 'utf8')
  if (existing !== output) {
    console.error('docs/FORMAT-CATALOG.md is out of date. Run: node scripts/gen-catalog.mjs')
    process.exit(1)
  }
  console.log('Catalog markdown is up to date.')
} else {
  writeFileSync(outPath, output)
  console.log(`Wrote ${outPath} — ${placementCount} placements, ${catalog.platforms.length} platforms.`)
}

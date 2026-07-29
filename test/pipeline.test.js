import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'

import { placements, presets, getPlacement, roleFloor, legibility, resolvePlacements } from '../src/registry.js'
import { contains, coverage, mapRect, safeArea, fitContain, rect } from '../src/solver/geometry.js'
import { buildFilename } from '../src/naming.js'
import { validateSet, stateOf } from '../src/validate/rules.js'
import { buildManifest, buildArchive, BlockedExportError } from '../src/export.js'
import { runBatch } from '../src/pipeline.js'
import { analyse } from '../src/analysis/index.js'

/* --------------------------------------------------------------- registry */

describe('registry', () => {
  test('every placement resolves a legibility context', () => {
    for (const p of placements) {
      assert.ok(p.context, `${p.id} has no viewing context`)
      assert.ok(legibility.contexts[p.context], `${p.id} references unknown context ${p.context}`)
    }
  })

  test('every placement has a canvas and at least one medium', () => {
    for (const p of placements) {
      assert.ok(p.canvas?.w > 0 && p.canvas?.h > 0, `${p.id} has no canvas`)
      assert.ok(p.media.length > 0, `${p.id} declares no media`)
    }
  })

  test('image placements declare an encoding list and byte ceiling', () => {
    for (const p of placements.filter((x) => x.media.includes('image'))) {
      assert.ok(p.image?.encodings?.length, `${p.id} has no encodings`)
      assert.ok(p.image.maxBytes > 0, `${p.id} has no byte ceiling`)
    }
  })

  test('safe zones never consume the whole canvas', () => {
    for (const p of placements) {
      const zone = safeArea(p.canvas, p.safeZone)
      assert.ok(zone.w > 0 && zone.h > 0, `${p.id} safe zone leaves no usable area`)
    }
  })

  test('every preset resolves to known placements', () => {
    for (const preset of presets) {
      assert.ok(preset.resolved.length > 0, `${preset.id} is empty`)
      for (const id of preset.resolved) assert.doesNotThrow(() => getPlacement(id))
    }
  })
})

/* ------------------------------------------------------------- legibility */

describe('legibility floors', () => {
  test('a floor is the greater of its absolute and proportional parts', () => {
    // At the 1080 reference canvas the two agree by construction (4% of 1080 is
    // 43.2), and the absolute floor wins the tie.
    const stories = roleFloor(getPlacement('meta_stories'), 'headline')
    assert.equal(stories.minPx, 44)
  })

  test('the proportional floor takes over on a larger canvas', () => {
    // 2% of a 2160px-tall 4K frame, with no absolute floor to compete.
    const uhd = roleFloor(getPlacement('ctv_4k'), 'headline')
    assert.ok(Math.abs(uhd.minPx - 43.2) < 0.1, `got ${uhd.minPx}`)
  })

  test('display floors are absolute, not proportional', () => {
    const big = roleFloor(getPlacement('gdn_970x250'), 'headline')
    const small = roleFloor(getPlacement('gdn_320x50'), 'headline')
    assert.equal(big.minPx, small.minPx)
    assert.equal(big.minPx, 14)
  })

  test('email floors double because the canvas renders at half size', () => {
    const hero = roleFloor(getPlacement('email_hero'), 'headline')
    assert.equal(hero.minPx, 36) // 18px at the 600px served width
  })

  test('ctv falls back to the default role entry', () => {
    const ctv = roleFloor(getPlacement('ctv_1080p'), 'headline')
    assert.ok(Math.abs(ctv.minPx - 21.6) < 0.1, `got ${ctv.minPx}`) // 2% of 1080
  })

  test('body copy is prohibited on canvases under 60px tall', () => {
    const floor = roleFloor(getPlacement('gdn_320x50'), 'body')
    assert.equal(floor.prohibitedUnderCanvasHeight, 60)
  })
})

/* --------------------------------------------------------------- geometry */

describe('geometry', () => {
  test('contains respects tolerance', () => {
    const outer = rect(0, 0, 100, 100)
    assert.ok(contains(outer, rect(10, 10, 80, 80)))
    assert.ok(!contains(outer, rect(-5, 10, 80, 80)))
    assert.ok(contains(outer, rect(-0.4, 10, 80, 80), 0.5))
  })

  test('coverage reports the retained fraction', () => {
    assert.equal(coverage(rect(0, 0, 10, 10), rect(5, 0, 10, 10)), 0.5)
    assert.equal(coverage(rect(0, 0, 10, 10), rect(0, 0, 10, 10)), 1)
    assert.equal(coverage(rect(0, 0, 10, 10), rect(50, 50, 10, 10)), 0)
  })

  test('mapRect carries a source box into output space', () => {
    const crop = rect(100, 100, 200, 200)
    const mapped = mapRect(rect(150, 150, 50, 50), crop, 400, 400)
    assert.deepEqual(mapped, rect(100, 100, 100, 100))
  })

  test('fitContain never exceeds the destination', () => {
    const f = fitContain(1000, 500, 300, 300)
    assert.ok(f.w <= 300 && f.h <= 300)
    assert.ok(Math.abs(f.w / f.h - 2) < 1e-6, 'aspect ratio must be preserved')
  })
})

/* ----------------------------------------------------------------- naming */

describe('naming', () => {
  const placement = getPlacement('meta_feed_square')

  test('fills tokens and slugs values', () => {
    const name = buildFilename({
      placement,
      meta: { brand: 'Acme Co', concept: 'Q4 Launch', version: 'v2' },
      format: 'jpg',
    })
    assert.equal(name, 'acme-co_q4-launch_meta_feed-square_1080x1080_1x1_v2.jpg')
  })

  test('collapses separators left by empty tokens', () => {
    const name = buildFilename({
      pattern: '{brand}_{lang}_{placement}',
      placement,
      meta: { brand: 'acme' },
      format: 'jpg',
    })
    assert.equal(name, 'acme_feed-square.jpg')
  })

  test('rejects unknown tokens rather than emitting them literally', () => {
    assert.throws(() => buildFilename({ pattern: '{nope}', placement, format: 'jpg' }), /Unknown naming token/)
  })
})

/* ------------------------------------------------------- set validation */

describe('set validation', () => {
  test('flags naming collisions', () => {
    const findings = validateSet([
      { filename: 'a.jpg', placementId: 'x', width: 10, height: 10, state: 'pass' },
      { filename: 'a.jpg', placementId: 'y', width: 10, height: 10, state: 'pass' },
    ])
    assert.ok(findings.some((f) => f.code === 'naming_collision' && f.severity === 'blocked'))
  })

  test('flags an incomplete Google asset family', () => {
    const findings = validateSet([
      { filename: 'a.jpg', placementId: 'goog_asset_landscape', width: 1200, height: 628, state: 'pass' },
    ])
    assert.ok(findings.some((f) => f.code === 'asset_family_incomplete'))
  })

  test('stateOf takes the worst severity', () => {
    assert.equal(stateOf([{ severity: 'info' }, { severity: 'warn' }]), 'warn')
    assert.equal(stateOf([{ severity: 'warn' }, { severity: 'blocked' }]), 'blocked')
    assert.equal(stateOf([]), 'pass')
  })
})

/* ---------------------------------------------------------- end to end */

/** A legible master: large type, high contrast, flat ground. */
async function legibleMaster(w = 1080, h = 1080) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <text x="80" y="300" font-family="DejaVu Sans" font-size="130" font-weight="bold" fill="#000000">Big news</text>
    <text x="80" y="440" font-family="DejaVu Sans" font-size="130" font-weight="bold" fill="#000000">today</text>
    <circle cx="${w - 240}" cy="${h - 300}" r="150" fill="#123456"/>
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

describe('pipeline', () => {
  test('an identity transform never blocks on type size', async () => {
    // The invariant that keeps the legibility rules honest: if a master is
    // legible at its native size, rendering it to the same canvas cannot make it
    // illegible. Any size-floor blocker here is a measurement bug, not a defect
    // in the creative.
    const input = await legibleMaster()
    const batch = await runBatch({ input, recipe: { placements: ['meta_feed_square'] } })
    const [out] = batch.outputs

    assert.equal(out.width, 1080)
    assert.equal(out.height, 1080)
    assert.equal(out.transform.kind, 'crop')
    assert.deepEqual(out.transform.crop, { x: 0, y: 0, w: 1080, h: 1080 })

    const sizeBlockers = out.findings.filter(
      (f) => f.severity === 'blocked' && f.code.startsWith('type_below_floor')
    )
    assert.deepEqual(sizeBlockers, [], `identity render blocked on type size: ${JSON.stringify(sizeBlockers)}`)
  })

  test('a tiny canvas blocks rather than shipping unreadable type', async () => {
    const input = await legibleMaster()
    const batch = await runBatch({ input, recipe: { placements: ['gdn_320x50'] } })
    const [out] = batch.outputs
    assert.equal(out.state, 'blocked')
    assert.ok(
      out.findings.some((f) => f.severity === 'blocked' && f.code.startsWith('type_below_floor')),
      'expected a type-size blocker on a 320x50'
    )
  })

  test('outputs always hit their exact canvas and byte ceiling', async () => {
    const input = await legibleMaster()
    const batch = await runBatch({
      input,
      recipe: { placements: ['gdn_300x250', 'meta_feed_portrait', 'gdn_728x90'] },
    })
    for (const o of batch.outputs) {
      const p = getPlacement(o.placementId)
      const meta = await sharp(o.buffer).metadata()
      assert.equal(meta.width, p.canvas.w, `${o.placementId} width`)
      assert.equal(meta.height, p.canvas.h, `${o.placementId} height`)
      assert.ok(o.bytes <= p.image.maxBytes, `${o.placementId} exceeded its byte ceiling`)
    }
  })

  test('aspect ratio is never distorted', async () => {
    // Non-uniform scale is forbidden everywhere (SPEC 7.3). Reaching a 728x90
    // from a square master must be fit-with-extension, never a stretch.
    const input = await legibleMaster()
    const batch = await runBatch({ input, recipe: { placements: ['gdn_728x90'] } })
    const [out] = batch.outputs
    assert.equal(out.transform.kind, 'fit')
    const placed = out.transform.placed
    assert.ok(Math.abs(placed.w / placed.h - 1) < 0.02, `placed box is ${placed.w}x${placed.h}, not square`)
  })

  test('background extension picks an exact strategy on a flat ground', async () => {
    const input = await legibleMaster()
    const batch = await runBatch({ input, recipe: { placements: ['gdn_728x90'] } })
    const [out] = batch.outputs
    assert.ok(['flat', 'gradient'].includes(out.extension.strategy), `got ${out.extension.strategy}`)
    assert.ok(out.extension.seamScore < legibility.craft.seamScoreWarn, `seam ${out.extension.seamScore}`)
  })

  test('analysis is reusable across batches', async () => {
    const input = await legibleMaster()
    const analysis = await analyse(input)
    const batch = await runBatch({ input, recipe: { placements: ['meta_feed_square'] }, analysis })
    assert.equal(batch.outputs.length, 1)
    assert.equal(batch.analysis.regions.length, analysis.regions.length)
  })
})

/* ----------------------------------------------------------------- export */

describe('export', () => {
  test('blocked outputs are excluded from the archive and nulled in the manifest', async () => {
    const input = await legibleMaster()
    const batch = await runBatch({
      input,
      recipe: { placements: ['meta_feed_square', 'gdn_320x50'] },
    })

    const blocked = batch.outputs.filter((o) => o.state === 'blocked')
    assert.ok(blocked.length > 0, 'expected the 320x50 to be blocked')

    const { exportable, manifest } = buildArchive(batch)
    assert.ok(!exportable.some((o) => o.state === 'blocked'), 'a blocked output reached the archive')

    for (const entry of manifest.outputs) {
      if (entry.state === 'blocked') assert.equal(entry.file, null)
      else assert.ok(entry.file, `${entry.placementId} has no file path`)
    }
  })

  test('an all-blocked batch refuses to export', async () => {
    const input = await legibleMaster()
    const batch = await runBatch({ input, recipe: { placements: ['gdn_320x50'] } })
    assert.throws(() => buildArchive(batch), BlockedExportError)
  })

  test('manifest records provenance for every output', async () => {
    const input = await legibleMaster()
    const batch = await runBatch({ input, recipe: { placements: ['meta_feed_square'] } })
    const manifest = buildManifest(batch)
    assert.ok(manifest.engineVersion)
    assert.ok(manifest.catalogVersion)
    assert.ok(manifest.sourceHash)
    assert.equal(manifest.outputs.length, 1)
    assert.ok(manifest.outputs[0].altText)
    assert.ok(manifest.outputs[0].transform)
  })
})

/* ------------------------------------------------------------ resolution */

describe('placement resolution', () => {
  test('deduplicates across overlapping presets', () => {
    const resolved = resolvePlacements({ presets: ['meta-fanout', 'social-core'] })
    const ids = resolved.map((p) => p.id)
    assert.equal(new Set(ids).size, ids.length, 'duplicate placements in resolution')
  })

  test('filters out placements that cannot carry the medium', () => {
    const resolved = resolvePlacements({ placements: ['meta_reels', 'meta_feed_square'], medium: 'image' })
    assert.deepEqual(resolved.map((p) => p.id), ['meta_feed_square'])
  })
})

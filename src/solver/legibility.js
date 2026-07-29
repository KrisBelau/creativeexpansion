/**
 * Legibility enforcement (SPEC 7.1, 7.2).
 *
 * This is the module the product's central claim rests on: type that would land
 * below the floor for its viewing context produces a `blocked` finding, and
 * blocked outputs never reach the export path.
 *
 * On the protected-crop track the type is baked into the pixels, so there is no
 * option to re-set it larger — the only honest outcomes are "it survives the
 * scale factor", "drop it", or "this placement cannot carry this creative".
 */
import { roleFloor, legibilityFor, legibility } from '../registry.js'
import { mapRect, safeArea, contains, coverage, area, intersect } from './geometry.js'
import { contrastRatio } from '../analysis/pixels.js'

/**
 * @param {object} args
 * @param {object} args.analysis
 * @param {object} args.placement
 * @param {object} args.transform  {kind:'crop', crop} or {kind:'fit', placed, scale}
 * @returns {{findings: object[], measurements: object[]}}
 */
export function checkLegibility({ analysis, placement, transform }) {
  const findings = []
  const measurements = []
  const ctx = legibilityFor(placement)
  const canvas = placement.canvas
  const zone = safeArea(canvas, placement.safeZone)
  const textRegions = analysis.regions.filter((r) => r.type === 'text')

  const scale = scaleOf(transform, canvas)

  for (const region of textRegions) {
    const outBox = toOutput(region.box, transform, canvas, region.id)
    // An element the re-layout dropped is not in the output, so there is nothing
    // to measure — the drop itself is already reported as a finding.
    if (!outBox) continue
    const renderedCap = region.capHeight * scaleFor(transform, scale, region.id)
    const floor = roleFloor(placement, region.role)

    const m = {
      regionId: region.id,
      role: region.role,
      sourceCapPx: round(region.capHeight),
      renderedCapPx: round(renderedCap),
      floorPx: floor ? round(floor.minPx) : null,
      ratio: floor ? round(renderedCap / floor.minPx) : null,
      confidence: region.confidence,
      sourceContrast: region.sourceContrast ?? null,
      box: outBox,
    }
    measurements.push(m)

    if (!floor) continue

    // --- size floor -------------------------------------------------------
    if (renderedCap < floor.minPx) {
      const shortfall = Math.round((1 - renderedCap / floor.minPx) * 100)

      // Same principle as the contrast check: blocked means "defective as
      // produced". If the type was not shrunk, its size is inherited from the
      // master and the resize did not cause the problem — the master simply has
      // type too small for this viewing context. Blocking there would fail an
      // identity transform, which is never the pipeline's fault.
      const notShrunk = scale >= 0.995
      let severity = 'blocked'
      let explanation = suggestion(region, floor, placement)
      if (notShrunk) {
        severity = 'warn'
        explanation = ` The type was not scaled down (${(scale * 100).toFixed(0)}%), so the master itself carries type below this context's floor — the resize did not cause it.`
      }
      if (region.confidence < 0.45) {
        severity = 'warn'
        explanation = ' Detection confidence is low, so this is a warning — confirm the region.'
      }

      findings.push({
        code: notShrunk ? `type_below_floor_inherited_${region.role}` : `type_below_floor_${region.role}`,
        severity,
        message:
          `${label(region.role)} renders at ${renderedCap.toFixed(1)}px cap height, ${shortfall}% below the ` +
          `${floor.minPx.toFixed(1)}px floor for ${ctx.label}.` +
          (notShrunk ? '' : cause(transform, placement)) +
          explanation,
        regionRef: region.id,
        measurement: m,
        suggestedFix: fixFor(region, floor, placement),
      })
    }

    // --- prohibited role on tiny canvases ---------------------------------
    if (floor.prohibitedUnderCanvasHeight && canvas.h < floor.prohibitedUnderCanvasHeight) {
      findings.push({
        code: `role_prohibited_${region.role}`,
        severity: 'blocked',
        message: `${label(region.role)} is not permitted on a canvas under ${floor.prohibitedUnderCanvasHeight}px tall. Drop it for this size.`,
        regionRef: region.id,
        suggestedFix: { action: 'drop', regionId: region.id },
      })
    }

    // --- safe zone --------------------------------------------------------
    if (zone.w < canvas.w || zone.h < canvas.h) {
      if (!contains(zone, outBox, 1)) {
        const inZone = 1 - coverage(zone, outBox)
        findings.push({
          code: 'text_in_safe_zone',
          severity: 'blocked',
          message: `${label(region.role)} has ${(inZone * 100).toFixed(0)}% of its area inside the platform UI safe zone and would be covered by ${placement.platformName} chrome.`,
          regionRef: region.id,
          suggestedFix: { action: 'reanchor', regionId: region.id },
        })
      } else {
        // Soft band: penalised but shippable (SPEC 7.3).
        const soft = softZone(canvas, placement.safeZone)
        if (!contains(soft, outBox, 1)) {
          findings.push({
            code: 'text_in_soft_safe_zone',
            severity: 'warn',
            message: `${label(region.role)} sits within the soft margin around the safe zone. Legal but tight.`,
            regionRef: region.id,
          })
        }
      }
    }

    // --- edge padding -----------------------------------------------------
    const padFloor = edgePadFloor(canvas)
    const padded = {
      x: padFloor,
      y: padFloor,
      w: canvas.w - padFloor * 2,
      h: canvas.h - padFloor * 2,
    }
    if (!contains(padded, outBox, 1)) {
      findings.push({
        code: 'text_edge_padding',
        severity: 'warn',
        message: `${label(region.role)} sits within ${padFloor}px of the canvas edge (minimum ${padFloor}px). Type touching the frame reads as an accident.`,
        regionRef: region.id,
      })
    }
  }

  // --- set-level checks ----------------------------------------------------
  if (textRegions.length) {
    const coverageRatio =
      textRegions.reduce((a, r) => {
        const b = toOutput(r.box, transform, canvas, r.id)
        return a + (b ? area(b) : 0)
      }, 0) / (canvas.w * canvas.h)
    if (coverageRatio > legibility.composition.maxTextCoveragePct / 100) {
      findings.push({
        code: 'text_coverage_high',
        severity: 'warn',
        message: `Type covers ${(coverageRatio * 100).toFixed(0)}% of the canvas (comfort ceiling ${legibility.composition.maxTextCoveragePct}%). Cluttered, and it correlates with weak delivery.`,
      })
    }
  }

  const maxWords = ctx.maxWordsOnScreen
  if (maxWords && textRegions.length > maxWords) {
    findings.push({
      code: 'too_many_elements_for_context',
      severity: 'warn',
      message: `${textRegions.length} type elements for ${ctx.label}, which tolerates about ${maxWords} words total.`,
    })
  }

  // Regions already blocked on size: the contrast pass skips these so one defect
  // produces one finding rather than a pile of them.
  const sizeBlocked = new Set(
    findings
      .filter((f) => f.severity === 'blocked' && /^type_below_floor|^role_prohibited/.test(f.code))
      .map((f) => f.regionRef)
  )

  if (findings.some((f) => f.code.startsWith('type_below_floor_inherited'))) {
    findings.push({
      code: 'master_type_below_context_floor',
      severity: 'warn',
      message: `One or more elements are below the ${ctx.label} floor in the master itself. Either the master needs larger type for this context, or a region's role is mislabelled — a logo wordmark read as body copy is the usual cause.`,
    })
  }

  return { findings, measurements, sizeBlocked }
}

/**
 * Local contrast per text region against the pixels actually behind it in the
 * rendered output (SPEC 7.2). Sampled from the rendered buffer, not the source,
 * so extension and resampling are accounted for.
 */
export function checkContrast({ placement, measurements, sampler, skipRegions = new Set() }) {
  const findings = []
  const cfg = legibility.contrast

  for (const m of measurements) {
    const floor = roleFloor(placement, m.role)
    if (!floor) continue
    // Type that already failed its size floor is blocked on better grounds, and
    // a sub-pixel box cannot be sampled meaningfully — reporting a contrast
    // number for it would be noise dressed up as a measurement.
    if (skipRegions.has(m.regionId)) continue
    if (m.renderedCapPx < 4) continue

    const sample = sampler(m.box)
    if (!sample) continue

    const isLarge = m.renderedCapPx >= floor.minPx * cfg.largeTextMultiplier
    const required = isLarge ? cfg.largeTextRatio : cfg.smallTextRatio
    const ratio = contrastRatio(sample.ink, sample.paper)

    // Blocked means "this output is defective as produced". Contrast does not
    // change under uniform scaling, so when the master fails the same threshold
    // the output is faithfully reproducing an upstream problem — that is a
    // warning plus a source-level finding, not 40 blocked placements over one
    // brand-colour decision. Blocking is reserved for contrast the pipeline
    // itself introduced (a darkened blur-extend behind type, say).
    const inherited = m.sourceContrast != null && m.sourceContrast < required
    let severity = inherited ? 'warn' : 'blocked'
    if ((m.confidence ?? 1) < 0.45) severity = 'warn'

    if (ratio < required) {
      const because = inherited
        ? ` The master has the same ${m.sourceContrast.toFixed(2)}:1 contrast, so resizing did not cause this — fix it upstream.`
        : ' Apply a scrim or move it.'
      findings.push({
        code: inherited ? 'contrast_below_floor_inherited' : 'contrast_below_floor',
        severity,
        message:
          `${label(m.role)} has ${ratio.toFixed(2)}:1 local contrast against its background ` +
          `(minimum ${required}:1 for ${isLarge ? 'large' : 'small'} type at this size).` +
          because +
          (severity === 'warn' && (m.confidence ?? 1) < 0.45 ? ' Detection confidence is also low — confirm the region.' : ''),
        regionRef: m.regionId,
        suggestedFix: { action: 'scrim', regionId: m.regionId },
      })
    } else if (sample.busyness > cfg.busyBackgroundEnergyThreshold) {
      findings.push({
        code: 'text_over_busy_background',
        severity: 'warn',
        message: `${label(m.role)} passes contrast (${ratio.toFixed(2)}:1) but sits on detail busy enough to hurt readability (energy ${sample.busyness.toFixed(2)}).`,
        regionRef: m.regionId,
        suggestedFix: { action: 'scrim', regionId: m.regionId },
      })
    }
  }
  return findings
}

/* ------------------------------------------------------------------ helpers */

function toOutput(box, transform, canvas, regionId) {
  if (transform.kind === 'relayout') {
    // Each element has its own destination; there is no single global mapping.
    const el = transform.layout.elements.find((e) => e.regionId === regionId)
    // boxDst is the region's own ink; dst includes the surrounding ground that
    // travels with the element and must not be measured as content.
    return el ? { ...(el.boxDst ?? el.dst) } : null
  }
  if (transform.kind === 'crop') return mapRect(box, transform.crop, canvas.w, canvas.h)
  const { placed, scale } = transform
  return {
    x: placed.x + box.x * scale,
    y: placed.y + box.y * scale,
    w: box.w * scale,
    h: box.h * scale,
  }
}

function scaleOf(transform, canvas) {
  if (transform.kind === 'crop') return canvas.w / transform.crop.w
  return transform.scale
}

function softZone(canvas, safeZone) {
  const k = legibility.composition.softSafeZoneMultiplier
  const s = safeZone ?? {}
  return safeArea(canvas, {
    top: (s.top ?? 0) * k,
    right: (s.right ?? 0) * k,
    bottom: (s.bottom ?? 0) * k,
    left: (s.left ?? 0) * k,
  })
}

export function edgePadFloor(canvas) {
  const short = Math.min(canvas.w, canvas.h)
  const c = legibility.composition
  if (short < c.smallCanvasThreshold) return c.minEdgePaddingPxFloor
  return Math.round((c.minEdgePaddingPct / 100) * short)
}

/**
 * Name the reason the type shrank. "Supply a layered source" is the right advice
 * either way, but a reviewer can only act on it if they know whether the driver
 * was the target's aspect ratio or its UI safe zone.
 */
/** Uniform for crop and fit; per-element for re-layout (though currently equal). */
function scaleFor(transform, globalScale, regionId) {
  if (transform.kind !== 'relayout') return globalScale
  const el = transform.layout.elements.find((e) => e.regionId === regionId)
  return el && el.src.h > 0 ? el.dst.h / el.src.h : globalScale
}

function cause(transform, placement) {
  if (transform.kind === 'relayout') {
    return ` Elements were re-laid-out at ${(transform.scale * 100).toFixed(0)}% and this one still falls short.`
  }
  if (transform.kind === 'crop') return ''
  const s = placement.safeZone ?? {}
  const inset = (s.top ?? 0) + (s.bottom ?? 0) + (s.left ?? 0) + (s.right ?? 0)
  if (inset > 0) {
    return ` The creative had to be fitted inside the ${placement.platformName} safe zone (insets ${s.top ?? 0}/${s.right ?? 0}/${s.bottom ?? 0}/${s.left ?? 0}px), which scaled it to ${(transform.scale * 100).toFixed(0)}%.`
  }
  return ` The creative had to be fitted rather than cropped to reach ${placement.aspect}, scaling it to ${(transform.scale * 100).toFixed(0)}%.`
}

function suggestion(region, floor, placement) {
  const needed = floor.minPx / region.capHeight
  const impliedShort = Math.round(Math.min(placement.canvas.w, placement.canvas.h) * needed)
  if (floor.belowFloor === 'drop' || floor.droppable) {
    return ` Drop ${region.role} for this size, or supply a layered source so the type can be re-set rather than scaled.`
  }
  if (floor.belowFloor === 'legal_review') {
    return ` Legal copy cannot be shrunk below the floor — move it to the landing page and clear the change with legal.`
  }
  return ` This creative would need a canvas of at least ~${impliedShort}px on the short side to carry this type at the crop scale. Supply a layered source to re-set the type instead.`
}

function fixFor(region, floor, placement) {
  if (floor.droppable || floor.belowFloor === 'drop') return { action: 'drop', regionId: region.id }
  if (floor.belowFloor === 'legal_review') return { action: 'legal_review', regionId: region.id }
  return { action: 'relayout', regionId: region.id, note: 'requires layered source' }
}

const LABELS = {
  headline: 'Headline',
  subhead: 'Subhead',
  body: 'Body copy',
  cta: 'CTA label',
  price: 'Price',
  legal: 'Legal line',
}
const label = (role) => LABELS[role] ?? role
const round = (v) => Math.round(v * 100) / 100

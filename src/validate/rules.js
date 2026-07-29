/**
 * Preflight validation (SPEC 11). Findings are `info` / `warn` / `blocked`.
 * Blocked outputs cannot be exported — enforced in src/export.js, not here.
 */
import sharp from 'sharp'
import { legibility, byteCeiling, safeZoneOf } from '../registry.js'
import { safeArea, contains, mapRect, coverage } from '../solver/geometry.js'
import { edgePadFloor } from '../solver/legibility.js'

export const SEVERITY_ORDER = { blocked: 3, warn: 2, info: 1 }

export function worstSeverity(findings) {
  let worst = null
  for (const f of findings) {
    if (!worst || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[worst]) worst = f.severity
  }
  return worst
}

export function stateOf(findings) {
  const worst = worstSeverity(findings)
  if (worst === 'blocked') return 'blocked'
  if (worst === 'warn') return 'warn'
  return 'pass'
}

/** Checks that need the encoded bytes in hand. */
export async function validateOutput({ buffer, format, placement, analysis, transform, extension }) {
  const findings = []
  const canvas = placement.canvas
  const meta = await sharp(buffer).metadata()

  // --- platform conformance ------------------------------------------------
  if (meta.width !== canvas.w || meta.height !== canvas.h) {
    findings.push({
      code: 'dimension_mismatch',
      severity: 'blocked',
      message: `Rendered ${meta.width}x${meta.height}, expected ${canvas.w}x${canvas.h}.`,
    })
  }

  const ceiling = byteCeiling(placement)
  if (ceiling && buffer.length > ceiling) {
    findings.push({
      code: 'byte_ceiling_exceeded',
      severity: 'blocked',
      message: `${kb(buffer.length)} exceeds the ${kb(ceiling)} ceiling for ${placement.name}.`,
    })
  }

  const allowed = placement.image?.encodings ?? []
  const normalised = format === 'jpg' ? 'jpg' : format
  if (allowed.length && !allowed.includes(normalised)) {
    findings.push({
      code: 'encoding_not_permitted',
      severity: 'blocked',
      message: `${placement.name} accepts ${allowed.join('/')}, produced ${normalised}.`,
    })
  }

  // --- craft ---------------------------------------------------------------
  const scale =
    transform.kind === 'crop' ? canvas.w / transform.crop.w : transform.scale
  const craft = legibility.craft
  if (scale > craft.maxUpscaleBlock) {
    findings.push({
      code: 'upscale_excessive',
      severity: 'blocked',
      message: `Requires ${(scale * 100).toFixed(0)}% upscale (block above ${craft.maxUpscaleBlock * 100}%). Supply a larger master.`,
    })
  } else if (scale > craft.maxUpscaleWarn * 1.001) {
    findings.push({
      code: 'upscale_warn',
      severity: 'warn',
      message: `Upscaled to ${(scale * 100).toFixed(0)}% of source resolution. Detail is interpolated, not real.`,
    })
  }

  if (extension && extension.strategy !== 'none') {
    if (extension.seamScore > craft.seamScoreWarn) {
      findings.push({
        code: 'extension_seam',
        severity: 'warn',
        message: `${extension.strategy} extension seam score ${extension.seamScore.toFixed(3)} (comfort ${craft.seamScoreWarn}).`,
      })
    }
    findings.push(...(extension.notes ?? []))
  }

  // --- content integrity ---------------------------------------------------
  const zone = safeArea(canvas, safeZoneOf(placement))
  for (const region of analysis.regions) {
    if (region.type !== 'logo') continue
    const mapped = toOutput(region.box, transform, canvas, region.id)
    if (!mapped) continue // dropped by the re-layout; reported there
    if (!contains({ x: 0, y: 0, w: canvas.w, h: canvas.h }, mapped, 1)) {
      findings.push({
        code: 'logo_clipped',
        severity: 'blocked',
        message: 'The logo is clipped by the canvas edge.',
        regionRef: region.id,
      })
    } else if (!contains(zone, mapped, 1)) {
      findings.push({
        code: 'logo_in_safe_zone',
        severity: 'blocked',
        message: `The logo sits inside the ${placement.platformName} UI safe zone and would be covered.`,
        regionRef: region.id,
      })
    }
    const padFloor = edgePadFloor(canvas)
    const padded = { x: padFloor, y: padFloor, w: canvas.w - padFloor * 2, h: canvas.h - padFloor * 2 }
    if (!contains(padded, mapped, 1)) {
      findings.push({
        code: 'logo_edge_padding',
        severity: 'warn',
        message: `The logo sits within ${padFloor}px of the canvas edge.`,
        regionRef: region.id,
      })
    }
  }

  if (!analysis.logo.found) {
    findings.push({
      code: 'logo_not_verified',
      severity: 'info',
      message: 'No logo reference in the brand kit, so logo protection could not be applied. Supply one to make the guarantee real.',
    })
  }

  for (const region of analysis.regions) {
    if (region.protection !== 'protected' || region.type === 'subject') continue
    const mapped = toOutput(region.box, transform, canvas, region.id)
    if (!mapped) continue // dropped by the re-layout; reported there
    const kept = coverage({ x: 0, y: 0, w: canvas.w, h: canvas.h }, mapped)
    if (kept < craft.minProductCoverage) {
      findings.push({
        code: 'protected_region_clipped',
        severity: 'blocked',
        message: `${region.type} region "${region.id}" retains only ${(kept * 100).toFixed(0)}% of its area (minimum ${craft.minProductCoverage * 100}%).`,
        regionRef: region.id,
      })
    }
  }

  // --- platform content policy --------------------------------------------
  if (placement.id === 'amz_sd_custom_image') {
    const textCount = analysis.regions.filter((r) => r.type === 'text').length
    if (textCount) {
      findings.push({
        code: 'text_prohibited',
        severity: 'blocked',
        message: `${placement.name} prohibits text, logos and CTAs in the image; ${textCount} type regions were detected.`,
      })
    }
  }

  return findings
}

/** Set-level assertions across a whole batch (SPEC 11 "set-level"). */
export function validateSet(outputs) {
  const findings = []
  const names = new Map()
  for (const o of outputs) {
    if (names.has(o.filename)) {
      findings.push({
        code: 'naming_collision',
        severity: 'blocked',
        message: `Two outputs resolve to the same filename: ${o.filename} (${names.get(o.filename)} and ${o.placementId}).`,
      })
    }
    names.set(o.filename, o.placementId)
  }

  // Google's responsive asset family is only usable when it is complete.
  const googleRequired = ['goog_asset_landscape', 'goog_asset_square']
  const googlePresent = outputs.filter((o) => o.placementId.startsWith('goog_asset_'))
  if (googlePresent.length) {
    const missing = googleRequired.filter(
      (id) => !outputs.some((o) => o.placementId === id && o.state !== 'blocked')
    )
    if (missing.length) {
      findings.push({
        code: 'asset_family_incomplete',
        severity: 'warn',
        message: `Google responsive asset set is missing required members: ${missing.join(', ')}.`,
      })
    }
  }

  // Carousel cards must agree on canvas.
  const carousel = outputs.filter((o) => /carousel/.test(o.placementId))
  const canvases = new Set(carousel.map((o) => `${o.width}x${o.height}`))
  if (canvases.size > 1) {
    findings.push({
      code: 'carousel_inconsistent',
      severity: 'blocked',
      message: `Carousel cards must share one canvas; found ${[...canvases].join(', ')}.`,
    })
  }

  return findings
}

function toOutput(box, transform, canvas, regionId) {
  if (transform.kind === 'relayout') {
    const el = transform.layout.elements.find((e) => e.regionId === regionId)
    // boxDst is the region's own ink; dst includes the surrounding ground that
    // travels with the element and must not be measured as content.
    return el ? { ...(el.boxDst ?? el.dst) } : null
  }
  if (transform.kind === 'crop') return mapRect(box, transform.crop, canvas.w, canvas.h)
  const { placed, scale } = transform
  return { x: placed.x + box.x * scale, y: placed.y + box.y * scale, w: box.w * scale, h: box.h * scale }
}

const kb = (n) => `${Math.round(n / 1024)} KB`

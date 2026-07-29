/**
 * Protected crop solver (SPEC 6.6).
 *
 * Searches scale and translation for the crop window that retains the most
 * saliency, subject to hard constraints that cannot be traded away:
 *
 *   - every immutable region (type, logo) lies wholly inside the crop
 *   - protected regions keep at least `minProductCoverage` of their area
 *   - after mapping to the output canvas, no protected content sits inside the
 *     placement's safe zone
 *   - scale is uniform; the crop's aspect ratio always equals the canvas's
 *
 * If no crop satisfies them, the caller falls back to fit-with-extension, which
 * preserves everything at a smaller scale and lets the background do the work.
 * That is always better than shipping a crop through a headline.
 */
import {
  rect,
  contains,
  coverage,
  intersect,
  union,
  area,
  mapRect,
  safeArea,
  overlaps,
  right,
  bottom,
} from './geometry.js'
import { legibility } from '../registry.js'

const SCALE_STEPS = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52, 0.46, 0.4]
const POSITION_STEPS = 13

/**
 * @returns {{crop, score, retention, feasible, relaxed, notes}} crop is in source pixels.
 */
export function solveCrop({ analysis, placement, anchorBias = 'auto' }) {
  const src = analysis.source
  const canvas = placement.canvas
  const targetAspect = canvas.w / canvas.h
  const integral = analysis.maps.saliency.integral()
  const proxyScale = analysis.proxies.saliency.scale

  const immutable = analysis.regions.filter((r) => r.protection === 'immutable')
  const protectedR = analysis.regions.filter((r) => r.protection === 'protected')
  const minCoverage = legibility.craft.minProductCoverage

  const zone = safeArea(canvas, placement.safeZone)
  const hasSafeZone = zone.w < canvas.w || zone.h < canvas.h

  const candidates = []
  for (const scaleStep of SCALE_STEPS) {
    // Largest window of the target aspect that fits the source, shrunk by the step.
    const full = largestWindow(src, targetAspect)
    const w = full.w * scaleStep
    const h = full.h * scaleStep
    if (w < 16 || h < 16) continue

    const xs = spread(0, src.w - w, POSITION_STEPS)
    const ys = spread(0, src.h - h, POSITION_STEPS)

    for (const y of ys) {
      for (const x of xs) {
        const crop = rect(x, y, w, h)

        // --- hard constraints -------------------------------------------------
        let ok = true
        for (const r of immutable) {
          if (!contains(crop, r.box, 0.5)) {
            ok = false
            break
          }
        }
        if (!ok) continue
        for (const r of protectedR) {
          if (coverage(crop, r.box) < minCoverage) {
            ok = false
            break
          }
        }
        if (!ok) continue

        if (hasSafeZone) {
          let violates = false
          for (const r of immutable) {
            const mapped = mapRect(r.box, crop, canvas.w, canvas.h)
            if (!contains(zone, mapped, 0.5)) {
              violates = true
              break
            }
          }
          if (violates) continue
        }

        // --- objective --------------------------------------------------------
        const proxyCrop = {
          x: crop.x * proxyScale,
          y: crop.y * proxyScale,
          w: crop.w * proxyScale,
          h: crop.h * proxyScale,
        }
        const retention = integral.sum(proxyCrop) / Math.max(1e-6, analysis.maps.saliency.total())
        const scaleReward = (crop.w * crop.h) / (src.w * src.h) // prefer less throwing away
        const anchorScore = anchorTerm(crop, src, immutable, protectedR, anchorBias)

        candidates.push({
          crop,
          retention,
          score: 0.62 * retention + 0.22 * scaleReward + 0.16 * anchorScore,
        })
      }
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]
    return {
      crop: best.crop,
      score: round(best.score),
      retention: round(best.retention),
      feasible: true,
      strategy: 'crop',
      notes: [],
    }
  }

  // Infeasible: report why, so the renderer can pick fit-with-extension and the
  // review UI can explain the decision rather than silently changing approach.
  return {
    crop: null,
    feasible: false,
    strategy: 'fit',
    score: 0,
    retention: 1,
    notes: [diagnoseInfeasibility({ src, canvas, targetAspect, immutable, protectedR, zone, hasSafeZone })],
  }
}

function largestWindow(src, targetAspect) {
  const srcAspect = src.w / src.h
  return srcAspect > targetAspect
    ? rect(0, 0, src.h * targetAspect, src.h)
    : rect(0, 0, src.w, src.w / targetAspect)
}

function spread(lo, hi, steps) {
  if (hi <= lo + 1e-6) return [lo]
  const out = []
  for (let i = 0; i < steps; i++) out.push(lo + ((hi - lo) * i) / (steps - 1))
  return out
}

/**
 * Composition preference. Faces would drive this if v0 had face detection; with
 * what it does have, keep the subject's centre near the frame's upper third and
 * keep type comfortably off the edges.
 */
function anchorTerm(crop, src, immutable, protectedR, bias) {
  const subject = protectedR.find((r) => r.type === 'subject')
  let score = 0.5

  if (subject) {
    const sc = { x: subject.box.x + subject.box.w / 2, y: subject.box.y + subject.box.h / 2 }
    const rel = { x: (sc.x - crop.x) / crop.w, y: (sc.y - crop.y) / crop.h }
    const targetY = bias === 'centre' ? 0.5 : 0.42
    const dx = Math.abs(rel.x - 0.5)
    const dy = Math.abs(rel.y - targetY)
    score = 1 - Math.min(1, dx * 1.2 + dy * 1.2)
  }

  // Penalise crops that bring type within 2% of the crop edge — even when it is
  // technically inside, type touching the frame edge reads as an accident.
  const margin = Math.min(crop.w, crop.h) * 0.02
  for (const r of immutable) {
    if (!contains(rect(crop.x + margin, crop.y + margin, crop.w - margin * 2, crop.h - margin * 2), r.box)) {
      score -= 0.15
    }
  }
  return Math.max(0, Math.min(1, score))
}

function diagnoseInfeasibility({ src, canvas, targetAspect, immutable, protectedR, zone, hasSafeZone }) {
  const srcAspect = src.w / src.h
  const contentBox = union([...immutable, ...protectedR].map((r) => r.box))

  if (!contentBox) {
    return {
      code: 'crop_infeasible_geometry',
      message: `No crop of ratio ${targetAspect.toFixed(2)}:1 fits the ${src.w}x${src.h} source.`,
    }
  }

  const contentAspect = contentBox.w / contentBox.h
  if (contentAspect > targetAspect * 1.02) {
    return {
      code: 'crop_infeasible_content_too_wide',
      message: `Protected content spans ${Math.round(contentBox.w)}x${Math.round(contentBox.h)}px (ratio ${contentAspect.toFixed(2)}:1), wider than the ${targetAspect.toFixed(2)}:1 target. Fitting with background extension instead of cropping.`,
    }
  }
  if (contentAspect < targetAspect * 0.98) {
    return {
      code: 'crop_infeasible_content_too_tall',
      message: `Protected content spans ${Math.round(contentBox.w)}x${Math.round(contentBox.h)}px (ratio ${contentAspect.toFixed(2)}:1), taller than the ${targetAspect.toFixed(2)}:1 target. Fitting with background extension instead of cropping.`,
    }
  }
  if (hasSafeZone) {
    return {
      code: 'crop_infeasible_safe_zone',
      message: `Protected content cannot be positioned clear of the ${canvas.w}x${canvas.h} safe zone by cropping alone. Fitting with background extension instead.`,
    }
  }
  return {
    code: 'crop_infeasible',
    message: 'No crop satisfies the protection constraints. Fitting with background extension instead.',
  }
}

/**
 * Fit-with-extension geometry: the source is scaled to sit wholly inside the
 * canvas (optionally inside the safe area), and the pad bands get filled by the
 * extension stage.
 */
export function solveFit({ analysis, placement, respectSafeZone = true }) {
  const src = analysis.source
  const canvas = placement.canvas
  const zone = respectSafeZone ? safeArea(canvas, placement.safeZone) : rect(0, 0, canvas.w, canvas.h)

  const k = Math.min(zone.w / src.w, zone.h / src.h)
  const w = src.w * k
  const h = src.h * k
  const x = zone.x + (zone.w - w) / 2
  const y = zone.y + (zone.h - h) / 2

  return {
    strategy: 'fit',
    placed: rect(x, y, w, h),
    scale: k,
    padded: {
      top: Math.round(y),
      left: Math.round(x),
      right: Math.round(canvas.w - (x + w)),
      bottom: Math.round(canvas.h - (y + h)),
    },
  }
}

const round = (v) => Math.round(v * 1000) / 1000

/**
 * Background extension (SPEC 6.4).
 *
 * Picks the cheapest strategy that the background class admits, scores the seam
 * it would leave, and steps down the preference list when the seam is visible.
 * `flat` and `gradient` are exact for designed creative, which is why extension
 * is usually invisible rather than a compromise.
 *
 * Returns a plan; src/render/image.js executes it.
 */
import { legibility } from '../registry.js'
import { toHex } from '../analysis/background.js'

const ORDER = ['flat', 'gradient', 'mirror', 'blur', 'matte']

/**
 * Admissibility is judged per edge, not per image. An ad is very often a flat
 * ground carrying type and a product: globally it looks "photographic" because
 * of all that detail, while each individual border strip is a plain colour that
 * can be extended exactly. Judging globally throws away the best strategy
 * available on most real creative.
 */
const ADMISSIBLE = {
  flat: (edge) => edge.flatness > 0.8 && edge.rampMagnitude < 8,
  gradient: (edge) => edge.flatness > 0.55,
  mirror: (edge) => edge.flatness > 0.2,
  blur: () => true,
  matte: () => true,
}

/**
 * @param {object} args
 * @param {object} args.analysis
 * @param {object} args.placement
 * @param {{top:number,right:number,bottom:number,left:number}} args.pad  pixels to fill per side
 * @param {string[]} args.allowed  strategies permitted by recipe policy
 * @param {string|null} args.matteColour  brand matte colour, if the kit supplies one
 */
export function planExtension({ analysis, placement, pad, allowed = ORDER, matteColour = null }) {
  const needed = pad.top > 0 || pad.right > 0 || pad.bottom > 0 || pad.left > 0
  if (!needed) return { strategy: 'none', seamScore: 0, perSide: {}, notes: [] }

  const bg = analysis.background
  const notes = []
  const canvasShort = Math.min(placement.canvas.w, placement.canvas.h)
  const sides = ['top', 'right', 'bottom', 'left'].filter((s) => pad[s] > 0)

  const perSide = {}
  const chosen = new Set()
  let worstSeam = 0

  for (const side of sides) {
    const edge = bg.edges[side]
    let picked = null

    for (const strategy of ORDER) {
      if (!allowed.includes(strategy)) continue
      if (!ADMISSIBLE[strategy](edge)) continue
      const plan = buildSide(strategy, { side, edge, bg, pad, matteColour, canvasShort, analysis })
      if (!plan) continue
      if (plan.seamScore > legibility.craft.seamScoreReject) {
        notes.push({
          code: 'extension_rejected',
          severity: 'info',
          message: `${strategy} extension on the ${side} edge would leave a visible seam (score ${plan.seamScore.toFixed(3)}); stepping down.`,
        })
        continue
      }
      picked = { strategy, ...plan }
      break
    }

    if (!picked) {
      picked = {
        strategy: 'matte',
        seamScore: 0,
        ...buildSide('matte', { side, edge, bg, pad, matteColour, canvasShort, analysis }),
      }
      notes.push({
        code: 'extension_forced_matte',
        severity: 'warn',
        message: `No content-aware strategy was admissible on the ${side} edge; using a flat matte there.`,
      })
    }

    if (picked.seamScore > legibility.craft.seamScoreWarn) {
      notes.push({
        code: 'extension_seam_visible',
        severity: 'warn',
        message: `${picked.strategy} extension on the ${side} edge scores ${picked.seamScore.toFixed(3)}, above the ${legibility.craft.seamScoreWarn} comfort threshold. Check the join.`,
      })
    }

    chosen.add(picked.strategy)
    worstSeam = Math.max(worstSeam, picked.seamScore)
    const { strategy, seamScore, ...cfg } = picked
    perSide[side] = { strategy, ...cfg }
  }

  // `mirror` and `blur` are whole-canvas operations in the renderer, so if any
  // side needs one, it governs the composite and the others ride along.
  const strategy = chosen.has('blur')
    ? 'blur'
    : chosen.has('mirror')
      ? 'mirror'
      : chosen.has('gradient')
        ? 'gradient'
        : chosen.has('flat')
          ? 'flat'
          : 'matte'

  const result = { strategy, perSide, seamScore: round(worstSeam), notes, sideStrategies: [...chosen] }
  if (strategy === 'blur') {
    result.blur = { sigma: Math.max(8, canvasShort * 0.035), darken: 0.88 }
  }
  if (strategy === 'matte') {
    result.fill = matteColour ?? toHex(dominantNonSubject(analysis))
  }
  return result
}

/** Plan one edge. Returns null when the strategy cannot serve this edge at all. */
function buildSide(strategy, { side, edge, bg, pad, matteColour, canvasShort, analysis }) {
  const padRatio = pad[side] / canvasShort

  switch (strategy) {
    case 'flat':
      // A flat fill's seam is exactly the strip's own deviation from its median.
      return { fill: toHex(edge.median), seamScore: round(edge.sd / 255) }

    case 'gradient': {
      // Extrapolate the strip's inner->outer ramp outward by the pad distance.
      const stripPx = bg.stripPx / Math.max(1e-6, analysis.proxies.saliency.scale)
      const perPx = edge.outer.map((c, i) => (c - edge.inner[i]) / Math.max(1, stripPx / 2))
      const far = edge.outer.map((c, i) => clamp255(c + perPx[i] * pad[side]))
      return {
        from: toHex(edge.outer),
        to: toHex(far),
        seamScore: round((edge.sd / 255) * 0.7),
      }
    }

    case 'mirror':
      // Mirroring is seamless at the join by construction; the risk is that it
      // duplicates recognisable content, which shows up as strip structure. A
      // long mirror is far more likely to read as one.
      return {
        mode: 'reflect',
        seamScore: round((edge.sd / 255) * (0.4 + padRatio * 2.2)),
      }

    case 'blur':
      if (padRatio > 0.33) return null // SPEC 6.4: blur-extend only up to a third
      return { mode: 'blur', seamScore: round(0.02 + padRatio * 0.08) }

    case 'matte':
      return { fill: matteColour ?? toHex(dominantNonSubject(analysis)), seamScore: 0 }

    default:
      return null
  }
}

function dominantNonSubject(analysis) {
  // Prefer the palette entry closest to the border colour: it reads as the
  // creative's ground rather than as an arbitrary accent.
  const border = analysis.background.edges.top.median
  let best = analysis.palette[0]?.rgb ?? [240, 240, 240]
  let bestD = Infinity
  for (const p of analysis.palette) {
    const d = (p.rgb[0] - border[0]) ** 2 + (p.rgb[1] - border[1]) ** 2 + (p.rgb[2] - border[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = p.rgb
    }
  }
  return best
}

const clamp255 = (v) => Math.max(0, Math.min(255, v))
const round = (v) => Math.round(v * 10000) / 10000

export { ORDER as EXTENSION_ORDER }

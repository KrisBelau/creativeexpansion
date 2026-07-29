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
 * `flat` and `gradient` are drawn as independent bands per edge, so each edge can
 * choose for itself. `mirror` and `blur` are whole-canvas operations in the
 * renderer, so one of them governs the entire composite — which means they must
 * be judged against the *largest* pad, never against whichever edge happens to
 * ask for them first. A 60px side strip picking blur used to hijack a 700px band.
 */
const LOCAL = ['flat', 'gradient']
const GLOBAL = ['mirror', 'blur']

/** Beyond this, a whole-canvas strategy is inventing more frame than it is given. */
const GLOBAL_MAX_PAD_RATIO = 0.5

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

  const ctx = { bg, pad, matteColour, canvasShort, analysis }
  const maxPadRatio = Math.max(...sides.map((s) => pad[s] / canvasShort))

  // --- 1. per-edge exact strategies -----------------------------------------
  const local = tryLocal(sides, allowed, ctx, notes)
  if (local) return { ...local, notes }

  // --- 2. one whole-canvas strategy, judged against the largest pad ---------
  if (maxPadRatio <= GLOBAL_MAX_PAD_RATIO) {
    for (const strategy of GLOBAL) {
      if (!allowed.includes(strategy)) continue
      const dominant = sides.reduce((a, b) => (pad[a] >= pad[b] ? a : b))
      if (!ADMISSIBLE[strategy](bg.edges[dominant])) continue

      // Every filled edge must tolerate it, since it governs all of them.
      const plans = sides.map((side) => buildSide(strategy, { side, edge: bg.edges[side], ...ctx }))
      if (plans.some((p) => p === null)) continue
      const seam = Math.max(...plans.map((p) => p.seamScore))

      if (seam > legibility.craft.seamScoreReject) {
        notes.push({
          code: 'extension_rejected',
          severity: 'info',
          message: `${strategy} extension would leave a visible seam (score ${seam.toFixed(3)}); stepping down.`,
        })
        continue
      }
      if (seam > legibility.craft.seamScoreWarn) {
        notes.push({
          code: 'extension_seam_visible',
          severity: 'warn',
          message: `${strategy} extension scores ${seam.toFixed(3)}, above the ${legibility.craft.seamScoreWarn} comfort threshold. Check the join.`,
        })
      }

      const result = {
        strategy,
        perSide: Object.fromEntries(sides.map((s, i) => [s, plans[i]])),
        seamScore: round(seam),
        notes,
      }
      if (strategy === 'blur') result.blur = { sigma: Math.max(8, canvasShort * 0.035), darken: 0.88 }
      return result
    }
  } else {
    notes.push({
      code: 'extension_pad_too_large',
      severity: 'info',
      message: `The largest pad is ${(maxPadRatio * 100).toFixed(0)}% of the short side, past the ${GLOBAL_MAX_PAD_RATIO * 100}% limit for mirror or blur extension. Using a brand matte — a deliberate letterbox beats inventing most of the frame.`,
    })
  }

  // --- 3. brand matte, always available and always safe ---------------------
  notes.push({
    code: 'extension_matte',
    severity: 'warn',
    message: 'No content-aware extension was admissible; the padding is a flat brand matte. Check that the composition reads as deliberate.',
  })
  return {
    strategy: 'matte',
    fill: matteColour ?? toHex(dominantNonSubject(analysis)),
    perSide: {},
    seamScore: 0,
    notes,
  }
}

/** Every filled edge served independently by an exact strategy, or nothing. */
function tryLocal(sides, allowed, ctx, notes) {
  const perSide = {}
  const chosen = new Set()
  let worstSeam = 0

  for (const side of sides) {
    const edge = ctx.bg.edges[side]
    let picked = null
    for (const strategy of LOCAL) {
      if (!allowed.includes(strategy)) continue
      if (!ADMISSIBLE[strategy](edge)) continue
      const plan = buildSide(strategy, { side, edge, ...ctx })
      if (!plan || plan.seamScore > legibility.craft.seamScoreReject) continue
      picked = { strategy, ...plan }
      break
    }
    if (!picked) return null // an exact fill is not available everywhere

    if (picked.seamScore > legibility.craft.seamScoreWarn) {
      notes.push({
        code: 'extension_seam_visible',
        severity: 'warn',
        message: `${picked.strategy} extension on the ${side} edge scores ${picked.seamScore.toFixed(3)}, above the ${legibility.craft.seamScoreWarn} comfort threshold.`,
      })
    }

    chosen.add(picked.strategy)
    worstSeam = Math.max(worstSeam, picked.seamScore)
    const { strategy, seamScore, ...cfg } = picked
    perSide[side] = { strategy, ...cfg }
  }

  return {
    strategy: chosen.has('gradient') ? 'gradient' : 'flat',
    perSide,
    seamScore: round(worstSeam),
    sideStrategies: [...chosen],
  }
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

    case 'blur': {
      if (padRatio > 0.33) return null // SPEC 6.4: blur-extend only up to a third

      // Blur-extend reproduces the whole master behind the sharp copy, so any
      // baked-in type comes back as a smeared but still-recognisable ghost —
      // unmistakably an artefact rather than a designed background. Charge it
      // against the seam score so type-bearing creative steps down to a matte.
      const textCount = (analysis.regions ?? []).filter((r) => r.type === 'text').length
      const ghost = Math.min(0.12, textCount * 0.035)
      return { mode: 'blur', seamScore: round(0.02 + padRatio * 0.08 + ghost) }
    }

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

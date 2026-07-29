/**
 * Background classification, border statistics and palette (SPEC 6.1).
 *
 * The border statistics are the important part: they decide which extension
 * strategies are admissible per edge (SPEC 6.4). An edge whose strip is a flat
 * colour can be extended exactly, with no artefact at all — which is the case
 * for most designed creative, and the reason extension is usually invisible.
 */
import { Grid, boxBlur } from './pixels.js'
import { edgeMap } from './saliency.js'

const STRIP = 0.06 // fraction of the shorter side sampled at each edge

export function analyseBackground(proxy) {
  const { w, h } = proxy.proxy
  const stripPx = Math.max(2, Math.round(Math.min(w, h) * STRIP))

  const edges = {
    top: sampleStrip(proxy, 0, 0, w, stripPx, 'vertical'),
    bottom: sampleStrip(proxy, 0, h - stripPx, w, stripPx, 'vertical'),
    left: sampleStrip(proxy, 0, 0, stripPx, h, 'horizontal'),
    right: sampleStrip(proxy, w - stripPx, 0, stripPx, h, 'horizontal'),
  }

  const global = globalStats(proxy)
  const classification = classify(global, edges)

  return { stripPx, edges, global, classification }
}

/**
 * Statistics for one edge strip. `axis` is the direction along which a gradient
 * would run if this strip is to be extrapolated outward.
 */
function sampleStrip(proxy, x0, y0, sw, sh, axis) {
  const { w } = proxy.proxy
  const { rgb } = proxy
  const px = []
  for (let y = y0; y < y0 + sh; y++) {
    for (let x = x0; x < x0 + sw; x++) {
      const i = (y * w + x) * 3
      px.push([rgb[i], rgb[i + 1], rgb[i + 2]])
    }
  }

  const mean = [0, 1, 2].map((c) => px.reduce((a, p) => a + p[c], 0) / px.length)

  // Robust spread, not standard deviation. A border strip on real creative very
  // often clips a logo or a legal line, and those few percent of outlying pixels
  // inflate an ordinary SD enough to make a plainly flat ground look textured —
  // which then loses the exact-extension strategy. Median absolute deviation
  // ignores them. 1.4826 rescales MAD to be comparable to an SD on normal data.
  const medianOf = (vals) => {
    const s = [...vals].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  const channelMads = [0, 1, 2].map((c) => {
    const vals = px.map((p) => p[c])
    const med = medianOf(vals)
    return medianOf(vals.map((v) => Math.abs(v - med))) * 1.4826
  })
  const sd = Math.sqrt(channelMads.reduce((a, b) => a + b * b, 0) / 3)

  // Gradient: mean colour of the outer half of the strip vs the inner half,
  // measured perpendicular to the edge. A real gradient shows a consistent ramp.
  const halves = splitPerpendicular(proxy, x0, y0, sw, sh, axis)
  const ramp = [0, 1, 2].map((c) => halves.inner[c] - halves.outer[c])
  const rampMagnitude = Math.hypot(...ramp)

  const median = [0, 1, 2].map((c) => medianOf(px.map((p) => p[c])))

  return {
    axis,
    mean: mean.map(Math.round),
    median,
    outer: halves.outer.map(Math.round),
    inner: halves.inner.map(Math.round),
    sd: round(sd),
    rampMagnitude: round(rampMagnitude),
    /** How safely this edge can be extended by simply repeating its colour. */
    flatness: round(clamp01(1 - sd / 24)),
  }
}

/**
 * Mean colour of the strip's outer and inner halves, measured perpendicular to
 * the edge — the ramp between them is what gradient extension extrapolates.
 *
 * Medians, not means: the inner half of a border strip routinely clips a legal
 * line or a logo, and averaging that in fabricates a ramp on a ground that is
 * actually flat. The result is a faint but unmistakable band in the extended
 * area, which is exactly the "resized" tell this product is meant to eliminate.
 */
function splitPerpendicular(proxy, x0, y0, sw, sh, axis) {
  const { w } = proxy.proxy
  const { rgb } = proxy
  const buckets = { outer: [[], [], []], inner: [[], [], []] }

  for (let y = y0; y < y0 + sh; y++) {
    for (let x = x0; x < x0 + sw; x++) {
      const along = axis === 'vertical' ? y - y0 : x - x0
      const extent = axis === 'vertical' ? sh : sw
      // "outer" = the half nearer the canvas edge we are extending away from.
      const nearEdge =
        y0 === 0 && axis === 'vertical'
          ? along < extent / 2
          : x0 === 0 && axis === 'horizontal'
            ? along < extent / 2
            : along >= extent / 2
      const bucket = nearEdge ? buckets.outer : buckets.inner
      const i = (y * w + x) * 3
      bucket[0].push(rgb[i])
      bucket[1].push(rgb[i + 1])
      bucket[2].push(rgb[i + 2])
    }
  }

  const med = (vals) => {
    if (!vals.length) return 0
    const s = vals.slice().sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  return {
    outer: buckets.outer.map(med),
    inner: buckets.inner.map(med),
  }
}

function globalStats(proxy) {
  const edges = edgeMap(proxy.luma)
  const smoothed = boxBlur(edges, 2)
  let sum = 0
  let strong = 0
  for (const v of smoothed.data) {
    sum += v
    if (v > 0.12) strong++
  }
  const edgeDensity = strong / smoothed.data.length
  const meanEdge = sum / smoothed.data.length

  const { rgb } = proxy
  const n = rgb.length / 3
  const mean = [0, 1, 2].map((c) => {
    let s = 0
    for (let i = 0; i < n; i++) s += rgb[i * 3 + c]
    return s / n
  })
  let colourSd = 0
  for (let i = 0; i < n; i++) {
    colourSd +=
      (rgb[i * 3] - mean[0]) ** 2 + (rgb[i * 3 + 1] - mean[1]) ** 2 + (rgb[i * 3 + 2] - mean[2]) ** 2
  }
  colourSd = Math.sqrt(colourSd / (n * 3))

  return { edgeDensity: round(edgeDensity), meanEdge: round(meanEdge), colourSd: round(colourSd) }
}

function classify(global, edges) {
  const flatness = avg(Object.values(edges).map((e) => e.flatness))
  const ramp = avg(Object.values(edges).map((e) => e.rampMagnitude))

  if (flatness > 0.85 && ramp < 6) return { class: 'flat', flatness: round(flatness) }
  if (flatness > 0.6 && ramp >= 6) return { class: 'gradient', flatness: round(flatness) }
  if (global.edgeDensity > 0.22) return { class: 'complex', flatness: round(flatness) }
  if (global.edgeDensity > 0.08) return { class: 'photographic', flatness: round(flatness) }
  return { class: 'texture', flatness: round(flatness) }
}

/** k-means palette over a subsample. Deterministic: seeded by even striding. */
export function extractPalette(proxy, k = 6) {
  const { rgb } = proxy
  const n = rgb.length / 3
  const stride = Math.max(1, Math.floor(n / 6000))
  const pts = []
  for (let i = 0; i < n; i += stride) pts.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]])
  if (!pts.length) return []

  let centres = []
  for (let i = 0; i < k; i++) centres.push(pts[Math.floor((i + 0.5) * (pts.length / k))].slice())

  for (let iter = 0; iter < 12; iter++) {
    const sums = centres.map(() => [0, 0, 0, 0])
    for (const p of pts) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < centres.length; c++) {
        const d =
          (p[0] - centres[c][0]) ** 2 + (p[1] - centres[c][1]) ** 2 + (p[2] - centres[c][2]) ** 2
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      const s = sums[best]
      s[0] += p[0]
      s[1] += p[1]
      s[2] += p[2]
      s[3]++
    }
    centres = centres.map((c, i) =>
      sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c
    )
  }

  const counts = centres.map(() => 0)
  for (const p of pts) {
    let best = 0
    let bestD = Infinity
    for (let c = 0; c < centres.length; c++) {
      const d =
        (p[0] - centres[c][0]) ** 2 + (p[1] - centres[c][1]) ** 2 + (p[2] - centres[c][2]) ** 2
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    counts[best]++
  }

  return centres
    .map((c, i) => ({
      rgb: c.map(Math.round),
      hex: toHex(c),
      coverage: round(counts[i] / pts.length),
    }))
    .filter((c) => c.coverage > 0.01)
    .sort((a, b) => b.coverage - a.coverage)
}

export const toHex = (c) =>
  '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const round = (v) => Math.round(v * 1000) / 1000

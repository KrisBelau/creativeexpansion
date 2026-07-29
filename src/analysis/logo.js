/**
 * Logo location by template match against a brand-kit reference (SPEC 6.1, 8).
 *
 * v0 does not attempt to *discover* an unknown logo — there is no reliable way
 * to tell a brand mark from any other graphic without a reference, and a wrong
 * guess here silently defeats the "logo is never cropped" guarantee. So: supply
 * a reference in the brand kit and it gets located and protected; supply none
 * and the source carries a `logo_not_verified` finding rather than a false
 * assurance.
 *
 * Match is zero-mean normalised cross-correlation over edge maps, which is
 * robust to the logo being recoloured or sitting on a different ground.
 */
import sharp from 'sharp'
import { Grid, boxBlur } from './pixels.js'
import { edgeMap } from './saliency.js'
import { rect } from '../solver/geometry.js'

const WIDTH_FRACTIONS = [0.08, 0.1, 0.12, 0.15, 0.18, 0.22, 0.27, 0.32, 0.4]
const ACCEPT = 0.55

export async function locateLogo(proxy, referenceBuffer, { label = 'logo' } = {}) {
  if (!referenceBuffer) return null
  const { w: pw, h: ph } = proxy.proxy
  // Blur both sides slightly. Stroke weight scales with the logo, so raw edge
  // maps of the same mark at different sizes correlate poorly; softening makes
  // the match depend on the mark's shape rather than its line thickness.
  const haystack = boxBlur(edgeMap(proxy.luma), 1)

  const refMeta = await sharp(referenceBuffer).metadata()
  const refAspect = refMeta.width / refMeta.height

  let best = null
  for (const frac of WIDTH_FRACTIONS) {
    const tw = Math.round(pw * frac)
    const th = Math.round(tw / refAspect)
    if (tw < 8 || th < 8 || tw > pw * 0.9 || th > ph * 0.9) continue

    const needle = await templateEdges(referenceBuffer, tw, th)
    const hit = search(haystack, needle, tw, th)
    if (hit && (!best || hit.score > best.score)) best = { ...hit, tw, th, frac }
  }

  if (!best || best.score < ACCEPT) {
    return {
      found: false,
      bestScore: best ? round(best.score) : 0,
      reason: best
        ? `best correlation ${round(best.score)} is below the ${ACCEPT} acceptance threshold`
        : 'no candidate scale fitted the proxy',
    }
  }

  return {
    found: true,
    region: {
      id: label,
      type: 'logo',
      protection: 'immutable',
      source: 'auto',
      confidence: round(best.score),
      box: rect(best.x, best.y, best.tw, best.th),
    },
  }
}

async function templateEdges(buffer, tw, th) {
  const { data } = await sharp(buffer)
    .resize(tw, th, { fit: 'fill', kernel: 'lanczos3' })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const g = new Grid(tw, th)
  for (let i = 0; i < tw * th; i++) g.data[i] = data[i] / 255
  return boxBlur(edgeMap(g), 1)
}

function search(haystack, needle, tw, th) {
  const { w, h } = haystack
  const nStats = zeroMean(needle.data)
  if (nStats.norm < 1e-6) return null

  const coarse = Math.max(2, Math.round(tw / 18))
  let best = scan(haystack, needle, nStats, tw, th, coarse, 0, 0, w - tw, h - th)
  if (!best) return null

  // Refine around the coarse winner at single-pixel stride.
  const pad = coarse * 2
  const refined = scan(
    haystack,
    needle,
    nStats,
    tw,
    th,
    1,
    Math.max(0, best.x - pad),
    Math.max(0, best.y - pad),
    Math.min(w - tw, best.x + pad),
    Math.min(h - th, best.y + pad)
  )
  return refined && refined.score > best.score ? refined : best
}

function scan(haystack, needle, nStats, tw, th, stride, x0, y0, x1, y1) {
  const { w, data } = haystack
  const nd = needle.data
  let best = null
  for (let y = y0; y <= y1; y += stride) {
    for (let x = x0; x <= x1; x += stride) {
      let sum = 0
      let sumSq = 0
      let dot = 0
      for (let ty = 0; ty < th; ty++) {
        const hRow = (y + ty) * w + x
        const nRow = ty * tw
        for (let tx = 0; tx < tw; tx++) {
          const v = data[hRow + tx]
          sum += v
          sumSq += v * v
          dot += v * nd[nRow + tx]
        }
      }
      const n = tw * th
      const mean = sum / n
      const norm = Math.sqrt(Math.max(0, sumSq - n * mean * mean))
      if (norm < 1e-6) continue
      const score = (dot - n * mean * nStats.mean) / (norm * nStats.norm)
      if (!best || score > best.score) best = { x, y, score }
    }
  }
  return best
}

function zeroMean(data) {
  let sum = 0
  for (const v of data) sum += v
  const mean = sum / data.length
  let sumSq = 0
  for (const v of data) sumSq += (v - mean) ** 2
  return { mean, norm: Math.sqrt(sumSq) }
}

const round = (v) => Math.round(v * 1000) / 1000

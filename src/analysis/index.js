/**
 * Analysis orchestration (SPEC 5.2, 6.1). Runs once per source; the result is
 * the editable Analysis object every downstream stage reads.
 */
import sharp from 'sharp'
import { loadProxy, contrastRatio } from './pixels.js'
import { saliencyMap, applyCentrePrior, busynessMap } from './saliency.js'
import { detectText, measureCapHeight } from './text.js'
import { analyseBackground, extractPalette, toHex } from './background.js'
import { locateLogo } from './logo.js'
import { rect, union, area, coverage } from '../solver/geometry.js'

export const ENGINE_VERSION = '0.1.0'
const TEXT_PROXY_LONG = 1024
const SALIENCY_PROXY_LONG = 512

/**
 * Analyse a source.
 *
 * `detect` is opt-in. Region detection is heuristic — it misses outline and script
 * faces and invents type in busy artwork — so it is offered as an action a person
 * takes and reviews, not as something that silently decides what the ad is made
 * of. Everything else here (ground class, palette, saliency, quality gate) is
 * measurement rather than interpretation, and always runs.
 */
export async function analyse(input, { brandKit = null, logoReference = null, detect = false } = {}) {
  const [salProxy, textProxy] = await Promise.all([
    loadProxy(input, SALIENCY_PROXY_LONG),
    loadProxy(input, TEXT_PROXY_LONG),
  ])

  const saliency = applyCentrePrior(saliencyMap(salProxy))
  const busyness = busynessMap(salProxy.luma)
  const background = analyseBackground(salProxy)
  const palette = extractPalette(salProxy)
  const source = salProxy.source

  let regions = []
  let logo = { found: false, bestScore: 0, reason: 'auto-detect has not been run' }

  if (detect) {
    const found = await detectRegionsIn({ salProxy, textProxy, saliency, logoReference, brandKit })
    regions = found.regions
    logo = found.logo
  }

  return {
    engineVersion: ENGINE_VERSION,
    source,
    format: salProxy.meta.format ?? null,
    proxies: { saliency: salProxy.proxy, text: textProxy.proxy },
    maps: { saliency, busyness },
    regions,
    detected: detect,
    background,
    palette,
    logo,
    alpha: salProxy.alpha,
    orientation: salProxy.orientation,
    quality: await qualityGate(input, salProxy, regions, background, detect),
  }
}

/** Region detection, separated so it can be invoked on demand. */
async function detectRegionsIn({ salProxy, textProxy, saliency, logoReference, brandKit }) {
  const detected = detectText(textProxy).map((r) => ({
    ...r,
    box: textProxy.toSource(r.box),
    capHeight: r.capHeight / textProxy.proxy.scale,
  }))

  const logo = await locateLogo(salProxy, logoReference ?? brandKit?.logoReference)
  const logoRegion = logo?.found
    ? { ...logo.region, box: salProxy.toSource(logo.region.box) }
    : null

  // A wordmark inside the logo lockup is not editorial copy: it is part of the
  // logo, protected by the logo's own minimum-size rule, and measuring it
  // against the body-copy floor would block every small placement for no reason.
  const textRegions = logoRegion
    ? detected.filter((r) => coverage(logoRegion.box, r.box) < 0.7)
    : detected

  for (const r of textRegions) {
    // Contrast is scale-invariant, so measure it once on the master. An output that
    // fails contrast has almost always inherited the problem rather than been given
    // it by the resize, and the two cases deserve different severities.
    r.sourceContrast = measureContrast(textProxy, r.box)
    // What to lift if this element is ever moved. A detection box is tight to the
    // ink, but the *element* is bigger: a CTA label sits on a pill, and lifting the
    // label alone would strand white type on the page colour.
    r.liftBox = liftBoxFor(textProxy, r)
  }

  const source = salProxy.source
  const regions = [...textRegions]
  if (logoRegion) {
    logoRegion.liftBox = padBox(logoRegion.box, source, 0.55)
    regions.push(logoRegion)
  }

  const subject = deriveSubject(saliency, salProxy, textRegions)
  if (subject) {
    // Saliency finds the high-contrast core of a product, not its full silhouette:
    // a pale cap or a soft shadow falls outside. Pad generously, because a product
    // lifted with its top sliced off is worse than one lifted with spare ground.
    subject.liftBox = padBox(subject.box, source, 0.14, { basis: 'short', max: 90 })
    regions.push(subject)
  }

  return { regions, logo: logo ?? { found: false, bestScore: 0, reason: 'no reference supplied' } }
}

/**
 * Derive everything measurable about a set of hand-drawn or edited regions.
 *
 * A person drawing a box supplies its geometry and its role; they cannot supply a
 * cap height, a contrast ratio or whether the type sits on a button. Deriving all
 * of that from the pixels here is what makes a manual region carry exactly the
 * same weight in the legibility rules as a detected one — otherwise manual mode
 * would be a second-class path that quietly skips the checks.
 */
export async function measureRegions(input, regions) {
  const textProxy = await loadProxy(input, TEXT_PROXY_LONG)
  const source = textProxy.source
  const scale = textProxy.proxy.scale

  // Run the detector's own line-and-block grouping once, and let a drawn box
  // adopt the cap height of any type block it contains.
  //
  // The alternative — measuring glyph components directly inside the drawn
  // rectangle — is a second heuristic that disagrees with the first: on a
  // three-line headline it read 59px against detection's 78px, because pooling
  // glyphs across lines shifts the percentile. Two numbers for the same type is
  // worse than either number being imperfect, since the floors are applied to
  // both. Direct measurement stays as the fallback for type the detector cannot
  // see at all, which is exactly the case manual mode exists for.
  const blocks = detectText(textProxy).map((b) => ({
    box: textProxy.toSource(b.box),
    capHeight: b.capHeight / scale,
  }))

  return regions.map((r) => {
    const out = { ...r }
    if (r.type === 'text') {
      const inside = blocks.filter((b) => coverage(r.box, b.box) > 0.6)
      if (inside.length) {
        const heights = inside.map((b) => b.capHeight).sort((a, b) => a - b)
        out.capHeight = heights[Math.floor(heights.length / 2)]
        out.capHeightSource = 'detected'
      } else {
        const measured = measureCapHeight(textProxy, textProxy.toProxy(r.box))
        out.capHeight = measured ? measured / scale : r.box.h * 0.72
        out.capHeightSource = measured ? 'measured' : 'estimated'
      }
      out.sourceContrast = measureContrast(textProxy, r.box)
      out.onPlate = detectPlate(textProxy, r)
      out.liftBox = liftBoxFor(textProxy, out)
    } else if (r.type === 'logo') {
      out.liftBox = padBox(r.box, source, 0.55)
    } else {
      out.liftBox = padBox(r.box, source, 0.14, { basis: 'short', max: 90 })
    }
    return out
  })
}

/** Is this type sitting on a solid contrasting plate (a button)? */
function detectPlate(proxy, region) {
  const b = proxy.toProxy(region.box)
  const pad = Math.min(8, Math.max(2, Math.round(b.h * 0.18)))
  const ring = ringMedian(proxy, b, pad)
  if (!ring) return false
  const page = pageColour(proxy)
  const fromPage = Math.hypot(ring[0] - page[0], ring[1] - page[1], ring[2] - page[2])
  const spread = ringSpread(proxy, b, pad, ring)
  return spread < 26 && fromPage > 45
}

function pageColour(proxy) {
  const { w, h } = proxy.proxy
  const k = Math.max(4, Math.round(Math.min(w, h) * 0.05))
  const acc = [0, 0, 0, 0]
  for (const [sx, sy] of [[0, 0], [w - k, 0], [0, h - k], [w - k, h - k]]) {
    for (let y = sy; y < sy + k; y++) {
      for (let x = sx; x < sx + k; x++) {
        const i = (y * w + x) * 3
        acc[0] += proxy.rgb[i]
        acc[1] += proxy.rgb[i + 1]
        acc[2] += proxy.rgb[i + 2]
        acc[3]++
      }
    }
  }
  return acc[3] ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]] : [255, 255, 255]
}

function ringSpread(proxy, box, pad, mean) {
  const { w, h } = proxy.proxy
  const x0 = Math.max(0, Math.floor(box.x - pad))
  const y0 = Math.max(0, Math.floor(box.y - pad))
  const x1 = Math.min(w, Math.ceil(box.x + box.w + pad))
  const y1 = Math.min(h, Math.ceil(box.y + box.h + pad))
  let sum = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue
      const i = (y * w + x) * 3
      sum += Math.hypot(proxy.rgb[i] - mean[0], proxy.rgb[i + 1] - mean[1], proxy.rgb[i + 2] - mean[2])
      n++
    }
  }
  return n ? sum / n : 999
}

/**
 * Grow a box, clamped to the frame. `pad` is derived from the box height rather
 * than its shorter side: a legal line is 862x23, so a fraction of the short side
 * is a couple of pixels and clips the final full stop, while a fraction of the
 * long side would be 70px and blow past the usable width. Height tracks the type
 * size, which is what the overhang actually scales with.
 */
function padBox(box, source, fraction, { basis = 'height', min = 4, max = 28 } = {}) {
  const reference = basis === 'height' ? box.h : Math.min(box.w, box.h)
  const pad = Math.min(max, Math.max(min, Math.round(reference * fraction)))
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  return rect(
    x,
    y,
    Math.min(source.w - x, box.w + pad * 2),
    Math.min(source.h - y, box.h + pad * 2)
  )
}

/**
 * The rect to lift for a text element. Type sitting on a solid plate (a button)
 * is grown outward until the surrounding colour stops matching that plate, so the
 * whole component travels together. Everything else just gets a small margin for
 * anti-aliased edges.
 */
function liftBoxFor(proxy, region) {
  const small = padBox(region.box, proxy.source, 0.55)
  if (!region.onPlate) return small

  const b = proxy.toProxy(region.box)
  const plate = ringMedian(proxy, b, Math.max(2, Math.round(b.h * 0.15)))
  if (!plate) return small

  const step = Math.max(2, Math.round(b.h * 0.12))
  const limit = b.h * 2.5
  let grown = { ...b }

  for (let i = 0; i < 40; i++) {
    const next = {
      x: grown.x - step,
      y: grown.y - step,
      w: grown.w + step * 2,
      h: grown.h + step * 2,
    }
    if (next.w > b.w + limit * 2 || next.h > b.h + limit) break
    const ring = ringMedian(proxy, next, step)
    if (!ring) break
    const drift = Math.hypot(ring[0] - plate[0], ring[1] - plate[1], ring[2] - plate[2])
    // Once the surround stops looking like the plate, we have reached its edge.
    if (drift > 34) break
    grown = next
  }

  // Include the plate's own boundary, then convert back to source pixels.
  const out = proxy.toSource({
    x: grown.x - step / 2,
    y: grown.y - step / 2,
    w: grown.w + step,
    h: grown.h + step,
  })
  const x = Math.max(0, out.x)
  const y = Math.max(0, out.y)
  return rect(x, y, Math.min(proxy.source.w - x, out.w), Math.min(proxy.source.h - y, out.h))
}

/** Median colour of a band of width `pad` immediately outside `box`. */
function ringMedian(proxy, box, pad) {
  const { w, h } = proxy.proxy
  const x0 = Math.max(0, Math.floor(box.x - pad))
  const y0 = Math.max(0, Math.floor(box.y - pad))
  const x1 = Math.min(w, Math.ceil(box.x + box.w + pad))
  const y1 = Math.min(h, Math.ceil(box.y + box.h + pad))
  const channels = [[], [], []]
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
      if (inside) continue
      const i = (y * w + x) * 3
      channels[0].push(proxy.rgb[i])
      channels[1].push(proxy.rgb[i + 1])
      channels[2].push(proxy.rgb[i + 2])
    }
  }
  if (channels[0].length < 8) return null
  return channels.map((c) => {
    c.sort((a, b) => a - b)
    return c[Math.floor(c.length / 2)]
  })
}

/**
 * Contrast ratio of a region in the source, by the same tonal-tails method the
 * renderer uses on outputs, so the two numbers are comparable.
 */
function measureContrast(proxy, sourceBox) {
  const { w, h } = proxy.proxy
  const b = proxy.toProxy(sourceBox)
  const x0 = Math.max(0, Math.floor(b.x))
  const y0 = Math.max(0, Math.floor(b.y))
  const x1 = Math.min(w, Math.ceil(b.x + b.w))
  const y1 = Math.min(h, Math.ceil(b.y + b.h))
  if (x1 - x0 < 2 || y1 - y0 < 2) return null

  const px = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3
      const rgb = [proxy.rgb[i], proxy.rgb[i + 1], proxy.rgb[i + 2]]
      px.push({ rgb, luma: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] })
    }
  }
  if (px.length < 4) return null

  px.sort((a, b2) => a.luma - b2.luma)
  const tail = Math.max(1, Math.round(px.length * 0.12))
  const mean = (slice) => {
    const acc = [0, 0, 0]
    for (const p of slice) {
      acc[0] += p.rgb[0]
      acc[1] += p.rgb[1]
      acc[2] += p.rgb[2]
    }
    return acc.map((v) => v / slice.length)
  }
  return (
    Math.round(contrastRatio(mean(px.slice(0, tail)), mean(px.slice(px.length - tail))) * 100) / 100
  )
}

function deriveSubject(saliency, proxy, textRegions) {
  const { w, h } = proxy.proxy
  // Mask out type, then take the bounding box of the top saliency decile.
  const masked = saliency.clone()
  for (const r of textRegions) {
    const b = proxy.toProxy(r.box)
    for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(h, Math.ceil(b.y + b.h)); y++) {
      for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(w, Math.ceil(b.x + b.w)); x++) {
        masked.data[y * w + x] = 0
      }
    }
  }

  const sorted = Float32Array.from(masked.data).sort()
  const cut = sorted[Math.floor(sorted.length * 0.95)]
  if (!(cut > 0.05)) return null

  // The bounding box of *all* salient pixels is not a subject — on a typical ad it
  // stretches from the logo to the product and swallows the copy in between, which
  // makes it useless as a crop constraint and actively wrong as a movable element
  // (re-layout would lift the headline twice). Take the largest connected blob
  // instead: that is the thing being shown.
  const blob = largestBlob(masked, cut)
  if (!blob) return null

  // Still refuse a subject that covers most of the frame; it carries no signal.
  if (area(blob) > w * h * 0.55) return null

  return {
    id: 'subject',
    type: 'subject',
    protection: 'protected',
    source: 'auto',
    confidence: 0.5,
    box: proxy.toSource(blob),
  }
}

/** Bounding box of the largest 8-connected region above `cut`. */
function largestBlob(grid, cut) {
  const { w, h, data } = grid
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let best = null
  let bestCount = 0

  for (let start = 0; start < data.length; start++) {
    if (seen[start] || data[start] < cut) continue
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    let count = 0

    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i - x) / w
      count++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const ni = ny * w + nx
          if (!seen[ni] && data[ni] >= cut) {
            seen[ni] = 1
            stack[sp++] = ni
          }
        }
      }
    }

    if (count > bestCount) {
      bestCount = count
      best = rect(minX, minY, maxX - minX + 1, maxY - minY + 1)
    }
  }

  return best
}

/** SPEC 5.2 — findings, not silent adjustments. */
async function qualityGate(input, proxy, textRegions, background, detected) {
  const findings = []
  const meta = proxy.meta

  if (meta.space === 'cmyk') {
    findings.push({
      code: 'source_cmyk',
      severity: 'warn',
      message: `Source is CMYK${meta.hasProfile ? '' : ' with no embedded profile'}. Converted to sRGB, but colours may shift — supply an RGB master for colour-critical work.`,
    })
  }
  if (!meta.hasProfile && meta.space !== 'srgb' && meta.space !== 'b-w') {
    findings.push({
      code: 'source_untagged',
      severity: 'warn',
      message: `No colour profile embedded (space: ${meta.space}). Assuming sRGB.`,
    })
  }
  if (meta.density && meta.density < 72) {
    findings.push({
      code: 'source_low_density',
      severity: 'info',
      message: `Reported density ${meta.density} dpi.`,
    })
  }

  if (proxy.alpha.hasAlpha && proxy.alpha.fraction > 0.01) {
    findings.push({
      code: 'source_has_transparency',
      severity: 'warn',
      message: `${Math.round(proxy.alpha.fraction * 100)}% of the master is transparent. Placements that require JPEG cannot carry an alpha channel, so those areas are flattened onto white — set a flatten colour in the recipe if the design expects a different ground.`,
    })
  }

  if (proxy.orientation.transposed) {
    findings.push({
      code: 'source_exif_rotated',
      severity: 'info',
      message: `The file stores EXIF orientation ${proxy.orientation.value}, so its real dimensions are ${proxy.source.w}x${proxy.source.h} rather than the ${meta.width}x${meta.height} recorded in the header. Working from the rotated pixels.`,
    })
  }

  const px = meta.width * meta.height
  if (px < 400_000) {
    findings.push({
      code: 'source_low_resolution',
      severity: 'warn',
      message: `Source is ${meta.width}x${meta.height} (${(px / 1e6).toFixed(2)} MP). Larger canvases will need upscaling.`,
    })
  }

  // A JPEG that has been through several generations shows blocking; a rough
  // proxy for that is high edge energy aligned to the 8px DCT grid. Only JPEG
  // can have it — running the check on PNG or WebP just reports texture and
  // film grain as compression damage.
  const blockiness = meta.format === 'jpeg' ? await estimateBlockiness(input) : 0
  if (blockiness > 0.18) {
    findings.push({
      code: 'source_compression_damage',
      severity: 'warn',
      message: `Blocking artefacts detected (score ${blockiness.toFixed(2)}). The source looks like a re-save of a re-save; downstream outputs cannot be cleaner than this.`,
    })
  }

  const lowConfidenceText = textRegions.filter((r) => r.confidence < 0.45)
  if (lowConfidenceText.length) {
    findings.push({
      code: 'text_detection_uncertain',
      severity: 'info',
      message: `${lowConfidenceText.length} of ${textRegions.length} detected text regions are low confidence. Review the regions before rendering.`,
    })
  }
  if (!textRegions.length) {
    findings.push({
      code: detected ? 'no_text_detected' : 'no_regions_yet',
      severity: detected ? 'info' : 'warn',
      message: detected
        ? 'Auto-detect found no type. If this creative has copy, mark it manually — undetected type gets cropped through with no warning.'
        : 'No regions marked yet. Nothing is protected, so a crop may cut straight through the copy. Draw a box around each element, or run auto-detect and correct what it gets wrong.',
    })
  }

  // Reported once against the master, because that is where the fix belongs.
  const lowContrast = textRegions.filter(
    (r) => r.sourceContrast != null && r.sourceContrast < 4.5 && (r.confidence ?? 1) >= 0.45
  )
  for (const r of lowContrast) {
    findings.push({
      code: 'source_contrast_low',
      severity: 'warn',
      message: `The ${r.role} at ${Math.round(r.box.x)},${Math.round(r.box.y)} has only ${r.sourceContrast.toFixed(2)}:1 contrast in the master (4.5:1 is the floor for small type). Every output inherits this — fix the master or approve the exception once.`,
      regionRef: r.id,
    })
  }

  if (['photographic', 'complex'].includes(background.classification.class)) {
    findings.push({
      code: 'faces_not_analysed',
      severity: 'warn',
      message: 'Face detection is not implemented in v0. On photographic sources, verify manually that no crop cuts a face.',
    })
  }

  return { blockiness: Math.round(blockiness * 1000) / 1000, findings }
}

async function estimateBlockiness(input) {
  const size = 256
  const { data, info } = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(size, size, { fit: 'fill', kernel: 'nearest' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  let onGrid = 0
  let offGrid = 0
  let onCount = 0
  let offCount = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 1; x < info.width; x++) {
      const d = Math.abs(data[y * info.width + x] - data[y * info.width + x - 1])
      if (x % 8 === 0) {
        onGrid += d
        onCount++
      } else {
        offGrid += d
        offCount++
      }
    }
  }
  const on = onCount ? onGrid / onCount : 0
  const off = offCount ? offGrid / offCount : 1
  if (off < 1e-6) return 0
  return Math.max(0, on / off - 1)
}

/** Regions that a crop may not cut through, in source coordinates. */
export function protectedRegions(analysis) {
  return analysis.regions.filter((r) => r.protection === 'immutable' || r.protection === 'protected')
}

export function immutableRegions(analysis) {
  return analysis.regions.filter((r) => r.protection === 'immutable')
}

export const textRegionsOf = (analysis) => analysis.regions.filter((r) => r.type === 'text')

/**
 * Text-region detection (SPEC 6.1).
 *
 * No OCR here — v0 needs *where the type is*, not what it says, because the
 * protected-crop track only has to avoid cutting through it and measure whether
 * it survives the scale factor. Reading the words is Phase 2 (de-flattening).
 *
 * Pipeline: threshold the edge map, take connected components (roughly glyphs),
 * discard components that cannot be glyphs, then group glyphs into lines by
 * baseline proximity and lines into blocks by size and vertical rhythm. This is
 * the classical text-line grouping approach; it beats morphological closing at a
 * guessed kernel width because it does not need to know the type size up front,
 * which is exactly what varies across an ad.
 *
 * It has false positives on detailed photography and false negatives on
 * outline/script faces. That is expected and is why every region is editable in
 * the review UI (SPEC 6.1) and why low confidence gates Track B (SPEC 6.3).
 */
import { edgeMap } from './saliency.js'
import { rect, union, area, right, bottom } from '../solver/geometry.js'

/** Glyph size bounds as a fraction of the proxy's height. */
const MIN_GLYPH_H = 0.006
const MAX_GLYPH_H = 0.2

export function detectText(proxy) {
  const { w, h } = proxy.proxy
  const edges = edgeMap(proxy.luma)
  const threshold = Math.max(percentile(edges.data, 0.88), 0.05)

  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) mask[i] = edges.data[i] >= threshold ? 1 : 0

  const glyphs = components(mask, w, h).filter((c) => isGlyphLike(c, h))

  const lines = groupLines(glyphs, h)
  const blocks = groupBlocks(lines)
  return classify(blocks, proxy)
}

/* ---------------------------------------------------------------- filtering */

function isGlyphLike(c, proxyH) {
  if (c.h < proxyH * MIN_GLYPH_H || c.h > proxyH * MAX_GLYPH_H) return false
  // Extremely wide-and-flat or tall-and-thin components are rules and borders.
  const ratio = c.w / c.h
  if (ratio > 14 || ratio < 0.04) return false
  // A glyph's strokes fill a meaningful share of its box.
  if (c.ink.fill < 0.06) return false
  // Reject outlines. A button, card or frame is a closed contour, so nearly all
  // of its edge pixels hug the bounding box; a glyph's ink reaches the interior.
  // Without this, a CTA button's own border is read as a huge line of type and
  // becomes the tallest "text" in the ad, wrecking every relative-size role.
  if (c.ink.hollowness > 0.82 && area(c) > (proxyH * 0.02) ** 2) return false
  return true
}

/**
 * Ink statistics for one component, computed from the component's *own* pixels.
 *
 * Measuring every mask pixel inside the bounding box instead is a trap: a CTA
 * button's outline encloses its label, so the label's pixels land in the
 * outline's box and make a hollow container look like solidly-inked type.
 */
function inkStats(box, pixels, w) {
  const band = Math.max(1, Math.round(Math.min(box.w, box.h) * 0.16))
  let ring = 0
  for (let k = 0; k < pixels.length; k++) {
    const i = pixels[k]
    const x = i % w
    const y = (i - x) / w
    const nearEdge =
      y - box.y < band ||
      bottom(box) - 1 - y < band ||
      x - box.x < band ||
      right(box) - 1 - x < band
    if (nearEdge) ring++
  }
  return {
    count: pixels.length,
    fill: pixels.length / Math.max(1, area(box)),
    hollowness: pixels.length ? ring / pixels.length : 1,
  }
}

/* ----------------------------------------------------------------- grouping */

/**
 * Glyphs -> lines. Two glyphs share a line when their vertical centres are
 * close relative to their height, their heights are comparable, and they are
 * horizontally within about one glyph-width of each other.
 */
function groupLines(glyphs, proxyH) {
  const pool = [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x)
  const used = new Set()
  const lines = []

  for (let i = 0; i < pool.length; i++) {
    if (used.has(i)) continue
    const seed = pool[i]
    const members = [seed]
    used.add(i)

    let changed = true
    while (changed) {
      changed = false
      const refH = median(members.map((m) => m.h))
      const box = union(members)
      for (let j = 0; j < pool.length; j++) {
        if (used.has(j)) continue
        const c = pool[j]
        const heightRatio = Math.min(c.h, refH) / Math.max(c.h, refH)
        if (heightRatio < 0.42) continue
        const sameBaseline = Math.abs(centreY(c) - centreY(box)) < Math.max(refH, c.h) * 0.55
        if (!sameBaseline) continue
        const gap = Math.max(box.x - right(c), c.x - right(box))
        if (gap > refH * 1.3) continue
        members.push(c)
        used.add(j)
        changed = true
      }
    }

    const line = buildLine(members)
    if (line) lines.push(line)
  }

  return lines.sort((a, b) => a.y - b.y || a.x - b.x)
}

function buildLine(members) {
  const box = union(members)
  const heights = members.map((m) => m.h)

  // A single component is only a line if it is clearly a word-shaped mass;
  // otherwise it is a graphic. Two components must at least look like a word.
  if (members.length === 1) {
    const c = members[0]
    if (c.w < c.h * 2.2 || c.ink.fill < 0.12) return null
  } else if (members.length === 2 && box.w < box.h * 1.4) {
    return null
  }

  const inkArea = members.reduce((a, m) => a + m.ink.count, 0)
  if (inkArea / Math.max(1, area(box)) < 0.05) return null

  // Cap height: the taller glyphs in a line are its capitals and ascenders, so
  // the 75th percentile of member heights approximates cap height far better
  // than the line box (which includes descenders) or the median (x-height).
  const capHeight = percentileOf(heights, 0.75)

  return {
    ...box,
    capHeight,
    members: members.length,
    inkRatio: inkArea / Math.max(1, area(box)),
  }
}

/**
 * Lines -> blocks. Consecutive lines of comparable size and tight vertical
 * rhythm are one typographic element, so they get one finding rather than one
 * per line — which is how a designer reads the ad.
 */
function groupBlocks(lines) {
  const blocks = []
  for (const line of lines) {
    const host = blocks.find((b) => {
      const last = b.lines[b.lines.length - 1]
      const ratio = Math.min(last.capHeight, line.capHeight) / Math.max(last.capHeight, line.capHeight)
      if (ratio < 0.78) return false
      const gap = line.y - bottom(last)
      if (gap < -last.h * 0.5 || gap > last.capHeight * 1.4) return false
      // Blocks are visually left- (or centre-) aligned; a line starting far away
      // horizontally belongs to a different element.
      const alignLeft = Math.abs(line.x - last.x) < last.capHeight * 1.2
      const alignCentre = Math.abs(centreX(line) - centreX(last)) < last.capHeight * 1.2
      return alignLeft || alignCentre
    })
    if (host) host.lines.push(line)
    else blocks.push({ lines: [line] })
  }

  return blocks.map((b) => {
    const box = union(b.lines)
    return {
      ...box,
      lineCount: b.lines.length,
      capHeight: median(b.lines.map((l) => l.capHeight)),
      members: b.lines.reduce((a, l) => a + l.members, 0),
      inkRatio: b.lines.reduce((a, l) => a + l.inkRatio, 0) / b.lines.length,
    }
  })
}

/* --------------------------------------------------------- role assignment */

function classify(blocks, proxy) {
  if (!blocks.length) return []
  const { h: proxyH } = proxy.proxy
  const tallest = Math.max(...blocks.map((b) => b.capHeight))
  const pageColour = dominantColour(proxy)

  return blocks
    .map((block, i) => {
      const rel = block.capHeight / tallest
      const onPlate = sitsOnPlate(block, proxy, pageColour)
      const inBottomBand = centreY(block) > proxyH * 0.85

      let role
      if (onPlate && rel < 0.8) role = 'cta'
      else if (inBottomBand && rel < 0.45) role = 'legal'
      else if (rel >= 0.8) role = 'headline'
      else if (rel >= 0.5) role = 'subhead'
      else role = 'body'

      const confidence = confidenceOf(block, role)

      return {
        id: `text_${i}`,
        type: 'text',
        role,
        capHeight: block.capHeight,
        lineCount: block.lineCount,
        // Headlines, CTAs and legal lines may never be cut; supporting copy may
        // be dropped by the escalation ladder but not sliced through.
        protection: ['headline', 'legal', 'cta'].includes(role) ? 'immutable' : 'protected',
        source: 'auto',
        confidence: round(confidence),
        onPlate,
        box: rect(block.x, block.y, block.w, block.h),
      }
    })
    .sort((a, b) => a.box.y - b.box.y)
}

function confidenceOf(block, role) {
  // Confidence rises with the amount of corroborating structure: more glyphs,
  // more lines, an ink ratio in the range type actually produces.
  const glyphTerm = clamp01((block.members - 1) / 8)
  const inkTerm = clamp01(1 - Math.abs(block.inkRatio - 0.28) / 0.28)
  const lineTerm = block.lineCount > 1 ? 1 : 0.65
  const shapeTerm = clamp01(block.w / Math.max(1, block.capHeight) / 6)
  return 0.35 * glyphTerm + 0.25 * inkTerm + 0.2 * lineTerm + 0.2 * shapeTerm
}

/**
 * Does this block sit on a solid contrasting plate — i.e. is it a button?
 * Sampled from a ring just outside the block: uniform colour, clearly different
 * from the page ground.
 */
function sitsOnPlate(block, proxy, pageColour) {
  // A thin ring. Buttons are padded tightly around their label, so a generous
  // ring reaches past the plate onto the page and averages the two together.
  const pad = Math.min(8, Math.max(2, Math.round(block.capHeight * 0.18)))
  const ring = sampleRing(block, proxy, pad)
  if (!ring) return false
  const fromPage = Math.hypot(
    ring.mean[0] - pageColour[0],
    ring.mean[1] - pageColour[1],
    ring.mean[2] - pageColour[2]
  )
  return ring.sd < 22 && fromPage > 45
}

export function sampleRing(box, proxy, pad) {
  const { w, h } = proxy.proxy
  const { rgb } = proxy
  const outer = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    x1: Math.min(w, Math.ceil(right(box) + pad)),
    y1: Math.min(h, Math.ceil(bottom(box) + pad)),
  }
  const px = []
  for (let y = outer.y; y < outer.y1; y++) {
    for (let x = outer.x; x < outer.x1; x++) {
      const insideBox =
        x >= box.x && x < right(box) && y >= box.y && y < bottom(box)
      if (insideBox) continue
      const i = (y * w + x) * 3
      px.push([rgb[i], rgb[i + 1], rgb[i + 2]])
    }
  }
  if (px.length < 12) return null
  const mean = [0, 1, 2].map((c) => px.reduce((a, p) => a + p[c], 0) / px.length)
  const sd = Math.sqrt(
    px.reduce((a, p) => a + ((p[0] - mean[0]) ** 2 + (p[1] - mean[1]) ** 2 + (p[2] - mean[2]) ** 2) / 3, 0) /
      px.length
  )
  return { mean, sd, count: px.length }
}

function dominantColour(proxy) {
  // Corner-biased sample: the page ground rather than the subject.
  const { w, h } = proxy.proxy
  const { rgb } = proxy
  const k = Math.max(4, Math.round(Math.min(w, h) * 0.05))
  const spots = [
    [0, 0],
    [w - k, 0],
    [0, h - k],
    [w - k, h - k],
  ]
  const acc = [0, 0, 0, 0]
  for (const [sx, sy] of spots) {
    for (let y = sy; y < sy + k; y++) {
      for (let x = sx; x < sx + k; x++) {
        const i = (y * w + x) * 3
        acc[0] += rgb[i]
        acc[1] += rgb[i + 1]
        acc[2] += rgb[i + 2]
        acc[3]++
      }
    }
  }
  return acc[3] ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]] : [255, 255, 255]
}

/* ------------------------------------------------------------- primitives */

/**
 * 8-connected components with per-component ink statistics. Iterative rather
 * than recursive: a large flat region can be a million-pixel component.
 */
function components(mask, w, h) {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const pixels = new Int32Array(w * h)
  const out = []

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    let sp = 0
    let np = 0
    stack[sp++] = start
    seen[start] = 1
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1

    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i - x) / w
      pixels[np++] = i
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
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1
            stack[sp++] = ni
          }
        }
      }
    }

    if (np < 4) continue
    const box = rect(minX, minY, maxX - minX + 1, maxY - minY + 1)
    out.push({ ...box, ink: inkStats(box, pixels.subarray(0, np), w) })
  }
  return out
}

export function percentile(data, p) {
  const sample = []
  const stride = Math.max(1, Math.floor(data.length / 20000))
  for (let i = 0; i < data.length; i += stride) sample.push(data[i])
  sample.sort((a, b) => a - b)
  return sample[Math.min(sample.length - 1, Math.floor(sample.length * p))] ?? 0
}

const percentileOf = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
}
const median = (arr) => percentileOf(arr, 0.5)
const centreY = (r) => r.y + r.h / 2
const centreX = (r) => r.x + r.w / 2
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const round = (v) => Math.round(v * 1000) / 1000

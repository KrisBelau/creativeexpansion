/**
 * Image renderer (SPEC 6.8).
 *
 * Two things here matter more than they look:
 *
 * 1. Downscaling happens in linear light. sharp/libvips does this when told to,
 *    and it is the difference between clean midtones and the muddy grey most
 *    resizers produce.
 * 2. Sharpening is scale-aware and gentler over type. A single global unsharp
 *    pass at a heavy downscale factor rings around glyph edges, which is exactly
 *    the "resized" tell this product exists to avoid.
 */
import sharp from 'sharp'
import { rect, roundRect, right, bottom } from '../solver/geometry.js'
import { composeRelayout } from './relayout.js'

/** Encodings that can carry an alpha channel. JPEG cannot. */
const ALPHA_CAPABLE = new Set(['png', 'webp'])

export async function renderImage({
  input,
  placement,
  transform,
  extension,
  encoding = 'auto',
  byteCeiling = null,
  targetRatio = 0.9,
  flattenColour = '#ffffff',
}) {
  const canvas = placement.canvas
  const allowed = placement.image?.encodings ?? ['jpg', 'png']
  const format = pickFormat(encoding, allowed, placement)

  // Decide the flatten colour up front, because it has to be applied to the
  // source *before* any geometry. Without this, transparent areas of a master
  // encode to solid black in JPEG — a transparent top band in a Figma or
  // Illustrator export comes out looking like the image was cropped away.
  const flatten = ALPHA_CAPABLE.has(format) ? null : flattenColour
  let relayoutNotes = []

  let pipeline
  if (transform.kind === 'relayout') {
    const composed = await composeRelayout({
      input,
      placement,
      layout: transform.layout,
      background: transform.analysis?.background,
      flattenColour: flatten,
    })
    pipeline = composed.pipeline
    relayoutNotes = composed.notes
  } else if (transform.kind === 'crop') {
    const crop = roundRect(transform.crop)
    pipeline = sourcePipeline(input, flatten)
      .extract({ left: Math.max(0, crop.x), top: Math.max(0, crop.y), width: crop.w, height: crop.h })
      .resize(canvas.w, canvas.h, {
        fit: 'fill',
        kernel: 'lanczos3',
        // Gamma-correct resampling: the whole point of 6.8.
        fastShrinkOnLoad: false,
      })
  } else {
    pipeline = await composeFit({ input, placement, transform, extension, flatten })
  }

  const scaleFactor = scaleOf(transform, canvas)
  pipeline = applySharpening(pipeline, scaleFactor)
  pipeline = pipeline.toColourspace('srgb').withMetadata({ icc: 'srgb' })

  const encoded = await encodeToCeiling({
    pipeline,
    placement,
    format,
    byteCeiling,
    targetRatio,
    flattenColour,
  })
  return { ...encoded, notes: [...relayoutNotes, ...(encoded.notes ?? [])] }
}

/**
 * The source, oriented and (optionally) flattened. `.rotate()` with no argument
 * applies the EXIF orientation; every stage must call it or coordinates diverge.
 */
function sourcePipeline(input, flatten) {
  const p = sharp(input, { failOn: 'none' }).rotate()
  return flatten ? p.flatten({ background: flatten }) : p
}

/* ------------------------------------------------------------ fit + extend */

async function composeFit({ input, placement, transform, extension, flatten }) {
  const canvas = placement.canvas
  const placed = roundRect(transform.placed)

  const scaled = await sourcePipeline(input, flatten)
    .resize(placed.w, placed.h, { fit: 'fill', kernel: 'lanczos3', fastShrinkOnLoad: false })
    .png()
    .toBuffer()

  const background = await buildBackground({ input, placement, extension, placed, flatten })

  return sharp(background).composite([{ input: scaled, left: placed.x, top: placed.y }])
}

async function buildBackground({ input, placement, extension, placed, flatten }) {
  const canvas = placement.canvas
  const strategy = extension?.strategy ?? 'matte'

  if (strategy === 'blur') {
    // Cover-scale the source to fill the canvas, blur it hard, darken it, and let
    // the sharp fitted copy sit on top.
    const sigma = extension.blur?.sigma ?? Math.max(8, Math.min(canvas.w, canvas.h) * 0.035)
    const darken = extension.blur?.darken ?? 0.88
    return sourcePipeline(input, flatten)
      .resize(canvas.w, canvas.h, { fit: 'cover', kernel: 'lanczos3', position: 'centre' })
      .blur(sigma)
      .modulate({ brightness: darken })
      .png()
      .toBuffer()
  }

  if (strategy === 'mirror') {
    // libvips can extend by reflection in one operation.
    return sourcePipeline(input, flatten)
      .resize(placed.w, placed.h, { fit: 'fill', kernel: 'lanczos3', fastShrinkOnLoad: false })
      .extend({
        top: placed.y,
        left: placed.x,
        bottom: canvas.h - bottom(placed),
        right: canvas.w - right(placed),
        extendWith: 'mirror',
      })
      .png()
      .toBuffer()
  }

  if (strategy === 'gradient' || strategy === 'flat') {
    return renderEdgeFill({ placement, extension, placed })
  }

  const fill = extension?.fill ?? '#f0f0f0'
  return sharp({
    create: { width: canvas.w, height: canvas.h, channels: 4, background: fill },
  })
    .png()
    .toBuffer()
}

/**
 * Flat and gradient extension are drawn as SVG bands per side, sampled from the
 * source's own border strips. Exact for designed grounds — no artefact at all.
 */
async function renderEdgeFill({ placement, extension, placed }) {
  const canvas = placement.canvas
  const per = extension.perSide ?? {}
  const base =
    per.top?.fill ?? per.bottom?.fill ?? per.left?.fill ?? per.right?.fill ?? extension.fill ?? '#ffffff'

  const bands = []
  const defs = []
  let gradientId = 0

  const band = (side, x, y, w, h) => {
    if (w <= 0 || h <= 0) return
    const cfg = per[side]
    if (!cfg) {
      bands.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${base}"/>`)
      return
    }
    if (cfg.fill) {
      bands.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${cfg.fill}"/>`)
      return
    }
    // Gradient runs from the join (the `from` colour) outward to the canvas edge.
    const id = `g${gradientId++}`
    const vector =
      side === 'top'
        ? { x1: 0, y1: 1, x2: 0, y2: 0 }
        : side === 'bottom'
          ? { x1: 0, y1: 0, x2: 0, y2: 1 }
          : side === 'left'
            ? { x1: 1, y1: 0, x2: 0, y2: 0 }
            : { x1: 0, y1: 0, x2: 1, y2: 0 }
    defs.push(
      `<linearGradient id="${id}" x1="${vector.x1}" y1="${vector.y1}" x2="${vector.x2}" y2="${vector.y2}">` +
        `<stop offset="0" stop-color="${cfg.from}"/><stop offset="1" stop-color="${cfg.to}"/></linearGradient>`
    )
    bands.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>`)
  }

  band('top', 0, 0, canvas.w, placed.y)
  band('bottom', 0, bottom(placed), canvas.w, canvas.h - bottom(placed))
  band('left', 0, placed.y, placed.x, placed.h)
  band('right', right(placed), placed.y, canvas.w - right(placed), placed.h)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.w}" height="${canvas.h}">` +
    `<defs>${defs.join('')}</defs>` +
    `<rect width="${canvas.w}" height="${canvas.h}" fill="${base}"/>` +
    bands.join('') +
    `</svg>`

  return sharp(Buffer.from(svg)).png().toBuffer()
}

/* -------------------------------------------------------------- sharpening */

function applySharpening(pipeline, scaleFactor) {
  // Only downscales need it, and the further down, the more (to a limit).
  if (scaleFactor >= 0.95) return pipeline
  const drop = Math.min(1, (1 - scaleFactor) / 0.8)
  return pipeline.sharpen({
    sigma: 0.6 + drop * 0.5,
    m1: 0.4 + drop * 0.3, // flat-area sharpening: kept low to avoid noise
    m2: 1.6 + drop * 1.0, // edge sharpening
    x1: 2,
    y2: 12,
    y3: 18,
  })
}

/* ---------------------------------------------------------------- encoding */

/**
 * Binary-search quality to land just under the platform ceiling (SPEC 6.8).
 * Reports what it had to do, so a mushy result is a finding rather than a
 * silent quality loss.
 */
async function encodeToCeiling({ pipeline, placement, format, byteCeiling, targetRatio, flattenColour = '#ffffff' }) {
  const allowed = placement.image?.encodings ?? ['jpg', 'png']
  const notes = []

  if (!byteCeiling) {
    const buffer = await encodeOnce(pipeline, format, format === 'png' ? null : 88)
    return { buffer, format, quality: format === 'png' ? null : 88, bytes: buffer.length, notes }
  }

  const target = Math.floor(byteCeiling * targetRatio)

  if (format === 'png') {
    const png = await encodeOnce(pipeline, 'png', null)
    if (png.length <= target) {
      return { buffer: png, format: 'png', quality: null, bytes: png.length, notes }
    }
    if (allowed.includes('jpg')) {
      notes.push({
        code: 'encoding_switched',
        severity: 'info',
        message: `PNG was ${kb(png.length)} against a ${kb(target)} target; switched to JPEG.`,
      })
      // The pipeline may still carry alpha — it was built for a PNG target.
      // JPEG cannot, and unflattened alpha encodes to black.
      return searchJpeg(pipeline.clone().flatten({ background: flattenColour }), target, byteCeiling, notes)
    }
    // Fall back to a palette PNG.
    const paletted = await pipeline.clone().png({ palette: true, quality: 80, effort: 8 }).toBuffer()
    if (paletted.length > byteCeiling) {
      notes.push({
        code: 'byte_ceiling_exceeded',
        severity: 'blocked',
        message: `Cannot meet the ${kb(byteCeiling)} ceiling: smallest clean PNG is ${kb(paletted.length)}.`,
      })
    }
    return { buffer: paletted, format: 'png', quality: 80, bytes: paletted.length, notes }
  }

  return searchJpeg(pipeline, target, byteCeiling, notes)
}

async function searchJpeg(pipeline, target, ceiling, notes) {
  let lo = 35
  let hi = 95
  let best = null

  for (let i = 0; i < 7; i++) {
    const q = Math.round((lo + hi) / 2)
    const buffer = await encodeOnce(pipeline, 'jpg', q)
    if (buffer.length <= target) {
      best = { buffer, quality: q }
      lo = q + 1
    } else {
      hi = q - 1
    }
    if (lo > hi) break
  }

  if (!best) {
    const floor = await encodeOnce(pipeline, 'jpg', 35)
    if (floor.length > ceiling) {
      notes.push({
        code: 'byte_ceiling_exceeded',
        severity: 'blocked',
        message: `Cannot meet the ${kb(ceiling)} ceiling: even quality 35 is ${kb(floor.length)}. Simplify the creative for this size.`,
      })
    } else {
      notes.push({
        code: 'byte_ceiling_tight',
        severity: 'warn',
        message: `Met the ${kb(ceiling)} ceiling only at quality 35 (${kb(floor.length)}). Expect visible compression, especially around type.`,
      })
    }
    return { buffer: floor, format: 'jpg', quality: 35, bytes: floor.length, notes }
  }

  if (best.quality < 60) {
    notes.push({
      code: 'encoding_quality_low',
      severity: 'warn',
      message: `Quality dropped to ${best.quality} to meet the byte ceiling. Check type edges for artefacts.`,
    })
  }
  return { buffer: best.buffer, format: 'jpg', quality: best.quality, bytes: best.buffer.length, notes }
}

function encodeOnce(pipeline, format, quality) {
  const p = pipeline.clone()
  if (format === 'png') return p.png({ compressionLevel: 9, effort: 8 }).toBuffer()
  if (format === 'webp') return p.webp({ quality: quality ?? 88, effort: 5 }).toBuffer()
  return p.jpeg({ quality: quality ?? 88, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer()
}

function pickFormat(encoding, allowed, placement) {
  if (encoding !== 'auto') {
    if (!allowed.includes(encoding)) throw new Error(`${placement.id} does not accept ${encoding}`)
    return encoding
  }
  // Logo slots want lossless; everything else wants JPEG unless it is unavailable.
  const wantsLossless = /logo/.test(placement.id)
  if (wantsLossless && allowed.includes('png')) return 'png'
  if (allowed.includes('jpg')) return 'jpg'
  if (allowed.includes('png')) return 'png'
  return allowed[0]
}

function scaleOf(transform, canvas) {
  if (transform.kind === 'crop') return canvas.w / transform.crop.w
  return transform.scale
}

const kb = (n) => `${Math.round(n / 1024)} KB`

/**
 * Sample ink and paper colour plus local busyness behind a text box in a
 * rendered buffer, for the contrast check (SPEC 7.2).
 */
export async function makeContrastSampler(buffer) {
  const img = sharp(buffer)
  const meta = await img.metadata()
  const { data, info } = await img.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true })

  return (box) => {
    const x0 = Math.max(0, Math.floor(box.x))
    const y0 = Math.max(0, Math.floor(box.y))
    const x1 = Math.min(info.width, Math.ceil(box.x + box.w))
    const y1 = Math.min(info.height, Math.ceil(box.y + box.h))
    if (x1 <= x0 || y1 <= y0) return null

    const px = []
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * info.width + x) * info.channels
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        px.push({ rgb: [r, g, b], luma: 0.2126 * r + 0.7152 * g + 0.0722 * b })
      }
    }
    if (px.length < 4) return null

    // Ink and paper as the two tonal extremes, by luminance rank. Symmetric
    // tails, deliberately: the type may be dark on light *or* light on dark, and
    // the minority population is the strokes either way, so anything that
    // assumes a polarity (or splits at the midpoint) misreads one of the two
    // cases badly. Trimming to tails also excludes the anti-aliased mid-tones,
    // which otherwise drag both colours together and fail legible type.
    px.sort((a, b) => a.luma - b.luma)
    const tail = Math.max(1, Math.round(px.length * 0.12))
    const inkSlice = px.slice(0, tail)
    const paperSlice = px.slice(px.length - tail)
    const mean = (slice) => {
      const acc = [0, 0, 0]
      for (const p of slice) {
        acc[0] += p.rgb[0]
        acc[1] += p.rgb[1]
        acc[2] += p.rgb[2]
      }
      return acc.map((v) => v / slice.length)
    }

    // Busyness has to be measured *around* the type, not through it: glyph edges
    // are high-frequency by definition, so sampling inside the box flags every
    // piece of text as sitting on busy detail.
    const pad = Math.max(2, Math.round(box.h * 0.4))
    const rx0 = Math.max(0, Math.floor(box.x - pad))
    const ry0 = Math.max(0, Math.floor(box.y - pad))
    const rx1 = Math.min(info.width, Math.ceil(box.x + box.w + pad))
    const ry1 = Math.min(info.height, Math.ceil(box.y + box.h + pad))
    let grad = 0
    let n = 0
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0 + 1; x < rx1; x++) {
        const insideText = x >= x0 && x < x1 && y >= y0 && y < y1
        if (insideText) continue
        const i = (y * info.width + x) * info.channels
        const j = (y * info.width + x - 1) * info.channels
        grad += Math.abs(data[i] - data[j])
        n++
      }
    }

    return {
      ink: mean(inkSlice),
      paper: mean(paperSlice),
      busyness: n ? Math.min(1, grad / n / 60) : 0,
    }
  }
}

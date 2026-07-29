/**
 * Renders an element re-layout (SPEC 6.3).
 *
 * Three steps: build a background plate with the elements patched out, lift each
 * element's real pixels from the master, and composite them where the layout
 * solver put them. Nothing is recognised or regenerated — the type in the output
 * is the same pixels as the type in the master, moved and scaled.
 *
 * The plate is where this can go wrong. Patching a hole is only honest on a
 * ground that is genuinely flat behind the element; src/solver/layout.js gates on
 * exactly that, and the patch colour is sampled from a ring around each element
 * rather than assumed from a global average.
 */
import sharp from 'sharp'
import { roundRect, right, bottom } from '../solver/geometry.js'

/**
 * @param {object} args
 * @param {Buffer|string} args.input
 * @param {object} args.placement
 * @param {object} args.layout   result of planLayout
 * @param {object} args.analysis
 * @param {string} args.flattenColour
 * @returns {Promise<{pipeline: sharp.Sharp, notes: object[]}>}
 */
export async function composeRelayout({ input, placement, layout, background, flattenColour }) {
  const canvas = placement.canvas
  const notes = []

  // Type carried on the hero is already inside the hero's lifted rect, so it is
  // neither patched nor composited separately — doing either would double-draw it.
  const lifted = layout.elements.filter((e) => !e.carriedBy)

  const base = sharp(input, { failOn: 'none' }).rotate()
  const flat = flattenColour ? base.clone().flatten({ background: flattenColour }) : base.clone()
  const master = await flat.png().toBuffer()
  const { width: mw, height: mh } = await sharp(master).metadata()

  // --- 1. the plate --------------------------------------------------------
  // Build the ground synthetically rather than by patching the master and
  // scaling it. Patching only covers the *detected* rects, and detection is tight
  // — a button's pill, a product's cap, the tail of a line of type all sit just
  // outside. Cover-scaling that plate to a taller canvas then magnifies every
  // remnant into unmistakable debris. Re-layout is only attempted on grounds that
  // are flat or a simple ramp (see canRelayout), and both of those can be
  // reproduced exactly, so there is nothing to be gained by carrying the original
  // pixels and a great deal to lose.
  const ground = await buildGround({ canvas, background, master, mw, mh })

  // --- 2. the elements ----------------------------------------------------
  const composites = []
  for (const el of lifted) {
    const src = clampRect(roundRect(el.src), mw, mh)
    const dst = roundRect(el.dst)
    if (!src || dst.w < 1 || dst.h < 1) continue

    const sprite = await sharp(master)
      .extract({ left: src.x, top: src.y, width: src.w, height: src.h })
      .resize(dst.w, dst.h, { fit: 'fill', kernel: 'lanczos3', fastShrinkOnLoad: false })
      .png()
      .toBuffer()

    composites.push({
      input: sprite,
      left: Math.max(0, Math.min(dst.x, canvas.w - dst.w)),
      top: Math.max(0, Math.min(dst.y, canvas.h - dst.h)),
    })
  }

  if (!composites.length) {
    notes.push({
      code: 'relayout_no_elements',
      severity: 'blocked',
      message: 'Re-layout produced no placeable elements.',
    })
  }

  return { pipeline: sharp(ground).composite(composites), notes }
}

/**
 * The reconstructed ground, at canvas size. Flat grounds are a fill; ramps are
 * re-synthesised from the master's top and bottom edge colours so the gradient
 * reads the same on a taller or wider canvas instead of being stretched.
 */
async function buildGround({ canvas, background, master, mw, mh }) {
  const edges = background?.edges
  const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`

  if (background?.classification?.class === 'gradient' && edges?.top && edges?.bottom) {
    const from = hex(edges.top.median)
    const to = hex(edges.bottom.median)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.w}" height="${canvas.h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
      </linearGradient></defs>
      <rect width="${canvas.w}" height="${canvas.h}" fill="url(#g)"/>
    </svg>`
    return sharp(Buffer.from(svg)).png().toBuffer()
  }

  const fill = edges
    ? hex(medianOfMedians([edges.top.median, edges.right.median, edges.bottom.median, edges.left.median]))
    : await dominantColour(master, mw, mh)

  return sharp({ create: { width: canvas.w, height: canvas.h, channels: 4, background: fill } })
    .png()
    .toBuffer()
}

function medianOfMedians(list) {
  return [0, 1, 2].map((c) => {
    const vals = list.map((m) => m[c]).sort((a, b) => a - b)
    return vals[Math.floor(vals.length / 2)]
  })
}

/** Fallback ground: median of the master's own border ring. */
async function dominantColour(master, mw, mh) {
  const strip = Math.max(2, Math.round(Math.min(mw, mh) * 0.04))
  const { data, info } = await sharp(master)
    .extract({ left: 0, top: 0, width: mw, height: strip })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = [[], [], []]
  for (let i = 0; i < info.width * info.height; i++) {
    channels[0].push(data[i * info.channels])
    channels[1].push(data[i * info.channels + 1])
    channels[2].push(data[i * info.channels + 2])
  }
  const med = channels.map((c) => {
    c.sort((a, b) => a - b)
    return c[Math.floor(c.length / 2)]
  })
  return `#${med.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Median colour of a thin ring just outside a rect — the ground immediately
 * behind the element. A global average would bleed in the element's own colours
 * and any accent elsewhere in the frame.
 */
async function ringColour(master, box, mw, mh) {
  const pad = Math.max(2, Math.round(Math.min(box.w, box.h) * 0.25))
  const outer = clampRect(
    { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 },
    mw,
    mh
  )
  if (!outer) return '#ffffff'

  const { data, info } = await sharp(master)
    .extract({ left: outer.x, top: outer.y, width: outer.w, height: outer.h })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const innerX0 = box.x - outer.x
  const innerY0 = box.y - outer.y
  const channels = [[], [], []]

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const insideElement =
        x >= innerX0 && x < innerX0 + box.w && y >= innerY0 && y < innerY0 + box.h
      if (insideElement) continue
      const i = (y * info.width + x) * info.channels
      channels[0].push(data[i])
      channels[1].push(data[i + 1])
      channels[2].push(data[i + 2])
    }
  }

  if (!channels[0].length) return '#ffffff'
  const med = channels.map((c) => {
    c.sort((a, b) => a - b)
    return c[Math.floor(c.length / 2)]
  })
  return `#${med.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function clampRect(r, w, h) {
  const x = Math.max(0, Math.min(r.x, w - 1))
  const y = Math.max(0, Math.min(r.y, h - 1))
  const x1 = Math.max(x + 1, Math.min(right(r), w))
  const y1 = Math.max(y + 1, Math.min(bottom(r), h))
  const out = { x, y, w: x1 - x, h: y1 - y }
  return out.w > 0 && out.h > 0 ? out : null
}

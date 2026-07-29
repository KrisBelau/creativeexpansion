/**
 * Raw pixel plumbing. Analysis runs on a downsampled proxy: full-resolution
 * scans buy nothing for saliency or region detection and cost seconds per source.
 */
import sharp from 'sharp'

/** Single-channel float grid, values in 0..1. */
export class Grid {
  constructor(w, h, data) {
    this.w = w
    this.h = h
    this.data = data ?? new Float32Array(w * h)
  }

  at(x, y) {
    const cx = x < 0 ? 0 : x >= this.w ? this.w - 1 : x
    const cy = y < 0 ? 0 : y >= this.h ? this.h - 1 : y
    return this.data[cy * this.w + cx]
  }

  set(x, y, v) {
    this.data[y * this.w + x] = v
  }

  clone() {
    return new Grid(this.w, this.h, Float32Array.from(this.data))
  }

  /** Sum of values inside a rect given in this grid's coordinate space. */
  sumRect(r) {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(this.w, Math.ceil(r.x + r.w))
    const y1 = Math.min(this.h, Math.ceil(r.y + r.h))
    let s = 0
    for (let y = y0; y < y1; y++) {
      const row = y * this.w
      for (let x = x0; x < x1; x++) s += this.data[row + x]
    }
    return s
  }

  total() {
    let s = 0
    for (let i = 0; i < this.data.length; i++) s += this.data[i]
    return s
  }

  normalise() {
    let min = Infinity
    let max = -Infinity
    for (const v of this.data) {
      if (v < min) min = v
      if (v > max) max = v
    }
    const range = max - min
    if (range < 1e-9) {
      this.data.fill(0)
      return this
    }
    for (let i = 0; i < this.data.length; i++) this.data[i] = (this.data[i] - min) / range
    return this
  }

  /** Integral image for O(1) rect sums — used by the crop search's inner loop. */
  integral() {
    const { w, h, data } = this
    const iw = w + 1
    const acc = new Float64Array(iw * (h + 1))
    for (let y = 0; y < h; y++) {
      let rowSum = 0
      for (let x = 0; x < w; x++) {
        rowSum += data[y * w + x]
        acc[(y + 1) * iw + x + 1] = acc[y * iw + x + 1] + rowSum
      }
    }
    return {
      w,
      h,
      sum(r) {
        const x0 = Math.max(0, Math.min(w, Math.floor(r.x)))
        const y0 = Math.max(0, Math.min(h, Math.floor(r.y)))
        const x1 = Math.max(0, Math.min(w, Math.ceil(r.x + r.w)))
        const y1 = Math.max(0, Math.min(h, Math.ceil(r.y + r.h)))
        return (
          acc[y1 * iw + x1] - acc[y0 * iw + x1] - acc[y1 * iw + x0] + acc[y0 * iw + x0]
        )
      },
    }
  }
}

/** Separable box blur. Radius in pixels; two passes approximate a Gaussian well enough. */
export function boxBlur(grid, radius) {
  if (radius < 1) return grid.clone()
  const { w, h } = grid
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const win = radius * 2 + 1

  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = -radius; x <= radius; x++) acc += grid.at(x, y)
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win
      acc += grid.at(x + radius + 1, y) - grid.at(x - radius, y)
    }
  }

  const tmpGrid = new Grid(w, h, tmp)
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -radius; y <= radius; y++) acc += tmpGrid.at(x, y)
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win
      acc += tmpGrid.at(x, y + radius + 1) - tmpGrid.at(x, y - radius)
    }
  }
  return new Grid(w, h, out)
}

/**
 * Load a source as a downsampled RGB proxy plus per-channel grids.
 * `long` is the target long-edge length of the proxy.
 */
export async function loadProxy(input, long = 512) {
  const image = sharp(input, { failOn: 'none' }).rotate()
  const meta = await image.metadata()
  const srcW = meta.width
  const srcH = meta.height
  const scale = Math.min(1, long / Math.max(srcW, srcH))
  const w = Math.max(8, Math.round(srcW * scale))
  const h = Math.max(8, Math.round(srcH * scale))

  const { data } = await image
    .clone()
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const n = w * h
  const luma = new Grid(w, h)
  const rg = new Grid(w, h)
  const by = new Grid(w, h)
  const rgb = new Uint8Array(data)

  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3] / 255
    const g = rgb[i * 3 + 1] / 255
    const b = rgb[i * 3 + 2] / 255
    luma.data[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
    // Cheap opponent-colour channels: enough to make colour pop register as salient.
    rg.data[i] = (r - g + 1) / 2
    by.data[i] = (b - (r + g) / 2 + 1) / 2
  }

  return {
    meta,
    source: { w: srcW, h: srcH },
    proxy: { w, h, scale },
    rgb,
    luma,
    rg,
    by,
    /** Convert proxy-space coords to source-space. */
    toSource: (r) => ({ x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale }),
    toProxy: (r) => ({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale }),
  }
}

/** Relative luminance of an sRGB triple, per WCAG. */
export function relativeLuminance(r, g, b) {
  const lin = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two sRGB triples (SPEC 7.2). */
export function contrastRatio(a, b) {
  const la = relativeLuminance(...a)
  const lb = relativeLuminance(...b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

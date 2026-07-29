/**
 * Saliency and edge density (SPEC 6.1).
 *
 * Multi-scale centre-surround: at each of several radii, take the absolute
 * difference between the channel and its blurred self, then sum across scales
 * and channels. Cheap, deterministic, no model weights, and good enough to
 * drive crop scoring on designed creative — which is mostly high-contrast
 * subject against simple ground.
 *
 * This is deliberately a classical algorithm rather than a learned model: it
 * has no license, no download, and identical output on every machine, which
 * the determinism requirement in SPEC 13 needs. Replacing it with a learned
 * saliency model later only changes this file.
 */
import { Grid, boxBlur } from './pixels.js'

const SCALES = [2, 4, 8, 16, 32]
const CHANNEL_WEIGHTS = { luma: 1.0, rg: 0.5, by: 0.5 }

export function saliencyMap(proxy) {
  const { w, h } = proxy.proxy
  const out = new Grid(w, h)

  for (const [name, weight] of Object.entries(CHANNEL_WEIGHTS)) {
    const channel = proxy[name]
    for (const radius of SCALES) {
      if (radius >= Math.min(w, h) / 2) continue
      const blurred = boxBlur(channel, radius)
      // Larger surrounds contribute less: fine detail is what draws the eye.
      const scaleWeight = weight / Math.sqrt(radius)
      for (let i = 0; i < out.data.length; i++) {
        out.data[i] += scaleWeight * Math.abs(channel.data[i] - blurred.data[i])
      }
    }
  }

  // Smooth to region-level importance, then normalise.
  const smoothed = boxBlur(out, Math.max(1, Math.round(Math.min(w, h) * 0.02)))
  return smoothed.normalise()
}

/**
 * Mild centre prior. Ads are composed, so the middle usually matters more —
 * but the weighting has to stay gentle or the crop solver just centre-crops,
 * which is the behaviour this whole product exists to avoid.
 */
export function applyCentrePrior(grid, strength = 0.25) {
  const { w, h } = grid
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const maxD = Math.hypot(cx, cy)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD
      const prior = 1 - strength * d * d
      grid.data[y * w + x] *= prior
    }
  }
  return grid.normalise()
}

/** Sobel gradient magnitude, normalised. Feeds text detection and seam scoring. */
export function edgeMap(channel) {
  const { w, h } = channel
  const out = new Grid(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = channel.at(x - 1, y - 1)
      const t = channel.at(x, y - 1)
      const tr = channel.at(x + 1, y - 1)
      const l = channel.at(x - 1, y)
      const r = channel.at(x + 1, y)
      const bl = channel.at(x - 1, y + 1)
      const b = channel.at(x, y + 1)
      const br = channel.at(x + 1, y + 1)
      const gx = tl + 2 * l + bl - tr - 2 * r - br
      const gy = tl + 2 * t + tr - bl - 2 * b - br
      out.data[y * w + x] = Math.hypot(gx, gy) / 4
    }
  }
  return out
}

/**
 * Local high-frequency energy, 0..1, used to catch type that passes a contrast
 * check but sits on detail busy enough to be unreadable anyway (SPEC 7.2).
 */
export function busynessMap(channel) {
  const edges = edgeMap(channel)
  return boxBlur(edges, Math.max(2, Math.round(Math.min(channel.w, channel.h) * 0.01))).normalise()
}

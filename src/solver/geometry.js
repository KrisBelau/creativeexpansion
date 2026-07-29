/** Rectangle helpers. All rects are {x, y, w, h} in pixels, y-down. */

export const rect = (x, y, w, h) => ({ x, y, w, h })

export const right = (r) => r.x + r.w
export const bottom = (r) => r.y + r.h
export const area = (r) => Math.max(0, r.w) * Math.max(0, r.h)
export const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export function intersect(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(right(a), right(b)) - x
  const h = Math.min(bottom(a), bottom(b)) - y
  return w <= 0 || h <= 0 ? null : rect(x, y, w, h)
}

export const overlaps = (a, b) => intersect(a, b) !== null

/** True when `inner` lies wholly inside `outer`, with an optional tolerance in px. */
export function contains(outer, inner, tol = 0) {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    right(inner) <= right(outer) + tol &&
    bottom(inner) <= bottom(outer) + tol
  )
}

/** Fraction of `inner` that falls inside `outer` (0..1). */
export function coverage(outer, inner) {
  const a = area(inner)
  if (a === 0) return 1
  const i = intersect(outer, inner)
  return i ? area(i) / a : 0
}

export function union(rects) {
  if (!rects.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, right(r))
    y1 = Math.max(y1, bottom(r))
  }
  return rect(x0, y0, x1 - x0, y1 - y0)
}

export function inflate(r, by) {
  return rect(r.x - by, r.y - by, r.w + by * 2, r.h + by * 2)
}

export function scaleRect(r, k) {
  return rect(r.x * k, r.y * k, r.w * k, r.h * k)
}

export function roundRect(r) {
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  return rect(x, y, Math.round(right(r)) - x, Math.round(bottom(r)) - y)
}

/** Clamp a rect so it sits inside bounds, preserving size where possible. */
export function clampInside(r, bounds) {
  const w = Math.min(r.w, bounds.w)
  const h = Math.min(r.h, bounds.h)
  const x = Math.min(Math.max(r.x, bounds.x), right(bounds) - w)
  const y = Math.min(Math.max(r.y, bounds.y), bottom(bounds) - h)
  return rect(x, y, w, h)
}

/**
 * The rect inside `canvas` that a placement's safe zone leaves usable.
 * Safe zones are declared as insets from each canvas edge (SPEC 7.3).
 */
export function safeArea(canvas, safeZone) {
  const { top = 0, right: r = 0, bottom: b = 0, left = 0 } = safeZone ?? {}
  return rect(left, top, canvas.w - left - r, canvas.h - top - b)
}

/** Largest rect of the given aspect ratio that fits inside w x h ("contain"). */
export function fitContain(srcW, srcH, dstW, dstH) {
  const k = Math.min(dstW / srcW, dstH / srcH)
  const w = srcW * k
  const h = srcH * k
  return { ...rect((dstW - w) / 2, (dstH - h) / 2, w, h), scale: k }
}

/** Smallest rect of the given aspect that covers w x h ("cover"). */
export function fitCover(srcW, srcH, dstW, dstH) {
  const k = Math.max(dstW / srcW, dstH / srcH)
  const w = srcW * k
  const h = srcH * k
  return { ...rect((dstW - w) / 2, (dstH - h) / 2, w, h), scale: k }
}

/** Map a rect from source pixel space into output pixel space given a crop. */
export function mapRect(r, crop, outW, outH) {
  const kx = outW / crop.w
  const ky = outH / crop.h
  return rect((r.x - crop.x) * kx, (r.y - crop.y) * ky, r.w * kx, r.h * ky)
}

export const aspectOf = (r) => r.w / r.h

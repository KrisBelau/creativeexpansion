/**
 * Registry access. Everything downstream reads placements through here so that
 * `data/formats.json` stays the single source of truth (SPEC 4, 9).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = (f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'))

export const catalog = load('formats.json')
export const legibility = load('legibility.json')
export const presetFile = load('presets.json')

/** Flattened placement list, each entry carrying its platform's inherited fields. */
export const placements = catalog.platforms.flatMap((platform) =>
  platform.placements.map((p) => ({
    ...p,
    platformId: platform.id,
    platformName: platform.name,
    context: p.context ?? platform.context,
    // Uploaded-display platforms declare byte/animation limits once, at platform level.
    image: p.image ?? platform.sharedConstraints?.image,
    aspect: p.aspect ?? deriveAspect(p.canvas),
  }))
)

const byId = new Map(placements.map((p) => [p.id, p]))

export function getPlacement(id) {
  const p = byId.get(id)
  if (!p) throw new Error(`Unknown placement: ${id}`)
  return p
}

export function getPlatform(id) {
  const p = catalog.platforms.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown platform: ${id}`)
  return p
}

/** Placements that can carry a still image. Video needs ffmpeg (SPEC phase 3). */
export function imagePlacements() {
  return placements.filter((p) => p.media.includes('image'))
}

export const presets = presetFile.presets.map((preset) => {
  const fromPlatforms = (preset.platforms ?? []).flatMap((platformId) =>
    getPlatform(platformId).placements.map((p) => p.id)
  )
  const ids = [...new Set([...(preset.placements ?? []), ...fromPlatforms])]
  return { ...preset, resolved: ids }
})

export function getPreset(id) {
  const p = presets.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown preset: ${id}`)
  return p
}

/**
 * Resolve a list of preset ids and/or bare placement ids into placement objects,
 * de-duplicated, keeping only those that accept the given medium.
 */
export function resolvePlacements({ presets: presetIds = [], placements: placementIds = [], medium = 'image' }) {
  const ids = [...placementIds]
  for (const id of presetIds) ids.push(...getPreset(id).resolved)
  const seen = new Set()
  const out = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const p = getPlacement(id)
    if (!p.media.includes(medium)) continue
    out.push(p)
  }
  return out
}

/** The legibility floors and role table that apply to a placement (SPEC 7.1). */
export function legibilityFor(placement) {
  const ctx = legibility.contexts[placement.context]
  if (!ctx) throw new Error(`No legibility context "${placement.context}" for ${placement.id}`)
  return ctx
}

export function roleFloor(placement, role) {
  const ctx = legibilityFor(placement)
  const spec = ctx.roles[role] ?? ctx.roles.default
  if (!spec) return null
  const { canvas } = placement
  let minPx = spec.minPx ?? 0
  if (spec.minPct != null) {
    const basisPx = ctx.basis === 'frameHeight' ? canvas.h : Math.min(canvas.w, canvas.h)
    minPx = Math.max(minPx, (spec.minPct / 100) * basisPx)
  }
  // Email renders at half its retina canvas, so the floor doubles in canvas pixels.
  return { ...spec, role, minPx: minPx / (ctx.measureScale ?? 1) }
}

function deriveAspect(canvas) {
  if (!canvas) return null
  const g = gcd(canvas.w, canvas.h)
  const w = canvas.w / g
  const h = canvas.h / g
  // Collapse ugly reduced ratios (e.g. 728:90 -> 364:45) into a decimal form.
  if (w > 20 || h > 20) return `${(canvas.w / canvas.h).toFixed(2)}:1`
  return `${w}:${h}`
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b)
}

export const byteCeiling = (placement) => placement.image?.maxBytes ?? null
export const safeZoneOf = (placement) => placement.safeZone ?? { top: 0, right: 0, bottom: 0, left: 0 }

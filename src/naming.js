/** Token-based output naming (SPEC 12). */

export const DEFAULT_PATTERN = '{brand}_{concept}_{platform}_{placement}_{w}x{h}_{ratio}_{version}'

const slug = (v) =>
  String(v ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()

export function buildFilename({ pattern = DEFAULT_PATTERN, placement, meta = {}, format }) {
  const tokens = {
    brand: slug(meta.brand ?? 'brand'),
    concept: slug(meta.concept ?? 'concept'),
    platform: slug(placement.platformId),
    placement: slug(placement.id.replace(new RegExp(`^${placement.platformId}_?`), '') || placement.id),
    w: placement.canvas.w,
    h: placement.canvas.h,
    ratio: slug(placement.aspect?.replace(':', 'x') ?? ''),
    duration: meta.duration ? `${meta.duration}s` : '',
    lang: slug(meta.lang ?? ''),
    version: slug(meta.version ?? 'v1'),
    context: slug(placement.context),
  }

  const base = pattern
    .replace(/\{(\w+)\}/g, (_, key) => {
      if (!(key in tokens)) throw new Error(`Unknown naming token: {${key}}`)
      return String(tokens[key])
    })
    // Collapse separators left behind by empty tokens.
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')

  return `${base}.${format === 'jpg' ? 'jpg' : format}`
}

/** Folder path inside the export ZIP. */
export function exportPath(placement) {
  return `${slug(placement.platformName)}/`
}

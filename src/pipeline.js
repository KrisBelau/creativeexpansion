/**
 * Batch pipeline: source + recipe -> outputs (SPEC 6, 9, 11).
 *
 * The ordering here is the product's argument. Solve geometry, then measure
 * legibility against that geometry, then render, then measure contrast against
 * the real pixels, then validate. Nothing is allowed to "fix itself" by lowering
 * a floor — when the constraints cannot be met the output is marked blocked and
 * carries the reason.
 */
import { createHash } from 'node:crypto'
import { resolvePlacements, getPlacement, byteCeiling } from './registry.js'
import { analyse, ENGINE_VERSION } from './analysis/index.js'
import { solveCrop, solveFit } from './solver/crop.js'
import { planExtension, EXTENSION_ORDER } from './solver/extend.js'
import { checkLegibility, checkContrast } from './solver/legibility.js'
import { renderImage, makeContrastSampler } from './render/image.js'
import { validateOutput, validateSet, stateOf } from './validate/rules.js'
import { buildFilename, exportPath, DEFAULT_PATTERN } from './naming.js'

export const DEFAULT_POLICY = {
  extension: EXTENSION_ORDER,
  upscaleLimit: 2.0,
  anchorBias: 'auto',
  matteColour: null,
  onBlocked: 'flag',
}

/**
 * @param {object} args
 * @param {Buffer|string} args.input          source image
 * @param {object} args.recipe                { presets, placements, policy, overrides, naming, meta }
 * @param {object} [args.analysis]            reuse a cached/edited analysis
 * @param {(p:object)=>void} [args.onProgress]
 */
export async function runBatch({ input, recipe, analysis: given = null, onProgress = () => {} }) {
  const policy = { ...DEFAULT_POLICY, ...(recipe.policy ?? {}) }
  const overrides = recipe.overrides ?? {}
  const placements = resolvePlacements({
    presets: recipe.presets ?? [],
    placements: recipe.placements ?? [],
    medium: 'image',
  })

  const sourceHash = createHash('sha256')
    .update(Buffer.isBuffer(input) ? input : Buffer.from(String(input)))
    .digest('hex')
    .slice(0, 16)

  const analysis = given ?? (await analyse(input, { logoReference: recipe.logoReference ?? null }))

  const outputs = []
  let done = 0
  for (const placement of placements) {
    onProgress({ phase: 'render', placementId: placement.id, done, total: placements.length })
    outputs.push(
      await renderOne({ input, placement, analysis, policy, override: overrides[placement.id] ?? {}, recipe })
    )
    done++
  }

  const setFindings = validateSet(outputs)
  // Set-level blockers attach to the outputs they name so the grid shows them.
  for (const f of setFindings) {
    for (const o of outputs) {
      if (!f.message.includes(o.placementId) && !f.message.includes(o.filename)) continue
      o.findings.push(f)
      o.state = stateOf(o.findings)
    }
  }

  const summary = summarise(outputs)
  onProgress({ phase: 'done', ...summary })

  return {
    engineVersion: ENGINE_VERSION,
    sourceHash,
    recipe: { ...recipe, policy },
    analysis: stripMaps(analysis),
    outputs,
    setFindings,
    summary,
  }
}

async function renderOne({ input, placement, analysis, policy, override, recipe }) {
  const findings = []
  const canvas = placement.canvas

  // --- geometry ------------------------------------------------------------
  const cropResult =
    override.transform === 'fit'
      ? { feasible: false, notes: [{ code: 'override_fit', severity: 'info', message: 'Recipe override forced fit-with-extension.' }] }
      : solveCrop({ analysis, placement, anchorBias: override.anchorBias ?? policy.anchorBias })

  let transform
  let extension = { strategy: 'none', seamScore: 0, notes: [] }

  if (cropResult.feasible) {
    transform = { kind: 'crop', crop: cropResult.crop }
  } else {
    for (const note of cropResult.notes ?? []) findings.push({ ...note, severity: note.severity ?? 'info' })
    const fit = solveFit({ analysis, placement, respectSafeZone: hasSafeZone(placement) })
    transform = { kind: 'fit', placed: fit.placed, scale: fit.scale }
    extension = planExtension({
      analysis,
      placement,
      pad: fit.padded,
      allowed: override.extension ?? policy.extension,
      matteColour: override.matteColour ?? policy.matteColour,
    })
  }

  // --- legibility, measured on the solved geometry -------------------------
  const { findings: legFindings, measurements, sizeBlocked } = checkLegibility({
    analysis,
    placement,
    transform,
  })
  findings.push(...legFindings)

  // --- render --------------------------------------------------------------
  let rendered
  try {
    rendered = await renderImage({
      input,
      placement,
      transform,
      extension,
      encoding: override.encoding ?? 'auto',
      byteCeiling: byteCeiling(placement),
    })
  } catch (err) {
    return {
      placementId: placement.id,
      platformId: placement.platformId,
      platformName: placement.platformName,
      placementName: placement.name,
      width: canvas.w,
      height: canvas.h,
      aspect: placement.aspect,
      context: placement.context,
      state: 'blocked',
      findings: [
        ...findings,
        { code: 'render_failed', severity: 'blocked', message: `Render failed: ${err.message}` },
      ],
      measurements,
      transform: describeTransform(transform),
      extension,
      buffer: null,
      filename: null,
    }
  }

  findings.push(...(rendered.notes ?? []))

  // --- contrast, measured on the real pixels -------------------------------
  const sampler = await makeContrastSampler(rendered.buffer)
  findings.push(...checkContrast({ placement, measurements, sampler, skipRegions: sizeBlocked }))

  // --- preflight -----------------------------------------------------------
  findings.push(
    ...(await validateOutput({
      buffer: rendered.buffer,
      format: rendered.format,
      placement,
      analysis,
      transform,
      extension,
    }))
  )

  const filename = buildFilename({
    pattern: recipe.naming ?? DEFAULT_PATTERN,
    placement,
    meta: recipe.meta ?? {},
    format: rendered.format,
  })

  return {
    placementId: placement.id,
    platformId: placement.platformId,
    platformName: placement.platformName,
    placementName: placement.name,
    width: canvas.w,
    height: canvas.h,
    aspect: placement.aspect,
    context: placement.context,
    filename,
    exportPath: exportPath(placement) + filename,
    format: rendered.format,
    quality: rendered.quality,
    bytes: rendered.bytes,
    byteCeiling: byteCeiling(placement),
    state: stateOf(findings),
    findings: dedupeFindings(findings),
    measurements,
    transform: describeTransform(transform),
    extension: { strategy: extension.strategy, seamScore: extension.seamScore },
    retention: cropResult.retention ?? null,
    buffer: rendered.buffer,
  }
}

function describeTransform(transform) {
  if (transform.kind === 'crop') {
    const c = transform.crop
    return {
      kind: 'crop',
      crop: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) },
    }
  }
  return {
    kind: 'fit',
    placed: {
      x: Math.round(transform.placed.x),
      y: Math.round(transform.placed.y),
      w: Math.round(transform.placed.w),
      h: Math.round(transform.placed.h),
    },
    scale: Math.round(transform.scale * 1000) / 1000,
  }
}

const hasSafeZone = (p) => {
  const s = p.safeZone ?? {}
  return Boolean(s.top || s.right || s.bottom || s.left)
}

function dedupeFindings(findings) {
  const seen = new Set()
  const out = []
  for (const f of findings) {
    const key = `${f.code}|${f.regionRef ?? ''}|${f.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out.sort(
    (a, b) => ({ blocked: 0, warn: 1, info: 2 })[a.severity] - ({ blocked: 0, warn: 1, info: 2 })[b.severity]
  )
}

export function summarise(outputs) {
  return {
    total: outputs.length,
    pass: outputs.filter((o) => o.state === 'pass').length,
    warn: outputs.filter((o) => o.state === 'warn').length,
    blocked: outputs.filter((o) => o.state === 'blocked').length,
    exportable: outputs.filter((o) => o.state !== 'blocked').length,
  }
}

/** Maps are large Float32Arrays; never serialise them to a client or manifest. */
function stripMaps(analysis) {
  const { maps, ...rest } = analysis
  return rest
}

/**
 * Export (SPEC 12). Blocked outputs are excluded here — this is the single
 * chokepoint that makes "0 exported outputs below the legibility floor" a
 * property of the code rather than a target to measure.
 */
import { ZipArchive } from 'archiver'
import { ENGINE_VERSION } from './analysis/index.js'
import { catalog } from './registry.js'

export class BlockedExportError extends Error {
  constructor(blocked) {
    super(
      `${blocked.length} output(s) are blocked and cannot be exported: ${blocked
        .map((o) => o.placementId)
        .join(', ')}`
    )
    this.name = 'BlockedExportError'
    this.blocked = blocked
  }
}

/**
 * @param {object} batch  result of runBatch
 * @param {object} opts
 * @param {boolean} [opts.includeBlocked=false]  when true, blocked outputs are
 *   written into a `_blocked/` folder for diagnosis and marked in the manifest.
 *   They are never written into the deliverable tree.
 */
export function buildArchive(batch, { includeBlocked = false, timestamp = null } = {}) {
  const exportable = batch.outputs.filter((o) => o.state !== 'blocked' && o.buffer)
  const blocked = batch.outputs.filter((o) => o.state === 'blocked')

  if (!exportable.length && !includeBlocked) throw new BlockedExportError(blocked)

  const archive = new ZipArchive({ zlib: { level: 9 } })
  for (const o of exportable) archive.append(o.buffer, { name: o.exportPath })

  if (includeBlocked) {
    for (const o of blocked) {
      if (o.buffer) archive.append(o.buffer, { name: `_blocked/${o.filename ?? o.placementId + '.jpg'}` })
    }
  }

  const manifest = buildManifest(batch, { timestamp })
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
  archive.append(toCsv(manifest), { name: 'manifest.csv' })
  archive.append(readme(batch, manifest), { name: 'README.txt' })
  archive.finalize()

  return { archive, manifest, exportable, blocked }
}

export function buildManifest(batch, { timestamp = null } = {}) {
  return {
    generatedAt: timestamp,
    engineVersion: ENGINE_VERSION,
    catalogVersion: catalog.catalogVersion,
    sourceHash: batch.sourceHash,
    recipe: batch.recipe,
    summary: batch.summary,
    outputs: batch.outputs.map((o) => ({
      file: o.state === 'blocked' ? null : o.exportPath,
      placementId: o.placementId,
      platform: o.platformName,
      placement: o.placementName,
      width: o.width,
      height: o.height,
      aspect: o.aspect,
      context: o.context,
      format: o.format ?? null,
      quality: o.quality ?? null,
      bytes: o.bytes ?? null,
      byteCeiling: o.byteCeiling ?? null,
      state: o.state,
      transform: o.transform,
      extension: o.extension,
      saliencyRetention: o.retention,
      altText: altTextFor(o, batch),
      findings: o.findings.map((f) => ({
        code: f.code,
        severity: f.severity,
        message: f.message,
        regionRef: f.regionRef ?? null,
      })),
    })),
    setFindings: batch.setFindings,
    sourceQuality: batch.analysis?.quality ?? null,
  }
}

/**
 * Alt text from what analysis actually knows. Deliberately descriptive of
 * structure rather than invented content: v0 has no OCR, so claiming to know
 * what the copy says would be a fabrication.
 */
function altTextFor(output, batch) {
  const regions = batch.analysis?.regions ?? []
  const text = regions.filter((r) => r.type === 'text')
  const parts = [`${output.platformName} ${output.placementName} advertisement`]
  if (text.length) parts.push(`with ${text.length} text element${text.length === 1 ? '' : 's'}`)
  if (batch.analysis?.logo?.found) parts.push('and a brand logo')
  const dominant = batch.analysis?.palette?.[0]
  if (dominant) parts.push(`on a predominantly ${dominant.hex} background`)
  return parts.join(' ') + '. Replace with a description of the creative before trafficking.'
}

function toCsv(manifest) {
  const cols = [
    'file',
    'placementId',
    'platform',
    'placement',
    'width',
    'height',
    'aspect',
    'context',
    'format',
    'quality',
    'bytes',
    'byteCeiling',
    'state',
    'saliencyRetention',
    'blockedCount',
    'warnCount',
    'findings',
  ]
  const rows = manifest.outputs.map((o) => {
    const blockedCount = o.findings.filter((f) => f.severity === 'blocked').length
    const warnCount = o.findings.filter((f) => f.severity === 'warn').length
    const codes = o.findings.map((f) => `${f.severity}:${f.code}`).join(' ')
    return [
      o.file ?? '',
      o.placementId,
      o.platform,
      o.placement,
      o.width,
      o.height,
      o.aspect,
      o.context,
      o.format ?? '',
      o.quality ?? '',
      o.bytes ?? '',
      o.byteCeiling ?? '',
      o.state,
      o.saliencyRetention ?? '',
      blockedCount,
      warnCount,
      codes,
    ]
  })
  return [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

const csvCell = (v) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function readme(batch, manifest) {
  const { summary } = batch
  const lines = [
    'Creative Expansion export',
    '='.repeat(25),
    '',
    `Engine ${manifest.engineVersion} · format catalog ${manifest.catalogVersion}`,
    `Source hash ${manifest.sourceHash}`,
    '',
    `${summary.exportable} of ${summary.total} outputs are included.`,
    `  pass    ${summary.pass}`,
    `  warn    ${summary.warn}  (included; see manifest for the reasons)`,
    `  blocked ${summary.blocked}  (NOT included)`,
    '',
  ]

  if (summary.blocked) {
    lines.push('Blocked outputs and why:', '')
    for (const o of batch.outputs.filter((x) => x.state === 'blocked')) {
      lines.push(`  ${o.placementId} (${o.width}x${o.height})`)
      for (const f of o.findings.filter((f) => f.severity === 'blocked')) {
        lines.push(`    - ${f.message}`)
      }
      lines.push('')
    }
    lines.push(
      'These were withheld deliberately. An output that cannot meet its',
      'legibility floor or its platform spec is not a deliverable — fix the',
      'input or drop the placement.',
      ''
    )
  }

  lines.push('manifest.json / manifest.csv record every output with its findings.')
  return lines.join('\n')
}

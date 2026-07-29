#!/usr/bin/env node
/**
 * Headless batch run, for testing the pipeline without the UI.
 *
 * Usage:
 *   node scripts/run-batch.mjs <source> [--preset id] [--logo file] [--out dir]
 *                              [--brand name] [--concept name] [--zip]
 */
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs'
import { join, basename } from 'node:path'
import { runBatch } from '../src/pipeline.js'
import { buildArchive, buildManifest } from '../src/export.js'
import { presets } from '../src/registry.js'

const argv = process.argv.slice(2)
if (!argv.length || argv.includes('--help')) {
  console.log(`Usage: node scripts/run-batch.mjs <source> [options]

  --preset <id>    preset to run (repeatable). Default: smoke-test
  --placement <id> single placement (repeatable)
  --logo <file>    brand-kit logo reference, enables logo protection
  --out <dir>      output directory. Default: out/<source-name>
  --brand <name>   naming token
  --concept <name> naming token
  --zip            also write export.zip (blocked outputs excluded)

Available presets:
${presets.map((p) => `  ${p.id.padEnd(26)} ${p.resolved.length.toString().padStart(3)} placements — ${p.name}`).join('\n')}`)
  process.exit(0)
}

const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const flags = (name) => argv.reduce((acc, v, i) => (v === `--${name}` ? [...acc, argv[i + 1]] : acc), [])
const has = (name) => argv.includes(`--${name}`)

const sourcePath = argv[0]
const input = readFileSync(sourcePath)
const logoPath = flag('logo')
const presetIds = flags('preset')
const placementIds = flags('placement')
const outDir = flag('out') ?? join('out', basename(sourcePath).replace(/\.[^.]+$/, ''))

mkdirSync(outDir, { recursive: true })

const recipe = {
  presets: presetIds.length || placementIds.length ? presetIds : ['smoke-test'],
  placements: placementIds,
  logoReference: logoPath ? readFileSync(logoPath) : null,
  meta: {
    brand: flag('brand', 'northwind'),
    concept: flag('concept', basename(sourcePath).replace(/\.[^.]+$/, '')),
    version: 'v1',
  },
}

const started = Date.now()
const batch = await runBatch({
  input,
  recipe,
  onProgress: (p) => {
    if (p.phase === 'render') {
      process.stdout.write(`\r  rendering ${p.done + 1}/${p.total}  ${p.placementId.padEnd(28)}`)
    }
  },
})
process.stdout.write('\r' + ' '.repeat(60) + '\r')

/* ------------------------------------------------------------------ report */

const q = batch.analysis.quality
console.log(`Source     ${sourcePath}  ${batch.analysis.source.w}x${batch.analysis.source.h}`)
console.log(`Background ${batch.analysis.background.classification.class} (flatness ${batch.analysis.background.classification.flatness})`)
console.log(`Regions    ${batch.analysis.regions.length} — ` +
  Object.entries(countBy(batch.analysis.regions, (r) => r.role ?? r.type))
    .map(([k, v]) => `${v} ${k}`)
    .join(', '))
console.log(`Logo       ${batch.analysis.logo.found ? `found (score ${batch.analysis.logo.region?.confidence ?? '?'})` : `not found (best ${batch.analysis.logo.bestScore})`}`)
if (q.findings.length) {
  console.log('Source quality:')
  for (const f of q.findings) console.log(`  [${f.severity}] ${f.message}`)
}
console.log()

const width = Math.max(...batch.outputs.map((o) => o.placementId.length))
for (const o of batch.outputs) {
  const badge = { pass: 'PASS   ', warn: 'WARN   ', blocked: 'BLOCKED' }[o.state]
  const size = `${o.width}x${o.height}`.padEnd(11)
  const bytes = o.bytes ? `${String(Math.round(o.bytes / 1024)).padStart(4)} KB` : '     —'
  const strategy = o.transform.kind === 'crop' ? 'crop' : `fit+${o.extension.strategy}`
  console.log(`${badge}  ${o.placementId.padEnd(width)}  ${size} ${bytes}  ${strategy.padEnd(12)} q${o.quality ?? '—'}`)
  for (const f of o.findings.filter((f) => f.severity !== 'info')) {
    console.log(`         ${f.severity === 'blocked' ? '✗' : '!'} ${f.message}`)
  }
  if (o.buffer && o.filename) writeFileSync(join(outDir, o.filename), o.buffer)
}

console.log()
console.log(`${batch.summary.pass} pass · ${batch.summary.warn} warn · ${batch.summary.blocked} blocked` +
  `   (${batch.summary.exportable}/${batch.summary.total} exportable)`)
console.log(`${((Date.now() - started) / 1000).toFixed(1)}s · wrote ${outDir}/`)

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(buildManifest(batch, { timestamp: null }), null, 2))

if (has('zip')) {
  const { archive } = buildArchive(batch, { includeBlocked: false })
  const zipPath = join(outDir, 'export.zip')
  await new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath)
    out.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(out)
  })
  console.log(`wrote ${zipPath}`)
}

function countBy(arr, fn) {
  const out = {}
  for (const x of arr) {
    const k = fn(x)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

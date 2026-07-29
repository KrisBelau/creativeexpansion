/**
 * HTTP layer. Deliberately thin: upload, analyse, render, export. All the
 * product logic lives in src/ and is exercised identically by scripts/run-batch.mjs,
 * so the UI cannot drift from the CLI.
 *
 * Batches live in memory. Persistence is Postgres + object storage per SPEC 13;
 * for a first stab, a process-local cache keeps the whole thing runnable with no
 * infrastructure.
 */
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { catalog, presets, placements, legibility } from './registry.js'
import { analyse } from './analysis/index.js'
import { runBatch, summarise } from './pipeline.js'
import { buildArchive, buildManifest, BlockedExportError } from './export.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } })

app.use(express.json({ limit: '2mb' }))
app.use(express.static(join(root, 'web')))

/** sourceId -> { buffer, filename, analysis, logo } */
const sources = new Map()
/** batchId -> batch result (buffers included) */
const batches = new Map()

const MAX_SOURCES = 12

/* ------------------------------------------------------------------ config */

app.get('/api/config', (req, res) => {
  res.json({
    catalogVersion: catalog.catalogVersion,
    updatedOn: catalog.updatedOn,
    contexts: Object.fromEntries(
      Object.entries(legibility.contexts).map(([k, v]) => [k, { label: v.label, basis: v.basis }])
    ),
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      count: p.resolved.filter((id) => placements.find((x) => x.id === id)?.media.includes('image')).length,
    })),
    platforms: catalog.platforms.map((p) => ({
      id: p.id,
      name: p.name,
      context: p.context,
      placements: p.placements
        .filter((x) => x.media.includes('image'))
        .map((x) => ({ id: x.id, name: x.name, canvas: x.canvas, aspect: x.aspect })),
    })),
  })
})

/* ------------------------------------------------------------------ upload */

app.post('/api/sources', upload.fields([{ name: 'source' }, { name: 'logo' }]), async (req, res) => {
  try {
    const file = req.files?.source?.[0]
    if (!file) return res.status(400).json({ error: 'No source file supplied.' })

    const logo = req.files?.logo?.[0]?.buffer ?? null
    const id = randomUUID()
    const analysis = await analyse(file.buffer, { logoReference: logo })

    if (sources.size >= MAX_SOURCES) sources.delete(sources.keys().next().value)
    sources.set(id, { buffer: file.buffer, filename: file.originalname, analysis, logo })

    res.json({ id, filename: file.originalname, analysis: publicAnalysis(analysis) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/sources/:id/image', (req, res) => {
  const src = sources.get(req.params.id)
  if (!src) return res.status(404).end()
  res.type('image/png').send(src.buffer)
})

/**
 * Region edits from the review UI. The analysis object is the highest-leverage
 * correction point in the product (SPEC 6.1), so edits replace the auto regions
 * and are marked as human-sourced, which exempts them from confidence downgrades.
 */
app.put('/api/sources/:id/regions', (req, res) => {
  const src = sources.get(req.params.id)
  if (!src) return res.status(404).json({ error: 'Unknown source.' })
  const incoming = req.body?.regions
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'regions must be an array.' })

  src.analysis.regions = incoming.map((r, i) => ({
    id: r.id ?? `human_${i}`,
    type: r.type ?? 'text',
    role: r.role ?? 'body',
    box: { x: +r.box.x, y: +r.box.y, w: +r.box.w, h: +r.box.h },
    capHeight: r.capHeight != null ? +r.capHeight : +r.box.h * 0.72,
    protection: r.protection ?? 'protected',
    source: r.source === 'auto' ? 'auto' : 'human',
    confidence: r.source === 'auto' ? (r.confidence ?? 0.5) : 1,
    sourceContrast: r.sourceContrast ?? null,
  }))

  res.json({ analysis: publicAnalysis(src.analysis) })
})

/* ------------------------------------------------------------------ render */

app.post('/api/batches', async (req, res) => {
  try {
    const { sourceId, presets: presetIds = [], placements: placementIds = [], meta = {}, policy = {} } = req.body ?? {}
    const src = sources.get(sourceId)
    if (!src) return res.status(404).json({ error: 'Unknown source. Re-upload it.' })
    if (!presetIds.length && !placementIds.length) {
      return res.status(400).json({ error: 'Choose at least one preset or placement.' })
    }

    const batch = await runBatch({
      input: src.buffer,
      analysis: src.analysis,
      recipe: {
        presets: presetIds,
        placements: placementIds,
        policy,
        meta: { brand: meta.brand || 'brand', concept: meta.concept || 'concept', version: meta.version || 'v1' },
      },
    })

    const id = randomUUID()
    batches.set(id, { ...batch, sourceId })
    if (batches.size > 8) batches.delete(batches.keys().next().value)

    res.json({ id, ...publicBatch(batch) })
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 4) })
  }
})

app.get('/api/batches/:id', (req, res) => {
  const batch = batches.get(req.params.id)
  if (!batch) return res.status(404).json({ error: 'Unknown batch.' })
  res.json({ id: req.params.id, ...publicBatch(batch) })
})

app.get('/api/batches/:id/outputs/:placementId', (req, res) => {
  const batch = batches.get(req.params.id)
  const out = batch?.outputs.find((o) => o.placementId === req.params.placementId)
  if (!out?.buffer) return res.status(404).end()
  res.type(out.format === 'png' ? 'image/png' : 'image/jpeg').send(out.buffer)
})

app.get('/api/batches/:id/manifest', (req, res) => {
  const batch = batches.get(req.params.id)
  if (!batch) return res.status(404).json({ error: 'Unknown batch.' })
  res.json(buildManifest(batch, { timestamp: new Date().toISOString() }))
})

app.get('/api/batches/:id/export.zip', (req, res) => {
  const batch = batches.get(req.params.id)
  if (!batch) return res.status(404).json({ error: 'Unknown batch.' })
  try {
    const { archive } = buildArchive(batch, {
      includeBlocked: req.query.includeBlocked === '1',
      timestamp: new Date().toISOString(),
    })
    res.attachment(`${batch.recipe.meta?.concept ?? 'export'}.zip`)
    archive.pipe(res)
  } catch (err) {
    if (err instanceof BlockedExportError) {
      return res.status(409).json({
        error: 'Every output is blocked, so there is nothing to deliver.',
        blocked: err.blocked.map((o) => ({
          placementId: o.placementId,
          reasons: o.findings.filter((f) => f.severity === 'blocked').map((f) => f.message),
        })),
      })
    }
    res.status(500).json({ error: err.message })
  }
})

/* ------------------------------------------------------------ serialisation */

/** Strip buffers and Float32Array maps before anything crosses the wire. */
function publicAnalysis(analysis) {
  return {
    engineVersion: analysis.engineVersion,
    source: analysis.source,
    regions: analysis.regions.map((r) => ({
      id: r.id,
      type: r.type,
      role: r.role ?? null,
      box: r.box,
      capHeight: r.capHeight ?? null,
      protection: r.protection,
      confidence: r.confidence,
      source: r.source,
      sourceContrast: r.sourceContrast ?? null,
      lineCount: r.lineCount ?? null,
    })),
    background: {
      classification: analysis.background.classification,
      edges: Object.fromEntries(
        Object.entries(analysis.background.edges).map(([k, v]) => [
          k,
          { flatness: v.flatness, median: v.median, sd: v.sd },
        ])
      ),
    },
    palette: analysis.palette,
    logo: analysis.logo.found
      ? { found: true, confidence: analysis.logo.region.confidence, box: analysis.logo.region.box }
      : { found: false, bestScore: analysis.logo.bestScore, reason: analysis.logo.reason },
    quality: analysis.quality,
  }
}

function publicBatch(batch) {
  return {
    engineVersion: batch.engineVersion,
    sourceHash: batch.sourceHash,
    sourceId: batch.sourceId,
    recipe: batch.recipe,
    summary: batch.summary,
    setFindings: batch.setFindings,
    sourceQuality: batch.analysis?.quality ?? null,
    outputs: batch.outputs.map(({ buffer, ...rest }) => ({
      ...rest,
      safeZone: placements.find((p) => p.id === rest.placementId)?.safeZone ?? null,
      platformDocs: catalog.platforms.find((p) => p.id === rest.platformId)?.docs ?? null,
    })),
  }
}

const port = process.env.PORT ?? 3000
app.listen(port, () => {
  console.log(`Creative Expansion — http://localhost:${port}`)
  console.log(`  format catalog ${catalog.catalogVersion} · ${placements.filter((p) => p.media.includes('image')).length} image placements`)
})

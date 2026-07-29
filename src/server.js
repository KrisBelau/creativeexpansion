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
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename, extname } from 'node:path'
import { readdirSync, readFileSync, existsSync } from 'node:fs'

import { catalog, presets, placements, legibility, resolvePlacements } from './registry.js'
import { analyse } from './analysis/index.js'
import { runBatch, summarise } from './pipeline.js'
import { buildArchive, buildManifest, BlockedExportError } from './export.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = express()

/**
 * Everything is held in memory — sources, rendered buffers, batches — so the
 * ceilings below are what keep a small instance alive. Render's free and starter
 * tiers are 512 MB, and one 40-placement batch of a large master can hold well
 * over 100 MB of pixel buffers at once. Tune with env vars, don't guess.
 */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 24)
const MAX_SOURCES = Number(process.env.MAX_SOURCES ?? 4)
const MAX_BATCHES = Number(process.env.MAX_BATCHES ?? 3)
const MAX_PLACEMENTS_PER_BATCH = Number(process.env.MAX_PLACEMENTS_PER_BATCH ?? 60)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2 },
})

/**
 * Optional gate. A public URL that accepts arbitrary uploads and runs image
 * analysis on them is an obvious way to burn someone else's CPU quota, so set
 * ACCESS_PASSWORD on any deployment that is reachable from the internet.
 */
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD
if (ACCESS_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next()
    const header = req.headers.authorization ?? ''
    const supplied = header.startsWith('Basic ')
      ? Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':')
      : null
    if (supplied != null && equalsConstantTime(supplied, ACCESS_PASSWORD)) return next()
    res.set('WWW-Authenticate', 'Basic realm="Creative Expansion", charset="UTF-8"')
    res.status(401).send('Authentication required.')
  })
}

function equalsConstantTime(a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

app.use(express.json({ limit: '2mb' }))
app.use(express.static(join(root, 'web')))

/** Liveness probe. Deliberately before the auth gate and free of any work. */
app.get('/healthz', (req, res) => res.json({ ok: true, engine: catalog.catalogVersion }))

/** sourceId -> { buffer, filename, analysis, logo } */
const sources = new Map()
/** batchId -> batch result (buffers included) */
const batches = new Map()

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

/**
 * Bundled test masters. A hosted deployment has no CLI to run `npm run sample`
 * with and no local files to hand, so the UI needs a way to demonstrate itself.
 * Generated at build time by scripts/make-sample.mjs.
 */
const SAMPLE_DIR = join(root, 'samples')
const LOGO_SAMPLE = 'logo-reference.png'

app.get('/api/samples', (req, res) => {
  res.json({ samples: listSamples() })
})

function listSamples() {
  if (!existsSync(SAMPLE_DIR)) return []
  return readdirSync(SAMPLE_DIR)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && f !== LOGO_SAMPLE)
    .sort()
    .map((file) => ({
      file,
      label: basename(file, extname(file)).replace(/^master-/, '').replace(/-/g, ' '),
    }))
}

/** Reject anything that is not a plain filename in the samples directory. */
function readSample(name) {
  if (!name || name !== basename(name)) return null
  const path = join(SAMPLE_DIR, name)
  if (!existsSync(path)) return null
  return readFileSync(path)
}

app.post('/api/sources', upload.fields([{ name: 'source' }, { name: 'logo' }]), async (req, res) => {
  try {
    const file = req.files?.source?.[0]
    const sampleName = req.body?.sample

    let buffer
    let filename
    let logo = req.files?.logo?.[0]?.buffer ?? null

    if (file) {
      buffer = file.buffer
      filename = file.originalname
    } else if (sampleName) {
      buffer = readSample(sampleName)
      if (!buffer) return res.status(400).json({ error: `Unknown sample: ${sampleName}` })
      filename = sampleName
      // Samples ship with their own brand mark, so logo protection just works.
      logo ??= readSample(LOGO_SAMPLE)
    } else {
      return res.status(400).json({ error: 'No source file supplied.' })
    }

    const id = randomUUID()
    const analysis = await analyse(buffer, { logoReference: logo })

    while (sources.size >= MAX_SOURCES) sources.delete(sources.keys().next().value)
    sources.set(id, { buffer, filename, analysis, logo })

    res.json({ id, filename, analysis: publicAnalysis(analysis) })
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

    // Guard the instance before doing the work, not after: every rendered buffer
    // is held in memory until the batch is evicted.
    const requested = resolvePlacements({ presets: presetIds, placements: placementIds, medium: 'image' })
    if (requested.length > MAX_PLACEMENTS_PER_BATCH) {
      return res.status(413).json({
        error: `${requested.length} placements exceeds this instance's limit of ${MAX_PLACEMENTS_PER_BATCH}. Render fewer at a time, or raise MAX_PLACEMENTS_PER_BATCH on a larger instance.`,
      })
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
    while (batches.size > MAX_BATCHES) batches.delete(batches.keys().next().value)

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
// 0.0.0.0 explicitly: platform health checks reach the container from outside,
// and a loopback-only bind fails them with no useful error.
app.listen(port, '0.0.0.0', () => {
  const imageCount = placements.filter((p) => p.media.includes('image')).length
  console.log(`Creative Expansion listening on :${port}`)
  console.log(`  format catalog ${catalog.catalogVersion} · ${imageCount} image placements`)
  console.log(`  limits: ${MAX_UPLOAD_MB} MB upload · ${MAX_SOURCES} sources · ${MAX_BATCHES} batches · ${MAX_PLACEMENTS_PER_BATCH} placements/batch`)
  console.log(`  access: ${ACCESS_PASSWORD ? 'password required' : 'OPEN — set ACCESS_PASSWORD if this is public'}`)
  console.log(`  samples: ${listSamples().length} bundled`)
})

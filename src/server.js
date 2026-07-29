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
    sources.set(id, {
      buffer,
      filename,
      analysis,
      logo,
      // Kept so an edit is undoable. Re-running detection would be equivalent but
      // costs seconds, and a reset button that is slow is a reset button nobody
      // trusts enough to use.
      autoRegions: structuredClone(analysis.regions),
      autoFindings: structuredClone(analysis.quality.findings),
    })

    res.json({ id, filename, analysis: publicAnalysis(analysis) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/sources/:id/image', (req, res) => {
  const src = sources.get(req.params.id)
  if (!src) return res.status(404).end()
  // Serve the true type. Labelling a JPEG as PNG relies on browser sniffing, and
  // it hides EXIF orientation from the browser — which then disagrees with the
  // orientation analysis used, putting every region overlay in the wrong place.
  res.type(src.analysis.format ? `image/${src.analysis.format}` : 'application/octet-stream')
  res.send(src.buffer)
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
  if (incoming.length > 200) return res.status(400).json({ error: 'Too many regions.' })

  try {
    src.analysis.regions = incoming.map((r, i) => normaliseRegion(r, i))
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  pruneStaleFindings(src)
  src.analysis.regionsEdited = true
  res.json({ analysis: publicAnalysis(src.analysis) })
})

/** Undo every region edit and restore what detection originally produced. */
app.post('/api/sources/:id/regions/reset', (req, res) => {
  const src = sources.get(req.params.id)
  if (!src) return res.status(404).json({ error: 'Unknown source.' })
  src.analysis.regions = structuredClone(src.autoRegions)
  src.analysis.quality.findings = structuredClone(src.autoFindings)
  src.analysis.regionsEdited = false
  res.json({ analysis: publicAnalysis(src.analysis) })
})

const REGION_TYPES = new Set(['text', 'logo', 'subject', 'product', 'cta', 'legal'])
const REGION_ROLES = new Set(['headline', 'subhead', 'body', 'cta', 'price', 'legal'])
const PROTECTIONS = new Set(['immutable', 'protected', 'droppable'])

function normaliseRegion(r, i) {
  const box = r?.box
  const nums = [box?.x, box?.y, box?.w, box?.h].map(Number)
  if (nums.some((n) => !Number.isFinite(n)) || nums[2] <= 0 || nums[3] <= 0) {
    throw new Error(`Region ${i} has an invalid box.`)
  }
  const type = REGION_TYPES.has(r.type) ? r.type : 'text'
  const role = REGION_ROLES.has(r.role) ? r.role : 'body'
  const human = r.source !== 'auto'
  return {
    id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : `region_${i}`,
    type,
    role: type === 'text' ? role : (r.role ?? null),
    box: { x: nums[0], y: nums[1], w: nums[2], h: nums[3] },
    capHeight: Number.isFinite(Number(r.capHeight)) ? Number(r.capHeight) : nums[3] * 0.72,
    protection: PROTECTIONS.has(r.protection) ? r.protection : 'protected',
    source: human ? 'human' : 'auto',
    // A region a human vouched for is not a guess, so it must not be softened by
    // the low-confidence downgrade that exists to forgive the detector.
    confidence: human ? 1 : Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0.5,
    sourceContrast: Number.isFinite(Number(r.sourceContrast)) ? Number(r.sourceContrast) : null,
    lineCount: Number.isFinite(Number(r.lineCount)) ? Number(r.lineCount) : null,
  }
}

/**
 * Source-level findings that name a region become nonsense once that region is
 * deleted, and a stale warning about type that no longer exists is worse than no
 * warning at all.
 */
function pruneStaleFindings(src) {
  const live = new Set(src.analysis.regions.map((r) => r.id))
  src.analysis.quality.findings = src.autoFindings.filter((f) => !f.regionRef || live.has(f.regionRef))

  const textRegions = src.analysis.regions.filter((r) => r.type === 'text')
  const uncertain = textRegions.filter((r) => r.confidence < 0.45).length
  src.analysis.quality.findings = src.analysis.quality.findings.filter(
    (f) => f.code !== 'text_detection_uncertain' && f.code !== 'no_text_detected'
  )
  if (uncertain) {
    src.analysis.quality.findings.push({
      code: 'text_detection_uncertain',
      severity: 'info',
      message: `${uncertain} of ${textRegions.length} text regions are low confidence. Review them before rendering.`,
    })
  }
  if (!textRegions.length) {
    src.analysis.quality.findings.push({
      code: 'no_text_detected',
      severity: 'info',
      message: 'No type regions remain. Nothing is protected from being cropped through.',
    })
  }
}

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
    format: analysis.format ?? null,
    alpha: analysis.alpha ?? null,
    orientation: analysis.orientation ?? null,
    regionsEdited: Boolean(analysis.regionsEdited),
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

/**
 * Multer rejects an oversized upload in middleware, before any route handler's
 * try/catch can see it. Without this the client gets Express's default HTML
 * error page, the UI's JSON parse fails, and the user is told nothing useful
 * about a limit they can actually do something about.
 */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is over this instance's ${MAX_UPLOAD_MB} MB upload limit. Downsample it, or raise MAX_UPLOAD_MB on a larger instance.`
        : `Upload rejected (${err.code}).`
    return res.status(413).json({ error: message })
  }
  if (res.headersSent) return next(err)
  res.status(500).json({ error: err?.message ?? 'Unexpected server error.' })
})

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

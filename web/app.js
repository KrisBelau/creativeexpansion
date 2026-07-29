/**
 * Review UI. No framework and no build step — this is a first stab, and the
 * interesting parts of the product are in the pipeline, not here.
 *
 * The one thing this must get right is showing *why* an output is blocked, in
 * context: the safe-zone overlay and the type-measurement table are the whole
 * argument for trusting the automation.
 */

const $ = (id) => document.getElementById(id)

const state = {
  config: null,
  source: null, // { id, filename, analysis }
  logoFile: null,
  selectedPresets: new Set(),
  selectedPlacements: new Set(),
  batch: null,
  filter: 'all',
  showOverlay: true,
  highlight: null,
}

const ROLES = ['headline', 'subhead', 'body', 'cta', 'price', 'legal']

/* ------------------------------------------------------------------- boot */

init()

async function init() {
  state.config = await (await fetch('/api/config')).json()
  $('catalogLine').textContent =
    `format catalog ${state.config.catalogVersion} · ${state.config.platforms.reduce((a, p) => a + p.placements.length, 0)} image placements across ${state.config.platforms.length} platforms`

  renderPresets()
  renderPlatformList()
  renderFilters()
  wireUpload()
  await renderSampleLinks()

  $('resetBtn').onclick = () => location.reload()
  $('runBtn').onclick = run
  $('exportBtn').onclick = exportZip
  $('manifestBtn').onclick = () => window.open(`/api/batches/${state.batch.id}/manifest`, '_blank')
  $('toggleOverlay').onclick = () => {
    state.showOverlay = !state.showOverlay
    $('toggleOverlay').textContent = state.showOverlay ? 'hide overlay' : 'show overlay'
    drawSource()
  }
  $('dClose').onclick = closeDrawer
  $('scrim').onclick = closeDrawer
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer())
}

/* ----------------------------------------------------------------- upload */

function wireUpload() {
  const drop = $('drop')
  const input = $('fileInput')

  $('browseBtn').onclick = () => input.click()
  input.onchange = () => input.files[0] && upload(input.files[0])

  $('logoBtn').onclick = () => $('logoInput').click()
  $('logoInput').onchange = () => {
    state.logoFile = $('logoInput').files[0] ?? null
    $('logoLine').innerHTML = state.logoFile
      ? `Logo reference: <b>${escapeHtml(state.logoFile.name)}</b>`
      : ''
  }

  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault()
      drop.classList.add('over')
    })
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault()
      drop.classList.remove('over')
    })
  }
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0]
    if (file) upload(file)
  })
}

/**
 * A hosted instance has no local files to hand, so the bundled test masters are
 * the fastest way to see what the tool actually does.
 */
async function renderSampleLinks() {
  const { samples } = await (await fetch('/api/samples')).json()
  if (!samples.length) return
  $('sampleLine').innerHTML =
    'or try a sample: ' +
    samples
      .map((s) => `<button class="link sample" data-file="${escapeHtml(s.file)}">${escapeHtml(s.label)}</button>`)
      .join(' · ')
  for (const btn of $('sampleLine').querySelectorAll('.sample')) {
    btn.onclick = () => upload(null, btn.dataset.file)
  }
}

async function upload(file, sampleName = null) {
  toast('<span class="spinner"></span>Analysing master…', 0)
  const body = new FormData()
  if (file) body.append('source', file)
  if (sampleName) body.append('sample', sampleName)
  if (state.logoFile) body.append('logo', state.logoFile)

  try {
    const res = await fetch('/api/sources', { method: 'POST', body })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Upload failed')

    state.source = data
    $('drop').classList.add('hidden')
    $('sourceView').classList.remove('hidden')
    $('panelFormats').classList.remove('disabled')
    renderSource()
    toast('Analysed. Pick formats.', 2200)
  } catch (err) {
    toast(err.message, 4000, true)
  }
}

/* ------------------------------------------------------------ source panel */

function renderSource() {
  const { filename, analysis } = state.source
  $('srcName').textContent = filename
  $('srcDims').textContent = `${analysis.source.w} × ${analysis.source.h}`
  $('srcBg').textContent = `${analysis.background.classification.class} (flatness ${analysis.background.classification.flatness})`
  $('srcLogo').textContent = analysis.logo.found
    ? `found · ${analysis.logo.confidence}`
    : state.logoFile
      ? `no match (${analysis.logo.bestScore})`
      : 'no reference'

  $('srcPalette').innerHTML = analysis.palette
    .slice(0, 6)
    .map((c) => `<i style="background:${c.hex}" title="${c.hex} · ${Math.round(c.coverage * 100)}%"></i>`)
    .join('')

  renderRegionList()
  renderSourceFindings()

  const img = new Image()
  img.onload = () => {
    state.sourceImage = img
    drawSource()
  }
  img.src = `/api/sources/${state.source.id}/image`
}

function renderRegionList() {
  const regions = state.source.analysis.regions
  const edited = state.source.analysis.regionsEdited

  if (!regions.length) {
    $('regionList').innerHTML = `<li class="empty">No regions. Nothing is protected, so a crop may cut through anything.</li>`
  } else {
    $('regionList').innerHTML = regions
      .map((r, i) => {
        const isText = r.type === 'text'
        const roleSelect = isText
          ? `<select data-i="${i}" title="Role — this selects which legibility floor applies">${ROLES.map(
              (role) => `<option value="${role}"${role === r.role ? ' selected' : ''}>${role}</option>`
            ).join('')}</select>`
          : `<span class="tag ${r.type}">${r.type}</span>`
        const conf = r.confidence != null ? r.confidence.toFixed(2) : '—'
        const human = r.source === 'human' ? '<span class="tag human" title="Edited by you">you</span>' : ''
        return `<li data-i="${i}">
          ${isText ? `<span class="tag">text</span>` : ''}${roleSelect}${human}
          <span class="conf${r.confidence < 0.45 ? ' low' : ''}" title="detector confidence">${conf}</span>
          <span class="cap">${r.capHeight ? `cap ${Math.round(r.capHeight)}px` : `${Math.round(r.box.w)}×${Math.round(r.box.h)}`}</span>
          <button class="del" data-del="${i}" title="Remove this region — it will no longer be protected or measured">×</button>
        </li>`
      })
      .join('')
  }

  $('regionActions').innerHTML = edited
    ? `<button class="link small" id="resetRegions">restore detected regions</button>`
    : ''
  if (edited) $('resetRegions').onclick = resetRegions

  for (const li of $('regionList').querySelectorAll('li[data-i]')) {
    li.onmouseenter = () => {
      state.highlight = +li.dataset.i
      li.classList.add('hl')
      drawSource()
    }
    li.onmouseleave = () => {
      state.highlight = null
      li.classList.remove('hl')
      drawSource()
    }
  }

  for (const sel of $('regionList').querySelectorAll('select')) {
    sel.onchange = () =>
      saveRegions(
        state.source.analysis.regions.map((r, i) =>
          i === +sel.dataset.i ? { ...r, role: sel.value, source: 'human' } : r
        ),
        `Role changed to ${sel.value}.`
      )
  }

  for (const btn of $('regionList').querySelectorAll('.del')) {
    btn.onclick = () => {
      const i = +btn.dataset.del
      const r = state.source.analysis.regions[i]
      saveRegions(
        state.source.analysis.regions.filter((_, j) => j !== i),
        `Removed the ${r.role ?? r.type} region.`
      )
    }
  }
}

/**
 * Regions are the analysis, and the analysis is what every downstream stage
 * reads — so an edit invalidates any batch already rendered from it. Say so
 * rather than leaving a stale grid looking current.
 */
async function saveRegions(regions, message) {
  try {
    const res = await fetch(`/api/sources/${state.source.id}/regions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regions }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Could not save regions')
    state.source.analysis = data.analysis
    state.regionsDirty = true
    renderRegionList()
    renderSourceFindings()
    drawSource()
    markStale()
    toast(`${message} Re-render to apply.`, 2600)
  } catch (err) {
    toast(err.message, 4000, true)
  }
}

async function resetRegions() {
  try {
    const res = await fetch(`/api/sources/${state.source.id}/regions/reset`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Could not reset')
    state.source.analysis = data.analysis
    state.regionsDirty = true
    renderRegionList()
    renderSourceFindings()
    drawSource()
    markStale()
    toast('Restored the detected regions. Re-render to apply.', 2600)
  } catch (err) {
    toast(err.message, 4000, true)
  }
}

/** Flag the review panel as reflecting a superseded analysis. */
function markStale() {
  if (!state.batch) return
  $('panelReview').classList.add('stale')
  $('staleBadge').hidden = false
  $('runBtn').textContent = 'Re-render'
}

function renderSourceFindings() {
  const findings = state.source.analysis.quality.findings ?? []
  $('sourceFindings').innerHTML = findings.length
    ? `<h4>Source quality</h4>` + findings.map(findingHtml).join('')
    : ''
}

function drawSource() {
  const img = state.sourceImage
  if (!img) return
  const canvas = $('sourceCanvas')
  const maxW = 460
  const scale = Math.min(1, maxW / img.width)
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  if (!state.showOverlay) return

  const colours = {
    text: 'rgba(76,141,255,0.95)',
    logo: 'rgba(139,92,246,0.95)',
    subject: 'rgba(63,185,80,0.8)',
  }

  state.source.analysis.regions.forEach((r, i) => {
    const b = r.box
    const x = b.x * scale
    const y = b.y * scale
    const w = b.w * scale
    const h = b.h * scale
    const active = state.highlight === i

    ctx.lineWidth = active ? 2.5 : r.type === 'subject' ? 1 : 1.5
    ctx.setLineDash(r.type === 'subject' ? [4, 3] : [])
    ctx.strokeStyle = colours[r.type] ?? 'rgba(255,255,255,0.7)'
    ctx.strokeRect(x, y, w, h)

    if (active) {
      ctx.fillStyle = 'rgba(76,141,255,0.16)'
      ctx.fillRect(x, y, w, h)
    }

    if (r.type === 'text' && (active || h > 14)) {
      const labelText = r.role
      ctx.font = '600 10px ui-monospace, monospace'
      const tw = ctx.measureText(labelText).width + 8
      ctx.fillStyle = colours.text
      ctx.fillRect(x, Math.max(0, y - 13), tw, 13)
      ctx.fillStyle = '#fff'
      ctx.fillText(labelText, x + 4, Math.max(9, y - 3.5))
    }
  })
}

/* ---------------------------------------------------------------- formats */

function renderPresets() {
  $('presets').innerHTML = state.config.presets
    .map(
      (p) => `<label class="preset" data-id="${p.id}">
        <input type="checkbox" />
        <span>
          <span class="pname">${escapeHtml(p.name)}</span>
          <span class="pdesc">${escapeHtml(p.description)}</span>
        </span>
        <span class="pcount">${p.count}</span>
      </label>`
    )
    .join('')

  for (const el of $('presets').querySelectorAll('.preset')) {
    const box = el.querySelector('input')
    box.onchange = () => {
      const id = el.dataset.id
      box.checked ? state.selectedPresets.add(id) : state.selectedPresets.delete(id)
      el.classList.toggle('on', box.checked)
      updateSelectionCount()
    }
  }
}

function renderPlatformList() {
  $('platformList').innerHTML = state.config.platforms
    .map(
      (p) => `<div class="platform">
        <h5>${escapeHtml(p.name)} <span style="opacity:.6">· ${p.context}</span></h5>
        <div class="chips">${p.placements
          .map(
            (pl) =>
              `<span class="chip" data-id="${pl.id}" title="${escapeHtml(pl.name)}">${pl.canvas.w}×${pl.canvas.h}</span>`
          )
          .join('')}</div>
      </div>`
    )
    .join('')

  for (const chip of $('platformList').querySelectorAll('.chip')) {
    chip.onclick = () => {
      const id = chip.dataset.id
      if (state.selectedPlacements.has(id)) state.selectedPlacements.delete(id)
      else state.selectedPlacements.add(id)
      chip.classList.toggle('on')
      updateSelectionCount()
    }
  }
}

function updateSelectionCount() {
  const fromPresets = new Set()
  for (const id of state.selectedPresets) {
    const preset = state.config.presets.find((p) => p.id === id)
    // Count is approximate here (presets overlap); the server de-duplicates.
    for (let i = 0; i < preset.count; i++) fromPresets.add(`${id}:${i}`)
  }
  const total = fromPresets.size + state.selectedPlacements.size
  $('selectedCount').textContent = `${total} selected`
  $('runBtn').disabled = total === 0
  $('runNote').textContent = total > 24 ? `${total} renders — this will take a moment.` : ''
}

/* ------------------------------------------------------------------- render */

async function run() {
  $('runBtn').disabled = true
  $('runBtn').innerHTML = '<span class="spinner"></span>Rendering…'

  try {
    const res = await fetch('/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: state.source.id,
        presets: [...state.selectedPresets],
        placements: [...state.selectedPlacements],
        meta: {
          brand: $('metaBrand').value,
          concept: $('metaConcept').value,
          version: $('metaVersion').value,
        },
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Render failed')

    state.batch = data
    state.regionsDirty = false
    $('panelReview').classList.remove('disabled', 'stale')
    $('staleBadge').hidden = true
    renderReview()
    $('panelReview').scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    toast(err.message, 5000, true)
  } finally {
    $('runBtn').disabled = false
    $('runBtn').textContent = state.batch ? 'Re-render' : 'Render'
  }
}

/* ------------------------------------------------------------------- review */

function renderFilters() {
  const opts = [
    ['all', 'All'],
    ['blocked', 'Blocked'],
    ['warn', 'Warn'],
    ['pass', 'Pass'],
  ]
  $('filters').innerHTML = opts
    .map(([k, label]) => `<span class="filter${k === 'all' ? ' on' : ''}" data-k="${k}">${label}</span>`)
    .join('')
  for (const f of $('filters').querySelectorAll('.filter')) {
    f.onclick = () => {
      state.filter = f.dataset.k
      for (const o of $('filters').querySelectorAll('.filter')) o.classList.toggle('on', o === f)
      renderGrid()
    }
  }
}

function renderReview() {
  const s = state.batch.summary
  $('summary').innerHTML = [
    ['', 'total', s.total],
    ['pass', 'pass', s.pass],
    ['warn', 'warn', s.warn],
    ['blocked', 'blocked', s.blocked],
  ]
    .map(([cls, label, n]) => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`)
    .join('')

  $('exportBtn').disabled = s.exportable === 0
  $('exportBtn').textContent = `Export ${s.exportable} ZIP`
  $('manifestBtn').disabled = false
  renderGrid()
}

function renderGrid() {
  // Worst first: attention should go where it is needed (SPEC 10).
  const order = { blocked: 0, warn: 1, pass: 2 }
  const outputs = state.batch.outputs
    .filter((o) => state.filter === 'all' || o.state === state.filter)
    .sort((a, b) => order[a.state] - order[b.state] || a.placementId.localeCompare(b.placementId))

  if (!outputs.length) {
    $('grid').innerHTML = `<p class="note">Nothing in this filter.</p>`
    return
  }

  $('grid').innerHTML = outputs
    .map((o) => {
      const src = o.state === 'blocked' && !o.format
        ? ''
        : `<img src="/api/batches/${state.batch.id}/outputs/${o.placementId}" alt="" loading="lazy" />`
      const blockedCount = o.findings.filter((f) => f.severity === 'blocked').length
      const warnCount = o.findings.filter((f) => f.severity === 'warn').length
      return `<div class="card ${o.state}" data-id="${o.placementId}">
        <div class="thumb">${src}</div>
        <div class="meta">
          <div class="pl"><span class="badge ${o.state}">${o.state}</span>${escapeHtml(o.placementName)}</div>
          <div class="dims">
            <span>${o.width}×${o.height}</span>
            <span>${o.bytes ? Math.round(o.bytes / 1024) + 'KB' : '—'}${blockedCount ? ` · ${blockedCount}✗` : warnCount ? ` · ${warnCount}!` : ''}</span>
          </div>
        </div>
      </div>`
    })
    .join('')

  for (const card of $('grid').querySelectorAll('.card')) {
    card.onclick = () => openDrawer(card.dataset.id)
  }
}

/* ------------------------------------------------------------------- drawer */

function openDrawer(placementId) {
  const o = state.batch.outputs.find((x) => x.placementId === placementId)
  if (!o) return
  state.drawerOutput = o

  $('dTitle').textContent = `${o.platformName} — ${o.placementName}`
  $('dSub').textContent =
    `${o.width}×${o.height} · ${o.aspect} · ${o.context} · ${o.transform.kind === 'crop' ? 'cropped' : `fitted + ${o.extension.strategy}`}`

  $('dFacts').innerHTML = facts(o)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')

  const findings = o.findings.length
    ? o.findings.map(findingHtml).join('')
    : `<p class="note">No findings. This output met every rule.</p>`
  $('dFindings').innerHTML = findings
  $('dMeasure').innerHTML = measureTable(o)

  drawPreview()
  for (const id of ['dSafe', 'dText', 'dCompare']) $(id).onchange = drawPreview

  $('drawer').classList.add('open')
  $('scrim').classList.add('open')
}

function closeDrawer() {
  $('drawer').classList.remove('open')
  $('scrim').classList.remove('open')
}

function drawPreview() {
  const o = state.drawerOutput
  const compare = $('dCompare').checked
  const url = compare
    ? `/api/sources/${state.batch.sourceId}/image`
    : `/api/batches/${state.batch.id}/outputs/${o.placementId}`

  const stage = $('dStage')
  stage.innerHTML = `<img src="${url}" alt="" id="dImg" />`
  const img = $('dImg')

  img.onload = () => {
    const shownW = img.clientWidth
    const shownH = img.clientHeight
    const kx = shownW / (compare ? img.naturalWidth : o.width)
    const ky = shownH / (compare ? img.naturalHeight : o.height)

    if (compare) return // overlays are in output space; skip them on the master

    if ($('dSafe').checked && o.safeZone) {
      const z = o.safeZone
      const usableW = o.width - (z.left ?? 0) - (z.right ?? 0)
      const usableH = o.height - (z.top ?? 0) - (z.bottom ?? 0)
      if (usableW < o.width || usableH < o.height) {
        const div = document.createElement('div')
        div.className = 'zone'
        div.style.left = `${(z.left ?? 0) * kx}px`
        div.style.top = `${(z.top ?? 0) * ky}px`
        div.style.width = `${usableW * kx}px`
        div.style.height = `${usableH * ky}px`
        div.title = 'Platform UI safe zone — nothing may sit outside this box'
        stage.appendChild(div)
      }
    }

    if ($('dText').checked) {
      for (const m of o.measurements ?? []) {
        const div = document.createElement('div')
        const bad = m.floorPx != null && m.renderedCapPx < m.floorPx
        div.className = `tbox${bad ? ' bad' : ''}`
        div.style.left = `${m.box.x * kx}px`
        div.style.top = `${m.box.y * ky}px`
        div.style.width = `${m.box.w * kx}px`
        div.style.height = `${m.box.h * ky}px`
        div.title = `${m.role}: ${m.renderedCapPx}px cap vs ${m.floorPx}px floor`
        stage.appendChild(div)
      }
    }
  }
}

function facts(o) {
  const rows = [
    ['File', o.filename ? `<span title="${escapeHtml(o.filename)}">${escapeHtml(truncate(o.filename, 42))}</span>` : '—'],
    ['Encoding', o.format ? `${o.format}${o.quality ? ` q${o.quality}` : ''}` : '—'],
    ['Size', o.bytes ? `${Math.round(o.bytes / 1024)} KB / ${Math.round(o.byteCeiling / 1024)} KB ceiling` : '—'],
    ['Strategy', o.transform.kind === 'crop' ? 'protected crop' : `fit + ${o.extension.strategy} extension`],
  ]
  if (o.transform.kind === 'crop') {
    const c = o.transform.crop
    rows.push(['Crop', `${c.w}×${c.h} at ${c.x},${c.y}`])
    if (o.retention != null) rows.push(['Saliency kept', `${Math.round(o.retention * 100)}%`])
  } else {
    rows.push(['Scale', `${Math.round(o.transform.scale * 100)}%`])
    rows.push(['Seam score', `${o.extension.seamScore}`])
  }
  return rows
}

function measureTable(o) {
  const rows = o.measurements ?? []
  if (!rows.length) return `<p class="note">No type detected in this output.</p>`
  return `<table class="measure">
    <thead><tr><th>Role</th><th>Cap px</th><th>Floor</th><th>×</th><th>Conf</th></tr></thead>
    <tbody>${rows
      .map((m) => {
        const ratio = m.ratio ?? 0
        const cls = ratio < 1 ? 'bad' : ratio < 1.15 ? 'edge' : ''
        return `<tr class="${cls}">
          <td>${m.role}</td>
          <td>${m.renderedCapPx}</td>
          <td>${m.floorPx ?? '—'}</td>
          <td>${ratio ? ratio.toFixed(2) : '—'}</td>
          <td>${m.confidence?.toFixed(2) ?? '—'}</td>
        </tr>`
      })
      .join('')}</tbody>
  </table>
  <p class="note">Cap px is the rendered cap height. Ratios under 1.00 are below the floor for this
  viewing context and block the output.</p>`
}

function findingHtml(f) {
  const fix = f.suggestedFix ? `<div class="fix">Suggested: ${escapeHtml(describeFix(f.suggestedFix))}</div>` : ''
  return `<div class="finding ${f.severity}">
    <code>${f.severity} · ${f.code}</code>
    ${escapeHtml(f.message)}${fix}
  </div>`
}

function describeFix(fix) {
  switch (fix.action) {
    case 'drop': return 'drop this element for this size'
    case 'scrim': return 'apply the brand scrim behind this type'
    case 'reanchor': return 'move this element clear of the safe zone'
    case 'legal_review': return 'move the legal copy to the landing page and clear it with legal'
    case 'relayout': return `re-lay out from a layered source${fix.note ? ` (${fix.note})` : ''}`
    default: return fix.action
  }
}

/* ------------------------------------------------------------------- export */

async function exportZip() {
  const url = `/api/batches/${state.batch.id}/export.zip`
  const res = await fetch(url)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    return toast(data.error ?? 'Export failed', 5000, true)
  }
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${$('metaConcept').value || 'export'}.zip`
  a.click()
  URL.revokeObjectURL(a.href)

  const s = state.batch.summary
  toast(
    s.blocked
      ? `Exported ${s.exportable}. ${s.blocked} blocked output${s.blocked === 1 ? '' : 's'} withheld — see README.txt in the ZIP.`
      : `Exported ${s.exportable} outputs.`,
    5000
  )
}

/* -------------------------------------------------------------------- util */

let toastTimer
function toast(html, ms = 2600, bad = false) {
  const el = $('toast')
  el.innerHTML = html
  el.classList.toggle('bad', bad)
  el.classList.add('show')
  clearTimeout(toastTimer)
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms)
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

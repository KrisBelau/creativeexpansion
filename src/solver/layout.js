/**
 * Element re-layout (SPEC 6.3, 6.5) — the track that makes an output look
 * designed rather than resized.
 *
 * The crop and fit tracks both move the master as one rigid block. A designer
 * does not: they move the headline, the product, the CTA and the legal line
 * independently, and re-set the type at a size that suits the new canvas. Doing
 * only the rigid transform is why most aspect changes end up as a shrunken
 * master on a colour field — measured at a 23% median scale across a 39-placement
 * fan-out, with 33 of those correctly blocked as illegible.
 *
 * This module treats each detected region as a movable element. It does not need
 * OCR to do that: the element's own pixels are lifted from the master and
 * re-placed, so nothing is recognised, re-typeset or invented. What it cannot do
 * is re-flow a line of text to a different measure — that needs the words, which
 * is Phase 2 proper.
 *
 * Scale is uniform across all elements, deliberately. Scaling elements
 * individually would satisfy the legibility floors more often but would destroy
 * the type hierarchy, and an ad whose subhead outweighs its headline is worse
 * than one that honestly reports it cannot fit.
 */
import { rect, safeArea, intersect, union, right, bottom, coverage } from './geometry.js'
import { roleFloor, legibility } from '../registry.js'
import { edgePadFloor } from './legibility.js'

/** Roles the escalation ladder may drop, in the order it drops them (SPEC 6.5). */
const DROP_ORDER = ['body', 'subhead']

/** Below this, a detection is too uncertain to constrain the whole layout. */
const TRUST = 0.45

/** A hero may stretch this far past its natural scale to fill the frame. */
const HERO_MAX_SCALE = 1.6

/** Vertical room always left for the hero when one is present. */
const HERO_RESERVE = 0.22

/** Region types that become movable elements. */
const MOVABLE = new Set(['text', 'logo', 'subject', 'product'])

/**
 * Can this master be re-laid-out at all? The blocker is the background: lifting
 * an element out leaves a hole, and the hole can only be filled honestly when the
 * ground behind it is reconstructable. Flat and near-flat grounds are exact.
 * Photographic grounds would need real inpainting, and a smeared patch where the
 * headline used to be is worse than an honest letterbox.
 */
export function canRelayout(analysis) {
  const cls = analysis.background.classification
  const elements = analysis.regions.filter((r) => MOVABLE.has(r.type))
  const text = elements.filter((r) => r.type === 'text')

  if (!text.length) {
    return { eligible: false, reason: 'no type was detected, so there is nothing to re-lay-out' }
  }
  if (!['flat', 'gradient'].includes(cls.class)) {
    return {
      eligible: false,
      reason: `the ground is ${cls.class}; lifting elements off it would leave patches that cannot be filled without inventing detail`,
    }
  }
  if (cls.flatness < 0.7) {
    return {
      eligible: false,
      reason: `the ground is only ${(cls.flatness * 100).toFixed(0)}% flat, too varied to patch cleanly behind a moved element`,
    }
  }

  // Elements are lifted as rectangles, so they have to be separable as
  // rectangles. Where two overlap, the sprite for one carries a slice of the
  // other — a fragment of the headline riding along on the product, which is
  // unmistakably broken. Separating them properly needs per-pixel masks, and
  // masking type off a product without the words is guesswork.
  //
  // Containment is fine and expected: a label printed on a product travels with
  // it (see inHero). Partial overlap is the disqualifying case.
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i]
      const b = elements[j]
      const ab = coverage(a.liftBox ?? a.box, b.box)
      const ba = coverage(b.liftBox ?? b.box, a.box)
      const contained = ab > 0.9 || ba > 0.9
      if (contained) continue
      if (ab > 0.04 || ba > 0.04) {
        const worst = Math.round(Math.max(ab, ba) * 100)
        return {
          eligible: false,
          reason:
            `the ${a.role ?? a.type} and ${b.role ?? b.type} regions overlap by ${worst}%, so they cannot be ` +
            `lifted as separate elements — one sprite would carry a slice of the other. A layered source would separate them cleanly`,
        }
      }
    }
  }

  return { eligible: true }
}

/**
 * @returns {{feasible, elements, dropped, scale, notes}} elements carry `src`
 *   (master pixels) and `dst` (target canvas pixels).
 */
export function planLayout({ analysis, placement, allowDropLegal = false }) {
  const canvas = placement.canvas
  const pad = edgePadFloor(canvas)
  const zone = safeArea(canvas, placement.safeZone)
  const content =
    intersect(zone, rect(pad, pad, canvas.w - pad * 2, canvas.h - pad * 2)) ??
    rect(pad, pad, Math.max(1, canvas.w - pad * 2), Math.max(1, canvas.h - pad * 2))

  const all = analysis.regions
    .filter((r) => MOVABLE.has(r.type))
    // The master's own vertical order is its reading order; preserving it is the
    // cheapest way to keep the recomposition feeling like the same ad.
    .sort((a, b) => a.box.y - b.box.y)

  // The hero is the product or subject: it does not belong in the type stack at
  // its natural size, because in the master it usually sits *beside* the copy
  // rather than below it. Stacking it rigidly wastes most of the frame — on a
  // 1:1 to 9:16 change it alone consumed the entire height budget.
  const hero = pickHero(all)

  // A hero that substantially contains a *non-text* element, or more than one
  // text element, is not a product — it is a saliency box that swallowed the
  // composition. Lifting it would composite those elements twice: once inside the
  // hero sprite and once on their own. Refuse it rather than trust it.
  const swallowed = hero
    ? all.filter((r) => r !== hero && coverage(hero.box, r.box) > 0.7)
    : []
  const heroIsBogus =
    hero && (swallowed.some((r) => r.type !== 'text') || swallowed.length > 1)
  const usableHero = heroIsBogus ? null : hero

  // Type printed on the product is part of the product. Lifting it out separately
  // would punch a hole in the hero and strand a label somewhere else in the
  // stack, so it travels with the hero and is measured at the hero's scale.
  const inHero = usableHero
    ? all.filter((r) => r !== usableHero && r.type === 'text' && coverage(usableHero.box, r.box) > 0.7)
    : []

  // A rejected hero is excluded from the stack too: at that size it would consume
  // the whole height budget and it is a bounding box, not an element.
  const stackable = all.filter(
    (r) => r !== usableHero && r !== hero && !inHero.includes(r)
  )

  const dropOrder = allowDropLegal ? [...DROP_ORDER, 'legal'] : DROP_ORDER
  const notes = []
  for (let step = 0; step <= dropOrder.length; step++) {
    const dropRoles = dropOrder.slice(0, step)
    const kept = stackable.filter((e) => !(e.type === 'text' && dropRoles.includes(e.role)))
    if (!kept.length && !usableHero) break

    const solved = solveStack({ elements: kept, hero: usableHero, inHero, content, analysis, placement })
    if (solved.feasible) {
      for (const role of dropRoles) {
        notes.push({
          code: `relayout_dropped_${role}`,
          severity: 'warn',
          message: `Dropped the ${role} copy: keeping it would have forced every element below the legibility floor for this canvas.`,
        })
      }
      return { ...solved, dropped: dropRoles, notes: [...notes, ...solved.notes] }
    }
    notes.push(...solved.notes)
  }

  return {
    feasible: false,
    dropped: [],
    notes: [
      ...notes,
      {
        code: 'relayout_infeasible',
        severity: 'info',
        message: 'No arrangement of the elements meets the legibility floors on this canvas, even after dropping supporting copy.',
      },
    ],
  }
}

/** The rect actually moved: the element, not just its ink. */
const geo = (r) => r.liftBox ?? r.box

/** Largest subject/product region — the thing the ad is actually showing. */
function pickHero(regions) {
  const candidates = regions.filter((r) => r.type === 'subject' || r.type === 'product')
  if (!candidates.length) return null
  return candidates.reduce((a, b) => (a.box.w * a.box.h >= b.box.w * b.box.h ? a : b))
}

function solveStack({ elements, hero, inHero, content, analysis, placement }) {
  const notes = []

  // --- the scale window ---------------------------------------------------
  // Floor: the smallest uniform scale at which every trusted piece of type is
  // legible. Low-confidence detections are excluded — one uncertain false
  // positive on a product label was single-handedly making every canvas
  // infeasible, which is the detector's doubt leaking into a hard constraint.
  let kMin = 0
  let binding = null
  let ignored = 0
  for (const e of elements) {
    if (e.type !== 'text' || !e.capHeight) continue
    const floor = roleFloor(placement, e.role)
    if (!floor) continue
    if ((e.confidence ?? 1) < TRUST) {
      ignored++
      continue
    }
    const needed = floor.minPx / e.capHeight
    if (needed > kMin) {
      kMin = needed
      binding = { role: e.role, needed, floor: floor.minPx }
    }
  }
  if (ignored) {
    notes.push({
      code: 'relayout_ignored_uncertain',
      severity: 'info',
      message: `${ignored} low-confidence text region${ignored === 1 ? '' : 's'} did not constrain the layout. Confirm or remove them if they are real.`,
    })
  }

  // Ceiling: the largest uniform scale that still fits. Gaps are compressible, so
  // they sit at a minimum here and receive the slack afterwards.
  const gaps = []
  for (let i = 1; i < elements.length; i++) {
    gaps.push(Math.max(0, geo(elements[i]).y - bottom(geo(elements[i - 1]))))
  }
  const minGap = content.h * 0.015
  const stackH = elements.reduce((a, e) => a + geo(e).h, 0)
  const widest = elements.length ? Math.max(...elements.map((e) => geo(e).w)) : 1
  const reserve = hero ? content.h * HERO_RESERVE : 0

  const kW = content.w / widest
  const kH = stackH > 0 ? (content.h - gaps.length * minGap - reserve) / stackH : Infinity
  const kMax = Math.min(kW, kH)

  if (!(kMax > 0) || kMin > kMax + 1e-6) {
    return {
      feasible: false,
      notes: [
        ...notes,
        {
          code: 'relayout_scale_conflict',
          severity: 'info',
          message: binding
            ? `The ${binding.role} needs ${(binding.needed * 100).toFixed(0)}% scale to clear its ${binding.floor.toFixed(0)}px floor, but only ${(Math.max(0, kMax) * 100).toFixed(0)}% fits the usable area.`
            : 'The elements do not fit the usable area at any scale.',
        },
      ],
    }
  }

  const preferred = Math.min(content.w, content.h) / Math.min(analysis.source.w, analysis.source.h)
  const k = Math.min(kMax, Math.max(kMin, preferred))

  if (k > 1.15) {
    notes.push({
      code: 'relayout_upscaled_elements',
      severity: 'warn',
      message: `Elements were scaled to ${(k * 100).toFixed(0)}% to meet the legibility floors here. Their pixels are interpolated — a layered source would let the type be re-set instead of enlarged.`,
    })
  }

  // --- vertical distribution ---------------------------------------------
  // The hero is elastic: the type stack takes what it needs, and the hero fills
  // whatever is left, up to a limit, at its own uniform scale.
  const textH = stackH * k
  let heroH = 0
  let heroScale = 0
  if (hero) {
    const available = Math.max(0, content.h - textH - gaps.length * minGap)
    heroScale = Math.min(HERO_MAX_SCALE, available / geo(hero).h, content.w / geo(hero).w)
    if (heroScale <= 0.05) {
      return {
        feasible: false,
        notes: [
          ...notes,
          {
            code: 'relayout_no_room_for_subject',
            severity: 'info',
            message: 'After placing the type there is no usable room left for the product.',
          },
        ],
      }
    }
    heroH = geo(hero).h * heroScale
  }

  // Insert the hero back into the reading order it had in the master.
  const order = [...elements]
  if (hero) {
    const at = order.findIndex((e) => e.box.y > hero.box.y)
    order.splice(at < 0 ? order.length : at, 0, hero)
  }

  const usedH = textH + heroH
  const slots = Math.max(1, order.length - 1)
  const leftover = Math.max(0, content.h - usedH)
  const share = leftover / slots

  const masterContent = union(order.map((e) => geo(e)))
  const placed = []
  let y = content.y

  for (let i = 0; i < order.length; i++) {
    const e = order[i]
    const scale = e === hero ? heroScale : k
    const g = geo(e)
    const w = g.w * scale
    const h = g.h * scale
    const dst = { x: horizontal(e, w, content, masterContent), y, w, h }
    placed.push({
      regionId: e.id,
      type: e.type,
      role: e.role ?? null,
      scale,
      src: { x: g.x, y: g.y, w: g.w, h: g.h },
      dst,
      // Where the region's own ink lands, for legibility and safe-zone checks: the
      // lift box carries surrounding ground that must not count as content.
      boxDst: {
        x: dst.x + (e.box.x - g.x) * scale,
        y: dst.y + (e.box.y - g.y) * scale,
        w: e.box.w * scale,
        h: e.box.h * scale,
      },
      capHeight: e.capHeight ? e.capHeight * scale : null,
    })

    // Type carried on the hero moves with it, so its destination is derived from
    // the hero's rather than assigned its own slot.
    if (e === hero) {
      for (const child of inHero) {
        const childDst = {
          x: dst.x + (child.box.x - g.x) * heroScale,
          y: dst.y + (child.box.y - g.y) * heroScale,
          w: child.box.w * heroScale,
          h: child.box.h * heroScale,
        }
        placed.push({
          regionId: child.id,
          type: child.type,
          role: child.role ?? null,
          scale: heroScale,
          carriedBy: hero.id,
          src: { x: child.box.x, y: child.box.y, w: child.box.w, h: child.box.h },
          dst: childDst,
          boxDst: childDst,
          capHeight: child.capHeight ? child.capHeight * heroScale : null,
        })
      }
    }

    y += h
    if (i < order.length - 1) y += share
  }

  // Pull the stack back inside the content box if rounding pushed it past.
  const last = placed.filter((p) => !p.carriedBy).pop()
  const overflow = last ? bottom(last.dst) - bottom(content) : 0
  if (overflow > 0.5) for (const p of placed) p.dst.y -= overflow

  return { feasible: true, elements: placed, scale: k, heroScale, kMin, kMax, notes }
}

/**
 * Keep each element's horizontal intent. Something centred in the master stays
 * centred; something left-aligned keeps its proportional inset. Getting this
 * wrong is what makes a recomposition read as a machine's work.
 */
function horizontal(element, dstW, content, masterContent) {
  const g = geo(element)
  const elCentre = g.x + g.w / 2
  const mcCentre = masterContent.x + masterContent.w / 2
  const wasCentred = Math.abs(elCentre - mcCentre) < masterContent.w * 0.08

  if (wasCentred) return content.x + (content.w - dstW) / 2

  const relLeft = (g.x - masterContent.x) / Math.max(1, masterContent.w)
  const x = content.x + relLeft * content.w
  // Never let the proportional inset push an element off the usable area.
  return Math.min(Math.max(x, content.x), right(content) - dstW)
}

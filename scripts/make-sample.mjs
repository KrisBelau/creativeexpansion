#!/usr/bin/env node
/**
 * Synthesises test masters that exercise the hard cases: type at several sizes
 * including a legal line near the floor, a logo in a corner, a subject offset
 * from centre, and background classes that select different extension
 * strategies.
 *
 * Usage: node scripts/make-sample.mjs [outDir]
 */
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2] ?? 'samples'
mkdirSync(outDir, { recursive: true })

const BRAND = { ink: '#0d1b2a', accent: '#e2703a', light: '#f4f1ea', mid: '#c7d3dd' }

/** The logo mark, also written on its own so it can be a brand-kit reference. */
const logoSvg = (w = 240, h = 60) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 240 60">
  <circle cx="28" cy="30" r="20" fill="${BRAND.accent}"/>
  <path d="M20 30 L27 38 L38 22" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="58" y="40" font-family="DejaVu Sans" font-size="30" font-weight="bold" fill="${BRAND.ink}">NORTHWIND</text>
</svg>`

/** 1:1 master on a flat ground — the common designed-creative case. */
const flatMaster = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
  <rect width="1080" height="1080" fill="${BRAND.light}"/>

  <!-- subject: offset right of centre so a centre-crop would be visibly wrong -->
  <g transform="translate(660,470)">
    <ellipse cx="0" cy="150" rx="150" ry="22" fill="#00000018"/>
    <rect x="-78" y="-190" width="156" height="330" rx="26" fill="${BRAND.ink}"/>
    <rect x="-78" y="-190" width="156" height="120" rx="26" fill="${BRAND.accent}"/>
    <rect x="-40" y="-230" width="80" height="48" rx="10" fill="#8a9aa8"/>
    <text x="0" y="40" font-family="DejaVu Sans" font-size="26" font-weight="bold"
          fill="#fff" text-anchor="middle">NW-9</text>
  </g>

  <g font-family="DejaVu Sans" fill="${BRAND.ink}">
    <text x="90" y="330" font-size="96" font-weight="bold">Built for</text>
    <text x="90" y="430" font-size="96" font-weight="bold">the long</text>
    <text x="90" y="530" font-size="96" font-weight="bold">haul.</text>
    <text x="90" y="610" font-size="44" fill="#44586a">Ten-year guarantee on every unit.</text>
  </g>

  <g transform="translate(90,880)">
    <rect x="0" y="0" width="330" height="86" rx="43" fill="${BRAND.accent}"/>
    <text x="165" y="56" font-family="DejaVu Sans" font-size="36" font-weight="bold"
          fill="#fff" text-anchor="middle">Shop the range</text>
  </g>

  <text x="90" y="1030" font-family="DejaVu Sans" font-size="21" fill="#5b6b7a">
    Guarantee applies to registered products only. Terms at northwind.example/terms.
  </text>

  <g transform="translate(90,90)">${inner(logoSvg(240, 60))}</g>
</svg>`

/** 16:9 master on a photographic-ish ground — forces blur/mirror extension. */
const photoMaster = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c3f5c"/><stop offset="1" stop-color="#6b8fa8"/>
    </linearGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/>
      <feColorMatrix type="saturate" values="0"/></filter>
  </defs>
  <rect width="1920" height="1080" fill="url(#sky)"/>
  <rect width="1920" height="1080" filter="url(#grain)" opacity="0.16"/>
  <path d="M0 760 L340 560 L700 780 L1080 500 L1460 740 L1920 560 L1920 1080 L0 1080 Z" fill="#123047"/>
  <path d="M0 880 L420 740 L900 920 L1400 800 L1920 900 L1920 1080 L0 1080 Z" fill="#0b2233"/>

  <g font-family="DejaVu Sans" fill="#ffffff">
    <text x="120" y="300" font-size="104" font-weight="bold">Where the road ends.</text>
    <text x="120" y="380" font-size="42" fill="#d6e3ec">The NW-9 keeps going.</text>
  </g>
  <text x="120" y="1010" font-family="DejaVu Sans" font-size="20" fill="#b9c9d6">
    Professional driver on a closed course. Do not attempt.
  </text>
  <g transform="translate(1600,60)">${inner(logoSvg(240, 60))}</g>
</svg>`

/** Deliberately hostile: dense copy that cannot survive a small canvas. */
const denseMaster = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="628">
  <rect width="1200" height="628" fill="#ffffff"/>
  <rect width="1200" height="628" fill="none" stroke="#e3e3e3" stroke-width="2"/>
  <g font-family="DejaVu Sans" fill="#111">
    <text x="60" y="120" font-size="58" font-weight="bold">Spring service event</text>
    <text x="60" y="180" font-size="30">Book any service before 30 April and get a free inspection.</text>
    <text x="60" y="230" font-size="24" fill="#444">Includes a 42-point check, fluid top-up, and a wash.</text>
    <text x="60" y="272" font-size="24" fill="#444">Available at all participating Northwind service centres.</text>
    <text x="60" y="314" font-size="24" fill="#444">No appointment needed for existing customers.</text>
  </g>
  <g transform="translate(60,420)">
    <rect x="0" y="0" width="260" height="64" rx="8" fill="${BRAND.accent}"/>
    <text x="130" y="42" font-family="DejaVu Sans" font-size="28" font-weight="bold"
          fill="#fff" text-anchor="middle">Book now</text>
  </g>
  <text x="60" y="570" font-family="DejaVu Sans" font-size="16" fill="#666">
    Offer subject to availability and excludes parts. Cannot be combined with other offers. See terms.
  </text>
  <g transform="translate(880,60) scale(0.9)">${inner(logoSvg(240, 60))}</g>
</svg>`

/** Strip the outer <svg> wrapper so a mark can be nested in another document. */
function inner(svg) {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
}

const jobs = [
  ['master-flat-1x1.png', flatMaster()],
  ['master-photo-16x9.png', photoMaster()],
  ['master-dense-1.91x1.png', denseMaster()],
]

for (const [name, svg] of jobs) {
  const buf = await sharp(Buffer.from(svg)).png().toBuffer()
  writeFileSync(join(outDir, name), buf)
  const m = await sharp(buf).metadata()
  console.log(`${name.padEnd(28)} ${m.width}x${m.height}  ${Math.round(buf.length / 1024)} KB`)
}

const logo = await sharp(Buffer.from(logoSvg(480, 120))).png().toBuffer()
writeFileSync(join(outDir, 'logo-reference.png'), logo)
console.log(`${'logo-reference.png'.padEnd(28)} 480x120  ${Math.round(logo.length / 1024)} KB`)

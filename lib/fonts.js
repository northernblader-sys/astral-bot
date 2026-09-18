/**
 * fonts.js — makes canvas text actually render on a container host.
 *
 * Why this exists: every *-render.mjs asks for generic families —
 * `ctx.font = 'bold 40px sans-serif'`, `'13px serif'`, `'bold 38px Georgia'`.
 * On a dev laptop those resolve against the OS font set and look fine. On
 * Railway (and any slim node:*-slim / distroless image) there are no fonts
 * installed and no fontconfig, so @napi-rs/canvas resolves 'sans-serif' to
 * nothing and draws NOTHING — every label, name, number and price comes out
 * blank while the boxes, bars and images behind them render perfectly. That
 * is the "script is not writing values on the generated stuff" bug: the
 * script wrote them, there was just no glyph to draw.
 *
 * Fix is two-sided and this is the half that always works:
 *   1. lib/assets/fonts/ now ships DejaVu (free, Bitstream Vera derived, the
 *      same family most Linux boxes use as their default), so the fonts
 *      travel with the repo and no longer depend on the host image.
 *   2. Each file is registered under EVERY family name the renderers ask
 *      for, including the generic ones. @napi-rs/canvas matches registered
 *      families by name, so registering a real file as "sans-serif" is what
 *      makes `ctx.font = '16px sans-serif'` resolve instead of falling
 *      through to an empty font set.
 *
 * Import it for side effects — `import '../lib/fonts.js'` — at the top of
 * anything that draws. Registration is idempotent and runs once per process.
 *
 * If a host DOES have fonts (local dev, or a Dockerfile that apt-installs
 * fonts-dejavu-core), nothing here hurts: these registrations simply win.
 */
import { GlobalFonts } from '@napi-rs/canvas'
import { existsSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const FONT_DIR = fileURLToPath(new URL('./assets/fonts/', import.meta.url))
const EXTRA_DIR = fileURLToPath(new URL('./assets/inventory/', import.meta.url))

/**
 * Generic + named families the renderers actually use, mapped to the file
 * that should answer for them. Keep the left-hand side in sync with whatever
 * `ctx.font = ...` strings exist in lib/*-render.mjs.
 */
const ALIASES = {
  'DejaVuSans.ttf': [
    'sans-serif', 'DejaVu Sans', 'Arial', 'Helvetica', 'Segoe UI', 'Roboto', 'Verdana', 'Tahoma',
  ],
  'DejaVuSans-Bold.ttf': [
    'DejaVu Sans Bold', 'Arial Bold',
  ],
  'DejaVuSerif.ttf': [
    'serif', 'DejaVu Serif', 'Georgia', 'Times New Roman', 'Times',
  ],
  'DejaVuSerif-Bold.ttf': [
    'DejaVu Serif Bold', 'Georgia Bold',
  ],
  'DejaVuSansMono.ttf': [
    'monospace', 'DejaVu Sans Mono', 'Courier New', 'Consolas',
  ],
  'DejaVuSans-Oblique.ttf': [
    'DejaVu Sans Oblique',
  ],
}

/** Display faces that were already in the repo and are asked for by name. */
const EXTRA_ALIASES = {
  'Orbitron-Bold.ttf': ['Orbitron', 'Orbitron Bold'],
  'Bangers-Regular.ttf': ['Bangers'],
}

let registered = false
let summary = { files: 0, families: 0, dir: FONT_DIR, ok: false, error: null }

export function registerFonts() {
  if (registered) return summary
  registered = true

  const register = (dir, table) => {
    for (const [file, families] of Object.entries(table)) {
      const full = path.join(dir, file)
      if (!existsSync(full)) continue
      let any = false
      for (const family of families) {
        try {
          // Same file, several family names — this is what lets a generic
          // 'sans-serif' request resolve to a real face.
          if (GlobalFonts.registerFromPath(full, family)) { summary.families++; any = true }
        } catch {
          // A single alias failing is not worth taking the process down for.
        }
      }
      if (any) summary.files++
    }
  }

  register(FONT_DIR, ALIASES)
  register(EXTRA_DIR, EXTRA_ALIASES)

  // Anything else dropped into assets/fonts later registers under its own
  // name automatically, so adding a font is a copy, not a code change.
  try {
    if (existsSync(FONT_DIR)) {
      for (const f of readdirSync(FONT_DIR)) {
        if (!/\.(ttf|otf)$/i.test(f) || ALIASES[f]) continue
        try { GlobalFonts.registerFromPath(path.join(FONT_DIR, f)); summary.files++ } catch {}
      }
    }
  } catch {}

  summary.ok = summary.families > 0
  if (!summary.ok) {
    process.stderr.write(
      `[fonts] ⚠️ no fonts registered from ${FONT_DIR} — canvas text will render blank. ` +
      `Check that lib/assets/fonts/*.ttf was committed and deployed.\n`,
    )
  }
  return summary
}

/** Reported by plugins/health.js so a blank-text deploy is diagnosable. */
export function fontStatus() {
  return { ...summary }
}

registerFonts()

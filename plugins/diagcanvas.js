/**
 * diagcanvas — TEMPORARY diagnostic command.
 * Usage: .diagcanvas
 * Checks, from inside the running bot process, whether @napi-rs/canvas and
 * gif-encoder-2 actually load, and whether the 3 mandatory battle assets
 * are present on disk. Reports results back in chat — no VPS shell needed.
 * Delete this file once the battle-frame issue is confirmed fixed.
 */
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { resolveImageSource } from '../lib/image.js'

const __dir = dirname(fileURLToPath(import.meta.url))

export default {
  name: 'diagcanvas',
  aliases: ['diagbattle'],
  category: 'utility',
  description: 'TEMP: diagnose battle-frame render dependencies',

  async run(ctx) {
    const lines = ['🔍 *Battle-frame diagnostic*\n']

    // 1. @napi-rs/canvas
    try {
      await import('@napi-rs/canvas')
      lines.push('✅ @napi-rs/canvas loads fine')
    } catch (e) {
      lines.push(`❌ @napi-rs/canvas FAILED: ${e.message}`)
    }

    // 2. gif-encoder-2
    try {
      await import('gif-encoder-2')
      lines.push('✅ gif-encoder-2 loads fine')
    } catch (e) {
      lines.push(`❌ gif-encoder-2 FAILED: ${e.message}`)
    }

    // 3. battle-frame-render.mjs itself
    try {
      await import('../lib/battle-frame-render.mjs')
      lines.push('✅ battle-frame-render.mjs imports fine')
    } catch (e) {
      lines.push(`❌ battle-frame-render.mjs FAILED to import: ${e.message}`)
    }

    // 4. Mandatory asset files — checked via lib/image.js's remote IMAGES
    //    map first (battle-frame-render.mjs now checks it too), then local
    //    disk as fallback.
    const assetDir = join(__dir, '..', 'lib', 'assets', 'battle')
    const mandatory = ['background_default.png', 'character_default.png', 'monster_default.png']
    for (const f of mandatory) {
      const mapped = resolveImageSource(f)
      if (/^https?:\/\//i.test(mapped)) {
        lines.push(`✅ ${f} resolves to remote URL (${mapped})`)
        continue
      }
      const p = join(assetDir, f)
      lines.push(existsSync(p) ? `✅ ${f} found locally` : `❌ ${f} MISSING (no remote map entry, not at ${p})`)
    }

    // 5. Optional character-state sheets — no remote entries yet, local only
    const optional = ['character_attack.png', 'character_hurt.png', 'character_dead.png', 'character_defend.png']
    for (const f of optional) {
      const mapped = resolveImageSource(f)
      if (/^https?:\/\//i.test(mapped)) {
        lines.push(`✅ ${f} resolves to remote URL (${mapped})`)
        continue
      }
      const p = join(assetDir, f)
      lines.push(existsSync(p) ? `✅ ${f} found locally` : `⚠️ ${f} missing (optional — falls back to character_default.png)`)
    }

    await ctx.reply(lines.join('\n'))
  },
}

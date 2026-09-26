/**
 * title-glyphs.js — drawing the level-200 prestige titles correctly.
 *
 * The four titles (see lib/title-engine.js) are literal Unicode glyph
 * strings, not plain text standing in for a rank name:
 *
 *   Ⓟⓡⓞ   Ⓐ🅜   Ⓖ🅜   Ⓛ🅜
 *
 * "GM" above is not the letters G and M — the 🅜 is U+1F15C NEGATIVE
 * SQUARED LATIN CAPITAL LETTER M, from the Enclosed Alphanumeric
 * Supplement block. That block is why this file exists:
 *
 *   1. DejaVu Sans (lib/fonts.js's everyday text font, the only one this
 *      repo shipped before this feature) has NO glyphs in that block, so
 *      drawing a title with ctx.font = '...sans-serif' produces a blank
 *      tofu box for the squared-letter half of every title except Ⓟⓡⓞ
 *      (whose circled-letter glyphs happen to live in the older, better
 *      supported U+24B6–U+24E1 range that DejaVu does cover — but relying
 *      on that would make Ⓟⓡⓞ silently work while the other three broke,
 *      which is worse than all four failing the same way. Route all of
 *      them through the symbols font instead of trying to special case one.)
 *
 *   2. Registering the right font (lib/assets/fonts/NotoSansSymbols-*.ttf,
 *      registered as "Noto Sans Symbols" in lib/fonts.js) is necessary but
 *      not sufficient. @napi-rs/canvas does not do per-glyph cross-family
 *      fallback the way a browser does: a single fillText() call using
 *      ctx.font = '...sans-serif' does NOT reach into a different
 *      registered family to cover glyphs sans-serif's own font is missing,
 *      even if that family is registered and even if it's the only
 *      registered font that actually has the glyph. Confirmed by rendering
 *      "Ⓖ🅜 Kagerou" with a single sans-serif fillText call and inspecting
 *      the output: both title glyphs came out as empty boxes while the name
 *      rendered fine. The fix is to split the string and issue two
 *      fillText() calls with two different ctx.font values, advancing x by
 *      the measured width of the first — that's what drawBadgedName() and
 *      titleTextWidth() below do. ANY new render site that wants to show a
 *      title next to other text must go through these, not a single
 *      fillText() with the title concatenated into a normal string.
 *
 * Plain chat messages (plugins/*.js reply strings) do NOT have this
 * problem — Telegram's own client renders the glyphs, not this bot's
 * server — so plugins can just interpolate tier.glyph directly into a
 * template string. This file is ONLY needed for canvas/image rendering
 * (lib/*-render.mjs).
 */
import './fonts.js' // ensure "Noto Sans Symbols" is registered before any draw

const SYMBOL_FAMILY = 'Noto Sans Symbols'

/** Swaps the family in a "<weight/size> <family>" ctx.font string. */
function withFamily(font, family) {
  const parts = String(font).trim().split(/\s+/)
  // Last token is always the family in every FONT.* string this repo uses
  // (e.g. 'bold 34px sans-serif' -> ['bold', '34px', 'sans-serif']); replacing
  // just that token keeps the weight/size untouched.
  parts[parts.length - 1] = family
  return parts.join(' ')
}

/**
 * titleTextWidth(ctx, glyph, font) — measures a title glyph string as it
 * will actually be drawn (in the symbols font), without mutating ctx.font
 * for the caller. Useful for layout math (centering, right-alignment)
 * before committing to drawBadgedName's own draw.
 */
export function titleTextWidth(ctx, glyph, font) {
  const prev = ctx.font
  ctx.font = withFamily(font, SYMBOL_FAMILY)
  const w = ctx.measureText(glyph).width
  ctx.font = prev
  return w
}

/**
 * drawBadgedName(ctx, x, y, { glyph, name, font, gap, color }) -> number
 *
 * Draws `glyph` (a title string like 'Ⓖ🅜') in the Noto Sans Symbols font
 * immediately followed by `name` in the caller's normal font, left-aligned
 * starting at (x, y). Returns the total width drawn, so callers that need
 * to keep drawing after the name (e.g. appending "(Lv 200)") know where to
 * continue.
 *
 * Assumes ctx.textAlign = 'left' and whatever ctx.textBaseline the caller
 * has already set (this function does not change either) — same contract
 * as a plain ctx.fillText call, just split in two.
 *
 * `glyph` may be omitted/null for an untitled player; in that case this
 * just draws `name` alone at (x, y), so call sites don't need an if/else
 * around every draw — see drawName() below for that convenience wrapper.
 */
export function drawBadgedName(ctx, x, y, { glyph, name, font, gap = 8, color }) {
  let cursor = x
  if (color) ctx.fillStyle = color

  if (glyph) {
    ctx.font = withFamily(font, SYMBOL_FAMILY)
    ctx.fillText(glyph, cursor, y)
    cursor += ctx.measureText(glyph).width + gap
  }

  ctx.font = font
  ctx.fillText(name, cursor, y)
  cursor += ctx.measureText(name).width

  return cursor - x
}

/**
 * drawName(ctx, x, y, player, tierInfo, font, opts) — convenience wrapper
 * for the common case: draw a player's badge (if titled) + name in one
 * call, without the caller needing to compute tierInfo itself first.
 *
 * `tierInfo` is whatever lib/title-engine.js's getTierForXp() returned for
 * this player, or null/undefined for an untitled player. Passed in rather
 * than computed here so this module stays free of any player-shape
 * assumptions (level cap, where prestige XP lives, etc.) — that logic
 * belongs to title-engine.js and the call site, not the renderer.
 */
export function drawName(ctx, x, y, name, tierInfo, font, opts = {}) {
  return drawBadgedName(ctx, x, y, {
    glyph: tierInfo?.glyph ?? null,
    name,
    font,
    ...opts,
  })
}

/**
 * format.js — shared display/storage formatting helpers.
 *
 * Currently just gems, added because floating point subtraction across
 * the spin plugins (ni-spin.js, yo-spin.js, miya-spin.js, mei-spin.js all
 * do `gems -= COST_PER_SPIN` in a loop, COST_PER_SPIN = 0.5) can drift a
 * player's wallet.gems into long repeating decimals like 0.44444444444.
 * Two fixes, used together:
 *
 *   1. roundGems(n)  — call this anywhere wallet.gems is WRITTEN, so the
 *      stored value itself never carries more than 2 decimal places and
 *      can't keep drifting worse over repeated transactions.
 *   2. fmtGems(n)    — call this anywhere wallet.gems is DISPLAYED to a
 *      player, so even a pre-existing dirty value already in someone's
 *      save file renders clean (max 2 decimals, no trailing zeros like
 *      "0.50" — shows "0.5").
 *
 * Both are safe to call on integers or already-clean values — they're
 * no-ops in that case.
 */

/** Round a gems amount to at most 2 decimal places. Use when WRITING. */
export function roundGems(amount) {
  const n = Number(amount) || 0
  return Math.round(n * 100) / 100
}

/**
 * Format a gems amount for display: at most 2 decimals, no trailing
 * zeros/decimal point for whole or 1-decimal values (0.5 not 0.50, 12
 * not 12.00). Use when DISPLAYING — every ${...gems} template literal.
 */
export function fmtGems(amount) {
  const n = roundGems(amount)
  // toFixed(2) then strip trailing zeros and a trailing bare "."
  return n.toFixed(2).replace(/\.?0+$/, '') || '0'
}

// ── Unicode display fonts ────────────────────────────────────────────────
// Mathematical Bold Fraktur (U+1D56C uppercase / U+1D586 lowercase). Bold
// Fraktur is used rather than plain Fraktur because the plain block has
// five holes in it — C, H, I, R and Z live in the Letterlike Symbols block
// (ℭ ℌ ℑ ℜ ℨ) instead of contiguously, so plain Fraktur cannot be done with
// codepoint arithmetic alone. The bold block is gapless.
const FRAKTUR_UPPER = 0x1d56c // 𝕬
const FRAKTUR_LOWER = 0x1d586 // 𝖆

/**
 * fraktur(text) — restyle A-Z/a-z as Mathematical Bold Fraktur, e.g.
 * "Anastasia" -> "𝕬𝖓𝖆𝖘𝖙𝖆𝖘𝖎𝖆". Anything that isn't a plain ASCII letter
 * (digits, punctuation, spaces, emoji, already-styled text) is passed
 * through untouched.
 *
 * Two things to know before using this anywhere else:
 *
 *   1. It is NOT markdown-composable. These are distinct codepoints, not
 *      styling applied to normal letters, so wrapping the result in
 *      WhatsApp's *bold* or _italic_ does nothing visible — the glyphs
 *      already carry their own weight. Pick one or the other.
 *   2. It must never touch a value used for LOOKUP. Player input is plain
 *      ASCII, so a fraktur'd name will not match a query — this is display
 *      only. data/characters.json deliberately stores Anastasia's `name`
 *      unstyled so `.character equip anastasia` still resolves; the font is
 *      applied at render time by her own messages instead.
 */
export function fraktur(text) {
  return String(text ?? '').replace(/[A-Za-z]/g, (ch) => {
    const code = ch.charCodeAt(0)
    const base = code <= 0x5a ? FRAKTUR_UPPER : FRAKTUR_LOWER
    const offset = code - (code <= 0x5a ? 0x41 : 0x61)
    return String.fromCodePoint(base + offset)
  })
}

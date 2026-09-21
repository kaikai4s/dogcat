module.exports = function createService({
  safeText
}) {
  function normalizeMemberNameColor(value) {
    const color = safeText(value).trim()
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color : ''
  }

  function normalizeMemberNameEffect(value) {
    const effect = safeText(value).trim()
    return ['none', 'gold_shine', 'silver_shine', 'bronze_shine', 'pink_dream', 'blue_diamond', 'emerald_glow', 'fire_glow', 'purple_neon', 'dark_gold', 'gradient_rainbow', '3d_emboss'].includes(effect) ? effect : 'none'
  }

  function normalizeMemberBadgeStyle(value) {
    const style = safeText(value).trim()
    return ['gold', 'silver', 'bronze', 'purple', 'pink', 'blue', 'green', 'red', 'dark', 'rainbow'].includes(style) ? style : 'gold'
  }

  function normalizeMemberBadgeTag(value) {
    return safeText(value).trim().slice(0, 8)
  }

  function isValidThemeKey(value) { return ['day', 'night'].includes(safeText(value).trim()) }

  function normalizeThemeKey(value) {
    const key = safeText(value).trim()
    return isValidThemeKey(key) ? key : 'day'
  }

  function isValidFontKey(value) { return ['system', 'rounded', 'clean', 'serif', 'cute'].includes(safeText(value).trim()) }

  function normalizeFontKey(value) {
    const key = safeText(value).trim()
    return isValidFontKey(key) ? key : 'system'
  }

  return {
    normalizeMemberNameColor,
    normalizeMemberNameEffect,
    normalizeMemberBadgeStyle,
    normalizeMemberBadgeTag,
    isValidThemeKey,
    normalizeThemeKey,
    isValidFontKey,
    normalizeFontKey
  }
}

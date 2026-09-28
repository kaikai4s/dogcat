const DEFAULT_CARD_STYLE = { profileCardColor: '#ffffff', profileCardOpacity: 46, profileCardBlur: 0, profileCardTextColor: '#2d211a' }
const CARD_STYLE_FIELDS = Object.keys(DEFAULT_CARD_STYLE)

function isValidField(key, value) {
  if (key === 'profileCardOpacity' || key === 'profileCardBlur') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
}

function normalizeCardStyle(profile = {}) {
  const result = {}
  CARD_STYLE_FIELDS.forEach((key) => {
    const value = isValidField(key, profile[key]) ? profile[key] : DEFAULT_CARD_STYLE[key]
    result[key] = typeof value === 'number' ? Math.round(value) : value.trim().toLowerCase()
  })
  return result
}

function validateCardStyleUpdate(data) {
  const result = {}
  CARD_STYLE_FIELDS.forEach((key) => {
    if (data[key] === undefined) return
    if (!isValidField(key, data[key])) {
      throw new Error(key === 'profileCardBlur' ? '名片模糊程度须为0到100之间的数字' : key === 'profileCardOpacity' ? '名片不透明度须为0到100之间的数字' : '名片颜色须为六位十六进制色值，如 #ffffff')
    }
    result[key] = normalizeCardStyle(data)[key]
  })
  return result
}

module.exports = { CARD_STYLE_FIELDS, normalizeCardStyle, validateCardStyleUpdate }

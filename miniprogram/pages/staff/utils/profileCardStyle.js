// 两个使用名片的分包各自携带此文件，避免占用主包；修改时保持两份实现一致。
const DEFAULT_CARD_STYLE = {
  profileCardColor: '#ffffff',
  profileCardOpacity: 46,
  profileCardBlur: 0,
  profileCardTextColor: '#2d211a'
}


function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
}

function normalizeCardStyle(profile = {}) {
  const opacity = profile.profileCardOpacity
  const blur = profile.profileCardBlur
  return {
    profileCardColor: isHexColor(profile.profileCardColor) ? profile.profileCardColor.trim().toLowerCase() : DEFAULT_CARD_STYLE.profileCardColor,
    profileCardTextColor: isHexColor(profile.profileCardTextColor) ? profile.profileCardTextColor.trim().toLowerCase() : DEFAULT_CARD_STYLE.profileCardTextColor,
    profileCardOpacity: typeof opacity === 'number' && Number.isFinite(opacity) && opacity >= 0 && opacity <= 100 ? Math.round(opacity) : DEFAULT_CARD_STYLE.profileCardOpacity,
    profileCardBlur: typeof blur === 'number' && Number.isFinite(blur) && blur >= 0 && blur <= 100 ? Math.round(blur) : DEFAULT_CARD_STYLE.profileCardBlur
  }
}

function buildCardStyle(profile) {
  const style = normalizeCardStyle(profile)
  const rgb = [1, 3, 5].map((start) => parseInt(style.profileCardColor.slice(start, start + 2), 16))
  const blur = (style.profileCardBlur * 0.24).toFixed(2)
  return `background: rgba(${rgb.join(',')},${style.profileCardOpacity / 100}); color: ${style.profileCardTextColor}; backdrop-filter: blur(${blur}rpx); -webkit-backdrop-filter: blur(${blur}rpx);`
}

module.exports = { DEFAULT_CARD_STYLE, isHexColor, normalizeCardStyle, buildCardStyle }

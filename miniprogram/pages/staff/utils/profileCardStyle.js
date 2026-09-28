// 两个使用名片的分包各自携带此文件，避免占用主包；修改时保持两份实现一致。
const DEFAULT_CARD_STYLE = {
  profileCardColor: '#ffffff',
  profileCardOpacity: 46,
  profileCardTextColor: '#2d211a'
}

const CARD_COLOR_OPTIONS = ['#ffffff', '#fff2df', '#ffd9c8', '#dff4ec', '#dceaff', '#e9ddff', '#2d211a', '#222222']
const TEXT_COLOR_OPTIONS = ['#2d211a', '#ffffff', '#222222', '#8b4513', '#d45f22', '#19765b', '#2859a6', '#7254a3']

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
}

function normalizeCardStyle(profile = {}) {
  const opacity = profile.profileCardOpacity
  return {
    profileCardColor: isHexColor(profile.profileCardColor) ? profile.profileCardColor.trim().toLowerCase() : DEFAULT_CARD_STYLE.profileCardColor,
    profileCardTextColor: isHexColor(profile.profileCardTextColor) ? profile.profileCardTextColor.trim().toLowerCase() : DEFAULT_CARD_STYLE.profileCardTextColor,
    profileCardOpacity: typeof opacity === 'number' && Number.isFinite(opacity) && opacity >= 0 && opacity <= 100 ? Math.round(opacity) : DEFAULT_CARD_STYLE.profileCardOpacity
  }
}

function buildCardStyle(profile) {
  const style = normalizeCardStyle(profile)
  const rgb = [1, 3, 5].map((start) => parseInt(style.profileCardColor.slice(start, start + 2), 16))
  return `background: rgba(${rgb.join(',')},${style.profileCardOpacity / 100}); color: ${style.profileCardTextColor};${style.profileCardOpacity === 0 ? ' backdrop-filter: none;' : ''}`
}

module.exports = { DEFAULT_CARD_STYLE, CARD_COLOR_OPTIONS, TEXT_COLOR_OPTIONS, isHexColor, normalizeCardStyle, buildCardStyle }

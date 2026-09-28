const HERO_DURATION = 420
const HERO_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

function buildHeroMotion(width, height, normalHeight, compactHeight) {
  const unit = width / 750
  const cw = (width - 68 * unit) * 0.82
  const ew = (width - 68 * unit) * 0.94
  // 两种文字布局提前测量，避免动画时改变字号、换行和 padding。
  const eh = Math.max(compactHeight, 100 * unit)
  const ch = Math.max(normalHeight, eh + 56 * unit)
  const collapsed = Math.max(520 * unit, ch + 80 * unit)
  const expanded = Math.max(height * 0.92, collapsed + 120 * unit, eh + 100 * unit)
  const cx = (width - cw) / 2
  const ex = (width - ew) / 2
  const cy = (collapsed - ch) / 2
  const ey = expanded - eh - 38 * unit
  const values = {
    'hero-width': width, 'hero-collapsed': collapsed, 'hero-expanded': expanded,
    'card-cw': cw, 'card-ch': ch, 'card-ew': ew, 'card-eh': eh,
    'card-cx': cx, 'card-cy': cy, 'card-ex': ex, 'card-ey': ey,
    'normal-end-x': ex + (ew - cw) / 2, 'normal-end-y': ey + (eh - ch) / 2,
    'compact-start-x': cx + (cw - ew) / 2, 'compact-start-y': cy + (ch - eh) / 2,
    'media-start-y': (collapsed - expanded) / 2,
    'glass-cx': -cx, 'glass-cy': (collapsed - expanded) / 2 - cy,
    'glass-ex': -ex, 'glass-ey': -ey
  }
  const style = Object.entries(values).map(([key, value]) => `--${key}: ${value.toFixed(3)}px;`).join('') +
    `--card-scale-x: ${ew / cw};--card-scale-y: ${eh / ch};--glass-scale-x: ${cw / ew};--glass-scale-y: ${ch / eh};`
  return { collapsed, expanded, cw, ch, ew, eh, style }
}

function buildHeroBodyStyle(layout, expanded, committed, moving) {
  const delta = layout ? (Number(expanded) - Number(committed)) * (layout.expanded - layout.collapsed) : 0
  return `transform: translate3d(0, ${delta}px, 0); transition: ${moving ? `transform ${HERO_DURATION}ms ${HERO_EASING}` : 'none'};`
}

module.exports = { HERO_DURATION, buildHeroMotion, buildHeroBodyStyle }

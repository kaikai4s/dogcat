const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0))

function hsvToHex(h, s, v) {
  h = clamp(h, 360) / 60
  s = clamp(s, 100) / 100
  v = clamp(v, 100) / 100
  const c = v * s
  const x = c * (1 - Math.abs(h % 2 - 1))
  const m = v - c
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6]
  return '#' + rgb.map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('')
}

function hexToHsv(hex, previousHue = 0) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = previousHue
  if (delta) {
    h = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: max ? delta / max * 100 : 0, v: max * 100 }
}

module.exports = { clamp, hsvToHex, hexToHsv }

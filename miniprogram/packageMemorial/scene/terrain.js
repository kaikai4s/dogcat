const M = require('./world-template')
function drawGround(c, view, grass) {
  c.fillStyle = '#7f9b52'
  c.fillRect(view.left, view.top, view.right - view.left, view.bottom - view.top)
  const tile = 192
  if (grass) for (let y = Math.floor(view.top / tile) * tile; y < view.bottom; y += tile) {
    for (let x = Math.floor(view.left / tile) * tile; x < view.right; x += tile) c.drawImage(grass, x, y, tile, tile)
  }
  c.fillStyle = 'rgba(161,181,102,0.32)'
  c.fillRect(view.left, view.top, view.right - view.left, view.bottom - view.top)
  // Paths share a single width and parallel edges at all world positions.
  function paths() {
    c.beginPath()
    M.roadX.forEach(x => c.rect(x - M.roadWidth / 2, 64, M.roadWidth, M.HEIGHT - 128))
    M.roadY.forEach(y => c.rect(64, y - M.roadWidth / 2, M.WIDTH - 128, M.roadWidth))
    c.moveTo(M.plaza.x + M.plaza.radius, M.plaza.y)
    c.arc(M.plaza.x, M.plaza.y, M.plaza.radius, 0, Math.PI * 2)
  }
  paths(); c.fillStyle = '#d3c7a6'; c.fill(); c.strokeStyle = '#a89e7e'; c.lineWidth = 4; c.stroke()
  c.save(); paths(); c.clip()
  c.strokeStyle = 'rgba(117,108,89,0.24)'; c.lineWidth = 1
  for (let y = Math.floor(view.top / 22) * 22; y < view.bottom; y += 22) {
    const offset = (Math.round(y / 22) % 2) * 18
    for (let x = Math.floor(view.left / 36) * 36 - 36; x < view.right; x += 36) {
      c.strokeRect(x + offset, y, 36, 22)
    }
  }
  c.restore()
  c.strokeStyle = '#c9c2a5'; c.lineWidth = 18
  c.strokeRect(54, 54, M.WIDTH - 108, M.HEIGHT - 108)
  c.strokeStyle = '#8e9471'; c.lineWidth = 3
  c.strokeRect(66, 66, M.WIDTH - 132, M.HEIGHT - 132)
}
function propBox(prop) {
  const type = prop.kind === 'memorial' && prop.legacy ? { width: 64, height: 88 } : M.PROPS[prop.kind]
  return { x: prop.x - type.width / 2, y: prop.y - type.height * .84,
    width: type.width, height: type.height }
}
// Coordinates follow the fountain's 256px atlas cell, so water stays attached
// to the bowls at every camera scale. Keep the stone pedestal and rim dry.
function drawFountainWater(c, box, time) {
  c.save()
  c.translate(box.x, box.y)
  c.scale(box.width / 256, box.height / 256)
  c.lineCap = 'round'

  // Low, spreading ripples on the lower basin, clipped around the pedestal.
  c.save()
  c.beginPath(); c.ellipse(128, 166, 69, 22, 0, 0, Math.PI * 2); c.clip()
  c.beginPath()
  c.rect(55, 140, 55, 48); c.rect(147, 140, 55, 48); c.rect(55, 174, 147, 16)
  c.clip()
  const ripples = [[93, 158], [162, 159], [126, 179]]
  ripples.forEach(([x, y], i) => {
    for (let n = 0; n < 3; n++) {
      const phase = (time * .5 + n / 3 + i * .19) % 1
      c.strokeStyle = 'rgba(222,248,237,' + (.34 * Math.sin(Math.PI * phase)).toFixed(3) + ')'
      c.lineWidth = .85
      c.beginPath(); c.ellipse(x, y, 3 + phase * 25, 1 + phase * 7, 0, 0, Math.PI * 2); c.stroke()
    }
  })
  c.restore()

  // Short moving highlights trace the existing spillways instead of painting
  // opaque white columns over the original water and stone texture.
  const streams = [[88, 115, 39], [92, 117, 42], [97, 119, 42], [107, 120, 44],
    [145, 120, 43], [153, 118, 42], [163, 116, 40], [167, 114, 38]]
  streams.forEach(([x, y, length], i) => {
    const flow = t => ({ x: x + Math.sin(t * Math.PI + time * Math.PI + i) * .55,
      y: y + t * length })
    c.strokeStyle = 'rgba(175,224,221,.22)'; c.lineWidth = 1.8
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + length); c.stroke()
    for (let n = 0; n < 3; n++) {
      const phase = (time * 1.5 + i * .13 + n / 3) % 1
      const a = flow(phase), b = flow(Math.min(1, phase + .12))
      c.strokeStyle = 'rgba(238,255,246,' + (.56 * Math.sin(Math.PI * phase)).toFixed(3) + ')'
      c.lineWidth = .8
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke()
    }
    const splash = (time * 1.5 + i * .13) % 1
    c.strokeStyle = 'rgba(231,252,243,' + (.38 * (1 - splash)).toFixed(3) + ')'
    c.lineWidth = .7
    c.beginPath(); c.ellipse(x, y + length, 1 + splash * 4, .5 + splash * 1.4, 0, 0, Math.PI * 2); c.stroke()
  })

  c.save()
  c.beginPath(); c.ellipse(128, 107, 26, 5, 0, 0, Math.PI * 2); c.clip()
  c.beginPath(); c.rect(101, 101, 16, 13); c.rect(139, 101, 16, 13); c.clip()
  for (let i = 0; i < 3; i++) {
    const phase = (time * .5 + i / 3) % 1
    c.strokeStyle = 'rgba(232,251,239,' + (.4 * Math.sin(Math.PI * phase)).toFixed(3) + ')'
    c.lineWidth = .7
    c.beginPath(); c.ellipse(128, 107, 10 + 18 * phase, 1 + 4 * phase, 0, 0, Math.PI * 2); c.stroke()
  }
  c.restore()
  c.restore()
}
function drawProp(c, prop, atlas, waterTime = 0, monuments, foliage, environment) {
  if (prop.kind === 'memorial' && monuments) {
    const b = propBox(prop), index = { arch: 0, cottage: 1, moon: 2 }[prop.style] || 0
    c.drawImage(monuments, index * 256, 0, 256, 352, b.x, b.y, b.width, b.height)
    const name = String(prop.name || '').slice(0, 20)
    c.save(); c.fillStyle = '#665b4b'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '9px sans-serif'
    if (name) c.fillText(name, prop.x, b.y + b.height * .43, b.width * .48)
    c.restore()
    return
  }
  if (!atlas) return
  const type = M.PROPS[prop.kind], b = propBox(prop)
  if (foliage && environment && (prop.kind === 'tree' || prop.kind === 'shrub')) {
    c.save()
    let painted = false
    ;['spring', 'summer', 'autumn', 'winter'].forEach((season, row) => {
      const amount = environment.seasons[season]
      if (amount <= .001) return
      c.globalAlpha = painted ? amount : 1
      c.drawImage(foliage, (prop.kind === 'tree' ? 0 : 256), row * 256, 256, 256, b.x, b.y, b.width, b.height)
      painted = true
    })
    c.restore()
    return
  }
  c.drawImage(atlas, type.index % 3 * 256, Math.floor(type.index / 3) * 256, 256, 256, b.x, b.y, b.width, b.height)
  if (prop.kind === 'fountain') drawFountainWater(c, b, waterTime)
}
function drawPlan(c) {
  c.fillStyle = '#9aaf75'; c.fillRect(0, 0, M.WIDTH, M.HEIGHT)
  c.fillStyle = '#eee4c8'
  M.roadX.forEach(x => c.fillRect(x - 48, 64, 96, M.HEIGHT - 128))
  M.roadY.forEach(y => c.fillRect(64, y - 48, M.WIDTH - 128, 96))
  c.beginPath(); c.arc(M.plaza.x, M.plaza.y, M.plaza.radius, 0, Math.PI * 2); c.fill()
  M.landmarks.forEach(p => { c.fillStyle = '#63775c'; c.beginPath(); c.arc(p.x, p.y, 45, 0, Math.PI * 2); c.fill() })
}
module.exports = { drawGround, drawProp, propBox, drawPlan }

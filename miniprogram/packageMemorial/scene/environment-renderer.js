const M = require('./world-template')
const { hash } = require('./environment')
const clamp = n => Math.max(0, Math.min(1, n))
const wrap = (n, size) => (n % size + size) % size
const intersects = (p, v, r = 100) => p.x >= v.left - r && p.x <= v.right + r && p.y >= v.top - r && p.y <= v.bottom + r
const lanterns = []
for (const x of M.roadX) for (let y = 320; y < M.HEIGHT - 140; y += 288) {
  if (M.roadY.some(road => Math.abs(road - y) < 95) || Math.hypot(x - M.plaza.x, y - M.plaza.y) < 260) continue
  for (const side of [-1, 1]) lanterns.push({ x: x + side * 58, y })
}
class EnvironmentRenderer {
  constructor(createCanvas, garden = M.version) {
    this.createCanvas = createCanvas; this.textures = {}
    this.particles = Array.from({ length: 80 }, (_, i) => {
      const seed = garden + ':particle:' + i
      return { x: hash(seed), y: hash(seed + ':y'), speed: .6 + hash(seed + ':speed'), phase: hash(seed + ':phase') * Math.PI * 2 }
    })
  }
  glow(name, rgb) {
    if (this.textures[name] !== undefined) return this.textures[name]
    let canvas = null
    try {
      if (this.createCanvas) {
        canvas = this.createCanvas(128, 128)
        const c = canvas.getContext('2d'), gradient = c.createRadialGradient(64, 64, 0, 64, 64, 64)
        gradient.addColorStop(0, 'rgba(' + rgb + ',.8)')
        gradient.addColorStop(.3, 'rgba(' + rgb + ',.3)')
        gradient.addColorStop(1, 'rgba(' + rgb + ',0)')
        c.fillStyle = gradient; c.fillRect(0, 0, 128, 128)
      }
    } catch (_) { canvas = null }
    this.textures[name] = canvas
    return canvas
  }
  ground(c, view, env, objects, scale) {
    c.save()
    // Tint grass only; paths and the space reserved for offerings remain clear.
    for (const [season, color, opacity] of [['spring', '#accc80', .06], ['autumn', '#c5a36b', .19], ['winter', '#e7eee5', .36]]) {
      if (env.seasons[season] < .001) continue
      c.fillStyle = color; c.globalAlpha = env.seasons[season] * opacity
      for (const lawn of M.lawns) {
        const a = lawn.polygon[0], b = lawn.polygon[2]
        const x = Math.max(a.x, view.left), y = Math.max(a.y, view.top)
        const w = Math.min(b.x, view.right) - x, h = Math.min(b.y, view.bottom) - y
        if (w > 0 && h > 0) c.fillRect(x, y, w, h)
      }
    }
    if (scale >= .5) for (const prop of objects) {
      if (!['tree', 'shrub'].includes(prop.kind) || !intersects(prop, view, 60)) continue
      for (let i = 0; i < 9; i++) {
        const angle = i * 2.4 + prop.x, radius = 12 + i * 3
        const x = prop.x + Math.cos(angle) * radius, y = prop.y + Math.sin(angle) * radius * .28 + 5
        c.globalAlpha = (env.seasons.spring * .38 + env.seasons.autumn * .5 + env.seasons.winter * .42)
        c.fillStyle = env.seasons.winter > .5 ? '#eef2ec' : env.seasons.autumn > .5 ? ['#b56c3d', '#d8aa58', '#a78046'][i % 3] : '#ead0ce'
        c.beginPath(); c.ellipse(x, y, 2.8, 1.4, angle, 0, Math.PI * 2); c.fill()
      }
    }
    c.globalAlpha = 1
    for (const lamp of lanterns) {
      if (!intersects(lamp, view, 20)) continue
      c.fillStyle = '#79705a'; c.fillRect(lamp.x - 2, lamp.y - 12, 4, 12)
      c.fillStyle = '#ded2ac'; c.fillRect(lamp.x - 5, lamp.y - 19, 10, 9)
      c.fillStyle = '#706b52'; c.fillRect(lamp.x - 6, lamp.y - 21, 12, 3)
      c.fillStyle = env.night > .25 ? '#ffe8aa' : '#eee2be'; c.fillRect(lamp.x - 3, lamp.y - 17, 6, 5)
    }
    c.restore()
  }
  screen(c, scene, env, time) {
    const { width, height, camera, scale, overview, effectsEnabled } = scene
    const toScreen = p => ({ x: (p.x - camera.x) * scale + width / 2, y: (p.y - camera.y) * scale + height / 2 })
    c.save()
    // Full map stays easy to read even at midnight.
    const night = env.night * (overview || scale < .5 ? .10 : .43)
    c.fillStyle = 'rgba(18,29,58,' + night + ')'; c.fillRect(0, 0, width, height)
    c.fillStyle = 'rgba(247,186,122,' + ((env.dawn * .10 + env.dusk * .18) * (1 - env.overcast * .6)) + ')'
    c.fillRect(0, 0, width, height)
    c.fillStyle = 'rgba(79,98,111,' + env.overcast * .10 + ')'; c.fillRect(0, 0, width, height)
    if (overview || scale < .5) { c.restore(); return }
    const warm = this.glow('warm', '255,209,128')
    const soft = this.glow('mist', '226,235,230')
    const light = (p, radius, strength) => {
      const pos = toScreen(p), size = radius * scale
      if (pos.x < -size || pos.x > width + size || pos.y < -size || pos.y > height + size) return
      c.globalAlpha = strength
      if (warm) c.drawImage(warm, pos.x - size, pos.y - size * .65, size * 2, size * 1.3)
      else { c.fillStyle = 'rgba(255,222,162,.10)'; c.beginPath(); c.ellipse(pos.x, pos.y, size, size * .65, 0, 0, Math.PI * 2); c.fill() }
    }
    if (env.night > .01) {
      for (const lamp of lanterns) light({ x: lamp.x, y: lamp.y - 12 }, 85, env.night * .65)
      for (const p of M.landmarks) {
        light({ x: p.x, y: p.y - (p.kind === 'fountain' ? 20 : 65) }, p.kind === 'fountain' ? 140 : 110, env.night * .5)
      }
      // A subtle local pool keeps the visitor and nearby memorial legible.
      light(scene.player, 125, env.night * .22)
    } else if (warm && env.overcast < .6) {
      c.globalAlpha = .12 + (env.dawn + env.dusk) * .2
      c.drawImage(warm, -width * .3, -height * .45, width * 1.3, height * 1.35)
    }
    c.globalAlpha = 1
    if (!effectsEnabled) { c.restore(); return }
    const t = time / 1000
    if (env.overcast > .08 && soft) {
      // Three cached, broad shadows move slowly; no full-scene blur/filter.
      for (let i = 0; i < 3; i++) {
        const x = wrap(i * width * .7 + t * 4, width * 2) - width * .5
        c.globalAlpha = env.overcast * .12; c.drawImage(soft, x, height * (.1 + i * .24), width, height * .3)
      }
    }
    const rain = env.weather.rain, snow = env.weather.snow
    const petals = env.seasons.spring * (1 - rain) * .6, leaves = env.seasons.autumn * (1 - rain) * .7
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]
      const x = wrap(p.x * (width + 80) + t * 9 * p.speed + env.weather.wind * 30 - camera.x * scale * .08, width + 80) - 40
      if (rain > .001 && i < 60) {
        const y = wrap(p.y * (height + 80) + t * 260 * p.speed - camera.y * scale * .08, height + 80) - 40
        c.globalAlpha = clamp(rain * 60 - i) * .43
        c.strokeStyle = '#d8e9e3'; c.lineWidth = .7; c.beginPath(); c.moveTo(x, y); c.lineTo(x - 3 - env.weather.wind * 2, y + 11); c.stroke()
      }
      if (snow > .001 && i < 50) {
        const y = wrap(p.y * (height + 60) + t * 19 * p.speed - camera.y * scale * .08, height + 60) - 30
        c.globalAlpha = clamp(snow * 50 - i) * .72; c.fillStyle = '#f5f7ef'
        c.beginPath(); c.arc(x + Math.sin(t * .65 + p.phase) * 13, y, 1 + p.speed * .8, 0, Math.PI * 2); c.fill()
      }
      if (i < 24 && petals + leaves > .001) {
        const y = wrap(p.y * (height + 60) + t * 14 * p.speed, height + 60) - 30
        c.globalAlpha = clamp((petals + leaves) * 24 - i) * .72
        c.fillStyle = leaves > petals ? ['#bc7d42', '#e3b76c', '#b79952'][i % 3] : '#f1d3d2'
        c.beginPath(); c.ellipse(x + Math.sin(t + p.phase) * 10, y, 2.5, .8 + Math.abs(Math.sin(t * .8 + p.phase)), t * .45 + p.phase, 0, Math.PI * 2); c.fill()
      }
      if (i < 12 && env.seasons.summer * env.night > .05 && rain < .1) {
        c.globalAlpha = env.seasons.summer * env.night * (.12 + .45 * Math.pow(Math.sin(t + p.phase), 2))
        c.fillStyle = '#f7efb0'; c.beginPath(); c.arc(x, height * (.35 + p.y * .5) + Math.sin(t * .4 + p.phase) * 10, 1.4, 0, Math.PI * 2); c.fill()
      }
    }
    if (soft && env.weather.mist > .01) for (let i = 0; i < 3; i++) {
      c.globalAlpha = env.weather.mist * .27
      c.drawImage(soft, Math.sin(t * .025 + i) * width * .2 - width * .4, height * (.2 + .25 * i), width * 1.8, height * .35)
    }
    c.restore()
  }
  destroy() { this.textures = {}; this.particles = [] }
}
module.exports = { EnvironmentRenderer, lanterns }

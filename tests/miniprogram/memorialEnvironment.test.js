const test = require('node:test')
const assert = require('node:assert/strict')
const { environmentAt, calendar, GardenEnvironment, WEATHER_SLOT, WEATHER_BLEND } = require('../../miniprogram/packageMemorial/scene/environment')
const { EnvironmentRenderer } = require('../../miniprogram/packageMemorial/scene/environment-renderer')
const { drawProp, propBox } = require('../../miniprogram/packageMemorial/scene/terrain')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const M = require('../../miniprogram/packageMemorial/scene/world-template')
const at = value => Date.parse(value + '+08:00')
const close = (a, b, tolerance = .0001) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`)

test('Beijing calendar changes season at local midnight, including leap day and the winter year boundary', () => {
  for (const [date, before, after] of [['2026-03-01', 'winter', 'spring'], ['2026-06-01', 'spring', 'summer'], ['2026-09-01', 'summer', 'autumn'], ['2026-12-01', 'autumn', 'winter']]) {
    const midnight = at(date + 'T00:00:00')
    assert.equal(calendar(midnight - 1).season, before)
    assert.equal(calendar(midnight).season, after)
    assert.equal(environmentAt(midnight).timeText, '00:00')
    assert.equal(environmentAt(midnight - 1).timeText, '23:59')
    assert.equal(environmentAt(midnight).seasons[before], 1)
    close(environmentAt(midnight + 7 * 86400000).seasons[after], 1)
  }
  assert.equal(calendar(at('2028-02-29T23:59:59')).season, 'winter')
  assert.equal(calendar(at('2027-01-01T12:00:00')).seasonMix, 1)
})

test('same garden has deterministic weather and continuous transitions across weather slots and season boundaries', () => {
  const begin = at('2026-11-30T18:00:00')
  for (let time = begin; time < begin + 3 * 86400000; time += 30000) {
    const env = environmentAt(time, 'garden-a')
    assert.deepEqual(environmentAt(time, 'garden-a'), env)
    close(Object.values(env.seasons).reduce((a, b) => a + b), 1)
    for (const value of [env.daylight, env.night, ...Object.values(env.seasons), ...['rain', 'snow', 'mist', 'cloudy'].map(k => env.weather[k])]) assert.ok(value >= 0 && value <= 1)
  }
  for (let slot = Math.floor(begin / WEATHER_SLOT); slot < Math.floor(begin / WEATHER_SLOT) + 60; slot++) {
    for (const time of [slot * WEATHER_SLOT, slot * WEATHER_SLOT + WEATHER_BLEND]) {
      const a = environmentAt(time - 1, 'garden-a'), b = environmentAt(time + 1, 'garden-a')
      for (const key of ['rain', 'snow', 'mist', 'cloudy', 'wind']) close(a.weather[key], b.weather[key])
      close(a.daylight, b.daylight)
    }
  }
  assert.ok(Array.from({ length: 48 }, (_, n) => begin + n * WEATHER_SLOT).some(t => environmentAt(t, 'garden-a').weather.kind !== environmentAt(t, 'garden-b').weather.kind))
})

test('day/night and seasonal lighting stay continuous at midnight, dawn and dusk', () => {
  for (const date of ['2026-04-15', '2026-07-15', '2026-10-15', '2026-01-15']) {
    assert.equal(environmentAt(at(date + 'T12:00:00')).daylight, 1)
    assert.equal(environmentAt(at(date + 'T23:00:00')).night, 1)
    for (let i = 0; i <= 86400; i += 30) {
      const time = at(date + 'T00:00:00') + i * 1000
      const a = environmentAt(time - 1000), b = environmentAt(time)
      for (const key of ['daylight', 'dawn', 'dusk']) close(a[key], b[key], .001)
    }
  }
})

test('server midpoint clock corrects different phones and ignores malformed or slow samples; resume catches up immediately', () => {
  const server = at('2026-12-01T00:00:00'), changes = []
  let phone = server + 8 * 3600000
  const env = new GardenEnvironment({ now: () => phone, gardenId: 'same', onChange: e => changes.push(e.label + e.timeText) })
  assert.equal(env.sync(server, phone - 100, phone + 100), true)
  assert.equal(env.sample().timeText, '00:00')
  const other = new GardenEnvironment({ now: () => server - 3600000, gardenId: 'same' })
  other.sync(server, server - 3600000, server - 3600000)
  assert.deepEqual(other.sample(), env.sample())
  for (let i = 0; i < 60; i++) env.sample()
  assert.equal(changes.length, 1)
  for (const args of [[NaN, phone, phone], [server, phone, phone + 10001], [server, phone, phone - 1]]) assert.equal(env.sync(...args), false)
  phone += 12 * 3600000
  assert.equal(env.sample().phase, '白天')
  phone -= 3600000
  assert.equal(env.sample().timeText, '11:00')
})

function context() {
  const calls = []
  const ctx = new Proxy({ globalAlpha: 1 }, { get: (o, key) => key in o ? o[key] : (...args) => calls.push([key, ...args]) })
  return { calls, ctx }
}

test('seasonal variants preserve tree/shrub anchors and leave memorials on their original atlas', () => {
  const base = {}, foliage = {}, monuments = {}, { ctx, calls } = context()
  for (const kind of ['tree', 'shrub']) {
    const prop = { kind, x: 300, y: 400 }, b = propBox(prop)
    for (const date of ['2026-04-15', '2026-07-15', '2026-10-15', '2026-01-15', '2026-03-03']) {
      calls.length = 0
      drawProp(ctx, prop, base, 0, monuments, foliage, environmentAt(at(date + 'T12:00:00')))
      for (const call of calls.filter(c => c[0] === 'drawImage')) {
        assert.equal(call[1], foliage)
        assert.deepEqual(call.slice(6), [b.x, b.y, b.width, b.height])
      }
    }
  }
  calls.length = 0
  drawProp(ctx, { kind: 'memorial', x: 300, y: 400 }, base, 0, monuments, foliage, environmentAt(at('2026-01-15T12:00:00')))
  assert.equal(calls.find(c => c[0] === 'drawImage')[1], monuments)
})

test('weather renders a bounded number of particles, has a lite mode and excludes particles on the overview', () => {
  const { ctx, calls } = context(), renderer = new EnvironmentRenderer(null, 'garden')
  const env = environmentAt(at('2026-01-15T21:00:00'))
  env.weather.rain = env.weather.snow = env.weather.mist = 1
  const scene = { width: 390, height: 844, camera: M.spawn, player: M.spawn, scale: 1, effectsEnabled: true, overview: false }
  renderer.screen(ctx, scene, env, env.time)
  assert.equal(calls.filter(c => c[0] === 'lineTo').length, 60)
  assert.equal(calls.filter(c => c[0] === 'arc').length, 50)
  for (const changes of [{ effectsEnabled: false }, { overview: true }]) {
    calls.length = 0
    renderer.screen(ctx, { ...scene, ...changes }, env, env.time)
    assert.equal(calls.filter(c => ['lineTo', 'arc'].includes(c[0])).length, 0)
    assert.ok(calls.some(c => c[0] === 'fillRect'))
  }
  renderer.destroy(); assert.equal(renderer.particles.length, 0)
})

test('optional seasonal download can fail and retry without breaking the scene or mutating a destroyed scene', async () => {
  const errors = [], loads = []
  const scene = new MemorialScene({ getContext: () => context().ctx, cancelAnimationFrame() {}, createImage() { const image = {}; loads.push(image); return image } }, { onEnvironmentAssetError: e => errors.push(e) })
  const a = scene.loadEnvironmentAssets()
  assert.equal(scene.loadEnvironmentAssets(), a)
  loads[0].onerror(); assert.equal(await a, false)
  assert.match(errors[0], /四季/)
  const b = scene.loadEnvironmentAssets(); loads[1].onload()
  assert.equal(await b, true); assert.equal(errors.at(-1), '')
  delete scene.images['seasons-v1/foliage.png']
  const c = scene.loadEnvironmentAssets(); scene.destroy(); loads[2].onload()
  await c
  assert.equal(errors.length, 2)
  assert.equal(Object.keys(scene.images).length, 0)
})

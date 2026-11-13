const test = require('node:test')
const assert = require('node:assert/strict')
const { Visitors } = require('../../miniprogram/packageMemorial/scene/visitors')
const { packet, cadencePackets, simulate } = require('../fixtures/memorialPresenceSimulation')

test('30/60 FPS playback stays continuous through slow updates and changing delivery cadence', () => {
  for (const fps of [30, 60]) for (const intervals of [[250], [450], [650], [900], [250, 500, 350, 700, 250, 450, 600]]) {
    const { metrics, frames } = simulate(Visitors, cadencePackets(intervals), { fps })
    assert.equal(metrics.stalls, 0, `${fps} FPS, ${intervals}: ${JSON.stringify(metrics)}`)
    assert.equal(metrics.backwards, 0)
    assert.ok(metrics.maxStep <= 144 / fps + .01, JSON.stringify(metrics))
    assert.ok(metrics.maxLagMs < 1500)
    assert.ok(frames.every(frame => frame.x <= frame.latestX && frame.samples <= 32))
    assert.ok(frames.filter(frame => frame.time > 5000).every(frame => frame.moving))
  }
})

test('source timing absorbs jitter, reordered delivery and one-second batches without position jumps', () => {
  const scenarios = [
    Array.from({ length: 100 }, (_, i) => packet(i * 250, i * 250 + [100, 180, 480, 130, 300, 220, 120, 600][i % 8])),
    Array.from({ length: 100 }, (_, i) => packet(i * 250, Math.ceil(i / 4) * 1000))
  ]
  for (const packets of scenarios) for (const fps of [30, 60]) {
    const { metrics, frames } = simulate(Visitors, packets, { fps })
    assert.equal(metrics.stalls, 0)
    assert.equal(metrics.backwards, 0)
    assert.ok(metrics.maxStep <= 144 / fps + .01, JSON.stringify(metrics))
    assert.ok(frames.every(frame => frame.x <= frame.latestX))
  }
})

test('a buffered right-angle turn follows both segments and a stop settles exactly without extrapolation', () => {
  const packets = []
  for (let at = 0; at <= 6000; at += 250) {
    packets.push(packet(at, at + 170 + [0, 180, 50, 260][at / 250 % 4], {
      x: 500 + Math.min(at, 3000) * .12, y: 500 + Math.max(0, at - 3000) * .12,
      direction: at > 3000 ? 'sw' : 'se', moving: at < 6000
    }))
  }
  const { frames, visitors } = simulate(Visitors, packets, { duration: 8500 })
  for (const f of frames) {
    assert.ok(f.y === 500 || f.x === 860, `cut corner at ${f.x}, ${f.y}`)
    assert.ok(f.x <= 860 && f.y <= 860)
    if (f.y > 502 && f.moving) assert.equal(f.direction, 'sw')
  }
  const actor = visitors.actors.get('other')
  assert.equal(actor.x, 860); assert.equal(actor.y, 860); assert.equal(actor.moving, false)
  assert.ok(frames.some(f => f.time < 8000 && f.x === 860 && f.y === 860 && !f.moving))
})

test('idle heartbeats neither drag the avatar nor stretch the next walk over the idle period', () => {
  const packets = [packet(0, 0, { x: 500, moving: false }), packet(4000, 4000, { x: 500, moving: false })]
  for (let i = 0; i <= 8; i++) packets.push(packet(7000 + i * 250, 7000 + i * 250, { x: 530 + i * 30, moving: i < 8 }))
  packets.push(packet(13000, 13000, { x: 770, moving: false }))
  const { frames, visitors } = simulate(Visitors, packets, { duration: 15000 })
  assert.ok(frames.filter(f => f.time < 7000).every(f => f.x === 500 && !f.moving))
  assert.ok(frames.find(f => f.time >= 7500).x > 550)
  assert.ok(frames.filter(f => f.time >= 11000).every(f => f.x === 770 && !f.moving))
  assert.equal(visitors.actors.get('other').x, 770)
})

test('a connection outage reaches the last confirmed position, rests, then expires the visitor', () => {
  const { frames, visitors } = simulate(Visitors, cadencePackets([650], 6500), { duration: 28000 })
  assert.ok(frames.every(f => f.x <= 1280))
  assert.ok(frames.filter(f => f.time > 12000).every(f => f.x === 1280 && !f.moving))
  assert.equal(visitors.actors.size, 0)
})

test('new epochs/teleports snap once; stale and duplicate snapshots cannot rewind a visitor', () => {
  let now = 0
  const v = new Visitors(() => now), first = packet(0).row
  v.apply([first]); const actor = v.actors.get('other')
  for (let i = 1; i <= 12; i++) {
    now = i * 250; v.apply([packet(now).row])
  }
  // A slow/paused renderer may lag > 240px, but consecutive snapshots did not teleport.
  assert.equal(v.actors.get('other'), actor)
  const samples = actor.samples.length
  v.apply([packet(500).row, packet(3000).row])
  assert.equal(actor.samples.length, samples)
  v.apply([{ ...packet(3250).row, x: 2000 }])
  assert.equal(v.actors.get('other').x, 2000)
  v.apply([{ ...first, epoch: 2, x: 1600 }])
  assert.equal(v.actors.get('other').x, 1600)
  v.apply([{ ...first, epoch: 1, seq: 99999, x: 100 }])
  assert.equal(v.actors.get('other').x, 1600)
  v.apply([], ['other']); assert.equal(v.actors.size, 0)
})

test('old clients, sender clock corrections and invalid clocks keep a finite monotonic playback path', () => {
  for (const mode of ['old-server', 'old-arrival', 'clock-correction', 'invalid']) {
    const packets = cadencePackets([450]).map(({ arrival, row }, i) => {
      if (mode === 'old-server' || mode === 'old-arrival') delete row.sampledAt
      if (mode === 'old-arrival') delete row.updatedAt
      if (mode === 'clock-correction' && i > 20) row.sampledAt -= 3600000
      if (mode === 'invalid') row.sampledAt = i % 2 ? NaN : 'invalid'
      return { arrival, row }
    })
    const { metrics, frames } = simulate(Visitors, packets)
    assert.equal(metrics.backwards, 0, mode)
    assert.equal(metrics.stalls, 0, mode)
    assert.ok(frames.every(f => Number.isFinite(f.x) && f.x <= f.latestX))
    assert.ok(metrics.maxStep < 3)
  }
})

test('100 independently rendered visitors remain smooth with bounded sample storage', () => {
  const { visitors, metrics, frames } = simulate(Visitors, cadencePackets([650]), { count: 100 })
  assert.equal(visitors.actors.size, 100)
  assert.equal(metrics.stalls, 0)
  const first = visitors.actors.get('other')
  for (const actor of visitors.actors.values()) {
    assert.equal(actor.x, first.x)
    assert.ok(actor.samples.length <= 32)
  }
  assert.ok(frames.every(f => f.samples <= 32))
})

test('a long network gap resumes from the displayed point without replaying seconds of silence', () => {
  const packets = []
  for (let at = 0; at <= 16000; at += 250) {
    if (at > 3000 && at < 10000) continue
    packets.push(packet(at, at, { x: 500 + .12 * (Math.min(3000, at) + Math.max(0, at - 9500)) }))
  }
  const { frames } = simulate(Visitors, packets, { duration: 16000 })
  assert.ok(frames.filter(f => f.time >= 8000 && f.time < 10000).every(f => f.x === 860 && !f.moving))
  const resumed = frames.find(f => f.time >= 10000)
  assert.ok(resumed.x < 865, 'resume must not teleport to the latest packet')
  assert.ok(frames.find(f => f.time >= 11000).x > 980, 'must catch up instead of replaying the 7s outage')
  assert.ok(frames.filter(f => f.time >= 12000).every(f => f.latestX - f.x < 90))
  assert.ok(frames.every(f => f.x <= f.latestX && f.distance >= 0 && f.distance < 3))
})

test('forward sender clock corrections do not create a long artificial movement segment', () => {
  const packets = cadencePackets([250]).map(({ arrival, row }) => {
    if (arrival >= 10000) row.sampledAt += 10000
    return { arrival, row }
  })
  const { metrics, frames } = simulate(Visitors, packets)
  assert.equal(metrics.stalls, 0)
  assert.ok(metrics.maxLagMs < 1000)
  assert.ok(frames.every(f => f.distance >= 0 && f.distance < 3 && f.x <= f.latestX))
})

test('low render rates consume elapsed network time instead of building an ever-growing replay backlog', () => {
  for (const fps of [5, 10, 15]) {
    const { metrics, frames } = simulate(Visitors, cadencePackets([250], 40000), { fps, duration: 40000 })
    assert.equal(metrics.stalls, 0)
    assert.ok(metrics.maxLagMs < 1000, `${fps} FPS: ${metrics.maxLagMs} ms behind`)
    assert.ok(frames.every(f => f.x <= f.latestX))
  }
})

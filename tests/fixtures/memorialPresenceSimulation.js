const { performance } = require('node:perf_hooks')
const base = { id: 'other', epoch: 1, gender: 'boy', direction: 'se', moving: true, activity: 'walk' }
function packet(sample, arrival = sample, extra = {}) {
  return { arrival, row: { ...base, seq: sample + 1, updatedAt: arrival + 100000,
    sampledAt: sample + 700000, x: 500 + sample * .12, y: 500, ...extra } }
}
function cadencePackets(intervals, duration = 25000) {
  const packets = []
  for (let at = 0, i = 0; at <= duration; at += intervals[i++ % intervals.length]) packets.push(packet(at))
  return packets
}
function simulate(Visitors, packets, { fps = 60, duration = 25000, warmup = 5000, count = 1 } = {}) {
  let now = 0, index = 0, latestX = 500, stopped = false
  const visitors = new Visitors(() => now), frames = [], costs = []
  const metrics = { stallFrames: 0, stalls: 0, maxStep: 0, backwards: 0, maxLagMs: 0 }
  packets = packets.slice().sort((a, b) => a.arrival - b.arrival)
  for (let frame = 0; frame < duration * fps / 1000; frame++) {
    now = frame * 1000 / fps
    while (index < packets.length && packets[index].arrival <= now) {
      const { row } = packets[index++]
      visitors.apply(Array.from({ length: count }, (_, i) => ({ ...row, id: i ? 'other' + i : 'other', y: row.y + i })))
      latestX = Math.max(latestX, row.x)
    }
    const actor = visitors.actors.get('other'), before = actor && actor.x, start = performance.now()
    visitors.step(1 / fps); costs.push(performance.now() - start)
    if (!actor || !visitors.actors.has('other')) continue
    const distance = actor.x - before
    frames.push({ time: now, x: actor.x, y: actor.y, moving: actor.moving, direction: actor.direction,
      phase: actor.walkPhase, latestX, distance, samples: actor.samples.length })
    if (now < warmup) continue
    const isStopped = Math.abs(distance) < .01
    if (isStopped) { metrics.stallFrames++; if (!stopped) metrics.stalls++ }
    stopped = isStopped
    metrics.maxStep = Math.max(metrics.maxStep, Math.abs(distance))
    if (distance < -.001) metrics.backwards++
    metrics.maxLagMs = Math.max(metrics.maxLagMs, now - (actor.x - 500) / .12)
  }
  costs.sort((a, b) => a - b)
  metrics.stepP95Ms = costs[Math.floor(costs.length * .95)]
  return { metrics, frames, visitors }
}
module.exports = { packet, cadencePackets, simulate }
